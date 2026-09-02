// Verification for the keyword-difficulty cache, queue and backfill
// (src/lib/aiseo/difficultyCache.js and the aiseo_kd_backfill scheduler job).
//
// SAFE TO RUN WITH THE SERVER UP. ../../db and ./serpLite are stubbed before
// the module loads, so data/app.db is never opened and no search endpoint is
// contacted. The stub is a tiny in-memory SQL interpreter covering only the
// statements this module issues — enough to assert real behaviour, small
// enough that a failure here means the module is wrong, not the stub.
//
//   node verify_difficulty_backfill.js
const Module = require('module');
const path = require('path');
const ROOT = process.argv[2] || process.cwd();
const real = Module._load;

// ------------------------------------------------------------- fake tables
const cacheRows = new Map(); // "kw|market" -> row
const queueRows = [];
let queueId = 0;
let now = Date.now();

const daysAgo = (d) => new Date(now - d * 86400000).toISOString().replace('T', ' ').slice(0, 19);

// A deliberately small SQL router: each prepared statement is matched by a
// distinctive fragment rather than parsed, because parsing SQL to test a cache
// would be testing the parser.
const dbStub = {
  prepare(sql) {
    const q = sql.replace(/\s+/g, ' ').trim();
    return {
      all: (...args) => {
        if (q.includes('FROM keyword_difficulty_cache')) {
          const market = args[0];
          const kws = args.slice(1);
          return kws.map((kw) => cacheRows.get(`${kw}|${market}`)).filter(Boolean).map((r) => ({
            ...r,
            age_days: (now - Date.parse(`${r.scored_at.replace(' ', 'T')}Z`)) / 86400000,
          }));
        }
        if (q.includes('FROM keyword_difficulty_queue')) {
          const [maxAttempts, limit] = args;
          return queueRows
            .filter((r) => r.attempts < maxAttempts)
            .sort((a, b) => a.attempts - b.attempts || a.seq - b.seq)
            .slice(0, limit)
            .map((r) => ({ ...r }));
        }
        return [];
      },
      get: (...args) => {
        if (q.includes('SUM(CASE WHEN attempts')) {
          const maxAttempts = args[0];
          return {
            total: queueRows.length,
            untried: queueRows.filter((r) => r.attempts === 0).length,
            exhausted: queueRows.filter((r) => r.attempts >= maxAttempts).length,
          };
        }
        if (q.includes('FROM keyword_difficulty_cache')) {
          return {
            scored: [...cacheRows.values()].filter((r) => r.difficulty != null).length,
            unscoreable: [...cacheRows.values()].filter((r) => r.difficulty == null).length,
          };
        }
        return {};
      },
      run: (...args) => {
        if (q.startsWith('INSERT INTO keyword_difficulty_cache')) {
          const [keyword, market, difficulty, basis, engine, detail_json, unavailable_reason] = args;
          cacheRows.set(`${keyword}|${market}`, {
            keyword, market, difficulty, basis, engine, detail_json, unavailable_reason,
            scored_at: daysAgo(0),
          });
          return { changes: 1 };
        }
        if (q.startsWith('INSERT INTO keyword_difficulty_queue')) {
          const [keyword, market, brand_id] = args;
          if (queueRows.some((r) => r.keyword === keyword && r.market === market)) return { changes: 0 };
          queueId += 1;
          queueRows.push({ id: queueId, seq: queueId, keyword, market, brand_id, attempts: 0, last_error: null });
          return { changes: 1 };
        }
        if (q.startsWith('DELETE FROM keyword_difficulty_queue')) {
          const i = queueRows.findIndex((r) => r.id === args[0]);
          if (i >= 0) queueRows.splice(i, 1);
          return { changes: 1 };
        }
        if (q.startsWith('UPDATE keyword_difficulty_queue')) {
          const row = queueRows.find((r) => r.id === args[1]);
          if (row) { row.attempts += 1; row.last_error = args[0]; }
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    };
  },
  transaction: (fn) => (arg) => fn(arg),
};

// serpLite is replaced by a scripted responder so throttles, empty pages and
// normal results can each be produced on demand.
let serpBehaviour = 'ok';
const serpStub = {
  search: async (kw) => {
    if (serpBehaviour === 'throttle') {
      return { ok: false, engine: 'duckduckgo', error: 'rate-limited (anomaly page returned)', results: [], related: [] };
    }
    if (serpBehaviour === 'empty') return { ok: true, engine: 'bing', results: [], related: [] };
    return {
      ok: true,
      engine: 'duckduckgo',
      market: 'US',
      results: [
        { position: 1, domain: 'wikipedia.org', url: 'https://wikipedia.org/x', title: kw },
        { position: 2, domain: 'example.com', url: 'https://example.com/', title: 'Example' },
        { position: 3, domain: 'nytimes.com', url: 'https://nytimes.com/a', title: kw },
        { position: 4, domain: 'reddit.com', url: 'https://reddit.com/r/x', title: 'thread' },
        { position: 5, domain: 'other.com', url: 'https://other.com/p', title: 'other' },
      ],
    };
  },
};

Module._load = function (request, parent) {
  if (request === '../../db') return dbStub;
  if (request === './serpLite') return serpStub;
  if (parent && /keywordMetrics/.test(parent.filename || '') && request === './difficultyCache') {
    return require(path.join(ROOT, 'src/lib/aiseo/difficultyCache.js'));
  }
  return real.apply(this, arguments);
};

const cache = require(path.join(ROOT, 'src/lib/aiseo/difficultyCache.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

(async () => {
  // --- cache read/write ---
  cache.write('web design', 'US', { difficulty: 42, basis: 'serp-proxy', engine: 'duckduckgo' });
  check('written score reads back', cache.readMany(['web design'], 'US').get('web design').difficulty, 42);
  check('keyword is normalised on read', cache.readMany(['  WEB DESIGN '], 'US').get('web design').difficulty, 42);
  check('other market is a separate entry', cache.readMany(['web design'], 'GB').size, 0);
  check('unknown keyword absent', cache.readMany(['nothing here'], 'US').size, 0);

  // --- freshness windows ---
  cacheRows.get('web design|US').scored_at = daysAgo(cache.FRESH_DAYS + 1);
  check('a stale score is treated as absent', cache.readMany(['web design'], 'US').size, 0);
  cacheRows.get('web design|US').scored_at = daysAgo(cache.FRESH_DAYS - 1);
  check('a score inside the window is kept', cache.readMany(['web design'], 'US').size, 1);

  cache.write('dead kw', 'US', { difficulty: null, unavailableReason: 'no results returned' });
  cacheRows.get('dead kw|US').scored_at = daysAgo(cache.FAILURE_RETRY_DAYS + 1);
  check('a failure expires on the shorter window', cache.readMany(['dead kw'], 'US').size, 0);
  cacheRows.get('dead kw|US').scored_at = daysAgo(1);
  check('a recent failure is still honoured', cache.readMany(['dead kw'], 'US').get('dead kw').difficulty, null);

  // --- queue ---
  check('enqueue skips already-fresh keywords',
    cache.enqueue(['web design', 'new one', 'another'], 'US', { brandId: 1 }),
    { queued: 2, alreadyFresh: 1 });
  check('enqueue is idempotent', cache.enqueue(['new one'], 'US').queued, 0);
  check('queue ordered oldest first', cache.takeBatch(10).map((r) => r.keyword), ['new one', 'another']);

  // --- scoring path ---
  serpBehaviour = 'ok';
  const kd = await cache.scoreOne('new one', 'US');
  check('scoreOne returns a difficulty', typeof kd.difficulty, 'number');
  check('scoreOne caches its result', cache.readMany(['new one'], 'US').get('new one').difficulty, kd.difficulty);
  check('scoreOne records the engine', cache.readMany(['new one'], 'US').get('new one').engine, 'duckduckgo');

  // An empty SERP is a real answer, cached as unscoreable rather than as a
  // low difficulty — the failure that would otherwise mark hard keywords easy.
  serpBehaviour = 'empty';
  const kdEmpty = await cache.scoreOne('another', 'US');
  check('empty SERP yields null, not a low score', kdEmpty.difficulty, null);
  check('empty SERP cached with a reason',
    Boolean(cache.readMany(['another'], 'US').get('another').unavailableReason), true);

  // A throttle must throw, never be written — caching it would poison the
  // keyword with a bogus score for the whole freshness window.
  serpBehaviour = 'throttle';
  let threw = null;
  try { await cache.scoreOne('throttled kw', 'US'); } catch (e) { threw = e; }
  check('throttle throws', Boolean(threw), true);
  check('throttle is flagged as such', Boolean(threw && threw.throttled), true);
  check('throttle writes nothing to the cache', cacheRows.has('throttled kw|US'), false);

  // --- attempt accounting ---
  cache.enqueue(['flaky'], 'US');
  const row = cache.takeBatch(10).find((r) => r.keyword === 'flaky');
  for (let i = 0; i < cache.MAX_ATTEMPTS; i += 1) cache.recordFailure(row.id, 'boom');
  check('an exhausted row stops being handed out',
    cache.takeBatch(10).some((r) => r.keyword === 'flaky'), false);

  const st = cache.queueStats();
  check('stats count exhausted rows', st.exhausted, 1);
  check('stats count cached scores', st.cachedScores >= 2, true);

  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
