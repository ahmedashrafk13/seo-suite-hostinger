// Crawler, robots.txt/sitemap discovery and link verification — ported from
// crawl(), fetch_robots(), fetch_sitemaps(), check_links(), check_resources()
// and check_host_variants() in tools/webtechstackdetector/main.py.
const zlib = require('zlib');
const { fetchUrl, requestOnce, decodeBody, mapLimit, sleep } = require('../lib/http');
const {
  canonUrl, sameSite, hostKey, joinUrl, isCrawlableHtml,
} = require('../lib/urls');
const { fetchPage } = require('./page');

// A link is BROKEN only on these (definitively gone) statuses. Everything else
// (401/403/405/429/5xx/999/520-530 …) is treated as bot-blocked / transient =
// "unverified", NEVER counted as broken. This distinction is the difference
// between a report a client trusts and one they dismiss.
const BROKEN_STATUSES = new Set([404, 410]);

// --- crawl ----------------------------------------------------------------
async function crawl(startUrl, maxPages, workers, delay, onProgress) {
  const seed = canonUrl(startUrl);
  const seen = new Set([seed]);
  const pages = new Map();
  const linkSources = new Map();     // canonical target -> Set(source page urls)
  // Internal links keyed AS WRITTEN (www/non-www, http/https, trailing slash
  // preserved). linkSources folds those variants together via canonUrl(), which
  // is right for most checks but hides redirects — links to the non-www
  // homepage would look identical to links to the canonical www one.
  const rawLinkSources = new Map();
  const frontier = [startUrl];

  const addSource = (map, key, src) => {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(src);
  };

  while (frontier.length && pages.size < maxPages) {
    const wave = [];
    while (frontier.length && wave.length < workers * 3 && pages.size + wave.length < maxPages) {
      wave.push(frontier.shift());
    }

    const fetched = await mapLimit(wave, workers, (u) => fetchPage(u));
    for (const page of fetched) {
      if (!page || page.__error) continue;
      pages.set(canonUrl(page.requested_url), page);
      for (const link of Array.from(page.internal_links).sort()) {
        addSource(linkSources, canonUrl(link), page.url);
        addSource(rawLinkSources, link, page.url);
        const c = canonUrl(link);
        if (!seen.has(c) && isCrawlableHtml(link)) {
          seen.add(c);
          frontier.push(link);
        }
      }
      for (const link of Array.from(page.external_links).sort()) {
        addSource(linkSources, canonUrl(link), page.url);
      }
    }

    if (onProgress) onProgress(`  crawled ${pages.size} pages, ${frontier.length} queued ...`);
    if (delay) await sleep(delay * 1000);
  }

  return { pages, linkSources, rawLinkSources, crawlComplete: frontier.length === 0 };
}

// --- robots.txt -----------------------------------------------------------
// A minimal robots.txt matcher covering what can_fetch() is used for here:
// which crawled pages are disallowed for our user agent. Longest-match wins
// between Allow and Disallow, as the spec (and Google) require; * and $
// wildcards are supported.
function buildRobotsMatcher(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines share the following rules.
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  const toRegex = (pattern) => {
    // Escape everything except the two wildcard characters robots.txt defines.
    let re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    let anchoredEnd = false;
    if (re.endsWith('$')) { anchoredEnd = true; re = re.slice(0, -1); }
    return new RegExp(`^${re}${anchoredEnd ? '$' : ''}`);
  };

  const pick = (ua) => {
    const lower = String(ua || '').toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const g of groups) {
      for (const a of g.agents) {
        if (a === '*') {
          if (bestLen < 0) { best = g; bestLen = 0; }
        } else if (lower.includes(a) && a.length > bestLen) {
          best = g; bestLen = a.length;
        }
      }
    }
    return best;
  };

  return function canFetch(ua, url) {
    const group = pick(ua);
    if (!group) return true;
    let path;
    try {
      const p = new URL(url);
      path = `${p.pathname}${p.search}`;
    } catch {
      return true;
    }
    let verdict = true;
    let bestLen = -1;
    for (const rule of group.rules) {
      if (rule.path === '') {
        // "Disallow:" with an empty value allows everything; it never wins on
        // length, so it is simply skipped.
        continue;
      }
      if (toRegex(rule.path).test(path) && rule.path.length > bestLen) {
        bestLen = rule.path.length;
        verdict = rule.allow;
      }
    }
    return verdict;
  };
}

async function fetchRobots(baseUrl) {
  const out = {
    exists: false, status: null, text: '', sitemaps: [],
    canFetch: null, issues: [], blocks_all: false,
  };
  const robotsUrl = joinUrl(baseUrl, '/robots.txt');
  try {
    const r = await fetchUrl(robotsUrl, { timeout: 12000 });
    out.status = r.status;
    const text = decodeBody(r);
    if (r.status === 200 && text.trim()) {
      out.exists = true;
      out.text = text;
      out.canFetch = buildRobotsMatcher(text);
      for (const line of text.split(/\r?\n/)) {
        if (line.toLowerCase().startsWith('sitemap:')) {
          out.sitemaps.push(line.slice(line.indexOf(':') + 1).trim());
        }
      }
      const uaAll = /user-agent:\s*\*([\s\S]*?)(?:\nuser-agent:|$)/i.exec(text);
      if (uaAll && /^\s*disallow:\s*\/\s*$/im.test(uaAll[1])) out.blocks_all = true;
    }
  } catch (err) {
    out.issues.push(`robots.txt fetch failed: ${err.kind || 'error'}`);
  }
  return out;
}

// --- sitemaps -------------------------------------------------------------
// Parsed with regular expressions rather than an XML library: sitemaps are a
// flat, well-known shape, and real ones are frequently malformed in ways a
// strict parser rejects outright (stray entities, BOMs, mixed namespaces).
// Extracting <loc>/<lastmod> textually reads those anyway, which is what a
// search engine effectively does.
function extractTags(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, 'gi');
  const out = [];
  let m = re.exec(xml);
  while (m) {
    out.push(m[1].trim());
    m = re.exec(xml);
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

async function fetchSitemaps(sitemapUrls, baseUrl) {
  const out = { found: [], urls: [], lastmods: {}, issues: [], count: 0, tried: [] };
  let queue;
  let guessed = new Set();
  if (sitemapUrls && sitemapUrls.length) {
    queue = [...sitemapUrls];
  } else {
    guessed = new Set(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']
      .map((p) => joinUrl(baseUrl, p)));
    queue = [...guessed];
  }
  const seen = new Set();

  const note = (smUrl, msg) => {
    // A guessed URL that is absent is not an issue — it was only a guess.
    if (!guessed.has(smUrl)) out.issues.push(`${smUrl} — ${msg}`);
  };

  while (queue.length && out.found.length < 25) {
    const smUrl = queue.shift();
    if (seen.has(smUrl)) continue;
    seen.add(smUrl);
    out.tried.push(smUrl);

    let r;
    try {
      r = await fetchUrl(smUrl, { timeout: 12000 });
    } catch (err) {
      note(smUrl, `fetch failed (${err.kind || 'error'})`);
      continue;
    }
    if (r.status !== 200) {
      note(smUrl, `HTTP ${r.status}`);
      continue;
    }
    let content = r.body;
    const ctype = String(r.headers['content-type'] || '').toLowerCase();
    if (smUrl.toLowerCase().endsWith('.gz') || ctype.includes('gzip')) {
      try { content = zlib.gunzipSync(content); } catch { /* already decompressed */ }
    }
    const head = content.slice(0, 512).toString('utf8').replace(/^\s+/, '').toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      note(smUrl, 'returns an HTML page, not an XML sitemap');
      continue;
    }
    const xml = content.toString('utf8');
    if (!/<\s*(?:[a-zA-Z0-9]+:)?(urlset|sitemapindex)\b/i.test(xml)) {
      note(smUrl, 'not valid XML');
      continue;
    }
    out.found.push(smUrl);

    const isIndex = /<\s*(?:[a-zA-Z0-9]+:)?sitemapindex\b/i.test(xml);
    if (isIndex) {
      extractTags(xml, 'loc').forEach((loc) => queue.push(decodeEntities(loc)));
    } else {
      // Split on <url> blocks so each <loc> keeps its own <lastmod>.
      const blocks = xml.split(/<\s*(?:[a-zA-Z0-9]+:)?url\b[^>]*>/i).slice(1);
      for (const block of blocks) {
        const loc = extractTags(block, 'loc')[0];
        const lastmod = extractTags(block, 'lastmod')[0];
        if (!loc) continue;
        const url = decodeEntities(loc);
        out.urls.push(url);
        if (lastmod) out.lastmods[canonUrl(url)] = lastmod;
      }
    }
  }

  out.count = out.urls.length;
  return out;
}

// --- link verification ----------------------------------------------------
// Returns [url, status, err, firstHopStatus, redirected]; the last two let the
// caller detect permanent (301) redirects without a second request.
async function checkLink(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Only the headers matter here, so the body is capped hard — link
      // verification across a large site would otherwise download the site.
      const r = await fetchUrl(url, { timeout: 15000, maxBytes: 2048 });
      const status = r.status;
      const firstHop = r.history.length ? r.history[0].status : status;
      return [url, status, null, firstHop, r.history.length > 0];
    } catch (err) {
      if (err.kind === 'connection') { lastErr = 'Connection error'; continue; }
      if (err.kind === 'timeout') return [url, null, 'Timeout', null, false];
      if (err.kind === 'redirect_loop') return [url, null, 'Redirect loop', null, false];
      if (err.kind === 'ssl') return [url, null, 'SSL error', null, false];
      return [url, null, err.name || 'Error', null, false];
    }
  }
  return [url, null, lastErr, null, false];
}

async function checkLinks(urls, workers, onProgress) {
  const results = new Map();
  if (!urls.length) return results;
  let done = 0;
  const rows = await mapLimit(urls, workers, async (u) => {
    const r = await checkLink(u);
    done += 1;
    if (onProgress && done % 25 === 0) onProgress(`  verified ${done}/${urls.length} links ...`);
    return r;
  });
  rows.forEach((row) => {
    if (!row || row.__error) return;
    const [url, status, err, firstHop, redirected] = row;
    results.set(url, [status, err, firstHop, redirected]);
  });
  return results;
}

function linkVerdict(status, err) {
  if (BROKEN_STATUSES.has(status)) return ['broken', `HTTP ${status}`];
  if (err && (/connection/i.test(err) || /dns/i.test(err))) return ['broken', 'connection refused / DNS failure'];
  if (status != null && status >= 200 && status < 400) return ['ok', null];
  if (status != null) return ['unverified', `HTTP ${status} (bot-blocked or transient)`];
  return ['unverified', err || 'not verifiable'];
}

// Plain-language reason an unverifiable link could not be confirmed — shown in
// the "could not verify" section so the report explains WHY.
function verifyReason(status, err) {
  if (status != null) {
    if ([401, 403, 405, 406, 999].includes(status)) {
      return `blocked to automated crawlers (HTTP ${status}) — likely works in a browser`;
    }
    if (status === 429) return 'rate-limited by the server (HTTP 429)';
    if (status >= 500 && status < 600) return `server error / temporarily unavailable (HTTP ${status})`;
    return `unexpected response (HTTP ${status})`;
  }
  const e = String(err || '').toLowerCase();
  if (e.includes('timeout')) return 'request timed out (server too slow or blocking crawlers)';
  if (e.includes('ssl')) return 'SSL / certificate error';
  if (e.includes('redirect')) return 'redirect loop';
  if (e.includes('connection')) return 'connection error';
  return err || 'could not connect';
}

// --- resource minification ------------------------------------------------
// Heuristic: minified files pack code onto very few, very long lines.
// Unminified files have many newlines and a short average line length.
function isUnminified(url, text) {
  const low = url.toLowerCase();
  if (low.includes('.min.') || low.includes('-min.')) return false;
  if (!text || text.length < 800) return false; // tiny files aren't worth flagging
  const lines = (text.match(/\n/g) || []).length + 1;
  if (lines <= 8) return false;                 // already on a handful of long lines
  const avgLine = text.length / lines;
  const indented = (text.match(/\n {2}/g) || []).length + (text.match(/\n\t/g) || []).length;
  return avgLine < 200 && (lines > 15 || indented > 10);
}

async function checkResource(url) {
  try {
    const r = await requestOnce(url, { timeout: 12000, maxBytes: 300000 });
    if (r.status !== 200) return [url, null];
    return [url, isUnminified(url, r.body.toString('utf8'))];
  } catch {
    return [url, null];
  }
}

async function checkResources(urls, workers) {
  const results = new Map();
  if (!urls.length) return results;
  const rows = await mapLimit(urls, workers, (u) => checkResource(u));
  rows.forEach((row) => {
    if (!row || row.__error) return;
    const [url, unmin] = row;
    if (unmin !== null && unmin !== undefined) results.set(url, unmin);
  });
  return results;
}

// --- www vs non-www -------------------------------------------------------
// If BOTH hosts serve HTTP 200 without one redirecting to the other, every URL
// exists twice — which is exactly why crawlers report ~2x the page and issue
// count on such sites.
async function checkHostVariants(startUrl) {
  const base = hostKey(startUrl);
  const wwwUrl = `https://www.${base}/`;
  const nonwwwUrl = `https://${base}/`;

  const probe = async (u) => {
    try {
      const r = await fetchUrl(u, { timeout: 15000, maxBytes: 4096 });
      return [r.status, new URL(r.url).host.toLowerCase().split(':')[0]];
    } catch {
      return [null, null];
    }
  };

  const [[ws, wh], [ns, nh]] = await Promise.all([probe(wwwUrl), probe(nonwwwUrl)]);
  const duplicate = Boolean(ws === 200 && ns === 200 && wh && nh
    && wh.startsWith('www.') && !nh.startsWith('www.'));
  return { duplicate, www: wwwUrl, nonwww: nonwwwUrl };
}

// --- duplicate content ----------------------------------------------------
// Cluster pages whose visible-text shingle sets overlap >= threshold (Jaccard).
function findDuplicateContent(pages, threshold = 0.85) {
  const sigs = pages
    .filter((p) => p.content_sig && p.content_sig.size >= 10)
    .map((p) => [p, p.content_sig]);
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < sigs.length; i += 1) {
    const [pi, si] = sigs[i];
    if (used.has(pi)) continue;
    const group = [pi];
    for (let j = i + 1; j < sigs.length; j += 1) {
      const [pj, sj] = sigs[j];
      if (used.has(pj)) continue;
      let inter = 0;
      // Iterate the smaller set — the cost of this loop dominates on large crawls.
      const [small, large] = si.size <= sj.size ? [si, sj] : [sj, si];
      for (const sh of small) if (large.has(sh)) inter += 1;
      if (!inter) continue;
      const union = si.size + sj.size - inter;
      if (union && inter / union >= threshold) {
        group.push(pj);
        used.add(pj);
      }
    }
    if (group.length > 1) {
      used.add(pi);
      clusters.push(group.map((p) => p.url));
    }
  }
  return clusters;
}

module.exports = {
  crawl, fetchRobots, fetchSitemaps, checkLinks, checkLink, checkResources,
  checkHostVariants, findDuplicateContent, linkVerdict, verifyReason,
  isUnminified, buildRobotsMatcher, BROKEN_STATUSES,
};
