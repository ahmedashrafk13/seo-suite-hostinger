// Broken-link sweep across the whole app.
//
// WHY
// verify_pages.js proves a fixed list of pages renders. It says nothing about
// whether the links ON those pages go anywhere — a renamed route, a dropped
// query parameter or a stale href is invisible until someone clicks it and
// lands on a 404 or a 500.
//
// HOW
// Same harness as verify_pages.js (real routers, real templates, real database,
// stubbed session). It renders a set of seed pages, extracts every internal
// href and form action, and GETs each one, following the app's own redirects.
// Anything that 404s, 500s or renders the error template is reported with the
// page that linked to it, so the fix has an address.
//
// Only GET requests are issued — form actions are recorded as "POST target"
// and checked for route existence rather than submitted, so nothing is written.
//
// Run:  node verify_links.js
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
  ['/ai-assist', './src/routes/aiAssist'],
];
MOUNTS.forEach(([mount, mod]) => {
  try { app.use(mount, passThrough, require(mod)); } catch (err) {
    console.log(`MOUNT FAIL ${mount}: ${err.message}`);
  }
});

// Routes that live on the auth/googleAuth routers, which are not mounted here
// because they redirect to Google or clear the session. Treated as known-good.
const OUT_OF_SCOPE = [/^\/login/, /^\/logout/, /^\/signup/, /^\/api\/auth\//];

const errors = new Map();
app.use((req, res) => { res.status(404).send('NOT FOUND'); });
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  errors.set(req.originalUrl, err);
  res.status(500).send(`ERROR: ${err.message}`);
});

// ------------------------------------------------------------------ crawling
function seedPages() {
  const brand = db.prepare('SELECT id FROM brands WHERE user_id=? ORDER BY id LIMIT 1').get(USER_ID);
  const b = brand ? brand.id : 1;
  const pick = (sql) => { try { const r = db.prepare(sql).get(USER_ID); return r ? r.id : null; } catch { return null; } };

  const seeds = [
    '/dashboard', `/dashboard?brand=${b}`,
    '/performance', `/performance?brand=${b}`,
    '/onboarding', '/brands', '/brands/import', `/brands/${b}`,
    '/connect', '/audit', '/pagespeed', '/linking', '/keywords', '/keywords/briefs',
    '/alerts', '/alerts/history', '/tasks', '/tasks?view=table',
    `/tasks/opportunities/${b}`, '/reports', '/settings', '/workflow',
    '/ai-assist',
  ];
  [
    ['linking_runs', '/linking/'], ['keyword_runs', '/keywords/'],
    ['audit_runs', '/audit/'], ['tasks', '/tasks/'], ['weekly_reports', '/reports/'],
    ['psi_reports', '/pagespeed/'],
  ].forEach(([table, prefix]) => {
    const id = pick(`SELECT id FROM ${table} WHERE user_id=? ORDER BY id DESC LIMIT 1`);
    if (id) seeds.push(prefix + id);
  });
  const brief = db.prepare('SELECT id FROM content_briefs WHERE user_id=? ORDER BY id DESC LIMIT 1').get(USER_ID);
  if (brief) seeds.push(`/keywords/brief/${brief.id}`);
  const alertEvent = pick('SELECT id FROM alert_events WHERE user_id=? ORDER BY id DESC LIMIT 1');
  if (alertEvent) seeds.push(`/alerts/event/${alertEvent}`);
  return seeds;
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Pulls hrefs and form actions out of rendered HTML. External URLs, anchors,
// mailto/tel and javascript: are skipped — this only checks the app's own links.
function extractLinks(html) {
  const out = { links: new Set(), forms: new Set() };
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = decode(m[1]).trim();
    if (!href || href.startsWith('#') || /^(https?:|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    out.links.add(href);
  }
  // A form's method decides how its action must be checked: method="get"
  // forms (the filter bars) are ordinary GET URLs, only method="post" forms
  // need a POST handler. Ignoring the method reported every filter bar in the
  // app as a missing POST route.
  for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
    const attrs = m[1];
    const actionMatch = attrs.match(/\baction\s*=\s*"([^"]*)"/i);
    if (!actionMatch) continue;
    const action = decode(actionMatch[1]).trim();
    if (!action || /^https?:/i.test(action)) continue;
    const methodMatch = attrs.match(/\bmethod\s*=\s*"([^"]*)"/i);
    const isPost = methodMatch && methodMatch[1].trim().toLowerCase() === 'post';
    if (isPost) out.forms.add(action);
    else out.links.add(action); // GET form → just another URL to fetch
  }
  return out;
}

function resolve(base, href) {
  try { return new URL(href, `http://x${base}`).pathname + new URL(href, `http://x${base}`).search; }
  catch { return null; }
}

function get(server, url) {
  return new Promise((resolve2) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve2({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', (e) => resolve2({ status: 0, body: e.message }));
  });
}

// A POST-only endpoint answers GET with a 404 from the router, which is not a
// broken link — so form actions are verified by checking the mounted routers
// declare a POST handler for that path rather than by issuing a request.
// app.js mounts these two at '/', so their paths (e.g. /connect/disconnect,
// /logout) sit under other routers' prefixes and would otherwise look missing.
// They are checked for route existence only — never requested, since they
// redirect to Google or clear the session.
const ROOT_ROUTERS = ['./src/routes/auth', './src/routes/googleAuth'];

function hasPostRoute(modPath, subPath) {
  let router;
  try { router = require(modPath); } catch { return false; }
  return (router.stack || []).some((layer) => {
    if (!layer.route || !layer.route.methods || !layer.route.methods.post) return false;
    return layer.regexp.test(subPath);
  });
}

function postRouteExists(actionPath) {
  const clean = actionPath.split('?')[0];
  if (ROOT_ROUTERS.some((mod) => hasPostRoute(mod, clean))) return true;
  const mount = MOUNTS.find(([m]) => clean === m || clean.startsWith(`${m}/`));
  if (!mount) return false;
  return hasPostRoute(mount[1], clean.slice(mount[0].length) || '/');
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const seeds = seedPages();
  const linkSources = new Map(); // url -> Set(pages that link to it)
  const formSources = new Map();

  console.log(`Crawling ${seeds.length} seed pages…\n`);
  for (const seed of seeds) {
    /* eslint-disable no-await-in-loop */
    const res = await get(server, seed);
    if (res.status !== 200) {
      console.log(`SEED ${res.status} ${seed} — cannot extract links`);
      continue;
    }
    const { links, forms } = extractLinks(res.body);
    links.forEach((href) => {
      const url = resolve(seed, href);
      if (!url || OUT_OF_SCOPE.some((re) => re.test(url))) return;
      if (!linkSources.has(url)) linkSources.set(url, new Set());
      linkSources.get(url).add(seed);
    });
    forms.forEach((action) => {
      const url = resolve(seed, action);
      if (!url || OUT_OF_SCOPE.some((re) => re.test(url))) return;
      if (!formSources.has(url)) formSources.set(url, new Set());
      formSources.get(url).add(seed);
    });
  }

  const broken = [];
  const urls = [...linkSources.keys()].sort();
  console.log(`Checking ${urls.length} distinct internal links…\n`);
  for (const url of urls) {
    const res = await get(server, url);
    const redirect = res.status >= 300 && res.status < 400;
    const renderedError = res.status === 200 && /Something went wrong|<title>\s*Error/i.test(res.body);
    const ok = (res.status === 200 && !renderedError) || redirect;
    if (ok) {
      console.log(`OK   ${res.status} ${url}${redirect ? ` -> ${res.location}` : ''}`);
    } else {
      const err = errors.get(url);
      broken.push({ url, status: res.status, from: [...linkSources.get(url)], reason: err ? err.message : res.body.slice(0, 160) });
      console.log(`BAD  ${res.status} ${url}\n     linked from: ${[...linkSources.get(url)].join(', ')}\n     ${err ? err.message : res.body.slice(0, 160)}`);
    }
  }

  console.log(`\nChecking ${formSources.size} distinct form actions…\n`);
  const badForms = [];
  for (const [url, from] of formSources) {
    if (postRouteExists(url)) {
      console.log(`OK   POST ${url}`);
    } else {
      badForms.push({ url, from: [...from] });
      console.log(`BAD  POST ${url}\n     no POST handler; submitted from: ${[...from].join(', ')}`);
    }
  }

  server.close();
  console.log(`\n${urls.length - broken.length}/${urls.length} links OK, ${formSources.size - badForms.length}/${formSources.size} form actions OK`);
  if (broken.length || badForms.length) {
    console.log('\nBROKEN:');
    broken.forEach((b) => console.log(`  ${b.status} ${b.url}  (from ${b.from.join(', ')})`));
    badForms.forEach((b) => console.log(`  POST ${b.url}  (from ${b.from.join(', ')})`));
  }
  process.exit(broken.length || badForms.length ? 1 : 0);
})();
