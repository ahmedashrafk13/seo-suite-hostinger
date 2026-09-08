// Google OAuth2 + API helpers. The code-exchange flow mirrors
// gsc-ga4-oauth-server/auth.js (authorization_code -> tokens, refresh_token
// renewal) but uses google-auth-library's OAuth2Client instead of hand-rolled
// axios calls, and persists tokens per-user in google_connections (SQLite)
// instead of a shared tokens.json file.
const { google } = require('googleapis');
const db = require('../db');
const config = require('../config');

const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

// Google Ads API version.
//
// MEASURED against the live API, not assumed — and the first measurement was
// wrong in an instructive way.
//
// Google routes the URL BEFORE it authenticates: an unknown method returns an
// HTML 404, a known one returns a JSON 401. So an unauthenticated 401 proves
// the VERSION PREFIX is served, and says nothing about whether that version
// implements the method. Probing that way suggested v22-v26 were all usable;
// with real credentials v26 answered generateKeywordIdeas with a JSON 404
// "Method not found." while v25 routed it and returned a genuine Ads error.
//
// Probed 2026-09-03, authenticated:
//   v21 and below   HTML 404   version prefix not served at all (sunset)
//   v26             JSON 404   version served, this method is not
//   v25             routed     reached the Ads backend
//
// v25 is therefore the newest version that actually serves
// KeywordPlanIdeaService here. When it sunsets, do not infer the replacement
// from an unauthenticated probe — press "Test Keyword Planner" on /connect,
// which retries each live version with real credentials and names the one
// that works.
const ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v25';
const ADS_BASE = (version) => `https://googleads.googleapis.com/${version || ADS_API_VERSION}`;

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  // Google Ads / Keyword Planner. There is no narrower scope: `adwords` is
  // the only one the Google Ads API accepts, and it is read-write, so the
  // consent screen asks for more than this app uses. The app only ever calls
  // generateKeywordIdeas and listAccessibleCustomers — both read-only — and
  // the consent copy on /connect says so, because a user who reads
  // "Manage your AdWords campaigns" and is not told why will not click it.
  ADS_SCOPE,
];

// The callback Google must have registered, and the one we actually send.
//
// This defers to config.js rather than deriving its own, because the two had
// drifted: config.GOOGLE_REDIRECT_URI honours BASE_URL, this did not. On any
// deployment that sets BASE_URL and not GOOGLE_REDIRECT_URI — which is exactly
// what DEPLOY-FLY.md instructs — the OAuth client sent
// http://localhost:8080/api/auth/google/callback and sign-in died with
// redirect_uri_mismatch, while `node src/doctor.js` read the config value and
// reported the CORRECT uri. A disagreement between the checker and the thing
// being checked is worse than either being wrong alone.
function getRedirectUri() {
  return config.GOOGLE_REDIRECT_URI;
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
  let credentials;
  try {
    ({ credentials } = await client.refreshAccessToken());
  } catch (err) {
    // TWO TOKENS, ONE OF WHICH THIS FUNCTION CANNOT SAVE.
    //
    // The access token is refreshed here automatically and indefinitely. The
    // REFRESH token is the credential doing the refreshing, and when Google
    // revokes that, there is nothing left to recover with — the only fix is a
    // human reconnecting on /connect.
    //
    // By far the most common cause is an OAuth app still in "Testing" status:
    // Google expires refresh tokens issued by such an app after seven days.
    // That produces a weekly failure in jobs nobody is watching — the nightly
    // sync, hourly alerts, the difficulty backfill — so the message names the
    // cause and the permanent fix rather than surfacing a bare invalid_grant.
    const raw = String((err && err.response && err.response.data
      && err.response.data.error) || err.message || '');
    if (/invalid_grant/i.test(raw)) {
      throw new Error(
        'The Google connection for '
        + (conn.connected_email || 'this workspace')
        + ' has been revoked by Google and must be reconnected on /connect. '
        + 'The usual cause is the OAuth app still being in "Testing" status, which expires '
        + 'refresh tokens after 7 days — publishing the app to "In production" in the Google '
        + 'Cloud console stops it recurring. Other causes: the user revoked access, or the '
        + 'password was changed.'
      );
    }
    throw err;
  }
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


// ====================================================================
// GOOGLE ADS  /  KEYWORD PLANNER
// ====================================================================
//
// Keyword Planner has no API of its own. Its numbers come from the Google Ads
// API (KeywordPlanIdeaService.generateKeywordIdeas), which needs THREE things,
// and every one of them is a separate failure mode a user must be able to see:
//
//   1. the `adwords` OAuth scope           -> granted at /auth/google
//   2. a developer token, ours, once       -> GOOGLE_ADS_DEVELOPER_TOKEN
//   3. a Google Ads customer the user owns -> chosen on /connect, per team
//
// (3) is why this is not just an env var. One deployment serves several teams,
// each with their own Ads account, so the customer id lives on the team's
// google_connections row. GOOGLE_ADS_CUSTOMER_ID remains as a fallback for a
// single-tenant install that predates the picker.

// Does a stored connection actually carry the Ads scope?
//
// This exists because Google does NOT retroactively grant a scope added to the
// code. Every connection made before the scope was added keeps working for
// Search Console and GA4 while silently 401-ing on Ads, which is
// indistinguishable from a broken integration unless the UI says
// "reconnect needed" - so it says exactly that.
function hasScope(conn, scope) {
  if (!conn || !conn.scope) return false;
  return String(conn.scope).split(/\s+/).includes(scope);
}

function hasAdsScope(conn) {
  return hasScope(conn, ADS_SCOPE);
}

// True when the user connected before `adwords` was requested: they have a
// working connection that can never answer an Ads call until they reconnect.
function needsAdsReconnect(conn) {
  return Boolean(conn) && !hasAdsScope(conn);
}

function adsDeveloperToken() {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
}

function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

// The Ads customer this user's runs should bill against, and the manager
// account to authorise through, if any.
//
// Per-user selection first, env second. `loginCustomerId` is the
// login-customer-id header: required when the chosen account is reached
// THROUGH a manager (MCC), and wrong to send otherwise - sending a manager id
// for a directly-owned account is one of the ways this API answers
// USER_PERMISSION_DENIED.
// What /connect should display for this team: which account its runs will
// use, and whether that is its own or the agency's shared one.
function getAdsSelection(userId) {
  const p = resolveAdsPrincipal(userId);
  if (!p.ok) {
    const conn = getConnection(userId);
    return {
      customerId: null,
      loginCustomerId: null,
      name: null,
      mode: null,
      shared: false,
      ownerEmail: null,
      reason: p.reason,
      // Kept for callers that only ask "was this from .env": a team with no
      // selection of its own is not configured from env either once the
      // shared path is unavailable.
      fromEnv: false,
      hasOwn: Boolean(conn && conn.ads_customer_id),
    };
  }
  return {
    customerId: p.customerId,
    loginCustomerId: p.loginCustomerId && p.loginCustomerId !== p.customerId ? p.loginCustomerId : null,
    name: p.name,
    mode: p.mode,
    shared: p.mode === 'shared',
    ownerEmail: p.ownerEmail || null,
    reason: null,
    fromEnv: p.mode === 'shared',
    hasOwn: p.mode === 'team',
    // Set when this team picked its own Ads account but is being served by the
    // shared one because its connection lost the Ads scope. The page must show
    // it: the team believes its own account is in use.
    staleOwnSelection: p.staleOwnSelection || null,
  };
}

function saveAdsSelection(userId, { customerId, loginCustomerId, name }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('Connect a Google account before choosing an Ads account.');
  db.prepare(`UPDATE google_connections
      SET ads_customer_id=?, ads_login_customer_id=?, ads_customer_name=?, updated_at=datetime('now')
    WHERE id=?`)
    .run(digitsOnly(customerId) || null, digitsOnly(loginCustomerId) || null, name || null, conn.id);
}

function clearAdsSelection(userId) {
  const conn = getConnection(userId);
  if (!conn) return;
  db.prepare(`UPDATE google_connections
      SET ads_customer_id=NULL, ads_login_customer_id=NULL, ads_customer_name=NULL, updated_at=datetime('now')
    WHERE id=?`).run(conn.id);
}

// WHOSE Google Ads account a run uses, and whose OAuth token authorises it.
//
// This is the question that decides how clients onboard, and there are two
// answers the app has to support at the same time:
//
//   SHARED (agency model). One Google Ads account - yours - serves every
//   client. Set GOOGLE_ADS_CUSTOMER_ID in .env and connect Google ONCE as
//   yourself. Clients do nothing at all: they never see the Ads consent
//   screen, never need a Google Ads account, and never know this is how the
//   volumes arrive. The calls run on YOUR stored refresh token no matter which
//   team asked, which is the whole point and the reason this function exists -
//   a client's own connection has no Ads scope and never will.
//
//   PER-TEAM. A client connects their own Google, grants Ads access, and picks
//   their own account on /connect. Their volumes bill against their account.
//   A team that has done this always overrides the shared account.
//
// Returns the principal to act as, or a `reason` explaining precisely which
// piece is missing - never a bare failure, because "no keyword volumes" has
// four different causes and they need different fixes.
function resolveAdsPrincipal(requestingUserId) {
  if (!adsDeveloperToken()) {
    return { ok: false, reason: 'GOOGLE_ADS_DEVELOPER_TOKEN is not set' };
  }

  // --- per-team selection wins -----------------------------------------
  const own = getConnection(requestingUserId);
  const ownCustomer = digitsOnly(own && own.ads_customer_id);
  if (ownCustomer && !hasAdsScope(own)) {
    // The team picked an account, then lost (or never had) the Ads scope on
    // its connection. Erroring here would break keyword volumes for a
    // workspace that a working shared account could serve perfectly, so this
    // degrades to the shared account and FLAGS the dead selection instead —
    // the same "narrower basis, named on the page" rule the rest of the suite
    // follows. What it must never do is fall back silently.
    const viaShared = resolveSharedAdsPrincipal();
    if (viaShared.ok) {
      return { ...viaShared, staleOwnSelection: ownCustomer };
    }
    return {
      ok: false,
      reason: 'this team chose its own Google Ads account, but its Google connection predates Ads access - reconnect Google on /connect',
    };
  }
  if (ownCustomer) {
    return {
      ok: true,
      mode: 'team',
      userId: requestingUserId,
      customerId: ownCustomer,
      loginCustomerId: digitsOnly(own.ads_login_customer_id) || null,
      name: own.ads_customer_name || null,
    };
  }

  // --- shared agency account -------------------------------------------
  return resolveSharedAdsPrincipal();
}

// The shared-account half of resolveAdsPrincipal, factored out so a team with
// a dead selection of its own can fall back onto it.
function resolveSharedAdsPrincipal() {
  const sharedCustomer = digitsOnly(process.env.GOOGLE_ADS_CUSTOMER_ID);
  if (!sharedCustomer) {
    return {
      ok: false,
      reason: 'no Google Ads account available: this team has not chosen one, and no shared GOOGLE_ADS_CUSTOMER_ID is configured',
    };
  }

  const owner = findAdsOwnerConnection();
  if (!owner) {
    return {
      ok: false,
      reason: 'GOOGLE_ADS_CUSTOMER_ID is set, but no Google connection in this deployment carries Ads access. Sign in as the account that owns the Ads account and connect Google on /connect'
        + (process.env.GOOGLE_ADS_OWNER_EMAIL ? ` (expecting ${process.env.GOOGLE_ADS_OWNER_EMAIL})` : ''),
    };
  }

  return {
    ok: true,
    mode: 'shared',
    userId: owner.user_id,
    ownerEmail: owner.connected_email || null,
    customerId: sharedCustomer,
    // A shared account is usually reached through the agency's manager
    // account, so the login-customer-id is configurable and falls back to the
    // customer id itself (harmless when they are the same - the header is
    // dropped in that case).
    loginCustomerId: digitsOnly(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || null,
    name: process.env.GOOGLE_ADS_CUSTOMER_NAME || null,
  };
}

// The connection whose refresh token the shared account acts on.
//
// GOOGLE_ADS_OWNER_EMAIL pins it explicitly, which matters once more than one
// admin has connected Google with Ads access - without it the choice would
// depend on row order, and the deployment would silently start billing a
// different Ads account than intended.
function findAdsOwnerConnection() {
  const wanted = String(process.env.GOOGLE_ADS_OWNER_EMAIL || '').trim().toLowerCase();
  if (wanted) {
    return db.prepare(`SELECT * FROM google_connections
      WHERE lower(connected_email) = ? AND scope LIKE '%auth/adwords%'
      ORDER BY id LIMIT 1`).get(wanted) || null;
  }
  return db.prepare(`SELECT * FROM google_connections
    WHERE scope LIKE '%auth/adwords%'
    ORDER BY id LIMIT 1`).get() || null;
}

// One authenticated Ads API request. Returns the parsed body, or throws with
// the API's own message - those messages are the only way to tell a sunset API
// version from a test-access developer token from a missing scope, so they are
// never swallowed here.
async function adsRequest(userId, path, { method = 'POST', body, loginCustomerId, version } = {}) {
  const devToken = adsDeveloperToken();
  if (!devToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN is not set.');

  // `userId` here is the PRINCIPAL's id, already resolved by
  // resolveAdsPrincipal - not necessarily the team that asked. In the shared
  // agency model these differ, and passing the requesting team's id would
  // authorise with a token that has no Ads scope.
  const conn = getConnection(userId);
  if (!conn) throw new Error('Google account not connected.');
  if (!hasAdsScope(conn)) {
    throw new Error('This Google connection was authorised before Keyword Planner access was added. Reconnect the Google account to grant it.');
  }

  const token = await getValidAccessToken(userId);
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = digitsOnly(loginCustomerId);

  const res = await fetch(`${ADS_BASE(version)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code = null;
    try {
      const parsed = JSON.parse(text);
      const err = parsed.error || {};
      code = err.status || null;
      const detail = (err.details && err.details[0] && err.details[0].errors
        && err.details[0].errors[0] && err.details[0].errors[0].message) || null;
      msg = detail ? `${err.message || msg} - ${detail}` : (err.message || msg);
    } catch (e) {
      msg = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    }
    const e = new Error(msg);
    // Attached rather than folded into the message: the probe below decides
    // what a 404 MEANS by re-testing, instead of printing a guess about
    // sunset versions next to every unrelated failure. That guess was wrong
    // once already — the path existed and the version was fine.
    e.httpStatus = res.status;
    e.apiStatus = code;
    e.rawBody = text.slice(0, 600);
    e.version = version || ADS_API_VERSION;
    throw e;
  }
  return text ? JSON.parse(text) : {};
}

// Every Ads account this Google login can reach, so the user PICKS one rather
// than typing a ten-digit number they have to go and look up. The descriptive
// name and manager flag are fetched per account and are best-effort: a manager
// account often refuses a direct query about itself, and an unnamed row in the
// dropdown is far better than an empty dropdown.
async function listAccessibleAdsCustomers(userId) {
  const listed = await adsRequest(userId, '/customers:listAccessibleCustomers', { method: 'GET' });
  const ids = (listed.resourceNames || []).map((r) => digitsOnly(r)).filter(Boolean);

  const out = [];
  for (const id of ids) {
    let name = null;
    let manager = null;
    let currency = null;
    try {
      /* eslint-disable no-await-in-loop */
      const q = await adsRequest(userId, `/customers/${id}/googleAds:search`, {
        body: {
          query: 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer LIMIT 1',
        },
        loginCustomerId: id,
      });
      const c = (q.results && q.results[0] && q.results[0].customer) || {};
      name = c.descriptiveName || null;
      manager = c.manager === undefined ? null : Boolean(c.manager);
      currency = c.currencyCode || null;
    } catch (e) {
      // Name lookup failed - keep the account, it is still selectable.
    }
    out.push({ id, name, manager, currency });
  }
  // Real advertising accounts first: a manager account cannot serve keyword
  // ideas on its own behalf, so it is the wrong thing to put at the top.
  out.sort((a, b) => (a.manager === b.manager ? 0 : a.manager ? 1 : -1));
  return out;
}

// A cheap end-to-end check for the /connect page: does a real Keyword Planner
// call succeed with what is configured right now? Returns a verdict object
// instead of throwing, because "not working, and here is Google's reason" is
// the thing the page has to render.
async function probeKeywordPlanner(userId) {
  if (!adsDeveloperToken()) {
    return { ok: false, stage: 'developer-token', message: 'GOOGLE_ADS_DEVELOPER_TOKEN is not set. Note that Google declines developer tokens for tools that only perform keyword research, so DataForSEO (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD) is the supported route to the same Google figures.' };
  }
  const p = resolveAdsPrincipal(userId);
  if (!p.ok) return { ok: false, stage: 'account', message: p.reason };

  const where = p.mode === 'shared'
    ? `shared agency account ${p.customerId}${p.ownerEmail ? ' via ' + p.ownerEmail : ''}`
    : `this team's own account ${p.customerId}`;

  try {
    const res = await adsRequest(p.userId, `/customers/${p.customerId}:generateKeywordIdeas`, {
      body: {
        keywordSeed: { keywords: ['seo services'] },
        geoTargetConstants: ['geoTargetConstants/2840'],
        language: 'languageConstants/1000',
        keywordPlanNetwork: 'GOOGLE_SEARCH',
        pageSize: 10,
      },
      loginCustomerId: p.loginCustomerId,
    });
    const results = res.results || [];
    const withVolume = results.filter((r) => r.keywordIdeaMetrics
      && r.keywordIdeaMetrics.avgMonthlySearches != null).length;
    if (!results.length) {
      return {
        ok: false,
        stage: 'empty',
        message: `The call to ${where} succeeded but returned no keyword ideas. That is what a TEST-access developer token does against a real account. Basic access is what fixes it - but Google declines it for keyword-research-only tools, so DataForSEO is the practical alternative.`,
      };
    }
    if (!withVolume) {
      return {
        ok: false,
        stage: 'no-metrics',
        message: `${where} returned ${results.length} ideas but no search volumes. Usually a Google Ads account with no billing set up, or a test-access developer token.`,
      };
    }
    return {
      ok: true,
      stage: 'ok',
      mode: p.mode,
      message: `Working via ${where} - ${results.length} ideas, ${withVolume} with volumes.`,
      sample: results.slice(0, 3).map((r) => ({ keyword: r.text, volume: Number(r.keywordIdeaMetrics.avgMonthlySearches) })),
    };
  } catch (err) {
    // A 404 here is the confusing one: the method path is routed (an unknown
    // method returns an HTML 404, not a JSON one), so "Method not found" on a
    // JSON error usually means THIS version does not serve THIS method for
    // this account. Rather than print a guess, retry the live versions and
    // report which one works — that turns a dead end into a one-line fix.
    if (err.httpStatus === 404) {
      const tried = [];
      for (const v of ['v25', 'v24', 'v23', 'v22', 'v26']) {
        if (v === (err.version || ADS_API_VERSION)) { tried.push(`${v}=404`); continue; }
        try {
          /* eslint-disable no-await-in-loop */
          await adsRequest(p.userId, `/customers/${p.customerId}:generateKeywordIdeas`, {
            body: {
              keywordSeed: { keywords: ['seo services'] },
              geoTargetConstants: ['geoTargetConstants/2840'],
              language: 'languageConstants/1000',
              keywordPlanNetwork: 'GOOGLE_SEARCH',
              pageSize: 10,
            },
            loginCustomerId: p.loginCustomerId,
            version: v,
          });
          return {
            ok: false,
            stage: 'wrong-version',
            message: `${err.version || ADS_API_VERSION} answered "${err.message}", but ${v} works. Set GOOGLE_ADS_API_VERSION=${v} in .env and restart. (tried ${tried.join(', ')})`,
          };
        } catch (e2) {
          tried.push(`${v}=${e2.httpStatus || '?'}${e2.apiStatus ? ' ' + e2.apiStatus : ''}`);
          // A non-404 from another version means the method exists there and
          // the real problem is elsewhere (auth, developer token, account) —
          // report THAT, since it is the actionable error.
          if (e2.httpStatus && e2.httpStatus !== 404) {
            return {
              ok: false,
              stage: 'api',
              message: `${v}: ${e2.message}${e2.rawBody ? ' | raw: ' + e2.rawBody : ''}`,
            };
          }
        }
      }
      return {
        ok: false,
        stage: 'api',
        message: `Every live API version returned 404 for generateKeywordIdeas (${tried.join(', ')}). Original: ${err.message}${err.rawBody ? ' | raw: ' + err.rawBody : ''}`,
      };
    }
    return {
      ok: false,
      stage: 'api',
      message: err.message + (err.rawBody ? ' | raw: ' + err.rawBody : ''),
    };
  }
}

module.exports = {
  SCOPES,
  ADS_SCOPE,
  ADS_API_VERSION,
  ADS_BASE,
  hasScope,
  hasAdsScope,
  needsAdsReconnect,
  adsDeveloperToken,
  adsRequest,
  getAdsSelection,
  resolveAdsPrincipal,
  findAdsOwnerConnection,
  saveAdsSelection,
  clearAdsSelection,
  listAccessibleAdsCustomers,
  probeKeywordPlanner,
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
