// Checks the Keyword Planner -> clustering integration and the views that
// render it. Pure logic plus template rendering: no database, no Ads API.
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || __dirname;
const ejs = require(path.join(ROOT, 'node_modules/ejs'));
const VIEWS = path.join(ROOT, 'views');

// db is required transitively by clustering; stub it so this never opens
// app.db while the server holds it (WASM SQLite has no cross-process safety).
const dbPath = require.resolve(path.join(ROOT, 'src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
};

const clustering = require(path.join(ROOT, 'src/lib/clustering.js'));

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// ---------------------------------------------------------------- clustering
// A topic the site already ranks for (impressions, no demand advantage) vs a
// topic it has never covered (no impressions, far more demand). Before the
// integration the first always won; the whole point is that it no longer does.
const input = [
  { keyword: 'blue widget repair guide', impressions: 5000, clicks: 100 },
  { keyword: 'blue widget repair tutorial', impressions: 2000, clicks: 40 },
  { keyword: 'buy red widgets online', impressions: 0, clicks: 0 },
  { keyword: 'red widgets for sale', impressions: 0, clicks: 0 },
];

let r = clustering.cluster(input, { minSimilarity: 0.3 });
const plainOrder = r.clusters.map((c) => c.primaryKeyword);
check('un-enriched run still orders by impressions', /blue widget/.test(plainOrder[0]), plainOrder);
check('un-enriched clusters carry no volume fields', r.clusters.every((c) => c.searchVolume === null), plainOrder);

const enriched = [
  { keyword: 'blue widget repair guide', impressions: 5000, clicks: 100, volume: 200, cpc: 0.4, competition: 'LOW' },
  { keyword: 'blue widget repair tutorial', impressions: 2000, clicks: 40, volume: 100, cpc: 0.3, competition: 'LOW' },
  { keyword: 'buy red widgets online', impressions: 0, clicks: 0, volume: 9000, cpc: 3.5, competition: 'HIGH' },
  { keyword: 'red widgets for sale', impressions: 0, clicks: 0, volume: 4000, cpc: 2.0, competition: 'HIGH' },
];
r = clustering.cluster(enriched, { minSimilarity: 0.3 });
const vOrder = r.clusters.map((c) => c.primaryKeyword);
check('demand outranks existing impressions once enriched', /red widget/.test(vOrder[0]), vOrder);

const red = r.clusters.find((c) => /red widget/.test(c.primaryKeyword));
check('cluster volume is summed', red.searchVolume === 13000, red.searchVolume);
check('top-of-page bid is the max, not the mean', red.topCpc === 3.5, red.topCpc);
check('traffic value = volume x top bid', red.trafficValue === Math.round(13000 * 3.5), red.trafficValue);
check('volume coverage is reported', red.volumeKeywords === 2 && red.keywordCount === 2, [red.volumeKeywords, red.keywordCount]);
check('per-keyword volumes are kept for the brief', Array.isArray(red.keywordVolumes) && red.keywordVolumes.length === 2, red.keywordVolumes);
check('primary keyword is the highest-volume member', red.primaryKeyword === 'buy red widgets online', red.primaryKeyword);

// Partial coverage: Google returns nothing for SOME keywords in a cluster.
// Reuses the four-keyword corpus above rather than a two-keyword one, because
// similarity here is IDF-weighted: the same pair that clusters among four
// keywords does not cluster when it is the entire corpus.
const partial = clustering.cluster(enriched.map(function (k) {
  return k.keyword === 'red widgets for sale' ? Object.assign({}, k, { volume: null, cpc: null }) : k;
}), { minSimilarity: 0.3 });
const green = partial.clusters.find(function (c) { return /red widget/.test(c.primaryKeyword); });
check('partial coverage clustered both keywords', Boolean(green) && green.keywordCount === 2,
  partial.clusters.map(function (c) { return c.primaryKeyword + ':' + c.keywordCount; }));
check('partial coverage sums only what Google answered', green && green.searchVolume === 9000, green && green.searchVolume);
check('partial coverage reports how many keywords had data',
  green && green.volumeKeywords === 1 && green.keywordCount === 2,
  green && [green.volumeKeywords, green.keywordCount]);
check('partial coverage keeps only the answered keyword in the detail list',
  green && green.keywordVolumes.length === 1, green && green.keywordVolumes);

// ---------------------------------------------------------------- templates
function locals(extra) {
  return Object.assign({
    title: 'T', pageTitle: 'T', active: 'keywords', path: '/keywords', query: {},
    navCounts: { openTasks: 1, needsApproval: 1, openAlerts: 2 }, navBrands: [],
    perms: { isAdmin: true }, currentUser: { name: 'A', email: 'a@b.c', role: 'admin' },
    team: null, setupRemaining: 0, pendingMembers: 0, assetVersion: '1',
    flash: null, flashError: null,
    csrfField: '<input type="hidden" name="_csrf" value="x">',
    fmtInt: (n) => Number(n || 0).toLocaleString('en-US'),
    fmtPct: (n) => n + '%', fmtDate: (s) => (s ? String(s).slice(0, 10) : '-'),
    fmtDateTime: (s) => s, shortUrl: (u) => u, severityMeta: {}, statusBadge: () => ({}),
  }, extra);
}
function render(view, extra) {
  const file = path.join(VIEWS, view);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals(extra), { filename: file, views: [VIEWS] });
}

// keywords.ejs - the opt-in checkbox
let html;
try {
  html = render('keywords.ejs', { brands: [{ id: 1, name: 'Acme', gscQueries: 10 }], runs: [] });
  check('clustering form offers the volume lookup', html.indexOf('name="with_volume"') >= 0);
  check('volume lookup is on by default', /name="with_volume"[^>]*checked/.test(html));
} catch (e) { fail += 1; console.log('FAIL keywords.ejs -> ' + e.message); }

// keyword-result.ejs - with and without volume
const runBase = {
  id: 7, name: 'Run', brand_id: 1, brand_name: 'Acme', source: 'manual',
  keyword_count: 4, cluster_count: 2,
};
function resultLocals(clusters, note) {
  return {
    run: Object.assign({}, runBase, { result: { clusters, plannerNote: note || null } }),
    clusters,
    intents: ['Transactional'], recs: ['Create new page'],
    approvedById: new Map(), query: {},
  };
}
try {
  html = render('keyword-result.ejs', resultLocals(r.clusters, 'Volume attached to 4 of 4 keywords.'));
  check('result table shows the searches column', html.indexOf('Searches/mo') >= 0);
  check('result table shows the top bid', html.indexOf('Top bid') >= 0);
  check('result table shows traffic value', html.indexOf('Traffic value') >= 0);
  check('total demand stat rendered', html.indexOf('Total searches/mo') >= 0);
  check('provenance note rendered', html.indexOf('Volume attached to 4 of 4 keywords.') >= 0);
  check('volume value formatted', html.indexOf('13,000') >= 0);
} catch (e) { fail += 1; console.log('FAIL keyword-result.ejs (enriched) -> ' + e.message); }

try {
  const plain = clustering.cluster(input, { minSimilarity: 0.3 });
  html = render('keyword-result.ejs', resultLocals(plain.clusters, null));
  check('an un-enriched run hides the volume columns', html.indexOf('Searches/mo') === -1);
  check('an un-enriched run hides the demand stat', html.indexOf('Total searches/mo') === -1);
  check('an un-enriched run renders no provenance note', html.indexOf('notice') === -1 || html.indexOf('Keyword Planner volume attached') === -1);
} catch (e) { fail += 1; console.log('FAIL keyword-result.ejs (plain) -> ' + e.message); }

// A run stored before this feature existed has no volume fields at all.
try {
  const legacy = r.clusters.map((c) => {
    const copy = Object.assign({}, c);
    delete copy.searchVolume; delete copy.topCpc; delete copy.trafficValue;
    delete copy.volumeKeywords; delete copy.keywordVolumes;
    return copy;
  });
  html = render('keyword-result.ejs', resultLocals(legacy, null));
  check('a run stored before this feature still renders', html.length > 1000);
  check('a legacy run shows no volume columns', html.indexOf('Searches/mo') === -1);
} catch (e) { fail += 1; console.log('FAIL keyword-result.ejs (legacy) -> ' + e.message); }

// tasks.ejs - the restructured board
function col(value, label, n, tasks) {
  return { value, label, description: label + ' description', total: n, tasks: tasks || [] };
}
const task = { id: 1, title: 'Fix it', severity: 'critical', source: 'alert', brand_name: 'Acme', affected_url: null };
try {
  html = render('tasks.ejs', {
    view: 'board', tasks: [],
    // The view derives openCols/closedCols itself from `columns`.
    columns: [
      col('backlog', 'Backlog', 172, [task]),
      col('in_progress', 'In progress', 0),
      col('awaiting_approval', 'Awaiting SEO approval', 0),
      col('blocked', 'Blocked', 0),
      col('done', 'Done', 0),
      col('dismissed', 'Dismissed', 0),
    ],
    filters: {}, sources: { alert: 'Alert' },
    statuses: [
      { value: 'backlog', label: 'Backlog' }, { value: 'in_progress', label: 'In progress' },
      { value: 'awaiting_approval', label: 'Awaiting SEO approval' }, { value: 'blocked', label: 'Blocked' },
      { value: 'done', label: 'Done' }, { value: 'dismissed', label: 'Dismissed' },
    ],
    assignees: [], brands: [], people: [], approvalRules: {},
    counts: { total: 172 },
  });
  check('board renders only the lanes that have work', (html.match(/class="board-col"/g) || []).length === 1,
    (html.match(/class="board-col"/g) || []).length);
  check('empty lanes collapse into one quiet strip', html.indexOf('board-quiet') >= 0);
  check('the quiet strip still names every empty lane',
    html.indexOf('In progress') >= 0 && html.indexOf('Blocked') >= 0 && html.indexOf('Awaiting SEO approval') >= 0);
  check('no full-size empty column is drawn', html.indexOf('board-col is-empty') === -1);
  check('lane count is handed to the grid', html.indexOf('--board-cols:1') >= 0);
} catch (e) { fail += 1; console.log('FAIL tasks.ejs -> ' + e.message); }

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
