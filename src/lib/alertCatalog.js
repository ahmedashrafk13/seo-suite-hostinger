// THE ALERT CATALOG
//
// Every alert the system can raise, declared in one place. The user browses
// this catalog, switches on the ones they want per brand, and sets their own
// threshold, comparison window, cadence and channels. Nothing here fires
// unless a matching row exists in `alert_subscriptions`.
//
// Each entry declares:
//   key          stable id, stored on the subscription
//   label        human name
//   group        catalog section in the UI
//   description  what it catches and why it matters
//   sources      which connected data source it needs
//   requires     gate: subscription is unusable until the brand has this
//   severity     default severity (user may override)
//   positive     true for good-news alerts (wins worth acting on)
//   params       the knobs the user sets, with sane defaults
//   evaluate     (ctx) => findings[]
//
// An evaluator returns zero or more findings:
//   { dedupe, title, message, affected[], action, severity?, evidence{} }
// `dedupe` must be stable for "the same problem in the same period" so an
// hourly scheduler cannot spam the same finding, but must change next period
// so a persisting problem is re-raised.
const db = require('../db');
const A = require('./analytics');

// ------------------------------------------------------------- formatting
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const pct1 = (n) => `${(Number(n) || 0).toFixed(1)}%`;
const pp2 = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const pos1 = (n) => (n == null ? 'n/a' : Number(n).toFixed(1));
const short = (u, max = 70) => {
  const s = String(u || '');
  try {
    const url = new URL(s);
    const p = url.pathname + (url.search || '');
    const out = p === '/' ? '/ (homepage)' : p;
    return out.length > max ? `${out.slice(0, max)}…` : out;
  } catch {
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
};

// A period token that changes when the comparison window moves, so a finding
// re-raises next week but not twice in the same week.
const periodToken = (cmp) => (cmp ? `${cmp.recent.startDate}_${cmp.recent.endDate}` : 'na');

// ------------------------------------------------------- shared param specs
const WINDOW_PARAM = {
  key: 'windowDays', label: 'Comparison window', type: 'select', default: 7,
  options: [
    { value: 7, label: '7 days vs previous 7' },
    { value: 14, label: '14 days vs previous 14' },
    { value: 28, label: '28 days vs previous 28' },
  ],
  help: 'Recent period compared against the equally long period before it.',
};

const MIN_CLICKS_PARAM = (def = 10) => ({
  key: 'minPriorClicks', label: 'Ignore below', type: 'number', default: def, unit: 'clicks in prior period',
  help: 'Suppresses noise from pages that barely had traffic to begin with.',
});

const MIN_IMPR_PARAM = (def = 100) => ({
  key: 'minPriorImpressions', label: 'Ignore below', type: 'number', default: def, unit: 'impressions in prior period',
  help: 'Suppresses noise from very low-volume pages or keywords.',
});

const MAX_ITEMS_PARAM = {
  key: 'maxItems', label: 'Report at most', type: 'number', default: 15, unit: 'items per alert',
  help: 'Caps how many pages or keywords are listed in one notification.',
};

const CATALOG = [];
function define(entry) { CATALOG.push(entry); return entry; }

// =========================================================================
// GROUP 1 — Organic traffic and visibility (Search Console, site level)
// =========================================================================

define({
  key: 'gsc_clicks_drop',
  label: 'Organic clicks dropped',
  group: 'Traffic & visibility',
  description: 'Total Search Console clicks fell by more than your threshold versus the previous equal-length period. The primary "something is wrong" signal.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'daily',
  params: [
    { key: 'dropPct', label: 'Alert when clicks fall by at least', type: 'number', default: 20, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorClicks', label: 'Only if prior period had at least', type: 'number', default: 20, unit: 'clicks' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.gscComparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.clicks < params.minPriorClicks) return [];
    const drop = A.dropPct(recent.clicks, prior.clicks);
    if (drop < params.dropPct) return [];
    return [{
      dedupe: `${brand.id}:gsc_clicks_drop:${periodToken(cmp)}`,
      title: `Organic clicks down ${pct1(drop)}`,
      message: `Search Console clicks fell from ${int(prior.clicks)} (${prior.startDate} → ${prior.endDate}) to ${int(recent.clicks)} (${recent.startDate} → ${recent.endDate}), a drop of ${pct1(drop)}. Impressions moved ${pct1(A.pctChange(recent.impressions, prior.impressions))} and average position went from ${pos1(prior.position)} to ${pos1(recent.position)}.`,
      affected: [brand.site_url],
      action: recent.impressions >= prior.impressions * 0.95
        ? 'Impressions held steady while clicks fell — this looks like a CTR or SERP-feature problem rather than lost rankings. Review titles and meta descriptions on the top landing pages, and check whether an AI Overview or new ad block now sits above you.'
        : 'Impressions fell alongside clicks, which points to lost rankings or lost indexation. Compare page-level and query-level movement, then check indexation status on the biggest losers.',
      evidence: { recent, prior, drop },
    }];
  },
});

define({
  key: 'gsc_impressions_drop',
  label: 'Search impressions dropped',
  group: 'Traffic & visibility',
  description: 'Impressions fell sharply — usually the earliest sign of lost rankings, deindexation or a Google update, and it moves before clicks do.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'daily',
  params: [
    { key: 'dropPct', label: 'Alert when impressions fall by at least', type: 'number', default: 25, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorImpressions', label: 'Only if prior period had at least', type: 'number', default: 500, unit: 'impressions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.gscComparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.impressions < params.minPriorImpressions) return [];
    const drop = A.dropPct(recent.impressions, prior.impressions);
    if (drop < params.dropPct) return [];
    return [{
      dedupe: `${brand.id}:gsc_impressions_drop:${periodToken(cmp)}`,
      title: `Search impressions down ${pct1(drop)}`,
      message: `Impressions fell from ${int(prior.impressions)} to ${int(recent.impressions)} (${pct1(drop)}) comparing ${recent.startDate} → ${recent.endDate} against ${prior.startDate} → ${prior.endDate}. Average position moved from ${pos1(prior.position)} to ${pos1(recent.position)}.`,
      affected: [brand.site_url],
      action: 'Check for lost rankings on your highest-impression queries and confirm key pages are still indexed. If position held steady while impressions fell, search demand or SERP layout changed rather than your rankings.',
      evidence: { recent, prior, drop },
    }];
  },
});

define({
  key: 'gsc_ctr_drop',
  label: 'Site-wide CTR dropped',
  group: 'Traffic & visibility',
  description: 'Click-through rate fell while impressions stayed intact. Points at titles, meta descriptions, or a new SERP feature pushing you down the page.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPp', label: 'Alert when CTR falls by at least', type: 'number', default: 0.3, unit: 'percentage points', step: 0.05 },
    WINDOW_PARAM,
    { key: 'minPriorImpressions', label: 'Only if prior period had at least', type: 'number', default: 1000, unit: 'impressions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.gscComparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.impressions < params.minPriorImpressions) return [];
    const deltaPp = (prior.ctr - recent.ctr) * 100;
    if (deltaPp < params.dropPp) return [];
    return [{
      dedupe: `${brand.id}:gsc_ctr_drop:${periodToken(cmp)}`,
      title: `Site CTR down ${deltaPp.toFixed(2)} points`,
      message: `CTR fell from ${pp2(prior.ctr * 100)} to ${pp2(recent.ctr * 100)} while impressions moved ${pct1(A.pctChange(recent.impressions, prior.impressions))}. That is ${int(Math.round(recent.impressions * (prior.ctr - recent.ctr)))} clicks lost to CTR alone.`,
      affected: [brand.site_url],
      action: 'Rewrite titles and meta descriptions on the highest-impression pages. Check the live SERP for the top queries — an AI Overview, ad block or new rich result may have taken the clicks.',
      evidence: { recent, prior, deltaPp },
    }];
  },
});

define({
  key: 'gsc_position_worsen',
  label: 'Average position worsened',
  group: 'Traffic & visibility',
  description: 'Site-wide average position slipped. A blunt but useful indicator of broad ranking loss, such as an algorithm update landing.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'deltaPositions', label: 'Alert when average position worsens by at least', type: 'number', default: 3, unit: 'positions', step: 0.5 },
    WINDOW_PARAM,
    { key: 'minPriorImpressions', label: 'Only if prior period had at least', type: 'number', default: 500, unit: 'impressions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.gscComparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.impressions < params.minPriorImpressions) return [];
    const delta = recent.position - prior.position; // positive = worse
    if (delta < params.deltaPositions) return [];
    return [{
      dedupe: `${brand.id}:gsc_position_worsen:${periodToken(cmp)}`,
      title: `Average position worsened by ${delta.toFixed(1)}`,
      message: `Impression-weighted average position moved from ${pos1(prior.position)} to ${pos1(recent.position)} between ${prior.startDate} → ${prior.endDate} and ${recent.startDate} → ${recent.endDate}.`,
      affected: [brand.site_url],
      action: 'Identify which queries and pages lost the most positions. A broad slip across unrelated queries usually means an algorithm update; a slip concentrated on a few pages means a page-level problem.',
      evidence: { recent, prior, delta },
    }];
  },
});

define({
  key: 'gsc_clicks_floor',
  label: 'Organic clicks below a floor',
  group: 'Traffic & visibility',
  description: 'Absolute safety net: raise an alert whenever clicks in the window fall under a number you consider unacceptable, regardless of trend.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'minClicks', label: 'Alert when clicks in the window fall below', type: 'number', default: 50, unit: 'clicks' },
    WINDOW_PARAM,
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGscDate(brand.id);
    if (!anchor) return [];
    const w = A.windowFrom(anchor, params.windowDays);
    const cur = A.gscWindow(brand.id, w);
    if (cur.days === 0 || cur.clicks >= params.minClicks) return [];
    return [{
      dedupe: `${brand.id}:gsc_clicks_floor:${w.startDate}_${w.endDate}`,
      title: `Organic clicks below floor (${int(cur.clicks)} < ${int(params.minClicks)})`,
      message: `Only ${int(cur.clicks)} clicks in the ${params.windowDays} days ending ${w.endDate}, against your floor of ${int(params.minClicks)}. Impressions were ${int(cur.impressions)} at average position ${pos1(cur.position)}.`,
      affected: [brand.site_url],
      action: 'With impressions present but clicks this low, the problem is ranking depth or CTR rather than indexation. Prioritise the striking-distance keywords and CTR work on the top landing pages.',
      evidence: { current: cur, floor: params.minClicks },
    }];
  },
});

define({
  key: 'gsc_clicks_spike',
  label: 'Unusual traffic spike',
  group: 'Traffic & visibility',
  description: 'Impressions jumped far above normal. Often good news, but a sudden spike on unrelated queries can also mean a hacked site serving spam pages.',
  sources: ['Search Console'], requires: 'gsc', severity: 'low', positive: true,
  defaultFrequency: 'weekly',
  params: [
    { key: 'risePct', label: 'Alert when impressions rise by at least', type: 'number', default: 60, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorImpressions', label: 'Only if prior period had at least', type: 'number', default: 200, unit: 'impressions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.gscComparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.impressions < params.minPriorImpressions) return [];
    const rise = A.pctChange(recent.impressions, prior.impressions);
    if (!Number.isFinite(rise) || rise < params.risePct) return [];
    return [{
      dedupe: `${brand.id}:gsc_clicks_spike:${periodToken(cmp)}`,
      title: `Impressions up ${pct1(rise)}`,
      message: `Impressions rose from ${int(prior.impressions)} to ${int(recent.impressions)} (+${pct1(rise)}) and clicks moved from ${int(prior.clicks)} to ${int(recent.clicks)}.`,
      affected: [brand.site_url],
      action: 'Confirm the new impressions come from queries relevant to the business. If they are unrelated or in another language, check Search Console for a security issue and review recently indexed URLs for injected spam pages. If they are relevant, find the newly ranking pages and push them harder.',
      evidence: { recent, prior, rise },
    }];
  },
});

define({
  key: 'gsc_data_stalled',
  label: 'Search Console data stopped arriving',
  group: 'Data health',
  description: 'No new Search Console rows for several days. Catches a broken sync, a revoked OAuth token or a property that lost verification — silent failures that would otherwise disable every other alert.',
  sources: ['Search Console'], requires: 'gsc', severity: 'critical',
  defaultFrequency: 'daily',
  params: [
    { key: 'maxAgeDays', label: 'Alert when newest data is older than', type: 'number', default: 5, unit: 'days' },
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGscDate(brand.id);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (!anchor) {
      return [{
        dedupe: `${brand.id}:gsc_data_stalled:never:${A.isoDate(today)}`,
        title: 'No Search Console data has ever been synced',
        message: `Brand "${brand.name}" has no rows in the Search Console tables. Either the property is not linked, the sync has never run, or every sync attempt failed.`,
        affected: [brand.site_url],
        action: 'Open the brand, confirm a verified Search Console property is selected, then run "Sync now" and read the sync log for the underlying error.',
        evidence: { anchor: null },
      }];
    }
    const ageDays = Math.round((today - new Date(`${anchor}T00:00:00Z`)) / 86400000);
    if (ageDays <= params.maxAgeDays) return [];
    return [{
      dedupe: `${brand.id}:gsc_data_stalled:${anchor}:${A.isoDate(today)}`,
      title: `Search Console data is ${ageDays} days stale`,
      message: `The newest Search Console data held for "${brand.name}" is ${anchor}, which is ${ageDays} days old. Search Console itself lags about ${A.GSC_LAG_DAYS} days, so anything beyond that points at the sync.`,
      affected: [brand.site_url],
      action: 'Check the latest sync run for errors. The usual causes are an expired refresh token (reconnect Google), a property that lost verification, or exhausted API quota.',
      evidence: { anchor, ageDays },
    }];
  },
});

// =========================================================================
// GROUP 2 — Keyword and ranking movement (Search Console, query level)
// =========================================================================

define({
  key: 'keyword_rank_drop',
  label: 'Keyword rankings declined',
  group: 'Keywords & rankings',
  description: 'Individual queries lost meaningful position. The keyword-level counterpart to the site-wide position alert, and far more actionable.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'deltaPositions', label: 'Alert when a keyword drops by at least', type: 'number', default: 5, unit: 'positions', step: 0.5 },
    WINDOW_PARAM,
    MIN_IMPR_PARAM(100),
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.queryComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.positionDelta != null && r.positionDelta >= params.deltaPositions)
      .sort((a, b) => (b.positionDelta * b.priorImpressions) - (a.positionDelta * a.priorImpressions))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = rows[0] ? `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}` : 'na';
    return [{
      dedupe: `${brand.id}:keyword_rank_drop:${token}`,
      title: `${hits.length} keyword${hits.length === 1 ? '' : 's'} lost ${params.deltaPositions}+ positions`,
      message: `Comparing the ${params.windowDays} days to ${rows[0].windows.recent.endDate} against the previous ${params.windowDays}:\n\n${hits.map((h) => `• "${h.entity}" — position ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)} (${h.positionDelta.toFixed(1)} worse), ${int(h.priorImpressions)} → ${int(h.recentImpressions)} impressions`).join('\n')}`,
      affected: hits.map((h) => `"${h.entity}" (pos ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)})`),
      action: 'For each keyword, identify the ranking URL and check what changed: content edits, lost internal or external links, a competitor publishing something better, or cannibalisation from another page on your own site.',
      evidence: { hits: hits.map((h) => ({ query: h.entity, from: h.priorPosition, to: h.recentPosition, delta: h.positionDelta, priorImpressions: h.priorImpressions })) },
    }];
  },
});

define({
  key: 'keyword_lost_top10',
  label: 'Keyword fell out of the top 10',
  group: 'Keywords & rankings',
  description: 'A query that was ranking on page one has slipped to page two or beyond — where clicks essentially stop.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [WINDOW_PARAM, MIN_IMPR_PARAM(50), MAX_ITEMS_PARAM],
  evaluate({ brand, params }) {
    const rows = A.queryComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.priorPosition != null && r.priorPosition <= 10
        && (r.recentPosition == null || r.recentPosition > 10))
      .sort((a, b) => b.priorImpressions - a.priorImpressions)
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:keyword_lost_top10:${token}`,
      title: `${hits.length} keyword${hits.length === 1 ? '' : 's'} dropped off page one`,
      message: `These queries were in the top 10 and no longer are:\n\n${hits.map((h) => `• "${h.entity}" — ${pos1(h.priorPosition)} → ${h.recentPosition == null ? 'no impressions' : pos1(h.recentPosition)}, clicks ${int(h.priorClicks)} → ${int(h.recentClicks)}`).join('\n')}`,
      affected: hits.map((h) => `"${h.entity}" (${pos1(h.priorPosition)} → ${h.recentPosition == null ? 'gone' : pos1(h.recentPosition)})`),
      action: 'Page-one losses are the highest-value recoveries available. For each, pull up the ranking URL, compare it against whoever replaced you, and prioritise a content refresh plus internal links from your strongest related pages.',
      evidence: { hits: hits.map((h) => ({ query: h.entity, from: h.priorPosition, to: h.recentPosition, priorClicks: h.priorClicks })) },
    }];
  },
});

define({
  key: 'keyword_lost_top3',
  label: 'Keyword fell out of the top 3',
  group: 'Keywords & rankings',
  description: 'A top-3 position was lost. The three highest positions carry the large majority of clicks, so this is worth catching separately from a page-one loss.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [WINDOW_PARAM, MIN_IMPR_PARAM(30), MAX_ITEMS_PARAM],
  evaluate({ brand, params }) {
    const rows = A.queryComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.priorPosition != null && r.priorPosition <= 3
        && (r.recentPosition == null || r.recentPosition > 3))
      .sort((a, b) => b.priorClicks - a.priorClicks)
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:keyword_lost_top3:${token}`,
      title: `${hits.length} keyword${hits.length === 1 ? '' : 's'} lost a top-3 position`,
      message: hits.map((h) => `• "${h.entity}" — ${pos1(h.priorPosition)} → ${h.recentPosition == null ? 'no impressions' : pos1(h.recentPosition)}, clicks ${int(h.priorClicks)} → ${int(h.recentClicks)}`).join('\n'),
      affected: hits.map((h) => `"${h.entity}" (${pos1(h.priorPosition)} → ${h.recentPosition == null ? 'gone' : pos1(h.recentPosition)})`),
      action: 'Treat as urgent. Check the ranking URL is still indexed and unchanged, then look for a competitor who has just published or refreshed. These are usually recoverable within weeks if addressed quickly.',
      evidence: { hits: hits.map((h) => ({ query: h.entity, from: h.priorPosition, to: h.recentPosition, priorClicks: h.priorClicks })) },
    }];
  },
});

define({
  key: 'keyword_entered_top10',
  label: 'Keyword entered the top 10',
  group: 'Keywords & rankings',
  description: 'A query has just reached page one. Worth knowing because a small push at this moment often converts into a top-3 position.',
  sources: ['Search Console'], requires: 'gsc', severity: 'info', positive: true,
  defaultFrequency: 'weekly',
  params: [WINDOW_PARAM, MIN_IMPR_PARAM(50), MAX_ITEMS_PARAM],
  evaluate({ brand, params }) {
    const rows = A.queryComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.recentPosition != null && r.recentPosition <= 10
        && (r.priorPosition == null || r.priorPosition > 10))
      .sort((a, b) => b.recentImpressions - a.recentImpressions)
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:keyword_entered_top10:${token}`,
      title: `${hits.length} keyword${hits.length === 1 ? '' : 's'} reached page one`,
      message: hits.map((h) => `• "${h.entity}" — ${h.priorPosition == null ? 'unranked' : pos1(h.priorPosition)} → ${pos1(h.recentPosition)}, ${int(h.recentImpressions)} impressions, ${int(h.recentClicks)} clicks`).join('\n'),
      affected: hits.map((h) => `"${h.entity}" (now ${pos1(h.recentPosition)})`),
      action: 'Add internal links to the ranking page from your strongest related pages and tighten the title around the query. Newly page-one keywords respond faster to on-page work than established ones.',
      evidence: { hits: hits.map((h) => ({ query: h.entity, from: h.priorPosition, to: h.recentPosition })) },
    }];
  },
});

define({
  key: 'keyword_high_impressions_low_ctr',
  label: 'High impressions but low CTR',
  group: 'Keywords & rankings',
  description: 'Queries where you are seen a lot but rarely clicked. Usually a title, meta description or intent-mismatch problem, and the cheapest traffic available.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'minImpressions', label: 'At least', type: 'number', default: 300, unit: 'impressions in the window' },
    { key: 'maxCtr', label: 'And CTR below', type: 'number', default: 1, unit: '%', step: 0.1 },
    { key: 'maxPosition', label: 'And average position better than', type: 'number', default: 20, unit: '(ignore deep rankings)' },
    { key: 'windowDays', label: 'Window', type: 'select', default: 28, options: [{ value: 14, label: '14 days' }, { value: 28, label: '28 days' }, { value: 90, label: '90 days' }] },
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGscDate(brand.id);
    if (!anchor) return [];
    const w = A.windowFrom(anchor, params.windowDays);
    const rows = db.prepare(`SELECT query entity,
        SUM(clicks) clicks, SUM(impressions) impressions,
        SUM(position*impressions)/NULLIF(SUM(impressions),0) position
      FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY query
      HAVING SUM(impressions) >= ? AND SUM(position*impressions)/NULLIF(SUM(impressions),0) <= ?
      ORDER BY impressions DESC LIMIT 400`)
      .all(brand.id, w.startDate, w.endDate, params.minImpressions, params.maxPosition);
    const hits = rows
      .filter((r) => (r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0) < params.maxCtr)
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    return [{
      dedupe: `${brand.id}:keyword_high_impressions_low_ctr:${w.startDate}_${w.endDate}`,
      title: `${hits.length} keyword${hits.length === 1 ? '' : 's'} with high impressions and CTR under ${params.maxCtr}%`,
      message: hits.map((h) => {
        const ctr = h.impressions > 0 ? (h.clicks / h.impressions) * 100 : 0;
        const p = A.pageForQuery(brand.id, h.entity);
        return `• "${h.entity}" — ${int(h.impressions)} impressions, ${int(h.clicks)} clicks (${pp2(ctr)}), position ${pos1(h.position)}${p ? `, ranking: ${short(p.page)}` : ''}`;
      }).join('\n'),
      affected: hits.map((h) => `"${h.entity}" (${int(h.impressions)} impr, ${pp2(h.impressions > 0 ? (h.clicks / h.impressions) * 100 : 0)} CTR)`),
      action: 'Rewrite the title tag to lead with the query wording and the outcome the searcher wants, and write a meta description that answers the query directly. Where position is 4–10, a CTR fix often doubles clicks without any ranking change.',
      evidence: { window: w, hits },
    }];
  },
});

define({
  key: 'keyword_striking_distance',
  label: 'Keywords in striking distance (positions 4–20)',
  group: 'Keywords & rankings',
  description: 'Queries ranking just below the top three, where a modest improvement produces a disproportionate click gain. The core content-opportunity signal.',
  sources: ['Search Console'], requires: 'gsc', severity: 'low', positive: true,
  defaultFrequency: 'weekly',
  params: [
    { key: 'minPosition', label: 'Position from', type: 'number', default: 4 },
    { key: 'maxPosition', label: 'Position to', type: 'number', default: 20 },
    { key: 'minImpressions', label: 'At least', type: 'number', default: 100, unit: 'impressions in the window' },
    { key: 'windowDays', label: 'Window', type: 'select', default: 28, options: [{ value: 28, label: '28 days' }, { value: 90, label: '90 days' }] },
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGscDate(brand.id);
    if (!anchor) return [];
    const w = A.windowFrom(anchor, params.windowDays);
    const rows = db.prepare(`SELECT query entity,
        SUM(clicks) clicks, SUM(impressions) impressions,
        SUM(position*impressions)/NULLIF(SUM(impressions),0) position
      FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
      GROUP BY query
      HAVING SUM(impressions) >= ?
         AND SUM(position*impressions)/NULLIF(SUM(impressions),0) >= ?
         AND SUM(position*impressions)/NULLIF(SUM(impressions),0) <= ?
      ORDER BY impressions DESC LIMIT ?`)
      .all(brand.id, w.startDate, w.endDate, params.minImpressions, params.minPosition, params.maxPosition, params.maxItems);
    if (!rows.length) return [];
    return [{
      dedupe: `${brand.id}:keyword_striking_distance:${w.startDate}_${w.endDate}`,
      title: `${rows.length} keyword${rows.length === 1 ? '' : 's'} in striking distance`,
      message: rows.map((h) => {
        const p = A.pageForQuery(brand.id, h.entity);
        return `• "${h.entity}" — position ${pos1(h.position)}, ${int(h.impressions)} impressions, ${int(h.clicks)} clicks${p ? `, ranking: ${short(p.page)}` : ''}`;
      }).join('\n'),
      affected: rows.map((h) => `"${h.entity}" (pos ${pos1(h.position)}, ${int(h.impressions)} impr)`),
      action: 'For each, strengthen the ranking page: cover the sub-questions competitors answer and you do not, add internal links from related pages using the keyword as anchor text, and make sure the title targets the query directly.',
      evidence: { window: w, hits: rows },
    }];
  },
});

define({
  key: 'keyword_cannibalization',
  label: 'Keyword cannibalisation detected',
  group: 'Keywords & rankings',
  description: 'Several of your own URLs compete for the same query, splitting authority and letting Google pick the weaker page.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'monthly',
  params: [
    { key: 'minImpressions', label: 'Only queries with at least', type: 'number', default: 100, unit: 'impressions' },
    { key: 'minPages', label: 'And at least', type: 'number', default: 3, unit: 'competing URLs' },
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.cannibalizedQueries(brand.id, {
      minImpressions: params.minImpressions, minPages: params.minPages,
    }).slice(0, params.maxItems);
    if (!rows.length) return [];
    const period = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(brand.id);
    return [{
      dedupe: `${brand.id}:keyword_cannibalization:${period.period_start}_${period.period_end}`,
      title: `${rows.length} quer${rows.length === 1 ? 'y' : 'ies'} with competing URLs`,
      message: rows.map((r) => `• "${r.query}" — ${r.page_count} URLs, ${int(r.impressions)} impressions:\n    ${String(r.pages).split(' | ').slice(0, 4).map(short).join('\n    ')}`).join('\n'),
      affected: rows.map((r) => `"${r.query}" (${r.page_count} URLs)`),
      action: 'Pick one canonical page per query. Consolidate the weaker pages into it or differentiate their focus, and repoint internal links to the chosen page. Do not simply add canonical tags without deciding the intent split first — and route any URL change or redirect through SEO approval.',
      evidence: { rows },
    }];
  },
});

// =========================================================================
// GROUP 3 — Landing page performance (Search Console, page level)
// =========================================================================

define({
  key: 'page_clicks_drop',
  label: 'High-value landing page losing clicks',
  group: 'Landing pages',
  description: 'Individual pages whose clicks fell sharply. Pinpoints where a site-wide dip actually originates.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPct', label: 'Alert when a page loses at least', type: 'number', default: 30, unit: '% of its clicks' },
    WINDOW_PARAM,
    MIN_CLICKS_PARAM(10),
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.pageComparison(brand.id, params.windowDays, { minPriorImpressions: 0 });
    const hits = rows
      .filter((r) => r.priorClicks >= params.minPriorClicks && r.clicksDropPct >= params.dropPct)
      .sort((a, b) => (b.priorClicks - b.recentClicks) - (a.priorClicks - a.recentClicks))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    const lost = hits.reduce((a, h) => a + (h.priorClicks - h.recentClicks), 0);
    return [{
      dedupe: `${brand.id}:page_clicks_drop:${token}`,
      title: `${hits.length} landing page${hits.length === 1 ? '' : 's'} lost clicks (${int(lost)} total)`,
      message: hits.map((h) => `• ${short(h.entity, 90)}\n    clicks ${int(h.priorClicks)} → ${int(h.recentClicks)} (${pct1(h.clicksDropPct)} down), impressions ${int(h.priorImpressions)} → ${int(h.recentImpressions)}, position ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)}`).join('\n'),
      affected: hits.map((h) => h.entity),
      action: 'For each page, separate the cause: if impressions held but clicks fell, it is CTR or a SERP feature; if impressions fell with position, it is ranking loss; if impressions went to zero, check indexation first.',
      evidence: { hits: hits.map((h) => ({ page: h.entity, priorClicks: h.priorClicks, recentClicks: h.recentClicks, drop: h.clicksDropPct, priorPosition: h.priorPosition, recentPosition: h.recentPosition })) },
    }];
  },
});

define({
  key: 'page_impressions_drop',
  label: 'Landing page losing impressions',
  group: 'Landing pages',
  description: 'Pages whose impressions collapsed — the earliest page-level warning, and the one that precedes click loss.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPct', label: 'Alert when a page loses at least', type: 'number', default: 40, unit: '% of its impressions' },
    WINDOW_PARAM,
    MIN_IMPR_PARAM(200),
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.pageComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.impressionsDropPct >= params.dropPct)
      .sort((a, b) => (b.priorImpressions - b.recentImpressions) - (a.priorImpressions - a.recentImpressions))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:page_impressions_drop:${token}`,
      title: `${hits.length} page${hits.length === 1 ? '' : 's'} lost 40%+ of impressions`,
      message: hits.map((h) => `• ${short(h.entity, 90)}\n    impressions ${int(h.priorImpressions)} → ${int(h.recentImpressions)} (${pct1(h.impressionsDropPct)} down), position ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)}`).join('\n'),
      affected: hits.map((h) => h.entity),
      action: 'Confirm each page is still indexed and canonicalised to itself, then check which queries it lost. A page losing impressions while holding position has lost query coverage, not rankings.',
      evidence: { hits: hits.map((h) => ({ page: h.entity, priorImpressions: h.priorImpressions, recentImpressions: h.recentImpressions, drop: h.impressionsDropPct })) },
    }];
  },
});

define({
  key: 'page_traffic_lost_entirely',
  label: 'Page stopped receiving traffic',
  group: 'Landing pages',
  description: 'A page that reliably earned clicks now has none at all. Strongly suggests deindexation, a broken URL, or an accidental redirect.',
  sources: ['Search Console'], requires: 'gsc', severity: 'critical',
  defaultFrequency: 'daily',
  params: [WINDOW_PARAM, MIN_CLICKS_PARAM(5), MAX_ITEMS_PARAM],
  evaluate({ brand, params }) {
    const rows = A.pageComparison(brand.id, params.windowDays, { minPriorImpressions: 0 });
    const hits = rows
      .filter((r) => r.priorClicks >= params.minPriorClicks && r.recentClicks === 0 && r.recentImpressions === 0)
      .sort((a, b) => b.priorClicks - a.priorClicks)
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:page_traffic_lost_entirely:${token}`,
      title: `${hits.length} page${hits.length === 1 ? '' : 's'} went from clicks to zero impressions`,
      message: hits.map((h) => `• ${short(h.entity, 90)} — had ${int(h.priorClicks)} clicks / ${int(h.priorImpressions)} impressions, now none at all`).join('\n'),
      affected: hits.map((h) => h.entity),
      action: 'Check each URL immediately: request it in a browser, confirm it returns 200, is not noindex, is not canonicalised elsewhere, and run it through Search Console URL Inspection. Zero impressions is almost always a technical fault rather than a ranking change.',
      evidence: { hits: hits.map((h) => ({ page: h.entity, priorClicks: h.priorClicks, priorImpressions: h.priorImpressions })) },
    }];
  },
});

define({
  key: 'page_rising',
  label: 'Page gaining traffic quickly',
  group: 'Landing pages',
  description: 'Pages with fast-growing clicks. Flags where momentum already exists, so effort can be concentrated where it compounds.',
  sources: ['Search Console'], requires: 'gsc', severity: 'info', positive: true,
  defaultFrequency: 'weekly',
  params: [
    { key: 'risePct', label: 'Alert when a page gains at least', type: 'number', default: 50, unit: '% more clicks' },
    WINDOW_PARAM,
    MIN_CLICKS_PARAM(5),
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.pageComparison(brand.id, params.windowDays, { minPriorImpressions: 0 });
    const hits = rows
      .filter((r) => r.priorClicks >= params.minPriorClicks
        && Number.isFinite(r.clicksChangePct) && r.clicksChangePct >= params.risePct)
      .sort((a, b) => (b.recentClicks - b.priorClicks) - (a.recentClicks - a.priorClicks))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:page_rising:${token}`,
      title: `${hits.length} page${hits.length === 1 ? '' : 's'} gaining clicks fast`,
      message: hits.map((h) => `• ${short(h.entity, 90)} — clicks ${int(h.priorClicks)} → ${int(h.recentClicks)} (+${pct1(h.clicksChangePct)}), position ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)}`).join('\n'),
      affected: hits.map((h) => h.entity),
      action: 'Double down while the page has momentum: expand it to cover adjacent queries it already gets impressions for, add internal links to it, and make sure it has a clear call to action.',
      evidence: { hits: hits.map((h) => ({ page: h.entity, priorClicks: h.priorClicks, recentClicks: h.recentClicks })) },
    }];
  },
});

define({
  key: 'page_ctr_drop',
  label: 'Landing page CTR dropped',
  group: 'Landing pages',
  description: 'A page still ranks and is still seen, but is clicked far less than before. Almost always a title/description or SERP-feature change.',
  sources: ['Search Console'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPp', label: 'Alert when a page CTR falls by at least', type: 'number', default: 1, unit: 'percentage points', step: 0.1 },
    WINDOW_PARAM,
    MIN_IMPR_PARAM(300),
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const rows = A.pageComparison(brand.id, params.windowDays, { minPriorImpressions: params.minPriorImpressions });
    const hits = rows
      .filter((r) => r.recentImpressions >= params.minPriorImpressions * 0.5
        && (r.priorCtr - r.recentCtr) * 100 >= params.dropPp)
      .sort((a, b) => (b.priorCtr - b.recentCtr) - (a.priorCtr - a.recentCtr))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    const token = `${rows[0].windows.recent.startDate}_${rows[0].windows.recent.endDate}`;
    return [{
      dedupe: `${brand.id}:page_ctr_drop:${token}`,
      title: `${hits.length} page${hits.length === 1 ? '' : 's'} lost CTR`,
      message: hits.map((h) => `• ${short(h.entity, 90)} — CTR ${pp2(h.priorCtr * 100)} → ${pp2(h.recentCtr * 100)}, position ${pos1(h.priorPosition)} → ${pos1(h.recentPosition)}, impressions ${int(h.priorImpressions)} → ${int(h.recentImpressions)}`).join('\n'),
      affected: hits.map((h) => h.entity),
      action: 'Compare each page\'s current title and meta description against what it had before. If nothing changed on your side, search the target query and look for a new AI Overview, ad block, or richer competitor snippet taking the click. Note that changing titles on high-performing pages needs SEO approval.',
      evidence: { hits: hits.map((h) => ({ page: h.entity, priorCtr: h.priorCtr, recentCtr: h.recentCtr })) },
    }];
  },
});

// =========================================================================
// GROUP 4 — Indexation and Search Console health
// =========================================================================

define({
  key: 'page_deindexed',
  label: 'Important page is no longer indexed',
  group: 'Indexation',
  description: 'Samples your top landing pages through the Search Console URL Inspection API and reports any that Google is not indexing. Catches accidental noindex, canonical mistakes and crawl blocks.',
  sources: ['Search Console (URL Inspection)'], requires: 'gsc', severity: 'critical',
  defaultFrequency: 'weekly',
  params: [
    { key: 'sampleSize', label: 'Check the top', type: 'number', default: 15, unit: 'pages by clicks', help: 'URL Inspection is quota-limited to roughly 2,000 calls per property per day, so this samples rather than sweeps.' },
    { key: 'windowDays', label: 'Rank pages by clicks over', type: 'select', default: 28, options: [{ value: 7, label: '7 days' }, { value: 28, label: '28 days' }, { value: 90, label: '90 days' }] },
  ],
  async evaluateAsync({ brand, params, google }) {
    if (!brand.gsc_property) return [];
    const pages = A.topPages(brand.id, params.windowDays, params.sampleSize)
      .filter((p) => p.entity && /^https?:\/\//.test(p.entity));
    if (!pages.length) return [];

    const bad = [];
    const errors = [];
    for (const p of pages) {
      try {
        const r = await google.inspectUrl(brand.user_id, brand.gsc_property, p.entity);
        const idx = (r && r.indexStatusResult) || {};
        const verdict = idx.verdict; // PASS | PARTIAL | FAIL | NEUTRAL
        if (verdict && verdict !== 'PASS') {
          bad.push({
            page: p.entity, clicks: p.clicks, verdict,
            coverageState: idx.coverageState || null,
            robotsTxtState: idx.robotsTxtState || null,
            indexingState: idx.indexingState || null,
            googleCanonical: idx.googleCanonical || null,
            userCanonical: idx.userCanonical || null,
          });
        }
      } catch (err) {
        errors.push(`${short(p.entity)}: ${err.message}`);
      }
    }
    if (!bad.length) return [];
    const today = A.isoDate(new Date());
    return [{
      dedupe: `${brand.id}:page_deindexed:${today}`,
      title: `${bad.length} important page${bad.length === 1 ? '' : 's'} not indexed`,
      message: `${bad.length} of the top ${pages.length} pages by clicks are not currently indexed:\n\n${bad.map((b) => `• ${short(b.page, 90)} (${int(b.clicks)} clicks)\n    verdict: ${b.verdict}, coverage: ${b.coverageState || 'unknown'}${b.robotsTxtState && b.robotsTxtState !== 'ALLOWED' ? `, robots.txt: ${b.robotsTxtState}` : ''}${b.googleCanonical && b.userCanonical && b.googleCanonical !== b.userCanonical ? `\n    Google picked a different canonical: ${short(b.googleCanonical)}` : ''}`).join('\n')}${errors.length ? `\n\n(${errors.length} URL(s) could not be inspected: ${errors.slice(0, 3).join('; ')})` : ''}`,
      affected: bad.map((b) => b.page),
      action: 'Work through each URL: confirm it returns 200, carries no noindex, is allowed in robots.txt, and self-canonicalises. Where Google chose a different canonical, decide which URL should win before changing anything — canonical edits require SEO approval.',
      evidence: { checked: pages.length, bad, errors },
    }];
  },
});

define({
  key: 'indexed_page_count_drop',
  label: 'Number of pages earning impressions fell',
  group: 'Indexation',
  description: 'Counts distinct URLs receiving impressions and alerts when that count drops. A practical proxy for shrinking indexation that needs no quota.',
  sources: ['Search Console'], requires: 'gsc', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPct', label: 'Alert when the URL count falls by at least', type: 'number', default: 15, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorPages', label: 'Only if prior period had at least', type: 'number', default: 10, unit: 'URLs' },
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGscDate(brand.id);
    if (!anchor) return [];
    const { recent, prior } = A.comparisonWindows(anchor, params.windowDays);
    const countIn = (w) => db.prepare(
      'SELECT COUNT(DISTINCT page) n FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ? AND impressions > 0'
    ).get(brand.id, w.startDate, w.endDate).n;
    const r = countIn(recent);
    const p = countIn(prior);
    if (p < params.minPriorPages) return [];
    const drop = A.dropPct(r, p);
    if (drop < params.dropPct) return [];
    return [{
      dedupe: `${brand.id}:indexed_page_count_drop:${recent.startDate}_${recent.endDate}`,
      title: `URLs earning impressions fell ${pct1(drop)} (${int(p)} → ${int(r)})`,
      message: `${int(p)} distinct URLs earned impressions in ${prior.startDate} → ${prior.endDate}, but only ${int(r)} did in ${recent.startDate} → ${recent.endDate} — a ${pct1(drop)} reduction in the site's visible footprint.`,
      affected: [brand.site_url],
      action: 'Compare the two URL sets to see exactly which pages dropped out, then check the Pages report in Search Console for a rise in "Crawled – currently not indexed" or "Excluded by noindex". Also verify robots.txt and the sitemap have not changed.',
      evidence: { recentCount: r, priorCount: p, drop, recent, prior },
    }];
  },
});

define({
  key: 'sitemap_problems',
  label: 'Sitemap errors or warnings',
  group: 'Indexation',
  description: 'Reads the sitemaps Search Console has on file and reports parse errors, warnings, or sitemaps Google has not fetched in a long time.',
  sources: ['Search Console (Sitemaps)'], requires: 'gsc', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'maxStaleDays', label: 'Also alert if a sitemap has not been fetched in', type: 'number', default: 30, unit: 'days' },
  ],
  async evaluateAsync({ brand, params, google }) {
    if (!brand.gsc_property) return [];
    let sitemaps;
    try {
      sitemaps = await google.listSitemaps(brand.user_id, brand.gsc_property);
    } catch (err) {
      return [{
        dedupe: `${brand.id}:sitemap_problems:fetch-error:${A.isoDate(new Date())}`,
        title: 'Could not read sitemaps from Search Console',
        message: `The Sitemaps API returned an error for ${brand.gsc_property}: ${err.message}`,
        affected: [brand.gsc_property],
        action: 'Confirm the property is still verified and the connected Google account still has at least restricted access to it.',
        evidence: { error: err.message },
      }];
    }

    const today = new Date();
    const problems = [];
    if (!sitemaps.length) {
      problems.push({ path: brand.gsc_property, issue: 'No sitemap is submitted for this property at all' });
    }
    sitemaps.forEach((s) => {
      const errs = Number(s.errors || 0);
      const warns = Number(s.warnings || 0);
      if (errs > 0) problems.push({ path: s.path, issue: `${errs} error(s) reported by Google` });
      if (warns > 0) problems.push({ path: s.path, issue: `${warns} warning(s) reported by Google` });
      if (s.isPending) problems.push({ path: s.path, issue: 'Submitted but still pending processing' });
      if (s.lastDownloaded) {
        const age = Math.round((today - new Date(s.lastDownloaded)) / 86400000);
        if (age > params.maxStaleDays) {
          problems.push({ path: s.path, issue: `Not fetched by Google for ${age} days (last: ${String(s.lastDownloaded).slice(0, 10)})` });
        }
      } else {
        problems.push({ path: s.path, issue: 'Google has never successfully downloaded this sitemap' });
      }
    });
    if (!problems.length) return [];
    return [{
      dedupe: `${brand.id}:sitemap_problems:${A.isoDate(today)}`,
      title: `${problems.length} sitemap issue${problems.length === 1 ? '' : 's'}`,
      message: problems.map((p) => `• ${short(p.path, 90)}\n    ${p.issue}`).join('\n'),
      affected: problems.map((p) => p.path),
      action: 'Fix parse errors first, then remove URLs that 404, redirect, or are noindex from the sitemap — Google treats a dirty sitemap as a quality signal. Re-submit once clean. Sitemap and robots.txt changes require SEO approval.',
      evidence: { sitemaps, problems },
    }];
  },
});

define({
  key: 'gsc_manual_action',
  label: 'Manual action or security issue',
  group: 'Indexation',
  description: 'Checks whether Search Console reports a manual action or a security problem such as malware or hacked content. The most serious thing that can happen to a site.',
  sources: ['Search Console'], requires: 'gsc', severity: 'critical',
  defaultFrequency: 'daily',
  params: [],
  async evaluateAsync({ brand, params, google }) {
    // Google has never exposed manual actions or security issues on a public
    // API, so this is inferred rather than read: a manual action produces a
    // near-total, abrupt collapse in impressions across the whole property.
    // A confirmed answer still requires opening Search Console, which is
    // exactly what the suggested action says to do.
    const cmp = A.gscComparison(brand.id, 7);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.impressions < 200) return [];
    const drop = A.dropPct(recent.impressions, prior.impressions);
    if (drop < 80) return [];
    return [{
      dedupe: `${brand.id}:gsc_manual_action:${periodToken(cmp)}`,
      title: `Possible manual action — impressions collapsed ${pct1(drop)}`,
      message: `Impressions fell from ${int(prior.impressions)} to ${int(recent.impressions)} in one week (${pct1(drop)}). A collapse of this size across an entire property is the signature of a manual action, a security issue such as hacked content, or an accidental site-wide noindex or robots.txt block.\n\nNote: Google does not expose manual actions or security issues through any public API, so this alert is inferred from the traffic pattern and must be confirmed by hand.`,
      affected: [brand.site_url],
      action: 'Open Search Console now and check Security & Manual Actions directly. In parallel, fetch robots.txt and the homepage to rule out a site-wide noindex or Disallow, and confirm the site resolves and is not serving hacked content.',
      evidence: { recent, prior, drop, inferred: true },
    }];
  },
});

// =========================================================================
// GROUP 5 — Engagement and conversions (GA4)
// =========================================================================

define({
  key: 'ga4_organic_sessions_drop',
  label: 'Organic sessions dropped (GA4)',
  group: 'Engagement & conversions',
  description: 'GA4 organic-search sessions fell. Confirms from the analytics side whether a Search Console dip actually reached the site.',
  sources: ['GA4'], requires: 'ga4', severity: 'high',
  defaultFrequency: 'daily',
  params: [
    { key: 'dropPct', label: 'Alert when organic sessions fall by at least', type: 'number', default: 20, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorSessions', label: 'Only if prior period had at least', type: 'number', default: 30, unit: 'sessions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.ga4Comparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.sessions < params.minPriorSessions) return [];
    const drop = A.dropPct(recent.sessions, prior.sessions);
    if (drop < params.dropPct) return [];
    return [{
      dedupe: `${brand.id}:ga4_organic_sessions_drop:${recent.startDate}_${recent.endDate}`,
      title: `Organic sessions down ${pct1(drop)} (GA4)`,
      message: `GA4 organic-search sessions fell from ${int(prior.sessions)} to ${int(recent.sessions)} (${pct1(drop)}) comparing ${recent.startDate} → ${recent.endDate} with ${prior.startDate} → ${prior.endDate}. Conversions over the same periods: ${int(prior.conversions)} → ${int(recent.conversions)}.`,
      affected: [brand.site_url],
      action: 'Cross-check against Search Console clicks. If GSC clicks held but GA4 sessions fell, suspect tracking — a broken tag, consent-banner change or deployment. If both fell, it is a genuine search visibility loss.',
      evidence: { recent, prior, drop },
    }];
  },
});

define({
  key: 'ga4_conversions_drop',
  label: 'Organic conversions dropped (GA4)',
  group: 'Engagement & conversions',
  description: 'Conversions from organic traffic fell. The alert closest to actual revenue, and the one worth waking someone up for.',
  sources: ['GA4'], requires: 'ga4', severity: 'critical',
  defaultFrequency: 'daily',
  params: [
    { key: 'dropPct', label: 'Alert when organic conversions fall by at least', type: 'number', default: 25, unit: '%' },
    WINDOW_PARAM,
    { key: 'minPriorConversions', label: 'Only if prior period had at least', type: 'number', default: 5, unit: 'conversions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.ga4Comparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.conversions < params.minPriorConversions) return [];
    const drop = A.dropPct(recent.conversions, prior.conversions);
    if (drop < params.dropPct) return [];
    return [{
      dedupe: `${brand.id}:ga4_conversions_drop:${recent.startDate}_${recent.endDate}`,
      title: `Organic conversions down ${pct1(drop)}`,
      message: `Conversions from organic search fell from ${int(prior.conversions)} to ${int(recent.conversions)} (${pct1(drop)}). Sessions over the same periods moved ${int(prior.sessions)} → ${int(recent.sessions)}, so conversion rate went from ${pp2(prior.conv_rate * 100)} to ${pp2(recent.conv_rate * 100)}.`,
      affected: [brand.site_url],
      action: A.dropPct(recent.sessions, prior.sessions) >= params.dropPct * 0.6
        ? 'Sessions fell by a similar amount, so this is a traffic problem rather than a conversion problem — chase the organic visibility loss.'
        : 'Sessions held up while conversions fell, so the funnel itself broke. Test the primary conversion path end to end and verify the conversion event is still firing.',
      evidence: { recent, prior, drop },
    }];
  },
});

define({
  key: 'ga4_conversion_rate_drop',
  label: 'Organic conversion rate dropped (GA4)',
  group: 'Engagement & conversions',
  description: 'Traffic held but converted worse. Isolates on-site or funnel problems from search visibility problems.',
  sources: ['GA4'], requires: 'ga4', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPp', label: 'Alert when conversion rate falls by at least', type: 'number', default: 1, unit: 'percentage points', step: 0.1 },
    WINDOW_PARAM,
    { key: 'minPriorSessions', label: 'Only if prior period had at least', type: 'number', default: 100, unit: 'sessions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.ga4Comparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.sessions < params.minPriorSessions) return [];
    const deltaPp = (prior.conv_rate - recent.conv_rate) * 100;
    if (deltaPp < params.dropPp) return [];
    return [{
      dedupe: `${brand.id}:ga4_conversion_rate_drop:${recent.startDate}_${recent.endDate}`,
      title: `Organic conversion rate down ${deltaPp.toFixed(2)} points`,
      message: `Conversion rate on organic sessions fell from ${pp2(prior.conv_rate * 100)} to ${pp2(recent.conv_rate * 100)} while sessions moved ${int(prior.sessions)} → ${int(recent.sessions)}.`,
      affected: [brand.site_url],
      action: 'Walk the conversion path on mobile and desktop, confirm forms submit and the conversion event fires, and check whether the traffic mix shifted toward lower-intent queries.',
      evidence: { recent, prior, deltaPp },
    }];
  },
});

define({
  key: 'ga4_engagement_drop',
  label: 'Engagement rate dropped (GA4)',
  group: 'Engagement & conversions',
  description: 'A falling share of engaged sessions suggests arriving visitors are not finding what the search result promised — an intent-mismatch or page-experience signal.',
  sources: ['GA4'], requires: 'ga4', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPp', label: 'Alert when engagement rate falls by at least', type: 'number', default: 8, unit: 'percentage points', step: 1 },
    WINDOW_PARAM,
    { key: 'minPriorSessions', label: 'Only if prior period had at least', type: 'number', default: 100, unit: 'sessions' },
  ],
  evaluate({ brand, params }) {
    const cmp = A.ga4Comparison(brand.id, params.windowDays);
    if (!cmp) return [];
    const { recent, prior } = cmp;
    if (prior.sessions < params.minPriorSessions) return [];
    const deltaPp = (prior.engagement_rate - recent.engagement_rate) * 100;
    if (deltaPp < params.dropPp) return [];
    return [{
      dedupe: `${brand.id}:ga4_engagement_drop:${recent.startDate}_${recent.endDate}`,
      title: `Engagement rate down ${deltaPp.toFixed(1)} points`,
      message: `Engaged-session rate for organic traffic fell from ${pct1(prior.engagement_rate * 100)} to ${pct1(recent.engagement_rate * 100)} across ${int(recent.sessions)} sessions.`,
      affected: [brand.site_url],
      action: 'Check whether new queries are sending mismatched traffic, and review load performance and above-the-fold content on the top landing pages. A sharp engagement drop with stable traffic often follows a design or speed regression.',
      evidence: { recent, prior, deltaPp },
    }];
  },
});

define({
  key: 'ga4_landing_page_drop',
  label: 'Landing page losing organic sessions (GA4)',
  group: 'Engagement & conversions',
  description: 'Page-level GA4 view of organic session loss, which catches pages where the click happened but the visit did not — a signal Search Console cannot give you.',
  sources: ['GA4'], requires: 'ga4', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPct', label: 'Alert when a landing page loses at least', type: 'number', default: 35, unit: '% of its sessions' },
    WINDOW_PARAM,
    { key: 'minPriorSessions', label: 'Only if prior period had at least', type: 'number', default: 20, unit: 'sessions' },
    MAX_ITEMS_PARAM,
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGa4Date(brand.id);
    if (!anchor) return [];
    const { recent, prior } = A.comparisonWindows(anchor, params.windowDays);
    const rows = db.prepare(`
      WITH r AS (SELECT page_path e, SUM(sessions) s, SUM(conversions) c FROM ga4_page_daily
                 WHERE brand_id=@b AND date BETWEEN @rs AND @re GROUP BY page_path),
           p AS (SELECT page_path e, SUM(sessions) s, SUM(conversions) c FROM ga4_page_daily
                 WHERE brand_id=@b AND date BETWEEN @ps AND @pe GROUP BY page_path)
      SELECT COALESCE(r.e,p.e) e, COALESCE(r.s,0) rs, COALESCE(p.s,0) ps,
             COALESCE(r.c,0) rc, COALESCE(p.c,0) pc
      FROM p LEFT JOIN r ON r.e=p.e
      WHERE COALESCE(p.s,0) >= @min
      ORDER BY COALESCE(p.s,0) DESC LIMIT 500`)
      .all({ b: brand.id, rs: recent.startDate, re: recent.endDate, ps: prior.startDate, pe: prior.endDate, min: params.minPriorSessions });

    const hits = rows
      .map((r) => ({ ...r, drop: A.dropPct(r.rs, r.ps) }))
      .filter((r) => r.drop >= params.dropPct)
      .sort((a, b) => (b.ps - b.rs) - (a.ps - a.rs))
      .slice(0, params.maxItems);
    if (!hits.length) return [];
    return [{
      dedupe: `${brand.id}:ga4_landing_page_drop:${recent.startDate}_${recent.endDate}`,
      title: `${hits.length} landing page${hits.length === 1 ? '' : 's'} lost organic sessions`,
      message: hits.map((h) => `• ${h.e}\n    sessions ${int(h.ps)} → ${int(h.rs)} (${pct1(h.drop)} down), conversions ${int(h.pc)} → ${int(h.rc)}`).join('\n'),
      affected: hits.map((h) => h.e),
      action: 'Match each path against Search Console click data. Where GSC clicks held but GA4 sessions fell, investigate tracking or a redirect swallowing the landing. Where both fell, treat it as a visibility loss.',
      evidence: { hits, recent, prior },
    }];
  },
});

define({
  key: 'ga4_data_stalled',
  label: 'GA4 data stopped arriving',
  group: 'Data health',
  description: 'No recent GA4 rows. Catches a removed tag, a revoked property permission or a broken sync before it quietly invalidates every conversion alert.',
  sources: ['GA4'], requires: 'ga4', severity: 'critical',
  defaultFrequency: 'daily',
  params: [
    { key: 'maxAgeDays', label: 'Alert when newest data is older than', type: 'number', default: 3, unit: 'days' },
  ],
  evaluate({ brand, params }) {
    const anchor = A.latestGa4Date(brand.id);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (!anchor) {
      return [{
        dedupe: `${brand.id}:ga4_data_stalled:never:${A.isoDate(today)}`,
        title: 'No GA4 data has ever been synced',
        message: `Brand "${brand.name}" has no rows in the GA4 tables. Either no GA4 property is linked, or every sync attempt has failed.`,
        affected: [brand.site_url],
        action: 'Open the brand and confirm a GA4 property is selected, then run "Sync now" and read the sync log.',
        evidence: { anchor: null },
      }];
    }
    const ageDays = Math.round((today - new Date(`${anchor}T00:00:00Z`)) / 86400000);
    if (ageDays <= params.maxAgeDays) return [];
    return [{
      dedupe: `${brand.id}:ga4_data_stalled:${anchor}:${A.isoDate(today)}`,
      title: `GA4 data is ${ageDays} days stale`,
      message: `The newest GA4 data for "${brand.name}" is ${anchor}, ${ageDays} days old. GA4 normally has data within a day, so this points at the sync or the property.`,
      affected: [brand.site_url],
      action: 'Check the latest sync run for errors, confirm the GA4 property id is still correct, and verify the connected Google account still has at least Viewer access to it.',
      evidence: { anchor, ageDays },
    }];
  },
});

// =========================================================================
// GROUP 6 — Core Web Vitals and page experience
// =========================================================================

function cwvAlert({ key, label, metric, unit, description, goodThreshold, defaultThreshold, severity }) {
  return define({
    key, label, group: 'Core Web Vitals', description,
    sources: ['PageSpeed Insights / CrUX'], requires: 'psi', severity,
    defaultFrequency: 'weekly',
    params: [
      { key: 'threshold', label: `Alert when ${metric.toUpperCase()} is worse than`, type: 'number', default: defaultThreshold, unit, step: metric === 'cls' ? 0.01 : 100 },
      { key: 'strategy', label: 'Measure', type: 'select', default: 'mobile', options: [{ value: 'mobile', label: 'Mobile' }, { value: 'desktop', label: 'Desktop' }] },
    ],
    evaluate({ brand, params }) {
      const snaps = A.latestCwv(brand.id, params.strategy);
      if (!snaps.length) return [];
      const cur = snaps[0];
      const prev = snaps[1] || null;
      const value = cur[metric];
      if (value == null || value <= params.threshold) return [];
      const fmt = (v) => (v == null ? 'n/a' : (metric === 'cls' ? Number(v).toFixed(3) : `${int(v)} ${unit}`));
      const trend = prev && prev[metric] != null
        ? ` Previous measurement was ${fmt(prev[metric])} on ${String(prev.captured_at).slice(0, 16)}.`
        : '';
      return [{
        dedupe: `${brand.id}:${key}:${String(cur.captured_at).slice(0, 10)}:${params.strategy}`,
        title: `${metric.toUpperCase()} is ${fmt(value)} on ${params.strategy}`,
        message: `${metric.toUpperCase()} measured ${fmt(value)} for ${cur.url} (${params.strategy}, source: ${cur.source === 'crux-field' ? 'real-user CrUX field data' : 'Lighthouse lab'}), against your threshold of ${fmt(params.threshold)}. Google's "good" boundary is ${fmt(goodThreshold)}.${trend} Performance score: ${cur.perf_score == null ? 'n/a' : cur.perf_score}/100.`,
        affected: [cur.url],
        action: {
          lcp: 'Find the LCP element in PageSpeed Insights. The usual fixes are compressing and preloading the hero image, serving next-gen formats, removing render-blocking CSS/JS, and improving server response time.',
          inp: 'Reduce main-thread work: break up long JavaScript tasks, defer non-critical third-party scripts, and audit event handlers on the slowest interactions.',
          cls: 'Set explicit width and height on images and embeds, reserve space for ads and banners, and avoid injecting content above existing content after load.',
        }[metric] || 'Review the PageSpeed Insights report for this URL and address the highest-impact opportunities.',
        evidence: { current: cur, previous: prev, threshold: params.threshold },
      }];
    },
  });
}

cwvAlert({
  key: 'cwv_lcp', label: 'LCP too slow', metric: 'lcp', unit: 'ms', severity: 'high',
  description: 'Largest Contentful Paint exceeded your threshold. LCP is the Core Web Vital most often responsible for a failing page-experience assessment.',
  goodThreshold: 2500, defaultThreshold: 2500,
});

cwvAlert({
  key: 'cwv_inp', label: 'INP too slow', metric: 'inp', unit: 'ms', severity: 'medium',
  description: 'Interaction to Next Paint exceeded your threshold. INP replaced FID as the responsiveness Core Web Vital.',
  goodThreshold: 200, defaultThreshold: 200,
});

cwvAlert({
  key: 'cwv_cls', label: 'CLS too high', metric: 'cls', unit: '', severity: 'medium',
  description: 'Cumulative Layout Shift exceeded your threshold — content is moving under the user as the page loads.',
  goodThreshold: 0.1, defaultThreshold: 0.1,
});

define({
  key: 'psi_score_drop',
  label: 'PageSpeed score dropped',
  group: 'Core Web Vitals',
  description: 'The Lighthouse performance score fell between two measurements — a fast way to catch a deployment that made the site slower.',
  sources: ['PageSpeed Insights'], requires: 'psi', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPoints', label: 'Alert when the score falls by at least', type: 'number', default: 10, unit: 'points' },
    { key: 'strategy', label: 'Measure', type: 'select', default: 'mobile', options: [{ value: 'mobile', label: 'Mobile' }, { value: 'desktop', label: 'Desktop' }] },
  ],
  evaluate({ brand, params }) {
    const snaps = A.latestCwv(brand.id, params.strategy);
    if (snaps.length < 2) return [];
    const [cur, prev] = snaps;
    if (cur.perf_score == null || prev.perf_score == null) return [];
    const drop = prev.perf_score - cur.perf_score;
    if (drop < params.dropPoints) return [];
    return [{
      dedupe: `${brand.id}:psi_score_drop:${String(cur.captured_at).slice(0, 10)}:${params.strategy}`,
      title: `PageSpeed score fell ${drop} points (${prev.perf_score} → ${cur.perf_score})`,
      message: `The ${params.strategy} performance score for ${cur.url} dropped from ${prev.perf_score} (${String(prev.captured_at).slice(0, 16)}) to ${cur.perf_score} (${String(cur.captured_at).slice(0, 16)}). LCP ${prev.lcp == null ? 'n/a' : int(prev.lcp)}ms → ${cur.lcp == null ? 'n/a' : int(cur.lcp)}ms, CLS ${prev.cls == null ? 'n/a' : Number(prev.cls).toFixed(3)} → ${cur.cls == null ? 'n/a' : Number(cur.cls).toFixed(3)}.`,
      affected: [cur.url],
      action: 'Check what shipped between the two measurements. New third-party scripts, an unoptimised image, or a larger JavaScript bundle are the usual causes.',
      evidence: { current: cur, previous: prev, drop },
    }];
  },
});

// =========================================================================
// GROUP 7 — Availability
// =========================================================================

define({
  key: 'site_down',
  label: 'Website is down',
  group: 'Availability',
  description: 'The site failed to return a success status on the last check. Extended downtime causes deindexation, so this is the fastest-acting alert in the system.',
  sources: ['HTTP probe'], requires: 'uptime', severity: 'critical',
  defaultFrequency: 'hourly',
  params: [
    { key: 'consecutiveFailures', label: 'Alert after', type: 'number', default: 2, unit: 'consecutive failed checks', help: 'Requiring more than one failure avoids paging on a single transient timeout.' },
  ],
  evaluate({ brand, params }) {
    const checks = db.prepare('SELECT * FROM uptime_checks WHERE brand_id=? ORDER BY id DESC LIMIT ?')
      .all(brand.id, Math.max(1, params.consecutiveFailures));
    if (checks.length < params.consecutiveFailures) return [];
    if (!checks.every((c) => !c.ok)) return [];
    const latest = checks[0];
    return [{
      dedupe: `${brand.id}:site_down:${String(latest.checked_at).slice(0, 13)}`,
      title: `${brand.name} is not responding`,
      message: `${params.consecutiveFailures} consecutive checks of ${latest.url} failed. Most recent: ${latest.status_code ? `HTTP ${latest.status_code}` : `no response (${latest.error || 'timeout'})`} after ${int(latest.response_ms)}ms at ${latest.checked_at} UTC.`,
      affected: [latest.url],
      action: 'Confirm the outage from outside your network, then check hosting status, DNS resolution and TLS certificate expiry. If the outage lasts more than a few hours, expect crawl errors in Search Console and monitor indexation once it is restored.',
      evidence: { checks },
    }];
  },
});

define({
  key: 'site_slow_response',
  label: 'Server response time degraded',
  group: 'Availability',
  description: 'The site responds but noticeably slower than usual. Slow server response feeds directly into LCP and crawl budget.',
  sources: ['HTTP probe'], requires: 'uptime', severity: 'medium',
  defaultFrequency: 'daily',
  params: [
    { key: 'thresholdMs', label: 'Alert when response time exceeds', type: 'number', default: 3000, unit: 'ms', step: 100 },
    { key: 'sampleSize', label: 'Averaged over the last', type: 'number', default: 3, unit: 'checks' },
  ],
  evaluate({ brand, params }) {
    const checks = db.prepare('SELECT * FROM uptime_checks WHERE brand_id=? AND ok=1 ORDER BY id DESC LIMIT ?')
      .all(brand.id, Math.max(1, params.sampleSize));
    if (checks.length < params.sampleSize) return [];
    const avg = checks.reduce((a, c) => a + (c.response_ms || 0), 0) / checks.length;
    if (avg <= params.thresholdMs) return [];
    return [{
      dedupe: `${brand.id}:site_slow_response:${String(checks[0].checked_at).slice(0, 10)}`,
      title: `Server response averaging ${int(avg)}ms`,
      message: `The last ${checks.length} successful checks of ${checks[0].url} averaged ${int(avg)}ms, above your ${int(params.thresholdMs)}ms threshold. Individual timings: ${checks.map((c) => `${int(c.response_ms)}ms`).join(', ')}.`,
      affected: [checks[0].url],
      action: 'Check server load, database query time and any recently added server-side integrations. Time to first byte above roughly 800ms makes a good LCP very hard to achieve.',
      evidence: { checks, avg },
    }];
  },
});

define({
  key: 'homepage_status_changed',
  label: 'Homepage HTTP status changed',
  group: 'Availability',
  description: 'The status code returned by the site changed — for example 200 becoming a 301 or 403. Catches accidental redirects and access rules that block crawlers.',
  sources: ['HTTP probe'], requires: 'uptime', severity: 'high',
  defaultFrequency: 'daily',
  params: [],
  evaluate({ brand }) {
    const checks = db.prepare('SELECT * FROM uptime_checks WHERE brand_id=? AND status_code IS NOT NULL ORDER BY id DESC LIMIT 2')
      .all(brand.id);
    if (checks.length < 2) return [];
    const [cur, prev] = checks;
    if (cur.status_code === prev.status_code) return [];
    return [{
      dedupe: `${brand.id}:homepage_status_changed:${cur.id}`,
      title: `HTTP status changed: ${prev.status_code} → ${cur.status_code}`,
      message: `${cur.url} returned HTTP ${prev.status_code} at ${prev.checked_at} and HTTP ${cur.status_code} at ${cur.checked_at}.`,
      affected: [cur.url],
      action: 'Verify the new status is intentional. A 403 or 503 shown to our probe may also be shown to Googlebot, and an unplanned 301 on the homepage can move ranking signals to an unexpected URL.',
      evidence: { current: cur, previous: prev },
    }];
  },
});

// =========================================================================
// GROUP 8 — Technical audit findings (from the crawl tools)
// =========================================================================

define({
  key: 'audit_broken_links_spike',
  label: 'Broken links increased',
  group: 'Technical audit',
  description: 'The number of broken internal or external links found by the technical audit grew since the previous crawl.',
  sources: ['Technical audit crawl'], requires: 'audit', severity: 'high',
  defaultFrequency: 'weekly',
  params: [
    { key: 'minIncrease', label: 'Alert when broken links increase by at least', type: 'number', default: 5, unit: 'links' },
  ],
  evaluate({ brand, params }) {
    const runs = db.prepare(`SELECT * FROM audit_runs
      WHERE brand_id=? AND status='completed' AND json_result IS NOT NULL
      ORDER BY id DESC LIMIT 2`).all(brand.id);
    if (runs.length < 2) return [];
    const count = (run) => {
      try {
        const j = JSON.parse(run.json_result);
        const f = (j.findings || []).filter((x) => /broken|404/i.test(x.id) || /broken/i.test(x.name || ''));
        return f.reduce((a, x) => a + (x.failed || 0), 0);
      } catch { return null; }
    };
    const cur = count(runs[0]);
    const prev = count(runs[1]);
    if (cur == null || prev == null) return [];
    const inc = cur - prev;
    if (inc < params.minIncrease) return [];
    return [{
      dedupe: `${brand.id}:audit_broken_links_spike:${runs[0].id}`,
      title: `Broken links up by ${int(inc)} (${int(prev)} → ${int(cur)})`,
      message: `The technical audit on ${String(runs[0].created_at).slice(0, 16)} found ${int(cur)} broken links, up from ${int(prev)} in the previous crawl on ${String(runs[1].created_at).slice(0, 16)}.`,
      affected: [brand.site_url],
      action: 'Open the audit report and work through the broken-link list. Fix the link target where the destination moved, and remove or repoint the link where the destination is genuinely gone.',
      evidence: { current: cur, previous: prev, currentRunId: runs[0].id },
    }];
  },
});

define({
  key: 'audit_health_drop',
  label: 'Site health score dropped',
  group: 'Technical audit',
  description: 'The overall health score from the technical audit fell between two crawls — a single number that catches broad technical regressions.',
  sources: ['Technical audit crawl'], requires: 'audit', severity: 'medium',
  defaultFrequency: 'weekly',
  params: [
    { key: 'dropPoints', label: 'Alert when the health score falls by at least', type: 'number', default: 5, unit: 'points' },
  ],
  evaluate({ brand, params }) {
    const runs = db.prepare(`SELECT * FROM audit_runs
      WHERE brand_id=? AND status='completed' AND json_result IS NOT NULL
      ORDER BY id DESC LIMIT 2`).all(brand.id);
    if (runs.length < 2) return [];
    const score = (run) => { try { return JSON.parse(run.json_result).site_health; } catch { return null; } };
    const cur = score(runs[0]);
    const prev = score(runs[1]);
    if (cur == null || prev == null) return [];
    const drop = prev - cur;
    if (drop < params.dropPoints) return [];
    return [{
      dedupe: `${brand.id}:audit_health_drop:${runs[0].id}`,
      title: `Site health score fell ${drop.toFixed(0)} points (${prev} → ${cur})`,
      message: `Technical audit health dropped from ${prev} to ${cur} between the crawl on ${String(runs[1].created_at).slice(0, 16)} and the one on ${String(runs[0].created_at).slice(0, 16)}.`,
      affected: [brand.site_url],
      action: 'Open both audit reports and compare the error-tier findings to see which checks newly failed.',
      evidence: { current: cur, previous: prev, currentRunId: runs[0].id },
    }];
  },
});

define({
  key: 'audit_new_critical_issues',
  label: 'New critical technical issues found',
  group: 'Technical audit',
  description: 'Error-tier findings from the latest crawl that were not failing in the previous one — regressions rather than long-standing debt.',
  sources: ['Technical audit crawl'], requires: 'audit', severity: 'high',
  defaultFrequency: 'weekly',
  params: [MAX_ITEMS_PARAM],
  evaluate({ brand, params }) {
    const runs = db.prepare(`SELECT * FROM audit_runs
      WHERE brand_id=? AND status='completed' AND json_result IS NOT NULL
      ORDER BY id DESC LIMIT 2`).all(brand.id);
    if (!runs.length) return [];
    const failing = (run) => {
      try {
        return new Map(JSON.parse(run.json_result).findings
          .filter((f) => f.display === 'error' && (f.failed || 0) > 0)
          .map((f) => [f.id, f]));
      } catch { return new Map(); }
    };
    const cur = failing(runs[0]);
    const prev = runs[1] ? failing(runs[1]) : new Map();
    const news = [...cur.values()].filter((f) => !prev.has(f.id)).slice(0, params.maxItems);
    if (!news.length) return [];
    return [{
      dedupe: `${brand.id}:audit_new_critical_issues:${runs[0].id}`,
      title: `${news.length} new critical technical issue${news.length === 1 ? '' : 's'}`,
      message: news.map((f) => `• ${f.name} — ${int(f.failed)} ${f.unit || 'pages'} affected\n    ${f.summary || ''}`).join('\n'),
      affected: news.flatMap((f) => (f.items || []).slice(0, 3).map((i) => (typeof i === 'string' ? i : (i.url || JSON.stringify(i))))),
      action: 'These checks were passing in the previous crawl and are failing now, so they most likely came from a recent deployment. Fix these before working on older technical debt.',
      evidence: { newIssues: news.map((f) => ({ id: f.id, name: f.name, failed: f.failed })), runId: runs[0].id },
    }];
  },
});

define({
  key: 'orphan_pages_increase',
  label: 'Orphan pages increased',
  group: 'Technical audit',
  description: 'More pages have no editorial internal links pointing at them. Orphans are crawled rarely and rank poorly regardless of content quality.',
  sources: ['Internal linking crawl'], requires: 'linking', severity: 'medium',
  defaultFrequency: 'monthly',
  params: [
    { key: 'minIncrease', label: 'Alert when orphan pages increase by at least', type: 'number', default: 3, unit: 'pages' },
  ],
  evaluate({ brand, params }) {
    const runs = db.prepare(`SELECT * FROM linking_runs
      WHERE brand_id=? AND status='completed' AND json_result IS NOT NULL
      ORDER BY id DESC LIMIT 2`).all(brand.id);
    if (runs.length < 2) return [];
    const count = (run) => {
      try {
        const j = JSON.parse(run.json_result);
        return (j.summary && j.summary.orphan_pages != null) ? Number(j.summary.orphan_pages) : null;
      } catch { return null; }
    };
    const cur = count(runs[0]);
    const prev = count(runs[1]);
    if (cur == null || prev == null) return [];
    const inc = cur - prev;
    if (inc < params.minIncrease) return [];
    return [{
      dedupe: `${brand.id}:orphan_pages_increase:${runs[0].id}`,
      title: `Orphan pages up by ${int(inc)} (${int(prev)} → ${int(cur)})`,
      message: `The internal linking crawl on ${String(runs[0].created_at).slice(0, 16)} found ${int(cur)} orphan pages, up from ${int(prev)}.`,
      affected: [brand.site_url],
      action: 'Open the internal linking report and use its recommendations to add editorial links to the new orphans from topically related pages. Adding large volumes of internal links requires SEO approval.',
      evidence: { current: cur, previous: prev, runId: runs[0].id },
    }];
  },
});

// =========================================================================
// Public API
// =========================================================================

const BY_KEY = new Map(CATALOG.map((a) => [a.key, a]));

const GROUP_ORDER = [
  'Traffic & visibility',
  'Keywords & rankings',
  'Landing pages',
  'Indexation',
  'Engagement & conversions',
  'Core Web Vitals',
  'Availability',
  'Technical audit',
  'Data health',
];

const FREQUENCIES = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Once a day' },
  { value: 'weekly', label: 'Once a week (Monday)' },
  { value: 'monthly', label: 'Once a month (1st)' },
  { value: 'manual', label: 'Only when I run checks manually' },
];

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'slack', label: 'Slack' },
  { value: 'webhook', label: 'Webhook / WhatsApp relay' },
];

function get(key) { return BY_KEY.get(key) || null; }
function all() { return CATALOG; }

function grouped() {
  const map = new Map(GROUP_ORDER.map((g) => [g, []]));
  CATALOG.forEach((a) => {
    if (!map.has(a.group)) map.set(a.group, []);
    map.get(a.group).push(a);
  });
  return [...map.entries()].filter(([, items]) => items.length).map(([group, items]) => ({ group, items }));
}

// Fills in defaults for any param the stored subscription does not set, so an
// evaluator never has to guard against a missing knob.
function resolveParams(alertDef, stored) {
  const out = {};
  (alertDef.params || []).forEach((p) => {
    const raw = stored && stored[p.key] != null ? stored[p.key] : p.default;
    out[p.key] = p.type === 'number' ? Number(raw) : raw;
  });
  // Several evaluators reuse maxItems even when the alert does not expose it.
  if (out.maxItems == null) out.maxItems = 15;
  return out;
}

// Which data a brand actually has, used to grey out alerts that cannot run.
function brandCapabilities(brand) {
  const has = (sql, ...args) => db.prepare(sql).get(brand.id, ...args).n > 0;
  return {
    gsc: Boolean(brand.gsc_property) && has('SELECT COUNT(*) n FROM gsc_daily WHERE brand_id=?'),
    ga4: Boolean(brand.ga4_property_id) && has('SELECT COUNT(*) n FROM ga4_daily WHERE brand_id=?'),
    psi: has('SELECT COUNT(*) n FROM psi_snapshots WHERE brand_id=? AND error IS NULL'),
    uptime: has('SELECT COUNT(*) n FROM uptime_checks WHERE brand_id=?'),
    audit: has("SELECT COUNT(*) n FROM audit_runs WHERE brand_id=? AND status='completed'"),
    linking: has("SELECT COUNT(*) n FROM linking_runs WHERE brand_id=? AND status='completed'"),
  };
}

module.exports = {
  all, get, grouped, resolveParams, brandCapabilities,
  GROUP_ORDER, FREQUENCIES, CHANNELS,
};
