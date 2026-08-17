// Period-comparison maths over the consolidated tables.
//
// Alerts, the weekly report and the opportunity engine all need the same
// "recent window vs prior window" comparison at site, page and query level.
// Implementing it once here keeps a "20% drop" identical everywhere.
//
// Window convention: `days` long, ending `endOffset` days before the most
// recent day we hold data for. So with days=7, offset=0 -> last 7 days;
// offset=7 -> the 7 days before those.
const db = require('../db');
const { GSC_LAG_DAYS } = require('./sync');

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Anchor windows on the newest date actually present for the brand rather than
// on "today" — otherwise every comparison silently includes empty days at the
// end whenever a sync is stale or GSC is lagging.
function latestGscDate(brandId) {
  const r = db.prepare('SELECT MAX(date) d FROM gsc_daily WHERE brand_id=?').get(brandId);
  return r && r.d ? r.d : null;
}

function latestGa4Date(brandId) {
  const r = db.prepare('SELECT MAX(date) d FROM ga4_daily WHERE brand_id=?').get(brandId);
  return r && r.d ? r.d : null;
}

function windowFrom(anchorIso, days, endOffset = 0) {
  const end = new Date(`${anchorIso}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - endOffset);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

// A matched pair of windows: the recent one and the equally long one before it.
function comparisonWindows(anchorIso, days) {
  return {
    recent: windowFrom(anchorIso, days, 0),
    prior: windowFrom(anchorIso, days, days),
  };
}

function pctChange(recent, prior) {
  if (prior === 0) return recent === 0 ? 0 : Infinity;
  return ((recent - prior) / prior) * 100;
}

// A drop expressed as a positive number of percent (0 when it grew).
function dropPct(recent, prior) {
  if (prior <= 0) return 0;
  const d = ((prior - recent) / prior) * 100;
  return d > 0 ? d : 0;
}

// ------------------------------------------------------------ site totals

function gscWindow(brandId, w) {
  const r = db.prepare(`SELECT
      COALESCE(SUM(clicks),0) clicks,
      COALESCE(SUM(impressions),0) impressions,
      COALESCE(SUM(position*impressions),0) pos_weighted,
      COUNT(*) days
    FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ?`)
    .get(brandId, w.startDate, w.endDate);
  return {
    ...w,
    clicks: r.clicks,
    impressions: r.impressions,
    days: r.days,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    position: r.impressions > 0 ? r.pos_weighted / r.impressions : 0,
  };
}

function ga4Window(brandId, w, channel = 'Organic Search') {
  // bounce_rate and avg_duration are per-day ratios/averages, so they have to
  // be re-weighted by that day's sessions — a plain SUM or AVG over days would
  // let a 3-session Sunday count as much as a 3,000-session Tuesday.
  const r = db.prepare(`SELECT
      COALESCE(SUM(sessions),0) sessions,
      COALESCE(SUM(users),0) users,
      COALESCE(SUM(engaged_sessions),0) engaged_sessions,
      COALESCE(SUM(conversions),0) conversions,
      COALESCE(SUM(bounce_rate * sessions),0) bounce_weighted,
      COALESCE(SUM(avg_duration * sessions),0) duration_weighted,
      COUNT(*) days
    FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ? AND channel=?`)
    .get(brandId, w.startDate, w.endDate, channel);
  return {
    ...w,
    sessions: r.sessions,
    users: r.users,
    engaged_sessions: r.engaged_sessions,
    conversions: r.conversions,
    days: r.days,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : 0,
    conv_rate: r.sessions > 0 ? r.conversions / r.sessions : 0,
    bounce_rate: r.sessions > 0 ? r.bounce_weighted / r.sessions : 0,
    avg_duration: r.sessions > 0 ? r.duration_weighted / r.sessions : 0,
  };
}

// Every channel in the window with the full ga4_daily metric set, including
// the bounce rate and average session duration that are synced for every row
// but were not read back anywhere.
function ga4Channels(brandId, days) {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT channel,
      SUM(sessions) sessions, SUM(users) users, SUM(engaged_sessions) engaged_sessions,
      SUM(conversions) conversions,
      SUM(bounce_rate * sessions) / NULLIF(SUM(sessions),0) bounce_rate,
      SUM(avg_duration * sessions) / NULLIF(SUM(sessions),0) avg_duration
    FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY channel ORDER BY sessions DESC`).all(brandId, w.startDate, w.endDate);
}

// Site-level GSC comparison, or null when there is not enough history to be
// meaningful (both windows need real days of data).
function gscComparison(brandId, days) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return null;
  const { recent, prior } = comparisonWindows(anchor, days);
  const r = gscWindow(brandId, recent);
  const p = gscWindow(brandId, prior);
  if (r.days === 0 || p.days === 0) return null;
  return { anchor, recent: r, prior: p };
}

function ga4Comparison(brandId, days, channel = 'Organic Search') {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return null;
  const { recent, prior } = comparisonWindows(anchor, days);
  const r = ga4Window(brandId, recent, channel);
  const p = ga4Window(brandId, prior, channel);
  if (r.days === 0 || p.days === 0) return null;
  return { anchor, recent: r, prior: p };
}

// ------------------------------------------------- per-entity comparisons

// Generic: aggregate `table`.`entityCol` over two windows and join them, so
// each row carries recent + prior metrics for one page or one query.
function entityComparison(brandId, table, entityCol, days, { minPriorImpressions = 0, limit = 5000 } = {}) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return [];
  const { recent, prior } = comparisonWindows(anchor, days);

  // FULL OUTER JOIN so an entity present in only one window still appears —
  // a page that went to zero clicks is exactly what we most need to catch.
  const sql = `
    WITH r AS (
      SELECT ${entityCol} AS entity,
             SUM(clicks) clicks, SUM(impressions) impressions,
             SUM(position*impressions) pw
      FROM ${table} WHERE brand_id=@bid AND date BETWEEN @rs AND @re
      GROUP BY ${entityCol}
    ), p AS (
      SELECT ${entityCol} AS entity,
             SUM(clicks) clicks, SUM(impressions) impressions,
             SUM(position*impressions) pw
      FROM ${table} WHERE brand_id=@bid AND date BETWEEN @ps AND @pe
      GROUP BY ${entityCol}
    )
    SELECT
      COALESCE(r.entity, p.entity) entity,
      COALESCE(r.clicks,0) r_clicks,
      COALESCE(p.clicks,0) p_clicks,
      COALESCE(r.impressions,0) r_impressions,
      COALESCE(p.impressions,0) p_impressions,
      CASE WHEN COALESCE(r.impressions,0) > 0 THEN r.pw / r.impressions END r_position,
      CASE WHEN COALESCE(p.impressions,0) > 0 THEN p.pw / p.impressions END p_position
    FROM r FULL OUTER JOIN p ON r.entity = p.entity
    WHERE COALESCE(p.impressions,0) >= @minPrior
    ORDER BY COALESCE(p.impressions,0) DESC
    LIMIT @limit`;

  const rows = db.prepare(sql).all({
    bid: brandId,
    rs: recent.startDate, re: recent.endDate,
    ps: prior.startDate, pe: prior.endDate,
    minPrior: minPriorImpressions,
    limit,
  });

  return rows.map((r) => ({
    entity: r.entity,
    recentClicks: r.r_clicks,
    priorClicks: r.p_clicks,
    recentImpressions: r.r_impressions,
    priorImpressions: r.p_impressions,
    recentPosition: r.r_position,
    priorPosition: r.p_position,
    clicksDropPct: dropPct(r.r_clicks, r.p_clicks),
    impressionsDropPct: dropPct(r.r_impressions, r.p_impressions),
    clicksChangePct: pctChange(r.r_clicks, r.p_clicks),
    impressionsChangePct: pctChange(r.r_impressions, r.p_impressions),
    // Position is "lower is better", so a positive delta means it got worse.
    positionDelta: (r.r_position != null && r.p_position != null) ? r.r_position - r.p_position : null,
    recentCtr: r.r_impressions > 0 ? r.r_clicks / r.r_impressions : 0,
    priorCtr: r.p_impressions > 0 ? r.p_clicks / r.p_impressions : 0,
    windows: { recent, prior },
  }));
}

function pageComparison(brandId, days, opts) {
  return entityComparison(brandId, 'gsc_page_daily', 'page', days, opts);
}

function queryComparison(brandId, days, opts) {
  return entityComparison(brandId, 'gsc_query_daily', 'query', days, opts);
}

// ------------------------------------------------------------- single-window

function topPages(brandId, days, limit = 50) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT page entity,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function topQueries(brandId, days, limit = 50) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT query entity,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function dailySeries(brandId, days) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT date, clicks, impressions, ctr, position
    FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(brandId, w.startDate, w.endDate);
}

function ga4Series(brandId, days, channel = 'Organic Search') {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT date, sessions, users, engaged_sessions, conversions
    FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ? AND channel=? ORDER BY date`)
    .all(brandId, w.startDate, w.endDate, channel);
}

// ------------------------------------------------- GSC extra dimensions

function gscByDimension(brandId, table, col, days, limit = 50) {
  const anchor = latestGscDate(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT ${col} entity,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM ${table} WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY ${col} ORDER BY clicks DESC, impressions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function gscCountries(brandId, days, limit = 100) {
  return gscByDimension(brandId, 'gsc_country_daily', 'country', days, limit);
}

function gscDevices(brandId, days) {
  return gscByDimension(brandId, 'gsc_device_daily', 'device', days, 10);
}

function gscAppearance(brandId, days) {
  return gscByDimension(brandId, 'gsc_appearance_daily', 'appearance', days, 25);
}

function gscSitemaps(brandId) {
  return db.prepare('SELECT * FROM gsc_sitemaps WHERE brand_id=? ORDER BY path').all(brandId);
}

// ------------------------------------------------- GA4 extra dimensions

function ga4ByDimension(brandId, table, cols, days, limit = 50) {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  const selectCols = cols.join(', ');
  return db.prepare(`SELECT ${selectCols},
      SUM(sessions) sessions, SUM(users) users, SUM(conversions) conversions
    FROM ${table} WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY ${selectCols} ORDER BY sessions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function ga4Devices(brandId, days) {
  return ga4ByDimension(brandId, 'ga4_device_daily', ['device_category'], days, 10);
}

function ga4Browsers(brandId, days) {
  return ga4ByDimension(brandId, 'ga4_device_daily', ['browser'], days, 15);
}

function ga4Countries(brandId, days, limit = 100) {
  return ga4ByDimension(brandId, 'ga4_geo_daily', ['country'], days, limit);
}

// Cities are qualified by country: "Springfield" alone would merge a dozen
// unrelated places into one row.
function ga4Cities(brandId, days, limit = 50) {
  return ga4ByDimension(brandId, 'ga4_geo_daily', ['country', 'city'], days, limit);
}

function ga4Acquisition(brandId, days, limit = 100) {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT source, medium,
      SUM(sessions) sessions, SUM(users) users, SUM(new_users) new_users, SUM(conversions) conversions
    FROM ga4_acquisition_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY source, medium ORDER BY sessions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function ga4Events(brandId, days, limit = 100) {
  const anchor = latestGa4Date(brandId);
  if (!anchor) return [];
  const w = windowFrom(anchor, days);
  return db.prepare(`SELECT event_name,
      SUM(event_count) event_count, SUM(total_users) total_users, SUM(event_value) event_value
    FROM ga4_event_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY event_name ORDER BY event_count DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

// ------------------------------------------------------ Page indexing (sampled)

// Reason breakdown, mirroring GSC's "Why pages aren't indexed" table —
// grouped by coverage state, most-common reason first. Only ever reflects
// URLs actually inspected via inspectSample(), since Google exposes no bulk
// coverage API.
function indexingSummary(brandId) {
  const rows = db.prepare(`SELECT
      COALESCE(coverage_state, 'Not yet checked') reason,
      verdict,
      COUNT(*) pages
    FROM url_inspections WHERE brand_id=? AND error IS NULL
    GROUP BY coverage_state, verdict
    ORDER BY pages DESC`).all(brandId);
  const totals = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN verdict='PASS' THEN 1 ELSE 0 END) "indexed",
      SUM(CASE WHEN verdict IS NOT NULL AND verdict != 'PASS' THEN 1 ELSE 0 END) notIndexed,
      MAX(checked_at) lastChecked
    FROM url_inspections WHERE brand_id=? AND error IS NULL`).get(brandId);
  return { reasons: rows, totals };
}

// Structured data as Google actually sees it, not as the page declares it.
// A page can serve perfect JSON-LD and still not qualify — this reports what
// Google detected on the URLs inspected so far, and any errors it raised.
function richResultsSummary(brandId) {
  const byType = db.prepare(`SELECT rich_result_types types, COUNT(*) pages
    FROM url_inspections
    WHERE brand_id=? AND error IS NULL AND rich_result_types IS NOT NULL
    GROUP BY rich_result_types ORDER BY pages DESC`).all(brandId);

  // rich_result_types holds a comma-joined list, so split it back out to count
  // each type across the whole sample rather than each unique combination.
  const typeCounts = new Map();
  byType.forEach((r) => {
    String(r.types).split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => {
      typeCounts.set(t, (typeCounts.get(t) || 0) + r.pages);
    });
  });

  const totals = db.prepare(`SELECT
      COUNT(*) checked,
      SUM(CASE WHEN rich_result_types IS NOT NULL THEN 1 ELSE 0 END) withRichResults,
      SUM(CASE WHEN rich_result_verdict='FAIL' THEN 1 ELSE 0 END) failing,
      SUM(CASE WHEN rich_result_issues IS NOT NULL THEN 1 ELSE 0 END) withIssues
    FROM url_inspections WHERE brand_id=? AND error IS NULL`).get(brandId);

  const issueRows = db.prepare(`SELECT url, rich_result_issues issues
    FROM url_inspections
    WHERE brand_id=? AND error IS NULL AND rich_result_issues IS NOT NULL LIMIT 50`).all(brandId);
  const issues = [];
  issueRows.forEach((r) => {
    try {
      JSON.parse(r.issues).forEach((i) => issues.push({ url: r.url, ...i }));
    } catch { /* a malformed blob should not take the page down */ }
  });

  return {
    totals,
    types: [...typeCounts.entries()].map(([type, pages]) => ({ type, pages })).sort((a, b) => b.pages - a.pages),
    issues: issues.slice(0, 50),
  };
}

// Which Googlebot indexed each page. A desktop-crawled page on a
// mobile-first-indexed site is worth knowing about.
function crawlerSummary(brandId) {
  return db.prepare(`SELECT COALESCE(crawled_as, 'Unknown') crawled_as, COUNT(*) pages
    FROM url_inspections WHERE brand_id=? AND error IS NULL
    GROUP BY crawled_as ORDER BY pages DESC`).all(brandId);
}

function indexingRows(brandId, { limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`SELECT * FROM url_inspections WHERE brand_id=?
    ORDER BY (verdict='PASS') ASC, checked_at DESC LIMIT ? OFFSET ?`).all(brandId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) n FROM url_inspections WHERE brand_id=?').get(brandId).n;
  return { rows, total };
}

// Latest Core Web Vitals snapshot per strategy, plus the one before it so
// degradation can be detected.
function latestCwv(brandId, strategy = 'mobile') {
  return db.prepare(`SELECT * FROM psi_snapshots
    WHERE brand_id=? AND strategy=? AND error IS NULL
    ORDER BY captured_at DESC, id DESC LIMIT 2`).all(brandId, strategy);
}

// Queries where more than one URL takes meaningful impressions — the signal
// for keyword cannibalisation.
function cannibalizedQueries(brandId, { minImpressions = 50, minPages = 2 } = {}) {
  const row = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(brandId);
  if (!row) return [];
  return db.prepare(`SELECT query,
      COUNT(DISTINCT page) page_count,
      SUM(impressions) impressions,
      SUM(clicks) clicks,
      GROUP_CONCAT(page, ' | ') pages
    FROM gsc_query_page
    WHERE brand_id=? AND period_start=? AND period_end=? AND impressions >= 5
    GROUP BY query
    HAVING COUNT(DISTINCT page) >= ? AND SUM(impressions) >= ?
    ORDER BY impressions DESC LIMIT 200`)
    .all(brandId, row.period_start, row.period_end, minPages, minImpressions);
}

// The raw query × page pairs from the latest synced window — the answer to
// "which URL is ranking for this keyword". It was synced and used internally
// (cannibalisation, clustering, brand-share) but never shown as itself.
function queryPagePairs(brandId, { limit = 2000, minImpressions = 1 } = {}) {
  const row = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(brandId);
  if (!row) return { period: null, rows: [] };
  const rows = db.prepare(`SELECT query, page, clicks, impressions, ctr, position
    FROM gsc_query_page
    WHERE brand_id=? AND period_start=? AND period_end=? AND impressions >= ?
    ORDER BY clicks DESC, impressions DESC LIMIT ?`)
    .all(brandId, row.period_start, row.period_end, minImpressions, limit);
  return { period: row, rows };
}

// Which URL currently owns a query (highest impressions), for task detail.
function pageForQuery(brandId, query) {
  const row = db.prepare(`SELECT page, impressions, clicks, position FROM gsc_query_page
    WHERE brand_id=? AND query=? ORDER BY period_end DESC, impressions DESC LIMIT 1`)
    .get(brandId, query);
  return row || null;
}

module.exports = {
  isoDate, latestGscDate, latestGa4Date, windowFrom, comparisonWindows,
  pctChange, dropPct, gscWindow, ga4Window, gscComparison, ga4Comparison,
  entityComparison, pageComparison, queryComparison,
  topPages, topQueries, dailySeries, ga4Series, latestCwv,
  cannibalizedQueries, pageForQuery, queryPagePairs, GSC_LAG_DAYS,
  gscCountries, gscDevices, gscAppearance, gscSitemaps,
  ga4Channels, ga4Devices, ga4Browsers, ga4Countries, ga4Cities, ga4Acquisition, ga4Events,
  indexingSummary, indexingRows, richResultsSummary, crawlerSummary,
};
