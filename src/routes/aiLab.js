// AI Lab — beta, additive comparison section. Generates an AI-powered
// counterpart to four existing deterministic features so the SEO team can
// compare them side by side. Every AI generation here is a manual, explicit
// button click — nothing in this file is ever called from alertEngine.js or
// any scheduled job.
const express = require('express');
const db = require('../db');
const clustering = require('../lib/clustering');
const budget = require('../lib/ai/budget');
const aiBrief = require('../lib/ai/aiBrief');
const aiOpportunities = require('../lib/ai/aiOpportunities');
const aiLinking = require('../lib/ai/aiLinking');
const aiTasks = require('../lib/ai/aiTasks');
const aiCannibalization = require('../lib/ai/aiCannibalization');
const compare = require('../lib/ai/compare');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

function getBrand(req) {
  return db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.brandId, req.dataUserId);
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// ------------------------------------------------------------------- hub
router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    res.render('ai-lab/hub', {
      title: 'AI Lab (Beta)', active: 'ai-lab', pageTitle: 'AI Lab — Beta comparison area',
      brands: brandsFor(userId),
      dashboard: budget.dashboard(),
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------- a. content brief
router.get('/:brandId/brief/:clusterKey', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const userId = req.dataUserId;
    const clusterKey = req.params.clusterKey;

    const resolved = aiBrief.resolve(userId, brand, clusterKey);
    if (!resolved) {
      return res.status(404).render('error', { title: 'Not found', active: 'ai-lab', message: 'That keyword cluster could not be found — it may belong to a different brand or a deleted run.' });
    }

    const existing = aiBrief.latestForClusterKey(brand.id, clusterKey);

    res.render('ai-lab/brief', {
      title: `AI Brief — ${resolved.cluster.primaryKeyword}`, active: 'ai-lab', pageTitle: 'AI Content Brief (Beta)',
      brand, brands: brandsFor(userId),
      clusterKey, resolved,
      row: existing ? { ...existing, headings: safeJson(existing.headings_json, []) } : null,
      realBriefLinkRunId: resolved.run.id, realBriefClusterId: resolved.cluster.id,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:brandId/brief/:clusterKey/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const clusterKey = req.params.clusterKey;
    const force = req.body.force === '1';
    const r = await aiBrief.generate(req.dataUserId, brand, clusterKey, { force });
    if (!r.ok) return res.redirect(`/ai-lab/${brand.id}/brief/${clusterKey}?error=` + encodeURIComponent(r.error));
    res.redirect(`/ai-lab/${brand.id}/brief/${clusterKey}?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI brief (no new API call).' : 'AI brief generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-lab/${brand ? brand.id : ''}/brief/${req.params.clusterKey}?error=` + encodeURIComponent(msg));
  }
});

// --------------------------------------------------------- b. opportunities
router.get('/:brandId/opportunities', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const opportunities = require('../lib/opportunities');
    const result = opportunities.analyse(brand);
    const findings = aiOpportunities.compactFindings(result);
    const inputHash = require('../lib/ai/hash').hashInputs(findings.map((f) => ({ id: f.id, page: f.page, query: f.query, estimatedGain: f.estimatedGain })));
    const cached = aiOpportunities.findCached(brand.id, inputHash);

    res.render('ai-lab/opportunities', {
      title: `AI Opportunities — ${brand.name}`, active: 'ai-lab', pageTitle: 'AI Opportunity Recommendations (Beta)',
      brand, brands: brandsFor(userIdOf(req)),
      result, findings,
      row: cached ? { ...cached, notes: safeJson(cached.findings_json, {}) } : null,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:brandId/opportunities/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiOpportunities.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-lab/${brand.id}/opportunities?error=` + encodeURIComponent('No opportunities found for this brand yet — nothing to send to AI.'));
    res.redirect(`/ai-lab/${brand.id}/opportunities?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI recommendations (no new API call).' : 'AI recommendations generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-lab/${brand ? brand.id : ''}/opportunities?error=` + encodeURIComponent(msg));
  }
});

// -------------------------------------------------------------- c. linking
router.get('/:brandId/linking', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const run = aiLinking.latestCompletedRun(brand.id);
    const recs = run ? aiLinking.topRecommendations(run.out_dir) : [];
    let cached = null;
    if (run && recs.length) {
      const inputHash = require('../lib/ai/hash').hashInputs({ runId: run.id, recs: recs.map((r) => [r.source_url, r.target_url, r.anchor_text]) });
      cached = aiLinking.findCached(brand.id, inputHash);
    }

    res.render('ai-lab/linking', {
      title: `AI Linking Rationale — ${brand.name}`, active: 'ai-lab', pageTitle: 'AI Linking Rationale (Beta)',
      brand, brands: brandsFor(req.dataUserId),
      run, recs, maxRecs: aiLinking.MAX_RECS,
      row: cached ? { ...cached, notes: safeJson(cached.notes_json, {}) } : null,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:brandId/linking/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiLinking.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-lab/${brand.id}/linking?error=` + encodeURIComponent('No completed internal linking run with recommendations found for this brand yet.'));
    res.redirect(`/ai-lab/${brand.id}/linking?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI rationales (no new API call).' : 'AI rationales generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-lab/${brand ? brand.id : ''}/linking?error=` + encodeURIComponent(msg));
  }
});

// ---------------------------------------------------------------- d. tasks
router.get('/:brandId/tasks', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const tasks = aiTasks.openTasksFor(brand);
    const compact = aiTasks.compactTasks(tasks);
    let cached = null;
    if (compact.length) {
      const inputHash = require('../lib/ai/hash').hashInputs(compact.map((t) => ({ id: t.id, title: t.title, detail: t.detail })));
      cached = aiTasks.findCached(brand.id, inputHash);
    }

    res.render('ai-lab/tasks', {
      title: `AI Task Recommendations — ${brand.name}`, active: 'ai-lab', pageTitle: 'AI Task Recommendations (Beta)',
      brand, brands: brandsFor(req.dataUserId),
      tasks,
      row: cached ? { ...cached, notes: safeJson(cached.notes_json, {}) } : null,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:brandId/tasks/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiTasks.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-lab/${brand.id}/tasks?error=` + encodeURIComponent('No open tasks found for this brand — nothing to send to AI.'));
    res.redirect(`/ai-lab/${brand.id}/tasks?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI-rewritten actions (no new API call).' : 'AI-rewritten task actions generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-lab/${brand ? brand.id : ''}/tasks?error=` + encodeURIComponent(msg));
  }
});

// -------------------------------------------------- e. cannibalisation verdict
//
// The deterministic cannibalisation analysis (the Python crawler's content
// comparison and opportunities.js's query/page split detector) is untouched and
// keeps running with no AI and no cost. This adds a second opinion beside it.
router.post('/:brandId/cannibalization/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiCannibalization.generate(brand, { force });
    if (r.empty) {
      return res.redirect('/ai-lab?error=' + encodeURIComponent('No cannibalisation findings for this brand — nothing to compare.'));
    }
    res.redirect('/ai-lab?msg=' + encodeURIComponent(
      r.cached
        ? 'Showing the cached AI cannibalisation verdicts (no new API call).'
        : 'AI cannibalisation verdicts generated — download the comparison sheet to review them.',
    ));
  } catch (err) {
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect('/ai-lab?error=' + encodeURIComponent(msg));
  }
});

// ------------------------------------------------- f. comparison sheet export
//
// Read-only and free: it exports whatever has already been generated, so
// downloading it never triggers an API call. Rows with no AI counterpart are
// included and marked, because "the AI has not covered this" is part of the
// comparison.
router.get('/:brandId/compare', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    res.json(compare.build(brand));
  } catch (err) { next(err); }
});

router.get('/:brandId/compare.csv', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-lab?error=' + encodeURIComponent('Brand not found.'));
    const comparison = compare.build(brand);
    const slug = String(brand.name || `brand-${brand.id}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stamp = comparison.generatedAt.slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="deterministic-vs-ai-${slug}-${stamp}.csv"`);
    res.send(compare.toCsv(comparison));
  } catch (err) { next(err); }
});

function userIdOf(req) { return req.dataUserId; }

module.exports = router;
