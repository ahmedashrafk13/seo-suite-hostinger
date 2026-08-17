// Automated weekly SEO report.
//
// One standard report per brand, generated from the consolidated tables so it
// never depends on a live API call at read time. Covers everything in the
// brief: organic traffic, impressions and clicks, average rankings, top gaining
// and declining keywords, top landing pages, conversion performance, technical
// issues, work completed, and what needs doing next week.
//
// The report is stored as JSON (weekly_reports.data_json) and rendered by the
// view layer, so an old report keeps showing the numbers as they were at
// generation time rather than silently changing when data is re-synced.
const db = require('../db');
const A = require('./analytics');
const csvStore = require('./csvStore');
const tasksLib = require('./tasks');
const notify = require('./notify');

function baseUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// The reporting week: Monday–Sunday, defaulting to the most recent complete
// week for which Search Console actually has data.
function weekWindow(anchorIso) {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  // Walk back to the most recent Sunday at or before the anchor.
  const dow = anchor.getUTCDay(); // 0 = Sunday
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() - (dow === 0 ? 0 : dow));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function priorWindow(w) {
  const start = new Date(`${w.startDate}T00:00:00Z`);
  const end = new Date(`${w.endDate}T00:00:00Z`);
  const pEnd = new Date(start); pEnd.setUTCDate(pEnd.getUTCDate() - 1);
  const pStart = new Date(pEnd); pStart.setUTCDate(pStart.getUTCDate() - (Math.round((end - start) / 86400000)));
  return { startDate: isoDate(pStart), endDate: isoDate(pEnd) };
}

function delta(recent, prior) {
  const abs = recent - prior;
  const pctVal = prior === 0 ? (recent === 0 ? 0 : null) : (abs / prior) * 100;
  return { recent, prior, abs, pct: pctVal };
}

// Aggregates an entity table over an explicit window (rather than the
// anchor-relative windows analytics.js provides) so the report can pin itself
// to calendar weeks.
function entityWindow(brandId, table, col, w) {
  return db.prepare(`SELECT ${col} entity,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM ${table} WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY ${col}`).all(brandId, w.startDate, w.endDate);
}

function joinEntities(recentRows, priorRows) {
  const map = new Map();
  recentRows.forEach((r) => map.set(r.entity, { entity: r.entity, r, p: null }));
  priorRows.forEach((p) => {
    if (map.has(p.entity)) map.get(p.entity).p = p;
    else map.set(p.entity, { entity: p.entity, r: null, p });
  });
  return [...map.values()].map((x) => {
    const rc = x.r ? x.r.clicks : 0;
    const pc = x.p ? x.p.clicks : 0;
    const ri = x.r ? x.r.impressions : 0;
    const pi = x.p ? x.p.impressions : 0;
    return {
      entity: x.entity,
      recentClicks: rc, priorClicks: pc, clickDelta: rc - pc,
      recentImpressions: ri, priorImpressions: pi, impressionDelta: ri - pi,
      recentPosition: x.r ? x.r.position : null,
      priorPosition: x.p ? x.p.position : null,
      positionDelta: (x.r && x.p && x.r.position != null && x.p.position != null) ? x.r.position - x.p.position : null,
      recentCtr: ri > 0 ? rc / ri : 0,
      priorCtr: pi > 0 ? pc / pi : 0,
    };
  });
}

// ------------------------------------------------------- full data appendix
//
// The standard report is deliberately an interpretation: headline, movers,
// what to do next. `full: true` additionally attaches every Search Console
// and GA4 dimension the suite syncs, aggregated over the report week, so the
// report can stand alone as the complete data hand-over for a client — no
// "log in and check GSC yourself" step. It is stored in the same data_json
// snapshot, so it stays true to the week it was generated for.
const FULL_LIMITS = { queries: 250, pages: 250, queryPage: 250, countries: 100, cities: 100, sources: 100, events: 100, inspections: 250 };

function gscDimension(brandId, table, col, w, limit) {
  return db.prepare(`SELECT ${col} entity,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(clicks)/NULLIF(SUM(impressions),0) ctr,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM ${table} WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY ${col} ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function ga4Dimension(brandId, table, cols, w, limit, extraCols = '') {
  const select = cols.join(', ');
  return db.prepare(`SELECT ${select},
      SUM(sessions) sessions, SUM(users) users, SUM(conversions) conversions ${extraCols}
    FROM ${table} WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY ${select} ORDER BY SUM(sessions) DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, limit);
}

function buildFullData(brand, w) {
  const L = FULL_LIMITS;
  const queryPage = A.queryPagePairs(brand.id, { limit: L.queryPage });
  const indexing = A.indexingSummary(brand.id);

  return {
    window: w,
    gsc: {
      totals: A.gscWindow(brand.id, w),
      daily: db.prepare(`SELECT date, clicks, impressions, ctr, position FROM gsc_daily
        WHERE brand_id=? AND date BETWEEN ? AND ? ORDER BY date`).all(brand.id, w.startDate, w.endDate),
      queries: gscDimension(brand.id, 'gsc_query_daily', 'query', w, L.queries),
      pages: gscDimension(brand.id, 'gsc_page_daily', 'page', w, L.pages),
      countries: gscDimension(brand.id, 'gsc_country_daily', 'country', w, L.countries),
      devices: gscDimension(brand.id, 'gsc_device_daily', 'device', w, 10),
      appearance: gscDimension(brand.id, 'gsc_appearance_daily', 'appearance', w, 25),
      sitemaps: A.gscSitemaps(brand.id),
      // query × page is a whole-sync-window snapshot, not a daily table, so it
      // cannot be clipped to the report week — labelled as such in the view.
      queryPagePeriod: queryPage.period,
      queryPage: queryPage.rows,
      indexing: {
        totals: indexing.totals,
        reasons: indexing.reasons,
        rows: db.prepare(`SELECT url, verdict, coverage_state, robots_txt_state, indexing_state,
            page_fetch_state, google_canonical, user_canonical, last_crawl_time, checked_at, error
          FROM url_inspections WHERE brand_id=? ORDER BY (verdict='PASS') ASC, checked_at DESC LIMIT ?`)
          .all(brand.id, L.inspections),
      },
    },
    ga4: {
      totalsOrganic: A.ga4Window(brand.id, w, 'Organic Search'),
      daily: db.prepare(`SELECT date, channel, sessions, users, engaged_sessions, conversions, bounce_rate, avg_duration
        FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ? ORDER BY date, channel`)
        .all(brand.id, w.startDate, w.endDate),
      channels: db.prepare(`SELECT channel,
          SUM(sessions) sessions, SUM(users) users, SUM(engaged_sessions) engaged_sessions,
          SUM(conversions) conversions,
          SUM(bounce_rate*sessions)/NULLIF(SUM(sessions),0) bounce_rate,
          SUM(avg_duration*sessions)/NULLIF(SUM(sessions),0) avg_duration
        FROM ga4_daily WHERE brand_id=? AND date BETWEEN ? AND ?
        GROUP BY channel ORDER BY SUM(sessions) DESC`).all(brand.id, w.startDate, w.endDate),
      landingPages: ga4Dimension(brand.id, 'ga4_page_daily', ['page_path'], w, L.pages),
      devices: ga4Dimension(brand.id, 'ga4_device_daily', ['device_category'], w, 10),
      browsers: ga4Dimension(brand.id, 'ga4_device_daily', ['browser'], w, 25),
      countries: ga4Dimension(brand.id, 'ga4_geo_daily', ['country'], w, L.countries),
      cities: ga4Dimension(brand.id, 'ga4_geo_daily', ['country', 'city'], w, L.cities),
      acquisition: db.prepare(`SELECT source, medium,
          SUM(sessions) sessions, SUM(users) users, SUM(new_users) new_users, SUM(conversions) conversions
        FROM ga4_acquisition_daily WHERE brand_id=? AND date BETWEEN ? AND ?
        GROUP BY source, medium ORDER BY SUM(sessions) DESC LIMIT ?`)
        .all(brand.id, w.startDate, w.endDate, L.sources),
      events: db.prepare(`SELECT event_name,
          SUM(event_count) event_count, SUM(total_users) total_users, SUM(event_value) event_value
        FROM ga4_event_daily WHERE brand_id=? AND date BETWEEN ? AND ?
        GROUP BY event_name ORDER BY SUM(event_count) DESC LIMIT ?`)
        .all(brand.id, w.startDate, w.endDate, L.events),
    },
    site: {
      psi: db.prepare(`SELECT url, strategy, captured_at, perf_score, lcp, inp, cls, fcp, ttfb, source, error
        FROM psi_snapshots WHERE brand_id=? ORDER BY id DESC LIMIT 20`).all(brand.id),
      uptime: db.prepare(`SELECT checked_at, url, status_code, ok, response_ms, error
        FROM uptime_checks WHERE brand_id=? ORDER BY id DESC LIMIT 50`).all(brand.id),
    },
    limits: L,
  };
}

function build(brand, { weekEnd = null, full = false } = {}) {
  const anchor = weekEnd || A.latestGscDate(brand.id) || isoDate(new Date());
  const w = weekWindow(anchor);
  const p = priorWindow(w);

  // ------------------------------------------------- search performance
  const gscR = A.gscWindow(brand.id, w);
  const gscP = A.gscWindow(brand.id, p);

  const search = {
    clicks: delta(gscR.clicks, gscP.clicks),
    impressions: delta(gscR.impressions, gscP.impressions),
    ctr: delta(gscR.ctr * 100, gscP.ctr * 100),
    // Position improves as it gets smaller, so the sign is inverted for display.
    position: { recent: gscR.position, prior: gscP.position, abs: gscR.position - gscP.position, improved: gscR.position < gscP.position },
    hasData: gscR.days > 0,
    daysWithData: gscR.days,
  };

  // --------------------------------------------------- GA4 / conversions
  const gaR = A.ga4Window(brand.id, w);
  const gaP = A.ga4Window(brand.id, p);
  const analytics = {
    hasData: gaR.days > 0,
    sessions: delta(gaR.sessions, gaP.sessions),
    users: delta(gaR.users, gaP.users),
    conversions: delta(gaR.conversions, gaP.conversions),
    convRate: delta(gaR.conv_rate * 100, gaP.conv_rate * 100),
    engagementRate: delta(gaR.engagement_rate * 100, gaP.engagement_rate * 100),
  };

  // ------------------------------------------------------- keyword moves
  const queries = joinEntities(
    entityWindow(brand.id, 'gsc_query_daily', 'query', w),
    entityWindow(brand.id, 'gsc_query_daily', 'query', p)
  );

  const gainers = queries
    .filter((q) => q.clickDelta > 0)
    .sort((a, b) => b.clickDelta - a.clickDelta).slice(0, 10);
  const decliners = queries
    .filter((q) => q.clickDelta < 0)
    .sort((a, b) => a.clickDelta - b.clickDelta).slice(0, 10);

  // When a week has almost no clicks, click deltas are meaningless — fall back
  // to impression movement so the report still says something useful.
  const impressionGainers = queries
    .filter((q) => q.impressionDelta > 0)
    .sort((a, b) => b.impressionDelta - a.impressionDelta).slice(0, 10);
  const impressionDecliners = queries
    .filter((q) => q.impressionDelta < 0)
    .sort((a, b) => a.impressionDelta - b.impressionDelta).slice(0, 10);

  const rankImprovers = queries
    .filter((q) => q.positionDelta != null && q.positionDelta < -1 && q.priorImpressions >= 20)
    .sort((a, b) => a.positionDelta - b.positionDelta).slice(0, 10);
  const rankLosers = queries
    .filter((q) => q.positionDelta != null && q.positionDelta > 1 && q.priorImpressions >= 20)
    .sort((a, b) => b.positionDelta - a.positionDelta).slice(0, 10);

  // --------------------------------------------------- landing pages
  const pages = joinEntities(
    entityWindow(brand.id, 'gsc_page_daily', 'page', w),
    entityWindow(brand.id, 'gsc_page_daily', 'page', p)
  );
  const topLanding = [...pages]
    .sort((a, b) => (b.recentClicks - a.recentClicks) || (b.recentImpressions - a.recentImpressions))
    .slice(0, 15);
  const pageGainers = pages.filter((x) => x.clickDelta > 0).sort((a, b) => b.clickDelta - a.clickDelta).slice(0, 10);
  const pageDecliners = pages.filter((x) => x.clickDelta < 0).sort((a, b) => a.clickDelta - b.clickDelta).slice(0, 10);

  // GA4 landing pages by conversions, so the report can name what actually pays.
  const convertingPages = db.prepare(`SELECT page_path entity,
      SUM(sessions) sessions, SUM(conversions) conversions
    FROM ga4_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY page_path HAVING SUM(sessions) > 0
    ORDER BY SUM(conversions) DESC, SUM(sessions) DESC LIMIT 10`)
    .all(brand.id, w.startDate, w.endDate);

  // ------------------------------------------------------ daily series
  const series = db.prepare(`SELECT date, clicks, impressions, ctr, position
    FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(brand.id, w.startDate, w.endDate);
  const ga4SeriesRows = db.prepare(`SELECT date, sessions, conversions FROM ga4_daily
    WHERE brand_id=? AND date BETWEEN ? AND ? AND channel='Organic Search' ORDER BY date`)
    .all(brand.id, w.startDate, w.endDate);

  // ------------------------------------------------- technical issues
  const latestAudit = db.prepare(`SELECT * FROM audit_runs WHERE brand_id=? AND status='completed'
    AND json_result IS NOT NULL ORDER BY id DESC LIMIT 1`).get(brand.id);
  let technical = null;
  if (latestAudit) {
    const norm = csvStore.normaliseAuditFindings(latestAudit.json_result);
    if (norm) {
      technical = {
        runId: latestAudit.id,
        crawledAt: latestAudit.created_at,
        health: norm.health,
        pagesCrawled: norm.pagesCrawled,
        bySeverity: norm.bySeverity,
        totalIssueInstances: norm.totalIssueInstances,
        top: norm.failing.slice(0, 12).map((f) => ({
          issue: f.issue, severity: f.severity, failed: f.failed, unit: f.unit, action: f.action,
        })),
      };
    }
  }

  const latestLinking = db.prepare(`SELECT * FROM linking_runs WHERE brand_id=? AND status='completed'
    ORDER BY id DESC LIMIT 1`).get(brand.id);
  let linking = null;
  if (latestLinking) {
    let s = null;
    try { s = JSON.parse(latestLinking.json_result || '{}').summary || null; } catch { s = null; }
    linking = {
      runId: latestLinking.id,
      crawledAt: latestLinking.created_at,
      pagesCrawled: s ? s.pages_crawled : null,
      orphanPages: s ? s.orphan_pages : null,
      underlinkedPages: s ? s.underlinked_pages : null,
      editorialLinks: s ? s.editorial_internal_links : null,
      cannibalizationPairs: s ? s.cannibalization_pairs : null,
      recommendationCount: s ? s.recommendations : null,
    };
  }

  // -------------------------------------------------- Core Web Vitals
  const cwv = {};
  ['mobile', 'desktop'].forEach((strategy) => {
    const snaps = A.latestCwv(brand.id, strategy);
    if (snaps.length) {
      cwv[strategy] = {
        capturedAt: snaps[0].captured_at, score: snaps[0].perf_score,
        lcp: snaps[0].lcp, inp: snaps[0].inp, cls: snaps[0].cls,
        source: snaps[0].source,
        previousScore: snaps[1] ? snaps[1].perf_score : null,
      };
    }
  });

  // ------------------------------------------------ alerts in the week
  const alerts = db.prepare(`SELECT alert_key, severity, title, created_at FROM alert_events
    WHERE brand_id=? AND date(created_at) BETWEEN ? AND ? ORDER BY
      CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END
    LIMIT 30`).all(brand.id, w.startDate, w.endDate);

  // ------------------------------------------ work completed & upcoming
  const completed = db.prepare(`SELECT id, title, source, severity, assignee, completed_at, completion_note
    FROM tasks WHERE brand_id=? AND status='done' AND date(completed_at) BETWEEN ? AND ?
    ORDER BY completed_at DESC LIMIT 40`).all(brand.id, w.startDate, w.endDate);

  const openTasks = db.prepare(`SELECT id, title, source, severity, priority, status, assignee, due_date,
      requires_approval, approved_at
    FROM tasks WHERE brand_id=? AND status IN ('backlog','in_progress','awaiting_approval','blocked')
    ORDER BY priority ASC, updated_at DESC LIMIT 40`).all(brand.id);

  const nextActions = openTasks.slice(0, 12);
  const awaitingApproval = openTasks.filter((t) => t.requires_approval && !t.approved_at);

  const taskCounts = tasksLib.counts(brand.user_id, brand.id);

  // --------------------------------------------------------- headline
  // A short written summary, so the report leads with an interpretation
  // rather than making the reader derive one from twelve tables.
  const headline = [];
  if (!search.hasData) {
    headline.push('No Search Console data is available for this week — check the brand\'s connection and sync status before reading anything else here.');
  } else {
    const cd = search.clicks;
    const move = cd.abs === 0
      ? 'unchanged'
      : `${cd.abs > 0 ? 'up' : 'down'}${cd.pct == null ? '' : ` ${Math.abs(cd.pct).toFixed(1)}%`}`;
    headline.push(`Organic clicks were ${Math.round(cd.recent).toLocaleString('en-US')} this week, ${move} against ${Math.round(cd.prior).toLocaleString('en-US')} the week before.`);
    if (search.impressions.abs !== 0) {
      headline.push(`Impressions ${search.impressions.abs > 0 ? 'rose' : 'fell'} to ${Math.round(search.impressions.recent).toLocaleString('en-US')}${search.impressions.pct == null ? '' : ` (${search.impressions.pct > 0 ? '+' : ''}${search.impressions.pct.toFixed(1)}%)`}.`);
    }
    if (search.position.recent) {
      headline.push(`Average position ${search.position.improved ? 'improved' : 'worsened'} to ${search.position.recent.toFixed(1)}.`);
    }
    if (cd.abs < 0 && search.impressions.abs >= 0) {
      headline.push('Impressions held while clicks fell, which points at CTR or a SERP-layout change rather than lost rankings.');
    }
  }
  if (analytics.hasData && analytics.conversions.prior > 0) {
    headline.push(`Organic conversions were ${Math.round(analytics.conversions.recent)} (${analytics.conversions.abs >= 0 ? '+' : ''}${analytics.conversions.abs.toFixed(0)} vs prior week).`);
  }
  if (technical && technical.bySeverity) {
    const crit = (technical.bySeverity.critical || 0) + (technical.bySeverity.high || 0);
    if (crit) headline.push(`${crit} high-or-critical technical check${crit === 1 ? '' : 's'} currently failing.`);
  }
  if (completed.length) headline.push(`${completed.length} task${completed.length === 1 ? '' : 's'} completed this week.`);
  if (awaitingApproval.length) headline.push(`${awaitingApproval.length} task${awaitingApproval.length === 1 ? '' : 's'} awaiting SEO approval.`);

  return {
    brand: { id: brand.id, name: brand.name, site_url: brand.site_url, gsc: brand.gsc_property, ga4: brand.ga4_property_name },
    period: w,
    priorPeriod: p,
    generatedAt: new Date().toISOString(),
    headline,
    search,
    analytics,
    series,
    ga4Series: ga4SeriesRows,
    keywords: {
      gainers, decliners, impressionGainers, impressionDecliners,
      rankImprovers, rankLosers,
      totalTracked: queries.length,
      useImpressionFallback: gainers.length === 0 && decliners.length === 0,
    },
    pages: { topLanding, gainers: pageGainers, decliners: pageDecliners, convertingPages },
    technical,
    linking,
    cwv,
    alerts,
    work: { completed, open: openTasks, nextActions, awaitingApproval, counts: taskCounts },
    full: full ? buildFullData(brand, w) : null,
  };
}

// Generates and stores a report, replacing any existing one for that week.
function generate(brand, { weekEnd = null, full = false } = {}) {
  const data = build(brand, { weekEnd, full });
  db.prepare(`INSERT INTO weekly_reports (user_id, brand_id, period_start, period_end, data_json)
    VALUES (?,?,?,?,?)
    ON CONFLICT(brand_id, period_start, period_end) DO UPDATE SET
      data_json=excluded.data_json, generated_at=datetime('now')`)
    .run(brand.user_id, brand.id, data.period.startDate, data.period.endDate, JSON.stringify(data));
  return db.prepare('SELECT * FROM weekly_reports WHERE brand_id=? AND period_start=? AND period_end=?')
    .get(brand.id, data.period.startDate, data.period.endDate);
}

// Scheduled runs can include the full data appendix by setting
// REPORT_INCLUDE_FULL_DATA=1, so an agency that always hands over the raw
// numbers does not have to regenerate every Monday's report by hand.
function scheduledFullData() {
  return process.env.REPORT_INCLUDE_FULL_DATA === '1';
}

async function generateAllWeekly({ full = scheduledFullData() } = {}) {
  const brands = db.prepare('SELECT * FROM brands WHERE active=1').all();
  const out = [];
  for (const brand of brands) {
    try {
      const row = generate(brand, { full });
      out.push({ brand: brand.name, reportId: row.id, period: `${row.period_start} → ${row.period_end}` });
    } catch (err) {
      console.error(`[reports] ${brand.name} failed: ${err.message}`);
      out.push({ brand: brand.name, error: err.message });
    }
  }
  return out;
}

// Generates every brand's weekly report and emails it to the brand's
// notify_email, falling back to the owning user's signup email — so a new
// user who never set a per-brand notification address still gets their
// weekly report at the address they signed up with.
async function generateAndSendAllWeekly({ full = scheduledFullData() } = {}) {
  const brands = db.prepare('SELECT * FROM brands WHERE active=1').all();
  const out = [];
  for (const brand of brands) {
    try {
      const row = generate(brand, { full });
      const data = JSON.parse(row.data_json);
      const user = db.prepare('SELECT email FROM users WHERE id=?').get(brand.user_id);
      const recipient = brand.notify_email || (user && user.email);
      let mail = { sent: false, reason: 'no recipient' };
      if (recipient) {
        mail = await notify.sendWeeklyReport(recipient, data, `${baseUrl()}/reports/${row.id}`);
      }
      out.push({
        brand: brand.name, reportId: row.id, period: `${row.period_start} → ${row.period_end}`,
        emailed: mail.sent, recipient: recipient || null, reason: mail.sent ? undefined : mail.reason,
      });
    } catch (err) {
      console.error(`[reports] ${brand.name} failed: ${err.message}`);
      out.push({ brand: brand.name, error: err.message });
    }
  }
  return out;
}

function get(id, userId) {
  const row = db.prepare(`SELECT r.*, b.name brand_name, b.site_url
    FROM weekly_reports r JOIN brands b ON b.id=r.brand_id
    WHERE r.id=? AND r.user_id=?`).get(id, userId);
  if (!row) return null;
  try { row.data = JSON.parse(row.data_json); } catch { row.data = null; }
  return row;
}

function list(userId, brandId) {
  const where = brandId ? 'AND r.brand_id=?' : '';
  const args = brandId ? [userId, brandId] : [userId];
  return db.prepare(`SELECT r.id, r.period_start, r.period_end, r.generated_at,
      b.name brand_name, b.id brand_id
    FROM weekly_reports r JOIN brands b ON b.id=r.brand_id
    WHERE r.user_id=? ${where} ORDER BY r.period_end DESC, b.name LIMIT 100`).all(...args);
}

module.exports = {
  build, generate, generateAllWeekly, generateAndSendAllWeekly, get, list, weekWindow, priorWindow,
};
