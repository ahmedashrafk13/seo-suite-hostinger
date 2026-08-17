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
