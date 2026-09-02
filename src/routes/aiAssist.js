// AI Assist — AI-generated content briefs, opportunity recommendations,
// linking rationale, metadata rewrites and task rewrites, one page per brand
// per feature. Every generation here is a manual, explicit button click —
// nothing in this file is ever called from alertEngine.js or any scheduled
// job, and every call is logged against the shared spend cap.
const express = require('express');
const db = require('../db');
const budget = require('../lib/ai/budget');
const aiBrief = require('../lib/ai/aiBrief');
const aiOpportunities = require('../lib/ai/aiOpportunities');
const aiLinking = require('../lib/ai/aiLinking');
const aiMetadata = require('../lib/ai/aiMetadata');
const aiTasks = require('../lib/ai/aiTasks');

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
    res.render('ai-assist/hub', {
      title: 'AI Assist', active: 'ai-assist', pageTitle: 'AI Assist',
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
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const userId = req.dataUserId;
    const clusterKey = req.params.clusterKey;

    const resolved = aiBrief.resolve(userId, brand, clusterKey);
    if (!resolved) {
      return res.status(404).render('error', { title: 'Not found', active: 'ai-assist', message: 'That keyword cluster could not be found — it may belong to a different brand or a deleted run.' });
    }

    const existing = aiBrief.latestForClusterKey(brand.id, clusterKey);

    res.render('ai-assist/brief', {
      title: `AI Brief — ${resolved.cluster.primaryKeyword}`, active: 'ai-assist', pageTitle: 'AI Content Brief',
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
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const clusterKey = req.params.clusterKey;
    const force = req.body.force === '1';
    const r = await aiBrief.generate(req.dataUserId, brand, clusterKey, { force });
    if (!r.ok) return res.redirect(`/ai-assist/${brand.id}/brief/${clusterKey}?error=` + encodeURIComponent(r.error));
    res.redirect(`/ai-assist/${brand.id}/brief/${clusterKey}?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI brief (no new API call).' : 'AI brief generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-assist/${brand ? brand.id : ''}/brief/${req.params.clusterKey}?error=` + encodeURIComponent(msg));
  }
});

// --------------------------------------------------------- b. opportunities
router.get('/:brandId/opportunities', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const opportunities = require('../lib/opportunities');
    const result = opportunities.analyse(brand);
    const findings = aiOpportunities.compactFindings(result);
    const inputHash = require('../lib/ai/hash').hashInputs(findings.map((f) => ({ id: f.id, page: f.page, query: f.query, estimatedGain: f.estimatedGain })));
    const cached = aiOpportunities.findCached(brand.id, inputHash);

    res.render('ai-assist/opportunities', {
      title: `AI Opportunities — ${brand.name}`, active: 'ai-assist', pageTitle: 'AI Opportunity Recommendations',
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
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiOpportunities.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-assist/${brand.id}/opportunities?error=` + encodeURIComponent('No opportunities found for this brand yet — nothing to send to AI.'));
    res.redirect(`/ai-assist/${brand.id}/opportunities?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI recommendations (no new API call).' : 'AI recommendations generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-assist/${brand ? brand.id : ''}/opportunities?error=` + encodeURIComponent(msg));
  }
});

// -------------------------------------------------------------- c. linking
router.get('/:brandId/linking', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const run = aiLinking.latestCompletedRun(brand.id);
    const recs = run ? aiLinking.topRecommendations(run.out_dir) : [];
    let cached = null;
    if (run && recs.length) {
      const inputHash = require('../lib/ai/hash').hashInputs({ runId: run.id, recs: recs.map((r) => [r.source_url, r.target_url, r.anchor_text]) });
      cached = aiLinking.findCached(brand.id, inputHash);
    }

    res.render('ai-assist/linking', {
      title: `AI Linking Rationale — ${brand.name}`, active: 'ai-assist', pageTitle: 'AI Linking Rationale',
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
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiLinking.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-assist/${brand.id}/linking?error=` + encodeURIComponent('No completed internal linking run with recommendations found for this brand yet.'));
    res.redirect(`/ai-assist/${brand.id}/linking?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI rationales (no new API call).' : 'AI rationales generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-assist/${brand ? brand.id : ''}/linking?error=` + encodeURIComponent(msg));
  }
});

// ------------------------------------------------------------ d. metadata
router.get('/:brandId/metadata', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const run = aiMetadata.latestCompletedRun(brand.id);
    const pages = run ? aiMetadata.weakMetadataPages(run.json_result) : [];
    let cached = null;
    if (run && pages.length) {
      const inputHash = require('../lib/ai/hash').hashInputs({ runId: run.id, pages: pages.map((p) => [p.url, p.issues.join('|')]) });
      cached = aiMetadata.findCached(brand.id, inputHash);
    }

    res.render('ai-assist/metadata', {
      title: `AI Metadata Optimization — ${brand.name}`, active: 'ai-assist', pageTitle: 'AI Metadata Optimization',
      brand, brands: brandsFor(req.dataUserId),
      run, pages, maxPages: aiMetadata.MAX_PAGES,
      row: cached ? { ...cached, notes: safeJson(cached.notes_json, {}) } : null,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:brandId/metadata/generate', async (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiMetadata.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-assist/${brand.id}/metadata?error=` + encodeURIComponent('No completed technical audit with missing/duplicate title or meta description found for this brand yet.'));
    res.redirect(`/ai-assist/${brand.id}/metadata?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI metadata suggestions (no new API call).' : 'AI metadata suggestions generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-assist/${brand ? brand.id : ''}/metadata?error=` + encodeURIComponent(msg));
  }
});

// ---------------------------------------------------------------- e. tasks
router.get('/:brandId/tasks', (req, res, next) => {
  try {
    const brand = getBrand(req);
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const tasks = aiTasks.openTasksFor(brand);
    const compact = aiTasks.compactTasks(tasks);
    let cached = null;
    if (compact.length) {
      const inputHash = require('../lib/ai/hash').hashInputs(compact.map((t) => ({ id: t.id, title: t.title, detail: t.detail })));
      cached = aiTasks.findCached(brand.id, inputHash);
    }

    res.render('ai-assist/tasks', {
      title: `AI Task Recommendations — ${brand.name}`, active: 'ai-assist', pageTitle: 'AI Task Recommendations',
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
    if (!brand) return res.redirect('/ai-assist?error=' + encodeURIComponent('Brand not found.'));
    const force = req.body.force === '1';
    const r = await aiTasks.generate(brand, { force });
    if (r.empty) return res.redirect(`/ai-assist/${brand.id}/tasks?error=` + encodeURIComponent('No open tasks found for this brand — nothing to send to AI.'));
    res.redirect(`/ai-assist/${brand.id}/tasks?msg=` + encodeURIComponent(
      r.cached ? 'Showing the cached AI-rewritten actions (no new API call).' : 'AI-rewritten task actions generated.'
    ));
  } catch (err) {
    const brand = getBrand(req);
    const msg = err.budgetBlocked ? err.message : `AI generation failed: ${err.message}`;
    res.redirect(`/ai-assist/${brand ? brand.id : ''}/tasks?error=` + encodeURIComponent(msg));
  }
});

function userIdOf(req) { return req.dataUserId; }

module.exports = router;
