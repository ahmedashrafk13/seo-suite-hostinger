// AI weekly-report commentary - a first draft of the paragraph a human then
// edits and signs.
//
// WHY THIS ONE AND NOT THE OTHERS. Every report already carries the numbers;
// what it lacks until someone sits down and writes it is the sentence that
// says what those numbers MEAN. That box (weekly_reports.commentary) is the
// only free-text field in the app that is written from scratch every week, for
// every brand, from data the app already holds - which is exactly the shape of
// work a model does well and a person resents. Nothing else in the reporting
// path was missing an AI hand: the figures are measured and must stay that way.
//
// WHAT IT IS NOT ALLOWED TO DO.
//   * It never invents a number. Only the aggregates passed in this file are
//     given to the model, and the prompt forbids any figure not in them.
//   * It never runs on a schedule. Like every other module in lib/ai, this is
//     reachable only from an explicit button - see the comment at the top of
//     routes/aiAssist.js. Weekly reports ARE generated automatically, and
//     wiring this into that job would spend the AI budget unattended on every
//     brand, every week, forever.
//   * It never publishes itself. The draft lands in the editable box and
//     nothing leaves the app until a person saves and shares it.
const azureClient = require('./azureClient');

const SYSTEM_PROMPT = [
  'You are a senior SEO account manager writing the commentary paragraph of a weekly client report.',
  'You will be given a JSON object of that week\'s measured figures and the change against the previous week.',
  'Write 3 to 5 short paragraphs, separated by blank lines, in plain British English for a non-technical client.',
  'Cover, in this order: what moved this week and by how much; the most likely explanation given only the data shown;',
  'anything that needs the client\'s attention; and what the SEO team is doing next.',
  'RULES YOU MUST FOLLOW:',
  '1. Use ONLY the numbers in the input. Never state a figure that is not there, and never estimate one.',
  '2. If a field is null or missing, say the data was not available rather than guessing.',
  '3. Do not promise rankings, traffic or revenue outcomes.',
  '4. Do not use marketing superlatives, exclamation marks or emoji.',
  '5. Attribute causes tentatively ("this is consistent with", "the likely driver is"), never as established fact,',
  '   because nothing in the input proves causation.',
  'Return a JSON object of the exact shape {"commentary": "..."} with the paragraphs separated by \\n\\n. JSON only.',
].join(' ');

function pct(d) {
  if (!d || d.pct == null) return null;
  return Math.round(d.pct * 10) / 10;
}

function metric(d) {
  if (!d) return null;
  return { now: d.recent, previous: d.prior, change: d.abs, changePct: pct(d) };
}

// The model sees a SMALL, NAMED summary, not the whole report.
//
// The stored report object runs to thousands of rows - every query, page,
// city, event and inspection. Passing that would cost a fortune per draft, and
// would bury the handful of figures a client paragraph is actually about. This
// picks the aggregates a human would quote, and nothing else.
function compact(data, brand) {
  const g = (data && data.gsc) || {};
  const t = g.totals || {};
  const ga = (data && data.ga4) || {};
  const org = ga.totalsOrganic || {};

  const topQueries = (g.queries || []).slice(0, 8).map((q) => ({
    query: q.entity || q.query,
    clicks: q.clicks != null ? q.clicks : (q.r && q.r.clicks),
    clicksChange: q.clicksDelta != null ? q.clicksDelta : null,
  }));
  const topPages = (g.pages || []).slice(0, 8).map((p) => ({
    page: p.entity || p.page,
    clicks: p.clicks != null ? p.clicks : (p.r && p.r.clicks),
  }));

  return {
    brand: brand ? brand.name : null,
    vertical: (brand && brand.vertical) || null,
    week: data && data.window ? data.window : null,
    searchConsole: {
      clicks: metric(t.clicks) || t.clicks,
      impressions: metric(t.impressions) || t.impressions,
      ctr: metric(t.ctr) || t.ctr,
      averagePosition: metric(t.position) || t.position,
    },
    organicSessions: metric(org.sessions) || org.sessions || null,
    organicConversions: metric(org.conversions) || org.conversions || null,
    topQueries,
    topPages,
    // Named explicitly so the model can say "not available" instead of
    // silently omitting a section the client expects every week.
    missing: {
      searchConsole: !g.totals,
      analytics: !ga.totalsOrganic,
    },
  };
}

function available() {
  return Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY_A);
}

async function draft(brand, report) {
  const data = report && report.data;
  if (!data) throw new Error('This report has no stored figures to write about.');

  const payload = compact(data, brand);
  const { data: out, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'report-commentary',
    brandId: brand ? brand.id : null,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(payload),
    maxTokens: 900,
    // Slightly warmer than the extraction features: this is prose a person
    // reads, and 0.2 produces the same four sentences every week.
    temperature: 0.4,
  });

  const text = String((out && out.commentary) || '').trim();
  if (!text) throw new Error('The model returned an empty commentary.');
  return { text, promptTokens, completionTokens, costUsd };
}

module.exports = { draft, compact, available, SYSTEM_PROMPT };
