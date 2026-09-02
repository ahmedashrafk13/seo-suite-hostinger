// Google OAuth2 + API helpers. The code-exchange flow mirrors
// gsc-ga4-oauth-server/auth.js (authorization_code -> tokens, refresh_token
// renewal) but uses google-auth-library's OAuth2Client instead of hand-rolled
// axios calls, and persists tokens per-user in google_connections (SQLite)
// instead of a shared tokens.json file.
const { google } = require('googleapis');
const db = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 4200}/api/auth/google/callback`;
}

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function buildAuthUrl() {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function exchangeCodeForTokens(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, ... }
}

function saveConnection(userId, tokens, connectedEmail) {
  const existing = db.prepare('SELECT id, refresh_token FROM google_connections WHERE user_id = ?').get(userId);
  const refreshToken = tokens.refresh_token || (existing && existing.refresh_token) || null;
  if (existing) {
    db.prepare(`UPDATE google_connections SET access_token=?, refresh_token=?, expiry=?, scope=?, connected_email=?, updated_at=datetime('now') WHERE id=?`)
      .run(tokens.access_token, refreshToken, tokens.expiry_date || null, tokens.scope || null, connectedEmail || null, existing.id);
  } else {
    db.prepare(`INSERT INTO google_connections (user_id, access_token, refresh_token, expiry, scope, connected_email) VALUES (?,?,?,?,?,?)`)
      .run(userId, tokens.access_token, refreshToken, tokens.expiry_date || null, tokens.scope || null, connectedEmail || null);
  }
}

function getConnection(userId) {
  return db.prepare('SELECT * FROM google_connections WHERE user_id = ?').get(userId);
}

function disconnect(userId) {
  db.prepare('DELETE FROM google_connections WHERE user_id = ?').run(userId);
}

// Returns a valid access token for the user, refreshing via refresh_token if expired.
// Throws if the user has no connection or no refresh_token available.
async function getValidAccessToken(userId) {
  const conn = getConnection(userId);
  if (!conn || !conn.access_token) {
    throw new Error('Google account not connected.');
  }
  const isExpired = !conn.expiry || Date.now() >= conn.expiry - 60_000;
  if (!isExpired) return conn.access_token;

  if (!conn.refresh_token) {
    throw new Error('Access token expired and no refresh token is available. Please reconnect your Google account.');
  }

  const client = makeOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token });
  const { credentials } = await client.refreshAccessToken();
  saveConnection(userId, credentials, conn.connected_email);
  return credentials.access_token;
}

async function getEmailFromIdToken(tokens) {
  try {
    const client = makeOAuthClient();
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    return data.email || null;
  } catch (e) {
    return null;
  }
}

async function listGscSites(userId) {
  const accessToken = await getValidAccessToken(userId);
  const client = makeOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const webmasters = google.webmasters({ version: 'v3', auth: client });
  const res = await webmasters.sites.list();
  return res.data.siteEntry || [];
}

async function listGa4Properties(userId) {
  const accessToken = await getValidAccessToken(userId);
  const client = makeOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const analyticsadmin = google.analyticsadmin({ version: 'v1beta', auth: client });
  const res = await analyticsadmin.accountSummaries.list();
  return res.data.accountSummaries || [];
}

// GSC search analytics rows for a site, used to build --gsc-csv input and for
// alert evaluation. Returns array of {keys: [date], clicks, impressions, ctr, position}
// or aggregated by page when dimensions=['page'].
async function searchAnalyticsQuery(userId, siteUrl, { startDate, endDate, dimensions = ['page'], rowLimit = 5000 }) {
  const accessToken = await getValidAccessToken(userId);
  const client = makeOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const webmasters = google.webmasters({ version: 'v3', auth: client });
  const res = await webmasters.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions, rowLimit },
  });
  return res.data.rows || [];
}

// Paginates searchanalytics so we are not silently capped at rowLimit.
// GSC returns at most 25 000 rows per request; `startRow` walks past that.
async function searchAnalyticsAll(userId, siteUrl, { startDate, endDate, dimensions = ['page'], maxRows = 25000, dimensionFilterGroups }) {
  const client = await authedClient(userId);
  const webmasters = google.webmasters({ version: 'v3', auth: client });
  const pageSize = 25000;
  const out = [];
  for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
    const rowLimit = Math.min(pageSize, maxRows - startRow);
    const res = await webmasters.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions, rowLimit, startRow, dimensionFilterGroups },
    });
    const rows = res.data.rows || [];
    out.push(...rows);
    if (rows.length < rowLimit) break;
  }
  return out;
}

async function authedClient(userId) {
  const accessToken = await getValidAccessToken(userId);
  const client = makeOAuthClient();
  client.setCredentials({ access_token: accessToken });
  return client;
}

// ------------------------------------------------------------------- GA4
// Runs a GA4 report. `metrics`/`dimensions` are plain string arrays; the
// return value is normalised to [{ dimensions: [...], metrics: {name: number} }]
// so callers never touch GA4's dimensionValues/metricValues shape.
async function ga4RunReport(userId, propertyId, { startDate, endDate, dimensions = [], metrics = [], dimensionFilter, limit = 25000, orderBys }) {
  const client = await authedClient(userId);
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: client });
  const property = String(propertyId).startsWith('properties/') ? String(propertyId) : `properties/${propertyId}`;
  const res = await analyticsdata.properties.runReport({
    property,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      dimensionFilter,
      orderBys,
      limit,
    },
  });
  const headers = (res.data.metricHeaders || []).map((h) => h.name);
  return (res.data.rows || []).map((row) => {
    const metricObj = {};
    headers.forEach((name, i) => {
      const raw = row.metricValues && row.metricValues[i] ? row.metricValues[i].value : '0';
      const n = Number(raw);
      metricObj[name] = Number.isFinite(n) ? n : 0;
    });
    return {
      dimensions: (row.dimensionValues || []).map((d) => d.value),
      metrics: metricObj,
    };
  });
}

// GA4 cohort/retention report. Unlike ga4RunReport, a cohort request has no
// dateRanges — the date range lives inside each cohort's dateRange, and the
// dimension/metric set is fixed to firstSessionDate/cohort + cohortActiveUsers
// by the caller. Returned rows are normalised the same way as ga4RunReport.
async function ga4RunCohortReport(userId, propertyId, { cohorts, cohortsRange, dimensions = ['cohort', 'cohortNthWeek'], metrics = ['cohortActiveUsers'], limit = 1000 }) {
  const client = await authedClient(userId);
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: client });
  const property = String(propertyId).startsWith('properties/') ? String(propertyId) : `properties/${propertyId}`;
  const res = await analyticsdata.properties.runReport({
    property,
    requestBody: {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      cohortSpec: {
        cohorts,
        cohortsRange,
      },
      limit,
    },
  });
  const headers = (res.data.metricHeaders || []).map((h) => h.name);
  return (res.data.rows || []).map((row) => {
    const metricObj = {};
    headers.forEach((name, i) => {
      const raw = row.metricValues && row.metricValues[i] ? row.metricValues[i].value : '0';
      const n = Number(raw);
      metricObj[name] = Number.isFinite(n) ? n : 0;
    });
    return { dimensions: (row.dimensionValues || []).map((d) => d.value), metrics: metricObj };
  });
}

// GA4 Realtime Data API — active users right now, mirroring the "Active users
// in last 30 minutes" widget on the GA4 Home report. No date range: this API
// only ever answers "right now."
async function ga4RunRealtimeReport(userId, propertyId, { dimensions = [], metrics = ['activeUsers'], limit = 25 } = {}) {
  const client = await authedClient(userId);
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: client });
  const property = String(propertyId).startsWith('properties/') ? String(propertyId) : `properties/${propertyId}`;
  const res = await analyticsdata.properties.runRealtimeReport({
    property,
    requestBody: {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit,
    },
  });
  const headers = (res.data.metricHeaders || []).map((h) => h.name);
  return (res.data.rows || []).map((row) => {
    const metricObj = {};
    headers.forEach((name, i) => {
      const raw = row.metricValues && row.metricValues[i] ? row.metricValues[i].value : '0';
      const n = Number(raw);
      metricObj[name] = Number.isFinite(n) ? n : 0;
    });
    return { dimensions: (row.dimensionValues || []).map((d) => d.value), metrics: metricObj };
  });
}

// GA4 Metadata API — lists every dimension/metric available for a property,
// including custom dimensions/metrics (customDefinition: true). Verified
// against node_modules/googleapis@144.0.0: analyticsdata.properties.getMetadata
// exists (src/apis/analyticsdata/v1beta.d.ts, Params$Resource$Properties$Getmetadata)
// and returns Schema$Metadata { dimensions: Schema$DimensionMetadata[], metrics:
// Schema$MetricMetadata[] }, each with apiName/uiName/customDefinition.
async function ga4GetMetadata(userId, propertyId) {
  const client = await authedClient(userId);
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: client });
  const property = String(propertyId).startsWith('properties/') ? String(propertyId) : `properties/${propertyId}`;
  const res = await analyticsdata.properties.getMetadata({ name: `${property}/metadata` });
  return {
    dimensions: res.data.dimensions || [],
    metrics: res.data.metrics || [],
  };
}

// GA4 reports `date` as YYYYMMDD; everything else in this app uses YYYY-MM-DD.
function ga4DateToIso(v) {
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v;
}

// Verifies a GA4 property is actually readable, returning a friendly reason
// when it is not (wrong id, no access, property deleted).
async function ga4Probe(userId, propertyId) {
  try {
    await ga4RunReport(userId, propertyId, {
      startDate: '7daysAgo', endDate: 'yesterday', metrics: ['sessions'], limit: 1,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------- Search Console extras
async function listSitemaps(userId, siteUrl) {
  const client = await authedClient(userId);
  const webmasters = google.webmasters({ version: 'v3', auth: client });
  const res = await webmasters.sitemaps.list({ siteUrl });
  return res.data.sitemap || [];
}

// URL Inspection API — the only way to read real indexation state, and the
// source for the "page deindexed" and "manual action" alert types.
// Quota is 2 000 calls/day/property, so callers must sample rather than sweep.
async function inspectUrl(userId, siteUrl, inspectionUrl) {
  const client = await authedClient(userId);
  const searchconsole = google.searchconsole({ version: 'v1', auth: client });
  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: { siteUrl, inspectionUrl, languageCode: 'en-US' },
  });
  return res.data.inspectionResult || null;
}

// ------------------------------------------------------------- URL Removals
// NOT AVAILABLE: Search Console's "Removals" report (temporary URL removal
// requests) is served by a separate "Removals API" that Google has never
// published in the discovery documents googleapis' code generator reads
// from. Checked node_modules/googleapis@144.0.0 (the version installed
// here): src/apis/searchconsole/v1.js only registers five resources —
// searchanalytics, sitemaps, sites, urlInspection, urlTestingTools — there
// is no urlNotifications/removals resource shipped anywhere in the package.
// (The Indexing API's urlNotifications.publish is a different, unrelated
// endpoint for a different product and cannot submit/list removal requests.)
// So there is no real client method to wrap here — inventing one would just
// 404. Leaving this stub so the intent is documented and callers get a
// clear, typed error instead of a crash if anyone wires it up later.
async function listRemovals() {
  throw new Error('GSC URL Removals is not available: no removals resource exists in the installed googleapis package (v144.0.0 checked). Google has not published this API for public client generation.');
}

// ------------------------------------------------------ PageSpeed Insights
// PSI v5 works without a key at low volume, but a key (PSI_API_KEY) raises the
// quota substantially. Returns lab Lighthouse metrics plus CrUX field data
// when Google has enough real-user traffic for the origin.
async function pageSpeed(url, strategy = 'mobile') {
  const key = process.env.PSI_API_KEY || '';
  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  if (key) params.set('key', key);
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;

  const res = await fetch(endpoint, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PageSpeed Insights returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();

  const audits = (data.lighthouseResult && data.lighthouseResult.audits) || {};
  const categories = (data.lighthouseResult && data.lighthouseResult.categories) || {};
  const num = (id) => (audits[id] && typeof audits[id].numericValue === 'number' ? audits[id].numericValue : null);

  // Field data (CrUX) is preferred for Core Web Vitals — it is what Google
  // actually ranks on. Fall back to lab numbers when the origin has no field data.
  const loading = data.loadingExperience || {};
  const fm = loading.metrics || {};
  const field = (k) => (fm[k] && typeof fm[k].percentile === 'number' ? fm[k].percentile : null);

  const fieldLcp = field('LARGEST_CONTENTFUL_PAINT_MS');
  const fieldInp = field('INTERACTION_TO_NEXT_PAINT');
  const fieldCls = field('CUMULATIVE_LAYOUT_SHIFT_SCORE');

  return {
    url: data.id || url,
    strategy,
    perf_score: categories.performance ? Math.round(categories.performance.score * 100) : null,
    // LCP/FCP/TTFB in ms, CLS unitless. CrUX reports CLS x100, so scale it back.
    lcp: fieldLcp !== null ? fieldLcp : num('largest-contentful-paint'),
    inp: fieldInp !== null ? fieldInp : num('interactive'),
    cls: fieldCls !== null ? fieldCls / 100 : num('cumulative-layout-shift'),
    fcp: field('FIRST_CONTENTFUL_PAINT_MS') !== null ? field('FIRST_CONTENTFUL_PAINT_MS') : num('first-contentful-paint'),
    ttfb: field('EXPERIMENTAL_TIME_TO_FIRST_BYTE') !== null ? field('EXPERIMENTAL_TIME_TO_FIRST_BYTE') : num('server-response-time'),
    source: (fieldLcp !== null || fieldInp !== null) ? 'crux-field' : 'lighthouse-lab',
    overall: loading.overall_category || null,
  };
}

module.exports = {
  SCOPES,
  isConfigured,
  buildAuthUrl,
  exchangeCodeForTokens,
  saveConnection,
  getConnection,
  disconnect,
  getValidAccessToken,
  getEmailFromIdToken,
  listGscSites,
  listGa4Properties,
  searchAnalyticsQuery,
  searchAnalyticsAll,
  ga4RunReport,
  ga4RunCohortReport,
  ga4RunRealtimeReport,
  ga4GetMetadata,
  ga4DateToIso,
  ga4Probe,
  listSitemaps,
  inspectUrl,
  listRemovals,
  pageSpeed,
};
