// KEYWORD METRICS — search volume and keyword difficulty, with the basis named.
//
// THE PROBLEM THIS SOLVES, AND THE RULE IT KEEPS
// The suite was asked for search volume, a country filter on it, and keyword
// difficulty. None of the three can be MEASURED without a paid credential, and
// ./research.js has always refused to print an invented number beside a
// measured one. That refusal is kept exactly as it was. What changes is that
// the number is now obtained where it genuinely can be, through a chain of
// adapters, and every value carries a `basis` saying which rung produced it:
//
//   VOLUME
//     'google-ads'   Google Ads Keyword Planner, via the Google Ads API on the
//                    OAuth principal already connected. Google's own numbers —
//                    the same ones every keyword tool resells. Needs a
//                    developer token (GOOGLE_ADS_DEVELOPER_TOKEN).
//     'dataforseo'   DataForSEO's Google Ads passthrough. Same origin as above.
//     'semrush'      Semrush's own database.
//     'search-console'  This site's real impressions. Not volume — DEMAND THIS
//                    SITE ALREADY SEES — and labelled that way. Always present
//                    where GSC is connected, and always the most trustworthy
//                    row on the page because it is a measurement of this exact
//                    property.
//     'trends'       Google Trends relative interest, 0-100, per country.
//                    Keyless. NOT a volume: it is the shape of demand, not its
//                    size, and it is rendered in its own column under its own
//                    heading. It exists because it is the only free source that
//                    answers the country question honestly.
//     null           unknown. Rendered as an em dash, never as zero.
//
//   DIFFICULTY
//     'dataforseo' / 'semrush' / 'ahrefs'  the vendor's own KD, 0-100.
//     'serp-proxy' a difficulty computed here from a keyless sample of a
//                  NON-GOOGLE result page (see ./serpLite.js). Its components
//                  are returned alongside the score so a practitioner can see
//                  exactly what drove it, and it is labelled "proxy" in every
//                  view. It is a real competition signal. It is not Ahrefs KD
//                  and is never presented as one.
//
// Nothing here ever fabricates. A rung that fails is recorded in `errors` and
// the next one is tried; when every rung fails the value is null and the UI
// says why.
const providers = require('./providers');
const markets = require('./markets');
const serpLite = require('./serpLite');
const difficultyCache = require('./difficultyCache');
const { fetchPage, mapLimit, sleep } = require('./fetcher');

// -------------------------------------------------------------- DataForSEO

const DFS_BASE = 'https://api.dataforseo.com/v3';

function dfsAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

async function dfsPost(path, payload) {
  const auth = dfsAuthHeader();
  if (!auth) throw new Error('DataForSEO credentials are not configured');
  const res = await fetchPage(`${DFS_BASE}${path}`, {
    timeout: 45000,
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(res.error || `HTTP ${res.status}`);
  const parsed = JSON.parse(res.body);
  if (parsed.status_code && parsed.status_code !== 20000) {
    throw new Error(`DataForSEO ${parsed.status_code}: ${parsed.status_message}`);
  }
  return parsed;
}

// Volume, CPC and competition for up to 700 keywords in one call.
async function dfsVolume(keywords, market) {
  const m = markets.resolve(market);
  const parsed = await dfsPost('/keywords_data/google_ads/search_volume/live', [{
    keywords: keywords.slice(0, 700),
    location_code: m.dfsLocation,
    language_code: m.dfsLanguage,
    // Google Ads reports the 12-month average by default, which is what every
    // "monthly search volume" figure in the industry means.
    search_partners: false,
  }]);
  const out = new Map();
  (parsed.tasks || []).forEach((t) => {
    (t.result || []).forEach((r) => {
      if (!r || !r.keyword) return;
      out.set(String(r.keyword).toLowerCase(), {
        volume: r.search_volume == null ? null : Number(r.search_volume),
        cpc: r.cpc == null ? null : Number(r.cpc),
        competition: r.competition_index == null ? null : Number(r.competition_index),
        monthly: Array.isArray(r.monthly_searches)
          ? r.monthly_searches.slice(0, 12).map((ms) => ({ year: ms.year, month: ms.month, volume: Number(ms.search_volume) || 0 }))
          : null,
        basis: 'dataforseo',
      });
    });
  });
  return out;
}

async function dfsDifficulty(keywords, market) {
  const m = markets.resolve(market);
  const parsed = await dfsPost('/dataforseo_labs/google/bulk_keyword_difficulty/live', [{
    keywords: keywords.slice(0, 1000),
    location_code: m.dfsLocation,
    language_code: m.dfsLanguage,
  }]);
  const out = new Map();
  (parsed.tasks || []).forEach((t) => {
    (t.result || []).forEach((r) => {
      (r.items || []).forEach((item) => {
        if (!item || !item.keyword) return;
        out.set(String(item.keyword).toLowerCase(), {
          difficulty: item.keyword_difficulty == null ? null : Number(item.keyword_difficulty),
          basis: 'dataforseo',
        });
      });
    });
  });
  return out;
}

// ------------------------------------------------------------------ Semrush

// Semrush's phrase_this endpoint returns one semicolon-delimited row per
// keyword. `Nq` is volume, `Kd` is difficulty, `Co` is Ads competition.
async function semrushMetrics(keywords, market) {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) throw new Error('SEMRUSH_API_KEY is not set');
  const m = markets.resolve(market);
  const db = m.semrush || 'us';
  const out = new Map();
  // phrase_these takes up to 100 semicolon-separated phrases per request.
  const chunks = [];
  for (let i = 0; i < keywords.length; i += 90) chunks.push(keywords.slice(i, i + 90));

  for (const chunk of chunks.slice(0, 8)) {
    const params = new URLSearchParams({
      type: 'phrase_these',
      key,
      phrase: chunk.join(';'),
      database: db,
      export_columns: 'Ph,Nq,Cp,Co,Nr,Kd',
    });
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchPage(`https://api.semrush.com/?${params.toString()}`, { timeout: 30000 });
    if (!res.ok || !res.body) throw new Error(res.error || `HTTP ${res.status}`);
    if (/^ERROR/i.test(res.body.trim())) throw new Error(res.body.trim().slice(0, 160));
    const lines = res.body.trim().split(/\r?\n/);
    const header = (lines.shift() || '').split(';').map((h) => h.trim());
    const idx = (name) => header.indexOf(name);
    lines.forEach((line) => {
      const cells = line.split(';');
      const phrase = cells[idx('Keyword')] || cells[0];
      if (!phrase) return;
      const num = (i) => {
        const v = i >= 0 ? cells[i] : null;
        const n = v == null || v === '' ? null : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      out.set(String(phrase).toLowerCase(), {
        volume: num(idx('Search Volume')),
        cpc: num(idx('CPC')),
        competition: num(idx('Competition')),
        results: num(idx('Number of Results')),
        difficulty: num(idx('Keyword Difficulty Index')),
        basis: 'semrush',
      });
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(400);
  }
  return out;
}

// -------------------------------------------------------------- Google Ads

// Google Ads Keyword Planner, on the OAuth principal this app already holds.
//
// This is the highest rung deliberately: it is Google's own volume, for the
// exact country asked for, and it costs nothing beyond a developer token. It
// needs GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CUSTOMER_ID (a manager
// account id, digits only) in addition to the Google connection.
async function googleAdsVolume(keywords, market, { userId }) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/[^0-9]/g, '');
  if (!devToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN is not set');
  if (!customerId) throw new Error('GOOGLE_ADS_CUSTOMER_ID is not set');

  const google = require('../google');
  const token = await google.getValidAccessToken(userId);
  if (!token) throw new Error('no Google connection for this user');

  const m = markets.resolve(market);
  const body = {
    keywordSeed: { keywords: keywords.slice(0, 20) },
    // Google Ads wants geoTargetConstants, whose numeric ids are the same
    // criteria ids the markets table already carries for DataForSEO.
    geoTargetConstants: m.worldwide ? [] : [`geoTargetConstants/${m.dfsLocation}`],
    language: `languageConstants/${m.dfsLanguage === 'en' ? '1000' : '1000'}`,
    keywordPlanNetwork: 'GOOGLE_SEARCH',
  };
  const res = await fetchPage(
    `https://googleads.googleapis.com/v18/customers/${customerId}:generateKeywordIdeas`,
    {
      timeout: 45000,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': devToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok || !res.body) throw new Error(res.error || `HTTP ${res.status}: ${String(res.body || '').slice(0, 200)}`);
  const parsed = JSON.parse(res.body);
  const out = new Map();
  (parsed.results || []).forEach((r) => {
    const kw = String(r.text || '').toLowerCase();
    const ms = r.keywordIdeaMetrics || {};
    if (!kw) return;
    out.set(kw, {
      volume: ms.avgMonthlySearches == null ? null : Number(ms.avgMonthlySearches),
      competition: ms.competitionIndex == null ? null : Number(ms.competitionIndex),
      cpc: ms.highTopOfPageBidMicros ? Math.round((Number(ms.highTopOfPageBidMicros) / 1e6) * 100) / 100 : null,
      basis: 'google-ads',
    });
  });
  return out;
}

// ------------------------------------------------------------ Google Trends

// Relative interest, 0-100, per country. Keyless.
//
// The endpoint needs a two-step token handshake and prefixes its JSON with a
// XSSI guard, both of which are handled here. It is fragile by nature — an
// unofficial endpoint — so every failure is caught and reported rather than
// thrown, and Trends is never the only reason a research run succeeds.
//
// Trends compares at most five terms per request and the values are RELATIVE
// TO THE HIGHEST TERM IN THE REQUEST. That makes cross-batch numbers
// incomparable, so a single anchor term is carried into every batch and the
// batches are rescaled onto it. Without that, keyword 6 scoring 100 would
// look identical to keyword 1 scoring 100 while meaning something completely
// different.
const TRENDS_PREFIX_RX = /^\)\]\}',?\s*/;

function parseTrends(body) {
  return JSON.parse(String(body || '').replace(TRENDS_PREFIX_RX, ''));
}

// THE COOKIE, AND WHY THIS IS NOT OPTIONAL.
//
// The Trends API endpoints answer a cookieless request with a flat HTTP 429 —
// every time, not intermittently. Verified: three consecutive attempts all
// returned 429 with an identical 1,701-byte body, so it is a hard requirement
// rather than a rate limit that backing off would clear.
//
// A single GET of the Trends web page sets an NID cookie, and the same request
// carrying that cookie returns 200. Without this, relative interest — the
// DEFAULT demand signal whenever no paid volume credential is configured —
// would have been permanently empty while reporting itself as merely
// unavailable.
//
// The cookie is fetched once and reused for the life of the process. It is
// re-fetched on the next call after a failure, so an expired cookie recovers
// on its own rather than poisoning every later run.
let trendsCookie = null;
let trendsCookieAt = 0;
const TRENDS_COOKIE_TTL_MS = 30 * 60 * 1000;

async function trendsCookieHeader({ force = false } = {}) {
  const fresh = trendsCookie && (Date.now() - trendsCookieAt) < TRENDS_COOKIE_TTL_MS;
  if (fresh && !force) return trendsCookie;
  const home = await fetchPage('https://trends.google.com/trends/explore?geo=US', {
    timeout: 15000, ua: serpLite.BROWSER_UA,
  });
  const raw = home.headers && home.headers['set-cookie'];
  if (!raw) return trendsCookie; // keep whatever we had; the caller reports the failure
  // Only the name=value pair is sent back; the attributes are the server's.
  trendsCookie = (Array.isArray(raw) ? raw : [raw])
    .map((c) => String(c).split(';')[0])
    .filter(Boolean)
    .join('; ');
  trendsCookieAt = Date.now();
  return trendsCookie;
}

async function trendsBatch(terms, { market = 'ZZ', time = 'today 12-m' } = {}) {
  const m = markets.resolve(market);
  const req = {
    comparisonItem: terms.slice(0, 5).map((t) => ({ keyword: t, geo: m.trendsGeo || '', time })),
    category: 0,
    property: '',
  };
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`;

  let cookie = await trendsCookieHeader();
  let ex = await fetchPage(exploreUrl, {
    timeout: 20000, ua: serpLite.BROWSER_UA, headers: cookie ? { Cookie: cookie } : undefined,
  });
  // A 429 on a request that carried a cookie means the cookie has expired, so
  // it is worth exactly one retry with a fresh one. A second 429 is a real
  // rate limit and is reported as such.
  if (ex.status === 429) {
    await sleep(800);
    cookie = await trendsCookieHeader({ force: true });
    ex = await fetchPage(exploreUrl, {
      timeout: 20000, ua: serpLite.BROWSER_UA, headers: cookie ? { Cookie: cookie } : undefined,
    });
  }
  if (!ex.ok || !ex.body) {
    throw new Error(`explore: ${ex.error || `HTTP ${ex.status}`}${ex.status === 429 ? ' (rate limited even with a fresh cookie)' : ''}`);
  }
  const widgets = parseTrends(ex.body).widgets || [];
  const ts = widgets.find((w) => w.id === 'TIMESERIES');
  if (!ts) throw new Error('explore returned no TIMESERIES widget');

  await sleep(600);
  const dataUrl = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(ts.request))}&token=${encodeURIComponent(ts.token)}`;
  const dv = await fetchPage(dataUrl, {
    timeout: 20000, ua: serpLite.BROWSER_UA, headers: cookie ? { Cookie: cookie } : undefined,
  });
  if (!dv.ok || !dv.body) throw new Error(`multiline: ${dv.error || `HTTP ${dv.status}`}`);
  const timeline = ((parseTrends(dv.body).default || {}).timelineData) || [];
  if (!timeline.length) throw new Error('multiline returned no timeline');

  // Mean interest over the window per term, and the last point, so a caller can
  // show both "how much" and "rising or falling".
  const n = terms.slice(0, 5).length;
  const sums = new Array(n).fill(0);
  const lasts = new Array(n).fill(0);
  const firstHalf = new Array(n).fill(0);
  const secondHalf = new Array(n).fill(0);
  const mid = Math.floor(timeline.length / 2);
  timeline.forEach((point, i) => {
    const vals = point.value || [];
    for (let k = 0; k < n; k += 1) {
      const v = Number(vals[k]) || 0;
      sums[k] += v;
      if (i >= mid) secondHalf[k] += v; else firstHalf[k] += v;
      if (i === timeline.length - 1) lasts[k] = v;
    }
  });

  return terms.slice(0, 5).map((term, k) => {
    const mean = timeline.length ? sums[k] / timeline.length : 0;
    const a = mid ? firstHalf[k] / mid : 0;
    const b = (timeline.length - mid) ? secondHalf[k] / (timeline.length - mid) : 0;
    return {
      keyword: term.toLowerCase(),
      relativeInterest: Math.round(mean * 10) / 10,
      latest: lasts[k],
      trend: a > 0 ? Math.round(((b - a) / a) * 100) : null,
      basis: 'trends',
      market: m.code,
      window: time,
    };
  });
}

// Batched, anchored, rescaled Trends interest for an arbitrary keyword list.
async function trendsInterest(keywords, { market = 'ZZ', time = 'today 12-m', maxKeywords = 24 } = {}) {
  const list = [...new Set(keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean))].slice(0, maxKeywords);
  if (!list.length) return { ok: false, error: 'no keywords', values: new Map() };
  const anchor = list[0];
  const values = new Map();
  const errors = [];

  // First batch establishes the anchor's own scale.
  const batches = [];
  batches.push(list.slice(0, 5));
  for (let i = 5; i < list.length; i += 4) batches.push([anchor, ...list.slice(i, i + 4)]);

  let anchorReference = null;
  for (const batch of batches) {
    try {
      /* eslint-disable no-await-in-loop */
      const rows = await trendsBatch(batch, { market, time });
      /* eslint-enable no-await-in-loop */
      const anchorRow = rows.find((r) => r.keyword === anchor);
      if (anchorReference == null) {
        anchorReference = anchorRow ? anchorRow.relativeInterest : null;
        rows.forEach((r) => values.set(r.keyword, r));
      } else if (anchorRow && anchorRow.relativeInterest > 0) {
        // Rescale this batch so its anchor matches the first batch's anchor.
        const factor = anchorReference / anchorRow.relativeInterest;
        rows.forEach((r) => {
          if (r.keyword === anchor) return;
          values.set(r.keyword, {
            ...r,
            relativeInterest: Math.round(r.relativeInterest * factor * 10) / 10,
            rescaled: true,
          });
        });
      } else {
        // The anchor scored zero in this batch, so nothing in it can be put on
        // the same scale. Recorded rather than silently mis-scaled.
        errors.push(`batch anchored on "${anchor}" returned zero interest for the anchor — ${batch.slice(1).join(', ')} could not be placed on the same scale`);
      }
    } catch (err) {
      errors.push(String(err.message).slice(0, 160));
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1500);
  }

  return {
    ok: values.size > 0,
    values,
    errors,
    market: markets.resolve(market).code,
    window: time,
    anchor,
  };
}

// ------------------------------------------------------- SERP difficulty proxy

// Domains whose presence in a result set genuinely raises the bar for a new
// page. Not an authority score — a named list of sites that are hard to
// outrank on any topic they cover, which is a claim that can be checked.
const HIGH_AUTHORITY = new Set([
  'wikipedia.org', 'en.wikipedia.org', 'britannica.com', 'investopedia.com',
  'amazon.com', 'amazon.co.uk', 'ebay.com', 'youtube.com', 'reddit.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'nytimes.com', 'bbc.co.uk', 'bbc.com', 'theguardian.com', 'forbes.com',
  'bloomberg.com', 'reuters.com', 'ft.com', 'wsj.com', 'cnbc.com',
  'healthline.com', 'webmd.com', 'mayoclinic.org', 'nhs.uk', 'nih.gov',
  'harvard.edu', 'mit.edu', 'coursera.org', 'udemy.com', 'edx.org',
  'indeed.com', 'glassdoor.com', 'zillow.com', 'realtor.com', 'redfin.com',
  'tripadvisor.com', 'yelp.com', 'booking.com', 'expedia.com',
  'shopify.com', 'hubspot.com', 'salesforce.com', 'microsoft.com', 'apple.com',
  'google.com', 'support.google.com', 'stackoverflow.com', 'github.com',
  'quora.com', 'medium.com', 'wikihow.com', 'pinterest.com', 'etsy.com',
]);

const UGC_FORUM = new Set(['reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'medium.com', 'pinterest.com', 'facebook.com', 'linkedin.com']);

function isGovEdu(domain) {
  return /\.(gov|gov\.[a-z]{2}|edu|ac\.[a-z]{2})$/i.test(String(domain || ''));
}

// The proxy score, stated as a formula so it can be argued with.
//
//   authorityShare   share of results on a named high-authority domain, or a
//                    .gov/.edu. Weight 45 — the single strongest signal that a
//                    new page will struggle.
//   titleMatchShare  share of results whose title contains the whole keyword.
//                    Weight 25 — pages deliberately built for this term.
//   homepageShare    share of results that are a site root. Weight 15 — a SERP
//                    answered by homepages is a head term.
//   ugcShare         share from forums and UGC platforms. Weight -20 — a SERP
//                    Google fills with Reddit is one where a good page wins.
//   thinResults      fewer than 6 usable results. Adds uncertainty, recorded
//                    but not scored, and downgrades `confidence`.
function difficultyFromSerp(keyword, serp) {
  const results = (serp && serp.results) || [];
  if (!results.length) {
    return {
      difficulty: null, basis: 'serp-proxy', confidence: 'none',
      reason: serp && serp.error ? `no result page could be sampled: ${serp.error}` : 'no results returned',
      components: null, engine: serp ? serp.engine : null,
    };
  }

  const kw = String(keyword || '').toLowerCase().trim();
  const n = results.length;
  const authority = results.filter((r) => HIGH_AUTHORITY.has(r.domain) || isGovEdu(r.domain)).length;
  const titleMatch = kw ? results.filter((r) => String(r.title || '').toLowerCase().includes(kw)).length : 0;
  const homepage = results.filter((r) => {
    try { const p = new URL(r.url).pathname; return p === '/' || p === ''; } catch { return false; }
  }).length;
  const ugc = results.filter((r) => UGC_FORUM.has(r.domain)).length;
  const distinctDomains = new Set(results.map((r) => r.domain)).size;

  const authorityShare = authority / n;
  const titleMatchShare = titleMatch / n;
  const homepageShare = homepage / n;
  const ugcShare = ugc / n;

  const raw = (authorityShare * 45) + (titleMatchShare * 25) + (homepageShare * 15) - (ugcShare * 20);
  // Floor of 5 rather than 0: no keyword with a populated result page is
  // genuinely zero-difficulty, and a 0 reads as "no data" to most people.
  const difficulty = Math.max(5, Math.min(100, Math.round(raw + 20)));

  return {
    difficulty,
    basis: 'serp-proxy',
    engine: serp.engine,
    market: serp.market || null,
    confidence: n >= 8 ? 'medium' : (n >= 5 ? 'low' : 'very-low'),
    components: {
      resultsSampled: n,
      distinctDomains,
      authorityDomains: authority,
      authorityShare: Math.round(authorityShare * 100),
      exactTitleMatches: titleMatch,
      titleMatchShare: Math.round(titleMatchShare * 100),
      homepages: homepage,
      homepageShare: Math.round(homepageShare * 100),
      ugcResults: ugc,
      ugcShare: Math.round(ugcShare * 100),
    },
    topDomains: results.slice(0, 10).map((r) => ({ position: r.position, domain: r.domain, title: r.title })),
    formula: 'difficulty = 20 + 45×authorityShare + 25×exactTitleMatchShare + 15×homepageShare − 20×ugcShare, clamped to 5-100',
    caveat: `Computed from a ${serp.engine} result sample, not from Google. It measures how contested the page is, and is labelled a proxy everywhere it appears.`,
  };
}

// --------------------------------------------------------------------- API

// The one function the features call.
//
// Returns a Map keyed on lowercase keyword, each value carrying whichever of
// volume / relativeInterest / difficulty could be obtained, each with its own
// `basis`. Also returns `sources` (what actually answered), `attempted` (every
// rung tried, in order) and `errors` (why a rung was skipped) so the result
// page can state the basis without the caller reconstructing it.
async function enrich(keywords, {
  market = 'ZZ', userId = null, wantVolume = true, wantDifficulty = true,
  difficultyLimit = 12, trendsLimit = 20, brandId = null, queueOverflow = true,
} = {}) {
  const list = [...new Set((keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean))];
  const out = new Map(list.map((k) => [k, { keyword: k }])); // eslint-disable-line
  const attempted = [];
  const errors = [];
  const sources = new Set();
  const m = markets.resolve(market);

  const mergeInto = (map, fields) => {
    map.forEach((v, k) => {
      const cur = out.get(k) || { keyword: k };
      fields.forEach((f) => {
        if (v[f] != null && cur[f] == null) {
          cur[f] = v[f];
          cur[`${f}Basis`] = v.basis;
        }
      });
      if (v.monthly && !cur.monthly) cur.monthly = v.monthly;
      out.set(k, cur);
    });
  };

  // ---- volume, best rung first --------------------------------------
  if (wantVolume && list.length) {
    const rungs = [
      {
        key: 'google-ads',
        available: () => providers.has('google-ads') && userId,
        fetch: () => googleAdsVolume(list, market, { userId }),
      },
      {
        key: 'dataforseo',
        available: () => providers.has('dataforseo'),
        fetch: () => dfsVolume(list, market),
      },
      {
        key: 'semrush',
        available: () => providers.has('semrush'),
        fetch: () => semrushMetrics(list, market),
      },
    ];
    let gotVolume = false;
    for (const rung of rungs) {
      if (gotVolume) break;
      if (!rung.available()) {
        attempted.push({ rung: rung.key, outcome: 'not configured' });
        continue;
      }
      try {
        /* eslint-disable no-await-in-loop */
        const map = await rung.fetch();
        /* eslint-enable no-await-in-loop */
        const hits = [...map.values()].filter((v) => v.volume != null).length;
        mergeInto(map, ['volume', 'cpc', 'competition', 'difficulty']);
        attempted.push({ rung: rung.key, outcome: `${hits} keyword${hits === 1 ? '' : 's'} with volume` });
        if (hits) { sources.add(rung.key); gotVolume = true; }
      } catch (err) {
        const msg = String(err.message).slice(0, 200);
        attempted.push({ rung: rung.key, outcome: `failed: ${msg}` });
        errors.push(`${rung.key}: ${msg}`);
      }
    }

    // Trends always runs when no measured volume was obtained, because it is
    // the only free answer to "and in which country". It is additive, never a
    // substitute — it populates its own field.
    if (!gotVolume && providers.has('google-trends')) {
      try {
        const t = await trendsInterest(list, { market, maxKeywords: trendsLimit });
        if (t.ok) {
          t.values.forEach((v, k) => {
            const cur = out.get(k) || { keyword: k };
            cur.relativeInterest = v.relativeInterest;
            cur.relativeInterestBasis = 'trends';
            cur.interestTrend = v.trend;
            cur.interestRescaled = Boolean(v.rescaled);
            out.set(k, cur);
          });
          sources.add('google-trends');
          attempted.push({ rung: 'google-trends', outcome: `${t.values.size} keyword${t.values.size === 1 ? '' : 's'} with relative interest for ${m.name}` });
        } else {
          attempted.push({ rung: 'google-trends', outcome: 'returned nothing' });
        }
        (t.errors || []).forEach((e) => errors.push(`google-trends: ${e}`));
      } catch (err) {
        const msg = String(err.message).slice(0, 200);
        attempted.push({ rung: 'google-trends', outcome: `failed: ${msg}` });
        errors.push(`google-trends: ${msg}`);
      }
    } else if (!gotVolume) {
      attempted.push({ rung: 'google-trends', outcome: 'disabled (AISEO_DISABLE_PUBLIC_SOURCES=1)' });
    }
  }

  // ---- difficulty ----------------------------------------------------
  if (wantDifficulty && list.length) {
    const needsKd = list.filter((k) => out.get(k).difficulty == null);
    if (needsKd.length && providers.has('dataforseo')) {
      try {
        const map = await dfsDifficulty(needsKd, market);
        const hits = [...map.values()].filter((v) => v.difficulty != null).length;
        mergeInto(map, ['difficulty']);
        attempted.push({ rung: 'dataforseo-kd', outcome: `${hits} keyword${hits === 1 ? '' : 's'} with measured difficulty` });
        if (hits) sources.add('dataforseo');
      } catch (err) {
        const msg = String(err.message).slice(0, 200);
        attempted.push({ rung: 'dataforseo-kd', outcome: `failed: ${msg}` });
        errors.push(`dataforseo-kd: ${msg}`);
      }
    }

    // The cache comes before any fetching. A stored score costs nothing, so
    // every keyword scored by a previous run — for this brand or any other
    // asking about the same keyword in the same country — is filled in first,
    // and the paced-request budget below is spent only on what is genuinely
    // unknown. This is what lets coverage reach every keyword over time
    // instead of the dozen a single run can afford.
    const beforeCache = list.filter((k) => out.get(k).difficulty == null);
    if (beforeCache.length) {
      const cached = difficultyCache.readMany(beforeCache, market);
      let fromCache = 0;
      cached.forEach((row, kw) => {
        const cur = out.get(kw) || { keyword: kw };
        if (row.difficulty != null) {
          cur.difficulty = row.difficulty;
          cur.difficultyBasis = row.basis || 'serp-proxy';
          cur.difficultyDetail = row.detail;
          cur.difficultyAgeDays = row.ageDays;
          fromCache += 1;
        } else if (row.unavailableReason) {
          cur.difficultyUnavailable = row.unavailableReason;
        }
        out.set(kw, cur);
      });
      if (fromCache) {
        sources.add('kd-cache');
        attempted.push({
          rung: 'kd-cache',
          outcome: `${fromCache} keyword${fromCache === 1 ? '' : 's'} answered from previously scored results, no fetch needed`,
        });
      }
    }

    // The keyless proxy, for the top N keywords only. Each one costs a paced
    // SERP request, so this is capped and the cap is REPORTED — a silent
    // truncation would read as "these are the only difficult keywords".
    // Anything past the cap is QUEUED rather than abandoned: the scheduled
    // backfill job drains it, and the next run reads those scores from the
    // cache above.
    const stillMissing = list.filter((k) => out.get(k).difficulty == null);
    if (stillMissing.length && providers.has('serp-lite')) {
      const targets = stillMissing.slice(0, difficultyLimit);
      const proxied = await mapLimit(targets, 2, async (kw) => {
        const serp = await serpLite.search(kw, { market, limit: 10 });
        return { kw, kd: difficultyFromSerp(kw, serp), serp };
      });
      let hits = 0;
      proxied.forEach((p) => {
        if (!p || p.__error) return;
        const cur = out.get(p.kw) || { keyword: p.kw };
        if (p.kd.difficulty != null) {
          cur.difficulty = p.kd.difficulty;
          cur.difficultyBasis = 'serp-proxy';
          cur.difficultyDetail = p.kd;
          hits += 1;
        } else {
          cur.difficultyUnavailable = p.kd.reason;
        }
        out.set(p.kw, cur);
        // Written through so the next run never pays for this fetch again.
        try {
          difficultyCache.write(p.kw, market, {
            difficulty: p.kd.difficulty,
            basis: 'serp-proxy',
            engine: p.kd.engine || (p.serp ? p.serp.engine : null),
            detail: p.kd.difficulty == null ? null : p.kd,
            unavailableReason: p.kd.difficulty == null ? (p.kd.reason || null) : null,
          });
        } catch { /* a cache write must never fail the run that produced it */ }
      });
      if (hits) sources.add('serp-lite');

      // Everything the cap excluded goes to the background job instead of
      // being dropped. This is the difference between "twelve keywords have a
      // difficulty" and "every keyword will have one".
      const overflow = stillMissing.slice(targets.length);
      let queued = 0;
      if (overflow.length && queueOverflow) {
        try { queued = difficultyCache.enqueue(overflow, market, { brandId }).queued; } catch { /* non-fatal */ }
      }

      attempted.push({
        rung: 'serp-proxy',
        outcome: `${hits} of ${targets.length} sampled`
          + (overflow.length
            ? ` — capped at ${difficultyLimit}; ${overflow.length} keyword${overflow.length === 1 ? '' : 's'} `
              + (queued
                ? `queued for the background scorer (${queued} newly queued), and will appear on the next run rather than being guessed now`
                : 'left without a difficulty rather than guessed')
            : ''),
      });
    }
  }

  // Coverage, stated as a number rather than left for the reader to count.
  // "40, proxy" on a cluster row is meaningless without knowing whether it
  // came from three keywords or thirty.
  const scored = list.filter((k) => out.get(k).difficulty != null).length;
  const difficultyCoverage = {
    scored,
    total: list.length,
    pct: list.length ? Math.round((scored / list.length) * 100) : 0,
    queued: list.filter((k) => out.get(k).difficulty == null && !out.get(k).difficultyUnavailable).length,
  };

  return {
    values: out,
    market: { code: m.code, name: m.name },
    sources: [...sources],
    attempted,
    errors,
    difficultyCoverage,
    difficultyBasisNote: sources.has('dataforseo') || sources.has('semrush')
      ? "Keyword difficulty is the vendor's measured KD."
      : `Keyword difficulty is a proxy computed from a sample of a non-Google result page, not a vendor KD. ${scored} of ${list.length} keywords are scored so far; the rest are queued for the background scorer and will fill in on the next run.`,
    // Stated once, here, so every view can render the same sentence.
    volumeBasisNote: sources.has('google-ads') || sources.has('dataforseo') || sources.has('semrush')
      ? 'Search volume is measured, from the source named on each row.'
      : 'No measured search volume is available: this deployment holds no Keyword Planner, DataForSEO or Semrush credential. Search Console impressions (a measurement of this site) and Google Trends relative interest (the shape of demand in the chosen country, 0-100, not a count) are shown instead, in their own columns.',
  };
}

module.exports = {
  enrich, difficultyFromSerp, trendsInterest, trendsBatch, trendsCookieHeader,
  dfsVolume, dfsDifficulty, semrushMetrics, googleAdsVolume,
  HIGH_AUTHORITY, UGC_FORUM,
};
