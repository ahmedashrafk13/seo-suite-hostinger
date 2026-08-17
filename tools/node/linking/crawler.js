// Crawler for the internal linking agent.
//
// Ported from the Crawler class, parse_sitemap(), apply_canonicals(),
// remap_links(), strip_template_blocks(), recompute_editorial() and
// resolve_site_branding() in internal_link_agent.py.
//
// The Python crawls with async httpx; this uses the same bounded-concurrency
// pool the audit port uses over node:http. Behaviour that matters to the
// results — the frontier order, robots handling, retry statuses, the crawl
// delay cap — is preserved.
const { fetchUrl, decodeBody, sleep } = require('../lib/http');
const { buildRobotsMatcher } = require('../audit/crawl');
const { DEFAULTS, L, acceptLanguageHeader } = require('./config');
const {
  normalizeUrl, sameSite, unifyOrigin, urlDepth, tokenize, words,
} = require('./urls');
const { parsePage, topicH1 } = require('./parse');

function log(msg) {
  process.stderr.write(`  ${msg}\n`);
}

// Sitemap URLs and whether the document was an index. Regex-based for the same
// reason as the audit port: real sitemaps are frequently malformed in ways a
// strict XML parser rejects outright.
function parseSitemap(body) {
  const xml = body.toString('utf8');
  const locs = [];
  const re = /<(?:[a-zA-Z0-9]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?loc>/gi;
  let m = re.exec(xml);
  while (m) {
    locs.push(m[1].trim()
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
    m = re.exec(xml);
  }
  const isIndex = /<\s*(?:[a-zA-Z0-9]+:)?sitemapindex\b/i.test(xml);
  return { urls: locs, isIndex };
}

class Crawler {
  constructor(root, cfg) {
    this.cfg = cfg;
    const withScheme = root.includes('://') ? root : `https://${root}`;
    const p = new URL(withScheme);
    this.scheme = (p.protocol || 'https:').replace(':', '');
    this.host = p.host.toLowerCase();
    this.root = `${this.scheme}://${this.host}`;
    this.pages = new Map();
    this.seen = new Set();
    this.failures = [];
    this.notes = [];
    this.sitemapUrls = [];
    this.sitemapsDeclared = [];
    this.crawlDelay = 0;
    this.throttled = 0;
    this.filteredOut = 0;
    this.unfetchedDiscovered = new Set();
    this.canFetch = null;
    this.headers = {
      'User-Agent': cfg.user_agent || DEFAULTS.user_agent || 'InternalLinkingAgent/1.0',
      'Accept-Language': acceptLanguageHeader(cfg.locale),
    };
  }

  allowedByFilters(url) {
    const inc = this.cfg.include || [];
    const exc = this.cfg.exclude || [];
    if (inc.length && !inc.some((pat) => new RegExp(pat).test(url))) return false;
    if (exc.length && exc.some((pat) => new RegExp(pat).test(url))) return false;
    return true;
  }

  async loadRobots() {
    const robotsUrl = `${this.root}/robots.txt`;
    try {
      const r = await fetchUrl(robotsUrl, { timeout: 12000, headers: this.headers });
      if (r.status === 200) {
        const text = decodeBody(r);
        this.canFetch = buildRobotsMatcher(text);
        for (const line of text.split(/\r?\n/)) {
          if (/^sitemap:/i.test(line.trim())) {
            this.sitemapsDeclared.push(line.slice(line.indexOf(':') + 1).trim());
          }
          const cd = /^crawl-delay:\s*([\d.]+)/i.exec(line.trim());
          // Honour robots Crawl-delay, but never stall longer than the cap: a
          // site declaring Crawl-delay: 30 would otherwise make a 300-page crawl
          // take two and a half hours.
          if (cd) this.crawlDelay = Math.min(parseFloat(cd[1]) || 0, this.cfg.crawl_delay_cap);
        }
      }
    } catch {
      this.notes.push('robots.txt could not be fetched; crawling with default politeness.');
    }
  }

  async loadSitemaps() {
    const queue = this.sitemapsDeclared.length
      ? [...this.sitemapsDeclared]
      : [`${this.root}/sitemap.xml`, `${this.root}/sitemap_index.xml`];
    const seen = new Set();
    const found = new Set();
    while (queue.length && found.size < 50000) {
      const smUrl = queue.shift();
      if (seen.has(smUrl)) continue;
      seen.add(smUrl);
      let r;
      try {
        r = await fetchUrl(smUrl, { timeout: 15000, headers: this.headers });
      } catch {
        continue;
      }
      if (r.status !== 200) continue;
      const { urls, isIndex } = parseSitemap(r.body);
      if (isIndex) {
        urls.forEach((u) => { if (seen.size + queue.length < 60) queue.push(u); });
      } else {
        urls.forEach((u) => {
          const n = normalizeUrl(u);
          if (n && sameSite(n, this.host)) found.add(unifyOrigin(n, this.root, this.host));
        });
      }
    }
    this.sitemapUrls = Array.from(found);
  }

  // One fetch with the retry policy the Python uses: retry_statuses get up to
  // max_retries attempts with a linear back-off, everything else is final.
  async fetchOnce(url) {
    let lastErr = null;
    for (let attempt = 0; attempt < this.cfg.max_retries; attempt += 1) {
      try {
        const r = await fetchUrl(url, {
          timeout: this.cfg.request_timeout * 1000,
          headers: this.headers,
        });
        if (this.cfg.retry_statuses.includes(r.status) && attempt < this.cfg.max_retries - 1) {
          this.throttled += 1;
          await sleep(600 * (attempt + 1));
          continue;
        }
        return { res: r, err: null };
      } catch (err) {
        lastErr = err;
        if (attempt < this.cfg.max_retries - 1) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }
    }
    return { res: null, err: lastErr };
  }

  // Settle the canonical origin BEFORE anything else runs.
  //
  // Almost every site redirects one of http/https or www/non-www to the other.
  // Whichever spelling the user typed, the pages that come back are served
  // under the site's own choice, and every internal URL must be normalised onto
  // that — otherwise links are keyed under one spelling while crawled pages are
  // keyed under another, and the entire editorial link graph silently comes out
  // empty. (This is exactly the failure it looked like on the first test run:
  // the port reported 381 site-wide links against the Python's 327 purely
  // because it had kept the non-www origin the Python had discarded.)
  async resolveOrigin() {
    const candidates = [
      `${this.scheme}://${this.host}/`,
      `https://${this.host}/`,
      `http://${this.host}/`,
    ];
    const attempts = [];
    for (const candidate of candidates) {
      let r;
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await fetchUrl(candidate, { timeout: 15000, headers: this.headers, maxBytes: 8192 });
      } catch (err) {
        attempts.push(`${candidate} -> ${err.kind || 'error'}`);
        continue;
      }
      if (r.status >= 400) { attempts.push(`${candidate} -> HTTP ${r.status}`); continue; }
      let final;
      try { final = new URL(r.url); } catch { continue; }
      if (!final.host || !sameSite(r.url, this.host)) continue;
      const newOrigin = `${final.protocol.replace(':', '')}://${final.host.toLowerCase()}`;
      if (newOrigin !== this.root) {
        this.notes.push(`Site resolves ${this.root} -> ${newOrigin}; all internal URLs `
          + `normalized to ${newOrigin}.`);
        log(`canonical origin: ${newOrigin} (redirected from ${this.root})`);
      } else {
        log(`canonical origin: ${newOrigin}`);
      }
      this.root = newOrigin;
      this.host = final.host.toLowerCase();
      this.scheme = final.protocol.replace(':', '');
      return;
    }
    log(`could not reach the homepage; assuming ${this.root}`);
    attempts.forEach((a) => log(`  tried ${a}`));
  }

  async crawl(startUrl, onProgress) {
    await this.resolveOrigin();
    await this.loadRobots();
    await this.loadSitemaps();

    // The seed is the RESOLVED origin's homepage, not the URL the user typed —
    // resolveOrigin() may have moved it to www/https.
    const seedNorm = unifyOrigin(normalizeUrl(`${this.root}/`) || this.root, this.root, this.host);
    const frontier = [{ url: seedNorm, depth: 0 }];
    this.seen.add(seedNorm);

    // Sitemap URLs are seeded into the frontier so pages that are in the
    // sitemap but linked from nowhere are still fetched — that is precisely how
    // an orphan is discovered. Shallow-first, so a page budget smaller than the
    // sitemap spends itself on the top of the site rather than on whatever the
    // sitemap happened to list first.
    const seeded = this.sitemapUrls.slice().sort((a, b) => (urlDepth(a) - urlDepth(b)) || (a.length - b.length));
    for (const u of seeded) {
      if (this.seen.has(u)) continue;
      this.seen.add(u);
      frontier.push({ url: u, depth: 1 });
    }

    const concurrency = Math.max(1, this.cfg.concurrency);
    while (frontier.length && this.pages.size < this.cfg.max_pages) {
      const wave = [];
      while (frontier.length && wave.length < concurrency
             && this.pages.size + wave.length < this.cfg.max_pages) {
        wave.push(frontier.shift());
      }

      // eslint-disable-next-line no-await-in-loop
      await Promise.all(wave.map(async ({ url, depth }) => {
        if (this.cfg.respect_robots && this.canFetch && !this.canFetch(this.headers['User-Agent'], url)) {
          this.filteredOut += 1;
          return;
        }
        if (!this.allowedByFilters(url)) {
          this.filteredOut += 1;
          return;
        }
        const { res, err } = await this.fetchOnce(url);
        if (this.cfg.delay) await sleep(this.cfg.delay * 1000);
        if (this.crawlDelay) await sleep(this.crawlDelay * 1000);

        if (err || !res) {
          this.failures.push({ url, error: err ? String(err.message || err) : 'no response' });
          return;
        }
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        if (res.status !== 200 || (ctype && !ctype.includes('html'))) {
          // Non-200s and non-HTML are still recorded as pages so broken-link
          // reporting can attribute a status to them.
          const finalUrl = unifyOrigin(normalizeUrl(res.url) || url, this.root, this.host);
          const stub = parsePage('', finalUrl, url, res.status, depth, this.host, this.root);
          this.pages.set(finalUrl, stub);
          return;
        }

        const finalUrl = unifyOrigin(normalizeUrl(res.url) || url, this.root, this.host);
        const html = decodeBody(res);
        const page = parsePage(html, finalUrl, url, res.status, depth, this.host, this.root);
        // A redirect means two URLs served this page; remember the requested
        // spelling so links written to it still resolve.
        if (finalUrl !== url) page.aliases.push(url);
        const existing = this.pages.get(finalUrl);
        if (existing) {
          existing.aliases.push(...page.aliases);
          return;
        }
        this.pages.set(finalUrl, page);

        for (const link of page.out_links) {
          const t = link.url;
          if (this.seen.has(t)) continue;
          this.seen.add(t);
          if (this.pages.size + frontier.length >= this.cfg.max_pages * 3) {
            this.unfetchedDiscovered.add(t);
            continue;
          }
          frontier.push({ url: t, depth: depth + 1 });
        }
      }));

      if (onProgress) onProgress(`crawled ${this.pages.size} pages, ${frontier.length} queued ...`);
    }

    // Anything still queued was discovered but never fetched — the page budget
    // ran out. This is what makes orphan status "provisional" rather than
    // definitive in the report.
    frontier.forEach(({ url }) => this.unfetchedDiscovered.add(url));
    return this.pages;
  }
}

// --- canonical merging ----------------------------------------------------
// Fold pages whose rel=canonical points at another crawled page.
function applyCanonicals(pages, notes) {
  const aliasOf = new Map();
  for (const [url, page] of pages) {
    const c = page.canonical;
    if (c && c !== url && pages.has(c)) aliasOf.set(url, c);
  }
  if (!aliasOf.size) return pages;

  // Resolve chains (a -> b -> c) so everything lands on the final target.
  const resolve = (u) => {
    let cur = u;
    let hops = 0;
    while (aliasOf.has(cur) && hops < 10) { cur = aliasOf.get(cur); hops += 1; }
    return cur;
  };

  const merged = new Map();
  for (const [url, page] of pages) {
    const target = resolve(url);
    if (target === url) {
      if (!merged.has(url)) merged.set(url, page);
      continue;
    }
    const keeper = pages.get(target);
    if (!keeper) { merged.set(url, page); continue; }
    keeper.aliases.push(url, ...page.aliases);
    merged.set(target, keeper);
  }
  notes.push(`${aliasOf.size} URL(s) folded into their rel=canonical target.`);
  log(`canonical merge: ${aliasOf.size} alias URL(s) folded`);
  return merged;
}

// Rewrite out-links onto the surviving canonical URLs.
function remapLinks(pages) {
  const alias = new Map();
  for (const [url, page] of pages) {
    page.aliases.forEach((a) => alias.set(a, url));
  }
  for (const page of pages.values()) {
    for (const link of page.out_links) {
      if (alias.has(link.url)) link.url = alias.get(link.url);
    }
    for (const b of page.blocks) {
      b.link_spans = b.link_spans.map(([s, e, dest]) => [s, e, alias.get(dest) || dest]);
    }
  }
}

const normBlock = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

function coveredChars(spans) {
  if (!spans.length) return 0;
  const merged = [];
  const sorted = spans.map((sp) => [sp[0], sp[1]]).sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged.reduce((a, [s, e]) => a + (e - s), 0);
}

// Settle what counts as an editorial link, using one consistent definition: a
// link is editorial exactly when it physically sits inside a content block that
// survived extraction and template removal.
//
// Deriving it from CSS class names instead was demonstrably wrong — on an
// Elementor site "elementor-nav-menu" escaped the chrome heuristics while
// carousel links whose anchor text appeared nowhere in the extracted copy were
// counted as editorial. Because orphan status is computed from editorial
// inbound links, that error propagated straight into the headline numbers.
function recomputeEditorial(pages) {
  for (const page of pages.values()) {
    const inContent = new Set();
    page.blocks.forEach((b) => b.link_spans.forEach((sp) => { if (sp[2]) inContent.add(sp[2]); }));
    page.out_links.forEach((link) => { link.editorial = inContent.has(link.url); });
  }
}

// Remove text blocks that are template furniture rather than page content.
//
// CSS-class heuristics miss plenty of widgets ("recent posts", "you may also
// like", promo strips). Any block whose exact text repeats across a large share
// of pages is template by definition, whatever it is called in the markup. This
// matters twice: shared widget text makes unrelated pages look near-identical
// and manufactures false cannibalization pairs, and injecting a link into a
// block that appears on every page would silently create a site-wide link.
function stripTemplateBlocks(pages, cfg, notes) {
  const n = pages.size;
  const stats = {
    template_blocks: 0, removed_duplicate: 0, removed_linklist: 0, shared_blocks: 0,
  };

  const freq = new Map();
  for (const p of pages.values()) {
    const uniq = new Set(p.blocks.map((b) => normBlock(b.text)));
    for (const norm of uniq) freq.set(norm, (freq.get(norm) || 0) + 1);
  }
  // Only the wholesale REMOVAL threshold depends on having enough pages to
  // judge. The per-block "shared" marking must run at any site size, or the
  // documented guarantee that anchors never land in copy repeated on another
  // page would quietly be false on small sites.
  const cut = n >= 4 ? Math.max(3, Math.floor(n * cfg.template_block_ratio)) : n + 1;
  const template = new Set();
  for (const [t, c] of freq) if (c >= cut) template.add(t);
  stats.template_blocks = template.size;

  for (const p of pages.values()) {
    const kept = [];
    for (const b of p.blocks) {
      const norm = normBlock(b.text);
      if (template.has(norm)) { stats.removed_duplicate += 1; continue; }
      if (b.text && coveredChars(b.link_spans) / b.text.length > cfg.link_density_block) {
        stats.removed_linklist += 1;
        continue;
      }
      // Below the template threshold but still duplicated somewhere: keep it as
      // content, but mark it so it never hosts a recommended anchor.
      if ((freq.get(norm) || 0) > 1) { b.shared = true; stats.shared_blocks += 1; }
      kept.push(b);
    }
    p.blocks = kept;
    p.text = kept.map((b) => b.text).join(' ');
    p.word_count = words(p.text).length;
  }

  recomputeEditorial(pages);

  if (template.size) {
    notes.push(
      `${template.size} repeated text block(s) identified as template furniture `
      + `(present on >=${cut} of ${n} pages) and excluded from both similarity `
      + 'scoring and anchor placement.'
    );
  }
  log(`template blocks removed: ${stats.template_blocks} distinct `
    + `(${stats.removed_duplicate} instances); `
    + `link-list blocks dropped: ${stats.removed_linklist}`);
  return stats;
}

module.exports = {
  Crawler, parseSitemap, applyCanonicals, remapLinks,
  stripTemplateBlocks, recomputeEditorial, coveredChars, normBlock, log,
};
