// The endpoint hPanel's cron job calls.
//
// Mounted before the authentication middleware, because cron has no session —
// so it authenticates with a shared secret instead, and the whole route is
// disabled unless one is configured. Without that, anyone who guessed the URL
// could trigger a full Google API sync and a round of alert emails on demand.
const express = require('express');
const crypto = require('crypto');
const scheduler = require('../lib/scheduler');
const config = require('../config');

const router = express.Router();

// Compared in constant time. The token travels in a URL that sits in a control
// panel field and in server logs, so it is not a high-value secret — but a
// timing-safe compare costs nothing and removes the question.
function tokenOk(supplied) {
  if (!config.CRON_TOKEN) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(config.CRON_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// wget/curl in a cron line can only really do a GET with the token in the query
// string, so both GET and POST are accepted, and the token is read from a
// header, the query string, or the body.
function authenticate(req, res, next) {
  if (!config.CRON_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: 'CRON_TOKEN is not set, so scheduled work cannot be triggered. Set it in .env and restart the app.',
    });
  }
  const supplied =
    req.get('x-cron-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    (req.body && req.body.token);
  if (!tokenOk(supplied)) {
    // Deliberately terse: a detailed error would help someone probe for the
    // token's length or format.
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return next();
}

// Runs everything that is due. This is the one URL that needs to be in cron.
//
// ?job=alerts       restricts the run to a single job
// ?force=1          runs regardless of whether the schedule says it is due
router.all('/', authenticate, async (req, res) => {
  const only = req.query.job || (req.body && req.body.job) || null;
  const force = req.query.force === '1' || (req.body && req.body.force === '1');
  const started = Date.now();
  try {
    const results = await scheduler.runDue({ only, force });
    const ran = results.filter((r) => !r.skipped);
    const failed = ran.filter((r) => !r.ok);
    // Plain text, because that is what lands in the cron email a control panel
    // sends on failure, and JSON in that email is unreadable.
    const lines = results.map((r) => {
      if (r.skipped) return `  - ${r.job}: skipped (${r.skipped})`;
      if (r.ok) return `  - ${r.job}: ok — ${r.detail} (${r.ms}ms)`;
      return `  - ${r.job}: FAILED — ${r.error} (${r.ms}ms)`;
    });
    const summary = `cron: ${ran.length} job(s) ran, ${failed.length} failed, ${Date.now() - started}ms`;
    if (ran.length) console.log(`[cron] ${summary}\n${lines.join('\n')}`);
    // A failing job returns 500 so the control panel's cron failure email
    // actually fires instead of the problem going unnoticed.
    res.status(failed.length ? 500 : 200);
    if (req.accepts('json') && !req.accepts('text/plain')) {
      return res.json({ ok: !failed.length, ran: ran.length, failed: failed.length, results });
    }
    return res.type('text/plain').send(`${summary}\n${lines.join('\n')}\n`);
  } catch (err) {
    console.error('[cron] tick failed:', err);
    return res.status(500).type('text/plain').send(`cron failed: ${err.message}\n`);
  }
});

// Read-only view of what has and has not been running. Useful for confirming
// the cron job was set up correctly without waiting an hour to find out.
router.get('/status', authenticate, (req, res) => {
  res.json({ ok: true, inProcess: config.INPROCESS_CRON, jobs: scheduler.status() });
});

module.exports = router;
