// FREE, KEYLESS REFERRING-PAGE PROXY
//
// competitive.js states plainly that referring-domain counts need a paid
// credential (Ahrefs/Moz/Semrush) this deployment does not have. That remains
// true for a verified, crawl-based backlink INDEX. But a coarse proxy is
// available without any key at all: search the web for pages that mention a
// domain without being that domain, via DuckDuckGo's keyless HTML endpoint
// (the same one used for keyword suggestion elsewhere in this codebase has a
// sibling — this one returns organic results, not autocomplete).
//
// WHAT THIS IS AND IS NOT
//   IS   a same-day, zero-cost list of pages currently indexed by DuckDuckGo
//        (itself backed by Bing) that mention the domain and are not the
//        domain's own pages — a real, if partial, sample of the earned web.
//   IS NOT a referring-domain COUNT in the Ahrefs/Moz sense: it has no crawl
//        depth guarantee, no link-vs-mention distinction (a page that types
//        "example.com" in running text counts the same as one that links to
//        it), and DuckDuckGo indexes a fraction of what a dedicated link
//        index does. Every caller must label it "referring pages found in a
//        web search", never "backlinks" or "referring domains".
//
// So it is reported as its own thing — a distinct signal, not a stand-in for
// the metric competitive.js already says it cannot provide.
const { sleep } = require('./fetcher');
const serpLite = require('./serpLite');

// The DuckDuckGo/Bing parsing that used to live here has been removed
// entirely — it is now in ./serpLite.js, which owns every result-page fetch in
// the suite. See referringPages() below for the two bugs that made the local
// copy return zero results while reporting success.

async function referringPages(domain, { limit = 30, excludeHost = null, market = 'ZZ' } = {}) {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) return { ok: false, error: 'no domain given', items: [], referringDomains: [] };
  const exclude = (excludeHost || clean).toLowerCase();

  const q = `"${clean}" -site:${clean}`;

  // Delegated to ./serpLite.js rather than parsing the result page here.
  //
  // THIS MODULE HAD TWO SILENT FAILURES, AND THEY COMPOUNDED.
  //
  // First, it requested the page with a self-identifying bot user agent
  // ("seo-suite-hostinger/1.0"). DuckDuckGo answers that with HTTP 202 and a
  // 14KB challenge page — a 2xx status, so `fetchPage` reported success and the
  // caller had no way to know the request had been refused.
  //
  // Second, its regex required `class="result__a"` to appear BEFORE `href=` in
  // the anchor. Attribute order is not guaranteed and DuckDuckGo does not emit
  // them that way, so the pattern matched nothing even on a good response.
  //
  // Either bug alone produces zero results reported as `ok: true`. Together
  // they meant the referring-domain figures on the competitive report were
  // structurally always empty, and the report said so as though it were a fact
  // about the web rather than about the parser. serpLite already handles the
  // browser user agent, the anomaly detection, the paced queue and both
  // engines, so the parsing lives in exactly one place now.
  const serp = await serpLite.search(q, { market, limit: Math.max(limit, 20) });
  if (!serp.ok) {
    return {
      ok: false,
      query: q,
      error: serp.error || 'no engine returned results',
      items: [],
      referringDomains: [],
    };
  }

  const items = [];
  serp.results.forEach((r) => {
    const host = r.host;
    if (!host || host === exclude || host.endsWith(`.${exclude}`)) return;
    items.push({ url: r.url, host, title: r.title });
  });

  const byDomain = new Map();
  items.forEach((it) => {
    const cur = byDomain.get(it.host) || {
      domain: it.host, count: 0, sampleUrl: it.url, sampleTitle: it.title,
    };
    cur.count += 1;
    byDomain.set(it.host, cur);
  });

  return {
    ok: true,
    query: q,
    engine: serp.engine,
    // Distinguishes "the search ran and found nothing" from "the search ran and
    // found only the domain's own pages", which the caller could not tell apart
    // from a single count.
    resultsSeen: serp.results.length,
    items: items.slice(0, limit),
    referringDomains: [...byDomain.values()].sort((a, b) => b.count - a.count).slice(0, limit),
  };
}

// Compares two sites' referring-domain proxy counts. Paced with a short sleep
// between the two calls, since both land on the same DuckDuckGo endpoint.
async function compare(ourDomain, theirDomain, opts = {}) {
  const ours = await referringPages(ourDomain, opts);
  await sleep(1200);
  const theirs = await referringPages(theirDomain, opts);
  return { ours, theirs };
}

module.exports = {
  referringPages,
  compare,
  // Re-exported from ./serpLite.js, which now owns the parsing. Kept on this
  // module's surface because callers and tests already import them from here.
  resolveResultUrl: serpLite.resolveDdgUrl,
  hostOf: serpLite.hostOf,
};
