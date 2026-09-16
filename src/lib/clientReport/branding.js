// AGENCY BRANDING for client-facing documents.
//
// WHY THIS IS NOT THE BRAND-LEVEL BRANDING ALREADY IN THE APP
// brands.report_company / report_logo_url / report_accent brand a WEEKLY
// report, and they are per brand because a white-label reseller sends one
// client's report under one badge and another's under a different one.
//
// A client report is written about a PROSPECT. There is no brand row for a
// prospect - that is the whole point of the feature - so there is nothing to
// hang per-brand branding on. What the document needs is the AGENCY's own
// identity, which is the same on every prospect document and should be typed
// once.
//
// Stored in app_settings, which is keyed (user_id, key) and scoped to the
// team's data owner like every other query in this app - so one team shares
// one letterhead, and a second team on the same deployment cannot see it.
const db = require('../../db');

const PREFIX = 'report_brand.';
const FIELDS = ['company', 'logo_url', 'accent', 'contact', 'footer', 'tagline'];

// A colour is written into a <style> block, so it is validated as a hex
// literal rather than trusted. Anything else is dropped and the document falls
// back to the app's own accent - an off-brand blue is a cosmetic problem, a
// string of CSS typed by a user is not.
function safeAccent(v) {
  return /^#[0-9a-f]{3,8}$/i.test(String(v || '').trim()) ? String(v).trim() : null;
}

function get(userId) {
  const rows = db.prepare('SELECT key, value FROM app_settings WHERE user_id=? AND key LIKE ?')
    .all(userId, `${PREFIX}%`);
  const out = {};
  rows.forEach((r) => { out[String(r.key).slice(PREFIX.length)] = r.value; });
  return {
    company: out.company || null,
    logoUrl: out.logo_url || null,
    accent: safeAccent(out.accent),
    contact: out.contact || null,
    footer: out.footer || null,
    tagline: out.tagline || null,
    // Drives the "your letterhead is not set up" hint on the form. A report
    // sent under no name at all is the failure this warns about, and it is
    // silent otherwise: the document renders perfectly well without it.
    configured: Boolean(out.company),
  };
}

function save(userId, values = {}) {
  const stmt = db.prepare(`INSERT INTO app_settings (user_id, key, value) VALUES (?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value`);
  db.transaction(() => {
    FIELDS.forEach((f) => {
      const raw = values[f] == null ? '' : String(values[f]).trim();
      const value = f === 'accent' ? (safeAccent(raw) || '') : raw.slice(0, 500);
      stmt.run(userId, PREFIX + f, value || null);
    });
  })();
  return get(userId);
}

module.exports = { get, save, safeAccent, FIELDS };
