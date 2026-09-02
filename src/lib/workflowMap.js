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

  // ---------------------------------------------------------------------
  // AI-era work.
  //
  // These jobs are absent from the original process map because the surfaces
  // they serve — AI Overviews, ChatGPT, Perplexity, Gemini — did not send
  // traffic when it was written. They are recorded with the same honesty as
  // the rest: what the suite measures, and what it cannot measure without a
  // credential this deployment does not hold.
  // ---------------------------------------------------------------------
  {
    id: 'ai-prompt-research',
    task: 'AI-assistant prompt research',
    description: 'Work out what people type into ChatGPT, Perplexity and Gemini when they have the need a brand serves — whole questions with a stated situation, not keywords — and decide what a page must contain to be cited in the answer.',
    tools: ['Manual experimentation in each assistant', 'Guesswork'],
    frequency: 'quarterly',
    timePerRun: '4-6 hours per brand, and rarely done at all',
    people: ['SEO Strategist'],
    inputs: ['Seed topics', 'Audience knowledge'],
    outputs: ['Prompt list grouped by the job the user is doing', 'Content angles'],
    status: 'assisted',
    automatedBy: 'Keyword & prompt research — Search Console queries and Google autocomplete for the search-box side, the AI model for the prompt side, clustered by intent. No search volume is shown for anything Search Console does not measure, because no keyword-tool credential exists here.',
    savedPerMonth: 1.5,
  },
  {
    id: 'ai-crawler-readiness',
    task: 'AI crawler access verification',
    description: 'Confirm each AI crawler can reach and read the site, separating training crawlers — whose blocking costs nothing — from retrieval fetchers, whose blocking removes the brand from that assistant\'s answers entirely.',
    tools: ['Reading robots.txt by hand', 'aicrawlercheck.com'],
    frequency: 'monthly',
    timePerRun: '1 hour per brand, and robots.txt alone gives the wrong answer',
    people: ['SEO Executive'],
    inputs: ['Site URL'],
    outputs: ['Per-agent access list', 'Escalation to whoever owns the CDN'],
    status: 'automated',
    automatedBy: 'AI-crawler readiness — checks robots.txt per agent AND requests the page as each agent, which is the only way to see an edge block. On the first site tested, robots.txt allowed every agent while the server answered four retrieval fetchers with HTTP 403.',
    savedPerMonth: 1,
  },
  {
    id: 'citability-review',
    task: 'On-page review for AI citability',
    description: 'Judge whether an answer engine can lift a passage from a page and attribute it: self-contained paragraphs, structured blocks, concrete figures, a visible date, valid schema.',
    tools: ['Reading the page and forming a view'],
    frequency: 'adhoc',
    timePerRun: '45 minutes per page',
    people: ['SEO Executive', 'Content Writer'],
    inputs: ['Page URL or draft', 'Target term'],
    outputs: ['Edit list'],
    status: 'assisted',
    automatedBy: 'On-page score — measures semantic coverage against a named comparison set, readability, entity density and citability locally, then asks the model for edits anchored to those measured gaps. Works on a pasted draft as well as a live URL.',
    savedPerMonth: 4,
  },
  {
    id: 'schema-maintenance',
    task: 'Structured data authoring and validation',
    description: 'Write and validate JSON-LD per page type, and keep the organisation-level facts consistent everywhere they appear.',
    tools: ['Google Rich Results Test', 'Schema Markup Validator', 'Hand-written JSON-LD'],
    frequency: 'monthly',
    timePerRun: '2 hours per brand',
    people: ['SEO Executive', 'Developer'],
    inputs: ['Page content', 'Brand facts'],
    outputs: ['JSON-LD blocks', 'Validation report'],
    status: 'assisted',
    automatedBy: 'Schema & structured data — validates against per-type requirement tables transcribed from Google documentation, keeping its required/recommended distinction, and generates blocks from what is visibly on the page. Fields it cannot read stay null and are listed as needing human input rather than being invented.',
    savedPerMonth: 1.5,
  },
  {
    id: 'brand-facts-hub',
    task: 'Canonical brand facts for AI engines',
    description: 'Write down, once, what the company is, who it serves, where it operates, what it charges and how it is accredited, so an assistant asked about the brand has something verifiable to read.',
    tools: ['Scattered across the About page, a deck, and somebody\'s memory'],
    frequency: 'quarterly',
    timePerRun: '3 hours, and it drifts out of date immediately',
    people: ['Account Manager', 'SEO Strategist'],
    inputs: ['Business information'],
    outputs: ['About page copy', 'llms.txt', 'Organization schema'],
    status: 'assisted',
    automatedBy: 'Brand hub — one fact set renders into llms.txt, the Organization block and a completeness checklist, so the three cannot disagree. States plainly that llms.txt is not a ranking factor and that Google does not use it.',
    savedPerMonth: 1,
  },
  {
    id: 'ambient-signals',
    task: 'Third-party brand mention monitoring',
    description: 'Watch the forums, news and discussion an assistant weighs when asked whether a brand can be trusted, and correct damaging claims before they become the standard answer.',
    tools: ['Occasional manual searching', 'Google Alerts'],
    frequency: 'weekly',
    timePerRun: '1 hour per brand, inconsistently',
    people: ['Account Manager'],
    inputs: ['Brand and product names'],
    outputs: ['Escalation when something is spotted'],
    status: 'assisted',
    automatedBy: 'Reputation & ambient signals — scans Hacker News and Google/Bing News, and Reddit where a free API credential is configured; classifies sentiment with a local lexicon; asks the model to triage only the mentions carrying a damaging factual claim. A failing source is reported rather than presenting as "no mentions".',
    savedPerMonth: 3,
  },
  {
    id: 'intent-drift',
    task: 'Content freshness and intent-drift review',
    description: 'Find pages losing ground faster than the site, and pages whose topic is unchanged while the question being asked of it has moved.',
    tools: ['Reading Search Console query reports page by page'],
    frequency: 'quarterly',
    timePerRun: '5 hours per brand, and drift is close to undetectable by eye',
    people: ['SEO Strategist'],
    inputs: ['GSC query-by-page data', 'Publication dates'],
    outputs: ['Refresh list with due dates'],
    status: 'assisted',
    automatedBy: 'Freshness & intent drift — decay measured relative to the whole site, so a sitewide fall does not file forty page-level tasks; drift measured as Jensen-Shannon divergence over the query mix between two snapshots. Flagged pages become dated tasks staggered across the weeks ahead.',
    savedPerMonth: 3,
  },
  {
    id: 'competitor-crawl',
    task: 'Competitor content and structure analysis',
    description: 'Work out what competitors publish that the brand does not, how fast they publish, and what their internal anchor text reveals about their priorities.',
    tools: ['Semrush', 'Ahrefs', 'Manual browsing'],
    frequency: 'quarterly',
    timePerRun: '6 hours per brand',
    people: ['SEO Strategist'],
    inputs: ['Competitor domains'],
    outputs: ['Gap list', 'Content plan'],
    status: 'assisted',
    automatedBy: 'Competitive intelligence — crawls named competitors for topic coverage, sections, schema, author signals, AI-retrieval posture and internal anchor patterns, then cross-references the gaps against queries this site already earns impressions for. Backlink profiles, competitor rankings and traffic estimates are NOT covered: those need a paid credential, and the report says so on the page rather than estimating them.',
    savedPerMonth: 4,
  },
  {
    id: 'seo-tracking-board',
    task: 'Ongoing technical tracking',
    description: 'Keep a standing watch on crawl errors, index coverage, Core Web Vitals, TTFB, SSL expiry, redirect chains, canonicals, titles, headings, content quality, internal links, images, URL structure, schema, JavaScript rendering, mobile usability and AI crawler access.',
    tools: ['Several dashboards, checked at different intervals by different people'],
    frequency: 'weekly',
    timePerRun: '2 hours per brand across all the tools',
    people: ['SEO Executive'],
    inputs: ['Site URL', 'Search Console', 'PageSpeed'],
    outputs: ['Regression list'],
    status: 'automated',
    automatedBy: 'Tracking board — twenty checks on one board, each storing a value AND a verdict per capture, so "did something break" is answerable rather than only "what is it now". A check that cannot measure returns unknown, never good, and unknown metrics are excluded from the score on both sides of the ratio.',
    savedPerMonth: 6,
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
    blockers: 'Needs SERP data for competitor coverage and the questions-to-answer section. Clustering already supplies intent, supporting keywords and page type. Partly unblocked by the AI SEO suite: the on-page scorer derives competitor coverage by crawling named competitor pages, and prompt research supplies the questions — both without SERP data, and both narrower than a real SERP would give.',
  },
  {
    rank: 10, item: 'Rank tracker import', value: 'medium', effort: 'low',
    status: 'next',
    rationale: 'Search Console position is a blended national average, so genuine ranking movement at a fixed location/device is currently invisible.',
    blockers: 'Needs the rank tracking platform\'s API credentials or a scheduled CSV export.',
  },
  {
    rank: 11, item: 'Competitor gap analysis', value: 'medium', effort: 'high',
    status: 'done',
    rationale: 'Finds topics with proven demand that the brand does not address at all.',
    delivered: 'Delivered by crawling named competitors rather than by buying keyword data: topic and entity coverage, site sections, publishing velocity, schema and author signals, AI-retrieval posture, and internal anchor patterns — cross-referenced against queries this site already earns impressions for.',
    caveat: 'Narrower than the original intent, and the page says so. Search Console still cannot report queries the site never appeared for, so a keyword-tool credential would genuinely add coverage. What was built needs no credential and invents nothing.',
  },
  {
    rank: 15, item: 'AI-crawler readiness and retrieval access', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'A blocked retrieval fetcher removes the brand from an assistant\'s answers entirely, and the usual cause is an edge rule nobody knows about — invisible in robots.txt and invisible in a browser.',
    delivered: 'Per-agent verdicts from robots.txt AND a live request as each agent, with training and retrieval crawlers reported separately because blocking them means opposite things. Alerting on a blocked retrieval fetcher, and on content that only exists once JavaScript has run.',
  },
  {
    rank: 16, item: 'On-page scoring for AI citability', value: 'high', effort: 'high',
    status: 'done',
    rationale: 'Ranking well and being citable are different properties, and nothing in the suite measured the second one.',
    delivered: 'Semantic coverage against a named comparison set, readability, entity density, and a citability score decomposed into countable signals — all computed locally, so a score is stable and explainable — plus model-written edits anchored to the measured gaps.',
    caveat: 'The comparison set is pasted URLs or the best-matching page on each named competitor domain, not the live top 10. There is no SERP credential here, and scraping Google would degrade silently to comparing against nothing. A DataForSEO credential would make it a true top-10 comparison.',
  },
  {
    rank: 17, item: 'Structured-data validation and generation', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'Invalid markup earns no rich result at all, and a JSON-LD block that does not parse is completely invisible while looking present in the page source.',
    delivered: 'Per-type requirement tables from Google documentation keeping the required/recommended distinction, @graph traversal, and generation from visible page content with unreadable fields left null and listed as needing input.',
  },
  {
    rank: 18, item: 'Intent-drift detection', value: 'high', effort: 'medium',
    status: 'done',
    rationale: 'The failure nothing else catches: the topic is still right, the question has changed, and traffic falls too slowly to cross any threshold.',
    delivered: 'Jensen-Shannon divergence over the impression-weighted query mix between two Search Console snapshots, reported with the gained and lost query lists that name the new question, and refresh tasks staggered across the weeks ahead by stated weekly capacity.',
  },
  {
    rank: 19, item: 'Ambient brand-signal monitoring', value: 'medium', effort: 'medium',
    status: 'done',
    rationale: 'An assistant asked whether a brand is credible weights third-party discussion heavily, because it is the part the brand did not write.',
    delivered: 'Hacker News and Google/Bing News scanning with lexicon sentiment and risk-pattern detection, model triage limited to mentions carrying a damaging factual claim, and per-source failures reported rather than presenting as silence.',
    caveat: 'Reddit — the most valuable source — now blocks keyless server-side search; the authenticated path is implemented and needs a free Reddit app credential. Trustpilot, G2 and the social networks have no keyless search endpoint and are deliberately not scraped: a scrape that starts returning nothing is indistinguishable from "no new reviews".',
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
  // Rough total of the manual effort the map describes.
  //
  // `timePerRun` is prose ("3–4 hours per brand", "45 minutes per page",
  // "Automated in the existing tool; 30 min/week to read"), so the UNIT has to
  // be read as well as the number. Taking the leading digits alone treated
  // "30 min/week" on a daily task as 30 hours × 22 runs = 660 hours a month,
  // which pushed the displayed total to 773 hours per brand — an obviously
  // impossible figure that nonetheless rendered on the workflow page.
  //
  // Where a line states its own cadence ("30 min/week"), that cadence wins:
  // the task's `frequency` describes how often the WORK happens, which for an
  // already-automated tool is not how often a person spends time on it.
  const parseEffortHours = (text) => {
    const s = String(text || '');
    const m = /(\d+(?:\.\d+)?)\s*(?:–|-|to)?\s*(\d+(?:\.\d+)?)?\s*(hours?|hrs?|minutes?|mins?|min)\b/i.exec(s);
    if (!m) return { hours: 0, cadenceOverride: null };
    // A range ("3–4 hours") is read at its lower bound, so the total is a floor
    // rather than a flattering estimate.
    const value = Number(m[1]);
    const isMinutes = /^m/i.test(m[3]);
    const hours = isMinutes ? value / 60 : value;
    const cadence = /\/\s*week|per\s+week|a\s+week/i.test(s) ? 4.3
      : (/\/\s*month|per\s+month|a\s+month/i.test(s) ? 1
        : (/\/\s*day|per\s+day|a\s+day/i.test(s) ? 22 : null));
    return { hours, cadenceOverride: cadence };
  };

  const RUNS_PER_MONTH = { daily: 22, weekly: 4.3, fortnightly: 2.2, monthly: 1, quarterly: 0.33, adhoc: 1 };
  const totalManualHours = TASKS.reduce((a, t) => {
    const { hours, cadenceOverride } = parseEffortHours(t.timePerRun);
    const runsPerMonth = cadenceOverride != null ? cadenceOverride : (RUNS_PER_MONTH[t.frequency] || 1);
    return a + (hours * runsPerMonth);
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
