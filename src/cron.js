// Command-line entry point for scheduled work: `npm run cron`.
//
// The HTTP endpoint (routes/cron.js) is the right mechanism on Hostinger's
// Node hosting, because a cron line there can only fetch a URL. But some plans
// expose real shell cron, where running the job directly is simpler and avoids
// depending on the web process being reachable:
//
//   */15 * * * * cd ~/seo-suite && /usr/bin/node src/cron.js >> ~/cron.log 2>&1
//
// Both paths call the same scheduler.runDue(), so the two are interchangeable —
// and safe to have both, since a job that has just run is no longer due.
const scheduler = require('./lib/scheduler');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--job=')) || '').split('=')[1] || null;
const force = args.includes('--force');
const listOnly = args.includes('--status');

(async () => {
  if (listOnly) {
    const rows = scheduler.status();
    const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);
    console.log(`${pad('JOB', 14)}${pad('SCHEDULE', 18)}${pad('LAST RUN', 26)}${pad('STATUS', 8)}DUE`);
    rows.forEach((r) => {
      console.log(
        `${pad(r.key, 14)}${pad(r.schedule, 18)}${pad(r.lastRunAt, 26)}${pad(r.lastStatus, 8)}${r.due ? 'yes' : 'no'}`
      );
      if (r.lastError) console.log(`  last error: ${r.lastError}`);
    });
    process.exit(0);
  }

  try {
    const results = await scheduler.runDue({ only, force });
    let failed = 0;
    results.forEach((r) => {
      if (r.skipped) return; // silent: the common case is "nothing was due"
      if (r.ok) console.log(`[cron] ${r.job}: ${r.detail} (${r.ms}ms)`);
      else { failed += 1; console.error(`[cron] ${r.job} FAILED: ${r.error}`); }
    });
    // Non-zero exit makes cron send its failure mail.
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error(`[cron] ${err.message}`);
    process.exit(1);
  }
})();
