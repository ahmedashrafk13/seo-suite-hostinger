// THE TRACKING ENGINE
//
// Runs the checks in ./trackingCatalog.js against a brand, stores every metric
// as a point in a time series, and turns the failures into findings.
//
// THE SAMPLE, AND WHY IT IS CHOSEN THIS WAY
// A page-scoped check cannot run on every URL — a 5,000-page site would take
// hours and would exhaust the PageSpeed quota on the first run. The sample is
// therefore built deliberately, in this order:
//
//   1. The homepage. Always. It is the page most likely to be a template for
//      everything else, and the one an AI engine reaches first.
//   2. The pages with the most Search Console impressions. These are where a
//      problem costs the most, so they are checked whether or not they are
//      representative.
//   3. One page per distinct URL section from the sitemap. This is the part
//      that makes the sample REPRESENTATIVE rather than merely important: a
//      templating fault usually affects one section, and a sample drawn only
//      from top pages would miss a broken section entirely because it has no
//      traffic yet.
//
// The composition is recorded on the run and shown in the UI, so nobody reads
// "3 pages have no H1" as "3 pages on the whole site have no H1".
//
// SITEWIDE SCOPE
// A sample answers "is there a problem"; it cannot answer "which pages". Two of
// the requested items — a list of 4xx pages, and sitewide tracking rather than
// sampled — need the whole URL set, so the sweep now runs in one of two scopes:
//
//   'sample'   the deliberate 12-URL sample described above. Default. Every
//              check runs, including the expensive ones (PageSpeed, TLS).
//   'sitewide' the same checks PLUS the full URL set — the union of the sitemap
//              and a link crawl — made available to the checks that can absorb
//              the volume. A check declares `sitewideCapable: true` to receive
//              it; the rest keep the sample, because running PageSpeed against
//              4,000 URLs would exhaust the daily quota on the first brand.
//
// The scope is recorded on the run and rendered beside every count, because
// "17 pages return 404" means something different in each one.
//
// SEQUENTIAL EXECUTION
// Checks run one after another, not in parallel. They hit the same origin, the
// same PageSpeed quota and the same small memory allowance on shared hosting;
// running fourteen concurrently is how a sweep gets rate-limited into
// returning "unknown" for half the board.
const db = require('../../db');
const store = require('./store');
const providers = require('./providers');
const catalog = require('./trackingCatalog');
const analytics = require('../analytics');
const {
  fetchRobots, fetchSitemapUrls, normalizeUrl, canonUrl,
} = require('./fetcher');

// Builds the sample. `size` is a target, not a guarantee — a small site
// legitimately produces a smaller one.
async function buildSample(brand, { size = 12, sitewide = false, sitewideCap = 3000 } = {}) {
  const site = normalizeUrl(brand.site_url);
  const picked = [];
  const seen = new Set();
  const composition = { homepage: 0, byTraffic: 0, bySection: 0 };

  const push = (url, bucket) => {
    if (!url) return false;
    const key = canonUrl(url);
    if (seen.has(key)) return false;
    seen.add(key);
    picked.push(url);
    composition[bucket] += 1;
    return true;
  };

  push(site, 'homepage');

  // Highest-impression pages.
  const anchor = analytics.latestGscDate(brand.id);
  let trafficPages = [];
  if (anchor) {
    const w = analytics.windowFrom(anchor, 28);
    trafficPages = db.prepare(`SELECT page, SUM(impressions) impressions FROM gsc_page_daily
      WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY page ORDER BY SUM(impressions) DESC LIMIT 40`).all(brand.id, w.startDate, w.endDate);
    const budget = Math.max(2, Math.floor(size * 0.5));
    for (const p of trafficPages) {
      if (composition.byTraffic >= budget) break;
      push(p.page, 'byTraffic');
    }
  }

  // One per sitemap section, to make the sample cover the site's shape.
  let sitemapInfo = { urls: [], sources: [] };
  try {
    const robots = await fetchRobots(site);
    sitemapInfo = await fetchSitemapUrls(site, { limit: 2000, robots });
  } catch { /* a missing sitemap is reported by its own check */ }

  if (sitemapInfo.urls.length) {
    const bySection = new Map();
    sitemapInfo.urls.forEach((u) => {
      let section = '(root)';
      try { section = new URL(u.loc).pathname.split('/').filter(Boolean)[0] || '(root)'; } catch { return; }
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(u.loc);
    });
    // Largest sections first — a section with 400 pages matters more than one
    // with two.
    const sections = [...bySection.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [, urls] of sections) {
      if (picked.length >= size) break;
      push(urls[0], 'bySection');
    }
  }

  // The full URL set, for sitewide scope. The union of the sitemap and the
  // pages the traffic data names, deduplicated — a link crawl is added by the
  // check that needs it, since only the broken-page check follows links and
  // paying for a crawl the other checks ignore would double every sweep.
  let allUrls = null;
  if (sitewide) {
    const seenAll = new Set();
    allUrls = [];
    const pushAll = (u, origin_) => {
      if (!u) return;
      const key = canonUrl(u);
      if (seenAll.has(key)) return;
      seenAll.add(key);
      allUrls.push({ url: u, from: origin_ });
    };
    pushAll(site, 'homepage');
    sitemapInfo.urls.forEach((u) => pushAll(u.loc, 'sitemap'));
    trafficPages.forEach((tp) => pushAll(tp.page, 'search-console'));
    allUrls = allUrls.slice(0, sitewideCap);
  }

  return {
    urls: picked.slice(0, size),
    scope: sitewide ? 'sitewide' : 'sample',
    allUrls,
    allUrlsBasis: sitewide
      ? `${allUrls.length.toLocaleString('en-US')} URL${allUrls.length === 1 ? '' : 's'}: the homepage, every URL in the sitemap (${sitemapInfo.urls.length.toLocaleString('en-US')}), and every page Search Console reports traffic for (${trafficPages.length}), deduplicated${allUrls.length >= sitewideCap ? ` and capped at ${sitewideCap}` : ''}`
      : null,
    composition,
    basis: [
      composition.homepage ? 'the homepage' : null,
      composition.byTraffic ? `${composition.byTraffic} highest-impression page${composition.byTraffic === 1 ? '' : 's'} from Search Console` : null,
      composition.bySection ? `${composition.bySection} page${composition.bySection === 1 ? '' : 's'} sampled one per sitemap section` : null,
    ].filter(Boolean).join(', '),
    sitemapUrlsSeen: sitemapInfo.urls.length,
    trafficPagesSeen: trafficPages.length,
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, only = null, sampleSize = 12,
  scope = 'sample', sitewideCap = 3000,
}) {
  const brandId = brand.id;
  const site = normalizeUrl(brand.site_url);
  let origin = site;
  try { origin = new URL(site).origin; } catch { /* keep */ }

  const selected = only
    ? catalog.all().filter((c) => (Array.isArray(only) ? only.includes(c.key) : c.key === only))
    : catalog.all();
  if (!selected.length) throw new Error(only ? `unknown tracking check "${only}"` : 'no checks defined');

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'tracking', target: site,
    label: `${only ? (Array.isArray(only) ? only.join(', ') : only) : 'full sweep'}${scope === 'sitewide' ? ' — sitewide' : ''}`,
    params: { only, sampleSize, scope, sitewideCap },
  });

  try {
    const sitewide = scope === 'sitewide';
    const sample = await buildSample(brand, { size: sampleSize, sitewide, sitewideCap });
    const ctx = {
      userId, brand, brandId, site, origin,
      sample: sample.urls,
      // Present only in sitewide scope. A check must test for it rather than
      // assume it, and only checks declaring sitewideCapable receive it — see
      // the loop below.
      scope,
      allUrls: sample.allUrls,
      // A check reads its own previous capture through this, so "did it change"
      // is answerable without every check re-implementing the lookup.
      previousMetric: (metricKey, url = '') => store.previousMetric(brandId, metricKey, url),
    };

    const results = [];
    const allMetrics = [];
    const allFindings = [];
    const sourcesUsed = new Set(['crawler']);

    for (const check of selected) {
      const missing = (check.needs || []).filter((n) => !providers.has(n));
      if (missing.length) {
        results.push({
          key: check.key, element: check.element, group: check.group,
          status: 'unavailable',
          reason: `needs ${missing.map((m) => (providers.get(m) || {}).label || m).join(', ')}`,
          metrics: [], findings: [],
        });
        continue;
      }

      const started = Date.now();
      let outcome;
      // A check only sees the full URL set if it declared it can handle one.
      // Without this gate, adding sitewide scope would silently hand 3,000 URLs
      // to the PageSpeed check and burn the daily quota on one brand.
      const checkCtx = (sitewide && check.sitewideCapable)
        ? ctx
        : { ...ctx, allUrls: null, scope: 'sample' };
      try {
        /* eslint-disable no-await-in-loop */
        outcome = await check.run(checkCtx);
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        // One check failing must not abandon the sweep. A network blip on the
        // image check should not cost the canonical check its result.
        results.push({
          key: check.key, element: check.element, group: check.group,
          status: 'error',
          reason: String((err && err.message) || err).slice(0, 300),
          ms: Date.now() - started,
          metrics: [], findings: [],
        });
        continue;
      }

      if (!outcome || outcome.unknown) {
        results.push({
          key: check.key, element: check.element, group: check.group,
          status: 'unknown',
          reason: (outcome && outcome.unknown) || 'the check returned nothing',
          ms: Date.now() - started,
          metrics: [], findings: [],
        });
        continue;
      }

      (check.needs || []).forEach((n) => sourcesUsed.add(n));
      const metrics = outcome.metrics || [];
      const findings = (outcome.findings || []).map((f) => ({
        ...f,
        // Namespaced so a finding key is unique across the whole catalog, and
        // stable across runs so the task bridge dedupes correctly.
        checkKey: `${check.key}.${f.checkKey}`,
        dedupeKey: `tracking:${check.key}:${f.checkKey}:${f.affectedUrl || brandId}`,
      }));

      // The check's own headline verdict: the worst MEASURED status among its
      // metrics.
      //
      // Unknown metrics are excluded from that comparison rather than ranked
      // between warn and good. Ranking them made a check whose schema coverage
      // was 100% with zero errors report as 'unknown', purely because one of
      // its three metrics — rich-result eligibility, which needs URL Inspection
      // data the nightly sync had not collected yet — had nothing to read. A
      // check is only 'unknown' when it measured NOTHING; if it measured
      // anything at all, its verdict comes from what it measured.
      const rank = { fail: 0, warn: 1, good: 2 };
      const measurable = metrics.filter((m) => m.status && m.status !== 'unknown');
      const worst = measurable.reduce((acc, m) => {
        const r = rank[m.status] == null ? 1 : rank[m.status];
        return r < acc.r ? { r, status: m.status } : acc;
      }, { r: 9, status: 'good' });
      const headline = measurable.length
        ? worst.status
        : (metrics.length ? 'unknown' : 'good');

      allMetrics.push(...metrics);
      allFindings.push(...findings);
      results.push({
        key: check.key, element: check.element, group: check.group,
        whatItTracks: check.whatItTracks, whyItMatters: check.whyItMatters,
        scope: check.scope,
        // Which URL set this check actually ran against, so a count on the board
        // is never read against the wrong denominator.
        ranAgainst: (sitewide && check.sitewideCapable) ? 'sitewide' : 'sample',
        sitewideCapable: Boolean(check.sitewideCapable),
        status: headline,
        ms: Date.now() - started,
        metrics,
        findings,
        detail: outcome.detail || null,
      });
    }

    // Board score: the share of measured metrics in a good state. Metrics that
    // could not be measured are excluded from BOTH sides of the ratio — a site
    // with no CrUX data must not score badly for it, and must not score well
    // for it either.
    const measured = allMetrics.filter((m) => m.status && m.status !== 'unknown');
    const good = measured.filter((m) => m.status === 'good').length;
    const score = measured.length ? Math.round((good / measured.length) * 100) : null;

    const byGroup = catalog.GROUP_ORDER.map((group) => {
      const items = results.filter((r) => r.group === group);
      if (!items.length) return null;
      const worst = items.reduce((acc, r) => {
        const rank = { fail: 0, warn: 1, error: 1, unknown: 2, unavailable: 3, good: 4 };
        const v = rank[r.status] == null ? 2 : rank[r.status];
        return v < acc.v ? { v, status: r.status } : acc;
      }, { v: 9, status: 'good' });
      return { group, status: worst.status, checks: items.length, failing: items.filter((r) => r.status === 'fail').length };
    }).filter(Boolean);

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site,
        sample,
        scope,
        scopeNote: sitewide
          ? `Sitewide scope. ${results.filter((r) => r.ranAgainst === 'sitewide').length} of ${results.length} checks ran against the full URL set (${sample.allUrlsBasis}); the rest ran against the ${sample.urls.length}-URL sample because they call a rate-limited or quota-limited API. Each check says which it used.`
          : `Sampled scope. Every check ran against the same ${sample.urls.length}-URL sample: ${sample.basis}. A count here is a count within that sample, not a sitewide total — switch to sitewide scope for a full list of affected URLs.`,
        checks: results,
        byGroup,
        counts: {
          total: results.length,
          good: results.filter((r) => r.status === 'good').length,
          warn: results.filter((r) => r.status === 'warn').length,
          fail: results.filter((r) => r.status === 'fail').length,
          unknown: results.filter((r) => r.status === 'unknown').length,
          unavailable: results.filter((r) => r.status === 'unavailable').length,
          error: results.filter((r) => r.status === 'error').length,
          metricsMeasured: measured.length,
        },
        provenance: providers.provenance([...sourcesUsed]),
      },
      findings: allFindings,
      metrics: allMetrics,
      sources: [...sourcesUsed],
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// Every brand with a site URL, for the scheduled sweep. Brands are swept one
// at a time by the caller.
function brandsToSweep({ limit = 50 } = {}) {
  return db.prepare(`SELECT b.*, u.id owner_id FROM brands b
    JOIN users u ON u.id = b.user_id
    WHERE b.active=1 AND b.site_url IS NOT NULL AND b.site_url != ''
    ORDER BY b.id LIMIT ?`).all(limit);
}

// The board view: the latest sweep per brand, plus the metric series behind it.
function board({ userId, brandId = null }) {
  const runs = store.listRuns({ userId, kind: 'tracking', brandId, limit: 30 });
  const latest = brandId
    ? store.latestRun({ userId, kind: 'tracking', brandId })
    : null;
  return {
    runs,
    latest,
    previous: latest ? store.previousRun(latest) : null,
    availability: catalog.availability(),
    grouped: catalog.grouped(),
    metrics: brandId ? store.latestMetrics(brandId) : [],
  };
}

// One metric's history, for a sparkline or a table.
function series(brandId, metricKey, { url = '', limit = 60 } = {}) {
  return store.metricSeries(brandId, metricKey, { url, limit });
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}${f.affected_url ? `\n\nURL: ${f.affected_url}` : ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:tracking:${run.id}:${f.check_key}`,
      category: 'SEO tracking',
      severity: f.severity,
      affectedUrl: f.affected_url || null,
      evidence: f.evidence,
      dedupeKey: f.dedupe_key || `aiseo:tracking:${f.check_key}:${run.brand_id || 0}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = { run, toTasks, buildSample, brandsToSweep, board, series, catalog };
