// WHO GETS CITED FOR THE QUESTIONS PEOPLE ASK AN ASSISTANT.
//
// THE GAP THIS CLOSES
// ./research.js already produces the two halves of the demand side: the
// keywords people type into a search box, and — through the model — the whole
// questions they type into ChatGPT, Perplexity and Gemini. What it never
// answered is the question that follows immediately, and the one a client
// actually asks: when somebody asks that, whose site does the answer come
// from? A list of prompts with no answer-side data tells you what to write
// about but not whether you are anywhere near being the source.
//
// WHAT CAN HONESTLY BE MEASURED HERE, AND WHAT CANNOT
// This deployment holds no citation-tracking credential (no Profound, no SE
// Ranking AI visibility, no DataForSEO LLM endpoints), and there is no keyless
// way to ask ChatGPT which sources it cited for a prompt. So the thing a
// client wants most — "we were cited in 12% of ChatGPT answers" — is NOT
// knowable here, and this module does not produce it. Inventing that number
// would be the exact failure ./providers.js exists to prevent.
//
// What IS knowable, keylessly, is the retrieval pool: the pages a web-grounded
// assistant would have to choose from. Every grounded assistant answers a
// question by running a search behind the scenes and reading the top results —
// ChatGPT and Copilot over Bing's index, Perplexity over its own blend of web
// indexes. So the set of pages ranking for the question is the population that
// citations are drawn FROM. Being in it is not proof of citation; being absent
// from it is very close to proof of non-citation, because a page that no index
// returns for the question cannot be read and quoted.
//
// That asymmetry is the whole value, and it is what every number below is
// labelled as:
//
//   PRESENT   the brand is in the retrieval pool for this question. Necessary,
//             not sufficient. Reported as "eligible to be cited".
//   ABSENT    the brand is not in the pool. Reported as "cannot currently be
//             cited for this question", which is a real, actionable finding.
//   UNKNOWN   the sample failed — blocked, timed out, no results. Reported as
//             unknown and EXCLUDED from both sides of every ratio.
//
// The third case is why this module is longer than it looks. A blocked sample
// silently counted as "brand absent" would manufacture a visibility crisis out
// of a rate limit, and one counted as "present" would hide a real one. So a
// failure is a third state everywhere, and the coverage figure is shown beside
// every percentage so the reader knows how much of the question set the
// percentage actually describes.
//
// GROUND TRUTH, WHERE IT EXISTS
// ./aiReferrals.js measures something this cannot: humans who read an AI
// answer, clicked the citation, and arrived — recorded by GA4 as an assistant
// referral. That is proof of citation rather than eligibility for it. Where
// the brand has AI referral sessions, this module says so alongside its own
// numbers, because one measured arrival outweighs any amount of pool analysis.
const serpLite = require('./serpLite');
const markets = require('./markets');
const store = require('./store');
const providers = require('./providers');
const competitive = require('./competitive');
const { hostKey, normalizeUrl } = require('../../../tools/node/lib/urls');

// A question set is capped because each prompt is one paced HTTP request
// against an endpoint that rate-limits, and serpLite serialises them with a
// minimum gap. Forty prompts is roughly three minutes of wall clock; a
// thousand would be an afternoon and a block.
const MAX_PROMPTS = Number(process.env.AISEO_PROMPT_CITATION_MAX || 40);

// ------------------------------------------------------------------ helpers
function brandDomainOf(brand) {
  try {
    return hostKey(brand.site_url).replace(/^www\./, '');
  } catch {
    return String(brand && brand.site_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

// A prompt is a whole question, so it is long. The retrieval sample is taken
// on the question as written rather than on extracted keywords, deliberately:
// the point is to see what an assistant's own grounding search would surface,
// and that search runs on the question.
function cleanPrompt(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

// Pulls the questions out of a stored research run's payload, so this analysis
// runs on the prompts that were actually generated for this brand rather than
// on a list retyped by hand.
//
// Two shapes are read: the model's clustered prompts (data.prompts.data
// .clusters[].prompts) and the question-modifier keywords the keyless
// expansion produced (anything in the universe that reads as a question).
// Both are questions people ask; only the first came from a model.
function promptsFromResearch(runData, { limit = MAX_PROMPTS } = {}) {
  const out = [];
  const seen = new Set();
  const push = (text, origin, meta) => {
    const q = cleanPrompt(text);
    if (!q || q.length < 12) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign({ prompt: q, origin }, meta || {}));
  };

  const clusters = ((runData || {}).prompts || {}).data;
  ((clusters && clusters.clusters) || []).forEach((c) => {
    (c.prompts || []).forEach((p) => push(
      typeof p === 'string' ? p : (p && (p.prompt || p.text)),
      'assistant-prompt',
      { job: c.job || null, intent: c.intent || null },
    ));
  });

  // Question-shaped keywords from the keyless side. Included because they are
  // real observed demand — someone typed them into Google — and they are the
  // only question source available when the AI half is switched off.
  const QUESTION_START = /^(how|what|why|when|which|who|can|is|are|does|do|should|will)\b/i;
  ((runData || {}).keywords || []).forEach((k) => {
    const term = k && (k.keyword || k.term);
    if (term && QUESTION_START.test(String(term))) {
      push(term, 'search-question', { impressions: k.impressions || null, intent: k.intent || null });
    }
  });

  return out.slice(0, limit);
}

// ------------------------------------------------------------- the analysis
// `competitorDomains` is the named competitor list from the brand, not a
// discovered one: the interesting comparison is against the sites the client
// argues with in sales calls, and an auto-discovered list would fill the table
// with directories and aggregators that no client cares about ranking against.
async function analyse({
  brand,
  prompts,
  market = 'ZZ',
  competitorDomains = [],
  limit = MAX_PROMPTS,
  perPrompt = 10,
  aiReferrals = null,
} = {}) {
  const started = Date.now();
  const brandDomain = brandDomainOf(brand);
  const competitors = (competitorDomains || [])
    .map((d) => String(d || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase())
    .filter(Boolean);

  const list = (prompts || []).slice(0, limit);
  if (!list.length) {
    return {
      ok: false,
      reason: 'no-prompts',
      note: 'No questions to check. Run keyword & prompt research first, or paste a question list.',
    };
  }

  const rows = [];
  const domainTally = new Map(); // domain -> { prompts, bestPosition, appearances }
  let present = 0;
  let absent = 0;
  let unknown = 0;

  for (const item of list) {
    const prompt = typeof item === 'string' ? cleanPrompt(item) : cleanPrompt(item.prompt);
    if (!prompt) continue;
    /* eslint-disable no-await-in-loop */
    const serp = await serpLite.search(prompt, { market, limit: perPrompt });

    if (!serp.ok || !serp.results.length) {
      unknown += 1;
      rows.push({
        prompt,
        origin: item.origin || null,
        job: item.job || null,
        intent: item.intent || null,
        state: 'unknown',
        engine: serp.engine || null,
        error: serp.error || 'no results returned',
        brand: null,
        competitors: [],
        pool: [],
      });
      continue;
    }

    const brandHit = serpLite.positionOf(serp, brandDomain);
    const compHits = competitors
      .map((d) => {
        const hit = serpLite.positionOf(serp, d);
        return hit ? { domain: d, position: hit.position, url: hit.url } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.position - b.position);

    if (brandHit) present += 1; else absent += 1;

    serp.results.forEach((r) => {
      const d = r.domain || r.host;
      if (!d) return;
      const cur = domainTally.get(d) || { domain: d, prompts: 0, bestPosition: 99, positions: [] };
      cur.prompts += 1;
      cur.positions.push(r.position);
      if (r.position < cur.bestPosition) cur.bestPosition = r.position;
      domainTally.set(d, cur);
    });

    rows.push({
      prompt,
      origin: item.origin || null,
      job: item.job || null,
      intent: item.intent || null,
      state: brandHit ? 'present' : 'absent',
      engine: serp.engine,
      brand: brandHit ? { position: brandHit.position, url: brandHit.url, title: brandHit.title } : null,
      competitors: compHits,
      // The pool itself, capped: this is what the reader checks the verdict
      // against, and the top five is enough to see whether the question was
      // even understood the way the prompt intended.
      pool: serp.results.slice(0, 5).map((r) => ({ position: r.position, domain: r.domain || r.host, url: r.url, title: r.title })),
    });
  }

  const measured = present + absent;
  const leaderboard = [...domainTally.values()]
    .map((d) => ({
      domain: d.domain,
      prompts: d.prompts,
      // Share is over MEASURED prompts, not over the whole list, and the
      // measured count travels with it — see the header. A leaderboard whose
      // denominator silently included failed samples would rank every domain
      // too low by the same unknown amount.
      share: measured ? Number(((d.prompts / measured) * 100).toFixed(1)) : null,
      bestPosition: d.bestPosition === 99 ? null : d.bestPosition,
      avgPosition: d.positions.length
        ? Number((d.positions.reduce((a, b) => a + b, 0) / d.positions.length).toFixed(1))
        : null,
      isBrand: d.domain === brandDomain,
      isNamedCompetitor: competitors.includes(d.domain),
    }))
    .sort((a, b) => b.prompts - a.prompts || (a.avgPosition || 99) - (b.avgPosition || 99));

  const brandRow = leaderboard.find((d) => d.isBrand) || null;

  // The gap list: questions where a named competitor is in the pool and the
  // brand is not. This is the actionable half of the whole analysis — each row
  // is a question the client's rival can be quoted on and they cannot.
  const gaps = rows
    .filter((r) => r.state === 'absent' && r.competitors.length)
    .map((r) => ({
      prompt: r.prompt,
      job: r.job,
      intent: r.intent,
      competitors: r.competitors,
      pool: r.pool,
    }))
    .sort((a, b) => (a.competitors[0].position || 99) - (b.competitors[0].position || 99));

  // Questions nobody strong answers: no named competitor and no brand in the
  // pool. Worth a separate list because these are the cheapest wins available
  // — an unclaimed question with an intent the brand can actually serve.
  const openQuestions = rows
    .filter((r) => r.state === 'absent' && !r.competitors.length)
    .map((r) => ({ prompt: r.prompt, job: r.job, intent: r.intent, pool: r.pool }));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    brandDomain,
    market: markets.resolve(market).code,
    marketLabel: markets.label ? markets.label(market) : markets.resolve(market).code,
    competitorDomains: competitors,
    counts: {
      requested: list.length,
      measured,
      present,
      absent,
      unknown,
      // Rendered next to every percentage. Below ~70% the UI says the sample
      // is too thin to read as a trend rather than showing a confident number.
      coverage: list.length ? Number(((measured / list.length) * 100).toFixed(1)) : 0,
    },
    eligibility: measured
      ? {
        // Named for what it is. NOT "citation rate" — see the header.
        label: 'Retrieval-pool presence',
        pct: Number(((present / measured) * 100).toFixed(1)),
        basis: `${present} of ${measured} question(s) where a keyless index sample returned this site in the top ${perPrompt}.`,
      }
      : null,
    brandSummary: brandRow,
    leaderboard: leaderboard.slice(0, 30),
    rows,
    gaps,
    openQuestions,
    // Provenance, in the shape the other analyses use, so the result page's
    // existing provenance block can render it unchanged.
    sources: ['serp-lite (DuckDuckGo/Bing HTML sample)'],
    limits: [
      'This measures the retrieval pool a grounded assistant would choose sources from — not the citations an assistant actually made. No keyless endpoint reports real ChatGPT, Gemini or Perplexity citations, and this deployment holds no citation-tracking credential.',
      'The sample comes from DuckDuckGo and Bing, not Google. That is the right index for ChatGPT and Copilot, which are Bing-grounded, and an approximation for Gemini and AI Overviews, which are not.',
      unknown ? `${unknown} question(s) could not be sampled and are excluded from every percentage rather than counted as absent.` : null,
      'Presence in the pool is necessary but not sufficient for a citation. Absence from it is near-conclusive that no citation is possible for that question today.',
    ].filter(Boolean),
    // Ground truth, when GA4 has any.
    referralEvidence: aiReferrals && aiReferrals.ok ? {
      sessions: aiReferrals.totals ? aiReferrals.totals.sessions : null,
      note: 'GA4 recorded real sessions arriving from AI assistants for this site. Those are proof of citation, unlike everything above — read them first.',
    } : null,
  };
}

// The findings this produces for the task backlog, in the shape aiseo/store.js
// already normalises.
function toFindings(result, brand) {
  if (!result || !result.ok) return [];
  const out = [];

  if (result.eligibility && result.counts.coverage >= 60) {
    const pct = result.eligibility.pct;
    out.push({
      severity: pct < 20 ? 'high' : pct < 50 ? 'medium' : 'low',
      title: `In the retrieval pool for ${pct}% of the assistant questions checked`,
      detail: `${result.eligibility.basis} An assistant can only quote a page an index returns for the question, so the remaining ${100 - pct}% are questions this site cannot currently be cited on.`,
      action: pct < 50
        ? 'Work the gap list below: each row is a question a named competitor can be quoted on and this site cannot. Answer it on a page that states the answer in a liftable passage near the top.'
        : 'Hold the pool presence and shift attention to citability — whether the passage an assistant would lift is actually quotable. The on-page score measures that.',
      dedupeKey: `prompt-citations:eligibility:${brand.id}`,
    });
  }

  if (result.gaps.length) {
    out.push({
      severity: 'medium',
      title: `${result.gaps.length} question(s) where a competitor is in the pool and this site is not`,
      detail: result.gaps.slice(0, 6).map((g) => `"${g.prompt}" — ${g.competitors[0].domain} at #${g.competitors[0].position}`).join('; '),
      action: 'Each of these is a question with demonstrated retrieval demand and a rival already eligible to answer it. Brief a page per cluster rather than per question.',
      evidence: { gaps: result.gaps.slice(0, 25) },
      dedupeKey: `prompt-citations:gaps:${brand.id}`,
    });
  }

  if (result.openQuestions.length >= 3) {
    out.push({
      severity: 'low',
      title: `${result.openQuestions.length} assistant question(s) with no strong answer from anyone`,
      detail: result.openQuestions.slice(0, 6).map((q) => `"${q.prompt}"`).join('; '),
      action: 'Unclaimed questions: neither this site nor any named competitor is in the pool. Cheapest available wins where the intent is one this brand can genuinely serve.',
      evidence: { openQuestions: result.openQuestions.slice(0, 25) },
      dedupeKey: `prompt-citations:open:${brand.id}`,
    });
  }

  if (result.counts.unknown && result.counts.coverage < 70) {
    out.push({
      severity: 'low',
      title: `Only ${result.counts.coverage}% of the question set could be sampled`,
      detail: `${result.counts.unknown} of ${result.counts.requested} questions returned nothing — normally a rate limit on the keyless endpoints rather than an empty result page.`,
      action: 'Re-run with a smaller question set, or later in the day. The percentages above describe only the sampled questions and should not be read as a site-wide figure at this coverage.',
      dedupeKey: `prompt-citations:coverage:${brand.id}`,
    });
  }

  return out;
}

// ==========================================================================
// The engine entry point the routes and the background runner call.
// ==========================================================================
//
// Follows the same contract as every other analysis in this directory:
// run({ userId, brand, adoptRunId, ... }) opens a run row, does the work, and
// finishes it with a result, findings and metrics. See ./runner.js for why the
// row is opened before the work rather than after.
//
// WHERE THE QUESTIONS COME FROM, IN PRIORITY ORDER
//   1. A pasted list, when the user typed one. Explicit beats derived.
//   2. The brand's most recent completed keyword-research run — the prompts
//      the model generated for this brand, plus the question-shaped keywords
//      the keyless expansion found.
// If neither exists the run finishes with an explanation rather than an empty
// table, because "no questions were available to check" and "this site is in
// no retrieval pool" would otherwise look identical on screen.
async function run({
  userId, brand, adoptRunId = null,
  promptText = null, market = null, perPrompt = 10, limit = MAX_PROMPTS,
}) {
  const site = normalizeUrl(brand.site_url);
  const resolvedMarket = market || brand.market || 'ZZ';

  let prompts = [];
  let promptSource = null;
  let researchRunId = null;

  const pasted = String(promptText || '')
    .split(/\r?\n/)
    .map((l) => cleanPrompt(l))
    .filter((l) => l.length >= 12);
  if (pasted.length) {
    prompts = pasted.map((p) => ({ prompt: p, origin: 'pasted' }));
    promptSource = 'pasted';
  } else {
    const researchRun = store.latestRun({ userId, kind: 'research', brandId: brand.id });
    if (researchRun && researchRun.result) {
      prompts = promptsFromResearch(researchRun.result, { limit });
      promptSource = 'research-run';
      researchRunId = researchRun.id;
    }
  }

  const runRow = store.begin({
    adoptRunId,
    userId,
    brandId: brand.id,
    kind: 'prompt_citations',
    target: site,
    label: `${prompts.length} question(s)`,
    params: { market: resolvedMarket, perPrompt, promptSource, researchRunId, prompts: prompts.length },
  });

  try {
    if (!prompts.length) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          site,
          promptSource: null,
          reason: 'no-questions',
          note: 'No questions were available to check. Run keyword research for this brand first — its '
            + 'assistant prompts and question keywords are used automatically — or paste a question list on '
            + 'the form.',
          provenance: providers.provenance([]),
        },
        findings: [],
        metrics: [],
        sources: [],
      });
    }

    const competitorDomains = competitive.list(brand.id)
      .filter((c) => c.active)
      .map((c) => c.domain);

    // GA4 ground truth, when a previous AI-referral run measured any. Read
    // from storage rather than re-run: this analysis must not depend on a GA4
    // credential, and a stored measurement is exactly as true as a fresh one.
    let referrals = null;
    const referralRun = store.latestRun({ userId, kind: 'ai_referrals', brandId: brand.id });
    if (referralRun && referralRun.result && !referralRun.result.empty) {
      referrals = { ok: true, totals: referralRun.result.totals || null };
    }

    const result = await analyse({
      brand,
      prompts,
      market: resolvedMarket,
      competitorDomains,
      limit,
      perPrompt,
      aiReferrals: referrals,
    });

    const findings = toFindings(result, brand);

    // The score is the retrieval-pool presence percentage, and it is null when
    // coverage is too thin to mean anything. A score computed from three
    // sampled questions out of forty would sit in the history chart looking
    // exactly like a measured one.
    const score = result.eligibility && result.counts.coverage >= 60
      ? Math.round(result.eligibility.pct)
      : null;

    return store.finish(runRow.id, {
      score,
      result: Object.assign({ empty: false, site, promptSource, researchRunId }, result, {
        scoreMeaning: score == null
          ? `Not scored: only ${result.counts.coverage}% of the question set could be sampled, which is too thin to report as a site-level figure.`
          : `${result.counts.present} of ${result.counts.measured} sampled question(s) returned this site in the top ${perPrompt} of a keyless index sample.`,
        provenance: providers.provenance(['crawler']),
      }),
      findings,
      metrics: [
        { key: 'promptcitations.pool_presence', value: score, status: score == null ? 'unknown' : (score >= 50 ? 'good' : (score >= 20 ? 'warn' : 'fail')) },
        { key: 'promptcitations.gaps', value: result.gaps.length, status: result.gaps.length ? 'warn' : 'good' },
        { key: 'promptcitations.coverage', value: result.counts.coverage, status: result.counts.coverage >= 70 ? 'good' : 'warn' },
      ],
      sources: ['crawler'],
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// Gap questions become content tasks: one per gap, carrying the competitor
// that already occupies the pool as the evidence that justifies the work.
function toTasks(runRecord, brand, { userId }) {
  const tasksLib = require('../tasks');
  const gaps = ((runRecord.result || {}).gaps) || [];
  let created = 0;
  // Capped at twenty. A forty-question run with a thin site would otherwise
  // open forty tasks in one click, which buries the backlog rather than
  // informing it; the gap list is sorted by the rival's position, so the
  // twenty kept are the ones where a competitor ranks highest.
  gaps.slice(0, 20).forEach((g) => {
    const rival = g.competitors && g.competitors[0];
    const res = tasksLib.upsertTask({
      userId,
      brandId: runRecord.brand_id,
      title: `Answer the assistant question: "${g.prompt}"`,
      detail: (rival
        ? `A keyless index sample returns ${rival.domain} at position ${rival.position} for this question and does not return this site at all. An assistant grounding an answer on this question can quote them and cannot quote us.`
        : 'A keyless index sample does not return this site for this question.')
        + '\n\nAnswer the question directly on one page, in a passage that states the answer in the first two '
        + 'sentences and reads correctly lifted out of its context. Then run the on-page score against that '
        + 'page — being in the retrieval pool and being quotable are different properties.'
        + '\n\nThis is retrieval-pool evidence, not a measured citation: it says an assistant COULD quote the '
        + 'pages listed, not that it did.',
      source: 'aiseo',
      sourceRef: `aiseo:prompt_citations:${runRecord.id}`,
      category: 'Content',
      severity: 'medium',
      evidence: g,
      dedupeKey: `aiseo:promptcitation:${runRecord.brand_id || 0}:${String(g.prompt).toLowerCase().slice(0, 120)}`,
    });
    if (res.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, analyse, toFindings, toTasks,
  promptsFromResearch, brandDomainOf, cleanPrompt, MAX_PROMPTS,
};
