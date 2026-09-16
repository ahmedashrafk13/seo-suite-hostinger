// Background execution for client reports.
//
// Same shape, and the same reasons, as lib/aiseo/runner.js: the work takes
// minutes, Passenger times out a held request, a browser showing nothing looks
// broken, and a reload would start a second identical run. So the route creates
// the row, redirects to a page that polls, and the work continues detached.
//
// ONE AT A TIME
// Lower than the AI SEO limit of two, deliberately. A client report drives a
// full site crawl, a second crawlability crawl, up to five PageSpeed runs and
// a paced sequence of search samples - it is several of those analyses back to
// back. Two at once on a shared host is how the process gets killed by the
// memory limit halfway through, which leaves a half-built report and a sales
// meeting with nothing to show.
const store = require('./store');
const build = require('./build');

const MAX_CONCURRENT = Number(process.env.CLIENT_REPORT_MAX_CONCURRENT || 1);

// reportId -> { url, startedMs, company }
const inflight = new Map();

function activeCount() { return inflight.size; }
function isRunning(reportId) { return inflight.has(Number(reportId)); }
function active() {
  return [...inflight.entries()].map(([id, meta]) => ({ id, ...meta, elapsedMs: Date.now() - meta.startedMs }));
}

function launch({
  userId, createdBy, url, domain, company, preparedFor, market, depth,
}) {
  if (inflight.size >= MAX_CONCURRENT) {
    const err = new Error(
      `A client report is already being built (${active().map((a) => a.domain || a.url).join(', ')}). `
      + 'Each one crawls a whole site, so they run one at a time on this host. Wait for it to finish.',
    );
    err.busy = true;
    throw err;
  }

  const reportId = store.begin({
    userId, createdBy, url, domain, company, preparedFor, market, depth,
  });
  inflight.set(reportId, { url, domain, company, startedMs: Date.now() });

  // Not awaited: that is the point. Every failure is recorded on the row, so
  // nothing escapes as an unhandled rejection - which on modern Node would
  // take the whole process down and with it everyone else's session.
  Promise.resolve()
    .then(() => build.run({ userId, reportId, url, company, preparedFor, market, depth }))
    .catch((err) => {
      console.error(`[client-report] run ${reportId} failed:`, err && err.message);
      try { store.fail(reportId, err); } catch (e) {
        console.error('[client-report] could not record the failure:', e.message);
      }
    })
    .finally(() => { inflight.delete(reportId); });

  return reportId;
}

// A row saying 'running' that is not live in this process was interrupted.
// Surfaced as its own state so the page can say so instead of spinning forever.
function status(reportId, userId) {
  const s = store.status(reportId, userId);
  if (!s) return null;
  return {
    ...s,
    live: isRunning(reportId),
    orphaned: s.status === 'running' && !isRunning(reportId),
  };
}

module.exports = { launch, isRunning, activeCount, active, status, MAX_CONCURRENT };
