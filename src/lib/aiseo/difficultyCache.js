// KEYWORD DIFFICULTY: THE CACHE, THE QUEUE, AND THE SCORER BEHIND BOTH.
//
// THE PROBLEM THIS SOLVES
// Difficulty without a paid credential means fetching a result page per
// keyword through ./serpLite.js, which paces itself to one request every
// 1.4 seconds. Inside a research run somebody is waiting on, that pacing put a
// hard ceiling of a dozen keywords on what could be scored, and every other
// keyword rendered as an em dash. The data was never the constraint — the
// place the work was being done was.
//
// So the work moves. A score is computed once, stored against (keyword,
// market), and reused by every later run and every other brand asking about
// the same keyword in the same country. Whatever a run cannot score inside its
// own budget is queued, and a scheduled job drains the queue at the pace
// serpLite allows. Coverage reaches 100% without anybody watching a spinner.
//
// WHAT IS CACHED, AND FOR HOW LONG
// A difficulty score is a description of a result page: which domains hold the
// top ten, how many are authoritative, how many match the query in the title.
// That composition changes over weeks, not hours, so a 45-day life is generous
// without being stale. Failures are cached too, for far longer than nothing
// and far shorter than a success — a keyword whose SERP came back empty must
// not be re-fetched on every run, and must not be written off permanently
// either.
//
// WHAT THIS DOES NOT CHANGE
// The score is still the serp-proxy: derived from a NON-GOOGLE index, labelled
// `proxy` in every view, and not Ahrefs KD. Scoring every keyword instead of
// twelve makes the coverage complete. It does not make the metric something it
// is not, and nothing here relabels it.
const db = require('../../db');
const serpLite = require('./serpLite');
const markets = require('./markets');

// How long a stored score is trusted. Deliberately different for the two
// cases: a real score describes a slow-moving SERP, while a failure is usually
// a transient throttle and deserves a much earlier retry.
const FRESH_DAYS = Number(process.env.KD_CACHE_FRESH_DAYS || 45);
const FAILURE_RETRY_DAYS = Number(process.env.KD_CACHE_FAILURE_RETRY_DAYS || 3);

// A queue row that has failed this many times is left alone. Without it, a
// keyword that is permanently unscoreable — a SERP that always returns empty —
// would be retried nightly forever, spending the whole backfill budget on the
// one thing that cannot succeed.
const MAX_ATTEMPTS = 4;

function normKeyword(k) {
  return String(k || '').toLowerCase().trim();
}

function normMarket(m) {
  try { return markets.resolve(m).code; } catch { return String(m || 'ZZ'); }
}

// Reads whatever is already known for a list of keywords. Returns a Map of
// keyword -> cached row, containing ONLY entries still inside their freshness
// window, so a caller never has to reason about age.
function readMany(keywords, market) {
  const mk = normMarket(market);
  const list = [...new Set((keywords || []).map(normKeyword).filter(Boolean))];
  const found = new Map();
  if (!list.length) return found;

  // Chunked to stay well inside SQLite's variable limit on a long keyword set.
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const holes = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT keyword, difficulty, basis, engine, detail_json, unavailable_reason, scored_at,
              CAST(julianday('now') - julianday(scored_at) AS REAL) AS age_days
         FROM keyword_difficulty_cache
        WHERE market = ? AND keyword IN (${holes})`,
    ).all(mk, ...chunk);

    rows.forEach((r) => {
      const limit = r.difficulty == null ? FAILURE_RETRY_DAYS : FRESH_DAYS;
      if (r.age_days != null && r.age_days > limit) return; // stale: treat as absent
      found.set(r.keyword, {
        keyword: r.keyword,
        difficulty: r.difficulty,
        basis: r.basis,
        engine: r.engine,
        detail: r.detail_json ? JSON.parse(r.detail_json) : null,
        unavailableReason: r.unavailable_reason,
        scoredAt: r.scored_at,
        ageDays: Math.round(r.age_days * 10) / 10,
      });
    });
  }
  return found;
}

function write(keyword, market, { difficulty = null, basis = 'serp-proxy', engine = null, detail = null, unavailableReason = null }) {
  const kw = normKeyword(keyword);
  if (!kw) return;
  db.prepare(
    `INSERT INTO keyword_difficulty_cache (keyword, market, difficulty, basis, engine, detail_json, unavailable_reason, scored_at)
     VALUES (?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(keyword, market) DO UPDATE SET
       difficulty=excluded.difficulty, basis=excluded.basis, engine=excluded.engine,
       detail_json=excluded.detail_json, unavailable_reason=excluded.unavailable_reason,
       scored_at=excluded.scored_at`,
  ).run(
    kw, normMarket(market), difficulty, basis, engine,
    detail ? JSON.stringify(detail) : null, unavailableReason,
  );
}

// ------------------------------------------------------------------ queue

// Enqueues keywords for the background job. Silently ignores anything already
// scored and fresh, so a caller can hand over its entire keyword list without
// filtering first.
function enqueue(keywords, market, { brandId = null } = {}) {
  const mk = normMarket(market);
  const list = [...new Set((keywords || []).map(normKeyword).filter(Boolean))];
  if (!list.length) return { queued: 0 };

  const fresh = readMany(list, mk);
  const pending = list.filter((k) => !fresh.has(k));
  if (!pending.length) return { queued: 0 };

  const stmt = db.prepare(
    `INSERT INTO keyword_difficulty_queue (keyword, market, brand_id)
     VALUES (?,?,?)
     ON CONFLICT(keyword, market) DO NOTHING`,
  );
  let queued = 0;
  db.transaction((rows) => {
    rows.forEach((k) => { queued += stmt.run(k, mk, brandId).changes || 0; });
  })(pending);
  return { queued, alreadyFresh: list.length - pending.length };
}

// Oldest first, least-attempted first: a keyword that has never been tried
// goes ahead of one that has already failed twice, so a run of bad keywords
// cannot starve the rest of the queue.
function takeBatch(limit) {
  return db.prepare(
    `SELECT id, keyword, market, brand_id, attempts
       FROM keyword_difficulty_queue
      WHERE attempts < ?
      ORDER BY attempts ASC, queued_at ASC
      LIMIT ?`,
  ).all(MAX_ATTEMPTS, Math.max(1, limit));
}

function dequeue(id) {
  db.prepare('DELETE FROM keyword_difficulty_queue WHERE id=?').run(id);
}

function recordFailure(id, message) {
  db.prepare('UPDATE keyword_difficulty_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    .run(String(message || '').slice(0, 200), id);
}

function queueStats() {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN attempts = 0 THEN 1 ELSE 0 END) AS untried,
            SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS exhausted
       FROM keyword_difficulty_queue`,
  ).get(MAX_ATTEMPTS);
  const cached = db.prepare(
    `SELECT COUNT(*) AS scored,
            SUM(CASE WHEN difficulty IS NULL THEN 1 ELSE 0 END) AS unscoreable
       FROM keyword_difficulty_cache`,
  ).get();
  return {
    queued: row.total || 0,
    untried: row.untried || 0,
    exhausted: row.exhausted || 0,
    cachedScores: cached.scored || 0,
    cachedFailures: cached.unscoreable || 0,
  };
}

// ----------------------------------------------------------------- scoring

// Scores one keyword and writes the result. Shared by the inline path in
// ./keywordMetrics.js and the background job, so the two can never drift into
// computing difficulty two different ways.
//
// `difficultyFromSerp` is required lazily: keywordMetrics requires this module,
// and requiring it back at load time would be circular.
async function scoreOne(keyword, market) {
  const { difficultyFromSerp } = require('./keywordMetrics');
  const kw = normKeyword(keyword);
  const serp = await serpLite.search(kw, { market, limit: 10 });

  // A throttle is not a result. serpLite reports a rate-limited fetch as
  // ok:false, and writing that to the cache as "no competition found" would
  // poison the keyword with a low difficulty for the next 45 days — the exact
  // failure mode this whole feature exists to avoid.
  if (serp && serp.ok === false && /rate-limit|throttl|anomaly|429/i.test(String(serp.error || ''))) {
    const err = new Error(`throttled: ${serp.error}`);
    err.throttled = true;
    throw err;
  }

  const kd = difficultyFromSerp(kw, serp);
  write(kw, market, {
    difficulty: kd.difficulty,
    basis: 'serp-proxy',
    engine: kd.engine || (serp ? serp.engine : null),
    detail: kd.difficulty == null ? null : kd,
    unavailableReason: kd.difficulty == null ? (kd.reason || 'no result page could be sampled') : null,
  });
  return kd;
}

module.exports = {
  readMany, write, enqueue, takeBatch, dequeue, recordFailure, queueStats, scoreOne,
  normKeyword, normMarket, FRESH_DAYS, FAILURE_RETRY_DAYS, MAX_ATTEMPTS,
};
