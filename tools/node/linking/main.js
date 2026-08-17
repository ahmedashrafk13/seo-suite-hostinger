#!/usr/bin/env node
// Internal linking agent — JavaScript port of
// tools/internal-linking-agent/internal_link_agent.py.
//
// WHY THIS EXISTS
// The Python original needs httpx, numpy, beautifulsoup4, lxml, python-docx and
// openpyxl. Hostinger's shared hosting provides no guaranteed Python and no way
// to pip install into it, which would leave the internal-linking feature
// permanently broken. This port needs only Node and packages already in
// package.json (cheerio, exceljs, docx).
//
// COMPATIBILITY
// The command line and — critically — the OUTPUT DIRECTORY CONTENTS are
// identical to the Python tool's: the same five .xlsx workbooks with the same
// column headers, crawl_data.json, summary.json and a .docx. src/lib/csvStore.js
// reads those by name, so the dashboard, the task generator and the downloadable
// reports all work unchanged.
//
// NOT PORTED: --render (needs a headless Chromium that shared hosting cannot
// install) and the optional spaCy NER anchor filter (a no-op in the Python
// whenever spaCy is absent, which it is on any host that cannot pip install).
// Both are accepted as flags and reported honestly in summary.json.
const fs = require('fs');
const path = require('path');
const { DEFAULTS, applyLocale } = require('./config');
const { normalizeUrl, sameSite, unifyOrigin, urlSlugWords, tokenize } = require('./urls');
const {
  Crawler, applyCanonicals, remapLinks, stripTemplateBlocks, log,
} = require('./crawler');
const {
  buildGraph, buildVectors, similarityMatrix, resolveSiteBranding,
  derivePrimaryKeywords, buildDiscriminatingTokens,
} = require('./analysis');
const {
  findCannibalization, groupDuplicateClusters, collapseDuplicatePairs,
  DUPLICATE_SEVERITIES,
} = require('./cannibalization');
const { recommend } = require('./recommend');
const { writeXlsx, buildDocx } = require('./report');

const TOTAL_STEPS = 8;
function step(n, msg) {
  process.stderr.write(`  [${n}/${TOTAL_STEPS}] ${msg}\n`);
}

function parseArgs(argv) {
  const args = {
    url: null, out: null, locale: 'en', render: false, gscCsv: null,
    include: [], exclude: [], ignoreRobots: false, verifyTls: false,
    userAgent: null,
  };
  const numeric = {
    '--max-pages': 'max_pages',
    '--concurrency': 'concurrency',
    '--delay': 'delay',
    '--max-new-links-per-source': 'max_new_links_per_source',
    '--max-new-inbound-per-target': 'max_new_inbound_per_target',
    '--min-source-words': 'min_source_words',
    '--boilerplate-ratio': 'boilerplate_ratio',
    '--max-same-anchor': 'max_same_anchor',
    '--words-per-link': 'words_per_link',
    '--max-editorial-out-per-page': 'max_editorial_out_per_page',
    '--top-k-similar': 'top_k_similar',
    '--min-similarity': 'min_similarity',
    '--min-content-words': 'min_content_words',
    '--anchor-max-owners': 'anchor_max_owners',
    '--anchor-sentence-terms': 'anchor_sentence_terms',
    '--crawl-delay-cap': 'crawl_delay_cap',
  };
  const overrides = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (numeric[a]) { overrides[numeric[a]] = Number(next()); continue; }
    switch (a) {
      case '--out': args.out = next(); break;
      case '--locale': case '--lang': args.locale = next(); break;
      case '--gsc-csv': args.gscCsv = next(); break;
      case '--include': args.include.push(next()); break;
      case '--exclude': args.exclude.push(next()); break;
      case '--user-agent': args.userAgent = next(); break;
      case '--ignore-robots': args.ignoreRobots = true; break;
      case '--verify-tls': args.verifyTls = true; break;
      case '--render': args.render = true; break;
      default:
        if (!a.startsWith('-')) rest.push(a);
    }
  }
  if (rest.length) [args.url] = rest;
  return { args, overrides };
}

// Load a Search Console "Pages" CSV and join it onto crawled pages by the same
// canonicalisation the rest of the tool uses.
const GSC_COLUMN_ALIASES = {
  url: 'url', page: 'url', 'landing page': 'url', 'top pages': 'url',
  clicks: 'clicks', impressions: 'impressions',
  position: 'position', 'average position': 'position',
  'avg. position': 'position', 'avg position': 'position',
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadGscCsv(csvPath, pages, origin, host, notes) {
  let text;
  try {
    text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    notes.push(`Search Console CSV could not be read (${err.message}); continuing without it.`);
    return null;
  }
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => GSC_COLUMN_ALIASES[String(h).trim().toLowerCase()] || null);
  if (!headers.includes('url')) {
    notes.push('Search Console CSV has no recognisable URL column; continuing without it.');
    return null;
  }
  const byUrl = {};
  let matched = 0;
  let unmatched = 0;
  for (const r of rows.slice(1)) {
    const rec = {};
    headers.forEach((h, i) => { if (h) rec[h] = r[i]; });
    if (!rec.url) continue;
    const norm = unifyOrigin(normalizeUrl(rec.url), origin, host);
    const num = (v) => {
      const n = parseFloat(String(v == null ? '' : v).replace(/[,%\s]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    if (norm && pages.has(norm)) {
      byUrl[norm] = {
        clicks: num(rec.clicks),
        impressions: num(rec.impressions),
        position: rec.position === undefined ? 100 : num(rec.position),
      };
      matched += 1;
    } else {
      unmatched += 1;
    }
  }
  log(`Search Console data joined: ${matched} matched, ${unmatched} unmatched`);
  return { by_url: byUrl, matched, unmatched };
}

async function main() {
  const t0 = Date.now();
  const { args, overrides } = parseArgs(process.argv.slice(2));
  if (!args.url) {
    process.stderr.write('Usage: node tools/node/linking/main.js <url> [--max-pages N] [--out DIR]\n');
    process.exit(2);
  }

  // Must run before any tokenizing/anchor work happens: it repopulates the
  // stopword/generic-anchor word lists for this run's language.
  const appliedLocale = applyLocale(args.locale);

  const cfg = { ...DEFAULTS, ...overrides };
  // Clamp every numeric input. An unclamped 0 surfaced as a division-by-zero
  // only after the entire crawl had finished.
  cfg.max_pages = Math.max(1, cfg.max_pages);
  cfg.concurrency = Math.max(1, cfg.concurrency);
  cfg.delay = Math.max(0, cfg.delay);
  cfg.max_new_links_per_source = Math.max(1, cfg.max_new_links_per_source);
  cfg.max_new_inbound_per_target = Math.max(1, cfg.max_new_inbound_per_target);
  cfg.boilerplate_ratio = Math.min(Math.max(cfg.boilerplate_ratio, 0.05), 1.0);
  cfg.max_same_anchor = Math.max(1, cfg.max_same_anchor);
  cfg.words_per_link = Math.max(10, cfg.words_per_link);
  cfg.max_editorial_out_per_page = Math.max(1, cfg.max_editorial_out_per_page);
  cfg.top_k_similar = Math.max(1, cfg.top_k_similar);
  cfg.min_similarity = Math.min(Math.max(cfg.min_similarity, 0), 1);
  cfg.min_content_words = Math.max(1, cfg.min_content_words);
  cfg.anchor_max_owners = Math.max(1, cfg.anchor_max_owners);
  cfg.anchor_sentence_terms = Math.max(0, cfg.anchor_sentence_terms);
  cfg.crawl_delay_cap = Math.max(0, cfg.crawl_delay_cap);
  // A page cannot be a link source below the density floor anyway, so
  // advertising a lower minimum than words_per_link would be misleading.
  cfg.min_source_words = Math.max(cfg.min_source_words, cfg.words_per_link);
  cfg.include = args.include;
  cfg.exclude = args.exclude;
  cfg.user_agent = args.userAgent || 'Mozilla/5.0 (compatible; InternalLinkingAgent/1.0)';
  cfg.respect_robots = !args.ignoreRobots;
  cfg.render = args.render;
  cfg.gsc_csv = args.gscCsv;
  cfg.locale = args.locale;
  cfg.applied_locale = appliedLocale;

  for (const pat of [...cfg.include, ...cfg.exclude]) {
    try { new RegExp(pat); } catch (err) {
      process.stderr.write(`\nInvalid --include/--exclude regex ${pat}: ${err.message}\n`);
      process.exit(2);
    }
  }

  const targetUrl = args.url;
  const crawler = new Crawler(targetUrl, cfg);
  const outdir = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, 'reports', `${crawler.host.replace(/:/g, '_')}-${Date.now()}`);

  process.stderr.write(`${'='.repeat(74)}\n  INTERNAL LINKING AGENT\n`);
  process.stderr.write(`  target : ${targetUrl}\n  output : ${outdir}\n`);
  process.stderr.write(`  budget : ${cfg.max_pages} pages\n${'='.repeat(74)}\n`);
  if (args.render) {
    crawler.notes.push('--render was requested but headless rendering is not available in the '
      + 'JavaScript crawler; the served HTML was analysed instead.');
  }

  step(1, 'Crawling');
  await crawler.crawl(targetUrl, (m) => process.stderr.write(`  ${m}\n`));
  if (!crawler.pages.size) {
    process.stderr.write(`\n  Could not crawl ${targetUrl} — no pages were fetched.\n`);
    process.exit(1);
  }

  // Computed after the crawl, because resolveOrigin() may have moved the host
  // to its www/https spelling — naming the deliverable from the pre-redirect
  // host would disagree with every URL inside it.
  const safeHost = crawler.host.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

  step(2, 'Merging canonicals');
  let pages = applyCanonicals(crawler.pages, crawler.notes);
  remapLinks(pages);

  step(3, 'Removing template blocks');
  const templateStats = stripTemplateBlocks(pages, cfg, crawler.notes);

  step(4, 'Resolving site branding');
  const brand = resolveSiteBranding(pages, cfg, crawler.notes);

  const urls = Array.from(pages.keys());
  step(5, 'Vectorizing content');
  const vec = buildVectors(pages, urls);
  const sim = similarityMatrix(vec.rows);

  derivePrimaryKeywords(pages, urls, brand);
  buildDiscriminatingTokens(pages, urls, brand, cfg);

  step(6, 'Building link graph');
  const graph = buildGraph(pages, cfg);

  const gsc = args.gscCsv ? loadGscCsv(args.gscCsv, pages, crawler.root, crawler.host, crawler.notes) : null;

  step(7, 'Finding cannibalization and recommendations');
  let cannibal = findCannibalization(pages, urls, sim, cfg);
  const dupClusters = groupDuplicateClusters(cannibal);
  cannibal = collapseDuplicatePairs(cannibal, dupClusters);
  const dupPages = new Set(dupClusters.flat());

  const nerStats = { rejected: 0 };
  const { recs, rejectStats } = recommend(pages, urls, sim, graph, cannibal, cfg, brand,
    dupPages, nerStats, gsc, {});

  // ---- derived report tables ---------------------------------------------
  const contentUrls = urls.filter((u) => pages.get(u).kind === 'content');

  let orphans = [];
  if (!graph.editorial_edges.size) {
    // With zero editorial links site-wide, every page trivially has zero
    // editorial inbound links and "orphan" cannot distinguish between them. The
    // real finding is site-level, so it is stated as a note instead of as
    // hundreds of orphan rows.
    crawler.notes.push(
      'ORPHAN ANALYSIS SUPPRESSED: this crawl found zero editorial (in-content) internal '
      + 'links across the whole site, so every page trivially has zero editorial inbound '
      + `links and 'orphan' cannot distinguish between them. The real finding is site-level: `
      + `all ${graph.boiler_edges.size} internal links sit in navigation, footer or other `
      + 'template furniture, and no page links to another from within its body copy. Fix '
      + 'that first - adding in-content links is the recommendation, and orphan status only '
      + 'becomes measurable once some exist.'
    );
    log('orphan analysis suppressed: zero editorial links found sitewide');
  } else {
    orphans = contentUrls
      .filter((u) => pages.get(u).inbound_editorial === 0)
      .map((u) => {
        const p = pages.get(u);
        return {
          url: u,
          title: p.title,
          h1: p.h1,
          word_count: p.word_count,
          inbound_editorial: 0,
          inbound_boilerplate: p.inbound_boilerplate,
          depth: p.depth,
          noindex: p.noindex,
          primary_keyword: p.primary_keyword,
          gsc_impressions: gsc && gsc.by_url[u] ? gsc.by_url[u].impressions : 0,
        };
      });
  }
  if (gsc && Object.keys(gsc.by_url).length) {
    orphans.sort((a, b) => (b.gsc_impressions - a.gsc_impressions) || (b.word_count - a.word_count));
  } else {
    orphans.sort((a, b) => (a.inbound_boilerplate - b.inbound_boilerplate) || (b.word_count - a.word_count));
  }

  const underlinked = urls
    .filter((u) => pages.get(u).inbound_editorial > 0 && pages.get(u).inbound_editorial <= 2
      && pages.get(u).kind === 'content')
    .map((u) => {
      const p = pages.get(u);
      return {
        url: u,
        title: p.title,
        word_count: p.word_count,
        inbound_editorial: p.inbound_editorial,
        inbound_boilerplate: p.inbound_boilerplate,
        pagerank: p.pagerank,
        noindex: p.noindex,
        primary_keyword: p.primary_keyword,
        gsc_impressions: gsc && gsc.by_url[u] ? gsc.by_url[u].impressions : 0,
      };
    });
  underlinked.sort((a, b) => (a.inbound_editorial - b.inbound_editorial) || (b.word_count - a.word_count));

  const saturated = urls
    .filter((u) => {
      const p = pages.get(u);
      return p.outbound_editorial >= cfg.max_editorial_out_per_page
        || (p.word_count && p.outbound_editorial > p.word_count / cfg.words_per_link);
    })
    .map((u) => ({
      url: u,
      outbound_editorial: pages.get(u).outbound_editorial,
      word_count: pages.get(u).word_count,
      links_total: pages.get(u).link_count_total,
    }));
  saturated.sort((a, b) => b.outbound_editorial - a.outbound_editorial);

  // "Avoid excessive links" also has to be measured against the TOTAL link
  // count, nav and footer included — that is what a crawler actually sees and
  // what dilutes the equity each link carries.
  const linkLoads = urls.map((u) => pages.get(u).link_count_total).sort((a, b) => b - a);
  const medianLinks = linkLoads.length ? linkLoads[Math.floor(linkLoads.length / 2)] : 0;
  const heavyCut = Math.max(150, Math.floor(medianLinks * 1.5));
  const linkHeavy = urls
    .filter((u) => pages.get(u).link_count_total >= heavyCut)
    .map((u) => ({
      url: u,
      links_total: pages.get(u).link_count_total,
      outbound_editorial: pages.get(u).outbound_editorial,
      word_count: pages.get(u).word_count,
    }));
  linkHeavy.sort((a, b) => b.links_total - a.links_total);

  const nonContent = urls
    .filter((u) => pages.get(u).kind !== 'content')
    .map((u) => {
      const p = pages.get(u);
      return {
        url: u,
        kind: p.kind,
        inbound_editorial: p.inbound_editorial,
        inbound_boilerplate: p.inbound_boilerplate,
        word_count: p.word_count,
        title: p.title,
      };
    });

  // ---- broken internal links ---------------------------------------------
  // A 4xx is a broken link. A 429/5xx that survived every retry is a server
  // that was unavailable during THIS crawl — reporting it as a broken link
  // would put a false defect in front of the client. Both are listed, labelled
  // apart.
  const broken = [];
  const transientCodes = new Set(cfg.retry_statuses.map((c) => `HTTP ${c}`));
  const badStatus = new Map();
  for (const [u, p] of pages) {
    if (p.status && p.status >= 400) badStatus.set(u, `HTTP ${p.status}`);
  }
  if (badStatus.size) {
    const referrers = new Map();
    for (const [src, page] of pages) {
      for (const target of page.raw_out_urls) {
        if (!badStatus.has(target)) continue;
        if (!referrers.has(target)) referrers.set(target, new Set());
        referrers.get(target).add(src);
      }
    }
    const sitemapSet = new Set(crawler.sitemapUrls);
    for (const [u, why] of Array.from(badStatus.entries()).sort()) {
      const refs = Array.from(referrers.get(u) || []).sort();
      broken.push({
        url: u,
        status: why,
        referring_pages: refs.length,
        linked_from: refs.slice(0, 5).join('; '),
        in_sitemap: sitemapSet.has(u),
        classification: transientCodes.has(why)
          ? 'server unavailable during crawl - re-check before acting'
          : 'broken link',
      });
    }
    broken.sort((a, b) => {
      const ab = a.classification !== 'broken link';
      const bb = b.classification !== 'broken link';
      if (ab !== bb) return ab ? 1 : -1;
      return (b.referring_pages - a.referring_pages) || a.url.localeCompare(b.url);
    });
    const linkedBroken = broken.filter((b) => b.referring_pages && b.classification === 'broken link');
    if (linkedBroken.length) {
      log(`broken internal links: ${linkedBroken.length} URL(s) return an error and are linked from other pages`);
    }
  }

  // ---- malformed hrefs -----------------------------------------------------
  const malformed = new Map();
  for (const [u, page] of pages) {
    for (const href of page.malformed_hrefs) {
      if (!malformed.has(href)) malformed.set(href, []);
      malformed.get(href).push(u);
    }
  }
  if (malformed.size) {
    crawler.notes.push(
      `${malformed.size} malformed href(s) found in the markup using a single slash after the `
      + "scheme (e.g. 'https:/example.com/page'). Browsers and crawlers resolve these to "
      + 'nonsense URLs; some servers still answer HTTP 200, creating duplicate indexable URLs.'
    );
  }

  // Coverage must be judged by set membership, not by comparing totals. A crawl
  // can fetch MORE pages than the sitemap lists while still having missed some
  // of the sitemap's URLs, which would silently make orphan status provisional.
  const analyzed = new Set(urls);
  for (const u of urls) pages.get(u).aliases.forEach((a) => analyzed.add(a));
  const unanalyzed = crawler.sitemapUrls.filter((u) => !analyzed.has(u)).sort();
  const coverage = {
    sitemap_urls: crawler.sitemapUrls.length,
    analyzed_pages: urls.length,
    sitemap_urls_not_analyzed: unanalyzed.length,
    examples: unanalyzed.slice(0, 20),
    complete: unanalyzed.length === 0,
    budget_exhausted: crawler.pages.size >= cfg.max_pages,
  };
  if (unanalyzed.length) {
    crawler.notes.push(
      `COVERAGE: ${unanalyzed.length} of ${crawler.sitemapUrls.length} sitemap URLs were not `
      + `analyzed. Orphan status is definitive only for the ${urls.length} pages actually `
      + 'analyzed.'
      + (coverage.budget_exhausted
        ? ` The page budget was reached - re-run with --max-pages ${crawler.sitemapUrls.length + 100} for full coverage.`
        : ' The budget was not the limit: those URLs error, redirect, or are not HTML.')
    );
    log(`coverage: ${unanalyzed.length} sitemap URL(s) not analyzed `
      + `(${coverage.budget_exhausted ? 'budget reached' : 'not analyzable'})`);
  } else {
    log(`coverage: complete - all ${crawler.sitemapUrls.length} sitemap URLs analyzed`);
  }
  if (crawler.unfetchedDiscovered.size) {
    crawler.notes.push(
      `${crawler.unfetchedDiscovered.size} URL(s) were discovered as link targets but never `
      + 'fetched, because the crawl budget ran out first. They are neither analyzed nor counted '
      + 'as failures, and links FROM them are invisible to this run.'
    );
  }

  // ---- write outputs -------------------------------------------------------
  step(8, 'Writing outputs');
  fs.mkdirSync(outdir, { recursive: true });
  const elapsed = (Date.now() - t0) / 1000;

  await writeXlsx(path.join(outdir, 'recommendations.xlsx'), recs, [
    'priority', 'confidence', 'source_url', 'target_url', 'anchor_text',
    'anchor_omits', 'anchor_source', 'context_sentence', 'block_index',
    'char_start', 'char_end', 'similarity', 'score', 'reason', 'target_title',
    'target_inbound_editorial', 'source_words', 'source_existing_editorial_out',
  ]);
  await writeXlsx(path.join(outdir, 'orphans.xlsx'),
    [...orphans.map((o) => ({ ...o, status: 'orphan' })),
      ...underlinked.map((u) => ({ ...u, status: 'under-linked' }))],
    ['status', 'url', 'inbound_editorial', 'inbound_boilerplate', 'word_count',
      'noindex', 'primary_keyword', 'title', 'gsc_impressions']);
  await writeXlsx(path.join(outdir, 'broken_links.xlsx'), broken, [
    'url', 'status', 'classification', 'referring_pages', 'linked_from', 'in_sitemap',
  ]);
  await writeXlsx(path.join(outdir, 'non_editorial_pages.xlsx'), nonContent, [
    'url', 'kind', 'inbound_editorial', 'inbound_boilerplate', 'word_count', 'title',
  ]);
  await writeXlsx(path.join(outdir, 'cannibalization.xlsx'), cannibal, [
    'severity', 'shared_keyword', 'similarity', 'page_a', 'title_a', 'words_a',
    'inbound_a', 'page_b', 'title_b', 'words_b', 'inbound_b', 'shared_terms',
    'evidence', 'recommendation',
  ]);

  const crawlData = urls.map((u) => {
    const p = pages.get(u);
    return {
      url: u,
      title: p.title,
      h1: p.h1,
      meta_description: p.meta_description,
      word_count: p.word_count,
      depth: p.depth,
      noindex: p.noindex,
      lang: p.lang,
      canonical: p.canonical,
      aliases: p.aliases,
      kind: p.kind,
      inbound_editorial: p.inbound_editorial,
      inbound_boilerplate: p.inbound_boilerplate,
      outbound_editorial: p.outbound_editorial,
      links_total: p.link_count_total,
      pagerank: p.pagerank,
      primary_keyword: p.primary_keyword,
      top_terms: p.top_terms,
      extraction_mode: p.extraction_mode,
      zero_vector: p.zero_vector,
    };
  });
  fs.writeFileSync(path.join(outdir, 'crawl_data.json'), JSON.stringify(crawlData, null, 2), 'utf8');

  // Named before summary.json is written, so the summary can point at the
  // deliverable. Setting it afterwards left report_docx null in the JSON.
  const docxName = `internal-linking-audit-${safeHost}.docx`;
  const docxPath = path.join(outdir, docxName);

  const tiers = { high: 0, 'single-word': 0, 'needs-new-sentence': 0 };
  recs.forEach((r) => { tiers[r.confidence] = (tiers[r.confidence] || 0) + 1; });
  const modes = {};
  urls.forEach((u) => {
    const m = pages.get(u).extraction_mode;
    modes[m] = (modes[m] || 0) + 1;
  });
  const nonEditorialBreakdown = {};
  nonContent.forEach((r) => { nonEditorialBreakdown[r.kind] = (nonEditorialBreakdown[r.kind] || 0) + 1; });

  const summary = {
    site: crawler.root,
    report_docx: docxName,
    generated_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    elapsed_seconds: Number(elapsed.toFixed(1)),
    config: cfg,
    pages_crawled: urls.length,
    brand_name: brand.brand_name,
    template_block_stats: templateStats,
    sitemap_urls_found: crawler.sitemapUrls.length,
    sitemaps_declared_in_robots: crawler.sitemapsDeclared,
    editorial_internal_links: graph.editorial_edges.size,
    sitewide_internal_links: graph.boiler_edges.size,
    sitewide_destinations: Array.from(graph.sitewide).sort().slice(0, 50),
    recommendations_total: recs.length,
    recommendations_ready: tiers.high,
    recommendations_single_word_anchor: tiers['single-word'],
    recommendations_need_new_copy: tiers['needs-new-sentence'],
    orphan_pages: orphans.length,
    underlinked_pages: underlinked.length,
    cannibalization_pairs: cannibal.filter((c) => c.severity !== 'critical').length,
    duplicate_content_pairs: cannibal.filter((c) => c.severity === 'critical').length,
    saturated_pages: saturated.length,
    link_heavy_pages: linkHeavy.length,
    non_editorial_pages: nonContent.length,
    non_editorial_breakdown: nonEditorialBreakdown,
    zero_vector_pages: vec.zero_vector_pages.length,
    noindex_pages: urls.filter((u) => pages.get(u).noindex).length,
    pages_with_no_extractable_text: urls.filter((u) => pages.get(u).word_count === 0).length,
    extraction_modes: modes,
    precision_filter_rejections: rejectStats,
    requests_throttled: crawler.throttled,
    discovered_but_unfetched: crawler.unfetchedDiscovered.size,
    robots_crawl_delay: crawler.crawlDelay,
    urls_filtered_out: crawler.filteredOut,
    coverage,
    duplicate_clusters: dupClusters,
    broken_internal_links: broken.filter((b) => b.referring_pages && b.classification === 'broken link').length,
    transient_error_urls: broken.filter((b) => b.classification !== 'broken link').length,
    malformed_hrefs: Object.fromEntries(Array.from(malformed.entries()).map(([h, s]) => [h, s.length])),
    fetch_failures: crawler.failures,
    notes: crawler.notes,
    gsc_joined: Boolean(gsc),
    gsc_matched: gsc ? gsc.matched : 0,
    gsc_unmatched: gsc ? gsc.unmatched : 0,
    // Reported as 0 for the same reason the Python reports 0 without spaCy
    // installed: the optional NER anchor filter did not run.
    ner_anchor_rejections: nerStats.rejected,
    implementation: 'node',
  };
  fs.writeFileSync(path.join(outdir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  await buildDocx(docxPath, {
    root: crawler.root,
    pages,
    urls,
    graph,
    recs,
    orphans,
    underlinked,
    cannibal,
    saturated,
    broken,
    nonContent,
    dupClusters,
    linkHeavy,
    summary,
    cfg,
    elapsed,
    notes: crawler.notes,
  });

  log(`wrote ${docxName}, recommendations.xlsx, orphans.xlsx, cannibalization.xlsx, `
    + 'broken_links.xlsx, non_editorial_pages.xlsx, crawl_data.json, summary.json');

  process.stderr.write(`\n${'='.repeat(74)}\n  RESULTS\n${'='.repeat(74)}\n`);
  process.stderr.write(`  unique pages analyzed         : ${summary.pages_crawled}\n`);
  process.stderr.write(`  editorial internal links      : ${summary.editorial_internal_links}\n`);
  process.stderr.write(`  site-wide (nav/footer) links  : ${summary.sitewide_internal_links}\n`);
  process.stderr.write(`  orphan pages                  : ${summary.orphan_pages}\n`);
  process.stderr.write(`  under-linked pages            : ${summary.underlinked_pages}\n`);
  process.stderr.write(`  non-editorial pages excluded  : ${summary.non_editorial_pages}\n`);
  process.stderr.write(`  duplicate-content pairs       : ${summary.duplicate_content_pairs}\n`);
  process.stderr.write(`  cannibalization pairs         : ${summary.cannibalization_pairs}\n`);
  process.stderr.write(`  broken internal links         : ${summary.broken_internal_links}\n`);
  process.stderr.write(`  recommendations ready to use  : ${summary.recommendations_ready}\n`);
  process.stderr.write(`  single-word anchors (verify)  : ${summary.recommendations_single_word_anchor}\n`);
  process.stderr.write(`  recommendations (new copy)    : ${summary.recommendations_need_new_copy}\n`);
  process.stderr.write(`\n  WORD REPORT: ${docxPath}\n${'='.repeat(74)}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n  Internal linking run failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
