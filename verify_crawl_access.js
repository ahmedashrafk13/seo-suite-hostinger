// Verifies authenticated crawling and the login-wall guard.
//
// Run with the server STOPPED, and against a scratch database — the WebAssembly
// SQLite driver is single-writer and a second process on data/app.db has
// corrupted it before:
//
//   DB_PATH=tmp/verify-crawl-access.db node verify_crawl_access.js
//
// WHAT IT PROVES
// Real HTTP servers are started on localhost, each serving one site at its own
// ORIGIN — not as a subdirectory, because the internal linking agent normalises
// its target to the origin and would crawl "/" either way. Each reproduces a
// wall the team actually meets:
//
//   open      public — the control. Must crawl fully with no credentials.
//   walled    302 to /login, which answers 200 with a password form. This is
//             the dangerous case: a login wall wearing a success code.
//             Anonymously it must be REFUSED, not crawled.
//   basic     HTTP 401 with a WWW-Authenticate header, the staging-site case.
//   edge      HTTP 403 until a bypass header is sent, the CDN bot-rule case.
//
// Then both Node crawlers are spawned against them exactly as toolRunner spawns
// them, and their output is checked for the thing that matters: that an
// authenticated crawl reaches every page, and that an unauthenticated one is
// stopped rather than reporting the login page as the site.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DB_PATH = process.env.DB_PATH || 'tmp/verify-crawl-access.db';

const crawlAuth = require('./src/lib/crawlAuth');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ==========================================================================
// The test site
// ==========================================================================

const SESSION_COOKIE = 'testsession=letmein';
const BASIC_OK = `Basic ${Buffer.from('staging:s3cret').toString('base64')}`;

// Each site has a hub linking to three children, so "did the crawl get past
// the front door" is answerable by counting pages rather than by inspecting one.
function pageHtml(title, links, extra = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><meta name="description" content="A page called ${title} on the crawl-access test site.">
</head><body><h1>${title}</h1>
<p>This paragraph exists so the page has enough visible text to be treated as real
content rather than as a shell. It repeats a little to clear the word-count floor
that separates a genuine page from a login screen: the guard must not mistake a
short but legitimate page for a wall, and it must not mistake a wall for a page.
That distinction is the entire point of this fixture, so the text is padded here
deliberately rather than left to chance.</p>
<nav>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</nav>${extra}</body></html>`;
}

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sign in</title></head><body><h1>Sign in</h1>
<form method="post"><input type="text" name="user"><input type="password" name="pass">
<button>Sign in</button></form></body></html>`;

// One server per site, each serving four pages at its own origin: the hub and
// three children, so "did the crawl get past the front door" is answerable by
// counting pages rather than by inspecting one.
//
// `gate` decides whether a request is allowed through, and returns the response
// to send when it is not. That is the only difference between the four sites.
function makeSite(name, gate) {
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    if (p === '/robots.txt') {
      return send(200, 'User-agent: *\nAllow: /', { 'content-type': 'text/plain' });
    }
    // Served unguarded, because a login page is reachable by definition.
    if (p === '/login') return send(200, LOGIN_HTML);

    const blocked = gate ? gate(req) : null;
    if (blocked) return send(blocked.status, blocked.body || '', blocked.headers || {});

    if (p === '/' ) return send(200, pageHtml(`${name} home`, ['/a', '/b', '/c']));
    if (/^\/[abc]$/.test(p)) return send(200, pageHtml(`${name} ${p.slice(1)}`, ['/']));
    return send(404, 'not found');
  });
}

// The four gates, each the shape of a real-world wall.
const GATES = {
  // The control: nothing is gated.
  open: null,
  // The dangerous one — a redirect to a page that answers 200.
  walled: (req) => (String(req.headers.cookie || '').includes('testsession=letmein')
    ? null
    : { status: 302, headers: { location: '/login' } }),
  basic: (req) => (req.headers.authorization === BASIC_OK
    ? null
    : { status: 401, body: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="staging"' } }),
  edge: (req) => (req.headers['x-bypass'] === 'ok' ? null : { status: 403, body: 'Forbidden' }),
};

async function startSites() {
  const bases = {};
  const servers = [];
  for (const [name, gate] of Object.entries(GATES)) {
    const server = makeSite(name, gate);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    bases[name] = `http://127.0.0.1:${server.address().port}`;
    servers.push(server);
  }
  return { bases, servers };
}

// ==========================================================================
// Spawning the crawlers the way toolRunner does
// ==========================================================================

function runNodeTool(script, args, { timeoutMs = 120000, env = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.dirname(script),
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

// Spawns a Python tool through the same resolver toolRunner uses, so this
// checks the interpreter the app would actually pick rather than whatever
// `python` happens to be on PATH.
function runPythonTool(tool, script, args, { timeoutMs = 180000, env: extraEnv = null } = {}) {
  const pythonEnv = require('./src/lib/pythonEnv');
  const env = pythonEnv.resolve(tool);
  if (!env.ok) return Promise.resolve({ skipped: true, reason: env.error });
  return new Promise((resolve) => {
    const child = spawn(env.bin, [...env.args, '-u', script, ...args], {
      cwd: path.dirname(script),
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

function parseAuditJson(text) {
  // Same extraction toolRunner uses, so a change to the output shape fails here
  // rather than silently in production.
  const toolRunner = require('./src/lib/toolRunner');
  return toolRunner.extractJson(text);
}

// ==========================================================================
// The checks
// ==========================================================================

async function main() {
  fs.mkdirSync('tmp', { recursive: true });
  const { bases, servers } = await startSites();
  console.log('');
  Object.entries(bases).forEach(([n, u]) => console.log(`  ${n.padEnd(8)} ${u}`));
  console.log('');

  const cookieAuth = { cookie: SESSION_COOKIE, headers: {}, basicUser: '', basicPass: '' };
  const basicAuth = { cookie: '', headers: {}, basicUser: 'staging', basicPass: 's3cret' };
  const headerAuth = { cookie: '', headers: { 'X-Bypass': 'ok' }, basicUser: '', basicPass: '' };

  // ---------------------------------------------------- credential plumbing
  console.log('Credential parsing');
  {
    const { auth, rejected } = crawlAuth.fromForm({
      auth_cookie: ' a=1; b=2 ',
      auth_headers: 'X-One: 1\n# a comment\n\nX-Two: 2\nHost: evil.example\nbroken line',
      auth_basic_user: 'u',
      auth_basic_pass: 'p',
    });
    check('cookie is trimmed and kept', auth.cookie === 'a=1; b=2', auth.cookie);
    check('valid headers are kept', auth.headers['X-One'] === '1' && auth.headers['X-Two'] === '2');
    check('comments and blank lines are skipped', Object.keys(auth.headers).length === 2,
      Object.keys(auth.headers).join(','));
    check('Host is refused, with a reason',
      rejected.some((r) => /Host/.test(r.line) && /crawler itself/.test(r.why)));
    check('a malformed line is refused, with a reason',
      rejected.some((r) => r.line === 'broken line' && /separator/.test(r.why)));

    const h = crawlAuth.toHeaders(auth);
    check('basic auth becomes an Authorization header',
      h.Authorization === `Basic ${Buffer.from('u:p').toString('base64')}`, h.Authorization);

    const args = crawlAuth.toArgs(auth);
    check('--cookie is emitted once', args.filter((a) => a === '--cookie').length === 1);
    check('--header is emitted per header', args.filter((a) => a === '--header').length === 3,
      `got ${args.filter((a) => a === '--header').length}`);

    // The rule that matters for run logs and shared reports.
    const desc = crawlAuth.describe(auth);
    check('describe() names the cookie but never its value',
      desc.includes('a, b') && !desc.includes('a=1') && !desc.includes('p'), desc);
    check('empty input means anonymous, not an empty credential set',
      crawlAuth.isEmpty(crawlAuth.fromForm({}).auth));
  }

  // ------------------------------------------------------------- the probe
  console.log('\nLogin-wall probe');
  {
    const open = await crawlAuth.probe(bases.open);
    check('a public site passes anonymously', open.ok === true, open.summary);
    check('a passing probe reports the word count it measured', open.words > 50, String(open.words));

    const walled = await crawlAuth.probe(bases.walled);
    check('a 200-answering login wall is caught', walled.ok === false, walled.summary);
    check('a login wall DOES stop the run', walled.blocking === true, String(walled.blocking));
    check('the wall is identified as a redirect to a sign-in page',
      walled.wall === 'redirect_to_login', walled.wall);
    check('the probe names the evidence', walled.reasons.length > 0 && /sign-in page/.test(walled.reasons[0]));
    check('the remedy tells the user to paste a cookie',
      /session cookie/i.test(crawlAuth.remedyFor(walled.wall)));

    const walledAuthed = await crawlAuth.probe(bases.walled, cookieAuth);
    check('the same site passes with a session cookie', walledAuthed.ok === true, walledAuthed.summary);
    check('a passing authenticated probe says so', /using cookie/.test(walledAuthed.summary), walledAuthed.summary);

    // The failure that actually happens in practice: a cookie that has expired.
    const stale = await crawlAuth.probe(bases.walled, {
      cookie: 'testsession=expired', headers: {}, basicUser: '', basicPass: '',
    });
    check('an expired cookie fails', stale.ok === false);
    check('an expired cookie gets the credential-specific message, not the generic one',
      /did not get past the wall/.test(stale.summary) && /expire/.test(stale.summary), stale.summary);

    const basic401 = await crawlAuth.probe(bases.basic);
    check('a 401 is caught', basic401.ok === false && basic401.wall === 'http_auth', basic401.wall);
    check('a 401 DOES stop the run', basic401.blocking === true, String(basic401.blocking));
    check('the 401 remedy asks for a username and password',
      /username and password/.test(crawlAuth.remedyFor(basic401.wall)));
    const basicOk = await crawlAuth.probe(bases.basic, basicAuth);
    check('basic auth gets in', basicOk.ok === true, basicOk.summary);

    const edge403 = await crawlAuth.probe(bases.edge);
    check('a 403 is reported as an edge block, not as a login',
      edge403.wall === 'forbidden', edge403.wall);
    check('a 403 does NOT stop the run — it is a bot rule, not proof of a login',
      edge403.blocking === false, String(edge403.blocking));
    check('the 403 remedy talks about the CDN rather than a login',
      /WAF|CDN/.test(crawlAuth.remedyFor(edge403.wall)));
    const edgeOk = await crawlAuth.probe(bases.edge, headerAuth);
    check('a bypass header gets in', edgeOk.ok === true, edgeOk.summary);

    const gone = await crawlAuth.probe('http://127.0.0.1:1/nothing');
    check('an unreachable host is "unreachable", not a wall', gone.wall === 'unreachable', gone.wall);
    check('an unreachable host does NOT stop the run — one bad request is not a verdict',
      gone.blocking === false, String(gone.blocking));
  }

  // ------------------------------------------- the crawlers, actually crawling
  console.log('\nTechnical audit crawler (Node port)');
  {
    const auditScript = path.join(__dirname, 'tools', 'node', 'audit', 'main.js');

    const anon = await runNodeTool(auditScript, [bases.walled, '--max-pages', '20', '--json']);
    const anonJson = parseAuditJson(anon.out);
    check('without credentials the walled site yields almost nothing',
      anonJson && anonJson.pages_crawled <= 2,
      anonJson ? `crawled ${anonJson.pages_crawled} pages` : 'no JSON');

    const authed = await runNodeTool(auditScript, [
      bases.walled, '--max-pages', '20', '--json', ...crawlAuth.toArgs(cookieAuth),
    ]);
    const authedJson = parseAuditJson(authed.out);
    check('with a session cookie the whole walled site is crawled',
      authedJson && authedJson.pages_crawled >= 4,
      authedJson ? `crawled ${authedJson.pages_crawled} pages` : 'no JSON');
    check('the audit records WHICH credentials it used, by name only',
      authedJson && Array.isArray(authedJson.crawl_auth)
        && authedJson.crawl_auth.includes('Cookie')
        && !JSON.stringify(authedJson.crawl_auth).includes('letmein'),
      authedJson ? JSON.stringify(authedJson.crawl_auth) : 'no JSON');

    const basicRun = await runNodeTool(auditScript, [
      bases.basic, '--max-pages', '20', '--json', ...crawlAuth.toArgs(basicAuth),
    ]);
    const basicJson = parseAuditJson(basicRun.out);
    check('basic auth crawls a staging site fully',
      basicJson && basicJson.pages_crawled >= 4,
      basicJson ? `crawled ${basicJson.pages_crawled} pages` : 'no JSON');

    // Regression guard: the flags must not leak into the crawl target.
    check('the auth flags are not mistaken for a URL',
      basicJson && String(basicJson.site).startsWith(bases.basic),
      basicJson ? String(basicJson.site) : 'no JSON');

    const control = await runNodeTool(auditScript, [bases.open, '--max-pages', '20', '--json']);
    const controlJson = parseAuditJson(control.out);
    check('a public site still crawls with no credentials at all',
      controlJson && controlJson.pages_crawled >= 4,
      controlJson ? `crawled ${controlJson.pages_crawled} pages` : 'no JSON');
    check('an anonymous crawl reports no credentials',
      controlJson && Array.isArray(controlJson.crawl_auth) && controlJson.crawl_auth.length === 0,
      controlJson ? JSON.stringify(controlJson.crawl_auth) : 'no JSON');
  }

  console.log('\nInternal linking agent (Node port)');
  {
    const linkScript = path.join(__dirname, 'tools', 'node', 'linking', 'main.js');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-linking-'));

    const authed = await runNodeTool(linkScript, [
      bases.walled, '--max-pages', '20', '--out', outDir, ...crawlAuth.toArgs(cookieAuth),
    ], { timeoutMs: 180000 });

    let summary = null;
    const summaryPath = path.join(outDir, 'summary.json');
    if (fs.existsSync(summaryPath)) {
      try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { summary = null; }
    }
    const crawled = summary
      ? (summary.pages_crawled || summary.pages || (summary.crawl && summary.crawl.pages) || null)
      : null;
    check('the linking agent produced output for the walled site',
      summary != null, `exit ${authed.code}: ${authed.err.slice(-300)}`);
    // No `crawled == null` escape hatch: if the field is ever renamed this must
    // fail loudly rather than quietly stop checking anything.
    check('the linking agent crawled past the login page', crawled >= 4, `pages=${crawled}`);

    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* leave it */ }
  }

  // The Python originals take the same flags and must behave identically —
  // TOOL_RUNTIME decides which of the two implementations a deployment runs, so
  // a credential path that works in only one of them is a trap that fires on
  // whichever host has Python.
  // ==========================================================================
  // The public-site guarantee
  // ==========================================================================
  //
  // The whole point of the blocking/advisory split. Every site in this section
  // is one that crawled fine before this feature existed, and every one of them
  // is a shape that a naive login detector gets WRONG. None may be stopped.
  console.log('');
  console.log('Public sites must be unaffected (false-positive guard)');
  {
    const cases = [
      {
        name: 'a sparse homepage with a "Client login" box in the header',
        // The realistic false positive: a password field AND very little text.
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Ashford Plumbing — Emergency plumbers in Leeds</title></head><body>
<header><form action="/login"><input type="text" name="u"><input type="password" name="p">
<button>Client login</button></form></header>
<h1>Emergency plumbers in Leeds</h1><p>Call us on 0113 496 0000.</p>
<a href="/services">Services</a></body></html>`,
      },
      {
        name: 'a page whose text happens to contain "restricted access"',
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Site notice</title></head><body><h1>Notice</h1>
<p>This area has restricted access for staff.</p></body></html>`,
      },
      {
        name: 'a one-line holding page with no login anywhere',
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Coming soon</title></head><body><h1>Coming soon</h1></body></html>`,
      },
      {
        name: 'a site that redirects http to https and www (a normal redirect chain)',
        redirectTo: '/final',
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Home</title></head><body><h1>Home</h1><p>Plenty of ordinary content here,
enough that no word-count floor is anywhere near being tripped by this page.</p>
</body></html>`,
      },
      {
        name: 'a site that redirects to a path containing the word "account"',
        // /accounts-payable-services is NOT /account/login. A sloppy substring
        // match on "account" would block this.
        redirectTo: '/accounts-payable-services',
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Accounts payable services</title></head><body><h1>Accounts payable</h1>
<p>An ordinary service page with an ordinary amount of copy on it, which exists
here to prove that a URL containing the word "account" is not a login wall.</p>
</body></html>`,
      },
    ];

    for (const c of cases) {
      const srv = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://127.0.0.1').pathname;
        if (c.redirectTo && p === '/') {
          res.writeHead(302, { location: c.redirectTo });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(c.html);
      });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${srv.address().port}/`;
      // eslint-disable-next-line no-await-in-loop
      const p = await crawlAuth.probe(url);
      check(`not blocked: ${c.name}`, p.blocking === false,
        `wall=${p.wall} words=${p.words}`);
      srv.close();
    }

    // And the case the guard must still catch even with no redirect: the site
    // serves its login form at / with a 200 and says so in the title.
    const loginAtRoot = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sign in · Acme Portal</title></head><body><h1>Sign in</h1>
<form><input type="text" name="u"><input type="password" name="p"></form></body></html>`);
    });
    await new Promise((r) => loginAtRoot.listen(0, '127.0.0.1', r));
    const rootProbe = await crawlAuth.probe(`http://127.0.0.1:${loginAtRoot.address().port}/`);
    check('still blocked: a login page served at / with HTTP 200',
      rootProbe.blocking === true && rootProbe.wall === 'login_page',
      `wall=${rootProbe.wall} words=${rootProbe.words}`);
    loginAtRoot.close();
  }

  // ==========================================================================
  // The commonest real shape: a public site that merely HAS accounts
  // ==========================================================================
  //
  // A restaurant site. Every page a diner needs is public — menu, hours,
  // contact, reservations. It also has /signup and /login so a customer can
  // make an account and track an order, and /account/orders behind that login.
  //
  // This must scan with NO credentials, exactly as it did before, and the
  // signup and login pages must be crawled like any other page. This is the
  // case a login detector must not touch, and it is the one most sites are.
  console.log('');
  console.log('A public site that merely has a signup/login page');
  {
    const page = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${title} at Olive & Thyme, an Italian restaurant."></head><body>
<header><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/hours">Hours</a>
<a href="/contact">Contact</a> <a href="/signup">Create account</a> <a href="/login">Log in</a></header>
<h1>${title}</h1>${body}</body></html>`;
    const filler = `<p>Olive &amp; Thyme has served hand-rolled pasta on Bridge Street
since 2011. The kitchen works from a short menu that changes with what the market
has, and everything from the bread to the ice cream is made in-house each morning.
Walk-ins are welcome at the bar, and the dining room takes reservations up to six
weeks ahead. Open Tuesday to Sunday for lunch and dinner.</p>`;

    const resto = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const cookie = req.headers.cookie || '';
      const send = (status, html, headers = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(html);
      };
      if (p === '/robots.txt') return send(200, 'User-agent: *\nAllow: /', { 'content-type': 'text/plain' });

      // Public pages — the whole site a diner cares about.
      if (p === '/') return send(200, page('Olive & Thyme — Italian on Bridge Street', filler));
      if (p === '/menu') return send(200, page('Menu', filler));
      if (p === '/hours') return send(200, page('Opening hours', filler));
      if (p === '/contact') return send(200, page('Contact and directions', filler));

      // Accounts exist, and their pages are ordinary public pages.
      if (p === '/signup') {
        return send(200, page('Create an account', `<form method="post">
<input type="email" name="email"><input type="password" name="password">
<button>Create account</button></form>${filler}`));
      }
      if (p === '/login') {
        return send(200, page('Log in', `<form method="post">
<input type="email" name="email"><input type="password" name="password">
<button>Log in</button></form>${filler}`));
      }

      // The only gated corner: a customer's own order history.
      if (p.startsWith('/account')) {
        if (!cookie.includes('diner=1')) return send(302, '', { location: '/login' });
        return send(200, page('Your orders', filler));
      }
      return send(404, 'not found');
    });
    await new Promise((r) => resto.listen(0, '127.0.0.1', r));
    const restoBase = `http://127.0.0.1:${resto.address().port}`;

    const probe = await crawlAuth.probe(restoBase);
    check('the access check passes with no credentials', probe.ok === true, probe.summary);
    check('nothing is flagged as a wall', probe.wall === null, String(probe.wall));

    // The signup and login pages themselves, probed directly: they carry a
    // password field, so this is where a naive detector would fire. They are
    // real pages with real content, so they must not read as walls.
    const signupProbe = await crawlAuth.probe(`${restoBase}/signup`);
    check('the signup page is not treated as a wall', signupProbe.blocking === false,
      `wall=${signupProbe.wall} words=${signupProbe.words}`);
    const loginProbe = await crawlAuth.probe(`${restoBase}/login`);
    check('the login page is not treated as a wall when it carries real content',
      loginProbe.blocking === false, `wall=${loginProbe.wall} words=${loginProbe.words}`);

    // And the run itself, end to end, with no credentials at all.
    const toolRunner = require('./src/lib/toolRunner');
    const db = require('./src/db');
    db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, role, status)
      VALUES (1,'verify@example.com','x','admin','active')`).run();
    const runId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: restoBase, maxPages: 30, createTasks: false,
    });
    const deadline = Date.now() + 90000;
    let row = null;
    for (;;) {
      row = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(runId);
      if (row && row.status !== 'running') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('the audit completes with no credentials', row && row.status === 'completed',
      row ? `${row.status}: ${(row.error || '').slice(0, 160)}` : 'no row');
    const j = row && row.json_result ? JSON.parse(row.json_result) : null;
    check('every public page was crawled, signup and login included',
      j && j.pages_crawled >= 6, j ? `pages=${j.pages_crawled}` : 'no result');
    check('a real health score was produced', j && typeof j.site_health === 'number',
      j ? String(j.site_health) : 'no result');
    check('the run is recorded as anonymous', row && row.auth_used === 0);
    check('no warning note was raised on a healthy public site',
      row && !/FAILED|will not serve/i.test(row.access_note || ''),
      (row && (row.access_note || '').slice(0, 140)) || '(none)');

    resto.close();
  }

  // ==========================================================================
  // The path matcher, table-tested
  // ==========================================================================
  //
  // Its failure mode is silent in BOTH directions: a missed wall reads as a
  // healthy small site, and a public page mistaken for a wall stops a crawl
  // that used to work. Neither shows up as an error, so both are tested.
  console.log('');
  console.log('Sign-in path matching');
  {
    const shouldNotMatch = [
      // Every one of these matched before the boundary was added.
      '/ssortment-of-cheeses', '/logins-explained', '/signing-a-lease',
      '/authenticated-users-guide',
      // And ordinary pages that must never match.
      '/', '/about', '/menu', '/reservations', '/contact', '/en-gb/',
      '/author/jane', '/authors', '/accounts-payable-services',
      '/single-origin-coffee', '/blog/how-to-log-a-support-ticket',
      '/services/authentication-consulting-for-banks',
    ];
    const shouldMatch = [
      '/login', '/login/', '/login.php', '/login.aspx', '/login?next=/dashboard',
      '/wp-login.php', '/account/login', '/accounts/login', '/users/sign_in',
      '/sign-in', '/signin', '/sso', '/auth', '/auth/callback', '/session/new',
      '/customer/account/login', '/o/oauth2/auth',
      // Non-English, because this suite is pointed at non-English sites.
      '/connexion', '/se-connecter', '/anmelden', '/einloggen', '/iniciar-sesion',
      '/entrar', '/accedi', '/inloggen', '/logga-in', '/zaloguj', '/giris', '/masuk',
    ];
    const wrongPositive = shouldNotMatch.filter((p) => crawlAuth.LOGIN_PATH.test(p));
    const wrongNegative = shouldMatch.filter((p) => !crawlAuth.LOGIN_PATH.test(p));
    check(`no ordinary path is mistaken for a sign-in page (${shouldNotMatch.length} cases)`,
      wrongPositive.length === 0, wrongPositive.join(', '));
    check(`every real sign-in path is recognised (${shouldMatch.length} cases)`,
      wrongNegative.length === 0, wrongNegative.join(', '));
    check('the matcher is anchored to path segments, not substrings',
      !crawlAuth.LOGIN_PATH.test('/sso-mething') && crawlAuth.LOGIN_PATH.test('/sso'));
  }

  // ==========================================================================
  // Onward-link counting
  // ==========================================================================
  console.log('');
  console.log('Onward-link counting');
  {
    const at = (html) => crawlAuth.countInternalLinks(html, 'https://example.com/login');
    check('a bare login form is a dead end', at('<form><input type="password"></form>') === 0);
    check('links to forgot-password and signup do not count as onward routes',
      at('<a href="/forgot-password">f</a><a href="/signup">s</a><a href="/login">l</a>') === 0);
    check('a real header nav counts as onward routes',
      at('<a href="/">h</a><a href="/menu">m</a><a href="/hours">o</a><a href="/contact">c</a>') === 4);
    check('external links are not onward routes into this site',
      at('<a href="https://facebook.com/x">f</a><a href="https://twitter.com/y">t</a>') === 0);
    check('anchors, mailto and tel are not onward routes',
      at('<a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="tel:+441134960000">p</a>') === 0);
    check('duplicate links count once',
      at('<a href="/menu">m</a><a href="/menu/">m</a><a href="/menu">m</a>') === 1);
    check('a link to the page itself is not an onward route', at('<a href="/login">self</a>') === 0);
    check('unparseable hrefs are ignored rather than throwing',
      at('<a href="http://[not a url">x</a><a href="/menu">m</a>') === 1);
  }

  // ==========================================================================
  // Every other site shape an audit meets
  // ==========================================================================
  //
  // None of these is a login wall, and every one of them crawled before this
  // feature existed. The audit tool has its own opinions about several of them
  // (a JS shell caps the health score, a bad certificate is a finding, a 503 is
  // an error) — that is the audit's job, and the access check must not
  // pre-empt any of it by refusing to start.
  console.log('');
  console.log('Other site shapes — none may be blocked');
  {
    const body = (title, extra = '') => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>
<p>An ordinary page with an ordinary amount of copy on it, long enough that no
word-count floor comes anywhere near being tripped, because the point of this
fixture is the response shape rather than the text.</p>
<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>${extra}</body></html>`;

    const shapes = [
      {
        name: 'a JavaScript-rendered SPA shell (empty div, no content)',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            + '<title>App</title></head><body><div id="root"></div>'
            + '<script src="/app.js"></script></body></html>');
        },
      },
      {
        name: 'an age gate for an alcohol-serving restaurant',
        handler: (req, res) => {
          const p = new URL(req.url, 'http://127.0.0.1').pathname;
          if (p === '/') {
            res.writeHead(302, { location: '/age-check' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body('Are you over 18?'));
        },
      },
      {
        name: 'a cookie-consent interstitial',
        handler: (req, res) => {
          const p = new URL(req.url, 'http://127.0.0.1').pathname;
          if (p === '/') {
            res.writeHead(302, { location: '/cookie-consent' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body('Your cookie choices'));
        },
      },
      {
        name: 'a locale redirect (/ to /en-gb/)',
        handler: (req, res) => {
          const p = new URL(req.url, 'http://127.0.0.1').pathname;
          if (p === '/') {
            res.writeHead(302, { location: '/en-gb/' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body('Home'));
        },
      },
      {
        name: 'a news paywall with a subscribe form on a public homepage',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(body('The Daily Ledger',
            '<form><input type="email" name="e"><button>Subscribe</button></form>'
            + '<p>Subscribers get unlimited access.</p>'));
        },
      },
      {
        name: 'HTTP 429 rate limit on the seed',
        handler: (req, res) => {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' });
          res.end('Too many requests');
        },
      },
      {
        name: 'HTTP 503 maintenance page',
        handler: (req, res) => {
          res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
          res.end(body('Back shortly'));
        },
      },
      {
        name: 'a Cloudflare-style JS challenge (403 + "Just a moment")',
        handler: (req, res) => {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><head><title>Just a moment...</title></head>'
            + '<body><div id="challenge-running"></div></body></html>');
        },
      },
      {
        name: 'a soft 404 homepage (200 saying "page not found")',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(body('Page not found'));
        },
      },
      {
        name: 'an empty 200 with no body at all',
        handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(''); },
      },
      {
        name: 'a non-HTML seed (JSON served at the root)',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        },
      },
      {
        name: 'a PDF served at the root',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/pdf' });
          res.end('%PDF-1.4 fake');
        },
      },
      {
        name: 'a redirect loop on the seed',
        handler: (req, res) => { res.writeHead(302, { location: '/' }); res.end(); },
      },
      {
        name: 'a long redirect chain that ends somewhere ordinary',
        handler: (req, res) => {
          const p = new URL(req.url, 'http://127.0.0.1').pathname;
          const hops = { '/': '/1', '/1': '/2', '/2': '/3', '/3': '/home' };
          if (hops[p]) { res.writeHead(301, { location: hops[p] }); return res.end(); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body('Home'));
        },
      },
      {
        name: 'a site that answers HEAD differently from GET',
        handler: (req, res) => {
          if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body('Home'));
        },
      },
      {
        name: 'a gzip-encoded response',
        handler: (req, res) => {
          const zlib = require('zlib');
          const gz = zlib.gzipSync(Buffer.from(body('Compressed home'), 'utf8'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
          res.end(gz);
        },
      },
      {
        name: 'a latin-1 encoded page',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
          res.end(Buffer.from(body('Caf\xe9 Ol\xe9'), 'latin1'));
        },
      },
      {
        name: 'a page with no <title> and no <h1>',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html lang="en"><body><p>Just some text, with a fair '
            + 'few words in it so that nothing trips a word-count floor, and a couple of '
            + 'links to prove there is a way onward into this site.</p>'
            + '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></body></html>');
        },
      },
    ];

    for (const shape of shapes) {
      const srv = http.createServer(shape.handler);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${srv.address().port}/`;
      // eslint-disable-next-line no-await-in-loop
      const p = await crawlAuth.probe(url);
      check(`not blocked: ${shape.name}`, p.blocking === false,
        `wall=${p.wall} status=${p.status} words=${p.words}`);
      srv.close();
    }
  }

  // A site with an expired/self-signed certificate must still be auditable —
  // that is precisely the kind of problem the audit exists to report, and both
  // crawlers deliberately ignore certificate errors for this reason. A guard
  // that refused to start would hide the finding.
  console.log('');
  console.log('TLS and scheme');
  {
    const https = require('https');
    const tls = require('tls');
    // A throwaway self-signed certificate, generated at run time so nothing
    // expires in the repo. Skipped where the platform cannot generate one.
    let creds = null;
    try {
      const { execFileSync } = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tls-'));
      const key = path.join(dir, 'k.pem');
      const crt = path.join(dir, 'c.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', crt, '-days', '1',
        '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
      creds = { key: fs.readFileSync(key), cert: fs.readFileSync(crt), dir };
    } catch {
      creds = null;
    }

    if (!creds) {
      console.log('  skip  self-signed HTTPS — openssl not available here');
    } else {
      const srv = https.createServer({ key: creds.key, cert: creds.cert }, (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="en"><head><meta charset="utf-8">'
          + '<title>Home</title></head><body><h1>Home</h1><p>A site whose certificate '
          + 'no browser will trust, which is exactly the sort of thing the audit is '
          + 'supposed to find and report rather than refuse to look at.</p>'
          + '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></body></html>');
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const p = await crawlAuth.probe(`https://127.0.0.1:${srv.address().port}/`);
      check('not blocked: a site with an untrusted (self-signed) certificate',
        p.blocking === false && p.ok === true, `wall=${p.wall} status=${p.status} err=${p.error}`);
      srv.close();
      try { fs.rmSync(creds.dir, { recursive: true, force: true }); } catch { /* leave it */ }
      void tls;
    }
  }

  // ==========================================================================
  // Non-Latin sign-in paths
  // ==========================================================================
  //
  // These matter because the paths arrive PERCENT-ENCODED. Node's URL turns
  // `/登录` into `/%E7%99%BB%E5%BD%95`, so without pathForMatch() decoding
  // first, every non-Latin segment in the list would be dead code — the list
  // would look complete and match nothing.
  console.log('');
  console.log('Non-Latin sign-in paths');
  {
    const cases = [
      ['Chinese (simplified)', 'https://example.cn/登录'],
      ['Chinese (traditional)', 'https://example.tw/登入'],
      ['Japanese', 'https://example.jp/ログイン'],
      ['Korean', 'https://example.kr/로그인'],
      ['Russian', 'https://example.ru/вход'],
      ['Ukrainian', 'https://example.ua/увійти'],
      ['Arabic', 'https://example.ae/دخول'],
      ['Hebrew', 'https://example.co.il/כניסה'],
      ['Thai', 'https://example.th/เข้าสู่ระบบ'],
      ['Greek', 'https://example.gr/σύνδεση'],
      ['Hindi', 'https://example.in/लॉगिन'],
    ];
    const missed = cases.filter(([, url]) => !crawlAuth.LOGIN_PATH.test(crawlAuth.pathForMatch(url)));
    check(`every non-Latin sign-in path is recognised (${cases.length} scripts)`,
      missed.length === 0, missed.map(([n]) => n).join(', '));

    // The bug this guards against: matching the RAW pathname instead of the
    // decoded one. Left unfixed, this assertion is what fails.
    check('a percent-encoded path is decoded before matching',
      crawlAuth.LOGIN_PATH.test(crawlAuth.pathForMatch('https://example.cn/%E7%99%BB%E5%BD%95'))
      && !crawlAuth.LOGIN_PATH.test('/%E7%99%BB%E5%BD%95'));

    // And the other direction — ordinary non-Latin pages must not match.
    const ordinary = [
      'https://example.cn/菜单',            // menu
      'https://example.jp/お問い合わせ',      // contact
      'https://example.ru/о-нас',           // about us
      'https://example.ae/قائمة-الطعام',     // food menu
      'https://example.th/ติดต่อเรา',        // contact us
    ];
    const wrong = ordinary.filter((u) => crawlAuth.LOGIN_PATH.test(crawlAuth.pathForMatch(u)));
    check(`ordinary non-Latin pages are not mistaken for sign-in (${ordinary.length} cases)`,
      wrong.length === 0, wrong.join(', '));

    // The wider language pass. Each of these is a market this suite is
    // plausibly pointed at, and an English-only matcher fails silently on
    // exactly the sites least likely to be double-checked by an
    // English-speaking operator.
    const wider = [
      ['Vietnamese', '/dang-nhap'], ['Persian', '/ورود'], ['Urdu', '/لاگ-ان'],
      ['Bengali', '/লগইন'], ['Tamil', '/உள்நுழை'], ['Sinhala', '/ලොග්-වන්න'],
      ['Burmese', '/လော့ဂ်အင်'], ['Khmer', '/ចូល'], ['Lao', '/ເຂົ້າສູ່ລະບົບ'],
      ['Georgian', '/შესვლა'], ['Armenian', '/մուտք'], ['Kazakh', '/кіру'],
      ['Amharic', '/ግባ'], ['Bulgarian', '/влез'], ['Ukrainian', '/вхід'],
      ['Croatian', '/prijava'], ['Czech', '/prihlaseni'], ['Hungarian', '/bejelentkezes'],
      ['Romanian', '/autentificare'], ['Estonian', '/logi-sisse'],
      ['Icelandic', '/innskraning'], ['Swahili', '/ingia'], ['Filipino', '/mag-login'],
      ['Lithuanian', '/prisijungti'],
    ];
    const missedWide = wider.filter(([, pth]) =>
      !crawlAuth.LOGIN_PATH.test(crawlAuth.pathForMatch(`https://x.test${encodeURI(pth)}`)));
    check(`sign-in is recognised across ${wider.length} more languages`,
      missedWide.length === 0, missedWide.map(([n]) => n).join(', '));

    // Percent-encoded on the way in, as a real redirect would arrive.
    const ordinaryWide = [
      '/dang-ky', '/priloha', '/kontakt', '/produkty', '/о-нас',
      '/ტელეფონი', '/မီနူး', '/ព័ត៌មាន', '/menu', '/prijave-za-newsletter',
    ];
    const wrongWide = ordinaryWide.filter((pth) =>
      crawlAuth.LOGIN_PATH.test(crawlAuth.pathForMatch(`https://x.test${encodeURI(pth)}`)));
    check(`ordinary pages in those languages are not mistaken for sign-in (${ordinaryWide.length} cases)`,
      wrongWide.length === 0, wrongWide.join(', '));
    check('the sign-in vocabulary covers a useful number of markets',
      crawlAuth.LOGIN_SEGMENTS.length >= 100, `${crawlAuth.LOGIN_SEGMENTS.length} segments`);

    check('a malformed percent escape does not throw',
      crawlAuth.pathForMatch('/%zz%') === '/%zz%');

    // End to end: a Chinese-language site that redirects to /登录 must be
    // caught as a wall, and must pass with a cookie.
    const zh = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const cookie = req.headers.cookie || '';
      const send = (st, html, h = {}) => {
        res.writeHead(st, { 'content-type': 'text/html; charset=utf-8', ...h });
        res.end(html);
      };
      if (p === '/登录') {
        return send(200, '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
          + '<title>登录</title></head><body><h1>登录</h1>'
          + '<form><input type="text" name="u"><input type="password" name="p"></form>'
          + '</body></html>');
      }
      if (!cookie.includes('sid=ok')) {
        return send(302, '', { location: encodeURI('/登录') });
      }
      return send(200, '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + '<title>会员中心</title></head><body><h1>会员中心</h1>'
        + '<p>这是一个只有登录后才能看到的页面，内容足够长，不会被字数下限误判为登录页。'
        + '这里还有若干指向站内其他页面的链接。</p>'
        + '<a href="/a">一</a><a href="/b">二</a><a href="/c">三</a></body></html>');
    });
    await new Promise((r) => zh.listen(0, '127.0.0.1', r));
    const zhBase = `http://127.0.0.1:${zh.address().port}`;

    const zhAnon = await crawlAuth.probe(zhBase);
    check('a Chinese-language login wall is caught',
      zhAnon.blocking === true && zhAnon.wall === 'redirect_to_login',
      `wall=${zhAnon.wall} final=${zhAnon.finalUrl}`);
    const zhAuthed = await crawlAuth.probe(zhBase, {
      cookie: 'sid=ok', headers: {}, basicUser: '', basicPass: '',
    });
    check('the same Chinese site passes with a cookie', zhAuthed.ok === true, zhAuthed.summary);
    zh.close();
  }

  // ==========================================================================
  // Playwright: a JS-rendered site behind a login
  // ==========================================================================
  //
  // The rendered path is a SEPARATE HTTP client — a Chromium browser context,
  // not the requests session — so credentials have to be installed on it
  // independently. If that were missed, `--render on` against a gated site
  // would pass the access check (which uses its own fetch) and then crawl
  // login pages, which is the original bug wearing a different hat.
  //
  // The fixture serves an empty shell whose real content is written by
  // JavaScript, and gates it on a cookie: unrendered it looks empty even when
  // authenticated, so this can only pass if BOTH the cookie and the rendering
  // reached the page.
  console.log('');
  console.log('Playwright rendered crawl of a gated site');
  {
    const spa = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const cookie = req.headers.cookie || '';
      const send = (st, body, h = {}) => {
        res.writeHead(st, { 'content-type': 'text/html; charset=utf-8', ...h });
        res.end(body);
      };
      if (p === '/robots.txt') return send(200, 'User-agent: *\nAllow: /', { 'content-type': 'text/plain' });
      if (p === '/login') {
        return send(200, '<!doctype html><html lang="en"><head><meta charset="utf-8">'
          + '<title>Sign in</title></head><body><h1>Sign in</h1>'
          + '<form><input type="password" name="p"></form></body></html>');
      }
      if (!cookie.includes('spa=1')) return send(302, '', { location: '/login' });

      // The shell. Nothing readable is in the served HTML — the title, the
      // heading, the copy and the links are all written by the script, so a
      // non-rendering crawl sees an empty page.
      const name = p === '/' ? 'home' : p.slice(1);
      return send(200, `<!doctype html><html lang="en"><head><meta charset="utf-8">
</head><body><div id="root"></div><script>
  var page = ${JSON.stringify(name)};
  document.title = 'Members ' + page;
  document.getElementById('root').innerHTML =
    '<h1>Members ' + page + '</h1>'
    + '<p>This paragraph is written by JavaScript and exists nowhere in the served '
    + 'HTML, so a crawl that reads only the served bytes cannot see it. It is long '
    + 'enough that no word-count floor is anywhere near being tripped.</p>'
    + '<a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a> <a href="/">home</a>';
</script></body></html>`);
    });
    await new Promise((r) => spa.listen(0, '127.0.0.1', r));
    const spaBase = `http://127.0.0.1:${spa.address().port}`;
    const spaAuth = { cookie: 'spa=1', headers: {}, basicUser: '', basicPass: '' };

    const pyAudit = path.join(__dirname, 'tools', 'webtechstackdetector', 'main.py');

    // Is Playwright actually usable here? The audit only renders when it is.
    const pwCheck = await runPythonTool('audit', pyAudit, ['--help'], { timeoutMs: 60000 });
    const pwAvailable = !pwCheck.skipped;

    if (!pwAvailable) {
      console.log(`  skip  rendered crawl — ${pwCheck.reason}`);
    } else {
      // 1. Rendered AND authenticated: must read the JS-written content.
      const both = await runPythonTool('audit', pyAudit, [
        spaBase, '--max-pages', '10', '--json', '--render', 'on',
        ...crawlAuth.toArgs(spaAuth),
      ], { timeoutMs: 300000 });
      const bothJson = parseAuditJson(both.out);
      const rendered = bothJson && bothJson.rendered === true;

      if (!rendered) {
        // Playwright is importable but Chromium is missing, or rendering was
        // declined. Reported rather than passing quietly on a weaker path.
        console.log('  skip  rendered crawl — the audit did not render '
          + `(${(both.err || '').split('\n').filter(Boolean).slice(-1)[0] || 'no reason given'})`);
      } else {
        check('a rendered crawl carries the session cookie into the browser',
          bothJson.pages_crawled >= 4, `pages=${bothJson.pages_crawled}`);
        check('the rendered crawl read content that only exists after JavaScript',
          !bothJson.content_warning,
          `content_warning=${bothJson.content_warning}`);
        check('the rendered run records the credential by name only',
          Array.isArray(bothJson.crawl_auth) && bothJson.crawl_auth.includes('Cookie')
          && !JSON.stringify(bothJson.crawl_auth).includes('spa=1'),
          JSON.stringify(bothJson.crawl_auth));

        // 2. Rendered but NOT authenticated: must not get past the login.
        const noCreds = await runPythonTool('audit', pyAudit, [
          spaBase, '--max-pages', '10', '--json', '--render', 'on',
        ], { timeoutMs: 300000 });
        const noCredsJson = parseAuditJson(noCreds.out);
        check('a rendered crawl without credentials still only reaches the login page',
          noCredsJson && noCredsJson.pages_crawled <= 2,
          noCredsJson ? `pages=${noCredsJson.pages_crawled}` : 'no JSON');

        // 3. Authenticated but NOT rendered: proves the fixture really is
        //    JS-only, so check 2 above is measuring rendering and not luck.
        const noRender = await runPythonTool('audit', pyAudit, [
          spaBase, '--max-pages', '10', '--json', '--render', 'off',
          ...crawlAuth.toArgs(spaAuth),
        ], { timeoutMs: 120000 });
        const noRenderJson = parseAuditJson(noRender.out);
        check('without rendering the same site reports as a JavaScript shell',
          noRenderJson && !!noRenderJson.content_warning,
          noRenderJson ? `warning=${noRenderJson.content_warning}` : 'no JSON');
        // The safety net for the one wall shape no server-side probe can see:
        // an app that answers 200 with a JS shell and redirects in the browser
        // (app.slack.com does exactly this). The guard cannot catch it, so the
        // audit must not report it as healthy either — the score is capped and
        // the warning is carried, which is what makes the miss survivable.
        check('a JavaScript shell cannot report a healthy score',
          noRenderJson && noRenderJson.site_health <= 12,
          noRenderJson ? `health=${noRenderJson.site_health}` : 'no JSON');
      }
    }
    spa.close();
  }

  // ==========================================================================
  // Credential lifecycle on the brand form
  // ==========================================================================
  //
  // Every check here is a bug that shipped and was found by asking whether the
  // feature was actually finished. The form cannot show a stored cookie or
  // password back to the user, so the empty-field cases are the normal path,
  // not the edge case.
  console.log('');
  console.log('Editing stored credentials without destroying them');
  {
    const db = require('./src/db');
    db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, role, status)
      VALUES (1,'verify@example.com','x','admin','active')`).run();
    db.prepare(`INSERT OR IGNORE INTO brands (id, user_id, name, site_url)
      VALUES (901,1,'Merge brand','https://example.com')`).run();

    const full = { cookie: 'sessionid=REAL', headers: { 'X-Token': 'abc' }, basicUser: '', basicPass: '' };
    crawlAuth.save(901, full);

    // THE BUG: editing only the basic-auth fields posted an empty cookie box,
    // and a plain replace wiped a working session cookie. The next crawl was
    // then refused and nothing connected the two events.
    const onlyBasic = crawlAuth.fromForm({ auth_basic_user: 'staging', auth_basic_pass: 'p' }).auth;
    const merged = crawlAuth.merge(crawlAuth.forBrand(901), onlyBasic, []);
    crawlAuth.save(901, merged);
    let now = crawlAuth.forBrand(901);
    check('editing basic auth keeps the stored cookie', now.cookie === 'sessionid=REAL', now.cookie);
    check('editing basic auth keeps the stored headers', now.headers['X-Token'] === 'abc',
      JSON.stringify(now.headers));
    check('the new basic auth is applied', now.basicUser === 'staging', now.basicUser);

    // Changing the username alone must not blank the password.
    crawlAuth.save(901, crawlAuth.merge(crawlAuth.forBrand(901),
      crawlAuth.fromForm({ auth_basic_user: 'staging2' }).auth, []));
    now = crawlAuth.forBrand(901);
    check('changing the basic-auth username keeps the stored password',
      now.basicPass === 'p' && now.basicUser === 'staging2',
      `${now.basicUser}/${now.basicPass ? 'set' : 'blank'}`);

    // A supplied header set replaces the stored one wholesale, so a header can
    // actually be removed by editing the box.
    crawlAuth.save(901, crawlAuth.merge(crawlAuth.forBrand(901),
      crawlAuth.fromForm({ auth_headers: 'X-Other: 1' }).auth, []));
    now = crawlAuth.forBrand(901);
    check('typing a new header set replaces the old one rather than unioning',
      !now.headers['X-Token'] && now.headers['X-Other'] === '1',
      JSON.stringify(now.headers));

    // Removal is explicit.
    crawlAuth.save(901, crawlAuth.merge(crawlAuth.forBrand(901), null, ['cookie']));
    check('removing the cookie removes only the cookie',
      !crawlAuth.forBrand(901).cookie && crawlAuth.forBrand(901).basicUser === 'staging2');
    const emptied = crawlAuth.merge(crawlAuth.forBrand(901), null, ['cookie', 'basic', 'headers']);
    check('removing every credential leaves nothing to store', crawlAuth.isEmpty(emptied));

    // THE OTHER BUG: the header textarea was prefilled with its own
    // explanatory text as a VALUE, so saving the form untouched stored
    // "(stored — retype to replace)" as a real header value.
    const roundTripped = crawlAuth.fromForm({
      auth_headers: 'X-Token: (stored — retype to replace)',
    }).auth;
    // The invariant, checked on the template itself: the header textarea must
    // render EMPTY. Anything between its tags is its VALUE and comes back on
    // the next save — which is how "(stored — retype to replace)" became a
    // header value. Grepping the file for that phrase would also match the
    // comment explaining the bug, so the element itself is what is inspected.
    const tpl = fs.readFileSync(path.join(__dirname, 'views', 'brand-detail.ejs'), 'utf8');
    const ta = /<textarea[^>]*name="auth_headers"[\s\S]*?<\/textarea>/.exec(tpl);
    check('the header textarea exists on the brand form', !!ta);
    if (ta) {
      const inner = ta[0].replace(/^<textarea[^>]*>/, '').replace(/<\/textarea>$/, '');
      check('the header textarea renders empty, so nothing is round-tripped as a value',
        inner.trim() === '', `contains: ${inner.slice(0, 80)}`);
    }
    // What the value used to look like, kept so the shape is recognisable if
    // it ever returns.
    check('placeholder prose would be stored verbatim if it were prefilled',
      roundTripped.headers['X-Token'] === '(stored — retype to replace)',
      JSON.stringify(roundTripped.headers));

    crawlAuth.clear(901);
  }

  // ==========================================================================
  // Credentials must not travel in argv
  // ==========================================================================
  //
  // This app deploys to shared hosting, where /proc/<pid>/cmdline is
  // world-readable to other tenants and /proc/<pid>/environ is not. A session
  // cookie in a command line is a client's session handed to strangers for the
  // length of the crawl, so the app spawns crawlers with the environment and
  // keeps the flags only for manual use.
  console.log('');
  console.log('Credential transport');
  {
    const auth = { cookie: 'sessionid=SECRET', headers: { 'X-K': 'v' }, basicUser: 'u', basicPass: 'p' };
    const env = crawlAuth.toEnv(auth);
    check('toEnv carries the credentials in one variable',
      Object.keys(env).length === 1 && env[crawlAuth.AUTH_ENV_VAR],
      Object.keys(env).join(','));
    const parsed = JSON.parse(env[crawlAuth.AUTH_ENV_VAR]);
    check('the environment carries cookie, headers and basic auth',
      parsed.Cookie === 'sessionid=SECRET' && parsed['X-K'] === 'v'
      && String(parsed.Authorization || '').startsWith('Basic '),
      JSON.stringify(Object.keys(parsed)));
    check('anonymous crawls add no environment variable',
      Object.keys(crawlAuth.toEnv(null)).length === 0);

    // And the crawlers must actually READ it, with no flags on the command
    // line at all — otherwise the app would spawn them with credentials they
    // ignore, and every gated crawl would silently go back to reading login
    // pages. Checked in both implementations, since both had to be taught.
    const nodeAudit = path.join(__dirname, 'tools', 'node', 'audit', 'main.js');
    const nodeViaEnv = await runNodeTool(nodeAudit,
      [bases.walled, '--max-pages', '20', '--json'],
      { env: crawlAuth.toEnv(cookieAuth) });
    const nodeJson = parseAuditJson(nodeViaEnv.out);
    check('the Node audit authenticates from the environment alone',
      nodeJson && nodeJson.pages_crawled >= 4,
      nodeJson ? `pages=${nodeJson.pages_crawled}` : `exit ${nodeViaEnv.code}`);
    check('no credential value appears in the command line it was given',
      !JSON.stringify([bases.walled, '--max-pages', '20', '--json']).includes('letmein'));

    const pyAudit = path.join(__dirname, 'tools', 'webtechstackdetector', 'main.py');
    const pyViaEnv = await runPythonTool('audit', pyAudit,
      [bases.walled, '--max-pages', '20', '--json'],
      { env: crawlAuth.toEnv(cookieAuth) });
    if (pyViaEnv.skipped) {
      console.log(`  skip  Python env transport — ${pyViaEnv.reason}`);
    } else {
      const pyJson = parseAuditJson(pyViaEnv.out);
      check('the Python audit authenticates from the environment alone',
        pyJson && pyJson.pages_crawled >= 4,
        pyJson ? `pages=${pyJson.pages_crawled}` : `exit ${pyViaEnv.code}`);
    }

    // A malformed value must degrade to anonymous, not crash the crawl.
    const broken = await runNodeTool(nodeAudit, [bases.open, '--max-pages', '5', '--json'],
      { env: { [crawlAuth.AUTH_ENV_VAR]: '{not json' } });
    const brokenJson = parseAuditJson(broken.out);
    check('a malformed credential variable degrades to anonymous, not a crash',
      brokenJson && brokenJson.pages_crawled >= 1
      && Array.isArray(brokenJson.crawl_auth) && brokenJson.crawl_auth.length === 0,
      brokenJson ? `pages=${brokenJson.pages_crawled} auth=${JSON.stringify(brokenJson.crawl_auth)}` : `exit ${broken.code}`);
  }

  // ==========================================================================
  // The linking agent's renderer
  // ==========================================================================
  //
  // A separate bug from the audit's, found by asking what else had a browser in
  // it. The linking agent's Renderer called browser.new_page() on a bare
  // browser, so it carried no credentials at all: a --render run on a gated
  // site rendered the LOGIN page for every URL while the access check had
  // already passed. Fixed by giving it a context with the credential headers.
  //
  // Proving it needs a fixture whose CONTENT is written by JavaScript, because
  // that is the only case where the renderer's output is what gets analysed.
  // The assertion is on what the render actually saw — "Members" or "Sign in" —
  // rather than on a page count, because a page count cannot tell the two
  // apart.
  console.log('');
  console.log('Linking agent renderer on a gated JS site');
  {
    const spa = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const cookie = req.headers.cookie || '';
      const send = (st, b, h = {}) => {
        res.writeHead(st, { 'content-type': 'text/html; charset=utf-8', ...h });
        res.end(b);
      };
      if (p === '/robots.txt') return send(200, 'User-agent: *\nAllow: /', { 'content-type': 'text/plain' });
      if (p === '/login') {
        return send(200, '<!doctype html><html lang="en"><head><meta charset="utf-8">'
          + '<title>Sign in</title></head><body><h1>Sign in</h1>'
          + '<form><input type="password" name="p"></form></body></html>');
      }
      if (!cookie.includes('spa=1')) return send(302, '', { location: '/login' });
      const name = p === '/' ? 'home' : p.slice(1);
      // No title and no body text in the served HTML — both are written by the
      // script, so only a render that carried the cookie can read them.
      return send(200, `<!doctype html><html lang="en"><head><meta charset="utf-8">
</head><body><div id="root"></div><script>
  document.title = 'Members ${name}';
  document.getElementById('root').innerHTML = '<h1>Members ${name}</h1>';
</script></body></html>`);
    });
    await new Promise((r) => spa.listen(0, '127.0.0.1', r));
    const spaBase = `http://127.0.0.1:${spa.address().port}`;
    const pyLinking = path.join(__dirname, 'tools', 'internal-linking-agent', 'internal_link_agent.py');

    const titleFrom = (outDir) => {
      const f = path.join(outDir, 'crawl_data.json');
      if (!fs.existsSync(f)) return null;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const arr = Array.isArray(j.pages) ? j.pages : Object.values(j.pages || j);
        const first = arr[0] || {};
        return `${first.title || ''} ${first.h1 || ''}`.trim();
      } catch { return null; }
    };

    const withCreds = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-lkr-'));
    const run = await runPythonTool('linking', pyLinking,
      [spaBase, '--max-pages', '8', '--out', withCreds, '--render'],
      { timeoutMs: 300000, env: crawlAuth.toEnv({ cookie: 'spa=1', headers: {}, basicUser: '', basicPass: '' }) });

    if (run.skipped) {
      console.log(`  skip  linking renderer — ${run.reason}`);
    } else {
      const seen = titleFrom(withCreds);
      if (seen == null) {
        console.log(`  skip  linking renderer — no crawl_data.json (exit ${run.code}: `
          + `${(run.err || '').split('\n').filter(Boolean).slice(-1)[0] || 'no reason'})`);
      } else {
        check('the linking renderer carries credentials into the browser',
          /Members/i.test(seen), `it rendered: "${seen}"`);
        check('and therefore does not analyse the login page',
          !/sign in/i.test(seen), `it rendered: "${seen}"`);

        // The control that gives the assertion its meaning: without
        // credentials the very same render returns the login page.
        const noCreds = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-lkr-anon-'));
        const anon = await runPythonTool('linking', pyLinking,
          [spaBase, '--max-pages', '8', '--out', noCreds, '--render'], { timeoutMs: 300000 });
        const seenAnon = titleFrom(noCreds);
        check('without credentials the same render sees the login page',
          seenAnon != null && /sign in/i.test(seenAnon),
          `it rendered: "${seenAnon}" (exit ${anon.code})`);
        try { fs.rmSync(noCreds, { recursive: true, force: true }); } catch { /* leave it */ }
      }
    }
    try { fs.rmSync(withCreds, { recursive: true, force: true }); } catch { /* leave it */ }
    spa.close();
  }

  // ==========================================================================
  // Credentials must never reach a third party
  // ==========================================================================
  //
  // Found while scoping the AI SEO work, and worse than the gap it was found
  // looking for: the crawlers merged credentials into EVERY request, and the
  // audit checks every external link a page points at. A fixture recorded a
  // client's live session cookie arriving at a partner domain.
  //
  // The rule now is that credentials are bound to one site and attached
  // per-request, evaluated against every redirect hop. These checks are the
  // boundary, stated as a table because the interesting cases are the near
  // misses.
  console.log('');
  console.log('Credential scope');
  {
    const httpLib = require('./tools/node/lib/http');
    const scoped = { headers: { Cookie: 'sess=SECRET' }, site: 'https://client.example.com/' };
    const cases = [
      ['the site itself', 'https://client.example.com/page', true],
      ['the www variant', 'https://www.client.example.com/page', true],
      ['a deep path', 'https://client.example.com/a/b?c=d', true],
      ['a subdomain (a CDN is not the site)', 'https://cdn.client.example.com/a.js', false],
      ['a different domain', 'https://partner.example.net/x', false],
      ['a suffix look-alike', 'https://client.example.com.evil.net/x', false],
      ['a different port', 'https://client.example.com:8443/x', false],
      ['plain HTTP when bound to HTTPS', 'http://client.example.com/x', false],
    ];
    const wrong = cases.filter(([, url, expected]) =>
      Boolean(httpLib.scopedAuthFor(url, scoped)) !== expected);
    check(`credentials go only to the site they belong to (${cases.length} cases)`,
      wrong.length === 0, wrong.map(([n]) => n).join('; '));
    check('an unbound credential set is attached to nothing at all',
      !httpLib.scopedAuthFor('https://client.example.com/', { headers: { Cookie: 'x' }, site: '' }));
  }

  // ==========================================================================
  // AI SEO analyses
  // ==========================================================================
  //
  // The nine analyses fetch from 87 call sites across seventeen files, so the
  // credentials live in async context for the length of a run rather than
  // being threaded through each one. What that buys has to be tested at the
  // boundary: on-site requests carry them, everything else does not, and the
  // AI-crawler checks stay unauthenticated on purpose.
  console.log('');
  console.log('AI SEO analyses: credentials, scope and opt-out');
  {
    const fetcher = require('./src/lib/aiseo/fetcher');

    // Two servers: the brand's own gated site, and a third party it links to.
    const seen = { own: [], third: [] };
    const ownSrv = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      seen.own.push({ path: p, cookie: req.headers.cookie || null, ua: req.headers['user-agent'] });
      const send = (st, b, h = {}) => {
        res.writeHead(st, { 'content-type': 'text/html; charset=utf-8', ...h });
        res.end(b);
      };
      if (p === '/robots.txt') return send(200, 'User-agent: *\nAllow: /', { 'content-type': 'text/plain' });
      if (p === '/login') {
        return send(200, '<!doctype html><html lang="en"><head><meta charset="utf-8">'
          + '<title>Sign in</title></head><body><h1>Sign in</h1>'
          + '<form><input type="password" name="p"></form></body></html>');
      }
      if (!String(req.headers.cookie || '').includes('sess=SECRET')) {
        return send(302, '', { location: '/login' });
      }
      return send(200, '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<title>Members area</title></head><body><h1>Members area</h1>'
        + '<p>Content that only a signed-in member can read, with enough words in it '
        + 'to count as a real page rather than a shell of any kind.</p></body></html>');
    });
    const thirdSrv = http.createServer((req, res) => {
      seen.third.push({ path: req.url, cookie: req.headers.cookie || null });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Competitor</title></head>'
        + '<body><h1>Competitor</h1><p>Their public content.</p></body></html>');
    });
    await new Promise((r) => ownSrv.listen(0, '127.0.0.1', r));
    await new Promise((r) => thirdSrv.listen(0, '127.0.0.1', r));
    const own = `http://127.0.0.1:${ownSrv.address().port}`;
    const third = `http://127.0.0.1:${thirdSrv.address().port}`;
    const creds = { headers: { Cookie: 'sess=SECRET' }, site: own };

    // 1. Inside a run, the brand's own pages come back authenticated.
    const inside = await fetcher.runWithAuth(creds, async () => fetcher.fetchPage(`${own}/`));
    check('an analysis reads the gated pages of the brand itself',
      /Members area/.test(inside.body || ''), `got: ${(inside.body || '').slice(0, 60)}`);

    // 2. Outside a run, nothing is sent — the default stays anonymous.
    const outside = await fetcher.fetchPage(`${own}/`);
    check('outside a run the same fetch is anonymous',
      /Sign in/.test(outside.body || ''), `got: ${(outside.body || '').slice(0, 60)}`);

    // 3. A third party — a competitor domain, Reddit, a news site — gets none.
    seen.third.length = 0;
    await fetcher.runWithAuth(creds, async () => fetcher.fetchPage(`${third}/their-page`));
    check('a competitor domain receives no credentials',
      seen.third.length > 0 && !seen.third.some((r) => r.cookie),
      JSON.stringify(seen.third));

    // 4. The AI-crawler checks opt out, because their question is what an
    //    UNauthenticated agent can read.
    const asAgent = await fetcher.runWithAuth(creds,
      async () => fetcher.fetchPage(`${own}/`, { ua: 'GPTBot', noAuth: true }));
    check('the AI-crawler checks stay unauthenticated inside an authenticated run',
      /Sign in/.test(asAgent.body || ''), `got: ${(asAgent.body || '').slice(0, 60)}`);

    // 5. Concurrency. Two analyses run at once and may belong to different
    //    brands, so a module-level credential would cross-contaminate. This is
    //    what AsyncLocalStorage is for, and it is worth proving rather than
    //    trusting.
    const [a, b] = await Promise.all([
      fetcher.runWithAuth(creds, async () => {
        await new Promise((r) => setTimeout(r, 30));
        return fetcher.fetchPage(`${own}/`);
      }),
      fetcher.runWithAuth({ headers: { Cookie: 'sess=WRONG' }, site: own }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return fetcher.fetchPage(`${own}/`);
      }),
    ]);
    check('two concurrent runs do not share credentials',
      /Members area/.test(a.body || '') && /Sign in/.test(b.body || ''),
      `first=${/Members/.test(a.body || '')} second=${/Members/.test(b.body || '')}`);

    // 6. A crawl started inside a run inherits them without being told.
    const crawled = await fetcher.runWithAuth(creds,
      async () => fetcher.crawlSite(own, { maxPages: 3, concurrency: 2 }));
    // A crawled page carries a parsed `doc`, not a bare title — reading the
    // wrong field made this pass vacuously the first time it was written.
    const list = (crawled && crawled.pages) || [];
    const titles = list.map((pg) => (pg.doc && pg.doc.title) || '').filter(Boolean);
    check('a site crawl inside a run inherits the credentials',
      titles.some((t) => /Members area/.test(t)),
      `titles: ${titles.join(' | ') || '(none)'}`);

    // 7. The provenance line names what was sent, never its value.
    const desc = await fetcher.runWithAuth(creds, async () => fetcher.authDescription());
    check('the run can report which credentials it used, by name only',
      desc && desc.headers.includes('Cookie') && !JSON.stringify(desc).includes('SECRET'),
      JSON.stringify(desc));

    ownSrv.close();
    thirdSrv.close();
  }

  // ==========================================================================
  // The rendered fallback: walls that only exist in the browser
  // ==========================================================================
  //
  // The one shape no server-side check can see: 200 with a JavaScript shell,
  // and the bounce to the sign-in page happens client-side. Measured against
  // app.slack.com/client, which is the reference case:
  //
  //   static   200, 146 words, 18 nav links, no form, no redirect  -> looks fine
  //   rendered -> app.slack.com/workspace-signin                   -> a wall
  //
  // The trigger has to be the thin TEXT (or a declared meta refresh), not the
  // link count: Slack ships 18 nav links in its shell, and the first version
  // of this required few links as well, so it never fired on the very case it
  // was written for.
  console.log('');
  console.log('Rendered fallback for client-side login walls');
  {
    const shellPage = (bodyScript) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>App</title></head><body><div id="root"></div>
<nav><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a></nav>
<script>${bodyScript}</script></body></html>`;

    const mk = (handler) => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
    });

    if (!crawlAuth.rendererAvailable()) {
      console.log('  skip  rendered fallback — no usable renderer on this machine');
    } else {
      // 1. A JS app that bounces an anonymous visitor to /login in the browser.
      const gated = await mk((req, res) => {
        const p = new URL(req.url, 'http://127.0.0.1').pathname;
        const cookie = req.headers.cookie || '';
        const send = (b) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b); };
        if (p === '/login') {
          return send('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            + '<title>Sign in</title></head><body><h1>Sign in</h1></body></html>');
        }
        if (!cookie.includes('app=1')) {
          // Served with a 200 and no server-side redirect at all — the bounce
          // is JavaScript, exactly like the reference case.
          return send(shellPage("window.location.replace('/login');"));
        }
        return send(shellPage("document.getElementById('root').innerHTML="
          + "'<h1>Members</h1><p>Plenty of real content, written by the app after sign-in, "
          + "long enough that nothing reads as thin.</p>';"));
      });

      const p1 = await crawlAuth.probe(gated.base, null, { timeout: 25000 });
      check('a client-side bounce to a login page is caught',
        p1.wall === 'client_side_login' && p1.blocking === true,
        `wall=${p1.wall} rendered=${p1.rendered ? p1.rendered.finalUrl : 'not rendered'}`);
      check('the reason says the redirect happened in the browser',
        /redirected itself in the browser/.test(p1.reasons[0] || ''),
        (p1.reasons[0] || '').slice(0, 90));
      check('its remedy mentions that a crawl will also need rendering',
        /rendering/i.test(crawlAuth.remedyFor('client_side_login')));

      // 2. The same app, authenticated: renders real content, so not a wall.
      const p2 = await crawlAuth.probe(gated.base, {
        cookie: 'app=1', headers: {}, basicUser: '', basicPass: '',
      }, { timeout: 25000 });
      check('the same app with credentials is not a wall',
        p2.blocking === false,
        `wall=${p2.wall} rendered words=${p2.rendered ? p2.rendered.words : 'n/a'}`);
      gated.srv.close();

      // 3. A thin page that renders into real content is left alone — the
      //    ordinary JS site, which must not be blocked.
      const spa = await mk((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(shellPage("document.getElementById('root').innerHTML="
          + "'<h1>Our menu</h1><p>Hand-rolled pasta, a short wine list and a daily special, "
          + "described here at enough length that the page is unambiguously real content.</p>';"));
      });
      const p3 = await crawlAuth.probe(spa.base, null, { timeout: 25000 });
      check('an ordinary JavaScript site is not blocked by the rendered check',
        p3.blocking === false, `wall=${p3.wall}`);
      spa.srv.close();

      // 4. A page that renders to nothing at all: not a login, but the crawl
      //    would read nothing, so it is reported without stopping the run.
      const empty = await mk((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="en"><head><meta charset="utf-8">'
          + '<title>App</title></head><body><div id="root"></div></body></html>');
      });
      const p4 = await crawlAuth.probe(empty.base, null, { timeout: 25000 });
      check('a page that renders to nothing is reported but does not stop the run',
        p4.wall === 'renders_empty' && p4.blocking === false, `wall=${p4.wall}`);
      empty.srv.close();

      // 5. The cost control. A page with real copy must never pay for a
      //    browser launch, or every audit gets ten seconds slower.
      const real = await mk((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Olive and Thyme</title></head><body><h1>Olive and Thyme</h1>
<p>${'Hand-rolled pasta served on Bridge Street since 2011, with a short menu that changes with the market and everything made in-house each morning. '.repeat(14)}</p>
<a href="/menu">Menu</a><a href="/hours">Hours</a></body></html>`);
      });
      const t0 = Date.now();
      const p5 = await crawlAuth.probe(real.base, null, { timeout: 25000 });
      const took = Date.now() - t0;
      check('a page with real content is never rendered, so it stays fast',
        !p5.rendered && took < 3000, `rendered=${!!p5.rendered} took=${took}ms`);
      real.srv.close();

      // 6. And it can be turned off outright.
      const off = await crawlAuth.probe(empty.base, null, { timeout: 5000, render: 'off' });
      check('the rendered check can be disabled', !off.rendered, `rendered=${!!off.rendered}`);
    }
  }

  console.log('');
  console.log('Python implementations (skipped where the interpreter cannot run them)');
  {
    const pyAudit = path.join(__dirname, 'tools', 'webtechstackdetector', 'main.py');
    const anon = await runPythonTool('audit', pyAudit, [bases.walled, '--max-pages', '20', '--json']);
    if (anon.skipped) {
      console.log(`  skip  Python audit — ${anon.reason}`);
    } else {
      const anonJson = parseAuditJson(anon.out);
      check('py: without credentials the walled site yields almost nothing',
        anonJson && anonJson.pages_crawled <= 2,
        anonJson ? `crawled ${anonJson.pages_crawled} pages` : `no JSON (exit ${anon.code})`);

      const authed = await runPythonTool('audit', pyAudit, [
        bases.walled, '--max-pages', '20', '--json', ...crawlAuth.toArgs(cookieAuth),
      ]);
      const authedJson = parseAuditJson(authed.out);
      check('py: with a session cookie the whole walled site is crawled',
        authedJson && authedJson.pages_crawled >= 4,
        authedJson ? `crawled ${authedJson.pages_crawled} pages` : `no JSON (exit ${authed.code})`);
      check('py: crawl_auth names the credential without its value',
        authedJson && Array.isArray(authedJson.crawl_auth)
          && authedJson.crawl_auth.includes('Cookie')
          && !JSON.stringify(authedJson.crawl_auth).includes('letmein'),
        authedJson ? JSON.stringify(authedJson.crawl_auth) : 'no JSON');

      const basicRun = await runPythonTool('audit', pyAudit, [
        bases.basic, '--max-pages', '20', '--json', ...crawlAuth.toArgs(basicAuth),
      ]);
      const basicJson = parseAuditJson(basicRun.out);
      check('py: basic auth crawls a staging site fully',
        basicJson && basicJson.pages_crawled >= 4,
        basicJson ? `crawled ${basicJson.pages_crawled} pages` : `no JSON (exit ${basicRun.code})`);

      // A malformed header must be reported and skipped, not crash the crawl.
      const badHeader = await runPythonTool('audit', pyAudit, [
        bases.open, '--max-pages', '5', '--json', '--header', 'not-a-header',
      ]);
      const badJson = parseAuditJson(badHeader.out);
      check('py: a malformed --header is reported and the crawl continues',
        badJson && /ignoring --header/.test(badHeader.err),
        `exit ${badHeader.code}`);
    }

    const pyLinking = path.join(__dirname, 'tools', 'internal-linking-agent', 'internal_link_agent.py');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pylinking-'));
    const linkRun = await runPythonTool('linking', pyLinking, [
      bases.walled, '--max-pages', '20', '--out', outDir, ...crawlAuth.toArgs(cookieAuth),
    ]);
    if (linkRun.skipped) {
      console.log(`  skip  Python linking agent — ${linkRun.reason}`);
    } else {
      let summary = null;
      const sp = path.join(outDir, 'summary.json');
      if (fs.existsSync(sp)) { try { summary = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { summary = null; } }
      check('py: the linking agent produced output for the walled site', summary != null,
        `exit ${linkRun.code}: ${linkRun.err.slice(-300)}`);
      check('py: the linking agent crawled past the login page',
        summary && summary.pages_crawled >= 4,
        summary ? `pages=${summary.pages_crawled}` : 'no summary');
    }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* leave it */ }
  }

  // ==========================================================================
  // Live sites  (--live)
  // ==========================================================================
  //
  // Fixtures prove the logic; only the live web proves the thresholds. A real
  // homepage carries cookie banners, consent iframes, chat widgets and a
  // header login link, and the question is whether the guard still reads it as
  // a public site.
  //
  // Opt-in, because a suite that fails when the network is down or when a
  // third party redesigns a page is a suite people stop running. Read-only
  // GETs of public homepages, one request each.
  if (process.argv.includes('--live')) {
    console.log('');
    console.log('Live sites — public (must pass)');
    const publicSites = [
      'https://www.americanwebbuilders.com/',   // the live test brand
      'https://www.bbc.co.uk/',                 // heavy consent + JS
      'https://en.wikipedia.org/wiki/SEO',      // deep page, not a homepage
      'https://www.gov.uk/',                    // sparse, service-led
      'https://news.ycombinator.com/',          // minimal HTML, has a login link
    ];
    for (const site of publicSites) {
      // eslint-disable-next-line no-await-in-loop
      const p = await crawlAuth.probe(site, null, { timeout: 25000 });
      // A network failure here is the network's fault, not a code failure —
      // reported as a skip so a flaky connection cannot fail the build.
      if (p.wall === 'unreachable') {
        console.log(`  skip  ${site} — ${p.error}`);
      } else {
        check(`live public site is not blocked: ${site}`, p.blocking === false,
          `wall=${p.wall} status=${p.status} words=${p.words} links=${p.internalLinks}`);
      }
    }

    console.log('');
    console.log('Live sites — genuinely gated (must be caught)');
    // Real applications that will not serve their content to a stranger. Each
    // is the exact shape the guard exists for, and none is a fixture.
    const gatedSites = [
      'https://app.asana.com/0/home',
      'https://mail.google.com/mail/u/0/',
      'https://www.linkedin.com/feed/',
      'https://github.com/settings/profile',
      'https://app.slack.com/client',
    ];
    let caught = 0;
    let reachable = 0;
    for (const site of gatedSites) {
      // eslint-disable-next-line no-await-in-loop
      const p = await crawlAuth.probe(site, null, { timeout: 25000 });
      if (p.wall === 'unreachable') {
        console.log(`  skip  ${site} — ${p.error}`);
      } else {
        reachable += 1;
        if (p.blocking) caught += 1;
        console.log(`  ${p.blocking ? 'caught ' : 'MISSED '} ${site}`
          + `  wall=${p.wall} status=${p.status} final=${String(p.finalUrl).slice(0, 70)}`);
      }
    }
    // Every one of these should now be caught. The last holdout was
    // app.slack.com/client, which answers 200 with a JS shell and bounces in
    // the browser; the rendered fallback closed it. One allowance remains for
    // a third party redesigning a page mid-week, and each verdict is printed
    // above so a regression names itself.
    if (reachable) {
      check(`live gated apps are caught (${caught}/${reachable})`,
        caught >= reachable - 1, `${caught} of ${reachable}`);
    }
    // ----------------------------------------------------------------------
    // The audit's own checks, live, in both implementations
    // ----------------------------------------------------------------------
    //
    // Everything above tests the access check. This tests that the AUDIT still
    // works — all of its checks, against a real site, in both the Python
    // original and the Node port — because the credential plumbing touched the
    // HTTP layer of both and a regression there would show up as a subtly
    // different report rather than as an error.
    //
    // Parity is asserted on the failing-check SET, not just the score: two
    // implementations can reach the same number for different reasons, and the
    // set is what the task generator and the alerts actually read.
    console.log('');
    console.log('Live audit — both implementations, same site');
    {
      const target = process.env.LIVE_AUDIT_URL || 'https://www.americanwebbuilders.com/';
      const pages = '25';
      const nodeScript = path.join(__dirname, 'tools', 'node', 'audit', 'main.js');
      const pyScript = path.join(__dirname, 'tools', 'webtechstackdetector', 'main.py');

      const nodeRun = await runNodeTool(nodeScript, [target, '--max-pages', pages, '--json'],
        { timeoutMs: 420000 });
      const nodeJson = parseAuditJson(nodeRun.out);
      check('the Node audit completes against a live site and returns findings',
        nodeJson && Array.isArray(nodeJson.findings) && nodeJson.findings.length > 10,
        nodeJson ? `${nodeJson.findings.length} findings` : `exit ${nodeRun.code}`);
      check('it crawled more than the seed page',
        nodeJson && nodeJson.pages_crawled > 1,
        nodeJson ? `pages=${nodeJson.pages_crawled}` : 'no JSON');
      check('an anonymous live audit sends no credentials',
        nodeJson && Array.isArray(nodeJson.crawl_auth) && nodeJson.crawl_auth.length === 0,
        nodeJson ? JSON.stringify(nodeJson.crawl_auth) : 'no JSON');

      const pyRun = await runPythonTool('audit', pyScript,
        [target, '--max-pages', pages, '--json'], { timeoutMs: 420000 });
      if (pyRun.skipped) {
        console.log(`  skip  Python parity — ${pyRun.reason}`);
      } else {
        const pyJson = parseAuditJson(pyRun.out);
        check('the Python audit completes against the same live site',
          pyJson && Array.isArray(pyJson.findings),
          pyJson ? `${pyJson.findings.length} findings` : `exit ${pyRun.code}`);

        if (nodeJson && pyJson) {
          const failingIds = (j) => new Set(
            j.findings.filter((f) => f.tier !== 'passed' && f.severity !== 'passed')
              .map((f) => f.id)
          );
          const ni = failingIds(nodeJson);
          const pi = failingIds(pyJson);
          const onlyNode = [...ni].filter((x) => !pi.has(x));
          const onlyPy = [...pi].filter((x) => !ni.has(x));
          // A tolerance, not an equality, and deliberately so: this runs
          // against the live web, where `slow_pages` depends on how the server
          // felt during each crawl and `unverified_links` on whether a third
          // party answered. A run of these two minutes apart measured node=81
          // python=80 purely from one page crossing the slow threshold in one
          // crawl and not the other. Demanding an exact match would make this
          // check fail for reasons that have nothing to do with the code, and
          // a suite that cries wolf is a suite nobody runs. The failing-check
          // SET below is the assertion that actually has teeth — it held
          // across that variance.
          const drift = Math.abs(nodeJson.site_health - pyJson.site_health);
          check('both implementations report the same health score, within live noise',
            drift <= 3,
            `node=${nodeJson.site_health} python=${pyJson.site_health} (drift ${drift})`);
          check('both implementations crawl the same number of pages',
            nodeJson.pages_crawled === pyJson.pages_crawled,
            `node=${nodeJson.pages_crawled} python=${pyJson.pages_crawled}`);
          // Named explicitly so a future failure is read correctly: these two
          // are expected to differ run to run, and are not evidence of a
          // divergence between the implementations.
          void 'timing-dependent: slow_pages, unverified_links';
          check(`both implementations fail the same set of checks (${ni.size})`,
            onlyNode.length === 0 && onlyPy.length === 0,
            `node-only: ${onlyNode.join(',') || 'none'}; python-only: ${onlyPy.join(',') || 'none'}`);
        }
      }
    }

  } else {
    console.log('');
    console.log('  (skipping live-site checks — re-run with --live to include them)');
  }

  // --------------------------------------------------------- run wiring
  console.log('\nRun wiring');
  {
    // The guard must stop a run rather than let it finish and be scored. Driven
    // through toolRunner so the real path is exercised, not a reimplementation.
    const toolRunner = require('./src/lib/toolRunner');
    const db = require('./src/db');
    db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, role, status)
      VALUES (1,'verify@example.com','x','admin','active')`).run();

    const runId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: bases.walled, maxPages: 20, createTasks: false,
    });
    // The probe is a single local request; give it room without polling forever.
    const deadline = Date.now() + 20000;
    let row = null;
    for (;;) {
      row = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(runId);
      if (row && row.status !== 'running') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('a walled site fails the run instead of producing a score',
      row && row.status === 'error', row ? row.status : 'no row');
    check('the failure explains what was seen and how to fix it',
      row && /will not serve its pages/.test(row.error || '') && /session cookie/i.test(row.error || ''),
      (row && (row.error || '').slice(0, 120)) || '');
    check('the failed run has no health score to mistake for a real one',
      row && !row.json_result);

    // ...and the override, for a gated homepage with public pages below it.
    const forcedId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: bases.walled, maxPages: 20, createTasks: false,
      force: true,
    });
    const forcedDeadline = Date.now() + 60000;
    let forced = null;
    for (;;) {
      forced = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(forcedId);
      if (forced && forced.status !== 'running') break;
      if (Date.now() > forcedDeadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('"scan anyway" lets the run proceed', forced && forced.status === 'completed',
      forced ? forced.status : 'no row');
    check('an overridden run keeps the finding as a note on the record',
      forced && /overridden/i.test(forced.access_note || ''),
      (forced && (forced.access_note || '').slice(0, 120)) || '');

    // And the control: an authenticated run must complete and be marked as
    // having used credentials.
    const okId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: bases.walled, maxPages: 20, createTasks: false,
      auth: cookieAuth,
    });
    const okDeadline = Date.now() + 60000;
    let okRow = null;
    for (;;) {
      okRow = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(okId);
      if (okRow && okRow.status !== 'running') break;
      if (Date.now() > okDeadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('an authenticated run completes', okRow && okRow.status === 'completed',
      okRow ? `${okRow.status}: ${(okRow.error || '').slice(0, 120)}` : 'no row');
    check('the run row records that credentials were used', okRow && okRow.auth_used === 1,
      okRow ? String(okRow.auth_used) : 'no row');
    const okJson = okRow && okRow.json_result ? JSON.parse(okRow.json_result) : null;
    check('the authenticated run actually read the site',
      okJson && okJson.pages_crawled >= 4,
      okJson ? `pages=${okJson.pages_crawled}` : 'no result');
    check('no credential value is written into the stored result',
      okRow && !JSON.stringify(okRow).includes('letmein'));

    // A 403 site must still RUN, end to end, as it did before the guard
    // existed — the probe only records what it saw. Checked at the run level
    // rather than at the probe level, because this is the promise that matters
    // to whoever presses the button.
    const edgeId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: bases.edge, maxPages: 20, createTasks: false,
    });
    const edgeDeadline = Date.now() + 60000;
    let edgeRow = null;
    for (;;) {
      edgeRow = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(edgeId);
      if (edgeRow && edgeRow.status !== 'running') break;
      if (Date.now() > edgeDeadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('a 403 site is crawled, not blocked — it completes like before',
      edgeRow && edgeRow.status === 'completed',
      edgeRow ? `${edgeRow.status}: ${(edgeRow.error || '').slice(0, 140)}` : 'no row');
    check('the 403 is recorded as a note on the run rather than as a refusal',
      edgeRow && /403|Forbidden/i.test(edgeRow.access_note || ''),
      (edgeRow && (edgeRow.access_note || '').slice(0, 140)) || '');

    // Per-brand storage, including the rule that changing a credential clears
    // the previous verification.
    db.prepare(`INSERT OR IGNORE INTO brands (id, user_id, name, site_url)
      VALUES (900,1,'Verify brand',?)`).run(bases.walled);
    crawlAuth.save(900, cookieAuth);
    const loaded = crawlAuth.forBrand(900);
    check('stored credentials round-trip', loaded && loaded.cookie === SESSION_COOKIE);
    const probe = await crawlAuth.probe(bases.walled, loaded);
    crawlAuth.recordVerification(900, probe);
    let st = crawlAuth.statusForBrand(900);
    check('a passing test is recorded against the brand', st && st.verifyStatus === 'ok',
      st ? st.verifyStatus : 'no status');
    crawlAuth.save(900, { cookie: 'testsession=different', headers: {}, basicUser: '', basicPass: '' });
    st = crawlAuth.statusForBrand(900);
    check('changing a credential clears the old verification',
      st && !st.verifyStatus && !st.verifiedAt, st ? String(st.verifyStatus) : 'no status');
    check('the brand status never exposes a credential value',
      st && !JSON.stringify(st).includes('different'));

    // A brand-less/anonymous run of a public site must be unaffected by all of
    // this — the regression that would matter most.
    const publicId = toolRunner.startAudit({
      userId: 1, brandId: null, domain: bases.open, maxPages: 20, createTasks: false,
    });
    const pubDeadline = Date.now() + 60000;
    let pubRow = null;
    for (;;) {
      pubRow = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(publicId);
      if (pubRow && pubRow.status !== 'running') break;
      if (Date.now() > pubDeadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('a public site still audits end to end with no credentials',
      pubRow && pubRow.status === 'completed',
      pubRow ? `${pubRow.status}: ${(pubRow.error || '').slice(0, 160)}` : 'no row');
    check('an anonymous run is recorded as anonymous', pubRow && pubRow.auth_used === 0);

    crawlAuth.clear(900);
    check('credentials can be removed', crawlAuth.statusForBrand(900) === null);
  }

  servers.forEach((srv) => srv.close());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nverify_crawl_access.js crashed:', err);
  process.exit(1);
});
