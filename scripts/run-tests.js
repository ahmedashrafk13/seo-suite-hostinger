#!/usr/bin/env node
// The test runner for the verification harnesses in this directory.
//
// Each harness is a standalone script that asserts against the real app and a
// real database, and exits non-zero when a check fails. This runner exists so
// there is one command that runs all of them and fails the run if any of them
// fails -- previously they could only be run by hand, one at a time, which in
// practice meant they were run rarely and drifted out of date.
//
//   npm test           the offline suite: deterministic, no network
//   npm run test:net   adds the harnesses that fetch live URLs
//   npm run test:all   both
//
// A harness is listed with the time it needs, not a uniform timeout: the
// crawl and action suites legitimately take minutes, and killing them at 60s
// would report a passing suite as broken.
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = {
  // Offline and deterministic. These must pass before anything ships.
  offline: [
    ['verify_security.js', 240],
    ['verify_links.js', 180],
    ['verify_pages.js', 180],
    ['verify_nav.js', 60],
    ['verify_actions.js', 420],
    ['verify_leads.js', 120],
    ['verify_assignments.js', 120],
    ['verify_content_brief.js', 120],
    ['verify_lifecycle_and_places.js', 120],
    ['verify_gaps.js', 180],
    ['verify_aiseo.js', 300],
    ['verify_ai_referrals.js', 120],
    ['verify_difficulty_backfill.js', 120],
    ['verify_keyword_planner.js', 120],
    ['verify_keyword_planner_lib.js', 120],
    ['verify_planner_clustering.js', 120],
    ['verify_js_rendering.js', 120],
    ['verify_render_budget.js', 120],
  ],
  // Fetch live URLs. Excluded from `npm test` because a failure here can mean
  // the network, not the code -- which is exactly the kind of noise that makes
  // people stop trusting a suite.
  net: [
    ['verify_crawl_access.js', 600],
  ],
};

// Not wired into any suite, with the reason, so that a harness is never
// quietly dropped:
//   verify_team.js     - asserts that open signup creates a team, but signup
//                        became invite-only. The harness needs to sign up
//                        through an invite before it can be trusted again.
//   verify_renderer.js - two checks assert against the live content of a
//                        third-party page, so they fail when that page changes
//                        rather than when the renderer breaks.

const arg = (process.argv[2] || 'offline').replace(/^--/, '');
const groups = arg === 'all' ? ['offline', 'net'] : [arg];
for (const g of groups) {
  if (!SUITES[g]) {
    console.error(`unknown suite "${g}" -- expected one of: offline, net, all`);
    process.exit(2);
  }
}

const jobs = groups.flatMap((g) => SUITES[g]);
const started = Date.now();
const failed = [];

console.log(`running ${jobs.length} harness(es): ${groups.join(' + ')}\n`);

for (const [file, timeoutSec] of jobs) {
  const t0 = Date.now();
  process.stdout.write(`${file.padEnd(34)} `);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.join(__dirname, '..'),
    timeout: timeoutSec * 1000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const ok = !timedOut && res.status === 0;
  if (ok) {
    console.log(`PASS  ${secs}s`);
  } else {
    console.log(`FAIL  ${secs}s${timedOut ? `  (timed out after ${timeoutSec}s)` : ''}`);
    failed.push({ file, output: `${res.stdout || ''}${res.stderr || ''}` });
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${jobs.length - failed.length}/${jobs.length} harnesses passed in ${elapsed}s`);

if (failed.length) {
  for (const f of failed) {
    console.log(`\n${'='.repeat(70)}\n${f.file}\n${'='.repeat(70)}`);
    console.log(f.output.split(/\r?\n/).slice(-25).join('\n'));
  }
  process.exit(1);
}
