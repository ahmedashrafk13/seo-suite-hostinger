// The AI layer for the AI SEO features.
//
// WHAT THE MODEL IS AND IS NOT USED FOR
// It is used for the things only a language model can do: writing the prompts
// a person would actually type into ChatGPT about a topic, naming the entities
// a page ought to mention, drafting a schema block, rewriting a paragraph so
// it can be quoted, and judging whether a hostile forum post is a factual
// claim or an opinion.
//
// It is NOT used for measurement. Scores, similarities, densities, drift and
// counts are computed in ./nlp.js, deterministically. This split is not
// stylistic:
//   - A score that changes when nothing changed cannot be explained to a
//     client, and cannot be alerted on.
//   - A cron job that measures with a paid model burns the spend cap on the
//     least valuable work in the system.
//   - Every one of these features must still work with no AI configured. If
//     measurement lived here, they would all return nothing.
//
// Every call goes through lib/ai/azureClient.js, which enforces the hard spend
// cap BEFORE any HTTP request, and through the cache in ./store.js, which is
// keyed on a hash of the meaningful inputs — so reopening a page never
// re-bills, and re-running an unchanged analysis costs nothing.
const azure = require('../ai/azureClient');
const budget = require('../ai/budget');
const providers = require('./providers');
const store = require('./store');

function available() {
  return providers.has('azure');
}

// Runs a prompt, or returns the cached answer for identical inputs.
//
// `force` re-asks and overwrites the cache — needed because a user who has
// edited the page and wants a fresh opinion would otherwise be shown the old
// one forever when the hashed inputs happen not to have changed (they hash the
// analysis inputs, not the whole page).
async function ask({
  feature, brandId = null, inputs, systemPrompt, userPrompt, maxTokens = 900, force = false,
}) {
  if (!available()) {
    return { ok: false, reason: 'unconfigured', error: 'Azure OpenAI is not configured, so AI-assisted output is unavailable. Every score and finding on this page is computed locally and is unaffected.' };
  }
  const inputHash = store.hashInputs({ feature, inputs });
  if (!force) {
    const hit = store.cachedAi(feature, inputHash);
    if (hit) return { ok: true, cached: true, data: hit.data, costUsd: 0, createdAt: hit.created_at };
  }
  try {
    const r = await azure.generate({ feature, brandId, systemPrompt, userPrompt, maxTokens });
    store.cacheAi({ brandId, feature, inputHash, data: r.data, costUsd: r.costUsd });
    return {
      ok: true, cached: false, data: r.data, costUsd: r.costUsd,
      tokens: r.promptTokens + r.completionTokens,
      promptTokens: r.promptTokens, completionTokens: r.completionTokens,
    };
  } catch (err) {
    // A budget refusal is a normal, expected state, not a bug — it is
    // reported as such so the page says "cap reached" rather than "error".
    return {
      ok: false,
      reason: err.budgetBlocked ? 'budget' : 'error',
      error: String(err.message),
      remaining: budget.remaining(),
    };
  }
}

// A house style every prompt inherits. The rules exist because each one was a
// failure mode worth designing out:
//   - JSON only: the caller parses it.
//   - No invented metrics: a model asked about keywords will happily produce
//     "search volume: 2,400", and that number would then be rendered in a
//     client report as though it were measured.
//   - Say when unsure: an empty array is a usable answer; a confident
//     fabrication is not.
const HOUSE_RULES = `
You are an SEO and AI-search analyst working inside a reporting tool.

Rules you must follow:
- Reply with a single JSON object matching the requested shape. No prose, no markdown.
- NEVER invent numeric metrics. You do not have access to search volume,
  keyword difficulty, backlink counts, traffic, or ranking data. If a field
  would require one, omit it or return null. Estimates must be labelled as
  qualitative bands ("high", "medium", "low"), never as numbers.
- Base every statement on the data given to you in the user message. Do not
  assume facts about the brand that are not stated there.
- Prefer fewer, higher-confidence items over a long speculative list.
- Write for a professional practitioner: specific, plain, no marketing tone.
`.trim();

// ------------------------------------------------- 1. prompt research
//
// The thing traditional keyword tools cannot give you: the sentences people
// type into an AI assistant. They differ from search queries in shape — full
// questions, constraints, comparisons, and a stated situation — so they cannot
// be derived from a keyword list by transformation, only written.
async function promptResearch({ brandId, brand, topics, keywords, vertical, force = false }) {
  const inputs = { topics, keywords: keywords.slice(0, 60), vertical, site: brand && brand.site_url };
  return ask({
    feature: 'aiseo.promptResearch',
    brandId,
    inputs,
    force,
    maxTokens: 1600,
    systemPrompt: `${HOUSE_RULES}

Your task: write the PROMPTS a real person would type into an AI assistant
(ChatGPT, Perplexity, Gemini, Copilot) when they have the need this brand
serves. These are not search queries. They are longer, they state a situation,
they carry constraints, and they often ask for a comparison or a
recommendation.

Group them by the job the person is trying to get done, not by keyword.

For each prompt also state:
- stage: "unaware" | "researching" | "comparing" | "ready" | "post-purchase"
- engines: which assistants this phrasing is most typical of
- citationOpportunity: what a page would have to contain to be cited in the
  answer to this prompt (be concrete: a table, a figure, a definition, a
  named methodology)

Shape:
{"clusters":[{"job":"...","intent":"Informational|Commercial|Transactional|Navigational|Local","prompts":[{"prompt":"...","stage":"...","engines":["chatgpt","perplexity"],"citationOpportunity":"..."}],"contentAngle":"..."}],
 "gaps":["..."],"notes":"..."}`,
    userPrompt: JSON.stringify({
      brand: brand ? { name: brand.name, site: brand.site_url, vertical: brand.vertical || vertical || 'other', market: brand.market || null } : null,
      seedTopics: topics,
      realSearchQueriesFromSearchConsole: keywords.slice(0, 60),
      instruction: 'Write 4-7 job clusters, 4-6 prompts each. The search queries are real Search Console data for this site; use them to infer what the audience actually wants, then write the AI-assistant phrasing of those same needs.',
    }, null, 1),
  });
}

// ------------------------------------------------ 2. on-page edit suggestions
//
// The model sees the MEASURED gaps, not the raw page. That keeps the token
// cost bounded on a long page and — more importantly — keeps the suggestions
// anchored to something checkable, instead of a free-form rewrite nobody can
// diff against the original.
async function onPageEdits({ brandId, targetKeyword, doc, gaps, citabilityInfo, competitorHeadings, force = false }) {
  const inputs = {
    url: doc.url, targetKeyword,
    missingEntities: gaps.missingEntities.slice(0, 30),
    weakPassages: (citabilityInfo.weakPassages || []).map((p) => p.preview),
    headings: doc.headings.slice(0, 40),
    competitorHeadings: (competitorHeadings || []).slice(0, 40),
  };
  return ask({
    feature: 'aiseo.onPageEdits',
    brandId,
    inputs,
    force,
    maxTokens: 1800,
    systemPrompt: `${HOUSE_RULES}

Your task: propose specific, in-line edits to a page so that it (a) covers the
topic as completely as the top-ranking pages do and (b) contains passages an AI
answer engine can quote and attribute.

Every edit must be actionable by a writer without further research:
- "where" names the heading or the quoted opening words of the paragraph to change
- "replaceWith" is copy that can be pasted, not an instruction
- Do not propose adding a statistic, price, date or claim. You do not know
  those. Where the page needs one, say what KIND of fact is needed and mark
  needsFact: true so a human supplies it.

Shape:
{"edits":[{"type":"rewrite|add-section|add-passage|restructure|heading","where":"...","why":"...","replaceWith":"...","needsFact":false,"priority":"high|medium|low"}],
 "missingSections":[{"heading":"...","whatItShouldCover":"...","approxWords":150}],
 "quotableRewrites":[{"original":"...","rewritten":"...","whyMoreCitable":"..."}]}`,
    userPrompt: JSON.stringify({
      url: doc.url,
      targetKeyword,
      currentTitle: doc.title,
      currentHeadings: doc.headings.slice(0, 40),
      wordCount: doc.wordCount,
      measuredGaps: {
        entitiesTopCompetitorsMentionAndThisPageDoesNot: gaps.missingEntities.slice(0, 30),
        semanticCoveragePct: gaps.semanticCoveragePct,
        headingsCompetitorsHaveAndThisPageDoesNot: gaps.missingHeadings.slice(0, 20),
      },
      citabilityMeasured: citabilityInfo.signals,
      paragraphsThatCannotStandAlone: (citabilityInfo.weakPassages || []).slice(0, 8).map((p) => p.preview),
      instruction: 'Return at most 12 edits, highest impact first.',
    }, null, 1),
  });
}

// -------------------------------------------------------- 3. schema drafting
//
// Deterministic generation handles the fields that can be read off the page
// (name, url, headline, images, breadcrumb trail, FAQ pairs found in the
// markup). The model is asked only for the parts that need reading
// comprehension: which type actually fits, and what the recommended-but-absent
// properties should say.
async function schemaDraft({
  brandId, doc, detected, wantedTypes, brandFacts, pageType = null, force = false,
}) {
  const inputs = {
    url: doc.url, title: doc.title,
    headings: doc.headings.slice(0, 30),
    detected: detected.map((d) => d.type),
    wantedTypes,
    // Part of the cache key: the same page classified differently must not
    // return the cached answer for the old classification.
    pageType: pageType ? pageType.type : null,
  };
  return ask({
    feature: 'aiseo.schemaDraft',
    brandId,
    inputs,
    force,
    maxTokens: 1800,
    systemPrompt: `${HOUSE_RULES}

Your task: decide which Schema.org types genuinely fit this page, and draft the
JSON-LD for them.

Hard constraints — a violation here produces markup that earns a manual action:
- Mark up ONLY what is visibly on the page. If the page has no FAQ, do not
  return FAQPage. If it has no prices, do not return Offer.
- Never fabricate a rating, review count, price, availability, author name or
  date. Use null and list the field in "needsHumanInput".
- Use the brand facts provided for Organization-level fields; do not guess them.
- The page type has ALREADY BEEN DECIDED by a deterministic classifier and is
  given to you as pageTypeVerdict. Do not re-litigate it. Types listed in
  pageTypeVerdict.forbidden must NOT appear in "recommended" under any
  circumstances — put them in "rejected" and quote the stated reason. This
  constraint exists because models reliably reach for Product on anything with
  a price, and Product on a service page is the exact failure this check is for.
- Where pageTypeVerdict.confident is false, say so in your reasoning and
  recommend the types that are safe for BOTH candidate page types.

Shape:
{"recommended":[{"type":"...","whyItFits":"...","jsonld":{...},"needsHumanInput":["..."],"riskIfWrong":"..."}],
 "rejected":[{"type":"...","whyNot":"..."}]}`,
    userPrompt: JSON.stringify({
      url: doc.url,
      title: doc.title,
      metaDescription: doc.metaDesc,
      headingOutline: doc.headings.slice(0, 30),
      firstParagraphs: doc.paragraphs.slice(0, 4),
      hasTable: doc.semantic.table,
      hasLists: doc.semantic.lists,
      breadcrumbTrail: doc.breadcrumbTrail.trail,
      schemaTypesAlreadyOnPage: detected.map((d) => d.type),
      typesTheUserAskedAbout: wantedTypes,
      pageTypeVerdict: pageType,
      brandCanonicalFacts: brandFacts,
    }, null, 1),
  });
}

// ------------------------------------------------------- 4. competitive gaps
//
// Both sides of the comparison are measured by the crawler; the model's job is
// to say what the difference MEANS and what to do about it, which is the part
// a topic-overlap table cannot express.
async function competitiveGaps({ brandId, brand, ourTopics, theirTopics, competitors, anchorPatterns, force = false }) {
  const inputs = { ourTopics: ourTopics.slice(0, 60), theirTopics: theirTopics.slice(0, 80), competitors };
  return ask({
    feature: 'aiseo.competitiveGaps',
    brandId,
    inputs,
    force,
    maxTokens: 1600,
    systemPrompt: `${HOUSE_RULES}

Your task: read a measured comparison of what this brand publishes against
what its named competitors publish, and turn it into a prioritised plan.

For each gap say what to build, why it is worth building for THIS brand, and
what would make the brand's version the citable one rather than a copy. Where
the right answer is "do not compete on this", say so — a gap that exists
because a competitor is a marketplace with 40,000 pages is not an opportunity.

Shape:
{"priorities":[{"topic":"...","gapType":"missing|thin|outranked|authority","whatToBuild":"...","whyForThisBrand":"...","differentiator":"...","effort":"low|medium|high","confidence":"high|medium|low"}],
 "doNotChase":[{"topic":"...","why":"..."}],
 "authorityReading":"..."}`,
    userPrompt: JSON.stringify({
      brand: { name: brand.name, site: brand.site_url, vertical: brand.vertical || 'other' },
      competitors,
      topicsWePublish: ourTopics.slice(0, 60),
      topicsTheyPublishWeDoNot: theirTopics.slice(0, 80),
      theirInternalAnchorTextPatterns: (anchorPatterns || []).slice(0, 30),
      instruction: 'At most 10 priorities. Every topic must come from the lists given.',
    }, null, 1),
  });
}

// -------------------------------------------------- 5. mention triage
//
// Lexicon sentiment classifies everything (cheap, deterministic). This is
// asked only about the items the lexicon flagged as carrying a damaging
// claim — the small set where the distinction between "an angry opinion" and
// "a false factual assertion an AI engine will repeat" actually matters, and
// where the response differs completely.
async function mentionTriage({ brandId, brand, mentions, force = false }) {
  const inputs = { mentions: mentions.map((m) => ({ url: m.url, title: m.title, snippet: (m.snippet || '').slice(0, 400) })) };
  return ask({
    feature: 'aiseo.mentionTriage',
    brandId,
    inputs,
    force,
    maxTokens: 1400,
    systemPrompt: `${HOUSE_RULES}

Your task: triage brand mentions that an automated scan flagged as potentially
damaging.

For each one decide:
- claimType: "factual-assertion" | "opinion" | "question" | "comparison" | "unrelated"
  ("unrelated" matters: a keyword match is not always about this brand.)
- verifiable: can the claim be checked against public record?
- recommendedResponse: "correct-the-record" | "respond-publicly" | "monitor" | "ignore" | "escalate-legal"
- draftResponse: only when recommendedResponse is correct-the-record or
  respond-publicly. Factual, non-defensive, no marketing language, no promises.

Do not assert whether a claim is true or false. You cannot know. Say what would
establish it.

Shape:
{"triaged":[{"url":"...","claimType":"...","verifiable":true,"aboutThisBrand":true,"severity":"critical|high|medium|low","recommendedResponse":"...","whatWouldSettleIt":"...","draftResponse":null}]}`,
    userPrompt: JSON.stringify({
      brand: { name: brand.name, site: brand.site_url },
      flaggedMentions: mentions.map((m) => ({
        url: m.url, source: m.source, title: m.title,
        snippet: (m.snippet || '').slice(0, 400),
        automatedRiskFlag: m.risk,
      })),
    }, null, 1),
  });
}

// --------------------------------------------- 6. intent-drift interpretation
//
// The divergence number comes from nlp.jensenShannon. What a shift in the
// query mix MEANS for the page — and whether the fix is a rewrite, a split, or
// nothing — is the judgement call.
//
// Batched across every drifted page in one call rather than one call per
// page: the earlier per-page loop resent the full system prompt (~250-300
// tokens of fixed instruction) for every page, so a run with 6 drifted pages
// paid for that overhead 6 times to get 6 independent judgements that fit
// comfortably in a single request. Caching stays per-page (each page keeps
// its own input hash and its own cache row), so a re-run where only one of
// six pages actually changed still re-asks about just that one page — this
// only collapses the *uncached* pages into one request instead of N.
// `item.page` is the page URL (a plain string) — the identifier used both to
// key the per-page cache and to match the model's per-page answer back to
// its request.
function intentDriftInputs(item) {
  return {
    page: item.page, pageTitle: item.pageTitle, lastModified: item.lastModified,
    driftMetrics: item.driftMetrics,
    gained: item.gainedQueries.slice(0, 25), lost: item.lostQueries.slice(0, 25),
  };
}

async function intentDriftReadings({ brandId, items, force = false }) {
  if (!available()) {
    return items.map(() => ({ ok: false, reason: 'unconfigured', error: 'Azure OpenAI is not configured, so AI-assisted output is unavailable. Every score and finding on this page is computed locally and is unaffected.' }));
  }

  const feature = 'aiseo.intentDrift';
  const withHash = items.map((item) => ({ item, inputHash: store.hashInputs({ feature, inputs: intentDriftInputs(item) }) }));

  const results = new Map(); // page -> result
  const misses = [];
  withHash.forEach(({ item, inputHash }) => {
    if (!force) {
      const hit = store.cachedAi(feature, inputHash);
      if (hit) { results.set(item.page, { ok: true, cached: true, data: hit.data, costUsd: 0, createdAt: hit.created_at }); return; }
    }
    misses.push({ item, inputHash });
  });

  if (misses.length) {
    const systemPrompt = `${HOUSE_RULES}

Your task: for EACH page in the array, its query mix in Search Console has
changed between two windows. Say what changed about what searchers want, and
what the page should do about it.

Distinguish three cases, because the response differs completely:
- "seasonal-or-noise": the mix moved but the underlying need did not. Do nothing.
- "intent-shift": the same topic is now being searched with a different goal
  (e.g. research became comparison). Re-angle the existing page.
- "topic-split": the page is now catching two distinct needs. Split it.

Return one verdict per page, in the same order, identified by its "page" URL —
judge each page independently of the others.

Shape:
{"readings":[{"page":"...","verdict":"seasonal-or-noise|intent-shift|topic-split","confidence":"high|medium|low",
 "whatChanged":"...","recommendedAction":"...","suggestedHeadings":["..."],
 "shouldRefresh":true,"refreshUrgency":"now|this-quarter|watch"}]}`;

    const userPrompt = JSON.stringify({
      pages: misses.map(({ item }) => ({
        page: item.page,
        title: item.pageTitle,
        lastModified: item.lastModified,
        measuredDrift: item.driftMetrics,
        queriesThePageGainedImpressionsFor: item.gainedQueries.slice(0, 25),
        queriesThePageLostImpressionsFor: item.lostQueries.slice(0, 25),
      })),
      note: 'Divergence is Jensen-Shannon over the impression-weighted query distribution, in bits, 0 = identical, 1 = no overlap.',
    }, null, 1);

    try {
      const r = await azure.generate({
        feature, brandId, systemPrompt, userPrompt,
        maxTokens: Math.min(1100 * misses.length, 4400),
      });
      const byPage = new Map((r.data.readings || []).map((x) => [x.page, x]));
      misses.forEach(({ item, inputHash }) => {
        const reading = byPage.get(item.page) || null;
        if (reading) store.cacheAi({ brandId, feature, inputHash, data: reading, costUsd: 0 });
        results.set(item.page, reading
          ? { ok: true, cached: false, data: reading }
          : { ok: false, reason: 'error', error: 'The model did not return a reading for this page.' });
      });
      // The batch's actual cost is billed once for the whole call; recorded
      // against the first miss so total spend is still accounted for even
      // though it is not divisible per page.
      if (misses[0]) {
        const first = results.get(misses[0].item.page);
        if (first && first.ok) { first.costUsd = r.costUsd; first.tokens = r.promptTokens + r.completionTokens; }
      }
    } catch (err) {
      const failure = {
        ok: false,
        reason: err.budgetBlocked ? 'budget' : 'error',
        error: String(err.message),
        remaining: budget.remaining(),
      };
      misses.forEach(({ item }) => results.set(item.page, failure));
    }
  }

  return items.map((item) => results.get(item.page) || { ok: false, reason: 'error', error: 'No reading produced.' });
}

// --------------------------------------------- 7. entity/topic link rationale
//
// Candidate link pairs are produced by the entity graph. The model supplies
// the anchor-text wording and the reason, which is what turns a similarity
// score into something a writer can act on without guessing.
async function linkRationale({ brandId, candidates, force = false }) {
  const inputs = { candidates: candidates.slice(0, 25).map((c) => [c.sourceUrl, c.targetUrl, c.sharedEntities.slice(0, 6)]) };
  return ask({
    feature: 'aiseo.linkRationale',
    brandId,
    inputs,
    force,
    maxTokens: 1500,
    systemPrompt: `${HOUSE_RULES}

Your task: for each proposed internal link, write the anchor text and say what
the link does for a reader.

Constraints:
- Anchor text must be natural prose that could appear in the source page's
  copy. No "click here", no exact-match keyword stuffing, no anchor over 8 words.
- If a pair does not deserve a link, say so with skip: true. A link that exists
  only because two pages share vocabulary makes the site harder to navigate.

Shape:
{"links":[{"sourceUrl":"...","targetUrl":"...","anchor":"...","placement":"...","reason":"...","skip":false}]}`,
    userPrompt: JSON.stringify({
      candidatePairs: candidates.slice(0, 25).map((c) => ({
        sourceUrl: c.sourceUrl,
        sourceTitle: c.sourceTitle,
        targetUrl: c.targetUrl,
        targetTitle: c.targetTitle,
        sharedEntities: c.sharedEntities.slice(0, 8),
        similarity: c.similarity,
      })),
    }, null, 1),
  });
}

// ---------------------------------------- 8. llms.txt / brand-hub fact review
//
// A brand hub is only useful if it is TRUE and complete. The model checks the
// declared facts for the things that make an AI engine distrust a page —
// vagueness, unverifiable superlatives, missing basics — rather than writing
// the facts, which must come from the business.
async function brandHubReview({ brandId, brand, facts, force = false }) {
  return ask({
    feature: 'aiseo.brandHubReview',
    brandId,
    inputs: { facts },
    force,
    maxTokens: 1200,
    systemPrompt: `${HOUSE_RULES}

Your task: review a brand's declared canonical facts — the set an AI engine
would read to answer "what is this company, and can I trust it".

Report:
- missing: basics an engine needs and no fact supplies (what it sells, who for,
  where it operates, how it is regulated/accredited, who runs it, how to
  contact it, pricing basis)
- unverifiable: facts stated in a way no third party could confirm, and what
  would make each one checkable
- vague: facts that say nothing ("industry-leading", "trusted by many")

Do not write replacement facts that assert anything about the business. For
each problem, say what KIND of statement would fix it.

Shape:
{"missing":[{"fact":"...","whyItMatters":"..."}],
 "unverifiable":[{"factKey":"...","problem":"...","whatWouldMakeItCheckable":"..."}],
 "vague":[{"factKey":"...","problem":"..."}],
 "readinessVerdict":"..."}`,
    userPrompt: JSON.stringify({
      brand: { name: brand.name, site: brand.site_url, vertical: brand.vertical || 'other' },
      declaredFacts: facts,
    }, null, 1),
  });
}

module.exports = {
  available, ask, HOUSE_RULES,
  promptResearch, onPageEdits, schemaDraft, competitiveGaps,
  mentionTriage, intentDriftReadings, linkRationale, brandHubReview,
};
