// Read-only UI smoke test: does every page actually render?
//
// WHY
// Every other suite in this repo tests engines and data. Nothing tested that
// the EJS templates survive contact with what those engines now return — and
// the engines changed a lot. A template that throws on a renamed field is a
// 500 in front of whoever opens the page, which no amount of correct analysis
// makes up for.
//
// HOW
// It rebuilds app.js's middleware stack exactly (same res.locals helpers, same
// sidebar queries, same view engine) but swaps the real session for a stub
// that pins req.session.userId, and swaps requireAuth for a pass-through. The
// REAL routers, REAL templates and REAL database are used throughout, so this
// exercises the same code path a logged-in user hits.
//
// Only GET requests are issued and nothing is written, so it is safe to run
// against live data.
//
// Run:  node verify_pages.js
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));

// Stub session — no cookie store, no login, just a pinned user id.
app.use((req, res, next) => { req.session = { userId: USER_ID }; next(); });

app.use((req, res, next) => {
  res.locals.currentUser = null;
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) res.locals.currentUser = user;
  }
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
      res.locals.setupRemaining = 0;
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
  res.locals.fmtDuration = (secs) => {
    const s = Math.round(Number(secs) || 0);
    if (s <= 0) return '0s';
    const m = Math.floor(s / 60);
    return m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  res.locals.fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
  res.locals.fmtDateTime = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—');
  res.locals.severityMeta = notify.severityMeta;
  res.locals.statusBadge = (status) => ({
    completed: 'good', running: 'accent', queued: 'neutral', pending: 'neutral',
    error: 'critical', failed: 'critical', timeout: 'critical',
  }[String(status || '').toLowerCase()] || 'neutral');
  res.locals.shortUrl = (u, max = 60) => {
    if (!u) return '—';
    try {
      const url = new URL(u);
      const p = url.pathname + (url.search || '');
      return p.length > max ? `${p.slice(0, max)}…` : p;
    } catch {
      return String(u).length > max ? `${String(u).slice(0, max)}…` : String(u);
    }
  };
  res.locals.query = req.query;
  res.locals.path = req.path;
  next();
});

const passThrough = (req, res, next) => next();
app.set('requireAuth', passThrough);

app.use((req, res, next) => {
  const u = res.locals.currentUser;
  if (u) {
    res.locals.navBrands = db.prepare('SELECT id, name FROM brands WHERE user_id=? AND active=1 ORDER BY name').all(u.id);
    res.locals.navCounts = {
      openTasks: db.prepare("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND status IN ('backlog','in_progress','awaiting_approval','blocked')").get(u.id).n,
      needsApproval: db.prepare("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND requires_approval=1 AND approved_at IS NULL AND status NOT IN ('done','dismissed')").get(u.id).n,
      openAlerts: db.prepare('SELECT COUNT(*) n FROM alert_events WHERE user_id=? AND acknowledged_at IS NULL').get(u.id).n,
    };
  } else {
    res.locals.navBrands = [];
    res.locals.navCounts = { openTasks: 0, needsApproval: 0, openAlerts: 0 };
  }
  next();
});

const MOUNTS = [
  ['/dashboard', './src/routes/dashboard'],
  ['/performance', './src/routes/performance'],
  ['/brands', './src/routes/brands'],
  ['/connect', './src/routes/connect'],
  ['/audit', './src/routes/audit'],
  ['/pagespeed', './src/routes/pagespeed'],
  ['/linking', './src/routes/linking'],
  ['/keywords', './src/routes/keywords'],
  ['/alerts', './src/routes/alerts'],
  ['/tasks', './src/routes/tasks'],
  ['/reports', './src/routes/reports'],
  ['/settings', './src/routes/settings'],
  ['/team', './src/routes/team'],
  ['/onboarding', './src/routes/onboarding'],
  ['/workflow', './src/routes/workflow'],
  ['/ai-lab', './src/routes/aiLab'],
  ['/ai-suggestions', './src/routes/aiSuggestions'],
];
MOUNTS.forEach(([mount, mod]) => {
  try { app.use(mount, passThrough, require(mod)); } catch (err) {
    console.log(`MOUNT FAIL ${mount}: ${err.message}`);
  }
});

// Capture the real error rather than the pretty error page, so a 500 reports
// its cause instead of "Something went wrong".
const errors = new Map();
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  errors.set(req.originalUrl, err);
  res.status(500).send(`ERROR: ${err.message}`);
});

// ------------------------------------------------------------------- targets
function discoverTargets() {
  const brand = db.prepare('SELECT id FROM brands WHERE user_id=? ORDER BY id LIMIT 1').get(USER_ID);
  const b = brand ? brand.id : 1;
  const pick = (sql) => { try { const r = db.prepare(sql).get(USER_ID); return r ? r.id : null; } catch { return null; } };

  const linkingRun = pick('SELECT id FROM linking_runs WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const keywordRun = pick('SELECT id FROM keyword_runs WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const auditRun = pick('SELECT id FROM audit_runs WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const task = pick('SELECT id FROM tasks WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const briefRow = db.prepare('SELECT id FROM content_briefs WHERE user_id=? ORDER BY id DESC LIMIT 1').get(USER_ID);
  const oldBrief = db.prepare('SELECT id FROM content_briefs WHERE user_id=? ORDER BY id ASC LIMIT 1').get(USER_ID);
  const alertEvent = pick('SELECT id FROM alert_events WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const report = pick('SELECT id FROM weekly_reports WHERE user_id=? ORDER BY id DESC LIMIT 1');

  // Every Performance tab, not just the default one: each renders its own
  // template branch against its own dimension table, so one tab breaking is
  // invisible from /performance alone.
  const PERF_TABS = [
    'queries', 'pages', 'querypage', 'countries', 'devices', 'appearance', 'sitemaps',
    'indexing', 'channels', 'ga4pages', 'ga4devices', 'ga4geo', 'ga4acquisition', 'ga4events', 'ai',
  ];

  const t = [
    '/dashboard', `/dashboard?brand=${b}`,
    '/performance', `/performance?brand=${b}`,
    ...PERF_TABS.map((tab) => `/performance?brand=${b}&tab=${tab}`),
    ...PERF_TABS.slice(0, 3).map((tab) => `/performance?brand=${b}&tab=${tab}&ajax=1`),
    '/onboarding', '/brands', '/brands/import', `/brands/${b}`,
    '/tasks?view=table', `/tasks?view=board&brand=${b}`,
    '/connect', '/audit', '/pagespeed', '/linking', '/keywords', '/alerts',
    '/alerts/history', '/tasks', '/tasks?status=backlog', '/tasks?severity=high',
    `/tasks/opportunities/${b}`, '/reports', '/settings', '/workflow',
    '/team', '/ai-lab', `/ai-lab/${b}/compare`, `/ai-lab/${b}/compare.csv`,
  ];
  if (linkingRun) t.push(`/linking/${linkingRun}`);
  if (keywordRun) t.push(`/keywords/${keywordRun}`);
  if (auditRun) t.push(`/audit/${auditRun}`);
  if (task) t.push(`/tasks/${task}`);
  if (alertEvent) t.push(`/alerts/event/${alertEvent}`);
  if (report) t.push(`/reports/${report}`, `/reports/${report}/print`, `/reports/${report}/xlsx`);
  // Both stored PageSpeed strategies: mobile and desktop render different
  // environment labels and, on some sites, different field-data availability.
  db.prepare('SELECT id FROM psi_reports WHERE user_id=? ORDER BY id DESC LIMIT 2').all(USER_ID)
    .forEach((r) => t.push(`/pagespeed/${r.id}`));
  // Both the newest and the OLDEST brief: the oldest predates schemaVersion
  // and is exactly the shape a template is most likely to trip over.
  if (briefRow) t.push(`/keywords/brief/${briefRow.id}`);
  if (oldBrief && (!briefRow || oldBrief.id !== briefRow.id)) t.push(`/keywords/brief/${oldBrief.id}`);
  return t;
}

function get(server, url) {
  return new Promise((resolve) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    }).on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const targets = discoverTargets();
  const bad = [];
  let ok = 0;

  for (const url of targets) {
    /* eslint-disable no-await-in-loop */
    const res = await get(server, url);
    const isOk = res.status === 200 || (res.status >= 300 && res.status < 400);
    // A 200 that rendered the error template is still a failure.
    const renderedError = res.status === 200 && /Something went wrong|<title>\s*Error/i.test(res.body);
    if (isOk && !renderedError) {
      ok += 1;
      const note = res.status >= 300 ? ` -> ${res.location}` : ` (${Math.round(res.body.length / 1024)}kb)`;
      console.log(`OK   ${res.status} ${url}${note}`);
    } else {
      const err = errors.get(url);
      bad.push({ url, status: res.status, message: err ? err.message : res.body.slice(0, 200) });
      console.log(`FAIL ${res.status} ${url}\n     ${err ? err.stack.split('\n').slice(0, 3).join('\n     ') : res.body.slice(0, 200)}`);
    }
  }

  server.close();
  console.log(`\n${ok} pages rendered, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})();
