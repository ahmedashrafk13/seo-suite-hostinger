// HTTP client for the crawlers.
//
// Built on node:http/node:https rather than global fetch because the crawlers
// need three things fetch does not expose:
//
//   1. The redirect chain. Several checks — "sitemap URL redirects elsewhere",
//      "internal link points at a 301" — depend on knowing each hop's status,
//      and fetch collapses redirects into a final response with no history.
//      Following them manually is the only way to see them.
//   2. TLS errors ignored. The Python original passes verify=False: a site with
//      an expired certificate must still be auditable, since that is precisely
//      the kind of problem the audit exists to report.
//   3. A byte cap on the response. Reading a 200MB video into memory to check
//      whether a link resolves would end the process on a shared host with a
//      small memory allowance.
//
// The interface mirrors what the Python code used from `requests`: a response
// carrying status, final url, headers, text and the redirect history.
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Upgrade-Insecure-Requests': '1',
};

// ------------------------------------------------------------ credentials
//
// Headers the crawl must send on every request to be served anything at all:
// a session cookie for a members-only site, HTTP basic auth for a staging
// build, or whatever header a CDN's rules expect. Set once from the command
// line (--cookie / --header) before the crawl starts.
//
// Module-level rather than threaded through every call site because there are
// dozens of them across both ports (pages, robots.txt, sitemaps, link checks,
// asset checks, host variants) and a credential that reaches only some of them
// is worse than none: the crawl half-works and the report is a mix of real
// pages and login pages. One place means every request carries it.
let AUTH_HEADERS = {};

// The site the credentials belong to. They are attached ONLY to requests for
// this site, and to nothing else.
//
// WHY, and this was a real leak: the audit checks every external link a page
// points at, and crawls follow cross-origin redirects. With the headers merged
// into every request unconditionally, a client's live session cookie was sent
// to every third-party domain the site links to — proven with a fixture that
// recorded `cookie=sess=SECRET` arriving at a partner domain. Handing a
// client's session to strangers is a worse outcome than any crawl gap, so an
// UNBOUND credential set is now attached to nothing at all: fail safe, not
// fail open.
let AUTH_SITE = '';

// The credential scope key — deliberately NOT hostKey().
//
// hostKey() is the crawler's site-grouping key and drops the port, because for
// grouping pages a port is noise. For credentials it is not: two services on
// one host are two different systems, and the first version of this leaked a
// cookie between them (caught by a fixture running the client site and a
// "partner" site on 127.0.0.1 under different ports — hostKey saw one site).
// A credential scope must be at least as strict as the browser's, so the port
// is kept. `www.` is still folded away, because a login cookie genuinely has
// to work across www and non-www and the audit probes both host variants.
function authSiteKey(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}`;
  } catch {
    return '';
  }
}

function setAuthHeaders(headers, site = '') {
  AUTH_HEADERS = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    if (k && v != null && !/[\r\n]/.test(String(v))) AUTH_HEADERS[k] = String(v);
  });
  if (site) AUTH_SITE = authSiteKey(site);
  return AUTH_HEADERS;
}

// Called by each port once it knows its seed URL.
function bindAuthSite(url) {
  AUTH_SITE = authSiteKey(url);
  return AUTH_SITE;
}

// Credentials for this URL, or null. A CDN, a partner, an analytics domain or
// any cross-origin redirect target gets null.
function authFor(url) {
  if (!AUTH_SITE || !Object.keys(AUTH_HEADERS).length) return null;
  return authSiteKey(url) === AUTH_SITE ? AUTH_HEADERS : null;
}

function authHeaderNames() {
  return Object.keys(AUTH_HEADERS);
}

// Parses the shared `--cookie` / `--header` flags out of an argv array, so both
// ports get identical behaviour from one implementation. Returns the argv with
// those flags removed, leaving each port's own parser untouched.
function takeAuthArgs(argv) {
  const rest = [];
  // The environment is the transport the app itself uses: on shared hosting
  // /proc/<pid>/cmdline is world-readable and environ is not, so a session
  // cookie does not belong in argv. Flags still win, because an explicit
  // argument should always beat an inherited one.
  const headers = {};
  try {
    const fromEnv = JSON.parse(process.env.CRAWL_AUTH_HEADERS || '{}');
    Object.entries(fromEnv).forEach(([k, v]) => {
      if (k && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
    });
  } catch { /* a malformed value must never stop a crawl */ }
  let cookie = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cookie') {
      cookie = String(argv[i + 1] || '');
      i += 1;
    } else if (a === '--header' || a === '-H') {
      const raw = String(argv[i + 1] || '');
      i += 1;
      const idx = raw.indexOf(':');
      if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    } else {
      rest.push(a);
    }
  }
  if (cookie) headers.Cookie = cookie;
  setAuthHeaders(headers);
  return { argv: rest, headers: AUTH_HEADERS };
}

// Connections are pooled and kept alive. Without this every request pays a
// fresh TCP + TLS handshake, which on a 200-page crawl is the dominant cost.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });

const MAX_REDIRECTS = 10;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'timeout' | 'connection' | 'ssl' | 'redirect_loop' | 'other'
  }
}

function classify(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || err.kind === 'timeout') return 'timeout';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'EPROTO'
      || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'ssl';
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET'
      || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'connection';
  return 'other';
}

// One request, no redirect following.
// `body` was added for the JSON APIs the keyword-metrics adapters call
// (DataForSEO, Google Ads). It is written before req.end() and its length is
// declared, because both of those endpoints reject a chunked request without a
// Content-Length. A GET with no body behaves exactly as it did before.
// Per-call credentials, scoped the same way the module-level ones are.
//
// This exists for the app (as opposed to the standalone crawlers), which is
// long-lived and runs two analyses at once: module-level credentials would let
// one brand's cookie be sent to another brand's site. Passing them per call and
// evaluating the scope against EACH hop's URL keeps a cross-origin redirect
// from carrying them off-site, which is the vector a caller cannot guard
// against on its own — fetchUrl follows redirects internally.
function scopedAuthFor(url, scopedAuth) {
  if (!scopedAuth || !scopedAuth.headers || !scopedAuth.site) return null;
  if (!Object.keys(scopedAuth.headers).length) return null;
  return authSiteKey(url) === authSiteKey(scopedAuth.site) ? scopedAuth.headers : null;
}

function requestOnce(url, {
  method = 'GET', timeout = 20000, headers = {}, maxBytes = DEFAULT_MAX_BYTES, body = null,
  scopedAuth = null,
}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new HttpError(`Invalid URL: ${url}`, 'other'));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new HttpError(`Unsupported protocol: ${target.protocol}`, 'other'));
      return;
    }
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...BROWSER_HEADERS,
          // Credentials sit between the defaults and the per-call headers: a
          // call that deliberately sets a header (the AI-crawler checks send
          // their own User-Agent) still wins, but nothing has to remember to
          // pass the session cookie.
          // Attached per-URL, and only for the site they belong to — see
          // authFor(). Never to an external link or a cross-origin redirect.
          ...(authFor(target.href) || {}),
          ...(scopedAuthFor(target.href, scopedAuth) || {}),
          ...headers,
          host: target.host,
          ...(body != null
            ? { 'content-length': String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body), 'utf8')) }
            : {}),
        },
        agent: isHttps ? httpsAgent : httpAgent,
        // Redirects are followed by the caller so the chain stays visible.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let aborted = false;

        // Decompression must match the Content-Encoding the server actually
        // used, not the one requested — some servers ignore Accept-Encoding.
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        stream.on('data', (chunk) => {
          if (aborted) return;
          size += chunk.length;
          if (size > maxBytes) {
            // Enough has been read to judge the response; stop paying for the rest.
            aborted = true;
            chunks.push(chunk);
            req.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', (err) => {
          // A truncated gzip stream after a deliberate abort is expected.
          if (aborted) return;
          reject(new HttpError(err.message, classify(err)));
        });
        stream.on('end', finish);

        let finished = false;
        function finish() {
          if (finished) return;
          finished = true;
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            url: target.href,
            location: res.headers.location || null,
          });
        }
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy(new HttpError(`Timeout after ${timeout}ms`, 'timeout'));
    });
    req.on('error', (err) => {
      reject(err instanceof HttpError ? err : new HttpError(err.message, classify(err)));
    });
    if (body != null) req.write(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    req.end();
  });
}

// Follows redirects, recording each hop — the equivalent of requests'
// `response.history`.
async function fetchUrl(url, options = {}) {
  const history = [];
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await requestOnce(current, options);
    const isRedirect = res.status >= 300 && res.status < 400 && res.location;
    if (!isRedirect) {
      return { ...res, url: current, history };
    }
    history.push({ status: res.status, url: current });
    let next;
    try {
      next = new URL(res.location, current).href;
    } catch {
      return { ...res, url: current, history };
    }
    // A redirect to itself never terminates.
    if (next === current) throw new HttpError('Redirect loop', 'redirect_loop');
    current = next;
  }
  throw new HttpError('Too many redirects', 'redirect_loop');
}

// Decodes a response body to text, honouring the charset the server declared
// and falling back to UTF-8. Latin-1 pages are common on older sites and
// decoding them as UTF-8 turns every accented character into a replacement
// character, which then corrupts word counts and duplicate detection.
function decodeBody(res) {
  const ctype = String(res.headers['content-type'] || '');
  const m = /charset=["']?([\w-]+)/i.exec(ctype);
  let charset = (m ? m[1] : 'utf-8').toLowerCase();
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
    charset = 'latin1';
  } else if (!['utf-8', 'utf8', 'ascii', 'latin1'].includes(charset)) {
    charset = 'utf-8';
  }
  try {
    return res.body.toString(charset === 'utf-8' ? 'utf8' : charset);
  } catch {
    return res.body.toString('utf8');
  }
}

// Runs `worker` over `items` with a fixed concurrency, preserving input order
// in the results — the equivalent of ThreadPoolExecutor.map(). Rejections are
// returned as values so one bad URL cannot abort a whole crawl wave.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { __error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  UA, BROWSER_HEADERS, HttpError,
  fetchUrl, requestOnce, decodeBody, mapLimit, sleep, classify,
  setAuthHeaders, authHeaderNames, takeAuthArgs, bindAuthSite, authFor,
  authSiteKey, scopedAuthFor,
};
