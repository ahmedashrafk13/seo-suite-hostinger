// Shared deterministic signals used by the opportunity engine, clustering and
// the content brief.
//
// Everything here is computed from data the app already holds (GSC + GA4 +
// brand settings). There are no external calls and no AI in this module: it
// exists specifically so the non-AI path can stand on its own, and so the
// three engines stop each inventing their own version of "is this a brand
// term?" or "what CTR should this position earn?".
const db = require('../db');

// --------------------------------------------------------------- brand terms
//
// Branded queries behave nothing like non-branded ones: they convert at
// multiples of the rate, they earn 3-10x the CTR at the same position, and
// several URLs ranking for your own company name is normal rather than
// cannibalisation. Mixing them into CTR-gap, striking-distance and
// cannibalisation detection corrupts all three, so every detector now has a
// consistent way to identify and exclude them.
//
// Derivation is deliberately conservative and needs no configuration: the
// brand's own name plus its registrable domain label, reduced to the tokens
// that actually identify it. Generic words inside a brand name ("american
// web builders" -> "web", "builders") are NOT treated as brand tokens on
// their own, because doing so would wrongly mark half the site's commercial
// keywords as branded. A query counts as branded when it contains the full
// brand phrase, the domain label, or a distinctive (non-generic) brand token.
const GENERIC_BRAND_TOKENS = new Set(`
  the and for web webs website websites design designs designer designers
  development developer developers digital marketing media group inc llc ltd
  co company companies agency agencies studio studios solutions services
  service builders builder consulting partners global online international
  usa us uk american america national
`.trim().split(/\s+/));

function domainLabel(siteUrl) {
  if (!siteUrl) return null;
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./i, '');
    const label = host.split('.')[0];
    return label && label.length > 2 ? label.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Returns { phrases: [...], tokens: Set, label } — phrases are matched as
// substrings, tokens as whole words.
function brandTerms(brand) {
  const phrases = [];
  const tokens = new Set();

  const name = String((brand && brand.name) || '').toLowerCase().trim();
  if (name.length > 2) {
    phrases.push(name);
    // "American Web Builders" -> also match "americanwebbuilders"
    const squashed = name.replace(/[^a-z0-9]/g, '');
    if (squashed.length > 4) phrases.push(squashed);
    name.split(/[^a-z0-9]+/).forEach((t) => {
      if (t.length > 2 && !GENERIC_BRAND_TOKENS.has(t)) tokens.add(t);
    });
  }

  const label = domainLabel(brand && brand.site_url);
  if (label) {
    phrases.push(label);
    if (!GENERIC_BRAND_TOKENS.has(label)) tokens.add(label);
  }

  return { phrases: [...new Set(phrases)], tokens, label };
}

function isBrandedQuery(query, terms) {
  if (!terms) return false;
  const q = String(query || '').toLowerCase();
  if (!q) return false;
  const squashed = q.replace(/[^a-z0-9]/g, '');
  for (const p of terms.phrases) {
    if (p.includes(' ')) { if (q.includes(p)) return true; } else if (squashed.includes(p)) return true;
  }
  if (terms.tokens.size) {
    for (const t of q.split(/[^a-z0-9]+/)) {
      if (terms.tokens.has(t)) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------- CTR by position
//
// The generic fallback curve. Industry-typical organic CTR, used only when a
// brand has too little history to fit its own.
const GENERIC_CTR_BY_POSITION = [
  [1, 0.28], [2, 0.15], [3, 0.11], [4, 0.08], [5, 0.06],
  [6, 0.05], [7, 0.04], [8, 0.033], [9, 0.028], [10, 0.025],
  [15, 0.015], [20, 0.01], [30, 0.006], [50, 0.003], [100, 0.001],
];

function lookupCurve(curve, position) {
  if (position == null) return 0.01;
  for (let i = 0; i < curve.length; i++) {
    if (position <= curve[i][0]) return curve[i][1];
  }
  return 0.001;
}

// Fits this brand's OWN observed CTR-by-position curve from its Search Console
// history, excluding branded queries.
//
// Why this is materially better than the generic curve:
//   - It reflects the brand's actual SERP environment. If every query it
//     ranks for carries an AI Overview, an ads block or a local pack, the
//     achievable CTR at position 3 is not 11% and a generic curve would
//     manufacture a permanent, uncloseable "CTR gap" on every page.
//   - It is fitted on WEIGHTED-AVERAGE positions and then applied to
//     weighted-average positions. That self-consistency cancels most of the
//     Jensen-inequality bias you get from feeding an averaged position into a
//     curve built for true positions (a page averaging 8.0 may be #3 half the
//     time and #13 the rest; the generic curve mis-prices that, a curve
//     fitted on the same kind of averaged data does not).
//
// Buckets with too little data fall back to the generic curve value, and the
// result is forced to be monotonically non-increasing, since a fitted curve
// that says position 7 out-earns position 4 is noise, not signal.
// A raw empirical fit is degenerate at the tail. On the live brand, positions
// 20/30/50/100 had thousands of impressions and zero clicks, so the fitted CTR
// was exactly 0.0000 — which asserts "a page at position 18 should earn no
// clicks" and makes CTR gaps mathematically undetectable across the entire
// range where most of that site actually ranks. The detector silently returned
// nothing.
//
// Fixed with Beta-Binomial shrinkage: each bucket is pulled toward the generic
// curve in proportion to how little data supports it.
//
//   fitted = (clicks + PRIOR * generic) / (impressions + PRIOR)
//
// A bucket with 5,000 impressions and 0 clicks still lands well below the
// generic value (it genuinely underperforms) but never at zero, and a bucket
// with 200 impressions barely moves off generic. This also removes the need
// for a hard sample cutoff: small samples shrink to the fallback on their own.
const SHRINKAGE_PRIOR_IMPRESSIONS = 1000;
const MIN_IMPRESSIONS_PER_BUCKET = 200;
const MIN_BUCKETS_TO_TRUST = 4;

function ctrCurve(brandId, brand, { days = 180 } = {}) {
  const generic = { curve: GENERIC_CTR_BY_POSITION, source: 'generic', buckets: 0 };
  if (!brandId) return generic;

  const anchor = db.prepare('SELECT MAX(date) d FROM gsc_query_daily WHERE brand_id=?').get(brandId);
  if (!anchor || !anchor.d) return generic;
  const end = anchor.d;
  const startD = new Date(`${end}T00:00:00Z`);
  startD.setUTCDate(startD.getUTCDate() - (days - 1));
  const start = startD.toISOString().slice(0, 10);

  let rows;
  try {
    rows = db.prepare(`SELECT query,
        SUM(clicks) clicks, SUM(impressions) impressions,
        SUM(position*impressions)/NULLIF(SUM(impressions),0) position
      FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY query HAVING SUM(impressions) > 0`).all(brandId, start, end);
  } catch {
    return generic;
  }
  if (!rows.length) return generic;

  const terms = brandTerms(brand || {});
  const buckets = new Map(); // bucket ceiling -> {clicks, impressions}
  const bucketFor = (pos) => {
    if (pos <= 10) return Math.max(1, Math.ceil(pos));
    if (pos <= 15) return 15;
    if (pos <= 20) return 20;
    if (pos <= 30) return 30;
    if (pos <= 50) return 50;
    return 100;
  };

  rows.forEach((r) => {
    if (r.position == null || !(r.impressions > 0)) return;
    if (isBrandedQuery(r.query, terms)) return; // branded CTR would inflate the whole curve
    const b = bucketFor(Number(r.position));
    const cur = buckets.get(b) || { clicks: 0, impressions: 0 };
    cur.clicks += Number(r.clicks) || 0;
    cur.impressions += Number(r.impressions) || 0;
    buckets.set(b, cur);
  });

  const ceilings = GENERIC_CTR_BY_POSITION.map(([c]) => c);
  const fittedCeilings = [];
  const fitted = ceilings.map((c) => {
    const generic = lookupCurve(GENERIC_CTR_BY_POSITION, c);
    const b = buckets.get(c);
    if (b && b.impressions >= MIN_IMPRESSIONS_PER_BUCKET) {
      fittedCeilings.push(c);
      const shrunk = (b.clicks + (SHRINKAGE_PRIOR_IMPRESSIONS * generic))
        / (b.impressions + SHRINKAGE_PRIOR_IMPRESSIONS);
      return [c, shrunk];
    }
    return [c, generic];
  });

  if (fittedCeilings.length < MIN_BUCKETS_TO_TRUST) return generic;

  // Enforce monotonic non-increase from position 1 downward.
  for (let i = 1; i < fitted.length; i++) {
    if (fitted[i][1] > fitted[i - 1][1]) fitted[i][1] = fitted[i - 1][1];
  }

  // A brand can easily have enough data to fit the tail (positions 15-100)
  // while having almost no top-10 non-branded impressions. Calling the whole
  // curve "calibrated" in that case would overclaim, so the fitted buckets are
  // reported explicitly and `isFitted(position)` lets a caller state, per
  // finding, whether THAT position's expected CTR came from this brand's own
  // data or from the generic fallback.
  return {
    curve: fitted,
    source: 'brand-calibrated',
    buckets: fittedCeilings.length,
    fittedCeilings,
    window: { start, end },
  };
}

// -------------------------------------------------- branded share, per page
//
// The CTR curve is fitted on NON-branded queries, because branded CTR is
// several times higher and would inflate the whole benchmark. But page-level
// GSC data (gsc_page_daily) carries no branded/non-branded split, so comparing
// a page's total CTR — branded traffic included — against a non-branded
// benchmark understates every gap and can hide real ones entirely.
//
// gsc_query_page holds query AND page together, so the branded share of a
// page's impressions and clicks can be measured there and applied to the
// window totals. Returns a Map of page -> { impressionShare, clickShare }.
// Pages absent from the snapshot are simply not in the map, and the caller
// falls back to raw totals at reduced confidence.
function brandedShareByPage(brandId, brand) {
  const out = new Map();
  if (!brandId) return out;
  const period = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(brandId);
  if (!period) return out;

  let rows;
  try {
    rows = db.prepare(`SELECT page, query, impressions, clicks FROM gsc_query_page
      WHERE brand_id=? AND period_start=? AND period_end=?`)
      .all(brandId, period.period_start, period.period_end);
  } catch {
    return out;
  }
  if (!rows.length) return out;

  const terms = brandTerms(brand || {});
  const totals = new Map();
  rows.forEach((r) => {
    const cur = totals.get(r.page) || { imp: 0, clicks: 0, bImp: 0, bClicks: 0 };
    const imp = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    cur.imp += imp;
    cur.clicks += clicks;
    if (isBrandedQuery(r.query, terms)) { cur.bImp += imp; cur.bClicks += clicks; }
    totals.set(r.page, cur);
  });

  totals.forEach((v, page) => {
    out.set(page, {
      impressionShare: v.imp > 0 ? v.bImp / v.imp : 0,
      clickShare: v.clicks > 0 ? v.bClicks / v.clicks : 0,
      sampleImpressions: v.imp,
    });
  });
  return out;
}

// ------------------------------------------------------- GA4 conversion value
//
// Ranking opportunities by clicks treats a click on a pricing page and a click
// on a glossary entry as equal. They are not. Where GA4 is connected, this
// returns a per-landing-page conversion rate so the opportunity engine can
// weight expected clicks by the chance they turn into something the business
// cares about.
//
// Returns { rateByPage: Map, siteRate, hasData }. Pages with too few sessions
// to estimate fall back to the site rate, so a low-traffic page is never
// pushed to the bottom of the backlog purely for lack of GA4 history.
const MIN_SESSIONS_FOR_PAGE_RATE = 30;

function conversionRates(brandId, { days = 90 } = {}) {
  const empty = { rateByPage: new Map(), siteRate: 0, hasData: false };
  if (!brandId) return empty;

  const anchor = db.prepare('SELECT MAX(date) d FROM ga4_page_daily WHERE brand_id=?').get(brandId);
  if (!anchor || !anchor.d) return empty;
  const end = anchor.d;
  const startD = new Date(`${end}T00:00:00Z`);
  startD.setUTCDate(startD.getUTCDate() - (days - 1));
  const start = startD.toISOString().slice(0, 10);

  let rows;
  try {
    rows = db.prepare(`SELECT page_path, SUM(sessions) sessions, SUM(conversions) conversions
      FROM ga4_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY page_path`).all(brandId, start, end);
  } catch {
    return empty;
  }
  if (!rows.length) return empty;

  let totalSessions = 0;
  let totalConversions = 0;
  rows.forEach((r) => {
    totalSessions += Number(r.sessions) || 0;
    totalConversions += Number(r.conversions) || 0;
  });
  if (totalSessions <= 0 || totalConversions <= 0) return { ...empty, hasData: false };

  const siteRate = totalConversions / totalSessions;
  const rateByPage = new Map();
  rows.forEach((r) => {
    const s = Number(r.sessions) || 0;
    if (s >= MIN_SESSIONS_FOR_PAGE_RATE) {
      rateByPage.set(String(r.page_path), (Number(r.conversions) || 0) / s);
    }
  });

  return { rateByPage, siteRate, hasData: true, window: { start, end } };
}

// Path-only key so a GSC page URL can be looked up against GA4's page_path.
function pathOf(url) {
  if (!url) return null;
  try { return new URL(url).pathname; } catch { return String(url); }
}

// Multiplier in roughly 0.5..2.0 expressing how much more (or less) valuable a
// click on this page is than an average click on the site. Deliberately
// bounded: conversion data is noisy, and it should tilt the ranking, never
// dominate it.
function conversionMultiplier(rates, page) {
  if (!rates || !rates.hasData || !page || rates.siteRate <= 0) return 1;
  const rate = rates.rateByPage.get(pathOf(page));
  if (rate == null) return 1;
  const ratio = rate / rates.siteRate;
  return Math.max(0.5, Math.min(2, ratio));
}

// ------------------------------------------------------------ sitewide control
//
// A page down 30% during a month when the whole site is down 30% is not a
// declining page — it is a declining site, and filing 30 page-level tasks for
// it buries the one finding that matters. This returns the brand's overall
// click change across the same windows so detectors can report a page's
// change RELATIVE to the site.
function sitewideClickChange(brandId, days, { endOffset = 0 } = {}) {
  const anchor = db.prepare('SELECT MAX(date) d FROM gsc_daily WHERE brand_id=?').get(brandId);
  if (!anchor || !anchor.d) return null;
  const win = (offset) => {
    const end = new Date(`${anchor.d}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - offset);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
  };
  const recent = win(endOffset);
  const prior = win(endOffset + days);
  const sum = (w) => {
    const r = db.prepare('SELECT COALESCE(SUM(clicks),0) c FROM gsc_daily WHERE brand_id=? AND date BETWEEN ? AND ?')
      .get(brandId, w.startDate, w.endDate);
    return Number(r.c) || 0;
  };
  const recentClicks = sum(recent);
  const priorClicks = sum(prior);
  if (priorClicks <= 0) return null;
  return {
    recentClicks,
    priorClicks,
    ratio: recentClicks / priorClicks, // < 1 means the whole site is down
    changePct: ((recentClicks - priorClicks) / priorClicks) * 100,
  };
}

// Was the expected CTR for this position fitted from the brand's own data, or
// taken from the generic fallback? Detectors surface this so an estimate is
// never presented as brand-specific when it isn't.
function ctrIsFitted(curveInfo, position) {
  if (!curveInfo || curveInfo.source !== 'brand-calibrated' || position == null) return false;
  const ceilings = curveInfo.fittedCeilings || [];
  for (let i = 0; i < curveInfo.curve.length; i++) {
    if (position <= curveInfo.curve[i][0]) return ceilings.includes(curveInfo.curve[i][0]);
  }
  return false;
}

module.exports = {
  brandTerms, isBrandedQuery, domainLabel, brandedShareByPage,
  ctrCurve, lookupCurve, ctrIsFitted, GENERIC_CTR_BY_POSITION,
  conversionRates, conversionMultiplier, pathOf,
  sitewideClickChange,
  GENERIC_BRAND_TOKENS,
};
