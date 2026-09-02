// Scheduled work that survives shared hosting.
//
// THE PROBLEM
// The original build scheduled everything in process: node-cron for alerts,
// nightly sync and weekly reports, setInterval for backups and assignment
// digests. That is correct on a server that runs continuously. Under Passenger
// — which is how Hostinger runs a Node app — it silently does nothing. Passenger
// starts the app on the first HTTP request and *stops it again* once it has
// been idle for a while (default ~5 minutes). A timer set for 03:20 belongs to
// a process that was killed at 23:10. Nothing errors; the alerts simply never
// fire, which is the worst kind of failure because the dashboard still looks
// healthy.
//
// THE FIX
// Scheduling is driven from outside by hPanel's cron, which makes an HTTP
// request to /internal/cron (see routes/cron.js). Waking the app is exactly
// what that request does, so the work runs in a process that is alive by
// construction.
//
// External cron is coarse — hPanel's finest granularity is a minute, and most
// people set it hourly — so the endpoint cannot just "run everything" on each
// hit. Instead every job records when it last completed, and each tick runs the
// jobs whose own schedule came due since then. That decouples the two
// cadences: an hourly cron still fires the weekly report exactly once, on
// Monday, and a cron that was down for two days catches up on the next hit
// rather than skipping a week.
//
// Nothing about the jobs themselves changed. Each one calls the same function
// the in-process scheduler called, so behaviour is identical either way — and
// INPROCESS_CRON=1 restores the timer-based mode for local development.
const db = require('../db');
const config = require('../config');

// --- when did each job last run ------------------------------------------
// Persisted, because the whole point is that the process does not outlive the
// interval between runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_runs (
    job          TEXT PRIMARY KEY,
    last_run_at  INTEGER NOT NULL,
    last_status  TEXT,
    last_error   TEXT,
    duration_ms  INTEGER
  );
`);

const getRun = db.prepare('SELECT * FROM scheduler_runs WHERE job = ?');
const setRun = db.prepare(
  `INSERT INTO scheduler_runs (job, last_run_at, last_status, last_error, duration_ms)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(job) DO UPDATE SET
     last_run_at = excluded.last_run_at,
     last_status = excluded.last_status,
     last_error  = excluded.last_error,
     duration_ms = excluded.duration_ms`
);

// --- cron expressions -----------------------------------------------------
// A five-field matcher (minute hour day-of-month month day-of-week) supporting
// *, lists, ranges and steps — everything the app's schedules use.
//
// Written here rather than pulled from a library because the question being
// asked is not the one cron libraries answer. node-cron can *run* an
// expression but cannot say "would this have fired between these two
// timestamps", which is the only thing needed to catch up after downtime.
function parseField(spec, min, max) {
  const allowed = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;
    let lo;
    let hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map((n) => parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      lo = a; hi = b;
    } else {
      const v = parseInt(range, 10);
      if (!Number.isFinite(v)) return null;
      lo = v; hi = stepRaw ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  // Cron accepts both 0 and 7 for Sunday.
  if (dow.has(7)) dow.add(0);
  // A restriction on both day-of-month and day-of-week is a union in cron, not
  // an intersection — the classic gotcha.
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  return { minute, hour, dom, month, dow, domRestricted, dowRestricted };
}

function matches(cronSpec, date) {
  if (!cronSpec.minute.has(date.getMinutes())) return false;
  if (!cronSpec.hour.has(date.getHours())) return false;
  if (!cronSpec.month.has(date.getMonth() + 1)) return false;
  const domOk = cronSpec.dom.has(date.getDate());
  const dowOk = cronSpec.dow.has(date.getDay());
  if (cronSpec.domRestricted && cronSpec.dowRestricted) return domOk || dowOk;
  if (cronSpec.domRestricted) return domOk;
  if (cronSpec.dowRestricted) return dowOk;
  return true;
}

// Would `expr` have fired in (after, now]? Walked a minute at a time, which is
// cheap for the windows involved and, unlike "compute the next fire time",
// needs no calendar arithmetic to get right.
const MAX_LOOKBACK_MINUTES = 60 * 24 * 40; // 40 days — long enough for monthly
function firedSince(expr, afterMs, nowMs) {
  const spec = parseCron(expr);
  if (!spec) return false;
  const start = Math.max(afterMs, nowMs - MAX_LOOKBACK_MINUTES * 60000);
  const cursor = new Date(start);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  while (cursor.getTime() <= nowMs) {
    if (matches(spec, cursor)) return true;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return false;
}

// --- the jobs -------------------------------------------------------------
// Each entry names the work, says when it is due, and how to do it. The `run`
// functions are the same ones the in-process scheduler invoked; they are
// required lazily because reportBuilder and alertEngine import this module's
// siblings and a top-level require would create a cycle at boot.
const JOBS = [
  {
    key: 'alerts',
    label: 'Alert evaluation',
    cron: () => process.env.ALERT_CRON || '7 * * * *',
    async run() {
      const alertEngine = require('./alertEngine');
      const results = await alertEngine.runAll();
      const fired = results.reduce((a, x) => a + (x.fired || 0), 0);
      return `${results.length} brand(s), ${fired} alert(s) fired`;
    },
  },
  {
    key: 'sync',
    label: 'Nightly data consolidation',
    cron: () => process.env.SYNC_CRON || '20 3 * * *',
    async run() {
      const sync = require('./sync');
      const r = await sync.syncAllBrands({ days: 30, includePsi: true });
      return `${r.length} brand(s) synced`;
    },
  },
  {
    key: 'reports',
    label: 'Weekly report generation',
    cron: () => process.env.REPORT_CRON || '30 6 * * 1',
    async run() {
      const reports = require('./reportBuilder');
      const r = await reports.generateAndSendAllWeekly();
      const emailed = r.filter((x) => x.emailed).length;
      return `${r.length} report(s), ${emailed} emailed`;
    },
  },
  {
    key: 'backup',
    label: 'Database backup',
    // Interval rather than cron, matching the original BACKUP_EVERY_HOURS knob.
    intervalMs: () => Math.max(1, Number(process.env.BACKUP_EVERY_HOURS || 12)) * 3600000,
    async run() {
      const backup = require('./backup');
      const r = await backup.run({ reason: 'scheduled' });
      return r && r.file ? `wrote ${r.file}` : 'no change since last backup';
    },
  },
  {
    key: 'assignments',
    label: 'Assignment digest sweep',
    // Deliberately frequent: this batches "you were assigned a task" emails and
    // people expect them within minutes, so it runs on every cron tick.
    intervalMs: () => Number(process.env.ASSIGNMENT_DIGEST_TICK_MS || 30_000),
    async run() {
      const assignmentQueue = require('./assignmentQueue');
      const sent = await assignmentQueue.flush();
      const real = sent.filter((s) => s.sent);
      return real.length ? `${real.length} digest(s) sent` : 'nothing due';
    },
  },
  {
    // The tracking board, swept on a schedule.
    //
    // WHY ONE BRAND PER TICK
    // A full sweep crawls a sample of pages, probes AI user agents and calls
    // PageSpeed Insights. Doing that for every brand in one cron tick would
    // exceed the PSI quota and, on shared hosting, the memory allowance. So
    // each tick sweeps the brand whose last sweep is oldest, and the rotation
    // comes out of the metric history rather than a cursor that could drift
    // out of step with reality.
    //
    // The consequence is stated plainly rather than hidden: with N brands and
    // a daily schedule, each brand is swept every N days. A brand that needs
    // daily monitoring should be swept from its own cron line with
    // ?job=aiseo_tracking.
    key: 'aiseo_tracking',
    label: 'AI SEO tracking sweep',
    cron: () => process.env.AISEO_TRACKING_CRON || '40 4 * * *',
    async run() {
      const tracking = require('./aiseo/tracking');
      const brands = tracking.brandsToSweep({ limit: 100 });
      if (!brands.length) return 'no active brands with a site URL';

      // Oldest last-sweep first. A brand never swept has no row at all, and
      // COALESCE puts it at the front — which is what makes a new brand get
      // its baseline on the next tick rather than after every other brand.
      const lastSweep = new Map(db.prepare(`SELECT brand_id, MAX(finished_at) last
        FROM aiseo_runs WHERE kind='tracking' AND status='completed' GROUP BY brand_id`)
        .all().map((r) => [r.brand_id, r.last]));
      brands.sort((a, b) => String(lastSweep.get(a.id) || '').localeCompare(String(lastSweep.get(b.id) || '')));

      const brand = brands[0];
      const perTick = Math.max(1, Number(process.env.AISEO_TRACKING_BRANDS_PER_TICK || 1));
      const selected = brands.slice(0, perTick);
      const done = [];
      for (const b of selected) {
        try {
          /* eslint-disable no-await-in-loop */
          const r = await tracking.run({
            userId: b.user_id,
            brand: b,
            sampleSize: Number(process.env.AISEO_TRACKING_SAMPLE || 12),
          });
          /* eslint-enable no-await-in-loop */
          done.push(`${b.name}: score ${r.score == null ? 'n/a' : Math.round(r.score)}, ${r.findings.length} finding(s)`);
        } catch (err) {
          // One brand failing must not abandon the others.
          done.push(`${b.name}: FAILED ${String(err.message).slice(0, 120)}`);
        }
      }
      return `${done.length} of ${brands.length} brand(s) swept (oldest first, starting with ${brand.name}) — ${done.join('; ')}`;
    },
  },
  {
    // Reputation scanning. Separate from the tracking sweep because it calls
    // out to third-party public endpoints rather than to the brand's own site,
    // and because it is the one job here whose findings people want to see
    // promptly — a damaging claim is worth knowing about the same day.
    key: 'aiseo_reputation',
    label: 'AI SEO reputation scan',
    cron: () => process.env.AISEO_REPUTATION_CRON || '15 5 * * *',
    async run() {
      const providers = require('./aiseo/providers');
      if (!providers.has('public')) return 'skipped — public sources are disabled';
      const reputation = require('./aiseo/reputation');
      const tracking = require('./aiseo/tracking');
      const brands = tracking.brandsToSweep({ limit: 100 });
      if (!brands.length) return 'no active brands';

      const lastScan = new Map(db.prepare(`SELECT brand_id, MAX(finished_at) last
        FROM aiseo_runs WHERE kind='reputation' AND status='completed' GROUP BY brand_id`)
        .all().map((r) => [r.brand_id, r.last]));
      brands.sort((a, b) => String(lastScan.get(a.id) || '').localeCompare(String(lastScan.get(b.id) || '')));

      const perTick = Math.max(1, Number(process.env.AISEO_REPUTATION_BRANDS_PER_TICK || 1));
      const out = [];
      for (const b of brands.slice(0, perTick)) {
        try {
          /* eslint-disable no-await-in-loop */
          // wantAi is off on the scheduled path. Triage costs money per call,
          // and a cron job that spends the AI budget unattended is how the cap
          // is reached before anyone has looked at a single finding. The
          // findings themselves are complete without it; triage is one click
          // away on the result page.
          const r = await reputation.run({ userId: b.user_id, brand: b, wantAi: false });
          /* eslint-enable no-await-in-loop */
          const res = r.result || {};
          out.push(`${b.name}: ${res.newThisScan || 0} new, ${(res.mix && res.mix.risky) || 0} risky`);
        } catch (err) {
          out.push(`${b.name}: FAILED ${String(err.message).slice(0, 120)}`);
        }
      }
      return out.join('; ') || 'nothing scanned';
    },
  },
  {
    // Freshness and intent drift. Weekly, because both are slow-moving: a
    // page's query mix does not shift meaningfully day to day, and a daily
    // run would spend the crawl budget re-confirming yesterday's answer.
    key: 'aiseo_freshness',
    label: 'AI SEO freshness & drift sweep',
    cron: () => process.env.AISEO_FRESHNESS_CRON || '10 6 * * 2',
    async run() {
      const freshness = require('./aiseo/freshness');
      const tracking = require('./aiseo/tracking');
      const brands = tracking.brandsToSweep({ limit: 100 }).filter((b) => b.gsc_property);
      if (!brands.length) return 'no brands with a Search Console property';
      const out = [];
      for (const b of brands.slice(0, Math.max(1, Number(process.env.AISEO_FRESHNESS_BRANDS_PER_TICK || 2)))) {
        try {
          /* eslint-disable no-await-in-loop */
          const r = await freshness.run({
            userId: b.user_id, brand: b,
            maxPages: Number(process.env.AISEO_FRESHNESS_PAGES || 40),
            wantAi: false, // same reasoning as the reputation job
          });
          /* eslint-enable no-await-in-loop */
          const c = (r.result && r.result.counts) || {};
          out.push(`${b.name}: ${c.drift || 0} drifted, ${c.decaying || 0} decaying, ${c.stale || 0} stale`);
        } catch (err) {
          out.push(`${b.name}: FAILED ${String(err.message).slice(0, 120)}`);
        }
      }
      return out.join('; ') || 'nothing swept';
    },
  },
  {
    // Keyword difficulty backfill.
    //
    // WHY THIS JOB EXISTS
    // Difficulty without a paid credential costs one paced SERP fetch per
    // keyword — about 1.4 seconds, enforced inside lib/aiseo/serpLite.js. That
    // is far too slow to do for hundreds of keywords inside a run somebody is
    // watching, which is why the inline scorer is capped at a dozen. Here
    // nobody is waiting, so the cap is irrelevant and the queue simply drains.
    //
    // Hourly rather than nightly: a smaller batch every hour spreads the load,
    // survives a restart with less lost work, and gets scores in front of the
    // user during the working day instead of only after a night has passed.
    key: 'aiseo_kd_backfill',
    label: 'Keyword difficulty backfill',
    cron: () => process.env.AISEO_KD_BACKFILL_CRON || '25 * * * *',
    async run() {
      const cache = require('./aiseo/difficultyCache');
      const providers = require('./aiseo/providers');
      if (!providers.has('serp-lite')) return 'serp-lite unavailable; nothing to score';

      // Sized to the pacing, not guessed: serpLite allows roughly 43 requests
      // a minute, so 120 keywords is about three minutes of work — short
      // enough to finish well inside the hour, long enough to clear a typical
      // research run's overflow in a few ticks.
      const batchSize = Math.max(10, Number(process.env.AISEO_KD_BACKFILL_BATCH || 120));
      const batch = cache.takeBatch(batchSize);
      if (!batch.length) {
        const st = cache.queueStats();
        return `queue empty (${st.cachedScores} keyword(s) scored in cache)`;
      }

      let scored = 0;
      let unscoreable = 0;
      let failed = 0;
      let throttled = 0;

      for (const row of batch) {
        try {
          /* eslint-disable no-await-in-loop */
          const kd = await cache.scoreOne(row.keyword, row.market);
          /* eslint-enable no-await-in-loop */
          // A null difficulty with a reason is a real answer — the SERP was
          // read and had nothing scoreable in it. It is cached and dequeued so
          // it is not retried forever.
          if (kd.difficulty == null) unscoreable += 1; else scored += 1;
          cache.dequeue(row.id);
        } catch (err) {
          // A throttle is NOT a failure of the keyword, so it must not burn an
          // attempt — otherwise a rate-limited hour would exhaust every row in
          // the batch and permanently abandon keywords that were never tried.
          if (err.throttled) {
            throttled += 1;
            break; // stop the tick; the next one starts with a clean allowance
          }
          failed += 1;
          cache.recordFailure(row.id, err.message);
        }
      }

      const st = cache.queueStats();
      return `${scored} scored, ${unscoreable} unscoreable, ${failed} failed`
        + (throttled ? ', stopped early on rate limit' : '')
        + ` — ${st.queued} still queued, ${st.cachedScores} in cache`;
    },
  },
  {
    key: 'sessions',
    label: 'Expired session sweep',
    intervalMs: () => 3600000,
    async run() {
      // Cheap, and without it the sessions table grows without bound on a host
      // where the app is restarted too often for an in-process timer to fire.
      const info = db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      return `${info.changes} expired session(s) removed`;
    },
  },
];

function jobByKey(key) {
  return JOBS.find((j) => j.key === key);
}

function isDue(job, nowMs) {
  const row = getRun.get(job.key);
  // Never run: due now. This makes the first cron hit after a deploy do a full
  // pass, which is also what makes a brand-new install populate itself.
  if (!row) return true;
  if (job.intervalMs) return nowMs - row.last_run_at >= job.intervalMs();
  return firedSince(job.cron(), row.last_run_at, nowMs);
}

async function runJob(job, { force = false } = {}) {
  const started = Date.now();
  try {
    const detail = await job.run();
    setRun.run(job.key, Date.now(), 'ok', null, Date.now() - started);
    return { job: job.key, ok: true, detail, ms: Date.now() - started, forced: force };
  } catch (err) {
    // The timestamp is still written on failure. Otherwise a job that throws
    // every time is "due" on every tick forever, and a broken nightly sync
    // would run on every single cron hit — turning one failure into hundreds.
    setRun.run(job.key, Date.now(), 'error', String(err && err.message || err), Date.now() - started);
    return { job: job.key, ok: false, error: String(err && err.message || err), ms: Date.now() - started, forced: force };
  }
}

// Runs every job that is due. Sequential on purpose: these jobs hit the same
// Google API quotas and the same SQLite file, and shared hosting gives the app
// a small memory allowance — running a sync and a report generation
// concurrently is how you get killed by the memory limit.
async function runDue({ only = null, force = false } = {}) {
  const now = Date.now();
  const selected = only ? JOBS.filter((j) => j.key === only) : JOBS;
  if (only && !selected.length) throw new Error(`unknown job "${only}"`);
  const results = [];
  for (const job of selected) {
    if (!force && !isDue(job, now)) {
      results.push({ job: job.key, ok: true, skipped: 'not due' });
      continue;
    }
    results.push(await runJob(job, { force }));
  }
  return results;
}

// What the settings page shows: whether scheduled work is actually happening.
// Worth surfacing because the failure mode this module exists to fix is
// invisible — a cron that was never configured looks exactly like one that is
// working until someone notices a missing report.
function status() {
  const now = Date.now();
  return JOBS.map((job) => {
    const row = getRun.get(job.key);
    return {
      key: job.key,
      label: job.label,
      schedule: job.intervalMs ? `every ${Math.round(job.intervalMs() / 60000)} min` : job.cron(),
      lastRunAt: row ? new Date(row.last_run_at).toISOString() : null,
      lastStatus: row ? row.last_status : null,
      lastError: row ? row.last_error : null,
      durationMs: row ? row.duration_ms : null,
      due: isDue(job, now),
    };
  });
}

// True when no job has ever run, which almost always means the hPanel cron job
// was never created.
function neverRan() {
  return JOBS.every((job) => !getRun.get(job.key));
}

// --- in-process mode ------------------------------------------------------
// Kept for local development and for anyone deploying to a VPS, where a
// long-lived process is real and an external cron is needless ceremony.
let started = false;
function startInProcess() {
  if (started) return;
  started = true;
  const cron = require('node-cron');
  JOBS.forEach((job) => {
    if (job.intervalMs) {
      const timer = setInterval(() => {
        runJob(job).then((r) => {
          if (!r.ok) console.error(`[cron] ${job.key} failed: ${r.error}`);
        });
      }, job.intervalMs());
      if (timer.unref) timer.unref();
      return;
    }
    const expr = job.cron();
    if (!cron.validate(expr)) {
      console.error(`[cron] invalid schedule "${expr}" for ${job.key} — skipped.`);
      return;
    }
    cron.schedule(expr, () => {
      runJob(job).then((r) => {
        console.log(`[cron] ${job.key}: ${r.ok ? r.detail : `FAILED ${r.error}`}`);
      });
    });
  });
  console.log('[cron] in-process scheduler started (INPROCESS_CRON).');
}

function start() {
  if (config.INPROCESS_CRON) {
    startInProcess();
  } else {
    console.log('[cron] in-process scheduler disabled; expecting external cron to call /internal/cron');
  }
}

module.exports = { JOBS, start, runDue, runJob, jobByKey, status, neverRan, firedSince, parseCron };
