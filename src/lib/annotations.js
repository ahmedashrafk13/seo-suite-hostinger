// CHANGE ANNOTATIONS — the timeline that makes a chart attributable.
//
// THE PROBLEM THIS SOLVES
// Every chart in this app answers "what happened". None of them could answer
// "why", and the reason is that the causes were never written down. A traffic
// inflection has four common explanations — a Google update, a deploy, a
// content push, a migration — and after three weeks they are indistinguishable
// from each other and from noise. The specialist ends up reconstructing the
// month from memory, a Slack search and the client's recollection of when the
// redesign went live.
//
// So a movement is annotated at the time it is caused, and every trend chart
// can draw the marks. That is the whole feature: one table, a small closed
// vocabulary of event kinds, and a query that returns the events overlapping a
// date window.
//
// WHY THE ALGORITHM UPDATES ARE A STATIC LIST, AND WHY THAT IS SAID OUT LOUD
// Google publishes confirmed ranking updates on its Search Status Dashboard,
// but there is no stable machine-readable feed of them, and the page's markup
// changes. Scraping it would give a list that silently goes empty the next
// time the page is rebuilt — and an empty update list looks exactly like a
// quiet quarter, which is the failure mode this whole codebase refuses.
//
// So the confirmed updates are a vendored constant with a stated as-of date.
// The UI shows that date, so a user can see when the list stops being current
// and add the newer ones by hand. A list that is honestly three months stale
// is more useful than a scrape that is silently empty.
const db = require('../db');

// ------------------------------------------------------------------- kinds
// A closed vocabulary. Free text fragments into "deploy", "Deploy" and
// "release" within a month and stops being filterable or colourable.
const KINDS = [
  {
    key: 'algorithm',
    label: 'Google update',
    colour: '#b45309',
    hint: 'A confirmed Google ranking or spam update. Affects every brand, so these are stored site-wide.',
  },
  {
    key: 'deploy',
    label: 'Deploy / release',
    colour: '#2563eb',
    hint: 'Code shipped. The single most common cause of a change nobody can explain.',
  },
  {
    key: 'content',
    label: 'Content change',
    colour: '#0f766e',
    hint: 'Pages published, rewritten, consolidated or removed.',
  },
  {
    key: 'technical',
    label: 'Technical SEO change',
    colour: '#7c3aed',
    hint: 'Titles, canonicals, robots.txt, schema, internal links, redirects.',
  },
  {
    key: 'migration',
    label: 'Migration / redesign',
    colour: '#be123c',
    hint: 'A domain move, URL restructure, platform change or full redesign.',
  },
  {
    key: 'campaign',
    label: 'Campaign / PR',
    colour: '#c026d3',
    hint: 'Paid, PR, email or social activity that moves branded search and direct traffic.',
  },
  {
    key: 'outage',
    label: 'Outage / incident',
    colour: '#dc2626',
    hint: 'Downtime, a certificate expiry, a WAF rule, a blocked crawler.',
  },
  {
    key: 'other',
    label: 'Other',
    colour: '#64748b',
    hint: 'Anything else worth remembering when reading a chart.',
  },
];
const KIND_KEYS = new Set(KINDS.map((k) => k.key));
const KIND_BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

function kindMeta(key) {
  return KIND_BY_KEY.get(String(key || '')) || KIND_BY_KEY.get('other');
}

// ------------------------------------------------- confirmed Google updates
// Confirmed, dated ranking and spam updates as published on Google's Search
// Status Dashboard. Announcement dates are used, not rollout-completion
// dates: a chart is read against when the change started reaching users.
//
// AS_OF is rendered in the UI. When it is months behind today, the page says
// so and offers the manual-entry form — see the header note above.
const ALGO_AS_OF = '2026-03-01';
const ALGO_UPDATES = [
  { key: 'google-2024-03-core', date: '2024-03-05', title: 'March 2024 core update', detail: 'Core update paired with new spam policies; the longest and most volatile core rollout to date, targeting unhelpful content at scale.' },
  { key: 'google-2024-03-spam', date: '2024-03-05', title: 'March 2024 spam update', detail: 'Scaled content abuse, site reputation abuse and expired-domain abuse policies enforced.' },
  { key: 'google-2024-05-ai-overviews', date: '2024-05-14', title: 'AI Overviews general rollout (US)', detail: 'AI Overviews replaced SGE and began appearing broadly, changing click distribution above the organic results.' },
  { key: 'google-2024-06-spam', date: '2024-06-20', title: 'June 2024 spam update', detail: 'Broad spam policy enforcement.' },
  { key: 'google-2024-08-core', date: '2024-08-15', title: 'August 2024 core update', detail: 'Core update Google described as intended to recover ground for small independent publishers hit in previous rounds.' },
  { key: 'google-2024-11-core', date: '2024-11-11', title: 'November 2024 core update', detail: 'Core update.' },
  { key: 'google-2024-12-core', date: '2024-12-12', title: 'December 2024 core update', detail: 'Core update, unusually close behind the November one.' },
  { key: 'google-2024-12-spam', date: '2024-12-19', title: 'December 2024 spam update', detail: 'Spam policy enforcement.' },
  { key: 'google-2025-03-core', date: '2025-03-13', title: 'March 2025 core update', detail: 'Core update.' },
  { key: 'google-2025-06-core', date: '2025-06-30', title: 'June 2025 core update', detail: 'Core update.' },
  { key: 'google-2025-08-spam', date: '2025-08-26', title: 'August 2025 spam update', detail: 'Spam policy enforcement.' },
  { key: 'google-2025-11-core', date: '2025-11-11', title: 'November 2025 core update', detail: 'Core update.' },
  { key: 'google-2025-12-spam', date: '2025-12-10', title: 'December 2025 spam update', detail: 'Spam policy enforcement.' },
];

// Inserts any confirmed update this workspace does not already carry. Safe to
// call repeatedly: external_key is unique per user, so a re-seed after adding
// newer updates to the constant inserts only the new ones and leaves any that
// were edited by hand alone.
function seedAlgorithmUpdates(userId, actorId = null) {
  const stmt = db.prepare(`INSERT INTO annotations
      (user_id, brand_id, kind, title, detail, starts_on, source, external_key, created_by)
    VALUES (?, NULL, 'algorithm', ?, ?, ?, 'google-confirmed', ?, ?)
    ON CONFLICT(user_id, external_key) DO NOTHING`);
  let added = 0;
  for (const u of ALGO_UPDATES) {
    const info = stmt.run(userId, u.title, u.detail, u.date, u.key, actorId);
    if (info && info.changes) added += 1;
  }
  return { added, total: ALGO_UPDATES.length, asOf: ALGO_AS_OF };
}

function seededCount(userId) {
  return db.prepare("SELECT COUNT(*) n FROM annotations WHERE user_id=? AND source='google-confirmed'")
    .get(userId).n;
}

// ------------------------------------------------------------------- writes
function normaliseDate(value) {
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function create(userId, {
  brandId = null, kind = 'other', title, detail = null, url = null,
  startsOn, endsOn = null, actorId = null, source = 'manual', externalKey = null,
}) {
  const start = normaliseDate(startsOn);
  if (!start) throw new Error('A date in YYYY-MM-DD form is required.');
  const cleanTitle = String(title || '').trim().slice(0, 200);
  if (!cleanTitle) throw new Error('A title is required.');
  const end = normaliseDate(endsOn);
  // An end date before the start would render as a zero-width band that looks
  // like a point event, so it is rejected rather than silently swapped.
  if (end && end < start) throw new Error('The end date cannot be before the start date.');

  const info = db.prepare(`INSERT INTO annotations
      (user_id, brand_id, kind, title, detail, url, starts_on, ends_on, source, external_key, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, brandId || null, KIND_KEYS.has(kind) ? kind : 'other', cleanTitle,
      detail ? String(detail).slice(0, 2000) : null,
      url ? String(url).slice(0, 500) : null,
      start, end, source, externalKey, actorId);
  return get(info.lastInsertRowid, userId);
}

function update(id, userId, fields) {
  const row = get(id, userId);
  if (!row) return null;
  const start = fields.startsOn !== undefined ? normaliseDate(fields.startsOn) : row.starts_on;
  if (!start) throw new Error('A date in YYYY-MM-DD form is required.');
  const end = fields.endsOn !== undefined ? normaliseDate(fields.endsOn) : row.ends_on;
  if (end && end < start) throw new Error('The end date cannot be before the start date.');
  const title = fields.title !== undefined ? String(fields.title || '').trim().slice(0, 200) : row.title;
  if (!title) throw new Error('A title is required.');
  db.prepare(`UPDATE annotations SET brand_id=?, kind=?, title=?, detail=?, url=?, starts_on=?, ends_on=?
    WHERE id=? AND user_id=?`)
    .run(
      fields.brandId !== undefined ? (fields.brandId || null) : row.brand_id,
      fields.kind !== undefined && KIND_KEYS.has(fields.kind) ? fields.kind : row.kind,
      title,
      fields.detail !== undefined ? (fields.detail ? String(fields.detail).slice(0, 2000) : null) : row.detail,
      fields.url !== undefined ? (fields.url ? String(fields.url).slice(0, 500) : null) : row.url,
      start, end, id, userId,
    );
  return get(id, userId);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM annotations WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

// ------------------------------------------------------------------- reads
function get(id, userId) {
  return db.prepare(`SELECT a.*, b.name brand_name FROM annotations a
    LEFT JOIN brands b ON b.id=a.brand_id WHERE a.id=? AND a.user_id=?`).get(id, userId) || null;
}

// The timeline for a brand.
//
// A site-wide annotation (brand_id NULL) belongs to EVERY brand's timeline,
// which is why the filter is "this brand or nobody's" rather than an equality
// test. Getting that wrong would hide algorithm updates from every chart —
// the events most worth seeing.
function forBrand(userId, brandId, { from = null, to = null, kinds = null, limit = 500 } = {}) {
  const where = ['a.user_id = ?'];
  const args = [userId];
  if (brandId) {
    where.push('(a.brand_id = ? OR a.brand_id IS NULL)');
    args.push(brandId);
  }
  if (from) { where.push("COALESCE(a.ends_on, a.starts_on) >= ?"); args.push(from); }
  if (to) { where.push('a.starts_on <= ?'); args.push(to); }
  if (kinds && kinds.length) {
    where.push(`a.kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  args.push(limit);
  return db.prepare(`SELECT a.*, b.name brand_name FROM annotations a
    LEFT JOIN brands b ON b.id=a.brand_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.starts_on DESC, a.id DESC LIMIT ?`).all(...args);
}

// The shape the chart partial consumes: one flat object per mark, already
// carrying its colour and label so the template does nothing but draw.
function marksFor(userId, brandId, { from = null, to = null } = {}) {
  return forBrand(userId, brandId, { from, to, limit: 200 })
    .map((a) => {
      const meta = kindMeta(a.kind);
      return {
        id: a.id,
        date: a.starts_on,
        endDate: a.ends_on || null,
        kind: a.kind,
        kindLabel: meta.label,
        colour: meta.colour,
        title: a.title,
        detail: a.detail || '',
        scope: a.brand_id ? (a.brand_name || 'this brand') : 'all brands',
      };
    })
    // Chronological for drawing, even though the list view is newest-first.
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

// Used by the report and the alert context: "was anything happening around
// this date?" A window rather than an exact match, because a deploy on the
// Friday explains a drop first seen on the Monday.
function near(userId, brandId, isoDate, windowDays = 7) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const shift = (days) => {
    const c = new Date(d);
    c.setUTCDate(c.getUTCDate() + days);
    return c.toISOString().slice(0, 10);
  };
  return forBrand(userId, brandId, { from: shift(-windowDays), to: shift(windowDays), limit: 25 });
}

function counts(userId) {
  return db.prepare(`SELECT kind, COUNT(*) n FROM annotations WHERE user_id=? GROUP BY kind`)
    .all(userId).reduce((acc, r) => { acc[r.kind] = r.n; return acc; }, {});
}

module.exports = {
  KINDS, KIND_KEYS, kindMeta,
  ALGO_UPDATES, ALGO_AS_OF, seedAlgorithmUpdates, seededCount,
  create, update, remove, get, forBrand, marksFor, near, counts,
  normaliseDate,
};
