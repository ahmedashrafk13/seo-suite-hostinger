// WHOLE-SITE AI CRAWLER READINESS — the eight-point checklist.
//
// WHAT WAS ASKED FOR
// "Search for whole website not single url", against this checklist:
//   1. robots.txt
//   2. Sitemap contains all target URLs
//   3. Important pages return 200
//   4. There is no accidental noindex
//   5. Canonical points to the correct page
//   6. Main content is available in HTML
//   7. Internal links are standard links
//   8. Structured data is valid and matches visible text
//
// WHY EACH ITEM IS ON THE LIST, AND WHY THE ORDER MATTERS
// These are ordered by what blocks what. A page an AI fetcher cannot REACH
// cannot be read (1-3); a page it can read but is told to ignore is not indexed
// (4-5); a page it reads and finds empty contributes nothing (6-7); and markup
// that contradicts the visible page is worse than no markup (8). Reporting them
// in any other order produces a list where the reader fixes item 8 on a page
// that item 3 says is a 404.
//
// TWO NON-OBVIOUS ITEMS
//
// "Internal links are standard links" is on the list because it is the silent
// killer of site-wide AI visibility. A <div onclick="router.push(…)"> or an
// <a href="#"> driven by JavaScript looks and behaves like a link to a person
// and is INVISIBLE to every AI retrieval fetcher, none of which execute
// scripts. A site navigated that way has, from their point of view, exactly one
// page. This check counts real anchors against fake ones, per page.
//
// "Structured data matches visible text" is on the list because it is the one
// structured-data failure a validator cannot catch. A FAQPage whose answers do
// not appear on the page passes every syntax check and is a policy violation;
// a Product whose marked-up price differs from the rendered one is a
// misrepresentation. So the values in the markup are compared against the
// page's own visible text and the differences are reported.
//
// SCOPE, AND HOW THE URL SET IS BUILT
// "Whole website" is bounded by what can be fetched in one run. The URL set is
// the UNION of the sitemap and a link crawl, deduplicated, which is what makes
// item 2 answerable at all: a sitemap compared only against itself can never be
// found incomplete. Every count states its denominator.
const store = require('./store');
const providers = require('./providers');
const nlp = require('./nlp');
const boilerplate = require('./boilerplate');
const pageTypeLib = require('./pageType');
const {
  AI_AGENTS, RETRIEVAL_AGENTS, fetchPage, parseDocument, fetchRobots, robotsAllows,
  fetchSitemapUrls, fetchLlmsTxt, crawlSite, normalizeUrl, canonUrl, mapLimit,
} = require('./fetcher');
const { probeAgents } = require('./readiness');

// ------------------------------------------------------------- the URL set

// The union of the sitemap and a link crawl, which is the only way item 2 can
// be checked: URLs the crawler reached that the sitemap does not list are the
// answer to "does the sitemap contain all target URLs".
async function buildUrlSet(site, { maxPages = 150, concurrency = 4 } = {}) {
  const robots = await fetchRobots(site);
  const sitemap = await fetchSitemapUrls(site, { limit: 5000, robots });
  const crawl = await crawlSite(site, { maxPages, concurrency });

  const sitemapKeys = new Map();
  sitemap.urls.forEach((u) => {
    const loc = u.loc || u;
    sitemapKeys.set(canonUrl(loc), { url: loc, lastmod: u.lastmod || null });
  });

  const crawledKeys = new Map();
  crawl.pages.forEach((p) => crawledKeys.set(canonUrl(p.url), p));

  const inBoth = [];
  const crawledNotInSitemap = [];
  const inSitemapNotCrawled = [];
  crawledKeys.forEach((page, key) => {
    if (sitemapKeys.has(key)) inBoth.push(key);
    else crawledNotInSitemap.push(page.url);
  });
  sitemapKeys.forEach((entry, key) => {
    if (!crawledKeys.has(key)) inSitemapNotCrawled.push(entry.url);
  });

  return {
    robots,
    sitemap,
    crawl,
    pages: crawl.pages,
    sitemapKeys,
    crawledKeys,
    inBoth,
    crawledNotInSitemap,
    inSitemapNotCrawled,
  };
}

// -------------------------------------------------------------- item checks

// 7. Internal links are standard links.
//
// Counts real anchors against the three common fakes, per page.
function linkMechanics(doc) {
  const $ = doc.$;
  const out = {
    realAnchors: 0, hrefless: 0, hashOnly: 0, jsHrefs: 0, clickableDivs: 0,
    examples: [],
  };
  if (!$) return out;

  try {
    $('a').each((_, el) => {
      const href = String($(el).attr('href') || '').trim();
      const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!href) {
        // An <a> with no href is not a link. Browsers render it, screen readers
        // skip it, and no crawler follows it.
        out.hrefless += 1;
        if (out.examples.length < 12) out.examples.push({ kind: 'anchor with no href', text });
        return;
      }
      if (href === '#') {
        out.hashOnly += 1;
        if (out.examples.length < 12) out.examples.push({ kind: 'href="#"', text });
        return;
      }
      if (/^javascript:/i.test(href)) {
        out.jsHrefs += 1;
        if (out.examples.length < 12) out.examples.push({ kind: 'javascript: href', text });
        return;
      }
      if (/^(mailto:|tel:|sms:|data:)/i.test(href)) return; // legitimate, not navigation
      out.realAnchors += 1;
    });

    // Non-anchor elements wired for navigation. Detected from the attributes a
    // framework leaves behind, which is real evidence rather than a guess.
    $('[onclick], [data-href], [data-url], [data-link], [role="link"]').each((_, el) => {
      const tag = (el.name || '').toLowerCase();
      if (tag === 'a') return;
      const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 60);
      out.clickableDivs += 1;
      if (out.examples.length < 12) out.examples.push({ kind: `<${tag}> wired for navigation`, text });
    });
  } catch { /* a document without a live $ returns zeros */ }

  const fake = out.hrefless + out.hashOnly + out.jsHrefs + out.clickableDivs;
  out.fakeTotal = fake;
  out.total = out.realAnchors + fake;
  out.realShare = out.total ? Math.round((out.realAnchors / out.total) * 100) : null;
  return out;
}

// 8. Structured data matches visible text.
//
// Walks the JSON-LD for the properties whose values are supposed to be things a
// reader can see, and checks each against the page's rendered text. Only
// properties where a mismatch is a genuine problem are checked — comparing a
// URL or an @id against body text would produce nothing but false positives.
const VISIBLE_PROPERTIES = [
  { path: 'name', label: 'name' },
  { path: 'headline', label: 'headline' },
  { path: 'price', label: 'offer price' },
  { path: 'ratingValue', label: 'rating value' },
  { path: 'reviewCount', label: 'review count' },
  { path: 'ratingCount', label: 'rating count' },
  { path: 'telephone', label: 'telephone' },
  { path: 'streetAddress', label: 'street address' },
];

function normaliseForCompare(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[^\w\s.%/@+-]/g, '')
    .trim();
}

function walkNodes(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) { node.forEach((n) => walkNodes(n, out, depth + 1)); return out; }
  out.push(node);
  Object.values(node).forEach((v) => { if (v && typeof v === 'object') walkNodes(v, out, depth + 1); });
  return out;
}

function markupMatchesVisible(doc) {
  const visible = normaliseForCompare(doc.bodyText || doc.mainText || '');
  const digitsOnly = visible.replace(/[^\d.]/g, ' ');
  const issues = [];
  const checked = [];

  const blocks = (doc.jsonLd || []).filter((j) => j.ok);
  blocks.forEach((block, bi) => {
    walkNodes(block.data).forEach((node) => {
      const type = node['@type'] ? String(Array.isArray(node['@type']) ? node['@type'][0] : node['@type']) : null;
      VISIBLE_PROPERTIES.forEach((prop) => {
        const raw = node[prop.path];
        if (raw == null || typeof raw === 'object') return;
        const value = normaliseForCompare(raw);
        if (!value || value.length < 3) return;
        checked.push({ type, property: prop.path, value: String(raw).slice(0, 120) });

        // Numeric values are compared against the digits in the page, because
        // "1200" in markup renders as "£1,200" and a string comparison would
        // fail on every correctly-marked-up price.
        const isNumeric = /^[\d.,]+$/.test(String(raw).trim());
        const present = isNumeric
          ? digitsOnly.includes(String(raw).replace(/[^\d.]/g, ''))
          : visible.includes(value);
        if (present) return;

        issues.push({
          blockIndex: bi,
          type,
          property: prop.path,
          label: prop.label,
          markupValue: String(raw).slice(0, 160),
          severity: ['price', 'ratingValue', 'reviewCount', 'ratingCount'].includes(prop.path) ? 'high' : 'medium',
          why: ['ratingValue', 'reviewCount', 'ratingCount'].includes(prop.path)
            ? 'A rating or review count in markup that does not appear on the page is self-serving review markup — the single most commonly penalised structured-data abuse.'
            : (prop.path === 'price'
              ? 'A marked-up price that does not appear on the page is a misrepresentation in a shopping result, and Google validates it against the rendered page.'
              : 'Structured data is required to describe what a reader can see. A value present only in markup is unverifiable and may be ignored across the whole page.'),
        });
      });
    });
  });

  // FAQ answers get their own pass: a marked-up answer whose text is not on the
  // page is the specific policy violation, and it needs the whole answer
  // compared rather than a property name.
  const faqIssues = [];
  blocks.forEach((block, bi) => {
    walkNodes(block.data).forEach((node) => {
      const t = node['@type'] ? String(Array.isArray(node['@type']) ? node['@type'][0] : node['@type']) : null;
      if (t !== 'Question') return;
      // acceptedAnswer.text is normally a string, but some generators emit a
      // nested object. Both shapes are read; anything else is skipped rather
      // than stringified into a comparison that could never match.
      const answer = node.acceptedAnswer && node.acceptedAnswer.text;
      const text = typeof answer === 'string'
        ? answer
        : (answer && typeof answer === 'object' ? answer.text : null);
      if (!text || typeof text !== 'string') return;
      // Compare on the first substantial run of the answer: markup often
      // carries HTML entities and the page does not, so a whole-string match
      // would fail on correct markup.
      const probe = normaliseForCompare(String(text).replace(/<[^>]+>/g, ' ')).split(' ').slice(0, 12).join(' ');
      if (probe.length < 20) return;
      if (visible.includes(probe)) return;
      faqIssues.push({
        blockIndex: bi,
        question: String(node.name || '(unnamed question)').slice(0, 140),
        answerProbe: probe.slice(0, 140),
        severity: 'high',
        why: 'An FAQPage answer must be VISIBLE on the page. Marking up an answer a reader cannot see is a policy violation, not a technical warning.',
      });
    });
  });

  const parseErrors = (doc.jsonLd || []).filter((j) => !j.ok)
    .map((j) => ({ error: j.error, raw: String(j.raw || '').slice(0, 200) }));

  return {
    blocks: blocks.length,
    parseErrors,
    propertiesChecked: checked.length,
    mismatches: issues,
    faqMismatches: faqIssues,
    ok: !issues.length && !faqIssues.length && !parseErrors.length,
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, site = null, maxPages = 120,
  probeEdge = true, importantUrls = [], deepSample = 25,
}) {
  const brandId = brand ? brand.id : null;
  const target = normalizeUrl(site || (brand && brand.site_url));
  if (!target) throw new Error('Give a site URL, or pick a brand with one.');
  let origin = target;
  try { origin = new URL(target).origin; } catch { /* keep */ }

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'site_readiness', target,
    label: `whole site, up to ${maxPages} pages`,
    params: { site: target, maxPages, probeEdge, importantUrls, deepSample },
  });

  try {
    const sources = ['crawler'];
    const set = await buildUrlSet(target, { maxPages });
    const okPages = set.pages.filter((p) => p.ok && p.doc);

    if (!okPages.length) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: `No page on ${target} could be fetched and parsed. Everything on this checklist depends on reading at least one page, so nothing else was attempted.`,
          crawl: { fetched: set.crawl.fetched, failures: set.pages.filter((p) => !p.ok).slice(0, 10) },
        },
        findings: [{
          checkKey: 'site_unreachable',
          title: 'No page on the site could be read',
          detail: set.pages.slice(0, 5).map((p) => `${p.url} → ${p.status || p.error}`).join('; '),
          severity: 'critical',
          affectedUrl: target,
          action: 'Fix availability first. Confirm the site returns 200 to a normal browser user agent from outside your network.',
          dedupeKey: `sitereadiness:unreachable:${target}`,
        }],
        sources,
      });
    }

    const checks = [];
    const findings = [];
    const addCheck = (c) => { checks.push(c); return c; };

    // ============================================================ 1. robots
    const robotsVerdicts = AI_AGENTS.map((agent) => {
      const v = robotsAllows(set.robots.parsed, agent.token, '/');
      return {
        key: agent.key, token: agent.token, label: agent.label, purpose: agent.purpose,
        allowed: v.allowed, rule: v.rule, matchedAgent: v.matchedAgent,
      };
    });
    let probes = [];
    if (probeEdge) {
      // Probed against the homepage only. An edge rule that blocks an agent
      // blocks it everywhere — it is a server configuration, not a per-page
      // one — so probing every page would cost N× the requests for the same
      // answer.
      probes = await probeAgents(target, {
        agents: AI_AGENTS,
        baselineDoc: okPages[0].doc,
        baselineBytes: okPages[0].bytes,
      });
    }
    const probeByKey = new Map(probes.map((p) => [p.key, p]));
    const agentStatus = robotsVerdicts.map((v) => {
      const probe = probeByKey.get(v.key) || null;
      let verdict = 'unknown';
      let reason = null;
      if (!v.allowed) { verdict = 'blocked'; reason = `robots.txt: ${v.rule}`; }
      else if (probe && probe.challenge) { verdict = 'blocked'; reason = `robots.txt allows it, but the server answered with ${probe.challenge}`; }
      else if (probe && probe.stripped) { verdict = 'degraded'; reason = `served ${Math.round(probe.contentRatio * 100)}% of the bytes a browser gets`; }
      else if (probe && probe.ok) { verdict = 'reachable'; reason = `HTTP ${probe.status} with a full-size body`; }
      else if (probe && probe.error) { verdict = 'unknown'; reason = `probe failed: ${probe.error}`; }
      else { verdict = 'allowed-by-robots'; reason = 'no live probe available for this agent'; }
      return { ...v, probe, verdict, reason };
    });
    const retrievalBlocked = agentStatus.filter((a) => a.purpose === 'retrieval' && (a.verdict === 'blocked' || a.verdict === 'degraded'));

    addCheck({
      key: 'robots_txt',
      item: '1. robots.txt',
      status: !set.robots.present ? 'warn' : (retrievalBlocked.length ? 'fail' : 'pass'),
      summary: set.robots.present
        ? `Served at ${origin}/robots.txt. ${set.robots.parsed.sitemaps.length} sitemap declaration${set.robots.parsed.sitemaps.length === 1 ? '' : 's'}. ${agentStatus.filter((a) => a.purpose === 'retrieval' && a.verdict === 'reachable').length} of ${agentStatus.filter((a) => a.purpose === 'retrieval').length} AI retrieval fetchers can reach the site.`
        : `No robots.txt is served (HTTP ${set.robots.status}). Not fatal — absence means "allow everything" — but it also means no sitemap is declared there, and a WAF that later starts serving an error page at that path would silently block every crawler.`,
      detail: { agents: agentStatus, sitemapsDeclared: set.robots.parsed.sitemaps, present: set.robots.present, status: set.robots.status },
    });

    if (retrievalBlocked.length) {
      findings.push({
        checkKey: 'site_retrieval_blocked',
        title: `${retrievalBlocked.length} AI retrieval fetcher${retrievalBlocked.length === 1 ? '' : 's'} cannot read this site`,
        detail: `${retrievalBlocked.map((a) => `${a.label}: ${a.reason}`).join('; ')}. These fetch pages at the moment a user asks a question, in order to cite them — while they are blocked, no page on this site can appear in those assistants' answers.`,
        severity: 'critical',
        affectedUrl: target,
        affectedCount: retrievalBlocked.length,
        action: retrievalBlocked.some((a) => a.reason && a.reason.startsWith('robots.txt:'))
          ? 'Remove the robots.txt rules blocking the retrieval agents. Rules for TRAINING crawlers can stay if they were set deliberately — that is a different decision with no visibility cost.'
          : 'robots.txt allows these agents, so the block is at the edge: check Cloudflare bot-fight mode, any "block AI scrapers" plugin, and WAF user-agent rules.',
        evidence: { agents: retrievalBlocked },
        dedupeKey: `sitereadiness:retrieval:${target}`,
      });
    }

    // ================================================= 2. sitemap coverage
    const missingFromSitemap = set.crawledNotInSitemap.filter((u) => {
      const page = set.crawledKeys.get(canonUrl(u));
      // Only pages that are actually indexable belong in a sitemap. A 404 or a
      // noindex page missing from the sitemap is correct, not a gap.
      if (!page || !page.ok || !page.doc) return false;
      return !/noindex/i.test(String(page.doc.robotsMeta || ''));
    });
    const sitemapCoverage = set.sitemap.urls.length
      ? Math.round((set.inBoth.length / Math.max(1, set.inBoth.length + missingFromSitemap.length)) * 100)
      : 0;

    addCheck({
      key: 'sitemap_coverage',
      item: '2. Sitemap contains all target URLs',
      status: !set.sitemap.urls.length ? 'fail' : (missingFromSitemap.length ? 'warn' : 'pass'),
      summary: !set.sitemap.urls.length
        ? 'No sitemap could be read at all, so no URL on this site is declared to a crawler that does not find it by following links.'
        : `${set.sitemap.urls.length.toLocaleString('en-US')} URLs in the sitemap, ${set.crawl.fetched} reached by crawling. ${missingFromSitemap.length} indexable crawled page${missingFromSitemap.length === 1 ? ' is' : 's are'} absent from it (${sitemapCoverage}% coverage of what was crawled), and ${set.inSitemapNotCrawled.length} sitemap URL${set.inSitemapNotCrawled.length === 1 ? ' was' : 's were'} not reached by the crawl.`,
      detail: {
        sitemapUrls: set.sitemap.urls.length,
        sitemapSources: set.sitemap.sources,
        crawled: set.crawl.fetched,
        inBoth: set.inBoth.length,
        missingFromSitemap: missingFromSitemap.slice(0, 60),
        inSitemapNotCrawled: set.inSitemapNotCrawled.slice(0, 60),
        coveragePct: sitemapCoverage,
        // The honest caveat: "not reached by the crawl" has two causes and only
        // one of them is a problem.
        caveat: `"Not reached by the crawl" means either the page has no internal links pointing at it (an orphan — a real problem) or the crawl stopped at ${maxPages} pages before reaching it (not a problem). The orphan check on the architecture report distinguishes them.`,
        crawlComplete: set.crawl.complete,
      },
    });

    if (!set.sitemap.urls.length) {
      findings.push({
        checkKey: 'no_sitemap',
        title: 'No XML sitemap could be read for this site',
        detail: `Neither ${origin}/sitemap.xml nor any sitemap declared in robots.txt returned a readable sitemap. Every URL on this site now has to be discovered by following links, which means an orphan page is invisible and a new page waits for a crawl rather than being announced.`,
        severity: 'high',
        affectedUrl: target,
        action: 'Publish a sitemap and declare it in robots.txt. It is the cheapest indexation improvement available.',
        evidence: { robotsSitemaps: set.robots.parsed.sitemaps, triedSources: set.sitemap.sources },
        dedupeKey: `sitereadiness:nositemap:${target}`,
      });
    } else if (missingFromSitemap.length) {
      findings.push({
        checkKey: 'sitemap_incomplete',
        title: `${missingFromSitemap.length} indexable page${missingFromSitemap.length === 1 ? ' is' : 's are'} missing from the sitemap`,
        detail: `Reached by crawling, indexable, and not listed: ${missingFromSitemap.slice(0, 10).join(', ')}${missingFromSitemap.length > 10 ? `, and ${missingFromSitemap.length - 10} more` : ''}.`,
        severity: 'medium',
        affectedUrl: missingFromSitemap[0],
        affectedCount: missingFromSitemap.length,
        action: 'Add them, or work out why the generator excluded them — an unintended exclusion rule usually affects a whole section rather than one page.',
        evidence: { urls: missingFromSitemap.slice(0, 100) },
        dedupeKey: `sitereadiness:sitemapgap:${target}`,
      });
    }

    // ============================================ 3. important pages 200
    //
    // "Important" is defined, not assumed: the homepage, anything the user
    // named, and the sitemap's shallowest URL per section. Those are then
    // fetched directly rather than inferred from the crawl, because a page the
    // crawl never reached has no status.
    const importantSet = new Map();
    const pushImportant = (url, why) => {
      if (!url) return;
      const key = canonUrl(url);
      if (importantSet.has(key)) { importantSet.get(key).why.push(why); return; }
      importantSet.set(key, { url, why: [why] });
    };
    pushImportant(target, 'homepage');
    (importantUrls || []).forEach((u) => pushImportant(u, 'named as important for this run'));
    const bySection = new Map();
    set.sitemap.urls.forEach((u) => {
      const loc = u.loc || u;
      let path = '/';
      try { path = new URL(loc).pathname || '/'; } catch { return; }
      const section = path.split('/').filter(Boolean)[0] || '(root)';
      const depth = path.split('/').filter(Boolean).length;
      const cur = bySection.get(section);
      if (!cur || depth < cur.depth) bySection.set(section, { url: loc, depth });
    });
    [...bySection.entries()].slice(0, 20).forEach(([section, v]) => pushImportant(v.url, `shallowest URL in /${section}`));

    const importantResults = await mapLimit([...importantSet.values()], 4, async (item) => {
      const cached = set.crawledKeys.get(canonUrl(item.url));
      if (cached) {
        return {
          ...item, status: cached.status, ok: cached.ok, error: cached.error || null,
          redirects: (cached.redirectChain || []).length, from: 'crawl',
        };
      }
      const res = await fetchPage(item.url, { timeout: 15000 });
      return {
        ...item, status: res.status, ok: res.ok, error: res.error,
        redirects: res.redirectChain.length, finalUrl: res.url, from: 'direct fetch',
      };
    });
    const importantOk = importantResults.filter((r) => r && !r.__error && r.ok);
    const importantBad = importantResults.filter((r) => r && !r.__error && !r.ok);
    const importantRedirecting = importantOk.filter((r) => r.redirects > 0);

    addCheck({
      key: 'important_200',
      item: '3. Important pages return 200',
      status: importantBad.length ? 'fail' : (importantRedirecting.length ? 'warn' : 'pass'),
      summary: `${importantOk.length} of ${importantResults.length} checked URLs return a success status. ${importantBad.length} do not. ${importantRedirecting.length} reach 200 only after a redirect.`,
      detail: {
        definition: 'The homepage, any URL named for this run, and the shallowest sitemap URL in each top-level section.',
        results: importantResults.filter((r) => r && !r.__error),
        failures: importantBad,
        redirecting: importantRedirecting,
      },
    });

    if (importantBad.length) {
      findings.push({
        checkKey: 'important_not_200',
        title: `${importantBad.length} important URL${importantBad.length === 1 ? '' : 's'} do not return a success status`,
        detail: importantBad.slice(0, 10).map((r) => `${r.url} → ${r.status || r.error} (${r.why.join('; ')})`).join('; '),
        severity: 'critical',
        affectedUrl: importantBad[0].url,
        affectedCount: importantBad.length,
        action: 'These are section entry points and the homepage. A broken one costs every page beneath it, not just itself.',
        evidence: { urls: importantBad },
        dedupeKey: `sitereadiness:important4xx:${target}`,
      });
    }

    // ============================================== 4. accidental noindex
    const noindexed = okPages.filter((p) => /noindex/i.test(String(p.doc.robotsMeta || ''))
      || /noindex/i.test(String((p.headers || {})['x-robots-tag'] || '')));
    // "Accidental" is the operative word: a noindex page that IS in the sitemap
    // is a contradiction the site is making with itself, and that is the
    // signature of an accident rather than a decision.
    const noindexInSitemap = noindexed.filter((p) => set.sitemapKeys.has(canonUrl(p.url)));
    const nosnippet = okPages.filter((p) => /nosnippet|max-snippet\s*:\s*0/i.test(String(p.doc.robotsMeta || ''))
      || /nosnippet|max-snippet\s*:\s*0/i.test(String((p.headers || {})['x-robots-tag'] || '')));

    addCheck({
      key: 'no_accidental_noindex',
      item: '4. There is no accidental noindex',
      status: noindexInSitemap.length ? 'fail' : (nosnippet.length ? 'warn' : 'pass'),
      summary: `${noindexed.length} of ${okPages.length} crawled pages carry noindex`
        + (noindexInSitemap.length
          ? `, and ${noindexInSitemap.length} of those ${noindexInSitemap.length === 1 ? 'is' : 'are'} ALSO listed in the sitemap — the site is telling Google to index them and not to index them at the same time, which is the signature of an accident.`
          : ' — none of them are in the sitemap, so they read as deliberate.')
        + (nosnippet.length ? ` ${nosnippet.length} page${nosnippet.length === 1 ? '' : 's'} carry nosnippet or max-snippet:0, which prevents an AI answer engine quoting them even where they rank.` : ''),
      detail: {
        noindexed: noindexed.map((p) => ({ url: p.url, robotsMeta: p.doc.robotsMeta, xRobots: (p.headers || {})['x-robots-tag'] || null, inSitemap: set.sitemapKeys.has(canonUrl(p.url)) })),
        contradictory: noindexInSitemap.map((p) => p.url),
        nosnippet: nosnippet.map((p) => ({ url: p.url, robotsMeta: p.doc.robotsMeta })),
      },
    });

    if (noindexInSitemap.length) {
      findings.push({
        checkKey: 'noindex_in_sitemap',
        title: `${noindexInSitemap.length} page${noindexInSitemap.length === 1 ? '' : 's'} carry noindex while being listed in the sitemap`,
        detail: `${noindexInSitemap.slice(0, 8).map((p) => p.url).join(', ')}. A sitemap entry is a request to index; a noindex tag is an instruction not to. One of the two is wrong, and which one it is is a decision only you can make — but the contradiction itself is never intentional.`,
        severity: 'high',
        affectedUrl: noindexInSitemap[0].url,
        affectedCount: noindexInSitemap.length,
        action: 'Decide per page: remove the noindex if the page should rank, or remove it from the sitemap if it should not.',
        evidence: { urls: noindexInSitemap.map((p) => ({ url: p.url, robotsMeta: p.doc.robotsMeta })) },
        dedupeKey: `sitereadiness:noindexsitemap:${target}`,
      });
    }
    if (nosnippet.length) {
      findings.push({
        checkKey: 'nosnippet',
        title: `${nosnippet.length} page${nosnippet.length === 1 ? '' : 's'} forbid snippets`,
        detail: `${nosnippet.slice(0, 6).map((p) => p.url).join(', ')}. nosnippet and max-snippet:0 stop Google and every AI answer surface from quoting the page. It can rank and still never be the cited source.`,
        severity: 'medium',
        affectedUrl: nosnippet[0].url,
        affectedCount: nosnippet.length,
        action: 'Remove these unless there is a licensing reason for them. They are usually inherited from a plugin default rather than chosen.',
        evidence: { urls: nosnippet.map((p) => ({ url: p.url, robotsMeta: p.doc.robotsMeta })) },
        dedupeKey: `sitereadiness:nosnippet:${target}`,
      });
    }

    // ================================================= 5. canonical health
    const canonicalRows = okPages.map((p) => {
      const raw = p.doc.canonical;
      let resolved = null;
      if (raw) { try { resolved = new URL(raw, p.url).href; } catch { resolved = raw; } }
      const selfKey = canonUrl(p.url);
      const canonKey = resolved ? canonUrl(resolved) : null;
      return {
        url: p.url,
        canonical: raw,
        resolved,
        self: canonKey === selfKey,
        missing: !raw,
        // A canonical pointing at a URL that is not on this site, or that the
        // crawl found to be a 404 or a redirect, is the damaging case: it tells
        // Google to index a page that does not exist.
        offSite: (() => {
          if (!resolved) return false;
          try { return new URL(resolved).host !== new URL(p.url).host; } catch { return false; }
        })(),
        targetKnown: canonKey ? set.crawledKeys.has(canonKey) : false,
        targetStatus: canonKey && set.crawledKeys.has(canonKey) ? set.crawledKeys.get(canonKey).status : null,
        inSitemap: set.sitemapKeys.has(selfKey),
      };
    });
    const canonMissing = canonicalRows.filter((r) => r.missing);
    const canonOffSite = canonicalRows.filter((r) => r.offSite);
    const canonToBroken = canonicalRows.filter((r) => !r.self && r.targetKnown && r.targetStatus && r.targetStatus >= 400);
    // Several URLs pointing at one canonical is normal and correct. Several
    // DISTINCT pages of real content collapsing onto one canonical is not, and
    // that is what is reported.
    const collapse = new Map();
    canonicalRows.filter((r) => !r.self && r.resolved).forEach((r) => {
      const k = canonUrl(r.resolved);
      if (!collapse.has(k)) collapse.set(k, []);
      collapse.get(k).push(r.url);
    });
    const collapsed = [...collapse.entries()].filter(([, urls]) => urls.length >= 3)
      .map(([canonical, urls]) => ({ canonical, urls: urls.slice(0, 12), count: urls.length }));
    const selfShare = canonicalRows.length
      ? Math.round((canonicalRows.filter((r) => r.self).length / canonicalRows.length) * 100) : null;

    addCheck({
      key: 'canonical_correct',
      item: '5. Canonical points to the correct page',
      status: (canonOffSite.length || canonToBroken.length || collapsed.length) ? 'fail'
        : (canonMissing.length ? 'warn' : 'pass'),
      summary: `${selfShare}% of crawled pages are self-canonical. ${canonMissing.length} have no canonical at all. ${canonOffSite.length} point at another host. ${canonToBroken.length} point at a URL the crawl found broken. ${collapsed.length} group${collapsed.length === 1 ? '' : 's'} of three or more distinct pages collapse onto one canonical.`,
      detail: {
        selfSharePct: selfShare,
        missing: canonMissing.map((r) => r.url).slice(0, 40),
        offSite: canonOffSite.slice(0, 30),
        toBroken: canonToBroken.slice(0, 30),
        collapsed,
        rows: canonicalRows.slice(0, 200),
      },
    });

    if (canonOffSite.length || canonToBroken.length) {
      const rows = [...canonOffSite, ...canonToBroken];
      findings.push({
        checkKey: 'canonical_wrong_target',
        title: `${rows.length} canonical tag${rows.length === 1 ? '' : 's'} point somewhere they should not`,
        detail: [
          canonOffSite.length ? `${canonOffSite.length} point at a different host: ${canonOffSite.slice(0, 4).map((r) => `${r.url} → ${r.resolved}`).join('; ')}.` : null,
          canonToBroken.length ? `${canonToBroken.length} point at a URL that returned an error: ${canonToBroken.slice(0, 4).map((r) => `${r.url} → ${r.resolved} (HTTP ${r.targetStatus})`).join('; ')}.` : null,
        ].filter(Boolean).join(' ') + ' A canonical pointing at a broken or foreign URL asks Google to index something that is not there, and the page making the request is the one that disappears.',
        severity: 'high',
        affectedUrl: rows[0].url,
        affectedCount: rows.length,
        action: 'Fix the target, or make each page self-canonical. An off-host canonical is only correct on a genuine syndication arrangement.',
        evidence: { offSite: canonOffSite.slice(0, 40), toBroken: canonToBroken.slice(0, 40) },
        dedupeKey: `sitereadiness:canonicalwrong:${target}`,
      });
    }
    if (collapsed.length) {
      findings.push({
        checkKey: 'canonical_collapse',
        title: `${collapsed.length} canonical group${collapsed.length === 1 ? '' : 's'} collapse three or more distinct pages onto one URL`,
        detail: collapsed.slice(0, 4).map((c) => `${c.count} pages → ${c.canonical} (${c.urls.slice(0, 3).join(', ')}…)`).join('; ')
          + '. Where those pages hold different content, everything except the canonical target is being asked to disappear from the index.',
        severity: 'high',
        affectedCount: collapsed.reduce((a, c) => a + c.count, 0),
        affectedUrl: collapsed[0].urls[0],
        action: 'Check whether the collapsed pages really are duplicates. A template emitting one hardcoded canonical for a whole section is the usual cause.',
        evidence: { groups: collapsed },
        dedupeKey: `sitereadiness:canonicalcollapse:${target}`,
      });
    }
    if (canonMissing.length) {
      findings.push({
        checkKey: 'canonical_missing',
        title: `${canonMissing.length} page${canonMissing.length === 1 ? '' : 's'} have no canonical tag`,
        detail: `${canonMissing.slice(0, 8).map((r) => r.url).join(', ')}. Without one, any parameterised or protocol variant of the URL is a separate candidate and Google picks the canonical itself.`,
        severity: 'low',
        affectedUrl: canonMissing[0].url,
        affectedCount: canonMissing.length,
        action: 'Emit a self-referencing canonical on every indexable page. It is a one-line template change.',
        evidence: { urls: canonMissing.map((r) => r.url).slice(0, 80) },
        dedupeKey: `sitereadiness:canonicalmissing:${target}`,
      });
    }

    // =========================================== 6. main content in HTML
    const contentRows = okPages.map((p) => {
      const clean = boilerplate.contentText(p.doc);
      return {
        url: p.url,
        servedWords: p.doc.wordCount,
        contentWords: clean.words,
        bodyWords: p.doc.bodyWordCount,
        spaMarker: p.doc.spaMarker,
        scriptCount: p.doc.scriptCount,
        mainSelector: p.doc.mainSelector,
        // The failure that matters: SPA markers present AND almost no served
        // text. Either alone is not a problem.
        likelyClientRendered: Boolean(p.doc.spaMarker && p.doc.wordCount < 120),
        thin: clean.words < 120,
        boilerplateFellBack: clean.fellBack,
      };
    });
    const clientRendered = contentRows.filter((r) => r.likelyClientRendered);
    const thin = contentRows.filter((r) => r.thin && !r.likelyClientRendered);

    addCheck({
      key: 'content_in_html',
      item: '6. Main content is available in HTML',
      status: clientRendered.length ? 'fail' : (thin.length > okPages.length * 0.2 ? 'warn' : 'pass'),
      summary: `${clientRendered.length} of ${okPages.length} pages serve almost no content in their HTML while showing single-page-app markers — to an AI retrieval fetcher, which runs no JavaScript, those pages are blank. A further ${thin.length} serve under 120 words of content without SPA markers, which is thin rather than broken.`,
      detail: { clientRendered: clientRendered.slice(0, 40), thin: thin.slice(0, 40), rows: contentRows.slice(0, 200) },
    });

    if (clientRendered.length) {
      findings.push({
        checkKey: 'site_client_rendered',
        title: `${clientRendered.length} page${clientRendered.length === 1 ? '' : 's'} deliver their content by JavaScript`,
        detail: `${clientRendered.slice(0, 6).map((r) => `${r.url} (${r.servedWords} words served)`).join('; ')}. Every AI retrieval fetcher reads the served HTML and executes no JavaScript, so these pages are effectively empty to them while looking perfect in a browser. Googlebot does render, but on a delay and not always.`,
        severity: 'critical',
        affectedUrl: clientRendered[0].url,
        affectedCount: clientRendered.length,
        action: 'Server-render or pre-render the main content into the initial HTML response. On a client-rendered site this is the single highest-impact AI-visibility fix available.',
        evidence: { pages: clientRendered.slice(0, 40) },
        dedupeKey: `sitereadiness:clientrendered:${target}`,
      });
    }

    // ======================================= 7. internal links are standard
    const linkRows = okPages.map((p) => ({ url: p.url, ...linkMechanics(p.doc) }));
    const badLinkPages = linkRows.filter((r) => r.fakeTotal > 0 && (r.realShare == null || r.realShare < 80));
    const noRealLinks = linkRows.filter((r) => r.realAnchors === 0);
    const totalFake = linkRows.reduce((a, r) => a + r.fakeTotal, 0);

    addCheck({
      key: 'standard_internal_links',
      item: '7. Internal links are standard links',
      status: noRealLinks.length ? 'fail' : (badLinkPages.length ? 'warn' : 'pass'),
      summary: noRealLinks.length
        ? `${noRealLinks.length} page${noRealLinks.length === 1 ? ' has' : 's have'} no real <a href> links at all — nothing can be discovered from ${noRealLinks.length === 1 ? 'it' : 'them'} by a crawler.`
        : `${totalFake} navigation element${totalFake === 1 ? '' : 's'} across ${badLinkPages.length} page${badLinkPages.length === 1 ? '' : 's'} are not crawlable links (href="#", javascript: hrefs, anchors with no href, or divs wired with onclick). ${linkRows.filter((r) => r.fakeTotal === 0).length} of ${linkRows.length} pages use standard links throughout.`,
      detail: { rows: linkRows.slice(0, 200), worst: badLinkPages.slice(0, 30), noRealLinks: noRealLinks.slice(0, 20) },
    });

    if (noRealLinks.length || badLinkPages.length) {
      findings.push({
        checkKey: 'non_standard_links',
        title: noRealLinks.length
          ? `${noRealLinks.length} page${noRealLinks.length === 1 ? '' : 's'} contain no crawlable links`
          : `${totalFake} navigation elements across ${badLinkPages.length} pages are not crawlable links`,
        detail: (noRealLinks.length ? `Pages with no <a href> at all: ${noRealLinks.slice(0, 5).map((r) => r.url).join(', ')}. ` : '')
          + `Examples of the pattern: ${badLinkPages.slice(0, 3).flatMap((r) => (r.examples || []).slice(0, 2).map((e) => `${e.kind}${e.text ? ` ("${e.text}")` : ''} on ${r.url}`)).join('; ')}. `
          + 'A div with an onclick handler, an href="#" driven by script, and an anchor with no href all look and behave like links to a person and are invisible to every AI retrieval fetcher, none of which execute JavaScript. A site navigated that way has, to them, one page.',
        severity: noRealLinks.length ? 'critical' : 'high',
        affectedUrl: (noRealLinks[0] || badLinkPages[0]).url,
        affectedCount: noRealLinks.length || badLinkPages.length,
        action: 'Every navigation target must be an <a href="/real/url">. Keep the click handler if the app needs it — an anchor with a real href and a handler that calls preventDefault works for both a router and a crawler.',
        evidence: { noRealLinks: noRealLinks.slice(0, 20), pages: badLinkPages.slice(0, 30) },
        dedupeKey: `sitereadiness:fakelinks:${target}`,
      });
    }

    // ====================== 8. structured data valid and matches visible text
    //
    // Run on a deep sample rather than every page: the comparison walks the
    // whole JSON-LD tree against the whole body text, and a templating fault
    // repeats identically across a section, so the marginal page adds nothing.
    const deepTargets = okPages
      .slice()
      .sort((a, b) => (b.doc.jsonLd || []).length - (a.doc.jsonLd || []).length)
      .slice(0, Math.max(3, deepSample));
    const schemaRows = deepTargets.map((p) => {
      const match = markupMatchesVisible(p.doc);
      const classified = pageTypeLib.classify(p.doc, { brand });
      return {
        url: p.url,
        blocks: match.blocks,
        parseErrors: match.parseErrors,
        mismatches: match.mismatches,
        faqMismatches: match.faqMismatches,
        propertiesChecked: match.propertiesChecked,
        pageType: classified.type,
        pageTypeLabel: classified.label,
        pageTypeConfident: classified.confident,
        declaredTypes: classified.declaredTypes,
        typeMismatches: classified.mismatches,
        ok: match.ok && !classified.mismatches.length,
      };
    });
    const withParseErrors = schemaRows.filter((r) => r.parseErrors.length);
    const withValueMismatch = schemaRows.filter((r) => r.mismatches.length);
    const withFaqMismatch = schemaRows.filter((r) => r.faqMismatches.length);
    const withTypeMismatch = schemaRows.filter((r) => r.typeMismatches.length);
    const withNoSchema = schemaRows.filter((r) => r.blocks === 0);

    addCheck({
      key: 'schema_matches_visible',
      item: '8. Structured data is valid and matches visible text',
      status: (withParseErrors.length || withFaqMismatch.length || withTypeMismatch.length) ? 'fail'
        : (withValueMismatch.length || withNoSchema.length) ? 'warn' : 'pass',
      summary: `${schemaRows.length} page${schemaRows.length === 1 ? '' : 's'} examined in depth (the ones carrying the most markup). `
        + `${withParseErrors.length} contain JSON-LD that does not parse. `
        + `${withTypeMismatch.length} declare a type their own content contradicts. `
        + `${withValueMismatch.length} carry a property value that does not appear anywhere in the visible text. `
        + `${withFaqMismatch.length} mark up an FAQ answer a reader cannot see. `
        + `${withNoSchema.length} have no structured data at all.`,
      detail: { rows: schemaRows, sampleBasis: `the ${schemaRows.length} crawled pages with the most JSON-LD blocks, out of ${okPages.length} crawled` },
    });

    if (withParseErrors.length) {
      findings.push({
        checkKey: 'schema_parse_errors',
        title: `${withParseErrors.length} page${withParseErrors.length === 1 ? '' : 's'} carry JSON-LD that does not parse`,
        detail: withParseErrors.slice(0, 6).map((r) => `${r.url}: ${r.parseErrors[0].error}`).join('; ')
          + '. A block that does not parse is invisible to Google and to every AI crawler — the markup is in the source and has no effect whatsoever, which is why nobody notices.',
        severity: 'critical',
        affectedUrl: withParseErrors[0].url,
        affectedCount: withParseErrors.length,
        action: 'Fix the JSON syntax. The usual causes are an unescaped quote inside a description, a trailing comma, and a template variable that rendered empty.',
        evidence: { pages: withParseErrors.map((r) => ({ url: r.url, errors: r.parseErrors })) },
        dedupeKey: `sitereadiness:schemaparse:${target}`,
      });
    }
    if (withTypeMismatch.length) {
      findings.push({
        checkKey: 'schema_type_mismatch',
        title: `${withTypeMismatch.length} page${withTypeMismatch.length === 1 ? '' : 's'} declare a schema type their content contradicts`,
        detail: withTypeMismatch.slice(0, 6).map((r) => `${r.url}: declares ${r.typeMismatches.map((m) => m.declared).join(', ')} but reads as a ${r.pageTypeLabel.toLowerCase()}`).join('; ')
          + `. ${withTypeMismatch[0].typeMismatches[0].reason}`,
        severity: 'high',
        affectedUrl: withTypeMismatch[0].url,
        affectedCount: withTypeMismatch.length,
        action: 'Run the schema audit on one of these URLs — it generates the correct block for the page type, ready to paste, and names what to remove.',
        evidence: { pages: withTypeMismatch.map((r) => ({ url: r.url, pageType: r.pageType, declared: r.declaredTypes, mismatches: r.typeMismatches })) },
        dedupeKey: `sitereadiness:schematype:${target}`,
      });
    }
    if (withFaqMismatch.length) {
      findings.push({
        checkKey: 'schema_faq_invisible',
        title: `${withFaqMismatch.length} page${withFaqMismatch.length === 1 ? '' : 's'} mark up FAQ answers that are not visible on the page`,
        detail: withFaqMismatch.slice(0, 5).map((r) => `${r.url}: "${r.faqMismatches[0].question}"`).join('; ')
          + '. Google requires every marked-up question and answer to be visible to the reader. This is a policy violation rather than a technical warning, and it is the most common reason FAQ markup is ignored.',
        severity: 'high',
        affectedUrl: withFaqMismatch[0].url,
        affectedCount: withFaqMismatch.reduce((a, r) => a + r.faqMismatches.length, 0),
        action: 'Either render the answers on the page — in an accordion is fine, collapsed content counts as visible — or remove the FAQPage markup.',
        evidence: { pages: withFaqMismatch.map((r) => ({ url: r.url, questions: r.faqMismatches })) },
        dedupeKey: `sitereadiness:schemafaq:${target}`,
      });
    }
    if (withValueMismatch.length) {
      const highSeverity = withValueMismatch.filter((r) => r.mismatches.some((m) => m.severity === 'high'));
      findings.push({
        checkKey: 'schema_value_mismatch',
        title: `${withValueMismatch.length} page${withValueMismatch.length === 1 ? '' : 's'} carry a marked-up value that does not appear in the visible text`,
        detail: withValueMismatch.slice(0, 6).map((r) => `${r.url}: ${r.mismatches.slice(0, 2).map((m) => `${m.type || 'node'}.${m.property} = "${m.markupValue}"`).join(', ')}`).join('; ')
          + `. ${withValueMismatch[0].mismatches[0].why}`,
        severity: highSeverity.length ? 'high' : 'medium',
        affectedUrl: withValueMismatch[0].url,
        affectedCount: withValueMismatch.reduce((a, r) => a + r.mismatches.length, 0),
        action: 'Bind the markup to the same data the template renders, rather than to a separate constant. A hardcoded price or rating in a JSON-LD block is guaranteed to drift from the page.',
        evidence: { pages: withValueMismatch.map((r) => ({ url: r.url, mismatches: r.mismatches })) },
        dedupeKey: `sitereadiness:schemavalue:${target}`,
      });
    }

    // ------------------------------------------------------------- scoring
    //
    // One point per checklist item, weighted by whether a failure BLOCKS
    // retrieval or merely weakens it. Stated on the page.
    const WEIGHTS = {
      robots_txt: 18,
      sitemap_coverage: 12,
      important_200: 16,
      no_accidental_noindex: 14,
      canonical_correct: 12,
      content_in_html: 16,
      standard_internal_links: 8,
      schema_matches_visible: 4,
    };
    const VALUE = { pass: 1, warn: 0.5, fail: 0 };
    const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const score = Math.round(checks.reduce((a, c) => a + ((WEIGHTS[c.key] || 0) * (VALUE[c.status] ?? 0)), 0) / totalWeight * 100);

    const llms = await fetchLlmsTxt(target);

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site: target,
        origin,
        scope: {
          crawled: set.crawl.fetched,
          usable: okPages.length,
          discovered: set.crawl.discovered,
          sitemapUrls: set.sitemap.urls.length,
          complete: set.crawl.complete,
          maxPages,
          deepSample: schemaRows.length,
          basis: `The URL set is the union of the sitemap (${set.sitemap.urls.length} URLs) and a link crawl (${set.crawl.fetched} fetched, ${okPages.length} parseable), capped at ${maxPages} pages. Every count below states its own denominator; "whole site" means this union, not an unbounded sweep.`,
        },
        checklist: checks.map((c) => ({ ...c, weight: WEIGHTS[c.key] || 0 })),
        counts: {
          pass: checks.filter((c) => c.status === 'pass').length,
          warn: checks.filter((c) => c.status === 'warn').length,
          fail: checks.filter((c) => c.status === 'fail').length,
          items: checks.length,
        },
        agents: agentStatus,
        retrievalBlocked,
        llmsTxt: { present: llms.present, status: llms.status, note: 'Optional. Google has stated it does not use llms.txt; it matters only for retrieval pipelines that read it.' },
        weights: WEIGHTS,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId ? [
        { key: 'site_readiness.score', value: score, status: score >= 85 ? 'good' : (score >= 60 ? 'warn' : 'fail') },
        { key: 'site_readiness.checks_failing', value: checks.filter((c) => c.status === 'fail').length, status: checks.some((c) => c.status === 'fail') ? 'fail' : 'good' },
        { key: 'site_readiness.retrieval_agents_blocked', value: retrievalBlocked.length, status: retrievalBlocked.length ? 'fail' : 'good' },
        { key: 'site_readiness.pages_client_rendered', value: clientRendered.length, status: clientRendered.length ? 'fail' : 'good' },
        { key: 'site_readiness.sitemap_coverage', value: sitemapCoverage, status: sitemapCoverage >= 95 ? 'good' : (sitemapCoverage >= 80 ? 'warn' : 'fail') },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:site_readiness:${run.id}:${f.check_key}`,
      category: 'AI crawler readiness',
      severity: f.severity,
      affectedUrl: f.affected_url || run.target,
      evidence: f.evidence,
      dedupeKey: f.dedupe_key || `aiseo:site_readiness:${f.check_key}:${run.brand_id || 0}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, buildUrlSet, linkMechanics, markupMatchesVisible,
  VISIBLE_PROPERTIES,
};
