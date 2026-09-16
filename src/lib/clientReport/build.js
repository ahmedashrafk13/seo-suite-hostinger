// THE CLIENT REPORT: from a URL to a document a sales team can send.
//
// WHAT THIS PRODUCES
// One frozen JSON payload holding every number, sentence and table the client
// will see. views/client-report-doc.ejs renders it and reads nothing else, so
// a report emailed in March still shows March's figures in December - and a
// change to a collector cannot silently rewrite a document that has already
// been sent.
//
// THE AUDIENCE IS THE CONSTRAINT
// The reader is the person who signs the contract. They are not technical and
// they are not stupid, which rules out both the raw crawler output and the
// content-free "your SEO score is 62!" one-pager. So every issue is stated
// three times over: what we found, why it costs them something, and what we
// would do about it. Sections they cannot act on are cut.
//
// WHAT IT REFUSES TO DO
//  - It does not estimate traffic, revenue or "lost leads". Nothing here
//    measures those, and an invented figure in a document a client forwards to
//    their own analyst is how an agency loses the account it just won.
//  - It does not report current Google rankings. A prospect has no Search
//    Console, and this deployment holds no Google SERP credential; what it has
//    is a sample of an independent index, labelled as one everywhere it
//    appears. See lib/aiseo/serpLite.js.
//  - It does not report a pillar it could not measure as a good one. An
//    unmeasured pillar is excluded from the overall score on BOTH sides of the
//    ratio, exactly as the AI SEO board does - collapsing "could not measure"
//    into "fine" is how a monitoring system reports green through an outage.
const store = require('./store');
const collect = require('./collect');
const issues = require('./issues');
const branding = require('./branding');
const providers = require('../aiseo/providers');
const markets = require('../aiseo/markets');

// The crawler's own severity weights, reused so an area score computed here
// cannot disagree with the Site Health figure the audit page shows.
const TIER_WEIGHT = { error: 5, warning: 2, notice: 1 };
const PENALTY_EXP = 0.5;

// Pillar weights for the overall score. Foundations dominate because a page
// that cannot be crawled, indexed or reached does not benefit from anything
// else on the list.
const PILLAR_WEIGHT = {
  foundations: 28,
  content: 20,
  speed: 20,
  ai: 12,
  visibility: 12,
  trust: 8,
};

const GRADES = [
  { min: 85, grade: 'A', label: 'Strong' },
  { min: 70, grade: 'B', label: 'Good, with gaps' },
  { min: 55, grade: 'C', label: 'Needs work' },
  { min: 40, grade: 'D', label: 'Poor' },
  { min: 0, grade: 'E', label: 'Critical' },
];

function gradeFor(score) {
  if (score == null) return { grade: null, label: 'Not measured' };
  return GRADES.find((g) => score >= g.min) || GRADES[GRADES.length - 1];
}

const n = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');

// ---------------------------------------------------------------- scoring

// An area's score, computed from the crawler's own findings with the crawler's
// own formula, restricted to the checks belonging to that area.
function areaScore(cards) {
  let num = 0;
  let den = 0;
  cards.forEach((c) => {
    const w = TIER_WEIGHT[c.tier];
    if (!w || !(c.total > 0)) return;
    const failFrac = Math.min(1, c.failed / c.total);
    num += w * (1 - (failFrac ** PENALTY_EXP));
    den += w;
  });
  return den ? Math.round((100 * num) / den) : null;
}

// ------------------------------------------------------------ the crawl

// Every crawler finding becomes a client-facing card. Findings with nothing
// failing become the "what is already right" list rather than being dropped:
// a report that lists only problems reads as a sales pitch, and the passed
// checks are the evidence that the whole site was examined.
function fromCrawl(crawl) {
  const cards = [];
  const passed = [];
  const byArea = {};

  (crawl.findings || []).forEach((f) => {
    const failed = Number(f.failed || 0);

    // EVERY check contributes to its area's score, passing ones included.
    //
    // This used to record only the failures, which looked right and scored
    // catastrophically: an area holding three checks where one failed on its
    // single unit scored 0, because the two clean checks were never in the
    // denominator. A site with HSTS off and no other security problem reported
    // a Security and trust score of zero. Passing checks hold the score up -
    // exactly as they do in the crawler's own Site Health figure, whose formula
    // this reuses.
    const area = (issues.CATALOG[f.id] && issues.CATALOG[f.id].area) || 'foundations';
    (byArea[area] = byArea[area] || []).push({
      tier: f.tier, failed, total: Number(f.total || 0),
    });

    if (failed <= 0) {
      passed.push({ name: f.name, summary: f.summary });
      return;
    }
    const card = issues.translate({
      id: f.id, name: f.name, tier: f.tier, summary: f.summary,
      failed, total: f.total, unit: f.unit, items: f.items,
    });
    card.priority = issues.priority(card);
    card.source = 'crawl';
    cards.push(card);
  });

  return { cards, passed, byArea };
}

// ------------------------------------------------------- crawlability / AI

function fromReadiness(run) {
  const cards = [];
  if (!run || !run.findings) return { cards, score: null };
  run.findings.forEach((f) => {
    const card = issues.translate({
      checkKey: f.check_key || f.checkKey,
      title: f.title,
      detail: f.detail,
      severity: f.severity,
      affectedCount: f.affected_count || f.affectedCount,
      action: f.action,
      items: f.affected_url ? [{ url: f.affected_url, note: null }] : [],
    });
    card.priority = issues.priority(card);
    card.source = 'crawlability';
    cards.push(card);
  });
  return { cards, score: run.score == null ? null : Math.round(run.score) };
}

// ------------------------------------------------------------- page speed

// PSI returns four category scores and the Core Web Vitals. The client sees
// the vitals in Google's own terms with the threshold spelled out, because
// "LCP 4.8s" means nothing and "the main content takes 4.8 seconds to appear,
// against a 2.5 second target" means something to anyone.
function fromSpeed(runs) {
  if (!runs || !runs.length) return null;
  const mobile = runs.filter((r) => r.strategy === 'mobile' && r.report);
  const desktop = runs.filter((r) => r.strategy === 'desktop' && r.report);
  if (!mobile.length) return null;

  const pages = mobile.map((r) => {
    const cats = {};
    (r.report.categories || []).forEach((c) => { cats[c.id] = c.score; });
    const field = r.report.field && r.report.field.available ? r.report.field : null;
    const lab = {};
    (r.report.metrics || []).forEach((m) => { lab[m.id] = m; });
    return {
      url: r.url,
      performance: cats.performance ?? null,
      accessibility: cats.accessibility ?? null,
      bestPractices: cats['best-practices'] ?? null,
      seo: cats.seo ?? null,
      fieldAvailable: Boolean(field),
      vitals: field
        ? field.metrics.map((m) => ({
          key: m.key,
          label: (issues.VITALS[m.key] || {}).label || m.label,
          plain: (issues.VITALS[m.key] || {}).plain || null,
          target: (issues.VITALS[m.key] || {}).good || null,
          why: (issues.VITALS[m.key] || {}).why || null,
          value: m.value,
          band: m.band,
          good: m.good,
          poor: m.poor,
        }))
        : [],
      // The lab metrics are the fallback when no real-visitor data exists -
      // which is the normal case for a smaller site, and must be labelled as a
      // laboratory measurement rather than passed off as what visitors see.
      labMetrics: ['largest-contentful-paint', 'cumulative-layout-shift', 'speed-index', 'total-blocking-time']
        .filter((id) => lab[id])
        .map((id) => ({ id, title: lab[id].title, value: lab[id].displayValue, band: lab[id].band })),
      // The three most expensive fixes PSI named, in its own words. These are
      // the technical detail a client's developer will want, so they are kept
      // in an appendix rather than the body.
      opportunities: (r.report.insights || []).slice(0, 6).map((a) => ({
        title: a.title, savingsMs: a.savingsMs || null, score: a.score,
      })),
    };
  });

  const desktopScores = desktop.map((r) => {
    const cats = {};
    (r.report.categories || []).forEach((c) => { cats[c.id] = c.score; });
    return { url: r.url, performance: cats.performance ?? null };
  });

  const scored = pages.map((p) => p.performance).filter((v) => v != null);
  return {
    pages,
    desktop: desktopScores,
    mobilePerformance: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    anyFieldData: pages.some((p) => p.fieldAvailable),
  };
}

// --------------------------------------------------------------- keywords

// The demand side, from Google's own figures, and the visibility side from a
// sample of an independent index. Kept in one section because the pair is the
// argument: here is what people search for, and here is how little of it you
// currently appear for.
function fromKeywords(demand, sample) {
  if (!demand || !demand.rows || !demand.rows.length) return null;

  const rows = demand.rows.map((r) => ({
    keyword: r.keyword,
    volume: r.volume ?? null,
    competition: r.competition || null,
    competitionIndex: r.competitionIndex ?? null,
    lowBid: r.lowBid ?? null,
    highBid: r.highBid ?? null,
    trendPct: r.trendPct ?? null,
    changeYoY: r.changeYoY ?? null,
    group: r.conceptGroup || null,
  }));

  const checked = sample || [];
  const visible = checked.filter((c) => c.visible === true);
  const notVisible = checked.filter((c) => c.visible === false);
  const unknown = checked.filter((c) => c.visible == null);

  // Where the money is: high volume, and the site is not showing up. Sorted by
  // volume because that is the order a client reads it in.
  const gaps = notVisible
    .slice()
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 15);

  const totalSearches = rows.reduce((a, r) => a + Number(r.volume || 0), 0);
  const gapSearches = notVisible.reduce((a, r) => a + Number(r.volume || 0), 0);

  // Which rival domains kept appearing where this site did not. Counted rather
  // than asserted, and only from the sampled result pages.
  const rivalCount = new Map();
  notVisible.forEach((c) => (c.rivals || []).forEach((d) => {
    rivalCount.set(d, (rivalCount.get(d) || 0) + 1);
  }));
  const rivals = [...rivalCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, appearances]) => ({ domain, appearances }));

  return {
    market: demand.market,
    marketLabel: markets.label(demand.market),
    rows: rows.slice(0, 40),
    rowsTotal: rows.length,
    totalSearches,
    gapSearches,
    checked: checked.length,
    visible: visible.length,
    notVisible: notVisible.length,
    unknown: unknown.length,
    sampleEngine: (checked.find((c) => c.engine) || {}).engine || null,
    gaps,
    rivals,
    basis: demand.basis || null,
    // Percentages are computed over the keywords that could actually be
    // sampled. An unknown is excluded from both sides, never counted as a
    // failure to rank.
    visibleShare: (visible.length + notVisible.length)
      ? Math.round((visible.length / (visible.length + notVisible.length)) * 100)
      : null,
  };
}

// ------------------------------------------------------------- the summary

// The executive summary, composed from measurements rather than written.
//
// Every sentence here is a statement about a number that was measured, and
// every number is interpolated. If a measurement is missing, its sentence is
// omitted rather than softened into a claim that was never checked.
function summarise({ site, overall, pillars, priorities, speed, keywords, readiness, crawlScope }) {
  const bullets = [];

  const one = crawlScope.pagesCrawled === 1;
  bullets.push(`We examined ${n(crawlScope.pagesCrawled)} ${one ? 'page' : 'pages'} on ${site.domain} and ran ${crawlScope.checksRun} technical checks against ${one ? 'it' : 'them'}.`);

  if (overall.score != null) {
    bullets.push(`Overall the site scores ${overall.score} out of 100 - ${overall.label.toLowerCase()}. ${overall.score >= 70
      ? 'The foundations are sound, and the gains available are mostly in what the site says rather than how it is built.'
      : 'That figure is held down by a small number of issues that affect many pages at once, which is the most fixable kind.'}`);
  }

  const critical = priorities.filter((p) => p.severity === 'critical');
  if (critical.length) {
    bullets.push(`${critical.length === 1 ? 'One issue is' : `${critical.length} issues are`} serious enough to be limiting what the site can rank for today${critical[0] ? `, beginning with: ${critical[0].headline.toLowerCase()}` : ''}.`);
  } else if (priorities.length) {
    bullets.push('Nothing on the site is critically broken. The opportunities below are improvements rather than repairs.');
  }

  if (speed && speed.mobilePerformance != null) {
    bullets.push(`On a mobile connection the site scores ${speed.mobilePerformance} out of 100 for speed${speed.anyFieldData
      ? ', measured against what real visitors to the site experienced over the last month'
      : ' in laboratory conditions - the site does not yet have enough traffic for Google to report real-visitor data'}.`);
  }

  if (keywords) {
    bullets.push(`Google reports ${n(keywords.totalSearches)} searches a month across the ${n(keywords.rowsTotal)} terms it considers this site relevant to${keywords.visibleShare != null
      ? `. In our sample of ${keywords.visible + keywords.notVisible} of those terms, the site appeared for ${keywords.visible}`
      : ''}.`);
  }

  if (readiness != null) {
    bullets.push(`For AI assistants - ChatGPT, Perplexity, Google's AI answers - the site scores ${readiness} out of 100 on whether it can be read and quoted at all.`);
  }

  return bullets;
}

// The one paragraph a salesperson reads out loud. Deliberately short, and
// deliberately about the client's business rather than about SEO.
function positioning({ overall, priorities, keywords, company }) {
  const parts = [];
  const quickWins = priorities.filter((p) => p.effort === 'quick').length;

  if (overall.score != null && overall.score < 70) {
    parts.push(`${company} is being held back by fixable technical problems rather than by anything about the business itself.`);
  } else {
    parts.push(`${company} has a technically sound website, which means the work worth doing is about reach rather than repair.`);
  }
  if (quickWins) {
    parts.push(`${quickWins} of the ${priorities.length} priorities below are quick wins - changes a developer can make in a day, not a project.`);
  }
  if (keywords && keywords.gapSearches > 0) {
    parts.push(`There are ${n(keywords.gapSearches)} searches a month across the terms we sampled where the site did not appear at all.`);
  }
  parts.push('Everything in this report was measured directly from the live website on the date shown; nothing is estimated.');
  return parts.join(' ');
}

// -------------------------------------------------------------- the plan

// 30/60/90, sequenced by effort and then by priority. The horizons come from
// the issue catalog so that the plan and the issue cards cannot disagree about
// how hard something is.
function planFrom(cards) {
  const bucket = { thirty: [], sixty: [], ninety: [] };
  const key = { quick: 'thirty', moderate: 'sixty', project: 'ninety' };
  cards.slice().sort((a, b) => b.priority - a.priority).forEach((c) => {
    const k = key[c.effort] || 'sixty';
    if (bucket[k].length < 8) bucket[k].push({ headline: c.headline, fix: c.fix, area: c.areaLabel });
  });
  return bucket;
}

// ------------------------------------------------------------------ build

async function run({
  userId, reportId, url, company = null, preparedFor = null,
  market = 'ZZ', depth = 'full',
}) {
  const prof = collect.profile(depth);
  const startedMs = Date.now();
  const sourceRuns = {};
  const attempts = {};
  const stage = (label, opts) => store.stage(reportId, label, opts);

  // 1. The homepage. The only step whose failure ends the report.
  stage('Reading the website');
  const site = await collect.readHomepage(url);
  const domain = collect.hostKey(site.url);

  // 2. The crawl. Started first because it is the longest-running step and
  //    everything else can be read while it works - except that it is awaited
  //    here rather than raced, for the memory reason in collect.js.
  stage(`Crawling up to ${prof.crawlPages} pages`);
  const crawlAttempt = await collect.attempt('crawl', async () => {
    const runId = collect.startCrawl({ userId, url: site.url, maxPages: prof.crawlPages });
    sourceRuns.auditRunId = runId;
    return collect.waitForCrawl(runId, {
      onTick: (line) => { if (line) store.stage(reportId, `Crawling: ${line.slice(0, 80)}`); },
    });
  });
  attempts.crawl = crawlAttempt;
  stage(crawlAttempt.ok ? 'Crawl finished' : 'Crawl failed', { ok: crawlAttempt.ok, note: crawlAttempt.error });

  // 3. Crawlability and AI-crawler access.
  stage('Checking crawlability and AI access');
  const readinessAttempt = await collect.attempt('readiness', async () => {
    const res = await collect.siteReadiness.run({
      userId, brand: null, site: site.url, maxPages: prof.readinessPages, probeEdge: true,
    });
    if (res && res.id) sourceRuns.readinessRunId = res.id;
    return res;
  });
  attempts.readiness = readinessAttempt;
  stage(readinessAttempt.ok ? 'Crawlability checked' : 'Crawlability check failed',
    { ok: readinessAttempt.ok, note: readinessAttempt.error });

  // 4. Structured data on the homepage.
  stage('Checking structured data');
  const schemaAttempt = await collect.attempt('schema', async () => {
    const res = await collect.schemaAuto.run({
      userId, brand: null, url: site.url, wantedTypes: [], wantAi: false,
    });
    if (res && res.id) sourceRuns.schemaRunId = res.id;
    return res;
  });
  attempts.schema = schemaAttempt;

  // 5. Speed.
  stage('Measuring speed with PageSpeed Insights');
  const speedAttempt = await collect.attempt('speed', () => collect.runPagespeed({
    userId,
    urls: collect.speedTargets(site.url, crawlAttempt.value, prof.psiUrls),
    wantDesktop: prof.psiDesktop,
  }));
  attempts.speed = speedAttempt;
  stage(speedAttempt.ok ? 'Speed measured' : 'Speed measurement unavailable',
    { ok: speedAttempt.ok, note: speedAttempt.error });

  // 6. Demand: Google's own search volumes, seeded from the domain.
  stage('Reading search demand from Google');
  const demandAttempt = await collect.attempt('keywords', () => collect.keywordDemand({
    userId, url: site.url, market, limit: prof.keywordIdeas,
  }));
  attempts.keywords = demandAttempt;

  // 7. Visibility: does the site show up for those terms? Sampled, paced, and
  //    labelled as a non-Google index everywhere it is shown.
  let visibilityAttempt = { ok: false, value: null, error: 'No keywords to sample.' };
  if (demandAttempt.ok && demandAttempt.value && demandAttempt.value.rows.length) {
    stage(`Sampling search results for ${prof.serpChecks} terms`);
    visibilityAttempt = await collect.attempt('visibility', () => collect.visibilitySample({
      domain,
      keywords: demandAttempt.value.rows,
      market: demandAttempt.value.market,
      limit: prof.serpChecks,
    }));
  }
  attempts.visibility = visibilityAttempt;

  // 8. Internal links. Full reports only - it is a second crawl of the site.
  let linkingAttempt = { ok: false, value: null, error: 'Not run on a quick scan.' };
  if (prof.linking) {
    stage('Mapping internal links');
    linkingAttempt = await collect.attempt('linking', async () => {
      const runId = collect.startLinking({ userId, url: site.url, maxPages: Math.min(prof.crawlPages, 120) });
      sourceRuns.linkingRunId = runId;
      return collect.waitForLinking(runId);
    });
  }
  attempts.linking = linkingAttempt;

  // ----------------------------------------------------------- assembly
  stage('Writing the report');

  const crawl = crawlAttempt.ok ? crawlAttempt.value : null;
  const crawlCards = crawl ? fromCrawl(crawl) : { cards: [], passed: [], byArea: {} };
  const readiness = readinessAttempt.ok ? fromReadiness(readinessAttempt.value) : { cards: [], score: null };
  const speed = speedAttempt.ok ? fromSpeed(speedAttempt.value) : null;
  const keywords = demandAttempt.ok
    ? fromKeywords(demandAttempt.value, visibilityAttempt.ok ? visibilityAttempt.value : [])
    : null;

  const allCards = [...crawlCards.cards, ...readiness.cards]
    .sort((a, b) => b.priority - a.priority);

  // Pillar scores. Each is null when it could not be measured, and a null is
  // excluded from the overall on both sides of the ratio.
  const pillarScores = {
    foundations: areaScore(crawlCards.byArea.foundations || []),
    content: areaScore(crawlCards.byArea.content || []),
    trust: areaScore(crawlCards.byArea.trust || []),
    speed: speed ? speed.mobilePerformance : null,
    ai: readiness.score,
    visibility: keywords ? keywords.visibleShare : null,
  };

  let num = 0;
  let den = 0;
  Object.entries(pillarScores).forEach(([key, value]) => {
    if (value == null) return;
    num += PILLAR_WEIGHT[key] * value;
    den += PILLAR_WEIGHT[key];
  });
  const overallScore = den ? Math.round(num / den) : null;
  const overall = { score: overallScore, ...gradeFor(overallScore) };

  const PILLAR_NOTE = {
    foundations: 'Can search engines reach, read and index the site.',
    content: 'Whether each page states clearly what it is for.',
    speed: 'How quickly the site loads and responds on a phone.',
    trust: 'Whether the connection and the pages are secure.',
    ai: 'Whether AI assistants can read and quote the site.',
    visibility: 'How often the site appeared for the terms we sampled.',
  };
  // Written for the client, not for the team. "PageSpeed Insights did not
  // return a result" names a tool they have never heard of and reads as our
  // problem leaking onto their document; the internal view carries the real
  // error for whoever has to fix it.
  const PILLAR_UNKNOWN = {
    foundations: 'We could not read enough of the site to score this.',
    content: 'We could not read enough of the site to score this.',
    speed: 'A speed measurement could not be completed for this site.',
    trust: 'We could not read enough of the site to score this.',
    ai: 'The crawler access checks could not be completed for this site.',
    visibility: 'No search results could be sampled for this site.',
  };

  const pillars = Object.keys(PILLAR_WEIGHT).map((key) => {
    const score = pillarScores[key];
    return {
      key,
      label: issues.AREAS[key],
      score,
      ...gradeFor(score),
      weight: PILLAR_WEIGHT[key],
      note: PILLAR_NOTE[key],
      unknownReason: score == null ? PILLAR_UNKNOWN[key] : null,
    };
  });

  const priorities = allCards.slice(0, 8);
  const byArea = {};
  allCards.forEach((c) => { (byArea[c.area] = byArea[c.area] || []).push(c); });

  // The same cards again, grouped into the document's chapters instead of the
  // scorecard's pillars, and ordered by issues.TOPICS rather than by whichever
  // chapter happened to produce a finding first. A chapter with nothing failing
  // is dropped here and reinstated by the view as a passed chapter, so the
  // contents page lists every chapter the crawl actually covered.
  const byTopic = {};
  allCards.forEach((c) => { (byTopic[c.topic] = byTopic[c.topic] || []).push(c); });

  const companyName = company || site.inferredCompany;
  const crawlScope = {
    pagesCrawled: crawl ? (crawl.pages_crawled || 0) : 0,
    pagesOk: crawl ? (crawl.pages_ok || 0) : 0,
    linksChecked: crawl ? (crawl.links_checked || 0) : 0,
    checksRun: crawl ? (crawl.findings || []).length : 0,
    siteHealth: crawl ? crawl.site_health : null,
    cap: prof.crawlPages,
    // True when the crawl stopped because it hit the page limit rather than
    // because it ran out of site. The document says so, so that "we examined
    // 150 pages" is never read as "the site has 150 pages".
    cappedOut: crawl ? (crawl.pages_crawled || 0) >= prof.crawlPages : false,
  };

  const headline = summarise({
    site: { ...site, domain },
    overall,
    pillars,
    priorities,
    speed,
    keywords,
    readiness: readiness.score,
    crawlScope,
  });

  // What was measured, and - just as important - what could not be. The second
  // list is what stops a client concluding that a section is missing because
  // there was nothing to say.
  const measured = [];
  const notMeasured = [];
  if (crawlAttempt.ok) measured.push(`A crawl of ${n(crawlScope.pagesCrawled)} pages, run from our own servers on the date above.`);
  else notMeasured.push(`The site crawl could not be completed: ${crawlAttempt.error}`);
  if (speed) measured.push('Google PageSpeed Insights, including real-visitor data where Google holds enough of it.');
  else notMeasured.push(`Speed could not be measured: ${speedAttempt.error || 'no result returned'}.`);
  if (readiness.score != null) measured.push('Direct requests to the site as each major search and AI crawler, plus its robots and sitemap files.');
  else notMeasured.push(`Crawlability could not be checked: ${readinessAttempt.error || 'no result returned'}.`);
  if (keywords) measured.push(`Search volumes from Google Ads Keyword Planner for ${keywords.marketLabel}, seeded from this domain.`);
  else notMeasured.push(`Search demand could not be read from Google: ${demandAttempt.error || 'no rows returned'}.`);
  if (keywords && keywords.checked) {
    measured.push(`A sample of ${keywords.checked} result pages from an independent search index, to see where the site currently appears.`);
  }
  notMeasured.push('Current Google rankings and actual visitor numbers. These are only available from the site\'s own Search Console and Analytics accounts, which we would connect at the start of an engagement.');

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    depth,
    profile: { label: prof.label, estimate: prof.estimate, crawlPages: prof.crawlPages },
    durationMs: Date.now() - startedMs,

    client: {
      company: companyName,
      preparedFor: preparedFor || null,
      url: site.url,
      domain,
      title: site.title,
      lang: site.lang,
    },

    agency: branding.get(userId),

    overall,
    pillars,
    headline,
    positioning: positioning({ overall, priorities, keywords, company: companyName }),

    priorities: priorities.map((c, i) => ({ ...c, rank: i + 1 })),
    issuesByTopic: issues.TOPICS
      .map(({ key, label }) => ({
        key,
        label,
        cards: byTopic[key] || [],
        criticalCount: (byTopic[key] || []).filter((x) => x.severity === 'critical').length,
      }))
      .filter((t) => t.cards.length),

    issuesByArea: Object.entries(byArea).map(([key, cards]) => ({
      key,
      label: issues.AREAS[key],
      cards,
      criticalCount: cards.filter((c) => c.severity === 'critical').length,
    })),
    issueCounts: {
      total: allCards.length,
      critical: allCards.filter((c) => c.severity === 'critical').length,
      important: allCards.filter((c) => c.severity === 'important').length,
      minor: allCards.filter((c) => c.severity === 'worth fixing').length,
      quickWins: allCards.filter((c) => c.effort === 'quick').length,
    },
    passed: crawlCards.passed,

    speed,
    keywords,
    schema: schemaAttempt.ok ? summariseSchema(schemaAttempt.value) : null,
    linking: linkingAttempt.ok ? summariseLinking(linkingAttempt.value) : null,
    siteSignals: {
      contentInHtml: !site.spaMarker,
      structuredDataBlocks: site.jsonLdBlocks,
      homepageWords: site.wordCount,
      hasMetaDescription: Boolean(site.metaDescription),
      hasH1: Boolean(site.h1),
    },

    plan: planFrom(allCards),

    method: {
      measured,
      notMeasured,
      crawlScope,
      serpCaveat: keywords && keywords.checked
        ? 'Where this report says the site "appeared" or "did not appear" for a term, that is a sample of an independent search index taken on the date above, not a Google ranking. It is a reliable indicator of competitive position and it is not a substitute for rank tracking, which we set up properly at the start of an engagement.'
        : null,
      // Commercial data providers this deployment does not hold a credential
      // for, named rather than quietly missing. It is also the honest answer
      // to "why is there no backlink section".
      wouldImprove: providers.provenance([]).wouldImprove,
    },

    // Kept out of the client-facing view and rendered on the internal one, so
    // the team can see which sources contributed and which failed.
    internal: {
      attempts: Object.fromEntries(Object.entries(attempts)
        .map(([k, v]) => [k, { ok: v.ok, ms: v.ms, error: v.error }])),
      sourceRuns,
    },
  };

  store.finish(reportId, {
    score: overall.score,
    grade: overall.grade,
    result,
    sourceRuns,
  });
  return result;
}

// Structured data, reduced to the two things a client can act on: whether the
// page describes itself at all, and what is missing.
function summariseSchema(run) {
  if (!run || !run.result || run.result.empty) return null;
  const r = run.result;
  const present = (r.detectedTypes || []).filter(Boolean);
  const missing = (r.oughtTo || []).filter(Boolean);
  const counts = r.counts || {};
  // The card is only raised when there is genuinely nothing there. A page with
  // some structured data and a few gaps is a refinement, not a finding worth a
  // full card in a client document.
  const card = present.length
    ? null
    : {
        ...issues.SCHEMA_CARD,
      what: issues.SCHEMA_CARD.what(null),
      areaLabel: issues.AREAS[issues.SCHEMA_CARD.area],
      topicLabel: issues.TOPIC_LABEL[issues.SCHEMA_CARD.topic],
      severity: 'important',
      effortLabel: issues.EFFORT[issues.SCHEMA_CARD.effort].label,
      horizon: issues.EFFORT[issues.SCHEMA_CARD.effort].horizon,
      count: 1,
      examples: [],
      source: 'schema',
    };
  return {
    pageType: (r.pageType && (r.pageType.label || r.pageType.type)) || null,
    presentTypes: [...new Set(present)].slice(0, 12),
    missingTypes: [...new Set(missing)].slice(0, 12),
    errorCount: Number(counts.errors || 0),
    warningCount: Number(counts.warnings || 0),
    card,
    score: run.score == null ? null : Math.round(run.score),
  };
}

// The internal-link crawl, reduced to the two findings a client understands:
// pages nothing links to, and pages competing with each other.
function summariseLinking(result) {
  if (!result) return null;
  const orphans = result.orphan_pages || result.orphans || [];
  const cannibal = result.cannibalization || result.cannibalisation || [];
  const recommendations = result.recommendations || result.link_recommendations || [];
  return {
    orphanCount: Array.isArray(orphans) ? orphans.length : 0,
    orphanExamples: (Array.isArray(orphans) ? orphans : []).slice(0, 6)
      .map((o) => (typeof o === 'string' ? o : o.url)).filter(Boolean),
    cannibalCount: Array.isArray(cannibal) ? cannibal.length : 0,
    cannibalExamples: (Array.isArray(cannibal) ? cannibal : []).slice(0, 5)
      .map((c) => (typeof c === 'string' ? c : (c.keyword || c.term || null))).filter(Boolean),
    opportunityCount: Array.isArray(recommendations) ? recommendations.length : 0,
  };
}

module.exports = {
  run, areaScore, gradeFor, fromCrawl, fromReadiness, fromSpeed, fromKeywords,
  summarise, positioning, planFrom, summariseSchema, summariseLinking,
  PILLAR_WEIGHT, GRADES,
};
