// 8. CONTENT FRESHNESS AND INTENT-DRIFT DETECTION
//
// Two related questions, both answered from Search Console history the app
// already holds.
//
// FRESHNESS is the easy one: which pages have not been touched in a long time
// AND are losing ground. The second clause is what makes it useful. A list of
// "pages not updated in 12 months" on any real site is most of the site, and
// updating a page that is performing fine is how a team spends a quarter
// achieving nothing. What matters is decay: a page whose impressions or
// position are sliding while the site as a whole is not.
//
// INTENT DRIFT is the harder and more valuable one: the topic did not change,
// but what people want from it did. A guide that ranked for "what is X" now
// gets impressions for "X vs Y" and "X pricing" — the page is still about the
// right subject and is now answering the wrong question. Traffic often falls
// slowly enough that nothing triggers an alert, and the page reads perfectly
// well on inspection, so this is close to undetectable by hand.
//
// HOW DRIFT IS MEASURED
// Jensen-Shannon divergence between the impression-weighted query distribution
// of two windows. Three alternatives were considered and rejected:
//
//   Comparing the top-10 query lists. Misses drift that starts below the top
//   10, which is where it always starts.
//
//   KL divergence. Undefined when a query appears in one window and not the
//   other — which is exactly what drift produces, so it is undefined precisely
//   when it is needed.
//
//   Comparing intent labels only. Too coarse. A page can shift substantially
//   inside "Informational" and the label never moves.
//
// JSD is symmetric, always finite, and bounded at 1 bit, so one threshold
// means the same thing on every brand and every page. The intent-label mix is
// computed as well, and reported alongside — it explains a divergence number
// in language a human can act on.
const db = require('../../db');
const nlp = require('./nlp');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const analytics = require('../analytics');
const seoSignals = require('../seoSignals');
const {
  fetchSitemapUrls, fetchRobots, fetchPage, parseDocument, normalizeUrl, canonUrl, mapLimit,
} = require('./fetcher');

// The impression-weighted query distribution for one page over one window.
function queryDistribution(brandId, page, window) {
  const rows = db.prepare(`SELECT query, SUM(impressions) impressions, SUM(clicks) clicks,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_query_page
    WHERE brand_id=? AND page=? AND period_start>=? AND period_end<=?
    GROUP BY query HAVING SUM(impressions) > 0`)
    .all(brandId, page, window.startDate, window.endDate);
  const map = new Map();
  rows.forEach((r) => map.set(String(r.query).toLowerCase(), Number(r.impressions) || 0));
  return { map, rows };
}

// gsc_query_page holds periodic snapshots rather than daily rows, so drift
// compares the two most recent DISTINCT snapshot periods for the brand. Using
// date windows against a snapshot table would silently compare a period
// against itself whenever only one snapshot fell inside the window — and would
// then report zero drift on every page, which reads as "nothing to do".
function snapshotPeriods(brandId, { limit = 2 } = {}) {
  return db.prepare(`SELECT DISTINCT period_start, period_end FROM gsc_query_page
    WHERE brand_id=? ORDER BY period_end DESC LIMIT ?`).all(brandId, limit)
    .map((p) => ({ startDate: p.period_start, endDate: p.period_end }));
}

function distributionForPeriod(brandId, page, period) {
  const rows = db.prepare(`SELECT query, impressions, clicks, position FROM gsc_query_page
    WHERE brand_id=? AND page=? AND period_start=? AND period_end=?`)
    .all(brandId, page, period.startDate, period.endDate);
  const map = new Map();
  rows.forEach((r) => {
    const imp = Number(r.impressions) || 0;
    if (imp > 0) map.set(String(r.query).toLowerCase(), imp);
  });
  return { map, rows };
}

// Which intent classes a query set falls into, weighted by impressions. The
// human-readable half of a drift report.
function intentMix(rows, vertical, market) {
  const totals = new Map();
  let total = 0;
  rows.forEach((r) => {
    const imp = Number(r.impressions) || 0;
    if (imp <= 0) return;
    const cls = nlp.classifyIntent([String(r.query)], vertical, market);
    const label = (cls && cls.intent) || 'Informational';
    totals.set(label, (totals.get(label) || 0) + imp);
    total += imp;
  });
  if (!total) return [];
  return [...totals.entries()]
    .map(([intent, impressions]) => ({ intent, impressions, share: Math.round((impressions / total) * 1000) / 10 }))
    .sort((a, b) => b.impressions - a.impressions);
}

// Decay: how a page's clicks and position moved, relative to the whole site.
//
// Relative is the important word. A page down 30% during a month when the site
// is down 30% is not a declining page; it is a declining site, and filing 40
// page-level refresh tasks for it buries the one finding that matters.
function decay(brandId, page, { days = 90 } = {}) {
  const anchor = analytics.latestGscDate(brandId);
  if (!anchor) return null;
  const recent = analytics.windowFrom(anchor, days);
  const priorEnd = new Date(`${recent.startDate}T00:00:00Z`);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
  const prior = analytics.windowFrom(priorEnd.toISOString().slice(0, 10), days);

  const read = (w) => {
    const r = db.prepare(`SELECT SUM(clicks) clicks, SUM(impressions) impressions,
        SUM(position*impressions)/NULLIF(SUM(impressions),0) position
      FROM gsc_page_daily WHERE brand_id=? AND page=? AND date BETWEEN ? AND ?`)
      .get(brandId, page, w.startDate, w.endDate);
    return {
      clicks: Number(r && r.clicks) || 0,
      impressions: Number(r && r.impressions) || 0,
      position: r && r.position == null ? null : Number(r.position),
    };
  };

  const now = read(recent);
  const then = read(prior);
  const site = seoSignals.sitewideClickChange(brandId, days);

  const clickChange = then.clicks > 0 ? ((now.clicks - then.clicks) / then.clicks) * 100 : null;
  const imprChange = then.impressions > 0 ? ((now.impressions - then.impressions) / then.impressions) * 100 : null;
  const positionChange = (now.position != null && then.position != null) ? now.position - then.position : null;

  return {
    recent: { ...now, window: recent },
    prior: { ...then, window: prior },
    clickChange: clickChange == null ? null : Math.round(clickChange * 10) / 10,
    imprChange: imprChange == null ? null : Math.round(imprChange * 10) / 10,
    // Positive = worse (position numbers grow as ranking falls).
    positionChange: positionChange == null ? null : Math.round(positionChange * 10) / 10,
    siteClickChange: site ? Math.round(site.changePct * 10) / 10 : null,
    // The page's change net of the site's. This is the number a decision
    // should be made on.
    relativeClickChange: (clickChange != null && site)
      ? Math.round((clickChange - site.changePct) * 10) / 10
      : null,
  };
}

// Last-modified date, from the sitemap where the sitemap is trustworthy, and
// from the page itself otherwise.
//
// Sitemap lastmod is checked for the deploy-stamp pattern first: if most dates
// land on one day, they were written by a build and mean nothing. In that case
// the page's own visible or structured date is used, and where neither exists
// the age is reported as unknown rather than as recent.
function buildLastmodIndex(sitemapUrls) {
  const dates = sitemapUrls.map((u) => u.lastmod).filter(Boolean);
  const byDay = new Map();
  dates.forEach((d) => {
    const t = Date.parse(d);
    if (!Number.isFinite(t)) return;
    const key = new Date(t).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });
  const top = [...byDay.values()].sort((a, b) => b - a)[0] || 0;
  const trustworthy = !(dates.length >= 8 && byDay.size < 8 && top / dates.length > 0.5);

  const index = new Map();
  if (trustworthy) {
    sitemapUrls.forEach((u) => {
      if (!u.lastmod) return;
      const t = Date.parse(u.lastmod);
      if (Number.isFinite(t)) index.set(canonUrl(u.loc), new Date(t).toISOString().slice(0, 10));
    });
  }
  return {
    index,
    trustworthy,
    reason: trustworthy ? null : `${dates.length} lastmod values across only ${byDay.size} distinct days — stamped at deploy time, so they do not indicate when content was edited`,
    dated: dates.length,
    total: sitemapUrls.length,
  };
}

// A date read off the page: Article schema first (most reliable), then a <time>
// element, then a visible "last updated" line.
function dateFromPage(doc) {
  for (const block of doc.jsonLd) {
    if (!block.ok) continue;
    const nodes = Array.isArray(block.data) ? block.data : [block.data, ...(block.data['@graph'] || [])];
    for (const n of nodes.filter(Boolean)) {
      const d = n.dateModified || n.datePublished;
      if (d && Number.isFinite(Date.parse(d))) {
        return { date: new Date(Date.parse(d)).toISOString().slice(0, 10), source: n.dateModified ? 'schema dateModified' : 'schema datePublished' };
      }
    }
  }
  const timeAttr = doc.$('time[datetime]').first().attr('datetime');
  if (timeAttr && Number.isFinite(Date.parse(timeAttr))) {
    return { date: new Date(Date.parse(timeAttr)).toISOString().slice(0, 10), source: '<time> element' };
  }
  const m = /\b(?:last\s+)?(?:updated|reviewed|revised|modified)(?:\s+on)?\s*:?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i
    .exec((doc.mainText || '').slice(0, 6000));
  if (m && Number.isFinite(Date.parse(m[1]))) {
    return { date: new Date(Date.parse(m[1])).toISOString().slice(0, 10), source: 'visible "last updated" text' };
  }
  return { date: null, source: null };
}

const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null);

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, maxPages = 40, driftThreshold = 0.35, staleDays = 365,
  wantAi = true, force = false,
}) {
  const brandId = brand.id;
  const site = normalizeUrl(brand.site_url);
  const vertical = brand.vertical || 'other';
  const market = brand.market || null;

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'freshness', target: site,
    params: { maxPages, driftThreshold, staleDays },
  });

  try {
    const sources = [];
    const anchor = analytics.latestGscDate(brandId);
    if (!anchor) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'No Search Console history for this brand, so neither decay nor intent drift can be measured. Connect Search Console and let a nightly sync run — drift needs at least two query snapshots, which is roughly two weeks of history.',
        },
        findings: [],
        sources,
      });
    }
    sources.push('gsc');

    // Pages worth examining: the ones that actually earn impressions. A
    // freshness sweep over every URL wastes the budget on pages nobody sees.
    const w = analytics.windowFrom(anchor, 90);
    const pages = db.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions,
        SUM(position*impressions)/NULLIF(SUM(impressions),0) position
      FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY page HAVING SUM(impressions) >= 30
      ORDER BY SUM(impressions) DESC LIMIT ?`).all(brandId, w.startDate, w.endDate, maxPages);

    if (!pages.length) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: `No page has 30 or more impressions in the last 90 days (window ${w.startDate} to ${w.endDate}), so there is nothing with enough signal to judge.`,
        },
        findings: [],
        sources,
      });
    }

    // Sitemap lastmod, once for the whole site.
    const robots = await fetchRobots(site);
    const sitemap = await fetchSitemapUrls(site, { limit: 3000, robots });
    const lastmod = buildLastmodIndex(sitemap.urls);
    sources.push('crawler');

    // Drift needs two snapshot periods.
    const periods = snapshotPeriods(brandId, { limit: 2 });
    const canMeasureDrift = periods.length >= 2;

    // Fetch each page once for its own date and its citability, in parallel but
    // politely — this is the brand's own site, so a small concurrency is fine.
    const fetched = await mapLimit(pages, 4, async (p) => {
      const res = await fetchPage(p.page, { timeout: 18000 });
      if (!res.ok || !res.body) return { page: p.page, ok: false, status: res.status, error: res.error };
      const doc = parseDocument(res.url, res.body);
      return { page: p.page, ok: true, doc, pageDate: dateFromPage(doc) };
    });
    const docByPage = new Map(fetched.filter((f) => f && f.ok).map((f) => [f.page, f]));

    const analysed = pages.map((p) => {
      const key = canonUrl(p.page);
      const fetchedPage = docByPage.get(p.page);
      const sitemapDate = lastmod.index.get(key) || null;
      const pageDate = fetchedPage && fetchedPage.pageDate ? fetchedPage.pageDate : { date: null, source: null };
      const bestDate = sitemapDate || pageDate.date;
      const dateSource = sitemapDate ? 'sitemap lastmod' : pageDate.source;

      const d = decay(brandId, p.page, { days: 90 });

      let drift = null;
      if (canMeasureDrift) {
        const recent = distributionForPeriod(brandId, p.page, periods[0]);
        const prior = distributionForPeriod(brandId, p.page, periods[1]);
        // Both windows need enough queries for a divergence to mean anything.
        // Below this, JSD is dominated by sampling noise and will happily
        // report 0.8 on a page that did not change at all.
        const enough = recent.map.size >= 5 && prior.map.size >= 5;
        const divergence = enough ? nlp.jensenShannon(recent.map, prior.map) : null;

        const gained = [...recent.map.entries()]
          .filter(([q]) => !prior.map.has(q))
          .sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([query, impressions]) => ({ query, impressions }));
        const lost = [...prior.map.entries()]
          .filter(([q]) => !recent.map.has(q))
          .sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([query, impressions]) => ({ query, impressions }));

        drift = {
          measurable: enough,
          reason: enough ? null : `too few queries to compare (${recent.map.size} recent, ${prior.map.size} prior; needs 5 of each)`,
          divergence: divergence == null ? null : Math.round(divergence * 1000) / 1000,
          periods,
          recentQueries: recent.map.size,
          priorQueries: prior.map.size,
          gained,
          lost,
          intentRecent: enough ? intentMix(recent.rows, vertical, market) : [],
          intentPrior: enough ? intentMix(prior.rows, vertical, market) : [],
        };
        if (drift.intentRecent.length && drift.intentPrior.length) {
          const topNow = drift.intentRecent[0].intent;
          const topThen = drift.intentPrior[0].intent;
          drift.intentChanged = topNow !== topThen;
          drift.intentFrom = topThen;
          drift.intentTo = topNow;
        }
      }

      const age = daysSince(bestDate);
      const citabilityScore = fetchedPage && fetchedPage.doc ? nlp.citability(fetchedPage.doc).score : null;

      // The refresh verdict. Ordered deliberately: drift outranks age, because
      // a page answering the wrong question is a problem whatever its date,
      // and a page that is old and still performing is not.
      let verdict = 'ok';
      let why = 'performing, and no drift detected';
      if (drift && drift.measurable && drift.divergence != null && drift.divergence >= driftThreshold) {
        verdict = 'intent-drift';
        why = `query mix diverged by ${drift.divergence} bits${drift.intentChanged ? ` and the dominant intent moved from ${drift.intentFrom} to ${drift.intentTo}` : ''}`;
      } else if (d && d.relativeClickChange != null && d.relativeClickChange <= -25) {
        verdict = 'decaying';
        why = `clicks down ${Math.abs(d.clickChange)}% against a site trend of ${d.siteClickChange}% — ${Math.abs(d.relativeClickChange)}pp worse than the site`;
      } else if (age != null && age >= staleDays && d && (d.imprChange == null || d.imprChange < 0)) {
        verdict = 'stale';
        why = `last changed ${age} days ago (${dateSource}) and impressions are not growing`;
      } else if (age == null) {
        verdict = 'unknown-age';
        why = 'no reliable last-modified date available from the sitemap or the page';
      } else if (age >= staleDays) {
        verdict = 'old-but-healthy';
        why = `${age} days old, but still growing — leave it alone`;
      }

      return {
        page: p.page,
        clicks: Number(p.clicks) || 0,
        impressions: Number(p.impressions) || 0,
        position: p.position == null ? null : Number(p.position),
        title: fetchedPage && fetchedPage.doc ? fetchedPage.doc.title : null,
        fetchOk: Boolean(fetchedPage),
        fetchError: fetchedPage ? null : (fetched.find((f) => f && f.page === p.page) || {}).error || 'not fetched',
        lastModified: bestDate,
        dateSource,
        ageDays: age,
        citability: citabilityScore,
        decay: d,
        drift,
        verdict,
        why,
      };
    });

    // AI reading, for the drifted pages only — the subset where the question
    // "is this seasonal noise, a re-angle, or a split" genuinely needs
    // judgement, and where getting it wrong wastes a writer's week.
    const drifted = analysed.filter((a) => a.verdict === 'intent-drift').slice(0, 6);
    const readings = [];
    if (wantAi && drifted.length) {
      // One batched call for every page that isn't already cached, instead of
      // one call per page — same per-page judgement, far less repeated
      // system-prompt overhead. See aiCalls.intentDriftReadings.
      const items = drifted.map((item) => ({
        page: item.page,
        pageTitle: item.title,
        lastModified: item.lastModified,
        driftMetrics: {
          divergenceBits: item.drift.divergence,
          intentFrom: item.drift.intentFrom, intentTo: item.drift.intentTo,
          clickChangePct: item.decay ? item.decay.clickChange : null,
          siteClickChangePct: item.decay ? item.decay.siteClickChange : null,
        },
        gainedQueries: item.drift.gained,
        lostQueries: item.drift.lost,
      }));
      const results = await aiCalls.intentDriftReadings({ brandId, items, force });
      items.forEach((item, idx) => {
        const r = results[idx];
        readings.push({ page: item.page, ok: r.ok, cached: r.cached, reason: r.reason, error: r.error, data: r.ok ? r.data : null });
      });
      if (readings.some((r) => r.ok)) sources.push('azure');
    }

    // ------------------------------------------------------------ findings
    const findings = [];
    const byVerdict = (v) => analysed.filter((a) => a.verdict === v);

    if (drifted.length) {
      findings.push({
        checkKey: 'intent_drift',
        title: `${byVerdict('intent-drift').length} page${byVerdict('intent-drift').length === 1 ? '' : 's'} show intent drift — what searchers want has changed`,
        detail: byVerdict('intent-drift').slice(0, 6).map((a) => `${a.page}: divergence ${a.drift.divergence} bits${a.drift.intentChanged ? `, ${a.drift.intentFrom} → ${a.drift.intentTo}` : ''}, gaining "${(a.drift.gained[0] || {}).query || '—'}" and losing "${(a.drift.lost[0] || {}).query || '—'}"`).join('; ') + '.',
        severity: 'high',
        affectedCount: byVerdict('intent-drift').length,
        affectedUrl: drifted[0].page,
        action: 'Re-angle rather than rewrite. The subject is still right; the question being asked is different. Compare the gained and lost query lists on each page before editing — they name the new question precisely.',
        evidence: { pages: byVerdict('intent-drift').map((a) => ({ page: a.page, divergence: a.drift.divergence, gained: a.drift.gained.slice(0, 8), lost: a.drift.lost.slice(0, 8), intentFrom: a.drift.intentFrom, intentTo: a.drift.intentTo })) },
        dedupeKey: `freshness:drift:${brandId}:${periods[0] ? periods[0].endDate : 'na'}`,
      });
    }

    const decaying = byVerdict('decaying');
    if (decaying.length) {
      findings.push({
        checkKey: 'decaying',
        title: `${decaying.length} page${decaying.length === 1 ? ' is' : 's are'} losing clicks faster than the site as a whole`,
        detail: decaying.slice(0, 6).map((a) => `${a.page}: ${a.decay.clickChange}% clicks against a site trend of ${a.decay.siteClickChange}%${a.ageDays != null ? `, last changed ${a.ageDays} days ago` : ''}`).join('; ') + '.',
        severity: 'high',
        affectedCount: decaying.length,
        affectedUrl: decaying[0].page,
        action: 'Refresh these. Decay measured against the site trend excludes a sitewide fall, so what remains is page-specific — usually a competitor publishing something better, or a fact on the page that has gone out of date.',
        evidence: { pages: decaying.map((a) => ({ page: a.page, decay: a.decay, ageDays: a.ageDays })) },
        dedupeKey: `freshness:decay:${brandId}:${w.endDate}`,
      });
    }

    const stale = byVerdict('stale');
    if (stale.length) {
      findings.push({
        checkKey: 'stale',
        title: `${stale.length} page${stale.length === 1 ? '' : 's'} older than ${staleDays} days and not growing`,
        detail: stale.slice(0, 8).map((a) => `${a.page} (${a.ageDays} days, ${a.dateSource})`).join('; ') + '.',
        severity: 'medium',
        affectedCount: stale.length,
        affectedUrl: stale[0].page,
        action: 'Schedule a refresh pass. Age alone is not a problem — these were selected because they are also flat or falling, which is the combination worth acting on.',
        evidence: { pages: stale.map((a) => ({ page: a.page, ageDays: a.ageDays, dateSource: a.dateSource, decay: a.decay })) },
        dedupeKey: `freshness:stale:${brandId}:${new Date().toISOString().slice(0, 7)}`,
      });
    }

    const unknownAge = byVerdict('unknown-age');
    if (unknownAge.length >= Math.max(3, analysed.length / 3)) {
      findings.push({
        checkKey: 'no_dates',
        title: `${unknownAge.length} page${unknownAge.length === 1 ? ' has' : 's have'} no reliable last-modified date`,
        detail: (lastmod.trustworthy
          ? 'These URLs carry no lastmod in the sitemap and show no date in their markup or schema. '
          : `Sitemap lastmod values are unusable for this site — ${lastmod.reason}. `)
          + 'A page with no stated date cannot demonstrate currency to a reader or to an AI engine, which will prefer a dated competitor over an undated page even when the undated one is more accurate.',
        severity: 'medium',
        affectedCount: unknownAge.length,
        action: 'Publish a visible "last reviewed" date and emit dateModified in Article schema. Both are small changes and both are read.',
        evidence: { lastmodIndex: { trustworthy: lastmod.trustworthy, reason: lastmod.reason, dated: lastmod.dated, total: lastmod.total }, pages: unknownAge.slice(0, 30).map((a) => a.page) },
        dedupeKey: `freshness:nodates:${brandId}`,
      });
    }

    if (!canMeasureDrift) {
      findings.push({
        checkKey: 'drift_unmeasurable',
        title: 'Intent drift could not be measured yet',
        detail: `Drift compares two query-level snapshots and only ${periods.length} exist for this brand. Snapshots are written by the nightly sync, so this becomes available once a second one has been taken.`,
        severity: 'info',
        action: 'No action — decay and staleness on this page are unaffected and were measured normally.',
        dedupeKey: `freshness:nodrift:${brandId}`,
      });
    }

    // Score: the share of examined pages in a healthy state.
    const healthy = analysed.filter((a) => a.verdict === 'ok' || a.verdict === 'old-but-healthy').length;
    const score = analysed.length ? Math.round((healthy / analysed.length) * 100) : null;

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site,
        window: w,
        thresholds: { driftThreshold, staleDays },
        canMeasureDrift,
        periods,
        lastmod: { trustworthy: lastmod.trustworthy, reason: lastmod.reason, dated: lastmod.dated, total: lastmod.total },
        counts: {
          examined: analysed.length,
          drift: byVerdict('intent-drift').length,
          decaying: byVerdict('decaying').length,
          stale: byVerdict('stale').length,
          unknownAge: byVerdict('unknown-age').length,
          oldButHealthy: byVerdict('old-but-healthy').length,
          ok: byVerdict('ok').length,
        },
        pages: analysed,
        aiReadings: readings,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: [
        { key: 'freshness.score', value: score, status: score == null ? 'unknown' : (score >= 75 ? 'good' : (score >= 50 ? 'warn' : 'fail')) },
        { key: 'freshness.drifted_pages', value: byVerdict('intent-drift').length, status: byVerdict('intent-drift').length ? 'warn' : 'good' },
        { key: 'freshness.decaying_pages', value: byVerdict('decaying').length, status: byVerdict('decaying').length ? 'warn' : 'good' },
        { key: 'freshness.stale_pages', value: byVerdict('stale').length, status: byVerdict('stale').length ? 'warn' : 'good' },
      ],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// Schedules a refresh: creates one dated task per flagged page rather than one
// task for the whole finding, because a refresh is per-page work that gets
// assigned to a person and needs its own due date.
//
// Due dates are staggered so a run that flags twelve pages does not create
// twelve tasks all due the same day, which is the same as none of them having
// a due date.
function scheduleRefreshes(run, brand, { userId, weeklyCapacity = 3 }) {
  const tasksLib = require('../tasks');
  const result = run.result || {};
  const pages = (result.pages || []).filter((p) => ['intent-drift', 'decaying', 'stale'].includes(p.verdict));
  if (!pages.length) return { created: 0, scheduled: 0 };

  // Most urgent first: drift, then decay, then age — and within each, by the
  // impressions at stake.
  const rank = { 'intent-drift': 0, decaying: 1, stale: 2 };
  const ordered = pages.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (b.impressions - a.impressions));

  let created = 0;
  ordered.forEach((p, i) => {
    const weekOffset = Math.floor(i / Math.max(1, weeklyCapacity));
    const due = new Date();
    due.setDate(due.getDate() + 7 + (weekOffset * 7));
    const dueDate = due.toISOString().slice(0, 10);

    const severity = p.verdict === 'intent-drift' ? 'high' : (p.verdict === 'decaying' ? 'high' : 'medium');
    const detailLines = [p.why];
    if (p.drift && p.drift.gained && p.drift.gained.length) {
      detailLines.push(`Now gaining impressions for: ${p.drift.gained.slice(0, 6).map((g) => `"${g.query}"`).join(', ')}.`);
    }
    if (p.drift && p.drift.lost && p.drift.lost.length) {
      detailLines.push(`No longer showing for: ${p.drift.lost.slice(0, 6).map((g) => `"${g.query}"`).join(', ')}.`);
    }
    if (p.decay) {
      detailLines.push(`Clicks ${p.decay.clickChange == null ? 'n/a' : `${p.decay.clickChange}%`}, impressions ${p.decay.imprChange == null ? 'n/a' : `${p.decay.imprChange}%`}, position change ${p.decay.positionChange == null ? 'n/a' : p.decay.positionChange}, against a site click trend of ${p.decay.siteClickChange == null ? 'n/a' : `${p.decay.siteClickChange}%`}.`);
    }
    if (p.ageDays != null) detailLines.push(`Last changed ${p.ageDays} days ago (${p.dateSource}).`);
    if (p.citability != null) detailLines.push(`Citability score ${p.citability}/100 — worth improving in the same pass.`);

    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: `Refresh: ${p.title || p.page}`,
      detail: detailLines.join('\n'),
      source: 'aiseo',
      sourceRef: `aiseo:freshness:${run.id}:${p.page}`,
      category: p.verdict === 'intent-drift' ? 'Intent drift' : 'Content refresh',
      severity,
      affectedUrl: p.page,
      dueDate,
      evidence: { verdict: p.verdict, decay: p.decay, drift: p.drift ? { divergence: p.drift.divergence, gained: p.drift.gained, lost: p.drift.lost } : null, ageDays: p.ageDays },
      dedupeKey: `aiseo:freshness:${p.verdict}:${p.page}`,
    });
    if (r.created) created += 1;
  });

  return { created, scheduled: ordered.length, weeklyCapacity };
}

function toTasks(run, brand, { userId }) {
  return scheduleRefreshes(run, brand, { userId });
}

module.exports = {
  run, toTasks, scheduleRefreshes, decay, intentMix, queryDistribution,
  snapshotPeriods, distributionForPeriod, buildLastmodIndex, dateFromPage,
};
