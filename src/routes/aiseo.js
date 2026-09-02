// THE AI SEO SUITE — routes
//
// Nine analyses, one router. They share a shape: a form page listing past
// runs, a POST that launches one in the background, a result page that polls
// until it finishes, and the same four actions on a finished run (create
// tasks, export JSON, delete, re-run). That shape is built once in
// `feature()` below rather than nine times.
//
// Features with genuinely extra surface — competitor management, brand facts
// and llms.txt, the metric series behind the tracking board — add their own
// routes on top.
const express = require('express');
const db = require('../db');

const store = require('../lib/aiseo/store');
const runner = require('../lib/aiseo/runner');
const providers = require('../lib/aiseo/providers');
const budget = require('../lib/ai/budget');

const research = require('../lib/aiseo/research');
const onpage = require('../lib/aiseo/onpage');
const schemaAuto = require('../lib/aiseo/schemaAuto');
const readiness = require('../lib/aiseo/readiness');
const architecture = require('../lib/aiseo/architecture');
const competitive = require('../lib/aiseo/competitive');
const reputation = require('../lib/aiseo/reputation');
const freshness = require('../lib/aiseo/freshness');
const tracking = require('../lib/aiseo/tracking');
const trackingCatalog = require('../lib/aiseo/trackingCatalog');
const siteReadiness = require('../lib/aiseo/siteReadiness');
const linkOpportunities = require('../lib/aiseo/linkOpportunities');
const reviewPlatforms = require('../lib/aiseo/reviewPlatforms');
const aiReferrals = require('../lib/aiseo/aiReferrals');
const difficultyCache = require('../lib/aiseo/difficultyCache');
const markets = require('../lib/aiseo/markets');
// The market a form posted, falling back to the brand's own. Shared by the
// three features that take a country, so one selection means the same thing on
// all of them.
function countryFrom(req, brand) {
  const raw = req.body.country || req.query.country;
  if (raw) return markets.resolve(raw).code;
  return markets.resolve(brand && brand.market).code;
}

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? AND active=1 ORDER BY name').all(userId);
}

// The brand for this request: an explicit ?brand=, else the only brand there
// is, else nothing. Picking "the first brand" when several exist would silently
// analyse the wrong site, so that is not done.
function resolveBrand(req, brands) {
  const wanted = req.query.brand || req.body.brand_id;
  if (wanted) return brands.find((b) => String(b.id) === String(wanted)) || null;
  return brands.length === 1 ? brands[0] : null;
}

function requireWrite(req, res) {
  if (res.locals.perms && res.locals.perms.canWrite) return true;
  res.redirect(`${req.baseUrl}${req.path.replace(/\/(run|delete|tasks)$/, '')}?error=`
    + encodeURIComponent('Your role cannot start analyses or change data.'));
  return false;
}

const flash = (req) => ({ flash: req.query.msg || null, flashError: req.query.error || null });

// --------------------------------------------------------------------- hub

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const brand = resolveBrand(req, brands);
    res.render('aiseo/hub', {
      title: 'AI SEO suite',
      active: 'aiseo',
      pageTitle: 'AI SEO suite',
      brands,
      brand,
      summary: store.summaryByKind({ userId, brandId: brand ? brand.id : null }),
      openFindings: store.openFindings({ userId, brandId: brand ? brand.id : null, limit: 40 }),
      providerList: providers.all(),
      aiBudget: budget.dashboard({ historyLimit: 10 }),
      activeRuns: runner.active(),
      maxConcurrent: runner.MAX_CONCURRENT,
      ...flash(req),
    });
  } catch (err) { next(err); }
});

// -------------------------------------------------------- the shared shape

// Builds the five routes every feature needs.
//
//   slug        URL segment and `active` nav key
//   kind        store kind
//   engine      module exposing run() and toTasks()
//   listView    EJS template for the form + run list
//   resultView  EJS template for a finished run
//   title
//   needsBrand  true when the analysis is meaningless without one
//   argsFrom    (req, brand) => engine args; throw to reject with a message
//   extraLocals (req, brand, userId) => object merged into the list view
function feature({
  slug, kind, engine, listView, resultView, title, needsBrand = true,
  argsFrom, extraLocals = null, targetFrom = null, labelFrom = null,
  // Called with the stored run just before it is rendered, for features whose
  // report improves after the run finished. Only difficulty backfill uses it:
  // scores computed by the background job land in the cache, not in the run's
  // frozen JSON, and without this the user would have to re-run an analysis
  // purely to see numbers the app already holds.
  hydrate = null,
}) {
  const base = `/${slug}`;

  router.get(base, (req, res, next) => {
    try {
      const userId = req.dataUserId;
      const brands = brandsFor(userId);
      const brand = resolveBrand(req, brands);
      res.render(listView, {
        title,
        active: 'aiseo',
        pageTitle: title,
        slug,
        kind,
        brands,
        brand,
        runs: store.listRuns({ userId, kind, brandId: brand ? brand.id : null, limit: 20 }),
        latest: brand ? store.latestRun({ userId, kind, brandId: brand.id }) : null,
        providerList: providers.all(),
        aiAvailable: providers.has('azure'),
        aiBudget: budget.dashboard({ historyLimit: 0 }),
        activeRuns: runner.active(),
        maxConcurrent: runner.MAX_CONCURRENT,
        ...(extraLocals ? extraLocals(req, brand, userId) : {}),
        ...flash(req),
      });
    } catch (err) { next(err); }
  });

  router.post(`${base}/run`, (req, res) => {
    if (!requireWrite(req, res)) return;
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const brand = resolveBrand(req, brands);
    const backTo = `${req.baseUrl}${base}${brand ? `?brand=${brand.id}` : ''}`;
    const fail = (msg) => res.redirect(`${backTo}${brand ? '&' : '?'}error=${encodeURIComponent(msg)}`);

    if (needsBrand && !brand) {
      return fail(brands.length
        ? 'Choose which brand to analyse.'
        : 'Add a brand first — these analyses run against a brand\'s site.');
    }

    let args;
    try {
      args = argsFrom(req, brand);
    } catch (err) {
      return fail(err.message);
    }

    try {
      const runId = runner.launch({
        userId,
        brand,
        kind,
        engine,
        args,
        target: targetFrom ? targetFrom(req, brand, args) : (brand ? brand.site_url : null),
        label: labelFrom ? labelFrom(req, brand, args) : null,
        params: args,
      });
      return res.redirect(`${req.baseUrl}${base}/${runId}`);
    } catch (err) {
      return fail(err.busy ? err.message : `Could not start the analysis: ${err.message}`);
    }
  });

  router.get(`${base}/:id`, (req, res, next) => {
    try {
      const userId = req.dataUserId;
      const run = store.get(req.params.id, userId);
      if (!run || run.kind !== kind) {
        return res.status(404).render('error', {
          title: 'Not found', active: 'aiseo',
          message: 'That analysis run does not exist, or belongs to a different feature.',
        });
      }
      const brands = brandsFor(userId);
      if (hydrate && run.status === 'completed' && run.result) {
        // A hydration failure must never take down the report it was meant to
        // improve — the stored run is still perfectly renderable without it.
        try { hydrate(run); } catch (err) { console.error(`[aiseo] hydrate ${kind} failed:`, err.message); }
      }
      res.render(resultView, {
        title: `${title} · ${run.target || run.id}`,
        active: 'aiseo',
        pageTitle: title,
        slug,
        kind,
        run,
        previous: store.previousRun(run),
        brand: run.brand_id ? brands.find((b) => b.id === run.brand_id) || null : null,
        brands,
        live: runner.isRunning(run.id),
        orphaned: run.status === 'running' && !runner.isRunning(run.id),
        aiAvailable: providers.has('azure'),
        ...flash(req),
      });
    } catch (err) { next(err); }
  });

  // Polled by the result page while a run is in flight.
  router.get(`${base}/:id/status`, (req, res) => {
    const s = runner.status(req.params.id, req.dataUserId);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s);
  });

  router.post(`${base}/:id/tasks`, (req, res) => {
    if (!requireWrite(req, res)) return;
    const userId = req.dataUserId;
    const run = store.get(req.params.id, userId);
    if (!run || run.kind !== kind) return res.redirect(`${req.baseUrl}${base}?error=${encodeURIComponent('Run not found.')}`);
    if (run.status !== 'completed') return res.redirect(`${req.baseUrl}${base}/${run.id}?error=${encodeURIComponent('That run has not finished, so there is nothing to turn into tasks.')}`);
    const brand = run.brand_id ? db.prepare('SELECT * FROM brands WHERE id=?').get(run.brand_id) : null;
    try {
      const r = engine.toTasks(run, brand, { userId: req.actorId || userId });
      return res.redirect(`${req.baseUrl}${base}/${run.id}?msg=${encodeURIComponent(
        r.created
          ? `${r.created} task${r.created === 1 ? '' : 's'} created.`
          : 'No new tasks — every actionable finding here already has one.',
      )}`);
    } catch (err) {
      return res.redirect(`${req.baseUrl}${base}/${run.id}?error=${encodeURIComponent(`Could not create tasks: ${err.message}`)}`);
    }
  });

  router.post(`${base}/:id/delete`, (req, res) => {
    if (!requireWrite(req, res)) return;
    if (runner.isRunning(req.params.id)) {
      return res.redirect(`${req.baseUrl}${base}/${req.params.id}?error=${encodeURIComponent('That run is still in progress. Wait for it to finish before deleting it.')}`);
    }
    store.removeRun(req.params.id, req.dataUserId);
    res.redirect(`${req.baseUrl}${base}?msg=${encodeURIComponent('Run deleted.')}`);
  });

  router.get(`${base}/:id/json`, (req, res) => {
    const run = store.get(req.params.id, req.dataUserId);
    if (!run || run.kind !== kind) return res.status(404).json({ error: 'not found' });
    res.type('application/json').send(JSON.stringify({
      id: run.id,
      kind: run.kind,
      target: run.target,
      status: run.status,
      score: run.score,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      ms: run.ms,
      params: run.params,
      result: run.result,
      findings: run.findings.map((f) => ({
        checkKey: f.check_key, title: f.title, detail: f.detail,
        severity: f.severity, affectedUrl: f.affected_url,
        affectedCount: f.affected_count, action: f.action, evidence: f.evidence,
      })),
    }, null, 2));
  });
}

// ------------------------------------------------------- 1. research

feature({
  slug: 'research',
  kind: 'research',
  engine: research,
  listView: 'aiseo/research',
  resultView: 'aiseo/research-result',
  title: 'Keyword & prompt research',
  // Fills in difficulties scored by the background job since this run
  // finished. Without it, a run would show the dozen keywords it could afford
  // to score inline and nothing else, forever — even once the backfill had
  // scored every remaining keyword. Read-only, from the cache; it never
  // rewrites the stored run.
  hydrate: (run) => {
    const r = run.result;
    if (!r || !r.metrics || !Array.isArray(r.keywords)) return;
    const marketCode = (r.metrics.market && r.metrics.market.code) || 'ZZ';
    const unscored = r.keywords.filter((k) => k.difficulty == null).map((k) => k.keyword);
    if (!unscored.length) return;

    const cached = difficultyCache.readMany(unscored, marketCode);
    if (!cached.size) return;

    let added = 0;
    const apply = (row) => {
      const hit = cached.get(String(row.keyword || '').toLowerCase().trim());
      if (!hit) return;
      if (hit.difficulty != null && row.difficulty == null) {
        row.difficulty = hit.difficulty;
        row.difficultyBasis = hit.basis || 'serp-proxy';
        row.difficultyDetail = hit.detail;
        added += 1;
      } else if (hit.difficulty == null && hit.unavailableReason && !row.difficultyUnavailable) {
        row.difficultyUnavailable = hit.unavailableReason;
      }
    };
    r.keywords.forEach(apply);
    (r.clusters || []).forEach((c) => (c.memberDetail || []).forEach(apply));

    if (!added) return;

    // Cluster averages are derived, so they have to be recomputed from the
    // members rather than left showing the figure that was true at run time.
    (r.clusters || []).forEach((c) => {
      const kds = (c.memberDetail || []).filter((m) => m.difficulty != null).map((m) => m.difficulty);
      c.avgDifficulty = kds.length ? Math.round(kds.reduce((a, b) => a + b, 0) / kds.length) : null;
      c.difficultyMembers = kds.length;
      if (kds.length && !c.difficultyBasis) c.difficultyBasis = 'serp-proxy';
    });

    const scored = r.keywords.filter((k) => k.difficulty != null).length;
    r.metrics.difficultyCoverage = {
      scored,
      total: r.keywords.length,
      pct: r.keywords.length ? Math.round((scored / r.keywords.length) * 100) : 0,
      queued: r.keywords.length - scored,
    };
    r.metrics.hydratedFromCache = added;
  },
  argsFrom: (req, brand) => ({
    seedText: String(req.body.seeds || ''),
    days: Math.min(480, Math.max(28, parseInt(req.body.days, 10) || 90)),
    includeSuggest: req.body.include_suggest !== 'off',
    includePrompts: req.body.include_prompts !== 'off',
    // NEW
    country: countryFrom(req, brand),
    includeRelated: req.body.include_related !== 'off',
    includeMetrics: req.body.include_metrics !== 'off',
    alphabetSweep: req.body.alphabet_sweep !== 'off',
    difficultyLimit: Math.min(40, Math.max(0, parseInt(req.body.difficulty_limit, 10) || 12)),
    force: req.body.force === '1',
  }),
  labelFrom: (req, brand, args) => `${args.seedText
    ? args.seedText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(', ').slice(0, 80)
    : 'Search Console seeds'} · ${markets.label(args.country)}`,
  extraLocals: (req, brand) => ({
    marketList: markets.all(),
    selectedMarket: markets.resolve(req.query.country || (brand && brand.market)).code,
  }),
});

// Saves the brand's seed topics from the research form, so the next run — and
// the scheduled one — has something to expand from without retyping.
router.post('/research/seeds', (req, res) => {
  if (!requireWrite(req, res)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, req.dataUserId);
  if (!brand) return res.redirect(`${req.baseUrl}/research?error=${encodeURIComponent('Brand not found.')}`);
  db.prepare('UPDATE brands SET seed_topics=? WHERE id=?')
    .run(String(req.body.seed_topics || '').trim() || null, brand.id);
  res.redirect(`${req.baseUrl}/research?brand=${brand.id}&msg=${encodeURIComponent('Seed topics saved on the brand.')}`);
});

// ------------------------------------------------------- 2. on-page scoring

feature({
  slug: 'optimizer',
  kind: 'onpage',
  engine: onpage,
  listView: 'aiseo/optimizer',
  resultView: 'aiseo/optimizer-result',
  title: 'On-page optimisation score',
  needsBrand: false,
  argsFrom: (req) => {
    const url = String(req.body.url || '').trim();
    const draft = String(req.body.draft || '').trim();
    if (!url && !draft) throw new Error('Give a URL to score, or paste a draft.');
    const keyword = String(req.body.keyword || '').trim();
    if (!keyword) throw new Error('Give the target term this page is meant to rank for — the score is relative to it.');
    return {
      url: url || null,
      draftHtml: draft || null,
      keyword,
      competitorUrls: String(req.body.competitor_urls || '')
        .split(/[\n,;\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).slice(0, 6),
      autoCompetitors: req.body.auto_competitors !== 'off',
      wantAiEdits: req.body.want_ai !== 'off',
      force: req.body.force === '1',
    };
  },
  targetFrom: (req, brand, args) => (args.url || `draft:${String(args.keyword).slice(0, 60)}`),
  labelFrom: (req, brand, args) => args.keyword,
  extraLocals: (req, brand, userId) => ({
    competitors: brand ? competitive.list(brand.id).filter((c) => c.active) : [],
  }),
});

// ------------------------------------------------------- 3. schema

feature({
  slug: 'schema',
  kind: 'schema',
  engine: schemaAuto,
  listView: 'aiseo/schema',
  resultView: 'aiseo/schema-result',
  title: 'Schema & structured data',
  needsBrand: false,
  argsFrom: (req) => {
    const url = String(req.body.url || '').trim();
    if (!url) throw new Error('Give the URL to audit.');
    return {
      url,
      wantedTypes: Array.isArray(req.body.types) ? req.body.types : (req.body.types ? [req.body.types] : []),
      wantAi: req.body.want_ai !== 'off',
      force: req.body.force === '1',
    };
  },
  targetFrom: (req, brand, args) => args.url,
  extraLocals: () => ({ typeRules: schemaAuto.TYPE_RULES }),
});

// The brand hub: canonical facts, and the llms.txt rendered from them.
router.get('/brand-hub', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const brand = resolveBrand(req, brands);
    let review = null;
    if (brand) {
      review = await schemaAuto.reviewBrandHub({
        userId, brand,
        wantAi: req.query.ai === '1',
        force: req.query.force === '1',
        useGscOrdering: req.query.gsc !== '0',
      });
    }
    res.render('aiseo/brand-hub', {
      title: 'Brand hub & llms.txt',
      active: 'aiseo',
      pageTitle: 'Brand hub & llms.txt',
      brands, brand, review,
      aiAvailable: providers.has('azure'),
      ...flash(req),
    });
  } catch (err) { next(err); }
});

router.post('/brand-hub/facts', (req, res) => {
  if (!requireWrite(req, res)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, req.dataUserId);
  if (!brand) return res.redirect(`${req.baseUrl}/brand-hub?error=${encodeURIComponent('Brand not found.')}`);

  // The form posts parallel arrays. A single fact posts a string rather than an
  // array, so both shapes are normalised before pairing.
  const asArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));
  const keys = asArray(req.body.fact_key);
  const values = asArray(req.body.fact_value);
  const sourceUrls = asArray(req.body.fact_source);
  const sections = asArray(req.body.fact_section);

  const entries = keys.map((key, i) => ({
    key: String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, ''),
    value: values[i],
    sourceUrl: sourceUrls[i],
    section: sections[i] || 'general',
    sortOrder: (i + 1) * 10,
  })).filter((e) => e.key);

  const saved = schemaAuto.saveFacts(brand.id, entries);
  res.redirect(`${req.baseUrl}/brand-hub?brand=${brand.id}&msg=${encodeURIComponent(`${saved} fact${saved === 1 ? '' : 's'} saved. The llms.txt below is regenerated from them.`)}`);
});

// The generated llms.txt as a download, so it can be dropped straight onto the
// site root. Served as text/plain rather than an attachment when previewed.
router.get('/brand-hub/llms.txt', async (req, res, next) => {
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.query.brand, req.dataUserId);
    if (!brand) return res.status(404).type('text/plain').send('Brand not found.\n');
    const facts = db.prepare('SELECT * FROM brand_facts WHERE brand_id=? ORDER BY sort_order, fact_key').all(brand.id);
    // The content map is now read from the site's sitemap, which is a network
    // call — hence the async handler. `gsc=0` renders the file without using
    // Search Console to order pages within each section, which is what a
    // reviewer wants when checking that coverage is complete rather than
    // traffic-weighted.
    const body = schemaAuto.renderLlmsTxt({
      brand,
      facts,
      sections: await schemaAuto.contentSections(brand.id, brand, {
        useGsc: req.query.gsc !== '0',
        limit: Math.min(600, Math.max(20, parseInt(req.query.limit, 10) || 200)),
        perSection: Math.min(100, Math.max(3, parseInt(req.query.per_section, 10) || 25)),
      }),
    });
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="llms.txt"');
    }
    return res.type('text/plain; charset=utf-8').send(body);
  } catch (err) { return next(err); }
});

// The generated @graph as a download, so it can go straight into a template.
// Served from the stored run rather than regenerated, so what is downloaded is
// exactly what was reviewed on screen.
router.get('/schema/:id/jsonld', (req, res) => {
  const run = store.get(req.params.id, req.dataUserId);
  if (!run || run.kind !== 'schema') return res.status(404).type('text/plain').send('Run not found.\n');
  const build = (run.result || {}).build || null;
  if (!build) return res.status(404).type('text/plain').send('That run has no generated schema.\n');

  // ?type=Service returns one block; no type returns the combined graph.
  const wanted = req.query.type ? String(req.query.type) : null;
  let body;
  let name;
  if (wanted) {
    const block = (build.blocks || []).find((b) => b.type === wanted);
    if (!block) return res.status(404).type('text/plain').send(`No ${wanted} block was generated for this run.\n`);
    body = req.query.script === '1' ? block.script : block.json;
    name = `${wanted.toLowerCase()}.jsonld`;
  } else {
    body = req.query.script === '1' ? build.graphScript : build.graphJson;
    name = 'schema-graph.jsonld';
  }
  if (!body) return res.status(404).type('text/plain').send('Nothing to download.\n');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.type(req.query.script === '1' ? 'text/html; charset=utf-8' : 'application/ld+json; charset=utf-8').send(body);
});

// ------------------------------------------------------- 4. AI readiness

feature({
  slug: 'readiness',
  kind: 'readiness',
  engine: readiness,
  listView: 'aiseo/readiness',
  resultView: 'aiseo/readiness-result',
  title: 'AI-crawler readiness',
  needsBrand: false,
  argsFrom: (req) => {
    const url = String(req.body.url || '').trim();
    if (!url && !req.body.brand_id) throw new Error('Give a URL, or choose a brand to check its homepage.');
    return {
      url: url || null,
      includePsi: req.body.include_psi !== 'off',
      probeEdge: req.body.probe_edge !== 'off',
    };
  },
  targetFrom: (req, brand, args) => (args.url || (brand ? brand.site_url : null)),
  extraLocals: () => ({ agents: require('../lib/aiseo/fetcher').AI_AGENTS, thresholds: readiness.THRESHOLDS }),
});

// -------------------------------------- 4b. AI readiness, WHOLE SITE
//
// A separate feature rather than a flag on /readiness. The two answer different
// questions — "can an AI fetcher read THIS page" against the eight-point
// checklist for the whole property — and their result pages share almost
// nothing, so folding them together would mean one template with two disjoint
// halves and a run of one rendering as the other.
feature({
  slug: 'site-readiness',
  kind: 'site_readiness',
  engine: siteReadiness,
  listView: 'aiseo/site-readiness',
  resultView: 'aiseo/site-readiness-result',
  title: 'AI-crawler readiness (whole site)',
  needsBrand: false,
  argsFrom: (req) => {
    const site = String(req.body.site || '').trim();
    if (!site && !req.body.brand_id) throw new Error('Give a site URL, or choose a brand.');
    return {
      site: site || null,
      maxPages: Math.min(400, Math.max(10, parseInt(req.body.max_pages, 10) || 120)),
      probeEdge: req.body.probe_edge !== 'off',
      deepSample: Math.min(80, Math.max(3, parseInt(req.body.deep_sample, 10) || 25)),
      // URLs the practitioner considers important, checked directly for a 200
      // rather than inferred from the crawl.
      importantUrls: String(req.body.important_urls || '')
        .split(/[\n,;\s]+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 25),
    };
  },
  targetFrom: (req, brand, args) => (args.site || (brand ? brand.site_url : null)),
  extraLocals: () => ({ agents: require('../lib/aiseo/fetcher').AI_AGENTS }),
});

// ------------------------- 5b. internal link opportunities for one URL
//
// The target-first view of internal linking: give it a URL, get back the pages
// that should link to it and the exact phrase already in each one's copy.
feature({
  slug: 'link-opportunities',
  kind: 'link_opportunities',
  engine: linkOpportunities,
  listView: 'aiseo/link-opportunities',
  resultView: 'aiseo/link-opportunities-result',
  title: 'Internal link opportunities for a URL',
  needsBrand: false,
  argsFrom: (req) => {
    const url = String(req.body.url || '').trim();
    if (!url) throw new Error('Give the URL you want internal links pointing at.');
    return {
      url,
      maxPages: Math.min(400, Math.max(10, parseInt(req.body.max_pages, 10) || 120)),
      limit: Math.min(200, Math.max(5, parseInt(req.body.limit, 10) || 50)),
      minRelevance: Math.min(0.6, Math.max(0.01, parseFloat(req.body.min_relevance) || 0.08)),
      // Anchor phrases the practitioner wants used, in addition to the ones
      // read off the target page. Still only offered where they appear verbatim
      // in a source page — a supplied phrase is not licence to invent one.
      extraPhrases: String(req.body.extra_phrases || '')
        .split(/[\n;]+/).map((x) => x.trim()).filter((x) => x.length > 3).slice(0, 12),
    };
  },
  targetFrom: (req, brand, args) => args.url,
  labelFrom: (req, brand, args) => {
    try { return new URL(args.url).pathname; } catch { return args.url; }
  },
});

// A CSV of the opportunity rows, in exactly the three columns asked for plus
// the sentence — because the anchor is unusable without knowing where it is.
router.get('/link-opportunities/:id/csv', (req, res) => {
  const run = store.get(req.params.id, req.dataUserId);
  if (!run || run.kind !== 'link_opportunities') return res.status(404).type('text/plain').send('Run not found.\n');
  const rows = ((run.result || {}).rows) || [];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['URL', 'Source URL', 'Anchor text', 'Sentence the anchor is in', 'Relevance', 'Shared entities'].join(',')];
  rows.forEach((r) => lines.push([
    esc(r.url), esc(r.sourceUrl), esc(r.anchorText), esc(r.sentence),
    esc(r.relevance), esc((r.sharedEntities || []).join('; ')),
  ].join(',')));
  res.setHeader('Content-Disposition', `attachment; filename="internal-link-opportunities-${run.id}.csv"`);
  res.type('text/csv; charset=utf-8').send(`\uFEFF${lines.join('\r\n')}\r\n`);
});

// ------------------------------------------- 7b. review platform coverage
feature({
  slug: 'review-platforms',
  kind: 'review_platforms',
  engine: reviewPlatforms,
  listView: 'aiseo/review-platforms',
  resultView: 'aiseo/review-platforms-result',
  title: 'Review platform coverage',
  argsFrom: (req, brand) => ({
    country: countryFrom(req, brand),
    includeSearch: req.body.include_search !== 'off',
    includeProbe: req.body.include_probe !== 'off',
  }),
  extraLocals: (req, brand) => ({
    platformList: brand ? reviewPlatforms.platformsFor(brand.vertical) : reviewPlatforms.PLATFORMS,
    allPlatforms: reviewPlatforms.PLATFORMS,
    marketList: markets.all(),
    selectedMarket: markets.resolve(req.query.country || (brand && brand.market)).code,
  }),
});

// ------------------------------------------- 9. measured AI referral traffic
feature({
  slug: 'ai-referrals',
  kind: 'ai_referrals',
  engine: aiReferrals,
  listView: 'aiseo/ai-referrals',
  resultView: 'aiseo/ai-referrals-result',
  title: 'AI referral traffic (measured)',
  argsFrom: (req) => ({
    days: Math.min(365, Math.max(28, parseInt(req.body.days, 10) || 90)),
    includeLandingPages: req.body.include_landing_pages !== 'off',
  }),
  extraLocals: (req, brand) => ({
    aiSources: aiReferrals.AI_SOURCES,
    ambiguousSources: aiReferrals.AMBIGUOUS_SOURCES,
    ga4Linked: Boolean(brand && brand.ga4_property_id),
  }),
});

// ------------------------------------------------------- 5. architecture

feature({
  slug: 'architecture',
  kind: 'architecture',
  engine: architecture,
  listView: 'aiseo/architecture',
  resultView: 'aiseo/architecture-result',
  title: 'Internal linking & architecture',
  argsFrom: (req) => ({
    maxPages: Math.min(300, Math.max(10, parseInt(req.body.max_pages, 10) || 60)),
    wantAi: req.body.want_ai !== 'off',
    force: req.body.force === '1',
  }),
});

// ------------------------------------------------------- 6. competitive

feature({
  slug: 'competitors',
  kind: 'competitive',
  engine: competitive,
  listView: 'aiseo/competitors',
  resultView: 'aiseo/competitive-result',
  title: 'Competitive intelligence',
  argsFrom: (req, brand) => ({
    maxPagesPerSite: Math.min(120, Math.max(10, parseInt(req.body.max_pages, 10) || 30)),
    wantAi: req.body.want_ai !== 'off',
    // NEW
    country: countryFrom(req, brand),
    includeTopicMatrix: req.body.include_matrix !== 'off',
    includeKeywordGap: req.body.include_keyword_gap !== 'off',
    includeBacklinkGap: req.body.include_backlink_gap !== 'off',
    keywordGapLimit: Math.min(60, Math.max(5, parseInt(req.body.keyword_gap_limit, 10) || 25)),
    backlinkSampleLimit: Math.min(50, Math.max(5, parseInt(req.body.backlink_sample_limit, 10) || 20)),
    force: req.body.force === '1',
  }),
  extraLocals: (req, brand) => ({
    competitors: brand ? competitive.list(brand.id) : [],
    notMeasured: providers.missing().filter((p) => ['backlinks', 'keyword-tool', 'rank-tracker'].includes(p.kind)),
    marketList: markets.all(),
    selectedMarket: markets.resolve(req.query.country || (brand && brand.market)).code,
  }),
});

router.post('/competitors/add', (req, res) => {
  if (!requireWrite(req, res)) return;
  const userId = req.dataUserId;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, userId);
  if (!brand) return res.redirect(`${req.baseUrl}/competitors?error=${encodeURIComponent('Brand not found.')}`);
  const back = `${req.baseUrl}/competitors?brand=${brand.id}`;
  try {
    // One line per competitor, so a list can be pasted in rather than added
    // one at a time.
    const lines = String(req.body.domains || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return res.redirect(`${back}&error=${encodeURIComponent('Enter at least one domain.')}`);
    let added = 0;
    lines.slice(0, 20).forEach((line) => {
      // "example.com | Their label" — the label is optional.
      const [domain, label] = line.split('|').map((s) => s.trim());
      competitive.add({ userId, brandId: brand.id, domain, label: label || null });
      added += 1;
    });
    return res.redirect(`${back}&msg=${encodeURIComponent(`${added} competitor${added === 1 ? '' : 's'} saved.`)}`);
  } catch (err) {
    return res.redirect(`${back}&error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/competitors/:id/remove', (req, res) => {
  if (!requireWrite(req, res)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, req.dataUserId);
  if (!brand) return res.redirect(`${req.baseUrl}/competitors?error=${encodeURIComponent('Brand not found.')}`);
  competitive.remove(brand.id, req.params.id);
  res.redirect(`${req.baseUrl}/competitors?brand=${brand.id}&msg=${encodeURIComponent('Competitor removed.')}`);
});

// ------------------------------------------------------- 7. reputation

feature({
  slug: 'reputation',
  kind: 'reputation',
  engine: reputation,
  listView: 'aiseo/reputation',
  resultView: 'aiseo/reputation-result',
  title: 'Reputation & ambient signals',
  argsFrom: (req) => ({
    window: ['week', 'month', 'year', 'all'].includes(req.body.window) ? req.body.window : 'year',
    wantAi: req.body.want_ai !== 'off',
    force: req.body.force === '1',
  }),
  extraLocals: (req, brand) => ({
    mentions: brand ? reputation.listMentions(brand.id, { limit: 60 }) : [],
    riskyMentions: brand ? reputation.listMentions(brand.id, { limit: 40, risky: true }) : [],
    watchTerms: brand ? reputation.watchTerms(brand) : [],
    publicSourcesEnabled: providers.has('public'),
  }),
});

router.post('/reputation/terms', (req, res) => {
  if (!requireWrite(req, res)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, req.dataUserId);
  if (!brand) return res.redirect(`${req.baseUrl}/reputation?error=${encodeURIComponent('Brand not found.')}`);
  db.prepare('UPDATE brands SET mention_terms=?, mention_subreddits=? WHERE id=?')
    .run(
      String(req.body.mention_terms || '').trim() || null,
      // Normalised to bare names so "r/webdesign", "/r/webdesign" and
      // "webdesign" all store identically and the scraper does not have to
      // guess which form it was given.
      String(req.body.mention_subreddits || '')
        .split(/[\s,;]+/)
        .map((x) => x.replace(/^\/?r\//i, '').trim())
        .filter(Boolean)
        .join(', ') || null,
      brand.id,
    );
  res.redirect(`${req.baseUrl}/reputation?brand=${brand.id}&msg=${encodeURIComponent('Watch terms and subreddits saved.')}`);
});

router.post('/reputation/mention/:id/reviewed', (req, res) => {
  if (!requireWrite(req, res)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.body.brand_id, req.dataUserId);
  if (!brand) return res.redirect(`${req.baseUrl}/reputation?error=${encodeURIComponent('Brand not found.')}`);
  reputation.markReviewed(brand.id, req.params.id);
  res.redirect(`${req.baseUrl}/reputation?brand=${brand.id}&msg=${encodeURIComponent('Marked as reviewed.')}`);
});

// ------------------------------------------------------- 8. freshness

feature({
  slug: 'freshness',
  kind: 'freshness',
  engine: freshness,
  listView: 'aiseo/freshness',
  resultView: 'aiseo/freshness-result',
  title: 'Freshness & intent drift',
  argsFrom: (req) => ({
    maxPages: Math.min(200, Math.max(5, parseInt(req.body.max_pages, 10) || 40)),
    driftThreshold: Math.min(0.9, Math.max(0.1, parseFloat(req.body.drift_threshold) || 0.35)),
    staleDays: Math.min(1460, Math.max(60, parseInt(req.body.stale_days, 10) || 365)),
    wantAi: req.body.want_ai !== 'off',
    force: req.body.force === '1',
  }),
});

// Schedules the refresh work as dated tasks, spread over the weeks ahead.
router.post('/freshness/:id/schedule', (req, res) => {
  if (!requireWrite(req, res)) return;
  const userId = req.dataUserId;
  const run = store.get(req.params.id, userId);
  if (!run || run.kind !== 'freshness') return res.redirect(`${req.baseUrl}/freshness?error=${encodeURIComponent('Run not found.')}`);
  const brand = run.brand_id ? db.prepare('SELECT * FROM brands WHERE id=?').get(run.brand_id) : null;
  const capacity = Math.min(20, Math.max(1, parseInt(req.body.weekly_capacity, 10) || 3));
  const r = freshness.scheduleRefreshes(run, brand, { userId: req.actorId || userId, weeklyCapacity: capacity });
  res.redirect(`${req.baseUrl}/freshness/${run.id}?msg=${encodeURIComponent(
    r.created
      ? `${r.created} refresh task${r.created === 1 ? '' : 's'} scheduled at ${capacity} per week.`
      : `No new tasks — all ${r.scheduled} flagged page(s) already have one.`,
  )}`);
});

// ------------------------------------------------------- 9. tracking board

feature({
  slug: 'monitoring',
  kind: 'tracking',
  engine: tracking,
  listView: 'aiseo/monitoring',
  resultView: 'aiseo/monitoring-result',
  title: 'SEO tracking board',
  argsFrom: (req) => ({
    only: Array.isArray(req.body.checks) && req.body.checks.length ? req.body.checks
      : (req.body.checks ? [req.body.checks] : null),
    sampleSize: Math.min(40, Math.max(3, parseInt(req.body.sample_size, 10) || 12)),
    // NEW: 'sitewide' hands the full URL set to the checks that declared they
    // can handle one; the rest keep the sample. See tracking.js for why the
    // gate exists.
    scope: req.body.scope === 'sitewide' ? 'sitewide' : 'sample',
    sitewideCap: Math.min(10000, Math.max(50, parseInt(req.body.sitewide_cap, 10) || 3000)),
  }),
  extraLocals: (req, brand, userId) => ({
    board: brand ? tracking.board({ userId, brandId: brand.id }) : null,
    availability: trackingCatalog.availability(),
    grouped: trackingCatalog.grouped(),
  }),
});

// One metric's history as JSON, for the sparklines on the board.
router.get('/monitoring/series/:metricKey', (req, res) => {
  const brand = db.prepare('SELECT id FROM brands WHERE id=? AND user_id=?').get(req.query.brand, req.dataUserId);
  if (!brand) return res.status(404).json({ error: 'brand not found' });
  const rows = tracking.series(brand.id, req.params.metricKey, {
    url: req.query.url || '',
    limit: Math.min(180, Math.max(2, parseInt(req.query.limit, 10) || 60)),
  });
  res.json({ metricKey: req.params.metricKey, url: req.query.url || '', points: rows });
});

module.exports = router;
