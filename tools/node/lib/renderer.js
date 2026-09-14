// Fetching a page the way a BROWSER sees it, for the crawlers that cannot
// execute JavaScript.
//
// THE PROBLEM. Every crawler in this app reads raw HTML (see fetcher.js) and
// runs no JavaScript. jsRendering.js can already PROVE which pages that breaks
// - it diffs Chrome's rendered element count, via the PageSpeed report, against
// the raw HTML - but proving it was as far as the app could go. On a React,
// Angular or Vue site that ships an empty shell, the internal-linking crawler
// reads zero anchors, the on-page audit reads zero words, and every content
// check downstream measures the shell instead of the page.
//
// WHY AN API AND NOT A HEADLESS BROWSER. This deployment target is Hostinger
// shared Node hosting: no root, no apt, no compiler, and Passenger stops the
// app when it goes idle. Chromium cannot be installed and could not stay
// resident if it were. A rendering API is the only path that works here, and
// it is also the cheaper one at this app's volume - rendering is billed per
// page, and jsRendering.js lets us render only the pages that need it rather
// than the whole crawl.
//
// WHAT THIS IS NOT. It is not a general proxy and it is not on by default.
// Rendering costs money per page, so it is opt-in per call (`render: true`),
// and fetchPage falls back to the raw fetch on any failure rather than letting
// a rendering outage take an audit down with it.
const { URL } = require('url');

// ZenRows is the provider this is written against. The shape - one GET, the
// target URL as a query parameter, HTML back in the body - is common to
// ScraperAPI and ScrapingBee too, so swapping providers is a change to
// buildUrl() and nothing else.
// Overridable so the budget tests can point at a local stub and count every
// paid call exactly, rather than proving the spending rules with real credits.
const ENDPOINT = process.env.ZENROWS_ENDPOINT || 'https://api.zenrows.com/v1/';
function endpoint() { return process.env.ZENROWS_ENDPOINT || ENDPOINT; }

// Rendering runs a real browser on someone else's machine: a page that takes
// 2s to fetch can take 15s to render. The raw-fetch default of 20s would time
// out on perfectly healthy pages and look like a provider failure.
const DEFAULT_TIMEOUT = 45000;

// How long to let the page settle after load before the DOM is read.
//
// This is not padding. A framework app reaches `load` with its shell mounted
// and its data still in flight, so reading the DOM at that instant returns a
// half-built page - which scores WORSE than the raw HTML in the one way that
// matters, by looking like a real reading when it is not. Measured against a
// live Angular app, no wait returned 6 links; this returns the full navigation.
const DEFAULT_WAIT_MS = 2500;

// ==========================================================================
// The key pool
// ==========================================================================
//
// More than one account can be configured. Keys are drained IN ORDER, not
// round-robined: the first key is used until the provider says it is finished,
// then the next takes over. Spreading load across keys would leave every
// account part-used and none of them cleanly exhausted, which makes "how much
// is left" impossible to answer.
//
// A retired key stays retired for the life of the process only. Allowances
// reset on the provider's billing period, and a restart re-reads the pool, so
// nothing here writes a key off permanently.
const RETIRED = new Map();

function keys() {
  const many = String(process.env.ZENROWS_API_KEYS || '').split(',');
  const one = String(process.env.ZENROWS_API_KEY || '');
  return [...many, one].map((k) => k.trim()).filter(Boolean)
    // The same key listed twice would otherwise be tried twice on failover,
    // spending a second credit to learn what the first already proved.
    .filter((k, i, all) => all.indexOf(k) === i);
}

function apiKey() {
  return keys().find((k) => !RETIRED.has(k)) || '';
}

// Rendering is enabled only when a live key is present. There is deliberately
// no separate on/off flag: a missing key and a disabled feature are the same
// state, and two settings that can disagree is one more way to be silently off.
function isEnabled() {
  return apiKey().length > 0;
}

// What a provider error means for the KEY, as opposed to for the page.
//
// This distinction is the whole point of the pool. An exhausted account should
// hand over to the next key; a blocked or missing target should not, because
// retrying a doomed URL against every key in turn spends a credit per key to
// learn the same thing each time. Getting this backwards is how a key pool
// turns into a way to burn three allowances instead of one.
//
//   retire  - this key is finished; never use it again this process
//   rotate  - this key is busy right now; try another, but keep this one
//   target  - the page is the problem, not the key; do not try another
function classify(message) {
  const m = String(message || '');
  if (/AUTH004|AUTH005/.test(m)) return 'retire';   // allowance spent / expired
  if (/AUTH001|AUTH002|AUTH003/.test(m)) return 'retire'; // missing / malformed / unknown key
  if (/AUTH006|AUTH008/.test(m)) return 'rotate';   // concurrency or rate limit
  return 'target';
}

function retire(key, why) {
  if (key) RETIRED.set(key, why || 'retired');
}

// For the status line and for tests: how much of the pool is left.
function poolStatus() {
  const all = keys();
  return {
    total: all.length,
    live: all.filter((k) => !RETIRED.has(k)).length,
    retired: all.filter((k) => RETIRED.has(k)).map((k) => ({ key: mask(k), why: RETIRED.get(k) })),
  };
}

// Keys are secrets. Anything that can reach a log, a report or the UI shows
// the masked form, never the key.
function mask(k) {
  const s = String(k || '');
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// Test seam only: forget every retirement.
function resetPool() { RETIRED.clear(); }

// Build the provider request for one target URL.
//
// `premium` buys residential proxies at roughly ten times the credit cost. It
// is off by default and should stay off: the targets here are clients' own
// marketing sites, not bot-hardened marketplaces.
function buildUrl(target, { premium = false, waitMs = DEFAULT_WAIT_MS, country = null, key = null } = {}) {
  const useKey = key || apiKey();
  if (!useKey) throw new Error('no live ZenRows key: set ZENROWS_API_KEY or ZENROWS_API_KEYS');
  const u = new URL(endpoint());
  u.searchParams.set('apikey', useKey);
  u.searchParams.set('url', target);
  u.searchParams.set('js_render', 'true');
  if (waitMs > 0) u.searchParams.set('wait', String(waitMs));
  if (premium) u.searchParams.set('premium_proxy', 'true');
  if (country) u.searchParams.set('proxy_country', country);
  return u.toString();
}

// Did the provider hand back an error document instead of the page?
//
// This matters more than it looks. ZenRows reports its own failures as a JSON
// body, sometimes with a 2xx envelope. Treating that as page content would not
// throw anywhere - it would quietly score a client's homepage as a 300-byte
// page with no headings and no links, which is exactly the false reading this
// whole feature exists to remove.
function providerError(body, status) {
  const text = String(body || '').trim();
  if (!text) return status >= 400 ? `provider returned ${status} with an empty body` : null;
  if (text[0] !== '{') return null;
  try {
    const j = JSON.parse(text);
    if (j && (j.code || j.title)) return `${j.code || 'error'}: ${j.title || j.detail || 'request rejected'}`;
  } catch (e) { /* not JSON after all - it is a page that happens to start with a brace */ }
  return null;
}

// Credentials and rendering must never mix.
//
// Authenticated crawls carry the client's own session cookie or Basic auth.
// Sending those to a third-party rendering service would hand a client's
// logged-in session to a vendor, so a call that has credentials in scope does
// not get rendered - it falls back to the raw fetch, which keeps the
// credential inside the scopedAuth rules fetchPage already enforces.
function refuseForAuth(auth) {
  return auth ? 'not rendered: the run carries site credentials, which are never sent to a third party' : null;
}

// ==========================================================================
// One rendered page, with failover
// ==========================================================================
//
// The transport is injected rather than required, because fetcher.js owns the
// HTTP layer (byte caps, broken-certificate tolerance, redirect chains) and
// two independent HTTP clients in one process is how those behaviours drift
// apart.
//
// Returns { res, key, attempts } on success, or throws the last error. The
// caller is expected to fall back to a raw fetch on a throw: a rendering
// outage must not take an audit down with it.
async function renderPage(target, opts, transport) {
  const { fetchUrl, decodeBody } = transport;
  const tried = [];
  let lastError = null;

  // Bounded by the pool, so a provider stuck on "rate limited" cannot spin.
  for (let i = 0; i < keys().length; i += 1) {
    // The next key that is live AND has not already been tried on this page.
    //
    // It cannot simply be apiKey(): a 'rotate' verdict deliberately leaves the
    // key in the pool, so apiKey() would hand back the same rate-limited key
    // and the loop would stall on it instead of failing over.
    const key = keys().find((k) => !RETIRED.has(k) && !tried.includes(k));
    if (!key) break;
    tried.push(key);

    let res = null;
    try {
      res = await fetchUrl(buildUrl(target, { ...opts, key }), {
        timeout: Math.max(opts.timeout || 0, DEFAULT_TIMEOUT),
        headers: { 'User-Agent': opts.ua },
        ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
      });
    } catch (err) {
      // A transport failure says nothing about the key, so it is not grounds
      // for retiring one. Trying the next key would spend a credit chasing a
      // network problem.
      lastError = `${err.kind || 'error'}: ${String(err.message).slice(0, 120)}`;
      break;
    }

    const perr = providerError(res.body ? decodeBody(res) : '', res.status);
    if (!perr) return { res, key, attempts: tried.length };

    lastError = perr;
    const verdict = classify(perr);
    if (verdict === 'target') break;             // the page is the problem - stop
    if (verdict === 'retire') retire(key, perr); // spent or invalid - hand over
    // 'rotate' leaves the key live and simply tries the next one.
  }

  const err = new Error(lastError || 'no live rendering key');
  err.attempts = tried.length;
  throw err;
}

// ==========================================================================
// Spending a credit only when the page actually needs one
// ==========================================================================
//
// Rendering is billed per page, so the question "does this page need it?" has
// to be answered from the raw HTML we already paid nothing for. Getting it
// wrong in one direction renders a whole server-rendered site for no reason;
// in the other it leaves a shell unrendered and the audit reports a blank page.
//
// The signature of a shell is specific and does not need a browser to see:
// a framework mount point is present, and almost no readable text is. Neither
// half is enough alone - plenty of server-rendered sites mount React for
// interactivity, and plenty of thin pages are genuinely thin - so both are
// required, which is what keeps this from firing on ordinary sites.
const MOUNT_RE = /(<[a-z-]*\s[^>]*\b(?:id=["'](?:__next|__nuxt|root|app)["']|data-reactroot|data-server-rendered)|<astro-island|<app-root)/i;

// Below this many visible words a page is not making a claim worth measuring.
// It is the same floor jsRendering.js uses, deliberately: two different
// answers to "is this page empty?" in one codebase is a bug waiting to happen.
const SHELL_WORDS = 120;

// Strip the parts of the document that are not readable text. Without this a
// shell scores thousands of "words" from its own inlined JavaScript bundle and
// never looks empty.
function visibleWordCount(html) {
  const text = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

// Does this raw HTML look like a shell whose content arrives via JavaScript?
function looksLikeShell(html) {
  const s2 = String(html || '');
  if (!s2) return false;
  if (!MOUNT_RE.test(s2)) return false;
  return visibleWordCount(s2) < SHELL_WORDS;
}

// ==========================================================================
// The per-run budget
// ==========================================================================
//
// A budget exists because a detector can be wrong, and being wrong on a
// 500-page crawl is the difference between cents and a real bill. This is the
// backstop that makes the worst case knowable in advance rather than
// discovered on an invoice.
function budgetFor(maxPages) {
  // An UNSET variable and a variable set to zero mean opposite things, and
  // Number('') is 0 - so an empty `RENDER_BUDGET=` line in .env would read as
  // a deliberate "render nothing" and disable the feature with no error
  // anywhere. The emptiness is tested before the number is.
  const raw = String(process.env.RENDER_BUDGET || '').trim();
  if (raw !== '') {
    const env = Number(raw);
    if (Number.isFinite(env) && env >= 0) return env;
  }
  // Default: a quarter of the crawl. A site where more than a quarter of
  // pages are shells is a fully client-rendered site, and that is a decision
  // to take deliberately by raising RENDER_BUDGET, not one to make by
  // accident at half a cent a page.
  return Math.max(20, Math.ceil(Number(maxPages || 0) * 0.25));
}

// A run's spending state. One per crawl.
function newBudget(maxPages) {
  return {
    limit: budgetFor(maxPages),
    used: 0,
    skippedForBudget: 0,
    // Set once the first shell is seen. Until then, a site is assumed
    // server-rendered and costs nothing.
    siteNeedsRendering: false,
    canSpend() { return isEnabled() && this.used < this.limit; },
    spend() { this.used += 1; this.siteNeedsRendering = true; },
    deny() { this.skippedForBudget += 1; },
  };
}

module.exports = {
  ENDPOINT, endpoint, DEFAULT_TIMEOUT, DEFAULT_WAIT_MS, isEnabled, buildUrl, providerError,
  refuseForAuth, apiKey, keys, classify, retire, poolStatus, mask, resetPool, renderPage,
  looksLikeShell, visibleWordCount, newBudget, budgetFor, SHELL_WORDS,
};
