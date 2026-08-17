// Constants and locale handling for the internal linking agent.
//
// Ported from tools/internal-linking-agent/internal_link_agent.py. The word
// lists are not re-typed: they are exported verbatim from the Python module
// into wordlists.json, so both implementations tokenize, reject generic
// anchors and trim dangling fragments using byte-identical vocabularies. A
// hand-copied stopword list that drifted by even one word would change which
// phrases qualify as anchors, and the difference would be invisible until a
// client asked why two runs disagreed.
const path = require('path');
const WORDLISTS = require('./wordlists.json');

const USER_AGENT = 'Mozilla/5.0 (compatible; InternalLinkingAgent/1.0; +https://example.com/bot)';

const DEFAULTS = {
  max_pages: 300,
  concurrency: 8,
  request_timeout: 20.0,
  delay: 0.15,                  // polite pause per worker between requests
  min_source_words: 120,        // a page needs this much body copy to be a link source
  max_new_links_per_source: 3,
  max_new_inbound_per_target: 5,
  max_editorial_out_per_page: 18,   // link saturation ceiling
  words_per_link: 125,              // density ceiling: 1 in-content link / N words
  top_k_similar: 8,             // per page, consider this many nearest neighbours
  min_similarity: 0.045,        // absolute cosine floor
  boilerplate_ratio: 0.55,      // link present on >= this share of pages == site-wide
  cannibal_similarity: 0.42,
  template_block_ratio: 0.20,   // identical text block on >= this share == template
  link_density_block: 0.60,     // block this fraction link text == link list, not prose
  repeated_h1_ratio: 0.35,      // same H1 on >= this share == site branding, not topic
  cannibal_min_words: 150,      // thin pages produce unstable similarity - don't judge
  cannibal_kw_min_sim: 0.30,    // shared keyword must be backed by body overlap
  max_same_anchor: 2,           // reuse of one exact anchor string, site-wide
  duplicate_similarity: 0.95,   // at/above this, pages are duplicates not rivals
  render_concurrency: 4,
  render_timeout: 20.0,
  render_settle: 1.5,

  // One definition of "thin", used everywhere.
  min_content_words: 40,

  // Anchor relevance. An anchor phrase must actually identify the page it
  // points at; a phrase that equally describes many pages ("web development
  // company" on a site with one such page per city) tells the reader nothing
  // about where they will land.
  anchor_max_owners: 1,
  anchor_token_df_ratio: 0.15,
  anchor_sentence_terms: 1,

  // Politeness
  crawl_delay_cap: 2.0,
  retry_statuses: [429, 500, 502, 503, 504],
  max_retries: 3,
};

// Recommendation tiers, strongest first.
//   high               - verbatim multi-word anchor already on the source page
//   single-word        - verbatim but one word only, so context may not fit
//   needs-new-sentence - relevant target, but no suitable existing phrase
const TIER_ORDER = { high: 0, 'single-word': 1, 'needs-new-sentence': 2 };

const SKIP_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.zip', '.rar', '.gz', '.tar', '.7z', '.dmg', '.exe', '.apk',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.webm', '.m4a', '.wav',
  '.css', '.js', '.json', '.xml', '.rss', '.atom', '.txt', '.woff', '.woff2',
  '.ttf', '.eot', '.map',
]);

const TRACKING_PREFIXES = /^(utm_|ga_|_ga|mc_[ce]id|vero_|_hs|hsa_|pk_|piwik_)/i;

// Exact parameter names. These MUST be matched exactly: as prefixes, "ref"
// would strip "refine" and "reference", "cid" would strip "cidx", and "source"
// would strip "source_category" — silently collapsing genuinely different URLs
// into one, so the second is never crawled and its links are misattributed.
const TRACKING_EXACT = new Set([
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'igshid', 'yclid',
  'twclid', 'ttclid', 'li_fat_id', 'ref', 'referrer', 'source', 'campaign',
  'trk', 'sessionid', 'phpsessid', 'jsessionid', 'cid', 'epik', 's_kwcid',
  'gad_source', 'srsltid', 'mkt_tok',
]);

function isTrackingParam(name) {
  return TRACKING_PREFIXES.test(name) || TRACKING_EXACT.has(String(name).toLowerCase());
}

// Unambiguous chrome. These words never describe article copy, so they win
// outright — "main-menu" and "elementor-nav-menu" are navigation regardless of
// what else the class name contains.
const STRONG_CHROME = /(^|[-_\s])(nav|navbar|navigation|menu|megamenu|footer|masthead|location-header|location-footer|breadcrumb|crumb|sidebar|side-bar|topbar|toolbar|offcanvas|drawer|cookie|consent|gdpr|popup|modal|skip-link|screen-reader|sr-only|visually-hidden|pagination|pager|site-map|sitemap|widget-area|widgets)([-_\s]|$)/i;

// Ambiguous markers. Page builders reuse these for the article body itself, so
// a content marker overrides them. Elementor wraps real copy in
// "elementor-widget-container"; treating that as chrome deleted whole pages.
const WEAK_CHROME = /(^|[-_\s])(header|aside|banner|promo|utility|share|social|recirc|newsletter|subscribe|comment|disqus|tag-cloud|archive-list|related|recommend)([-_\s]|$)/i;

// Trailing boundary matters: without it "page" prefix-matches "pager" and
// "text" matches "texture". Tokens that collide with chrome names (main, page,
// section) are deliberately absent — STRONG_CHROME already wins.
const CONTENT_SAFE = /(^|[-_\s])(entry|post|article|single|blog|product|service|card|hero|elementor|wp-block|content|body|copy|text|editor|rich|prose)([-_\s]|$)/i;

function looksBoilerplate(blob) {
  if (!String(blob || '').trim()) return false;
  if (STRONG_CHROME.test(blob)) return true;
  return WEAK_CHROME.test(blob) && !CONTENT_SAFE.test(blob);
}

const MAIN_SELECTORS = [
  'main', 'article', '[role=main]', '#main', '#content', '#main-content',
  '.main-content', '.entry-content', '.post-content', '.page-content',
  '.article-body', '.content-area', '.rich-text', '.prose', '.elementor-widget-container',
];

const TEXT_BLOCK_TAGS = ['p', 'li', 'blockquote', 'dd', 'td', 'figcaption',
  'h2', 'h3', 'h4', 'h5', 'h6'];

const PROSE_TAGS = new Set(['p', 'li', 'blockquote', 'dd', 'div']);

// \p{L} is the JavaScript equivalent of Python's [^\W\d_] under re.UNICODE:
// letters only, no digits, no underscore. The optional apostrophe group keeps
// "don't" and "client's" as single tokens, as the Python does.
const WORD_RE = /\p{L}+(?:['’]\p{L}+)?/gu;

// Split on sentence-final punctuation followed by whitespace and something that
// starts a new sentence. Lookbehind is supported in Node 18+.
const SENTENCE_SPLIT = /(?<=[.!?…])[\s ]+(?=["'(“‘]?\p{L})/u;

// Prepositions that, as the second-to-last word of a candidate anchor, mean the
// phrase is a prepositional tail cut out of a longer title rather than a
// self-contained noun phrase. "web design in chicago" is fine because "in" is
// not in this set — locative prepositions produce legitimate anchors; the
// relational ones below almost never do.
const ANCHOR_TAIL_PREPOSITIONS = new Set([
  'with', 'from', 'by', 'via', 'through', 'about', 'against', 'among',
  'between', 'during', 'without', 'within', 'toward', 'towards', 'upon',
]);

// --- locale ---------------------------------------------------------------
// The active word lists live in this mutable object rather than as module
// constants, because apply_locale() swaps them for the run's language exactly
// as the Python does. Everything downstream reads through `L`.
const L = {
  locale: 'en',
  STOPWORDS: new Set(),
  GENERIC_ANCHORS: new Set(),
  GENERIC_CONTENT_WORDS: new Set(),
  DANGLING_TAIL_WORDS: new Set(),
  CLAUSE_VERBS: new Set(),
};

// Returns the locale actually applied, which is 'en' when the requested one is
// unknown — a warning rather than a failure, matching the Python.
function applyLocale(requested) {
  const want = String(requested || 'en').toLowerCase().split(/[-_]/)[0];
  const chosen = WORDLISTS[want] ? want : 'en';
  const w = WORDLISTS[chosen];
  L.locale = chosen;
  L.STOPWORDS = new Set(w.STOPWORDS);
  L.GENERIC_ANCHORS = new Set(w.GENERIC_ANCHORS);
  L.GENERIC_CONTENT_WORDS = new Set(w.GENERIC_CONTENT_WORDS);
  L.DANGLING_TAIL_WORDS = new Set(w.DANGLING_TAIL_WORDS);
  // The clause-verb heuristic depends on English SVO word order and a closed
  // set of auxiliaries. It does not translate cleanly, so it is shipped empty
  // for every locale except English rather than as a low-quality translation.
  L.CLAUSE_VERBS = new Set(chosen === 'en' ? w.CLAUSE_VERBS : []);
  return chosen;
}

applyLocale('en');

// Accept-Language sent while crawling, so a multilingual site serves the copy
// the run is actually meant to analyse.
function acceptLanguageHeader(locale) {
  const base = String(locale || 'en').toLowerCase().split(/[-_]/)[0];
  if (base === 'en') return 'en-US,en;q=0.9';
  return `${base},${base}-${base.toUpperCase()};q=0.9,en;q=0.5`;
}

module.exports = {
  USER_AGENT, DEFAULTS, TIER_ORDER, SKIP_EXTENSIONS,
  isTrackingParam, looksBoilerplate,
  STRONG_CHROME, WEAK_CHROME, CONTENT_SAFE,
  MAIN_SELECTORS, TEXT_BLOCK_TAGS, PROSE_TAGS,
  WORD_RE, SENTENCE_SPLIT, ANCHOR_TAIL_PREPOSITIONS,
  L, applyLocale, acceptLanguageHeader,
  WORDLISTS_PATH: path.join(__dirname, 'wordlists.json'),
};
