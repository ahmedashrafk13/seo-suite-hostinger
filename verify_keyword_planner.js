// Exercises src/routes/keywordPlanner.js over real HTTP, with lib/google and
// the planner's network calls stubbed in the require cache.
//
// The stubs are the point: lib/google loads the database, and this deployment
// runs a WASM SQLite with no cross-process write safety while the dev server
// holds app.db open. Nothing here touches the DB or the Google Ads API.
const path = require('path');
const http = require('http');

const ROOT = process.argv[2] || __dirname;
const express = require(path.join(ROOT, 'node_modules/express'));

// --- stub the database with a tiny in-memory store -------------------------
// Enough to exercise saving, listing and reopening a run without touching
// app.db (WASM SQLite has no cross-process write safety).
const rowsStore = [];
let nextId = 1;
const dbPath = require.resolve(path.join(ROOT, 'src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    prepare: (sql) => ({
      run: (...args) => {
        if (/INSERT INTO keyword_planner_runs/.test(sql)) {
          rowsStore.unshift({
            id: nextId, user_id: args[0], kind: args[1], label: args[2], market: args[3],
            language: args[4], engines: args[5], row_count: args[6],
            params_json: args[7], result_json: args[8], created_at: '2026-09-11 21:00',
          });
          return { lastInsertRowid: nextId++ };
        }
        if (/DELETE FROM keyword_planner_runs/.test(sql)) {
          const i = rowsStore.findIndex((r) => String(r.id) === String(args[0]));
          if (i >= 0) rowsStore.splice(i, 1);
        }
        return {};
      },
      all: () => rowsStore.slice(0, 25),
      get: (...args) => rowsStore.find((r) => String(r.id) === String(args[0])) || null,
    }),
  },
};

// --- stub lib/google -------------------------------------------------------
let ADS_OK = true;
const googlePath = require.resolve(path.join(ROOT, 'src/lib/google.js'));
require.cache[googlePath] = {
  id: googlePath,
  filename: googlePath,
  loaded: true,
  exports: {
    ADS_API_VERSION: 'v25',
    adsDeveloperToken: () => (ADS_OK ? 'dev-token' : ''),
    resolveAdsPrincipal: () => (ADS_OK
      ? { ok: true, mode: 'shared', userId: 1, customerId: '1234567890', loginCustomerId: null, ownerEmail: 'o@x.com', name: 'Agency' }
      : { ok: false, reason: 'no Google Ads account available' }),
    adsRequest: async () => { throw new Error('adsRequest should be stubbed per-test'); },
  },
};

// --- stub the planner's three RPCs ----------------------------------------
const plannerPath = require.resolve(path.join(ROOT, 'src/lib/aiseo/keywordPlanner.js'));
const realPlanner = require(plannerPath);
let NEXT = null;   // result to return
let THROWS = null; // error to throw
const calls = [];
['ideas', 'historical', 'forecast'].forEach((k) => {
  realPlanner[k] = async (userId, opts) => {
    calls.push({ method: k, opts });
    if (THROWS) throw THROWS;
    return Object.assign({ kind: k }, NEXT);
  };
});
realPlanner.suggestGeoTargets = async () => ([{ id: '1023191', name: 'New York', type: 'CITY', parents: ['New York, United States'], reach: 1000 }]);

const basis = { account: 'shared agency account 1234567890', mode: 'shared', market: 'United States', language: 'English', network: 'Google Search only', apiVersion: 'v25' };
const IDEAS_RESULT = {
  rows: [{ keyword: 'seo services', volume: 12100, competition: 'HIGH', competitionIndex: 88, lowBid: 4.2, highBid: 19.5, averageCpc: null, monthly: [{ label: '2025-01', volume: 100 }], trendPct: 12, isSeed: true, conceptGroup: 'Services', closeVariants: [] }],
  total: 1, returned: 1, filteredOut: 0, nextPageToken: null, devices: null,
  conceptGroups: [{ name: 'Services', keywords: 1, volume: 12100 }], basis, seedMode: 'keyword', truncatedSeed: 0,
  // A healthy run: Google returned ideas beyond the seed itself.
  seedCount: 1, newIdeas: 40,
};

// --- app -------------------------------------------------------------------
const router = require(path.join(ROOT, 'src/routes/keywordPlanner.js'));
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  req.dataUserId = 1;
  Object.assign(res.locals, {
    csrfField: '<input type="hidden" name="_csrf" value="x">',
    path: req.path, query: req.query,
    navCounts: { openTasks: 0, needsApproval: 0, openAlerts: 0 }, navBrands: [],
    perms: { isAdmin: true }, currentUser: { name: 'A', email: 'a@b.c', role: 'admin' },
    team: null, setupRemaining: 0, pendingMembers: 0, assetVersion: '1',
    fmtInt: (n) => String(n), fmtPct: (n) => n + '%', fmtDate: (s) => s, fmtDateTime: (s) => s,
    shortUrl: (u) => u, severityMeta: {}, statusBadge: () => ({}),
  });
  next();
});
app.use('/keyword-planner', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => { res.status(500).send('SERVER ERROR: ' + err.message); });

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('OK   ' + name); } else { fail += 1; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const server = app.listen(0, async () => {
  try {
    // 1. GET the page
    let r = await request('GET', '/keyword-planner');
    check('GET / renders 200', r.status === 200, 'status ' + r.status + ' ' + r.body.slice(0, 200));
    check('GET / shows the connected account', r.body.indexOf('1234567890') >= 0);
    check('GET / defaults to the ideas tab', r.body.indexOf('action="/keyword-planner/ideas"') >= 0);

    // 2. Tab links carry form state forward
    r = await request('GET', '/keyword-planner?tab=forecast&keywords=seo%20services&market=GB');
    check('tab=forecast renders the forecast form', r.body.indexOf('action="/keyword-planner/forecast"') >= 0);
    check('keywords survive the tab switch', r.body.indexOf('seo services') >= 0);
    check('country survives the tab switch', r.body.indexOf('value="GB" selected') >= 0);

    // 3. POST ideas
    NEXT = IDEAS_RESULT; THROWS = null; calls.length = 0;
    r = await request('POST', '/keyword-planner/ideas', {
      tab: 'ideas', keywords: 'seo services\nseo agency', market: 'GB', language: 'de',
      network: 'GOOGLE_SEARCH_AND_PARTNERS', seed_mode: 'keyword', devices: '1',
      min_volume: '100', exclude_terms: 'free', questions_only: '1', geo_ids: '1023191',
    });
    check('POST /ideas renders 200', r.status === 200, r.body.slice(0, 300));
    check('POST /ideas shows the row', r.body.indexOf('12,100') >= 0);
    check('POST /ideas called the ideas RPC', calls.length === 1 && calls[0].method === 'ideas');
    const o = calls[0].opts;
    check('keywords parsed into a list', Array.isArray(o.keywords) && o.keywords.length === 2, JSON.stringify(o.keywords));
    check('country passed through', o.market === 'GB');
    check('language passed through', o.language === 'de');
    check('network passed through', o.network === 'GOOGLE_SEARCH_AND_PARTNERS');
    check('device breakdown requested', o.deviceBreakdown === true);
    check('refinements passed through', o.minVolume === '100' && o.excludeTerms === 'free' && o.questionsOnly === true);
    check('geo target id passed through', JSON.stringify(o.geoTargetIds) === '["1023191"]');
    check('form comes back filled in', r.body.indexOf('seo agency') >= 0);

    // 3b. Concept grouping is a default-on checkbox: unchecking it must stick.
    calls.length = 0;
    await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'x', annotations_present: '1' });
    check('unchecked concept grouping turns it off', calls[0].opts.annotations === false);
    calls.length = 0;
    await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'x', annotations_present: '1', annotations: '1' });
    check('checked concept grouping turns it on', calls[0].opts.annotations === true);
    calls.length = 0;
    await request('POST', '/keyword-planner/historical', { tab: 'historical', keywords: 'x' });
    check('concept grouping defaults on where the box is absent', calls[0].opts.annotations === true);

    // 4. A Google error renders on the page, not as a 500
    THROWS = Object.assign(new Error('USER_PERMISSION_DENIED'), { httpStatus: 403, rawBody: '{"e":1}' });
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'x' });
    check('API failure renders 200, not 500', r.status === 200, 'status ' + r.status);
    check("Google's message is shown verbatim", r.body.indexOf('USER_PERMISSION_DENIED') >= 0);
    check('a fix hint is offered', r.body.indexOf('login-customer-id') >= 0);
    check('the raw body is available', r.body.indexOf('Raw response') >= 0);

    // 5. A validation error from the library also renders on the page
    THROWS = new Error('Enter at least one seed keyword.');
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: '' });
    check('validation error renders on the page', r.status === 200 && r.body.indexOf('Enter at least one seed keyword') >= 0, 'status ' + r.status);

    // 6. CSV export
    THROWS = null; NEXT = IDEAS_RESULT;
    r = await request('POST', '/keyword-planner/export.csv', { tab: 'ideas', keywords: 'seo services' });
    check('CSV responds 200', r.status === 200);
    check('CSV content type', /text\/csv/.test(r.headers['content-type'] || ''));
    check('CSV is an attachment', /attachment; filename="keyword-planner-ideas-\d{4}-\d{2}-\d{2}\.csv"/.test(r.headers['content-disposition'] || ''), r.headers['content-disposition']);
    check('CSV starts with a BOM for Excel', r.body.charCodeAt(0) === 0xfeff);
    check('CSV has the header row', r.body.indexOf('avg_monthly_searches') >= 0);
    check('CSV has the data row', r.body.indexOf('seo services,12100') >= 0);
    check('CSV has a month column', r.body.indexOf('2025-01') >= 0);

    // 6b. Bing: a second engine's column, merged but never blended.
    var BING = { rows: [{ keyword: 'seo services', volume: 12100, competition: 'HIGH', competitionIndex: 88,
      lowBid: 4.2, highBid: 19.5, averageCpc: null, monthly: null, trendPct: null, isSeed: false,
      conceptGroup: null, closeVariants: [], bingVolume: 880 }] };
    realPlanner.attachBingVolume = async function (rows) {
      return { rows: BING.rows, note: 'Bing Webmaster Tools returned volume for 1 of the 1 keywords looked up.' };
    };
    NEXT = IDEAS_RESULT; THROWS = null;
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo services', bing: '1' });
    check('Bing column appears when asked', r.body.indexOf('Bing searches') >= 0);
    check('Bing value rendered', r.body.indexOf('880') >= 0);
    check('Bing kept out of the Google column', r.body.indexOf('12,100') >= 0);
    check('Bing provenance note shown', r.body.indexOf('returned volume for 1 of the 1') >= 0);

    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo services' });
    check('no Bing column when not asked', r.body.indexOf('Bing searches') === -1);

    // Asked, but Bing had nothing. This is the case that previously looked
    // identical to the checkbox not working.
    realPlanner.attachBingVolume = async function (rows) {
      return { rows: rows, note: 'Bing Webmaster Tools returned no volume for these keywords.' };
    };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo services', bing: '1' });
    check('asked-but-empty still shows the Bing column', r.body.indexOf('Bing searches') >= 0);
    check('asked-but-empty explains itself above the table',
      r.body.indexOf('Bing was queried and returned no volume') >= 0);
    check('asked-but-empty names the engine on the Google column',
      r.body.indexOf('Google searches/mo') >= 0);
    check('Bing choice survives a tab switch', r.body.indexOf('bing=1') >= 0);
    check('Google is not a frozen checkbox', r.body.indexOf('checked disabled') === -1);

    // --- the two different kinds of empty Bing cell ------------------------
    // A row past the per-request cap and a row Bing had no data for must not
    // render identically: one means "looked and found nothing", the other
    // means "never looked".
    NEXT = Object.assign({}, IDEAS_RESULT, {
      rows: [
        Object.assign({}, IDEAS_RESULT.rows[0], { keyword: 'answered', bingVolume: 588, bingChecked: true }),
        Object.assign({}, IDEAS_RESULT.rows[0], { keyword: 'checked but empty', bingVolume: null, bingChecked: true }),
        Object.assign({}, IDEAS_RESULT.rows[0], { keyword: 'never looked up', bingVolume: null, bingChecked: false }),
      ],
      total: 3,
    });
    realPlanner.attachBingVolume = async function (rows) {
      return { rows: rows, note: 'Bing had data for 1 of the 2 keywords it was asked about.', checked: 2, capped: true, matched: 1 };
    };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'x', bing: '1' });
    check('a checked-but-empty Bing cell says so', r.body.indexOf('no record of this exact phrase') >= 0);
    check('an unchecked Bing cell is drawn differently', r.body.indexOf('Not looked up') >= 0);
    check('the cap is stated above the table', r.body.indexOf('Bing checked') >= 0);
    check('the three empty states are explained', r.body.indexOf('never looked up') >= 0
      && r.body.indexOf('measured zero') >= 0 && r.body.indexOf('no record of that exact phrase') >= 0);

    // A measured zero must not be collapsed into "no data".
    NEXT = Object.assign({}, IDEAS_RESULT, {
      rows: [Object.assign({}, IDEAS_RESULT.rows[0], { keyword: 'engine optimization', bingVolume: 0, bingChecked: true })],
      total: 1, newIdeas: 1,
    });
    realPlanner.attachBingVolume = async function (rows) { return { rows: rows, note: 'n/a', checked: 1, capped: false, matched: 1 }; };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'x', bing: '1' });
    check('a measured zero renders as 0, not a dash', r.body.indexOf('>0</span>') >= 0);
    check('the measured zero explains itself', r.body.indexOf('measured zero, not missing data') >= 0);

    // --- Google's close-variant buckets -----------------------------------
    // Google gives every member of a variant cluster the SAME figure, which is
    // why three rows read 90,500 and Bing shows nothing for two of them.
    NEXT = Object.assign({}, IDEAS_RESULT, {
      rows: ['seo', 'search engine optimization', 'seo engine optimization', 'unrelated term'].map(function (k, i) {
        return Object.assign({}, IDEAS_RESULT.rows[0], { keyword: k, volume: i === 3 ? 1200 : 90500, isSeed: false });
      }),
      total: 4, newIdeas: 4,
    });
    realPlanner.attachBingVolume = async function (rows) { return { rows: rows, note: 'n/a', checked: 4, capped: false, matched: 0 }; };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo' });
    check('a shared Google figure is marked as a bucket', /&#8942;3|⋮3/.test(r.body), r.body.indexOf('8942'));
    check('the bucket marker is explained', r.body.indexOf('one opportunity, not N of them') >= 0);
    check('a unique figure is not marked as a bucket',
      (r.body.match(/8942;3/g) || []).length >= 1 && r.body.indexOf('8942;1<') === -1);

    // --- a dead seed (typically a typo) -----------------------------------
    // Google hands the seeds back mixed into the ideas, so "found nothing"
    // otherwise renders as an ordinary one-row table.
    THROWS = null;
    NEXT = {
      rows: [{ keyword: 'seo serivces', volume: 210, competition: 'LOW', competitionIndex: 4,
        lowBid: null, highBid: null, averageCpc: null, monthly: null, trendPct: -94,
        isSeed: true, conceptGroup: null, closeVariants: [] }],
      total: 1, returned: 1, filteredOut: 0, nextPageToken: null, devices: null,
      conceptGroups: [], basis: basis, seedMode: 'keyword', truncatedSeed: 0,
      seedCount: 1, newIdeas: 0,
    };
    realPlanner.attachBingVolume = async function (rows) {
      return { rows: rows, note: 'no keyword stats returned' };
    };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo serivces', bing: '1' });
    check('a dead seed is explained, not left as a bare row',
      r.body.indexOf('Google found no new keyword ideas') >= 0);
    check('the spelling cause is named first', r.body.indexOf('does not correct spelling') >= 0);
    check('the Bing banner is demoted when Google found nothing',
      r.body.indexOf('Bing was queried and returned no volume') === -1);

    // A healthy run must NOT show the dead-seed notice.
    NEXT = Object.assign({}, IDEAS_RESULT, { seedCount: 1, newIdeas: 40 });
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo services' });
    check('a healthy run shows no dead-seed notice',
      r.body.indexOf('Google found no new keyword ideas') === -1);

    // --- engine selection ------------------------------------------------
    // Bing-only on the metrics tab: no Google Ads call at all.
    calls.length = 0;
    realPlanner.attachBingVolume = async function (rows) {
      return { rows: rows.map(function (x) { return Object.assign({}, x, { bingVolume: 42 }); }), note: 'bing ok' };
    };
    r = await request('POST', '/keyword-planner/historical', {
      tab: 'historical', keywords: 'seo services', bing: '1', google_present: '1',
    });
    check('Bing-only run renders', r.status === 200, r.body.slice(0, 200));
    check('Bing-only run makes no Google Ads call', calls.length === 0, calls.map(function (c) { return c.method; }));
    check('Bing-only rows carry the Bing value', r.body.indexOf('Bing searches/mo') >= 0 && />\s*42\s*</.test(r.body));
    check('Bing-only basis says no Ads call was made', r.body.indexOf('no Google Ads call') >= 0);

    // Google back on: the Ads call happens again.
    calls.length = 0;
    NEXT = IDEAS_RESULT;
    r = await request('POST', '/keyword-planner/historical', {
      tab: 'historical', keywords: 'seo services', bing: '1', google: '1', google_present: '1',
    });
    check('ticking Google restores the Ads call', calls.length === 1 && calls[0].method === 'historical',
      calls.map(function (c) { return c.method; }));

    // Neither engine selected.
    r = await request('POST', '/keyword-planner/historical', {
      tab: 'historical', keywords: 'seo services', google_present: '1',
    });
    check('no engine selected is refused with a reason', r.body.indexOf('Pick at least one search engine') >= 0);

    // Bing cannot generate ideas, and says so rather than failing oddly.
    r = await request('POST', '/keyword-planner/ideas', {
      tab: 'ideas', keywords: 'seo services', bing: '1', google_present: '1',
    });
    check('Bing-only on the ideas tab explains the limit',
      r.body.indexOf('Bing cannot generate keyword ideas') >= 0);

    // Restore the data-returning stub for the CSV checks below.
    realPlanner.attachBingVolume = async function () {
      return { rows: BING.rows, note: 'Bing Webmaster Tools returned volume for 1 of the 1 keywords looked up.' };
    };

    r = await request('POST', '/keyword-planner/export.csv', { tab: 'ideas', keywords: 'seo services', bing: '1' });
    check('CSV gains a Bing column when asked', r.body.indexOf('bing_monthly_searches') >= 0);
    r = await request('POST', '/keyword-planner/export.csv', { tab: 'ideas', keywords: 'seo services' });
    check('CSV has no Bing column when not asked', r.body.indexOf('bing_monthly_searches') === -1);

    // 6c. Persistence: a run survives leaving the page.
    NEXT = Object.assign({}, IDEAS_RESULT, { seedCount: 1, newIdeas: 40 });
    realPlanner.attachBingVolume = async function (rows) { return { rows: rows, note: 'n/a', checked: 1, capped: false, matched: 1 }; };
    r = await request('POST', '/keyword-planner/ideas', { tab: 'ideas', keywords: 'seo services' });
    check('a run is saved', rowsStore.length >= 1, rowsStore.length);
    check('the saved run is listed on the page', r.body.indexOf('Saved runs') >= 0);

    const savedId = rowsStore[0].id;
    r = await request('GET', '/keyword-planner/run/' + savedId);
    check('a saved run reopens', r.status === 200, r.status);
    check('reopening makes no API call', (function () { const before = calls.length; return before === calls.length; })());
    check('reopening says it is a snapshot', r.body.indexOf('saved run') >= 0);
    check('the reopened run shows its rows', r.body.indexOf('12,100') >= 0);
    check('the form is refilled from the stored parameters', r.body.indexOf('seo services') >= 0);

    r = await request('GET', '/keyword-planner/run/999999');
    check('an unknown run id 404s', r.status === 404, r.status);

    // 7. Geo lookup
    r = await request('GET', '/keyword-planner/geo?q=new%20york');
    check('geo lookup returns JSON', r.status === 200 && JSON.parse(r.body).results[0].id === '1023191');

    // 8. No Ads access at all
    ADS_OK = false;
    r = await request('GET', '/keyword-planner');
    check('no-access page still renders', r.status === 200);
    check('no-access page explains why', r.body.indexOf('GOOGLE_ADS_DEVELOPER_TOKEN is not set') >= 0);
    check('no-access page disables submit', r.body.indexOf('disabled') >= 0);
    ADS_OK = true;
  } catch (e) {
    fail += 1;
    console.log('FAIL harness threw ->', e.stack);
  }
  server.close();
  console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
