// BACKGROUND EXECUTION FOR THE AI SEO ANALYSES
//
// WHY THESE CANNOT RUN INSIDE THE REQUEST
// A readiness check probes fifteen user agents, measures TTFB three times and
// calls PageSpeed Insights, which routinely takes 30-60 seconds on its own. A
// competitive run crawls several sites. Holding an HTTP request open for that
// long fails in three ways on this deployment: Passenger times the request
// out, the browser shows nothing while it waits, and a user who reloads
// starts a second identical run.
//
// So the route creates the run row synchronously, redirects the browser to a
// result page that polls, and the work continues detached — exactly the shape
// the existing /audit and /linking features already use, except that these
// stay in this process instead of spawning a child.
//
// STAYING IN-PROCESS IS DELIBERATE
// This deployment runs SQLite through the WebAssembly driver, which is
// single-writer: a second process opening data/app.db while the server is
// running has corrupted it before. A child process would need its own
// connection. Everything here shares the connection db.js already owns.
//
// THE FAILURE THIS MODULE EXISTS TO CONTAIN
// A detached promise that rejects with nobody listening kills the process on
// modern Node. Every launch is therefore wrapped so a rejection becomes an
// 'error' status on the run row and a log line, never an unhandled rejection.
const db = require('../../db');
const store = require('./store');

// runId -> { kind, brandId, startedMs, label }
// In-memory only, and deliberately so: it answers "is this still running in
// THIS process", which is exactly the question a stale 'running' row cannot.
// See reconcileOnBoot for the other half.
const inflight = new Map();

// How many analyses may run at once across the whole app.
//
// Two, not more. Each one crawls, and shared hosting gives this app a small
// memory allowance and a modest connection budget; three concurrent crawls is
// how the process gets killed by the memory limit mid-write. Anything beyond
// the limit is refused with an explanation rather than queued, because a
// silently queued run looks identical to a stuck one.
const MAX_CONCURRENT = Number(process.env.AISEO_MAX_CONCURRENT || 2);

function activeCount() { return inflight.size; }
function isRunning(runId) { return inflight.has(Number(runId)); }
function active() {
  return [...inflight.entries()].map(([id, meta]) => ({ id, ...meta, elapsedMs: Date.now() - meta.startedMs }));
}

// Starts an analysis and returns its run id immediately.
//
// `engine` is any of the modules in this directory exposing
// run({ userId, brand, adoptRunId, ... }).
function launch({
  userId, brand, kind, engine, args = {}, target = null, label = null, params = null,
}) {
  if (inflight.size >= MAX_CONCURRENT) {
    const err = new Error(
      `${inflight.size === 1 ? '1 analysis is' : `${inflight.size} analyses are`} already running (${active().map((a) => a.kind).join(', ')}). `
      + 'These crawl live sites, so they are limited to '
      + `${MAX_CONCURRENT} at a time to stay inside this host's memory allowance. Wait for one to finish.`,
    );
    err.busy = true;
    throw err;
  }

  const row = store.begin({
    userId,
    brandId: brand ? brand.id : null,
    kind,
    target,
    label,
    params,
  });

  inflight.set(row.id, { kind, brandId: brand ? brand.id : null, startedMs: Date.now(), label });

  // Not awaited: that is the point. Errors are handled inside so nothing
  // escapes as an unhandled rejection.
  Promise.resolve()
    .then(() => engine.run({ ...args, userId, brand, adoptRunId: row.id }))
    .then(() => {
      // The engine has already written the completed row through store.finish.
      // Turn its findings into tasks right away — the same call the "Create
      // tasks" button makes, just without waiting for anyone to click it.
      // upsertTask is dedupe-key-safe, so a later manual click is a no-op.
      try {
        const finished = store.get(row.id, userId);
        if (finished && finished.status === 'completed' && typeof engine.toTasks === 'function') {
          engine.toTasks(finished, brand || null, { userId });
        }
      } catch (e) {
        console.error(`[aiseo] auto task creation failed for ${kind} run ${row.id}:`, e.message);
      }
    })
    .catch((err) => {
      // The engines call store.fail themselves and rethrow, so this is
      // usually already recorded. Writing again is harmless and covers the
      // case where the throw happened before the engine's own try block.
      console.error(`[aiseo] ${kind} run ${row.id} failed:`, err && err.message);
      try {
        const current = db.prepare('SELECT status FROM aiseo_runs WHERE id=?').get(row.id);
        if (current && current.status === 'running') store.fail(row.id, err);
      } catch (e) {
        console.error('[aiseo] could not record the failure:', e.message);
      }
    })
    .finally(() => { inflight.delete(row.id); });

  return row.id;
}

// A run marked 'running' whose process no longer exists.
//
// Called at boot. Passenger stops this app whenever it goes idle, which will
// happen in the middle of a crawl sooner or later; without this the run row
// stays 'running' forever and its result page polls indefinitely, which reads
// as "still working" rather than "was interrupted".
function reconcileOnBoot() {
  const stale = db.prepare("SELECT id, kind, started_at FROM aiseo_runs WHERE status='running'").all();
  if (!stale.length) return { reconciled: 0 };
  db.prepare(`UPDATE aiseo_runs SET status='error',
      error='Interrupted — the application was stopped or restarted while this analysis was running. Start it again.',
      finished_at=datetime('now')
    WHERE status='running'`).run();
  console.log(`[aiseo] marked ${stale.length} interrupted run(s) as failed: ${stale.map((s) => `${s.kind}#${s.id}`).join(', ')}`);
  return { reconciled: stale.length, runs: stale };
}

// Status for the polling endpoint the result pages use.
function status(runId, userId) {
  const run = db.prepare(`SELECT id, kind, status, score, error, started_at, finished_at, ms,
      (SELECT COUNT(*) FROM aiseo_findings f WHERE f.run_id = aiseo_runs.id) findings
    FROM aiseo_runs WHERE id=? AND user_id=?`).get(runId, userId);
  if (!run) return null;
  return {
    ...run,
    live: isRunning(runId),
    // A row that says 'running' but is not live in this process was
    // interrupted. Surfaced as a distinct state so the page can say so
    // instead of spinning forever.
    orphaned: run.status === 'running' && !isRunning(runId),
  };
}

module.exports = {
  launch, isRunning, activeCount, active, reconcileOnBoot, status, MAX_CONCURRENT,
};
