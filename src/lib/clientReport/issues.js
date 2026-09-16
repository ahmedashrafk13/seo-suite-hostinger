// TRANSLATION: a technical finding becomes something a business owner can act on.
//
// THE PROBLEM THIS SOLVES
// The crawler reports "dup_titles: 14 pages share a title tag". That sentence
// is correct, is what an SEO needs, and means nothing to the person signing the
// contract. Handed to a client unedited it does one of two things: it is
// skipped, or it is forwarded to their developer who replies "so what?".
//
// So every check this app can run has an entry here carrying four things the
// raw finding does not:
//   what  - the same fact in the client's vocabulary
//   why   - what it costs them, in traffic, trust or revenue terms
//   fix   - what we would actually do about it
//   impact/effort - so the report can order the work honestly
//
// THE RULES THIS FILE KEEPS
// 1. NO INVENTED NUMBERS. Every figure in the copy is interpolated from the
//    measurement. There is no "this is costing you 40% of your traffic"
//    anywhere, because nothing here measures that. See the README section
//    "The rule the whole suite is built on".
// 2. NO CATASTROPHISING. A missing meta description is a missed click, not an
//    emergency. A document that calls everything critical is read as a sales
//    document rather than an audit.
// 3. AN UNMAPPED CHECK STILL RENDERS. translate() falls back to the tool's own
//    name and summary rather than dropping the finding, so adding a check to
//    the crawler can never silently remove it from a client report.

// Areas double as the scorecard's sections, so the two cannot disagree about
// which pillar an issue belongs to.
const AREAS = {
  foundations: 'Technical foundations',
  speed: 'Speed and experience',
  content: 'Content and on-page',
  visibility: 'Search visibility',
  trust: 'Security and trust',
  ai: 'AI and answer engines',
};

// REPORT TOPICS: the section order of the agency's own onboarding deliverable.
//
// AREAS above are the scorecard's pillars - they answer "how healthy is this
// part of the site". TOPICS answer a different question: "which chapter of the
// document does this finding belong in". They are deliberately separate, because
// the client report mirrors the structure the agency already sends clients, and
// that structure groups by subject (indexing, structure, speed, on-page) rather
// than by pillar. Collapsing the two would force the scorecard and the chapter
// list to agree about something they legitimately disagree about.
const TOPICS = [
  { key: 'indexing', label: 'Website Indexing and Crawlability' },
  { key: 'structure', label: 'Website Structure' },
  { key: 'speed', label: 'Page Speed' },
  { key: 'mobile', label: 'Mobile-Friendliness and Usability' },
  { key: 'onpage', label: 'On-Page SEO' },
  { key: 'schema', label: 'Structured Data and Rich Results' },
  { key: 'ai', label: 'AI Search Readiness (GEO / AEO)' },
  { key: 'technical', label: 'Additional Technical Considerations' },
  { key: 'security', label: 'Security and Trust' },
];

const TOPIC_LABEL = Object.fromEntries(TOPICS.map((t) => [t.key, t.label]));

// Finding id -> chapter. A key absent from here falls back to TOPIC_FROM_AREA,
// so a check added to the crawler lands in a sensible chapter rather than
// vanishing from the document. Same contract as translate().
const TOPIC_OF = {
  // Website Indexing and Crawlability
  sitemap_robots: 'indexing',
  sitemap_incorrect: 'indexing',
  non_indexable: 'indexing',
  nofollow: 'indexing',
  canonicalized: 'indexing',

  // Website Structure
  broken_links: 'structure',
  orphans: 'structure',
  weak_linking: 'structure',
  resource_links: 'structure',
  unverified_links: 'structure',

  // Page Speed
  slow_pages: 'speed',
  unminified: 'speed',

  // Mobile
  viewport: 'mobile',

  // On-Page SEO
  dup_titles: 'onpage',
  dup_meta: 'onpage',
  dup_content: 'onpage',
  missing_title: 'onpage',
  missing_meta: 'onpage',
  missing_h1: 'onpage',
  multiple_h1: 'onpage',
  multiple_title: 'onpage',
  title_length: 'onpage',
  desc_length: 'onpage',
  low_word_count: 'onpage',
  text_ratio: 'onpage',
  image_alt: 'onpage',
  empty_anchor: 'onpage',
  nondesc_anchor: 'onpage',

  // Additional Technical Considerations
  http_status: 'technical',
  site_unreachable: 'technical',
  canonical: 'technical',
  host_duplicate: 'technical',
  permanent_redirects: 'technical',
  charset: 'technical',
  doctype: 'technical',

  // Security and Trust
  mixed_content: 'security',
  https_to_http: 'security',
  hsts: 'security',
};

// The fallback, so an unmapped finding still lands in a chapter.
const TOPIC_FROM_AREA = {
  foundations: 'technical',
  speed: 'speed',
  content: 'onpage',
  visibility: 'indexing',
  trust: 'security',
  ai: 'ai',
};

function topicFor(key, area) {
  if (key && TOPIC_OF[key]) return TOPIC_OF[key];
  if (key && AI_KEY_PREFIXES.some((p) => String(key).startsWith(p))) return 'ai';
  return TOPIC_FROM_AREA[area] || 'technical';
}

// Effort bands, used for sequencing rather than quoting. "quick" is something a
// developer does in an afternoon; "project" needs planning and sign-off.
const EFFORT = {
  quick: { label: 'Quick win', order: 1, horizon: 'first 30 days' },
  moderate: { label: 'Moderate', order: 2, horizon: 'days 30-60' },
  project: { label: 'Project', order: 3, horizon: 'days 60-90' },
};

const plural = (n, one, many) => `${Number(n || 0).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// The crawler's checks. Keys are the finding ids emitted by
// tools/node/audit/analyze.js and its Python twin - they are stored in the
// database and drive task generation, so they must not be renamed here.
// ---------------------------------------------------------------------------
const CRAWL = {
  http_status: {
    area: 'foundations', impact: 5, effort: 'moderate',
    headline: 'Pages on the site are returning errors',
    what: (c) => `${plural(c.failed, 'page', 'pages')} answered with an error instead of content when we requested them.`,
    why: 'A page that errors cannot rank, and any link or advert pointing at it sends the visitor to a dead end. Search engines eventually drop error pages from their index, so each one is a page that has quietly stopped earning.',
    fix: 'Restore the page, or redirect it to the closest working equivalent so its history and the links pointing at it are preserved.',
  },
  broken_links: {
    area: 'foundations', impact: 4, effort: 'quick',
    headline: 'Broken links are sending visitors to dead ends',
    what: (c) => `We found ${plural(c.failed, 'broken link', 'broken links')} across the pages we checked.`,
    why: 'Every broken link is a visitor who hits a dead end mid-journey, and a route search engines cannot follow. One loses a potential enquiry; the other leaves parts of the site harder to discover.',
    fix: 'Repoint each broken link at the correct page, and remove the ones whose destination no longer exists.',
  },
  dup_titles: {
    area: 'content', impact: 4, effort: 'quick',
    headline: 'Different pages are competing with the same title',
    what: (c) => `${plural(c.failed, 'page shares', 'pages share')} a page title with at least one other page on the site.`,
    why: 'The title is the headline shown in search results and the single strongest statement of what a page is about. When several pages carry the same one, search engines have to guess which to show - and frequently show the wrong one, or neither.',
    fix: 'Give every page a distinct title written around what that page uniquely offers.',
  },
  dup_meta: {
    area: 'content', impact: 2, effort: 'quick',
    headline: 'Pages share the same search-results description',
    what: (c) => `${plural(c.failed, 'page uses', 'pages use')} a description that also appears on another page.`,
    why: 'The description is the sales copy underneath your listing. A repeated one reads as boilerplate and gives someone scanning the results no reason to choose you over the listing above or below.',
    fix: 'Write a specific description per page, aimed at the visitor that page is for.',
  },
  dup_content: {
    area: 'content', impact: 4, effort: 'moderate',
    headline: 'The same content appears on several pages',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} content that substantially duplicates another page.`,
    why: 'Duplicate pages split the credit for the same topic between them, so neither ranks as well as one strong page would. It also spends the limited attention search engines give the site on reading the same thing twice.',
    fix: 'Consolidate the duplicates into the single best version and redirect the others to it.',
  },
  missing_title: {
    area: 'content', impact: 5, effort: 'quick',
    headline: 'Pages have no title at all',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} no page title.`,
    why: 'With no title, search engines invent one from whatever text they find. That listing rarely reads well, and the page loses its clearest chance to say what it is.',
    fix: 'Add a written title to every page.',
  },
  missing_meta: {
    area: 'content', impact: 2, effort: 'quick',
    headline: 'Pages have no description for search results',
    what: (c) => `${plural(c.failed, 'page is', 'pages are')} missing the description that appears under the link in search results.`,
    why: 'Without one, search engines lift an arbitrary sentence from the page. This is your advert copy in the one place every potential customer sees it, and at the moment it is being written for you.',
    fix: 'Write a description for each page - a short, specific line that gives someone a reason to click.',
  },
  missing_h1: {
    area: 'content', impact: 3, effort: 'quick',
    headline: 'Pages have no main heading',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} no main on-page heading.`,
    why: 'The main heading tells the visitor and the search engine what the page is about within a second of it loading. Without it the page reads as unfinished, and its topic has to be inferred from the body text.',
    fix: 'Add one clear main heading per page, matching what the page is actually for.',
  },
  multiple_h1: {
    area: 'content', impact: 1, effort: 'quick',
    headline: 'Some pages have several competing main headings',
    what: (c) => `${plural(c.failed, 'page uses', 'pages use')} more than one main heading.`,
    why: 'Several top-level headings on one page blur what it is about. The effect is mild, it is free to fix, and it makes the page easier to read.',
    fix: 'Keep one main heading per page and demote the rest to sub-headings.',
  },
  title_length: {
    area: 'content', impact: 2, effort: 'quick',
    headline: 'Titles are being cut off in search results',
    what: (c) => `${plural(c.failed, 'page title is', 'page titles are')} too long or too short for the space search engines give it.`,
    why: 'A title cut off mid-sentence loses the part that would have earned the click. A title that is too short leaves that space unused.',
    fix: 'Rewrite the affected titles to fit, leading with the words a customer would actually search for.',
  },
  desc_length: {
    area: 'content', impact: 1, effort: 'quick',
    headline: 'Descriptions do not fit the space available',
    what: (c) => `${plural(c.failed, 'description is', 'descriptions are')} outside the length search engines display.`,
    why: 'Over-long descriptions are truncated mid-sentence; very short ones waste free advertising space under your listing.',
    fix: 'Trim or extend the affected descriptions to fit the displayed length.',
  },
  low_word_count: {
    area: 'content', impact: 3, effort: 'project',
    headline: 'Pages are too thin to compete',
    what: (c) => `${plural(c.failed, 'page carries', 'pages carry')} very little text.`,
    why: 'A page with a few lines on it cannot answer the question that brought someone to it, so it rarely ranks against pages that do. A large number of thin pages also drags on how the site as a whole is judged.',
    fix: 'Expand the pages that matter commercially, and merge or remove the ones that exist only to fill a menu.',
  },
  text_ratio: {
    area: 'content', impact: 1, effort: 'moderate',
    headline: 'Pages are mostly code, with little readable content',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} very little readable text relative to the code behind it.`,
    why: 'Search engines and AI assistants read text. A page that is mostly markup gives them little to work with, whatever it looks like to a visitor.',
    fix: 'Add substantive copy to the affected pages and simplify the markup where it can be reduced.',
  },
  image_alt: {
    area: 'content', impact: 2, effort: 'quick',
    headline: 'Images have no text description',
    what: (c) => `${plural(c.failed, 'image is', 'images are')} missing the short text description that screen readers and search engines rely on.`,
    why: 'These descriptions are how images are understood by search engines, how they appear in image search, and how visitors using a screen reader experience your site. Missing them is also one of the most common accessibility complaints.',
    fix: 'Add a plain description to each image that carries meaning, and mark purely decorative images as such.',
  },
  slow_pages: {
    area: 'speed', impact: 4, effort: 'moderate',
    headline: 'Pages are slow to load',
    what: (c) => `${plural(c.failed, 'page took', 'pages took')} noticeably longer to respond than a visitor will wait.`,
    why: 'Load time decides whether a visitor stays. It is also a ranking factor on mobile, so a slow page is penalised twice: fewer people see it, and fewer of those who do stay long enough to convert.',
    fix: 'Compress and correctly size images, reduce the scripts loaded before first paint, and enable caching at the server.',
  },
  unminified: {
    area: 'speed', impact: 2, effort: 'quick',
    headline: 'Page code is larger than it needs to be',
    what: (c) => `${plural(c.failed, 'script or stylesheet is', 'scripts and stylesheets are')} being served uncompressed.`,
    why: 'Every extra kilobyte is time the visitor waits before seeing anything, and the effect is worst on the mobile connections most visitors arrive on.',
    fix: 'Turn on minification and compression in the build or hosting layer - usually a configuration change rather than development work.',
  },
  viewport: {
    area: 'speed', impact: 4, effort: 'quick',
    headline: 'Pages are not set up for mobile screens',
    what: (c) => `${plural(c.failed, 'page is', 'pages are')} missing the instruction that tells a phone how to size the page.`,
    why: 'Without it the page renders at desktop width on a phone, so visitors have to pinch and zoom to read it. Google judges the mobile version of a site first, so this affects rankings as well as experience.',
    fix: 'Add the mobile viewport declaration to the site template.',
  },
  mixed_content: {
    area: 'trust', impact: 3, effort: 'moderate',
    headline: 'Secure pages are loading insecure files',
    what: (c) => `${plural(c.failed, 'page loads', 'pages load')} an image, script or stylesheet over an insecure connection.`,
    why: 'Browsers either block these files or warn the visitor. A security warning on the page where someone was about to make an enquiry is one of the most expensive things a website can show.',
    fix: 'Serve every asset over HTTPS and update the hard-coded references that still point at the insecure address.',
  },
  https_to_http: {
    area: 'trust', impact: 2, effort: 'quick',
    headline: 'Secure pages link to insecure ones',
    what: (c) => `${plural(c.failed, 'link sends', 'links send')} visitors from a secure page to an insecure address.`,
    why: 'It drops the visitor out of the secure connection, and on some browsers shows them a warning at exactly the wrong moment.',
    fix: 'Update the affected links to their secure equivalents.',
  },
  hsts: {
    area: 'trust', impact: 1, effort: 'quick',
    headline: 'The site does not enforce a secure connection',
    what: () => 'The server does not instruct browsers to always use the secure version of the site.',
    why: 'Without it, the first visit of the day can still be made over an insecure connection before the redirect happens. It is a small exposure, and closing it is a server setting rather than a development task.',
    fix: 'Enable HTTP Strict Transport Security at the server or CDN.',
  },
  host_duplicate: {
    area: 'foundations', impact: 5, effort: 'quick',
    headline: 'The site exists twice, at two different addresses',
    what: () => 'Both the www and the non-www version of the site serve content without one redirecting to the other, so every page exists at two addresses.',
    why: 'Search engines treat those as two sites competing with each other. The credit each page has earned is split between the two copies, which holds both back.',
    fix: 'Choose one address as the official one and redirect the other to it permanently.',
  },
  non_indexable: {
    area: 'foundations', impact: 5, effort: 'quick',
    headline: 'Pages are blocked from appearing in search results',
    what: (c) => `${plural(c.failed, 'page carries', 'pages carry')} an instruction telling search engines not to list it.`,
    why: 'These pages cannot appear in search results at all, whatever is on them. It is usually left over from a staging site or a plugin default, and it is one of the few problems that can remove a whole section of a site from Google overnight.',
    fix: 'Remove the blocking instruction from every page that is meant to be found.',
  },
  canonical: {
    area: 'foundations', impact: 3, effort: 'moderate',
    headline: 'Pages point search engines at the wrong version of themselves',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} a problem with the tag that tells search engines which version of a page is the official one.`,
    why: 'Set wrongly, this tag tells search engines to ignore the page and rank a different one instead. It is invisible on screen, which is why it so often goes unnoticed for months.',
    fix: 'Correct the tag so each page declares itself, except where a duplicate genuinely should defer to another page.',
  },
  canonicalized: {
    area: 'foundations', impact: 4, effort: 'moderate',
    headline: 'Pages are telling search engines to rank something else instead',
    what: (c) => `${plural(c.failed, 'page defers', 'pages defer')} to a different page, so it will not rank in its own right.`,
    why: 'Each of these pages has been voluntarily withdrawn from search results. That is correct for a duplicate, and a serious loss for a page that was meant to earn traffic.',
    fix: 'Review each one and point it back at itself wherever the page deserves to rank.',
  },
  sitemap_robots: {
    area: 'foundations', impact: 4, effort: 'quick',
    headline: 'Search engines are not being given a map of the site',
    what: (c) => c.summary || 'The files that tell search engines what to crawl and what to ignore are missing or incomplete.',
    why: 'These two small files are how a search engine learns what exists on the site and what it is allowed to read. When they are wrong, new pages go undiscovered for weeks - and in the worst case whole sections are excluded by accident.',
    fix: 'Publish a complete, current sitemap and correct the crawl instructions so nothing that should rank is being excluded.',
  },
  sitemap_incorrect: {
    area: 'foundations', impact: 2, effort: 'quick',
    headline: 'The sitemap lists pages that should not be in it',
    what: (c) => `${plural(c.failed, 'address in the sitemap is', 'addresses in the sitemap are')} redirected, missing or blocked.`,
    why: 'A sitemap is a set of recommendations. When many of them are wrong, search engines trust the file less and crawl the site less efficiently.',
    fix: 'Regenerate the sitemap so it lists only live, indexable pages.',
  },
  orphans: {
    area: 'foundations', impact: 3, effort: 'moderate',
    headline: 'Pages exist but nothing links to them',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} no links pointing to it from anywhere else on the site.`,
    why: 'A page nothing links to is a page visitors cannot navigate to and search engines struggle to find. Whatever was invested in producing it is currently earning nothing.',
    fix: 'Link the worthwhile ones from the relevant sections, and retire the rest.',
  },
  weak_linking: {
    area: 'foundations', impact: 2, effort: 'moderate',
    headline: 'Important pages are barely linked to',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} only a single internal link pointing at it.`,
    why: 'How often a page is linked to from within the site is a direct signal of how important it is. A money page with one link looks, to a search engine, like the least important thing on the site.',
    fix: 'Add links from relevant existing content to the pages that matter commercially.',
  },
  permanent_redirects: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Internal links route through redirects',
    what: (c) => `${plural(c.failed, 'internal link points', 'internal links point')} at an address that redirects somewhere else.`,
    why: 'Each redirect adds a delay before the page appears and slightly dilutes the value passed through the link. Minor individually; it adds up across a site.',
    fix: 'Update the links to point at the final address directly.',
  },
  empty_anchor: {
    area: 'content', impact: 1, effort: 'quick',
    headline: 'Some links have no readable text',
    what: (c) => `${plural(c.failed, 'link has', 'links have')} no text a person or a search engine can read.`,
    why: 'Link text is one of the clearest signals of what the destination page is about. A blank link passes none of that on, and is unusable with a screen reader.',
    fix: 'Give each link descriptive text, or a label where the link is an icon.',
  },
  nondesc_anchor: {
    area: 'content', impact: 1, effort: 'quick',
    headline: 'Links say "click here" rather than what they lead to',
    what: (c) => `${plural(c.failed, 'link uses', 'links use')} generic wording such as "click here" or "read more".`,
    why: 'Link text is how both visitors and search engines predict what is on the other side. Generic wording throws that away on every link.',
    fix: 'Rewrite the link text to describe the destination.',
  },
  charset: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Pages do not declare their text encoding',
    what: (c) => `${plural(c.failed, 'page is', 'pages are')} missing the declaration that tells a browser how to read its text.`,
    why: 'Without it, apostrophes and accented characters can display as stray symbols on some browsers. Cosmetic - and it looks careless on a page a customer is reading.',
    fix: 'Add the encoding declaration to the site template.',
  },
  doctype: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Pages are missing a standard declaration',
    what: (c) => `${plural(c.failed, 'page does', 'pages do')} not open with the standard document declaration.`,
    why: 'Browsers fall back to a compatibility mode that can render the page differently from how it was designed.',
    fix: 'Add the declaration to the site template.',
  },
  nofollow: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Internal links are marked to be ignored',
    what: (c) => `${plural(c.failed, 'internal link carries', 'internal links carry')} an instruction telling search engines not to follow it.`,
    why: 'These links exist for visitors but pass no value to their destination, so the pages they point at are weaker than the site structure suggests.',
    fix: 'Remove the instruction from internal links leading to pages that are meant to rank.',
  },
  resource_links: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Files are linked as if they were pages',
    what: (c) => `${plural(c.failed, 'link presents', 'links present')} a file as though it were a page.`,
    why: 'Search engines follow these as pages and find a document instead, which spends the crawl allowance the site is given on nothing.',
    fix: 'Link files with the correct markup so they are treated as downloads.',
  },
  multiple_title: {
    area: 'content', impact: 2, effort: 'quick',
    headline: 'Pages contain more than one title',
    what: (c) => `${plural(c.failed, 'page has', 'pages have')} two or more titles in its code.`,
    why: 'Search engines pick one, and not always the one you intended - so the listing a customer sees may not be the one that was written.',
    fix: 'Remove the duplicate titles, usually left behind by a plugin or a template.',
  },
  unverified_links: {
    area: 'foundations', impact: 1, effort: 'quick',
    headline: 'Some links could not be checked',
    what: (c) => `${plural(c.failed, 'link', 'links')} could not be verified, because the destination blocked our check rather than answering it.`,
    why: 'This is not evidence of a problem. It is listed so the report is explicit about what it could not confirm, rather than quietly reporting those links as healthy.',
    fix: 'No action needed unless a specific link is already known to be broken.',
  },
};

// ---------------------------------------------------------------------------
// Whole-site crawlability and AI-crawler readiness (lib/aiseo/siteReadiness).
// Only the findings a client benefits from seeing are given copy; the rest fall
// through to the generic translation below.
// ---------------------------------------------------------------------------
const READINESS = {
  site_unreachable: {
    area: 'foundations', impact: 5, effort: 'moderate',
    headline: 'The site could not be read reliably',
    what: () => 'Our crawler could not fetch pages from the site the way a search engine would.',
    why: 'If an automated visitor cannot read the site, neither can a search engine. Nothing else in this report matters until this is resolved.',
    fix: 'Check that the site answers ordinary automated requests from outside your own network, and that no security layer is blocking them.',
  },
};

// Any siteReadiness finding whose key starts with one of these prefixes is an
// AI-crawler access question rather than a classic SEO one, and is filed under
// the AI area so the scorecard and the issue list agree.
const AI_KEY_PREFIXES = ['ai_', 'llms', 'agent_', 'retrieval'];

// ---------------------------------------------------------------------------
// Structured data (lib/aiseo/schemaAuto).
// ---------------------------------------------------------------------------
const SCHEMA_CARD = {
  area: 'ai', topic: 'schema', impact: 3, effort: 'moderate',
  headline: 'The site does not describe itself in a way search engines can reuse',
  what: (detail) => detail
    || 'Key pages are missing the machine-readable description that search engines and AI assistants read.',
  why: 'This hidden description is what produces the extra detail in a search listing - star ratings, prices, opening hours, FAQ answers - and it is a primary source for AI assistants answering questions about a business. Without it your listing is plain text beside competitors showing rich ones.',
  fix: 'Add structured descriptions for the organisation, its services, and the pages where extra detail can be displayed.',
};

// ---------------------------------------------------------------------------
// Core Web Vitals, explained in the terms Google uses, with the threshold
// stated so a client can see how far off they are.
// ---------------------------------------------------------------------------
const VITALS = {
  LARGEST_CONTENTFUL_PAINT_MS: {
    label: 'Loading speed',
    plain: 'How long before the main content of the page appears.',
    good: 'under 2.5 seconds',
    why: 'This is the number a visitor experiences as "the site is slow", and Google uses it as a ranking factor on mobile.',
  },
  INTERACTION_TO_NEXT_PAINT: {
    label: 'Responsiveness',
    plain: 'How quickly the page reacts when someone taps or clicks.',
    good: 'under 200 milliseconds',
    why: 'A page that lags when tapped feels broken, so visitors tap again - which is how enquiries get submitted twice, or abandoned.',
  },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: {
    label: 'Visual stability',
    plain: 'How much the page moves around while it is loading.',
    good: 'under 0.1',
    why: 'Content that shifts as it loads causes taps on the wrong button - most expensively on a form or a checkout.',
  },
  FIRST_CONTENTFUL_PAINT_MS: {
    label: 'First impression',
    plain: 'How long before anything at all appears on screen.',
    good: 'under 1.8 seconds',
    why: 'A blank screen is the moment a visitor decides whether to wait or leave.',
  },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: {
    label: 'Server response',
    plain: 'How long the server takes to start answering.',
    good: 'under 0.8 seconds',
    why: 'Everything else on the page waits for this, so it sets the ceiling on how fast the site can be.',
  },
};

// ---------------------------------------------------------------------------
// translate(): one finding in, one client-facing card out.
// ---------------------------------------------------------------------------
const CATALOG = { ...CRAWL, ...READINESS };

// The crawler's tiers and the AI SEO severities are two vocabularies for the
// same idea; both map onto the three words this report uses with a client.
const SEVERITY_FROM_TIER = {
  error: 'critical', critical: 'critical', high: 'critical',
  warning: 'important', medium: 'important',
  notice: 'worth fixing', low: 'worth fixing', info: 'worth fixing',
};

// A FLOOR THE CRAWLER'S DISPLAY TIER CANNOT UNDERCUT.
//
// The crawler files several checks as "notice" because of how it counts them,
// not because of what they mean. `non_indexable` is the clearest case: six
// pages carrying a noindex tag is one line in a technical audit and is "this
// section of your website cannot appear in Google at all" to the person
// reading this report. Left at the tier the crawler assigns, it ranked below a
// large count of missing image descriptions.
//
// So an entry may declare the least serious thing it is allowed to be called.
// This only ever raises a severity; a check the crawler escalated to `error`
// on a particular site keeps that.
const SEVERITY_RANK = { 'worth fixing': 0, important: 1, critical: 2 };
const SEVERITY_FLOOR = {
  non_indexable: 'critical',
  host_duplicate: 'critical',
  http_status: 'critical',
  canonicalized: 'important',
  canonical: 'important',
  sitemap_robots: 'important',
  orphans: 'important',
  slow_pages: 'important',
  weak_linking: 'worth fixing',
};

function severityFor(key, tier) {
  const fromTier = SEVERITY_FROM_TIER[tier] || 'worth fixing';
  const floor = SEVERITY_FLOOR[key];
  if (!floor) return fromTier;
  return SEVERITY_RANK[floor] > SEVERITY_RANK[fromTier] ? floor : fromTier;
}

function areaForUnmapped(key) {
  return AI_KEY_PREFIXES.some((p) => String(key || '').startsWith(p)) ? 'ai' : 'foundations';
}

function translate(finding) {
  const key = finding.key || finding.id || finding.checkKey || finding.check_key;
  const entry = CATALOG[key] || null;
  const ctx = {
    failed: Number(finding.failed || finding.affectedCount || finding.affected_count || 0),
    total: Number(finding.total || 0),
    unit: finding.unit || 'pages',
    summary: finding.summary || null,
    detail: finding.detail || null,
  };
  const severity = severityFor(key, finding.tier || finding.severity);
  const examples = (finding.items || [])
    .slice(0, 6)
    .map((it) => (typeof it === 'string' ? { url: it, note: null } : { url: it.url || null, note: it.note || null }))
    .filter((it) => it.url || it.note);

  if (!entry) {
    // An unmapped check still reaches the client, in the tool's own words.
    // Dropping it would make the report quietly incomplete, which is worse than
    // one sentence that reads more technically than the rest.
    const area = areaForUnmapped(key);
    return {
      key,
      area,
      areaLabel: AREAS[area],
      topic: topicFor(key, area),
      topicLabel: TOPIC_LABEL[topicFor(key, area)],
      headline: finding.name || finding.title || 'Issue found',
      what: finding.summary || finding.detail || '',
      why: null,
      fix: finding.action || null,
      severity,
      impact: severity === 'critical' ? 4 : (severity === 'important' ? 2 : 1),
      effort: 'moderate',
      effortLabel: EFFORT.moderate.label,
      horizon: EFFORT.moderate.horizon,
      count: ctx.failed,
      total: ctx.total,
      unit: ctx.unit,
      examples,
      mapped: false,
    };
  }

  return {
    key,
    area: entry.area,
    areaLabel: AREAS[entry.area],
    topic: topicFor(key, entry.area),
    topicLabel: TOPIC_LABEL[topicFor(key, entry.area)],
    headline: entry.headline,
    what: typeof entry.what === 'function' ? entry.what(ctx) : entry.what,
    why: entry.why,
    fix: entry.fix,
    severity,
    impact: entry.impact,
    effort: entry.effort,
    effortLabel: EFFORT[entry.effort].label,
    horizon: EFFORT[entry.effort].horizon,
    count: ctx.failed,
    total: ctx.total,
    unit: ctx.unit,
    examples,
    mapped: true,
  };
}

// Priority = how much this holds rankings back, times how widespread it is.
//
// Prevalence is the square root of the affected fraction, for the same reason
// the crawler's own health score uses it: a problem appearing at all says more
// about the site than its hundredth instance does. Without that, one enormous
// missing-alt-text count outranked an entire section being blocked from search.
function priority(card) {
  const total = Number(card.total || 0);
  const failed = Number(card.count || 0);
  const prevalence = total > 0 ? Math.sqrt(Math.min(1, failed / total)) : (failed > 0 ? 0.6 : 0);
  const sev = card.severity === 'critical' ? 1 : (card.severity === 'important' ? 0.62 : 0.3);
  return Math.round(Number(card.impact || 1) * 20 * sev * (0.35 + 0.65 * prevalence));
}

module.exports = {
  AREAS, EFFORT, VITALS, SCHEMA_CARD, CATALOG, CRAWL, READINESS,
  TOPICS, TOPIC_LABEL, TOPIC_OF, topicFor,
  translate, priority, severityFor, SEVERITY_FROM_TIER, SEVERITY_FLOOR,
};
