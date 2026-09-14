// LEADS - the conversions that happen after the click.
//
// WHY THIS EXISTS
// Everything else in this suite measures attention: impressions, clicks,
// sessions, positions. A client measures business. The gap between the two is
// where SEO reporting loses arguments - a page whose clicks fell 20% but whose
// enquiries doubled is a success, and no chart in this app could say so.
//
// The design decision that matters here is that leads are POSTED IN, not
// scraped out. GA4 already counts conversion events and this deliberately does
// not use them, for three reasons that are not fixable by configuration:
//  - A GA4 conversion is a browser event. Consent refusals, ad blockers and
//     iOS content blockers remove a material and *unknowable* fraction of them,
//     and the fraction differs per site, so the count cannot even be corrected.
//  - GA4 counts a form submission, not a lead. Spam, duplicate submits and
//     the person who fills the form to ask where the car park is all count once
//     each, and none of them is a lead.
//  - Nothing downstream of the form is visible to it at all. "Which page
//     produces enquiries that are actually WORTH something" needs the CRM's
//     verdict - qualified, won, lost, and for how much - and that verdict is
//     formed days later by a human.
// So the source of truth is the system that already knows: the form handler or
// the CRM, posting server-to-server to POST /api/leads.
//
// PII
// A row here identifies a real person. See the header on the `leads` table in
// src/db.js for the three rules that follow from that; the one enforced in this
// file is `attribution()` and `summary()`, which return counts and money only,
// so the client-facing report and share link cannot leak a contact detail even
// if someone renders every field they are handed.
const crypto = require('crypto');
const db = require('../db');

// ---------------------------------------------------------------- ingest keys
//
// Hashed with SHA-256 rather than bcrypt, unlike a user password. That is a
// deliberate difference and not an oversight: this key is 32 bytes of
// crypto.randomBytes, so there is no dictionary to run against it and nothing
// for a work factor to buy - while the endpoint is called on every form
// submission, where a 60ms bcrypt comparison is a real cost. A user password is
// low-entropy and typed by a human, which is the case bcrypt exists for.
function hashKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function mintKey() {
  // Prefixed so that a key found in a log, a form builder or a support ticket
  // is identifiable as belonging to this app, and so a key pasted into the
  // wrong field fails a shape check before it reaches a hash comparison.
  return `sk_lead_${crypto.randomBytes(24).toString('base64url')}`;
}

// Issues a new key for a brand and returns it ONCE. The plaintext is never
// stored, so a lost key is regenerated rather than recovered - the same
// contract as every other API key the user has ever been issued, and the reason
// the UI has to insist on copying it at the moment it is shown.
function issueKey(brandId, userId) {
  const token = mintKey();
  db.prepare(`UPDATE brands SET lead_key_hash=?, lead_key_hint=?, lead_key_created_at=datetime('now'),
      lead_last_error=NULL, lead_last_error_at=NULL
    WHERE id=? AND user_id=?`).run(hashKey(token), token.slice(-4), brandId, userId);
  return token;
}

function revokeKey(brandId, userId) {
  db.prepare(`UPDATE brands SET lead_key_hash=NULL, lead_key_hint=NULL, lead_key_created_at=NULL
    WHERE id=? AND user_id=?`).run(brandId, userId);
}

// Resolves a posted key to its brand.
//
// The lookup is by hash equality on an indexed-enough column rather than by
// scanning brands and comparing in JS, but the comparison itself still has to
// be constant-time-ish in spirit: SQLite's `=` on a hex digest is not, and that
// is acceptable precisely because the compared value is a HASH. An attacker who
// learns a hash byte-by-byte learns a hash, and cannot invert it to the key.
// Comparing the raw key in SQL would not be acceptable, which is why it is
// never stored.
function brandForKey(token) {
  const t = String(token || '').trim();
  if (!t.startsWith('sk_lead_') || t.length < 20) return null;
  return db.prepare('SELECT * FROM brands WHERE lead_key_hash=?').get(hashKey(t)) || null;
}

// ------------------------------------------------------------- normalisation
//
// The whole value of this table is that a lead can be lined up against the page
// that produced it, and that only works if both sides spell the page the same
// way. They do not, natively:
//
//   gsc_page_daily.page      https://www.example.com/services/roofing/
//   ga4_page_daily.page_path /services/roofing
//   what a form posts        https://example.com/services/roofing/?utm_source=google#form
//
// Those are one page. So everything is reduced to a lowercase path with no
// query, no fragment, no trailing slash and no index filename, and the reducing
// happens on the way in (for leads) and on the way out (for GSC's URLs), so the
// join is a plain equality test.
//
// Deliberately NOT normalised away: case in the path. A path is
// case-sensitive on most servers, /Services and /services can be two pages, and
// folding them would merge two rows that a client can see are different. Only
// the host and scheme are lowercased.
function normalisePath(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  let pathname;
  try {
    // A bare path ("/contact") is not a valid URL, so it is given a throwaway
    // base rather than being parsed by hand.
    pathname = new URL(raw, 'https://x.invalid').pathname;
  } catch {
    pathname = raw.split('?')[0].split('#')[0];
  }
  try { pathname = decodeURI(pathname); } catch { /* a malformed escape stays as-is */ }
  // Index filenames are the same page as the directory.
  pathname = pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return pathname || '/';
}

// Search engines whose referrer means the visit was organic, when the poster
// gave no utm_medium. Not exhaustive and does not need to be: an unrecognised
// search engine falls through to 'referral', which is visibly wrong in the UI
// and correctable, rather than being silently counted as organic - the
// direction of the error matters, because this number is the one used to argue
// that SEO is working.
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|brave\.com|search\.marginalia\.nu)$/i;
const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|gemini\.google\.com)$/i;
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|t\.co|twitter\.com|x\.com|reddit\.com|pinterest\.[a-z.]+|tiktok\.com|youtube\.com)$/i;

// One channel per lead, decided once at insert time.
//
// utm_medium wins when it is present, because it is what the person who built
// the campaign intended and the referrer is only evidence about it. The
// referrer is the fallback for the ordinary case: a contact form that captures
// document.referrer and nothing else.
function deriveChannel({ source, medium, referrer }) {
  const m = String(medium || '').trim().toLowerCase();
  if (m) {
    if (/^(organic|natural|seo)$/.test(m)) return 'organic';
    if (/^(cpc|ppc|paid|paidsearch|paid_search|display|cpm|retargeting)$/.test(m)) return 'paid';
    if (m === 'email' || m === 'newsletter') return 'email';
    if (/^(social|social-network|social_media|paid-social)$/.test(m)) return 'social';
    if (m === 'referral') return 'referral';
    if (m === 'none' || m === '(none)' || m === 'direct') return 'direct';
    if (m === 'ai' || m === 'llm') return 'ai';
    return 'other';
  }

  const s = String(source || '').trim().toLowerCase();
  if (s === 'direct' || s === '(direct)') return 'direct';

  const ref = String(referrer || '').trim();
  if (!ref) return s ? 'other' : 'direct';
  let host;
  try { host = new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'other'; }
  if (AI_HOSTS.test(host)) return 'ai';
  if (SEARCH_HOSTS.test(host)) return 'organic';
  if (SOCIAL_HOSTS.test(host)) return 'social';
  return 'referral';
}

const STATUSES = ['new', 'qualified', 'won', 'lost', 'spam'];
// Which statuses count as a real lead in the headline numbers. 'spam' and
// 'lost' are kept rather than deleted - a page that produces ten enquiries of
// which nine are spam is a finding, not an empty row, and deleting them would
// make the same page look merely quiet.
const REAL = "status IN ('new','qualified','won')";

// ------------------------------------------------------------------- ingest
//
// Field names are accepted in several spellings because this endpoint is
// configured by whoever owns the form, not by this app: a WordPress form
// plugin, a Webflow webhook, a Zapier step and a CRM all name the same field
// differently, and asking a client's web developer to rename theirs is how an
// integration quietly never gets finished.
function pick(obj, ...names) {
  for (const n of names) {
    if (obj[n] != null && String(obj[n]).trim() !== '') return String(obj[n]).trim();
  }
  return null;
}

function toIso(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  // A clock skewed into the future would sort above everything forever and
  // silently break every "last 30 days" window, so it is clamped to now.
  const now = Date.now();
  return (d.getTime() > now + 60_000 ? new Date(now) : d).toISOString();
}

function toNumber(v) {
  if (v == null || v === '') return null;
  // Currency symbols, thousands separators and a trailing "USD" all arrive in
  // practice from form builders that store the value as a display string.
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const MAX_FIELD = 500;
function clip(v) { return v == null ? null : String(v).slice(0, MAX_FIELD); }

// Records one lead. Returns { id, duplicate } - `duplicate: true` means an
// external_id already seen, which is a success, not an error: a CRM retrying a
// POST it never saw the response to must not be punished for it.
function record(brand, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const landingUrl = pick(p, 'landing_page', 'landingPage', 'page', 'url', 'page_url', 'pageUrl', 'form_page');
  const referrer = pick(p, 'referrer', 'referer', 'http_referer', 'referring_url');
  const source = pick(p, 'source', 'utm_source', 'utmSource');
  const medium = pick(p, 'medium', 'utm_medium', 'utmMedium');
  const campaign = pick(p, 'campaign', 'utm_campaign', 'utmCampaign');
  const externalId = pick(p, 'external_id', 'externalId', 'id', 'lead_id', 'submission_id');

  const statusIn = String(pick(p, 'status') || 'new').toLowerCase();
  const status = STATUSES.includes(statusIn) ? statusIn : 'new';

  const row = {
    user_id: brand.user_id,
    brand_id: brand.id,
    external_id: clip(externalId),
    occurred_at: toIso(pick(p, 'occurred_at', 'occurredAt', 'created_at', 'timestamp', 'date')),
    landing_path: normalisePath(landingUrl),
    landing_url: clip(landingUrl),
    source: clip(source),
    medium: clip(medium),
    campaign: clip(campaign),
    referrer: clip(referrer),
    channel: deriveChannel({ source, medium, referrer }),
    status,
    value: toNumber(pick(p, 'value', 'amount', 'deal_value', 'revenue')),
    currency: clip(pick(p, 'currency')),
    name: clip(pick(p, 'name', 'full_name', 'fullName', 'contact_name')),
    email: clip(pick(p, 'email', 'email_address', 'emailAddress')),
    phone: clip(pick(p, 'phone', 'telephone', 'phone_number', 'tel')),
    company: clip(pick(p, 'company', 'organisation', 'organization', 'business')),
    note: clip(pick(p, 'note', 'notes', 'message', 'comments', 'enquiry')),
    // Capped, because a form tool that posts its entire configuration alongside
    // the submission would otherwise put a megabyte per lead into a SQLite file
    // that lives on shared hosting.
    raw_json: JSON.stringify(p).slice(0, 20_000),
  };

  if (row.external_id) {
    const existing = db.prepare('SELECT id FROM leads WHERE brand_id=? AND external_id=?')
      .get(brand.id, row.external_id);
    if (existing) {
      // A re-post is treated as an update, not a no-op: the second POST is
      // usually the CRM revising the lead (new status, a deal value that was
      // not known at capture time), which is exactly the information this
      // table exists to hold.
      db.prepare(`UPDATE leads SET status=?, value=COALESCE(?, value), currency=COALESCE(?, currency),
          note=COALESCE(?, note), name=COALESCE(?, name), email=COALESCE(?, email),
          phone=COALESCE(?, phone), company=COALESCE(?, company)
        WHERE id=?`)
        .run(row.status, row.value, row.currency, row.note, row.name, row.email,
          row.phone, row.company, existing.id);
      touch(brand.id);
      return { id: existing.id, duplicate: true };
    }
  }

  const info = db.prepare(`INSERT INTO leads
    (user_id, brand_id, external_id, occurred_at, landing_path, landing_url, source, medium,
     campaign, referrer, channel, status, value, currency, name, email, phone, company, note, raw_json)
    VALUES (@user_id, @brand_id, @external_id, @occurred_at, @landing_path, @landing_url, @source,
     @medium, @campaign, @referrer, @channel, @status, @value, @currency, @name, @email, @phone,
     @company, @note, @raw_json)`).run(row);
  touch(brand.id);
  return { id: Number(info.lastInsertRowid), duplicate: false };
}

function touch(brandId) {
  db.prepare(`UPDATE brands SET lead_last_seen_at=datetime('now'), lead_last_error=NULL WHERE id=?`)
    .run(brandId);
}

// A rejected post is recorded on the brand, because the failure mode this
// prevents is the expensive one: a form wired up months ago that has been
// posting a malformed body into a 400 ever since, with nothing on any screen
// saying so and a client wondering why the leads report is empty.
function recordError(brandId, message) {
  db.prepare(`UPDATE brands SET lead_last_error=?, lead_last_error_at=datetime('now') WHERE id=?`)
    .run(String(message).slice(0, 300), brandId);
}

// ------------------------------------------------------------------ reading
function list(userId, { brandId = null, from = null, to = null, channel = null, status = null,
  path = null, limit = 100, offset = 0 } = {}) {
  const where = ['l.user_id=?'];
  const args = [userId];
  if (brandId) { where.push('l.brand_id=?'); args.push(brandId); }
  if (from) { where.push('l.occurred_at >= ?'); args.push(from); }
  if (to) { where.push('l.occurred_at <= ?'); args.push(`${to}T23:59:59Z`); }
  if (channel) { where.push('l.channel=?'); args.push(channel); }
  if (status) { where.push('l.status=?'); args.push(status); }
  if (path) { where.push('l.landing_path=?'); args.push(path); }
  const sql = `SELECT l.*, b.name brand_name FROM leads l JOIN brands b ON b.id=l.brand_id
    WHERE ${where.join(' AND ')} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, limit, offset);
}

function count(userId, opts = {}) {
  const where = ['l.user_id=?'];
  const args = [userId];
  if (opts.brandId) { where.push('l.brand_id=?'); args.push(opts.brandId); }
  if (opts.from) { where.push('l.occurred_at >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('l.occurred_at <= ?'); args.push(`${opts.to}T23:59:59Z`); }
  if (opts.channel) { where.push('l.channel=?'); args.push(opts.channel); }
  if (opts.status) { where.push('l.status=?'); args.push(opts.status); }
  if (opts.path) { where.push('l.landing_path=?'); args.push(opts.path); }
  return db.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${where.join(' AND ')}`).get(...args).n;
}

function get(id, userId) {
  return db.prepare(`SELECT l.*, b.name brand_name FROM leads l JOIN brands b ON b.id=l.brand_id
    WHERE l.id=? AND l.user_id=?`).get(id, userId) || null;
}

function setStatus(id, userId, status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown lead status: ${status}`);
  db.prepare('UPDATE leads SET status=? WHERE id=? AND user_id=?').run(status, id, userId);
}

function remove(id, userId) {
  // A hard delete, not a soft one. This is the row a GDPR erasure request is
  // about, and a "deleted" flag on a row still holding the person's email is
  // not an erasure.
  db.prepare('DELETE FROM leads WHERE id=? AND user_id=?').run(id, userId);
}

// -------------------------------------------------------------- aggregation
//
// Everything below returns counts and money only - no name, email or phone - 
// so these are the functions the report, the share link and the email can call
// without any of them having to remember not to print a field.

// Window helper shared by every aggregate here, so "last 28 days" means the
// same thing on the dashboard, in the report and in the share link.
function windowDates(days = 28, endDate = null) {
  const end = endDate ? new Date(`${String(endDate).slice(0, 10)}T00:00:00Z`) : new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function summary(brandId, { from, to } = windowDates()) {
  const args = [brandId, from, `${to}T23:59:59Z`];
  const row = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN ${REAL} THEN 1 ELSE 0 END) real_leads,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won,
      SUM(CASE WHEN status='qualified' THEN 1 ELSE 0 END) qualified,
      SUM(CASE WHEN status='spam' THEN 1 ELSE 0 END) spam,
      SUM(CASE WHEN status='won' THEN COALESCE(value,0) ELSE 0 END) won_value,
      SUM(CASE WHEN ${REAL} AND channel='organic' THEN 1 ELSE 0 END) organic,
      SUM(CASE WHEN ${REAL} AND channel='organic' THEN COALESCE(value,0) ELSE 0 END) organic_value
    FROM leads WHERE brand_id=? AND occurred_at>=? AND occurred_at<=?`).get(...args);
  const byChannel = db.prepare(`SELECT channel, COUNT(*) n, SUM(COALESCE(value,0)) value
    FROM leads WHERE brand_id=? AND occurred_at>=? AND occurred_at<=? AND ${REAL}
    GROUP BY channel ORDER BY n DESC`).all(...args);
  return {
    from, to,
    total: row.total || 0,
    leads: row.real_leads || 0,
    won: row.won || 0,
    qualified: row.qualified || 0,
    spam: row.spam || 0,
    wonValue: row.won_value || 0,
    organic: row.organic || 0,
    organicValue: row.organic_value || 0,
    byChannel,
  };
}

// The comparison the weekly report and the dashboard both want: this window
// against the one immediately before it, same length.
function summaryWithPrior(brandId, days = 28, endDate = null) {
  const cur = windowDates(days, endDate);
  const priorEnd = new Date(`${cur.from}T00:00:00Z`).getTime() - 86400000;
  const prior = windowDates(days, new Date(priorEnd).toISOString().slice(0, 10));
  const recent = summary(brandId, cur);
  const previous = summary(brandId, prior);
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : (a ? 100 : 0));
  return {
    ...recent,
    prior: previous,
    delta: {
      leads: recent.leads - previous.leads,
      leadsPct: pct(recent.leads, previous.leads),
      organic: recent.organic - previous.organic,
      organicPct: pct(recent.organic, previous.organic),
      wonValue: recent.wonValue - previous.wonValue,
      wonValuePct: pct(recent.wonValue, previous.wonValue),
    },
  };
}

// THE POINT OF THE WHOLE FEATURE: which pages produce business.
//
// GSC's `page` is an absolute URL and is normalised here in JS rather than in
// SQL, because SQLite has no URL parser and the string surgery needed to strip
// a scheme, host, query and trailing slash inside a GROUP BY would be both
// unreadable and wrong on the first edge case. The row counts involved are one
// per page per day for one brand over one window - thousands, not millions - 
// so aggregating them in JS costs nothing measurable.
function attribution(brandId, { from, to } = windowDates(), { includeZeroLead = true } = {}) {
  const pages = new Map();
  const at = (path) => {
    if (!pages.has(path)) {
      pages.set(path, {
        path, clicks: 0, impressions: 0, position: null, positionWeight: 0,
        sessions: 0, ga4Conversions: 0, leads: 0, won: 0, value: 0, organicLeads: 0,
      });
    }
    return pages.get(path);
  };

  const gsc = db.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position * impressions) pos_weighted, SUM(impressions) imp_for_pos
    FROM gsc_page_daily WHERE brand_id=? AND date>=? AND date<=? GROUP BY page`)
    .all(brandId, from, to);
  gsc.forEach((r) => {
    const path = normalisePath(r.page);
    if (!path) return;
    const p = at(path);
    p.clicks += r.clicks || 0;
    p.impressions += r.impressions || 0;
    // Two URLs collapsing to one path (http and https, or with and without a
    // trailing slash) must combine their positions by impression weight, not by
    // averaging two averages - the second is wrong whenever the two URLs are
    // not equally visible, which is the normal case for a redirect pair.
    p.positionWeight += (r.pos_weighted || 0);
    p.position = null; // resolved below, once every contributing URL is in
  });

  const ga = db.prepare(`SELECT page_path, SUM(sessions) sessions, SUM(conversions) conversions
    FROM ga4_page_daily WHERE brand_id=? AND date>=? AND date<=? GROUP BY page_path`)
    .all(brandId, from, to);
  ga.forEach((r) => {
    const path = normalisePath(r.page_path);
    if (!path) return;
    const p = at(path);
    p.sessions += r.sessions || 0;
    p.ga4Conversions += r.conversions || 0;
  });

  const leadRows = db.prepare(`SELECT landing_path, COUNT(*) n,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won,
      SUM(CASE WHEN channel='organic' THEN 1 ELSE 0 END) organic,
      SUM(COALESCE(value,0)) value
    FROM leads WHERE brand_id=? AND occurred_at>=? AND occurred_at<=? AND ${REAL}
      AND landing_path IS NOT NULL
    GROUP BY landing_path`).all(brandId, from, `${to}T23:59:59Z`);
  leadRows.forEach((r) => {
    const p = at(r.landing_path);
    p.leads += r.n;
    p.won += r.won;
    p.organicLeads += r.organic;
    p.value += r.value || 0;
  });

  const out = [];
  for (const p of pages.values()) {
    p.position = p.impressions ? p.positionWeight / p.impressions : null;
    delete p.positionWeight;
    // Leads per 100 clicks rather than a raw percentage, because the honest
    // numbers here are small: 3 leads from 180 clicks reads as "1.7 per 100",
    // which is a rate a client can hold in their head, where "1.67%" invites a
    // comparison against ecommerce conversion rates it has nothing to do with.
    p.leadsPer100 = p.clicks ? (p.leads / p.clicks) * 100 : null;
    p.valuePerClick = p.clicks ? p.value / p.clicks : null;
    if (!includeZeroLead && !p.leads) continue;
    out.push(p);
  }
  // Ordered by leads, then by value, then by clicks - so the table opens on the
  // pages that earn, not the pages that are merely busy. That inversion is the
  // reason this page exists next to the existing Performance tab.
  out.sort((a, b) => (b.leads - a.leads) || (b.value - a.value) || (b.clicks - a.clicks));
  return out;
}

// Leads with no landing page attached at all. Reported separately and never
// folded into "direct", because the two mean different things: a lead whose
// form did not send a page URL is a wiring problem to fix, while a direct lead
// is a real finding about the channel. Merging them would quietly deflate every
// page's contribution and there would be nothing on screen to notice it by.
function unattributed(brandId, { from, to } = windowDates()) {
  return db.prepare(`SELECT COUNT(*) n, SUM(COALESCE(value,0)) value
    FROM leads WHERE brand_id=? AND occurred_at>=? AND occurred_at<=? AND ${REAL}
      AND (landing_path IS NULL OR landing_path='')`)
    .get(brandId, from, `${to}T23:59:59Z`);
}

// Daily series for the trend chart, dense over the window (a day with no leads
// is a zero, not a gap - a sparse series draws a line straight through a quiet
// fortnight and makes it look busy).
function daily(brandId, { from, to } = windowDates()) {
  const rows = db.prepare(`SELECT substr(occurred_at,1,10) d, COUNT(*) n,
      SUM(CASE WHEN channel='organic' THEN 1 ELSE 0 END) organic,
      SUM(COALESCE(value,0)) value
    FROM leads WHERE brand_id=? AND occurred_at>=? AND occurred_at<=? AND ${REAL}
    GROUP BY d ORDER BY d`).all(brandId, from, `${to}T23:59:59Z`);
  const byDay = new Map(rows.map((r) => [r.d, r]));
  const out = [];
  for (let t = new Date(`${from}T00:00:00Z`); t <= new Date(`${to}T00:00:00Z`); t = new Date(t.getTime() + 86400000)) {
    const d = t.toISOString().slice(0, 10);
    const r = byDay.get(d);
    out.push({ date: d, leads: r ? r.n : 0, organic: r ? r.organic : 0, value: r ? r.value : 0 });
  }
  return out;
}

function hasAny(brandId) {
  return db.prepare('SELECT 1 FROM leads WHERE brand_id=? LIMIT 1').get(brandId) != null;
}

module.exports = {
  STATUSES,
  issueKey, revokeKey, brandForKey,
  normalisePath, deriveChannel,
  record, recordError,
  list, count, get, setStatus, remove,
  windowDates, summary, summaryWithPrior, attribution, unattributed, daily, hasAny,
};
