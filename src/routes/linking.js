// Internal linking: start crawls and browse the CSV output as real, sortable,
// filterable tables — with the raw files still downloadable.
const express = require('express');
const path = require('path');
const db = require('../db');
const toolRunner = require('../lib/toolRunner');
const csvStore = require('../lib/csvStore');
const tasksLib = require('../lib/tasks');
const A = require('../lib/analytics');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const runs = db.prepare(`SELECT l.*, b.name brand_name FROM linking_runs l
      LEFT JOIN brands b ON b.id=l.brand_id
      WHERE l.user_id=? ORDER BY l.id DESC LIMIT 30`).all(userId)
      .map((r) => {
        let counts = null;
        let summary = null;
        if (r.json_result) {
          try {
            const j = JSON.parse(r.json_result);
            counts = j.counts || null;
            summary = j.summary || null;
          } catch { /* leave nulls */ }
        }
        return { ...r, counts, summary, json_result: undefined };
      });

    // Whether GSC blending is possible per brand, so the checkbox can explain
    // itself instead of silently doing nothing.
    const brands = brandsFor(userId).map((b) => ({
      ...b,
      hasGsc: Boolean(A.latestGscDate(b.id)),
    }));

    res.render('linking', {
      title: 'Internal linking',
      active: 'linking',
      pageTitle: 'Internal linking agent',
      runs, brands,
      tool: toolRunner.toolAvailability().linking,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/start', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
    let siteUrl = String(req.body.site_url || '').trim();

    if (brandId) {
      const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
      if (!brand) return res.redirect('/linking?error=' + encodeURIComponent('Brand not found.'));
      if (!siteUrl) siteUrl = brand.site_url;
    }
    if (!siteUrl) return res.redirect('/linking?error=' + encodeURIComponent('Enter a website URL or pick a brand.'));
    if (!/^https?:\/\//i.test(siteUrl)) siteUrl = `https://${siteUrl}`;

    const runId = toolRunner.startLinking({
      userId,
      brandId,
      siteUrl,
      maxPages: Math.min(2000, Math.max(10, parseInt(req.body.max_pages, 10) || 200)),
      useGsc: req.body.use_gsc === 'on',
      render: req.body.render === 'on',
      createTasks: req.body.create_tasks !== 'off',
    });

    res.redirect(`/linking/${runId}`);
  } catch (err) { next(err); }
});

// Run overview: headline numbers + a tab per CSV.
router.get('/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = db.prepare(`SELECT l.*, b.name brand_name FROM linking_runs l
      LEFT JOIN brands b ON b.id=l.brand_id WHERE l.id=? AND l.user_id=?`).get(req.params.id, userId);
    if (!run) {
      return res.status(404).render('error', { title: 'Not found', active: 'linking', message: 'That linking run does not exist.' });
    }

    let result = null;
    try { result = run.json_result ? JSON.parse(run.json_result) : null; } catch { result = null; }
    const inv = run.out_dir ? csvStore.inventory(run.out_dir) : { exists: false, files: [] };

    // Which CSV to show. Default to recommendations, the primary deliverable.
    const tabKey = req.query.tab || (inv.files.length ? inv.files[0].key : null);
    let table = null;
    if (tabKey && inv.exists) {
      const filters = {};
      ['confidence', 'status', 'severity', 'kind', 'classification'].forEach((c) => {
        if (req.query[`f_${c}`]) filters[c] = req.query[`f_${c}`];
      });
      table = csvStore.readTable(run.out_dir, tabKey, {
        search: req.query.q || '',
        sort: req.query.sort || '',
        dir: req.query.dir === 'desc' ? 'desc' : 'asc',
        page: parseInt(req.query.page, 10) || 1,
        perPage: Math.min(200, parseInt(req.query.per, 10) || 50),
        filters,
      });
    }

    const relatedTasks = db.prepare(`SELECT * FROM tasks WHERE source='linking' AND source_ref=?
      ORDER BY priority ASC LIMIT 60`).all(`linking:${run.id}`);

    res.render('linking-result', {
      title: `Internal linking · ${run.site_url}`,
      active: 'linking',
      pageTitle: 'Internal linking report',
      run, result, inv, table, tabKey, relatedTasks,
      isRunning: run.status === 'running',
      query: req.query,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.get('/:id/status', (req, res) => {
  const run = db.prepare('SELECT id, status, error, log_tail, finished_at FROM linking_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run) return res.status(404).json({ error: 'not found' });
  const lines = String(run.log_tail || '').split('\n').map((l) => l.trimEnd())
    .filter((l) => l.trim()).slice(-8);
  res.json({
    id: run.id,
    status: run.status,
    error: run.error,
    finishedAt: run.finished_at,
    progress: lines,
    live: toolRunner.isRunning('linking', run.id),
  });
});

router.post('/:id/cancel', (req, res) => {
  toolRunner.cancel('linking', Number(req.params.id));
  res.redirect(`/linking/${req.params.id}?msg=` + encodeURIComponent('Run cancelled.'));
});

router.post('/:id/create-tasks', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = db.prepare('SELECT * FROM linking_runs WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!run || !run.json_result) {
      return res.redirect('/linking?error=' + encodeURIComponent('That run has no results to turn into tasks.'));
    }
    const brand = run.brand_id ? db.prepare('SELECT * FROM brands WHERE id=?').get(run.brand_id) : null;
    const r = tasksLib.fromLinkingRun(run, brand);
    res.redirect(`/linking/${run.id}?msg=` + encodeURIComponent(
      r.created ? `${r.created} task${r.created === 1 ? '' : 's'} created.` : 'No new tasks — this run\'s findings already have tasks.'
    ));
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM linking_runs WHERE id=? AND user_id=?').run(req.params.id, req.dataUserId);
  res.redirect('/linking?msg=' + encodeURIComponent('Linking run deleted.'));
});

// Raw file download (any CSV in the run directory, plus the .docx).
router.get('/:id/download/:file', (req, res) => {
  const run = db.prepare('SELECT * FROM linking_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run || !run.out_dir) return res.status(404).send('Not found');
  const target = csvStore.resolveDownload(run.out_dir, req.params.file);
  if (!target) return res.status(404).send('File not available.');
  res.download(target, path.basename(target));
});

// The Word report the tool produces for clients.
router.get('/:id/report', (req, res) => {
  const run = db.prepare('SELECT * FROM linking_runs WHERE id=? AND user_id=?')
    .get(req.params.id, req.dataUserId);
  if (!run || !run.docx_path) return res.status(404).send('No document report available for this run.');
  res.download(run.docx_path, path.basename(run.docx_path));
});

module.exports = router;
