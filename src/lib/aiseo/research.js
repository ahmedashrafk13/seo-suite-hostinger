// 1. AI-POWERED KEYWORD AND PROMPT RESEARCH
//
// Two discovery problems, not one.
//
// The first is the familiar one: find the queries people type into a search
// box. This deployment has no Semrush, Ahrefs or Keyword Planner credential,
// so volume cannot be measured. What it DOES have is better than a third-party
// volume estimate for a site that already ranks: Search Console, which reports
// the queries this exact site was actually shown for, with real impressions
// and real positions. Those are measurements, not estimates. They are extended
// with Google's own autocomplete, which is a free, keyless view of what Google
// believes people are searching — the same source every "keyword idea" tool
// starts from.
//
// The second problem is new and no keyword tool answers it: the PROMPTS people
// type into ChatGPT, Perplexity and Gemini. Those are not queries. They are
// whole sentences that state a situation and ask for a judgement, and they
// cannot be derived from a keyword list by adding modifiers — they have to be
// written by something that knows how people talk to assistants. That is the
// one job the model is given here.
//
// WHAT IS NOT DONE, AND WHY
// No search volume is displayed unless it was MEASURED. A number invented by a
// language model, or extrapolated from autocomplete position, would be
// indistinguishable on screen from a measured one and would end up in a client
// report. That rule is unchanged.
//
// WHAT CHANGED: THE MEASUREMENT IS NOW ATTEMPTED PROPERLY
// "No volume, because we have no Semrush" was leaving three real sources
// unused, so the run now goes through ./keywordMetrics.js, which tries them in
// order and labels every value with the rung that produced it:
//
//   Google Ads Keyword Planner  Google's own volumes, per country, on the
//                               OAuth connection this app already holds. Needs
//                               only a free developer token.
//   DataForSEO / Semrush        where a credential exists.
//   Search Console              impressions for this exact property. Not a
//                               volume, and labelled as what it is.
//   Google Trends               relative interest 0-100 for the CHOSEN COUNTRY.
//                               Keyless, and the honest answer to the country
//                               question: it gives the shape of demand, not its
//                               size, and lives in its own column.
//
// KEYWORD DIFFICULTY, AND WHY IT IS CALLED A PROXY
// A vendor KD is used where a credential provides one. Otherwise a difficulty
// is COMPUTED from a keyless sample of a non-Google result page — how much of
// the top ten is on a named high-authority domain, how many titles carry the
// exact phrase, how many results are homepages, how much of it is Reddit — with
// the formula and every component shown. That is a real competition signal. It
// is labelled "proxy" in every view and is never presented as Ahrefs KD.
//
// COUNTRY
// One market selection flows through autocomplete (gl/hl), Trends (geo), the
// SERP sample (region) and any paid adapter (location code). See ./markets.js
// for why that needed a table rather than a parameter.
const clustering = require('../clustering');
const analytics = require('../analytics');
const seoSignals = require('../seoSignals');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const markets = require('./markets');
const serpLite = require('./serpLite');
const keywordMetrics = require('./keywordMetrics');
const difficultyCache = require('./difficultyCache');
const { fetchPage, mapLimit, sleep } = require('./fetcher');

// Google's autocomplete endpoint. Keyless, public, and the actual source
// behind the "keyword ideas" list in most tools. `client=chrome` returns a
// plain JSON array rather than the JSONP the other clients emit.
const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';

// Modifiers that pull different intent layers out of one seed. Chosen because
// each surfaces a distinct SERP type, not because they lengthen the list:
// question words surface informational pages, "best/vs" surface comparison
// pages, "cost/price" surface commercial ones, and "near me/in" surface local.
const QUESTION_MODIFIERS = ['how', 'what', 'why', 'when', 'which', 'who', 'can', 'is', 'does', 'should'];
const COMPARISON_MODIFIERS = ['best', 'top', 'vs', 'alternative to', 'compared to', 'or'];
const COMMERCIAL_MODIFIERS = ['cost', 'price', 'pricing', 'cheap', 'fees', 'worth it', 'requirements'];
const LOCAL_MODIFIERS = ['near me', 'in', 'online'];

async function suggest(term, { hl = 'en', gl = null, market = null } = {}) {
  if (!providers.has('public')) return [];
  // A market overrides hl/gl, so a caller can pass one identifier instead of
  // remembering which of Google's two locale parameters means what.
  if (market) {
    const m = markets.resolve(market);
    hl = m.hl || hl;
    gl = m.gl || gl;
  }
  const params = new URLSearchParams({ client: 'chrome', q: term, hl });
  if (gl) params.set('gl', gl);
  const res = await fetchPage(`${SUGGEST_URL}?${params.toString()}`, { timeout: 8000 });
  if (!res.ok || !res.body) return [];
  try {
    const parsed = JSON.parse(res.body);
    // Shape: [query, [suggestions], [descriptions], [], {metadata}]
    const list = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
    return list.map((s, i) => ({ keyword: String(s).toLowerCase().trim(), rank: i + 1 })).filter((s) => s.keyword);
  } catch {
    return [];
  }
}

// Expands seeds through autocomplete.
//
// Rate-limited deliberately. Google answers this endpoint generously but not
// infinitely, and a research run that fires 400 concurrent requests gets an
// empty result set for the second half — which looks like "no ideas found"
// rather than "throttled". Two at a time with a pause is slower and complete.
// The alphabet sweep: "<seed> a", "<seed> b" … Google completes each prefix
// differently, and this is where the long-tail phrasings a modifier list cannot
// anticipate come from. It is the technique behind every "keyword ideas" tool's
// long tail, and it is free.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

async function expandSeeds(seeds, {
  perSeedModifiers = true, hl = 'en', gl = null, market = null,
  maxRequests = 90, alphabetSweep = true, alphabetLetters = 12,
} = {}) {
  const queries = [];
  seeds.forEach((seed) => {
    queries.push({ seed, term: seed, layer: 'base' });
    if (!perSeedModifiers) return;
    QUESTION_MODIFIERS.slice(0, 6).forEach((m) => queries.push({ seed, term: `${m} ${seed}`, layer: 'question' }));
    COMPARISON_MODIFIERS.slice(0, 4).forEach((m) => queries.push({ seed, term: `${m} ${seed}`, layer: 'comparison' }));
    COMMERCIAL_MODIFIERS.slice(0, 4).forEach((m) => queries.push({ seed, term: `${seed} ${m}`, layer: 'commercial' }));
    LOCAL_MODIFIERS.slice(0, 2).forEach((m) => queries.push({ seed, term: `${seed} ${m}`, layer: 'local' }));
    if (alphabetSweep) {
      ALPHABET.slice(0, Math.max(0, Math.min(26, alphabetLetters)))
        .forEach((letter) => queries.push({ seed, term: `${seed} ${letter}`, layer: 'alphabet' }));
    }
  });

  const capped = queries.slice(0, maxRequests);
  const found = new Map();
  // Batches of two, with a short pause between batches.
  for (let i = 0; i < capped.length; i += 2) {
    const batch = capped.slice(i, i + 2);
    // eslint-disable-next-line no-await-in-loop
    const results = await mapLimit(batch, 2, async (q) => ({ q, list: await suggest(q.term, { hl, gl, market }) }));
    results.forEach((r) => {
      if (!r || r.__error) return;
      r.list.forEach((s) => {
        // A completion identical to the prefix that produced it ("widgets a")
        // is the prefix, not a suggestion. Dropped so the alphabet sweep adds
        // only real phrasings.
        if (r.q.layer === 'alphabet' && s.keyword === r.q.term) return;
        const existing = found.get(s.keyword);
        if (existing) {
          existing.sources.add(r.q.layer);
          existing.bestRank = Math.min(existing.bestRank, s.rank);
          existing.timesSuggested += 1;
        } else {
          found.set(s.keyword, {
            keyword: s.keyword,
            seed: r.q.seed,
            bestRank: s.rank,
            timesSuggested: 1,
            sources: new Set([r.q.layer]),
          });
        }
      });
    });
    if (i + 2 < capped.length) await sleep(220);
  }

  return [...found.values()].map((f) => ({ ...f, sources: [...f.sources] }));
}

// A SECOND SUGGESTION INDEX, for the phrasings Google's autocomplete misses.
//
// Google's autocomplete is one index's view of how a question gets typed;
// Bing's is another, and the two lists genuinely differ. Verified live on the
// same seed, Google offered "…per square metre / …calculator uk / …ireland"
// while Bing offered "…per foot / …near me cost / …company cost" — different
// framings of one intent, and a keyword universe built from a single suggestion
// source does not contain them at all.
//
// This replaced an attempt to scrape the "related searches" block from a result
// page, which neither engine actually serves — see ./serpLite.js for what was
// tried and why an always-empty list was the wrong thing to ship.
async function relatedForSeeds(seeds, { market = 'ZZ', maxSeeds = 6 } = {}) {
  if (!providers.has('serp-lite')) return { ok: false, rows: [], reason: 'keyless SERP sampling is disabled' };
  const rows = new Map();
  const errors = [];
  for (const seed of seeds.slice(0, maxSeeds)) {
    /* eslint-disable no-await-in-loop */
    const r = await serpLite.relatedSearches(seed, { market });
    /* eslint-enable no-await-in-loop */
    if (!r.ok) { errors.push(`${seed}: ${r.error || 'no suggestions returned'}`); continue; }
    r.related.forEach((term, i) => {
      const key = String(term).toLowerCase().trim();
      if (!key || key === seed.toLowerCase()) return;
      const cur = rows.get(key) || { keyword: key, seed, bestRank: i + 1, timesSuggested: 0, sources: new Set() };
      cur.timesSuggested += 1;
      cur.bestRank = Math.min(cur.bestRank, i + 1);
      cur.sources.add('related');
      rows.set(key, cur);
    });
  }
  return {
    ok: rows.size > 0,
    rows: [...rows.values()].map((r) => ({ ...r, sources: [...r.sources] })),
    errors,
    engine: 'bing-suggest',
  };
}

// ---------------------------------------------------------------- assembly

// Search Console keywords, which are the only demand numbers here that are
// measured rather than inferred.
function gscKeywords(brandId, { days = 90, limit = 800 } = {}) {
  if (!brandId) return [];
  const rows = clustering.keywordsFromGsc(brandId, { days, minImpressions: 3, limit });
  return rows.map((r) => ({
    keyword: String(r.keyword).toLowerCase(),
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    position: r.position == null ? null : Number(r.position),
    source: 'search-console',
  }));
}

// Merges the two sources into one keyword universe.
//
// Provenance is carried on every row and rendered in the UI, because the two
// halves are not equivalent evidence: a Search Console row means "this site was
// shown for this, N times"; an autocomplete row means "Google offers this
// phrase to people typing". Presenting them in one undifferentiated table is
// how an idea gets treated as a measurement.
function mergeUniverse(gscRows, suggestRows, brand, { metrics = null } = {}) {
  const terms = new Map();
  const brandTerms = seoSignals.brandTerms(brand || {});

  gscRows.forEach((r) => {
    terms.set(r.keyword, {
      keyword: r.keyword,
      impressions: r.impressions,
      clicks: r.clicks,
      position: r.position,
      inSearchConsole: true,
      suggestRank: null,
      suggestLayers: [],
      branded: seoSignals.isBrandedQuery(r.keyword, brandTerms),
      demandEvidence: 'measured',
    });
  });

  suggestRows.forEach((s) => {
    const existing = terms.get(s.keyword);
    if (existing) {
      existing.suggestRank = s.bestRank;
      existing.suggestLayers = s.sources;
      // A keyword in BOTH is the strongest signal available without a volume
      // tool: Google suggests it, and this site is already shown for it.
      existing.demandEvidence = 'measured+suggested';
      return;
    }
    terms.set(s.keyword, {
      keyword: s.keyword,
      impressions: null,
      clicks: null,
      position: null,
      inSearchConsole: false,
      suggestRank: s.bestRank,
      suggestLayers: s.sources,
      branded: seoSignals.isBrandedQuery(s.keyword, brandTerms),
      demandEvidence: 'suggested',
    });
  });

  const list = [...terms.values()];

  // Volume, difficulty and relative interest, folded in with the BASIS for
  // each. A row can legitimately carry a measured volume, a proxy difficulty
  // and a Trends interest all at once, from three different rungs — so each
  // value keeps its own provenance rather than the row keeping one.
  if (metrics && metrics.values) {
    list.forEach((k) => {
      const m = metrics.values.get(k.keyword);
      if (!m) return;
      k.volume = m.volume == null ? null : m.volume;
      k.volumeBasis = m.volumeBasis || null;
      k.cpc = m.cpc == null ? null : m.cpc;
      k.adsCompetition = m.competition == null ? null : m.competition;
      k.monthlyVolume = m.monthly || null;
      k.difficulty = m.difficulty == null ? null : m.difficulty;
      k.difficultyBasis = m.difficultyBasis || null;
      k.difficultyDetail = m.difficultyDetail || null;
      k.difficultyUnavailable = m.difficultyUnavailable || null;
      k.relativeInterest = m.relativeInterest == null ? null : m.relativeInterest;
      k.relativeInterestBasis = m.relativeInterestBasis || null;
      k.interestTrend = m.interestTrend == null ? null : m.interestTrend;
      k.interestRescaled = Boolean(m.interestRescaled);
    });
  }

  return list;
}

// Ranks the universe without inventing a volume.
//
// The score is an explicit, explainable combination of what is known:
// impressions where they exist (log-scaled, because the difference between 10
// and 100 impressions matters more than between 10,000 and 10,090),
// autocomplete prominence, and how many distinct modifier layers surfaced the
// term. It is called `priority`, not `volume`, everywhere it is shown.
function scoreKeyword(k) {
  let score = 0;
  const reasons = [];

  // A MEASURED volume, where one exists, outranks every inferred signal — so it
  // enters the score first and at the highest weight. Log-scaled for the same
  // reason impressions are: the gap between 100 and 1,000 monthly searches
  // matters far more than the gap between 50,000 and 51,000.
  if (k.volume) {
    const s = Math.min(60, Math.log10(k.volume + 1) * 18);
    score += s;
    reasons.push(`${k.volume.toLocaleString('en-US')} monthly searches (${k.volumeBasis})`);
  } else if (k.relativeInterest) {
    // Relative interest is NOT a volume and is weighted well below one. It is
    // in the score because it is the only country-specific demand signal
    // available without a credential, and excluding it entirely would leave the
    // country filter with nothing to change.
    const s = Math.min(18, (k.relativeInterest / 100) * 18);
    score += s;
    reasons.push(`Google Trends relative interest ${k.relativeInterest}/100 for the selected country`
      + (k.interestTrend != null ? ` (${k.interestTrend >= 0 ? '+' : ''}${k.interestTrend}% over the window)` : ''));
  }

  // Difficulty lowers priority rather than raising it: an achievable keyword is
  // worth more than a contested one at the same demand. Applied as a multiplier
  // at the end so it scales the whole score instead of being another additive
  // term that a high-volume head term simply outweighs.
  if (k.impressions) {
    const s = Math.min(50, Math.log10(k.impressions + 1) * 16);
    score += s;
    reasons.push(`${k.impressions.toLocaleString('en-US')} impressions in Search Console`);
  }
  if (k.suggestRank) {
    const s = Math.max(0, 22 - ((k.suggestRank - 1) * 2));
    score += s;
    reasons.push(`Google suggests it at position ${k.suggestRank}`);
  }
  if (k.suggestLayers && k.suggestLayers.length > 1) {
    score += Math.min(12, k.suggestLayers.length * 3);
    reasons.push(`surfaced by ${k.suggestLayers.length} modifier layers`);
  }
  // A position between 4 and 20 is the striking-distance band: real demand,
  // already ranking, one improvement away from traffic. Worth more than a
  // keyword with the same impressions sitting at 60.
  if (k.position != null && k.position >= 4 && k.position <= 20) {
    score += 16;
    reasons.push(`already ranking at position ${k.position.toFixed(1)} — striking distance`);
  }
  if (k.branded) {
    // Branded terms are not opportunities; they are already won. Kept in the
    // universe (they matter for the prompt work) but pushed down the list.
    score *= 0.35;
    reasons.push('branded term — already captured');
  }

  if (k.difficulty != null) {
    // 0.55 at KD 100, 1.0 at KD 0. Deliberately gentle: a proxy difficulty is
    // not certain enough to halve a keyword's priority, and a hard keyword with
    // real demand is still worth planning for.
    const factor = 1 - (Math.max(0, Math.min(100, k.difficulty)) / 100) * 0.45;
    score *= factor;
    reasons.push(`difficulty ${k.difficulty}/100 (${k.difficultyBasis === 'serp-proxy' ? 'SERP proxy' : k.difficultyBasis}) — priority scaled by ${factor.toFixed(2)}`);
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

// --------------------------------------------------------------------- run

// The whole research pass. `seedText` overrides the brand's stored seeds; when
// both are empty it falls back to the site's own top Search Console queries,
// which is the right default for an established site and the reason a brand
// with GSC connected needs no configuration at all.
async function run({
  userId, brand, adoptRunId = null, seedText = '', days = 90, includeSuggest = true,
  includePrompts = true, force = false,
  // NEW: the country the volume, difficulty and SERP sample are for. Falls back
  // to the brand's stored market, then to worldwide. Resolved through
  // ./markets.js so one selection reaches every adapter in the identifier it
  // expects.
  country = null,
  includeRelated = true,
  includeMetrics = true,
  difficultyLimit = 12,
  alphabetSweep = true,
}) {
  const brandId = brand ? brand.id : null;
  const vertical = (brand && brand.vertical) || 'other';
  const locale = (brand && brand.locale) || 'en';
  const market = markets.resolve(country || (brand && brand.market) || null);

  const explicitSeeds = String(seedText || '')
    .split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);
  const storedSeeds = String((brand && brand.seed_topics) || '')
    .split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'research',
    target: brand ? brand.site_url : null,
    label: explicitSeeds.length ? explicitSeeds.slice(0, 3).join(', ') : 'Search Console seeds',
    params: {
      seeds: explicitSeeds, days, includeSuggest, includePrompts,
      country: market.code, includeRelated, includeMetrics, difficultyLimit, alphabetSweep,
    },
  });

  try {
    const sources = [];
    const gscRows = gscKeywords(brandId, { days });
    if (gscRows.length) sources.push('gsc');

    // Seeds, in priority order: what the user typed, what the brand stores,
    // then the site's own best-performing non-branded queries.
    let seeds = explicitSeeds.length ? explicitSeeds : storedSeeds;
    let seedOrigin = explicitSeeds.length ? 'typed for this run' : (storedSeeds.length ? 'brand settings' : null);
    if (!seeds.length && gscRows.length) {
      const brandTerms = seoSignals.brandTerms(brand || {});
      seeds = gscRows
        .filter((r) => !seoSignals.isBrandedQuery(r.keyword, brandTerms))
        .slice(0, 8)
        .map((r) => r.keyword);
      seedOrigin = 'top non-branded Search Console queries';
    }
    if (!seeds.length) {
      // Nothing to work from is a real, explainable state — not an error and
      // not an empty page.
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'No seed topics and no Search Console history for this brand, so there is nothing to expand from. Add seed topics on the brand, or connect Search Console and let a sync run.',
          seeds: [], keywords: [], clusters: [], prompts: null,
          market: { code: market.code, name: market.name },
        },
        findings: [],
        sources,
      });
    }

    let suggestRows = [];
    if (includeSuggest && providers.has('public')) {
      suggestRows = await expandSeeds(seeds.slice(0, 8), {
        hl: market.hl || locale.split('-')[0] || 'en',
        gl: market.gl,
        market: market.code,
        alphabetSweep,
        // The alphabet sweep multiplies the request count by 12 per seed, so
        // the cap rises with it rather than silently truncating the modifier
        // layers it was sized for.
        maxRequests: alphabetSweep ? 200 : 90,
      });
      if (suggestRows.length) sources.push('public');
    }

    // Related searches: the alternative PHRASINGS, which autocomplete does not
    // give. Merged into the same suggestion pool with its own layer name so a
    // reader can see where a term came from.
    let related = null;
    if (includeRelated && providers.has('serp-lite')) {
      related = await relatedForSeeds(seeds, { market: market.code });
      if (related.ok) {
        sources.push('serp-lite');
        const bySeed = new Map(suggestRows.map((r) => [r.keyword, r]));
        related.rows.forEach((r) => {
          const existing = bySeed.get(r.keyword);
          if (existing) {
            existing.sources = [...new Set([...existing.sources, 'related'])];
            existing.bestRank = Math.min(existing.bestRank, r.bestRank);
          } else {
            suggestRows.push(r);
            bySeed.set(r.keyword, r);
          }
        });
      }
    }

    // ------------------------------------------------------ volume and KD
    //
    // Enriched BEFORE scoring, because volume and difficulty change the
    // ordering — and enriched on the ranked head of the universe rather than
    // all of it, since a keyless difficulty costs one paced SERP request per
    // keyword. What was and was not enriched is reported.
    const preliminary = mergeUniverse(gscRows, suggestRows, brand)
      .map((k) => ({ ...k, ...scoreKeyword(k) }))
      .sort((a, b) => b.score - a.score);

    let metrics = null;
    if (includeMetrics) {
      const enrichTargets = preliminary
        .filter((k) => !k.branded)
        .slice(0, 200)
        .map((k) => k.keyword);
      if (enrichTargets.length) {
        metrics = await keywordMetrics.enrich(enrichTargets, {
          market: market.code,
          userId,
          difficultyLimit,
          brandId,
          // Queued below instead, once the clusters exist: enqueuing here
          // would fill the backfill queue in raw keyword order, which drains
          // depth-first and can leave whole clusters with no difficulty for
          // several ticks. Round-robin across clusters gives every cluster a
          // number after the first tick instead.
          queueOverflow: false,
        });
        metrics.sources.forEach((src) => {
          const key = src === 'google-ads' ? 'google-ads' : src;
          if (!sources.includes(key)) sources.push(key);
        });
      }
    }

    const universe = mergeUniverse(gscRows, suggestRows, brand, { metrics })
      .map((k) => ({ ...k, ...scoreKeyword(k) }))
      .sort((a, b) => b.score - a.score);

    // Topic + intent clustering, using the app's existing engine so the
    // groupings here and on /keywords mean the same thing.
    const clusterInput = universe.slice(0, 600).map((k) => ({
      keyword: k.keyword,
      impressions: k.impressions || 0,
      clicks: k.clicks || 0,
      position: k.position,
    }));
    const clustered = clustering.cluster(clusterInput, {
      brandId, vertical, locale, market, minSimilarity: 0.4, maxClusters: 60,
    });

    // Clusters ordered by the demand evidence that actually exists, and
    // annotated with what share of each cluster is measured rather than
    // suggested. A cluster of eight autocomplete phrases and no impressions is
    // a hypothesis; the UI should not present it beside a measured one without
    // saying which is which.
    const byKeyword = new Map(universe.map((k) => [k.keyword, k]));
    const clusterList = (clustered.clusters || []).map((c) => {
      // clustering.cluster() returns members as [{ keyword, impressions, … }].
      const members = (c.members || []).map((m) => byKeyword.get(m.keyword)).filter(Boolean);
      const measured = members.filter((m) => m.inSearchConsole).length;
      const impressions = members.reduce((a, m) => a + (m.impressions || 0), 0);
      const withVolume = members.filter((m) => m.volume != null);
      const kds = members.filter((m) => m.difficulty != null).map((m) => m.difficulty);
      return {
        ...c,
        memberDetail: members,
        measuredShare: members.length ? Math.round((measured / members.length) * 100) : 0,
        impressions,
        // Cluster-level demand and difficulty, so a content plan can be built
        // from the clusters rather than from individual keywords. Both state how
        // many members they were computed from — a total volume over 2 of 9
        // members is not the cluster's volume and must not read as one.
        volume: withVolume.length ? withVolume.reduce((a, m) => a + m.volume, 0) : null,
        volumeMembers: withVolume.length,
        volumeBasis: withVolume.length ? withVolume[0].volumeBasis : null,
        avgDifficulty: kds.length ? Math.round(kds.reduce((a, b) => a + b, 0) / kds.length) : null,
        difficultyMembers: kds.length,
        difficultyBasis: kds.length ? (members.find((m) => m.difficulty != null) || {}).difficultyBasis : null,
        priority: Math.round(members.reduce((a, m) => a + (m.score || 0), 0) * 10) / 10,
        evidence: measured === members.length ? 'measured'
          : (measured === 0 ? 'suggested' : 'mixed'),
      };
    }).sort((a, b) => b.priority - a.priority);

    // The AI half: the prompts people type into assistants.
    let prompts = null;
    if (includePrompts) {
      prompts = await aiCalls.promptResearch({
        brandId, brand, topics: seeds.slice(0, 8),
        keywords: universe.filter((k) => k.inSearchConsole && !k.branded).slice(0, 60).map((k) => k.keyword),
        vertical, force,
      });
      if (prompts.ok) sources.push('azure');
    }

    // Queue every unscored keyword for the background difficulty scorer,
    // round-robin across clusters.
    //
    // The order matters more than it looks. The queue drains in insertion
    // order, so enqueuing cluster by cluster would score all thirty keywords
    // of the first cluster before touching the second — and a user looking at
    // the table an hour later would see one complete cluster and a column of
    // em dashes. Interleaving means the first pass gives every cluster a
    // number, and later passes deepen the average.
    let difficultyQueued = 0;
    if (includeMetrics && metrics) {
      try {
        const rows = clusterList.map((c) => (c.memberDetail || [])
          .filter((m) => m.difficulty == null && !m.difficultyUnavailable)
          .map((m) => m.keyword));
        const interleaved = [];
        const depth = Math.max(0, ...rows.map((r) => r.length));
        for (let i = 0; i < depth; i += 1) {
          rows.forEach((r) => { if (r[i]) interleaved.push(r[i]); });
        }
        if (interleaved.length) {
          difficultyQueued = difficultyCache.enqueue(interleaved, market.code, { brandId }).queued;
        }
      } catch (err) {
        // Never fail a research run because the backfill queue rejected a write.
        console.error('[research] difficulty enqueue failed:', err.message);
      }
    }

    // ------------------------------------------------------------ findings
    const findings = [];

    // Striking-distance keywords: real demand, already ranking, closest thing
    // to free traffic in the list.
    const striking = universe.filter((k) => !k.branded && k.position != null
      && k.position >= 4 && k.position <= 20 && (k.impressions || 0) >= 50);
    if (striking.length) {
      findings.push({
        checkKey: 'striking_distance',
        title: `${striking.length} keyword${striking.length === 1 ? '' : 's'} in striking distance (positions 4-20)`,
        detail: `These already earn impressions and rank just outside the top 3. Top by impressions: ${striking.slice(0, 6).map((k) => `"${k.keyword}" (#${k.position.toFixed(1)}, ${k.impressions.toLocaleString('en-US')} impr)`).join('; ')}.`,
        severity: 'high',
        affectedCount: striking.length,
        action: 'Improve the ranking page for each: strengthen the on-page coverage against the current top 3, then re-check position in 3-4 weeks.',
        evidence: { keywords: striking.slice(0, 30) },
        dedupeKey: `research:striking:${brandId}`,
      });
    }

    // The country the numbers are for, and the basis of the volume column.
    // Stated as a finding rather than only as a footnote, because a report read
    // without its basis is the failure mode this whole module is built against.
    if (metrics) {
      const measuredVolumes = universe.filter((k) => k.volume != null).length;
      const proxyKd = universe.filter((k) => k.difficultyBasis === 'serp-proxy').length;
      const measuredKd = universe.filter((k) => k.difficulty != null && k.difficultyBasis !== 'serp-proxy').length;
      const interest = universe.filter((k) => k.relativeInterest != null).length;
      findings.push({
        checkKey: 'metrics_basis',
        title: measuredVolumes
          ? `${measuredVolumes} keyword${measuredVolumes === 1 ? '' : 's'} carry a measured search volume for ${market.name}`
          : `No measured search volume is available for ${market.name}`,
        detail: `${metrics.volumeBasisNote} `
          + `Difficulty: ${measuredKd} measured, ${proxyKd} from a keyless SERP proxy`
          + (proxyKd ? ' (computed from a DuckDuckGo/Bing result sample, not from Google — the formula and every component are shown against each keyword)' : '')
          + `. Relative interest: ${interest} keyword${interest === 1 ? '' : 's'}. `
          + `Rungs tried, in order: ${metrics.attempted.map((a) => `${a.rung} — ${a.outcome}`).join('; ')}.`,
        severity: 'info',
        action: measuredVolumes
          ? 'No action needed. The source of each number is shown on its own row.'
          : 'Set GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CUSTOMER_ID to get Google\'s own volumes for this country on the Google connection this app already holds — it is the cheapest of the options and needs no new subscription.',
        evidence: {
          market: { code: market.code, name: market.name },
          attempted: metrics.attempted,
          errors: metrics.errors,
          sources: metrics.sources,
          counts: { measuredVolumes, measuredKd, proxyKd, interest },
        },
        dedupeKey: `research:metricsbasis:${brandId}:${market.code}`,
      });

      // Low-difficulty demand: the actionable intersection, and the reason
      // difficulty was worth computing at all.
      const winnable = universe.filter((k) => !k.branded
        && k.difficulty != null && k.difficulty <= 35
        && ((k.volume || 0) >= 50 || (k.impressions || 0) >= 30 || (k.relativeInterest || 0) >= 25));
      if (winnable.length >= 3) {
        findings.push({
          checkKey: 'winnable_keywords',
          title: `${winnable.length} keyword${winnable.length === 1 ? '' : 's'} with demand and a difficulty at or below 35`,
          detail: winnable.slice(0, 10).map((k) => `"${k.keyword}" (KD ${k.difficulty}`
            + (k.volume != null ? `, ${k.volume.toLocaleString('en-US')}/mo` : (k.impressions ? `, ${k.impressions.toLocaleString('en-US')} impr` : ''))
            + ')').join('; ')
            + `. Difficulty basis: ${[...new Set(winnable.map((k) => k.difficultyBasis))].join(', ')}.`,
          severity: 'medium',
          affectedCount: winnable.length,
          action: 'These are the shortest path to traffic in this run. Check the sampled result page shown against each one before committing — a low proxy difficulty on a SERP full of forum threads means a good page wins, and that is exactly the case worth taking.',
          evidence: { keywords: winnable.slice(0, 40) },
          dedupeKey: `research:winnable:${brandId}:${market.code}`,
        });
      }
    }

    if (related && related.ok && related.rows.length) {
      const newFromRelated = related.rows.filter((r) => !gscRows.some((g) => g.keyword === r.keyword));
      if (newFromRelated.length >= 3) {
        findings.push({
          checkKey: 'related_search_phrasings',
          title: `${newFromRelated.length} alternative phrasings from a second suggestion index`,
          detail: `${newFromRelated.slice(0, 10).map((r) => `"${r.keyword}"`).join(', ')}. `
            + 'These come from Bing\'s suggestion index rather than Google\'s. The two lists genuinely differ — the same seed produces different framings of the same intent in each — so a keyword universe built from one suggestion source does not contain them.',
          severity: 'info',
          affectedCount: newFromRelated.length,
          action: 'Read these as evidence about how the intent is expressed, not as separate pages to build. Several phrasings of one question belong on one page.',
          evidence: { keywords: newFromRelated.slice(0, 40), engine: related.engine, errors: related.errors },
          dedupeKey: `research:related:${brandId}:${market.code}`,
        });
      }
    }

    // Demand the site is not visible for at all.
    const unclaimed = universe.filter((k) => !k.inSearchConsole && !k.branded && k.suggestRank && k.suggestRank <= 6);
    if (unclaimed.length >= 3) {
      findings.push({
        checkKey: 'unclaimed_demand',
        title: `${unclaimed.length} suggested phrases this site is not visible for`,
        detail: `Google offers these completions for the seed topics, and Search Console shows no impressions for them: ${unclaimed.slice(0, 8).map((k) => `"${k.keyword}"`).join(', ')}.`,
        severity: 'medium',
        affectedCount: unclaimed.length,
        action: 'Check each against the live SERP before committing — autocomplete proves the phrasing exists, not that it carries useful volume. Cluster the survivors into one page per intent rather than one page per phrase.',
        evidence: { keywords: unclaimed.slice(0, 40) },
        dedupeKey: `research:unclaimed:${brandId}`,
      });
    }

    // Prompt-shaped demand with no page that could be cited.
    if (prompts && prompts.ok && prompts.data && Array.isArray(prompts.data.clusters)) {
      const promptCount = prompts.data.clusters.reduce((a, c) => a + ((c.prompts || []).length), 0);
      findings.push({
        checkKey: 'ai_prompt_coverage',
        title: `${promptCount} assistant prompts mapped across ${prompts.data.clusters.length} jobs`,
        detail: (prompts.data.clusters || []).slice(0, 5)
          .map((c) => `${c.job} (${(c.prompts || []).length} prompts, ${c.intent || 'unclassified'})`).join('; '),
        severity: 'info',
        affectedCount: promptCount,
        action: 'For each job, confirm one page can answer the whole cluster with a quotable passage. Prompts asking for comparisons need a comparison page, not a service page.',
        evidence: { jobs: (prompts.data.clusters || []).map((c) => ({ job: c.job, intent: c.intent, prompts: (c.prompts || []).length })) },
        dedupeKey: `research:prompts:${brandId}`,
      });
    }

    const score = clusterList.length
      ? Math.min(100, Math.round((striking.length * 4) + (clusterList.filter((c) => c.evidence !== 'suggested').length * 2)))
      : null;

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        seeds, seedOrigin,
        market: { code: market.code, name: market.name },
        counts: {
          total: universe.length,
          measured: universe.filter((k) => k.inSearchConsole).length,
          suggested: universe.filter((k) => !k.inSearchConsole).length,
          branded: universe.filter((k) => k.branded).length,
          striking: striking.length,
          withVolume: universe.filter((k) => k.volume != null).length,
          withDifficulty: universe.filter((k) => k.difficulty != null).length,
          withProxyDifficulty: universe.filter((k) => k.difficultyBasis === 'serp-proxy').length,
          withRelativeInterest: universe.filter((k) => k.relativeInterest != null).length,
          fromRelatedSearches: related && related.ok ? related.rows.length : 0,
          fromAlphabetSweep: suggestRows.filter((r) => (r.sources || []).includes('alphabet')).length,
        },
        // Where every number came from, and which rungs were tried and failed.
        // Rendered above the table, because the table is unreadable without it.
        metrics: metrics ? {
          market: metrics.market,
          sources: metrics.sources,
          attempted: metrics.attempted,
          errors: metrics.errors,
          volumeBasisNote: metrics.volumeBasisNote,
          difficultyBasisNote: metrics.difficultyBasisNote,
          difficultyCoverage: metrics.difficultyCoverage,
          difficultyQueued,
          difficultyLimit,
        } : null,
        related: related ? { ok: related.ok, count: related.rows.length, engine: related.engine, errors: related.errors, reason: related.reason || null } : null,
        keywords: universe.slice(0, 400),
        clusters: clusterList,
        prompts: prompts ? {
          ok: prompts.ok, cached: prompts.cached, reason: prompts.reason,
          error: prompts.error, data: prompts.ok ? prompts.data : null,
        } : null,
        provenance: providers.provenance(sources),
        window: gscRows.length ? { days, latest: analytics.latestGscDate(brandId) } : null,
      },
      findings,
      metrics: brandId ? [
        { key: 'research.keywords_total', value: universe.length, status: 'good' },
        { key: 'research.striking_distance', value: striking.length, status: striking.length ? 'warn' : 'good' },
        { key: 'research.keywords_with_volume', value: universe.filter((k) => k.volume != null).length, status: 'good' },
        {
          key: 'research.winnable_keywords',
          value: universe.filter((k) => !k.branded && k.difficulty != null && k.difficulty <= 35).length,
          status: 'good',
        },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// Turns the research findings into tasks, using the same bridge audits and
// alerts use so everything lands in one backlog.
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
      sourceRef: `aiseo:research:${run.id}:${f.check_key}`,
      category: 'Keyword research',
      severity: f.severity,
      evidence: f.evidence,
      dedupeKey: `aiseo:research:${run.brand_id || 0}:${f.check_key}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, suggest, expandSeeds, relatedForSeeds,
  gscKeywords, mergeUniverse, scoreKeyword, ALPHABET,
};
