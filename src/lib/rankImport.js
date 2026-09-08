// RANK TRACKER IMPORT — real positions, from the tool that actually measures them.
//
// WHY THIS EXISTS
// Search Console's average position is the only ranking figure this suite has
// had, and it is a blended national average across every device and location
// that produced an impression. A keyword that ranks 3rd in Manchester and 40th
// nationally arrives as one number near 20 that describes neither, and a client
// who checks their own phone sees something the dashboard cannot corroborate.
// That is not a flaw in Search Console — it is what the metric means — so the
// fix is to import the measurement from a tool that fixes location and device,
// and to keep the two apart at every layer. See the header on rank_positions
// in src/db.js.
//
// WHY AN IMPORT AND NOT AN API INTEGRATION
// There are a dozen rank trackers and each has a different API, auth model and
// price. Every one of them exports CSV, and most can email or FTP a scheduled
// export. So the import is the universal path: it costs no credential, works
// with a tracker the agency already pays for, and a provider adapter can be
// added later on top of the same tables.
//
// WHAT MAKES THIS NOT-TRIVIAL, AND WHERE THE WORK WENT
//   1. Every exporter names its columns differently ("Keyword"/"Query"/
//      "Search term", "Position"/"Rank"/"Pos"). So the mapping is derived from
//      a synonym table, reported back to the user, and overridable.
//   2. Half of them export WIDE — one row per keyword, one column per capture
//      date. A long-format-only importer reads those files as a single row of
//      nonsense. Both shapes are detected and handled.
//   3. "Not ranking" is exported as blank, "-", ">100", "101+" or 0 depending
//      on the tool, and each of those means the same thing. Storing 0 would
//      make an unranked keyword look like the best result on the page, so they
//      all normalise to NULL and are counted separately.
//   4. A re-import of an overlapping window must not double-count. The unique
//      key is (brand, keyword, location, device, engine, date), so re-importing
//      Tuesday's file corrects Tuesday rather than adding a second Tuesday.
const db = require('../db');

// --------------------------------------------------------------- CSV parsing
// A real CSV parser rather than split(','): keyword columns routinely contain
// commas ("plumber, emergency"), and quoted fields with embedded quotes are
// normal in exports from spreadsheet software.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, ''); // strip a BOM Excel adds
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      // A trailing newline produces one empty cell, not an empty row.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

// Delimiter sniffing on the header line only. Counting across the whole file
// would be swayed by commas inside keyword values, which is exactly the case
// that makes a semicolon-delimited European export look comma-delimited.
function sniffDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/).find((l) => l.trim().length) || '';
  const counts = [
    { d: ',', n: (firstLine.match(/,/g) || []).length },
    { d: '\t', n: (firstLine.match(/\t/g) || []).length },
    { d: ';', n: (firstLine.match(/;/g) || []).length },
    { d: '|', n: (firstLine.match(/\|/g) || []).length },
  ].sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

// ------------------------------------------------------------ column mapping
// Synonyms observed across AccuRanker, SE Ranking, Semrush Position Tracking,
// Ahrefs Rank Tracker, SERPWatcher, Wincher, Nightwatch and the generic
// spreadsheet people keep by hand. Matched on a normalised header, so
// "Search Volume", "search_volume" and "SEARCH VOLUME" are one entry.
const FIELD_SYNONYMS = {
  keyword: ['keyword', 'keywords', 'query', 'searchterm', 'search term', 'term', 'phrase', 'kw'],
  position: ['position', 'rank', 'ranking', 'pos', 'currentposition', 'current rank', 'currentrank', 'googleposition', 'rankgoogle'],
  url: ['url', 'landingpage', 'landing page', 'rankingurl', 'ranking url', 'page', 'result url', 'resulturl'],
  location: ['location', 'locale', 'city', 'region', 'geo', 'country', 'market', 'searchlocation'],
  device: ['device', 'devicetype', 'platform'],
  engine: ['engine', 'searchengine', 'search engine', 'se'],
  search_volume: ['searchvolume', 'search volume', 'volume', 'sv', 'avgmonthlysearches', 'monthlysearches'],
  captured_on: ['date', 'captureddate', 'captured on', 'checkdate', 'checked', 'checkedat', 'day', 'timestamp', 'datetime'],
};

function normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');
}

// A header cell that is itself a date is the signature of a wide export.
function headerAsDate(h) {
  return parseDate(h);
}

// Dates arrive in five shapes across these tools. Anything ambiguous is
// rejected rather than guessed: reading 03/04/2026 as March when the tracker
// meant April would silently shift a month of history by 28 days.
function parseDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO, the only unambiguous form
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/); // 2026/3/4
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/); // 4 Mar 2026
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/); // Mar 4, 2026
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Which column holds what. Returns the mapping AND the headers it could not
// place, because a silent mis-map is the failure that produces a chart of
// plausible, wrong numbers.
function mapColumns(headers) {
  const mapping = {};
  const dateColumns = [];
  const unmatched = [];
  headers.forEach((raw, idx) => {
    const norm = normaliseHeader(raw);
    if (!norm) return;
    const asDate = headerAsDate(raw);
    if (asDate) { dateColumns.push({ idx, date: asDate, header: raw }); return; }
    const field = Object.keys(FIELD_SYNONYMS)
      .find((f) => FIELD_SYNONYMS[f].some((syn) => normaliseHeader(syn) === norm));
    if (field && mapping[field] === undefined) mapping[field] = idx;
    else if (!field) unmatched.push(raw);
  });
  return { mapping, dateColumns, unmatched };
}

// Provider identification is a convenience, not a dependency: nothing branches
// on it, it is recorded so a mixed workspace can tell where a series came from.
function detectProvider(headers) {
  const set = new Set(headers.map(normaliseHeader));
  if (set.has('searchvolume') && set.has('competition') && set.has('rankingurl')) return 'accuranker';
  if (set.has('serpfeatures') || set.has('trafficpercent')) return 'semrush';
  if (set.has('searchengine') && set.has('devicetype')) return 'seranking';
  if (set.has('sv') && set.has('kd')) return 'ahrefs';
  return 'generic';
}

// ------------------------------------------------------- value normalisation
// "Not in the top 100" is exported as blank, '-', '>100', '101+', '100+' or 0.
// Every one of those means "not found", and storing 0 for it would rank an
// invisible keyword above the site's best result. So they all become null, and
// the caller counts them as unranked rather than discarding the row — the fact
// that a tracked keyword is not ranking is itself the finding.
function parsePosition(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s || s === '-' || s === '—' || s === 'n/a' || s === 'na' || s === 'null'
    || s === 'not ranked' || s === 'not found' || s === 'nr') {
    return { position: null, unranked: true };
  }
  // The "beyond our crawl depth" markers: ">100", "100+", "101+", ">50".
  if (/^[><]\s*\d+$/.test(s) || /^\d+\s*\+$/.test(s)) return { position: null, unranked: true };
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { position: null, unranked: true };
  // Above 100 is beyond every tracker's crawl depth and means the same thing.
  if (n > 100) return { position: null, unranked: true };
  return { position: n, unranked: false };
}

function normaliseDevice(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return 'desktop';
  if (/mob|phone|ios|android/.test(s)) return 'mobile';
  if (/tab|ipad/.test(s)) return 'tablet';
  return 'desktop';
}

function normaliseEngine(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return 'google';
  if (s.includes('bing')) return 'bing';
  if (s.includes('yahoo')) return 'yahoo';
  if (s.includes('duck')) return 'duckduckgo';
  if (s.includes('yandex')) return 'yandex';
  if (s.includes('youtube')) return 'youtube';
  return 'google';
}

// --------------------------------------------------------------- the import
// `defaultDate` is used when the file carries no date at all — a "current
// rankings" export, which several tools produce. It defaults to today, and the
// UI makes it editable, because importing last Friday's export as though it
// were measured today puts a four-day-old rank on today's line.
function preview(text, { limit = 8 } = {}) {
  const delimiter = sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { error: 'That file has no rows.' };
  const headers = rows[0].map((h) => String(h || '').trim());
  const { mapping, dateColumns, unmatched } = mapColumns(headers);
  const wide = dateColumns.length >= 2;
  return {
    delimiter,
    delimiterLabel: { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' }[delimiter] || delimiter,
    headers,
    mapping,
    dateColumns,
    unmatched,
    shape: wide ? 'wide' : 'long',
    provider: detectProvider(headers),
    dataRows: rows.length - 1,
    sample: rows.slice(1, 1 + limit),
    hasKeyword: mapping.keyword !== undefined,
    hasPosition: mapping.position !== undefined,
  };
}

function importText(userId, brand, text, {
  filename = null, defaultDate = null, defaultLocation = 'default',
  defaultDevice = null, defaultEngine = null, actorId = null, overrides = null,
} = {}) {
  const delimiter = sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length < 2) throw new Error('That file has a header but no data rows.');

  const headers = rows[0].map((h) => String(h || '').trim());
  const detected = mapColumns(headers);
  const mapping = Object.assign({}, detected.mapping, overrides || {});
  const { dateColumns } = detected;
  const wide = dateColumns.length >= 2;
  const provider = detectProvider(headers);

  if (mapping.keyword === undefined) {
    throw new Error('No keyword column could be identified. Rename the column to "Keyword", or pick it by hand.');
  }
  if (!wide && mapping.position === undefined) {
    throw new Error('No position column could be identified. Rename the column to "Position", or pick it by hand.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const fallbackDate = parseDate(defaultDate) || today;

  const insert = db.prepare(`INSERT INTO rank_positions
      (brand_id, import_id, keyword, position, url, location, device, engine, search_volume, captured_on, provider)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, keyword, location, device, engine, captured_on) DO UPDATE SET
      position=excluded.position, url=excluded.url, search_volume=excluded.search_volume,
      import_id=excluded.import_id, provider=excluded.provider`);

  const cell = (row, idx) => (idx === undefined || idx == null ? '' : String(row[idx] == null ? '' : row[idx]).trim());

  const importRow = db.prepare(`INSERT INTO rank_imports
      (user_id, brand_id, filename, provider, captured_on, rows_seen, rows_imported, rows_skipped,
       keywords, mapping_json, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  let seen = 0;
  let imported = 0;
  let skipped = 0;
  let unranked = 0;
  const keywords = new Set();
  const dates = new Set();
  const skipReasons = new Map();
  const note = (why) => skipReasons.set(why, (skipReasons.get(why) || 0) + 1);

  // Everything in one transaction: a half-imported file leaves a series with a
  // hole in it, which reads as a ranking collapse on the missing day.
  const run = db.transaction(() => {
    const info = importRow.run(userId, brand.id, filename || null, provider,
      wide ? null : fallbackDate, 0, 0, 0, 0,
      JSON.stringify({ mapping, wide, dateColumns: dateColumns.map((d) => d.date), delimiter }),
      null, actorId);
    const importId = info.lastInsertRowid;

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r];
      if (!row || row.every((c) => String(c || '').trim() === '')) continue;
      seen += 1;
      const keyword = cell(row, mapping.keyword).toLowerCase();
      if (!keyword) { skipped += 1; note('no keyword'); continue; }

      const location = cell(row, mapping.location) || defaultLocation || 'default';
      const device = normaliseDevice(cell(row, mapping.device) || defaultDevice);
      const engine = normaliseEngine(cell(row, mapping.engine) || defaultEngine);
      const url = cell(row, mapping.url) || null;
      const volRaw = cell(row, mapping.search_volume);
      const volume = volRaw ? Math.round(Number(volRaw.replace(/[^\d.]/g, ''))) || null : null;

      // WIDE: one column per capture date, so one row yields many points.
      if (wide) {
        for (const dc of dateColumns) {
          const { position, unranked: miss } = parsePosition(row[dc.idx]);
          // A blank cell in a wide export means "not measured that day", which
          // is different from "measured and not found". Only the whole-column
          // markers for not-found are stored as a null position; an empty cell
          // is skipped so the series has a gap rather than a false miss.
          if (position == null && String(row[dc.idx] == null ? '' : row[dc.idx]).trim() === '') continue;
          insert.run(brand.id, importId, keyword, position, url, location, device, engine,
            volume, dc.date, provider);
          imported += 1;
          if (miss) unranked += 1;
          dates.add(dc.date);
        }
        keywords.add(keyword);
        continue;
      }

      // LONG: one row is one measurement.
      const capturedOn = parseDate(cell(row, mapping.captured_on)) || fallbackDate;
      const { position, unranked: miss } = parsePosition(cell(row, mapping.position));
      insert.run(brand.id, importId, keyword, position, url, location, device, engine,
        volume, capturedOn, provider);
      imported += 1;
      if (miss) unranked += 1;
      keywords.add(keyword);
      dates.add(capturedOn);
    }

    const noteText = [
      unranked ? `${unranked} row(s) recorded as not ranking in the top 100.` : null,
      skipReasons.size ? [...skipReasons].map(([why, n]) => `${n} skipped (${why})`).join('; ') : null,
      detected.unmatched.length ? `Columns ignored: ${detected.unmatched.slice(0, 8).join(', ')}.` : null,
    ].filter(Boolean).join(' ') || null;

    const sortedDates = [...dates].sort();
    db.prepare(`UPDATE rank_imports SET rows_seen=?, rows_imported=?, rows_skipped=?, keywords=?,
        captured_on=?, notes=? WHERE id=?`)
      .run(seen, imported, skipped, keywords.size,
        sortedDates.length ? sortedDates[sortedDates.length - 1] : fallbackDate, noteText, importId);
    return importId;
  });

  const importId = run();
  return {
    importId,
    provider,
    shape: wide ? 'wide' : 'long',
    seen,
    imported,
    skipped,
    unranked,
    keywords: keywords.size,
    dates: [...dates].sort(),
    ignoredColumns: detected.unmatched,
    mapping,
  };
}

// ------------------------------------------------------------------- reading
function captureDates(brandId, limit = 60) {
  return db.prepare(`SELECT DISTINCT captured_on FROM rank_positions
    WHERE brand_id=? ORDER BY captured_on DESC LIMIT ?`).all(brandId, limit).map((r) => r.captured_on);
}

function segments(brandId) {
  return db.prepare(`SELECT location, device, engine, COUNT(DISTINCT keyword) keywords,
      MAX(captured_on) last_seen
    FROM rank_positions WHERE brand_id=?
    GROUP BY location, device, engine ORDER BY keywords DESC`).all(brandId);
}

// The table the specialist actually reads: today's position, the previous
// capture's position, and the movement between them.
//
// UNRANKED IS NOT ZERO, AND MOVEMENT INTO OR OUT OF IT IS NOT A NUMBER.
// A keyword that went from 8 to not-found has not "moved 93 places" — it left
// the measured range. So `delta` is null in that case and `event` says what
// happened, which is the difference between a report that reads correctly and
// one that shows a tidy number for an unmeasurable change.
function board(brandId, {
  date = null, compareDate = null, location = null, device = null, engine = null,
  limit = 500, search = null,
} = {}) {
  const dates = captureDates(brandId, 400);
  if (!dates.length) return { rows: [], date: null, compareDate: null, dates: [], summary: null };
  const current = date && dates.includes(date) ? date : dates[0];
  const prior = compareDate && dates.includes(compareDate)
    ? compareDate
    : (dates.find((d) => d < current) || null);

  const filters = ['brand_id=?', 'captured_on=?'];
  const args = [brandId, current];
  if (location) { filters.push('location=?'); args.push(location); }
  if (device) { filters.push('device=?'); args.push(device); }
  if (engine) { filters.push('engine=?'); args.push(engine); }
  if (search) { filters.push('keyword LIKE ?'); args.push(`%${String(search).toLowerCase()}%`); }

  const currentRows = db.prepare(`SELECT keyword, position, url, location, device, engine, search_volume
    FROM rank_positions WHERE ${filters.join(' AND ')}
    ORDER BY (position IS NULL), position ASC LIMIT ?`).all(...args, limit);

  const priorMap = new Map();
  if (prior) {
    const pf = ['brand_id=?', 'captured_on=?'];
    const pa = [brandId, prior];
    if (location) { pf.push('location=?'); pa.push(location); }
    if (device) { pf.push('device=?'); pa.push(device); }
    if (engine) { pf.push('engine=?'); pa.push(engine); }
    db.prepare(`SELECT keyword, location, device, engine, position FROM rank_positions
      WHERE ${pf.join(' AND ')}`).all(...pa)
      .forEach((r) => priorMap.set(`${r.keyword}|${r.location}|${r.device}|${r.engine}`, r.position));
  }

  const rows = currentRows.map((r) => {
    const key = `${r.keyword}|${r.location}|${r.device}|${r.engine}`;
    const was = priorMap.has(key) ? priorMap.get(key) : undefined;
    let delta = null;
    let event = null;
    if (was === undefined) event = 'new';
    else if (was == null && r.position != null) event = 'entered';
    else if (was != null && r.position == null) event = 'lost';
    else if (was != null && r.position != null) {
      // Positive delta = improvement, because "up 4" must mean better. Raw
      // subtraction gives the opposite sign, which is the classic rank-report
      // bug that makes a decline look like a win.
      delta = Number((was - r.position).toFixed(1));
      if (delta === 0) event = 'flat';
      else event = delta > 0 ? 'up' : 'down';
    }
    return Object.assign({}, r, { was: was === undefined ? null : was, delta, event });
  });

  const ranked = rows.filter((r) => r.position != null);
  const summary = {
    tracked: rows.length,
    ranked: ranked.length,
    unranked: rows.length - ranked.length,
    top3: ranked.filter((r) => r.position <= 3).length,
    top10: ranked.filter((r) => r.position <= 10).length,
    top20: ranked.filter((r) => r.position <= 20).length,
    // The average is over RANKED keywords only, and the count is shown beside
    // it. Averaging with unranked keywords excluded silently would flatter a
    // site that just lost half its terms.
    avgPosition: ranked.length
      ? Number((ranked.reduce((a, r) => a + r.position, 0) / ranked.length).toFixed(1))
      : null,
    improved: rows.filter((r) => r.event === 'up').length,
    declined: rows.filter((r) => r.event === 'down').length,
    entered: rows.filter((r) => r.event === 'entered').length,
    lost: rows.filter((r) => r.event === 'lost').length,
    newKeywords: rows.filter((r) => r.event === 'new').length,
  };

  return { rows, date: current, compareDate: prior, dates, summary };
}

// Visibility over time: the share of tracked keywords in the top 3 / 10 / 20
// per capture date, plus the average position of the ranked ones.
//
// A share is the honest headline for a rank set because the keyword list grows:
// "42 keywords in the top 10" rises when 30 new terms are added, while "31% in
// the top 10" does not.
function visibility(brandId, { location = null, device = null, engine = null, limit = 120 } = {}) {
  const filters = ['brand_id=?'];
  const args = [brandId];
  if (location) { filters.push('location=?'); args.push(location); }
  if (device) { filters.push('device=?'); args.push(device); }
  if (engine) { filters.push('engine=?'); args.push(engine); }
  const rows = db.prepare(`SELECT captured_on date,
      COUNT(*) tracked,
      SUM(CASE WHEN position IS NOT NULL THEN 1 ELSE 0 END) ranked,
      SUM(CASE WHEN position <= 3 THEN 1 ELSE 0 END) top3,
      SUM(CASE WHEN position <= 10 THEN 1 ELSE 0 END) top10,
      SUM(CASE WHEN position <= 20 THEN 1 ELSE 0 END) top20,
      AVG(position) avg_position
    FROM rank_positions WHERE ${filters.join(' AND ')}
    GROUP BY captured_on ORDER BY captured_on DESC LIMIT ?`).all(...args, limit);
  return rows.reverse().map((r) => ({
    date: r.date,
    tracked: r.tracked,
    ranked: r.ranked,
    top3: r.top3,
    top10: r.top10,
    top20: r.top20,
    top10Share: r.tracked ? Number(((r.top10 / r.tracked) * 100).toFixed(1)) : 0,
    avgPosition: r.avg_position == null ? null : Number(Number(r.avg_position).toFixed(1)),
  }));
}

function history(brandId, keyword, { location = null, device = null, engine = null } = {}) {
  const filters = ['brand_id=?', 'keyword=?'];
  const args = [brandId, String(keyword || '').toLowerCase()];
  if (location) { filters.push('location=?'); args.push(location); }
  if (device) { filters.push('device=?'); args.push(device); }
  if (engine) { filters.push('engine=?'); args.push(engine); }
  return db.prepare(`SELECT captured_on date, position, url, location, device, engine
    FROM rank_positions WHERE ${filters.join(' AND ')} ORDER BY captured_on`).all(...args);
}

// Biggest movers between two captures, used by the report and the alert.
function movers(brandId, { date = null, compareDate = null, minMove = 3, limit = 25 } = {}) {
  const b = board(brandId, { date, compareDate, limit: 5000 });
  const moved = b.rows.filter((r) => r.delta != null && Math.abs(r.delta) >= minMove);
  return {
    date: b.date,
    compareDate: b.compareDate,
    up: moved.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, limit),
    down: moved.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, limit),
    lost: b.rows.filter((r) => r.event === 'lost').slice(0, limit),
    entered: b.rows.filter((r) => r.event === 'entered').slice(0, limit),
  };
}

function imports(userId, brandId = null, limit = 30) {
  const where = brandId ? 'AND i.brand_id=?' : '';
  const args = brandId ? [userId, brandId, limit] : [userId, limit];
  return db.prepare(`SELECT i.*, b.name brand_name FROM rank_imports i
    LEFT JOIN brands b ON b.id=i.brand_id
    WHERE i.user_id=? ${where} ORDER BY i.id DESC LIMIT ?`).all(...args);
}

// Deleting an import removes the rows it wrote. A row corrected by a LATER
// import is left alone: its import_id points at that later import, so the
// correction survives the deletion of the file it corrected.
function deleteImport(id, userId) {
  const row = db.prepare('SELECT * FROM rank_imports WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return null;
  const del = db.transaction(() => {
    const n = db.prepare('DELETE FROM rank_positions WHERE import_id=?').run(id).changes;
    db.prepare('DELETE FROM rank_imports WHERE id=?').run(id);
    return n;
  });
  return { positionsDeleted: del(), brandId: row.brand_id };
}

function hasData(brandId) {
  return db.prepare('SELECT COUNT(*) n FROM rank_positions WHERE brand_id=?').get(brandId).n > 0;
}

module.exports = {
  parseDelimited, sniffDelimiter, parseDate, parsePosition, mapColumns, detectProvider,
  normaliseDevice, normaliseEngine, FIELD_SYNONYMS,
  preview, importText,
  captureDates, segments, board, visibility, history, movers, imports, deleteImport, hasData,
};
