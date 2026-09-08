// Authenticated crawling, and the guard that stops an unauthenticated crawl
// reporting a healthy site it never actually read.
//
// THE PROBLEM THIS SOLVES
// Both crawlers request pages anonymously. On a site that will not serve its
// content to a stranger — a members-only site, a client portal, a staging
// build behind HTTP basic auth — there were two outcomes, and the second is
// the dangerous one:
//
//   401 on the seed            the run fails, which is at least honest.
//   302 to /login, then 200    the crawler gets a *successful* login page,
//                              follows its two or three links (register,
//                              forgot password, privacy), and produces a
//                              three-page audit with a plausible health score.
//
// That second case is a login wall wearing a success code — the same trap this
// repo already documents for old.reddit.com/search in the Reddit scraper. A
// score computed over three pages of a login form is not a smaller truth than
// a real audit, it is a different and false one, and nothing on screen said so.
//
// So this module does two separate jobs:
//
//   1. CARRY CREDENTIALS. Normalises a cookie / header / basic-auth set into
//      the command-line flags all four crawler implementations now accept
//      (Python audit, Python linking agent, and both Node ports).
//   2. PROBE BEFORE CRAWLING. One request to the seed URL, before a crawl is
//      spawned, deciding whether the site will serve its pages at all. A
//      second spent here replaces a ten-minute crawl that returns nothing —
//      and catches the case that actually bites in practice: a saved cookie
//      that has since expired.
//
// THE CONSTRAINT THAT SHAPES THE WHOLE FILE
// A site that crawled correctly before this feature existed must still crawl
// correctly, identically, with no credentials and no new way to fail. A guard
// that stops a public crawl on a bad guess costs the team far more than the
// wall it catches — so the probe stops a run ONLY on evidence that cannot mean
// anything else (see BLOCKING_WALLS). A 403, a timeout, a bad seed URL, a
// sparse homepage with a login box: all noted, none blocking, crawl proceeds
// exactly as before. The only cost to a public site is one extra HTTP request
// before a crawl that is about to make hundreds.
//
// The probe is deliberately in the app rather than in the crawlers, so the
// verdict is identical whichever implementation ends up running, and so the
// "Test access" button on the brand page and the pre-flight check share one
// piece of code and cannot disagree.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../db');
const fetcher = require('./aiseo/fetcher');
const pythonEnv = require('./pythonEnv');

// ==========================================================================
// Credential shape
// ==========================================================================
//
// An auth object is `{ cookie, headers, basicUser, basicPass }`, all optional.
// `null` and an object whose every field is empty both mean "crawl anonymously"
// — callers should not have to distinguish those.

// Header names a caller must not be able to set. `Host` and `Content-Length`
// would corrupt the request itself; the hop-by-hop names are meaningless to
// set per-request and break keep-alive. Everything else is allowed: the point
// of the feature is to let the team send whatever their site requires.
const BLOCKED_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization',
]);

// Parses the free-text header box: one `Name: value` per line. Blank lines and
// `#` comments are skipped so a team can annotate what a header is for.
function parseHeaderLines(text) {
  const headers = {};
  const rejected = [];
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf(':');
    if (idx <= 0) {
      rejected.push({ line, why: 'no "Name: value" separator' });
      return;
    }
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      rejected.push({ line, why: 'not a valid header name' });
      return;
    }
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      rejected.push({ line, why: `${name} is set by the crawler itself and cannot be overridden` });
      return;
    }
    // A header value containing a newline is a request-splitting attempt, and
    // there is no legitimate reason for one here.
    if (/[\r\n]/.test(value)) {
      rejected.push({ line, why: 'header values cannot contain line breaks' });
      return;
    }
    headers[name] = value;
  });
  return { headers, rejected };
}

// Builds an auth object from posted form fields. Returns the parse problems
// rather than throwing, so a route can show them next to the form.
function fromForm(body = {}) {
  const { headers, rejected } = parseHeaderLines(body.auth_headers);
  const auth = {
    cookie: String(body.auth_cookie || '').trim().replace(/[\r\n]+/g, ' '),
    headers,
    basicUser: String(body.auth_basic_user || '').trim(),
    basicPass: String(body.auth_basic_pass || '').trim(),
  };
  return { auth: isEmpty(auth) ? null : auth, rejected };
}

function isEmpty(auth) {
  if (!auth) return true;
  return !auth.cookie
    && !auth.basicUser
    && !Object.keys(auth.headers || {}).length;
}

// What the credentials are, in one line, for a log or a run banner. Values are
// never included — a run log is read by more people than the brand settings
// page, and a session cookie in a log tail is a session cookie leaked.
function describe(auth) {
  if (isEmpty(auth)) return 'anonymous (no credentials)';
  const parts = [];
  if (auth.cookie) {
    const names = auth.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
    parts.push(`cookie${names.length === 1 ? '' : 's'} ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
  }
  if (auth.basicUser) parts.push(`HTTP basic auth as ${auth.basicUser}`);
  const hn = Object.keys(auth.headers || {});
  if (hn.length) parts.push(`header${hn.length === 1 ? '' : 's'} ${hn.join(', ')}`);
  return parts.join(' + ');
}

// The header set to send. Basic auth is expanded here rather than being a
// separate transport, because that is all it ever was.
function toHeaders(auth) {
  if (isEmpty(auth)) return {};
  const out = { ...(auth.headers || {}) };
  if (auth.cookie) out.Cookie = auth.cookie;
  if (auth.basicUser) {
    const token = Buffer.from(`${auth.basicUser}:${auth.basicPass || ''}`, 'utf8').toString('base64');
    out.Authorization = `Basic ${token}`;
  }
  return out;
}

// The environment this app spawns a crawler with — the DEFAULT transport for
// credentials, in preference to the command line.
//
// WHY NOT ARGUMENTS
// This app's deployment target is shared hosting. On Linux `/proc/<pid>/cmdline`
// is world-readable, so a session cookie passed as `--cookie` is visible to
// every other tenant on the box for as long as the crawl runs; `environ` on the
// same process is 0400, readable only by its owner. Neither is a vault, but one
// of them hands a client's session to strangers and the other does not.
//
// The flags remain, because a developer running the crawler by hand needs them
// and because the two implementations must keep identical command lines. A flag
// wins over the environment when both are present — an explicit argument should
// always beat an inherited one.
const AUTH_ENV_VAR = 'CRAWL_AUTH_HEADERS';

function toEnv(auth) {
  const headers = toHeaders(auth);
  if (!Object.keys(headers).length) return {};
  return { [AUTH_ENV_VAR]: JSON.stringify(headers) };
}

// The command-line flags for the crawlers. All four implementations accept
// `--cookie` once and `--header "Name: value"` repeated.
//
// Kept for manual use and for the verify suite, which drives the crawlers
// directly. This app spawns them with toEnv() instead — see above.
function toArgs(auth) {
  const headers = toHeaders(auth);
  const args = [];
  if (headers.Cookie) {
    args.push('--cookie', headers.Cookie);
    delete headers.Cookie;
  }
  Object.entries(headers).forEach(([k, v]) => args.push('--header', `${k}: ${v}`));
  return args;
}

// ==========================================================================
// Per-brand storage
// ==========================================================================

function forBrand(brandId) {
  if (!brandId) return null;
  const row = db.prepare('SELECT * FROM crawl_auth WHERE brand_id=?').get(brandId);
  if (!row) return null;
  let headers = {};
  try { headers = row.headers_json ? JSON.parse(row.headers_json) : {}; } catch { headers = {}; }
  const auth = {
    cookie: row.cookie || '',
    headers,
    basicUser: row.basic_user || '',
    basicPass: row.basic_pass || '',
  };
  if (isEmpty(auth)) return null;
  auth.meta = {
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    verifyStatus: row.verify_status,
    verifyNote: row.verify_note,
  };
  return auth;
}

// Read for display: the metadata and which fields are set, never the values.
function statusForBrand(brandId) {
  if (!brandId) return null;
  const row = db.prepare('SELECT * FROM crawl_auth WHERE brand_id=?').get(brandId);
  if (!row) return null;
  const auth = forBrand(brandId);
  if (!auth) return null;
  return {
    describe: describe(auth),
    hasCookie: !!row.cookie,
    hasBasic: !!row.basic_user,
    basicUser: row.basic_user || '',
    headerNames: Object.keys(auth.headers || {}),
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    verifyStatus: row.verify_status,
    verifyNote: row.verify_note,
  };
}

// Merges an incoming credential set over what is already stored.
//
// WHY THIS EXISTS
// The brand form cannot show a stored cookie or password back to the user —
// they are secrets, and the fields render as placeholders. So a team member
// who edits only the basic-auth username posts an EMPTY cookie box, and a
// plain replace silently destroyed a working session cookie. That was a real
// bug: the credentials vanished, the next crawl was refused, and nothing on
// screen connected the two.
//
// So a blank field means "leave it alone" and removal is explicit. `remove`
// names the fields to drop: 'cookie', 'basic', 'headers'.
function merge(existing, incoming, remove = []) {
  const drop = new Set(remove);
  const base = existing || { cookie: '', headers: {}, basicUser: '', basicPass: '' };
  const inc = incoming || { cookie: '', headers: {}, basicUser: '', basicPass: '' };
  return {
    cookie: drop.has('cookie') ? '' : (inc.cookie || base.cookie || ''),
    // A supplied header set replaces the stored one wholesale rather than
    // being unioned: a team editing the box expects to see the result of what
    // they typed, and a union makes a removed header impossible to remove.
    headers: drop.has('headers')
      ? {}
      : (Object.keys(inc.headers || {}).length ? inc.headers : (base.headers || {})),
    basicUser: drop.has('basic') ? '' : (inc.basicUser || base.basicUser || ''),
    // The password follows the username: a new username with a blank password
    // keeps the stored password, which is what "change the username" means.
    basicPass: drop.has('basic') ? '' : (inc.basicPass || base.basicPass || ''),
  };
}

function save(brandId, auth) {
  if (!brandId) return;
  if (isEmpty(auth)) return clear(brandId);
  db.prepare(`INSERT INTO crawl_auth (brand_id, cookie, headers_json, basic_user, basic_pass, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(brand_id) DO UPDATE SET
      cookie=excluded.cookie, headers_json=excluded.headers_json,
      basic_user=excluded.basic_user, basic_pass=excluded.basic_pass,
      updated_at=datetime('now'),
      -- A credential change invalidates the previous test result. Leaving the
      -- old "verified" stamp in place would show a green tick for a cookie
      -- that has just been replaced with a typo.
      verified_at=NULL, verify_status=NULL, verify_note=NULL`)
    .run(brandId, auth.cookie || null, JSON.stringify(auth.headers || {}),
      auth.basicUser || null, auth.basicPass || null);
  return undefined;
}

function clear(brandId) {
  if (!brandId) return;
  db.prepare('DELETE FROM crawl_auth WHERE brand_id=?').run(brandId);
}

function recordVerification(brandId, probe) {
  if (!brandId) return;
  db.prepare(`UPDATE crawl_auth SET verified_at=datetime('now'), verify_status=?, verify_note=?
    WHERE brand_id=?`)
    .run(probe.ok ? 'ok' : 'blocked', String(probe.summary || '').slice(0, 400), brandId);
}

// ==========================================================================
// The login-wall probe
// ==========================================================================

// URL paths that mean "this is the sign-in page, not the page you asked for".
//
// TWO THINGS ARE LOAD-BEARING HERE, and both were bugs first.
//
// 1. THE BOUNDARY. Matched as a whole path segment, ending at the end of the
//    string or at / ? # . — never as a bare substring. Without the boundary
//    `/sso` matched `/ssortment-of-cheeses`, `/login` matched
//    `/logins-explained`, `/signin` matched `/signing-a-lease` and
//    `/authenticate` matched `/authenticated-users-guide`. A restaurant with
//    an assortment page, or any site redirecting to one of those, would have
//    had its crawl stopped as a login wall. The `.` is allowed because
//    `/login.php` and `/login.aspx` are real sign-in pages.
//
// 2. THE NON-ENGLISH PATHS. This app is used on non-English sites — brands
//    carry a `locale` and the crawlers take `--locale` — so an English-only
//    list quietly fails to recognise a French or German login wall, which is
//    the silent half of the original bug on exactly the sites least likely to
//    be double-checked by an English-speaking operator.
const LOGIN_SEGMENTS = [
  // English
  '/login', '/log-in', '/signin', '/sign-in', '/sso', '/logon', '/log-on',
  '/wp-login', '/wp-login.php', '/user/login', '/users/sign_in', '/account/login',
  '/accounts/login', '/auth', '/authenticate', '/session/new', '/sessions/new',
  '/members/login', '/member/login', '/customer/account/login', '/portal/login',
  '/idp', '/oauth2/authorize', '/o/oauth2/auth', '/adfs/ls',
  // French, German, Spanish, Portuguese, Italian, Dutch, Nordic, Polish,
  // Turkish, Indonesian — the locales this suite is actually pointed at.
  '/connexion', '/se-connecter', '/identification',
  '/anmelden', '/anmeldung', '/einloggen',
  '/iniciar-sesion', '/inicio-sesion', '/acceder', '/ingresar',
  '/entrar', '/iniciar-sessao',
  '/accedi', '/autenticazione',
  '/inloggen', '/aanmelden',
  '/logga-in', '/logg-inn', '/kirjaudu',
  '/zaloguj', '/logowanie',
  '/giris', '/oturum-ac',
  '/masuk',
  // Non-Latin scripts. These only work because pathForMatch() percent-decodes
  // the path first: Node's URL gives `/%E7%99%BB%E5%BD%95` for `/登录`, so a
  // literal here would never have matched the raw pathname.
  '/登录', '/登入', '/登陆', '/會員登入', '/用户登录', '/会员登录',  // Chinese
  '/ログイン', '/サインイン', '/ろぐいん',            // Japanese
  '/로그인', '/회원로그인',                          // Korean
  '/вход', '/войти', '/авторизация', '/логин',        // Russian
  '/увійти', '/вхід',                                // Ukrainian
  '/влез', '/вписване',                              // Bulgarian / Macedonian
  '/تسجيل-الدخول', '/دخول', '/تسجيل_الدخول', '/الدخول', // Arabic
  '/ورود', '/وارد-شدن',                              // Persian / Farsi
  '/لاگ-ان', '/لاگ_ان',                               // Urdu
  '/התחברות', '/כניסה',                              // Hebrew
  '/เข้าสู่ระบบ', '/ลงชื่อเข้าใช้',                        // Thai
  '/σύνδεση', '/εισοδος', '/είσοδος',                // Greek
  '/लॉगिन', '/प्रवेश', '/लोग-इन',                        // Hindi
  '/লগইন', '/প্রবেশ',                                  // Bengali
  '/உள்நுழை', '/உள்நுழைவு',                            // Tamil
  '/ලොග්-වන්න',                                       // Sinhala
  '/လော့ဂ်အင်',                                        // Burmese
  '/ចូល',                                            // Khmer
  '/ເຂົ້າສູ່ລະບົບ',                                       // Lao
  '/შესვლა',                                         // Georgian
  '/մուտք',                                          // Armenian
  '/кіру',                                           // Kazakh
  '/ግባ',                                             // Amharic
  // Latin-script languages the earlier pass missed. Cheap to add, and each is
  // a market this suite is plausibly pointed at.
  '/dang-nhap', '/dangnhap',                         // Vietnamese
  '/prijava', '/prijavi-se',                         // Croatian / Serbian / Slovenian
  '/prihlaseni', '/prihlasenie',                     // Czech / Slovak
  '/bejelentkezes',                                  // Hungarian
  '/autentificare', '/conectare',                    // Romanian
  '/pieslegties', '/prisijungti',                    // Latvian / Lithuanian
  '/logi-sisse',                                     // Estonian
  '/innskraning',                                    // Icelandic
  '/ingia',                                          // Swahili
  '/mag-login',                                      // Filipino
  '/oturumac',                                       // Turkish (no-hyphen variant)
];

const LOGIN_PATH = new RegExp(
  `(?:${LOGIN_SEGMENTS.map((p) => p.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('|')})(?=$|[/?#.])`,
  'i'
);

// The path to test the matcher against: percent-DECODED, because that is the
// form the segments above are written in.
//
// Node's URL percent-encodes non-ASCII, so `https://site.cn/登录` arrives as
// `/%E7%99%BB%E5%BD%95` and a literal `/登录` in the list would never match —
// the non-Latin half of the list would have been dead code. Malformed escapes
// (`/%zz`) make decodeURIComponent throw, so the raw path is the fallback:
// a path that cannot be decoded is still worth matching in its raw form.
function pathForMatch(urlOrPath) {
  let raw = String(urlOrPath || '');
  try {
    const u = new URL(raw);
    raw = u.pathname + (u.search || '');
  } catch { /* already a path */ }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Phrases that appear on a wall and essentially nowhere else. Kept short and
// unambiguous: "sign in" alone is in the header of half the web, so it is not
// here — only phrases that state the page IS the gate.
const WALL_PHRASES = [
  'you must be logged in',
  'you need to be logged in',
  'please log in to continue',
  'please sign in to continue',
  'log in to continue',
  'sign in to continue',
  'members only',
  'restricted access',
  'access denied',
  'authentication required',
  'this content is for members',
];

function looksLikeLoginForm(html) {
  if (!html) return false;
  // A password field is the only reliable structural marker. A site can style
  // a login page any way it likes, but it cannot collect a password without one.
  return /<input[^>]+type\s*=\s*["']?password/i.test(html);
}

// Does the page SAY it is a sign-in page, in its title or its own URL?
//
// This is one half of the login-page test, and it exists to protect ordinary
// public sites. A password field plus a short page is not enough on its own: a
// small business site with a "Client login" box in its header and a
// deliberately sparse homepage matches that, and blocking its crawl would be a
// false alarm on a site that was crawling perfectly well before. A marketing
// homepage does not call itself "Sign in".
function saysSignIn(html, finalPath) {
  const title = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html || '') || [])[1] || '';
  const vocab = /\b(log ?in|sign ?in|signin|login|authenticate|authentication|sso)\b/i;
  return vocab.test(title) || LOGIN_PATH.test(finalPath || '');
}

// How many links on this page lead further into the same site?
//
// This is the strongest signal available, because it answers the question the
// guard is actually asking — *would a crawl started here get anywhere?* A real
// login wall is a dead end: a password box, and links to forgot-password and
// signup if anything. A restaurant's login page carries the site's whole
// header nav, so a crawl seeded there reaches the menu, the hours and the
// contact page and produces a perfectly good audit.
//
// So a page that offers a way into the site is never treated as a wall, no
// matter what its title says. That case was found by testing a restaurant
// fixture whose /login page has real content and a full nav: the word-count
// and title rules both fired on it, and blocking it would have been wrong.
function countInternalLinks(html, finalUrl) {
  if (!html) return 0;
  let origin;
  try { origin = new URL(finalUrl).origin; } catch { return 0; }
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m = re.exec(html);
  while (m) {
    const raw = m[1].trim();
    if (raw && !/^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) {
      try {
        const u = new URL(raw, finalUrl);
        // Same site, and not a link back to this very page or to the sign-in
        // family — a wall linking to /forgot-password is still a wall.
        const decoded = pathForMatch(u.pathname);
        if (u.origin === origin && !LOGIN_PATH.test(decoded)
          && !/(forgot|reset|register|signup|sign-up|注册|登録|регистрация)/i.test(decoded)) {
          const key = u.pathname.replace(/\/$/, '') || '/';
          if (key !== (new URL(finalUrl).pathname.replace(/\/$/, '') || '/')) seen.add(key);
        }
      } catch { /* an unparseable href is not a route into the site */ }
    }
    m = re.exec(html);
  }
  return seen.size;
}

// Below this many onward links, a page is a dead end for a crawler. Three
// rather than one, because a genuine wall commonly carries a couple of legal
// or marketing links (privacy, terms, "about us") beside the form.
const DEAD_END_LINKS = 3;

// Which verdicts are allowed to STOP a run, and which are only advisory.
//
// THE RULE, and the reason this split exists at all: a site that crawled fine
// before must still crawl. So a run is stopped only where the evidence is
// unambiguous and verifiable — the server demanded credentials (401), or it
// redirected to a page that identifies itself as the sign-in page. Everything
// else the probe can notice is a guess:
//
//   403          usually a WAF or bot rule, not a login. The crawl used to run
//                and report what it found, and it still does.
//   4xx/5xx      a bad seed URL or a site having a moment. The crawler's own
//                error reporting is better than a pre-flight veto.
//   unreachable  one timed-out request must never veto a crawl — that would
//                turn a flaky moment into "this site cannot be audited".
//   gated phrase a phrase match is weak evidence on its own.
//
// Those four are recorded as a warning on the run and the crawl proceeds
// exactly as it did before this feature existed.
const BLOCKING_WALLS = new Set([
  'http_auth', 'redirect_to_login', 'login_page',
  // Proven by rendering the page and watching it navigate itself to a sign-in
  // URL, so it is evidence, not a guess.
  'client_side_login',
]);

function isBlocking(wall) {
  return BLOCKING_WALLS.has(wall);
}

// Rough visible-word count, used only to separate "a login page" from "a real
// page that happens to have a login form in its header or a modal".
function wordCount(html) {
  try {
    return fetcher.visibleText(fetcher.load(html)).split(/\s+/).filter(Boolean).length;
  } catch {
    return String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  }
}

// One request to the seed URL, returning a verdict on whether a crawl started
// now would read the site or read a wall.
//
// Three outcomes, not two:
//
//   ok: true                     the site serves its content — crawl it.
//   ok: false, blocking: true    an unambiguous auth wall. Stop the run.
//   ok: false, blocking: false   something worth noting (a 403, a timeout, a
//                                bad URL) that is NOT proof of a login wall.
//                                The crawl runs exactly as it did before and
//                                the observation is attached to the run.
//
// `reasons` always names the evidence, because a pre-flight check that stops a
// run without saying what it saw is worse than no check.
async function probe(url, auth = null, { timeout = 20000, render = 'auto' } = {}) {
  const headers = toHeaders(auth);
  const res = await fetcher.fetchPage(url, { timeout, headers });

  const out = {
    url,
    requestedUrl: url,
    finalUrl: res.url,
    status: res.status,
    error: res.error,
    redirectChain: res.redirectChain || [],
    authUsed: !isEmpty(auth),
    authDescribed: describe(auth),
    reasons: [],
    wall: null,
    ok: false,
    summary: '',
    words: null,
  };

  if (res.error || res.status == null) {
    out.wall = 'unreachable';
    out.reasons.push(`the seed URL could not be fetched (${res.error || 'no response'})`);
    out.summary = `${url} did not answer the access check (${res.error || 'no response'}), `
      + 'so the crawl was started anyway and will report what it finds.';
    out.blocking = false;
    return out;
  }

  // Percent-decoded, so the non-Latin sign-in segments can match at all.
  const finalPath = pathForMatch(res.url);

  // --- status-based walls -------------------------------------------------
  if (res.status === 401) {
    out.wall = 'http_auth';
    out.reasons.push('the server answered 401 Unauthorized — the site is behind HTTP basic auth');
  } else if (res.status === 403) {
    out.wall = 'forbidden';
    out.reasons.push('the server answered 403 Forbidden — an edge rule or WAF is refusing the crawler');
  } else if (res.status >= 400) {
    out.wall = 'http_error';
    out.reasons.push(`the server answered HTTP ${res.status} on the seed URL`);
  }

  // --- redirect to a sign-in page ----------------------------------------
  const redirected = (out.redirectChain || []).length > 0;
  if (!out.wall && redirected && LOGIN_PATH.test(finalPath)) {
    out.wall = 'redirect_to_login';
    out.reasons.push(
      `the seed URL redirected to ${res.url}, which is a sign-in page — `
      + 'a login wall that answers HTTP 200, so a crawl would report the login form as the site'
    );
  }

  // --- the page itself is the gate ---------------------------------------
  if (!out.wall && res.body) {
    const words = wordCount(res.body);
    out.words = words;
    const hasForm = looksLikeLoginForm(res.body);
    const lower = res.body.toLowerCase();
    const phrase = WALL_PHRASES.find((p) => lower.includes(p));

    const onward = countInternalLinks(res.body, res.url);
    out.internalLinks = onward;
    // A declared client-side redirect. Not a verdict on its own — plenty of
    // legitimate pages use one — but a reason to look in a browser.
    const refresh = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/i.exec(res.body);
    out.metaRefresh = refresh ? refresh[0].slice(0, 200) : null;

    // FOUR signals must agree before this is called a login page: a password
    // field, almost no content, a title or URL that says sign-in, and no way
    // onward into the site. Any three of the four describe real public pages —
    // a restaurant's login page carrying the full header nav being the case
    // that found this — and stopping a crawl that used to work is a worse
    // outcome than the wall this catches.
    //
    // The link count is the one that matters most, because it answers what the
    // guard is really predicting: a page offering six routes into the site is
    // not a dead end, whatever it calls itself.
    if (hasForm && words < 150 && saysSignIn(res.body, finalPath) && onward < DEAD_END_LINKS) {
      out.wall = 'login_page';
      out.reasons.push(
        `the seed page is a sign-in page and a dead end: a password field, only ${words} `
        + `words of visible text, a title or URL that says sign-in, and ${onward} link`
        + `${onward === 1 ? '' : 's'} onward into the site`
      );
    } else if (hasForm && words < 150 && onward < DEAD_END_LINKS) {
      // Suspicious but not proven — a password field on a thin dead-end page
      // that does not call itself a login page. Noted, and the crawl proceeds.
      out.wall = 'maybe_login';
      out.reasons.push(
        `the seed page has a password field, only ${words} words of visible text and `
        + `${onward} link${onward === 1 ? '' : 's'} onward into the site. That may be a `
        + 'login page, or a sparse homepage with a login box — the crawl was run either '
        + 'way, so check the page count below looks right for this site'
      );
    } else if (phrase && words < 150) {
      out.wall = 'gated_content';
      out.reasons.push(
        `the seed page says "${phrase}" and carries only ${words} words of visible text. `
        + 'The crawl was run anyway'
      );
    }
  }

  out.ok = !out.wall;
  out.blocking = isBlocking(out.wall);

  // The rendered second look. Only for a shell — a page a crawl would get
  // nothing from anyway — and only when the static verdict was "fine", because
  // that is the case the static check gets wrong.
  if (out.ok && render !== 'off' && looksLikeShell(out) && rendererAvailable()) {
    const r = await renderProbe(url, auth);
    if (r) {
      out.rendered = {
        finalUrl: r.finalUrl,
        title: r.title,
        words: r.words,
        internalLinks: r.internalLinks,
        navigated: r.finalUrl !== r.requestedUrl,
        hasPassword: r.hasPassword,
      };
      const navigatedAway = r.finalUrl !== r.requestedUrl;
      const mentionsSignIn = SIGNIN_MENTION.test(pathForMatch(r.finalUrl))
        || SIGNIN_MENTION.test(r.title || '');
      if (navigatedAway && mentionsSignIn) {
        // The Slack case: the page bounced itself to a sign-in URL. The
        // navigation is what makes the looser URL test safe here.
        out.wall = 'client_side_login';
        out.reasons.push(
          `the page answered HTTP ${res.status} and then redirected itself in the browser to `
          + `${r.finalUrl} ("${r.title}"), which is a sign-in page — invisible to any `
          + 'server-side check, because the bounce happens in JavaScript'
        );
      } else if (r.hasPassword && r.words < 150 && r.internalLinks < DEAD_END_LINKS) {
        out.wall = 'client_side_login';
        out.reasons.push(
          `once rendered, the page is a sign-in form: a password field, ${r.words} words `
          + `of text and ${r.internalLinks} links onward`
        );
      } else if (r.words < 20 && r.internalLinks === 0) {
        // Not a login, but not crawlable either. Advisory: the crawl runs and
        // the audit's own thin-content handling caps what it can claim.
        out.wall = 'renders_empty';
        out.reasons.push(
          `the page renders to ${r.words} words and no links even in a real browser, `
          + 'so a crawl will read almost nothing from it'
        );
      }
      out.ok = !out.wall;
      out.blocking = isBlocking(out.wall);
    }
  }

  if (out.ok) {
    out.summary = out.authUsed
      ? `${url} served its content to the crawler using ${out.authDescribed} (HTTP ${res.status}, ~${out.words} words).`
      : `${url} serves its content anonymously (HTTP ${res.status}, ~${out.words} words).`;
  } else if (!out.blocking) {
    // Advisory only. Worded as an observation about a crawl that IS running,
    // never as a refusal — the crawl behaves exactly as it did before.
    out.summary = `Access check on ${url}: ${out.reasons[0]}.`;
  } else if (out.authUsed) {
    // The single most common real-world failure: a cookie that worked when it
    // was pasted and has since expired. Say that, rather than repeating the
    // generic "site needs a login" message.
    out.summary = `The stored credentials did not get past the wall on ${url}. `
      + `${out.reasons[0]}. Session cookies expire — re-copy it from a logged-in browser and test again.`;
  } else {
    out.summary = `${url} will not serve its pages to an anonymous crawler. ${out.reasons[0]}.`;
  }
  return out;
}

// Advice a route or a view can print for each wall kind. Kept here so the
// audit page, the linking page and the brand page give the same instructions.
const REMEDY = {
  // Blocking walls — the run stopped, and this is how to get past it.
  http_auth: 'Enter the HTTP basic auth username and password under "Crawl access" — that is all this kind of wall needs.',
  redirect_to_login: 'Log into the site in your browser, copy the session cookie from DevTools → Application → Cookies, and paste it under "Crawl access".',
  login_page: 'Log into the site in your browser, copy the session cookie from DevTools → Application → Cookies, and paste it under "Crawl access".',
  client_side_login: 'This is a JavaScript app that signs users in before showing anything. Log in in your browser, copy the session cookie from DevTools → Application → Cookies, and paste it under "Crawl access" — and note that a crawl will also need rendering enabled to read it.',
  renders_empty: 'The page renders to nothing even in a browser. Check the site is working, and crawl a URL that serves real content.',
  // Advisory — the crawl RAN. Worded as "if the result looks wrong, this is why".
  maybe_login: 'If the report covers fewer pages than the site has, paste a logged-in session cookie under "Crawl access" and run it again.',
  gated_content: 'If the report looks thin, paste a logged-in session cookie under "Crawl access" and run it again.',
  forbidden: 'A 403 is usually a WAF or bot rule rather than a login. If the report came back empty, allowlist the crawler at the CDN, or send whatever header your edge rules expect under "Crawl access".',
  http_error: 'Check the seed URL is right and the site is up.',
  unreachable: 'Check the URL, DNS and whether the site is reachable from this server.',
};

function remedyFor(wall) {
  return REMEDY[wall] || 'Add credentials under "Crawl access" on the brand, or crawl a publicly readable URL.';
}


// ==========================================================================
// The rendered fallback
// ==========================================================================
//
// One wall shape defeats every server-side check: the server answers 200 with
// a JavaScript shell and the bounce to the sign-in page happens in the
// browser. app.slack.com/client is the reference case — 200, no login form in
// the HTML, and following its meta refresh lands back on the same shell.
// Measured against the live site, only rendering reveals it:
//
//   static probe   200, 146 words, no form, no redirect     -> looks fine
//   rendered       -> app.slack.com/workspace-signin        -> a login wall
//
// So when the static probe finds a page that looks like a SHELL — almost no
// text, almost no links onward — and a renderer exists, the page is rendered
// and judged again. The narrow trigger is the point: this costs a browser
// launch, so an ordinary page never pays for it.
const RENDER_PROBE = path.join(__dirname, '..', '..', 'tools', 'render_probe.py');

// Slack lands on `/workspace-signin`, which is not the segment `/signin`, so
// the strict path matcher does not fire on it. In the rendered path a looser
// test is justified: a page that NAVIGATED ITSELF to a URL mentioning sign-in
// is a login wall, and the navigation is the corroboration the static matcher
// lacks. Used nowhere else.
const SIGNIN_MENTION = /(sign-?in|log-?in|logon|authenticate|sso|oauth)/i;

function rendererAvailable() {
  if (!fs.existsSync(RENDER_PROBE)) return false;
  try {
    return pythonEnv.resolve('audit').ok;
  } catch {
    return false;
  }
}

// Renders one URL and returns the probe's JSON, or null. Never throws: a
// renderer that fails must leave the static verdict standing, not break a run.
function renderProbe(url, auth, { timeoutMs = 45000, settleMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let env;
    try {
      env = pythonEnv.resolve('audit');
      if (!env.ok) return resolve(null);
    } catch {
      return resolve(null);
    }
    let child;
    try {
      child = spawn(env.bin, [
        ...env.args, '-u', RENDER_PROBE, url,
        '--timeout-ms', String(Math.max(5000, timeoutMs - 10000)),
        '--settle-ms', String(settleMs),
      ], {
        cwd: path.dirname(RENDER_PROBE),
        windowsHide: true,
        env: { ...process.env, ...toEnv(auth) },
      });
    } catch {
      return resolve(null);
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const start = out.lastIndexOf('{');
      if (start < 0) return resolve(null);
      try {
        const parsed = JSON.parse(out.slice(start));
        resolve(parsed && parsed.ok ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    return undefined;
  });
}

// Does the static verdict deserve a second look in a browser?
//
// The first version required hardly any text AND hardly any links, and it
// missed the reference case: app.slack.com/client serves 146 words and 18 nav
// links in its shell, so the link half of the test was never true and the
// renderer never ran.
//
// What actually characterises a shell is that the TEXT is not there — a page
// with under 150 visible words has no content to audit whatever its nav looks
// like — or that the page declares a redirect it expects a client to follow.
// Slack does both. Either is enough to spend one browser launch on; a real
// page with real copy never pays for it.
//
// This is also the same threshold the audit crawler itself uses to decide a
// page is a JavaScript shell, so the two agree about what "thin" means.
function looksLikeShell(probe) {
  if (!probe || !probe.ok) return false;
  if (probe.metaRefresh) return true;
  return probe.words != null && probe.words < 150;
}

// ==========================================================================
// Post-run coverage
// ==========================================================================

// The second half of the guard: a crawl that got past the seed can still be
// walled a level down (a public homepage in front of a gated app). Comparing
// what was crawled against what the sitemap advertises catches that, and costs
// one request.
//
// Deliberately reported as a NOTE on the run, not as a failure: a sitemap
// legitimately lists more URLs than a capped crawl visits, so this cannot be
// a hard gate without producing false alarms on every `--max-pages` limit.
async function coverage(siteUrl, pagesCrawled, { maxPages = null, auth = null } = {}) {
  let sitemap = null;
  try {
    sitemap = await fetcher.fetchSitemapUrls(siteUrl, { limit: 5000, headers: toHeaders(auth) });
  } catch {
    return null;
  }
  const total = sitemap && Array.isArray(sitemap.urls) ? sitemap.urls.length : 0;
  // No sitemap, or an unreadable one, is not evidence either way — and this
  // check must never turn "I could not tell" into a warning.
  if (!total) return null;

  // Only meaningful when the crawl was NOT the thing that stopped early.
  const capped = maxPages != null && pagesCrawled >= maxPages;
  const ratio = pagesCrawled / total;
  const shortfall = !capped && total >= 10 && ratio < 0.5;

  return {
    sitemapUrls: total,
    pagesCrawled,
    ratio,
    capped,
    shortfall,
    note: shortfall
      ? `The sitemap lists ${total} URLs but the crawl read ${pagesCrawled}. `
        + 'Something is stopping the crawler part-way through the site — commonly a gated section, '
        + 'a robots rule, or pages reachable only from a logged-in navigation.'
      : null,
  };
}

module.exports = {
  fromForm, parseHeaderLines, isEmpty, describe, toHeaders, toArgs, toEnv, merge,
  AUTH_ENV_VAR,
  isBlocking, BLOCKING_WALLS, rendererAvailable, renderProbe, looksLikeShell,
  // Exported for the verify suite: the path matcher is table-tested there,
  // because its failure mode is silent in both directions — a missed wall, or
  // a public page mistaken for one.
  LOGIN_PATH, LOGIN_SEGMENTS, countInternalLinks, DEAD_END_LINKS, pathForMatch,
  forBrand, statusForBrand, save, clear, recordVerification,
  probe, remedyFor, REMEDY, coverage,
};
