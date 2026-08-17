// Content Opportunity engine.
//
// Reads the consolidated Search Console and GA4 data and produces a ranked
// list of specific, evidenced content actions. This is the "Content
// Opportunity Agent" from the plan, implemented as a deterministic analysis
// over data we already hold rather than as a prompt — so every item it emits
// carries the numbers that justify it, and the same input always produces the
// same output.
//
// Six opportunity types:
//   ctr_gap          high impressions, low CTR         → rewrite title/meta
//   striking_distance position 4–20 with volume        → strengthen the page
//   declining         page losing clicks vs prior      → refresh / investigate
//   refresh           page decaying slowly over 90d    → content refresh
//   new_page          keyword cluster with no owner    → commission new page
//   cannibalisation   several URLs on one query        → consolidate
//
// Each opportunity gets a score so the backlog can be prioritised by expected
// gain rather than by whichever check ran last.
const db = require('../db');
const A = require('./analytics');
const clustering = require('./clustering');
const S = require('./seoSignals');

const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;
const pp = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const plural = (n, one, many) => (Math.round(Number(n) || 0) === 1 ? one : many);

// Rough CTR that a given average position ought to achieve. Used to estimate
// the click upside of a CTR fix. These are industry-typical organic curves,
// not promises — they exist to rank opportunities against each other.
//
// Retained as the fallback only: `analyse` now fits the brand's OWN curve from
// its Search Console history where there is enough data (see seoSignals.js),
// because a generic curve manufactures permanent, uncloseable "CTR gaps" on
// any site whose SERPs carry AI Overviews, ad blocks or local packs.
const CTR_BY_POSITION = S.GENERIC_CTR_BY_POSITION;

function expectedCtr(position, curveInfo = null) {
  const curve = (curveInfo && curveInfo.curve) || CTR_BY_POSITION;
  return S.lookupCurve(curve, position);
}

// ------------------------------------------------------------------ scoring
//
// Every detector scores in ONE unit: expected additional clicks per 28 days.
//
// Previously each detector invented its own multiplier — clicks x10, x12, x9,
// but impressions x2 and x1.5 for new_page and cannibalisation. Impressions
// run 20-100x larger than clicks, so on the live brand the entire top 12 of
// the ranked backlog was cannibalisation and a real 124-click CTR win sat at
// number 13. The multipliers were chosen by feel and the resulting numbers
// were not comparable to each other in any unit.
//
// Now: score = expected incremental clicks x conversion weight x confidence.
//   - conversion weight (0.5-2.0) comes from GA4 landing-page conversion rate,
//     so a click on a page that converts is worth more than one that doesn't.
//     Bounded deliberately: conversion data is noisy and should tilt the
//     ranking, never dominate it.
//   - confidence (0-1) discounts estimates resting on weaker evidence, so a
//     speculative gain never outranks a well-evidenced one of the same size.
// The raw click estimate is preserved on every item as `expectedClicks` so the
// number a human reads is never the scaled one.
const WINDOW_DAYS = 28;

function scoreOf(expectedClicks, { conversionMultiplier = 1, confidence = 1 } = {}) {
  return Math.round(Math.max(0, expectedClicks) * conversionMultiplier * confidence * 10);
}

// Normalises an estimate measured over `days` into the standard 28-day window
// so detectors using 90-day inputs cannot outrank 28-day ones on window length
// alone (which is exactly how new_page and cannibalisation used to win).
function per28Days(value, days) {
  if (!days || days <= 0) return value;
  return (value / days) * WINDOW_DAYS;
}

// ------------------------------------------------------------------ context
//
// Built once per run and shared by every detector so they cannot disagree
// about what counts as a brand term, what CTR a position should earn, or
// which day the data is trustworthy up to.
//
// SAFE_ANCHOR_LAG_DAYS is the important one. Windows anchored on
// MAX(date) always include Search Console's most recent days, which are
// still backfilling and therefore systematically under-report. Every
// trend detector then reads that as a decline. Stepping the anchor back a
// few days costs a little recency and removes a whole class of false
// "declining page" tasks.
const SAFE_ANCHOR_LAG_DAYS = 3;
const MIN_HISTORY_DAYS_FOR_LAG = 60;

function safeAnchor(brandId) {
  const anchor = A.latestGscDate(brandId);
  if (!anchor) return null;
  const row = db.prepare('SELECT COUNT(DISTINCT date) d FROM gsc_daily WHERE brand_id=?').get(brandId);
  // On a brand with barely any history, dropping days would break the
  // comparison windows entirely — recency matters more than the bias there.
  if (!row || (Number(row.d) || 0) < MIN_HISTORY_DAYS_FOR_LAG) return anchor;
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - SAFE_ANCHOR_LAG_DAYS);
  return d.toISOString().slice(0, 10);
}

// Detectors are exported individually and can be called without a context.
// When that happens the context must be REBUILT, not skipped: passing
// `ctx = null` silently disabled the branded-query filter, so the AI Lab
// comparison sheet listed the brand's own name as a cannibalisation finding
// while the opportunities screen — same detector, same data — correctly
// excluded it. Two screens disagreeing about the same data is worse than
// either answer alone.
function ensureCtx(brandId, ctx) {
  if (ctx) return ctx;
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
    if (brand) return buildContext(brand);
  } catch { /* fall through to the minimal context below */ }
  return {
    brandId, brand: null, anchor: A.latestGscDate(brandId), rawAnchor: A.latestGscDate(brandId),
    terms: S.brandTerms({}), curve: S.ctrCurve(null, null),
    brandedShare: new Map(), rates: S.conversionRates(null), sitewide: null,
  };
}

function buildContext(brand) {
  const brandId = brand.id;
  return {
    brandId,
    brand,
    anchor: safeAnchor(brandId),
    rawAnchor: A.latestGscDate(brandId),
    terms: S.brandTerms(brand),
    curve: S.ctrCurve(brandId, brand),
    brandedShare: S.brandedShareByPage(brandId, brand),
    rates: S.conversionRates(brandId),
    sitewide: S.sitewideClickChange(brandId, WINDOW_DAYS),
  };
}

// -------------------------------------------------------------- detectors

// 1. High impressions, low CTR — the cheapest wins on the site.
function ctrGaps(brandId, { windowDays = 28, minImpressions = 200, maxPosition = 20, limit = 30 } = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const anchor = (ctx && ctx.anchor) || A.latestGscDate(brandId);
  if (!anchor) return [];
  const w = A.windowFrom(anchor, windowDays);
  const rows = db.prepare(`SELECT page,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY page
    HAVING SUM(impressions) >= ?
       AND SUM(position*impressions)/NULLIF(SUM(impressions),0) <= ?
    ORDER BY SUM(impressions) DESC LIMIT 300`)
    .all(brandId, w.startDate, w.endDate, minImpressions, maxPosition);

  const curve = ctx && ctx.curve;
  const shares = (ctx && ctx.brandedShare) || new Map();

  return rows.map((r) => {
    // Strip branded traffic before comparing against a non-branded benchmark.
    // Without this, a page whose brand queries convert at 40% CTR looks
    // healthy against a 1% non-branded curve and its real gap on commercial
    // queries stays invisible.
    const share = shares.get(r.page);
    const hasShare = Boolean(share && share.sampleImpressions > 0);
    const impressions = hasShare ? r.impressions * (1 - share.impressionShare) : r.impressions;
    const clicks = hasShare ? r.clicks * (1 - share.clickShare) : r.clicks;
    const ctr = impressions > 0 ? clicks / impressions : 0;
    const target = expectedCtr(r.position, curve);
    const upside = Math.max(0, (target - ctr) * impressions);
    return {
      ...r,
      nonBrandedImpressions: impressions,
      nonBrandedClicks: clicks,
      brandedShareKnown: hasShare,
      brandedImpressionShare: hasShare ? share.impressionShare : null,
      ctr,
      target,
      upside,
    };
  })
    .filter((r) => r.nonBrandedImpressions >= 50 && r.upside >= 5 && r.ctr < r.target * 0.6)
    .sort((a, b) => b.upside - a.upside)
    .slice(0, limit)
    .map((r) => {
      const queries = topQueriesForPage(brandId, r.page, 6, ctx);
      const fitted = S.ctrIsFitted(curve, r.position);
      const convMult = S.conversionMultiplier(ctx && ctx.rates, r.page);
      // An expected-CTR benchmark taken from the generic curve rather than
      // this brand's own data is a weaker basis for a click estimate, so the
      // score is discounted rather than presented as equally certain.
      // Discounted twice over: once when the CTR benchmark is generic rather
      // than this brand's own, and again when the branded share of the page's
      // traffic is unknown and the comparison had to use raw totals.
      const confidence = (fitted ? 1 : 0.75) * (r.brandedShareKnown ? 1 : 0.85);
      const expected = per28Days(r.upside, windowDays);
      return {
        type: 'ctr_gap',
        typeLabel: 'CTR gap',
        page: r.page,
        title: `Rewrite title and meta description: ${shortPath(r.page)}`,
        score: scoreOf(expected, { conversionMultiplier: convMult, confidence }),
        expectedClicks: expected,
        scoreBasis: {
          unit: 'expected additional clicks per 28 days',
          expectedClicks: expected,
          conversionMultiplier: convMult,
          confidence,
          ctrBenchmark: fitted ? 'brand-calibrated' : 'generic curve',
        },
        estimatedGain: `~${int(r.upside)} extra clicks per ${windowDays} days`,
        severity: r.upside >= 50 ? 'high' : (r.upside >= 15 ? 'medium' : 'low'),
        evidence: {
          window: w, impressions: r.impressions, clicks: r.clicks,
          nonBrandedImpressions: r.nonBrandedImpressions, nonBrandedClicks: r.nonBrandedClicks,
          brandedImpressionShare: r.brandedImpressionShare,
          ctr: r.ctr, expectedCtr: r.target, position: r.position, upside: r.upside, queries,
          ctrBenchmarkSource: fitted ? 'brand-calibrated' : 'generic',
        },
        summary: `${int(r.nonBrandedImpressions)} non-branded impressions but only ${int(r.nonBrandedClicks)} ${plural(r.nonBrandedClicks, 'click', 'clicks')} (${pp(r.ctr * 100)} CTR) at average position ${r.position.toFixed(1)}.${r.brandedShareKnown && r.brandedImpressionShare > 0.02 ? ` (${pct(r.brandedImpressionShare * 100)} of this page's impressions are branded and have been excluded.)` : ''} ${fitted ? 'This site\'s own pages at this position average' : 'A page at this position would typically see'} about ${pp(r.target * 100)}, which is roughly ${int(r.upside)} more clicks per ${windowDays} days.`,
        action: [
          'Rewrite the title tag to lead with the exact wording searchers use and the outcome they want.',
          'Write a meta description that answers the top query directly instead of describing the page.',
          queries.length ? `Top non-branded queries to target: ${queries.slice(0, 4).map((q) => `"${q.query}"`).join(', ')}.` : null,
          !fitted ? 'The CTR benchmark here is an industry-generic curve, not this site\'s own — check the live SERP for an AI Overview or ad block that may cap what is achievable.' : null,
          'Do not change the URL. Note that a title change on a high-performing page needs SEO approval.',
        ].filter(Boolean).join(' '),
      };
    });
}

// 2. Striking distance — positions 4–20 where a push pays off disproportionately.
function strikingDistance(brandId, { windowDays = 28, minImpressions = 100, from = 4, to = 20, limit = 30 } = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const anchor = (ctx && ctx.anchor) || A.latestGscDate(brandId);
  if (!anchor) return [];
  const w = A.windowFrom(anchor, windowDays);
  const rows = db.prepare(`SELECT query,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY query
    HAVING SUM(impressions) >= ?
       AND SUM(position*impressions)/NULLIF(SUM(impressions),0) BETWEEN ? AND ?
    ORDER BY SUM(impressions) DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, minImpressions, from, to, limit * 3);

  const curve = ctx && ctx.curve;
  const terms = ctx && ctx.terms;

  const scored = rows
    // Branded queries are excluded: you already own position 1-3 for your own
    // name, the CTR is several times non-branded, and "push it into the top 3"
    // is not a piece of work anyone can action.
    .filter((r) => !S.isBrandedQuery(r.query, terms))
    .map((r) => {
      const ctr = r.impressions > 0 ? r.clicks / r.impressions : 0;
      // Upside of reaching position 3.
      const upside = Math.max(0, (expectedCtr(3, curve) - ctr) * r.impressions);
      const owner = A.pageForQuery(brandId, r.query);
      return { ...r, ctr, upside, owner };
    })
    .sort((a, b) => b.upside - a.upside);

  // Group by the page that ranks, not by the query.
  //
  // Ten phrasings of one keyword ranking with one URL is ONE piece of work —
  // strengthen that page — but it used to produce ten near-identical backlog
  // items. The queries are kept on the item so the writer still sees every
  // phrasing to cover.
  const byPage = new Map();
  const noOwner = [];
  scored.forEach((r) => {
    if (!r.owner || !r.owner.page) { noOwner.push(r); return; }
    if (!byPage.has(r.owner.page)) byPage.set(r.owner.page, []);
    byPage.get(r.owner.page).push(r);
  });

  const groups = [
    ...[...byPage.entries()].map(([page, qs]) => ({ page, queries: qs })),
    ...noOwner.map((r) => ({ page: null, queries: [r] })),
  ]
    .map((g) => ({ ...g, upside: g.queries.reduce((s, q) => s + q.upside, 0) }))
    .sort((a, b) => b.upside - a.upside)
    .slice(0, limit);

  return groups.map((g) => {
    const lead = g.queries[0];
    const others = g.queries.slice(1);
    const convMult = S.conversionMultiplier(ctx && ctx.rates, g.page);
    const fitted = S.ctrIsFitted(curve, 3);
    // Reaching position 3 is an assumption, not an observation — this
    // estimate is inherently more speculative than a CTR-gap one, and the
    // score says so rather than competing on equal footing.
    const confidence = (fitted ? 0.7 : 0.55);
    const expected = per28Days(g.upside, windowDays);
    return {
      type: 'striking_distance',
      typeLabel: 'Striking distance',
      page: g.page,
      query: lead.query,
      queries: g.queries.map((q) => ({ query: q.query, impressions: q.impressions, position: q.position })),
      title: g.page
        ? `Strengthen ${shortPath(g.page)} for ${g.queries.length} near-miss quer${g.queries.length === 1 ? 'y' : 'ies'}`
        : `Push "${lead.query}" from position ${lead.position.toFixed(1)} into the top 3`,
      score: scoreOf(expected, { conversionMultiplier: convMult, confidence }),
      expectedClicks: expected,
      scoreBasis: {
        unit: 'expected additional clicks per 28 days',
        expectedClicks: expected,
        conversionMultiplier: convMult,
        confidence,
        note: 'Assumes the page reaches position 3, which is not guaranteed.',
      },
      estimatedGain: `~${int(g.upside)} extra clicks per ${windowDays} days if these reach position 3`,
      severity: g.upside >= 40 ? 'high' : (g.upside >= 12 ? 'medium' : 'low'),
      evidence: {
        window: w,
        queries: g.queries.map((q) => ({
          query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.position, upside: q.upside,
        })),
        rankingPage: g.page,
        upside: g.upside,
        brandedExcluded: true,
      },
      summary: g.page
        ? `${shortPath(g.page)} ranks just outside the top 3 for ${g.queries.length} quer${g.queries.length === 1 ? 'y' : 'ies'} — led by "${lead.query}" at average position ${lead.position.toFixed(1)} with ${int(lead.impressions)} impressions${others.length ? `, plus ${others.length} more phrasing${others.length === 1 ? '' : 's'}` : ''}.`
        : `"${lead.query}" sits at average position ${lead.position.toFixed(1)} with ${int(lead.impressions)} impressions and ${int(lead.clicks)} clicks over ${windowDays} days (no single ranking URL identified).`,
      action: [
        g.page ? `Strengthen ${g.page}:` : 'Identify the ranking page, then:',
        'cover the sub-questions competitors answer and you do not,',
        `work the exact quer${g.queries.length === 1 ? 'y' : 'ies'} into the H1 and opening paragraph`,
        others.length ? `(${others.slice(0, 5).map((q) => `"${q.query}"`).join(', ')}),` : ',',
        'and add internal links to it from your strongest topically related pages using these as anchor text.',
      ].join(' '),
    };
  });
}

// Statistical-significance guard shared by the trend-based detectors below.
//
// Replaces the old "3*sqrt(n)/n" ad-hoc noise-floor heuristic with a real
// closed-form significance test: a one-tailed two-sample Poisson rate-ratio
// z-test.
//
// Model & formula:
//   Daily click counts are treated as an (approximately) Poisson process.
//   For a count `k` observed over an exposure window of `t` days, the rate
//   estimate is lambda = k / t, and by the delta method on the Poisson
//   variance (Var(k) = k), the standard error of that rate is
//   se = sqrt(k) / t.
//
//   Given two INDEPENDENT windows — "prior" (k1 clicks over t1 days) and
//   "recent" (k2 clicks over t2 days) — the z-statistic for a decrease is:
//     z = (lambda1 - lambda2) / sqrt(se1^2 + se2^2)
//       = (k1/t1 - k2/t2) / sqrt(k1/t1^2 + k2/t2^2)
//   which is asymptotically standard-normal under the null hypothesis that
//   the true rate did not fall. A drop is flagged significant at confidence
//   level C when z clears the one-tailed critical value for C (e.g. 1.645
//   for 95%; we use one-tailed because a "declining" detector only ever
//   cares about decreases, never increases).
//
// Assumptions (stated explicitly, not hidden):
//   - Click arrivals are independent Poisson events. Reasonable for
//     aggregated daily counts; ignores day-of-week/seasonal correlation.
//   - The normal approximation to the Poisson is used for the z-test, which
//     is decent once counts are roughly >= 10; below that it is
//     conservative (harder to flag, not easier) — the safe failure
//     direction for something that files backlog tasks.
//   - No multiple-comparison correction is applied across the many
//     pages/queries scanned per run; at 95% confidence, roughly 1 in 20
//     borderline cases across a large site could still be a false
//     positive. Tightening `confidence` per brand (a paid-tier config
//     knob) is the intended lever if that turns out to matter in practice.
//
// `confidence` is exposed so it can become a per-brand setting later
// without another rewrite of this function.
const Z_FOR_ONE_TAILED_CONFIDENCE = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };
function zCriticalOneTailed(confidence = 0.95) {
  return Z_FOR_ONE_TAILED_CONFIDENCE[confidence] || Z_FOR_ONE_TAILED_CONFIDENCE[0.95];
}

// priorCount/recentCount: raw click counts over their respective windows.
// priorDays/recentDays: the exposure (in days) each count was observed over
// — these do NOT need to be equal (e.g. a 62-day baseline vs a 28-day
// recent window), which is exactly why this replaces the old percentage
// heuristic that only ever compared like-for-like windows.
// `minRelativeDrop` is an optional floor (e.g. 0.2 for "at least 20%
// down") applied ALONGSIDE the significance test, not instead of it — a
// tiny, non-actionable drop can still be statistically significant on a
// huge-traffic page, and this keeps such noise out of the backlog.
function isSignificantRateDrop(priorCount, priorDays, recentCount, recentDays, { confidence = 0.95, minRelativeDrop = 0 } = {}) {
  const t1 = Math.max(Number(priorDays) || 0, 1e-6);
  const t2 = Math.max(Number(recentDays) || 0, 1e-6);
  const k1 = Math.max(Number(priorCount) || 0, 0);
  const k2 = Math.max(Number(recentCount) || 0, 0);
  const lambda1 = k1 / t1;
  const lambda2 = k2 / t2;
  if (lambda1 <= 0) return false; // nothing to have dropped from
  const relativeDrop = (lambda1 - lambda2) / lambda1;
  if (relativeDrop < minRelativeDrop) return false;
  const se1 = Math.sqrt(k1) / t1;
  const se2 = Math.sqrt(k2) / t2;
  const se = Math.sqrt(se1 * se1 + se2 * se2);
  if (se <= 0) return relativeDrop > 0;
  const z = (lambda1 - lambda2) / se;
  return z >= zCriticalOneTailed(confidence);
}

// 3. Declining pages — losing clicks against the prior equal period.
function declining(brandId, { windowDays = 28, minPriorClicks = 10, minDropPct = 20, confidence = 0.95, limit = 30 } = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const rows = A.pageComparison(brandId, windowDays, { minPriorImpressions: 0 });

  // Sitewide control.
  //
  // A page down 30% in a month when the whole site is down 30% is not a
  // declining page — it is a declining site, and filing one task per page
  // buries the single finding that matters. `siteRatio` is the brand's own
  // recent/prior click ratio, so each page is judged against what the site
  // did, not against zero.
  const site = (ctx && ctx.sitewide) || S.sitewideClickChange(brandId, windowDays);
  const siteRatio = site && site.ratio > 0 ? site.ratio : 1;
  const siteIsDown = siteRatio < 0.9;

  return rows
    .filter((r) => {
      if (r.priorClicks < minPriorClicks) return false;
      if (!isSignificantRateDrop(r.priorClicks, windowDays, r.recentClicks, windowDays, { confidence, minRelativeDrop: minDropPct / 100 })) return false;
      // Expected recent clicks if this page had simply tracked the site.
      const expectedIfSiteWide = r.priorClicks * siteRatio;
      // Require the page to have fallen materially further than the site did,
      // otherwise it is carrying its share of a sitewide movement.
      return r.recentClicks < expectedIfSiteWide * 0.85;
    })
    .map((r) => ({ ...r, excessLost: Math.max(0, (r.priorClicks * siteRatio) - r.recentClicks) }))
    .sort((a, b) => b.excessLost - a.excessLost)
    .slice(0, limit)
    .map((r) => {
      const lost = r.priorClicks - r.recentClicks;
      const impressionsHeld = r.priorImpressions > 0 && r.recentImpressions >= r.priorImpressions * 0.9;
      const convMult = S.conversionMultiplier(ctx && ctx.rates, r.entity);
      // Score on the loss BEYOND the sitewide trend — the part actually
      // attributable to this page and therefore recoverable by working on it.
      const expected = r.excessLost;
      return {
        type: 'declining',
        typeLabel: 'Declining page',
        page: r.entity,
        title: `Investigate ${lost >= 0 ? `${int(lost)} lost clicks` : 'decline'}: ${shortPath(r.entity)}`,
        score: scoreOf(expected, { conversionMultiplier: convMult, confidence: 0.9 }),
        expectedClicks: expected,
        scoreBasis: {
          unit: 'expected additional clicks per 28 days',
          expectedClicks: expected,
          conversionMultiplier: convMult,
          confidence: 0.9,
          note: siteIsDown
            ? `Scored on the ${int(expected)} clicks lost BEYOND the sitewide decline of ${pct(Math.abs(site.changePct))}, not the full ${int(lost)}.`
            : 'Sitewide traffic was stable, so the full loss is attributed to this page.',
        },
        estimatedGain: `Recovering to the prior level is worth ~${int(lost)} clicks per ${windowDays} days`,
        severity: expected >= 30 ? 'high' : (expected >= 8 ? 'medium' : 'low'),
        evidence: {
          page: r.entity, recentClicks: r.recentClicks, priorClicks: r.priorClicks,
          recentImpressions: r.recentImpressions, priorImpressions: r.priorImpressions,
          recentPosition: r.recentPosition, priorPosition: r.priorPosition,
          dropPct: r.clicksDropPct, windows: r.windows,
          sitewideChangePct: site ? site.changePct : null,
          excessLostVsSitewide: expected,
        },
        summary: `Clicks fell from ${int(r.priorClicks)} to ${int(r.recentClicks)} (${pct(r.clicksDropPct)} down). Impressions moved ${int(r.priorImpressions)} → ${int(r.recentImpressions)} and position ${r.priorPosition == null ? 'n/a' : r.priorPosition.toFixed(1)} → ${r.recentPosition == null ? 'n/a' : r.recentPosition.toFixed(1)}.${siteIsDown ? ` Sitewide clicks moved ${pct(site.changePct)} over the same period, so this page fell about ${int(expected)} clicks further than the site as a whole.` : ''}`,
        action: impressionsHeld
          ? 'Impressions held while clicks fell, so this is a CTR problem, not a ranking problem. Check whether the title or description changed, and search the main query for a new AI Overview, ad block or richer competitor snippet.'
          : 'Impressions fell with the clicks, so visibility was lost. Confirm the page is still indexed and self-canonical, check which queries it dropped, and compare it against whoever now ranks above it.',
      };
    });
}

// 4. Content decay — a slower signal than `declining`: pages down against
//    their own 90-day baseline rather than against last month.
function refreshCandidates(brandId, { minBaselineClicks = 15, minDropPct = 25, confidence = 0.95, limit = 25 } = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const anchor = (ctx && ctx.anchor) || A.latestGscDate(brandId);
  if (!anchor) return [];
  const recent = A.windowFrom(anchor, 28, 0);
  const baseline = A.windowFrom(anchor, 90, 28); // the 90 days before the recent month

  const rows = db.prepare(`
    WITH r AS (SELECT page, SUM(clicks) c, SUM(impressions) i FROM gsc_page_daily
               WHERE brand_id=@b AND date BETWEEN @rs AND @re GROUP BY page),
         base AS (SELECT page, SUM(clicks) c, SUM(impressions) i, COUNT(DISTINCT date) d
               FROM gsc_page_daily WHERE brand_id=@b AND date BETWEEN @bs AND @be GROUP BY page)
    SELECT base.page, COALESCE(r.c,0) rc, COALESCE(r.i,0) ri,
           base.c bc, base.i bi, base.d bd
    FROM base LEFT JOIN r ON r.page = base.page
    WHERE base.c >= @min
    ORDER BY base.c DESC LIMIT 300`)
    .all({ b: brandId, rs: recent.startDate, re: recent.endDate, bs: baseline.startDate, be: baseline.endDate, min: minBaselineClicks });

  return rows.map((r) => {
    // Normalise the baseline to a 28-day rate so the comparison is fair.
    const baselineRate = r.bd > 0 ? (r.bc / r.bd) * 28 : 0;
    const drop = A.dropPct(r.rc, baselineRate);
    return { ...r, baselineRate, drop };
  })
    // Same significance test as `declining`, but using the RAW baseline
    // count over its actual exposure (r.bd distinct days observed) against
    // the recent 28-day count — the two windows are different lengths
    // (~62 vs 28 days), which is exactly the case the old normalised-rate
    // heuristic couldn't handle cleanly but the Poisson rate-ratio test
    // handles natively (rates, not raw counts, are what get compared).
    .filter((r) => isSignificantRateDrop(r.bc, r.bd, r.rc, 28, { confidence, minRelativeDrop: minDropPct / 100 })
      && r.baselineRate >= minBaselineClicks * 0.5)
    .sort((a, b) => (b.baselineRate - b.rc) - (a.baselineRate - a.rc))
    .slice(0, limit)
    .map((r) => ({
      type: 'refresh',
      typeLabel: 'Content refresh',
      page: r.page,
      title: `Refresh decaying content: ${shortPath(r.page)}`,
      score: scoreOf(r.baselineRate - r.rc, {
        conversionMultiplier: S.conversionMultiplier(ctx && ctx.rates, r.page),
        // Slow decay is a reliable signal but recovery to full baseline is
        // optimistic, so this is discounted against a measured CTR gap.
        confidence: 0.8,
      }),
      expectedClicks: r.baselineRate - r.rc,
      scoreBasis: {
        unit: 'expected additional clicks per 28 days',
        expectedClicks: r.baselineRate - r.rc,
        conversionMultiplier: S.conversionMultiplier(ctx && ctx.rates, r.page),
        confidence: 0.8,
        note: 'Assumes a refresh restores the page to its own 90-day baseline.',
      },
      estimatedGain: `~${int(r.baselineRate - r.rc)} clicks per month back to baseline`,
      severity: (r.baselineRate - r.rc) >= 25 ? 'high' : 'medium',
      evidence: {
        page: r.page, recentClicks: r.rc, baseline28dRate: r.baselineRate,
        baselineWindow: baseline, recentWindow: recent, dropPct: r.drop,
      },
      summary: `Averaged ${int(r.baselineRate)} clicks per 28 days across ${baseline.startDate} → ${baseline.endDate}, but only ${int(r.rc)} in the last 28 days (${pct(r.drop)} below its own baseline). This is gradual decay rather than a sudden drop.`,
      action: 'Update the page for currency: refresh statistics and dates, add sections covering questions that have emerged since publication, remove anything now inaccurate, and re-check that it still matches what ranks today. Republish with an updated date.',
    }));
}

// 5. New-page opportunities — clusters with no page genuinely ABOUT them.
//
// This detector could not fire. It required `recommendation === 'Create new
// page'`, which clustering only emits when NO cluster member has a ranking
// URL — but the keywords are sourced from Search Console, so every one of them
// has a ranking URL by construction. Verified on the live brand: 457 of 457
// keywords had one, and the detector returned zero results on every run.
//
// The definition was wrong, not the threshold. "No page ranks for this" is
// unobservable from GSC; "no page is ABOUT this" is observable and is the
// question that actually matters. A cluster needs a new page when the URL
// currently collecting its impressions is only incidentally related to it —
// the homepage, a blog index, or a post on a different subject soaking up
// impressions it will never rank well for.
//
// Topical ownership is measured from the URL slug, which is always available
// and needs no crawl: if none of the cluster's distinctive keyword tokens
// appear in the owning URL's path, that URL is not about this topic.
const SLUG_STOPWORDS = new Set('the a an and or for of in to with your best top blog page post index html php htm category tag'.split(' '));

function slugTokens(url) {
  if (!url) return new Set();
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url); }
  return new Set(
    path.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !SLUG_STOPWORDS.has(t)),
  );
}

// Shares clustering's tokenizer so "services"/"service" match, and drops
// tokens too generic to prove a slug is about a topic.
const GENERIC_TOPIC_TOKENS = new Set('service services company companies agency agencies solution solutions provider providers business usa best top');

function keywordTokens(keyword, locale) {
  return clustering.tokenize(keyword, locale).filter((t) => !GENERIC_TOPIC_TOKENS.has(t));
}

function ownsTopic(url, primaryKeyword, locale) {
  const slug = slugTokens(url);
  if (!slug.size) return false;
  const kw = keywordTokens(primaryKeyword, locale);
  if (!kw.length) return false;
  const stemmedSlug = new Set([...slug].flatMap((t) => clustering.tokenize(t, locale)));
  const hits = kw.filter((t) => stemmedSlug.has(t)).length;
  // At least half the distinctive keyword tokens must appear in the slug for
  // the URL to count as being about this topic.
  return hits >= Math.ceil(kw.length / 2);
}

function newPageOpportunities(brandId, {
  limit = 15, vertical = 'other', locale = 'en', market = null,
  minImpressions = 100, maxOwnerPosition = 8,
} = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const keywords = clustering.keywordsFromGsc(brandId, { days: 90, minImpressions: 30, limit: 1200 });
  if (!keywords.length) return [];
  const result = clustering.cluster(keywords, {
    brandId, vertical, locale, market,
  });
  const terms = ctx && ctx.terms;

  return result.clusters
    .filter((c) => {
      if (c.totalImpressions < minImpressions) return false;
      if (S.isBrandedQuery(c.primaryKeyword, terms)) return false;
      // Clustering's own verdict still wins when it has one.
      if (c.recommendation === 'Create new page') return true;
      if (c.recommendation === 'Existing page — already strong') return false;
      // Otherwise: is the URL collecting these impressions actually about
      // this topic, and is it doing well enough to leave alone?
      if (!c.existingPage) return true;
      if (c.avgPosition != null && c.avgPosition <= maxOwnerPosition) return false;
      return !ownsTopic(c.existingPage, c.primaryKeyword, locale);
    })
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, limit)
    .map((c) => {
      const owner = c.existingPage;
      const incidental = owner && !ownsTopic(owner, c.primaryKeyword, locale);
      // Expected clicks if a dedicated page reached position 5, versus what
      // the cluster earns today. Converted to the standard 28-day window,
      // since these impressions are measured over 90 days — the old version
      // scored raw 90-day impressions against other detectors' 28-day clicks,
      // which is how it came to dominate the ranking.
      const impressions28 = per28Days(c.totalImpressions, 90);
      const currentClicks28 = per28Days(c.totalClicks, 90);
      const expected = Math.max(0, (expectedCtr(5, ctx && ctx.curve) * impressions28) - currentClicks28);
      return {
        type: 'new_page',
        typeLabel: 'New page',
        page: null,
        query: c.primaryKeyword,
        title: `New page: "${c.primaryKeyword}" (${c.keywordCount} keywords)`,
        // The most speculative estimate the engine makes: it assumes a page
        // that does not exist yet will rank. Discounted accordingly so it
        // cannot outrank measured opportunities of similar size.
        score: scoreOf(expected, { confidence: 0.5 }),
        expectedClicks: expected,
        scoreBasis: {
          unit: 'expected additional clicks per 28 days',
          expectedClicks: expected,
          confidence: 0.5,
          note: 'Assumes a new, dedicated page reaches position 5. Speculative by nature.',
        },
        estimatedGain: `~${int(expected)} extra clicks per 28 days if a dedicated page reaches position 5`,
        severity: expected >= 40 ? 'high' : (expected >= 10 ? 'medium' : 'low'),
        evidence: {
          cluster: c,
          impressions90d: c.totalImpressions,
          impressionsPer28d: impressions28,
          currentOwner: owner,
          ownerIsIncidental: incidental,
          ownerPosition: c.avgPosition,
        },
        summary: incidental
          ? `${c.keywordCount} related keywords totalling ${int(c.totalImpressions)} impressions over 90 days are currently collected by ${shortPath(owner)}, which is not a page about "${c.primaryKeyword}"${c.avgPosition != null ? ` and only reaches average position ${c.avgPosition.toFixed(1)}` : ''}. Intent reads as ${c.intent.toLowerCase()}${c.intentConfidence === 'low' ? ' (weak signal — verify)' : ''}.`
          : `${c.keywordCount} related keywords totalling ${int(c.totalImpressions)} impressions have no URL that owns them${c.avgPosition != null ? `, currently surfacing at average position ${c.avgPosition.toFixed(1)}` : ''}. Intent reads as ${c.intent.toLowerCase()}${c.intentConfidence === 'low' ? ' (weak signal — verify)' : ''}.`,
        action: `Commission a ${c.suggestedPageType.toLowerCase()}. Primary keyword: "${c.primaryKeyword}". Supporting keywords: ${c.supportingKeywords.slice(0, 8).join(', ')}${c.supportingKeywords.length > 8 ? `, and ${c.supportingKeywords.length - 8} more` : ''}.${incidental ? ` Impressions are currently landing on ${shortPath(owner)} — link the new page from it and make sure the two do not target the same phrasing.` : ''} Publishing requires SEO approval.`,
      };
    });
}

// 6. Cannibalisation — several URLs splitting one query.
function cannibalisation(brandId, { minImpressions = 100, minPages = 3, limit = 20 } = {}, ctx = null) {
  ctx = ensureCtx(brandId, ctx);
  const terms = ctx && ctx.terms;
  const rows = A.cannibalizedQueries(brandId, { minImpressions, minPages })
    // Several URLs ranking for your own company name is normal and correct,
    // not cannibalisation. On the live brand "american web builders" was being
    // filed as a high-severity finding with the second-highest score on the
    // whole backlog.
    .filter((r) => !S.isBrandedQuery(r.query, terms));

  // Group by the SET of competing pages, not by query.
  //
  // "web design services usa", "web design company usa", "web design usa" and
  // "web design us" over the same four URLs is one consolidation decision, and
  // it was producing four separate backlog items. Grouping turns it into a
  // single piece of work that lists every affected query.
  const groups = new Map();
  rows.forEach((r) => {
    const pages = String(r.pages).split(' | ').filter(Boolean).sort();
    const key = pages.join('||');
    if (!groups.has(key)) groups.set(key, { pages, queries: [], impressions: 0, clicks: 0 });
    const g = groups.get(key);
    g.queries.push({ query: r.query, impressions: r.impressions, clicks: r.clicks, pageCount: r.page_count });
    g.impressions += Number(r.impressions) || 0;
    g.clicks += Number(r.clicks) || 0;
  });

  return [...groups.values()]
    .map((g) => ({ ...g, queries: g.queries.sort((a, b) => b.impressions - a.impressions) }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((g) => {
      const lead = g.queries[0];
      const ctr = g.impressions > 0 ? g.clicks / g.impressions : 0;
      // Consolidation recovers the gap between what these queries earn while
      // split and what one focused page at the same average position would.
      // This is a genuine click estimate, in the same unit as every other
      // detector — previously this was raw impressions x1.5, which is why
      // cannibalisation occupied the entire top of the backlog.
      const avgPosition = lead.pageCount >= 5 ? 12 : 9;
      const achievable = expectedCtr(avgPosition, ctx && ctx.curve);
      const expected = Math.max(0, (achievable - ctr) * g.impressions);
      const convMult = S.conversionMultiplier(ctx && ctx.rates, g.pages[0]);
      return {
        type: 'cannibalisation',
        typeLabel: 'Cannibalisation',
        page: null,
        query: lead.query,
        queries: g.queries.map((q) => q.query),
        title: g.queries.length === 1
          ? `Consolidate ${g.pages.length} URLs competing for "${lead.query}"`
          : `Consolidate ${g.pages.length} URLs competing across ${g.queries.length} related queries`,
        score: scoreOf(expected, { conversionMultiplier: convMult, confidence: 0.6 }),
        expectedClicks: expected,
        scoreBasis: {
          unit: 'expected additional clicks per 28 days',
          expectedClicks: expected,
          conversionMultiplier: convMult,
          confidence: 0.6,
          note: 'Assumes consolidation lifts CTR to a normal rate for the position these URLs already hold.',
        },
        estimatedGain: `${int(g.impressions)} impressions are split across ${g.pages.length} URLs; consolidating is worth roughly ${int(expected)} clicks`,
        severity: g.pages.length >= 5 ? 'high' : 'medium',
        evidence: {
          queries: g.queries,
          pageCount: g.pages.length,
          impressions: g.impressions,
          clicks: g.clicks,
          pages: g.pages,
          brandedExcluded: true,
        },
        summary: `${g.pages.length} different URLs take impressions for ${g.queries.length === 1 ? `"${lead.query}"` : `${g.queries.length} closely related queries (led by "${lead.query}")`} — ${int(g.impressions)} impressions and ${int(g.clicks)} clicks in total — so ranking signals are split and Google is choosing between them.`,
        action: `Decide which single page should own ${g.queries.length === 1 ? 'this query' : 'this group of queries'}, then either differentiate the others onto genuinely different intents or consolidate them into the chosen page. Affected URLs: ${g.pages.slice(0, 5).map(shortPath).join(', ')}${g.pages.length > 5 ? `, and ${g.pages.length - 5} more` : ''}. Repoint internal links to the winner. Any redirect, canonical change or page removal requires SEO approval.`,
      };
    });
}

// Branded queries are filtered out: telling a writer to target the company's
// own name in a rewritten title is noise, and those queries' CTR is not
// representative of what the rewrite can achieve.
function topQueriesForPage(brandId, page, limit = 5, ctx = null) {
  const row = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(brandId);
  if (!row) return [];
  const rows = db.prepare(`SELECT query, impressions, clicks, position FROM gsc_query_page
    WHERE brand_id=? AND page=? AND period_start=? AND period_end=?
    ORDER BY impressions DESC LIMIT ?`)
    .all(brandId, page, row.period_start, row.period_end, limit * 3);
  const terms = ctx && ctx.terms;
  return rows.filter((r) => !S.isBrandedQuery(r.query, terms)).slice(0, limit);
}

function shortPath(u) {
  if (!u) return '(no URL)';
  try {
    const url = new URL(u);
    const p = url.pathname;
    return p === '/' ? '/ (homepage)' : (p.length > 60 ? `${p.slice(0, 60)}…` : p);
  } catch { return String(u).slice(0, 60); }
}

// ------------------------------------------------------------------ driver

// Runs every detector for a brand and returns one ranked list.
function analyse(brand, options = {}) {
  const brandId = brand.id;
  const ctx = buildContext(brand);
  const groups = {
    ctr_gap: safe(() => ctrGaps(brandId, options.ctrGap, ctx)),
    striking_distance: safe(() => strikingDistance(brandId, options.strikingDistance, ctx)),
    declining: safe(() => declining(brandId, options.declining, ctx)),
    refresh: safe(() => refreshCandidates(brandId, options.refresh, ctx)),
    new_page: safe(() => newPageOpportunities(brandId, {
      vertical: brand.vertical || 'other',
      locale: brand.locale || 'en',
      market: brand.market || null,
      ...options.newPage,
    }, ctx)),
    cannibalisation: safe(() => cannibalisation(brandId, options.cannibalisation, ctx)),
  };

  const all = Object.values(groups).flat().sort((a, b) => b.score - a.score);

  // Cross-detector view.
  //
  // One page can legitimately surface as a CTR gap, a decline AND a refresh
  // candidate — three findings, but one page to sit down and work on. The
  // detectors stay independent (each carries its own evidence), and this adds
  // the page-level roll-up so the backlog can show "this page has 3 signals"
  // instead of three unconnected rows.
  const byPage = new Map();
  all.forEach((o) => {
    if (!o.page) return;
    if (!byPage.has(o.page)) byPage.set(o.page, []);
    byPage.get(o.page).push(o);
  });
  const multiSignalPages = [...byPage.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([page, items]) => ({
      page,
      signals: items.map((i) => i.typeLabel),
      types: items.map((i) => i.type),
      combinedScore: items.reduce((s, i) => s + i.score, 0),
      combinedExpectedClicks: items.reduce((s, i) => s + (i.expectedClicks || 0), 0),
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore);

  // Tag each item so a UI can group without recomputing.
  const signalCount = new Map(multiSignalPages.map((p) => [p.page, p.signals.length]));
  all.forEach((o) => { o.pageSignalCount = o.page ? (signalCount.get(o.page) || 1) : 1; });

  return {
    brand: { id: brand.id, name: brand.name, site_url: brand.site_url },
    generatedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    total: all.length,
    opportunities: all,
    groups,
    multiSignalPages,
    // Stated so a reader knows what the scores rest on, rather than having to
    // infer it from the numbers.
    method: {
      scoreUnit: 'expected additional clicks per 28 days x conversion weight x confidence x 10',
      ctrBenchmark: ctx.curve.source,
      ctrFittedBuckets: ctx.curve.fittedCeilings || [],
      conversionWeighting: ctx.rates.hasData
        ? `GA4 landing-page conversion rate (site average ${(ctx.rates.siteRate * 100).toFixed(2)}%, ${ctx.rates.rateByPage.size} pages with enough sessions to score individually)`
        : 'unavailable — GA4 conversion data not present, all pages weighted equally',
      brandedQueriesExcluded: ctx.terms.phrases,
      dataAnchor: ctx.anchor,
      rawLatestDate: ctx.rawAnchor,
      anchorLagApplied: ctx.anchor !== ctx.rawAnchor
        ? `Windows end ${SAFE_ANCHOR_LAG_DAYS} days before the newest date held, because Search Console is still backfilling its most recent days and counting them produces false declines.`
        : 'No lag applied (insufficient history).',
      sitewideChangePct: ctx.sitewide ? ctx.sitewide.changePct : null,
    },
  };
}

function safe(fn) {
  try { return fn() || []; } catch (err) {
    console.error('[opportunities] detector failed:', err.message);
    return [];
  }
}

// Promotes opportunities into the task backlog.
function toTasks(brand, result, tasksLib, { limit = 40, types = null, reconcile = true } = {}) {
  let created = 0;
  // Every key emitted this run, so anything previously raised and absent now
  // can be retired instead of lingering in the backlog forever.
  const emittedKeys = [];
  result.opportunities
    .filter((o) => !types || types.includes(o.type))
    .slice(0, limit)
    .forEach((o) => {
      const detail = [
        o.summary,
        '',
        `Estimated gain: ${o.estimatedGain}`,
        '',
        'Recommended action:',
        o.action,
        '',
        o.page ? `Page: ${o.page}` : null,
        o.query ? `Keyword: ${o.query}` : null,
        `Opportunity type: ${o.typeLabel} · priority score ${o.score}`,
      ].filter((x) => x !== null).join('\n');

      const dedupeKey = `task:opp:${brand.id}:${o.type}:${o.page || o.query}`;
      emittedKeys.push(dedupeKey);
      const r = tasksLib.upsertTask({
        userId: brand.user_id,
        brandId: brand.id,
        title: o.title,
        detail,
        source: 'opportunity',
        sourceRef: o.type,
        category: o.type === 'cannibalisation' ? 'Internal linking' : 'Content',
        severity: o.severity,
        affectedUrl: o.page || null,
        evidence: o.evidence,
        // Keyed on the target rather than the period, so one page produces one
        // ongoing task instead of a fresh one every week.
        dedupeKey,
      });
      if (r.created) created += 1;
    });

  // Retire opportunities that no longer exist. Skipped when `types` is set,
  // because a filtered run only knows about some of the findings and must not
  // conclude that the ones it did not look for have gone away.
  let retired = null;
  if (reconcile && !types && typeof tasksLib.reconcile === 'function') {
    retired = tasksLib.reconcile(brand.user_id, brand.id, 'opportunity', emittedKeys, {
      sourceRef: `the content opportunity run of ${new Date().toISOString().slice(0, 10)}`,
      keyPrefix: `task:opp:${brand.id}:`,
    });
  }
  return { created, retired, createdCount: created };
}

module.exports = {
  analyse, toTasks, ctrGaps, strikingDistance, declining,
  refreshCandidates, newPageOpportunities, cannibalisation, expectedCtr,
  isSignificantRateDrop, zCriticalOneTailed,
};
