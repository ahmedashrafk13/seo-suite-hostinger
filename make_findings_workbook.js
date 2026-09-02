// Builds the requirements-and-fixes deliverable for the SEO team.
//
//   node make_findings_workbook.js
//   -> reports/ai-seo-requirements-and-fixes.xlsx   (the deliverable)
//   -> reports/ai-seo-requirements-and-fixes.csv    (same data, flat)
//
// THE SHAPE, AND WHY IT CHANGED
// The first version of this had one row per TOOL, which meant a feature area
// with five separate requirements became one cell holding five paragraphs. That
// is precisely the failure src/lib/xlsxExport.js exists to prevent — "a plain
// CSV with a multi-line blob crammed into one cell" — and it is unreadable in
// Excel: no filtering, no sorting, no per-item status, and a row height of
// forty lines.
//
// So the data is NORMALISED: one row per individual requirement, each with its
// own id, status and owner-readable summary. The long-form explanation lives on
// its own sheet keyed by the same id, split into problem / solution / caveat,
// so someone scanning the main sheet is never forced to read three paragraphs
// to find out whether an item is done.
//
// Styling follows the app's own convention (src/lib/xlsxExport.js): dark navy
// header, white bold text, frozen header row. Added here on top of that:
// wrapped body text with computed row heights, banded rows, borders, an
// autofilter, and a status column with dropdown validation.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F8' } };
const BORDER = { style: 'thin', color: { argb: 'FFD6DBE3' } };
const GROUP_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF3' } };

const STATUSES = ['Done', 'Done — new feature', 'Done — bug fixed', 'No change needed'];

// =========================================================================
// THE DATA — one entry per individual requirement
// =========================================================================
//
// `summary` is the scannable cell: what was built, in one or two sentences.
// `problem` / `solution` / `caveat` are the long-form fields on the Detail
// sheet. Keeping them apart is what stops the main sheet becoming a wall.

const R = [
  // ---------------------------------------------------- keyword research
  {
    id: '1.1',
    tool: 'Keyword Research & Prompt',
    requirement: 'Missing keyword suggestions based on Google data',
    status: 'Done',
    summary: 'Autocomplete expansion now adds an alphabet sweep ("term a", "term b"…) and a second suggestion index. Request budget raised from 90 to 200 per run to pay for it.',
    where: '/ai-seo/research',
    modules: 'research.js, serpLite.js',
    problem: 'Expansion used one source — Google autocomplete with a fixed modifier list — so it only ever returned completions of phrases someone had already thought of.',
    solution: 'Two additions. (1) An alphabet sweep of up to 12 letters per seed, which is where the long-tail phrasings no modifier list can anticipate come from — it is the technique behind every keyword tool\'s long tail and it is free. (2) A second suggestion index, from Bing\'s keyless OpenSearch endpoint, which returns a genuinely different list.',
    caveat: 'This was originally built to scrape the "related searches" block off a result page. Verified against both live endpoints, NEITHER SERVES ONE — so that approach would have returned an empty list forever while looking like a measurement. The second index was used instead, and verified additive: on the same seed, all 6 Bing suggestions were absent from Google\'s 15.',
  },
  {
    id: '1.2',
    tool: 'Keyword Research & Prompt',
    requirement: 'Search volume',
    status: 'Done',
    summary: 'New adapter chain: Google Ads Keyword Planner → DataForSEO → Semrush. Every value is labelled with the source that produced it. With no credential, Search Console impressions and Trends relative interest are shown in their own columns instead.',
    where: '/ai-seo/research',
    modules: 'keywordMetrics.js (new), providers.js',
    problem: 'No volume at all. The platform had no keyword-tool credential, and its rule against inventing numbers had been implemented as "omit the feature", which left three genuinely available sources unused.',
    solution: 'A four-rung chain, tried best-first, with the rung recorded on every value. GOOGLE ADS IS THE HEADLINE ADDITION: it reuses the Google OAuth the app already holds, so the only missing pieces are a free developer token and a customer id — Google\'s own volumes, per country, with no new subscription.',
    caveat: 'The no-invention rule is unchanged. With no credential an em dash means unknown and never zero, and Trends relative interest sits in its OWN column under its own heading because it is the shape of demand, not its size.',
  },
  {
    id: '1.3',
    tool: 'Keyword Research & Prompt',
    requirement: 'Add country filter for volume',
    status: 'Done — new feature',
    summary: 'Country selector on the research form, threaded through autocomplete, Trends, the result sample and every paid adapter. 40 markets.',
    where: '/ai-seo/research',
    modules: 'markets.js (new)',
    problem: 'No country concept existed anywhere, so every figure was implicitly worldwide.',
    solution: 'A market registry where each country carries every identifier its consumers expect: Google gl/hl, Trends geo, DuckDuckGo kl, Bing cc, DataForSEO location_code, Semrush database.',
    caveat: 'This needed a table rather than a single parameter because the identifiers genuinely differ — the UK is gl=gb, geo=GB, kl=uk-en, location_code=2826. Passing the wrong one silently returns WORLDWIDE data labelled as a country, which is the worst failure available here.',
  },
  {
    id: '1.4',
    tool: 'Keyword Research & Prompt',
    requirement: 'Keyword difficulty',
    status: 'Done',
    summary: 'Vendor KD where a credential exists; otherwise computed from a live result-page sample with the formula and every component shown. Difficulty now also scales keyword priority, and a new "winnable keywords" finding surfaces low-difficulty demand.',
    where: '/ai-seo/research',
    modules: 'keywordMetrics.js, serpLite.js',
    problem: 'No difficulty figure of any kind.',
    solution: 'difficulty = 20 + 45×authorityShare + 25×exactTitleMatchShare + 15×homepageShare − 20×ugcShare, clamped 5–100. Every component is shown against each keyword, so the score can be argued with rather than taken on trust.',
    caveat: 'Labelled "proxy" in every view and never presented as Ahrefs KD — it is computed from a non-Google index. Capped per run (default 12 keywords) because each costs one paced request, and WHAT THE CAP LEFT OUT IS REPORTED rather than left looking blank.',
  },

  // ---------------------------------------------------------- on-page
  {
    id: '2.1',
    tool: 'On Page Score',
    requirement: 'Enforce heading hierarchy checks — flag skipped levels (H5 before H1) and duplicate adjacent tags',
    status: 'Done — new feature',
    summary: 'Eight heading issue classes validated in document order, scored 0–100, feeding the composite score at weight 10, with the WCAG reference where one applies.',
    where: '/ai-seo/optimizer',
    modules: 'headings.js (new), onpage.js',
    problem: 'Heading structure was not checked at all. The scorer read headings for keyword placement and gap analysis but never validated the tree.',
    solution: 'Missing H1 (high severity), multiple H1s, skipped levels including the H5-before-H1 case, H1 not first, duplicate ADJACENT headings at the same level, the same heading text repeated 3+ times, empty heading tags read from the DOM, and headings whose entire text is a generic label.',
    caveat: 'Reported with the reason it matters: a retrieval system chunks a page by its heading tree, so a skipped level means the chunker either flattens the page or attributes a passage to the wrong subject. The same defect fails WCAG 1.3.1 for screen-reader users.',
  },
  {
    id: '2.2',
    tool: 'On Page Score',
    requirement: 'Detect keyword stuffing and repetition',
    status: 'Done — new feature',
    summary: 'Density AND distribution. Target-term density against a 2.8% ceiling, occurrences charted across ten buckets, over-used phrases, duplicated sentences and heading over-optimisation. Applied as a penalty of up to 25 points on the composite score.',
    where: '/ai-seo/optimizer',
    modules: 'headings.js (new), onpage.js',
    problem: 'No repetition check existed.',
    solution: 'Density alone is a bad test — a 300-word page at 2% and a 3,000-word page at 2% are the same number and only one reads as spam — so distribution is measured alongside it and charted.',
    caveat: 'Clustering is judged over a FIFTH of the page, not a tenth. The first implementation used a single-tenth window, and 18 occurrences packed into the opening third spread across three tenths at six each, so no single tenth held half of them and an obviously stuffed block scored as evenly distributed. Regression-tested.',
  },
  {
    id: '2.3',
    tool: 'On Page Score',
    requirement: 'Exclude headers, footers, social links and repeated pricing labels from content analysis to prevent skewed metrics',
    status: 'Done — bug fixed',
    summary: 'All content metrics now run on boilerplate-stripped text: ~60 structural selectors, DOM-level removal of repeated pricing labels, and cross-page template detection. The result page shows the word count metrics were actually computed on.',
    where: '/ai-seo/optimizer',
    modules: 'boilerplate.js (new), onpage.js, competitive.js',
    problem: 'THE LARGEST SOURCE OF SKEW. The parser falls back to <body> when no container holds enough text, so readability, entity density, keyword density and semantic coverage were all being computed over the nav, cookie banner, footer link farm and social row. On a short page that is most of the words, and it moves every ratio.',
    solution: 'Three passes: structural selectors (nav/header/footer/aside/roles/cookie/social/widget/pagination/modal + form controls), DOM-level leaf removal for pricing labels, and cross-page repeated-block detection.',
    caveat: 'Pricing labels had to be removed in the DOM, not on the joined text: a grid renders as <span>From</span><span>$99</span><span>per month</span>, which becomes one run once text nodes are joined, and no line-level rule can take that apart safely. It also NEVER returns an empty body — if stripping would remove everything, the original is kept and the fallback is reported.',
  },
  {
    id: '2.4',
    tool: 'On Page Score',
    requirement: 'Stop flagging competitor-specific names (Starfish, Saint Urbain) and generic buttons (Learn More, Check) as missing semantic entities',
    status: 'Done — bug fixed',
    summary: 'Competitor brand terms are derived from their domains and homepage titles; a ~250-entry generic-UI vocabulary covers buttons, marketing headings and pricing furniture. Everything suppressed is listed with its reason.',
    where: '/ai-seo/optimizer',
    modules: 'boilerplate.js (new), onpage.js',
    problem: 'A competitor\'s brand name is STRUCTURALLY the entity most certain to appear on their pages and not on yours, so it topped every gap list — the report was advising the client to write about their rivals. Generic labels came next for the same reason.',
    solution: 'Brand terms from evidence rather than guesswork: the registrable label of each competitor domain, plus the brand half of their homepage title ("Menu | Saint Urbain" → "Saint Urbain", and the token "Urbain"). Matched on the WHOLE phrase, so "Check" is suppressed and "Check Point Software" is not.',
    caveat: 'The semantic-coverage PERCENTAGE is recomputed on the filtered denominator, so a page is no longer marked down for lacking a rival\'s brand name. The suppressed list is shown on the page — a filter nobody can inspect is a filter nobody can trust.',
  },

  // ----------------------------------------------------------- schema
  {
    id: '3.1',
    tool: 'Schema & structured data',
    requirement: 'Suggesting wrong schema (on a service page, suggesting Product schema)',
    status: 'Done — bug fixed',
    summary: 'A page-type classifier now runs BEFORE anything is generated, using four independent evidence sources. Forbidden types are not generated and the reason is shown. A wrong declared type costs up to 45 points on the schema score.',
    where: '/ai-seo/schema',
    modules: 'pageType.js (new), schemaAuto.js, aiCalls.js',
    problem: 'THE ROOT CAUSE WAS TREATING A PRICE AS EVIDENCE OF A PRODUCT. Generation ran off three narrow signals — a breadcrumb trail, question-shaped headings, and "400+ words in an <article>" — none of which can tell a service page from a product page.',
    solution: 'The discriminator is the TRANSACTION APPARATUS — an add-to-cart control, an SKU, a variant selector — not the presence of a price. Service, pricing and course pages all quote prices, so a price with no purchase control is now recorded as evidence AGAINST product and shown as such.',
    caveat: 'Verified: a service page quoting $1,200 and declaring Product now classifies as service (confident), and the Product declaration is raised as a HIGH-severity finding with the reason quoted. The AI draft is handed the verdict so it reasons about properties instead of re-litigating the type — models reliably reach for Product on anything with a price.',
  },
  {
    id: '3.2',
    tool: 'Schema & structured data',
    requirement: 'Generate the final schema that should be on the page (each schema type separately)',
    status: 'Done',
    summary: '13 builders producing complete, pasteable blocks per type — plus one combined @graph with @id cross-references, and download endpoints for both.',
    where: '/ai-seo/schema',
    modules: 'schemaBuilder.js (new), routes/aiseo.js',
    problem: 'The old generator emitted FRAGMENTS with explicit nulls. That is worse than useless: Google treats an explicit null as a malformed value, whereas an absent property is simply ignored. Nine unlinked half-blocks with no guidance on combining them is not a deliverable.',
    solution: 'Every unknowable property is OMITTED, so each block is valid JSON-LD exactly as it stands. What could not be read is listed beside it with the exact value shape expected ("ISO 8601 with a timezone offset", not "add a date"). Types the page type forbids are listed with their reason; a type requested explicitly is still produced, flagged with the objection.',
    caveat: 'FAQ answers are now extracted by walking forward from each question heading to the next heading of the same or higher level, handling dt/dd and details/summary. The old pair-by-position approach could attach the WRONG answer text — a policy violation, not a cosmetic error.',
  },

  // ---------------------------------------------------------- llms.txt
  {
    id: '4.1',
    tool: 'Brand hub & llms.txt',
    requirement: 'Generate llms.txt on the basis of the sitemap, not Search Console',
    status: 'Done',
    summary: 'The content map now reads the sitemap as its source of record, grouped by the site\'s own URL sections. Search Console only orders pages within each section and annotates the busiest.',
    where: '/ai-seo/brand-hub',
    modules: 'schemaAuto.js, routes/aiseo.js',
    problem: 'Two failures, both material. COVERAGE: GSC only knows pages Google has already shown, so a new section, a page that has never ranked, and every page on a site with no GSC history were all absent — a retrieval system reading the file concluded they did not exist. STRUCTURE: a flat "most-visited" list expresses no architecture.',
    solution: 'The relationship is inverted — coverage from the sitemap, prominence from GSC. Where a brand has no GSC history the file is now complete and merely unordered, instead of empty.',
    caveat: 'Each section header states its own total ("25 of 140 pages in this section") so a truncated list never reads as a complete inventory. Added ?gsc=0 to rebuild ordered by last-modified instead of clicks — what you want when checking coverage rather than traffic weighting.',
  },

  // ------------------------------------------------- AI crawler readiness
  {
    id: '5.1',
    tool: 'AI Crawler Readiness',
    requirement: 'Search the whole website, not a single URL',
    status: 'Done — new feature',
    summary: 'A new whole-site feature with its own form and result page, running the eight-point checklist against the union of the sitemap and a link crawl.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js (new), store.js, routes/aiseo.js',
    problem: 'Readiness only ever scored one URL.',
    solution: 'Kept SEPARATE from the single-URL report rather than added as a flag: the two answer different questions and their result pages share almost nothing, so folding them together would mean one template with two disjoint halves.',
    caveat: 'The URL set is the UNION of the sitemap and a crawl. That union is what makes item 5.3 answerable at all — a sitemap compared only against itself can never be found incomplete. Items are ordered and weighted by what blocks what.',
  },
  {
    id: '5.2',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: robots.txt',
    status: 'Done',
    summary: 'Per AI agent, tested against robots.txt AND by making a live request as that agent. Retrieval fetchers and training crawlers reported separately. Weight 18 of 100.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: 'The dominant real failure is not a robots rule someone wrote; it is an edge rule nobody knows about — Cloudflare bot-fight, a WAF user-agent rule, a "block AI scrapers" plugin — returning 403 while robots.txt says Allow. The only way to find it is to make the request as that agent.',
    caveat: 'Blocking a TRAINING crawler costs nothing in visibility and many publishers do it deliberately; blocking a RETRIEVAL fetcher means the brand cannot appear in that assistant\'s answers at all. A tool that reports "8 AI bots blocked" without that split is wrong in both directions.',
  },
  {
    id: '5.3',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: sitemap contains all target URLs',
    status: 'Done',
    summary: 'Indexable crawled pages absent from the sitemap, and sitemap URLs the crawl never reached, with both lists shown. Weight 12.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: 'Pages that are 404 or noindex are excluded — their absence from a sitemap is correct, not a gap.',
    caveat: '"Not reached by the crawl" has two causes and only one is a problem: an orphan page, or the crawl hitting its page cap. The caveat is stated on the check rather than left for the reader to infer.',
  },
  {
    id: '5.4',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: important pages return 200',
    status: 'Done',
    summary: '"Important" is defined, not assumed: the homepage, any URL you name on the form, and the shallowest sitemap URL per top-level section. Fetched directly. Weight 16.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: 'Fetched directly rather than inferred from the crawl, because a page the crawl never reached has no status at all.',
    caveat: 'A broken section entry point costs every page beneath it, not just itself — which is why section entry points are included automatically rather than left to be named.',
  },
  {
    id: '5.5',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: there is no accidental noindex',
    status: 'Done',
    summary: 'Noindex pages listed, with those ALSO in the sitemap flagged hardest. nosnippet and max-snippet:0 reported separately. Weight 14.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: '"Accidental" is the operative word. A noindex page that is also listed in the sitemap is the site requesting indexation and forbidding it simultaneously — that contradiction is never intentional, and it is the signature the check keys on.',
    caveat: 'nosnippet is its own finding because a page carrying it can rank and still never be the cited source. It is usually inherited from a plugin default rather than chosen.',
  },
  {
    id: '5.6',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: canonical points to the correct page',
    status: 'Done',
    summary: 'Missing canonicals, canonicals pointing off-host, canonicals pointing at a URL the crawl found broken, and three or more distinct pages collapsing onto one. Weight 12.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: 'A canonical pointing at a broken or foreign URL asks Google to index something that is not there, and the page making the request is the one that disappears.',
    caveat: 'Several URLs pointing at one canonical is normal and correct; several DISTINCT pages of real content collapsing onto one is not. Only the second is reported, and a template emitting one hardcoded canonical for a whole section is the usual cause.',
  },
  {
    id: '5.7',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: main content is available in HTML',
    status: 'Done',
    summary: 'Pages with SPA markers serving under 120 words of content, plus thin pages reported separately. Weight 16.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: '—',
    solution: 'Every AI retrieval fetcher reads the served HTML and executes no JavaScript, so such a page is blank to them while looking perfect in a browser. Googlebot does render, but on a delay and not always.',
    caveat: 'On a client-rendered site this is the single highest-impact AI-visibility fix available, which is why it carries joint-highest weight with the robots check.',
  },
  {
    id: '5.8',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: internal links are standard links',
    status: 'Done — new feature',
    summary: 'Real anchors counted against href="#", javascript: hrefs, anchors with no href, and divs wired with onclick/data-href/role=link. Per page, with examples. Weight 8.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: 'Never checked anywhere in the platform, and invisible to every conventional validator.',
    solution: 'All four patterns look and behave like links to a person and are invisible to every AI fetcher, none of which execute JavaScript. A site navigated that way has, to them, ONE PAGE.',
    caveat: 'The fix is compatible with a JS router: an anchor with a real href plus a handler calling preventDefault works for both the app and the crawler. That is stated in the recommendation rather than left as "use real links".',
  },
  {
    id: '5.9',
    tool: 'AI Crawler Readiness',
    requirement: 'Checklist: structured data is valid and matches visible text',
    status: 'Done — new feature',
    summary: 'Marked-up name, headline, price, rating, review count, telephone and address compared against the rendered text; FAQ answers probed against the visible page; parse errors reported. Weight 4.',
    where: '/ai-seo/site-readiness',
    modules: 'siteReadiness.js',
    problem: 'This is the one structured-data failure a validator cannot catch — a hardcoded price or an invented rating passes every syntax check.',
    solution: 'Numeric values are compared digit-wise, so a marked-up "1499.00" correctly matches a rendered "£1,499.00" and does not produce a false positive on correct markup.',
    caveat: 'An invented aggregateRating is the most commonly penalised structured-data abuse there is, and an FAQ answer a reader cannot see is a policy violation rather than a technical warning. Both are reported at high severity.',
  },

  // -------------------------------------------------- internal linking
  {
    id: '6.1',
    tool: 'Internal linking & architecture',
    requirement: 'Option to search for a URL and find internal linking opportunities, with columns: URL, Source URL, Anchor text',
    status: 'Done — new feature',
    summary: 'A new target-first feature: one URL in, and the pages that should link to it out — each with an anchor phrase already present in that page\'s own copy, the sentence it sits in, and a CSV export.',
    where: '/ai-seo/link-opportunities',
    modules: 'linkFinder.js (new), linkOpportunities.js (new), routes/aiseo.js',
    problem: 'Neither existing tool answered this. /linking produces every pair on the site (right for an audit, no help for one page); /ai-seo/architecture proposes links across the whole graph ordered by global overlap, so one page\'s opportunities are scattered through sixty rows about other pages.',
    solution: 'THE ANCHOR RULE IS ABSOLUTE: every anchor is a verbatim substring of the source page\'s own rendered text. A recommendation to "link with this anchor" is worthless if the phrase is not on the source page — the implementer then has to write a sentence and decide where it goes, and a five-minute linking task has become a writing brief.',
    caveat: 'Live testing found a real bug: the top six recommendations on one site were all the same anchor inside the same sitewide banner — a feature block in a plain div with no nav or template class, which no selector list would ever catch. It needed cross-page repetition detection, which in turn needed the template detector taught to read list items as whole units. After the fix that site returned 1 genuinely editorial row instead of 6 identical ones.',
  },

  // ------------------------------------------------------- competitive
  {
    id: '7.1',
    tool: 'Competitive intelligence',
    requirement: 'Clean the noisy response — brand entities and general words like "Office Headquarters", "Why Choose Us"',
    status: 'Done — bug fixed',
    summary: 'Every gap list is filtered by three evidence sources: competitor brand terms, your own brand terms, and each site\'s own template text. Before/after counts and the full suppressed list with reasons are shown.',
    where: '/ai-seo/competitors',
    modules: 'boilerplate.js (new), competitive.js, gapAnalysis.js (new)',
    problem: 'Same structural cause as 2.4 — a competitor\'s brand is the entity most certain to be on their pages and not on yours, so it topped every list. The report was, in effect, recommending that the client write about their rivals and add buttons.',
    solution: 'topicProfile() now runs on boilerplate-stripped text, and anchorPatterns()\'s hand-written 10-phrase stoplist was replaced with the shared ~250-entry filter — so "what a competitor links with" means the same thing everywhere in the suite.',
    caveat: 'The suppression is auditable: what was removed, and why, is listed on the page. A filter nobody can inspect is a filter nobody can trust.',
  },
  {
    id: '7.2',
    tool: 'Competitive intelligence',
    requirement: 'Wrong referring domains analysis',
    status: 'Done — bug fixed',
    summary: 'Every candidate page is now fetched and its outbound anchors read; a domain counts only where a real link exists. Mentions without a link have their own column. YOUR HISTORICAL FIGURES WILL HAVE MOVED.',
    where: '/ai-seo/competitors',
    modules: 'gapAnalysis.js (new), competitive.js',
    problem: 'The old figure came from a web search for pages MENTIONING a domain — a page that types "example.com" in running text counted the same as one that links to it. It was labelled a proxy, but a labelled wrong number is still a wrong number.',
    solution: 'Three outcomes kept distinct: linked (with rel/nofollow recorded), mention-without-link, and unverified (could not fetch — claims nothing). That turns a mention count into a small TRUE backlink sample.',
    caveat: 'Unlinked mentions of YOUR brand are now their own finding, and they are the cheapest links available: the publisher already decided to write about you.',
  },
  {
    id: '7.3',
    tool: 'Competitive intelligence',
    requirement: 'Topical coverage gap in tabular form — columns: Topic, Comp 1 score, Comp 2 score, Our brand score',
    status: 'Done — new feature',
    summary: 'Exactly that table, plus a deficit column, sorted by how far behind you are. One score per site per topic, computed identically, with the formula printed under the table.',
    where: '/ai-seo/competitors',
    modules: 'gapAnalysis.js (new), competitive.js',
    problem: 'Only two flat lists existed — missing entities and missing phrases. They said WHAT was missing but not how far behind, and gave no per-competitor breakdown.',
    solution: 'coverage = 40×(share of pages discussing the topic) + 40×(share whose TITLE OR H1 is about it) + 20×(deepest such page has 500+ words). Every cell\'s tooltip splits breadth from depth, because a site with high "mentions" and zero "about" name-drops the topic and has no page for it — a different problem from not discussing it.',
    caveat: 'A short topic requires EVERY word. The first version used a fixed 50% threshold, which meant "green roof" was satisfied by "roof" alone — so every roofing site scored identically on every topic and the matrix was useless. Regression-tested. Near-duplicates also collapse, so "capital adequacy" and "capital adequacy requirements" are one row.',
  },
  {
    id: '7.4',
    tool: 'Competitive intelligence',
    requirement: 'Keyword gap (competitors\' keyword rankings)',
    status: 'Done — new feature',
    summary: 'A matrix of where each site appears for each candidate keyword, with a state per row: gap, behind, we lead, or nobody ranks. Candidates drawn from your own non-branded Search Console queries first.',
    where: '/ai-seo/competitors',
    modules: 'gapAnalysis.js (new), serpLite.js (new)',
    problem: 'Impossible without seeing a result page, and the platform had no SERP source.',
    solution: 'Measured against Google where DataForSEO is configured; otherwise read from a keyless result sample — which is a real like-for-like comparison (same query, same page, same moment, every site).',
    caveat: 'Labelled NOT-GOOGLE on the table, in the caveat and in the finding. Capped, with the cap reported. Using your own GSC queries as candidates is what makes the rows keywords that matter to this brand rather than every phrase a competitor happens to use.',
  },
  {
    id: '7.5',
    tool: 'Competitive intelligence',
    requirement: 'Backlinks gap (competitors\' backlinks)',
    status: 'Done — new feature',
    summary: 'Referring domains, linking pages, followed count and Domain Authority per site — plus the domains linking to a competitor and not to you, sorted by how many competitors each links to.',
    where: '/ai-seo/competitors',
    modules: 'gapAnalysis.js (new), competitive.js',
    problem: 'Not attempted at all.',
    solution: 'Uses the Moz link index where a credential is set (complete counts); otherwise the verified sample from 7.2. The multi-competitor gap rows are the most directly actionable output in the module: a directory, supplier page, association list or review site that has the whole category except this client.',
    caveat: 'Without a link-index credential every count is explicitly labelled A FLOOR, NOT A TOTAL — comparable between sites because the same cap applies to all of them, and not comparable to an Ahrefs or Semrush figure.',
  },

  // -------------------------------------------------------- reputation
  {
    id: '8.1',
    tool: 'Reputation & ambient signals',
    requirement: 'Missing top review platforms',
    status: 'Done — new feature',
    summary: 'A new feature checking 19 platforms, chosen by vertical and weighted by what a missing profile actually costs. Establishes presence without reading a single review.',
    where: '/ai-seo/review-platforms',
    modules: 'reviewPlatforms.js (new), store.js, routes/aiseo.js',
    problem: 'The mention monitor deliberately refuses to scrape Trustpilot, G2, Capterra and Google — they block automated access, and a scrape that silently returns nothing is indistinguishable from "no new reviews". That refusal is correct and unchanged. But existence is a different question and needs no reviews.',
    solution: 'Two methods: a direct probe of the platform\'s conventional profile URL where it has one, or a site-restricted search. Vertical-aware, so a restaurant is not told it is missing from G2.',
    caveat: 'A platform that blocks or rate-limits is recorded as UNKNOWN, never as missing, and unknowns are excluded from the score on both sides. Calling an unknown a gap would send someone to create a profile that already exists.',
  },

  // --------------------------------------------------------- freshness
  {
    id: '9.1',
    tool: 'Freshness & intent drift',
    requirement: 'Ok',
    status: 'No change needed',
    summary: 'Confirmed accepted; nothing changed in this module. It inherits the shared boilerplate exclusion, so its topic-drift comparison is no longer influenced by navigation and footer changes.',
    where: '/ai-seo/freshness',
    modules: '—',
    problem: '—',
    solution: '—',
    caveat: 'The only indirect change: because the shared text helpers now strip the template, a drift measurement is no longer moved by a navigation redesign.',
  },

  // ---------------------------------------------------- tracking board
  {
    id: '10.1',
    tool: 'SEO tracking board',
    requirement: 'Missing 4xx pages',
    status: 'Done — new feature',
    summary: 'A dedicated broken-page check covering 4xx, 5xx, soft 404s and unreachable URLs — each with the internal links pointing at it. Four new metrics.',
    where: '/ai-seo/monitoring',
    modules: 'trackingCatalog.js, tracking.js',
    problem: 'The existing crawl-errors check tested a 12-URL sample. That answers "does this site have broken pages" and CANNOT answer "which ones" — a 4,000-page site with 60 dead product URLs shows a clean sample almost every time.',
    solution: 'Adds the one thing a sitemap cannot supply: THE TARGETS OF INTERNAL LINKS. That is where dead URLs live — a page deleted from the CMS leaves the sitemap immediately and leaves the links pointing at it for years.',
    caveat: 'Four outcomes reported separately because the fix differs: 4xx WITH inbound links (the actionable list), 4xx with none (usually a stale sitemap entry), 5xx (Google slows its crawl of the WHOLE site), and soft 404s — HTTP 200 with not-found content, detected from the title and H1 only, and the most damaging because no status check ever sees them.',
  },
  {
    id: '10.2',
    tool: 'SEO tracking board',
    requirement: 'Sitewide tracking missing',
    status: 'Done',
    summary: 'The sweep now takes a scope: sampled (unchanged default) or sitewide. Sitewide builds the full URL set and hands it only to checks that declare they can absorb one. Every check reports which set it used.',
    where: '/ai-seo/monitoring',
    modules: 'tracking.js, trackingCatalog.js',
    problem: 'Every check ran against the same 12-URL sample, so no count could ever be a sitewide total.',
    solution: 'The full URL set is the homepage plus every sitemap URL plus every page with Search Console traffic, deduplicated and capped (default 3,000, configurable).',
    caveat: 'The per-check gate is the important part: without it, adding sitewide scope would silently hand 3,000 URLs to the PageSpeed check and burn the daily quota on the first brand. Caps are stated, never applied silently.',
  },

  // ------------------------------------------------------- duplicate row
  {
    id: '11.1',
    tool: 'Competitive Analysis — Requirements',
    requirement: 'Duplicate of rows 7.1–7.5 (same five requirements restated)',
    status: 'Done',
    summary: 'All five delivered — see rows 7.1 through 7.5 for the detail on each.',
    where: '/ai-seo/competitors',
    modules: 'See 7.1–7.5',
    problem: '—',
    solution: 'Noise filtered with the suppressed list shown; referring domains verified by fetching each candidate; topic coverage matrix in the requested shape; keyword gap matrix with its non-Google basis labelled; backlink gap with the domains linking to competitors and not to you.',
    caveat: 'Listed as its own row so the original sheet\'s numbering is preserved and nothing looks unanswered.',
  },
];

// -------------------------------------------------------- supporting data

const MODULES = [
  ['markets.js', 92, 'New', '40 markets, each carrying every geo identifier its consumers expect (Google gl/hl, Trends geo, DDG kl, DataForSEO location code)', '1.3'],
  ['serpLite.js', 310, 'New', 'Keyless, country-aware sample of a result page, plus the second suggestion index', '1.1, 1.4, 7.4, 8.1'],
  ['keywordMetrics.js', 637, 'New', 'Volume and difficulty adapter chain: Google Ads → DataForSEO → Semrush → Trends, plus the SERP difficulty proxy', '1.2, 1.4'],
  ['boilerplate.js', 491, 'New', 'Boilerplate stripping, cross-page template detection, competitor brand terms and the generic-UI vocabulary', '2.3, 2.4, 7.1'],
  ['headings.js', 414, 'New', 'Heading hierarchy validation and keyword stuffing / repetition detection', '2.1, 2.2'],
  ['pageType.js', 396, 'New', 'Page-type classification from URL, commerce DOM, content and existing markup — with a forbidden-type list per type', '3.1'],
  ['schemaBuilder.js', 653, 'New', '13 builders producing complete pasteable blocks plus the combined @graph', '3.2'],
  ['linkFinder.js', 398, 'New', 'Verbatim-anchor link discovery for one target URL', '6.1'],
  ['linkOpportunities.js', 197, 'New', 'The run wrapper making the link finder a first-class suite feature', '6.1'],
  ['siteReadiness.js', 939, 'New', 'The whole-site eight-point AI-crawler checklist', '5.1–5.9'],
  ['reviewPlatforms.js', 483, 'New', 'Review platform presence and gap detection across 19 platforms', '8.1'],
  ['gapAnalysis.js', 520, 'New', 'Topic coverage matrix, keyword gap, backlink gap and verified referring domains', '7.2–7.5'],
  ['verify_gaps.js', 668, 'New', 'Verification suite for all of the above — 57 checks', 'All'],
  ['research.js', null, 'Changed', 'Alphabet sweep, second suggestion index, country, volume and difficulty enrichment', '1.1–1.4'],
  ['onpage.js', null, 'Changed', 'Boilerplate-stripped metrics, heading and stuffing checks, entity noise filtering', '2.1–2.4'],
  ['schemaAuto.js', null, 'Changed', 'Page-type wiring, wrong-type findings, sitemap-based llms.txt content map', '3.1, 3.2, 4.1'],
  ['competitive.js', null, 'Changed', 'Noise filtering, the three new gap tables, verified referring domains', '7.1–7.5'],
  ['trackingCatalog.js', null, 'Changed', 'The sitewide broken-page check, plus sitewide-capable flags', '10.1, 10.2'],
  ['tracking.js', null, 'Changed', 'Sample versus sitewide scope, with a per-check gate', '10.2'],
  ['providers.js', null, 'Changed', 'Google Ads, Google Trends and SERP-sample adapters declared', '1.2, 1.3'],
  ['routes/aiseo.js', null, 'Changed', 'Three new features, country and scope parameters, CSV and JSON-LD download endpoints', '1.3, 3.2, 5.1, 6.1, 8.1, 10.2'],
  ['tools/node/lib/http.js', null, 'Changed', 'Request-body support, needed for the JSON APIs the volume adapters call', '1.2'],
];

const SOURCES = [
  ['Google Search Console', 'Your OAuth', 'Measured', 'Queries, impressions, clicks, positions, index coverage — this property only', 'Shown as measured'],
  ['Google Analytics 4', 'Your OAuth', 'Measured', 'Sessions, engagement, conversions', 'Shown as measured'],
  ['PageSpeed Insights / CrUX', 'OAuth or optional key', 'Measured', 'Core Web Vitals lab and field data', 'Lab and field reported separately'],
  ['Built-in crawler', 'None', 'Measured', 'HTML, headings, schema, links, robots, canonicals — your site and competitors\'', 'Shown as measured'],
  ['Google Ads Keyword Planner', 'Free dev token + your OAuth', 'Measured', 'Monthly search volume, CPC, competition — per country', 'Source printed on every value'],
  ['DataForSEO / Semrush / Moz / Ahrefs', 'Paid credential', 'Measured', 'Volume, difficulty, live Google positions, complete backlink counts', 'Source printed on every value'],
  ['Google autocomplete', 'Keyless', 'Sampled', 'Seed expansion and the alphabet sweep', 'Suggestion rank, never a volume'],
  ['Bing suggestion index', 'Keyless', 'Sampled', 'Alternative phrasings Google\'s autocomplete does not return', 'Named as a second index'],
  ['Google Trends', 'Keyless', 'Sampled', 'Relative interest 0–100, per country', 'Own column. The shape of demand, not its size'],
  ['DuckDuckGo / Bing result sample', 'Keyless', 'Sampled', 'Difficulty proxy, keyword gap, review-platform detection', 'Explicitly labelled NOT Google'],
  ['Verified referring domains', 'Keyless', 'Sampled', 'Candidates found by search, then each page fetched and its links read', 'A floor, not a total'],
  ['Reddit / Hacker News / news RSS', 'Keyless (Reddit optional key)', 'Sampled', 'Third-party brand discussion and sentiment', 'Which tier answered is reported'],
  ['Azure OpenAI', 'Your key', 'Measured input', 'Assistant prompts, drafted edits, written rationale', 'Never used for a measurement'],
  ['Competitor organic traffic', '—', 'Not available', 'Nothing. No source can answer it', 'Not shown, not approximated'],
  ['Actual AI citation share', '—', 'Not available', 'Needs a citation-tracking credential', 'Readiness measured instead, labelled as such'],
  ['True rank tracking', '—', 'Not available', 'GSC average position is a blended national figure', 'Stated wherever position appears'],
];

// Defects found by RUNNING the engines against live sites, after the
// requirement work was complete and the unit suites were green. Recorded
// separately because they are not requirements — they are what end-to-end
// testing turned up, and every one of them would have shipped.
const LIVE_BUGS = [
  [
    'Google Trends returned nothing, always',
    'Keyword research — relative interest',
    'Critical',
    'Trends answers a cookieless request with a flat HTTP 429 — three consecutive attempts returned an identical 1,701-byte body, so it was a hard requirement rather than a transient limit.',
    'Relative interest is the DEFAULT demand signal whenever no paid volume credential is configured. The column would have been permanently empty on every install that has not bought a keyword tool — while reporting itself as merely unavailable.',
    'A single GET of the Trends web page sets an NID cookie; the same request carrying it returns 200. The cookie is fetched once, reused for 30 minutes, and re-fetched once on a 429 so an expired one recovers on its own.',
    'Fixed and verified live: 3 of 3 keywords returned interest values with trend direction.',
  ],
  [
    'Referring-domain search returned zero results, reported as success',
    'Competitive — referring domains and backlink gap',
    'Critical',
    'Two independent faults compounding. (1) The request used a self-identifying bot user agent, which DuckDuckGo answers with HTTP 202 and a challenge page — a 2xx status, so the fetch reported success. (2) The result regex required class= to appear before href= in the anchor, which is not how the markup is emitted.',
    'Either fault alone produces zero results reported as ok:true. Together they meant the referring-domain figures were STRUCTURALLY always empty, and the report presented that as a fact about the web rather than about the parser. This was pre-existing, not introduced by this work — but the new backlink gap inherited it.',
    'The module no longer parses result pages at all. It delegates to the shared sampler, which already handles the browser user agent, anomaly detection, the paced queue and both engines. Parsing now lives in exactly one place.',
    'Fixed. A live check that the search returns parseable results is now part of the suite, so a silent zero fails the build.',
  ],
  [
    'Unlinked pages were reported as "mentions" without checking they mentioned anything',
    'Competitive — referring domains',
    'High',
    'The verification step had three outcomes and treated "fetched, no link found" as "names the domain but does not link to it" — without ever checking that the page named it.',
    'On a live run the fallback engine ignored the -site: and quoted-phrase operators, so candidates came back including support.google.com and brainly.ph. All were reported as unlinked mentions of the target. That is a fabricated claim about a third-party page — precisely the class of error this module exists to remove.',
    'A fourth outcome was added: irrelevant. The page text is now actually checked for the domain. A high irrelevant share also sets a candidate-quality flag and prints a warning, so a weak sample is visible instead of reading as a thin link profile.',
    'Fixed and verified: the same query now reports 0 mentions, 8 irrelevant, quality "poor", and warns the sample is unreliable.',
  ],
  [
    'Suppression summary was malformed and double-counted',
    'Competitive and on-page — noise filtering',
    'Medium',
    'Two faults in one line. Reasons were pluralised by appending an s, producing "appears in this site template on most pagess". And two filter results were merged by taking the union of their pre-rendered summary strings rather than adding their counts.',
    'The summary read "21 competitor brand names ... 30 competitor brand names" as two separate entries on the same line. It is the line that proves the noise filter is working, so it undermined exactly the thing it was there to demonstrate.',
    'Filters now expose per-reason counts as data, callers merge numerically, and pluralisation leaves a phrase alone when it already ends in a plural.',
    'Fixed and verified on a live run: "51 competitor brand names / 16 appears in this site template on most pages / 7 generic UI or section labels".',
  ],
  [
    'Link recommendations were all the same sitewide banner',
    'Internal linking — link opportunities',
    'High',
    'The top six recommendations for one target were the same anchor inside the same sentence: a feature block rendered on every page, in a plain div with no navigation, footer or template class on it.',
    'Six identical rows pointing at one repeated banner is worse than no recommendations. No selector list would ever have caught it, because there was nothing in the markup to select on.',
    'Cross-page repetition detection was added to the anchor gate, which in turn required the template detector to read list items and table cells as whole units — the block has no terminating punctuation, so a sentence-boundary split merged it with its neighbours and it never repeated verbatim.',
    'Fixed and verified: the same site now returns 1 genuinely editorial recommendation instead of 6 identical banner rows.',
  ],
  [
    'Keyword clustering scored every site identically on every topic',
    'Competitive — topic coverage matrix',
    'High',
    'Topic coverage used a fixed 50% word-match threshold, so a two-word topic such as "green roof" was satisfied by "roof" alone.',
    'Every roofing site scored the same on every roofing topic, which made the entire matrix useless — it would have shipped looking plausible and saying nothing.',
    'The threshold now scales with topic length: short topics require every word, longer ones allow one miss.',
    'Fixed and regression-tested.',
  ],
  [
    'Stuffed content scored as evenly distributed',
    'On-page — keyword stuffing',
    'Medium',
    'Clustering was judged over a single tenth of the page. Eighteen occurrences packed into the opening third spread across three tenths at six each, so no single tenth held half of them.',
    'An obviously front-loaded block passed the distribution test, which is the half of the check that distinguishes stuffing from a page that is simply about its subject.',
    'The window is now two adjacent tenths — a fifth of the page, which is what a reader would call "one part of it".',
    'Fixed and regression-tested.',
  ],
]

const VERIFICATION = [
  ['verify_aiseo.js', 82, 'All pass', 'The pre-existing suite: text measurement, HTML parsing, robots matching, schema validation, scoring, the Reddit tier chain, provider honesty, the run store, live network'],
  ['verify_gaps.js', 65, 'All pass', 'New: country resolution, boilerplate exclusion, heading hierarchy, keyword stuffing, page-type classification, schema generation, the verbatim-anchor rule, site-readiness checks, gap analyses, difficulty proxy, review-platform relevance — plus a regression test per bug on the "Bugs found in testing" sheet'],
  ['verify_gaps.js --full', 7, 'All pass', 'Live network: SERP sampling, the difficulty proxy against a real result page, the second suggestion index, the URL-set builder, Google Trends, the referring-page search, and the link finder end to end'],
  ['Engines run end to end', 8, 'All complete', 'Every analysis run against a real brand with 36,920 Search Console rows and two configured competitors: research, on-page, schema, whole-site readiness, link opportunities, review platforms, competitive, and a sitewide tracking sweep'],
  ['EJS template compile', 82, 'All pass', 'Every template in the application compiles'],
  ['View render check', 7, 'All pass', 'Each new and heavily-changed result view rendered against a payload matching what its engine actually emits'],
  ['Route registration', 14, 'All respond', 'Every AI SEO route registers and responds on a booted application'],
];

// =========================================================================
// BUILD
// =========================================================================

function styleSheet(ws, columns, rowCount, { wrapFrom = 0 } = {}) {
  const header = ws.getRow(1);
  header.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    c.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  });
  header.height = 28;

  for (let r = 2; r <= rowCount + 1; r += 1) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: true }, (c, colNumber) => {
      c.alignment = {
        vertical: 'top',
        horizontal: 'left',
        wrapText: colNumber >= wrapFrom,
      };
      c.font = { size: 10 };
      c.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
      if (r % 2 === 1) c.fill = BAND_FILL;
    });
    // Row height is computed from the longest wrapped cell so nothing is
    // clipped and nothing gets forty blank lines. Excel's own auto-fit does
    // not run on wrapped text set programmatically.
    let lines = 1;
    columns.forEach((col, i) => {
      const v = row.getCell(i + 1).value;
      if (v == null) return;
      const width = col.width || 20;
      const est = Math.ceil(String(v).length / Math.max(8, width - 2));
      if (est > lines) lines = est;
    });
    row.height = Math.min(220, Math.max(16, lines * 12.6));
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

async function build() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEO Automation Suite';
  wb.created = new Date();
  wb.title = 'AI SEO — requirements and fixes';

  // ------------------------------------------------- Sheet 1: Requirements
  const cols1 = [
    { header: 'ID', key: 'id', width: 7 },
    { header: 'Tool', key: 'tool', width: 26 },
    { header: 'Requirement', key: 'requirement', width: 44 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'What was built', key: 'summary', width: 62 },
    { header: 'Where to see it', key: 'where', width: 26 },
    { header: 'Modules', key: 'modules', width: 30 },
  ];
  const ws1 = wb.addWorksheet('Requirements', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws1.columns = cols1;
  R.forEach((r) => ws1.addRow({
    id: r.id, tool: r.tool, requirement: r.requirement, status: r.status,
    summary: r.summary, where: r.where, modules: r.modules,
  }));
  styleSheet(ws1, cols1, R.length, { wrapFrom: 2 });

  // Status colouring and dropdown validation.
  for (let r = 2; r <= R.length + 1; r += 1) {
    const c = ws1.getCell(`D${r}`);
    const v = String(c.value || '');
    const colour = v.includes('bug fixed') ? 'FF9A3412'
      : (v.includes('new feature') ? 'FF1D4ED8'
        : (v === 'No change needed' ? 'FF6B7280' : 'FF166534'));
    c.font = { size: 10, bold: true, color: { argb: colour } };
    c.dataValidation = {
      type: 'list', allowBlank: false, formulae: [`"${STATUSES.join(',')}"`],
      showErrorMessage: true, errorTitle: 'Invalid status',
      error: `Must be one of: ${STATUSES.join(', ')}`,
    };
    ws1.getCell(`A${r}`).font = { size: 10, bold: true };
  }

  // ------------------------------------------------------ Sheet 2: Detail
  const cols2 = [
    { header: 'ID', key: 'id', width: 7 },
    { header: 'Requirement', key: 'requirement', width: 34 },
    { header: 'What was wrong before', key: 'problem', width: 58 },
    { header: 'How it works now', key: 'solution', width: 58 },
    { header: 'What to know / caveat', key: 'caveat', width: 58 },
  ];
  const ws2 = wb.addWorksheet('Detail', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws2.columns = cols2;
  R.forEach((r) => ws2.addRow({
    id: r.id, requirement: r.requirement, problem: r.problem, solution: r.solution, caveat: r.caveat,
  }));
  styleSheet(ws2, cols2, R.length, { wrapFrom: 2 });
  for (let r = 2; r <= R.length + 1; r += 1) ws2.getCell(`A${r}`).font = { size: 10, bold: true };

  // ----------------------------------------------------- Sheet 3: Summary
  const byTool = new Map();
  R.forEach((r) => {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  });
  const cols3 = [
    { header: 'Tool', key: 'tool', width: 30 },
    { header: 'Requirements', key: 'count', width: 14 },
    { header: 'Delivered', key: 'done', width: 12 },
    { header: 'New features', key: 'newf', width: 14 },
    { header: 'Bugs fixed', key: 'bugs', width: 12 },
    { header: 'Where to see it', key: 'where', width: 30 },
  ];
  const ws3 = wb.addWorksheet('Summary by tool', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws3.columns = cols3;
  const summaryRows = [...byTool.entries()].map(([tool, items]) => ({
    tool,
    count: items.length,
    done: items.filter((i) => i.status !== 'No change needed').length,
    newf: items.filter((i) => i.status.includes('new feature')).length,
    bugs: items.filter((i) => i.status.includes('bug fixed')).length,
    where: [...new Set(items.map((i) => i.where))].join(', '),
  }));
  summaryRows.forEach((r) => ws3.addRow(r));
  const totals = {
    tool: 'TOTAL',
    count: R.length,
    done: R.filter((i) => i.status !== 'No change needed').length,
    newf: R.filter((i) => i.status.includes('new feature')).length,
    bugs: R.filter((i) => i.status.includes('bug fixed')).length,
    where: '',
  };
  ws3.addRow(totals);
  styleSheet(ws3, cols3, summaryRows.length + 1, { wrapFrom: 6 });
  const totalRow = ws3.getRow(summaryRows.length + 2);
  totalRow.eachCell((c) => { c.font = { size: 10, bold: true }; c.fill = GROUP_FILL; });
  for (let r = 2; r <= summaryRows.length + 2; r += 1) {
    ['B', 'C', 'D', 'E'].forEach((col) => {
      ws3.getCell(`${col}${r}`).alignment = { vertical: 'top', horizontal: 'center' };
    });
  }

  // ------------------------------------------------- Sheet 4: New modules
  const cols4 = [
    { header: 'File', key: 'file', width: 26 },
    { header: 'Lines', key: 'lines', width: 10 },
    { header: 'New or changed', key: 'kind', width: 16 },
    { header: 'What it does', key: 'purpose', width: 72 },
    { header: 'Requirements it serves', key: 'serves', width: 24 },
  ];
  const ws4 = wb.addWorksheet('Code changes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws4.columns = cols4;
  MODULES.forEach(([file, lines, kind, purpose, serves]) => ws4.addRow({
    file, lines: lines == null ? '' : lines, kind, purpose, serves,
  }));
  styleSheet(ws4, cols4, MODULES.length, { wrapFrom: 4 });
  for (let r = 2; r <= MODULES.length + 1; r += 1) {
    ws4.getCell(`A${r}`).font = { size: 10, name: 'Consolas' };
    ws4.getCell(`B${r}`).alignment = { vertical: 'top', horizontal: 'center' };
    const k = ws4.getCell(`C${r}`);
    k.font = { size: 10, bold: true, color: { argb: String(k.value) === 'New' ? 'FF1D4ED8' : 'FF6B7280' } };
  }

  // ------------------------------------------------ Sheet 5: Data sources
  const cols5 = [
    { header: 'Source', key: 'source', width: 32 },
    { header: 'Authentication', key: 'auth', width: 26 },
    { header: 'Category', key: 'cat', width: 15 },
    { header: 'What it provides', key: 'provides', width: 60 },
    { header: 'How it is labelled on screen', key: 'label', width: 42 },
  ];
  const ws5 = wb.addWorksheet('Data sources', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws5.columns = cols5;
  SOURCES.forEach(([source, auth, cat, provides, label]) => ws5.addRow({ source, auth, cat, provides, label }));
  styleSheet(ws5, cols5, SOURCES.length, { wrapFrom: 4 });
  for (let r = 2; r <= SOURCES.length + 1; r += 1) {
    const c = ws5.getCell(`C${r}`);
    const v = String(c.value);
    const colour = v === 'Not available' ? 'FF9A3412' : (v === 'Sampled' ? 'FFA16207' : 'FF166534');
    c.font = { size: 10, bold: true, color: { argb: colour } };
  }

  // ------------------------------------------------- Sheet 6: Verification
  const cols6 = [
    { header: 'Suite', key: 'suite', width: 26 },
    { header: 'Checks', key: 'checks', width: 10 },
    { header: 'Result', key: 'result', width: 14 },
    { header: 'What it covers', key: 'covers', width: 92 },
  ];
  const ws6 = wb.addWorksheet('Verification', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws6.columns = cols6;
  VERIFICATION.forEach(([suite, checks, result, covers]) => ws6.addRow({ suite, checks, result, covers }));
  styleSheet(ws6, cols6, VERIFICATION.length, { wrapFrom: 4 });
  for (let r = 2; r <= VERIFICATION.length + 1; r += 1) {
    ws6.getCell(`A${r}`).font = { size: 10, name: 'Consolas' };
    ws6.getCell(`B${r}`).alignment = { vertical: 'top', horizontal: 'center' };
    ws6.getCell(`C${r}`).font = { size: 10, bold: true, color: { argb: 'FF166534' } };
  }

  // ------------------------------------------ Sheet 7: bugs found in testing
  const cols7 = [
    { header: 'Defect', key: 'defect', width: 42 },
    { header: 'Area', key: 'area', width: 30 },
    { header: 'Severity', key: 'sev', width: 11 },
    { header: 'What was wrong', key: 'what', width: 58 },
    { header: 'Why it mattered', key: 'why', width: 58 },
    { header: 'The fix', key: 'fix', width: 58 },
    { header: 'Status', key: 'status', width: 44 },
  ];
  const ws7 = wb.addWorksheet('Bugs found in testing', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws7.columns = cols7;
  LIVE_BUGS.forEach(([defect, area, sev, what, why, fix, status]) => ws7.addRow({
    defect, area, sev, what, why, fix, status,
  }));
  styleSheet(ws7, cols7, LIVE_BUGS.length, { wrapFrom: 1 });
  for (let r = 2; r <= LIVE_BUGS.length + 1; r += 1) {
    ws7.getCell(`A${r}`).font = { size: 10, bold: true };
    const sv = ws7.getCell(`C${r}`);
    const v = String(sv.value);
    sv.font = {
      size: 10,
      bold: true,
      color: { argb: v === 'Critical' ? 'FF9A3412' : (v === 'High' ? 'FFB45309' : 'FFA16207') },
    };
    ws7.getCell(`G${r}`).font = { size: 10, color: { argb: 'FF166534' } };
  }

  // --------------------------------------------------------------- write
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const xlsxPath = path.join(outDir, 'ai-seo-requirements-and-fixes.xlsx');
  await wb.xlsx.writeFile(xlsxPath);

  // The CSV is the same NORMALISED data, so it is genuinely usable rather
  // than the previous one-blob-per-tool shape.
  const csvPath = path.join(outDir, 'ai-seo-requirements-and-fixes.csv');
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csvHeaders = ['ID', 'Tool', 'Requirement', 'Status', 'What was built', 'Where to see it', 'Modules', 'What was wrong before', 'How it works now', 'What to know / caveat'];
  const csvLines = [csvHeaders.map(esc).join(',')];
  R.forEach((r) => csvLines.push([
    r.id, r.tool, r.requirement, r.status, r.summary, r.where, r.modules, r.problem, r.solution, r.caveat,
  ].map(esc).join(',')));
  fs.writeFileSync(csvPath, `﻿${csvLines.join('\r\n')}\r\n`, 'utf8');

  // The old single-blob CSV is superseded. It is removed rather than left
  // beside the new one — two files with similar names and different shapes is
  // how the wrong one gets sent to a client — but the removal is best-effort:
  // the file is routinely open in an editor, and failing the whole generation
  // because a spreadsheet has a lock on it would be absurd.
  const old = path.join(outDir, 'ai-seo-findings-fixes.csv');
  let removed = false;
  let removeNote = null;
  if (fs.existsSync(old)) {
    try { fs.unlinkSync(old); removed = true; } catch (err) {
      removeNote = `could not remove the superseded ai-seo-findings-fixes.csv (${err.code}) — it is probably open. Close it and delete it by hand.`;
    }
  }

  console.log(`wrote ${xlsxPath}`);
  console.log(`      ${(fs.statSync(xlsxPath).size / 1024).toFixed(0)} KB · 7 sheets · ${R.length} requirement rows · ${LIVE_BUGS.length} defects found in testing`);
  console.log(`wrote ${csvPath}`);
  console.log(`      ${(fs.statSync(csvPath).size / 1024).toFixed(0)} KB · ${csvHeaders.length} columns · ${R.length} rows`);
  if (removed) console.log('removed the superseded ai-seo-findings-fixes.csv (one blob per tool)');
  if (removeNote) console.log(`NOTE: ${removeNote}`);
  console.log('');
  console.log(`requirements: ${R.length} · delivered ${totals.done} · new features ${totals.newf} · bugs fixed ${totals.bugs} · no change needed ${R.length - totals.done}`);
}

build().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
