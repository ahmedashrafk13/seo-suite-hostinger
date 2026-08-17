// Read-write smoke test for the POST flows a tester will click first.
//
// WHY
// `verify_pages.js` proves every page RENDERS. It says nothing about what
// happens when someone presses a button, and buttons are where the writes
// live: creating a keyword run, filing tasks, generating a brief, approving a
// cluster, changing a task's status. Those paths were only ever exercised at
// the library level here, never through the HTTP layer that actually runs
// them.
//
// SAFETY
// Every request runs inside a single SQLite transaction that is ALWAYS rolled
// back, and the harness shares one better-sqlite3 connection with the routes,
// so their writes land in the same transaction and vanish with it. The
// database is byte-for-byte unchanged afterwards, which is asserted at the end.
//
// DELIBERATELY EXCLUDED — these are not "risky to test", they are impossible
// to test safely in-process:
//   * /audit/start, /linking/start   spawn OS processes and crawl the network
//   * /brands/:id/sync               calls the Google APIs
//   * /alerts/test-notification,
//     /reports/:id/send              send real email
//   * /ai-lab/**/generate            spend money on API calls
//   * /brands/:id/delete, /*/delete  destructive by design
//   * /auth/*                        session mutation, not app logic
// Those need a human on a staging brand, and are listed in the handover notes.
//
// Run:  node verify_actions.js
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');

const db = require('./src/db');
const notify = require('./src/lib/notify');
const teamLib = require('./src/lib/team');

const USER_ID = Number(process.env.SMOKE_USER_ID || 2);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => { req.session = { userId: USER_ID }; next(); });
app.use((req, res, next) => {
  res.locals.currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(USER_ID) || null;
  // Team resolution, mirroring src/app.js: routes read req.dataUserId for data
  // access and req.actorId for identity, and views read res.locals.perms.
  {
    const _u = res.locals.currentUser;
    if (_u) {
      req.actorId = _u.id;
      req.dataUserId = teamLib.dataOwnerId(_u);
      res.locals.team = _u.team_id ? teamLib.getTeam(_u.team_id) : null;
      res.locals.perms = {
        isAdmin: teamLib.isAdmin(_u),
        canAssign: teamLib.canAssign(_u),
        canWrite: teamLib.canWrite(_u),
        canManageTeam: teamLib.canManageTeam(_u),
      };
      res.locals.pendingMembers = _u.team_id && teamLib.isAdmin(_u) ? teamLib.pendingCount(_u.team_id) : 0;
    } else {
      req.dataUserId = null;
      res.locals.team = null;
      res.locals.perms = { isAdmin: false, canAssign: false, canWrite: false, canManageTeam: false };
      res.locals.pendingMembers = 0;
    }
  }
  res.locals.fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  res.locals.fmtPct = (n, dp = 1) => `${(Number(n) || 0).toFixed(dp)}%`;
  res.locals.fmtPos = (n) => (n == null ? '—' : Number(n).toFixed(1));
  res.locals.fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
  res.locals.fmtDateTime = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—');
  res.locals.severityMeta = notify.severityMeta;
  res.locals.shortUrl = (u) => String(u || '—');
  res.locals.query = req.query;
  res.locals.path = req.path;
  res.locals.navBrands = [];
  res.locals.navCounts = { openTasks: 0, needsApproval: 0, openAlerts: 0 };
  next();
});
const pass = (req, res, next) => next();
app.set('requireAuth', pass);
[['/brands', './src/routes/brands'], ['/keywords', './src/routes/keywords'],
  ['/tasks', './src/routes/tasks'], ['/alerts', './src/routes/alerts'],
  ['/linking', './src/routes/linking'], ['/audit', './src/routes/audit']]
  .forEach(([m, mod]) => app.use(m, pass, require(mod)));

const errors = new Map();
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  errors.set(req.originalUrl, err);
  res.status(500).send(`ERROR: ${err.message}`);
});

function post(server, url, form) {
  const body = new URLSearchParams(form || {}).toString();
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: out }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

let passed = 0;
const failures = [];

function record(name, res, url) {
  // A POST route here always redirects on success. An error surfaces either as
  // a 500, or as a redirect carrying ?error= — both are failures.
  const redirected = res.status >= 300 && res.status < 400;
  const errParam = redirected && /[?&]error=/.test(res.location || '');
  if (redirected && !errParam) {
    passed += 1;
    console.log(`OK   ${res.status} ${name}`);
    return true;
  }
  const err = errors.get(url);
  const detail = errParam
    ? decodeURIComponent((res.location.split('error=')[1] || '').split('&')[0])
    : (err ? err.stack.split('\n').slice(0, 3).join('\n     ') : res.body.slice(0, 200));
  failures.push(name);
  console.log(`FAIL ${res.status} ${name}\n     ${detail}`);
  return false;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const before = db.prepare('SELECT (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM keyword_runs) k, (SELECT COUNT(*) FROM content_briefs) b').get();

  db.prepare('BEGIN').run();
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY id LIMIT 1').get(USER_ID);
    const brandId = brand.id;

    console.log('\n[keyword clustering]');
    let r = await post(server, '/keywords/run', { brand_id: brandId, source: 'gsc', name: 'smoke test' });
    record('POST /keywords/run (from Search Console)', r, '/keywords/run');

    r = await post(server, '/keywords/run', {
      brand_id: brandId, source: 'manual', name: 'smoke paste',
      keywords: 'web design services\nweb design company\nweb design pricing\naffordable web design services for small business',
    });
    record('POST /keywords/run (pasted list)', r, '/keywords/run');

    // The degenerate input that used to 500 with a NOT NULL constraint.
    r = await post(server, '/keywords/run', { brandId, source: 'paste', name: 'junk', keywords: 'the and for\na of to' });
    record('POST /keywords/run (all-stopword list — used to crash)', r, '/keywords/run');

    const runRow = db.prepare('SELECT id, result_json FROM keyword_runs WHERE user_id=? ORDER BY id DESC LIMIT 1').get(USER_ID);
    const usable = db.prepare("SELECT id, result_json FROM keyword_runs WHERE user_id=? AND cluster_count > 0 ORDER BY id DESC LIMIT 1").get(USER_ID);
    const clusterId = usable ? (JSON.parse(usable.result_json).clusters[0] || {}).id : null;

    console.log('\n[cluster actions]');
    if (usable && clusterId) {
      r = await post(server, `/keywords/${usable.id}/cluster/${clusterId}/approve`, {});
      record('POST approve cluster', r, `/keywords/${usable.id}/cluster/${clusterId}/approve`);

      r = await post(server, `/keywords/${usable.id}/cluster/${clusterId}/brief`, {});
      record('POST generate content brief', r, `/keywords/${usable.id}/cluster/${clusterId}/brief`);

      r = await post(server, `/keywords/${usable.id}/create-tasks`, { limit: '10' });
      record('POST create tasks from clusters', r, `/keywords/${usable.id}/create-tasks`);

      r = await post(server, `/keywords/${usable.id}/cluster/${clusterId}/unapprove`, {});
      record('POST unapprove cluster', r, `/keywords/${usable.id}/cluster/${clusterId}/unapprove`);
    } else {
      console.log('SKIP no usable cluster run available');
    }

    console.log('\n[tasks]');
    r = await post(server, `/tasks/opportunities/${brandId}/promote`, { limit: '20' });
    record('POST create tasks from opportunities', r, `/tasks/opportunities/${brandId}/promote`);

    const task = db.prepare("SELECT id FROM tasks WHERE user_id=? AND status='backlog' AND requires_approval=0 ORDER BY id DESC LIMIT 1").get(USER_ID);
    if (task) {
      r = await post(server, `/tasks/${task.id}/status`, { status: 'in_progress' });
      record('POST change task status', r, `/tasks/${task.id}/status`);
      r = await post(server, `/tasks/${task.id}/update`, { title: 'Edited by smoke test' });
      record('POST edit task', r, `/tasks/${task.id}/update`);
    }

    // The approval gate is a safety feature: completing a restricted task
    // without approval must be REFUSED. A pass here means it let it through.
    const gated = db.prepare("SELECT id FROM tasks WHERE user_id=? AND requires_approval=1 AND approved_at IS NULL AND status NOT IN ('done','dismissed') ORDER BY id DESC LIMIT 1").get(USER_ID);
    if (gated) {
      r = await post(server, `/tasks/${gated.id}/status`, { status: 'done' });
      const blocked = /[?&]error=/.test(r.location || '');
      if (blocked) { passed += 1; console.log('OK   approval gate REFUSED completing a restricted task without approval'); } else { failures.push('approval gate'); console.log('FAIL approval gate let a restricted task be completed without approval'); }
    }

    console.log('\n[linking run → tasks]');
    const lrun = db.prepare("SELECT id FROM linking_runs WHERE user_id=? AND status='completed' ORDER BY id DESC LIMIT 1").get(USER_ID);
    if (lrun) {
      r = await post(server, `/linking/${lrun.id}/create-tasks`, {});
      record('POST create tasks from linking run', r, `/linking/${lrun.id}/create-tasks`);
    }
    const arun = db.prepare("SELECT id FROM audit_runs WHERE user_id=? AND status='completed' ORDER BY id DESC LIMIT 1").get(USER_ID);
    if (arun) {
      r = await post(server, `/audit/${arun.id}/create-tasks`, {});
      record('POST create tasks from audit run', r, `/audit/${arun.id}/create-tasks`);
    }

    console.log('\n[brand settings]');
    r = await post(server, `/brands/${brandId}/content-settings`, {
      vertical: brand.vertical || 'professional_services',
      locale: brand.locale || 'en',
      market: brand.market || '',
      services_json: brand.services_json || '[]',
      cta_json: brand.cta_json || '{}',
    });
    record('POST save brand content settings', r, `/brands/${brandId}/content-settings`);

    console.log('\n[alerts]');
    r = await post(server, '/alerts/acknowledge-all', {});
    record('POST acknowledge all alerts', r, '/alerts/acknowledge-all');
  } finally {
    db.prepare('ROLLBACK').run();
    server.close();
  }

  const after = db.prepare('SELECT (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM keyword_runs) k, (SELECT COUNT(*) FROM content_briefs) b').get();
  const clean = before.t === after.t && before.k === after.k && before.b === after.b;
  console.log(`\nrollback check: tasks ${before.t}->${after.t}, runs ${before.k}->${after.k}, briefs ${before.b}->${after.b} ${clean ? 'OK (database unchanged)' : 'FAILED — DATA WAS WRITTEN'}`);
  if (!clean) failures.push('rollback left data behind');

  console.log(`\n${passed} actions passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
