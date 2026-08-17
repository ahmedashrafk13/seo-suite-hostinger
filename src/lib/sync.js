// SEO data consolidation.
//
// Pulls from Google Search Console, GA4, PageSpeed Insights and a plain HTTP
// uptime probe, and upserts everything into the brand-keyed tables in db.js.
// Every downstream feature (alerts, weekly reports, opportunities, keyword
// clustering, task generation) reads from those tables rather than calling
// Google directly — so the whole app keeps working when a quota is exhausted,
// and a metric means the same thing everywhere.
//
// All upserts are idempotent: re-syncing an overlapping date range replaces
// rows instead of double-counting. GSC finalises data ~2-3 days late, so the
// default window always re-pulls recent days to pick up revisions.
const db = require('../db');
const google = require('./google');
const csvStore = require('./csvStore');

const GSC_LAG_DAYS = 2; // GSC has no data for today/yesterday yet

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// The default sync window: `days` of history ending at the last day GSC is
// likely to have data for.
function defaultWindow(days = 90) {
  const end = daysAgo(GSC_LAG_DAYS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function startSyncRun(brandId, userId, kind) {
  const r = db.prepare(
    'INSERT INTO sync_runs (brand_id, user_id, kind, status) VALUES (?,?,?,?)'
  ).run(brandId, userId, kind, 'running');
  return r.lastInsertRowid;
}

function finishSyncRun(id, { status, rows = 0, detail = null, error = null }) {
  db.prepare(
    "UPDATE sync_runs SET status=?, rows_written=?, detail=?, error=?, finished_at=datetime('now') WHERE id=?"
  ).run(status, rows, detail, error, id);
}

// --------------------------------------------------------------------- GSC

async function syncGscDaily(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['date'], maxRows: 1000,
  });
  const stmt = db.prepare(`INSERT INTO gsc_daily (brand_id, date, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(brand_id, date) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(brand.id, r.keys[0], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGscPages(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  // date x page, so page-level trends and week-over-week deltas are possible.
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['date', 'page'], maxRows: 50000,
  });
  const stmt = db.prepare(`INSERT INTO gsc_page_daily (brand_id, date, page, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, page) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(brand.id, r.keys[0], r.keys[1], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGscQueries(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['date', 'query'], maxRows: 50000,
  });
  const stmt = db.prepare(`INSERT INTO gsc_query_daily (brand_id, date, query, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, query) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(brand.id, r.keys[0], r.keys[1], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

// query x page for the window as a whole. Needed to answer "which page ranks
// for this keyword" — used by clustering and the opportunity engine.
async function syncGscQueryPage(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['query', 'page'], maxRows: 25000,
  });
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM gsc_query_page WHERE brand_id=? AND period_start=? AND period_end=?')
      .run(brand.id, startDate, endDate);
    const stmt = db.prepare(`INSERT INTO gsc_query_page
      (brand_id, period_start, period_end, query, page, clicks, impressions, ctr, position)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(brand_id, period_start, period_end, query, page) DO UPDATE SET
        clicks=excluded.clicks, impressions=excluded.impressions,
        ctr=excluded.ctr, position=excluded.position`);
    list.forEach((r) => stmt.run(
      brand.id, startDate, endDate, r.keys[0], r.keys[1],
      r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGscCountries(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['date', 'country'], maxRows: 25000,
  });
  const stmt = db.prepare(`INSERT INTO gsc_country_daily (brand_id, date, country, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, country) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(brand.id, r.keys[0], r.keys[1], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGscDevices(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['date', 'device'], maxRows: 5000,
  });
  const stmt = db.prepare(`INSERT INTO gsc_device_daily (brand_id, date, device, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, device) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(brand.id, r.keys[0], r.keys[1], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

// GSC's API rejects searchAppearance combined with any other dimension
// (including date), so this is a window snapshot rather than a daily
// breakdown — stored under the window's end date, replacing any prior
// snapshot for that brand+date the same way a re-sync would.
async function syncGscAppearance(brand, { startDate, endDate }) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const rows = await google.searchAnalyticsAll(brand.user_id, brand.gsc_property, {
    startDate, endDate, dimensions: ['searchAppearance'], maxRows: 100,
  });
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM gsc_appearance_daily WHERE brand_id=? AND date=?').run(brand.id, endDate);
    const stmt = db.prepare(`INSERT INTO gsc_appearance_daily (brand_id, date, appearance, clicks, impressions, ctr, position)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(brand_id, date, appearance) DO UPDATE SET
        clicks=excluded.clicks, impressions=excluded.impressions,
        ctr=excluded.ctr, position=excluded.position`);
    list.forEach((r) => stmt.run(brand.id, endDate, r.keys[0], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
  });
  tx(rows);
  return { rows: rows.length };
}

// Sitemap snapshot: GSC only exposes current state, so each sync replaces the
// whole set for the brand rather than accumulating history.
async function syncGscSitemaps(brand) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const sitemaps = await google.listSitemaps(brand.user_id, brand.gsc_property);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM gsc_sitemaps WHERE brand_id=?').run(brand.id);
    const stmt = db.prepare(`INSERT INTO gsc_sitemaps
      (brand_id, path, is_pending, is_sitemaps_index, type, last_submitted, last_downloaded, warnings, errors, submitted_count, indexed_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    list.forEach((s) => {
      const contents = s.contents || [];
      const submitted = contents.reduce((a, c) => a + Number(c.submitted || 0), 0);
      const indexed = contents.reduce((a, c) => a + Number(c.indexed || 0), 0);
      stmt.run(
        brand.id, s.path, s.isPending ? 1 : 0, s.isSitemapsIndex ? 1 : 0,
        s.type || null, s.lastSubmitted || null, s.lastDownloaded || null,
        Number(s.warnings || 0), Number(s.errors || 0), submitted || null, indexed || null
      );
    });
  });
  tx(sitemaps);
  return { rows: sitemaps.length };
}

// --------------------------------------------------------------------- GA4

async function syncGa4Daily(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  // Split by default channel group so organic can be isolated from the rest
  // while still keeping total traffic available.
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'sessionDefaultChannelGroup'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'conversions', 'bounceRate', 'averageSessionDuration'],
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_daily
    (brand_id, date, channel, sessions, users, engaged_sessions, conversions, bounce_rate, avg_duration)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, channel) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users,
      engaged_sessions=excluded.engaged_sessions, conversions=excluded.conversions,
      bounce_rate=excluded.bounce_rate, avg_duration=excluded.avg_duration`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id,
      google.ga4DateToIso(r.dimensions[0]),
      r.dimensions[1] || '(unknown)',
      r.metrics.sessions || 0,
      r.metrics.totalUsers || 0,
      r.metrics.engagedSessions || 0,
      r.metrics.conversions || 0,
      r.metrics.bounceRate || 0,
      r.metrics.averageSessionDuration || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGa4Pages(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  // Organic-only landing pages, which is what maps onto GSC page data.
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'landingPagePlusQueryString'],
    metrics: ['sessions', 'totalUsers', 'conversions'],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
      },
    },
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_page_daily (brand_id, date, page_path, sessions, users, conversions)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, page_path) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users, conversions=excluded.conversions`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id,
      google.ga4DateToIso(r.dimensions[0]),
      r.dimensions[1] || '(not set)',
      r.metrics.sessions || 0,
      r.metrics.totalUsers || 0,
      r.metrics.conversions || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGa4Devices(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'deviceCategory', 'browser'],
    metrics: ['sessions', 'totalUsers', 'conversions'],
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_device_daily (brand_id, date, device_category, browser, sessions, users, conversions)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, device_category, browser) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users, conversions=excluded.conversions`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id, google.ga4DateToIso(r.dimensions[0]), r.dimensions[1] || '(not set)', r.dimensions[2] || '(not set)',
      r.metrics.sessions || 0, r.metrics.totalUsers || 0, r.metrics.conversions || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGa4Geo(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'country', 'city'],
    metrics: ['sessions', 'totalUsers', 'conversions'],
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_geo_daily (brand_id, date, country, city, sessions, users, conversions)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, country, city) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users, conversions=excluded.conversions`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id, google.ga4DateToIso(r.dimensions[0]), r.dimensions[1] || '(not set)', r.dimensions[2] || '(not set)',
      r.metrics.sessions || 0, r.metrics.totalUsers || 0, r.metrics.conversions || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGa4Acquisition(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'sessionSource', 'sessionMedium'],
    metrics: ['sessions', 'totalUsers', 'newUsers', 'conversions'],
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_acquisition_daily (brand_id, date, source, medium, sessions, users, new_users, conversions)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, source, medium) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users, new_users=excluded.new_users, conversions=excluded.conversions`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id, google.ga4DateToIso(r.dimensions[0]), r.dimensions[1] || '(direct)', r.dimensions[2] || '(none)',
      r.metrics.sessions || 0, r.metrics.totalUsers || 0, r.metrics.newUsers || 0, r.metrics.conversions || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

async function syncGa4Events(brand, { startDate, endDate }) {
  if (!brand.ga4_property_id) return { rows: 0, skipped: 'no GA4 property linked' };
  const rows = await google.ga4RunReport(brand.user_id, brand.ga4_property_id, {
    startDate, endDate,
    dimensions: ['date', 'eventName'],
    metrics: ['eventCount', 'totalUsers', 'eventValue'],
    limit: 25000,
  });
  const stmt = db.prepare(`INSERT INTO ga4_event_daily (brand_id, date, event_name, event_count, total_users, event_value)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, event_name) DO UPDATE SET
      event_count=excluded.event_count, total_users=excluded.total_users, event_value=excluded.event_value`);
  const tx = db.transaction((list) => {
    list.forEach((r) => stmt.run(
      brand.id, google.ga4DateToIso(r.dimensions[0]), r.dimensions[1] || '(not set)',
      r.metrics.eventCount || 0, r.metrics.totalUsers || 0, r.metrics.eventValue || 0
    ));
  });
  tx(rows);
  return { rows: rows.length };
}

// --------------------------------------------------- PageSpeed and uptime

async function syncPageSpeed(brand, urls) {
  const targets = (urls && urls.length ? urls : [brand.site_url]).slice(0, 5);
  let written = 0;
  const errors = [];
  for (const url of targets) {
    for (const strategy of ['mobile', 'desktop']) {
      try {
        const m = await google.pageSpeed(url, strategy);
        db.prepare(`INSERT INTO psi_snapshots
          (brand_id, url, strategy, perf_score, lcp, inp, cls, fcp, ttfb, source)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(brand.id, url, strategy, m.perf_score, m.lcp, m.inp, m.cls, m.fcp, m.ttfb, m.source);
        written += 1;
      } catch (err) {
        errors.push(`${strategy} ${url}: ${err.message}`);
        db.prepare('INSERT INTO psi_snapshots (brand_id, url, strategy, error) VALUES (?,?,?,?)')
          .run(brand.id, url, strategy, err.message.slice(0, 500));
      }
    }
  }
  return { rows: written, detail: errors.length ? errors.join('; ') : null };
}

async function checkUptime(brand) {
  const url = brand.site_url;
  const t0 = Date.now();
  try {
    // GET rather than HEAD: a surprising number of sites/CDNs reject HEAD.
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'SEO-Automation-Suite/2.0 (uptime check)' },
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    db.prepare('INSERT INTO uptime_checks (brand_id, url, status_code, ok, response_ms) VALUES (?,?,?,?,?)')
      .run(brand.id, url, res.status, res.ok ? 1 : 0, ms);
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    db.prepare('INSERT INTO uptime_checks (brand_id, url, status_code, ok, response_ms, error) VALUES (?,?,?,?,?,?)')
      .run(brand.id, url, null, 0, ms, err.message.slice(0, 500));
    return { ok: false, status: null, ms, error: err.message };
  }
}

// ------------------------------------------------------ URL Inspection sample
// Google publishes no bulk "index coverage" API — the URL Inspection API is
// the only way to read real indexing state, one URL at a time, capped at
// ~2,000 calls/day/property.
//
// Candidate selection matters: sampling only from gsc_page_daily (as this
// used to) guarantees "not indexed" almost never shows up, because a page
// needs to be indexed before it can earn clicks/impressions in the first
// place — the sample was structurally biased toward pages that already
// passed. Pages that are actually at risk of not being indexed are the ones
// with no organic traffic at all: broken internal-link targets, orphaned
// pages the crawler found no editorial links pointing at, and other
// under-linked pages. Those come from the linking agent's own CSVs, which
// already exist for any brand that has run a linking audit, so priority is:
//   1. broken link targets (the linking crawler already found these dead)
//   2. orphan / under-linked pages with the least organic traffic
//   3. top GSC pages, as a fallback and to keep refreshing the baseline
// so a rolling picture builds up over repeated runs without ever exceeding
// quota in one call, and it skips anything checked in the last 7 days.
// `topShare` reserves part of every batch for top-traffic pages instead of
// treating them purely as a fallback. Two reasons:
//   1. A site with a long orphan queue would never reach them, so the
//      indexed-page baseline would go stale indefinitely.
//   2. The crawl, sitemap and rich-result fields the inspection returns only
//      exist for pages Google has actually indexed — an at-risk-only sample
//      answers "is this page indexed?" but can never answer "does this site
//      qualify for rich results?", because a non-indexed page reports neither.
function candidatePages(brand, limit, { topShare = 0.35 } = {}) {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    if (!url || seen.has(url) || out.length >= limit) return;
    seen.add(url);
    out.push(url);
  };

  const topSlots = Math.max(1, Math.round(limit * topShare));
  const atRiskLimit = limit - topSlots;

  const latestLinking = db.prepare(`SELECT * FROM linking_runs
    WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brand.id);

  if (latestLinking && latestLinking.out_dir) {
    try {
      const broken = csvStore.readTable(latestLinking.out_dir, 'broken_links', { perPage: atRiskLimit });
      (broken ? broken.rows : []).forEach((r) => { if (out.length < atRiskLimit) add(r.url); });
    } catch { /* CSV missing or unreadable — fall through to the next tier */ }
    try {
      const orphans = csvStore.readTable(latestLinking.out_dir, 'orphans', {
        sort: 'gsc_impressions', dir: 'asc', perPage: atRiskLimit,
      });
      (orphans ? orphans.rows : []).forEach((r) => { if (out.length < atRiskLimit) add(r.url); });
    } catch { /* same */ }
  }

  // Top-traffic pages: the reserved slots, plus anything the at-risk tiers
  // left unused on sites with no linking crawl or no orphans.
  if (out.length < limit) {
    const rest = limit - out.length;
    const topGsc = db.prepare(`SELECT page FROM gsc_page_daily
      WHERE brand_id=? AND date >= date('now', '-90 days')
      GROUP BY page ORDER BY SUM(impressions) DESC LIMIT ?`).all(brand.id, rest * 3);
    topGsc.forEach((r) => add(r.page));
  }

  return out.slice(0, limit);
}

async function inspectSample(brand, { limit = 40 } = {}) {
  if (!brand.gsc_property) return { rows: 0, skipped: 'no GSC property linked' };
  const alreadyChecked = new Set(
    db.prepare(`SELECT url FROM url_inspections WHERE brand_id=? AND checked_at >= datetime('now', '-7 days')`)
      .all(brand.id).map((r) => r.url)
  );
  const candidates = candidatePages(brand, limit * 2)
    .filter((url) => !alreadyChecked.has(url))
    .slice(0, limit)
    .map((page) => ({ page }));

  const upsert = db.prepare(`INSERT INTO url_inspections
    (brand_id, url, verdict, coverage_state, robots_txt_state, indexing_state, page_fetch_state,
     google_canonical, user_canonical, last_crawl_time, crawled_as, sitemap, referring_urls,
     rich_result_verdict, rich_result_types, rich_result_issues, error, checked_at)
    VALUES (@brand_id,@url,@verdict,@coverage_state,@robots_txt_state,@indexing_state,@page_fetch_state,
      @google_canonical,@user_canonical,@last_crawl_time,@crawled_as,@sitemap,@referring_urls,
      @rich_result_verdict,@rich_result_types,@rich_result_issues,@error,datetime('now'))
    ON CONFLICT(brand_id, url) DO UPDATE SET
      verdict=excluded.verdict, coverage_state=excluded.coverage_state, robots_txt_state=excluded.robots_txt_state,
      indexing_state=excluded.indexing_state, page_fetch_state=excluded.page_fetch_state,
      google_canonical=excluded.google_canonical, user_canonical=excluded.user_canonical,
      last_crawl_time=excluded.last_crawl_time, crawled_as=excluded.crawled_as, sitemap=excluded.sitemap,
      referring_urls=excluded.referring_urls, rich_result_verdict=excluded.rich_result_verdict,
      rich_result_types=excluded.rich_result_types, rich_result_issues=excluded.rich_result_issues,
      error=excluded.error, checked_at=excluded.checked_at`);

  // richResultsResult lists each detected type with the items carrying it, plus
  // any structured-data errors. Google omits the block entirely when a page has
  // no eligible markup, which is itself the answer to "does this page qualify
  // for rich results" — so absent is stored as null, not as a failure.
  const richOf = (rr) => {
    if (!rr) return { verdict: null, types: null, issues: null };
    const detected = rr.detectedItems || [];
    const issues = [];
    detected.forEach((d) => {
      (d.items || []).forEach((item) => {
        (item.issues || []).forEach((iss) => issues.push({
          type: d.richResultType,
          severity: iss.severity || null,
          message: iss.issueMessage || null,
        }));
      });
    });
    return {
      verdict: rr.verdict || null,
      types: detected.map((d) => d.richResultType).filter(Boolean).join(', ') || null,
      issues: issues.length ? JSON.stringify(issues) : null,
    };
  };

  let written = 0;
  const errors = [];
  for (const c of candidates) {
    try {
      const r = await google.inspectUrl(brand.user_id, brand.gsc_property, c.page);
      const idx = (r && r.indexStatusResult) || {};
      const rich = richOf(r && r.richResultsResult);
      upsert.run({
        brand_id: brand.id, url: c.page,
        verdict: idx.verdict || null, coverage_state: idx.coverageState || null,
        robots_txt_state: idx.robotsTxtState || null, indexing_state: idx.indexingState || null,
        page_fetch_state: idx.pageFetchState || null, google_canonical: idx.googleCanonical || null,
        user_canonical: idx.userCanonical || null, last_crawl_time: idx.lastCrawlTime || null,
        crawled_as: idx.crawledAs || null,
        sitemap: (idx.sitemap || []).join(' | ') || null,
        referring_urls: (idx.referringUrls || []).slice(0, 25).join(' | ') || null,
        rich_result_verdict: rich.verdict, rich_result_types: rich.types, rich_result_issues: rich.issues,
        error: null,
      });
      written += 1;
    } catch (err) {
      errors.push(`${c.page}: ${err.message}`);
      upsert.run({
        brand_id: brand.id, url: c.page, verdict: null, coverage_state: null, robots_txt_state: null,
        indexing_state: null, page_fetch_state: null, google_canonical: null, user_canonical: null,
        last_crawl_time: null, crawled_as: null, sitemap: null, referring_urls: null,
        rich_result_verdict: null, rich_result_types: null, rich_result_issues: null,
        error: err.message.slice(0, 300),
      });
    }
  }
  return { rows: written, checked: candidates.length, detail: errors.length ? errors.slice(0, 5).join('; ') : null };
}

// ---------------------------------------------------------------- drivers

// Full sync for one brand. Each source is independent — a GA4 failure must
// not prevent GSC data from landing, so every step is caught separately and
// reported back in `steps`.
async function syncBrand(brand, { days = 90, includePsi = false } = {}) {
  const window = defaultWindow(days);
  const runId = startSyncRun(brand.id, brand.user_id, 'full');
  const steps = [];
  let total = 0;

  const tasks = [
    ['gsc_daily', () => syncGscDaily(brand, window)],
    ['gsc_pages', () => syncGscPages(brand, window)],
    ['gsc_queries', () => syncGscQueries(brand, window)],
    ['gsc_query_page', () => syncGscQueryPage(brand, window)],
    ['gsc_countries', () => syncGscCountries(brand, window)],
    ['gsc_devices', () => syncGscDevices(brand, window)],
    ['gsc_appearance', () => syncGscAppearance(brand, window)],
    ['gsc_sitemaps', () => syncGscSitemaps(brand)],
    ['ga4_daily', () => syncGa4Daily(brand, window)],
    ['ga4_pages', () => syncGa4Pages(brand, window)],
    ['ga4_devices', () => syncGa4Devices(brand, window)],
    ['ga4_geo', () => syncGa4Geo(brand, window)],
    ['ga4_acquisition', () => syncGa4Acquisition(brand, window)],
    ['ga4_events', () => syncGa4Events(brand, window)],
    ['uptime', () => checkUptime(brand).then((r) => ({ rows: 1, detail: r.ok ? `HTTP ${r.status}` : `DOWN: ${r.error || r.status}` }))],
  ];
  if (includePsi) tasks.push(['pagespeed', () => syncPageSpeed(brand, [brand.site_url])]);

  for (const [name, fn] of tasks) {
    try {
      const r = await fn();
      total += r.rows || 0;
      steps.push({ step: name, ok: true, rows: r.rows || 0, note: r.skipped || r.detail || null });
    } catch (err) {
      steps.push({ step: name, ok: false, rows: 0, note: err.message });
      console.error(`[sync] brand ${brand.id} ${name} failed: ${err.message}`);
    }
  }

  const anyOk = steps.some((s) => s.ok && s.rows > 0);
  const allFailed = steps.every((s) => !s.ok);
  finishSyncRun(runId, {
    status: allFailed ? 'error' : (anyOk ? 'completed' : 'completed_empty'),
    rows: total,
    detail: JSON.stringify(steps),
    error: allFailed ? steps.map((s) => `${s.step}: ${s.note}`).join('; ') : null,
  });

  return { runId, window, total, steps };
}

async function syncAllBrands({ days = 90, includePsi = false } = {}) {
  const brands = db.prepare('SELECT * FROM brands WHERE active = 1').all();
  const results = [];
  for (const brand of brands) {
    // Skip brands whose owner has disconnected Google — nothing to pull.
    const conn = google.getConnection(brand.user_id);
    if (!conn) {
      results.push({ brand: brand.name, skipped: 'owner has no Google connection' });
      continue;
    }
    try {
      const r = await syncBrand(brand, { days, includePsi });
      results.push({ brand: brand.name, total: r.total, steps: r.steps });
    } catch (err) {
      results.push({ brand: brand.name, error: err.message });
    }
  }
  return results;
}

// --------------------------------------------------------------- readers
// Small query helpers used by dashboards, reports and the alert engine, so
// the same aggregation logic is not re-implemented per caller.

function gscTotals(brandId, startDate, endDate) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(clicks),0) clicks,
      COALESCE(SUM(impressions),0) impressions,
      COUNT(*) days
    FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ?`).get(brandId, startDate, endDate);
  // Position must be impression-weighted, not a plain mean of daily averages.
  const pos = db.prepare(`SELECT
      COALESCE(SUM(position * impressions),0) wsum,
      COALESCE(SUM(impressions),0) isum
    FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ?`).get(brandId, startDate, endDate);
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    days: row.days,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
    position: pos.isum > 0 ? pos.wsum / pos.isum : 0,
  };
}

function ga4Totals(brandId, startDate, endDate, channel = 'Organic Search') {
  const where = channel ? 'AND channel = ?' : '';
  const args = channel ? [brandId, startDate, endDate, channel] : [brandId, startDate, endDate];
  return db.prepare(`SELECT
      COALESCE(SUM(sessions),0) sessions,
      COALESCE(SUM(users),0) users,
      COALESCE(SUM(engaged_sessions),0) engaged_sessions,
      COALESCE(SUM(conversions),0) conversions
    FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ? ${where}`).get(...args);
}

function dataCoverage(brandId) {
  const g = db.prepare('SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM gsc_daily WHERE brand_id=?').get(brandId);
  const a = db.prepare('SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM ga4_daily WHERE brand_id=?').get(brandId);
  const lastSync = db.prepare("SELECT * FROM sync_runs WHERE brand_id=? ORDER BY id DESC LIMIT 1").get(brandId);
  return { gsc: g, ga4: a, lastSync };
}

module.exports = {
  isoDate, daysAgo, defaultWindow, GSC_LAG_DAYS,
  syncGscDaily, syncGscPages, syncGscQueries, syncGscQueryPage,
  syncGscCountries, syncGscDevices, syncGscAppearance, syncGscSitemaps, inspectSample, candidatePages,
  syncGa4Daily, syncGa4Pages, syncGa4Devices, syncGa4Geo, syncGa4Acquisition, syncGa4Events,
  syncPageSpeed, checkUptime,
  syncBrand, syncAllBrands,
  gscTotals, ga4Totals, dataCoverage,
};
