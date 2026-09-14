// Checks the regrouped sidebar and the merged AI visibility overview.
// Pure template rendering: no database, no server.
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || __dirname;
const ejs = require(path.join(ROOT, 'node_modules/ejs'));
const VIEWS = path.join(ROOT, 'views');

function locals(extra) {
  return Object.assign({
    title: 'T', pageTitle: 'T', active: null,
    path: '/dashboard', query: {},
    navCounts: { openTasks: 3, needsApproval: 1, openAlerts: 2 },
    navBrands: [{ id: 1, name: 'Acme' }],
    perms: { isAdmin: true }, currentUser: { name: 'A', email: 'a@b.c', role: 'admin' },
    team: null, setupRemaining: 0, pendingMembers: 0, assetVersion: '1',
    flash: null, flashError: null,
    csrfField: '<input type="hidden" name="_csrf" value="x">',
    fmtInt: (n) => Number(n || 0).toLocaleString('en-US'),
    fmtPct: (n) => n + '%', fmtDate: (s) => (s ? String(s).slice(0, 10) : '-'),
    fmtDateTime: (s) => s, shortUrl: (u) => u, severityMeta: {}, statusBadge: () => ({}),
  }, extra);
}

function renderSidebar(p) {
  const file = path.join(VIEWS, 'partials/sidebar.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), locals({ path: p }), { filename: file, views: [VIEWS] });
}

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + detail : '')); }
}

// --- 1. every route in the app still has exactly one nav home --------------
const EXPECTED = [
  '/dashboard', '/performance',
  '/ai-seo/research', '/keyword-planner', '/keywords', '/keywords/briefs', '/ai-seo/competitors',
  '/audit', '/pagespeed', '/ai-seo/site-readiness', '/ai-seo/readiness', '/ai-seo/monitoring',
  '/ai-seo/optimizer', '/ai-seo/schema', '/ai-seo/freshness', '/linking',
  '/ai-seo/link-opportunities', '/ai-seo/architecture',
  '/ai-seo', '/ai-seo/answer-citations', '/ai-seo/ai-referrals', '/ai-seo/brand-hub',
  '/ai-seo/reputation', '/ai-seo/review-platforms',
  '/alerts', '/tasks/opportunities', '/tasks',
  '/reports', '/leads',
  '/brands', '/team', '/connect', '/settings', '/workflow',
];
const html = renderSidebar('/dashboard');
const hrefs = (html.match(/class="nav-link[^"]*" href="([^"]+)"/g) || [])
  .map((m) => m.match(/href="([^"]+)"/)[1]);
EXPECTED.forEach((h) => {
  const n = hrefs.filter((x) => x === h).length;
  if (n !== 1) { fail += 1; console.log('FAIL nav has ' + n + ' entries for ' + h); }
});
check('every expected destination appears exactly once', hrefs.length === EXPECTED.length,
  'rendered ' + hrefs.length + ' links, expected ' + EXPECTED.length + ': extra=' + JSON.stringify(hrefs.filter((h) => EXPECTED.indexOf(h) === -1)));
check('the old AI Assist hub is gone from the nav', hrefs.indexOf('/ai-assist') === -1);

// --- 2. sections are named by job, not by route prefix ---------------------
['Overview', 'Research and planning', 'Site health', 'Content and pages', 'AI visibility', 'Act', 'Deliver', 'Setup']
  .forEach((label) => check('section "' + label + '" exists', html.indexOf('>' + label + ' <') >= 0));
check('no section is named after the /ai-seo folder', html.indexOf('>AI search <') === -1);

// --- 3. active state: longest prefix wins ----------------------------------
function activeOf(p) {
  const h = renderSidebar(p);
  const m = h.match(/class="nav-link active" href="([^"]+)"/g) || [];
  return m.map((x) => x.match(/href="([^"]+)"/)[1]);
}
check('/keywords lights only Keyword clusters', JSON.stringify(activeOf('/keywords')) === '["/keywords"]', JSON.stringify(activeOf('/keywords')));
check('/keywords/briefs lights only Content briefs', JSON.stringify(activeOf('/keywords/briefs')) === '["/keywords/briefs"]', JSON.stringify(activeOf('/keywords/briefs')));
check('/ai-seo lights only the overview', JSON.stringify(activeOf('/ai-seo')) === '["/ai-seo"]', JSON.stringify(activeOf('/ai-seo')));
check('/ai-seo/schema lights only Structured data', JSON.stringify(activeOf('/ai-seo/schema')) === '["/ai-seo/schema"]', JSON.stringify(activeOf('/ai-seo/schema')));
check('/keyword-planner lights only Keyword Planner', JSON.stringify(activeOf('/keyword-planner')) === '["/keyword-planner"]', JSON.stringify(activeOf('/keyword-planner')));
check('a run page still lights its parent', JSON.stringify(activeOf('/audit/42')) === '["/audit"]', JSON.stringify(activeOf('/audit/42')));

// --- 4. a collapsed section opens when it holds the current page -----------
function openSections(p) {
  const h = renderSidebar(p);
  return (h.match(/<details class="nav-section" data-key="([a-z]+)" open/g) || [])
    .map((x) => x.match(/data-key="([a-z]+)"/)[1]);
}
check('Site health is collapsed elsewhere', openSections('/dashboard').indexOf('health') === -1, JSON.stringify(openSections('/dashboard')));
check('Site health opens on /audit', openSections('/audit').indexOf('health') >= 0, JSON.stringify(openSections('/audit')));
check('Content and pages opens on /ai-seo/schema', openSections('/ai-seo/schema').indexOf('content') >= 0);
check('Content and pages opens on /linking', openSections('/linking').indexOf('content') >= 0);
check('AI visibility opens on /ai-seo/reputation', openSections('/ai-seo/reputation').indexOf('visibility') >= 0);
check('AI visibility opens on an /ai-assist generation page', openSections('/ai-assist/1/metadata').indexOf('visibility') >= 0, JSON.stringify(openSections('/ai-assist/1/metadata')));
check('Setup opens on /connect without an openIfPrefix', openSections('/connect').indexOf('setup') >= 0);
check('Setup is collapsed on /dashboard', openSections('/dashboard').indexOf('setup') === -1);
const alwaysOpen = openSections('/dashboard');
check('only the four always-open sections start open',
  JSON.stringify(alwaysOpen) === '["overview","research","act","deliver"]', JSON.stringify(alwaysOpen));

// --- 5. the command palette lists the same destinations -------------------
const cmdk = (html.match(/class="cmdk-item" href="([^"]+)"/g) || []).map((m) => m.match(/href="([^"]+)"/)[1]);
check('command palette lists every nav destination',
  EXPECTED.every((h) => cmdk.indexOf(h) >= 0), JSON.stringify(EXPECTED.filter((h) => cmdk.indexOf(h) === -1)));

// --- 6. the merged AI visibility overview ---------------------------------
const hubFile = path.join(VIEWS, 'aiseo/hub.ejs');
const hubSrc = fs.readFileSync(hubFile, 'utf8');
const aiBudget = {
  spent: 1.2345, cap: 20, remaining: 18.7655,
  byFeature: [{ feature: 'ai_brief', calls: 12, prompt_tokens: 5000, completion_tokens: 900, cost_usd: 0.9 }],
  history: [{}, {}],
  pricing: { inputPer1M: 2.5, outputPer1M: 10 },
};
const hubBase = {
  brands: [{ id: 1, name: 'Acme' }, { id: 2, name: 'Globex' }],
  summary: [{ kind: 'research', runs: 2, lastRun: '2026-01-01', score: 80, findings: 3, urgent: 1 }],
  openFindings: [{ severity: 'high', run_kind: 'onpage', title: 'Thin page', affected_url: 'https://e.com/a', run_id: 5 }],
  providerList: [{ label: 'GSC', available: true, enhancementMissing: false, provides: ['queries'], note: null }],
  aiBudget, activeRuns: [], maxConcurrent: 2,
};
[['no brand selected', null], ['a brand selected', { id: 1, name: 'Acme' }]].forEach(([label, brand]) => {
  let out;
  try {
    out = ejs.render(hubSrc, locals(Object.assign({ path: '/ai-seo', brand }, hubBase)), { filename: hubFile, views: [VIEWS] });
  } catch (e) {
    fail += 1; console.log('FAIL hub renders with ' + label + ' -> ' + e.message); return;
  }
  console.log('OK   hub renders with ' + label + ' (' + out.length + ' bytes)');
  check('  AI Assist section present (' + label + ')', out.indexOf('AI Assist') >= 0);
  check('  spend, cap and remaining shown (' + label + ')',
    out.indexOf('$' + (1.2345).toFixed(3)) >= 0 && out.indexOf('$20.00 cap') >= 0 && out.indexOf('$' + (18.7655).toFixed(3)) >= 0);
  check('  call count summed from byFeature, not history (' + label + ')', out.indexOf('12 calls logged') >= 0);
  check('  spend-by-feature detail (' + label + ')', out.indexOf('Where the AI budget went') >= 0);
  check('  no dead links back to the removed hub (' + label + ')', out.indexOf('href="/ai-assist"') === -1);
  if (brand) {
    check('  tools link straight to the selected brand', out.indexOf('/ai-assist/1/metadata') >= 0);
  } else {
    check('  every brand gets a row', out.indexOf('/ai-assist/1/tasks') >= 0 && out.indexOf('/ai-assist/2/tasks') >= 0);
  }
});

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
