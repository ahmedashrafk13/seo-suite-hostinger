// Cross-site request forgery protection for the form posts.
//
// WHY THIS IS NEEDED WHEN THE COOKIE IS ALREADY SameSite=Lax
// Lax stops a cross-site POST from carrying the session cookie in every
// current browser, which covers the classic attack. It is not the whole story:
//  - Lax is a browser behaviour, not a server check. An older browser, a
//     WebView with a relaxed policy, or a future flag flip removes it silently
//     and nothing here would notice.
//  - Lax does not isolate same-site origins. Anything served from a sibling
//     subdomain of the deployment (a staging host, a client microsite, a
//     hijacked marketing subdomain) is "same-site" and its forms would post
//     with a valid session.
// A synchronizer token is a server-side check that holds in both cases, so the
// guarantee stops depending on how the visitor's browser is configured.
//
// SHAPE
// One token per session, kept in the session row, echoed into every POST form
// by `csrfField` and required back on every state-changing request. It is not
// rotated per request: rotation breaks the back button and any second tab
// holding an older page, and buys nothing here because the token is never
// exposed to a third party (no cross-origin GET can read a rendered page).
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FIELD = '_csrf';

function mint() {
  return crypto.randomBytes(32).toString('base64url');
}

// The token for this session, created on first use. Sessions predating this
// change simply gain one on their next request rather than being invalidated.
function tokenFor(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) req.session.csrfToken = mint();
  return req.session.csrfToken;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  // Length is compared first because timingSafeEqual throws on a mismatch.
  // The length of a token is not a secret - every one of them is 43 bytes.
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Exposes the token to templates. Mounted with the rest of the view globals so
// it is available on the login and sign-up pages too, which are rendered
// before anyone is authenticated.
function expose(req, res, next) {
  const token = tokenFor(req);
  res.locals.csrfToken = token;
  // Templates insert this rather than hand-writing the input, so the field
  // name lives in exactly one place.
  res.locals.csrfField = `<input type="hidden" name="${FIELD}" value="${token}">`;
  next();
}

// Rejects a state-changing request that does not carry the session's token.
// Mount AFTER any route that authenticates by shared secret instead of by
// session (/internal/cron), which has no session to hold a token.
function verify(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const supplied =
    (req.body && req.body[FIELD]) ||
    req.get('x-csrf-token') ||
    req.query[FIELD];

  if (sameToken(supplied, req.session && req.session.csrfToken)) return next();

  // 403 rather than a redirect: a redirect to the login page would look like
  // an expired session and invite the user to retry the same broken post
  // forever. The message names the ordinary cause, because that is what this
  // almost always is - a form left open past a session expiry.
  return res.status(403).render('error', {
    title: 'Request could not be verified',
    active: null,
    message: 'This form was submitted with an expired or missing security token. '
      + 'That usually means the page sat open for a long time. Reload the page and try again.',
    stack: null,
  });
}

// A session must not keep its token across a privilege change: the same token
// living either side of a login is what lets a fixed session be reused. Called
// by the login/sign-up handlers after regenerating the session.
function rotate(req) {
  if (req.session) req.session.csrfToken = mint();
}

module.exports = { expose, verify, rotate, tokenFor, FIELD };
