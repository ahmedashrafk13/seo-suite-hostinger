// Content Brief Agent.
//
// Takes an approved keyword cluster (from clustering.js) and produces a brief
// covering every field the brief spec asks for that can be built from data
// this app already owns, with zero external calls and zero ongoing cost:
//
//   search intent               — clustering.js already classified it
//   recommended title           — templated from primary keyword + intent
//   suggested headings          — one per supporting keyword + intent shape
//   supporting keywords         — clustering.js already grouped them
//   word-count range            — the linking crawler's own page inventory
//   internal-link suggestions   — the linking crawler's recommendations, or
//                                 (for a not-yet-created page) the existing
//                                 pages with the closest topical overlap
//   relevant products/services  — matched against the brand's own service
//                                 list, entered once in brand settings
//   recommended call to action  — matched against the brand's own CTA
//                                 rules, entered once in brand settings
//
// Two fields from the original brief are deliberately NOT produced here —
// "competitor coverage summary" and "questions to answer" — because both
// require seeing live Google search results, which nothing free provides.
// Rather than fabricate a plausible-looking guess for a paid product, the
// brief marks both fields as unavailable and says why, so a human knows to
// fill them in by hand rather than trusting an invented answer.
const db = require('../db');
const csvStore = require('./csvStore');
const analytics = require('./analytics');
const clustering = require('./clustering');

// Stored briefs are frozen JSON snapshots, so a brief generated before a fix
// landed keeps its old output forever. Bump this whenever the generated shape
// or the quality of a generated field changes materially, so the view can tell
// a reader their brief predates the current generator instead of silently
// showing stale output. The v2 comment claimed the stamp did this; nothing
// actually compared it until now.
//
//   v2 — added schemaVersion, warnings, meta description, field sources
//   v3 — title/heading generation corrected (see the fixes below), fieldSources
//        no longer reports 'data' for unmeasurable fields
const SCHEMA_VERSION = 3;

const STOPWORDS = new Set('a an and are as at be but by for from how i in into is it of on or that the to was what when where which who why with your you my me we our us do does can could should would will'.split(' '));

// Words that are grammatically fine but carry no discriminating signal for
// *what topic* a keyword is about — nearly every commercial SEO keyword
// contains "services", "company", "solutions" etc, so matching on those
// alone produces confident-looking false positives (this is exactly what
// happened in testing: "SEO services" matched a web-development cluster
// purely because both phrases contain the word "services"). These are
// excluded only from the relevance-matching token set below, not from the
// general tokenizer, since headings/titles still want the real words.
// Deliberately excludes topic words like "web"/"design"/"development"/"seo"
// even though they're common — those genuinely identify what a keyword is
// about. Only pure business-speak filler that says nothing about topic goes
// here (it would otherwise make e.g. "SEO services" match any cluster whose
// keywords happen to contain the word "services", which is nearly all of
// them — confirmed as a real false positive during testing).
const GENERIC_BUSINESS_WORDS = new Set('services service company companies solutions solution agency agencies firm firms provider providers business businesses usa us united states near your area best top custom professional'.split(' '));

function tokenize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Same as tokenize(), but for relevance MATCHING rather than display —
// strips generic business filler words so overlap only counts on words that
// actually identify a topic (e.g. "shopify", "seo", "logo", not "services").
function distinctiveTokens(s) {
  return tokenize(s).filter((w) => !GENERIC_BUSINESS_WORDS.has(w));
}

// Acronyms and initialisms that must not be sentence-cased.
//
// `titleCase` uppercased first letters blindly, which shipped
// "Website Design Services In Usa Near You" as a recommended title tag on the
// live brand. These stay fully capitalised; the small joining words stay lower
// case unless they lead the title.
// Deliberately excludes words that are ambiguous in ordinary prose — "us",
// "it", "ar", "ml", "amp" — because "About Us" must not become "About US" and
// "How It Works" must not become "How IT Works". Only initialisms that are
// effectively never used as common words are listed.
const ACRONYMS = new Set(`
  usa uk eu uae seo sem aeo ppc cro smm ux api saas b2b b2c
  cms crm erp roi kpi sme llc ltd ai vr nft css html php sql
  ios pdf faq nap idx mls hvac hipaa gdpr wcag pwa
  cdn dns ssl url urls cta ctas lms gpt llm
`.trim().split(/\s+/));

// Words kept lower case inside a title unless they are the first word.
const TITLE_MINOR_WORDS = new Set('a an and as at but by for from in into nor of on or per the to vs via with'.split(' '));

// Real Search Console query strings carry stray punctuation: a leading quote
// left over from a phrase search, trailing separators, doubled spaces. Left in
// place it leaks straight into a title tag — the live brand's brief opened its
// recommended title with a bare `"` character, and the same string was reused
// verbatim as an H2. Intra-word apostrophes are preserved ("company's").
function cleanQueryText(query) {
  return String(query || '')
    .replace(/["“”]/g, ' ')
    .replace(/(^|\s)['’]+/g, '$1')
    .replace(/['’]+(\s|$)/g, '$1')
    .replace(/\s*[,;:|/\\]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  const words = String(s || '').split(/(\s+)/);
  let wordIndex = -1;
  return words.map((chunk) => {
    if (/^\s+$/.test(chunk) || !chunk) return chunk;
    wordIndex += 1;
    const bare = chunk.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (ACRONYMS.has(bare)) return chunk.replace(/[a-z]+/gi, (m) => m.toUpperCase());
    if (wordIndex > 0 && TITLE_MINOR_WORDS.has(bare)) return chunk.toLowerCase();
    return chunk.replace(/\b\w/, (c) => c.toUpperCase());
  }).join('');
}

// ------------------------------------------------------------ title/meta limits
//
// Google truncates on pixel width, not character count, but characters are a
// serviceable proxy and nothing was checking them at all — the live brand's
// stored brief recommended a 62-character title with no warning.
const TITLE_MAX_CHARS = 60;
const META_MIN_CHARS = 110;
const META_MAX_CHARS = 155;

function lengthCheck(text, min, max, label) {
  const len = String(text || '').length;
  if (!len) return { length: 0, status: 'missing', note: `No ${label} generated.` };
  if (len > max) return { length: len, status: 'too-long', note: `${len} characters — likely truncated in search results (aim for under ${max}). Trim it before publishing.` };
  if (min && len < min) return { length: len, status: 'too-short', note: `${len} characters — shorter than the ${min}+ that usually earns a full snippet.` };
  return { length: len, status: 'ok', note: `${len} characters — within the usual display limit.` };
}

// clustering.js's `intent` field is a full display string (e.g.
// "Commercial investigation"), not a short key — normalise it once here so
// every matcher in this file (title, headings, CTA rules) agrees on the same
// small vocabulary instead of each guessing at clustering.js's exact wording.
function normaliseIntent(intent) {
  const s = String(intent || '').toLowerCase();
  if (s.startsWith('transactional')) return 'transactional';
  if (s.startsWith('commercial')) return 'commercial';
  if (s.startsWith('local')) return 'local';
  if (s.startsWith('navigational')) return 'navigational';
  return 'informational';
}

// ------------------------------------------------------------- recommended title
//
// Titles and headings used to be pure template lookups keyed on vertical +
// intent ("X Services", "Why Choose Us for X"). That reads as generic
// boilerplate the moment a real customer looks at it, so both fields are now
// built by a data-derivation pipeline that only falls back to the templates
// below when there is genuinely no usable signal:
//
//   1. Brand-history path: find this brand's own highest-clicking crawled
//      page whose title/keyword topically overlaps the cluster, and rewrite
//      ITS title for the new keyword by keeping its own wrapper words
//      ("Best", "Guide", "Near You", the brand suffix, whatever pattern that
//      specific brand's own copywriter already used and that already earns
//      clicks) and swapping in the new keyword. This is "follow what already
//      works for this brand," not a generic industry template.
//   2. Query-derivation path: if there's no brand-history match (new site,
//      or nothing topically overlapping yet), but the brand has real GSC
//      query history, use the single highest-impression literal query string
//      in the cluster's keyword set — cleaned up and capitalised, but not
//      reworded — since that is literally what real searchers typed.
//   3. Template path: only when neither of the above has anything to work
//      with (a truly cold-start brand: no crawl, no GSC history) does the
//      vertical-aware template fire, and fieldSources marks it 'template' so
//      nothing data-derived is ever mislabeled and nothing templated is ever
//      passed off as data-derived.
const TITLE_TEMPLATES = {
  default: {
    transactional: (kw) => `${kw}: Pricing, Options & How to Get Started`,
    commercial: (kw) => `${kw} Services`,
    local: (kw) => `${kw} Near You`,
    navigational: (kw) => kw,
    informational: (kw) => `${kw}: A Complete Guide`,
  },
  ecommerce: {
    transactional: (kw) => `Buy ${kw}: Prices, Options & Shipping`,
    commercial: (kw) => `Best ${kw}: Compare Options & Prices`,
    local: (kw) => `${kw} Near You — Store Locations`,
    navigational: (kw) => kw,
    informational: (kw) => `${kw}: A Buying Guide`,
  },
  saas: {
    transactional: (kw) => `${kw} Pricing & Plans`,
    commercial: (kw) => `${kw} Alternatives & Comparison`,
    local: (kw) => `${kw} Near You`,
    navigational: (kw) => kw,
    informational: (kw) => `${kw}: A Complete Guide`,
  },
  publisher_content: {
    transactional: (kw) => `${kw}: Pricing, Options & How to Get Started`,
    commercial: (kw) => `Best ${kw}: Our Picks`,
    local: (kw) => `${kw} Near You`,
    navigational: (kw) => kw,
    informational: (kw) => `${kw}: Everything You Need to Know`,
  },
};

// Suffix applied only for the same intents the original code suffixed
// (transactional/commercial/local) — informational/navigational titles were
// never suffixed, and that's preserved for every vertical, not just default.
const SUFFIX_INTENTS = new Set(['transactional', 'commercial', 'local']);

function templatedTitle(cluster, brand) {
  const kw = titleCase(cluster.primaryKeyword);
  const brandSuffix = brand && brand.name ? ` | ${brand.name}` : '';
  const intentKey = normaliseIntent(cluster.intent);
  const vertical = (brand && brand.vertical) || 'default';
  const table = TITLE_TEMPLATES[vertical] || TITLE_TEMPLATES.default;
  const build = table[intentKey] || TITLE_TEMPLATES.default[intentKey] || TITLE_TEMPLATES.default.informational;
  return SUFFIX_INTENTS.has(intentKey) ? `${build(kw)}${brandSuffix}` : build(kw);
}

function clusterTokenSet(cluster) {
  return new Set([
    ...distinctiveTokens(cluster.primaryKeyword),
    ...cluster.supportingKeywords.flatMap(distinctiveTokens),
  ]);
}

// Finds the longest contiguous run of `lowerWords` whose tokens belong to
// `kwTokens` — i.e. where the old keyword actually sits inside the old
// title's word sequence, so it can be swapped out in place while leaving the
// brand's own wrapper words exactly where they were.
function longestTokenSpan(lowerWords, kwTokens) {
  let best = null;
  for (let i = 0; i < lowerWords.length; i += 1) {
    if (!kwTokens.has(lowerWords[i])) continue;
    let j = i;
    while (j < lowerWords.length && kwTokens.has(lowerWords[j])) j += 1;
    if (!best || (j - i) > (best.end - best.start)) best = { start: i, end: j };
    i = j;
  }
  return best;
}

// Rewrites a real, already-published title for a new keyword by keeping
// every wrapper word (the brand's own modifiers, separators, brand name) in
// place and only swapping out the span that was the OLD keyword. Returns
// null when the old keyword can't be located inside the old title at all —
// in that case the title's "pattern" can't be trusted, so the caller should
// move on to the next candidate rather than force a bad rewrite.
function rewriteTitleForKeyword(oldTitle, oldKeyword, newKeywordTitleCased, brandName) {
  let core = String(oldTitle || '').trim();
  if (!core) return null;
  let brandPrefix = '';
  let brandSuffix = '';
  if (brandName) {
    const esc = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffixRe = new RegExp(`\\s*[|\\-–:]\\s*${esc}\\s*$`, 'i');
    const prefixRe = new RegExp(`^\\s*${esc}\\s*[|\\-–:]\\s*`, 'i');
    if (suffixRe.test(core)) { brandSuffix = core.match(suffixRe)[0]; core = core.replace(suffixRe, ''); } else if (prefixRe.test(core)) { brandPrefix = core.match(prefixRe)[0]; core = core.replace(prefixRe, ''); }
  }
  const words = core.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const lowerWords = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const kwTokens = new Set(distinctiveTokens(oldKeyword));
  if (!kwTokens.size) return null;
  const span = longestTokenSpan(lowerWords, kwTokens);
  // Require the located span to cover a real majority of the old keyword's
  // tokens — a one-word coincidental overlap isn't the keyword's position.
  if (!span || (span.end - span.start) < Math.max(1, Math.ceil(kwTokens.size / 2))) return null;
  const before = words.slice(0, span.start).join(' ');
  const after = words.slice(span.end).join(' ');

  // The wrapper is only reusable if it is genuinely generic packaging.
  //
  // Without this check the rewrite carried the SOURCE page's own qualifiers
  // onto an unrelated keyword: on the live brand it produced
  // "Web Development Services USA Services in NYC" — a national keyword
  // wearing a New York page's wrapper, with "Services" repeated at the seam.
  // Any wrapper word that is not recognised packaging (a place name, a
  // different service, a year) means this title's pattern cannot be
  // transplanted, so the caller moves on to the next candidate.
  const wrapperWords = `${before} ${after}`.split(/\s+/).filter(Boolean);
  const newKwTokens = new Set(tokenize(newKeywordTitleCased));
  const unusable = wrapperWords.some((w) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!bare || bare.length <= 2) return false;
    if (STOPWORDS.has(bare) || ALLOWED_WRAPPER_WORDS.has(bare)) return false;
    // A wrapper word that the new keyword already covers is fine.
    return !newKwTokens.has(bare);
  });
  if (unusable) return null;

  // Collapse the seam by trimming the WRAPPER, never the keyword.
  //
  // The keyword is verbatim data and must survive intact. Running a word-level
  // dedup across the whole assembled string mutated it instead: rewriting
  // "New York City Website Development" for "custom web development services in
  // new york" left "New" behind as a wrapper (the keyword span began at
  // "York"), and the dedup then deleted the keyword's OWN "New" as a duplicate
  // — shipping "New Custom Web Development Services in York" and splitting the
  // place name in half. Dropping the redundant wrapper word instead yields
  // "Custom Web Development Services in New York", which is what was meant.
  const keywordStems = new Set(tokenize(newKeywordTitleCased).map((t) => clustering.stem(t, 'en')));
  const beforeClean = dropWrapperWordsCoveredBy(before, keywordStems);
  const afterClean = dropWrapperWordsCoveredBy(after, keywordStems);
  const rebuilt = trimTitleEdges([beforeClean, newKeywordTitleCased, afterClean].filter(Boolean).join(' '));
  if (!rebuilt) return null;
  return `${brandPrefix}${rebuilt}${brandSuffix}`.replace(/\s+/g, ' ').trim();
}

// Removes wrapper words the new keyword already carries, so the seam collapses
// without touching the keyword itself. Stopwords and short words are structural
// and always kept — dropping them would break the wrapper's grammar.
function dropWrapperWordsCoveredBy(wrapper, keywordStems) {
  return String(wrapper || '').split(/\s+/).filter(Boolean).filter((w) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!bare || bare.length <= 2 || STOPWORDS.has(bare)) return true;
    return !keywordStems.has(clustering.stem(bare, 'en'));
  }).join(' ');
}

// Generic packaging a copywriter wraps around any keyword. Anything outside
// this list is treated as specific to the source page.
const ALLOWED_WRAPPER_WORDS = new Set(`
  best top leading trusted affordable professional expert complete ultimate
  guide services service solutions company agency provider near you your our
  online free custom quality reliable premier
`.trim().split(/\s+/));

// Collapses a distinctive word repeated inside the title's core
// ("... Services USA Services" -> "... Services USA"), matched on the STEM so
// near-duplicates collapse too — "Company"/"Companies" both stem to "company",
// which is what let the live brand ship the title "Website Development Company
// Providing Websites for Companies Providing". Only ever removes a LATER
// duplicate of an earlier word, so meaning is never changed by reordering.
//
// NEVER call this across a brand affix. A brand's own name is not redundant
// just because it repeats a keyword word, and passing the fully assembled
// title collapsed "Web Development Services | American Web Builders" into
// "... | American Builders", and "Design Services in Austin | Austin Design Co"
// into "... | Co" — corrupting the brand's name inside a recommended title tag.
// Every current caller passes bare keyword or query text, never an assembled
// title; rewriteTitleForKeyword collapses its seam with
// dropWrapperWordsCoveredBy instead, which cannot touch the keyword either.
function dropRepeatedWords(title) {
  const seen = new Set();
  const out = [];
  String(title).split(/\s+/).forEach((w) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (bare && bare.length > 2 && !STOPWORDS.has(bare)) {
      const key = clustering.stem(bare, 'en');
      if (seen.has(key)) return;
      seen.add(key);
    }
    out.push(w);
  });
  return trimDanglingWords(out.join(' '));
}

// Strips trailing separators and joining words that carry no meaning at the end
// of a title — left either by a duplicate removed from after them ("... For
// Companies" -> "... For") or by a source query that simply ended that way.
function trimDanglingWords(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  while (words.length) {
    const bare = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!bare || TITLE_MINOR_WORDS.has(bare) || STOPWORDS.has(bare)) { words.pop(); continue; }
    break;
  }
  return words.join(' ').trim();
}

// Prepositions and conjunctions that can never legitimately OPEN a title.
// Deliberately excludes articles — "The Complete Guide to X" is a fine title,
// so "the"/"a"/"an" are left alone.
const NON_LEADING_WORDS = new Set('and or but nor for of to in into on at by from with as per via vs'.split(' '));

// Trims both ends: a removed wrapper word can leave a dangling preposition at
// the front ("in Custom Web Development") as easily as at the back.
function trimTitleEdges(text) {
  const words = trimDanglingWords(text).split(/\s+/).filter(Boolean);
  while (words.length) {
    const bare = words[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!bare || NON_LEADING_WORDS.has(bare)) { words.shift(); continue; }
    break;
  }
  return words.join(' ').trim();
}

// Path 1 — brand history: this brand's own top-clicking crawled pages,
// ranked by topical overlap with the cluster then by real clicks, rewritten
// for the new keyword using that specific page's own title pattern.
function titleFromBrandHistory(cluster, brand, crawlPages) {
  const clicksByUrl = new Map(analytics.topPages(brand.id, 9999, 500).map((r) => [r.entity, r]));
  if (!clicksByUrl.size) return [];
  const clusterTokens = clusterTokenSet(cluster);
  const candidates = crawlPages
    .filter((p) => p.kind === 'content' && p.title && p.url !== cluster.existingPage && clicksByUrl.has(p.url))
    .map((p) => {
      const pageTokens = new Set([...distinctiveTokens(p.primary_keyword), ...(p.top_terms || []).flatMap(distinctiveTokens)]);
      let overlap = 0;
      pageTokens.forEach((t) => { if (clusterTokens.has(t)) overlap += 1; });
      return { page: p, overlap, clicks: clicksByUrl.get(p.url).clicks || 0 };
    })
    .filter((c) => c.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (b.clicks - a.clicks));
  // Returns EVERY usable rewrite in preference order, not just the first.
  // Returning the first meant one unusable-but-valid candidate (the blog index,
  // whose title "Blog" rewrites into an 86-character keyword dump) was emitted
  // with a length warning while shorter candidates went unexamined.
  const rewrites = [];
  for (const c of candidates) {
    const oldKeyword = c.page.primary_keyword || c.page.title;
    const rewritten = rewriteTitleForKeyword(c.page.title, oldKeyword, titleCase(cluster.primaryKeyword), brand && brand.name);
    if (rewritten) {
      rewrites.push({ title: rewritten, basedOn: c.page.url, sourceTitle: c.page.title, method: 'brand-history' });
      if (rewrites.length >= 5) break;
    }
  }
  return rewrites;
}

// The brand's GSC query history, fetched once per brief. The title path and
// the headings path each used to issue the same 1,000-row query independently.
function brandQueries(brand, cached) {
  if (cached) return cached;
  return analytics.topQueries(brand.id, 9999, 1000);
}

// Path 2 — query derivation: the highest-impression real GSC query string
// that belongs to this cluster (shares a distinctive token with the primary
// or supporting keywords), cleaned up and capitalised but not reworded —
// it's literally what real searchers typed.
function titleFromTopQuery(cluster, brand, cachedQueries) {
  const queries = brandQueries(brand, cachedQueries);
  if (!queries.length) return [];
  const clusterTokens = clusterTokenSet(cluster);
  const scored = queries
    .map((q) => {
      const qTokens = distinctiveTokens(q.entity);
      const overlap = qTokens.filter((t) => clusterTokens.has(t)).length;
      // Same on-topic requirement the headings use: every distinctive token
      // must belong to this cluster. Partial overlap was picking queries that
      // merely shared a word — a cluster about "web development services usa"
      // was titled "Web Design and Web Development Services Atlanta", naming
      // a city the page has nothing to do with.
      const onTopic = qTokens.length > 0 && qTokens.every((t) => clusterTokens.has(t));
      return { q, overlap, onTopic };
    })
    .filter((s) => s.overlap > 0 && s.onTopic)
    .sort((a, b) => (b.overlap - a.overlap) || (b.q.impressions - a.q.impressions));
  if (!scored.length) return [];

  // Every on-topic query, cleaned, in preference order — the caller picks the
  // first that fits. Returning only scored[0] is how a 71-character query
  // became the recommended title on the live brand: the brief then warned about
  // the very title it had just chosen, while shorter, equally on-topic
  // candidates sat further down this same list.
  return scored
    .slice(0, 10)
    .map((s) => ({
      title: dropRepeatedWords(titleCase(cleanQueryText(s.q.entity))),
      basedOn: s.q.entity,
      method: 'query',
    }))
    .filter((c) => c.title)
    // Flagged when cleanup changed the wording, so the brief can show the
    // verbatim query beside the title instead of implying they are identical.
    .map((c) => ({ ...c, cleaned: c.title.toLowerCase() !== String(c.basedOn).trim().toLowerCase() }));
}

function recommendedTitle(cluster, brand, crawlPages, cachedQueries) {
  // Candidates in priority order: this brand's own proven title patterns, then
  // real searcher phrasing, then the vertical template. The first one that FITS
  // wins. Previously each path returned a single candidate and the first
  // non-null won outright, so an over-long title from a high-priority path was
  // emitted with a warning attached while shorter candidates — including the
  // always-short template — were never considered. A 60-character limit the
  // generator knows about is a limit it should meet, not report on.
  const candidates = [
    ...titleFromBrandHistory(cluster, brand, crawlPages || []),
    ...titleFromTopQuery(cluster, brand, cachedQueries),
    { title: templatedTitle(cluster, brand), method: 'template' },
  ].filter((c) => c && c.title);
  const chosen = candidates.find((c) => c.title.length <= TITLE_MAX_CHARS) || candidates[0];
  return { ...chosen, check: lengthCheck(chosen.title, 0, TITLE_MAX_CHARS, 'title') };
}

// ------------------------------------------------------------ suggested headings
const HEADING_INTRO_TEMPLATES = {
  default: {
    informational: (kw) => [`What Is ${kw}?`, `Why ${kw} Matters`],
    transactional: (kw) => [`What's Included`, `Why Choose Us for ${kw}`],
    commercial: (kw) => [`What's Included`, `Why Choose Us for ${kw}`],
    local: (kw) => [`${kw} in Your Area`, `Why Work With a Local Team`],
    navigational: () => ['Overview'],
  },
  ecommerce: {
    informational: (kw) => [`What Is ${kw}?`, `How to Choose ${kw}`],
    transactional: (kw) => [`Product Options & Pricing`, `Why Buy ${kw} From Us`],
    commercial: (kw) => [`How ${kw} Options Compare`, `What to Look For`],
    local: (kw) => [`Find ${kw} Near You`, `Store Locations & Hours`],
    navigational: () => ['Overview'],
  },
  saas: {
    informational: (kw) => [`What Is ${kw}?`, `How ${kw} Works`],
    transactional: (kw) => [`Plans & Pricing`, `What's Included`],
    commercial: (kw) => [`How ${kw} Compares to Alternatives`, `Key Features`],
    local: (kw) => [`${kw} for Your Region`, `Localized Support`],
    navigational: () => ['Overview'],
  },
  publisher_content: {
    informational: (kw) => [`What Is ${kw}?`, `Why ${kw} Matters`],
    transactional: (kw) => [`What's Included`, `Where to Get ${kw}`],
    commercial: (kw) => [`Our Picks for ${kw}`, `How We Chose`],
    local: (kw) => [`${kw} in Your Area`, `Local Considerations`],
    navigational: () => ['Overview'],
  },
};

// Question-shaped real queries read naturally as headings ("How Much Does X
// Cost?"); a bare noun-phrase query doesn't, so it's framed as "About: <query>"
// instead of being forced into a fake question — still the real query text,
// just not mislabeled as something it isn't.
const WH_STARTERS = new Set(['what', 'why', 'how', 'when', 'where', 'which', 'who', 'is', 'are', 'can', 'does', 'do', 'should']);

function headingFromQuery(query) {
  const words = cleanQueryText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Cleaned the same way a query-derived title is: real GSC queries include
  // stray quotes, truncated fragments and doubled-up phrases, and those read as
  // badly in an H2 as they do in a title tag.
  const clean = dropRepeatedWords(titleCase(cleanQueryText(query).replace(/[?]+$/, '')));
  if (!clean) return null;
  if (WH_STARTERS.has(words[0].toLowerCase())) return `${clean}?`;
  // A noun-phrase query reads perfectly well as a heading on its own. The old
  // "About: " prefix was a hedge against forcing it into a fake question, but
  // it just made every such heading look machine-generated.
  return clean;
}

// Real "people also search"-style intro headings: the cluster's own highest-
// impression GSC queries (excluding ones that are just the primary keyword
// itself), turned into headings. Falls back to null (caller uses the
// template) when the brand has no matching query history at all.
function headingsFromQueries(cluster, brand, cachedQueries) {
  const queries = brandQueries(brand, cachedQueries);
  if (!queries.length) return null;
  const clusterTokens = clusterTokenSet(cluster);
  const primaryTokens = new Set(distinctiveTokens(cluster.primaryKeyword));
  const scored = queries
    .map((q) => {
      const qTokens = distinctiveTokens(q.entity);
      const overlap = qTokens.filter((t) => clusterTokens.has(t)).length;
      const isJustPrimary = qTokens.every((t) => primaryTokens.has(t)) && qTokens.some((t) => primaryTokens.has(t));
      // Every distinctive token must belong to the cluster, not just one.
      //
      // Scoring on partial overlap let unrelated queries in: a cluster about
      // "web development services usa" was given the headings
      // "Web Design and Web Development Services Atlanta" and
      // "Website Design and Development Miami", because they shared the words
      // "web" and "development". A heading that introduces a city the page is
      // not about is worse than no heading at all.
      const onTopic = qTokens.length > 0 && qTokens.every((t) => clusterTokens.has(t));
      return { q, overlap, isJustPrimary, onTopic };
    })
    .filter((s) => s.overlap > 0 && !s.isJustPrimary && s.onTopic)
    .sort((a, b) => (b.overlap - a.overlap) || (b.q.impressions - a.q.impressions));
  if (!scored.length) return null;
  const seen = new Set();
  const headings = [];
  for (const s of scored) {
    const h = headingFromQuery(s.q.entity);
    if (h && !seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); headings.push(h); }
    if (headings.length >= 2) break;
  }
  return headings.length ? headings : null;
}

function templatedIntroHeadings(cluster, brand) {
  const kw = titleCase(cluster.primaryKeyword);
  const intent = normaliseIntent(cluster.intent);
  const vertical = (brand && brand.vertical) || 'default';
  const table = HEADING_INTRO_TEMPLATES[vertical] || HEADING_INTRO_TEMPLATES.default;
  const introFn = table[intent] || HEADING_INTRO_TEMPLATES.default[intent] || HEADING_INTRO_TEMPLATES.default.informational;
  return introFn(kw);
}

// Two headings are "the same section" when their distinctive tokens match as a
// set, regardless of word order or filler. This is what stops the brief
// emitting "Website Design Usa", "Website Design In Usa" and
// "Website Design Services Usa" as three separate sections — which is exactly
// what the live brand's stored brief did, giving a writer six of nine headings
// that all meant the same thing.
// The distinctive, stemmed tokens a heading is "about".
function headingTokens(heading) {
  return [...new Set(distinctiveTokens(heading).map((t) => clustering.stem(t, 'en')))];
}

// Two tokens count as the same concept when one is a prefix of the other and
// the shared prefix is long enough to be meaningful — "web"/"website",
// "develop"/"development". Light stemming alone leaves those apart, which is
// why "Web Development Services USA" and "Website Development Services in USA"
// both survived the first pass of this fix.
const PREFIX_MATCH_MIN = 3;

function tokensMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= PREFIX_MATCH_MIN && long.startsWith(short);
}

// Two headings are the same section when their token sets agree on BOTH
// sides — matches measured against the LARGER set, not the smaller.
//
// Pure containment was too aggressive: "Web Development Services USA"
// ({web, develop}) is fully contained in "Web Design and Web Development
// Services Atlanta" ({web, design, develop, atlanta}), so a short, on-topic
// heading was silently absorbed by a longer, unrelated one and the outline
// collapsed from seven headings to two. Scoring against the larger set means
// a heading is only dropped when it genuinely says the same thing, not merely
// when it is a subset.
const SAME_SECTION_THRESHOLD = 0.75;

function isSameSection(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return false;
  const [small, large] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  const matched = small.filter((t) => large.some((o) => tokensMatch(t, o))).length;
  return (matched / large.length) >= SAME_SECTION_THRESHOLD;
}

// `seedTokens` pre-loads the deduper with token sets that must not be repeated
// but are not themselves headings — in practice the recommended title. The
// title and the intro headings are both derived from the same ranked query
// list, so they collided constantly: the live brand's brief opened with the H2
// "Web Design and Development Company in USA" directly beneath the identical
// title tag. An H2 that restates the title is a wasted section.
function dedupeHeadings(headings, seedTokens = []) {
  const accepted = [];
  const acceptedTokens = [...seedTokens];
  const seenExact = new Set();
  headings.forEach((h) => {
    if (!h) return;
    const exact = h.toLowerCase().trim();
    if (seenExact.has(exact)) return;
    const tokens = headingTokens(h);
    // A heading with no distinctive tokens ("Get Started", "Overview") is
    // deduped on its exact text only.
    if (tokens.length && acceptedTokens.some((prev) => isSameSection(tokens, prev))) return;
    seenExact.add(exact);
    acceptedTokens.push(tokens);
    accepted.push(h);
  });
  return accepted;
}

// Body sections come from sub-topics where clustering found them, and only
// fall back to supporting keywords when it didn't.
//
// Sub-clusters are groups of keywords that are genuinely distinct from each
// other within the topic, so each one is a real section. Supporting keywords
// are just the cluster's members sorted by impressions — adjacent entries are
// usually rephrasings, which is why using them directly produced duplicate
// headings.
function bodyHeadings(cluster) {
  const subs = Array.isArray(cluster.subClusters) ? cluster.subClusters : null;
  if (subs && subs.length >= 2) {
    return {
      headings: subs.map((s) => dropRepeatedWords(titleCase(s.label))).filter(Boolean),
      method: 'sub-topic',
    };
  }
  // Fallback: the cluster's own supporting keywords, cleaned the same way the
  // title is, and with any keyword that merely restates the primary one
  // dropped — a section heading that says the same thing as the page's title
  // is not a section, and it used to consume up to six of the nine slots.
  const primaryTokens = new Set(distinctiveTokens(cluster.primaryKeyword).map((t) => clustering.stem(t, 'en')));
  const headings = cluster.supportingKeywords
    .map((k) => dropRepeatedWords(titleCase(k)))
    .filter(Boolean)
    .filter((h) => {
      const tokens = headingTokens(h);
      return tokens.length > 0 && !tokens.every((t) => primaryTokens.has(t));
    })
    .slice(0, 6);
  return { headings, method: 'supporting-keyword' };
}

function suggestedHeadings(cluster, brand, cachedQueries, recommendedTitleText) {
  const intent = normaliseIntent(cluster.intent);
  const fromQueries = headingsFromQueries(cluster, brand, cachedQueries);
  const intro = fromQueries || templatedIntroHeadings(cluster, brand);
  const introMethod = fromQueries ? 'query' : 'template';
  const body = bodyHeadings(cluster);

  // Seeded with the title so no heading merely restates it.
  const titleTokens = recommendedTitleText ? headingTokens(recommendedTitleText) : [];
  const headings = dedupeHeadings([
    ...intro,
    ...body.headings,
    intent === 'informational' ? 'Frequently Asked Questions' : 'Get Started',
  ], titleTokens.length ? [titleTokens] : []);

  return {
    headings,
    // Reported separately because the two halves of the outline are derived
    // very differently and a reader should know which is which.
    method: introMethod === 'query' || body.method === 'sub-topic' ? 'data' : 'template',
    introMethod,
    bodyMethod: body.method,
  };
}

// ---------------------------------------------------------------- word count
// Uses the linking crawler's own page inventory (crawl_data.json) as the
// only real baseline available without fetching anyone else's page: the
// median and 85th percentile of the brand's own indexable content pages.
// This is a "match what already works on this site" range, not a
// "match what's currently ranking" range — the honest distinction is
// called out in the brief's UI, not hidden.
function wordCountRange(crawlPages) {
  const counts = crawlPages
    .filter((p) => p.kind === 'content' && Number(p.word_count) > 0)
    .map((p) => Number(p.word_count))
    .sort((a, b) => a - b);
  if (counts.length < 3) return null;
  const pct = (p) => counts[Math.min(counts.length - 1, Math.floor(p * (counts.length - 1)))];
  // `low` used to be the median, so the "range" was [median, p85] and the
  // floor was always "at least as long as your average page" — not a range
  // around a target at all. It now spans p40-p85 with the median called out
  // separately as the target, which is what a writer actually needs.
  return {
    low: pct(0.4),
    high: pct(0.85),
    target: pct(0.6),
    median: pct(0.5),
    sampleSize: counts.length,
    basis: 'This brand\'s own crawled content pages — what already works on this site, NOT what currently ranks for this keyword. Check the live SERP before treating it as a target.',
  };
}

// ------------------------------------------------------- internal link suggestions
function internalLinkSuggestions(cluster, crawlPages, recommendationRows) {
  // Improving an existing page: reuse the linking agent's own recommendations
  // that already target that URL — no guessing needed, it already crawled this.
  if (cluster.existingPage && recommendationRows && recommendationRows.length) {
    const targeted = recommendationRows
      .filter((r) => r.target_url === cluster.existingPage)
      .slice(0, 8)
      .map((r) => ({ from: r.source_url, anchor: r.anchor_text, reason: r.reason || null }));
    if (targeted.length) return { mode: 'existing-page-recommendations', links: targeted };
  }

  // A page that doesn't exist yet: find the crawled pages whose own topical
  // fingerprint (top_terms/primary_keyword) overlaps the cluster's keywords,
  // ranked by how much internal authority they already carry (pagerank),
  // so the suggestion is "link from your strongest related pages."
  const clusterTokens = new Set([
    ...distinctiveTokens(cluster.primaryKeyword),
    ...cluster.supportingKeywords.flatMap(distinctiveTokens),
  ]);
  const scored = crawlPages
    .filter((p) => p.kind === 'content' && p.url !== cluster.existingPage)
    .map((p) => {
      const pageTokens = new Set([...distinctiveTokens(p.primary_keyword), ...(p.top_terms || []).flatMap(distinctiveTokens)]);
      let overlap = 0;
      pageTokens.forEach((t) => { if (clusterTokens.has(t)) overlap += 1; });
      return { page: p, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (b.page.pagerank || 0) - (a.page.pagerank || 0))
    .slice(0, 8)
    .map((s) => ({ from: s.page.url, anchor: null, reason: `Topically related (${s.overlap} shared term${s.overlap === 1 ? '' : 's'}), pagerank ${((s.page.pagerank || 0) * 100).toFixed(1)}%` }));

  return { mode: scored.length ? 'topical-overlap' : 'none', links: scored };
}

// -------------------------------------------------------- meta description
//
// Not previously generated at all, despite the CTR-gap opportunity type
// existing specifically to tell people to rewrite it. Built deterministically
// from the cluster's own primary keyword, intent and the brand's configured
// CTA, and length-checked — a template, and labelled as one, but a complete
// starting point rather than a blank field.
const META_TEMPLATES = {
  transactional: (kw, brandName) => `Compare options and pricing for ${kw}. See what's included, how quickly you can start, and what it costs${brandName ? ` with ${brandName}` : ''}.`,
  commercial: (kw, brandName) => `Looking for ${kw}? See what to look for, how the options compare, and how${brandName ? ` ${brandName}` : ' we'} can help you choose.`,
  local: (kw) => `Need ${kw}? See service areas, what's covered and how to get started — with local support and a direct line to the team.`,
  // Extended past the 110-character floor: the shorter original wording put any
  // keyword under ~12 characters below the minimum, so the generator warned
  // about its own output for every short keyword.
  informational: (kw) => `A practical guide to ${kw}: what it means, how it works, and what to do next — clear answers, no jargon, and the steps worth taking first.`,
  // Was `"${kw} — find what you need and get in touch."`, which is structurally
  // under the 110-character floor for any short keyword — so the generator
  // reliably warned about a description it had just written itself.
  navigational: (kw, brandName) => `${kw} — everything in one place${brandName ? ` from ${brandName}` : ''}: the key pages, contact details and next steps, so you can find what you need and get in touch quickly.`,
};

// Trims an over-long description at a sentence or word boundary. The generator
// used to length-check its own output, warn, and then emit it anyway — leaving
// the SEO team to hand-trim something the tool could have trimmed itself.
function trimToLength(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  // Only cut at a sentence boundary if doing so keeps most of the text.
  if (sentenceEnd >= max * 0.6) return cut.slice(0, sentenceEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  const body = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s—–-]+$/, '');
  // Already ends a sentence — an ellipsis on top of a full stop just looks
  // like a mistake.
  return /[.!?]$/.test(body) ? body : `${body}…`;
}

function recommendedMeta(cluster, brand, cta) {
  const kw = String(cluster.primaryKeyword || '').trim();
  const intent = normaliseIntent(cluster.intent);
  const build = META_TEMPLATES[intent] || META_TEMPLATES.informational;
  let text = build(kw, brand && brand.name);
  // Append the brand's own configured CTA when there is room for it.
  if (cta && cta.text && (text.length + cta.text.length + 1) <= META_MAX_CHARS) {
    text = `${text} ${cta.text}.`.replace(/\.\.$/, '.');
  }
  // A long primary keyword can push even a fitted template past the limit.
  text = trimToLength(text, META_MAX_CHARS);
  return { text, method: 'template', check: lengthCheck(text, META_MIN_CHARS, META_MAX_CHARS, 'meta description') };
}

// -------------------------------------------------------- services & CTA
function relevantServices(cluster, brand) {
  let services = [];
  try { services = brand.services_json ? JSON.parse(brand.services_json) : []; } catch { services = []; }
  if (!Array.isArray(services) || !services.length) {
    return { matched: [], configured: false };
  }
  const clusterTokens = new Set([
    ...distinctiveTokens(cluster.primaryKeyword),
    ...cluster.supportingKeywords.flatMap(distinctiveTokens),
  ]);
  const scored = services.map((s) => {
    const svcTokens = new Set([...distinctiveTokens(s.name), ...(s.keywords || []).flatMap(distinctiveTokens)]);
    let overlap = 0;
    svcTokens.forEach((t) => { if (clusterTokens.has(t)) overlap += 1; });
    return { name: s.name, overlap };
  }).filter((s) => s.overlap > 0).sort((a, b) => b.overlap - a.overlap);
  return { matched: scored.slice(0, 3).map((s) => s.name), configured: true };
}

function recommendedCta(cluster, brand) {
  let cta = null;
  try { cta = brand.cta_json ? JSON.parse(brand.cta_json) : null; } catch { cta = null; }
  if (!cta || (!cta.default && !(cta.rules || []).length)) {
    return { text: null, configured: false };
  }
  // Matched against the same normalised intent key used for the title/
  // headings, not the raw display strings — see normaliseIntent()'s comment.
  const key = normaliseIntent(cluster.intent);
  const rule = (cta.rules || []).find((r) => String(r.pageType || '').toLowerCase() === key);
  return { text: (rule && rule.cta) || cta.default || null, configured: true };
}

// ------------------------------------------------------------------- build
function build(brand, cluster) {
  const latestLinking = db.prepare(`SELECT out_dir FROM linking_runs
    WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brand.id);
  const crawlPages = latestLinking ? csvStore.readCrawlData(latestLinking.out_dir) : [];
  const recommendationRows = latestLinking
    ? (csvStore.readTable(latestLinking.out_dir, 'recommendations', { perPage: 5000 }) || { rows: [] }).rows
    : [];

  // Fetched once and shared by the title and headings paths, which each used
  // to issue this same 1,000-row query independently.
  const queryHistory = analytics.topQueries(brand.id, 9999, 1000);

  const services = relevantServices(cluster, brand);
  const cta = recommendedCta(cluster, brand);
  const title = recommendedTitle(cluster, brand, crawlPages, queryHistory);
  const headings = suggestedHeadings(cluster, brand, queryHistory, title.title);
  const meta = recommendedMeta(cluster, brand, cta);
  const words = wordCountRange(crawlPages);
  const links = internalLinkSuggestions(cluster, crawlPages, recommendationRows);

  // Intent gating.
  //
  // The page type, title shape, headings and CTA all descend from the
  // cluster's intent label. When that label is a weak guess, every one of
  // them inherits the guess — which is how a national keyword ended up with
  // the title "... In Usa Near You" and the heading "Why Work With a Local
  // Team". The brief now carries the warning to the surface instead of
  // presenting derived fields with the same confidence as measured ones.
  const intentConfidence = cluster.intentConfidence || 'low';
  const intentIsWeak = intentConfidence === 'low';
  const warnings = [];
  if (intentIsWeak) {
    warnings.push({
      field: 'searchIntent',
      severity: 'high',
      message: `Search intent was classified as "${cluster.intent}" with low confidence${cluster.intentCoverage != null ? ` (only ${Math.round(cluster.intentCoverage * 100)}% of the cluster's keywords carry that signal)` : ''}. The recommended page type, title shape and headings all follow from it — check the live SERP for this keyword before using them.`,
    });
  }
  if (cluster.needsReview) {
    warnings.push({
      field: 'cluster',
      severity: 'high',
      message: 'These keywords are only loosely related to each other. Confirm they belong on one page before writing to this brief.',
    });
  }
  if (title.check && title.check.status !== 'ok') {
    warnings.push({ field: 'recommendedTitle', severity: 'medium', message: title.check.note });
  }
  if (meta.check && meta.check.status !== 'ok') {
    warnings.push({ field: 'recommendedMetaDescription', severity: 'low', message: meta.check.note });
  }
  if (!services.configured) {
    warnings.push({ field: 'relevantServices', severity: 'low', message: 'No services are configured for this brand, so none could be matched. Add them in brand settings.' });
  } else if (!services.matched.length) {
    // Configured but nothing matched is a different finding from not configured
    // at all, and it used to render as a silently empty section.
    warnings.push({ field: 'relevantServices', severity: 'low', message: 'None of this brand\'s configured services share a topic with this keyword. Either this page sells something not yet on the service list, or the cluster is off-portfolio — worth checking before commissioning it.' });
  }
  if (!cta.configured) {
    warnings.push({ field: 'callToAction', severity: 'low', message: 'No CTA rules are configured for this brand, so a generic one is shown. Add them in brand settings.' });
  }
  // Both of these fields silently rendered as empty while fieldSources still
  // claimed they were 'data' — the reader had no way to tell "measured zero"
  // from "could not be measured".
  if (!words) {
    warnings.push({ field: 'wordCountRange', severity: 'low', message: 'No word-count range could be measured: this brand has fewer than three crawled content pages. Run the internal-linking crawl to establish a baseline.' });
  }
  if (!links.links.length) {
    warnings.push({ field: 'internalLinks', severity: 'medium', message: 'No internal link sources could be identified — no crawled page shares a topic with this cluster. A new page with no inbound internal links will struggle to be discovered or to rank; identify link sources manually before publishing.' });
  }

  return {
    // Stored briefs are frozen JSON with no version marker, so a brief written
    // before a field existed renders as undefined in a view that expects it —
    // which is the state the live brand's stored briefs are in. Stamping the
    // version lets a reader (and the view) tell an old shape from a new one.
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    brand: { id: brand.id, name: brand.name, site_url: brand.site_url },
    cluster: {
      id: cluster.id,
      primaryKeyword: cluster.primaryKeyword,
      supportingKeywords: cluster.supportingKeywords,
      keywordCount: cluster.keywordCount,
      recommendation: cluster.recommendation,
      recommendationReason: cluster.recommendationReason,
      existingPage: cluster.existingPage,
    },
    searchIntent: {
      intent: cluster.intent,
      confidence: intentConfidence,
      coverage: cluster.intentCoverage != null ? cluster.intentCoverage : null,
      suggestedPageType: cluster.suggestedPageType,
      // Explicit so a consumer never treats a weak guess as settled.
      verifyBeforeUse: intentIsWeak,
    },
    recommendedTitle: title.title,
    recommendedTitleCheck: title.check,
    recommendedTitleBasis: title.method === 'template'
      ? { method: 'template' }
      : {
        method: title.method,
        basedOn: title.basedOn,
        sourceTitle: title.sourceTitle || null,
        // True when cleanup changed the wording, so the UI can show the
        // verbatim query rather than implying the title IS the query.
        cleaned: Boolean(title.cleaned),
      },
    recommendedMetaDescription: meta.text,
    recommendedMetaDescriptionCheck: meta.check,
    suggestedHeadings: headings.headings,
    suggestedHeadingsBasis: {
      method: headings.method,
      introMethod: headings.introMethod,
      bodyMethod: headings.bodyMethod,
    },
    // Sub-topics carried through so a writer can see the structure the
    // headings came from, and split the page if it is really a hub.
    subTopics: Array.isArray(cluster.subClusters) ? cluster.subClusters : null,
    isHubTopic: Boolean(cluster.isHub),
    warnings,
    supportingKeywords: cluster.supportingKeywords,
    wordCountRange: words,
    internalLinks: links,
    relevantServices: services,
    callToAction: cta,
    // Explicitly unavailable rather than guessed — see file header.
    questionsToAnswer: { available: false, reason: 'Needs live Google search results (e.g. "People Also Ask") — no free data source provides this.' },
    competitorCoverage: { available: false, reason: 'Needs to see competitors\' actual ranking pages — no free data source provides this.' },
    // Which fields are templated wording vs derived from real data, so a UI
    // (or a human) can tell "Recommended Title" (always a template filled
    // in with the primary keyword) apart from "Word Count Range" (measured
    // from the brand's own crawled pages) instead of presenting both with
    // equal confidence.
    fieldSources: {
      // Downgraded to 'inferred' when the classifier itself is unsure, so a
      // low-confidence guess is never presented as measured data.
      searchIntent: intentIsWeak ? 'inferred' : 'data',
      recommendedTitle: title.method === 'template' ? 'template' : 'data',
      recommendedMetaDescription: 'template',
      suggestedHeadings: headings.method === 'template' ? 'template' : 'data',
      supportingKeywords: 'data',
      // 'data' only when there is actually a measurement behind the field.
      // Both of these previously claimed 'data' while holding null / an empty
      // list, which is the one thing this block exists to prevent.
      wordCountRange: words ? 'data' : 'unavailable',
      internalLinks: links.links.length ? 'data' : 'unavailable',
      relevantServices: services.configured ? 'data' : 'unavailable',
      callToAction: cta.configured ? 'data' : 'template',
      questionsToAnswer: 'unavailable',
      competitorCoverage: 'unavailable',
    },
  };
}

function findCluster(userId, keywordRunId, clusterId) {
  const run = db.prepare('SELECT * FROM keyword_runs WHERE id=? AND user_id=?').get(keywordRunId, userId);
  if (!run || !run.result_json) return null;
  let parsed;
  try { parsed = JSON.parse(run.result_json); } catch { return null; }
  const cluster = (parsed.clusters || []).find((c) => c.id === Number(clusterId));
  return cluster ? { run, cluster } : null;
}

function generate(userId, brand, keywordRunId, clusterId) {
  const found = findCluster(userId, keywordRunId, clusterId);
  if (!found) return { ok: false, error: 'Cluster not found in that keyword run.' };
  const data = build(brand, found.cluster);
  const result = db.prepare(`INSERT INTO content_briefs (user_id, brand_id, keyword_run_id, cluster_id, primary_keyword, data_json)
    VALUES (?,?,?,?,?,?)`)
    .run(userId, brand.id, keywordRunId, clusterId, found.cluster.primaryKeyword, JSON.stringify(data));
  return { ok: true, id: result.lastInsertRowid };
}

function get(id, userId) {
  const row = db.prepare(`SELECT b.*, br.name brand_name FROM content_briefs b
    LEFT JOIN brands br ON br.id=b.brand_id WHERE b.id=? AND b.user_id=?`).get(id, userId);
  if (!row) return null;
  try { row.data = JSON.parse(row.data_json); } catch { row.data = null; }
  return row;
}

function list(userId, brandId) {
  const where = brandId ? 'AND b.brand_id=?' : '';
  const args = brandId ? [userId, brandId] : [userId];
  return db.prepare(`SELECT b.id, b.primary_keyword, b.created_at, br.name brand_name, br.id brand_id
    FROM content_briefs b LEFT JOIN brands br ON br.id=b.brand_id
    WHERE b.user_id=? ${where} ORDER BY b.id DESC LIMIT 200`).all(...args);
}

module.exports = {
  build, generate, get, list, findCluster, wordCountRange,
  recommendedTitle, suggestedHeadings, templatedTitle, SCHEMA_VERSION,
};
