// Analysis — one finding per check, counted per instance.
//
// A direct port of analyze() and site_health() from
// tools/webtechstackdetector/main.py. Every check keeps its original id, name,
// tier, summary wording and counting rule, because those ids are stored in the
// database, drive task generation (lib/tasks.js), the audit alert types
// (lib/alertCatalog.js) and the exported report — changing one would silently
// break history comparisons on existing runs.
//
// The comments explaining WHY a check counts the way it does are carried over
// verbatim where they capture a decision that is not obvious from the code;
// several were written after checking this tool's output against Semrush on
// real sites, and re-deriving them from scratch would be easy to get wrong.
const {
  canonUrl, sameSite, truncate, joinUrl, RESOURCE_EXT,
} = require('../lib/urls');
const { isErrorPage } = require('./page');
const {
  findDuplicateContent, linkVerdict, verifyReason, BROKEN_STATUSES,
} = require('./crawl');
const { UA } = require('../lib/http');

// Severity tiers. `tier` drives the score weight; a check with 0 failures is
// displayed as PASSED regardless of its tier. The special "info" tier is NEVER
// scored — it is used only for the "could not verify" section.
const TIER_WEIGHT = { error: 5.0, warning: 2.0, notice: 1.0 }; // "info" excluded on purpose

// Thresholds
const TITLE_MAX = 60;     // Google truncates the SERP title around 580px ≈ 60 chars
const TITLE_MIN = 10;
const DESC_MAX = 160;
const DESC_MIN = 70;
const LOW_WORDS = 200;
const TEXT_HTML_MIN = 0.10;

// Concavity of the per-check penalty. A check failing on fraction f of its
// units loses f**PENALTY_EXP of its weight (not f). 0.5 (square root) makes the
// FIRST occurrences of an issue count for more than later ones — reflecting
// that an issue appearing at all signals a site-wide problem.
const PENALTY_EXP = 0.5;

function finding(fid, name, tier, summary, items = null, failed = 0, total = 0, unit = 'pages') {
  return {
    id: fid,
    name,
    tier,
    display: failed > 0 ? tier : 'passed',
    summary,
    items: items || [],
    failed,
    total,
    unit,
  };
}

function canonicalTarget(page, startUrl) {
  if (!page || !page.canonicals.length) return null;
  const href = page.canonicals[0];
  const target = /^https?:\/\//i.test(href) ? href : joinUrl(page.url, href);
  return sameSite(startUrl, target) ? target : null;
}

function canonicalizesAway(page, startUrl) {
  const t = canonicalTarget(page, startUrl);
  return t !== null && canonUrl(t) !== canonUrl(page.url);
}

function analyze({
  startUrl, pages, linkSources, robots, sitemap, linkStatus, resourceStatus,
  slowThreshold, externalChecked, crawlComplete, maxPages, hostVariants,
  rawLinkSources,
}) {
  const findings = [];
  const seed = canonUrl(startUrl);
  const allPages = Array.from(pages.values());

  // De-duplicate on FINAL (post-redirect) URL. Prefer the copy fetched directly.
  const seenFinal = new Map();
  for (const p of allPages) {
    if (!(p.is_html && p.ok && !p.error)) continue;
    if (isErrorPage(p)) continue;
    const key = canonUrl(p.url);
    if (!seenFinal.has(key) || !p.redirect_chain.length) seenFinal.set(key, p);
  }
  const htmlPages = Array.from(seenFinal.values());

  // On-page issues (missing meta/H1/alt/title, word count, text ratio,
  // viewport, …) are audited on EVERY indexable crawled page. A page that
  // canonicalises to another URL still has these problems, so it must NOT be
  // excluded here — excluding them meant a site canonicalising every page to
  // the homepage showed a perfect score while actually being broken.
  const onpage = htmlPages;
  const nPages = Math.max(1, onpage.length);

  // For DUPLICATE detection only, drop pages that defer indexing to a DIFFERENT
  // URL via rel=canonical (e.g. ?utm= variants → clean URL): the canonical
  // legitimately resolves the duplication. …BUT only when the canonical TARGET
  // actually carries the same value. Blanket-excluding every page that
  // canonicalises away produced a FALSE PASS on sites pointing every page at an
  // unrelated URL: 21 pages all titled the same were reported as "All titles
  // are unique" because 21 of 22 pages were dropped from the scope.
  const byCanonUrl = new Map(htmlPages.map((p) => [canonUrl(p.url), p]));

  const dedupScope = (field) => htmlPages.filter((p) => {
    const t = canonicalTarget(p, startUrl);
    if (t !== null && canonUrl(t) !== canonUrl(p.url)) {
      const tgt = byCanonUrl.get(canonUrl(t));
      if (tgt && tgt[field] === p[field]) return false; // true duplicate — canonical handles it
    }
    return true;
  });

  const totalLinks = Math.max(1, onpage.reduce((a, p) => a + p.link_count, 0));
  const totalImgs = onpage.reduce((a, p) => a + p.images_total, 0);

  // --- ERROR: broken links ------------------------------------------------
  // One report row PER (page → broken target) pair, so the report lists every
  // page that contains a broken link. Only links CONFIRMED broken (HTTP 404/410
  // or a hard DNS/connection failure) are reported as broken. Links that could
  // NOT be verified — bot-blocked or transient (403/429/5xx/timeout/SSL) — are
  // kept separately and reported with their reason, never asserted as broken.
  const brokenItems = [];
  let brokenInstances = 0;
  let soft404 = 0;
  const brokenUrls = new Set();
  const brokenPages = new Set();
  const unverifiedMap = new Map(); // target -> [reason, sorted sources, internal]

  for (const [target, sources] of linkSources) {
    const pg = pages.get(target);
    const internal = sameSite(startUrl, target);
    const loc = internal ? 'internal' : 'external';
    const soft = Boolean(pg && pg.ok && isErrorPage(pg) && canonUrl(pg.url) !== target);
    let note;
    if (soft) {
      note = 'soft 404 — link redirects to a not-found page';
    } else {
      let status;
      let err;
      if (linkStatus.has(target)) {
        [status, err] = linkStatus.get(target);
      } else if (pg) {
        status = pg.status; err = pg.error;
      } else {
        continue;
      }
      const [kind, vnote] = linkVerdict(status, err);
      if (kind === 'ok') continue;
      if (kind === 'unverified') {
        unverifiedMap.set(target, [verifyReason(status, err), Array.from(sources).sort(), internal]);
        continue;
      }
      note = vnote;
    }
    if (soft) soft404 += 1;
    brokenUrls.add(target);
    for (const src of Array.from(sources).sort()) {
      brokenInstances += 1;
      brokenPages.add(src);
      brokenItems.push({ url: src, note: `broken link → ${truncate(target, 75)}  (${note}, ${loc})` });
    }
  }
  brokenItems.sort((a, b) => (a.note === b.note ? a.url.localeCompare(b.url) : a.note.localeCompare(b.note)));
  let brokenSummary = brokenInstances
    ? `${brokenInstances} broken link(s) on ${brokenPages.size} page(s) `
      + `(${brokenUrls.size} unique broken URL(s)${soft404 ? `, incl. ${soft404} soft 404` : ''})`
    : 'No broken links detected';
  if (!externalChecked) brokenSummary += ' (external links skipped)';
  findings.push(finding('broken_links', 'Broken internal & external links', 'error',
    brokenSummary, brokenItems, brokenInstances, totalLinks, 'links'));

  // --- INFO: links that could not be verified (NOT scored) ----------------
  if (unverifiedMap.size) {
    const uvItems = Array.from(unverifiedMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([target, [reason, srcs, intern]]) => ({
        url: target,
        note: `${reason}  (${intern ? 'internal' : 'external'}; linked from ${srcs.length} page(s))`,
        sources: srcs.slice(0, 5),
      }));
    findings.push(finding('unverified_links', 'Links that could not be verified', 'info',
      `${unverifiedMap.size} link(s) could not be confirmed working or broken `
      + '(bot-blocked or transient). NOT counted as broken and NOT included in '
      + 'the score — listed for manual review.',
      uvItems, unverifiedMap.size, 0));
  }

  // --- ERROR: 4xx/5xx status pages ----------------------------------------
  const badStatus = allPages
    .filter((p) => p.status != null && p.status >= 400)
    .map((p) => ({ url: p.url, note: `HTTP ${p.status}` }));
  findings.push(finding('http_status', 'Pages returning 4xx/5xx status codes', 'error',
    badStatus.length ? `${badStatus.length} page(s) returned a 4xx/5xx status` : 'No 4xx/5xx pages',
    badStatus, badStatus.length, pages.size, 'pages'));

  // --- ERROR: duplicated titles -------------------------------------------
  const titleScope = dedupScope('title');
  const titles = new Map();
  titleScope.forEach((p) => {
    if (!p.title) return;
    if (!titles.has(p.title)) titles.set(p.title, []);
    titles.get(p.title).push(p.url);
  });
  const dupTitles = Array.from(titles.entries()).filter(([, u]) => u.length > 1);
  const dupTitlePages = dupTitles.reduce((a, [, u]) => a + u.length, 0);
  findings.push(finding('dup_titles', 'Duplicate title tags', 'error',
    dupTitles.length
      ? `${dupTitlePages} page(s) share a duplicate title (${dupTitles.length} duplicated title(s))`
      : 'All titles are unique',
    dupTitles.map(([t, urls]) => ({
      url: urls[0], note: `"${truncate(t)}" — on ${urls.length} pages`, sources: urls.slice(0, 25),
    })),
    dupTitlePages, Math.max(1, titleScope.length)));

  // --- ERROR: duplicated meta descriptions --------------------------------
  const descScope = dedupScope('meta_desc');
  const descs = new Map();
  descScope.forEach((p) => {
    if (!p.meta_desc) return;
    if (!descs.has(p.meta_desc)) descs.set(p.meta_desc, []);
    descs.get(p.meta_desc).push(p.url);
  });
  const dupDesc = Array.from(descs.entries()).filter(([, u]) => u.length > 1);
  const dupDescPages = dupDesc.reduce((a, [, u]) => a + u.length, 0);
  findings.push(finding('dup_meta', 'Duplicate meta descriptions', 'error',
    dupDesc.length
      ? `${dupDescPages} page(s) share a duplicate meta description (${dupDesc.length} duplicated)`
      : 'All meta descriptions are unique',
    dupDesc.map(([d, urls]) => ({
      url: urls[0], note: `"${truncate(d)}" — on ${urls.length} pages`, sources: urls.slice(0, 25),
    })),
    dupDescPages, Math.max(1, descScope.length)));

  // --- ERROR: duplicate content -------------------------------------------
  // Cluster ALL indexable pages, then drop only those whose rel=canonical
  // points at a URL inside the SAME cluster — that is the case a canonical
  // really resolves. A canonical aimed at an unrelated page leaves the
  // duplication real.
  const rawClusters = findDuplicateContent(htmlPages);
  const dupClusters = [];
  for (const cl of rawClusters) {
    const keys = new Set(cl.map(canonUrl));
    const kept = cl.filter((u) => {
      const p = byCanonUrl.get(canonUrl(u));
      const t = p ? canonicalTarget(p, startUrl) : null;
      return !(t !== null && canonUrl(t) !== canonUrl(u) && keys.has(canonUrl(t)));
    });
    if (kept.length > 1) dupClusters.push(kept);
  }
  const dupContentPages = dupClusters.reduce((a, c) => a + c.length, 0);
  findings.push(finding('dup_content', 'Duplicate content', 'error',
    dupClusters.length
      ? `${dupContentPages} page(s) in ${dupClusters.length} near-duplicate cluster(s)`
      : 'No duplicate content detected',
    dupClusters.map((c) => ({
      url: c[0], note: `near-duplicate body content on ${c.length} pages`, sources: c.slice(0, 25),
    })),
    dupContentPages, Math.max(1, htmlPages.length)));

  // --- ERROR: incorrect pages in sitemap ----------------------------------
  // Judge each sitemap URL EXACTLY as listed. The exact URL's own status wins
  // over the canon-folded page lookup, because canonUrl() folds trailing-slash
  // variants together — a sitemap entry "/x" would otherwise resolve to the
  // crawled "/x/" page (HTTP 200, no redirect chain) and look healthy while
  // "/x" itself 301s.
  const smBad = [];
  const smSame = sitemap.urls.filter((u) => sameSite(startUrl, u));
  for (const u of smSame) {
    const pageObj = pages.get(canonUrl(u));
    let exact = linkStatus.has(u) ? linkStatus.get(u) : null;
    if (exact === null && pageObj && pageObj.requested_url === u) exact = 'page';
    if (exact !== null && exact !== 'page') {
      const [st, , , red] = exact;
      if (red) { smBad.push({ url: u, note: 'sitemap URL redirects elsewhere' }); continue; }
      if (BROKEN_STATUSES.has(st)) {
        smBad.push({ url: u, note: `sitemap URL is broken (HTTP ${st})` });
        continue;
      }
    } else if (pageObj) {
      if (pageObj.redirect_chain.length) {
        smBad.push({ url: u, note: 'sitemap URL redirects elsewhere' });
        continue;
      }
      if (BROKEN_STATUSES.has(pageObj.status)) {
        smBad.push({ url: u, note: `sitemap URL is broken (HTTP ${pageObj.status})` });
        continue;
      }
    }
    // URL itself resolves 200 — is the page it serves self-canonical?
    if (pageObj && canonicalizesAway(pageObj, startUrl)) {
      smBad.push({
        url: u,
        note: 'sitemap URL canonicalises to a different page — non-canonical URLs should not be in the sitemap',
      });
    }
  }
  findings.push(finding('sitemap_incorrect', 'Incorrect pages in sitemap.xml', 'error',
    smBad.length
      ? `${smBad.length} sitemap URL(s) redirect, are broken, or are non-canonical`
      : 'Sitemap URLs are clean',
    smBad, smBad.length, Math.max(1, smSame.length), 'sitemap URLs'));

  // --- WARNING: unminified JS/CSS -----------------------------------------
  // Counted PER PAGE-REFERENCE (one unminified file loaded on N pages = N
  // issues), with the unique-file count shown alongside.
  const unminFiles = new Set(Array.from(resourceStatus.entries()).filter(([, f]) => f).map(([u]) => u));
  let unminRefs = 0;
  let totalRefs = 0;
  for (const p of onpage) {
    for (const a of p.assets) {
      if (/\.(css|js)(\?|#|$)/i.test(a)) {
        totalRefs += 1;
        if (unminFiles.has(a)) unminRefs += 1;
      }
    }
  }
  findings.push(finding('unminified', 'Unminified JavaScript and CSS files', 'warning',
    unminRefs
      ? `${unminRefs} unminified reference(s) across ${unminFiles.size} unique file(s)`
      : (resourceStatus.size
        ? `All ${resourceStatus.size} checked JS/CSS files are minified`
        : 'No JS/CSS files checked'),
    Array.from(unminFiles).sort().slice(0, 50).map((u) => ({ url: u, note: 'not minified' })),
    unminRefs, Math.max(1, totalRefs), 'references'));

  // --- WARNING: images without alt ----------------------------------------
  const altItems = [];
  let missingAlt = 0;
  for (const p of onpage) {
    missingAlt += p.images_missing_alt;
    if (p.images_missing_alt) {
      altItems.push({
        url: p.url,
        note: `${p.images_missing_alt}/${p.images_total} images missing alt`,
        sources: p.missing_alt_samples,
      });
    }
  }
  findings.push(finding('image_alt', 'Images without alt attributes', 'warning',
    missingAlt
      ? `${missingAlt} image(s) missing alt across ${altItems.length} page(s)`
      : (totalImgs ? `All ${totalImgs} images have alt text` : 'No images found'),
    altItems, missingAlt, Math.max(1, totalImgs), 'images'));

  // --- WARNING: low text-HTML ratio ---------------------------------------
  const lowRatio = [];
  for (const p of onpage) {
    if (!p.html_len) continue;
    const ratio = p.text_len / p.html_len;
    if (ratio < TEXT_HTML_MIN) {
      lowRatio.push({
        url: p.url,
        note: `text/HTML ratio ${(ratio * 100).toFixed(1)}% (min ${(TEXT_HTML_MIN * 100).toFixed(0)}%)`,
      });
    }
  }
  findings.push(finding('text_ratio', 'Low text-to-HTML ratio', 'warning',
    lowRatio.length
      ? `${lowRatio.length} page(s) below ${(TEXT_HTML_MIN * 100).toFixed(0)}% text/HTML`
      : 'Text-to-HTML ratio is healthy',
    lowRatio, lowRatio.length, nPages));

  // --- WARNING: nofollow internal links -----------------------------------
  const nofollowInstances = onpage.reduce((a, p) => a + p.nofollow_internal.size, 0);
  findings.push(finding('nofollow', 'Outgoing internal links with nofollow', 'warning',
    nofollowInstances ? `${nofollowInstances} internal link(s) marked nofollow` : 'No nofollowed internal links',
    onpage.filter((p) => p.nofollow_internal.size)
      .map((p) => ({ url: p.url, note: `${p.nofollow_internal.size} nofollow internal link(s)` })),
    nofollowInstances, totalLinks, 'links'));

  // --- WARNING: missing H1 -------------------------------------------------
  const missingH1 = onpage.filter((p) => p.h1s.length === 0).map((p) => ({ url: p.url, note: 'no H1 tag' }));
  findings.push(finding('missing_h1', 'Pages without an H1 heading', 'warning',
    missingH1.length ? `${missingH1.length} page(s) have no H1` : 'Every page has an H1',
    missingH1, missingH1.length, nPages));

  // --- WARNING: missing meta description ----------------------------------
  const missingDesc = onpage.filter((p) => !p.meta_desc);
  findings.push(finding('missing_meta', 'Pages without a meta description', 'warning',
    missingDesc.length
      ? `${missingDesc.length} page(s) missing a meta description`
      : 'Every page has a meta description',
    missingDesc.map((p) => ({ url: p.url, note: 'missing meta description' })),
    missingDesc.length, nPages));

  // --- WARNING: missing title ----------------------------------------------
  const missingTitle = onpage.filter((p) => !p.title);
  findings.push(finding('missing_title', 'Pages without a title tag', 'warning',
    missingTitle.length ? `${missingTitle.length} page(s) missing a <title>` : 'Every page has a title',
    missingTitle.map((p) => ({ url: p.url, note: 'missing <title>' })),
    missingTitle.length, nPages));

  // --- WARNING: low word count ---------------------------------------------
  const lowWc = onpage.filter((p) => p.word_count < LOW_WORDS)
    .map((p) => ({ url: p.url, note: `${p.word_count} words (min ${LOW_WORDS})` }));
  findings.push(finding('low_word_count', 'Pages with low word count', 'warning',
    lowWc.length ? `${lowWc.length} page(s) under ${LOW_WORDS} words` : 'No thin pages by word count',
    lowWc, lowWc.length, nPages));

  // --- WARNING: title length ------------------------------------------------
  const titleLen = [];
  for (const p of onpage) {
    if (!p.title) continue;
    const n = p.title.length;
    if (n > TITLE_MAX) titleLen.push({ url: p.url, note: `title is ${n} chars (max ${TITLE_MAX})` });
    else if (n < TITLE_MIN) titleLen.push({ url: p.url, note: `title is only ${n} chars (min ${TITLE_MIN})` });
  }
  findings.push(finding('title_length', 'Title tags too long or too short', 'warning',
    titleLen.length
      ? `${titleLen.length} title(s) outside ${TITLE_MIN}-${TITLE_MAX} chars`
      : 'Title lengths are healthy',
    titleLen, titleLen.length, nPages));

  // --- WARNING: meta description length -------------------------------------
  const descLen = [];
  for (const p of onpage) {
    if (!p.meta_desc) continue;
    const n = p.meta_desc.length;
    if (n > DESC_MAX) descLen.push({ url: p.url, note: `meta description is ${n} chars (max ${DESC_MAX})` });
    else if (n < DESC_MIN) descLen.push({ url: p.url, note: `meta description is only ${n} chars (min ${DESC_MIN})` });
  }
  findings.push(finding('desc_length', 'Meta descriptions too long or too short', 'warning',
    descLen.length
      ? `${descLen.length} meta description(s) outside ${DESC_MIN}-${DESC_MAX} chars`
      : 'Meta description lengths are healthy',
    descLen, descLen.length, nPages));

  // --- WARNING: HTTPS page links to HTTP ------------------------------------
  const httpsHttp = onpage.reduce((a, p) => a + p.http_from_https, 0);
  findings.push(finding('https_to_http', 'Links from HTTPS pages to HTTP URLs', 'warning',
    httpsHttp ? `${httpsHttp} HTTPS→HTTP link(s)` : 'No HTTPS→HTTP links',
    onpage.filter((p) => p.http_from_https)
      .map((p) => ({ url: p.url, note: `${p.http_from_https} link(s) to HTTP URLs` })),
    httpsHttp, totalLinks, 'links'));

  // --- WARNING: mixed content -----------------------------------------------
  const mixed = onpage.reduce((a, p) => a + p.mixed_content, 0);
  findings.push(finding('mixed_content', 'Mixed content (HTTP resources on HTTPS)', 'warning',
    mixed ? `${mixed} HTTP resource(s) loaded on HTTPS pages` : 'No mixed content',
    onpage.filter((p) => p.mixed_content)
      .map((p) => ({ url: p.url, note: `${p.mixed_content} resource(s) loaded over HTTP` })),
    mixed, totalLinks, 'resources'));

  // --- WARNING: missing viewport (mobile) -----------------------------------
  const noViewport = onpage.filter((p) => !p.has_viewport)
    .map((p) => ({ url: p.url, note: 'no <meta name=viewport>' }));
  findings.push(finding('viewport', 'Pages without a viewport meta tag', 'warning',
    noViewport.length
      ? `${noViewport.length} page(s) missing a viewport meta tag`
      : 'Every page declares a viewport',
    noViewport, noViewport.length, nPages));

  // --- NOTICE: resources formatted as page link -----------------------------
  const resInstances = onpage.reduce((a, p) => a + p.resource_link_count, 0);
  findings.push(finding('resource_links', 'Resources formatted as page link', 'notice',
    resInstances ? `${resInstances} link(s) point at a resource file` : 'No resource-as-page links',
    onpage.filter((p) => p.resource_link_count)
      .map((p) => ({ url: p.url, note: `${p.resource_link_count} resource link(s)` })),
    resInstances, totalLinks, 'links'));

  // --- NOTICE: links with no anchor text ------------------------------------
  // Counted per instance, but unnamed links are almost always a handful of
  // TEMPLATE links — a logo <img> with no alt, social icons — repeated on every
  // page. The unique-target count is reported alongside so "970" reads as "5
  // template links to fix", not 970 jobs.
  const emptyAnchor = onpage.reduce((a, p) => a + p.empty_anchor, 0);
  const eaTargets = new Map();
  onpage.forEach((p) => p.empty_anchor_urls.forEach((u) => {
    if (!eaTargets.has(u)) eaTargets.set(u, []);
    eaTargets.get(u).push(p.url);
  }));
  const eaItems = Array.from(eaTargets.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([u, srcs]) => ({ url: u, note: `linked with no anchor text on ${srcs.length} page(s)`, sources: srcs.slice(0, 25) }));
  findings.push(finding('empty_anchor', 'Links with no anchor text', 'notice',
    emptyAnchor
      ? `${emptyAnchor} link(s) have no anchor text across ${eaTargets.size} unique link target(s)`
      : 'All links have anchor text',
    eaItems, emptyAnchor, totalLinks, 'links'));

  // --- NOTICE: non-descriptive anchor text ----------------------------------
  const nondesc = onpage.reduce((a, p) => a + p.nondesc_anchor, 0);
  findings.push(finding('nondesc_anchor', 'Non-descriptive anchor text', 'notice',
    nondesc ? `${nondesc} link(s) use generic anchor text` : 'Anchor text is descriptive',
    onpage.filter((p) => p.nondesc_anchor)
      .map((p) => ({ url: p.url, note: `${p.nondesc_anchor} non-descriptive anchor(s)` })),
    nondesc, totalLinks, 'links'));

  // --- NOTICE: permanent (301) redirects ------------------------------------
  // INTERNAL links pointing at a 301 only — a link on the site sending users
  // (and link equity) through a redirect. External sites redirecting their own
  // URLs is not this site's SEO concern.
  //
  // Counted PER (page → redirecting target) pair, like broken links, because
  // the cost is paid on every page carrying the link. Resource files are
  // excluded: they are already reported by "resources formatted as page link",
  // and a 301 on an image is not what this check is about. Uses rawLinkSources
  // (links AS WRITTEN) rather than the canonUrl-folded linkSources, so
  // www/non-www and trailing-slash variants stay distinct.
  const redirTargets = new Map();
  for (const [target, sources] of (rawLinkSources || linkSources)) {
    if (!sameSite(startUrl, target) || RESOURCE_EXT.test(target)) continue;
    let is301 = false;
    let dest = '';
    if (linkStatus.has(target)) {
      const [, , fh, red] = linkStatus.get(target);
      if (red && fh === 301) is301 = true;
    } else {
      const pg = pages.get(canonUrl(target));
      if (pg && pg.requested_url === target && pg.redirect_chain.some(([st]) => st === 301)) {
        is301 = true;
        dest = pg.url;
      }
    }
    if (is301) redirTargets.set(target, [sources.size, dest]);
  }
  const perm = Array.from(redirTargets.values()).reduce((a, [n]) => a + n, 0);
  const permItems = Array.from(redirTargets.entries())
    .sort((a, b) => b[1][0] - a[1][0])
    .map(([u, [n, dest]]) => ({
      url: u,
      note: dest
        ? `301 → ${truncate(dest)} — linked from ${n} page(s)`
        : `301 permanent redirect — linked from ${n} page(s)`,
    }));
  findings.push(finding('permanent_redirects', 'Permanent (301) redirects', 'notice',
    perm
      ? `${perm} internal link(s) point at a 301 redirect across ${redirTargets.size} unique redirecting URL(s)`
      : 'No internal permanent redirects',
    permItems, perm, totalLinks, 'links'));

  // --- NOTICE: multiple H1 ---------------------------------------------------
  const multiH1 = onpage.filter((p) => p.h1s.length > 1)
    .map((p) => ({ url: p.url, note: `${p.h1s.length} H1 tags` }));
  findings.push(finding('multiple_h1', 'Pages with more than one H1', 'notice',
    multiH1.length ? `${multiH1.length} page(s) have multiple H1s` : 'No pages with multiple H1s',
    multiH1, multiH1.length, nPages));

  // --- NOTICE: multiple title tags -------------------------------------------
  const multiTitle = onpage.filter((p) => p.title_count > 1)
    .map((p) => ({ url: p.url, note: `${p.title_count} <title> tags` }));
  findings.push(finding('multiple_title', 'Pages with more than one title tag', 'notice',
    multiTitle.length ? `${multiTitle.length} page(s) have multiple <title> tags` : 'No pages with multiple titles',
    multiTitle, multiTitle.length, nPages));

  // --- NOTICE: missing charset declaration -----------------------------------
  const noCharset = onpage.filter((p) => !p.has_charset)
    .map((p) => ({ url: p.url, note: 'no charset declaration' }));
  findings.push(finding('charset', 'Pages without a charset declaration', 'notice',
    noCharset.length
      ? `${noCharset.length} page(s) missing a charset declaration`
      : 'Every page declares a charset',
    noCharset, noCharset.length, nPages));

  // --- NOTICE: missing doctype -----------------------------------------------
  const noDoctype = onpage.filter((p) => !p.has_doctype)
    .map((p) => ({ url: p.url, note: 'no <!doctype> declaration' }));
  findings.push(finding('doctype', 'Pages without a doctype', 'notice',
    noDoctype.length ? `${noDoctype.length} page(s) missing a doctype` : 'Every page declares a doctype',
    noDoctype, noDoctype.length, nPages));

  // --- NOTICE: pages with only one incoming internal link --------------------
  if (crawlComplete) {
    const weak = onpage
      .filter((p) => canonUrl(p.url) !== seed && (linkSources.get(canonUrl(p.url)) || new Set()).size === 1)
      .map((p) => p.url);
    findings.push(finding('weak_linking', 'Pages with only one incoming internal link', 'notice',
      weak.length ? `${weak.length} page(s) have a single inbound internal link` : 'No weakly-linked pages',
      weak.map((u) => ({ url: u, note: 'only 1 incoming internal link' })),
      weak.length, nPages));
  } else {
    findings.push(finding('weak_linking', 'Pages with only one incoming internal link', 'notice',
      `Skipped — crawl hit the ${maxPages}-page cap; internal link graph is incomplete`,
      [], 0, 0));
  }

  // --- NOTICE: orphan pages ---------------------------------------------------
  if (!crawlComplete) {
    findings.push(finding('orphans', 'Orphan pages', 'notice',
      `Skipped — crawl hit the ${maxPages}-page cap. Re-run with --max-pages >= total pages to detect orphans.`,
      [], 0, 0));
  } else if (sitemap.count) {
    const linked = new Set([...linkSources.keys(), ...pages.keys(), seed]);
    const smCanon = new Map();
    sitemap.urls.filter((u) => sameSite(startUrl, u)).forEach((u) => smCanon.set(canonUrl(u), u));
    const orphans = Array.from(smCanon.entries())
      .filter(([c]) => !linked.has(c))
      .map(([, orig]) => orig)
      .sort();
    findings.push(finding('orphans', 'Orphan pages', 'notice',
      orphans.length ? `${orphans.length} sitemap URL(s) not internally linked` : 'No orphan pages',
      orphans.map((u) => ({ url: u, note: 'in sitemap but no internal link points to it' })),
      orphans.length, Math.max(1, smCanon.size), 'sitemap URLs'));
  } else {
    findings.push(finding('orphans', 'Orphan pages', 'notice',
      'No XML sitemap to compare against', [], 0, 0));
  }

  // --- NOTICE: non-indexable pages ---------------------------------------------
  const nonindex = [];
  for (const p of htmlPages) {
    const reasons = [];
    if ((p.robots_meta || '').includes('noindex')) reasons.push('meta robots noindex');
    if ((p.x_robots || '').toLowerCase().includes('noindex')) reasons.push('X-Robots-Tag noindex');
    if (robots.canFetch) {
      try {
        if (!robots.canFetch(UA, p.url)) reasons.push('blocked by robots.txt');
      } catch { /* a malformed rule must not abort the audit */ }
    }
    if (reasons.length) nonindex.push({ url: p.url, note: reasons.join('; ') });
  }
  findings.push(finding('non_indexable', 'Non-indexable pages', 'notice',
    nonindex.length
      ? `${nonindex.length} non-indexable page(s) — confirm intentional`
      : 'All crawled pages are indexable',
    nonindex, nonindex.length, htmlPages.length || 1));

  // --- NOTICE: canonical tag issues ---------------------------------------------
  const canonIssues = [];
  const canonAwayItems = [];
  for (const p of htmlPages) {
    if (!p.canonicals.length) {
      canonIssues.push({ url: p.url, note: 'no canonical tag (recommended)' });
      continue;
    }
    if (p.canonicals.length > 1) {
      canonIssues.push({ url: p.url, note: `conflicting: ${p.canonicals.length} canonical tags` });
    }
    const href = p.canonicals[0];
    let target;
    if (!/^https?:\/\//i.test(href)) {
      target = joinUrl(p.url, href);
      canonIssues.push({ url: p.url, note: `relative canonical '${truncate(href)}' — use absolute URL` });
    } else {
      target = href;
    }
    if (!sameSite(startUrl, target)) {
      canonIssues.push({ url: p.url, note: `canonical points off-site: ${truncate(target)}` });
    } else if (canonUrl(target) !== canonUrl(p.url)) {
      canonAwayItems.push({ url: p.url, note: `canonical → ${truncate(target)}` });
    }
  }
  // This row covers only MALFORMED canonicals (missing / conflicting /
  // relative / off-site). Cross-page canonicals get their own row below. Never
  // claim the canonicals "look correct" while that row is non-empty — the two
  // rows together read as a contradiction.
  let canonSummary;
  if (canonIssues.length) canonSummary = `${canonIssues.length} canonical note(s)`;
  else if (canonAwayItems.length) {
    canonSummary = `tags are well-formed, but ${canonAwayItems.length} page(s) canonicalise to a `
      + 'different URL — see "Pages canonicalised to a different URL"';
  } else canonSummary = 'Canonical tags look correct';
  findings.push(finding('canonical', 'Canonical tag issues', 'notice',
    canonSummary, canonIssues, canonIssues.length, htmlPages.length || 1));

  // --- WARNING: pages canonicalised to a different URL ---------------------------
  // These pages tell search engines "index that other URL instead of me", so
  // they will not rank on their own. A handful (param variants) is normal; a
  // large share — every page pointing at the homepage — is a critical,
  // site-wide indexation problem.
  findings.push(finding('canonicalized', 'Pages canonicalised to a different URL', 'warning',
    canonAwayItems.length
      ? `${canonAwayItems.length} page(s) point rel=canonical at another URL and won't be indexed on their own`
      : 'No pages canonicalise away',
    canonAwayItems, canonAwayItems.length, htmlPages.length || 1));

  // --- NOTICE: slow-loading pages -------------------------------------------------
  const timings = htmlPages.filter((p) => p.elapsed).map((p) => p.elapsed);
  const slow = htmlPages.slice().sort((a, b) => b.elapsed - a.elapsed)
    .filter((p) => p.elapsed > slowThreshold)
    .map((p) => ({ url: p.url, note: `${p.elapsed}s (threshold ${slowThreshold}s)` }));
  const avg = timings.length
    ? Number((timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(2))
    : 0;
  findings.push(finding('slow_pages', 'Slow-loading pages', 'notice',
    slow.length ? `${slow.length} slow page(s); avg load ${avg}s` : `No slow pages (avg load ${avg}s)`,
    slow, slow.length, htmlPages.length || 1));

  // --- NOTICE: HSTS ----------------------------------------------------------------
  const seedPage = pages.get(seed) || allPages[0] || null;
  const hstsOk = Boolean(seedPage && seedPage.hsts);
  findings.push(finding('hsts', 'HSTS support', 'notice',
    hstsOk
      ? 'HSTS (Strict-Transport-Security) is enabled'
      : 'HSTS (Strict-Transport-Security) is not enabled',
    hstsOk ? [] : [{ url: startUrl, note: 'no Strict-Transport-Security header' }],
    hstsOk ? 0 : 1, 1));

  // --- WARNING: www / non-www duplicate host ----------------------------------------
  if (hostVariants) {
    const dup = hostVariants.duplicate;
    findings.push(finding('host_duplicate',
      'www and non-www both serve content (duplicate host)', 'warning',
      dup
        ? 'Both the www and non-www hosts return HTTP 200 without redirecting to one '
          + 'canonical host — every URL exists twice. Add a 301 redirect to your preferred host.'
        : 'A single canonical host is enforced',
      dup
        ? [{ url: hostVariants.nonwww, note: 'serves 200' }, { url: hostVariants.www, note: 'serves 200' }]
        : [],
      dup ? 1 : 0, 1));
  }

  // --- NOTICE: robots.txt / sitemap health --------------------------------------------
  const srItems = [];
  let srFail = 0;
  if (!robots.exists) {
    srItems.push({
      url: joinUrl(startUrl, '/robots.txt'),
      note: `robots.txt missing or empty (HTTP ${robots.status})`,
    });
    srFail += 1;
  } else {
    if (robots.blocks_all) {
      srItems.push({ url: 'robots.txt', note: 'Disallow: / blocks the ENTIRE site for all bots' });
      srFail += 1;
    }
    if (!robots.sitemaps.length) {
      srItems.push({ url: 'robots.txt', note: 'no Sitemap: directive in robots.txt (recommended)' });
      srFail += 1;
    }
  }
  (robots.issues || []).forEach((issue) => { srItems.push({ url: 'robots.txt', note: issue }); srFail += 1; });
  if (sitemap.count === 0) {
    srItems.push({ url: joinUrl(startUrl, '/sitemap.xml'), note: 'no valid XML sitemap found' });
    srFail += 1;
  }
  (sitemap.issues || []).forEach((issue) => { srItems.push({ url: 'sitemap', note: issue }); srFail += 1; });
  findings.push(finding('sitemap_robots', 'robots.txt & sitemap health',
    robots.blocks_all ? 'error' : 'notice',
    `robots.txt: ${robots.exists ? 'present' : 'missing'}; `
    + `sitemap: ${sitemap.count} URL(s) in ${sitemap.found.length} file(s)`,
    srItems, srFail, Math.max(1, srFail + 4)));

  return findings;
}

// Site Health = weighted average across all APPLICABLE checks of the fraction
// of units that PASS, weighted by severity tier. Proportional (frequency of the
// issue), severity-weighted (errors > warnings > notices), and driven by
// checks-run rather than a flat per-category penalty. Passing checks hold the
// score up; each failing check drags its own term down in proportion to how
// many units are affected.
function siteHealth(findings) {
  let num = 0;
  let den = 0;
  for (const f of findings) {
    const total = f.total || 0;
    const w = TIER_WEIGHT[f.tier];      // "info" tier -> undefined -> never scored
    if (w === undefined || total <= 0) continue;
    const failFrac = Math.min(1, f.failed / total);
    const passFrac = 1 - (failFrac ** PENALTY_EXP);
    num += w * passFrac;
    den += w;
  }
  return den ? Math.round((100 * num) / den) : 100;
}

function groupFindings(findings) {
  const groups = {
    error: [], warning: [], notice: [], info: [], passed: [],
  };
  findings.forEach((f) => {
    if (!groups[f.display]) groups[f.display] = [];
    groups[f.display].push(f);
  });
  return groups;
}

module.exports = {
  analyze, siteHealth, groupFindings, finding,
  TIER_WEIGHT, PENALTY_EXP, TITLE_MAX, TITLE_MIN, DESC_MAX, DESC_MIN, LOW_WORDS, TEXT_HTML_MIN,
};
