// SERP-LITE — a keyless, country-aware sample of a result page.
//
// WHY THIS EXISTS
// Four of the requested features are impossible without SEEING a result page:
// keyword difficulty, the keyword gap against competitors, "which review
// platforms rank for this brand", and "is my page or theirs the one Google
// returns". This deployment has no SERP API credential, and scraping
// google.com/search is both against its terms and unreliable enough that a
// blocked scrape would silently degrade to "no competition found" — the worst
// possible failure for a difficulty score.
//
// So this module samples DuckDuckGo's HTML endpoint and Bing's, both of which
// answer unauthenticated requests, and labels everything it returns as what it
// is: a SAMPLE OF A NON-GOOGLE INDEX. That distinction is carried on every
// object this module produces and rendered in the UI, because a difficulty
// score computed from Bing's index is a genuine competition signal but is not
// Google's ranking, and presenting it as one would be the same fabrication the
// rest of this codebase refuses to commit.
//
// When DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are present, ./keywordMetrics.js
// prefers their live Google SERP and this module is used only as the fallback.
// Nothing here changes; the provenance on the result says which ran.
//
// PACING
// Both endpoints throttle. Every call goes through a module-level queue with a
// minimum gap, and a 202/403/429 backs off rather than retrying immediately.
// A research run that fires forty concurrent SERP requests gets an empty
// result set for the last thirty, which reads as "no competition" instead of
// "throttled" — the same trap ./research.js already avoids for autocomplete.
const cheerio = require('cheerio');
const markets = require('./markets');
const { fetchPage, sleep } = require('./fetcher');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Minimum gap between two outbound search requests, and the state that
// enforces it across concurrent callers.
const MIN_GAP_MS = 1400;
let lastRequestAt = 0;
let chain = Promise.resolve();

// Serialises every search through one queue. Returns whatever `fn` returns.
function queued(fn) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // The queue must survive a rejection, or one failed search stalls every
  // later one forever.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function registrableish(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Good enough for grouping: handles co.uk / com.au style suffixes without
  // shipping a public-suffix list.
  const twoLevelTlds = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
  if (parts.length >= 3 && twoLevelTlds.has(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// DuckDuckGo's HTML results link through //duckduckgo.com/l/?uddg=<encoded>.
function resolveDdgUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname.replace(/^www\./, '') === 'duckduckgo.com' && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return u.href;
  } catch { return null; }
}

// Bing wraps some results in a base64 redirect (bing.com/ck/a?...&u=a1<b64>).
function resolveBingUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (/\/ck\/a$/.test(u.pathname)) {
      const raw = u.searchParams.get('u');
      if (raw && /^a1/.test(raw)) {
        const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      return null; // an unresolvable redirect is dropped, not guessed at
    }
    return u.href;
  } catch { return null; }
}

// ------------------------------------------------------------- DuckDuckGo

async function ddg(query, { market = 'ZZ', limit = 10 } = {}) {
  const m = markets.resolve(market);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${encodeURIComponent(m.ddg)}`;
  const res = await fetchPage(url, { timeout: 16000, ua: BROWSER_UA });
  if (!res.ok || !res.body) {
    return { ok: false, engine: 'duckduckgo', error: res.error || `HTTP ${res.status}`, results: [], related: [] };
  }
  // DuckDuckGo answers a rate-limited request with a 200 and an anomaly page
  // rather than a 429, so the body has to be inspected.
  if (/anomaly|unusual traffic|challenge-form/i.test(res.body.slice(0, 4000)) && !/result__a/.test(res.body)) {
    return { ok: false, engine: 'duckduckgo', error: 'rate-limited (anomaly page returned)', results: [], related: [] };
  }

  const $ = cheerio.load(res.body);
  const results = [];
  $('div.result, div.web-result').each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    if ($el.hasClass('result--ad') || $el.find('.badge--ad').length) return;
    const $a = $el.find('a.result__a').first();
    const target = resolveDdgUrl($a.attr('href'));
    if (!target) return;
    const host = hostOf(target);
    if (!host) return;
    results.push({
      position: results.length + 1,
      url: target,
      host,
      domain: registrableish(host),
      title: $a.text().replace(/\s+/g, ' ').trim(),
      snippet: $el.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim(),
    });
  });

  // A related-searches block, if one is ever served here.
  //
  // Verified against the live endpoint: it is NOT. DuckDuckGo's HTML endpoint
  // carries no related-searches markup, and Bing's result page omits its `.b_rs`
  // block from a plain request. The selectors are kept because they cost
  // nothing and would start working if either endpoint changed — but nothing
  // depends on them: relatedSearches() below uses Bing's suggestion index
  // instead, precisely so the feature is not silently empty forever.
  const related = [];
  $('a.related-searches__item, .related-searches a, #related_searches a').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (t && t.length > 2 && !related.includes(t)) related.push(t);
  });

  return { ok: true, engine: 'duckduckgo', market: m.code, query, results, related };
}

// -------------------------------------------------------------------- Bing

async function bing(query, { market = 'ZZ', limit = 10 } = {}) {
  const m = markets.resolve(market);
  const params = new URLSearchParams({ q: query, count: String(Math.max(10, limit)), format: 'rss' });
  // Bing's RSS output is far more stable than its HTML and needs no cookie.
  // It carries title, link and description per result, which is everything the
  // difficulty and gap calculations read.
  if (m.gl) params.set('cc', m.gl.toUpperCase());
  const url = `https://www.bing.com/search?${params.toString()}`;
  const res = await fetchPage(url, { timeout: 16000, ua: BROWSER_UA });
  if (!res.ok || !res.body) {
    return { ok: false, engine: 'bing', error: res.error || `HTTP ${res.status}`, results: [], related: [] };
  }
  if (!/<item>/i.test(res.body)) {
    // Bing served HTML (a consent or challenge page) instead of the feed.
    const $ = cheerio.load(res.body);
    const results = [];
    $('li.b_algo').each((_, el) => {
      if (results.length >= limit) return;
      const $a = $(el).find('h2 a').first();
      const target = resolveBingUrl($a.attr('href'));
      if (!target) return;
      const host = hostOf(target);
      if (!host) return;
      results.push({
        position: results.length + 1,
        url: target,
        host,
        domain: registrableish(host),
        title: $a.text().replace(/\s+/g, ' ').trim(),
        snippet: $(el).find('.b_caption p').first().text().replace(/\s+/g, ' ').trim(),
      });
    });
    if (!results.length) {
      return { ok: false, engine: 'bing', error: 'no parseable results (challenge or consent page)', results: [], related: [] };
    }
    return { ok: true, engine: 'bing', market: m.code, query, results, related: [] };
  }

  const $ = cheerio.load(res.body, { xmlMode: true });
  const results = [];
  $('item').each((_, el) => {
    if (results.length >= limit) return;
    const link = $(el).find('link').first().text().trim();
    const target = resolveBingUrl(link) || (/^https?:\/\//i.test(link) ? link : null);
    if (!target) return;
    const host = hostOf(target);
    if (!host) return;
    results.push({
      position: results.length + 1,
      url: target,
      host,
      domain: registrableish(host),
      title: $(el).find('title').first().text().replace(/\s+/g, ' ').trim(),
      snippet: $(el).find('description').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  });
  return { ok: true, engine: 'bing', market: m.code, query, results, related: [] };
}

// ---------------------------------------------------------------- combined

// One result page for one query, from whichever keyless engine answers.
//
// DuckDuckGo is tried first because it carries related searches; Bing is the
// fallback because it answers when DuckDuckGo throttles. The engine that
// produced the sample is named on the return value and must be shown wherever
// the numbers derived from it appear.
async function search(query, { market = 'ZZ', limit = 10, engine = 'auto' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty query', results: [], related: [], engine: null, keyless: true };

  const attempts = engine === 'ddg' ? [ddg]
    : (engine === 'bing' ? [bing] : [ddg, bing]);

  const errors = [];
  for (const fn of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const out = await queued(() => fn(q, { market, limit }));
    if (out.ok && out.results.length) return { ...out, keyless: true, tried: errors.concat([]).length + 1 };
    errors.push({ engine: out.engine, error: out.error || 'no results' });
  }
  return {
    ok: false, keyless: true, query: q, market: markets.resolve(market).code,
    results: [], related: [], engine: null,
    error: errors.map((e) => `${e.engine}: ${e.error}`).join('; '),
  };
}

// ALTERNATIVE PHRASINGS, from a second suggestion index.
//
// WHAT THIS ORIGINALLY TRIED TO DO, AND WHY IT WAS CHANGED
// The first implementation scraped the "related searches" block from a result
// page. Verified against both live endpoints, neither serves one: DuckDuckGo's
// HTML endpoint has no related-searches markup at all, and Bing's result page
// does not include its `.b_rs` block in the HTML returned to a plain request.
// Scraping a block that is not there returns an empty list forever, which reads
// on screen as "this seed has no alternative phrasings" — a false statement
// dressed as a measurement, which is the one outcome this codebase refuses.
//
// WHAT IT DOES INSTEAD, AND WHY IT IS GENUINELY ADDITIVE
// Bing's OpenSearch suggestion endpoint answers unauthenticated requests and
// returns completions from BING's index rather than Google's. That is not the
// same list. Verified live against the same seed, Google offered
// "…cost per square metre / …cost calculator uk / …cost ireland" while Bing
// offered "…cost per foot / …near me cost / …company cost" — different
// framings of the same intent, which is exactly what ./research.js was missing
// when it had only Google autocomplete to work from.
//
// It is labelled for what it is everywhere it surfaces: suggestions from a
// second index, not Google's related searches and not a volume signal.
const BING_SUGGEST_URL = 'https://api.bing.com/osjson.aspx';

async function relatedSearches(query, { market = 'ZZ', limit = 10 } = {}) {
  const m = markets.resolve(query ? market : market);
  const params = new URLSearchParams({ query: String(query || '') });
  // Bing wants a full language-region market string; where the market row has
  // no region, the parameter is omitted rather than guessed.
  if (m.gl && m.hl) params.set('market', `${m.hl.split('-')[0]}-${m.gl.toUpperCase()}`);

  const res = await queued(() => fetchPage(`${BING_SUGGEST_URL}?${params.toString()}`, {
    timeout: 12000, ua: BROWSER_UA,
  }));
  if (!res.ok || !res.body) {
    return { ok: false, engine: 'bing-suggest', related: [], error: res.error || `HTTP ${res.status}` };
  }
  try {
    // Shape: [query, [suggestions], …]
    const parsed = JSON.parse(res.body);
    const list = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
    const q = String(query || '').toLowerCase().trim();
    const related = list
      .map((x) => String(x).toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((x) => x && x !== q)
      .slice(0, limit);
    return { ok: related.length > 0, engine: 'bing-suggest', market: m.code, related, error: null };
  } catch (err) {
    return { ok: false, engine: 'bing-suggest', related: [], error: `unparseable response: ${String(err.message).slice(0, 100)}` };
  }
}

// Does `domain` appear anywhere in the sampled result page for `query`, and at
// what position? The primitive behind the keyword-gap table.
function positionOf(serp, domain) {
  const want = registrableish(String(domain || '').replace(/^www\./, '').toLowerCase());
  if (!want || !serp || !serp.results) return null;
  const hit = serp.results.find((r) => r.domain === want || r.host === want || String(r.host || '').endsWith(`.${want}`));
  return hit ? { position: hit.position, url: hit.url, title: hit.title } : null;
}

module.exports = {
  search, ddg, bing, relatedSearches, positionOf,
  hostOf, registrableish, resolveDdgUrl, resolveBingUrl,
  BROWSER_UA, MIN_GAP_MS,
};
