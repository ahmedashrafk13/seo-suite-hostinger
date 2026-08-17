#!/usr/bin/env node
// Technical SEO audit — JavaScript port of tools/webtechstackdetector/main.py.
//
// WHY THIS EXISTS
// The Python original needs an interpreter plus requests and beautifulsoup4.
// Hostinger's shared hosting provides no guaranteed Python and no way to pip
// install into it, which would leave the audit feature permanently broken. This
// port needs nothing but Node and the `cheerio` package that is already in
// package.json, so the feature works on any host that can run the app itself.
//
// COMPATIBILITY
// The command line, the progress output and — most importantly — the JSON on
// stdout are identical to the Python tool's, because lib/toolRunner.js parses
// that JSON and stores it, and every downstream consumer (the report views,
// task generation, audit alerts, history comparison) reads the stored shape.
// The two implementations are interchangeable: TOOL_RUNTIME=python and
// TOOL_RUNTIME=node produce the same report for the same site.
//
// NOT PORTED: --render. Rendering needs a headless Chromium, which cannot be
// installed on shared hosting. The flag is accepted and ignored (with a note in
// the output) rather than rejected, so the app's existing call sites work
// unchanged — see the render handling below.
const {
  crawl, fetchRobots, fetchSitemaps, checkLinks, checkResources, checkHostVariants,
} = require('./crawl');
const { analyze, siteHealth, groupFindings } = require('./analyze');
const { fetchPage, isThin, thinCause } = require('./page');
const { normalizeUrl, canonUrl, sameSite, hostKey } = require('../lib/urls');

function parseArgs(argv) {
  const args = {
    url: null,
    maxPages: 200,
    workers: 10,
    slow: 3.0,
    maxLinks: 1500,
    maxResources: 800,
    delay: 0,
    noExternal: false,
    noResources: false,
    render: 'auto',
    renderWait: 2500,
    json: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--max-pages': args.maxPages = parseInt(next(), 10); break;
      case '--workers': args.workers = parseInt(next(), 10); break;
      case '--slow': args.slow = parseFloat(next()); break;
      case '--max-links': args.maxLinks = parseInt(next(), 10); break;
      case '--max-resources': args.maxResources = parseInt(next(), 10); break;
      case '--delay': args.delay = parseFloat(next()); break;
      case '--no-external': args.noExternal = true; break;
      case '--no-resources': args.noResources = true; break;
      case '--render': args.render = next(); break;
      case '--render-wait': args.renderWait = parseInt(next(), 10); break;
      case '--json': args.json = true; break;
      // Accepted and ignored: this port emits JSON only, and the app renders
      // its own document from that JSON (routes/audit.js "export").
      case '--doc': case '--html': next(); break;
      default:
        if (!a.startsWith('-')) rest.push(a);
    }
  }
  if (rest.length) [args.url] = rest;
  return args;
}

// Progress goes to stderr so stdout stays parseable as JSON. toolRunner merges
// both streams into the run log, so the user still sees it live.
function progress(msg) {
  process.stderr.write(`${msg}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    process.stderr.write('Usage: node tools/node/audit/main.js <url> [--max-pages N] [--json]\n');
    process.exit(2);
  }

  const startUrl = normalizeUrl(args.url);
  const quiet = args.json;

  // Rendering requires a headless browser that shared hosting cannot provide.
  // Rather than fail, the crawl proceeds on the served HTML and — if the seed
  // page turns out to be a JavaScript shell — says so plainly in
  // content_warning, which the report surfaces. That is the same field the
  // Python tool uses when Playwright is missing, so the UI needs no change.
  let renderHint = '';
  if (args.render === 'on') {
    renderHint = 'headless rendering is not available in the JavaScript crawler, so only the '
      + 'served HTML was read';
  }

  if (!quiet) progress(`  Crawling ${startUrl} (max ${args.maxPages} pages)...`);
  const { pages, linkSources, rawLinkSources, crawlComplete } = await crawl(
    startUrl, args.maxPages, args.workers, args.delay, quiet ? null : progress
  );

  if (!pages.size || Array.from(pages.values()).every((p) => p.error)) {
    const first = pages.values().next().value;
    const reason = first ? first.error : 'no response';
    process.stderr.write(`  Could not crawl ${startUrl}: ${reason}\n`);
    process.exit(1);
  }

  const robots = await fetchRobots(startUrl);
  const sitemap = await fetchSitemaps(robots.sitemaps, startUrl);

  // Link verification: everything not already crawled as a page.
  const crawled = new Set(pages.keys());
  const toCheck = [];
  for (const target of linkSources.keys()) {
    if (crawled.has(target)) continue;
    if (sameSite(startUrl, target) || !args.noExternal) toCheck.push(target);
  }
  // Also verify internal links AS WRITTEN when no page was fetched at that
  // exact URL. canonUrl() folds www/non-www and trailing-slash variants
  // together, so a link to the non-www homepage would resolve to the crawled
  // www page and its 301 would be invisible.
  const crawledExact = new Set(Array.from(pages.values()).map((p) => p.requested_url));
  const queued = new Set(toCheck);
  for (const target of rawLinkSources.keys()) {
    if (crawledExact.has(target) || queued.has(target)) continue;
    queued.add(target);
    toCheck.push(target);
  }
  // NOTE: sitemap URLs are deliberately NOT added to this set, even though a
  // comment in the Python tool's sitemap check says they are. They are not, in
  // the version being ported, and adding them changes the result substantially:
  // on the first site tested it took "incorrect pages in sitemap" from 2 to
  // 120, because every uncrawled sitemap entry then got a status and most of
  // them redirect. Whether that is a better audit is a separate question — this
  // port's job is to produce the same report the Python tool produces, so the
  // behaviour matches the code rather than the comment.
  const checkList = toCheck.slice(0, args.maxLinks);
  if (!quiet && checkList.length) progress(`  Verifying ${checkList.length} off-page links...`);
  const linkStatus = await checkLinks(checkList, args.workers, quiet ? null : progress);

  // Resource minification check.
  let resourceStatus = new Map();
  if (!args.noResources) {
    const assets = new Set();
    for (const p of pages.values()) {
      for (const a of p.assets) if (/\.(css|js)(\?|#|$)/i.test(a)) assets.add(a);
    }
    const list = Array.from(assets).slice(0, args.maxResources);
    if (!quiet && list.length) progress(`  Checking ${list.length} JS/CSS files for minification...`);
    resourceStatus = await checkResources(list, args.workers);
  }

  const hostVariants = await checkHostVariants(startUrl);

  const seedPage = pages.get(canonUrl(startUrl)) || pages.values().next().value || null;
  let contentWarning = null;
  if (seedPage && isThin(seedPage)) contentWarning = renderHint || thinCause(seedPage);

  const stats = {
    links_checked: linkStatus.size + crawled.size,
    resources_checked: resourceStatus.size,
    external_checked: !args.noExternal,
    rendered: false,
    content_warning: contentWarning,
    pages: pages.size,
    pages_ok: Array.from(pages.values()).filter((p) => p.ok).length,
    crawl_complete: crawlComplete,
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };

  const findings = analyze({
    startUrl,
    pages,
    linkSources,
    robots,
    sitemap,
    linkStatus,
    resourceStatus,
    slowThreshold: args.slow,
    externalChecked: !args.noExternal,
    crawlComplete,
    maxPages: args.maxPages,
    hostVariants,
    rawLinkSources,
  });

  let score = siteHealth(findings);
  // A site whose content is entirely client-rendered cannot be meaningfully
  // scored on its served HTML; capping the score prevents an empty shell from
  // reporting as healthy.
  if (contentWarning) score = Math.min(score, 12);

  const groups = groupFindings(findings);
  const result = {
    site: startUrl,
    site_health: score,
    pages_crawled: pages.size,
    pages_ok: stats.pages_ok,
    links_checked: stats.links_checked,
    resources_checked: stats.resources_checked,
    external_checked: stats.external_checked,
    rendered: stats.rendered,
    content_warning: stats.content_warning,
    counts: {
      error: groups.error.length,
      warning: groups.warning.length,
      notice: groups.notice.length,
      info: groups.info.length,
      passed: groups.passed.length,
    },
    findings,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`  Audit failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
