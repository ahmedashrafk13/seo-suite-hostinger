// SEO PROCESS MAP AND AUTOMATION BACKLOG
//
// Deliverable 1 of the plan: a written map of the current SEO workflow, and a
// prioritised backlog of what to automate. Held as structured data rather than
// a static document so the app can render it, export it, and — importantly —
// show live status against each item (what this build already automates, what
// is still manual, and what must stay manual by policy).
//
// `status` values:
//   automated       this suite does it now, no human needed to produce it
//   assisted        the suite produces the analysis; a human decides/executes
//   manual          still done by hand; on the backlog
//   policy_manual   deliberately kept manual — the operating rule forbids
//                   automating the change itself

const FREQUENCIES = {
  daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly',
  monthly: 'Monthly', quarterly: 'Quarterly', adhoc: 'Ad hoc / on request',
};

// ---------------------------------------------------------------- the map
const TASKS = [
  {
    id: 'tech-audit',
    task: 'Technical site audit',
    description: 'Crawl each brand site for broken links, duplicate or missing titles and meta descriptions, missing/multiple H1s, redirect chains, non-indexable pages, canonical problems, missing image alt text, slow pages, orphan indicators, and sitemap/robots issues.',
    tools: ['Screaming Frog', 'Semrush Site Audit', 'Manual browser checks'],
    frequency: 'monthly',
    timePerRun: '3–4 hours per brand',
    people: ['SEO Executive'],
    inputs: ['Site URL', 'Crawl configuration'],
    outputs: ['Issue spreadsheet', 'Prioritised fix list for the dev team'],
    status: 'automated',
    automatedBy: 'Technical audit — wraps webtechstackdetector, normalises every finding to severity + affected URL + issue type + recommended action, and opens a task per failing check.',
    savedPerMonth: 3.5,
  },
  {
    id: 'rank-report',
    task: 'Ranking and traffic reporting',
    description: 'Pull clicks, impressions, CTR and average position from Search Console; pull organic sessions and conversions from GA4; compare against the prior period; assemble a client-facing weekly summary.',
    tools: ['Search Console', 'GA4', 'Google Sheets', 'Looker Studio'],
    frequency: 'weekly',
    timePerRun: '2 hours per brand',
    people: ['SEO Executive', 'Account Manager'],
    inputs: ['GSC export', 'GA4 export', 'Rank tracker export'],
    outputs: ['Weekly client report', 'Internal performance deck'],
    status: 'automated',
    automatedBy: 'Weekly reports — generated per brand every Monday from the consolidated tables, covering traffic, rankings, top gainers/decliners, landing pages, conversions, technical issues, work completed and next actions.',
    savedPerMonth: 8,
  },
  {
    id: 'traffic-monitoring',
    task: 'Traffic and ranking drop monitoring',
    description: 'Spot organic traffic falls, keyword ranking declines, deindexed pages, 404 spikes, downtime and Core Web Vitals regressions before the client notices.',
    tools: ['Search Console (manual checks)', 'Ad-hoc spreadsheet review'],
    frequency: 'weekly',
    timePerRun: '1.5 hours per brand, and usually too late',
    people: ['SEO Executive'],
    inputs: ['GSC performance report'],
    outputs: ['Escalation email when something is noticed'],
    status: 'automated',
    automatedBy: 'Alerts — 40 alert types across Search Console, GA4, PageSpeed/CrUX, uptime and crawl output. Each is opt-in per brand with its own threshold, window, cadence and channel, and can open a task automatically.',
    savedPerMonth: 6,
  },
  {
    id: 'keyword-research',
    task: 'Keyword research and grouping',
    description: 'Gather keywords, group them into topics, judge search intent, decide the page type each cluster needs, and decide whether an existing page should be improved or a new page created.',
    tools: ['Semrush', 'Ahrefs', 'Google Sheets', 'Manual sorting'],
    frequency: 'quarterly',
    timePerRun: '6–8 hours per brand',
    people: ['SEO Strategist', 'Content Lead'],
    inputs: ['Seed keyword list', 'Competitor keyword export'],
    outputs: ['Keyword cluster sheet', 'Content plan'],
    status: 'assisted',
    automatedBy: 'Keyword clustering — clusters a pasted list or the brand\'s own Search Console queries, assigns intent and page type, and recommends improve-existing vs create-new by checking which URL already owns each cluster. A strategist still signs off the plan.',
    savedPerMonth: 2,
  },
  {
    id: 'internal-linking',
    task: 'Internal linking audit',
    description: 'Find orphan and under-linked pages, identify semantically related pages, choose natural anchor text, and avoid linking pages that compete for the same keyword.',
    tools: ['Screaming Frog', 'Manual content review'],
    frequency: 'quarterly',
    timePerRun: '5–6 hours per brand',
    people: ['SEO Executive', 'Content Editor'],
    inputs: ['Full site crawl', 'Target page list'],
    outputs: ['Link insertion list with source, target and anchor'],
    status: 'assisted',
    automatedBy: 'Internal linking — wraps the internal linking agent, blends the brand\'s Search Console page data, and renders all five CSVs as filterable tables. Anchor text is quoted verbatim from the source page, so nothing has to be invented.',
    savedPerMonth: 2,
  },
  {
    id: 'content-opportunity',
    task: 'Content opportunity identification',
    description: 'Find keywords with high impressions and low CTR, keywords sitting in positions 4–20, pages whose performance is declining, and pages due a refresh.',
    tools: ['Search Console', 'Google Sheets pivot tables'],
    frequency: 'monthly',
    timePerRun: '3 hours per brand',
    people: ['SEO Strategist'],
    inputs: ['GSC query and page exports'],
    outputs: ['Content opportunity list'],
    status: 'automated',
    automatedBy: 'Opportunities — six detectors (CTR gap, striking distance, declining, decay/refresh, new-page, cannibalisation), each scored by estimated click upside so the backlog is ordered by expected gain.',
    savedPerMonth: 3,
  },
  {
    id: 'task-creation',
    task: 'Turning findings into assigned work',
    description: 'Read the audits and reports, decide what actually needs doing, write it up as a ticket, assign it and chase it.',
    tools: ['Trello / Asana', 'Email', 'Spreadsheets'],
    frequency: 'weekly',
    timePerRun: '2 hours per brand',
    people: ['SEO Lead', 'Account Manager'],
    inputs: ['Audit output', 'Alert emails', 'Report findings'],
    outputs: ['Assigned tickets with owners and due dates'],
    status: 'automated',
    automatedBy: 'Tasks — every alert, audit finding, linking finding, cluster and opportunity opens a deduplicated task carrying its own evidence. Board and table views, assignment, due dates, and an approval gate on restricted changes.',
    savedPerMonth: 6,
  },
  {
    id: 'cwv',
    task: 'Core Web Vitals monitoring',
    description: 'Measure LCP, INP and CLS per brand and track regressions after deployments.',
    tools: ['PageSpeed Insights (manual)', 'Chrome DevTools'],
    frequency: 'monthly',
    timePerRun: '1 hour per brand',
    people: ['SEO Executive', 'Front-end developer'],
    inputs: ['Key page URLs'],
    outputs: ['Performance findings for the dev team'],
    status: 'automated',
    automatedBy: 'PageSpeed snapshots on sync, preferring real-user CrUX field data over lab numbers, with LCP/INP/CLS and score-drop alerts.',
    savedPerMonth: 1,
  },
  {
    id: 'content-brief',
    task: 'Content brief writing',
    description: 'For an approved keyword: intent, recommended title, headings, supporting keywords, questions to answer, competitor coverage, word count, internal links, relevant services, and the call to action.',
    tools: ['Google Docs', 'Manual SERP review'],
    frequency: 'weekly',
    timePerRun: '2–3 hours per brief',
    people: ['SEO Strategist', 'Content Writer'],
    inputs: ['Approved target keyword', 'Competitor URLs'],
    outputs: ['Content brief document'],
    status: 'manual',
    backlogNote: 'Phase 2. The clustering output already supplies intent, supporting keywords and page type, which is roughly half a brief. Competitor coverage and the questions-to-answer section need SERP data this build does not yet pull.',
    savedPerMonth: 0,
  },
  {
    id: 'competitor',
    task: 'Competitor gap analysis',
    description: 'Identify topics competitors rank for that the brand does not cover at all.',
    tools: ['Semrush', 'Ahrefs'],
    frequency: 'quarterly',
    timePerRun: '4 hours per brand',
    people: ['SEO Strategist'],
    inputs: ['Competitor domain list'],
    outputs: ['Content gap list'],
    status: 'manual',
    backlogNote: 'Phase 2. Needs a third-party keyword API (Semrush, Ahrefs or DataForSEO) — Search Console only reports queries the brand already appears for, so a true gap cannot be derived from it.',
    savedPerMonth: 0,
  },
  {
    id: 'backlinks',
    task: 'Backlink monitoring',
    description: 'Track referring domains, new and lost links, and toxic link risk.',
    tools: ['Ahrefs', 'Semrush'],
    frequency: 'monthly',
    timePerRun: '2 hours per brand',
    people: ['SEO Executive'],
    inputs: ['Domain'],
    outputs: ['Backlink change report'],
    status: 'manual',
    backlogNote: 'Phase 2. Requires a backlink data provider; no Google API exposes this.',
    savedPerMonth: 0,
  },
  {
    id: 'rank-tracking',
    task: 'Dedicated rank tracking',
    description: 'Track a defined keyword set at a fixed location and device on a daily basis.',
    tools: ['AccuRanker / SERanking'],
    frequency: 'daily',
    timePerRun: 'Automated in the existing tool; 30 min/week to read',
    people: ['SEO Executive'],
    inputs: ['Tracked keyword list'],
    outputs: ['Ranking trend charts'],
    status: 'manual',
    backlogNote: 'Search Console average position is a blended national figure across devices, so it is not a substitute for true rank tracking. Next step is importing the rank tracker\'s CSV/API export into the consolidated tables so alerts can read it alongside GSC.',
    savedPerMonth: 0,
  },
];

// --------------------------------------------------- the approval boundary
// Restated here so the process document and the enforcement code cannot drift
// apart — tasks.js APPROVAL_RULES implements exactly this list.
const APPROVAL_BOUNDARY = [
  { action: 'Publishing content', why: 'A published page is public immediately and can cannibalise or mis-target existing pages. Editorial judgement is required.' },
  { action: 'Changing URLs', why: 'A URL change discards accumulated ranking signals unless redirects are handled precisely.' },
  { action: 'Editing canonical tags', why: 'A wrong canonical can deindex a page that was ranking well, and the damage is not obvious for weeks.' },
  { action: 'Updating robots.txt', why: 'A single mistaken Disallow line can remove an entire site section from the index.' },
  { action: 'Removing or redirecting pages', why: 'Irreversible in practice, and easy to get wrong when a page still holds links or rankings.' },
  { action: 'Adding large volumes of internal links', why: 'Bulk link insertion changes site architecture and can look manipulative if done without editorial care.' },
  { action: 'Changing titles on high-performing pages', why: 'Titles on pages that already rank well are a known quantity; an untested rewrite risks CTR that is already working.' },
];

// ------------------------------------------------------ automation backlog
// Prioritised. `value` and `effort` drive the ordering shown in the UI.
const BACKLOG = [
  {
    rank: 1, item: 'Centralised GSC + GA4 data consolidation', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'Everything else depends on it. Until one store held brand-wise and URL-wise data, every report and alert meant a fresh manual export.',
    delivered: 'Brand-keyed tables for GSC daily/page/query/query×page, GA4 daily and landing pages, PageSpeed snapshots and uptime checks, with a nightly sync.',
  },
  {
    rank: 2, item: 'Automated technical audit with severity and recommended action', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'The single largest recurring manual cost, and the one most prone to being skipped under deadline pressure.',
    delivered: 'Scheduled/on-demand crawl covering all twelve required checks, normalised to severity + affected URL + issue type + action, exportable as CSV, with tasks opened automatically.',
  },
  {
    rank: 3, item: 'Configurable alerting across every available signal', value: 'high', effort: 'high',
    status: 'done',
    rationale: 'Detection latency was the real problem: drops were being found during monthly reporting, weeks after they happened.',
    delivered: '40 alert types, each opt-in per brand with its own threshold, comparison window, cadence, severity and channel (email, Slack, or webhook for WhatsApp relays).',
  },
  {
    rank: 4, item: 'Automated weekly reporting per brand', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'Roughly 8 hours a month per brand spent assembling numbers that already exist in the consolidated store.',
    delivered: 'Monday generation covering traffic, impressions/clicks, rankings, top gainers and decliners, landing pages, conversions, technical issues, work completed and next actions.',
  },
  {
    rank: 5, item: 'Task creation and tracking with an approval gate', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'Analysis without assigned ownership does not change rankings. The gate is what makes automation safe to run unattended.',
    delivered: 'Deduplicated tasks from every source, board and table views, assignment and due dates, and a hard block on completing restricted changes without sign-off.',
  },
  {
    rank: 6, item: 'Keyword clustering with intent and page-type recommendation', value: 'medium', effort: 'medium',
    status: 'done',
    rationale: 'Quarterly research was the largest single block of strategist time.',
    delivered: 'Clustering over pasted lists or the brand\'s own Search Console queries, with intent classification, page-type suggestion, and improve-existing vs create-new resolved against real ranking data.',
  },
  {
    rank: 7, item: 'Content opportunity detection', value: 'high', effort: 'low',
    status: 'done',
    rationale: 'The highest-return analysis available, and cheap once consolidated data exists.',
    delivered: 'Six scored detectors, each promoting to the backlog with the numbers that justify it.',
  },
  {
    rank: 8, item: 'Internal linking recommendations surfaced in the UI', value: 'medium', effort: 'low',
    status: 'done',
    rationale: 'The agent already produced good CSVs, but nobody read files sitting in a folder.',
    delivered: 'All five CSVs rendered as searchable, sortable, filterable tables with raw download retained.',
  },
  {
    rank: 9, item: 'Content Brief Agent', value: 'high', effort: 'high',
    status: 'next',
    rationale: '2–3 hours per brief, and briefs are the bottleneck between an approved keyword and published content.',
    blockers: 'Needs SERP data for competitor coverage and the questions-to-answer section. Clustering already supplies intent, supporting keywords and page type.',
  },
  {
    rank: 10, item: 'Rank tracker import', value: 'medium', effort: 'low',
    status: 'next',
    rationale: 'Search Console position is a blended national average, so genuine ranking movement at a fixed location/device is currently invisible.',
    blockers: 'Needs the rank tracking platform\'s API credentials or a scheduled CSV export.',
  },
  {
    rank: 11, item: 'Competitor gap analysis', value: 'medium', effort: 'high',
    status: 'later',
    rationale: 'Finds topics with proven demand that the brand does not address at all.',
    blockers: 'Requires a third-party keyword API. Search Console cannot report queries the site never appeared for.',
  },
  {
    rank: 12, item: 'Backlink monitoring and toxic link alerts', value: 'medium', effort: 'medium',
    status: 'later',
    rationale: 'Lost links are a common, and commonly missed, cause of ranking decline.',
    blockers: 'Requires a backlink data provider.',
  },
  {
    rank: 13, item: 'Lead and conversion attribution beyond GA4 events', value: 'medium', effort: 'medium',
    status: 'later',
    rationale: 'Tying organic performance to actual pipeline is what makes the reporting persuasive to a client.',
    blockers: 'Needs CRM access and an agreed definition of a qualified lead per brand.',
  },
  {
    rank: 14, item: 'SEO Task Manager Agent (autonomous prioritisation)', value: 'medium', effort: 'high',
    status: 'later',
    rationale: 'The natural end state: read all signals and maintain the backlog without prompting.',
    blockers: 'Deliberately last. It should only be built once the underlying data, alerting and task systems have been stable long enough to trust their output.',
  },
];

function summary() {
  const byStatus = (s) => TASKS.filter((t) => t.status === s);
  const hoursSaved = TASKS.reduce((a, t) => a + (t.savedPerMonth || 0), 0);
  const totalManualHours = TASKS.reduce((a, t) => {
    // Parse the leading number out of "3–4 hours per brand" for a rough total.
    const m = String(t.timePerRun).match(/(\d+(?:\.\d+)?)/);
    const per = m ? Number(m[1]) : 0;
    const runsPerMonth = { daily: 22, weekly: 4.3, fortnightly: 2.2, monthly: 1, quarterly: 0.33, adhoc: 1 }[t.frequency] || 1;
    return a + per * runsPerMonth;
  }, 0);

  return {
    totalTasks: TASKS.length,
    automated: byStatus('automated').length,
    assisted: byStatus('assisted').length,
    manual: byStatus('manual').length,
    hoursSavedPerMonthPerBrand: Math.round(hoursSaved * 10) / 10,
    estimatedManualHoursPerMonthPerBrand: Math.round(totalManualHours),
    backlogDone: BACKLOG.filter((b) => b.status === 'done').length,
    backlogNext: BACKLOG.filter((b) => b.status === 'next').length,
    backlogLater: BACKLOG.filter((b) => b.status === 'later').length,
  };
}

module.exports = { TASKS, BACKLOG, APPROVAL_BOUNDARY, FREQUENCIES, summary };
