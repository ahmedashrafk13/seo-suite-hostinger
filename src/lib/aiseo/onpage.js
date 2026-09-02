// 2. ON-PAGE OPTIMISATION AND REAL-TIME SCORING
//
// Scores a page — live URL or pasted draft — against the pages it actually
// competes with, on the four things that decide whether it ranks AND whether
// an AI answer engine can quote it:
//
//   semantic coverage   does it discuss what the competing pages discuss?
//   readability         can the intended reader follow it?
//   entity density      is it about specific, nameable things?
//   citability          can a retrieval system lift a passage and attribute it?
//
// HOW THE COMPETITOR SET IS OBTAINED, AND WHY IT IS HONEST
// A "top-ranking pages" comparison needs a SERP. There is no SERP API
// credential in this deployment, and scraping Google's result page is both
// unreliable and against its terms — a comparison built on a blocked or
// captcha'd scrape silently degrades to comparing against nothing, which is
// worse than not offering the feature.
//
// So the competitor set comes from three sources, in this order, and the page
// always states which one it used:
//   1. URLs the user pastes. Exact, and the practitioner usually knows them.
//   2. The best-matching page on each named competitor domain, found by
//      reading that domain's own sitemap and scoring its URLs and titles
//      against the target keyword. This is a real retrieval step against real
//      pages, not a guess about rankings.
//   3. When DataForSEO or Semrush credentials exist, their SERP endpoint.
//      Wired as an adapter (see ./providers.js) and used automatically when
//      present.
//
// The score is never presented as "you will rank" — it is presented as
// coverage relative to the named comparison set, which is what it measures.
const db = require('../../db');
const nlp = require('./nlp');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const analytics = require('../analytics');
const boilerplate = require('./boilerplate');
const headingsLib = require('./headings');
const pageTypeLib = require('./pageType');
const {
  fetchPage, parseDocument, fetchSitemapUrls, fetchRobots, normalizeUrl, mapLimit,
} = require('./fetcher');

// ------------------------------------------------- competitor page discovery

// Scores a candidate URL from a competitor's sitemap for how likely it is to
// be THE page competing for the target keyword.
//
// Slug and title matching, weighted toward the slug: a URL containing the
// keyword's content words is a much stronger signal of a page's subject than a
// title that happens to mention them in passing.
function candidateScore(candidateUrl, keyword) {
  const target = new Set(nlp.contentWords(keyword).map(nlp.stem));
  if (!target.size) return 0;
  let path = '';
  try { path = new URL(candidateUrl).pathname; } catch { path = String(candidateUrl); }
  const slugWords = new Set(nlp.contentWords(path.replace(/[/_-]+/g, ' ')).map(nlp.stem));
  let hits = 0;
  target.forEach((t) => { if (slugWords.has(t)) hits += 1; });
  const coverage = hits / target.size;
  // A short, focused path beats a deep one carrying the same words: /pricing
  // is more likely the pricing page than /blog/2019/notes-on-pricing-models.
  const depthPenalty = Math.min(0.3, Math.max(0, (path.split('/').filter(Boolean).length - 2) * 0.06));
  return Math.max(0, coverage - depthPenalty);
}

// Finds each competitor's most relevant page for the keyword.
async function discoverCompetitorPages(brandId, keyword, { limit = 4, perDomain = 1 } = {}) {
  const domains = db.prepare('SELECT domain, label FROM competitors WHERE brand_id=? AND active=1 ORDER BY id')
    .all(brandId).slice(0, 6);
  if (!domains.length) return { pages: [], method: 'none', domains: [] };

  const found = [];
  for (const d of domains) {
    if (found.length >= limit) break;
    const site = normalizeUrl(d.domain);
    // eslint-disable-next-line no-await-in-loop
    const robots = await fetchRobots(site);
    // eslint-disable-next-line no-await-in-loop
    const sitemap = await fetchSitemapUrls(site, { limit: 1200, robots });
    if (!sitemap.urls.length) continue;
    const ranked = sitemap.urls
      .map((u) => ({ url: u.loc, lastmod: u.lastmod, score: candidateScore(u.loc, keyword) }))
      .filter((u) => u.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, perDomain);
    ranked.forEach((r) => found.push({ ...r, domain: d.domain, label: d.label || d.domain, via: 'sitemap-match' }));
  }

  return {
    pages: found.slice(0, limit),
    method: found.length ? 'competitor-sitemap-match' : 'none',
    domains: domains.map((d) => d.domain),
  };
}

// ------------------------------------------------------------------ scoring

// Semantic coverage: what share of the vocabulary the comparison set agrees on
// does this page also carry?
//
// The key design decision is "agrees on". Comparing against the UNION of
// competitor terms punishes a page for every idiosyncratic word any one
// competitor happens to use. Comparing against terms that appear on at least
// half of them isolates the shared subject matter — the things a page about
// this topic is expected to discuss — and that is a gap worth reporting.
function semanticCoverage(doc, competitorDocs, {
  ourText = null, theirTexts = null, noiseOpts = null,
} = {}) {
  if (!competitorDocs.length) {
    return { pct: null, consensusTerms: [], missing: [], covered: [], basis: 'no comparison set' };
  }
  // Boilerplate-stripped text where the caller supplied it. Without this, the
  // "consensus vocabulary" of four competitor pages is dominated by the words
  // every one of their templates repeats — their nav labels, their footer, the
  // words "privacy policy" — and the page under review is then marked down for
  // not carrying a competitor's navigation.
  const theirs = (theirTexts && theirTexts.length === competitorDocs.length)
    ? theirTexts
    : competitorDocs.map((d) => d.mainText || '');
  const mineText = ourText != null ? ourText : (doc.mainText || '');
  const perDoc = theirs.map((t) => new Set([...nlp.termFrequency(t).keys()]));
  const counts = new Map();
  perDoc.forEach((set) => set.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));

  const threshold = Math.max(2, Math.ceil(competitorDocs.length / 2));
  const consensus = [...counts.entries()]
    .filter(([, c]) => c >= threshold)
    .map(([term, c]) => ({ term, documents: c }))
    .sort((a, b) => b.documents - a.documents);

  const mine = new Set([...nlp.termFrequency(mineText).keys()]);
  const covered = consensus.filter((c) => mine.has(c.term));

  // Consensus terms this page lacks, with the noise filtered out. A "missing
  // term" that is a competitor's brand name or a generic button label is not a
  // content gap, and asking a writer to add it is the bug being fixed here.
  const missingRaw = consensus.filter((c) => !mine.has(c.term));
  const filteredMissing = noiseOpts
    ? boilerplate.filterPhrases(missingRaw.map((c) => ({ phrase: c.term, documents: c.documents })), noiseOpts)
    : { kept: missingRaw.map((c) => ({ phrase: c.term, documents: c.documents })), suppressed: [], suppressedCount: 0, summary: [] };
  const missing = filteredMissing.kept.map((c) => ({ term: c.phrase, documents: c.documents }));

  return {
    // The percentage is computed on the FILTERED denominator too: a page cannot
    // be scored against terms it is right not to have.
    pct: consensus.length
      ? Math.round((covered.length / Math.max(1, covered.length + missing.length)) * 100)
      : null,
    consensusTerms: consensus.slice(0, 120),
    covered: covered.slice(0, 80).map((c) => c.term),
    missing: missing.slice(0, 80).map((c) => c.term),
    missingDetail: missing.slice(0, 80),
    suppressed: filteredMissing.suppressed.slice(0, 40),
    suppressedCount: filteredMissing.suppressedCount,
    suppressedSummary: filteredMissing.summary,
    basis: `terms appearing on at least ${threshold} of ${competitorDocs.length} comparison pages`
      + (filteredMissing.suppressedCount
        ? `, with ${filteredMissing.suppressedCount} excluded as noise (${filteredMissing.summary.join(', ')})`
        : ''),
    cosineToSet: competitorDocs.length
      ? Math.round(nlp.cosine(nlp.termFrequency(mineText), nlp.termFrequency(theirs.join(' '))) * 100) / 100
      : null,
  };
}

// Entities the comparison set names and this page does not. Reported
// separately from vocabulary coverage because the two call for different
// edits: a missing term is usually a phrasing gap, a missing entity is usually
// a factual omission (a standard not cited, a body not named, a figure absent).
function entityGap(doc, competitorDocs, {
  ourText = null, theirTexts = null, noiseOpts = null,
} = {}) {
  const mineText = ourText != null ? ourText : (doc.mainText || '');
  const theirs2 = (theirTexts && theirTexts.length === competitorDocs.length)
    ? theirTexts : competitorDocs.map((d) => d.mainText || '');

  const mine = new Map(nlp.entities(mineText).map((e) => [e.surface.toLowerCase(), e]));
  const theirs = new Map();
  theirs2.forEach((t) => {
    nlp.entities(t).forEach((e) => {
      const key = e.surface.toLowerCase();
      const cur = theirs.get(key) || { surface: e.surface, type: e.type, documents: 0, count: 0 };
      cur.documents += 1;
      cur.count += e.count;
      theirs.set(key, cur);
    });
  });
  const threshold = competitorDocs.length >= 3 ? 2 : 1;
  const candidates = [...theirs.values()]
    .filter((e) => e.documents >= threshold && !mine.has(e.surface.toLowerCase()))
    .sort((a, b) => b.documents - a.documents || b.count - a.count);

  // THE FILTER THAT STOPS THE BAD RECOMMENDATIONS.
  //
  // A competitor's own brand name is, by construction, the entity most likely
  // to appear on their pages and not on ours — so before this filter the top of
  // every entity-gap list was the competitors' brands, and the report was
  // literally advising the client to write about their rivals. Generic button
  // and section labels ("Learn More", "Why Choose Us", "Office Headquarters")
  // came next for the same structural reason. See ./boilerplate.js.
  const filtered = noiseOpts
    ? boilerplate.filterEntities(candidates, noiseOpts)
    : { kept: candidates, suppressed: [], suppressedCount: 0, summary: [] };

  return {
    missing: filtered.kept.slice(0, 40),
    suppressed: filtered.suppressed.slice(0, 60),
    suppressedCount: filtered.suppressedCount,
    suppressedSummary: filtered.summary,
    candidatesBeforeFilter: candidates.length,
    mineCount: mine.size,
    theirsCount: theirs.size,
    threshold,
  };
}

// Headings the comparison set covers and this page does not — the fastest read
// on a structural content gap, and the one a writer can act on directly.
function headingGap(doc, competitorDocs) {
  const norm = (h) => nlp.contentWords(h).map(nlp.stem).join(' ');
  const mine = new Set(doc.headings.map((h) => norm(h.text)).filter(Boolean));
  const counts = new Map();
  competitorDocs.forEach((d) => {
    const seen = new Set();
    (d.headings || []).filter((h) => h.level >= 2 && h.level <= 3).forEach((h) => {
      const key = norm(h.text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const cur = counts.get(key) || { key, examples: [], documents: 0 };
      cur.documents += 1;
      if (cur.examples.length < 3) cur.examples.push(h.text);
      counts.set(key, cur);
    });
  });
  return [...counts.values()]
    .filter((c) => !mine.has(c.key) && c.documents >= Math.max(2, Math.ceil(competitorDocs.length / 2)))
    // A heading gap of "Why Choose Us" is not a content gap. Filtered on the
    // example text rather than the stemmed key, because that is what a reader
    // would be asked to add.
    .filter((c) => !(c.examples || []).every((ex) => boilerplate.isGenericUi(ex)))
    .sort((a, b) => b.documents - a.documents)
    .slice(0, 20);
}

// Keyword placement — the deterministic on-page basics, kept because they
// still matter and are the cheapest thing to get wrong.
function placement(doc, keyword) {
  const kwWords = nlp.contentWords(keyword).map(nlp.stem);
  const has = (text) => {
    if (!kwWords.length) return false;
    const set = new Set(nlp.contentWords(text || '').map(nlp.stem));
    return kwWords.every((w) => set.has(w));
  };
  const firstHundred = (doc.mainText || '').split(/\s+/).slice(0, 100).join(' ');
  return {
    inTitle: has(doc.title),
    inH1: (doc.h1s || []).some((h) => has(h)),
    inMetaDescription: has(doc.metaDesc),
    inUrl: has(String(doc.url || '').replace(/[/_-]+/g, ' ')),
    inFirstHundredWords: has(firstHundred),
    inSubheading: (doc.headings || []).filter((h) => h.level >= 2).some((h) => has(h.text)),
    exactMatchCount: keyword
      ? ((doc.mainText || '').toLowerCase().match(new RegExp(keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
      : 0,
  };
}

// The headline score.
//
// Weights and why: coverage and citability carry the most because they are the
// two the comparison set gives real evidence for; placement is cheap to fix and
// therefore worth little credit; readability is capped so a page cannot score
// well purely by being simple. When there is no comparison set, coverage is
// EXCLUDED and the weights renormalise — a score computed against nothing must
// not silently report 0% coverage as a failure.
function compositeScore({
  coverage, readability, entity, citabilityInfo, placementInfo,
  headingInfo = null, stuffingInfo = null,
}) {
  const parts = [];

  if (coverage.pct != null) {
    parts.push({ key: 'semantic_coverage', weight: 30, value: coverage.pct / 100, label: 'Semantic coverage vs comparison set' });
  }

  // Reading-ease target band rather than "higher is better": a compliance or
  // certification page scoring 80 has usually been stripped of the precision
  // its reader needs, and one scoring 20 is unreadable. 45-70 is the band
  // professional explanatory content lands in.
  let readScore = 0;
  if (readability.fleschReadingEase != null) {
    const e = readability.fleschReadingEase;
    if (e >= 45 && e <= 70) readScore = 1;
    else if (e > 70) readScore = Math.max(0.5, 1 - ((e - 70) / 60));
    else readScore = Math.max(0, e / 45);
    if (readability.longSentences > readability.sentences * 0.2) readScore *= 0.8;
  }
  parts.push({ key: 'readability', weight: 15, value: readScore, label: 'Readability (target band 45-70 reading ease)' });

  // Entity density target: roughly 1.5-6 distinct entities per 100 words.
  // Below that a page is generic; far above it, it is a list of names rather
  // than an explanation.
  const d = entity.density || 0;
  let entScore = 0;
  if (d >= 1.5 && d <= 6) entScore = 1;
  else if (d > 6) entScore = Math.max(0.4, 1 - ((d - 6) / 8));
  else entScore = d / 1.5;
  parts.push({ key: 'entity_density', weight: 20, value: Math.min(1, entScore), label: 'Entity density' });

  parts.push({ key: 'citability', weight: 25, value: citabilityInfo.score / 100, label: 'Citability (AI answer extractability)' });

  const placementHits = ['inTitle', 'inH1', 'inFirstHundredWords', 'inSubheading', 'inUrl']
    .filter((k) => placementInfo[k]).length;
  parts.push({ key: 'placement', weight: 10, value: placementHits / 5, label: 'Target-term placement' });

  // Heading structure. Weighted at 10 because it is cheap to fix and decides
  // whether a retrieval system can attribute a passage to a question at all —
  // the same reason citability carries weight.
  if (headingInfo) {
    parts.push({
      key: 'heading_structure',
      weight: 10,
      value: headingInfo.score / 100,
      label: 'Heading hierarchy (H1 present and singular, no skipped levels)',
    });
  }

  // Over-optimisation. A PENALTY rather than a scored dimension, because
  // "not stuffed" is the normal state and does not deserve credit — a page
  // should not be able to raise its score by having no keyword problems. The
  // deduction is applied after the weighted sum, and stated.
  let penalty = 0;
  const penaltyReasons = [];
  if (stuffingInfo && stuffingInfo.measurable) {
    stuffingInfo.issues.forEach((i) => {
      if (i.key === 'target_absent') return; // reported, but placement already covers it
      const cost = { high: 12, medium: 7, low: 3 }[i.severity] || 3;
      penalty += cost;
      penaltyReasons.push(`${i.key} (−${cost})`);
    });
    penalty = Math.min(25, penalty);
  }

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const earned = Math.round(parts.reduce((a, p) => a + (p.weight * Math.max(0, Math.min(1, p.value))), 0) / totalWeight * 100);
  const score = Math.max(0, earned - penalty);
  return {
    score,
    earnedBeforePenalty: earned,
    penalty,
    penaltyReasons,
    parts: parts.map((p) => ({
      ...p,
      earned: Math.round(p.weight * Math.max(0, Math.min(1, p.value)) * 10) / 10,
      pct: Math.round(Math.max(0, Math.min(1, p.value)) * 100),
    })),
    basis: (coverage.pct == null
      ? 'Scored without a comparison set: semantic coverage is excluded and the remaining weights are renormalised.'
      : 'Scored against the named comparison pages.')
      + (penalty
        ? ` ${earned} earned, less a ${penalty}-point over-optimisation deduction (${penaltyReasons.join(', ')}).`
        : ''),
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, url = null, draftHtml = null, keyword,
  competitorUrls = [], autoCompetitors = true, wantAiEdits = true, force = false,
}) {
  const brandId = brand ? brand.id : null;
  const target = url ? normalizeUrl(url) : `draft:${(keyword || 'untitled').slice(0, 60)}`;

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'onpage', target,
    label: keyword || null,
    params: { url, keyword, competitorUrls, autoCompetitors, hasDraft: Boolean(draftHtml) },
  });

  try {
    const sources = ['crawler'];

    // The page under review.
    let doc;
    let fetchInfo = null;
    if (draftHtml) {
      // A draft is scored exactly like a live page. Wrapping bare text in
      // markup would fake a structure the draft does not have and inflate the
      // citability score — so a draft with no HTML is parsed as-is and its
      // structural signals come out low, correctly.
      doc = parseDocument(url ? normalizeUrl(url) : 'draft://local', draftHtml);
    } else {
      if (!url) throw new Error('Give a URL to score, or paste a draft.');
      fetchInfo = await fetchPage(normalizeUrl(url), { timeout: 25000 });
      if (!fetchInfo.ok || !fetchInfo.body) {
        return store.finish(runRow.id, {
          score: null,
          result: {
            empty: true,
            reason: fetchInfo.error
              ? `Could not fetch the page: ${fetchInfo.error}`
              : `The page returned HTTP ${fetchInfo.status}, so there is nothing to score.`,
            fetch: { status: fetchInfo.status, error: fetchInfo.error, ms: fetchInfo.totalMs },
          },
          findings: [{
            checkKey: 'unfetchable',
            title: 'The page could not be fetched',
            detail: fetchInfo.error || `HTTP ${fetchInfo.status}`,
            severity: 'critical',
            affectedUrl: target,
            action: 'Confirm the URL is public and returns 200 to a normal browser user agent before scoring it.',
            dedupeKey: `onpage:unfetchable:${target}`,
          }],
          sources,
        });
      }
      doc = parseDocument(fetchInfo.url, fetchInfo.body);
    }

    // The comparison set.
    let comparison = { pages: [], method: 'none', domains: [] };
    const pasted = (competitorUrls || []).map((u) => String(u).trim()).filter(Boolean);
    if (pasted.length) {
      comparison = { pages: pasted.map((u) => ({ url: normalizeUrl(u), via: 'pasted' })), method: 'pasted', domains: [] };
    } else if (autoCompetitors && brandId) {
      comparison = await discoverCompetitorPages(brandId, keyword || doc.title || '', { limit: 4 });
    }

    const competitorDocs = [];
    const competitorFetches = [];
    if (comparison.pages.length) {
      const fetched = await mapLimit(comparison.pages, 3, async (p) => {
        const res = await fetchPage(p.url, { timeout: 20000 });
        return { p, res };
      });
      fetched.forEach((entry) => {
        if (!entry || entry.__error) return;
        const { p, res } = entry;
        if (!res.ok || !res.body) {
          competitorFetches.push({ url: p.url, ok: false, status: res.status, error: res.error, via: p.via });
          return;
        }
        const cdoc = parseDocument(res.url, res.body);
        competitorDocs.push(cdoc);
        competitorFetches.push({
          url: res.url, ok: true, status: res.status, via: p.via,
          title: cdoc.title, words: cdoc.wordCount, headings: cdoc.headings.length,
        });
      });
    }

    // ---------------------------------------------------------- clean text
    //
    // EVERY CONTENT MEASUREMENT BELOW RUNS ON BOILERPLATE-STRIPPED TEXT.
    //
    // Before this, readability, entity density, keyword density and semantic
    // coverage were computed over whatever fetcher.parseDocument chose as the
    // main region — and where no container held enough of the page's text, that
    // is <body>: the navigation, the cookie banner, the footer link farm and
    // the social row included. On a short page those are most of the words, so
    // every one of those numbers was measuring the template. See
    // ./boilerplate.js for exactly what is removed and how it reports itself.
    const clean = boilerplate.contentText(doc);
    const cleanText = clean.text;
    const cleanCompetitor = competitorDocs.map((d) => boilerplate.contentText(d));
    const theirCleanTexts = cleanCompetitor.map((c) => c.text);

    // Cross-page template detection, available because the comparison set is
    // several pages: any short string appearing on most of them is furniture.
    const templateBlocks = boilerplate.repeatedBlocks([doc, ...competitorDocs]);

    // What counts as noise for THIS run: the competitors' own brand names, the
    // generic UI vocabulary, and whatever repeats across the comparison set.
    const competitorMeta = comparison.pages.map((pp, i) => ({
      domain: (() => { try { return new URL(pp.url).hostname; } catch { return null; } })(),
      homeTitle: competitorDocs[i] ? competitorDocs[i].title : null,
    })).filter((c) => c.domain);
    const configuredCompetitors = brandId
      ? db.prepare('SELECT domain, label FROM competitors WHERE brand_id=? AND active=1').all(brandId)
      : [];
    const noiseOpts = {
      competitorTerms: boilerplate.competitorBrandTerms([...competitorMeta, ...configuredCompetitors]),
      // seoSignals.brandTerms returns { phrases, tokens, label }; the noise
      // filter wants one flat Set of lowercase strings to test membership
      // against. Our own brand appearing on a competitor page is worth knowing
      // about, but it is not a gap in our content.
      ownBrandTerms: (() => {
        const bt = require('../seoSignals').brandTerms(brand || {});
        return new Set([...(bt.phrases || []), ...(bt.tokens || [])]);
      })(),
      boilerplateBlocks: templateBlocks.usable ? templateBlocks.blocks : null,
    };

    // Measurements — all local, all deterministic.
    const coverage = semanticCoverage(doc, competitorDocs, {
      ourText: cleanText, theirTexts: theirCleanTexts, noiseOpts,
    });
    const readability = nlp.readability(cleanText);
    const entity = nlp.entityDensity(cleanText);
    const citabilityInfo = nlp.citability(doc);
    const placementInfo = placement(doc, keyword || '');
    const entities = entityGap(doc, competitorDocs, {
      ourText: cleanText, theirTexts: theirCleanTexts, noiseOpts,
    });
    const headings = headingGap(doc, competitorDocs);
    const phrases = nlp.keyPhrases(cleanText, { minCount: 2, limit: 30 });

    // The two new structural checks.
    const headingInfo = headingsLib.hierarchy(doc);
    const stuffingInfo = headingsLib.stuffing(cleanText, {
      keyword: keyword || '', headings: doc.headings,
    });

    // What kind of page this is. Reported rather than acted on here — the
    // schema feature is where it drives generation — because a practitioner
    // scoring a page wants to know whether the tool understood what it was
    // looking at.
    const classified = pageTypeLib.classify(doc, { brand });

    const composite = compositeScore({
      coverage, readability, entity, citabilityInfo, placementInfo,
      headingInfo, stuffingInfo,
    });

    // How this page actually performs, where Search Console knows. This is
    // what stops the score being an abstraction: a page scoring 45 that earns
    // 2,000 clicks does not need rewriting, and a page scoring 85 with zero
    // impressions has a different problem than its copy.
    let performance = null;
    if (brandId && url) {
      const anchor = analytics.latestGscDate(brandId);
      if (anchor) {
        const w = analytics.windowFrom(anchor, 28);
        const row = db.prepare(`SELECT SUM(clicks) clicks, SUM(impressions) impressions,
            SUM(position*impressions)/NULLIF(SUM(impressions),0) position
          FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ? AND page=?`)
          .get(brandId, w.startDate, w.endDate, normalizeUrl(url));
        if (row && row.impressions) {
          performance = {
            window: w, clicks: Number(row.clicks) || 0,
            impressions: Number(row.impressions) || 0,
            position: row.position == null ? null : Number(row.position),
          };
          sources.push('gsc');
        }
      }
    }

    // The AI half: concrete edits, anchored to the measured gaps.
    let aiEdits = null;
    if (wantAiEdits) {
      aiEdits = await aiCalls.onPageEdits({
        brandId,
        targetKeyword: keyword || doc.title || '',
        doc,
        gaps: {
          missingEntities: entities.missing.map((e) => e.surface),
          semanticCoveragePct: coverage.pct,
          missingHeadings: headings.map((h) => h.examples[0]),
          headingStructureIssues: headingInfo.issues.map((i) => i.message),
          overOptimisation: stuffingInfo.measurable
            ? stuffingInfo.issues.map((i) => i.message)
            : [],
        },
        citabilityInfo,
        competitorHeadings: competitorDocs.flatMap((d) => (d.headings || []).filter((h) => h.level === 2).map((h) => h.text)),
        force,
      });
      if (aiEdits.ok) sources.push('azure');
    }

    // ------------------------------------------------------------ findings
    const findings = [];

    if (coverage.pct != null && coverage.pct < 60) {
      findings.push({
        checkKey: 'semantic_coverage',
        title: `Semantic coverage is ${coverage.pct}% of what the comparison pages agree on`,
        detail: `${coverage.missing.length} consensus terms are absent. Most common: ${coverage.missing.slice(0, 15).join(', ')}. Basis: ${coverage.basis}.`,
        severity: coverage.pct < 40 ? 'high' : 'medium',
        affectedUrl: target,
        affectedCount: coverage.missing.length,
        action: 'Add substantive coverage of the missing subjects — not the words. Terms added without the underlying explanation raise this number and change nothing else.',
        evidence: { missing: coverage.missing.slice(0, 60), basis: coverage.basis, comparedWith: competitorFetches.filter((c) => c.ok).map((c) => c.url) },
        dedupeKey: `onpage:coverage:${target}`,
      });
    }

    // -------------------------------------------- heading hierarchy
    if (headingInfo.issues.length) {
      const worst = headingInfo.issues.reduce((acc, i) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return (rank[i.severity] ?? 2) < (rank[acc.severity] ?? 3) ? i : acc;
      }, headingInfo.issues[0]);
      findings.push({
        checkKey: 'heading_hierarchy',
        title: `Heading structure scores ${headingInfo.score}/100 — ${headingInfo.issues.length} issue${headingInfo.issues.length === 1 ? '' : 's'}`,
        detail: headingInfo.issues.map((i) => i.message).join(' '),
        severity: worst.severity,
        affectedUrl: target,
        affectedCount: headingInfo.issues.length,
        action: 'Fix the outline before rewriting any copy. A retrieval system chunks a page by its heading tree, so a skipped level or a second H1 changes which passage it believes answers which question — and the same defect fails WCAG 1.3.1 for screen-reader users.',
        evidence: {
          score: headingInfo.score,
          issues: headingInfo.issues,
          counts: headingInfo.counts,
          outline: headingInfo.outline.slice(0, 60),
        },
        dedupeKey: `onpage:headings:${target}`,
      });
    }

    // ------------------------------------------- keyword stuffing
    if (stuffingInfo.measurable && stuffingInfo.issues.filter((i) => i.key !== 'target_absent').length) {
      const real = stuffingInfo.issues.filter((i) => i.key !== 'target_absent');
      const worst = real.reduce((acc, i) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return (rank[i.severity] ?? 2) < (rank[acc.severity] ?? 3) ? i : acc;
      }, real[0]);
      findings.push({
        checkKey: 'over_optimisation',
        title: `${real.length} repetition problem${real.length === 1 ? '' : 's'} in the body content`
          + (stuffingInfo.target ? ` — target term at ${stuffingInfo.target.densityPct}% density` : ''),
        detail: `${real.map((i) => i.message).join(' ')} Measured over ${stuffingInfo.words} words of content AFTER the navigation, header, footer, social links and repeated pricing labels were excluded — so none of this is a template artefact.`,
        severity: worst.severity,
        affectedUrl: target,
        affectedCount: real.length,
        action: real.map((i) => i.action).filter(Boolean).join(' '),
        evidence: {
          target: stuffingInfo.target,
          overUsedPhrases: stuffingInfo.overUsedPhrases,
          duplicatedSentences: stuffingInfo.duplicatedSentences,
          thresholds: stuffingInfo.thresholds,
          contentWords: stuffingInfo.words,
        },
        dedupeKey: `onpage:stuffing:${target}`,
      });
    }

    // ----------------------------- boilerplate that could not be excluded
    if (clean.fellBack && clean.reason) {
      findings.push({
        checkKey: 'content_region_unclear',
        title: 'The page\'s content could not be separated from its template',
        detail: clean.reason,
        severity: 'info',
        affectedUrl: target,
        action: 'Wrap the page\'s own content in a <main> or <article> element. Every content metric on this report — readability, entity density, keyword density, semantic coverage — is currently measured over the navigation and footer as well, which moves all of them.',
        evidence: { clean: { fellBack: true, reason: clean.reason, strippedWords: clean.strippedWords }, mainSelector: doc.mainSelector, mainSelectorRejected: doc.mainSelectorRejected },
        dedupeKey: `onpage:contentregion:${target}`,
      });
    }

    if (entities.missing.length >= 5) {
      findings.push({
        checkKey: 'entity_gap',
        title: `${entities.missing.length} entities the comparison pages name and this page does not`,
        detail: entities.missing.slice(0, 12).map((e) => `${e.surface} (${e.documents} of ${competitorDocs.length} pages)`).join('; ')
          + (entities.suppressedCount
            ? `. ${entities.suppressedCount} further candidate${entities.suppressedCount === 1 ? ' was' : 's were'} excluded as noise rather than reported: ${entities.suppressedSummary.join(', ')} — competitor brand names and generic button or section labels are not content gaps.`
            : ''),
        severity: 'medium',
        affectedUrl: target,
        affectedCount: entities.missing.length,
        action: 'Treat each as a factual question: is this standard, body, figure or product genuinely relevant here? Add the ones that are, with a source. Ignore the rest.',
        evidence: {
          entities: entities.missing.slice(0, 40),
          // What was filtered out, and why. Shown because a suppressed list
          // nobody can inspect is a list nobody can trust.
          suppressed: entities.suppressed,
          suppressedCount: entities.suppressedCount,
          suppressedSummary: entities.suppressedSummary,
          candidatesBeforeFilter: entities.candidatesBeforeFilter,
        },
        dedupeKey: `onpage:entities:${target}`,
      });
    }

    if (citabilityInfo.score < 55) {
      const s = citabilityInfo.signals;
      const reasons = [];
      if (s.selfContainedShare < 70) reasons.push(`only ${s.selfContainedShare}% of paragraphs can stand alone (the rest open with "This", "It", "However" and lose their referent when extracted)`);
      if (!s.hasStructuredBlocks) reasons.push('no lists, tables or definition lists — nothing survives chunking intact');
      if (!s.hasVisibleDate) reasons.push('no visible date or "last updated" marker, so an engine cannot judge currency');
      if (!s.hasSchema) reasons.push('no valid structured data');
      if (s.questionHeadings === 0) reasons.push('no heading is phrased as the question a reader would ask');
      findings.push({
        checkKey: 'low_citability',
        title: `Citability is ${citabilityInfo.score}/100 — AI answer engines will struggle to quote this page`,
        detail: reasons.join('; ') || 'Passage structure is not extractable.',
        severity: citabilityInfo.score < 35 ? 'high' : 'medium',
        affectedUrl: target,
        action: 'Rewrite the weakest paragraphs so each answers its own heading in its first sentence, add one table or definition list, and surface a visible last-reviewed date.',
        evidence: { signals: s, weakPassages: citabilityInfo.weakPassages },
        dedupeKey: `onpage:citability:${target}`,
      });
    }

    const missingPlacement = [
      !placementInfo.inTitle && 'the title tag',
      !placementInfo.inH1 && 'the H1',
      !placementInfo.inFirstHundredWords && 'the first 100 words',
      !placementInfo.inSubheading && 'any subheading',
    ].filter(Boolean);
    if (keyword && missingPlacement.length >= 2) {
      findings.push({
        checkKey: 'placement',
        title: `The target term is missing from ${missingPlacement.length} key positions`,
        detail: `"${keyword}" does not appear in ${missingPlacement.join(', ')}.`,
        severity: missingPlacement.length >= 3 ? 'high' : 'medium',
        affectedUrl: target,
        action: 'Work the term into the title, H1 and opening paragraph naturally. If it cannot be worked in naturally, the page is probably targeting the wrong term.',
        evidence: placementInfo,
        dedupeKey: `onpage:placement:${target}`,
      });
    }

    if (readability.fleschReadingEase != null && readability.longSentences > Math.max(3, readability.sentences * 0.25)) {
      findings.push({
        checkKey: 'readability',
        title: `${readability.longSentences} of ${readability.sentences} sentences run past 30 words`,
        detail: `Reading ease ${readability.fleschReadingEase}, grade level ${readability.fleschKincaidGrade}, average sentence ${readability.avgSentenceWords} words.`,
        severity: 'low',
        affectedUrl: target,
        action: 'Split the longest sentences. Long sentences also hurt citability: a 60-word sentence rarely survives extraction intact.',
        evidence: readability,
        dedupeKey: `onpage:readability:${target}`,
      });
    }

    if (!competitorDocs.length) {
      findings.push({
        checkKey: 'no_comparison_set',
        title: 'Scored with no comparison set',
        detail: comparison.domains.length
          ? `No page on ${comparison.domains.join(', ')} matched "${keyword}" closely enough in their sitemaps to use as a comparison.`
          : 'No competitor URLs were given and no competitors are configured for this brand, so semantic coverage could not be measured.',
        severity: 'info',
        affectedUrl: target,
        action: 'Paste 2-4 competing URLs, or add competitor domains on the Competitive intelligence page, and re-score.',
        dedupeKey: `onpage:nocomparison:${target}`,
      });
    }

    return store.finish(runRow.id, {
      score: composite.score,
      result: {
        empty: false,
        url: target,
        keyword: keyword || null,
        isDraft: Boolean(draftHtml),
        fetch: fetchInfo ? { status: fetchInfo.status, ms: fetchInfo.totalMs, bytes: fetchInfo.bytes, finalUrl: fetchInfo.url } : null,
        page: {
          title: doc.title, titleLength: (doc.title || '').length,
          metaDesc: doc.metaDesc, metaDescLength: (doc.metaDesc || '').length,
          h1s: doc.h1s, headings: doc.headings, wordCount: doc.wordCount,
          // The word count content metrics were actually computed on, which is
          // not the same number as wordCount and needs to be visible next to it.
          contentWordCount: clean.words,
          boilerplateExcluded: {
            fellBack: clean.fellBack,
            reason: clean.reason || null,
            retainedShare: clean.retainedShare == null ? null : clean.retainedShare,
            removedChars: clean.removedChars || 0,
            selectorsMatched: clean.selectorsMatched || [],
            samples: (clean.removed || []).slice(0, 20),
          },
          canonical: doc.canonical, lang: doc.lang, robotsMeta: doc.robotsMeta,
          mainSelector: doc.mainSelector, semantic: doc.semantic,
          schemaTypes: doc.jsonLd.filter((j) => j.ok).flatMap((j) => schemaTypesOf(j.data)),
          images: { total: doc.images.length, missingAlt: doc.images.filter((i) => i.alt == null).length },
          internalLinks: doc.links.filter((l) => l.internal).length,
          externalLinks: doc.links.filter((l) => !l.internal).length,
        },
        composite,
        // The two new structural blocks.
        headingStructure: headingInfo,
        overOptimisation: stuffingInfo,
        pageTypeVerdict: {
          type: classified.type,
          label: classified.label,
          confident: classified.confident,
          score: classified.score,
          runnerUp: classified.runnerUp,
          evidence: classified.evidence.slice(0, 10),
          mismatches: classified.mismatches,
        },
        templateBlocks: templateBlocks.usable
          ? { pages: templateBlocks.pages, threshold: templateBlocks.threshold, basis: templateBlocks.basis, examples: templateBlocks.examples }
          : { usable: false, pages: templateBlocks.pages },
        coverage,
        readability,
        entity,
        citability: citabilityInfo,
        placement: placementInfo,
        entityGap: entities,
        headingGap: headings,
        keyPhrases: phrases,
        comparison: { method: comparison.method, domains: comparison.domains, pages: competitorFetches },
        performance,
        aiEdits: aiEdits ? {
          ok: aiEdits.ok, cached: aiEdits.cached, reason: aiEdits.reason,
          error: aiEdits.error, data: aiEdits.ok ? aiEdits.data : null,
        } : null,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId && url ? [
        { key: 'onpage.score', url: target, value: composite.score, status: composite.score >= 75 ? 'good' : (composite.score >= 55 ? 'warn' : 'fail') },
        { key: 'onpage.citability', url: target, value: citabilityInfo.score, status: citabilityInfo.score >= 65 ? 'good' : (citabilityInfo.score >= 45 ? 'warn' : 'fail') },
        { key: 'onpage.semantic_coverage', url: target, value: coverage.pct, status: coverage.pct == null ? 'unknown' : (coverage.pct >= 70 ? 'good' : (coverage.pct >= 50 ? 'warn' : 'fail')) },
        { key: 'onpage.heading_structure', url: target, value: headingInfo.score, status: headingInfo.score >= 90 ? 'good' : (headingInfo.score >= 70 ? 'warn' : 'fail') },
        {
          key: 'onpage.keyword_density',
          url: target,
          value: stuffingInfo.measurable && stuffingInfo.target ? stuffingInfo.target.densityPct : null,
          status: !stuffingInfo.measurable || !stuffingInfo.target
            ? 'unknown'
            : (stuffingInfo.target.densityPct > headingsLib.NATURAL_DENSITY_CEILING ? 'fail'
              : (stuffingInfo.target.clustered ? 'warn' : 'good')),
        },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// Pulls @type values out of a JSON-LD node, following @graph. Shared with the
// schema module, which needs the same walk.
function schemaTypesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => schemaTypesOf(n, out)); return out; }
  if (node['@type']) {
    const t = node['@type'];
    (Array.isArray(t) ? t : [t]).forEach((x) => out.push(String(x)));
  }
  if (Array.isArray(node['@graph'])) node['@graph'].forEach((n) => schemaTypesOf(n, out));
  return out;
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: `${f.title} — ${run.target}`,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:onpage:${run.id}:${f.check_key}`,
      category: 'On-page optimisation',
      severity: f.severity,
      affectedUrl: f.affected_url || run.target,
      evidence: f.evidence,
      dedupeKey: `aiseo:onpage:${f.check_key}:${f.affected_url || run.target}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, semanticCoverage, entityGap, headingGap, placement,
  compositeScore, discoverCompetitorPages, candidateScore, schemaTypesOf,
};
