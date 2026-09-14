// Google Keyword Planner - the full surface, not just the volume column.
//
// keywordMetrics.js already calls generateKeywordIdeas, but only as ONE of six
// volume sources, and it throws away almost everything Keyword Planner returns
// so the merged row looks the same whichever source filled it. That is right
// for a blended metric and wrong for the person who actually wants Keyword
// Planner: the ideas expansion, the competition band, the top-of-page bid
// range, the twelve-month curve, the concept grouping and the forecast are the
// product, and none of them survive the merge.
//
// This module is the unmerged path. Every value here came from Google Ads and
// is labelled as such; nothing is estimated, scaled or filled in from another
// source. Three RPCs on KeywordPlanIdeaService cover the whole tool:
//
//   generateKeywordIdeas              discovery    seed -> new keywords
//   generateKeywordHistoricalMetrics  measurement  exact list, no expansion
//   generateKeywordForecastMetrics    planning     spend -> clicks/impressions
//
// plus geoTargetConstants:suggest, which is how the real Keyword Planner lets
// you target a city instead of a country.
//
// ACCESS. Identical to keywordMetrics.googleAdsVolume: a developer token, and
// either the team's own Ads account or the shared agency one, resolved by
// google.resolveAdsPrincipal. A TEST-access token authenticates fine and
// returns empty results, which is why callers here distinguish "no rows" from
// "failed" - see google.probeKeywordPlanner for the same distinction.

const markets = require('./markets');

// Required lazily, exactly as keywordMetrics.googleAdsVolume does. ../google
// pulls in the database, and this deployment runs a WebAssembly SQLite with no
// cross-process write safety: a load-time require here would open app.db from
// any script that so much as imports this file for its pure helpers.
function ads() {
  return require('../google');
}

// Ads language criteria ids. Kept here rather than imported from
// keywordMetrics because that module does not export its table; the ids are
// Google constants and do not change.
const LANGUAGES = [
  { code: 'en', id: 1000, name: 'English' },
  { code: 'es', id: 1003, name: 'Spanish' },
  { code: 'fr', id: 1002, name: 'French' },
  { code: 'de', id: 1001, name: 'German' },
  { code: 'it', id: 1004, name: 'Italian' },
  { code: 'pt', id: 1014, name: 'Portuguese' },
  { code: 'nl', id: 1010, name: 'Dutch' },
  { code: 'pl', id: 1030, name: 'Polish' },
  { code: 'ru', id: 1031, name: 'Russian' },
  { code: 'tr', id: 1037, name: 'Turkish' },
  { code: 'ar', id: 1019, name: 'Arabic' },
  { code: 'he', id: 1027, name: 'Hebrew' },
  { code: 'hi', id: 1023, name: 'Hindi' },
  { code: 'id', id: 1025, name: 'Indonesian' },
  { code: 'ja', id: 1005, name: 'Japanese' },
  { code: 'ko', id: 1012, name: 'Korean' },
  { code: 'zh', id: 1017, name: 'Chinese (simplified)' },
  { code: 'th', id: 1044, name: 'Thai' },
  { code: 'vi', id: 1040, name: 'Vietnamese' },
  { code: 'sv', id: 1015, name: 'Swedish' },
  { code: 'no', id: 1013, name: 'Norwegian' },
  { code: 'da', id: 1009, name: 'Danish' },
  { code: 'fi', id: 1011, name: 'Finnish' },
  { code: 'cs', id: 1021, name: 'Czech' },
  { code: 'sk', id: 1033, name: 'Slovak' },
  { code: 'hu', id: 1024, name: 'Hungarian' },
  { code: 'ro', id: 1032, name: 'Romanian' },
  { code: 'el', id: 1022, name: 'Greek' },
  { code: 'uk', id: 1036, name: 'Ukrainian' },
];
const LANG_BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const LANG_BY_ID = new Map(LANGUAGES.map((l) => [String(l.id), l]));

// Accepts a language id ("1000"), a code ("en"), or nothing.
function resolveLanguage(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return LANG_BY_CODE.get('en');
  return LANG_BY_ID.get(s) || LANG_BY_CODE.get(s) || LANG_BY_CODE.get('en');
}

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTH_INDEX = new Map(MONTH_NAMES.map((m, i) => [m, i + 1]));

const NETWORKS = [
  { value: 'GOOGLE_SEARCH', label: 'Google Search only' },
  { value: 'GOOGLE_SEARCH_AND_PARTNERS', label: 'Google Search and search partners' },
];

const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'];

// Keyword Planner caps a seed at 20 terms; anything past that is silently
// dropped by Google, so it is trimmed here and the caller is told.
const MAX_SEED_KEYWORDS = 20;
// generateKeywordHistoricalMetrics takes far more, but a page that renders
// them all is unusable and the request body has a practical ceiling.
const MAX_HISTORICAL_KEYWORDS = 500;
const MAX_FORECAST_KEYWORDS = 500;

// --------------------------------------------------------------- conversions

function micros(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 1e6) * 100) / 100;
}

function toMicros(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e6);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Google's twelve-month curve, oldest first, flattened into something a
// sparkline and a CSV can both consume. The label is YYYY-MM because the API
// returns the month as an enum name, which sorts alphabetically and would put
// APRIL first.
function monthlySeries(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const rows = list.map((v) => {
    const year = num(v.year);
    const month = MONTH_INDEX.get(String(v.month || '').toUpperCase()) || null;
    return {
      year,
      month,
      label: year && month ? year + '-' + String(month).padStart(2, '0') : null,
      volume: num(v.monthlySearches),
    };
  }).filter((r) => r.label);
  rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows.length ? rows : null;
}

// Direction of the window, as a percentage change from its first quarter to
// its last. Reported only when both ends are real numbers - a null month is
// missing data, not a zero, and averaging a null as zero is how a flat
// keyword ends up looking like a collapse.
function trendFromSeries(series) {
  if (!series || series.length < 6) return null;
  const vals = series.map((r) => r.volume);
  const head = vals.slice(0, 3).filter((v) => v != null);
  const tail = vals.slice(-3).filter((v) => v != null);
  if (head.length < 3 || tail.length < 3) return null;
  const a = head.reduce((s, v) => s + v, 0) / head.length;
  const b = tail.reduce((s, v) => s + v, 0) / tail.length;
  if (!a) return null;
  return Math.round(((b - a) / a) * 100);
}

// KeywordPlanHistoricalMetrics -> one flat row. Shared by the ideas and the
// historical-metrics paths because Google returns the same message in both.
function metricsRow(text, ms, extra) {
  const m = ms || {};
  const series = monthlySeries(m.monthlySearchVolumes);
  return Object.assign({
    keyword: text,
    volume: num(m.avgMonthlySearches),
    competition: m.competition || null,
    competitionIndex: num(m.competitionIndex),
    lowBid: micros(m.lowTopOfPageBidMicros),
    highBid: micros(m.highTopOfPageBidMicros),
    averageCpc: micros(m.averageCpcMicros),
    monthly: series,
    trendPct: trendFromSeries(series),
    // Keyword Planner's headline comparisons, computed from the same series
    // rather than fetched - Google exposes no field for either.
    change3m: periodChanges(series).threeMonth,
    changeYoY: periodChanges(series).yearOnYear,
  }, extra || {});
}

// ------------------------------------------------------------ request bodies

function geoTargets(m, extraGeoIds) {
  const out = [];
  if (!m.worldwide) out.push('geoTargetConstants/' + m.dfsLocation);
  (extraGeoIds || []).forEach((id) => {
    const clean = String(id).replace(/\D+/g, '');
    if (clean) out.push('geoTargetConstants/' + clean);
  });
  // De-duplicated: passing the same constant twice is an API error, and it is
  // easy to pick "United States" as the market and then also search for it in
  // the location box.
  return Array.from(new Set(out));
}

// The four seed shapes Keyword Planner offers. The UI calls them what the tool
// calls them ("Start with keywords" / "Start with a website"), and the combined
// seed is the one people forget exists even though it is usually the best of
// the three: a page plus the terms you already know it should rank for.
function buildSeed(opts) {
  const kws = (opts.keywords || []).slice(0, MAX_SEED_KEYWORDS);
  const site = String(opts.url || '').trim();
  const mode = opts.seedMode;

  if (mode === 'url' || mode === 'site') {
    if (!site) throw new Error('Enter a URL to use as the seed.');
    // urlSeed reads ONE page; siteSeed asks Google for the whole domain, which
    // is what the "Entire site" radio in Keyword Planner does.
    return mode === 'site' ? { siteSeed: { site } } : { urlSeed: { url: site } };
  }
  if (mode === 'keyword_and_url') {
    if (!kws.length || !site) throw new Error('The combined seed needs both keywords and a URL.');
    return { keywordAndUrlSeed: { url: site, keywords: kws } };
  }
  if (!kws.length) throw new Error('Enter at least one seed keyword.');
  return { keywordSeed: { keywords: kws } };
}

function parseYearMonth(v) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month: MONTH_NAMES[month - 1] };
}

// historicalMetricsOptions. Google defaults to the last full twelve months; an
// explicit range is what lets someone compare last year's season to this one,
// which is the most common reason to open Keyword Planner in planning season.
// Twenty-four months by default, not Google's twelve.
//
// Keyword Planner's two headline columns are "three month change" and "YoY
// change", and the second is impossible from twelve months of data: comparing
// this month against a month in the same window is not a year-on-year
// comparison. Asking for 24 is the only way to produce the column Keyword
// Planner itself shows. Verified: 24 months is returned in full; 48 is
// refused. Google's window ends at the last COMPLETE month, so the range is
// anchored on that rather than on today.
function defaultYearMonthRange() {
  const now = new Date();
  // Last complete month = the month before the current one.
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth(); // 0-based current month == 1-based previous
  const end = endM === 0
    ? { year: endY - 1, month: MONTH_NAMES[11] }
    : { year: endY, month: MONTH_NAMES[endM - 1] };
  const startDate = new Date(Date.UTC(end.year, MONTH_NAMES.indexOf(end.month) - 23, 1));
  return {
    start: { year: startDate.getUTCFullYear(), month: MONTH_NAMES[startDate.getUTCMonth()] },
    end,
  };
}

function historicalOptions(opts) {
  const out = {};
  const start = parseYearMonth(opts.startYearMonth);
  const end = parseYearMonth(opts.endYearMonth);
  out.yearMonthRange = (start && end) ? { start, end } : defaultYearMonthRange();
  if (opts.includeAverageCpc !== false) out.includeAverageCpc = true;
  return out;
}

// Percentage change between two periods of the series, newest last.
// Returns null rather than 0 when either side is missing or the base is zero:
// "no comparison possible" and "no change" are different statements.
function changeBetween(series, recentMonths, offsetMonths) {
  if (!series || !series.length) return null;
  const vals = series.map((r) => r.volume);
  const end = vals.length - offsetMonths;
  const start = end - recentMonths;
  if (start < 0 || end > vals.length) return null;
  const window = vals.slice(start, end).filter((v) => v != null);
  if (window.length < recentMonths) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// Keyword Planner's own two comparison columns.
function periodChanges(series) {
  if (!series || series.length < 4) return { threeMonth: null, yearOnYear: null };
  const latest3 = changeBetween(series, 3, 0);
  const prior3 = changeBetween(series, 3, 3);
  const yearAgo3 = changeBetween(series, 3, 12);
  const pct = (now, then) => (now == null || then == null || !then)
    ? null : Math.round(((now - then) / then) * 100);
  return { threeMonth: pct(latest3, prior3), yearOnYear: pct(latest3, yearAgo3) };
}

function principalFor(userId) {
  const p = ads().resolveAdsPrincipal(userId);
  if (!p.ok) {
    const err = new Error(p.reason);
    err.noPrincipal = true;
    throw err;
  }
  return p;
}

// What the page prints under the table so a number is never anonymous: which
// account answered, in which country and language, on which network.
function basisFor(p, m, lang, network) {
  return {
    account: p.mode === 'shared'
      ? 'shared agency account ' + p.customerId + (p.ownerEmail ? ' (via ' + p.ownerEmail + ')' : '')
      : "this team's account " + p.customerId,
    mode: p.mode,
    staleOwnSelection: p.staleOwnSelection || null,
    market: m.name,
    language: lang.name,
    network: (NETWORKS.find((n) => n.value === network) || NETWORKS[0]).label,
    apiVersion: ads().ADS_API_VERSION,
  };
}

function normNetwork(v) {
  return NETWORKS.some((n) => n.value === v) ? v : 'GOOGLE_SEARCH';
}

// ------------------------------------------------------------------ 1. ideas

// Discovery. Google's own ideas for a seed, with every metric it attaches,
// optionally grouped by the concepts Keyword Planner shows in its grouped-ideas
// view.
async function ideas(userId, opts) {
  const o = opts || {};
  const p = principalFor(userId);
  const m = markets.resolve(o.market);
  const lang = resolveLanguage(o.language);
  const network = normNetwork(o.network);

  const body = Object.assign({
    language: 'languageConstants/' + lang.id,
    geoTargetConstants: geoTargets(m, o.geoTargetIds),
    keywordPlanNetwork: network,
    includeAdultKeywords: Boolean(o.includeAdultKeywords),
    pageSize: Math.min(1000, Math.max(10, num(o.pageSize) || 500)),
  }, buildSeed(o));

  // Concept annotations are what turn 500 undifferentiated ideas into the
  // grouped view. They cost nothing extra on the request.
  if (o.annotations !== false) body.keywordAnnotation = ['KEYWORD_CONCEPT'];
  // Device split across the whole result set - the only aggregate Google
  // offers, and a fair answer to "is this a phone keyword".
  if (o.deviceBreakdown) body.aggregateMetrics = { aggregateMetricTypes: ['DEVICE'] };

  const hist = historicalOptions(o);
  if (hist) body.historicalMetricsOptions = hist;
  if (o.pageToken) body.pageToken = o.pageToken;

  const parsed = await ads().adsRequest(
    p.userId,
    '/customers/' + p.customerId + ':generateKeywordIdeas',
    { body, loginCustomerId: p.loginCustomerId },
  );

  const seedSet = new Set((o.keywords || []).map((k) => String(k).trim().toLowerCase()));
  let rows = (parsed.results || []).map((r) => {
    const text = String(r.text || '');
    const concepts = (r.keywordAnnotations && Array.isArray(r.keywordAnnotations.concepts))
      ? r.keywordAnnotations.concepts.map((c) => ({
        name: c.name || null,
        group: (c.conceptGroup && c.conceptGroup.name) || null,
        groupType: (c.conceptGroup && c.conceptGroup.type) || null,
      })).filter((c) => c.name || c.group)
      : [];
    return metricsRow(text, r.keywordIdeaMetrics, {
      // Google mixes the seeds back into the ideas. Flagging them rather than
      // dropping them keeps "what I asked for" and "what Google suggests" on
      // one table, which is how the real tool shows it.
      isSeed: seedSet.has(text.toLowerCase()),
      concepts,
      conceptGroup: (concepts.find((c) => c.group) || {}).group || null,
    });
  });

  const fetched = rows.length;
  rows = sortRows(applyFilters(rows, o), o.sort);

  return {
    kind: 'ideas',
    rows,
    total: rows.length,
    returned: fetched,
    filteredOut: fetched - rows.length,
    nextPageToken: parsed.nextPageToken || null,
    devices: deviceBreakdown(parsed.aggregateMetricResults),
    conceptGroups: groupByConcept(rows),
    basis: basisFor(p, m, lang, network),
    seedMode: o.seedMode || 'keyword',
    truncatedSeed: Math.max(0, (o.keywords || []).length - MAX_SEED_KEYWORDS),
    // How many of Google's results were NEW, as opposed to the seeds handed
    // back. Google mixes the seeds into the ideas, so "returned: 1" for a
    // one-word seed means it found nothing at all - a state that otherwise
    // renders as a perfectly normal one-row table and reads as a broken page.
    seedCount: seedSet.size,
    newIdeas: Math.max(0, fetched - rows.filter((r) => r.isSeed).length),
  };
}

// ------------------------------------------------------ 2. historical metrics

// Measurement, not discovery. Google returns metrics for EXACTLY the keywords
// asked about and expands nothing, which is the right call for "here is my
// list, what is it worth" - the question the ideas endpoint answers badly
// because it buries the list inside hundreds of suggestions.
async function historical(userId, opts) {
  const o = opts || {};
  const p = principalFor(userId);
  const m = markets.resolve(o.market);
  const lang = resolveLanguage(o.language);
  const network = normNetwork(o.network);

  const all = (o.keywords || []).filter(Boolean);
  if (!all.length) throw new Error('Enter at least one keyword.');
  const keywords = all.slice(0, MAX_HISTORICAL_KEYWORDS);

  const body = {
    keywords,
    language: 'languageConstants/' + lang.id,
    geoTargetConstants: geoTargets(m, o.geoTargetIds),
    keywordPlanNetwork: network,
    includeAdultKeywords: Boolean(o.includeAdultKeywords),
  };
  if (o.deviceBreakdown) body.aggregateMetrics = { aggregateMetricTypes: ['DEVICE'] };
  const hist = historicalOptions(o);
  if (hist) body.historicalMetricsOptions = hist;

  const parsed = await ads().adsRequest(
    p.userId,
    '/customers/' + p.customerId + ':generateKeywordHistoricalMetrics',
    { body, loginCustomerId: p.loginCustomerId },
  );

  let rows = (parsed.results || []).map((r) => metricsRow(String(r.text || ''), r.keywordMetrics, {
    // Google folds plurals, spacing and stop-word variants into one row and
    // reports which terms were merged. Hiding that would mean showing one
    // volume for three of the user's keywords with no explanation of where the
    // other two went.
    closeVariants: Array.isArray(r.closeVariants) ? r.closeVariants : [],
  }));

  // Anything Google returned nothing for is listed as such rather than
  // silently absent - a keyword with no data and a keyword you mistyped look
  // identical once the row disappears.
  const seen = new Set();
  rows.forEach((r) => {
    seen.add(r.keyword.toLowerCase());
    (r.closeVariants || []).forEach((v) => seen.add(String(v).toLowerCase()));
  });
  const missing = keywords.filter((k) => !seen.has(String(k).toLowerCase()));

  const fetched = rows.length;
  rows = sortRows(applyFilters(rows, o), o.sort);

  return {
    kind: 'historical',
    rows,
    total: rows.length,
    returned: fetched,
    filteredOut: fetched - rows.length,
    missing,
    devices: deviceBreakdown(parsed.aggregateMetricResults),
    basis: basisFor(p, m, lang, network),
    truncatedSeed: Math.max(0, all.length - MAX_HISTORICAL_KEYWORDS),
  };
}

// --------------------------------------------------------------- 3. forecasts

// Google forecasts up to a year ahead and refuses a range starting in the past,
// so the default is the next 30 days starting tomorrow rather than today - a
// request submitted near midnight UTC with "today" as the start is the classic
// way to get an unhelpful date-range error.
function forecastPeriod(opts) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  let start = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.startDate || ''))
    ? new Date(opts.startDate + 'T00:00:00Z') : null;
  let end = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.endDate || ''))
    ? new Date(opts.endDate + 'T00:00:00Z') : null;
  if (!start || Number.isNaN(start.getTime())) {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
  }
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + 29 * 86400000);
  }
  const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  return { startDate: fmt(start), endDate: fmt(end), days };
}

// Planning. Given keywords, a bid and a date range, Google forecasts the
// clicks, impressions and cost a campaign would see. This is the half of
// Keyword Planner that answers "what would it cost to buy this traffic instead
// of earning it" - the number that justifies an SEO budget to a client better
// than any volume figure does.
async function forecast(userId, opts) {
  const o = opts || {};
  const p = principalFor(userId);
  const m = markets.resolve(o.market);
  const lang = resolveLanguage(o.language);
  const network = normNetwork(o.network);

  const all = (o.keywords || []).filter(Boolean);
  if (!all.length) throw new Error('Enter at least one keyword to forecast.');
  const keywords = all.slice(0, MAX_FORECAST_KEYWORDS);

  const matchType = MATCH_TYPES.indexOf(o.matchType) >= 0 ? o.matchType : 'BROAD';
  const bidMicros = toMicros(o.maxCpcBid);
  if (!bidMicros) {
    throw new Error('Enter a maximum CPC bid above zero - a forecast has nothing to forecast against without one.');
  }

  const period = forecastPeriod(o);

  // THE REQUEST SHAPE HERE WAS DERIVED FROM THE API, NOT FROM THE DOCS.
  //
  // The first version of this function was written from the published
  // CampaignToForecast description and Google rejected almost every field in
  // it. The shape below was established by probing the live v25 endpoint field
  // by field, because its error messages name what they do not recognise:
  //
  //   campaign.keywordPlanNetwork        does not exist - there is no network
  //                                      choice on a forecast at all
  //   campaign.geoModifiers              does not exist; geoTargetConstants does
  //   campaign.negativeKeywords          does not exist on this RPC
  //   campaign.conversionRate            does not exist on this RPC
  //   biddingStrategy.manualCpcBidMicros does not exist;
  //                                      manualCpcBiddingStrategy.maxCpcBidMicros does
  //   adGroups[].biddableKeywords        does not exist; adGroups[].keywords does
  //   adGroups[].keywords[].keyword      does not exist - the keyword is FLAT
  //   adGroups[].keywords[].maxCpcBidMicros  does not exist - the bid is per
  //                                      strategy, not per keyword
  //   forecastPeriod.days                does not exist - it is a plain
  //                                      DateRange, and `days` was our own
  //                                      derived field leaking into the request
  //
  // Every line below was confirmed to return a real forecast.
  const campaign = {
    biddingStrategy: { manualCpcBiddingStrategy: { maxCpcBidMicros: bidMicros } },
    adGroups: [{
      keywords: keywords.map((text) => ({ text, matchType })),
    }],
  };
  const geo = geoTargets(m, o.geoTargetIds);
  if (geo.length) campaign.geoTargetConstants = geo;
  campaign.languageConstants = ['languageConstants/' + lang.id];

  const parsed = await ads().adsRequest(
    p.userId,
    '/customers/' + p.customerId + ':generateKeywordForecastMetrics',
    {
      // `days` is stripped: it is ours, for the per-day arithmetic below, and
      // Google rejects the whole request if it is sent.
      body: { campaign, forecastPeriod: { startDate: period.startDate, endDate: period.endDate } },
      loginCustomerId: p.loginCustomerId,
    },
  );

  const f = parsed.campaignForecastMetrics || {};
  const cost = micros(f.costMicros);
  return {
    kind: 'forecast',
    metrics: {
      impressions: num(f.impressions),
      clicks: num(f.clicks),
      ctr: f.clickThroughRate == null ? null : Math.round(Number(f.clickThroughRate) * 10000) / 100,
      averageCpc: micros(f.averageCpcMicros),
      cost,
      conversions: num(f.conversions),
      conversionRate: f.conversionRate == null ? null : Math.round(Number(f.conversionRate) * 10000) / 100,
      averageCpa: micros(f.averageCpaMicros),
      // NOT from Google: the arithmetic a planner does next anyway, shown so
      // nobody retypes it into a calculator. Labelled as derived in the view.
      costPerDay: cost != null && period.days ? Math.round((cost / period.days) * 100) / 100 : null,
    },
    period,
    keywordCount: keywords.length,
    matchType,
    maxCpcBid: bidMicros / 1e6,
    // Google's forecast RPC has no conversion-rate input, so conversions are
    // only ever reported if it chooses to. Recorded as null rather than
    // dropped, so the view keeps saying why the figure is absent.
    conversionRateInput: null,
    basis: basisFor(p, m, lang, network),
    truncatedSeed: Math.max(0, all.length - MAX_FORECAST_KEYWORDS),
  };
}

// ------------------------------------------------------- 5b. Bing-only rows

// A result for "I only want Bing", with no Google Ads call at all.
//
// WHY THIS EXISTS. Keyword Planner is Google's tool, so the ideas half cannot
// run without it - Bing has no keyword-suggestion endpoint here. But the
// "metrics for my list" half is just "here are my keywords, what are they
// worth", and Bing can answer that on its own. Skipping the Ads call then has
// two real benefits: it spends no Google Ads quota, and it works for a team
// that has no Ads account connected at all.
//
// The rows are deliberately the SAME SHAPE the Google path produces, with
// every Google-only field left null, so the table, the filters, the sort and
// the CSV all work unchanged and nothing downstream has to know which engine
// answered.
function bingOnlyResult(keywords, opts) {
  const o = opts || {};
  const all = (keywords || []).filter(Boolean);
  if (!all.length) throw new Error('Enter at least one keyword.');
  const list = all.slice(0, MAX_HISTORICAL_KEYWORDS);
  const m = markets.resolve(o.market);

  return {
    kind: 'historical',
    engines: ['bing'],
    rows: list.map((k) => metricsRow(String(k), null, { closeVariants: [] })),
    total: list.length,
    returned: list.length,
    filteredOut: 0,
    missing: [],
    devices: null,
    // No Ads account was used, so the basis must not imply one.
    basis: {
      account: 'no Google Ads call - Bing Webmaster Tools only',
      mode: 'bing-only',
      staleOwnSelection: null,
      market: m.name,
      language: resolveLanguage(o.language).name,
      network: 'Bing',
      apiVersion: 'n/a',
    },
    truncatedSeed: Math.max(0, all.length - MAX_HISTORICAL_KEYWORDS),
  };
}

// ------------------------------------------------------------ 5. Bing volume

// Bing Webmaster Tools volume, alongside Google's.
//
// WHAT THIS IS FOR. Two search engines disagreeing is information. A keyword
// with healthy Google volume and near-zero Bing volume usually skews young,
// mobile or technical; the reverse skews older and desktop, which in some
// verticals is the buying audience. Neither number is a correction of the
// other and this never blends them.
//
// WHAT IT IS NOT. These are BING's searches, not Google's, and they are much
// smaller - Bing's share of search is a fraction of Google's and varies by
// country. The column is labelled as Bing throughout for that reason, and the
// figure is deliberately NOT scaled by an assumed Google/Bing ratio: a scaled
// number would read exactly like a Google volume while being a guess built on
// a guess. The honest use is relative - which keyword is bigger on Bing, and
// by roughly how much.
//
// SLOW BY CONSTRUCTION. Bing's GetKeywordStats takes ONE keyword per request,
// so this is one HTTP round trip per keyword at a concurrency of four. That is
// why it is opt-in, capped, and applied to the rows already on screen rather
// than to every idea Google returned.
// Every row on the page gets checked. Kept in step with keywordMetrics' own
// ceiling, because that module does the slicing - a larger number here would
// promise rows it silently drops. This is a request-duration guard, not a
// quota: see the measurements in keywordMetrics.js.
const BING_ROW_CAP = Math.max(1, Number(process.env.BING_MAX_KEYWORDS) || 1000);

async function attachBingVolume(rows, opts) {
  const o = opts || {};
  const keywordMetrics = require('./keywordMetrics');
  const dataCredentials = require('../dataCredentials');

  const cred = dataCredentials.resolve('bing', { brandId: o.brandId || null });
  if (cred && cred.error) return { rows, note: `Bing volume unavailable: ${cred.error}` };
  const values = (cred && cred.values) || null;
  if (!values && !process.env.BING_WEBMASTER_API_KEY) {
    return {
      rows,
      note: 'Bing volume needs a free Bing Webmaster Tools API key (bing.com/webmasters, Settings > API access). Add it under the brand\'s data credentials to show a Bing column here.',
    };
  }

  const target = rows.slice(0, BING_ROW_CAP);
  if (!target.length) return { rows, note: null };

  try {
    const map = await keywordMetrics.bingVolume(target.map((r) => r.keyword), o.market, values);
    let matched = 0;
    // `bingChecked` is the point of this loop as much as the volume is.
    //
    // A row past the cap and a row Bing had no data for BOTH end up with no
    // number, and rendering them the same way tells the reader that Bing
    // looked and found nothing - when in fact it never looked. On a 500-row
    // ideas run that mislabels 380 rows. The flag lets the table say which is
    // which, and it is set on the slice that was actually sent, not inferred
    // from whether an answer came back.
    const merged = rows.map((r, i) => {
      const checked = i < target.length;
      const hit = checked ? map.get(String(r.keyword).toLowerCase()) : null;
      if (hit && hit.volume != null) matched += 1;
      return Object.assign({}, r, {
        bingChecked: checked,
        bingVolume: hit && hit.volume != null ? hit.volume : null,
        bingMonthly: (hit && hit.monthly) || null,
      });
    });
    const capped = rows.length > target.length;
    const throttle = map.throttled || null;
    return {
      rows: merged,
      checked: target.length,
      matched,
      capped,
      throttled: throttle,
      note: (matched
        ? `Bing had data for ${matched} of the ${target.length} keywords it was asked about`
          + (capped ? `. The remaining ${rows.length - target.length} rows were not looked up` : '')
          + '. Bing searches are not Google searches and are much smaller - compare keywords against each other within the Bing column, not against the Google one.'
        : `Bing was asked about ${target.length} keywords and had data for none of them.`
          + (capped ? ` The other ${rows.length - target.length} rows were not looked up.` : ''))
        + (throttle
          ? ` Bing rate-limited this run after ${throttle.answered} of ${throttle.asked} keywords`
            + (throttle.stoppedEarly ? ' and the rest were skipped rather than retried pointlessly' : '')
            + '. Its allowance refills over a few minutes, so the unanswered rows are not "no data" - re-run a shorter list, or wait and try again.'
          : ''),
    };
  } catch (err) {
    // Never fatal: the Google half of the page is already rendered and correct.
    return { rows, note: `Bing volume was not attached: ${err.message}` };
  }
}

// ------------------------------------------------------- 4. geo target search

// Keyword Planner targets cities, regions and metros, not just countries. The
// markets table in this app only knows countries, so this exposes Google's own
// location search and the page passes the chosen ids straight through.
async function suggestGeoTargets(userId, query, opts) {
  const o = opts || {};
  const q = String(query || '').trim();
  if (!q) return [];
  const p = principalFor(userId);
  const body = {
    locale: String(o.locale || 'en').toLowerCase(),
    locationNames: { names: [q] },
  };
  if (o.countryCode && String(o.countryCode).toUpperCase() !== 'ZZ') {
    body.countryCode = String(o.countryCode).toUpperCase();
  }
  const parsed = await ads().adsRequest(p.userId, '/geoTargetConstants:suggest', {
    body,
    loginCustomerId: p.loginCustomerId,
  });
  return (parsed.geoTargetConstantSuggestions || []).map((s) => {
    const g = s.geoTargetConstant || {};
    return {
      id: String(g.id || (g.resourceName || '').split('/').pop() || ''),
      name: g.name || '',
      type: g.targetType || null,
      countryCode: g.countryCode || null,
      reach: num(s.reach),
      // The parent chain is what tells Birmingham (UK) from Birmingham
      // (Alabama); without it the dropdown is a coin flip.
      parents: (s.geoTargetConstantParents || []).map((x) => x.name).filter(Boolean),
    };
  }).filter((x) => x.id && x.name);
}

// ------------------------------------------------------------------ filtering

function tokenList(v) {
  return String(v || '')
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Keyword Planner's own refinement controls, applied after the fetch. These
// RPCs accept none of them as request parameters, so filtering here is not a
// shortcut - it is the only place it can happen.
function applyFilters(rows, opts) {
  const o = opts || {};
  const minVolume = num(o.minVolume);
  const maxVolume = num(o.maxVolume);
  const maxCompetition = num(o.maxCompetitionIndex);
  const maxBid = num(o.maxTopBid);
  const include = tokenList(o.includeTerms);
  const exclude = tokenList(o.excludeTerms);
  const minWords = num(o.minWords);
  const questionsOnly = Boolean(o.questionsOnly);

  return rows.filter((r) => {
    if (minVolume != null && (r.volume == null || r.volume < minVolume)) return false;
    if (maxVolume != null && r.volume != null && r.volume > maxVolume) return false;
    if (maxCompetition != null && r.competitionIndex != null && r.competitionIndex > maxCompetition) return false;
    if (maxBid != null && r.highBid != null && r.highBid > maxBid) return false;
    const kw = r.keyword.toLowerCase();
    if (include.length && !include.some((t) => kw.indexOf(t) >= 0)) return false;
    if (exclude.length && exclude.some((t) => kw.indexOf(t) >= 0)) return false;
    if (minWords != null && kw.split(/\s+/).filter(Boolean).length < minWords) return false;
    if (questionsOnly && !QUESTION_RE.test(kw)) return false;
    return true;
  });
}

const QUESTION_RE = /^(how|what|why|when|where|who|which|can|do|does|is|are|should|will)\s|\?/;

const SORTS = {
  volume: (a, b) => (b.volume || 0) - (a.volume || 0),
  volume_asc: (a, b) => (a.volume || 0) - (b.volume || 0),
  competition: (a, b) => (a.competitionIndex == null ? 101 : a.competitionIndex)
    - (b.competitionIndex == null ? 101 : b.competitionIndex),
  bid: (a, b) => (b.highBid || 0) - (a.highBid || 0),
  trend: (a, b) => (b.trendPct == null ? -1e9 : b.trendPct) - (a.trendPct == null ? -1e9 : a.trendPct),
  alpha: (a, b) => a.keyword.localeCompare(b.keyword),
};

function sortRows(rows, key) {
  return rows.slice().sort(SORTS[key] || SORTS.volume);
}

function deviceBreakdown(agg) {
  const list = (agg && agg.deviceSearchesList) || [];
  if (!list.length) return null;
  const total = list.reduce((s, d) => s + (num(d.searchCount) || 0), 0);
  if (!total) return null;
  return list.map((d) => ({
    device: String(d.device || 'UNKNOWN').toLowerCase().replace(/_/g, ' '),
    searches: num(d.searchCount),
    share: Math.round(((num(d.searchCount) || 0) / total) * 1000) / 10,
  })).sort((a, b) => (b.searches || 0) - (a.searches || 0));
}

// Keyword Planner's grouped-ideas view, rebuilt from the concept annotations.
function groupByConcept(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = r.conceptGroup || 'Ungrouped';
    if (!groups.has(key)) groups.set(key, { name: key, keywords: 0, volume: 0 });
    const g = groups.get(key);
    g.keywords += 1;
    g.volume += r.volume || 0;
  });
  return Array.from(groups.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 40);
}

// ----------------------------------------------------------------------- CSV

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(result) {
  // The Bing column only appears when Bing was actually asked - an empty
  // column of blanks in an export reads as "Bing says zero", which is a
  // different claim from "Bing was not consulted".
  const hasBing = (result.rows || []).some((r) => r.bingVolume != null);
  const head = ['keyword', 'avg_monthly_searches', 'competition', 'competition_index',
    'low_top_of_page_bid', 'high_top_of_page_bid', 'average_cpc',
    'three_month_change_pct', 'year_on_year_change_pct', 'trend_pct',
    'concept_group', 'close_variants']
    .concat(hasBing ? ['bing_monthly_searches'] : []);
  // Month columns come from the first row that has a curve, so a CSV opened in
  // a spreadsheet has one column per month rather than a JSON blob in a cell.
  const months = ((result.rows || []).find((r) => r.monthly) || {}).monthly || [];
  const monthCols = months.map((m) => m.label);
  const lines = [head.concat(monthCols).join(',')];

  (result.rows || []).forEach((r) => {
    const byLabel = new Map((r.monthly || []).map((m) => [m.label, m.volume]));
    const cells = [
      r.keyword, r.volume, r.competition, r.competitionIndex,
      r.lowBid, r.highBid, r.averageCpc,
      r.change3m, r.changeYoY, r.trendPct,
      r.conceptGroup, (r.closeVariants || []).join(' | '),
    ].concat(hasBing ? [r.bingVolume] : [])
      .concat(monthCols.map((c) => (byLabel.has(c) ? byLabel.get(c) : '')));
    lines.push(cells.map(csvCell).join(','));
  });
  return lines.join('\r\n');
}

// Splits a textarea or a pasted CSV column into keywords. Deliberately the
// same contract as the clustering page, so a list pasted into one works in the
// other.
function parseKeywords(input) {
  const seen = new Set();
  const out = [];
  String(input || '').split(/[\r\n]+/).forEach((line) => {
    let s = line.trim();
    if (!s) return;
    if (s.indexOf(',') >= 0) s = s.split(',')[0].trim();
    s = s.replace(/^["']+|["']+$/g, '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (key === 'keyword' || key === 'keywords' || key === 'query' || key === 'term') return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

module.exports = {
  ideas, historical, forecast, suggestGeoTargets, attachBingVolume, bingOnlyResult,
  parseKeywords, csv, resolveLanguage, forecastPeriod,
  LANGUAGES, NETWORKS, MATCH_TYPES,
  MAX_SEED_KEYWORDS, MAX_HISTORICAL_KEYWORDS, MAX_FORECAST_KEYWORDS,
};
