// Keyword clustering.
//
// Takes a keyword list (pasted, uploaded, or pulled straight from the brand's
// own Search Console queries) and returns clusters, each with a primary
// keyword, supporting keywords, search intent, a suggested page type, and a
// recommendation to either use an existing page or create a new one.
//
// METHOD, and why this one
// Real SERP-overlap clustering is the gold standard but needs a paid SERP API
// on every keyword. This runs on data we already have, with no external calls:
//
//  1. Normalise  — lowercase, strip punctuation, drop stopwords, light stemming
//                  so "web designer" and "web designers" share a token.
//  2. Signature  — each keyword reduces to its set of content-bearing tokens.
//  3. Cluster    — agglomerative merge on token overlap, with a rule that two
//                  keywords only join if they share a "head" term. This is what
//                  stops "web design cost" and "logo design cost" collapsing
//                  into one cluster purely because they share "design cost".
//  4. Anchor     — where the brand has GSC data, keywords that Google already
//                  answers with the SAME URL are pulled together regardless of
//                  wording. This is real behavioural evidence and it overrides
//                  the lexical guess, which is what makes the output usable
//                  rather than merely tidy.
//  5. Label      — the highest-volume (or shortest, as a fallback) member
//                  becomes the primary keyword; the rest are supporting.
//  6. Intent     — modifier patterns classify commercial / transactional /
//                  informational / navigational / local intent.
//  7. Page type  — derived from intent plus cluster shape.
//  8. Existing vs new — if one URL already owns most of the cluster's
//                  impressions, recommend improving it; otherwise a new page.
const db = require('../db');
const A = require('./analytics');
const places = require('./places');

// ---------------------------------------------------------- locale-aware NLP
//
// The original stemmer/stopword list was English-only suffix stripping
// applied unconditionally to every brand. For a non-English brand that is
// actively harmful — e.g. Spanish "casas" losing its final "s" under the
// English rule set collapses it with an unrelated word, and English
// stopwords ("the", "for") don't even occur in Spanish/French/German text
// so they were previously inert-but-wrong rather than helpful for those
// brands. `locale` (from `brands.locale`, e.g. "en", "es-MX", "fr-CA",
// "de") now selects a per-language rule set. Unset/unknown locale defaults
// to 'en', reproducing the original behaviour exactly for every brand that
// hasn't configured one.
//
// Coverage: en, es, fr, de get light suffix-stripping stemming and a
// stopword list. Any OTHER locale (it, pt, ja, ar, zh, ...) gets NO
// stemming (identity function) and NO stopword filtering — this is the
// explicit, documented fallback: applying a wrong-language rule is worse
// than applying none, so unsupported locales just compare exact word forms.
// This is a deliberate scope limit, not an oversight: full multi-language
// stemming (Snowball-quality) would need a real NLP dependency (e.g.
// `snowball-stemmers`), and installing new npm packages could not be
// verified as feasible in this environment, so we stayed dependency-free.
// A future pass can wire in a real stemmer library behind the same
// `stem(word, locale)` seam without touching call sites.
function normalizeLocale(locale) {
  if (!locale) return 'en';
  const l = String(locale).toLowerCase().split(/[-_]/)[0];
  return l || 'en';
}

const STOPWORDS_EN = new Set(`a an and are as at be but by for from how i in into is it of on or that the to was what when where which who why with your you my me we our us do does can could should would will has have had if then than there their this these those about above after again all also am any because been before being below between both during each few further here him his himself how's i'd i'll i'm i've into itself let's more most no nor not now off once only other ought our ours ourselves out over own same she so some such too under until up very were while whom you'd you'll you're you've yours yourself yourselves near best top good great cheap`.split(/\s+/));
const STOPWORDS_ES = new Set(`de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tu ti tus ellas nosotras vosotros vosotras os cerca mejor mejores barato buen buena mejor precio`.split(/\s+/));
const STOPWORDS_FR = new Set(`le de un etre et a il avoir ne je son que se qui ce dans en du elle au pour pas vous par sur faire plus dire on mon lui nous comme mais pouvoir avec tout y aller voir bien ou sans tu leur si deux pres meilleur meilleurs moins cher pas cher`.split(/\s+/));
const STOPWORDS_DE = new Set(`der die das und in den von zu mit sich des auf fur ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem uber einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei nahe beste gunstig billig`.split(/\s+/));

const STOPWORDS_BY_LOCALE = { en: STOPWORDS_EN, es: STOPWORDS_ES, fr: STOPWORDS_FR, de: STOPWORDS_DE };
// Kept for anything importing the historical name directly.
const STOPWORDS = STOPWORDS_EN;

function stopwordsFor(locale) {
  const lang = normalizeLocale(locale);
  // Unsupported locale: an empty set, not the English list — English filler
  // words are just ordinary content tokens in other languages and dropping
  // them would silently discard real signal, not noise.
  return STOPWORDS_BY_LOCALE[lang] || new Set();
}

// Suffix, minLength pairs. Deliberately conservative light stemming, same
// spirit as the original English-only version: an aggressive stemmer merges
// unrelated keywords and the clusters stop making sense.
const EN_SUFFIXES = [['ies', 4], ['ing', 5], ['ers', 5], ['es', 4], ['er', 5], ['s', 4]];
const ES_SUFFIXES = [['ciones', 7], ['cion', 5], ['mente', 6], ['dades', 6], ['dad', 4], ['es', 4], ['as', 4], ['os', 4], ['a', 3], ['o', 3]];
const FR_SUFFIXES = [['ations', 7], ['ation', 6], ['ement', 6], ['euse', 5], ['eux', 4], ['ers', 5], ['es', 4], ['er', 4], ['s', 3]];
const DE_SUFFIXES = [['ungen', 6], ['heiten', 7], ['ung', 4], ['heit', 5], ['lich', 5], ['isch', 5], ['en', 4], ['er', 4], ['e', 3], ['s', 3]];
const LOCALE_SUFFIX_RULES = { en: EN_SUFFIXES, es: ES_SUFFIXES, fr: FR_SUFFIXES, de: DE_SUFFIXES };

function stem(word, locale = 'en') {
  if (word.length <= 3) return word;
  const lang = normalizeLocale(locale);
  const rules = LOCALE_SUFFIX_RULES[lang];
  if (!rules) return word; // unsupported locale: identity, see note above
  for (const [suffix, min] of rules) {
    if (word.endsWith(suffix) && word.length >= min) {
      if (lang === 'en' && suffix === 'ies') return `${word.slice(0, -3)}y`;
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function tokenize(keyword, locale = 'en') {
  const stop = stopwordsFor(locale);
  return String(keyword || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t.length > 1 && !stop.has(t))
    .map((t) => stem(t, locale));
}

// ------------------------------------------------------------------ intent
//
// Vertical support: the patterns below started life encoding one business
// type (services/agencies) as if it were universal. They still ARE the
// default/fallback set — that behaviour must not change for any brand that
// hasn't configured a vertical — but a brand can now opt into vertical-aware
// additions via `brand.vertical`. Unknown/unset vertical ('other' or falsy)
// reproduces the original patterns exactly.
//
// Local intent used to be anchored to six hardcoded US cities, which not
// only missed every other market but actively mislabelled non-US queries.
// It's replaced with locale-agnostic heuristics: "near me"-style phrases, a
// postal/ZIP code shape, and a city-agnostic "near/in <word(s)>" pattern
// (excluding common non-place nouns that would otherwise misfire, e.g.
// "in stock", "in bulk"). This is a broadened regex heuristic, not NER — it
// will still both over- and under-fire on some phrasing; see the module
// header limitations note for what's explicitly out of scope.
const LOCAL_IN_EXCLUSIONS = new Set(`
  stock bulk store cart advance general detail details progress person
  private public minutes hours days weeks months years total total-
  demand review reviews depth summary short brief full
`.trim().split(/\s+/));

// Country- and continent-scale places are NOT local intent.
//
// This was a live defect: "website design services in usa" matched the
// "in <word>" pattern, was labelled Local with high confidence, and the
// content brief then recommended a "Location landing page with NAP details,
// local proof and a map" for a national keyword — producing the title
// "... In Usa Near You" and the heading "Why Work With a Local Team". Nine of
// twenty-six clusters on the live brand were mislabelled this way.
//
// A searcher typing "in usa" wants a national provider, not a branch office.
// Local intent means city/neighbourhood scale, so anything at national scale
// or larger is excluded from the place pattern regardless of how it is
// phrased. Sub-national regions (states, counties) are deliberately NOT
// listed: "web design in texas" genuinely is regional intent.
// Includes the individual words of multi-word country names ("united",
// "great"), not just the joined forms. A market string like "United States"
// is split into its words before it reaches here, so excluding only
// "unitedstates" and "states" still let "united" through and re-created the
// exact bug this set exists to prevent.
const NON_LOCAL_PLACE_SCOPE = new Set(`
  usa us u.s usa's america american americas states unitedstates united
  uk u.k britain british england gb greatbritain great kingdom
  canada canadian australia australian europe european asia asian africa
  worldwide world global international nationwide national anywhere online
  earth eu emea apac latam
`.trim().split(/\s+/));

// A single "in <place>" match is weak evidence on its own. Local intent is
// confirmed when the cluster ALSO shows a genuinely local signal — a "near me"
// style phrase, a postcode, or a city term from the brand's configured
// market. Without corroboration the "in <place>" hit is treated as a weak
// signal (half weight) rather than proof, which stops a single preposition
// from redirecting an entire content plan.
function isNonLocalScope(word) {
  return NON_LOCAL_PLACE_SCOPE.has(String(word || '').toLowerCase().replace(/[^a-z.]/g, ''));
}

const LOCAL_RE = new RegExp(
  '\\b(near me|nearby|near you|close to me|in my area|around me)\\b'
  + '|\\b\\d{5}(-\\d{4})?\\b' // US ZIP / ZIP+4
  + '|\\b[a-z]{1,2}\\d[a-z\\d]?\\s?\\d[a-z]{2}\\b' // UK-style postcode shape
  + '|\\b(local|locally|city|town|county|zip code|postcode|postal code)\\b',
);

// Tested separately (not folded into LOCAL_RE) because it needs the
// exclusion list applied word-by-word.
function hasLocalInPattern(keyword, placeWhitelist) {
  const m = keyword.match(/\b(?:near|in)\s+([a-z][a-z.'-]{2,})\b/);
  if (m && !LOCAL_IN_EXCLUSIONS.has(m[1]) && !isNonLocalScope(m[1])) return true;
  // Market-aware boost: a brand's own configured service area/market means
  // its real place names are local-intent signal even without "near"/"in"
  // (e.g. "plumber stockport" for a brand whose market is Greater
  // Manchester). See the market-whitelist block below for where this set
  // comes from and how it degrades with no config/network at all.
  if (placeWhitelist && placeWhitelist.size) {
    for (const place of placeWhitelist) {
      // The country-scale exclusion has to apply here too, not only to the
      // "in <word>" pattern above. A brand whose market is "United States"
      // seeds the whitelist with "united" and "states", which would make
      // every national keyword ("web design united states") read as Local
      // intent and send the content brief off to recommend a location page
      // with NAP details and a map — the same failure the `in usa` fix
      // addressed, reached by a different route.
      if (place.length > 2 && !isNonLocalScope(place) && keyword.includes(place)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------- market place whitelist
//
// `brand.market` (e.g. "Greater Manchester", "Austin, TX") is now actually
// consumed here, not just stored. No paid geocoding API is required or
// assumed:
//
//  1. Zero-dependency baseline (always available, no network): the market
//     string itself is split into tokens/phrases ("greater manchester",
//     "manchester", "uk"), which already gives real per-brand place signal
//     with zero external calls and zero config beyond the field the brand
//     already fills in.
//  2. Optional best-effort enrichment: if the process has outbound network
//     access, `warmMarketPlaces` asks OpenStreetMap's free, keyless
//     Nominatim search API for real settlement names near/matching that
//     market string, and merges them into the whitelist. This is entirely
//     optional — no API key, no required config — and is fire-and-forget:
//     nothing in the request path awaits it, so a slow/blocked/offline
//     network never delays or fails a clustering run. If it fails for any
//     reason (offline box, rate limit, DNS blocked), the baseline token
//     split from step 1 is what's already cached and used instead.
//
// If a paid/keyed geocoding provider is ever wired up elsewhere in this
// codebase (grepped for GEOCODE/google maps/mapbox at the time of writing —
// none exists yet, only Google Business Profile's own API in sync.js /
// alertCatalog.js, which is a different surface and not a general geocoder),
// this is the seam to plug it into: replace/augment `warmMarketPlaces`.
const marketPlaceCache = new Map(); // lowercased market string -> Set(place tokens)

function marketTokens(market) {
  if (!market) return new Set();
  const raw = String(market).toLowerCase();
  const parts = raw.split(/[,/|]/).map((p) => p.trim()).filter(Boolean);
  const words = raw.split(/[\s,/|]+/).map((w) => w.trim()).filter((w) => w.length > 2);
  return new Set([...parts, ...words]);
}

// Best-effort, non-blocking. Callers should NOT await this on a request
// path that needs to stay fast/offline-safe — call it fire-and-forget after
// a run so the NEXT run for that market benefits from richer place names.
async function warmMarketPlaces(market, { timeoutMs = 4000 } = {}) {
  if (!market) return;
  const key = String(market).toLowerCase();
  if (marketPlaceCache.has(key)) return; // already warmed (or already fell back) this process
  const fallback = marketTokens(market);
  marketPlaceCache.set(key, fallback); // seed immediately so it's never empty mid-fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=25&featureType=settlement&q=${encodeURIComponent(market)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'seo-automation-suite/1.0 (best-effort local-intent lookup; no key required)' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return; // keep the fallback that's already cached
    const data = await res.json();
    const names = new Set(fallback);
    (Array.isArray(data) ? data : []).forEach((d) => {
      const primary = String(d.display_name || '').split(',')[0].trim().toLowerCase();
      if (primary) names.add(primary);
      if (d.address && typeof d.address === 'object') {
        Object.values(d.address).forEach((v) => { if (typeof v === 'string' && v.length > 2) names.add(v.toLowerCase()); });
      }
    });
    marketPlaceCache.set(key, names);
  } catch {
    // Offline / blocked / DNS failure / timeout: fine — the token-split
    // fallback set above is already cached and remains in use.
  }
}

function marketPlaceWhitelist(market) {
  if (!market) return null;
  const key = String(market).toLowerCase();
  if (marketPlaceCache.has(key)) return marketPlaceCache.get(key);
  const fallback = marketTokens(market);
  marketPlaceCache.set(key, fallback);
  return fallback;
}

const BASE_INTENT_PATTERNS = [
  {
    intent: 'Transactional',
    weight: 5,
    test: /\b(buy|order|price|pricing|cost|quote|hire|book|subscribe|signup|sign up|free trial|discount|coupon|deal|for sale|shop|purchase|rates?|fees?)\b/,
  },
  {
    intent: 'Commercial investigation',
    weight: 4,
    test: /\b(best|top|review|reviews|compare|comparison|vs|versus|alternative|alternatives|company|companies|agency|agencies|service|services|provider|providers|firm|firms|consultant|software|tools?|platform)\b/,
  },
  {
    intent: 'Local',
    weight: 4,
    test: LOCAL_RE,
  },
  {
    intent: 'Informational',
    weight: 3,
    test: /\b(how|what|why|when|which|guide|tutorial|tips|ideas|examples?|checklist|template|meaning|definition|explained|steps|learn|vs\b|difference)\b/,
  },
  {
    intent: 'Navigational',
    weight: 2,
    test: /\b(login|log in|sign in|contact|about|careers|support|help desk|portal|dashboard|download)\b/,
  },
];

// Vertical-specific additions layered on top of the base patterns above.
// These ADD signal (extra regex alternatives / weight adjustments) rather
// than replacing anything, so a brand without a configured vertical (or one
// set to 'other') behaves exactly as before.
const VERTICAL_EXTRA_TESTS = {
  ecommerce: {
    Transactional: /\b(buy|price|prices|cheap|for sale|shipping|in stock|add to cart|checkout|discount code)\b/,
  },
  saas: {
    Transactional: /\b(pricing|free trial|demo|subscribe|per seat|per user)\b/,
    'Commercial investigation': /\b(vs|versus|alternative|alternatives|integration|integrations|api)\b/,
  },
  marketplace: {
    Transactional: /\b(buy|price|prices|for sale|listing|listings|in stock)\b/,
  },
};

// publisher_content weights informational intent higher, since a content
// publisher's commercial-sounding modifiers (e.g. "best") are usually still
// editorial ("best laptops 2026") rather than a shortlist/CTA page.
const VERTICAL_WEIGHT_MULTIPLIERS = {
  publisher_content: { Informational: 1.5 },
};

function buildIntentPatterns(vertical) {
  const extra = VERTICAL_EXTRA_TESTS[vertical] || {};
  const weightMult = VERTICAL_WEIGHT_MULTIPLIERS[vertical] || {};
  return BASE_INTENT_PATTERNS.map((p) => {
    const extraTest = extra[p.intent];
    const test = extraTest ? new RegExp(`${p.test.source}|${extraTest.source}`, 'i') : p.test;
    const weight = weightMult[p.intent] ? p.weight * weightMult[p.intent] : p.weight;
    return { ...p, test, weight };
  });
}

// ---------------------------------------------------------------- page type
//
// The page-type taxonomy used to be a single hardcoded list bolted onto the
// intent patterns above, which is exactly the "confident but wrong" failure
// mode this rework targets: an ecommerce brand does not have "Service or
// product pages", it has PDPs and PLPs. `default` reproduces the original
// wording exactly, so an unset/unknown vertical is unaffected.
const PAGE_TYPE_TAXONOMY = {
  default: {
    Transactional: 'Service or product page with pricing and a direct enquiry form',
    'Commercial investigation': 'Comparison, listicle or category page with a clear shortlist and CTA',
    Local: 'Location landing page with NAP details, local proof and a map',
    Informational: 'Blog post or guide answering the question directly, with an in-content CTA',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  ecommerce: {
    Transactional: 'Product page (PDP) with price, stock status and add-to-cart',
    'Commercial investigation': 'Category page (PLP) or buying guide with a comparison table',
    Local: 'Store locator page with hours, address and a map',
    Informational: 'Buying guide answering the question directly, with links to relevant products',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  saas: {
    Transactional: 'Pricing page with plans and a free-trial/demo CTA',
    'Commercial investigation': 'Comparison/alternatives page with a feature matrix',
    Local: 'Integration page or regional landing page, if applicable',
    Informational: 'Blog post or guide answering the question directly, with an in-content CTA',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  marketplace: {
    Transactional: 'Listing/category page with pricing and a clear buy/enquire path',
    'Commercial investigation': 'Comparison or category page with a clear shortlist and CTA',
    Local: 'Location or store-locator page with a map',
    Informational: 'Buying guide answering the question directly, with links to relevant listings',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  local_service: {
    Transactional: 'Service page with pricing and a direct booking/enquiry form',
    'Commercial investigation': 'Comparison, listicle or category page with a clear shortlist and CTA',
    Local: 'Location landing page with NAP details, local proof and a map',
    Informational: 'Blog post or guide answering the question directly, with an in-content CTA',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  professional_services: {
    Transactional: 'Service page with pricing/engagement details and a direct enquiry form',
    'Commercial investigation': 'Comparison, listicle or category page with a clear shortlist and CTA',
    Local: 'Location landing page with NAP details, local proof and a map',
    Informational: 'Blog post or guide answering the question directly, with an in-content CTA',
    Navigational: 'Existing utility page — usually needs no new content',
  },
  publisher_content: {
    Transactional: 'Product/affiliate roundup page with clear picks and links',
    'Commercial investigation': 'Roundup or listicle page ranking the available options',
    Local: 'Location-focused editorial page, if applicable',
    Informational: 'In-depth editorial guide or article answering the question directly',
    Navigational: 'Existing utility page — usually needs no new content',
  },
};

function suggestedPageType(intent, vertical) {
  const table = PAGE_TYPE_TAXONOMY[vertical] || PAGE_TYPE_TAXONOMY.default;
  return table[intent] || PAGE_TYPE_TAXONOMY.default[intent] || PAGE_TYPE_TAXONOMY.default.Informational;
}

// `vertical` and `market` are optional and default to the original, generic
// behaviour — existing callers that don't pass them keep working exactly as
// before. Note the intent regex patterns themselves (buy/best/how/etc.) are
// still English-only; making those genuinely multilingual is out of scope
// for this pass (it needs per-language phrase lists, not a mechanical
// change) and is a known, explicit limitation — non-English brands still
// get usable clustering/stemming/local-detection, but intent labelling
// quality will be lower until that's addressed.
// Confidence is derived from COVERAGE and MARGIN, not from the pattern's
// weight.
//
// The previous formula was `score = (hits / n) * weight` with `high` at
// `score >= 2`. Since the weights are 4 and 5, any pattern matching half the
// keywords automatically scored >= 2, so on the live brand 20 of 26 clusters
// reported "high" confidence. That number was measuring "did half of these
// keywords contain a common word", then presenting it as certainty — and the
// content brief consumed it as if it were.
//
// Coverage and weight now do separate jobs: weight still decides WHICH intent
// wins (a transactional signal should outrank an informational one even when
// it appears less often), while confidence reflects how much of the cluster
// actually agreed and how clearly the winner beat the runner-up.
function intentConfidence(coverage, margin, clusterSize) {
  if (clusterSize >= 3 && coverage >= 0.6 && margin >= 0.25) return 'high';
  if (coverage >= 0.35 && margin >= 0.1) return 'medium';
  return 'low';
}

function classifyIntent(keywords, vertical = 'other', market = null) {
  const patterns = buildIntentPatterns(vertical);
  const placeWhitelist = marketPlaceWhitelist(market);
  const n = Math.max(1, keywords.length);
  const scores = new Map();
  const coverages = new Map();

  // Tracked separately so Local can be corroborated rather than trusted on a
  // bare "in <word>" match — see NON_LOCAL_PLACE_SCOPE above.
  let strongLocalHits = 0;
  let weakLocalHits = 0;

  patterns.forEach((p) => {
    // Count how many keywords in the cluster match, not just whether any do,
    // so a single stray "best" cannot re-label a whole informational cluster.
    let hits = 0;
    keywords.forEach((k) => {
      const kw = String(k).toLowerCase();
      if (p.intent === 'Local') {
        const strong = p.test.test(kw);
        const weak = !strong && hasLocalInPattern(kw, placeWhitelist);
        if (strong) strongLocalHits += 1;
        if (weak) weakLocalHits += 1;
        if (strong || weak) hits += 1;
        return;
      }
      if (p.test.test(kw)) hits += 1;
    });
    if (hits > 0) {
      const coverage = hits / n;
      let score = coverage * p.weight;
      // Local with no strong signal anywhere in the cluster is a preposition
      // match, not evidence of local intent. Halve it so it can still win when
      // nothing else fires, but cannot casually outrank a real commercial or
      // informational signal.
      if (p.intent === 'Local' && strongLocalHits === 0 && weakLocalHits > 0) score *= 0.5;
      scores.set(p.intent, score);
      coverages.set(p.intent, coverage);
    }
  });

  if (!scores.size) {
    return {
      intent: 'Informational',
      confidence: 'low',
      coverage: 0,
      pageType: `${suggestedPageType('Informational', vertical)} — no strong intent modifier present, so verify against the live SERP before committing`,
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [intent, score] = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;
  const margin = score > 0 ? (score - runnerUp) / score : 0;
  const coverage = coverages.get(intent) || 0;
  let confidence = intentConfidence(coverage, margin, keywords.length);

  // A Local label that rests only on weak matches can never be "high",
  // whatever the arithmetic says.
  if (intent === 'Local' && strongLocalHits === 0 && confidence === 'high') confidence = 'medium';

  const pageType = suggestedPageType(intent, vertical);
  return {
    intent,
    confidence,
    coverage,
    margin,
    // Low confidence is stated in the page-type string itself, because that
    // string is what gets read downstream and pasted into briefs.
    pageType: confidence === 'low'
      ? `${pageType} — intent signal is weak (${Math.round(coverage * 100)}% of keywords), so verify against the live SERP before committing`
      : pageType,
    alternatives: ranked.slice(1, 3).map(([i]) => i),
  };
}

// ------------------------------------------------------------- clustering

// Jaccard similarity over token sets.
function jaccard(a, b) {
  let shared = 0;
  a.forEach((t) => { if (b.has(t)) shared += 1; });
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// Overlap (containment) coefficient: shared tokens over the SMALLER set.
//
// Jaccard is length-biased, and it penalises exactly the keywords clustering
// exists to organise. "web design" vs "affordable web design services for
// small business" scores 0.29 on Jaccard and falls below the 0.4 threshold,
// so the long tail lands in singleton clusters while the head term sits alone.
// Containment scores that same pair at 1.0, because the short keyword is
// wholly inside the long one — which is the actual relationship.
//
// Used only as a FALLBACK alongside the shared-head-term rule, so it widens
// recall for genuine long tails without letting two unrelated keywords merge
// on a single common token.
function overlapCoefficient(a, b) {
  let shared = 0;
  a.forEach((t) => { if (b.has(t)) shared += 1; });
  const smaller = Math.min(a.size, b.size);
  return smaller === 0 ? 0 : shared / smaller;
}

// Mean pairwise Jaccard across a member list — how internally coherent a
// cluster actually is. Sampled above 40 members so this stays O(1)-ish on
// large inputs rather than quadratic.
function cohesion(members) {
  if (members.length < 2) return 1;
  const sample = members.length > 40
    ? members.filter((_, i) => i % Math.ceil(members.length / 40) === 0)
    : members;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      total += jaccard(sample[i].tokenSet, sample[j].tokenSet);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

function buildClusters(items, {
  minSimilarity = 0.4, requireSharedHead = true, containmentThreshold = 0.8,
  maxClusterSize = MAX_MERGED_CLUSTER_SIZE,
} = {}) {
  // Document frequency: a token appearing in nearly every keyword (the brand
  // name, or "design" on a design site) carries no separating power and must
  // not be allowed to act as the shared head term.
  const df = new Map();
  items.forEach((it) => it.tokenSet.forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const n = items.length;
  const isGeneric = (t) => (df.get(t) || 0) / n > 0.6;

  const headTokens = (it) => new Set([...it.tokenSet].filter((t) => !isGeneric(t)));
  items.forEach((it) => { it.headSet = headTokens(it); });

  // Seed one cluster per keyword, then merge greedily from the most
  // "central" keywords outward — highest volume first, so the biggest term
  // anchors the cluster rather than whichever happened to be first in the list.
  const order = [...items].sort((a, b) => (b.impressions - a.impressions) || (a.keyword.length - b.keyword.length));
  const clusters = [];
  const assigned = new Set();

  order.forEach((seed) => {
    if (assigned.has(seed.keyword)) return;
    const members = [seed];
    assigned.add(seed.keyword);

    // Gather every eligible candidate WITH its similarity, rather than
    // absorbing them in list order. A seed can legitimately match hundreds of
    // keywords on a site that ranks broadly for one topic, and taking them
    // first-come produced a 244-keyword cluster on the live brand — an
    // unusable planning unit that no page can be written against.
    //
    // Capping at `maxClusterSize` and keeping the CLOSEST members means the
    // overflow is not discarded: those keywords stay unassigned and go on to
    // seed their own clusters on later iterations, so a broad topic becomes
    // several coherent sibling clusters instead of one blob.
    const candidates = [];
    order.forEach((cand) => {
      if (assigned.has(cand.keyword)) return;
      const sim = jaccard(seed.tokenSet, cand.tokenSet);
      // Long-tail rescue: a keyword that wholly contains the seed's tokens
      // belongs with it even when Jaccard is dragged down by the extra words.
      const contained = sim < minSimilarity
        && overlapCoefficient(seed.tokenSet, cand.tokenSet) >= containmentThreshold;
      if (sim < minSimilarity && !contained) return;
      // Geography is a hard partition, not a similarity term.
      //
      // "web development services usa" and "web development services atlanta"
      // share the head "web development" and score highly on Jaccard, so they
      // used to land in one cluster — and the content brief then titled the
      // national page "... Services Atlanta". Different places mean different
      // pages targeting different SERPs, and no lexical score should be able
      // to override that.
      if (seed.placeKey !== cand.placeKey) return;
      // The shared-head rule is enforced for containment matches too — it is
      // what stops "web design cost" and "logo design cost" merging on
      // "design cost" alone.
      if (requireSharedHead && seed.headSet.size && cand.headSet.size) {
        let sharesHead = false;
        cand.headSet.forEach((t) => { if (seed.headSet.has(t)) sharesHead = true; });
        if (!sharesHead) return;
      }
      candidates.push({ cand, sim });
    });

    candidates
      .sort((a, b) => (b.sim - a.sim) || (b.cand.impressions - a.cand.impressions))
      .slice(0, Math.max(0, maxClusterSize - 1))
      .forEach(({ cand }) => {
        members.push(cand);
        assigned.add(cand.keyword);
      });

    clusters.push(members);
  });

  return clusters;
}

// Step 4: merge clusters whose keywords Google already answers with the same
// URL. Behavioural evidence beats lexical similarity.
// Merging on the dominant ranking URL is sound in principle — Google answering
// two phrasings with the same page is real behavioural evidence — but it was
// unbounded, and on a small site one strong blog post ranks for hundreds of
// variants. On the live brand that collapsed 244 of 500 keywords (49% of the
// input) into a single cluster labelled "website development company". Nothing
// can be written against a 244-keyword cluster, and the content brief
// downstream just title-cased the first few members as headings.
//
// Two guards, both of which preserve the behaviour that made this useful:
//   maxMergedSize — a merged cluster stops absorbing beyond a workable page's
//     worth of keywords. The evidence that two groups share a ranking URL is
//     still recorded (they keep the same existingPage), they simply stay
//     separate planning units.
//   minMergedCohesion — a merge is rejected outright if it would drop mean
//     pairwise similarity below a floor, i.e. if the only thing the members
//     have in common is that one over-ranking URL.
const MAX_MERGED_CLUSTER_SIZE = 30;
const MIN_MERGED_COHESION = 0.18;

function mergeByRankingUrl(clusters, urlForKeyword, {
  maxMergedSize = MAX_MERGED_CLUSTER_SIZE,
  minMergedCohesion = MIN_MERGED_COHESION,
} = {}) {
  if (!urlForKeyword) return clusters;

  const dominantUrl = (members) => {
    const tally = new Map();
    members.forEach((m) => {
      const u = urlForKeyword.get(m.keyword);
      if (!u) return;
      tally.set(u, (tally.get(u) || 0) + (m.impressions || 1));
    });
    if (!tally.size) return null;
    const [url, weight] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    // Only treat the URL as the cluster's owner if it dominates decisively.
    return weight / total >= 0.6 ? url : null;
  };

  const byUrl = new Map();
  const out = [];
  clusters.forEach((members) => {
    const url = dominantUrl(members);
    if (!url) { out.push(members); return; }
    const target = byUrl.get(url);
    if (target) {
      // One URL commonly ranks for several cities at once, so the ranking-URL
      // merge would quietly undo the geographic partition applied above.
      if ((target[0] && target[0].placeKey) !== (members[0] && members[0].placeKey)) {
        out.push(members);
        return;
      }
      const combined = target.length + members.length;
      const wouldCohere = combined <= maxMergedSize
        ? cohesion([...target, ...members]) >= minMergedCohesion
        : false;
      if (combined <= maxMergedSize && wouldCohere) {
        target.push(...members);
        return;
      }
      // Rejected: keep this group as its own planning unit. It still shares
      // the ranking URL, which the caller records as `existingPage`.
      out.push(members);
      return;
    }
    const arr = [...members];
    byUrl.set(url, arr);
    out.push(arr);
  });
  return out;
}

// Splits an oversized cluster into coherent sub-topics by re-clustering its
// own members at a stricter threshold. Returns null when the cluster is small
// enough to be a single page, or when splitting produced nothing useful.
//
// This is what makes a large topic actionable: "website development company"
// with 100+ variants is a hub, and each sub-cluster is a page under it. The
// content brief consumes sub-clusters so headings come from distinct
// sub-topics instead of from near-identical keyword restatements.
const SUBCLUSTER_MIN_SIZE = 12;

function buildSubClusters(members, { minSimilarity = 0.4 } = {}) {
  if (members.length < SUBCLUSTER_MIN_SIZE) return null;
  const stricter = Math.min(0.75, minSimilarity + 0.2);
  const groups = buildClusters(members, { minSimilarity: stricter, containmentThreshold: 0.9 })
    .filter((g) => g.length > 0);
  // A split that yields one group, or one group per keyword, has told us
  // nothing — fall back to no sub-clusters rather than fake structure.
  if (groups.length < 2 || groups.length > members.length * 0.7) return null;
  return groups
    .sort((a, b) => b.reduce((s, m) => s + m.impressions, 0) - a.reduce((s, m) => s + m.impressions, 0))
    // Capped at what a writer can actually turn into sections. Beyond this the
    // tail is long-tail phrasing, not distinct sub-topics.
    .slice(0, 8)
    .map((g, i) => {
      const sorted = [...g].sort((a, b) => (b.impressions - a.impressions) || (a.keyword.length - b.keyword.length));
      return {
        id: i + 1,
        label: sorted[0].keyword,
        keywords: sorted.map((m) => m.keyword),
        keywordCount: sorted.length,
        impressions: g.reduce((s, m) => s + m.impressions, 0),
        clicks: g.reduce((s, m) => s + m.clicks, 0),
      };
    });
}

// ------------------------------------------------------------------ public

// `input` is an array of { keyword, impressions?, clicks?, position? }, or an
// array of plain strings.
function cluster(input, {
  brandId = null, minSimilarity = 0.4, maxClusters = 200, vertical = 'other',
  locale = 'en', market = null,
} = {}) {
  // Best-effort, non-blocking: warms the market-place cache for NEXT time.
  // Never awaited here, so an offline box or slow network never delays (or
  // can ever fail) a clustering run.
  if (market) warmMarketPlaces(market).catch(() => {});

  const seen = new Set();
  const items = [];
  (input || []).forEach((raw) => {
    const keyword = String(typeof raw === 'string' ? raw : raw.keyword || '').trim().toLowerCase();
    if (!keyword || seen.has(keyword)) return;
    seen.add(keyword);
    const tokens = tokenize(keyword, locale);
    if (!tokens.length) return;
    items.push({
      keyword,
      tokens,
      tokenSet: new Set(tokens),
      // '' for national/unscoped keywords; a canonical place key otherwise.
      placeKey: places.placeKey(keyword, marketPlaceWhitelist(market)),
      impressions: Number((typeof raw === 'object' && raw.impressions) || 0),
      clicks: Number((typeof raw === 'object' && raw.clicks) || 0),
      position: (typeof raw === 'object' && raw.position != null) ? Number(raw.position) : null,
    });
  });

  // The empty-input result must have the SAME shape as a real one.
  //
  // It previously returned only three keys, so `result.clusterCount` was
  // undefined and `saveRun` died on a NOT NULL constraint. That is reachable
  // from ordinary use: paste a list that is entirely stopwords, or upload a
  // CSV whose keyword column is mis-detected, and every row tokenises to
  // nothing. The run then 500s instead of reporting that it found no usable
  // keywords.
  if (!items.length) {
    return {
      clusters: [],
      keywordCount: 0,
      clusterCount: 0,
      singletons: 0,
      hadGscContext: false,
      unclustered: [],
      hubs: 0,
      needsReview: 0,
      largestCluster: 0,
      topicCount: 0,
      truncated: null,
      // Says WHY it is empty, so the UI can tell "no keywords supplied" apart
      // from "keywords supplied but none were usable".
      emptyReason: (input || []).length
        ? 'None of the supplied keywords contained a usable word after removing stopwords and punctuation. Check that the correct column was picked up.'
        : 'No keywords were supplied.',
    };
  }

  // Where the brand has GSC data, look up which URL already ranks per keyword.
  let urlForKeyword = null;
  if (brandId) {
    urlForKeyword = new Map();
    const rows = db.prepare(`SELECT query, page, MAX(impressions) imp FROM gsc_query_page
      WHERE brand_id=? GROUP BY query`).all(brandId);
    rows.forEach((r) => urlForKeyword.set(String(r.query).toLowerCase(), r.page));
  }

  let groups = buildClusters(items, { minSimilarity });
  groups = mergeByRankingUrl(groups, urlForKeyword);
  groups.sort((a, b) => {
    const ai = a.reduce((s, m) => s + m.impressions, 0);
    const bi = b.reduce((s, m) => s + m.impressions, 0);
    return (bi - ai) || (b.length - a.length);
  });
  // Truncation used to be silent, so a run that dropped half its clusters
  // looked identical to one that fitted. Report it instead.
  const droppedClusters = Math.max(0, groups.length - maxClusters);
  const droppedKeywords = droppedClusters
    ? groups.slice(maxClusters).reduce((s, g) => s + g.length, 0)
    : 0;
  groups = groups.slice(0, maxClusters);

  const clusters = groups.map((members, i) => {
    // Primary keyword: most impressions, then most clicks, then shortest —
    // the shortest term is usually the head term of the topic.
    const sorted = [...members].sort((a, b) =>
      (b.impressions - a.impressions) || (b.clicks - a.clicks) || (a.keyword.length - b.keyword.length));
    const primary = sorted[0];
    const supporting = sorted.slice(1);
    const keywords = sorted.map((m) => m.keyword);
    const intent = classifyIntent(keywords, vertical || 'other', market);

    const totalImpressions = members.reduce((s, m) => s + m.impressions, 0);
    const totalClicks = members.reduce((s, m) => s + m.clicks, 0);
    const positions = members.map((m) => m.position).filter((p) => p != null && p > 0);
    const avgPosition = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : null;

    // Existing page vs new page.
    let existing = null;
    if (urlForKeyword) {
      const tally = new Map();
      members.forEach((m) => {
        const u = urlForKeyword.get(m.keyword);
        if (!u) return;
        tally.set(u, (tally.get(u) || 0) + (m.impressions || 1));
      });
      if (tally.size) {
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        const total = ranked.reduce((s, [, w]) => s + w, 0);
        existing = {
          url: ranked[0][0],
          share: total > 0 ? ranked[0][1] / total : 0,
          competingUrls: ranked.length,
          allUrls: ranked.slice(0, 5).map(([u, w]) => ({ url: u, weight: w })),
        };
      }
    }

    let recommendation;
    let recommendationReason;
    if (!existing) {
      recommendation = 'Create new page';
      recommendationReason = brandId
        ? 'No URL on the site currently earns impressions for these keywords, so there is nothing to improve.'
        : 'No Search Console data was supplied for this brand, so existing coverage could not be checked. Verify by hand before commissioning new content.';
    } else if (existing.competingUrls >= 3 && existing.share < 0.5) {
      recommendation = 'Consolidate existing pages';
      recommendationReason = `${existing.competingUrls} different URLs already split these keywords, with no clear owner (the leading URL takes only ${Math.round(existing.share * 100)}% of impressions). Choose one canonical page before adding more content.`;
    } else if (avgPosition != null && avgPosition <= 3) {
      recommendation = 'Existing page — already strong';
      recommendationReason = `${existing.url} already ranks at position ${avgPosition.toFixed(1)} for this cluster. Protect it rather than rewriting it.`;
    } else {
      recommendation = 'Improve existing page';
      recommendationReason = `${existing.url} already earns ${Math.round(existing.share * 100)}% of this cluster's impressions${avgPosition != null ? ` at average position ${avgPosition.toFixed(1)}` : ''}. Expanding it is cheaper and faster than building a new page that would compete with it.`;
    }

    const subClusters = buildSubClusters(members, { minSimilarity });
    const clusterCohesion = cohesion(members);

    return {
      id: i + 1,
      label: primary.keyword,
      primaryKeyword: primary.keyword,
      supportingKeywords: supporting.map((m) => m.keyword),
      keywordCount: members.length,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      intentCoverage: intent.coverage,
      suggestedPageType: intent.pageType,
      // Present when the cluster is a topic rather than a single page. The
      // content brief uses these for headings; without them it restates the
      // same keyword six ways.
      subClusters,
      isHub: Boolean(subClusters && subClusters.length >= 2),
      cohesion: clusterCohesion,
      // The geography this cluster targets ('' = national/unscoped). Surfaced
      // so a brief can state it rather than inferring it from a keyword.
      placeKey: primary.placeKey || '',
      isGeoTargeted: Boolean(primary.placeKey),
      // Flags a cluster whose members do not really belong together, so a
      // human reviews it before it becomes a page.
      needsReview: clusterCohesion < 0.15 && members.length >= 5,
      totalImpressions,
      totalClicks,
      avgPosition,
      ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      existingPage: existing ? existing.url : null,
      existingShare: existing ? existing.share : null,
      competingUrls: existing ? existing.competingUrls : 0,
      recommendation,
      recommendationReason,
      members: sorted.map((m) => ({
        keyword: m.keyword, impressions: m.impressions, clicks: m.clicks,
        position: m.position, rankingUrl: urlForKeyword ? (urlForKeyword.get(m.keyword) || null) : null,
      })),
    };
  });

  // Sibling topics.
  //
  // Capping cluster size stops the 244-keyword blob, but it introduces the
  // opposite risk: a site that ranks for hundreds of variants of one theme now
  // produces many 30-keyword siblings, and filing a separate task and brief
  // for each would be just as unusable in the other direction.
  //
  // The evidence that dropped out of mergeByRankingUrl is reinstated here as a
  // grouping rather than a merge: clusters that Google answers with the SAME
  // URL are tagged with a shared topicId. They stay separate planning units
  // (each can become its own page), but the backlog treats the topic as one
  // piece of work — see clustersToTasks.
  const topicByUrl = new Map();
  clusters.forEach((c) => {
    if (!c.existingPage) { c.topicId = null; return; }
    if (!topicByUrl.has(c.existingPage)) topicByUrl.set(c.existingPage, []);
    topicByUrl.get(c.existingPage).push(c);
  });
  let topicSeq = 0;
  topicByUrl.forEach((group) => {
    topicSeq += 1;
    group.forEach((c) => {
      c.topicId = `t${topicSeq}`;
      c.siblingCount = group.length;
    });
  });

  return {
    clusters,
    topicCount: topicSeq,
    keywordCount: items.length,
    clusterCount: clusters.length,
    singletons: clusters.filter((c) => c.keywordCount === 1).length,
    hadGscContext: Boolean(urlForKeyword && urlForKeyword.size),
    // `unclustered` was previously returned only on the empty-input path, so
    // any caller reading it on a real run got undefined. Singleton clusters
    // are what "unclustered" actually means here.
    unclustered: clusters.filter((c) => c.keywordCount === 1).map((c) => c.primaryKeyword),
    hubs: clusters.filter((c) => c.isHub).length,
    needsReview: clusters.filter((c) => c.needsReview).length,
    largestCluster: clusters.length ? Math.max(...clusters.map((c) => c.keywordCount)) : 0,
    // Place-shaped words the gazetteer did not recognise. Reported rather than
    // swallowed, so a miss is visible and fixable (add it to the brand's
    // market) instead of silently producing a worse cluster.
    unrecognisedPlaces: places.unrecognisedPlaceCandidates(
      items.map((i) => i.keyword), marketPlaceWhitelist(market),
    ),
    truncated: droppedClusters > 0
      ? { droppedClusters, droppedKeywords, maxClusters }
      : null,
  };
}

// Pull the brand's own queries from the consolidated data as clustering input.
function keywordsFromGsc(brandId, { days = 90, minImpressions = 10, limit = 1500 } = {}) {
  const anchor = A.latestGscDate(brandId);
  if (!anchor) return [];
  const w = A.windowFrom(anchor, days);
  return db.prepare(`SELECT query keyword,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_query_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY query HAVING SUM(impressions) >= ?
    ORDER BY impressions DESC LIMIT ?`)
    .all(brandId, w.startDate, w.endDate, minImpressions, limit);
}

// Accepts pasted text (one keyword per line) or CSV with a keyword column
// plus optional impressions/clicks/position columns.
function parseKeywordInput(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delimiter) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const first = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/^﻿/, ''));
  const kwIdx = first.findIndex((h) => /^(keyword|query|term|search term)s?$/.test(h));
  const hasHeader = kwIdx !== -1;

  if (!hasHeader) {
    // No header: treat the first field of every line as the keyword.
    return lines.map((l) => ({ keyword: splitLine(l)[0] })).filter((r) => r.keyword);
  }

  const idx = (names) => first.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const impIdx = idx(['impression', 'impr', 'volume', 'search volume']);
  const clickIdx = idx(['click']);
  const posIdx = idx(['position', 'rank', 'avg position', 'average position']);

  return lines.slice(1).map((l) => {
    const c = splitLine(l);
    const num = (i) => {
      if (i === -1 || c[i] == null) return 0;
      const n = Number(String(c[i]).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    return {
      keyword: c[kwIdx],
      impressions: num(impIdx),
      clicks: num(clickIdx),
      position: posIdx === -1 ? null : (num(posIdx) || null),
    };
  }).filter((r) => r.keyword);
}

function saveRun(userId, brandId, name, source, result) {
  const r = db.prepare(`INSERT INTO keyword_runs
    (user_id, brand_id, name, source, keyword_count, cluster_count, result_json)
    VALUES (?,?,?,?,?,?,?)`)
    .run(userId, brandId, name || null, source, result.keywordCount, result.clusterCount, JSON.stringify(result));
  return r.lastInsertRowid;
}

function getRun(id, userId) {
  const row = db.prepare(`SELECT k.*, b.name brand_name FROM keyword_runs k
    LEFT JOIN brands b ON b.id=k.brand_id WHERE k.id=? AND k.user_id=?`).get(id, userId);
  if (!row) return null;
  try { row.result = JSON.parse(row.result_json); } catch { row.result = null; }
  return row;
}

function listRuns(userId, brandId) {
  const where = brandId ? 'AND k.brand_id=?' : '';
  const args = brandId ? [userId, brandId] : [userId];
  return db.prepare(`SELECT k.id, k.name, k.source, k.keyword_count, k.cluster_count, k.created_at,
      b.name brand_name FROM keyword_runs k LEFT JOIN brands b ON b.id=k.brand_id
    WHERE k.user_id=? ${where} ORDER BY k.id DESC LIMIT 50`).all(...args);
}

// Turns clusters into content tasks — the bridge from analysis to backlog.
function clustersToTasks(runId, userId, brandId, result, tasksLib, { maxTasks = 25, reconcile = true } = {}) {
  let created = 0;
  const emittedKeys = [];

  // One task per TOPIC, not per cluster. Sibling clusters (same dominant
  // ranking URL) describe one body of work on one page; filing them
  // separately would put ten near-identical rows in the backlog.
  const eligible = result.clusters.filter((c) => c.recommendation !== 'Existing page — already strong');
  const byTopic = new Map();
  eligible.forEach((c) => {
    const key = c.topicId || `c${c.id}`;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(c);
  });

  [...byTopic.values()]
    .map((group) => group.sort((a, b) => b.totalImpressions - a.totalImpressions))
    .sort((a, b) => b.reduce((s, c) => s + c.totalImpressions, 0) - a.reduce((s, c) => s + c.totalImpressions, 0))
    .slice(0, maxTasks)
    .forEach((group) => {
      const c = group[0];
      const siblings = group.slice(1);
      const topicImpressions = group.reduce((s, g) => s + g.totalImpressions, 0);
      const isNew = c.recommendation === 'Create new page';
      const detail = [
        `Cluster: ${c.keywordCount} keyword${c.keywordCount === 1 ? '' : 's'}, ${Math.round(c.totalImpressions).toLocaleString('en-US')} impressions, ${Math.round(c.totalClicks).toLocaleString('en-US')} clicks${c.avgPosition != null ? `, average position ${c.avgPosition.toFixed(1)}` : ''}.`,
        '',
        `Search intent: ${c.intent} (${c.intentConfidence} confidence)`,
        `Suggested page type: ${c.suggestedPageType}`,
        '',
        `Primary keyword: ${c.primaryKeyword}`,
        ...(c.supportingKeywords.length ? ['Supporting keywords:', ...c.supportingKeywords.slice(0, 25).map((k) => `  • ${k}`)] : []),
        ...(c.supportingKeywords.length > 25 ? [`  … and ${c.supportingKeywords.length - 25} more`] : []),
        ...(c.subClusters && c.subClusters.length >= 2
          ? ['', 'Sub-topics (each can become a section or its own page):',
            ...c.subClusters.map((s) => `  • ${s.label} (${s.keywordCount} keywords, ${Math.round(s.impressions).toLocaleString('en-US')} impressions)`)]
          : []),
        ...(siblings.length
          ? ['', `Related clusters ranking with the same URL (${siblings.length}) — plan these together, not as separate pages:`,
            ...siblings.map((s) => `  • ${s.primaryKeyword} (${s.keywordCount} keywords)`)]
          : []),
        ...(c.needsReview ? ['', 'NOTE: these keywords are only loosely related (low cohesion) — review the grouping before commissioning.'] : []),
        ...(c.intentConfidence === 'low' ? ['', 'NOTE: search intent for this cluster is a weak guess — confirm against the live SERP before choosing a page type.'] : []),
        '',
        `Recommendation: ${c.recommendation}`,
        c.recommendationReason,
        ...(c.existingPage ? ['', `Existing page: ${c.existingPage}`] : []),
        '',
        `Source: keyword clustering run #${runId}.`,
      ].join('\n');

      const dedupeKey = `task:cluster:${brandId || `u${userId}`}:${c.existingPage || c.primaryKeyword}`;
      emittedKeys.push(dedupeKey);
      const r = tasksLib.upsertTask({
        userId, brandId,
        title: isNew
          ? `New page: "${c.primaryKeyword}" (${c.keywordCount} keywords)`
          : `${c.recommendation}: "${c.primaryKeyword}"`,
        detail,
        source: 'opportunity',
        sourceRef: `cluster:${runId}:${c.id}`,
        category: 'Content',
        // Severity reflects the whole topic, not just its lead cluster.
        severity: topicImpressions >= 1000 ? 'high' : (topicImpressions >= 200 ? 'medium' : 'low'),
        affectedUrl: c.existingPage,
        evidence: { cluster: c, siblings: siblings.map((s) => s.primaryKeyword), runId },
        // Keyed on the page the topic belongs to where one is known, so a
        // re-run whose lead keyword shifts updates the existing task instead
        // of opening a duplicate.
        dedupeKey,
      });
      if (r.created) created += 1;
    });

  // Retire cluster tasks whose topic no longer appears in the latest run.
  // Only safe when the run was not truncated by `maxTasks`: a capped run has
  // not looked at every topic, so absence is not evidence of resolution.
  let retired = null;
  const wasCapped = byTopic.size > maxTasks;
  if (reconcile && !wasCapped && typeof tasksLib.reconcile === 'function') {
    retired = tasksLib.reconcile(userId, brandId, 'opportunity', emittedKeys, {
      sourceRef: `keyword clustering run #${runId}`,
      keyPrefix: `task:cluster:${brandId || `u${userId}`}:`,
    });
  }
  return { created, retired, cappedAt: wasCapped ? maxTasks : null };
}

module.exports = {
  cluster, keywordsFromGsc, parseKeywordInput, classifyIntent, tokenize, stem,
  saveRun, getRun, listRuns, clustersToTasks, suggestedPageType,
  warmMarketPlaces, marketPlaceWhitelist, normalizeLocale,
};
