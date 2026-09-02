// 6. COMPETITIVE INTELLIGENCE AND GAP ANALYSIS
//
// Reverse-engineers what named competitors publish, how fast they publish it,
// how they link internally, and where their coverage exceeds this brand's —
// then says which of those gaps are worth closing.
//
// WHAT IS MEASURED HERE AND WHAT CANNOT BE
// This is worth stating precisely, because competitive-intelligence tools are
// where invented numbers do the most damage.
//
//   MEASURED, from a real fetch of their site:
//     - their content inventory (sitemap + crawl)
//     - which topics and entities they cover, and which this brand does not
//     - their publishing velocity, from sitemap lastmod and on-page dates
//     - their internal anchor-text patterns, which reveal what they think
//       their own money pages are
//     - their structured data, their schema types, their author markup
//     - their page-level technical posture (TTFB, HTML size, JS dependence)
//
//   MEASURED, from Search Console, for THIS brand only:
//     - the queries this site is shown for, and at what position
//
//   NOT AVAILABLE without a paid credential:
//     - their organic traffic estimate (Semrush)
//     - which pages AI assistants actually cite (DataForSEO/Profound)
//
// The adapters for those exist in ./providers.js and activate on a key. The
// report says, on the page, which questions it cannot answer. That is
// materially more useful than a fabricated Domain Authority: a practitioner
// who knows the basis can act on it.
//
// WHAT THIS REPORT NOW ANSWERS THAT IT PREVIOUSLY DID NOT
// Four requested tables were missing or wrong, and all four are in
// ./gapAnalysis.js with their methods stated on the table itself:
//
//   TOPIC COVERAGE MATRIX  one row per topic, one column per site, one score
//     computed identically for everybody. Replaces the two flat gap lists,
//     which said what was missing but not how far behind we were.
//
//   KEYWORD GAP  where each site appears for each candidate keyword. Measured
//     against Google where a rank-tracker credential exists; otherwise read
//     from a keyless result sample, which is a real like-for-like visibility
//     comparison and is labelled as not-Google everywhere it appears.
//
//   BACKLINK GAP  referring domains per site, and the domains linking to them
//     and not to us. From the Moz link index where a credential exists,
//     otherwise from a VERIFIED sample.
//
//   REFERRING DOMAINS, CORRECTED  the old figure counted pages that MENTIONED
//     a domain, which is not a backlink. Every candidate is now fetched and its
//     outbound links read; a domain counts only where a real link is found.
//
// AND THE NOISE IS GONE
// Competitor brand names, generic button labels and marketing section headings
// ("Learn More", "Why Choose Us", "Office Headquarters") were dominating every
// gap list — structurally, because a competitor's own brand is the entity most
// certain to be on their pages and not on ours. ./boilerplate.js filters them
// and reports what it removed, so the suppression is auditable rather than
// silent.
//
// AI CITATION PROXY
// "Are competitors cited by AI engines and we are not" cannot be measured
// without a citation-tracking API. What CAN be measured, and is a genuine
// component of it, is whether each site is READABLE by the retrieval fetchers
// and structured to be quotable. That is computed for every competitor with the
// same code that scores this brand (./readiness.js, ./nlp.citability) and
// reported as a comparison — labelled as a readiness comparison, not as
// citation share.
const db = require('../../db');
const nlp = require('./nlp');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const analytics = require('../analytics');
const webMentions = require('./webMentions');
const sitemapHistory = require('./sitemapHistory');
const boilerplate = require('./boilerplate');
const gapAnalysis = require('./gapAnalysis');
const markets = require('./markets');
const seoSignals = require('../seoSignals');
const {
  crawlSite, fetchPage, fetchRobots, fetchSitemapUrls, fetchLlmsTxt,
  parseDocument, robotsAllows, measureTtfb, normalizeUrl, hostKey, canonUrl,
  RETRIEVAL_AGENTS,
} = require('./fetcher');

// ------------------------------------------------------------- competitors

function list(brandId) {
  return db.prepare('SELECT * FROM competitors WHERE brand_id=? ORDER BY active DESC, domain').all(brandId);
}

function add({ userId, brandId, domain, label = null, notes = null }) {
  const clean = hostKey(domain);
  if (!clean) throw new Error(`"${domain}" is not a usable domain.`);
  db.prepare(`INSERT INTO competitors (user_id, brand_id, domain, label, notes)
    VALUES (?,?,?,?,?)
    ON CONFLICT(brand_id, domain) DO UPDATE SET
      label=excluded.label, notes=excluded.notes, active=1`)
    .run(userId, brandId, clean, label, notes);
  return db.prepare('SELECT * FROM competitors WHERE brand_id=? AND domain=?').get(brandId, clean);
}

function remove(brandId, id) {
  return db.prepare('DELETE FROM competitors WHERE id=? AND brand_id=?').run(id, brandId).changes;
}

// -------------------------------------------------------------- inventory

// Publishing velocity from the sitemap's lastmod dates.
//
// Reported with an explicit caveat that the UI surfaces: many CMS platforms
// stamp lastmod on every page at deploy time, which makes an inactive site look
// prolific. The check detects that — if most lastmod values fall on one or two
// days, the dates are a deploy artefact, and velocity is reported as unknown
// rather than as a large number.
function velocityFromSitemap(urls) {
  const dated = urls.map((u) => u.lastmod).filter(Boolean)
    .map((d) => {
      const t = Date.parse(d);
      return Number.isFinite(t) ? new Date(t) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b - a);

  if (dated.length < 5) {
    return { usable: false, reason: `only ${dated.length} URL${dated.length === 1 ? '' : 's'} carry a lastmod date`, dated: dated.length, total: urls.length };
  }

  const byDay = new Map();
  dated.forEach((d) => {
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });
  const days = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const topDayShare = days[0][1] / dated.length;
  if (topDayShare > 0.5 && byDay.size < 8) {
    return {
      usable: false,
      reason: `${Math.round(topDayShare * 100)}% of lastmod dates fall on ${days[0][0]} — these are almost certainly stamped at deploy time, not at edit time, so they say nothing about publishing activity`,
      dated: dated.length, total: urls.length, distinctDays: byDay.size,
    };
  }

  const now = Date.now();
  const within = (days90) => dated.filter((d) => (now - d.getTime()) <= days90 * 86400000).length;
  return {
    usable: true,
    dated: dated.length,
    total: urls.length,
    distinctDays: byDay.size,
    newest: dated[0].toISOString().slice(0, 10),
    oldest: dated[dated.length - 1].toISOString().slice(0, 10),
    last30: within(30),
    last90: within(90),
    last365: within(365),
    perMonth: Math.round((within(90) / 3) * 10) / 10,
  };
}

// URL-path taxonomy: what sections a site is organised into, and how big each
// is. The fastest read on where a competitor invests.
function sectionProfile(urls) {
  const sections = new Map();
  urls.forEach((u) => {
    let path = '/';
    try { path = new URL(u.loc || u).pathname; } catch { return; }
    const first = path.split('/').filter(Boolean)[0] || '(root)';
    sections.set(first, (sections.get(first) || 0) + 1);
  });
  return [...sections.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

// Anchor-text patterns from a site's own internal links. This is the closest
// thing to reading a competitor's strategy directly: the phrases they choose to
// link with, weighted by how often, are the terms they are deliberately
// building pages around.
function anchorPatterns(pages) {
  const counts = new Map();
  const targets = new Map();
  pages.filter((p) => p.ok && p.doc).forEach((p) => {
    p.doc.links.filter((l) => l.internal && l.anchor && l.anchor.length > 2).forEach((l) => {
      const anchor = l.anchor.toLowerCase().replace(/\s+/g, ' ').trim();
      if (anchor.length > 70) return;
      // The hand-written stoplist here covered ten phrases. The shared filter
      // covers the whole generic-UI vocabulary plus pricing furniture, and is
      // the same one the on-page and gap analyses use — so "what a competitor
      // links with" now means the same thing everywhere in the suite.
      if (boilerplate.isGenericUi(anchor)) return;
      counts.set(anchor, (counts.get(anchor) || 0) + 1);
      if (!targets.has(anchor)) targets.set(anchor, new Set());
      targets.get(anchor).add(canonUrl(l.url));
    });
  });
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([anchor, count]) => ({ anchor, count, targets: [...(targets.get(anchor) || [])].slice(0, 3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}

// Topic coverage: the entities and phrases a site's crawled pages are about.
function topicProfile(pages) {
  const entityCounts = new Map();
  const phraseCounts = new Map();
  let words = 0;
  let pagesWithSchema = 0;
  let pagesWithAuthor = 0;
  let citabilityTotal = 0;
  let citabilityPages = 0;
  const schemaTypes = new Map();

  // Cross-page template detection: any short string appearing on most of a
  // site's own pages is its furniture, whatever markup it sits in. This is the
  // strongest available boilerplate signal and it only exists because we hold
  // several pages of the same site at once.
  const usablePages = pages.filter((p) => p.ok && p.doc);
  const template = boilerplate.repeatedBlocks(usablePages.map((p) => p.doc));

  usablePages.forEach((p) => {
    const doc = p.doc;
    // Word count stays on the full main region — it is a measure of page size,
    // and stripping the template would make it incomparable with every other
    // word count in the suite. Everything SEMANTIC below uses the clean text.
    words += doc.wordCount;
    const clean = boilerplate.contentText(doc);
    const text = `${doc.title || ''}. ${doc.headings.map((h) => h.text).join('. ')}. ${clean.text.slice(0, 8000)}`;
    nlp.entities(text).filter((e) => e.type !== 'statistic').forEach((e) => {
      const key = e.surface.toLowerCase();
      const cur = entityCounts.get(key) || { surface: e.surface, pages: 0, count: 0 };
      cur.pages += 1;
      cur.count += e.count;
      entityCounts.set(key, cur);
    });
    nlp.keyPhrases(clean.text, { minCount: 2, limit: 12 }).forEach((ph) => {
      phraseCounts.set(ph.phrase, (phraseCounts.get(ph.phrase) || 0) + 1);
    });

    const types = doc.jsonLd.filter((j) => j.ok).flatMap((j) => require('./onpage').schemaTypesOf(j.data));
    if (types.length) pagesWithSchema += 1;
    types.forEach((t) => schemaTypes.set(t, (schemaTypes.get(t) || 0) + 1));
    if (types.some((t) => /Person|author/i.test(t)) || /\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test((doc.mainText || '').slice(0, 1500))) {
      pagesWithAuthor += 1;
    }

    const cit = nlp.citability(doc);
    citabilityTotal += cit.score;
    citabilityPages += 1;
  });

  const usable = usablePages.length;
  return {
    pages: usable,
    avgWords: usable ? Math.round(words / usable) : 0,
    // The site's own template blocks, carried on the profile so the gap
    // analysis can suppress them without re-deriving them.
    template: template.usable
      ? { blocks: template.blocks, examples: template.examples, threshold: template.threshold, basis: template.basis }
      : { usable: false, pages: template.pages },
    entities: [...entityCounts.values()].sort((a, b) => b.pages - a.pages || b.count - a.count).slice(0, 120),
    phrases: [...phraseCounts.entries()].map(([phrase, pages_]) => ({ phrase, pages: pages_ }))
      .sort((a, b) => b.pages - a.pages).slice(0, 60),
    schemaCoverage: usable ? Math.round((pagesWithSchema / usable) * 100) : 0,
    schemaTypes: [...schemaTypes.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    authorCoverage: usable ? Math.round((pagesWithAuthor / usable) * 100) : 0,
    avgCitability: citabilityPages ? Math.round(citabilityTotal / citabilityPages) : null,
  };
}

// AI-retrieval readiness for one domain, computed the same way as for this
// brand so the comparison is like-for-like.
async function retrievalPosture(site) {
  const target = normalizeUrl(site);
  const robots = await fetchRobots(target);
  const llms = await fetchLlmsTxt(target);
  const home = await fetchPage(target, { timeout: 20000 });
  const doc = home.ok && home.body ? parseDocument(home.url, home.body) : null;
  const ttfb = await measureTtfb(target, { samples: 2 });

  const agents = RETRIEVAL_AGENTS.map((a) => {
    const v = robotsAllows(robots.parsed, a.token, '/');
    return { key: a.key, label: a.label, allowedByRobots: v.allowed, rule: v.rule };
  });

  return {
    site: target,
    reachable: home.ok,
    status: home.status,
    ttfbMs: ttfb.ms,
    htmlBytes: home.bytes,
    llmsTxt: llms.present,
    robotsPresent: robots.present,
    retrievalAgentsAllowed: agents.filter((a) => a.allowedByRobots).length,
    retrievalAgentsTotal: agents.length,
    agents,
    servedWordCount: doc ? doc.wordCount : null,
    likelyClientRendered: Boolean(doc && doc.spaMarker && doc.wordCount < 120),
    homeCitability: doc ? nlp.citability(doc).score : null,
    semantic: doc ? doc.semantic : null,
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, maxPagesPerSite = 30, wantAi = true, force = false,
  // NEW SURFACE, all defaulting on:
  country = null,           // which market the keyword gap is read for
  includeTopicMatrix = true,
  includeKeywordGap = true,
  includeBacklinkGap = true,
  keywordGapLimit = 25,     // paced SERP samples, so capped and the cap reported
  backlinkSampleLimit = 20,
}) {
  const brandId = brand.id;
  const site = normalizeUrl(brand.site_url);
  const competitors = list(brandId).filter((c) => c.active);

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'competitive', target: site,
    label: competitors.map((c) => c.domain).join(', ').slice(0, 120) || null,
    params: {
      competitors: competitors.map((c) => c.domain),
      maxPagesPerSite,
      country: markets.resolve(country || brand.market).code,
      includeTopicMatrix, includeKeywordGap, includeBacklinkGap,
      keywordGapLimit, backlinkSampleLimit,
    },
  });

  try {
    const sources = ['crawler'];

    if (!competitors.length) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'No competitors are configured for this brand. Add two to four domains you genuinely compete with — an automatically-guessed list is wrong often enough to waste the crawl.',
          competitors: [],
        },
        findings: [{
          checkKey: 'no_competitors',
          title: 'No competitors configured',
          detail: 'Competitive analysis needs named domains.',
          severity: 'info',
          action: 'Add competitor domains on this page, then re-run.',
          dedupeKey: `competitive:none:${brandId}`,
        }],
        sources,
      });
    }

    // --- our own side ---------------------------------------------------
    const ourRobots = await fetchRobots(site);
    const ourSitemap = await fetchSitemapUrls(site, { limit: 3000, robots: ourRobots });
    const ourCrawl = await crawlSite(site, { maxPages: maxPagesPerSite, concurrency: 4 });
    const ourProfile = topicProfile(ourCrawl.pages);
    const ourVelocity = velocityFromSitemap(ourSitemap.urls);
    const ourVelocityHistory = sitemapHistory.run({ brandId, site: hostKey(site), urls: ourSitemap.urls });
    const ourPosture = await retrievalPosture(site);
    const ourAnchors = anchorPatterns(ourCrawl.pages);
    const market = markets.resolve(country || brand.market);

    // VERIFIED referring pages, not mentions.
    //
    // The old call counted any page a web search returned for the domain name,
    // including pages that merely typed it in running text. Every candidate is
    // now fetched and its anchors read, so a domain counts only where a real
    // link exists. See gapAnalysis.verifyReferring for the three outcomes it
    // distinguishes and why "unverified" is kept as its own bucket.
    const ourReferring = await gapAnalysis.verifyReferring(hostKey(site), { limit: backlinkSampleLimit });
    if (ourReferring.ok) sources.push('web-mentions');

    // --- each competitor ------------------------------------------------
    const theirs = [];
    for (const c of competitors.slice(0, 5)) {
      const cSite = normalizeUrl(c.domain);
      /* eslint-disable no-await-in-loop */
      const robots = await fetchRobots(cSite);
      const sitemap = await fetchSitemapUrls(cSite, { limit: 3000, robots });
      const crawl = await crawlSite(cSite, { maxPages: maxPagesPerSite, concurrency: 3 });
      const profile = topicProfile(crawl.pages);
      const posture = await retrievalPosture(cSite);
      const referring = await gapAnalysis.verifyReferring(hostKey(cSite), {
        limit: backlinkSampleLimit,
        // Our own coverage of a competitor's name is not a third-party link to
        // them, so our host is excluded from their sample.
        excludeHost: hostKey(site),
      });
      if (referring.ok) sources.push('web-mentions');
      await new Promise((r) => { setTimeout(r, 800); });
      /* eslint-enable no-await-in-loop */
      theirs.push({
        domain: c.domain,
        label: c.label || c.domain,
        notes: c.notes,
        inventory: {
          sitemapUrls: sitemap.urls.length,
          sitemapSources: sitemap.sources,
          sections: sectionProfile(sitemap.urls),
        },
        velocity: velocityFromSitemap(sitemap.urls),
        velocityHistory: sitemapHistory.run({ brandId, site: hostKey(cSite), urls: sitemap.urls }),
        crawl: { fetched: crawl.fetched, usable: crawl.pages.filter((p) => p.ok).length, complete: crawl.complete },
        profile,
        posture,
        anchors: anchorPatterns(crawl.pages),
        referring,
        // The crawled pages are kept on the competitor record so the topic
        // matrix can score them without re-crawling. Dropped from the stored
        // payload before it is written — see `theirsForStorage` below — because
        // a parsed cheerio document per page would be megabytes of JSON.
        pages: crawl.pages,
        homeTitle: posture && posture.reachable ? (crawl.pages.find((pp) => pp.ok && pp.doc) || { doc: {} }).doc.title : null,
      });
    }

    // --- content gap ----------------------------------------------------
    // An entity counts as a gap when at least half the competitors cover it
    // and this brand does not. Requiring more than one competitor is what
    // separates a genuine subject expectation from one competitor's
    // idiosyncrasy.
    const ourEntities = new Set(ourProfile.entities.map((e) => e.surface.toLowerCase()));
    const theirEntityCounts = new Map();
    theirs.forEach((t) => {
      const seen = new Set();
      t.profile.entities.forEach((e) => {
        const key = e.surface.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const cur = theirEntityCounts.get(key) || { surface: e.surface, competitors: 0, domains: [], pages: 0 };
        cur.competitors += 1;
        cur.domains.push(t.domain);
        cur.pages += e.pages;
        theirEntityCounts.set(key, cur);
      });
    });
    const gapThreshold = Math.max(1, Math.ceil(theirs.length / 2));

    // WHAT COUNTS AS NOISE FOR THIS RUN.
    //
    // Assembled once and applied to every gap list below. Three sources, all
    // evidence rather than guesswork:
    //   - the competitors' own brand names, derived from their domains and the
    //     brand half of their homepage titles;
    //   - our own brand terms, because a competitor naming us is not a gap in
    //     our content;
    //   - every string that repeats across most pages of any site in the run,
    //     which is that site's template.
    const noiseOpts = {
      competitorTerms: boilerplate.competitorBrandTerms(theirs.map((t) => ({
        domain: t.domain, label: t.label, homeTitle: t.homeTitle,
      }))),
      ownBrandTerms: (() => {
        const bt = seoSignals.brandTerms(brand || {});
        return new Set([...(bt.phrases || []), ...(bt.tokens || [])]);
      })(),
      boilerplateBlocks: (() => {
        const all = new Set();
        [ourProfile, ...theirs.map((t) => t.profile)].forEach((prof) => {
          if (prof && prof.template && prof.template.blocks) {
            prof.template.blocks.forEach((b) => all.add(b));
          }
        });
        return all.size ? all : null;
      })(),
    };

    const entityGapsRaw = [...theirEntityCounts.values()]
      .filter((e) => e.competitors >= gapThreshold && !ourEntities.has(e.surface.toLowerCase()))
      .sort((a, b) => b.competitors - a.competitors || b.pages - a.pages);
    const entityFilter = boilerplate.filterEntities(entityGapsRaw, noiseOpts);
    const entityGaps = entityFilter.kept.slice(0, 60);

    const ourPhrases = new Set(ourProfile.phrases.map((p) => p.phrase));
    const theirPhraseCounts = new Map();
    theirs.forEach((t) => {
      t.profile.phrases.forEach((p) => {
        const cur = theirPhraseCounts.get(p.phrase) || { phrase: p.phrase, competitors: 0, pages: 0 };
        cur.competitors += 1;
        cur.pages += p.pages;
        theirPhraseCounts.set(p.phrase, cur);
      });
    });
    const topicGapsRaw = [...theirPhraseCounts.values()]
      .filter((p) => p.competitors >= gapThreshold && !ourPhrases.has(p.phrase))
      .sort((a, b) => b.competitors - a.competitors || b.pages - a.pages);
    const phraseFilter = boilerplate.filterPhrases(topicGapsRaw, noiseOpts);
    const topicGaps = phraseFilter.kept.slice(0, 50);

    // What the cleaning removed, for the UI. A filter nobody can inspect is a
    // filter nobody can trust, and the previous behaviour — surfacing these as
    // recommendations — is exactly what this run has to be able to prove it
    // stopped doing.
    // The two filters are merged by ADDING their per-reason counts. Taking the
    // union of the two pre-rendered summary strings put "21 competitor brand
    // names" and "30 competitor brand names" on the same line as separate
    // entries, which reads as a bug because it is one.
    const mergedReasons = { ...entityFilter.byReason };
    Object.entries(phraseFilter.byReason || {}).forEach(([reason, n]) => {
      mergedReasons[reason] = (mergedReasons[reason] || 0) + n;
    });

    const noiseRemoved = {
      entities: entityFilter.suppressed.slice(0, 60),
      phrases: phraseFilter.suppressed.slice(0, 60),
      total: entityFilter.suppressedCount + phraseFilter.suppressedCount,
      byReason: mergedReasons,
      summary: boilerplate.renderReasonSummary(mergedReasons),
      competitorBrandTerms: [...noiseOpts.competitorTerms].slice(0, 40),
      templateBlocksDetected: noiseOpts.boilerplateBlocks ? noiseOpts.boilerplateBlocks.size : 0,
    };

    // --- sections they have and we do not -------------------------------
    const ourSections = new Set(sectionProfile(ourSitemap.urls).map((s) => s.section));
    const sectionGaps = [];
    theirs.forEach((t) => {
      t.inventory.sections.filter((s) => s.count >= 3 && !ourSections.has(s.section)).forEach((s) => {
        const existing = sectionGaps.find((g) => g.section === s.section);
        if (existing) { existing.competitors.push({ domain: t.domain, pages: s.count }); }
        else sectionGaps.push({ section: s.section, competitors: [{ domain: t.domain, pages: s.count }] });
      });
    });
    sectionGaps.sort((a, b) => b.competitors.length - a.competitors.length);

    // --- keyword-side context, for our own site only --------------------
    let ourQueries = [];
    if (brandId) {
      const anchor = analytics.latestGscDate(brandId);
      if (anchor) {
        const w = analytics.windowFrom(anchor, 90);
        ourQueries = db.prepare(`SELECT query, SUM(impressions) impressions, SUM(clicks) clicks,
            SUM(position*impressions)/NULLIF(SUM(impressions),0) position
          FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
          GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 300`)
          .all(brandId, w.startDate, w.endDate);
        if (ourQueries.length) sources.push('gsc');
      }
    }

    // Queries we already have demand for, that map onto a topic gap. These are
    // the strongest opportunities available without a rank tracker: proven
    // demand on our own property, and competitors already publishing for it.
    const gapTerms = new Set([...entityGaps, ...topicGaps].flatMap((g) => nlp.contentWords(g.surface || g.phrase).map(nlp.stem)));
    const corroborated = ourQueries.filter((q) => {
      const toks = nlp.contentWords(q.query).map(nlp.stem);
      return toks.length && toks.some((t) => gapTerms.has(t)) && (Number(q.position) || 100) > 10;
    }).slice(0, 40);

    // ============================================ TOPIC COVERAGE MATRIX
    //
    // Topic | Comp 1 | Comp 2 | … | Our brand, one score per cell, computed
    // identically for every site. Built from the CLEANED gap lists, collapsed
    // so "capital adequacy" and "capital adequacy requirements" are one row.
    let matrix = null;
    if (includeTopicMatrix) {
      const derived = gapAnalysis.topicsFromGaps({
        entityGaps: entityGaps.map((e) => ({ surface: e.surface, count: e.pages })),
        topicGaps,
        ourPhrases: [...ourPhrases],
        noiseOpts,
        limit: 30,
      });
      // Our own strongest topics are added to the matrix as well. A table that
      // only lists what we are missing reads as though we cover nothing, and
      // the columns are far more legible when some rows show us ahead.
      const ourTopTopics = ourProfile.phrases.slice(0, 8)
        .filter((ph) => !boilerplate.isGenericUi(ph.phrase))
        .map((ph) => ({ topic: ph.phrase, terms: [ph.phrase] }));
      const allTopics = [...derived.topics];
      ourTopTopics.forEach((t) => {
        if (!allTopics.some((x) => x.topic === t.topic)) allTopics.push(t);
      });

      matrix = gapAnalysis.topicMatrix(allTopics, [
        { key: 'ours', label: brand.name || 'Our brand', pages: ourCrawl.pages },
        ...theirs.map((t) => ({ key: t.domain, label: t.label || t.domain, pages: t.pages || [] })),
      ], { limit: 40 });
      matrix.noiseRemoved = derived.suppressed;
      matrix.collapsedDuplicates = derived.collapsed;
    }

    // ==================================================== KEYWORD GAP
    //
    // The candidate keywords are the ones this brand ALREADY has demand
    // evidence for from Search Console, plus the cleaned topic gaps. Using our
    // own measured queries first means the table's rows are keywords that
    // matter to this brand rather than every phrase a competitor happens to use.
    let kwGap = null;
    if (includeKeywordGap) {
      const candidates = [];
      const seenKw = new Set();
      const pushKw = (k) => {
        const t = String(k || '').toLowerCase().trim();
        if (!t || t.length < 4 || seenKw.has(t)) return;
        if (boilerplate.isGenericUi(t)) return;
        seenKw.add(t);
        candidates.push(t);
      };
      const brandTermSet = seoSignals.brandTerms(brand || {});
      ourQueries
        .filter((q) => !seoSignals.isBrandedQuery(q.query, brandTermSet))
        .slice(0, 60)
        .forEach((q) => pushKw(q.query));
      topicGaps.slice(0, 20).forEach((t) => pushKw(t.phrase));
      entityGaps.slice(0, 10).forEach((e) => pushKw(e.surface));

      kwGap = await gapAnalysis.keywordGap(candidates, [
        { key: 'ours', label: brand.name || 'Our brand', domain: hostKey(site), ours: true },
        ...theirs.map((t) => ({ key: t.domain, label: t.label || t.domain, domain: t.domain })),
      ], { market: market.code, limit: keywordGapLimit });
      if (kwGap.ok) sources.push('serp-lite');
    }

    // =================================================== BACKLINK GAP
    let blGap = null;
    if (includeBacklinkGap) {
      // The referring-domain samples for every site were already gathered
      // above, so the gap table is assembled from those rather than re-fetching
      // — except where a link-index credential exists, in which case
      // backlinkGap() uses it and ignores the samples entirely.
      if (providers.has('moz')) {
        blGap = await gapAnalysis.backlinkGap(site, theirs.map((t) => t.domain), { sampleLimit: backlinkSampleLimit });
        sources.push('moz');
      } else {
        const rows = [
          { domain: hostKey(site), ours: true, sample: ourReferring },
          ...theirs.map((t) => ({ domain: t.domain, ours: false, sample: t.referring })),
        ].map((r) => ({
          domain: r.domain,
          ours: r.ours,
          source: r.sample && r.sample.ok ? 'verified-sample' : 'unavailable',
          domainAuthority: null,
          referringDomains: r.sample && r.sample.ok ? r.sample.referringDomains.length : null,
          backlinks: r.sample && r.sample.ok ? r.sample.linked.length : null,
          followedDomains: r.sample && r.sample.ok ? r.sample.followedDomains : null,
          mentionsWithoutLink: r.sample && r.sample.ok ? r.sample.mentions.length : null,
          irrelevantCandidates: r.sample && r.sample.ok ? (r.sample.irrelevant || []).length : null,
          candidateQuality: r.sample && r.sample.ok ? r.sample.candidateQuality : null,
          unverifiedCandidates: r.sample && r.sample.ok ? r.sample.unverified.length : null,
          isSample: true,
          basis: r.sample && r.sample.ok ? r.sample.basis : `no data: ${(r.sample && r.sample.error) || 'not attempted'}`,
          sampleDetail: r.sample && r.sample.ok ? { referringDomains: r.sample.referringDomains.slice(0, 25) } : null,
        }));

        const oursRow = rows.find((r) => r.ours);
        const ourSet = new Set(((oursRow && oursRow.sampleDetail) ? oursRow.sampleDetail.referringDomains : []).map((d) => d.domain));
        const gapDomains = [];
        rows.filter((r) => !r.ours).forEach((r) => {
          if (!r.sampleDetail) return;
          r.sampleDetail.referringDomains.forEach((d) => {
            if (ourSet.has(d.domain)) return;
            const existing = gapDomains.find((g) => g.domain === d.domain);
            if (existing) { existing.linksTo.push(r.domain); return; }
            gapDomains.push({ domain: d.domain, linksTo: [r.domain], sample: d.sample, anchors: d.anchors, followed: d.followed });
          });
        });
        gapDomains.sort((a, b) => b.linksTo.length - a.linksTo.length);

        blGap = {
          rows,
          ours: oursRow,
          ahead: rows.filter((r) => !r.ours && r.referringDomains != null && oursRow
            && oursRow.referringDomains != null && r.referringDomains > oursRow.referringDomains),
          gapDomains: gapDomains.slice(0, 60),
          errors: [],
          mixedMethods: false,
          method: 'verified-sample',
          caveat: `No link-index credential is configured, so each row is a VERIFIED SAMPLE: candidate pages found by a keyless web search were fetched and their outbound links read, and a domain counts only where a real link to the target was found. Capped at ${backlinkSampleLimit * 2} candidates per site, so every count is a FLOOR rather than a total — comparable between sites because the same cap applies to all of them, and not comparable to an Ahrefs or Semrush figure.`,
        };
      }
    }

    let ai = null;
    if (wantAi && (entityGaps.length || topicGaps.length)) {
      ai = await aiCalls.competitiveGaps({
        brandId, brand,
        ourTopics: ourProfile.phrases.map((p) => p.phrase),
        theirTopics: [...topicGaps.map((t) => t.phrase), ...entityGaps.map((e) => e.surface)],
        competitors: theirs.map((t) => ({ domain: t.domain, pages: t.inventory.sitemapUrls, sections: t.inventory.sections.slice(0, 6) })),
        anchorPatterns: theirs.flatMap((t) => t.anchors.slice(0, 8).map((a) => `${t.domain}: "${a.anchor}" ×${a.count}`)),
        force,
      });
      if (ai.ok) sources.push('azure');
    }

    // ------------------------------------------------------------ findings
    const findings = [];

    if (entityGaps.length >= 8) {
      findings.push({
        checkKey: 'entity_gap',
        title: `${entityGaps.length} subjects at least half the competitors cover and this site does not`,
        detail: entityGaps.slice(0, 14).map((e) => `${e.surface} (${e.competitors} of ${theirs.length})`).join('; ') + '.'
          + (noiseRemoved.total
            ? ` ${noiseRemoved.total} further candidate${noiseRemoved.total === 1 ? ' was' : 's were'} suppressed rather than reported (${noiseRemoved.summary.join(', ')}) — a competitor's own brand name and a generic button or section label are not subjects to write about.`
            : ''),
        severity: 'high',
        affectedCount: entityGaps.length,
        action: 'Treat each as a question about the offering, not a keyword to add: is this standard, product, body or concept genuinely part of what this brand does? Build pages for the ones that are.',
        evidence: {
          gaps: entityGaps.slice(0, 40),
          threshold: `${gapThreshold} of ${theirs.length} competitors`,
          noiseRemoved,
        },
        dedupeKey: `competitive:entitygap:${brandId}`,
      });
    }

    if (sectionGaps.length) {
      findings.push({
        checkKey: 'section_gap',
        title: `${sectionGaps.length} site section${sectionGaps.length === 1 ? '' : 's'} competitors maintain and this site does not`,
        detail: sectionGaps.slice(0, 8).map((g) => `/${g.section} (${g.competitors.map((c) => `${c.domain}: ${c.pages} pages`).join(', ')})`).join('; ') + '.',
        severity: 'medium',
        affectedCount: sectionGaps.length,
        action: 'A section a competitor maintains at scale is a structural bet, not a content idea. Decide deliberately whether to match it — matching a 400-page glossary badly is worse than not having one.',
        evidence: { sections: sectionGaps.slice(0, 20) },
        dedupeKey: `competitive:sectiongap:${brandId}`,
      });
    }

    if (corroborated.length) {
      findings.push({
        checkKey: 'corroborated_gap',
        title: `${corroborated.length} queries with existing demand where competitors publish and this site ranks past position 10`,
        detail: corroborated.slice(0, 8).map((q) => `"${q.query}" (${Math.round(q.impressions).toLocaleString('en-US')} impr, position ${Number(q.position).toFixed(1)})`).join('; ') + '.',
        severity: 'high',
        affectedCount: corroborated.length,
        action: 'These are the best-evidenced opportunities in this report: Search Console proves the demand on this exact property, and the competitor crawl proves the subject is being covered by others.',
        evidence: { queries: corroborated },
        dedupeKey: `competitive:corroborated:${brandId}`,
      });
    }

    // ------------------------------------------- topic coverage matrix
    if (matrix && matrix.rows.length) {
      const behind = matrix.rows.filter((r) => r.deficit != null && r.deficit > 0);
      const universal = matrix.rows.filter((r) => r.universalGap);
      const ahead = matrix.rows.filter((r) => r.deficit != null && r.deficit < 0);
      if (behind.length) {
        findings.push({
          checkKey: 'topic_coverage_matrix',
          title: `Behind the strongest competitor on ${behind.length} of ${matrix.rows.length} topics`,
          detail: `${universal.length ? `${universal.length} topic${universal.length === 1 ? ' is' : 's are'} covered by EVERY competitor and not at all here: ${universal.slice(0, 6).map((r) => r.topic).join(', ')}. ` : ''}`
            + `Largest deficits: ${behind.slice(0, 6).map((r) => `${r.topic} (${r.bestRival} ${r.bestRivalScore} vs ${r.ourScore} here)`).join('; ')}. `
            + `${ahead.length ? `${ahead.length} topic${ahead.length === 1 ? '' : 's'} where this site leads. ` : ''}`
            + `Coverage formula: ${matrix.formula}`,
          severity: universal.length ? 'high' : 'medium',
          affectedCount: behind.length,
          action: 'Work the matrix top-down: a topic every competitor covers and this site does not is a structural absence, and it is a different decision from a topic where the gap is depth. The "pages about" count per cell says which of the two you are looking at.',
          evidence: {
            columns: matrix.columns,
            rows: matrix.rows.slice(0, 40),
            formula: matrix.formula,
            caveat: matrix.caveat,
            sites: matrix.sites,
          },
          dedupeKey: `competitive:topicmatrix:${brandId}`,
        });
      }
    }

    // -------------------------------------------------- keyword gap
    if (kwGap && kwGap.ok) {
      const absent = kwGap.rows.filter((r) => r.state === 'absent-they-rank');
      const behindOnKw = kwGap.rows.filter((r) => r.state === 'behind');
      if (absent.length || behindOnKw.length) {
        findings.push({
          checkKey: 'keyword_gap',
          title: `${absent.length} keyword${absent.length === 1 ? ' where a competitor ranks' : 's where competitors rank'} and this site does not`
            + (behindOnKw.length ? `, plus ${behindOnKw.length} where it ranks below them` : ''),
          detail: `${absent.slice(0, 8).map((r) => `"${r.keyword}" (${r.bestRival} at #${r.bestRivalPosition})`).join('; ')}. `
            + `${behindOnKw.length ? `Behind on: ${behindOnKw.slice(0, 6).map((r) => `"${r.keyword}" (#${r.ourPosition} vs ${r.bestRival} #${r.bestRivalPosition})`).join('; ')}. ` : ''}`
            + kwGap.caveat,
          severity: absent.length >= 5 ? 'high' : 'medium',
          affectedCount: absent.length + behindOnKw.length,
          action: 'Open the competitor URL shown against each row before deciding anything. The useful question is not "do they rank" but "what does their page do that ours does not" — and for a keyword where nobody ranks well, the answer is usually that the intent is served by a different page type entirely.',
          evidence: {
            columns: kwGap.columns,
            rows: kwGap.rows,
            counts: kwGap.counts,
            market: kwGap.market,
            engine: kwGap.engine,
            caveat: kwGap.caveat,
            cappedAt: kwGap.cappedAt,
            errors: kwGap.errors,
          },
          dedupeKey: `competitive:keywordgap:${brandId}`,
        });
      }
    } else if (kwGap && !kwGap.ok) {
      findings.push({
        checkKey: 'keyword_gap_unavailable',
        title: 'The keyword gap could not be measured',
        detail: kwGap.reason,
        severity: 'info',
        action: 'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD for live Google positions, or leave keyless SERP sampling enabled for the non-Google comparison.',
        dedupeKey: `competitive:keywordgapunavailable:${brandId}`,
      });
    }

    // ------------------------------------------------- backlink gap
    if (blGap && blGap.rows.length) {
      const oursRow = blGap.ours;
      if (blGap.ahead.length) {
        findings.push({
          checkKey: 'backlink_gap',
          title: `${blGap.ahead.length} competitor${blGap.ahead.length === 1 ? ' has' : 's have'} more referring domains than this site`,
          detail: `${oursRow && oursRow.referringDomains != null ? `${oursRow.referringDomains} here` : 'unknown here'} against ${blGap.ahead.map((t) => `${t.domain}: ${t.referringDomains}`).join(', ')}. `
            + `${blGap.gapDomains.length ? `${blGap.gapDomains.length} domain${blGap.gapDomains.length === 1 ? '' : 's'} link to a competitor and not to this site, ${blGap.gapDomains.filter((g) => g.linksTo.length > 1).length} of them to more than one: ${blGap.gapDomains.slice(0, 8).map((g) => `${g.domain} (→ ${g.linksTo.join(', ')})`).join('; ')}. ` : ''}`
            + blGap.caveat,
          severity: 'medium',
          affectedCount: blGap.gapDomains.length || blGap.ahead.length,
          action: 'The domains linking to several competitors and not to this site are the shortlist: a directory, a supplier page, an association member list or a review site that has the whole category except this brand. Those are the reachable ones. Chasing a one-off editorial link is not.',
          evidence: {
            rows: blGap.rows.map((r) => ({ ...r, sampleDetail: r.sampleDetail ? { referringDomains: (r.sampleDetail.referringDomains || []).slice(0, 15) } : null })),
            gapDomains: blGap.gapDomains.slice(0, 40),
            method: blGap.method,
            caveat: blGap.caveat,
          },
          dedupeKey: `competitive:backlinkgap:${brandId}`,
        });
      }

      // The verified/mention split is worth its own line, because it is the
      // number that was previously wrong.
      const mentionsOnly = blGap.rows.reduce((a, r) => a + (r.mentionsWithoutLink || 0), 0);
      if (mentionsOnly) {
        findings.push({
          checkKey: 'mentions_without_links',
          title: `${mentionsOnly} page${mentionsOnly === 1 ? '' : 's'} name a domain in this comparison without linking to it`,
          detail: `Every candidate page found by search was fetched and its outbound links read. ${mentionsOnly} of them mention the domain in their text and carry no link to it. Those are unlinked mentions, not backlinks — and the previous version of this report counted them as referring domains, which is why the figures moved.`,
          severity: 'low',
          affectedCount: mentionsOnly,
          action: 'Unlinked mentions of THIS brand are the easiest links available: the publisher already decided to write about you. Ask.',
          evidence: { rows: blGap.rows.map((r) => ({ domain: r.domain, ours: r.ours, mentionsWithoutLink: r.mentionsWithoutLink, referringDomains: r.referringDomains })) },
          dedupeKey: `competitive:mentionsonly:${brandId}`,
        });
      }
    }

    // Readiness comparison — labelled as what it is.
    const behindOn = theirs.filter((t) => (t.posture.homeCitability || 0) > (ourPosture.homeCitability || 0) + 10);
    if (behindOn.length) {
      findings.push({
        checkKey: 'citability_behind',
        title: `${behindOn.length} competitor${behindOn.length === 1 ? '' : 's'} score higher on AI-citability than this site`,
        detail: `${behindOn.map((t) => `${t.domain}: ${t.posture.homeCitability}`).join(', ')} versus ${ourPosture.homeCitability} here. This is a structural readiness comparison — self-contained passages, structured blocks, visible dates, valid schema — not a measurement of actual AI citations, which needs a citation-tracking credential this deployment does not have.`,
        severity: 'medium',
        affectedCount: behindOn.length,
        action: 'Run the on-page scorer on this site\'s key pages and act on the citability findings. The structural fixes are cheap and the gap closes quickly.',
        evidence: { ours: ourPosture, theirs: behindOn.map((t) => ({ domain: t.domain, posture: t.posture })) },
        dedupeKey: `competitive:citability:${brandId}`,
      });
    }

    const schemaAhead = theirs.filter((t) => t.profile.schemaCoverage > ourProfile.schemaCoverage + 20);
    if (schemaAhead.length) {
      findings.push({
        checkKey: 'schema_behind',
        title: `Structured-data coverage is behind ${schemaAhead.length} competitor${schemaAhead.length === 1 ? '' : 's'}`,
        detail: `${ourProfile.schemaCoverage}% of sampled pages here carry schema, against ${schemaAhead.map((t) => `${t.domain} ${t.profile.schemaCoverage}%`).join(', ')}. Their types: ${[...new Set(schemaAhead.flatMap((t) => t.profile.schemaTypes.map((s) => s.type)))].slice(0, 10).join(', ')}.`,
        severity: 'medium',
        action: 'Match the types that fit this site. Structured data is one of the few competitive gaps that can be closed in days rather than quarters.',
        evidence: { ours: ourProfile.schemaCoverage, theirs: schemaAhead.map((t) => ({ domain: t.domain, coverage: t.profile.schemaCoverage, types: t.profile.schemaTypes })) },
        dedupeKey: `competitive:schema:${brandId}`,
      });
    }

    // Prefer the observed, diffed-history velocity over the single-snapshot
    // lastmod inference wherever this app has run against the site before;
    // fall back to the lastmod estimate only where there is no history yet.
    const velocityFor = (t) => (t.velocityHistory.usable
      ? { perMonth: t.velocityHistory.perMonth, source: 'observed' }
      : (t.velocity.usable ? { perMonth: t.velocity.perMonth, source: 'lastmod-estimate' } : null));
    const ourVel = ourVelocityHistory.usable
      ? { perMonth: ourVelocityHistory.perMonth, source: 'observed' }
      : (ourVelocity.usable ? { perMonth: ourVelocity.perMonth, source: 'lastmod-estimate' } : null);

    const velocityAhead = theirs
      .map((t) => ({ t, v: velocityFor(t) }))
      .filter(({ v }) => v && ourVel && v.perMonth > ourVel.perMonth * 2);
    if (velocityAhead.length) {
      findings.push({
        checkKey: 'velocity_behind',
        title: `${velocityAhead.length} competitor${velocityAhead.length === 1 ? ' publishes' : 's publish'} at more than twice this site's rate`,
        detail: `${velocityAhead.map(({ t, v }) => `${t.domain}: ~${v.perMonth}/month (${v.source === 'observed' ? 'observed over repeated runs' : 'estimated from sitemap lastmod'})`).join(', ')} against ~${ourVel.perMonth}/month here (${ourVel.source === 'observed' ? 'observed' : 'estimated'}).`,
        severity: 'low',
        action: 'Velocity is only worth matching where it is producing pages that rank. Check a sample of their recent URLs before committing to a cadence.',
        evidence: {
          ours: { legacy: ourVelocity, history: ourVelocityHistory },
          theirs: velocityAhead.map(({ t }) => ({ domain: t.domain, legacy: t.velocity, history: t.velocityHistory })),
        },
        dedupeKey: `competitive:velocity:${brandId}`,
      });
    }

    const baselineSites = [
      ...(ourVelocityHistory.baseline ? ['this site'] : []),
      ...theirs.filter((t) => t.velocityHistory.baseline).map((t) => t.domain),
    ];
    if (baselineSites.length) {
      findings.push({
        checkKey: 'velocity_baseline',
        title: 'Publishing-rate tracking is starting from scratch for at least one site in this run',
        detail: `${baselineSites.join(', ')} — no prior sitemap snapshot exists for ${baselineSites.length === 1 ? 'it' : 'them'} yet, so this run recorded the starting inventory rather than a rate. A genuine observed publishing rate will appear once competitive analysis is run again after some time has passed.`,
        severity: 'info',
        action: 'Re-run competitive analysis periodically (e.g. monthly) — each run after the first sharpens the observed velocity figures for every site tracked.',
        evidence: { ours: ourVelocityHistory, theirs: theirs.map((t) => ({ domain: t.domain, history: t.velocityHistory })) },
        dedupeKey: `competitive:velocitybaseline:${brandId}`,
      });
    }

    // Referring-page proxy, free and keyless: not a verified backlink index,
    // but a same-day sample of who mentions each domain that neither Semrush
    // nor Ahrefs is needed to see.
    const referringAhead = theirs.filter((t) => t.referring && t.referring.ok
      && ourReferring.ok
      && t.referring.referringDomains.length > ourReferring.referringDomains.length + 2);
    if (referringAhead.length) {
      findings.push({
        checkKey: 'referring_pages_behind',
        title: `${referringAhead.length} competitor${referringAhead.length === 1 ? '' : 's'} have more verified referring domains in this sample than this site`,
        detail: `${ourReferring.referringDomains.length} VERIFIED referring domain(s) found for this site versus ${referringAhead.map((t) => `${t.domain}: ${t.referring.referringDomains.length}`).join(', ')}. Each candidate page was fetched and its outbound links read, so every domain counted carries a real link — but the candidate list comes from a capped keyless web search, so these are floors, not totals. Not a substitute for a link index.`,
        severity: 'low',
        action: 'Open the referring pages listed for the ahead competitor(s) and see what they are being mentioned for — a directory listing, a review, a guest post — then judge whether the same opportunity exists for this brand.',
        evidence: {
          ours: { domain: hostKey(site), referringDomains: ourReferring.referringDomains },
          theirs: referringAhead.map((t) => ({ domain: t.domain, referringDomains: t.referring.referringDomains })),
        },
        dedupeKey: `competitive:referring:${brandId}`,
      });
    }

    // The unanswerable questions, stated plainly as a finding so they appear in
    // the report rather than only as a footnote.
    const missingProviders = providers.missing().filter((p) => ['backlinks', 'keyword-tool', 'rank-tracker'].includes(p.kind));
    if (missingProviders.length) {
      findings.push({
        checkKey: 'data_limits',
        title: `${missingProviders.length} competitive question${missingProviders.length === 1 ? '' : 's'} cannot be answered with the credentials configured`,
        detail: `Not measured: organic traffic estimates, and which pages AI assistants actually cite. `
          + `Measured but SAMPLED rather than complete: referring domains (a verified sample — every counted domain carries a real link, but the candidate list is a capped web search, so counts are floors) and keyword positions (${kwGap && kwGap.ok ? `read from a ${kwGap.engine} result page, not from Google` : 'not read'}). `
          + `Adding a credential for ${missingProviders.map((p) => p.label).join(', ')} would replace the samples with complete counts and the non-Google positions with live Google SERPs. Everything else here is measured from a live fetch of the sites named.`,
        severity: 'info',
        action: missingProviders.map((p) => p.note).filter(Boolean).join(' '),
        evidence: { providers: missingProviders.map((p) => ({ key: p.key, label: p.label, provides: p.provides })) },
        dedupeKey: `competitive:datalimits:${brandId}`,
      });
    }

    // Score: how this brand's measurable posture compares, averaged across the
    // dimensions that were actually measured. Deliberately not a "competitive
    // strength" number — it is a coverage-and-readiness comparison and is
    // labelled as such in the UI.
    const dims = [];
    if (theirs.length) {
      const avg = (fn) => theirs.reduce((a, t) => a + (fn(t) || 0), 0) / theirs.length;
      dims.push({ key: 'schema', ours: ourProfile.schemaCoverage, theirs: Math.round(avg((t) => t.profile.schemaCoverage)) });
      dims.push({ key: 'citability', ours: ourPosture.homeCitability || 0, theirs: Math.round(avg((t) => t.posture.homeCitability)) });
      dims.push({ key: 'author_signals', ours: ourProfile.authorCoverage, theirs: Math.round(avg((t) => t.profile.authorCoverage)) });
      dims.push({ key: 'avg_words', ours: ourProfile.avgWords, theirs: Math.round(avg((t) => t.profile.avgWords)) });
      dims.push({ key: 'retrieval_access', ours: ourPosture.retrievalAgentsAllowed, theirs: Math.round(avg((t) => t.posture.retrievalAgentsAllowed)) });
    }
    const wins = dims.filter((d) => d.ours >= d.theirs).length;
    const score = dims.length ? Math.round((wins / dims.length) * 100) : null;

    // The crawled pages were kept on each competitor record so the topic matrix
    // could score them. They must not reach the stored payload: every page
    // carries a live cheerio document and the full page text, which would be
    // megabytes of JSON per run and would be serialised on every result-page
    // render. Stripped here, once, at the boundary.
    const theirsForStorage = theirs.map((t) => {
      const { pages: _pages, ...rest } = t;
      return {
        ...rest,
        profile: t.profile ? {
          ...t.profile,
          // The template block Set is not JSON-serialisable and is only needed
          // during the run.
          template: t.profile.template && t.profile.template.usable !== false
            ? { examples: t.profile.template.examples, threshold: t.profile.template.threshold, basis: t.profile.template.basis }
            : t.profile.template,
        } : t.profile,
        referring: t.referring && t.referring.ok ? {
          ok: true,
          method: t.referring.method,
          basis: t.referring.basis,
          referringDomains: t.referring.referringDomains.slice(0, 25),
          linkedPages: t.referring.linked.slice(0, 20).map((x) => ({ url: x.url, host: x.host, title: x.title, followed: x.followed, links: x.links })),
          mentionsWithoutLink: t.referring.mentions.length,
          irrelevantCandidates: (t.referring.irrelevant || []).length,
          candidateQuality: t.referring.candidateQuality,
          unverified: t.referring.unverified.length,
          candidates: t.referring.candidates,
        } : t.referring,
      };
    });

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site,
        market: { code: market.code, name: market.name },
        // ------------------------------------------------- the new tables
        topicMatrix: matrix,
        keywordGap: kwGap,
        backlinkGap: blGap ? {
          rows: blGap.rows.map((r) => ({ ...r, sampleDetail: r.sampleDetail ? { referringDomains: (r.sampleDetail.referringDomains || []).slice(0, 20) } : null })),
          ours: blGap.ours ? { ...blGap.ours, sampleDetail: undefined } : null,
          ahead: blGap.ahead.map((r) => ({ domain: r.domain, referringDomains: r.referringDomains })),
          gapDomains: blGap.gapDomains.slice(0, 60),
          method: blGap.method,
          caveat: blGap.caveat,
          errors: blGap.errors,
        } : null,
        // What the noise filter removed, so the cleaning is auditable.
        noiseRemoved,
        ours: {
          inventory: { sitemapUrls: ourSitemap.urls.length, sections: sectionProfile(ourSitemap.urls) },
          velocity: ourVelocity,
          velocityHistory: ourVelocityHistory,
          profile: ourProfile,
          posture: ourPosture,
          anchors: ourAnchors,
          referring: ourReferring && ourReferring.ok ? {
            ok: true,
            method: ourReferring.method,
            basis: ourReferring.basis,
            referringDomains: ourReferring.referringDomains.slice(0, 25),
            linkedPages: ourReferring.linked.slice(0, 20).map((x) => ({ url: x.url, host: x.host, title: x.title, followed: x.followed, links: x.links })),
            mentionsWithoutLink: ourReferring.mentions.length,
            irrelevantCandidates: (ourReferring.irrelevant || []).length,
            candidateQuality: ourReferring.candidateQuality,
            unverified: ourReferring.unverified.length,
            candidates: ourReferring.candidates,
          } : ourReferring,
          crawl: { fetched: ourCrawl.fetched, usable: ourCrawl.pages.filter((p) => p.ok).length },
        },
        competitors: theirsForStorage,
        gaps: {
          entities: entityGaps,
          topics: topicGaps,
          sections: sectionGaps,
          corroboratedQueries: corroborated,
          threshold: gapThreshold,
          // The counts before and after cleaning, so the effect of the filter
          // is a number on the page rather than a claim in a comment.
          beforeCleaning: { entities: entityGapsRaw.length, topics: topicGapsRaw.length },
          afterCleaning: { entities: entityGaps.length, topics: topicGaps.length },
        },
        comparison: dims,
        ai: ai ? { ok: ai.ok, cached: ai.cached, reason: ai.reason, error: ai.error, data: ai.ok ? ai.data : null } : null,
        notMeasured: missingProviders.map((p) => ({ label: p.label, provides: p.provides, note: p.note })),
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: [
        { key: 'competitive.entity_gaps', value: entityGaps.length, status: entityGaps.length > 20 ? 'warn' : 'good' },
        {
          key: 'competitive.topics_behind',
          value: matrix ? matrix.rows.filter((r) => r.deficit != null && r.deficit > 0).length : null,
          status: matrix ? (matrix.rows.some((r) => r.universalGap) ? 'fail' : 'warn') : 'unknown',
        },
        {
          key: 'competitive.keywords_they_rank_we_dont',
          value: kwGap && kwGap.ok ? kwGap.counts.absentTheyRank : null,
          status: kwGap && kwGap.ok ? (kwGap.counts.absentTheyRank ? 'warn' : 'good') : 'unknown',
        },
        {
          key: 'competitive.referring_domains_verified',
          value: blGap && blGap.ours ? blGap.ours.referringDomains : null,
          status: 'good',
        },
        {
          key: 'competitive.backlink_gap_domains',
          value: blGap ? blGap.gapDomains.length : null,
          status: blGap && blGap.gapDomains.length ? 'warn' : 'good',
        },
        { key: 'competitive.our_schema_coverage', value: ourProfile.schemaCoverage, status: 'good' },
        { key: 'competitive.our_citability', value: ourPosture.homeCitability, status: 'good' },
      ],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:competitive:${run.id}:${f.check_key}`,
      category: 'Competitive intelligence',
      severity: f.severity,
      evidence: f.evidence,
      dedupeKey: `aiseo:competitive:${f.check_key}:${run.brand_id || 0}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, list, add, remove,
  velocityFromSitemap, sectionProfile, anchorPatterns, topicProfile, retrievalPosture,
  // Re-exported so the verification suite can exercise the new tables without
  // reaching past this module into ./gapAnalysis.js.
  topicMatrix: gapAnalysis.topicMatrix,
  keywordGap: gapAnalysis.keywordGap,
  backlinkGap: gapAnalysis.backlinkGap,
  verifyReferring: gapAnalysis.verifyReferring,
};
