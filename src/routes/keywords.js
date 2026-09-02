// Keyword clustering: paste or upload a list, or pull the brand's own Search
// Console queries, and get clusters with intent, page type and an
// existing-page-vs-new-page recommendation.
const express = require('express');
const db = require('../db');
const clustering = require('../lib/clustering');
const tasksLib = require('../lib/tasks');
const contentBrief = require('../lib/contentBrief');
const { buildWorkbook, sendWorkbook } = require('../lib/xlsxExport');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId).map((b) => ({
      ...b,
      gscQueries: db.prepare('SELECT COUNT(DISTINCT query) n FROM gsc_query_daily WHERE brand_id=?').get(b.id).n,
    }));
    res.render('keywords', {
      title: 'Keyword clustering',
      active: 'keywords',
      pageTitle: 'Keyword clustering',
      brands,
      runs: clustering.listRuns(userId),
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/run', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
    const brand = brandId ? db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId) : null;
    if (brandId && !brand) return res.redirect('/keywords?error=' + encodeURIComponent('Brand not found.'));

    const source = req.body.source === 'gsc' ? 'gsc' : 'manual';
    let input = [];
    let name = String(req.body.name || '').trim() || null;

    if (source === 'gsc') {
      if (!brand) return res.redirect('/keywords?error=' + encodeURIComponent('Pick a brand to pull Search Console keywords from.'));
      input = clustering.keywordsFromGsc(brand.id, {
        days: Math.min(480, Math.max(7, parseInt(req.body.days, 10) || 90)),
        minImpressions: Math.max(1, parseInt(req.body.min_impressions, 10) || 20),
        limit: Math.min(5000, Math.max(10, parseInt(req.body.limit, 10) || 1500)),
      });
      if (!input.length) {
        return res.redirect('/keywords?error=' + encodeURIComponent(
          'No Search Console keywords matched those settings. Lower the minimum impressions, widen the window, or sync the brand first.'
        ));
      }
      if (!name) name = `${brand.name} — Search Console keywords`;
    } else {
      input = clustering.parseKeywordInput(req.body.keywords || '');
      if (!input.length) {
        return res.redirect('/keywords?error=' + encodeURIComponent('No keywords were found in that input. Paste one keyword per line, or a CSV with a "keyword" column.'));
      }
      if (!name) name = `Pasted list (${input.length} keywords)`;
    }

    const result = clustering.cluster(input, {
      brandId: brand ? brand.id : null,
      vertical: (brand && brand.vertical) || 'other',
      locale: (brand && brand.locale) || 'en',
      market: (brand && brand.market) || null,
      minSimilarity: Math.min(0.9, Math.max(0.1, parseFloat(req.body.min_similarity) || 0.4)),
    });

    const runId = clustering.saveRun(userId, brand ? brand.id : null, name, source, result);
    res.redirect(`/keywords/${runId}`);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ content briefs
// Registered before GET /:id — Express matches routes in definition order,
// and a bare "/:id" pattern would otherwise swallow "/briefs" as if "briefs"
// were a run id (confirmed as a real bug during testing: GET /keywords/briefs
// 404'd because it hit /:id first with id="briefs").

router.get('/briefs', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const selectedBrand = req.query.brand ? Number(req.query.brand) : null;
    res.render('brief-list', {
      title: 'Content briefs', active: 'briefs', pageTitle: 'Content briefs',
      briefs: contentBrief.list(userId, selectedBrand),
      brands: brandsFor(userId),
      selectedBrand,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.get('/brief/:briefId', (req, res, next) => {
  try {
    const row = contentBrief.get(req.params.briefId, req.dataUserId);
    if (!row || !row.data) {
      return res.status(404).render('error', { title: 'Not found', active: 'keywords', message: 'That content brief does not exist.' });
    }
    res.render('brief-detail', {
      title: `Brief — ${row.primary_keyword}`, active: 'briefs', pageTitle: 'Content brief',
      row, d: row.data,
      // Stored briefs are frozen snapshots; the view warns when one predates
      // the current generator so nobody writes from stale output.
      currentSchemaVersion: contentBrief.SCHEMA_VERSION,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/brief/:briefId/delete', (req, res) => {
  db.prepare('DELETE FROM content_briefs WHERE id=? AND user_id=?').run(req.params.briefId, req.dataUserId);
  res.redirect('/keywords/briefs?msg=' + encodeURIComponent('Brief deleted.'));
});

router.get('/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = clustering.getRun(req.params.id, userId);
    if (!run || !run.result) {
      return res.status(404).render('error', { title: 'Not found', active: 'keywords', message: 'That clustering run does not exist.' });
    }

    // Filters over the cluster list.
    let clusters = run.result.clusters;
    if (req.query.intent) clusters = clusters.filter((c) => c.intent === req.query.intent);
    if (req.query.rec) clusters = clusters.filter((c) => c.recommendation === req.query.rec);
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      clusters = clusters.filter((c) => c.primaryKeyword.includes(q)
        || c.supportingKeywords.some((k) => k.includes(q)));
    }

    const intents = [...new Set(run.result.clusters.map((c) => c.intent))].sort();
    const recs = [...new Set(run.result.clusters.map((c) => c.recommendation))].sort();

    const approvedRows = db.prepare('SELECT cluster_id, approved_by, approved_at FROM approved_clusters WHERE keyword_run_id=?').all(run.id);
    const approvedById = new Map(approvedRows.map((r) => [r.cluster_id, r]));

    res.render('keyword-result', {
      title: run.name || 'Clustering run',
      active: 'keywords',
      pageTitle: run.name || 'Keyword clusters',
      run, clusters, intents, recs, approvedById,
      query: req.query,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// A cluster must be approved before "Content brief" will generate one — see
// the approved_clusters table comment in db.js for why.
router.post('/:id/cluster/:clusterId/approve', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = clustering.getRun(req.params.id, userId);
    if (!run || !run.result) return res.redirect('/keywords?error=' + encodeURIComponent('Run not found.'));
    const cluster = run.result.clusters.find((c) => c.id === Number(req.params.clusterId));
    if (!cluster) return res.redirect(`/keywords/${run.id}?error=` + encodeURIComponent('Cluster not found.'));

    const approver = (res.locals.currentUser && (res.locals.currentUser.name || res.locals.currentUser.email)) || 'SEO team';
    db.prepare(`INSERT INTO approved_clusters (user_id, keyword_run_id, cluster_id, primary_keyword, approved_by)
      VALUES (?,?,?,?,?)
      ON CONFLICT(keyword_run_id, cluster_id) DO UPDATE SET approved_by=excluded.approved_by, approved_at=datetime('now')`)
      .run(userId, run.id, cluster.id, cluster.primaryKeyword, approver);
    res.redirect(`/keywords/${run.id}?msg=` + encodeURIComponent(`Approved "${cluster.primaryKeyword}" for content — brief can now be generated.`));
  } catch (err) { next(err); }
});

router.post('/:id/cluster/:clusterId/unapprove', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = clustering.getRun(req.params.id, userId);
    if (!run) return res.redirect('/keywords?error=' + encodeURIComponent('Run not found.'));
    db.prepare('DELETE FROM approved_clusters WHERE keyword_run_id=? AND cluster_id=?').run(run.id, req.params.clusterId);
    res.redirect(`/keywords/${run.id}?msg=` + encodeURIComponent('Approval withdrawn.'));
  } catch (err) { next(err); }
});

router.post('/:id/create-tasks', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = clustering.getRun(req.params.id, userId);
    if (!run || !run.result) return res.redirect('/keywords?error=' + encodeURIComponent('Run not found.'));
    const outcome = clustering.clustersToTasks(run.id, userId, run.brand_id, run.result, tasksLib, {
      maxTasks: Math.min(100, parseInt(req.body.limit, 10) || 25),
    });
    const created = outcome.created;
    const retired = outcome.retired;

    const parts = [];
    parts.push(created
      ? `${created} content task${created === 1 ? '' : 's'} added to the backlog.`
      : 'No new tasks — these clusters already have tasks.');
    if (retired && retired.resolved) {
      parts.push(`${retired.resolved} earlier cluster task${retired.resolved === 1 ? '' : 's'} auto-resolved — those topics no longer appear.`);
    }
    if (retired && retired.annotated) {
      parts.push(`${retired.annotated} in-progress task${retired.annotated === 1 ? '' : 's'} flagged as no longer detected, but left open.`);
    }
    if (outcome.cappedAt) {
      parts.push(`Only the top ${outcome.cappedAt} topics were filed, so nothing was auto-resolved this run.`);
    }
    res.redirect(`/keywords/${run.id}?msg=` + encodeURIComponent(parts.join(' ')));
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM keyword_runs WHERE id=? AND user_id=?').run(req.params.id, req.dataUserId);
  res.redirect('/keywords?msg=' + encodeURIComponent('Clustering run deleted.'));
});

router.post('/:id/cluster/:clusterId/brief', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const run = clustering.getRun(req.params.id, userId);
    if (!run || !run.result) return res.redirect('/keywords?error=' + encodeURIComponent('Run not found.'));
    if (!run.brand_id) {
      return res.redirect(`/keywords/${run.id}?error=` + encodeURIComponent(
        'This run has no brand attached, so a brief cannot look up the brand\'s services, CTA, or crawled pages. Re-run clustering with a brand selected.'
      ));
    }
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(run.brand_id, userId);
    if (!brand) return res.redirect(`/keywords/${run.id}?error=` + encodeURIComponent('Brand not found.'));

    const approved = db.prepare('SELECT 1 FROM approved_clusters WHERE keyword_run_id=? AND cluster_id=?')
      .get(run.id, req.params.clusterId);
    if (!approved) {
      return res.redirect(`/keywords/${run.id}?error=` + encodeURIComponent(
        'Approve this keyword before generating a brief for it — briefs are only built for keywords the SEO team has signed off on.'
      ));
    }

    const r = contentBrief.generate(userId, brand, run.id, req.params.clusterId);
    if (!r.ok) return res.redirect(`/keywords/${run.id}?error=` + encodeURIComponent(r.error));
    res.redirect(`/keywords/brief/${r.id}`);
  } catch (err) { next(err); }
});

router.get('/:id/csv', async (req, res) => {
  const run = clustering.getRun(req.params.id, req.dataUserId);
  if (!run || !run.result) return res.status(404).send('Not found');

  const clusterRows = [];
  const keywordRows = [];
  run.result.clusters.forEach((c) => {
    clusterRows.push({
      cluster: c.id,
      primary_keyword: c.primaryKeyword,
      supporting_keywords: c.supportingKeywords.join(' | '),
      keyword_count: c.keywordCount,
      search_intent: c.intent,
      intent_confidence: c.intentConfidence,
      suggested_page_type: c.suggestedPageType,
      impressions: Math.round(c.totalImpressions),
      clicks: Math.round(c.totalClicks),
      avg_position: c.avgPosition == null ? '' : c.avgPosition.toFixed(1),
      recommendation: c.recommendation,
      reason: c.recommendationReason,
      existing_page: c.existingPage || '',
      competing_urls: c.competingUrls,
    });
    (c.supportingKeywords || []).forEach((kw) => {
      keywordRows.push({ cluster: c.id, primary_keyword: c.primaryKeyword, keyword: kw });
    });
  });

  const workbook = buildWorkbook({
    sheets: [
      {
        name: 'Clusters',
        columns: [
          { header: 'Cluster', key: 'cluster', width: 10 },
          { header: 'Primary Keyword', key: 'primary_keyword', width: 30 },
          { header: 'Supporting Keywords', key: 'supporting_keywords', width: 50 },
          { header: 'Keyword Count', key: 'keyword_count', width: 12 },
          { header: 'Search Intent', key: 'search_intent', width: 20, dropdown: ['Transactional', 'Commercial investigation', 'Local', 'Informational', 'Navigational'] },
          { header: 'Intent Confidence', key: 'intent_confidence', width: 14 },
          { header: 'Suggested Page Type', key: 'suggested_page_type', width: 20 },
          { header: 'Impressions', key: 'impressions', width: 12 },
          { header: 'Clicks', key: 'clicks', width: 10 },
          { header: 'Avg Position', key: 'avg_position', width: 12 },
          { header: 'Recommendation', key: 'recommendation', width: 30, dropdown: ['Create new page', 'Consolidate existing pages', 'Existing page — already strong', 'Improve existing page'] },
          { header: 'Reason', key: 'reason', width: 50 },
          { header: 'Existing Page', key: 'existing_page', width: 40 },
          { header: 'Competing URLs', key: 'competing_urls', width: 50 },
        ],
        rows: clusterRows,
      },
      {
        name: 'Keywords Detail',
        columns: [
          { header: 'Cluster', key: 'cluster', width: 10 },
          { header: 'Primary Keyword', key: 'primary_keyword', width: 30 },
          { header: 'Keyword', key: 'keyword', width: 40 },
        ],
        rows: keywordRows,
      },
    ],
  });

  await sendWorkbook(res, workbook, `keyword-clusters-run${run.id}.xlsx`);
});

module.exports = router;
