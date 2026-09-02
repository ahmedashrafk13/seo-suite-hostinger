// BOILERPLATE AND NOISE — what to exclude before measuring content.
//
// THE THREE BUGS THIS FIXES
//
// 1. SKEWED CONTENT METRICS. ./fetcher.js picks a main-content container and,
//    when no candidate holds enough of the page's text, falls back to <body>.
//    That fallback is the right call for word count — it is never wrong in the
//    direction that matters — but it means readability, entity density,
//    keyword density and semantic coverage were all being computed over the
//    navigation, the cookie banner, the footer link farm and the social icon
//    row. On a short page that is most of the words, and it moves every score.
//
// 2. GENERIC UI TEXT REPORTED AS A MISSING SEMANTIC ENTITY. "Learn More",
//    "Check", "Get Started", "Why Choose Us", "Office Headquarters" are not
//    entities. They were being extracted, counted, compared against
//    competitors and emitted as "subjects competitors cover and this site does
//    not", which sends a writer to add a button.
//
// 3. COMPETITOR BRAND NAMES REPORTED AS MISSING ENTITIES. "Starfish", "Saint
//    Urbain" — a competitor's own brand, product and location names are the
//    single most common thing a competitor page names and this brand's page
//    does not, and they are the one thing that must never be recommended. A
//    gap analysis that says "add Starfish to your page" is worse than no gap
//    analysis.
//
// WHAT THIS MODULE IS NOT
// It is not a readability library and it does not guess. Every exclusion is
// either structural (the text sits inside a <nav>/<footer>/<aside>), positional
// (the same short string repeats across pages of the same site, which is the
// definition of a template), or listed by name below. A caller can always see
// what was removed: every function returns the excluded material alongside the
// cleaned material.
const cheerio = require('cheerio');

// ------------------------------------------------ structural boilerplate

// Containers whose contents are, by definition, not the page's content.
// Ordered roughly by how reliable each is.
const BOILERPLATE_SELECTORS = [
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[aria-label*="breadcrumb" i]', '[aria-label*="navigation" i]', '[aria-label*="social" i]',
  '.nav', '.navbar', '.navigation', '.menu', '.main-menu', '.mega-menu', '.topbar', '.top-bar',
  '.site-header', '.site-footer', '.page-header__nav', '.header-inner', '.footer-inner',
  '.breadcrumb', '.breadcrumbs', '[class*="breadcrumb"]',
  '.sidebar', '.widget', '.widgets', '.widget-area', '.offcanvas', '.off-canvas',
  '.cookie', '.cookies', '.cookie-banner', '.cookie-notice', '.gdpr', '.consent',
  '#cookie-notice', '#cookie-law-info-bar', '.cc-window', '.osano-cm-window',
  '.social', '.socials', '.social-links', '.social-icons', '.share', '.sharing', '.share-buttons',
  '.skip-link', '.screen-reader-text', '.visually-hidden', '.sr-only',
  '.newsletter', '.subscribe-form', '.mc4wp-form',
  '.modal', '.popup', '.lightbox', '.overlay', '.drawer',
  '.pagination', '.pager', '.page-numbers',
  '.related-posts', '.post-navigation', '.nav-links',
  '.copyright', '.legal', '.disclaimer-bar',
  '.back-to-top', '.scroll-top',
  'noscript', 'template', 'svg', 'script', 'style', 'iframe',
];

// Interactive controls whose label is UI text, not prose. Removed as well,
// because a page with twenty "Add to cart" buttons should not read as a page
// that says "add to cart" twenty times.
const CONTROL_SELECTORS = ['button', 'select', 'option', '[role="button"]', 'input', 'label.sr-only'];

// ------------------------------------------------------- generic UI phrases

// Exact-match phrases that are UI chrome wherever they appear. Matched
// case-insensitively against a WHOLE candidate entity or heading, never as a
// substring — "Check" is chrome, "Check Point Software" is a company.
const GENERIC_UI = new Set([
  // buttons and links
  'learn more', 'read more', 'find out more', 'discover more', 'see more', 'show more',
  'view more', 'view all', 'see all', 'browse all', 'shop all', 'explore', 'explore more',
  'get started', 'start now', 'start here', 'begin', 'continue', 'next', 'previous', 'back',
  'submit', 'send', 'send message', 'sign up', 'sign in', 'log in', 'login', 'logout',
  'register', 'subscribe', 'subscribe now', 'join now', 'join', 'apply', 'apply now',
  'download', 'download now', 'download pdf', 'get quote', 'get a quote', 'request a quote',
  'request info', 'request information', 'contact us', 'call us', 'call now', 'email us',
  'book now', 'book online', 'reserve', 'reserve a table', 'order now', 'order online',
  'buy now', 'add to cart', 'add to basket', 'checkout', 'view cart', 'my cart',
  'enroll now', 'enrol now', 'enroll', 'register now', 'schedule a call', 'book a demo',
  'get in touch', 'talk to us', 'chat with us', 'live chat', 'help', 'support',
  'check', 'check now', 'check availability', 'search', 'filter', 'sort', 'reset', 'clear',
  'close', 'cancel', 'ok', 'yes', 'no', 'more', 'less', 'menu', 'toggle navigation',
  'skip to content', 'skip to main content', 'accept', 'accept all', 'accept cookies',
  'decline', 'manage preferences', 'cookie settings', 'privacy settings',
  'share', 'share this', 'tweet', 'pin it', 'follow us', 'like us',
  'print', 'save', 'copy link', 'back to top', 'load more', 'show less',
  // marketing section headings that name nothing
  'why choose us', 'why choose', 'why us', 'about us', 'about', 'our story', 'our team',
  'our mission', 'our vision', 'our values', 'our services', 'our work', 'our clients',
  'our process', 'how it works', 'what we do', 'who we are', 'meet the team',
  'testimonials', 'reviews', 'case studies', 'portfolio', 'gallery', 'faq', 'faqs',
  'frequently asked questions', 'get to know us', 'what our clients say',
  'contact', 'contact information', 'contact details', 'get directions', 'directions',
  'office headquarters', 'head office', 'headquarters', 'main office', 'our office',
  'our offices', 'our locations', 'locations', 'find us', 'visit us', 'opening hours',
  'business hours', 'hours of operation', 'quick links', 'useful links', 'helpful links',
  'related links', 'site map', 'sitemap', 'newsletter', 'stay in touch', 'stay updated',
  'follow', 'connect', 'connect with us', 'social media', 'legal', 'legal notice',
  'terms', 'terms of service', 'terms and conditions', 'terms of use', 'privacy',
  'privacy policy', 'cookie policy', 'refund policy', 'shipping policy', 'disclaimer',
  'accessibility', 'accessibility statement', 'copyright', 'all rights reserved',
  'blog', 'news', 'articles', 'resources', 'insights', 'latest', 'latest news',
  'latest posts', 'recent posts', 'popular posts', 'categories', 'tags', 'archive',
  'home', 'homepage', 'pricing', 'plans', 'plans and pricing', 'compare plans',
  'features', 'benefits', 'solutions', 'products', 'services', 'industries',
  'careers', 'jobs', 'work with us', 'join our team', 'partners', 'press', 'media',
  'free', 'free trial', 'start free trial', 'no credit card required',
  'read the full story', 'view case study', 'see pricing', 'view details', 'details',
  'available now', 'coming soon', 'new', 'popular', 'featured', 'recommended',
  'best seller', 'best sellers', 'top rated', 'on sale', 'sale', 'offers', 'deals',
]);

// Repeated commercial labels that are template furniture rather than content.
// Matched as a whole trimmed line, which is how they appear in a price table.
const PRICING_LABEL_RX = /^(?:from|starting (?:at|from)|only|just|as low as|per (?:month|year|user|seat|person|night|day|hour)|\/\s*(?:mo|month|yr|year|user)|incl\.?\s*vat|excl\.?\s*vat|\+\s*vat|inc\s*vat|save\s+\d+%?|was\s+[^\s]+|now\s+[^\s]+|rrp|msrp|free\s+shipping|in\s+stock|out\s+of\s+stock|sold\s+out|\d+\s*%\s*off|billed\s+\w+|cancel\s+anytime|most\s+popular|best\s+value|per\s+\w+\s*\/\s*\w+)$/i;

// A bare price, a bare currency amount, or a bare number with a unit. These
// repeat once per card in a pricing grid and dominate the statistic-entity
// count on any page with a price table.
const BARE_PRICE_RX = /^(?:[$£€¥₹]\s?\d[\d,.]*(?:\s?(?:\/|per)\s?\w+)?|\d[\d,.]*\s?(?:usd|gbp|eur|aud|cad|inr|pkr|aed|sar)|\d+\s*(?:%|%\s*off))$/i;

function isGenericUi(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/[–—>»→←→]+$/g, '')
    .replace(/[.:!?]+$/g, '')
    .trim();
  if (!t) return true;
  if (GENERIC_UI.has(t)) return true;
  if (PRICING_LABEL_RX.test(t)) return true;
  if (BARE_PRICE_RX.test(t)) return true;
  // "Learn More About Our Services" style: a generic opener plus filler.
  if (/^(?:learn|read|find out|discover|see|view|explore|get|start|shop|browse|click)\s+(?:more|all|now|here|today)\b/.test(t)) return true;
  return false;
}

// ------------------------------------------------- content text extraction

// The page's text with the boilerplate removed.
//
// Returns BOTH the cleaned text and what was taken out, and never returns an
// empty string when the page had text: if stripping would remove nearly
// everything — which happens on a page built entirely of <div class="widget">
// — the original is kept and `fellBack` says so. An empty contentText would
// make every downstream score read as "thin content", which is precisely the
// class of bug ./fetcher.js already guards against for the main selector.
function contentText(doc, { minRetainedShare = 0.25 } = {}) {
  if (!doc) return { text: '', words: 0, removed: [], fellBack: false, selectorsMatched: [] };

  const html = doc.$ ? doc.$.html() : null;
  const source = doc.mainText || doc.bodyText || '';
  if (!html) return { text: source, words: wordCount(source), removed: [], fellBack: true, reason: 'no parsed document', selectorsMatched: [] };

  // Reparsing rather than mutating doc.$ — doc.$ is shared with every other
  // feature that received this document, and removing nodes from it would
  // silently change their link counts, image counts and heading lists.
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const removed = [];
  const selectorsMatched = [];

  BOILERPLATE_SELECTORS.forEach((sel) => {
    let nodes;
    try { nodes = $(sel); } catch { return; }
    if (!nodes.length) return;
    let removedHere = 0;
    nodes.each((_, el) => {
      const t = textOf($, $(el));
      if (t) removed.push({ selector: sel, chars: t.length, preview: t.slice(0, 120) });
      $(el).remove();
      removedHere += 1;
    });
    if (removedHere) selectorsMatched.push({ selector: sel, nodes: removedHere });
  });

  CONTROL_SELECTORS.forEach((sel) => {
    try { $(sel).remove(); } catch { /* selector unsupported by the parser */ }
  });

  // Anchors whose entire visible text is generic UI chrome. The anchor goes,
  // the surrounding sentence stays — which is the opposite of removing the
  // whole paragraph a "Learn more" link happens to sit in.
  $('a').each((_, el) => {
    const t = textOf($, $(el));
    if (t && isGenericUi(t)) $(el).remove();
  });

  // Small leaf elements whose ENTIRE text is a repeated pricing label or a
  // bare price. This has to happen in the DOM rather than on the joined text:
  // a pricing grid renders as <span>From</span><span>$99</span><span>per
  // month</span>, which becomes the single run "From $99 per month" once the
  // text nodes are joined, and no line-level rule can take that apart without
  // risking real prose. Capped at 60 characters so a sentence that merely
  // begins with "From" is never touched.
  const LEAF_TAGS = 'span, small, em, strong, b, i, li, td, th, dd, dt, div, p, figcaption';
  $(LEAF_TAGS).each((_, el) => {
    const $el = $(el);
    // Only leaves: an element containing other elements may hold real content
    // whose concatenation happens to look like a label.
    if ($el.children().length) return;
    const t = textOf($, $el);
    if (!t || t.length > 60) return;
    if (isGenericUi(t)) {
      removed.push({ selector: '(leaf label)', chars: t.length, preview: t });
      $el.remove();
    }
  });

  const root = $('main').first().length ? $('main').first()
    : ($('article').first().length ? $('article').first() : $('body'));
  let text = textOf($, root.length ? root : $.root());

  // Line-level pass: drop standalone lines that are pure pricing furniture or
  // a bare price. These survive the structural pass because they sit in the
  // page's real content region.
  const lines = text.split(/(?<=[.!?])\s+|\s{2,}/);
  const keptLines = [];
  lines.forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (t.length <= 40 && isGenericUi(t)) { removed.push({ selector: '(line)', chars: t.length, preview: t }); return; }
    keptLines.push(t);
  });
  text = keptLines.join(' ').replace(/\s+/g, ' ').trim();

  const originalWords = wordCount(source);
  const cleanedWords = wordCount(text);
  const share = originalWords ? cleanedWords / originalWords : 1;

  // The fallback fires in two cases, and the second one matters more than the
  // threshold it sits beside:
  //
  //   share below the floor  the filter took most of the page, which means the
  //                          real content is inside elements it treats as
  //                          chrome. Only judged on pages long enough for a
  //                          ratio to mean anything.
  //   NOTHING LEFT           the filter took everything. This is checked at ANY
  //                          length, because a short page reduced to zero words
  //                          is the worst possible outcome — every downstream
  //                          metric then reads it as thin content, which is
  //                          precisely the class of bug the main-selector guard
  //                          in ./fetcher.js exists to prevent, reintroduced one
  //                          layer later.
  const strippedToNothing = originalWords > 0 && cleanedWords === 0;
  if (strippedToNothing || (originalWords >= 60 && share < minRetainedShare)) {
    return {
      text: source,
      words: originalWords,
      removed,
      selectorsMatched,
      fellBack: true,
      reason: strippedToNothing
        ? `stripping boilerplate left NO text at all (${originalWords} words before), which means the page's entire content sits inside elements this pass treats as chrome — a bare <div class="widget"> wrapper is the usual cause. Measured from the unstripped text instead so the page is not misread as empty.`
        : `stripping boilerplate left only ${Math.round(share * 100)}% of the text (${cleanedWords} of ${originalWords} words), which means the page's real content is inside elements this pass treats as chrome. Measured from the unstripped text instead so the page is not misread as thin.`,
      strippedWords: cleanedWords,
    };
  }

  return {
    text,
    words: cleanedWords,
    originalWords,
    retainedShare: Math.round(share * 100),
    removedChars: removed.reduce((a, r) => a + r.chars, 0),
    removed: removed.slice(0, 40),
    selectorsMatched,
    fellBack: false,
  };
}

function textOf($, node) {
  const parts = [];
  const walk = (el) => {
    if (!el) return;
    if (el.type === 'text') {
      const t = String(el.data || '').trim();
      if (t) parts.push(t);
      return;
    }
    const tag = (el.name || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'svg') return;
    (el.children || []).forEach(walk);
  };
  (node || $('body')).toArray().forEach(walk);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// ------------------------------------------- cross-page repeated blocks

// The definitive boilerplate test, available only when several pages of the
// same site are in hand: a string that appears verbatim on most of them is a
// template, whatever markup it sits in.
//
// Used by ./competitive.js and ./architecture.js, which both crawl a set of
// pages and were both counting a site's footer text once per page.
// Elements whose text is a self-contained unit. Collected in addition to the
// sentence split below, because the most damaging template blocks are NOT
// sentences and the split never isolates them.
//
// Verified against a live site: a feature list rendered on every page as
// `<li>Unlimited Pages Website with Unique Design</li>` was invisible to a
// sentence-boundary split — it has no terminating punctuation, so it merged
// into a longer run with its neighbours and never repeated verbatim. It sat in
// a plain <div> with no nav, footer or template class, so the selector pass
// missed it too. The link finder then recommended it as an anchor once per
// page, producing six identical rows. Reading the leaf elements directly is
// what catches it.
const BLOCK_ELEMENTS = 'li, td, th, dd, dt, figcaption, p, h1, h2, h3, h4, h5, h6, blockquote, label, summary';

function repeatedBlocks(docs, { minShare = 0.6, minLength = 12, maxLength = 400 } = {}) {
  const usable = (docs || []).filter(Boolean);
  if (usable.length < 3) return { blocks: new Set(), pages: usable.length, usable: false };

  const counts = new Map();
  usable.forEach((doc) => {
    const seen = new Set();
    const record = (raw) => {
      const t = String(raw || '').replace(/\s+/g, ' ').trim();
      if (t.length < minLength || t.length > maxLength) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    };

    const text = doc.bodyText || doc.mainText || '';
    // Sentence-ish segments, so a repeated footer paragraph is caught whole.
    text.split(/(?<=[.!?])\s+|\s{2,}|\|/).forEach(record);

    // Per-element text, which catches the non-sentence blocks the split above
    // cannot: list items, table cells, captions, definition terms.
    if (doc.$) {
      try {
        doc.$(BLOCK_ELEMENTS).each((_, el) => {
          const $el = doc.$(el);
          // Leaves only. A <p> wrapping three <span>s is recorded once, as the
          // <p>; recording both it and its children would count the same text
          // twice and inflate every repetition count.
          if ($el.children().length && !/^(p|li|td|th|dd|dt|h[1-6]|blockquote)$/i.test(el.name || '')) return;
          record($el.text());
        });
      } catch { /* a document with no live $ falls back to the text split alone */ }
    }

    (doc.headings || []).forEach((h) => record(h.text));
  });

  const threshold = Math.max(3, Math.ceil(usable.length * minShare));
  const blocks = new Set();
  const examples = [];
  counts.forEach((count, key) => {
    if (count < threshold) return;
    blocks.add(key);
    if (examples.length < 25) examples.push({ text: key.slice(0, 140), pages: count });
  });

  return {
    blocks,
    examples: examples.sort((a, b) => b.pages - a.pages),
    pages: usable.length,
    threshold,
    usable: true,
    basis: `text appearing verbatim on at least ${threshold} of ${usable.length} crawled pages, read both as sentence segments and as whole list items, table cells, captions and headings`,
  };
}

// ------------------------------------------------------- entity noise filter

// Brand terms for a competitor, derived from what we actually know about them:
// the registrable part of their domain, and the brand half of their homepage
// title. Both are real evidence; neither is a guess.
function competitorBrandTerms(competitors = []) {
  const terms = new Set();
  const add = (raw) => {
    const t = String(raw || '').toLowerCase().replace(/[^a-z0-9 &'-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 3) return;
    terms.add(t);
    // A two-word brand also blocks each distinctive word, because a
    // competitor page names "Saint Urbain" and "Urbain" interchangeably.
    t.split(' ').forEach((w) => { if (w.length >= 4) terms.add(w); });
  };

  competitors.forEach((c) => {
    const domain = String((c && (c.domain || c.host)) || '').toLowerCase().replace(/^www\./, '');
    if (domain) {
      const label = domain.split('.')[0];
      if (label && label.length >= 3) add(label.replace(/[-_]+/g, ' '));
    }
    if (c && c.label) add(c.label);
    // The brand half of a title, which is conventionally after the last
    // separator: "Menu | Saint Urbain" -> "Saint Urbain".
    const title = String((c && (c.homeTitle || c.title)) || '');
    if (title) {
      const parts = title.split(/\s+[|–—·•-]\s+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) add(parts[parts.length - 1]);
    }
  });

  return terms;
}

// Should this candidate entity be reported at all?
//
// Returns null when it is fine, or a string reason when it must be dropped.
// A reason rather than a boolean, because the reasons are shown in the UI —
// "12 entities suppressed: 7 competitor brand names, 5 generic UI labels" is a
// line a practitioner trusts, and a silent filter is one they cannot audit.
function entityNoiseReason(surface, {
  ownBrandTerms = null, competitorTerms = null, boilerplateBlocks = null, type = null,
} = {}) {
  const raw = String(surface || '').trim();
  if (!raw) return 'empty';
  const t = raw.toLowerCase();

  if (isGenericUi(t)) return 'generic UI or section label';
  if (competitorTerms && competitorTerms.has(t)) return 'competitor brand name';
  if (competitorTerms) {
    // A multi-word surface containing a competitor brand token is still theirs.
    const tokens = t.split(/\s+/);
    if (tokens.some((tok) => tok.length >= 4 && competitorTerms.has(tok))) return 'competitor brand name';
  }
  if (ownBrandTerms && ownBrandTerms.has && ownBrandTerms.has(t)) return 'this brand name';
  if (boilerplateBlocks && boilerplateBlocks.has && boilerplateBlocks.has(t)) return 'appears in this site template on most pages';

  // A single all-caps token of two letters is almost always an abbreviation
  // artefact ("US" from a sentence, "OK" from a button) rather than an entity
  // worth recommending.
  if (type === 'acronym' && raw.replace(/s$/, '').length <= 2) return 'two-letter acronym';
  // A month or weekday name is a date fragment, not a subject.
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/.test(t)) return 'date fragment';
  // A bare ordinal or number word.
  if (/^\d+$/.test(t)) return 'bare number';

  return null;
}

// Pluralises a reason phrase without mangling it.
//
// The naive `${reason}s` produced "appears in this site template on most
// pagess", because the reason already ends in a plural noun. Reasons are short
// human phrases, not lemmas, so the rule is: only pluralise when the phrase
// ends in a countable singular word.
function pluraliseReason(reason, count) {
  if (count === 1) return reason;
  const last = String(reason).split(' ').pop();
  if (/s$/i.test(last)) return reason; // already plural, or ends in s
  return `${reason}s`;
}

// Counts grouped by reason, as a plain object, so a caller merging two filter
// results can ADD the counts rather than concatenating two pre-rendered
// strings — which is how "21 competitor brand names" and "30 competitor brand
// names" both ended up in one summary line.
function byReasonCounts(suppressed) {
  const out = {};
  suppressed.forEach((x) => { out[x.reason] = (out[x.reason] || 0) + 1; });
  return out;
}

function renderReasonSummary(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${pluraliseReason(reason, count)}`);
}

// Filters an entity list and reports what it removed, grouped by reason.
function filterEntities(entities, opts = {}) {
  const kept = [];
  const suppressed = [];
  (entities || []).forEach((e) => {
    const surface = e.surface != null ? e.surface : e;
    const reason = entityNoiseReason(surface, { ...opts, type: e.type });
    if (reason) suppressed.push({ surface, reason, ...(e.type ? { type: e.type } : {}) });
    else kept.push(e);
  });

  const counts = byReasonCounts(suppressed);
  return {
    kept,
    suppressed,
    suppressedCount: suppressed.length,
    byReason: counts,
    summary: renderReasonSummary(counts),
  };
}

// The same filter for phrase lists (competitive.js topic gaps), which have no
// `type` and whose members are multi-word.
function filterPhrases(phrases, opts = {}) {
  const kept = [];
  const suppressed = [];
  (phrases || []).forEach((p) => {
    const phrase = p.phrase != null ? p.phrase : p;
    const reason = entityNoiseReason(phrase, opts);
    if (reason) suppressed.push({ phrase, reason });
    else kept.push(p);
  });
  const counts = byReasonCounts(suppressed);
  return {
    kept,
    suppressed,
    suppressedCount: suppressed.length,
    byReason: counts,
    summary: renderReasonSummary(counts),
  };
}

module.exports = {
  BOILERPLATE_SELECTORS, BLOCK_ELEMENTS, GENERIC_UI, PRICING_LABEL_RX, BARE_PRICE_RX,
  isGenericUi, contentText, repeatedBlocks,
  pluraliseReason, byReasonCounts, renderReasonSummary,
  competitorBrandTerms, entityNoiseReason, filterEntities, filterPhrases,
  wordCount,
};
