// Technical SEO audit: start crawls, watch progress, read findings grouped by
// severity with the affected URLs and recommended action for each.
const express = require('express');
const db = require('../db');
const toolRunner = require('../lib/toolRunner');
const pythonEnv = require('../lib/pythonEnv');
const csvStore = require('../lib/csvStore');
const tasksLib = require('../lib/tasks');
const { buildWorkbook, sendWorkbook } = require('../lib/xlsxExport');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const runs = db.prepare(`SELECT a.*, b.name brand_name FROM audit_runs a
      LEFT JOIN brands b ON b.id=a.brand_id
      WHERE a.user_id=? ORDER BY a.id DESC LIMIT 30`).all(userId)
      .map((r) => {
        // Surface the headline numbers in the list without shipping the whole
        // JSON payload to the template.
        let health = null;
        let issues = null;
        if (r.json_result) {
          try {
            const j = JSON.parse(r.json_result);
            health = j.site_health;
            issues = j.counts ? (j.counts.error || 0) + (j.counts.warning || 0) : null;
          } catch { /* leave nulls */ }
        }
        return { ...r, health, issues, json_result: undefined };
      });

    res.render('audit', {
      title: 'Technical audit',
      active: 'audit',
      pageTitle: 'Technical SEO audit',
      runs,
      brands: brandsFor(userId),
      tool: toolRunner.toolAvailability().audit,
      python: toolRunner.toolAvailability().python,
      pythonStatus: pythonEnv.status().find((x) => x.tool === 'audit'),
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Installs the crawler's Python packages into the interpreter the app will
// actually use. Admin-only and explicitly invoked, because it changes the
// machine's Python environment rather than anything inside this app.
router.post('/install-deps', (req, res) => {
  if (!res.locals.perms.isAdmin) {
    return res.redirect('/audit?error=' + encodeURIComponent('Only a team admin can install dependencies.'));
  }
  const r = pythonEnv.install('audit');
  if (r.ok) {
    return res.redirect('/audit?msg=' + encodeURIComponent(
      r.alreadySatisfied
        ? 'Dependencies were already installed — audits are ready to run.'
        : `Installed. Audits will now run with ${r.bin}.`
    ));
  }
  res.redirect('/audit?error=' + encodeURIComponent(r.error));
});

router.post('/start', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
    let domain = String(req.body.domain || '').trim();

    // Choosing a brand is the normal path; the URL is then implied.
    if (brandId) {
      const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
      if (!brand) return res.redirect('/audit?error=' + encodeURIComponent('Brand not found.'));
      if (!domain) domain = brand.site_url;
    }
    if (!domain) return res.redirect('/audit?error=' + encodeURIComponent('Enter a website URL or pick a brand.'));
    if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`;

    const runId = toolRunner.startAudit({
      userId,
      brandId,
      domain,
      maxPages: Math.min(2000, Math.max(5, parseInt(req.body.max_pages, 10) || 100)),
      render: req.body.render || 'auto',
      createTasks: req.body.create_tasks !== 'off',
    });

    res.redirect(`/audit/${runId}`);
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = db.prepare(`SELECT a.*, b.name brand_name, b.id brand_id FROM audit_runs a
      LEFT JOIN brands b ON b.id=a.brand_id
      WHERE a.id=? AND a.user_id=?`).get(req.params.id, userId);
    if (!run) {
      return res.status(404).render('error', { title: 'Not found', active: 'audit', message: 'That audit run does not exist.' });
    }

    const report = run.json_result ? csvStore.normaliseAuditFindings(run.json_result) : null;
    const relatedTasks = db.prepare(`SELECT * FROM tasks WHERE source='audit' AND source_ref LIKE ?
      ORDER BY priority ASC LIMIT 60`).all(`audit:${run.id}:%`);

    // The previous completed crawl of the same target, for a before/after read.
    const previous = db.prepare(`SELECT id, created_at, json_result FROM audit_runs
      WHERE user_id=? AND domain=? AND status='completed' AND id < ? ORDER BY id DESC LIMIT 1`)
      .get(userId, run.domain, run.id);
    let previousReport = null;
    if (previous) {
      const p = csvStore.normaliseAuditFindings(previous.json_result);
      if (p) previousReport = { id: previous.id, created_at: previous.created_at, health: p.health, bySeverity: p.bySeverity, failingIds: p.failing.map((f) => f.id) };
    }

    res.render('audit-result', {
      title: `Audit · ${run.domain}`,
      active: 'audit',
      pageTitle: 'Audit report',
      run, report, previousReport, relatedTasks,
      isRunning: run.status === 'running',
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Polled by the result page while a crawl is in flight.
router.get('/:id/status', (req, res) => {
  const run = db.prepare('SELECT id, status, error, log_tail, finished_at FROM audit_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run) return res.status(404).json({ error: 'not found' });

  // Show the last few meaningful lines rather than raw JSON spilling into the UI.
  const lines = String(run.log_tail || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('{') && !l.startsWith('"') && !l.startsWith('}'))
    .slice(-6);

  res.json({
    id: run.id,
    status: run.status,
    error: run.error,
    finishedAt: run.finished_at,
    progress: lines,
    live: toolRunner.isRunning('audit', run.id),
  });
});

router.post('/:id/cancel', (req, res) => {
  toolRunner.cancel('audit', Number(req.params.id));
  res.redirect(`/audit/${req.params.id}?msg=` + encodeURIComponent('Run cancelled.'));
});

router.post('/:id/create-tasks', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = db.prepare('SELECT * FROM audit_runs WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!run || !run.json_result) {
      return res.redirect('/audit?error=' + encodeURIComponent('That run has no results to turn into tasks.'));
    }
    const brand = run.brand_id ? db.prepare('SELECT * FROM brands WHERE id=?').get(run.brand_id) : null;
    const r = tasksLib.fromAuditRun(run, brand, { minTier: req.body.min_tier || 'warning' });
    res.redirect(`/audit/${run.id}?msg=` + encodeURIComponent(
      r.created ? `${r.created} task${r.created === 1 ? '' : 's'} created from ${r.considered} failing check(s).`
        : `No new tasks — all ${r.considered || 0} failing check(s) already have one.`
    ));
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM audit_runs WHERE id=? AND user_id=?').run(req.params.id, req.dataUserId);
  res.redirect('/audit?msg=' + encodeURIComponent('Audit run deleted.'));
});

// Printable / saveable report rendered from the audit JSON.
// (main.py cannot emit both --json and a document in one crawl, so the
// document is produced here from the structured result instead.)
router.get('/:id/export', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = db.prepare(`SELECT a.*, b.name brand_name FROM audit_runs a
      LEFT JOIN brands b ON b.id=a.brand_id WHERE a.id=? AND a.user_id=?`).get(req.params.id, userId);
    if (!run || !run.json_result) {
      return res.status(404).render('error', { title: 'Not found', active: 'audit', message: 'No report available for that run.' });
    }
    const report = csvStore.normaliseAuditFindings(run.json_result);
    res.render('audit-export', { run, report, layout: false });
  } catch (err) { next(err); }
});

// Machine-readable export, for anyone wiring this into a sheet or BI tool.
router.get('/:id/json', (req, res) => {
  const run = db.prepare('SELECT json_result FROM audit_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run || !run.json_result) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(run.json_result);
});

// Findings as CSV: severity, affected URL, issue type, recommended action —
// exactly the deliverable shape asked for.
router.get('/:id/csv', async (req, res) => {
  const run = db.prepare('SELECT * FROM audit_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run || !run.json_result) return res.status(404).send('Not found');
  const report = csvStore.normaliseAuditFindings(run.json_result);
  if (!report) return res.status(500).send('Could not parse the audit result.');

  const rows = [];
  report.failing.forEach((f) => {
    if (!f.items.length) {
      rows.push({ severity: f.severity, issue_type: f.issue, affected_url: '', detail: f.summary, found_on: '', recommended_action: f.action, affected_count: f.failed });
      return;
    }
    f.items.forEach((item) => {
      rows.push({
        severity: f.severity, issue_type: f.issue, affected_url: item.url || '',
        detail: item.note || f.summary,
        found_on: item.sources && item.sources.length ? item.sources.join('; ') : '',
        recommended_action: f.action, affected_count: f.failed,
      });
    });
  });

  const workbook = buildWorkbook({
    sheets: [{
      name: 'Findings',
      columns: [
        { header: 'Severity', key: 'severity', width: 12, dropdown: ['critical', 'high', 'medium', 'low', 'info'] },
        { header: 'Issue Type', key: 'issue_type', width: 30 },
        { header: 'Affected URL', key: 'affected_url', width: 50 },
        { header: 'Detail', key: 'detail', width: 50 },
        { header: 'Found On / Duplicate Pages', key: 'found_on', width: 60 },
        { header: 'Recommended Action', key: 'recommended_action', width: 50 },
        { header: 'Affected Count', key: 'affected_count', width: 14 },
      ],
      rows,
    }],
  });

  const host = String(run.domain).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_');
  await sendWorkbook(res, workbook, `seo-audit-${host}-run${run.id}.xlsx`);
});

module.exports = router;
