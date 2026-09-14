require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const config = require('./config');
const alertEngine = require('./lib/alertEngine');
const scheduler = require('./lib/scheduler');
const team = require('./lib/team');
const assignmentQueue = require('./lib/assignmentQueue');
const pythonEnv = require('./lib/pythonEnv');
const backup = require('./lib/backup');
const toolRunner = require('./lib/toolRunner');
const notify = require('./lib/notify');

const securityHeaders = require('./lib/securityHeaders');
const csrf = require('./lib/csrf');

const app = express();
const PORT = config.PORT;

// A tunnel or reverse proxy terminates TLS, so Express must be told to read
// X-Forwarded-Proto - otherwise `secure` cookies are never sent and nobody can
// stay signed in. It also decides whether HSTS is safe to send.
const BEHIND_PROXY = process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production';
if (BEHIND_PROXY) app.set('trust proxy', 1);

// Cache-busting stamp for the stylesheet. Browsers cache /css/style.css hard,
// so a CSS change could sit on disk while the tab kept rendering the previous
// layout - indistinguishable from "the fix didn't work". The stamp is the
// file's modification time, so the URL changes exactly when the file does.
// In production it is read once at boot; in development it is re-read per
// request so an edit shows up on the next refresh without a restart.
// Both the stylesheet and the client scripts are cache-busted, and by the same
// stamp: the loader in /js/chart-assets.js is now as likely to change as the
// CSS, and a stamp derived from style.css alone would leave a stale copy of it
// in every browser until the next unrelated CSS edit.
const ASSET_PATHS = [
  path.join(__dirname, '..', 'public', 'css', 'style.css'),
  path.join(__dirname, '..', 'public', 'js', 'chart-assets.js'),
  path.join(__dirname, '..', 'public', 'js', 'country-codes.js'),
];
function assetVersion() {
  const fs = require('fs');
  let newest = 0;
  for (const p of ASSET_PATHS) {
    try {
      const m = Math.floor(fs.statSync(p).mtimeMs);
      if (m > newest) newest = m;
    } catch { /* a missing file just does not contribute */ }
  }
  return String(newest);
}
const BOOT_ASSET_VERSION = assetVersion();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
// Set before anything else answers, so the static handler's responses carry
// them too - a header middleware mounted after express.static would not apply
// to /css/style.css or /js/chart-assets.js at all.
app.use(securityHeaders({ behindProxy: BEHIND_PROXY }));

// Every reference to these files carries ?v=<mtime>, so the bytes at a given
// URL never change and a year-long immutable cache is safe. Without maxAge the
// browser revalidated the stylesheet and the chart loader on every navigation
// - a round trip in front of first paint on each page, which is exactly the
// kind of thing that puts LCP over budget on a slow connection.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '365d',
  immutable: true,
  // A directory listing or an index.html is never wanted here; public/ holds
  // privacy.html and terms.html, which are linked explicitly.
  index: false,
  setHeaders(res, filePath) {
    // The two standalone legal pages are not versioned, so they must not be
    // pinned for a year.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // keyword pastes can be large
app.use(express.json({ limit: '5mb' }));

// Sessions live in SQLite, not in memory. With the default MemoryStore every
// restart signed the whole team out - tolerable for one developer, not for a
// team on a live URL who would be logged out by a deploy or a crash-restart.
// That matters more on shared hosting, not less: Passenger stops the app
// whenever it goes idle, so a memory-backed session would rarely survive an
// afternoon.
//
// The store writes to the connection db.js already owns rather than opening its
// own - see lib/sessionStore.js for why connect-sqlite3 was replaced.
const SqliteSessionStore = require('./lib/sessionStore');

app.use(session({
  store: new SqliteSessionStore(db),
  name: 'seosuite.sid',
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // active use keeps a session alive rather than expiring mid-week
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    // Only set over HTTPS: forcing it on plain HTTP would silently break login
    // for anyone running this locally.
    secure: process.env.COOKIE_SECURE === '1' || BEHIND_PROXY,
  },
}));

// Current user + globals every view can rely on.
app.use((req, res, next) => {
  res.locals.currentUser = null;
  if (req.session.userId) {
    const user = db.prepare(`SELECT id, email, name, team_id, role, status, can_assign
      FROM users WHERE id = ?`).get(req.session.userId);
    if (user) {
      res.locals.currentUser = user;
      // A team shares the data of its owner. Resolving that here means every
      // existing `WHERE user_id = ?` query scopes to the whole team without
      // being rewritten - while req.actorId still identifies the person, so
      // approvals and assignments record who actually acted.
      req.actorId = user.id;
      req.dataUserId = team.dataOwnerId(user);
      res.locals.team = user.team_id ? team.getTeam(user.team_id) : null;
      res.locals.perms = {
        isAdmin: team.isAdmin(user),
        canAssign: team.canAssign(user),
        canWrite: team.canWrite(user),
        canManageTeam: team.canManageTeam(user),
      };
      res.locals.pendingMembers = team.isAdmin(user) && user.team_id ? team.pendingCount(user.team_id) : 0;
    } else {
      req.session.userId = null;
    }
  }
  if (!res.locals.perms) {
    res.locals.perms = { isAdmin: false, canAssign: false, canWrite: false, canManageTeam: false };
    res.locals.team = null;
    res.locals.pendingMembers = 0;
  }

  // Small helpers used across templates, defined once here rather than
  // re-implemented per view.
  res.locals.fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  res.locals.fmtPct = (n, dp = 1) => `${(Number(n) || 0).toFixed(dp)}%`;
  res.locals.fmtPos = (n) => (n == null ? '-' : Number(n).toFixed(1));
  // Seconds → "2m 14s", matching how GA4 prints average session duration.
  res.locals.fmtDuration = (secs) => {
    const s = Math.round(Number(secs) || 0);
    if (s <= 0) return '0s';
    const m = Math.floor(s / 60);
    return m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  res.locals.fmtDate = (s) => (s ? String(s).slice(0, 10) : '-');
  res.locals.fmtDateTime = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '-');
  res.locals.assetVersion = process.env.NODE_ENV === 'production' ? BOOT_ASSET_VERSION : assetVersion();
  res.locals.severityMeta = notify.severityMeta;
  // Run status → an actual badge class. Several views used the raw status as
  // the class name, so anything other than "completed" rendered as an
  // unstyled, borderless pill (there is no .badge.running / .badge.error).
  res.locals.statusBadge = (status) => ({
    completed: 'good',
    running: 'accent',
    queued: 'neutral',
    pending: 'neutral',
    error: 'critical',
    failed: 'critical',
    timeout: 'critical',
  }[String(status || '').toLowerCase()] || 'neutral');
  res.locals.shortUrl = (u, max = 60) => {
    if (!u) return ' - ';
    try {
      const url = new URL(u);
      const p = url.pathname + (url.search || '');
      const out = p === '/' ? '/' : p;
      return out.length > max ? `${out.slice(0, max)}…` : out;
    } catch {
      return String(u).length > max ? `${String(u).slice(0, max)}…` : String(u);
    }
  };
  res.locals.query = req.query;
  res.locals.path = req.path;
  next();
});

// Makes `csrfField` available to every template. Verification is mounted
// further down, after the cron route.
app.use(csrf.expose);

function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    // Remember where they were headed so login can return them there.
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  // A member awaiting approval is authenticated but has no workspace yet.
  // Blocking here - not in each route - is what guarantees no client data can
  // leak to an unapproved account through a route someone forgets to guard.
  if (res.locals.currentUser.status !== 'active') return res.redirect('/pending');

  next();
}
app.set('requireAuth', requireAuth);

// Admin-only areas: team management, and anything that repoints the whole
// team's data source.
function requireAdmin(req, res, next) {
  if (!res.locals.currentUser) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (!res.locals.perms.isAdmin) {
    return res.status(403).render('error', {
      title: 'Admins only', active: null,
      message: 'Only a team admin can open this page.',
    });
  }
  next();
}
app.set('requireAdmin', requireAdmin);

// Brands are needed by the sidebar's brand switcher on every authed page.
app.use((req, res, next) => {
  if (res.locals.currentUser) {
    // Scoped to req.dataUserId - the team's data owner - not to the signed-in
    // member's own id. A team shares the owner's workspace (see lib/team.js),
    // and all ~130 data queries in the routes already resolve through
    // dataUserId. This middleware used currentUser.id, so every member who was
    // not the owner got an empty brand switcher and three zeroed counters
    // sitting next to page bodies full of the team's real data - the sidebar
    // disagreeing with the page it framed.
    const dataUserId = req.dataUserId;
    res.locals.navBrands = db.prepare('SELECT id, name FROM brands WHERE user_id=? AND active=1 ORDER BY name')
      .all(dataUserId);
    res.locals.navCounts = {
      openTasks: db.prepare("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND status IN ('backlog','in_progress','awaiting_approval','blocked')")
        .get(dataUserId).n,
      needsApproval: db.prepare("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND requires_approval=1 AND approved_at IS NULL AND status NOT IN ('done','dismissed')")
        .get(dataUserId).n,
      openAlerts: db.prepare('SELECT COUNT(*) n FROM alert_events WHERE user_id=? AND acknowledged_at IS NULL')
        .get(dataUserId).n,
    };
  } else {
    res.locals.navBrands = [];
    res.locals.navCounts = { openTasks: 0, needsApproval: 0, openAlerts: 0 };
  }

  // Drives the "Get started" nav item. Derived from real state, so it
  // disappears by itself once the workspace is actually set up.
  res.locals.setupRemaining = 0;
  if (res.locals.currentUser && res.locals.perms.isAdmin) {
    try {
      res.locals.setupRemaining = require('./routes/onboarding').steps(req, res).filter((x) => !x.done).length;
    } catch { res.locals.setupRemaining = 0; }
  }
  next();
});

app.get('/', (req, res) => res.redirect(res.locals.currentUser ? '/dashboard' : '/login'));

// Mounted ahead of the authenticated routes: cron carries a shared secret, not
// a session, and must not be redirected to the login page.
app.use('/internal/cron', require('./routes/cron'));

// Lead ingest is called by someone else's software - a form handler, a CRM, a
// Zapier step - which authenticates with a key in a header and has no session.
// It is mounted here, ABOVE csrf.verify, for exactly the reason the cron route
// is: there is no session to hold a CSRF token, so the verifier below would
// reject every post. See routes/leadsApi.js.
app.use('/api/leads', require('./routes/leadsApi'));

// Everything below authenticates by session, so from here on a state-changing
// request must carry the session's CSRF token. Mounted after the cron route
// deliberately: cron authenticates with a shared secret and has no session to
// hold a token. See lib/csrf.js.
app.use(csrf.verify);

// A cheap liveness URL. Hostinger's uptime monitor (or any external pinger)
// hitting this every few minutes also has the side effect of keeping Passenger
// from idling the app out between cron ticks.
// A weekly report shared with a client. No session, no login, GET only - the
// token in the URL is the whole credential. See routes/share.js.
app.use('/r', require('./routes/share'));

app.get('/healthz', (req, res) => {
  res.type('text/plain').send(`ok ${db.engineName || 'sqlite'}\n`);
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/googleAuth'));
app.use('/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/performance', requireAuth, require('./routes/performance'));
app.use('/brands', requireAuth, require('./routes/brands'));
app.use('/connect', requireAuth, require('./routes/connect'));
app.use('/audit', requireAuth, require('./routes/audit'));
app.use('/pagespeed', requireAuth, require('./routes/pagespeed'));
app.use('/linking', requireAuth, require('./routes/linking'));
app.use('/keywords', requireAuth, require('./routes/keywords'));
// Mounted on its own path rather than under /keywords: that router matches a
// bare "/:id" as a clustering run id, so any sibling path added there has to
// be declared above it or it 404s (see the comment in routes/keywords.js).
app.use('/keyword-planner', requireAuth, require('./routes/keywordPlanner'));
app.use('/alerts', requireAuth, require('./routes/alerts'));
app.use('/tasks', requireAuth, require('./routes/tasks'));
app.use('/reports', requireAuth, require('./routes/reports'));
app.use('/leads', requireAuth, require('./routes/leads'));
app.use('/settings', requireAuth, require('./routes/settings'));
app.use('/team', requireAuth, require('./routes/team'));
app.use('/onboarding', requireAuth, require('./routes/onboarding'));
app.use('/workflow', requireAuth, require('./routes/workflow'));
app.use('/ai-assist', requireAuth, require('./routes/aiAssist'));
app.use('/ai-seo', requireAuth, require('./routes/aiseo'));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found', active: null, status: 404,
    message: `There is no page at ${req.path}. It may have been renamed, or the link that brought you here may be out of date.`,
  });
});

app.use((err, req, res, next) => {
  // A short reference is logged with the stack and shown to the user, so a
  // report of "I got an error" can be tied to one line in the log without the
  // page having to show the error itself.
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  const isProd = process.env.NODE_ENV === 'production';
  console.error(`[error] ref=${ref} ${req.method} ${req.originalUrl}`, err);

  // Raw err.message used to be rendered in production. The messages here come
  // from SQLite, googleapis and nodemailer, and carry absolute paths, SQL, and
  // in the worst case a fragment of a request that contained a credential - 
  // none of which belongs on a page that an unapproved account can reach.
  const message = isProd
    ? `Something went wrong on our side. Quote reference ${ref} if you report this.`
    : (err.message || 'Something went wrong.');

  // If the failure happened before the view-globals middleware ran (a session
  // store error, say), these locals are missing and error.ejs would itself
  // throw on `currentUser` - turning a handled 500 into an unhandled one with
  // no page at all.
  if (res.locals.currentUser === undefined) res.locals.currentUser = null;
  if (!res.locals.perms) {
    res.locals.perms = { isAdmin: false, canAssign: false, canWrite: false, canManageTeam: false };
  }
  if (res.locals.team === undefined) res.locals.team = null;
  if (res.locals.pendingMembers === undefined) res.locals.pendingMembers = 0;
  if (!res.locals.navBrands) res.locals.navBrands = [];
  if (!res.locals.navCounts) res.locals.navCounts = { openTasks: 0, needsApproval: 0, openAlerts: 0 };

  // Headers may already be sent if the failure happened mid-stream (an xlsx
  // export, a long report). Nothing can be rendered over a partial response;
  // ending it is the only honest option.
  if (res.headersSent) return req.socket.destroy();

  try {
    return res.status(500).render('error', {
      title: 'Error', active: null,
      message,
      stack: isProd ? null : err.stack,
    });
  } catch (renderErr) {
    // The error page itself failed. Plain text beats a blank response.
    console.error(`[error] ref=${ref} error page failed to render`, renderErr);
    return res.status(500).type('text/plain').send(`Something went wrong (ref ${ref}).
`);
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n  SEO Automation Suite  →  http://localhost:${PORT}\n`);

  // A run marked "running" in the database belongs to a process that no longer
  // exists, so clear those before anything reads them.
  try { toolRunner.reconcileOnBoot(); } catch (e) {
    console.error('[boot] run reconciliation failed:', e.message);
  }

  // Same problem, different runner: the AI SEO analyses run in-process, so a
  // Passenger restart mid-crawl leaves a row saying 'running' that nothing will
  // ever finish. Left alone, its result page polls forever, which reads as
  // "still working" rather than "was interrupted".
  try { require('./lib/aiseo/runner').reconcileOnBoot(); } catch (e) {
    console.error('[boot] AI SEO run reconciliation failed:', e.message);
  }

  // Alerts, nightly sync, weekly reports, database backups and assignment
  // digests are all owned by lib/scheduler.js now. On a long-lived server it
  // starts the same in-process timers as before; behind Passenger, where the
  // process is stopped whenever it goes idle, it starts nothing and waits to be
  // driven by an external cron calling /internal/cron. See that module's header.
  try { scheduler.start(); } catch (e) {
    console.error('[boot] scheduler failed to start:', e.message);
  }

  // The crawlers ship in two implementations: the original Python programs and
  // JavaScript ports that need nothing but Node. A machine can have several
  // Python installs with only one carrying the packages, and shared hosting
  // often has none at all - so report which implementation will actually be
  // used rather than letting the first audit surprise someone.
  try {
    toolRunner.runtimeStatus().forEach((s) => {
      console.log(`  ${s.label}: using ${s.using}${s.note ? ` (${s.note})` : ''}`);
    });
  } catch (e) {
    console.error('[boot] tool runtime check failed:', e.message);
  }

  // Refuses to start a production deploy with a guessable session secret: with
  // the default, anyone can forge a signed cookie and sign in as the admin.
  if (process.env.NODE_ENV === 'production' && config.SESSION_SECRET === 'dev-insecure-secret-change-me') {
    console.error('\n  FATAL: SESSION_SECRET is still the default. Set a long random value in .env before exposing this app.\n');
    process.exit(1);
  }
  if (process.env.NODE_ENV !== 'production') {
    console.log('  Note: NODE_ENV is not "production" - error pages will show stack traces.');
  }
  if (process.env.SIGNUP_REQUIRES_INVITE !== '1') {
    console.log('  Note: sign-up is open - anyone who reaches this URL can create their own workspace.');
    console.log('        Set SIGNUP_REQUIRES_INVITE=1 once your team has joined.');
  }

  if (!notify.smtpConfigured()) {
    console.log('  Note: SMTP is not configured, so alert emails are logged to this console instead of sent.');
  }
  const tools = toolRunner.toolAvailability();
  if (!tools.audit.exists) console.log(`  Note: audit tool missing at ${tools.audit.script}`);
  if (!tools.linking.exists) console.log(`  Note: linking tool missing at ${tools.linking.script}`);

  // The failure this warns about is silent: with no in-process scheduler and no
  // external cron, alerts and reports simply never happen and the dashboard
  // gives no sign of it.
  if (!config.INPROCESS_CRON) {
    if (!config.CRON_TOKEN) {
      console.log('  Note: CRON_TOKEN is not set - scheduled alerts, sync, reports and backups cannot run.');
      console.log('        See DEPLOY-HOSTINGER.md ("Scheduled jobs") to finish the setup.');
    } else if (scheduler.neverRan()) {
      console.log('  Note: no scheduled job has run yet. If this deploy is more than an hour old,');
      console.log(`        check the hPanel cron job is calling ${config.BASE_URL || 'https://your-domain'}/internal/cron`);
    }
  }
});

// Passenger imports this file rather than running it as a program, and sends
// SIGTERM when it idles the app out. Closing the database on the way down
// matters for the WebAssembly engine, which holds its own heap and must flush
// and release the file rather than being killed mid-write.
function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  // Do not hang forever on a connection that will not drain.
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An unhandled rejection defaults to killing the process on modern Node. On
// shared hosting that turns one failed Google API call into a 503 for everyone
// until the next request restarts the app, so it is logged instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

module.exports = { app, server };
