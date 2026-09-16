// CLIENT REPORT - the prospect-facing audit the sales team sends.
//
// Three surfaces, and the split between them is the whole design:
//
//   /client-report            the form and the history        (internal)
//   /client-report/:id        the build, its stages, its data (internal)
//   /client-report/:id/document  the document the client reads (deliverable)
//
// The document view renders nothing but the frozen payload on the row. It
// carries no app navigation, no internal links, no run ids and no "generated
// by" line naming a machine - because it is printed to PDF and emailed, and
// every one of those things reads as an internal screenshot rather than a
// professional deliverable.
const express = require('express');

const store = require('../lib/clientReport/store');
const runner = require('../lib/clientReport/runner');
const collect = require('../lib/clientReport/collect');
const branding = require('../lib/clientReport/branding');
const markets = require('../lib/aiseo/markets');
const google = require('../lib/google');

const router = express.Router();

const flash = (req) => ({ flash: req.query.msg || null, flashError: req.query.error || null });

function requireWrite(req, res) {
  if (res.locals.perms && res.locals.perms.canWrite) return true;
  res.redirect(`/client-report?error=${encodeURIComponent('Your role cannot build reports.')}`);
  return false;
}

// ------------------------------------------------------------------ list

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    res.render('client-report', {
      title: 'Client report',
      active: 'client-report',
      pageTitle: 'Client report',
      reports: store.list(userId, 40),
      profiles: collect.PROFILES,
      marketList: markets.all(),
      brand: branding.get(userId),
      activeRuns: runner.active(),
      // Both are prerequisites for a complete report rather than for any
      // report, so they are shown as notices on the form rather than blocking
      // it: a report without the speed section is still worth sending.
      googleConnected: Boolean(google.getConnection(userId)),
      ...flash(req),
    });
  } catch (err) { next(err); }
});

// The agency letterhead. Saved from the report form rather than from Settings,
// because this is the only place it is used and the person who notices it is
// missing is the person about to send a report.
router.post('/branding', (req, res) => {
  if (!requireWrite(req, res)) return;
  branding.save(req.dataUserId, {
    company: req.body.company,
    logo_url: req.body.logo_url,
    accent: req.body.accent,
    contact: req.body.contact,
    footer: req.body.footer,
    tagline: req.body.tagline,
  });
  res.redirect(`/client-report?msg=${encodeURIComponent('Report branding saved.')}`);
});

// ------------------------------------------------------------------- run

router.post('/run', (req, res) => {
  if (!requireWrite(req, res)) return;
  const fail = (msg) => res.redirect(`/client-report?error=${encodeURIComponent(msg)}`);

  let url = String(req.body.url || '').trim();
  if (!url) return fail('Enter the website address you want to report on.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return fail(`"${req.body.url}" is not a website address we can read.`);
  }

  const depth = req.body.depth === 'quick' ? 'quick' : 'full';

  try {
    const reportId = runner.launch({
      userId: req.dataUserId,
      createdBy: req.actorId || req.dataUserId,
      url,
      domain,
      company: String(req.body.company || '').trim() || null,
      preparedFor: String(req.body.prepared_for || '').trim() || null,
      market: markets.resolve(req.body.market).code,
      depth,
    });
    return res.redirect(`/client-report/${reportId}`);
  } catch (err) {
    return fail(err.busy ? err.message : `Could not start the report: ${err.message}`);
  }
});

// ---------------------------------------------------------------- one run

router.get('/:id', (req, res, next) => {
  try {
    const report = store.get(req.params.id, req.dataUserId);
    if (!report) {
      return res.status(404).render('error', {
        title: 'Not found', active: 'client-report',
        message: 'That client report does not exist, or belongs to another workspace.',
      });
    }
    res.render('client-report-run', {
      title: `Client report · ${report.domain || report.url}`,
      active: 'client-report',
      pageTitle: 'Client report',
      report,
      live: runner.isRunning(report.id),
      orphaned: report.status === 'running' && !runner.isRunning(report.id),
      ...flash(req),
    });
  } catch (err) { next(err); }
});

// Polled by the page above while the report is being built.
router.get('/:id/status', (req, res) => {
  const s = runner.status(req.params.id, req.dataUserId);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

// ------------------------------------------------------------- deliverable

router.get('/:id/document', (req, res, next) => {
  try {
    const report = store.get(req.params.id, req.dataUserId);
    if (!report || !report.result) {
      return res.status(404).render('error', {
        title: 'Not ready', active: 'client-report',
        message: report
          ? 'That report has not finished building yet, so there is no document to show.'
          : 'That client report does not exist, or belongs to another workspace.',
      });
    }
    // A document about someone else's website should never be indexed, even
    // though this route needs a session to reach: the same defence the weekly
    // report's share links carry, for the same reason.
    res.set({
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    });
    res.render('client-report-doc', {
      layout: false,
      row: report,
      d: report.result,
    });
  } catch (err) { next(err); }
});

router.get('/:id/json', (req, res) => {
  const report = store.get(req.params.id, req.dataUserId);
  if (!report) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(JSON.stringify({
    id: report.id,
    url: report.url,
    status: report.status,
    score: report.score,
    grade: report.grade,
    startedAt: report.started_at,
    finishedAt: report.finished_at,
    result: report.result,
  }, null, 2));
});

router.post('/:id/delete', (req, res) => {
  if (!requireWrite(req, res)) return;
  if (runner.isRunning(req.params.id)) {
    return res.redirect(`/client-report/${req.params.id}?error=${encodeURIComponent('That report is still being built. Wait for it to finish before deleting it.')}`);
  }
  store.remove(req.params.id, req.dataUserId);
  res.redirect(`/client-report?msg=${encodeURIComponent('Report deleted.')}`);
});

module.exports = router;
