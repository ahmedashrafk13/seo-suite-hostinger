// Response security headers.
//
// This app audits other people's sites for exactly these headers
// (lib/aiseo/readiness.js flags a missing CSP and a missing HSTS as findings)
// while serving none of its own. It also holds the most sensitive data in the
// stack: Google OAuth refresh tokens for every connected client property, an
// SMTP password, and per-client API credentials. So the headers are set here.
//
// THE CSP IS DELIBERATELY NOT NONCE-BASED
// The views carry ~20 inline <script> blocks, ~660 inline style attributes and
// ~28 inline event handlers. A nonce covers the script blocks but not the
// handlers (nonces do not apply to attributes), so a strict policy would need
// 'unsafe-hashes' plus a hash per handler — a policy that breaks silently on
// the next markup edit and gets switched off in a hurry. What is set instead
// keeps 'unsafe-inline' for scripts and styles and spends the policy on the
// directives that still bite with inline code allowed:
//
//   frame-ancestors 'none'  no clickjacking an admin into approving a member
//   form-action 'self'      an injected <form> cannot post a session or an
//                           OAuth code to an attacker's host
//   base-uri 'self'         an injected <base> cannot re-point every relative
//                           script URL on the page at another origin
//   object-src 'none'       no Flash/PDF-plugin execution paths
//   script-src allowlist    an injected <script src> can only load from this
//                           origin or the pinned CDN, not from anywhere
//
// CSP_REPORT_ONLY=1 sends the same policy as Content-Security-Policy-Report-Only
// so a stricter draft can be trialled against real traffic before it enforces.

const CDN = 'https://cdn.jsdelivr.net';
const FONTS_CSS = 'https://fonts.googleapis.com';
const FONTS_FILES = 'https://fonts.gstatic.com';

const POLICY = [
  "default-src 'self'",
  // 'unsafe-inline' is load-bearing here — see the note above.
  `script-src 'self' 'unsafe-inline' ${CDN}`,
  `style-src 'self' 'unsafe-inline' ${FONTS_CSS} ${CDN}`,
  `font-src 'self' ${FONTS_FILES} data:`,
  // data: for the inline SVG favicon; https: because report screenshots and
  // brand logos are fetched from the client sites being audited.
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders({ behindProxy = false } = {}) {
  const reportOnly = process.env.CSP_REPORT_ONLY === '1';
  const cspHeader = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

  return function setSecurityHeaders(req, res, next) {
    res.setHeader(cspHeader, POLICY);
    // Stops a downloaded audit .xlsx or a JSON response from being sniffed
    // into something the browser will execute.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Belt to frame-ancestors, for anything that still only reads this one.
    res.setHeader('X-Frame-Options', 'DENY');
    // Referrers leak run ids and brand ids in paths like
    // /ai-seo/readiness/1421. Send the origin only, and only to HTTPS.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Only when TLS is actually terminated in front of the app. Sending HSTS
    // over plain HTTP is ignored by browsers, but sending it from a local
    // dev server that shares a hostname with anything else would pin that
    // hostname to HTTPS in the developer's browser for a year.
    if (behindProxy) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

module.exports = securityHeaders;
module.exports.POLICY = POLICY;
