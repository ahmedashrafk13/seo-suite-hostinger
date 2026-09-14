// CLIENT SHARE LINKS for a weekly report.
//
// WHY A LINK AND NOT A CLIENT LOGIN
// The obvious feature request here is "give the client an account". This app
// deliberately does not have one, and lib/team.js states the reason: only the
// SEO team holds logins, because a client account is a password that will be
// reused and leaked, an inbox to reset it from, and a permission surface over a
// workspace that contains every OTHER client's data. A share link inverts all
// three - it grants exactly one report, it can be revoked in one click, and
// nothing about it can be escalated, because there is nothing behind it to
// escalate to.
//
// WHAT THE LINK IS
// 32 bytes of crypto.randomBytes, base64url. Stored as a SHA-256 hash, so the
// database cannot hand out working links even to someone who reads it, and the
// plaintext is shown once at creation. The token is the whole credential - this
// is a capability URL - which is why:
//  - it is long enough not to be guessable (256 bits; enumeration is not a
//     threat model, it is arithmetic),
//  - the shared page is served `noindex` and `Referrer-Policy: no-referrer`,
//     so it does not end up in a search index or leak through an outbound
//     click,
//  - it can be given an expiry date, and
//  - it carries NO personally identifying lead data (see lib/leads.js), on the
//     principle that a URL forwarded to a client is a URL forwarded onwards.
const crypto = require('crypto');
const db = require('../db');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function mint() {
  return crypto.randomBytes(32).toString('base64url');
}

// Creates a link for a report the caller owns. Returns the row plus the
// plaintext token, which is the only time it exists.
function create(reportId, userId, { label = null, expiresOn = null, createdBy = null } = {}) {
  const report = db.prepare('SELECT id FROM weekly_reports WHERE id=? AND user_id=?').get(reportId, userId);
  if (!report) throw new Error('Report not found.');
  const token = mint();
  const info = db.prepare(`INSERT INTO report_shares
      (user_id, report_id, token_hash, token_hint, label, expires_on, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, reportId, hashToken(token), token.slice(-6), label || null,
      expiresOn || null, createdBy || userId);
  return { id: Number(info.lastInsertRowid), token };
}

function listFor(reportId, userId) {
  return db.prepare(`SELECT s.*, u.email created_by_email
    FROM report_shares s LEFT JOIN users u ON u.id=s.created_by
    WHERE s.report_id=? AND s.user_id=? ORDER BY s.created_at DESC`).all(reportId, userId);
}

function listAll(userId, limit = 100) {
  return db.prepare(`SELECT s.*, r.period_start, r.period_end, b.name brand_name
    FROM report_shares s
    JOIN weekly_reports r ON r.id=s.report_id
    JOIN brands b ON b.id=r.brand_id
    WHERE s.user_id=? ORDER BY s.created_at DESC LIMIT ?`).all(userId, limit);
}

function revoke(shareId, userId) {
  db.prepare(`UPDATE report_shares SET revoked_at=datetime('now')
    WHERE id=? AND user_id=? AND revoked_at IS NULL`).run(shareId, userId);
}

// Reasons a link can fail, kept as distinct values rather than one boolean,
// because the page shown to a client has to say which: "this link expired on
// 3 March, ask for a new one" is a message a client can act on, and "not found"
// on a link their agency definitely sent them is a support call.
const INVALID = 'invalid';
const EXPIRED = 'expired';
const REVOKED = 'revoked';

// Resolves a token to its report. Called by the public route, so it is the only
// function here that is reachable without a session.
function resolve(token) {
  const t = String(token || '').trim();
  // Length is checked first so that a scan of random short strings costs a
  // string comparison rather than a hash and a query.
  if (t.length < 20 || t.length > 100) return { ok: false, reason: INVALID };
  const share = db.prepare('SELECT * FROM report_shares WHERE token_hash=?').get(hashToken(t));
  if (!share) return { ok: false, reason: INVALID };
  if (share.revoked_at) return { ok: false, reason: REVOKED, share };
  if (share.expires_on && share.expires_on < new Date().toISOString().slice(0, 10)) {
    return { ok: false, reason: EXPIRED, share };
  }
  const report = db.prepare(`SELECT r.*, b.name brand_name, b.site_url, b.id brand_id,
      b.report_company, b.report_logo_url, b.report_accent, b.report_footer, b.report_contact
    FROM weekly_reports r JOIN brands b ON b.id=r.brand_id WHERE r.id=?`).get(share.report_id);
  // A report deleted after its link was sent: the link is dead, and saying so
  // as "invalid" is honest - there is nothing to show and nothing to fix.
  if (!report) return { ok: false, reason: INVALID, share };
  try { report.data = JSON.parse(report.data_json); } catch { report.data = null; }
  if (!report.data) return { ok: false, reason: INVALID, share };
  return { ok: true, share, report };
}

// Recorded on every view, not just the first.
//
// This is the single most-used field in the whole feature and it is worth
// saying why: an agency's real question about a report is not what is in it,
// it is whether the client opened it. A view count and a last-viewed timestamp
// answer that, and they are also the honest counter-evidence when a client says
// they never received it.
function recordView(shareId) {
  db.prepare(`UPDATE report_shares SET views=views+1, last_viewed_at=datetime('now') WHERE id=?`)
    .run(shareId);
}

// The commentary a specialist writes on a report. Stored on the report itself
// rather than per share link, so the report page, the print view and every
// share link render one narrative instead of three drafts of it - which is what
// the column was added for.
function setCommentary(reportId, userId, text) {
  const value = String(text || '').trim().slice(0, 20_000) || null;
  db.prepare(`UPDATE weekly_reports SET commentary=?, commentary_updated_at=datetime('now')
    WHERE id=? AND user_id=?`).run(value, reportId, userId);
}

module.exports = {
  create, listFor, listAll, revoke, resolve, recordView, setCommentary,
  INVALID, EXPIRED, REVOKED,
};
