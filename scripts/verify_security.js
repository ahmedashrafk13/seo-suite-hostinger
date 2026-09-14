// Verifies the security posture and the asset budget of the running app.
//
// WHY THIS EXISTS
// The other verify_*.js scripts prove that pages render and that links go
// somewhere. None of them can tell you that the CSRF middleware is still
// mounted, that a login still issues a fresh session id, or that nobody has
// re-added a 522 KB chart library to the shared <head>. Those are all one
// careless edit away, and every one of them fails silently — the app looks
// completely normal with the protection removed.
//
// WHAT IT COVERS
//   response headers        CSP, nosniff, frame options, referrer, HSTS
//   CSRF                    token present in forms; state-changing POST refused
//                           without one; refused with a wrong one
//   session handling        a new id at login (no fixation); the pre-login id
//                           is dead afterwards; returnTo cannot leave the site
//   login throttle          spraying one password across many addresses from
//                           one IP is stopped
//   team data scoping       a non-owner member's sidebar shows the team's data
//   asset budget            no chart library in the <head>; the loader pins SRI
//   render sweep            every page 200s and every POST form on it has a token
//
// SAFETY
// Runs against a throwaway database in TMP_DIR, never data/app.db. That is not
// politeness: the WebAssembly SQLite engine takes a coarse whole-file lock, so
// pointing this at the live database while the app is up is how you corrupt it.
//
// Run:  node verify_security.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.VERIFY_PORT || 4399);
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'seosuite-verify-'));

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SESSION_SECRET = 'verify-security-secret-long-enough-to-pass';
process.env.SIGNUP_REQUIRES_INVITE = '0';
process.env.INPROCESS_CRON = '0';
process.env.CRON_TOKEN = '';
process.env.DB_PATH = path.join(SANDBOX, 'verify.db');
process.env.DATA_DIR = SANDBOX;
process.env.REPORTS_DIR = SANDBOX;
process.env.TMP_DIR = SANDBOX;

const BASE = `http://127.0.0.1:${PORT}`;

function mkJar() { return { cookie: '' }; }

function req(jar, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : new URLSearchParams(opts.body).toString();
    const headers = { Accept: 'text/html' };
    if (data) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const cookie = opts.cookie === undefined ? jar.cookie : opts.cookie;
    if (cookie) headers.Cookie = cookie;

    const r = http.request(BASE + urlPath, { method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && !opts.keepJar) {
          const sid = sc.map((c) => c.split(';')[0]).find((c) => c.startsWith('seosuite.sid='));
          if (sid) jar.cookie = sid;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: out, setCookie: sc || [] });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
  const mark = pass ? '  ok    ' : '  FAIL  ';
  console.log(mark + name + (detail ? ` — ${detail}` : ''));
}
function csrfToken(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}
function section(title) { console.log(`\n${title}`); }

(async () => {
  require('../src/app');
  // The boot sequence reconciles interrupted runs and probes for Python.
  await new Promise((r) => setTimeout(r, 2500));

  const db = require('../src/db');
  const owner = mkJar();

  // ------------------------------------------------------- response headers
  section('Response headers');
  const login = await req(owner, 'GET', '/login');
  const h = login.headers;
  const csp = h['content-security-policy'] || '';
  check('Content-Security-Policy is sent', Boolean(csp), csp ? 'present' : 'MISSING');
  check("CSP: frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
  check("CSP: form-action 'self'", csp.includes("form-action 'self'"));
  check("CSP: base-uri 'self'", csp.includes("base-uri 'self'"));
  check("CSP: object-src 'none'", csp.includes("object-src 'none'"));
  check('X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff');
  check('X-Frame-Options: DENY', h['x-frame-options'] === 'DENY');
  check('Referrer-Policy is sent', Boolean(h['referrer-policy']), h['referrer-policy']);
  check('Permissions-Policy is sent', Boolean(h['permissions-policy']));
  check('HSTS withheld on plain HTTP', !h['strict-transport-security'],
    'sent only when TRUST_PROXY=1 or NODE_ENV=production');

  // -------------------------------------------------------- the asset budget
  section('Asset budget');
  check('no chart library in the shared <head>',
    !/apexcharts|jsvectormap/i.test(login.body),
    'a chart library here costs every one of the ~60 pages');
  check('no country-code table in the shared <head>', !/country-codes/i.test(login.body));
  check('the on-demand loader is referenced instead', /\/js\/chart-assets\.js\?v=\d+/.test(login.body));
  const loader = await req(owner, 'GET', '/js/chart-assets.js');
  check('the loader is served', loader.status === 200 && /ChartAssets/.test(loader.body), `HTTP ${loader.status}`);
  const sriCount = (loader.body.match(/sha384-/g) || []).length;
  check('the loader pins an SRI hash per CDN file', sriCount >= 4, `${sriCount} hashes`);
  const css = await req(owner, 'GET', '/css/style.css?v=1');
  check('versioned assets are immutably cached', /immutable/.test(css.headers['cache-control'] || ''),
    css.headers['cache-control']);
  const legal = await req(owner, 'GET', '/privacy.html');
  check('unversioned pages are not year-cached', !/immutable/.test(legal.headers['cache-control'] || ''),
    legal.headers['cache-control']);

  // ------------------------------------------------------------------- CSRF
  section('CSRF');
  check('the login form carries a token', Boolean(csrfToken(login.body)));
  const noTok = await req(owner, 'POST', '/login', { body: { email: 'a@b.c', password: 'x' } });
  check('a POST with no token is refused', noTok.status === 403, `HTTP ${noTok.status}`);
  const badTok = await req(owner, 'POST', '/login', { body: { email: 'a@b.c', password: 'x', _csrf: 'not-the-token' } });
  check('a POST with a wrong token is refused', badTok.status === 403, `HTTP ${badTok.status}`);

  // -------------------------------------------------------- session handling
  section('Session handling');
  const signupPage = await req(owner, 'GET', '/signup');
  const preLoginCookie = owner.cookie;
  const created = await req(owner, 'POST', '/signup', {
    body: {
      email: 'verify-owner@test.local', password: 'a-long-enough-password',
      name: 'Verify Owner', _csrf: csrfToken(signupPage.body),
    },
  });
  check('sign-up completes', created.status === 302 && created.headers.location === '/dashboard',
    `${created.status} ${created.headers.location || ''}`);
  check('sign-up issues a NEW session id', owner.cookie !== preLoginCookie, 'no session fixation');
  const stale = await req(owner, 'GET', '/dashboard', { cookie: preLoginCookie, keepJar: true });
  check('the pre-login session id is not signed in',
    stale.status === 302 && /\/login/.test(stale.headers.location || ''),
    `${stale.status} ${stale.headers.location || ''}`);

  const dash = await req(owner, 'GET', '/dashboard');
  check('the owner reaches the dashboard', dash.status === 200, `HTTP ${dash.status}`);
  await req(owner, 'POST', '/logout', { body: { _csrf: csrfToken(dash.body) } });
  const login2 = await req(owner, 'GET', '/login');
  const back = await req(owner, 'POST', '/login', {
    body: {
      email: 'verify-owner@test.local', password: 'a-long-enough-password',
      _csrf: csrfToken(login2.body),
    },
  });
  const loc = back.headers.location || '';
  check('login redirects to a local path only',
    back.status === 302 && loc.startsWith('/') && !loc.startsWith('//'),
    `${back.status} -> ${loc}`);

  // --------------------------------------------------------- login throttle
  section('Login throttle');
  let blockedAfter = 0;
  for (let i = 0; i < 45; i += 1) {
    const page = await req(owner, 'GET', '/login', { cookie: '', keepJar: true });
    const sid = (page.setCookie || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('seosuite.sid='));
    const attempt = await req(owner, 'POST', '/login', {
      body: { email: `spray${i}@test.local`, password: 'Password1!', _csrf: csrfToken(page.body) },
      cookie: sid, keepJar: true,
    });
    if (attempt.status === 429) { blockedAfter = i + 1; break; }
  }
  check('one password sprayed across many addresses is throttled', blockedAfter > 0,
    blockedAfter ? `blocked after ${blockedAfter} addresses` : '45 addresses tried unthrottled');

  // ------------------------------------------------------ team data scoping
  section('Team data scoping');
  const brandsPage = await req(owner, 'GET', '/brands');
  await req(owner, 'POST', '/brands/create', {
    body: {
      name: 'Verify Brand', site_url: 'https://verify-brand.example',
      _csrf: csrfToken(brandsPage.body),
    },
  });
  const ownerRow = db.prepare('SELECT * FROM users WHERE email=?').get('verify-owner@test.local');
  const team = db.prepare('SELECT * FROM teams WHERE owner_user_id=?').get(ownerRow.id);
  const brand = db.prepare('SELECT * FROM brands WHERE user_id=?').get(ownerRow.id);
  check('the brand belongs to the team owner', Boolean(brand), brand ? brand.name : 'NOT CREATED');

  const member = mkJar();
  const memberSignup = await req(member, 'GET', `/signup?invite=${encodeURIComponent(team.invite_code)}`);
  await req(member, 'POST', '/signup', {
    body: {
      email: 'verify-member@test.local', password: 'a-long-enough-password', name: 'Verify Member',
      invite_code: team.invite_code, _csrf: csrfToken(memberSignup.body),
    },
  });
  const pendingBlocked = await req(member, 'GET', '/dashboard');
  check('a pending member cannot reach the workspace',
    pendingBlocked.status === 302 && /pending/.test(pendingBlocked.headers.location || ''),
    `${pendingBlocked.status} ${pendingBlocked.headers.location || ''}`);
  const pendingPage = await req(member, 'GET', '/pending');
  check('the pending page leaks no client data', !/Verify Brand/.test(pendingPage.body));

  const memberRow = db.prepare('SELECT * FROM users WHERE email=?').get('verify-member@test.local');
  const teamPage = await req(owner, 'GET', '/team');
  await req(owner, 'POST', `/team/members/${memberRow.id}/approve`, { body: { _csrf: csrfToken(teamPage.body) } });

  db.prepare("INSERT INTO tasks (user_id, brand_id, title, status, requires_approval) VALUES (?,?,?,'backlog',0)")
    .run(ownerRow.id, brand.id, 'Verify scoping task');

  const memberDash = await req(member, 'GET', '/dashboard');
  const ownerDash = await req(owner, 'GET', '/dashboard');
  function navTaskCount(html) {
    // The badge carries an `urgent` modifier and a title attribute, so match the
    // class as a prefix rather than requiring `class="nav-badge">` exactly.
    const m = html.match(/href="\/tasks"[\s\S]{0,600}?<span class="nav-badge[^"]*"[^>]*>\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }
  check('an approved member reaches the dashboard', memberDash.status === 200, `HTTP ${memberDash.status}`);
  check("the member's sidebar lists the team's brands", /Verify Brand/.test(memberDash.body),
    'the sidebar must resolve through req.dataUserId, not the member id');
  const ownerCount = navTaskCount(ownerDash.body);
  const memberCount = navTaskCount(memberDash.body);
  check("the member's nav counters match the owner's",
    ownerCount !== null && ownerCount === memberCount,
    `owner=${ownerCount} member=${memberCount}`);

  // ----------------------------------------------------------- render sweep
  section('Render sweep');
  const pages = [
    '/', '/dashboard', '/performance', '/brands', `/brands/${brand.id}`, '/brands/import',
    '/connect', '/audit', '/pagespeed', '/linking', '/keywords', '/alerts', '/alerts/history',
    '/tasks', '/reports', '/settings', '/team', '/onboarding', '/workflow',
    '/ai-assist', '/ai-seo', '/healthz',
    '/ai-seo/readiness', '/ai-seo/schema', '/ai-seo/research', '/ai-seo/competitors',
    '/ai-seo/freshness', '/ai-seo/architecture', '/ai-seo/optimizer', '/ai-seo/reputation',
    '/ai-seo/monitoring', '/ai-seo/ai-referrals', '/ai-seo/link-opportunities',
    '/ai-seo/review-platforms', '/ai-seo/site-readiness', '/ai-seo/answer-citations',
    `/ai-seo/answer-citations?brand=${brand.id}`,
    `/performance?brand=${brand.id}`, `/tasks?brand=${brand.id}`, `/keywords?brand=${brand.id}`,
  ];
  const broke = [];
  const untokened = [];
  const eagerCharts = [];
  for (const url of pages) {
    const r = await req(owner, 'GET', url);
    if (r.status >= 500) { broke.push(`${url} -> ${r.status}`); continue; }
    const forms = (r.body.match(/<form[^>]*method="POST"[^>]*>/gi) || []).length;
    const tokens = (r.body.match(/name="_csrf"/g) || []).length;
    if (forms > tokens) untokened.push(`${url} (${forms} forms, ${tokens} tokens)`);
    if (/<script src="https:\/\/cdn\.jsdelivr/.test(r.body)) eagerCharts.push(url);
  }
  check(`all ${pages.length} pages render without a 500`, broke.length === 0, broke.join('; ') || 'clean');
  check('every POST form on every page carries a token', untokened.length === 0,
    untokened.join('; ') || 'all covered');
  check('no page eagerly loads a CDN chart library', eagerCharts.length === 0,
    eagerCharts.join(', ') || 'all on demand');

  // ------------------------------------------------------------------ report
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
  }

  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* leave it for inspection */ }
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('\nverify_security.js could not complete:', err);
  process.exit(2);
});
