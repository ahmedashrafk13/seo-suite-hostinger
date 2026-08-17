// Performance: a GSC/GA4-mirroring dashboard — the same numbers an SEO would
// pull from Search Console's Performance report and GA4's Reports, joined
// into one screen per brand, with the recent-vs-prior comparisons the rest
// of the suite already relies on (src/lib/analytics.js).
const express = require('express');
const db = require('../db');
const A = require('../lib/analytics');
const google = require('../lib/google');
const sync = require('../lib/sync');
const csvStore = require('../lib/csvStore');

const router = express.Router();

const RANGES = [7, 28, 90];
const SORTABLE = new Set(['clicks', 'impressions', 'ctr', 'position']);
const TABS = [
  'queries', 'pages', 'querypage', 'countries', 'devices', 'appearance', 'sitemaps', 'indexing',
  'channels', 'ga4pages', 'ga4devices', 'ga4geo', 'ga4acquisition', 'ga4events', 'ai',
];
const PAGE_SIZE = 50;

function sortRows(rows, sort, dir) {
  const key = SORTABLE.has(sort) ? sort : 'clicks';
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => (Number(a[key]) - Number(b[key])) * mul);
}

// Slices one page out of an already-sorted/filtered array, mirroring GSC's
// "Rows per page" tables instead of dumping hundreds of rows on one screen.
function paginate(rows, page) {
  const total = rows.length;
  const start = (page - 1) * PAGE_SIZE;
  return { rows: rows.slice(start, start + PAGE_SIZE), total };
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = db.prepare('SELECT * FROM brands WHERE user_id=? AND active=1 ORDER BY name').all(userId);
    const selectedId = req.query.brand ? Number(req.query.brand) : (brands[0] ? brands[0].id : null);
    const brand = brands.find((b) => b.id === selectedId) || null;

    const days = RANGES.includes(Number(req.query.days)) ? Number(req.query.days) : 28;
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'queries';
    const sort = req.query.sort || 'clicks';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let data = null;
    if (brand) {
      const gsc = A.gscComparison(brand.id, days);
      const ga4 = A.ga4Comparison(brand.id, days, 'Organic Search');
      const series = A.dailySeries(brand.id, days);
      const ga4Series = A.ga4Series(brand.id, days, 'Organic Search');

      let queries = A.queryComparison(brand.id, days, { limit: 5000 });
      let pages = A.pageComparison(brand.id, days, { limit: 5000 });
      if (q) {
        queries = queries.filter((r) => r.entity.toLowerCase().includes(q));
        pages = pages.filter((r) => r.entity.toLowerCase().includes(q));
      }
      const queriesSorted = sortRows(queries.map((r) => ({
        entity: r.entity, clicks: r.recentClicks, impressions: r.recentImpressions,
        ctr: r.recentCtr, position: r.recentPosition, priorClicks: r.priorClicks,
      })), sort, dir);
      const pagesSorted = sortRows(pages.map((r) => ({
        entity: r.entity, clicks: r.recentClicks, impressions: r.recentImpressions,
        ctr: r.recentCtr, position: r.recentPosition, priorClicks: r.priorClicks,
      })), sort, dir);
      const queryPage = paginate(queriesSorted, page);
      const pagePage = paginate(pagesSorted, page);

      const channels = A.ga4Channels(brand.id, days);

      // query × page from the latest sync window — which URL actually ranks
      // for each keyword.
      const queryPagePairs = A.queryPagePairs(brand.id, { limit: 5000 });
      let queryPageRows = queryPagePairs.rows;
      if (q) queryPageRows = queryPageRows.filter((r) => `${r.query} ${r.page}`.toLowerCase().includes(q));
      const queryPagePaged = paginate(sortRows(queryPageRows, sort, dir), page);

      let ga4Pages = [];
      const gaAnchor = A.latestGa4Date(brand.id);
      if (gaAnchor) {
        const w = A.windowFrom(gaAnchor, days);
        ga4Pages = db.prepare(`SELECT page_path entity,
            SUM(sessions) sessions, SUM(users) users, SUM(conversions) conversions
          FROM ga4_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
          GROUP BY page_path ORDER BY sessions DESC LIMIT 2000`).all(brand.id, w.startDate, w.endDate);
        if (q) ga4Pages = ga4Pages.filter((r) => r.entity.toLowerCase().includes(q));
      }
      const ga4PagePage = paginate(ga4Pages, page);

      // GSC extra dimensions — mirrors Search Console's Countries / Devices /
      // Search appearance tabs and the Sitemaps report.
      let countries = A.gscCountries(brand.id, days, 2000);
      const devices = A.gscDevices(brand.id, days);
      const appearance = A.gscAppearance(brand.id, days);
      const sitemaps = A.gscSitemaps(brand.id);
      if (q) countries = countries.filter((r) => r.entity.toLowerCase().includes(q));
      const countryPage = paginate(countries, page);

      // GA4 extra dimensions — mirrors GA4's Tech, Demographics, Acquisition
      // and Engagement > Events reports.
      const ga4DeviceRows = A.ga4Devices(brand.id, days);
      const ga4BrowserRows = A.ga4Browsers(brand.id, days);
      let ga4CountryRows = A.ga4Countries(brand.id, days, 2000);
      if (q) ga4CountryRows = ga4CountryRows.filter((r) => r.country.toLowerCase().includes(q));
      const ga4CountryPage = paginate(ga4CountryRows, page);
      let ga4CityRows = A.ga4Cities(brand.id, days, 500);
      if (q) ga4CityRows = ga4CityRows.filter((r) => `${r.city} ${r.country}`.toLowerCase().includes(q));
      let ga4AcquisitionRows = A.ga4Acquisition(brand.id, days, 2000);
      if (q) ga4AcquisitionRows = ga4AcquisitionRows.filter((r) => `${r.source}/${r.medium}`.toLowerCase().includes(q));
      const ga4AcquisitionPage = paginate(ga4AcquisitionRows, page);
      const ga4EventRows = A.ga4Events(brand.id, days, 1000);
      const ga4EventPage = paginate(ga4EventRows, page);

      // Page indexing — sampled via URL Inspection (see sync.inspectSample);
      // Google exposes no bulk coverage API, so this reflects only the pages
      // actually checked so far, not every URL on the site.
      const indexing = A.indexingSummary(brand.id);
      const indexingPage = A.indexingRows(brand.id, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      // Rich results and crawler split ride along on the same URL Inspection
      // rows — no extra API quota is spent to show them.
      const richResults = A.richResultsSummary(brand.id);
      const crawlers = A.crawlerSummary(brand.id);

      // Broken links straight from the linking crawl — no URL Inspection
      // quota needed, and the direct answer to "which links are dead".
      let brokenLinks = [];
      let brokenLinksTotal = 0;
      const latestLinking = db.prepare(`SELECT out_dir FROM linking_runs
        WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
        ORDER BY id DESC LIMIT 1`).get(brand.id);
      if (latestLinking && latestLinking.out_dir) {
        const table = csvStore.readTable(latestLinking.out_dir, 'broken_links', { perPage: 20 });
        if (table) { brokenLinks = table.rows; brokenLinksTotal = table.total; }
      }

      data = {
        gsc, ga4, series, ga4Series,
        queryRows: queryPage.rows, queryTotal: queryPage.total,
        pageRows: pagePage.rows, pageTotal: pagePage.total,
        channels,
        queryPagePeriod: queryPagePairs.period,
        queryPageRows: queryPagePaged.rows, queryPageTotal: queryPagePaged.total,
        ga4Pages: ga4PagePage.rows, ga4PageTotal: ga4PagePage.total,
        countries: countryPage.rows, countryTotal: countryPage.total, countriesForChart: countries,
        devices, appearance, sitemaps,
        ga4DeviceRows, ga4BrowserRows,
        ga4CountryRows: ga4CountryPage.rows, ga4CountryTotal: ga4CountryPage.total, ga4CountriesForChart: ga4CountryRows,
        ga4CityRows,
        ga4AcquisitionRows: ga4AcquisitionPage.rows, ga4AcquisitionTotal: ga4AcquisitionPage.total, ga4AcquisitionForChart: ga4AcquisitionRows,
        ga4EventRows: ga4EventPage.rows, ga4EventTotal: ga4EventPage.total, ga4EventsForChart: ga4EventRows,
        indexing, indexingRows: indexingPage.rows, indexingTotal: indexingPage.total,
        richResults, crawlers,
        brokenLinks, brokenLinksTotal,
      };
    }

    res.render('performance', {
      title: 'Performance', active: 'performance', pageTitle: 'Performance',
      brands, brand, selectedId, days, RANGES, tab, sort, dir, q, page, pageSize: PAGE_SIZE, data,
      // When set, the template renders only the tab-content fragment (no
      // shell/KPI cards) so switching tabs/sorting/paging can be done via
      // fetch() + innerHTML swap instead of a full page reload.
      ajax: req.query.ajax === '1',
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Runs a batch of URL Inspection checks for the brand's highest-traffic
// unchecked pages. Manual/on-demand rather than part of the nightly sync
// because the API is slow (one call per URL) and quota-capped (~2,000/day).
router.post('/inspect', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, userId);
    if (!brand) return res.redirect('/performance?error=' + encodeURIComponent('Brand not found.'));
    const limit = Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 40));
    const r = await sync.inspectSample(brand, { limit });
    const msg = r.skipped
      ? r.skipped
      : `Checked ${r.rows} of ${r.checked} page(s).${r.detail ? ` Some failed: ${r.detail}` : ''}`;
    res.redirect(`/performance?brand=${brand.id}&tab=indexing&msg=` + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

// Live "active users right now" widget, polled from the page — the in-app
// equivalent of GA4 Home's realtime card. Best-effort: GA4 realtime has its
// own quota and occasional latency, so failures degrade to "unavailable"
// rather than breaking the page.
router.get('/realtime.json', async (req, res) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.query.brand, userId);
    if (!brand || !brand.ga4_property_id) return res.json({ ok: false, reason: 'No GA4 property linked.' });

    const [totalRows, byCountry, byPage] = await Promise.all([
      google.ga4RunRealtimeReport(userId, brand.ga4_property_id, { metrics: ['activeUsers'] }),
      google.ga4RunRealtimeReport(userId, brand.ga4_property_id, { dimensions: ['country'], metrics: ['activeUsers'], limit: 10 }),
      google.ga4RunRealtimeReport(userId, brand.ga4_property_id, { dimensions: ['unifiedScreenName'], metrics: ['activeUsers'], limit: 10 }),
    ]);
    const activeUsers = totalRows[0] ? totalRows[0].metrics.activeUsers : 0;
    res.json({
      ok: true,
      activeUsers,
      byCountry: byCountry.map((r) => ({ country: r.dimensions[0], activeUsers: r.metrics.activeUsers })),
      byPage: byPage.map((r) => ({ page: r.dimensions[0], activeUsers: r.metrics.activeUsers })),
    });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
});

module.exports = router;
