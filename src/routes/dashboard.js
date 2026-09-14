// Command-centre dashboard: one screen answering "what needs my attention".
const express = require('express');
const db = require('../db');
const google = require('../lib/google');
const sync = require('../lib/sync');
const A = require('../lib/analytics');
const tasksLib = require('../lib/tasks');
const alertEngine = require('../lib/alertEngine');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const connected = Boolean(google.getConnection(userId));
    const brands = db.prepare('SELECT * FROM brands WHERE user_id=? AND active=1 ORDER BY name').all(userId);

    const selectedId = req.query.brand ? Number(req.query.brand) : null;
    const scope = selectedId ? brands.filter((b) => b.id === selectedId) : brands;

    // Per-brand summary card: 28-day search performance with week-over-week
    // movement, plus counts of what is outstanding.
    const cards = scope.map((brand) => {
      const cmp28 = A.gscComparison(brand.id, 28);
      const cmp7 = A.gscComparison(brand.id, 7);
      const ga = A.ga4Comparison(brand.id, 28);
      return {
        brand,
        gsc28: cmp28,
        gsc7: cmp7,
        ga4: ga,
        coverage: sync.dataCoverage(brand.id),
        openTasks: db.prepare("SELECT COUNT(*) n FROM tasks WHERE brand_id=? AND status IN ('backlog','in_progress','awaiting_approval','blocked')").get(brand.id).n,
        needsApproval: db.prepare("SELECT COUNT(*) n FROM tasks WHERE brand_id=? AND requires_approval=1 AND approved_at IS NULL AND status NOT IN ('done','dismissed')").get(brand.id).n,
        openAlerts: db.prepare('SELECT COUNT(*) n FROM alert_events WHERE brand_id=? AND acknowledged_at IS NULL').get(brand.id).n,
        criticalAlerts: db.prepare("SELECT COUNT(*) n FROM alert_events WHERE brand_id=? AND acknowledged_at IS NULL AND severity IN ('critical','high')").get(brand.id).n,
        series: A.dailySeries(brand.id, 30),
        latestAudit: db.prepare("SELECT id, status, created_at, json_result FROM audit_runs WHERE brand_id=? AND status='completed' ORDER BY id DESC LIMIT 1").get(brand.id),
      };
    }).map((c) => {
      // Pull the health score out without shipping the whole audit JSON to the view.
      let health = null;
      if (c.latestAudit && c.latestAudit.json_result) {
        try { health = JSON.parse(c.latestAudit.json_result).site_health; } catch { health = null; }
      }
      return { ...c, health, latestAudit: c.latestAudit ? { id: c.latestAudit.id, created_at: c.latestAudit.created_at } : null };
    });

    // Roll-up across whichever brands are in scope.
    const totals = cards.reduce((acc, c) => {
      if (c.gsc28) {
        acc.clicks += c.gsc28.recent.clicks;
        acc.priorClicks += c.gsc28.prior.clicks;
        acc.impressions += c.gsc28.recent.impressions;
        acc.priorImpressions += c.gsc28.prior.impressions;
      }
      if (c.ga4) {
        acc.sessions += c.ga4.recent.sessions;
        acc.conversions += c.ga4.recent.conversions;
        acc.priorConversions += c.ga4.prior.conversions;
      }
      acc.openTasks += c.openTasks;
      acc.needsApproval += c.needsApproval;
      acc.openAlerts += c.openAlerts;
      acc.criticalAlerts += c.criticalAlerts;
      return acc;
    }, {
      clicks: 0, priorClicks: 0, impressions: 0, priorImpressions: 0,
      sessions: 0, conversions: 0, priorConversions: 0,
      openTasks: 0, needsApproval: 0, openAlerts: 0, criticalAlerts: 0,
    });

    const taskCounts = tasksLib.counts(userId, selectedId);

    // Open-task severity mix and GA4 channel mix - feed the two donut charts
    // that replace what used to be dead space on the dashboard.
    const brandIds = scope.map((b) => b.id);
    let severityMix = [];
    let channelMix = [];
    if (brandIds.length) {
      const placeholders = brandIds.map(() => '?').join(',');
      severityMix = db.prepare(`SELECT severity, COUNT(*) n FROM tasks
        WHERE brand_id IN (${placeholders}) AND status NOT IN ('done','dismissed')
        GROUP BY severity ORDER BY CASE severity
          WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`)
        .all(...brandIds);
      const anchorRow = db.prepare(`SELECT MAX(date) d FROM ga4_daily WHERE brand_id IN (${placeholders})`).get(...brandIds);
      if (anchorRow && anchorRow.d) {
        const end = anchorRow.d;
        const start = A.windowFrom(end, 28).startDate;
        channelMix = db.prepare(`SELECT channel, SUM(sessions) n FROM ga4_daily
          WHERE brand_id IN (${placeholders}) AND date BETWEEN ? AND ?
          GROUP BY channel HAVING SUM(sessions) > 0 ORDER BY n DESC LIMIT 8`)
          .all(...brandIds, start, end);
      }
    }

    // Combined daily click trend across the brands in scope, so the left
    // column has a real chart instead of trailing off into empty space when
    // there's only one (short) brand card above it.
    let trendSeries = [];
    if (brandIds.length) {
      const placeholders = brandIds.map(() => '?').join(',');
      // Anchored on the newest day actually held, not on "now" - Search
      // Console runs 2-3 days behind and a stale sync pushes that further, so
      // a "-30 days from today" window silently drew a short or empty chart
      // next to cards that were showing data. Same convention as analytics.js.
      const anchorGsc = db.prepare(`SELECT MAX(date) d FROM gsc_daily WHERE brand_id IN (${placeholders})`).get(...brandIds);
      if (anchorGsc && anchorGsc.d) {
        const start = A.windowFrom(anchorGsc.d, 30).startDate;
        trendSeries = db.prepare(`SELECT date, SUM(clicks) clicks, SUM(impressions) impressions
          FROM gsc_daily WHERE brand_id IN (${placeholders}) AND date BETWEEN ? AND ?
          GROUP BY date ORDER BY date`).all(...brandIds, start, anchorGsc.d);
      }
    }

    /* Query and page detail for the main column.
       -----------------------------------------------------------------
       The dashboard used to put every operational panel (approvals, alerts,
       next up) in a narrow rail beside a main column that held only the brand
       cards. Whenever the rail was taller than the cards - which is most of
       the time, since three stacked panels beat two or three short cards -
       the left half of the screen below the cards was simply blank.

       Adding real substance is the right fix rather than narrowing the rail:
       these are the tables an SEO actually opens a dashboard to read, and
       they come from data already synced, so there is no new API call.

       All three are anchored on the newest date actually held rather than on
       today, matching the trend chart above and analytics.js: Search Console
       runs 2-3 days behind and a stale sync pushes that further, so a
       "last 28 days from now" window quietly returns short or empty. */
    let topQueries = [];
    let topPages = [];
    let movers = { up: [], down: [] };

    if (brandIds.length) {
      const ph = brandIds.map(() => '?').join(',');
      const anchorQ = db.prepare(`SELECT MAX(date) d FROM gsc_query_daily WHERE brand_id IN (${ph})`).get(...brandIds);

      if (anchorQ && anchorQ.d) {
        const win = A.comparisonWindows(anchorQ.d, 28);

        const agg = (table, col, w) => db.prepare(
          `SELECT ${col} AS entity,
                  SUM(clicks) clicks,
                  SUM(impressions) impressions,
                  CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) / SUM(impressions) ELSE 0 END ctr,
                  CASE WHEN SUM(impressions) > 0
                       THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END position
             FROM ${table}
            WHERE brand_id IN (${ph}) AND date BETWEEN ? AND ?
            GROUP BY ${col}`
        ).all(...brandIds, w.startDate, w.endDate);

        const recentQ = agg('gsc_query_daily', 'query', win.recent);
        const priorQ = new Map(agg('gsc_query_daily', 'query', win.prior).map((r) => [r.entity, r]));

        topQueries = recentQ
          .slice()
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 8)
          .map((r) => Object.assign({}, r, { priorClicks: (priorQ.get(r.entity) || {}).clicks || 0 }));

        topPages = agg('gsc_page_daily', 'page', win.recent)
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 8);

        /* Biggest movers. Queries under 10 clicks in both windows are dropped:
           2 clicks becoming 6 is a 200% rise and means nothing, and letting
           those to the top is what makes a "movers" table useless. */
        const moved = recentQ
          .map((r) => {
            const before = (priorQ.get(r.entity) || {}).clicks || 0;
            return { entity: r.entity, clicks: r.clicks, priorClicks: before, change: r.clicks - before };
          })
          .filter((r) => Math.max(r.clicks, r.priorClicks) >= 10);

        movers = {
          up: moved.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 5),
          down: moved.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, 5),
        };
      }
    }

    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      pageTitle: 'Dashboard',
      connected,
      brands,
      selectedId,
      cards,
      totals,
      taskCounts,
      recentAlerts: alertEngine.recentEvents(userId, { brandId: selectedId, limit: 8 }),
      urgentTasks: tasksLib.list(userId, { brandId: selectedId, onlyOpen: true, limit: 8 }),
      approvalQueue: db.prepare(`SELECT t.*, b.name brand_name FROM tasks t LEFT JOIN brands b ON b.id=t.brand_id
        WHERE t.user_id=? AND t.requires_approval=1 AND t.approved_at IS NULL
          AND t.status NOT IN ('done','dismissed') ORDER BY t.priority ASC LIMIT 6`).all(userId),
      lastSync: db.prepare('SELECT * FROM sync_runs WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId),
      severityMix, channelMix, trendSeries,
      topQueries, topPages, movers,
    });
  } catch (err) { next(err); }
});

// Manual "run everything now" - sync, then evaluate alerts.
router.post('/refresh', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = db.prepare('SELECT * FROM brands WHERE user_id=? AND active=1').all(userId);
    for (const brand of brands) {
      try { await sync.syncBrand(brand, { days: 30 }); } catch (e) {
        console.error(`[dashboard] sync ${brand.name}: ${e.message}`);
      }
    }
    const results = await alertEngine.runAll({ force: true, userId });
    const fired = results.reduce((a, r) => a + (r.fired || 0), 0);
    res.redirect('/dashboard?msg=' + encodeURIComponent(
      `Refreshed ${brands.length} brand${brands.length === 1 ? '' : 's'} and evaluated all alerts - ${fired} alert${fired === 1 ? '' : 's'} fired.`
    ));
  } catch (err) { next(err); }
});

module.exports = router;
