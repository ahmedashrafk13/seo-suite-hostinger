// Weekly SEO reports: generate, browse, print, export.
const express = require('express');
const db = require('../db');
const reportBuilder = require('../lib/reportBuilder');
const { buildWorkbook, sendWorkbook } = require('../lib/xlsxExport');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.query.brand ? Number(req.query.brand) : null;
    res.render('reports', {
      title: 'Reports',
      active: 'reports',
      pageTitle: 'Weekly reports',
      brands: brandsFor(userId),
      brandId,
      reports: reportBuilder.list(userId, brandId),
      // Tool-run artifacts are also reachable from here, since people look for
      // "the reports" in one place.
      audits: db.prepare(`SELECT a.id, a.domain, a.created_at, a.status, b.name brand_name
        FROM audit_runs a LEFT JOIN brands b ON b.id=a.brand_id
        WHERE a.user_id=? AND a.status='completed' ORDER BY a.id DESC LIMIT 15`).all(userId),
      linkings: db.prepare(`SELECT l.id, l.site_url, l.created_at, l.status, l.docx_path, b.name brand_name
        FROM linking_runs l LEFT JOIN brands b ON b.id=l.brand_id
        WHERE l.user_id=? AND l.status='completed' ORDER BY l.id DESC LIMIT 15`).all(userId),
      reportCron: process.env.REPORT_CRON || '30 6 * * 1',
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/generate', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
    const full = Boolean(req.body.full_data);

    if (brandId) {
      const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
      if (!brand) return res.redirect('/reports?error=' + encodeURIComponent('Brand not found.'));
      const row = reportBuilder.generate(brand, { weekEnd: req.body.week_end || null, full });
      return res.redirect(`/reports/${row.id}?msg=` + encodeURIComponent(
        full ? 'Report generated with the full Search Console and GA4 data appendix.' : 'Report generated.'
      ));
    }

    const brands = db.prepare('SELECT * FROM brands WHERE user_id=? AND active=1').all(userId);
    if (!brands.length) return res.redirect('/reports?error=' + encodeURIComponent('Add a brand first.'));
    let n = 0;
    brands.forEach((brand) => {
      try { reportBuilder.generate(brand, { full }); n += 1; } catch (e) {
        console.error(`[reports] ${brand.name}: ${e.message}`);
      }
    });
    res.redirect('/reports?msg=' + encodeURIComponent(`Generated ${n} report${n === 1 ? '' : 's'}.`));
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const row = reportBuilder.get(req.params.id, req.dataUserId);
    if (!row || !row.data) {
      return res.status(404).render('error', { title: 'Not found', active: 'reports', message: 'That report does not exist.' });
    }
    res.render('report-detail', {
      title: `${row.brand_name} · ${row.period_start}`,
      active: 'reports',
      pageTitle: 'Weekly report',
      row,
      d: row.data,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Print-optimised standalone version.
router.get('/:id/print', (req, res, next) => {
  try {
    const row = reportBuilder.get(req.params.id, req.dataUserId);
    if (!row || !row.data) return res.status(404).send('Not found');
    res.render('report-print', { row, d: row.data, layout: false });
  } catch (err) { next(err); }
});

// Excel export — one sheet per dataset. With the full appendix attached this
// is the complete GSC + GA4 hand-over; without it, the standard report's
// tables. Column sets are declared per sheet so the workbook keeps the styled
// header/frozen-row treatment the rest of the app's exports use.
const COLS = {
  gscEntity: (name) => [
    { header: name, key: 'entity', width: 46 },
    { header: 'Clicks', key: 'clicks', width: 12 },
    { header: 'Impressions', key: 'impressions', width: 14 },
    { header: 'CTR', key: 'ctr', width: 10 },
    { header: 'Position', key: 'position', width: 10 },
  ],
  ga4Entity: (name, key) => [
    { header: name, key, width: 40 },
    { header: 'Sessions', key: 'sessions', width: 12 },
    { header: 'Users', key: 'users', width: 12 },
    { header: 'Conversions', key: 'conversions', width: 13 },
  ],
};

// GSC stores CTR as a 0–1 ratio; a spreadsheet reader expects a percentage.
function asPct(v) { return v == null ? '' : Number((Number(v) * 100).toFixed(2)); }
function round(v, dp = 1) { return v == null ? '' : Number(Number(v).toFixed(dp)); }

router.get('/:id/xlsx', async (req, res, next) => {
  try {
    const row = reportBuilder.get(req.params.id, req.dataUserId);
    if (!row || !row.data) return res.status(404).redirect('/reports?error=' + encodeURIComponent('Report not found.'));
    const d = row.data;
    const sheets = [];

    sheets.push({
      name: 'Summary',
      columns: [
        { header: 'Metric', key: 'metric', width: 30 },
        { header: 'This week', key: 'recent', width: 16 },
        { header: 'Prior week', key: 'prior', width: 16 },
        { header: 'Change %', key: 'pct', width: 12 },
      ],
      rows: [
        { metric: 'Clicks', recent: round(d.search.clicks.recent, 0), prior: round(d.search.clicks.prior, 0), pct: round(d.search.clicks.pct) },
        { metric: 'Impressions', recent: round(d.search.impressions.recent, 0), prior: round(d.search.impressions.prior, 0), pct: round(d.search.impressions.pct) },
        { metric: 'CTR %', recent: round(d.search.ctr.recent, 2), prior: round(d.search.ctr.prior, 2), pct: round(d.search.ctr.pct) },
        { metric: 'Average position', recent: round(d.search.position.recent), prior: round(d.search.position.prior), pct: '' },
        { metric: 'Organic sessions', recent: round(d.analytics.sessions.recent, 0), prior: round(d.analytics.sessions.prior, 0), pct: round(d.analytics.sessions.pct) },
        { metric: 'Organic users', recent: round(d.analytics.users.recent, 0), prior: round(d.analytics.users.prior, 0), pct: round(d.analytics.users.pct) },
        { metric: 'Organic conversions', recent: round(d.analytics.conversions.recent, 0), prior: round(d.analytics.conversions.prior, 0), pct: round(d.analytics.conversions.pct) },
        { metric: 'Conversion rate %', recent: round(d.analytics.convRate.recent, 2), prior: round(d.analytics.convRate.prior, 2), pct: round(d.analytics.convRate.pct) },
        { metric: 'Engagement rate %', recent: round(d.analytics.engagementRate.recent, 1), prior: round(d.analytics.engagementRate.prior, 1), pct: round(d.analytics.engagementRate.pct) },
      ],
    });

    const f = d.full;
    if (f) {
      const gscRows = (rows) => rows.map((r) => ({
        entity: r.entity, clicks: round(r.clicks, 0), impressions: round(r.impressions, 0),
        ctr: asPct(r.ctr), position: round(r.position),
      }));
      const ga4Rows = (rows, key) => rows.map((r) => ({
        [key]: r[key], sessions: round(r.sessions, 0), users: round(r.users, 0), conversions: round(r.conversions, 0),
      }));

      sheets.push(
        { name: 'GSC daily',
          columns: [
            { header: 'Date', key: 'date', width: 14 },
            { header: 'Clicks', key: 'clicks', width: 12 },
            { header: 'Impressions', key: 'impressions', width: 14 },
            { header: 'CTR', key: 'ctr', width: 10 },
            { header: 'Position', key: 'position', width: 10 },
          ],
          rows: f.gsc.daily.map((r) => ({ date: r.date, clicks: round(r.clicks, 0), impressions: round(r.impressions, 0), ctr: asPct(r.ctr), position: round(r.position) })) },
        { name: 'GSC queries', columns: COLS.gscEntity('Query'), rows: gscRows(f.gsc.queries) },
        { name: 'GSC pages', columns: COLS.gscEntity('Page'), rows: gscRows(f.gsc.pages) },
        { name: 'GSC query to page',
          columns: [
            { header: 'Query', key: 'query', width: 40 },
            { header: 'Ranking URL', key: 'page', width: 52 },
            { header: 'Clicks', key: 'clicks', width: 12 },
            { header: 'Impressions', key: 'impressions', width: 14 },
            { header: 'CTR', key: 'ctr', width: 10 },
            { header: 'Position', key: 'position', width: 10 },
          ],
          rows: f.gsc.queryPage.map((r) => ({ query: r.query, page: r.page, clicks: round(r.clicks, 0), impressions: round(r.impressions, 0), ctr: asPct(r.ctr), position: round(r.position) })) },
        { name: 'GSC countries', columns: COLS.gscEntity('Country'), rows: gscRows(f.gsc.countries) },
        { name: 'GSC devices', columns: COLS.gscEntity('Device'), rows: gscRows(f.gsc.devices) },
        { name: 'GSC appearance', columns: COLS.gscEntity('Search appearance'), rows: gscRows(f.gsc.appearance) },
        { name: 'GSC sitemaps',
          columns: [
            { header: 'Sitemap', key: 'path', width: 52 },
            { header: 'Type', key: 'type', width: 16 },
            { header: 'Submitted URLs', key: 'submitted_count', width: 15 },
            { header: 'Indexed URLs', key: 'indexed_count', width: 14 },
            { header: 'Last submitted', key: 'last_submitted', width: 20 },
            { header: 'Last read', key: 'last_downloaded', width: 20 },
            { header: 'Warnings', key: 'warnings', width: 11 },
            { header: 'Errors', key: 'errors', width: 10 },
          ],
          rows: f.gsc.sitemaps },
        { name: 'GSC indexing',
          columns: [
            { header: 'URL', key: 'url', width: 52 },
            { header: 'Verdict', key: 'verdict', width: 12 },
            { header: 'Coverage state', key: 'coverage_state', width: 32 },
            { header: 'Robots', key: 'robots_txt_state', width: 16 },
            { header: 'Indexing state', key: 'indexing_state', width: 20 },
            { header: 'Fetch state', key: 'page_fetch_state', width: 18 },
            { header: 'Google canonical', key: 'google_canonical', width: 48 },
            { header: 'Declared canonical', key: 'user_canonical', width: 48 },
            { header: 'Last crawled', key: 'last_crawl_time', width: 22 },
            { header: 'Checked', key: 'checked_at', width: 20 },
            { header: 'Error', key: 'error', width: 30 },
          ],
          rows: f.gsc.indexing.rows },
        { name: 'GA4 daily',
          columns: [
            { header: 'Date', key: 'date', width: 14 },
            { header: 'Channel', key: 'channel', width: 24 },
            { header: 'Sessions', key: 'sessions', width: 12 },
            { header: 'Users', key: 'users', width: 12 },
            { header: 'Engaged sessions', key: 'engaged_sessions', width: 17 },
            { header: 'Conversions', key: 'conversions', width: 13 },
            { header: 'Bounce rate %', key: 'bounce_rate', width: 14 },
            { header: 'Avg duration (s)', key: 'avg_duration', width: 16 },
          ],
          rows: f.ga4.daily.map((r) => ({
            date: r.date, channel: r.channel, sessions: round(r.sessions, 0), users: round(r.users, 0),
            engaged_sessions: round(r.engaged_sessions, 0), conversions: round(r.conversions, 0),
            bounce_rate: asPct(r.bounce_rate), avg_duration: round(r.avg_duration),
          })) },
        { name: 'GA4 channels',
          columns: [
            { header: 'Channel', key: 'channel', width: 26 },
            { header: 'Sessions', key: 'sessions', width: 12 },
            { header: 'Users', key: 'users', width: 12 },
            { header: 'Engaged sessions', key: 'engaged_sessions', width: 17 },
            { header: 'Engagement rate %', key: 'engagement_rate', width: 18 },
            { header: 'Bounce rate %', key: 'bounce_rate', width: 14 },
            { header: 'Avg duration (s)', key: 'avg_duration', width: 16 },
            { header: 'Conversions', key: 'conversions', width: 13 },
          ],
          rows: f.ga4.channels.map((r) => ({
            channel: r.channel, sessions: round(r.sessions, 0), users: round(r.users, 0),
            engaged_sessions: round(r.engaged_sessions, 0),
            engagement_rate: r.sessions > 0 ? round((r.engaged_sessions / r.sessions) * 100) : '',
            bounce_rate: asPct(r.bounce_rate), avg_duration: round(r.avg_duration),
            conversions: round(r.conversions, 0),
          })) },
        { name: 'GA4 landing pages', columns: COLS.ga4Entity('Landing page', 'page_path'), rows: ga4Rows(f.ga4.landingPages, 'page_path') },
        { name: 'GA4 devices', columns: COLS.ga4Entity('Device category', 'device_category'), rows: ga4Rows(f.ga4.devices, 'device_category') },
        { name: 'GA4 browsers', columns: COLS.ga4Entity('Browser', 'browser'), rows: ga4Rows(f.ga4.browsers, 'browser') },
        { name: 'GA4 countries', columns: COLS.ga4Entity('Country', 'country'), rows: ga4Rows(f.ga4.countries, 'country') },
        { name: 'GA4 cities',
          columns: [
            { header: 'City', key: 'city', width: 26 },
            { header: 'Country', key: 'country', width: 26 },
            { header: 'Sessions', key: 'sessions', width: 12 },
            { header: 'Users', key: 'users', width: 12 },
            { header: 'Conversions', key: 'conversions', width: 13 },
          ],
          rows: f.ga4.cities.map((r) => ({ city: r.city, country: r.country, sessions: round(r.sessions, 0), users: round(r.users, 0), conversions: round(r.conversions, 0) })) },
        { name: 'GA4 acquisition',
          columns: [
            { header: 'Source', key: 'source', width: 26 },
            { header: 'Medium', key: 'medium', width: 20 },
            { header: 'Sessions', key: 'sessions', width: 12 },
            { header: 'Users', key: 'users', width: 12 },
            { header: 'New users', key: 'new_users', width: 12 },
            { header: 'Conversions', key: 'conversions', width: 13 },
          ],
          rows: f.ga4.acquisition.map((r) => ({
            source: r.source, medium: r.medium, sessions: round(r.sessions, 0),
            users: round(r.users, 0), new_users: round(r.new_users, 0), conversions: round(r.conversions, 0),
          })) },
        { name: 'GA4 events',
          columns: [
            { header: 'Event name', key: 'event_name', width: 32 },
            { header: 'Event count', key: 'event_count', width: 14 },
            { header: 'Total users', key: 'total_users', width: 13 },
            { header: 'Event value', key: 'event_value', width: 14 },
          ],
          rows: f.ga4.events.map((r) => ({
            event_name: r.event_name, event_count: round(r.event_count, 0),
            total_users: round(r.total_users, 0), event_value: round(r.event_value, 2),
          })) },
        { name: 'Core Web Vitals',
          columns: [
            { header: 'Measured', key: 'captured_at', width: 20 },
            { header: 'URL', key: 'url', width: 44 },
            { header: 'Device', key: 'strategy', width: 12 },
            { header: 'Score', key: 'perf_score', width: 10 },
            { header: 'LCP (ms)', key: 'lcp', width: 12 },
            { header: 'INP (ms)', key: 'inp', width: 12 },
            { header: 'CLS', key: 'cls', width: 10 },
            { header: 'FCP (ms)', key: 'fcp', width: 12 },
            { header: 'TTFB (ms)', key: 'ttfb', width: 12 },
            { header: 'Source', key: 'source', width: 14 },
            { header: 'Error', key: 'error', width: 30 },
          ],
          rows: f.site.psi },
        { name: 'Uptime',
          columns: [
            { header: 'Checked', key: 'checked_at', width: 20 },
            { header: 'URL', key: 'url', width: 44 },
            { header: 'Status code', key: 'status_code', width: 13 },
            { header: 'OK', key: 'ok', width: 8 },
            { header: 'Response (ms)', key: 'response_ms', width: 14 },
            { header: 'Error', key: 'error', width: 30 },
          ],
          rows: f.site.uptime },
      );
    } else {
      sheets.push(
        { name: 'Top landing pages', columns: COLS.gscEntity('Page'),
          rows: d.pages.topLanding.map((r) => ({
            entity: r.entity, clicks: round(r.recentClicks, 0), impressions: round(r.recentImpressions, 0),
            ctr: asPct(r.recentCtr), position: round(r.recentPosition),
          })) },
        { name: 'Keyword movement',
          columns: [
            { header: 'Query', key: 'entity', width: 46 },
            { header: 'Direction', key: 'direction', width: 12 },
            { header: 'Clicks', key: 'clicks', width: 12 },
            { header: 'Clicks change', key: 'clickDelta', width: 14 },
            { header: 'Impressions', key: 'impressions', width: 14 },
            { header: 'Position', key: 'position', width: 10 },
          ],
          rows: [
            ...d.keywords.gainers.map((q) => ({ direction: 'gain', ...q })),
            ...d.keywords.decliners.map((q) => ({ direction: 'decline', ...q })),
          ].map((q) => ({
            entity: q.entity, direction: q.direction, clicks: round(q.recentClicks, 0),
            clickDelta: round(q.clickDelta, 0), impressions: round(q.recentImpressions, 0),
            position: round(q.recentPosition),
          })) },
      );
    }

    const workbook = buildWorkbook({ sheets });
    const safeBrand = String(row.brand_name || 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await sendWorkbook(res, workbook, `${safeBrand}-${row.period_start}-to-${row.period_end}${f ? '-full-data' : ''}.xlsx`);
  } catch (err) { next(err); }
});

router.get('/:id/json', (req, res) => {
  const row = reportBuilder.get(req.params.id, req.dataUserId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(row.data_json);
});

// Sends an already-generated report by email on demand, so a user can verify
// SMTP delivery or re-send a report without waiting for Monday's cron.
router.post('/:id/send', async (req, res, next) => {
  try {
    const row = reportBuilder.get(req.params.id, req.dataUserId);
    if (!row || !row.data) return res.status(404).redirect('/reports?error=' + encodeURIComponent('Report not found.'));
    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(row.brand_id);
    const user = db.prepare('SELECT email FROM users WHERE id=?').get(req.dataUserId);
    const recipient = (req.body.to || (brand && brand.notify_email) || (user && user.email) || '').trim();
    if (!recipient) return res.redirect(`/reports/${row.id}?error=` + encodeURIComponent('No recipient email available.'));
    const notify = require('../lib/notify');
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`;
    const result = await notify.sendWeeklyReport(recipient, row.data, `${baseUrl}/reports/${row.id}`);
    if (result.sent) {
      return res.redirect(`/reports/${row.id}?msg=` + encodeURIComponent(`Report emailed to ${recipient}.`));
    }
    return res.redirect(`/reports/${row.id}?error=` + encodeURIComponent(`Email not sent: ${result.reason || 'unknown error'}`));
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM weekly_reports WHERE id=? AND user_id=?').run(req.params.id, req.dataUserId);
  res.redirect('/reports?msg=' + encodeURIComponent('Report deleted.'));
});

module.exports = router;
