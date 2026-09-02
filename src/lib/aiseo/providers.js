// WHICH DATA SOURCES THIS DEPLOYMENT ACTUALLY HAS
//
// The AI SEO features were specified against a list of tools — Semrush,
// Ahrefs, Moz, Google Keyword Planner, GtMetrix, aicrawlercheck.com. This
// deployment holds credentials for none of them. Pretending otherwise would
// produce the worst possible outcome: a dashboard full of invented keyword
// volumes and backlink counts that read exactly like real ones.
//
// So every feature is built on the sources that ARE present and verifiable —
// Search Console, GA4, PageSpeed Insights / CrUX, this app's own crawler, the
// public endpoints that need no key, and Azure OpenAI — and every provider
// that would improve a given feature is declared here as an OPTIONAL adapter.
// A feature checks `has()` before reaching for one, and states in its own
// output which sources its numbers came from. Add a key to .env and the
// adapter activates; add nothing and the feature still works, with the
// narrower basis named on the page.
//
// The point of the registry is that "we do not have Semrush" is a fact the UI
// can render, rather than a silence the reader has to guess at.
const config = require('../../config');

// A provider entry:
//   key        stable id used in code and in `sources` arrays on results
//   label      what a human calls it
//   kind       search-console | analytics | performance | ai | crawler |
//              public | keyword-tool | backlinks | rank-tracker
//   envKeys    the variables that make it available (all must be set)
//   detect     optional override when availability is not just an env var
//   provides   what a feature can ask it for
//   note       shown in the UI beside an unavailable provider
//   enhancedBy optional. Variables that IMPROVE a provider which already
//              works. This exists because two states were not enough: Reddit
//              is scraped successfully with no credential at all, and a
//              credential only removes the rate limiting and adds post scores.
//              Rendering that as "not configured" told the reader the source
//              was dead when it was returning data — the opposite of true.
//   enhancedNote  what the enhancement buys, shown when it is NOT yet set
const PROVIDERS = [
  {
    key: 'gsc',
    label: 'Google Search Console',
    kind: 'search-console',
    envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    provides: ['queries', 'impressions', 'clicks', 'positions', 'index-coverage', 'sitemaps'],
    note: 'Connect Google to supply real query and indexation data.',
  },
  {
    key: 'ga4',
    label: 'Google Analytics 4',
    kind: 'analytics',
    envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    provides: ['sessions', 'conversions', 'engagement'],
    note: 'Connect Google and pair a GA4 property on the brand.',
  },
  {
    key: 'psi',
    label: 'PageSpeed Insights / CrUX',
    kind: 'performance',
    // PSI authorises the OAuth principal, so a Google connection alone is
    // enough; PSI_API_KEY is an extra path, not a requirement. See lib/psi.js.
    envKeys: [],
    detect: () => Boolean(process.env.PSI_API_KEY || process.env.GOOGLE_CLIENT_ID),
    provides: ['lcp', 'inp', 'cls', 'ttfb', 'lighthouse', 'field-data'],
    note: 'Needs either a Google connection or PSI_API_KEY.',
  },
  {
    key: 'azure',
    label: 'Azure OpenAI',
    kind: 'ai',
    envKeys: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY_A', 'AZURE_OPENAI_MODEL'],
    provides: ['prompt-research', 'entity-extraction', 'edit-suggestions', 'schema-drafting', 'sentiment'],
    note: 'Set AZURE_OPENAI_ENDPOINT / _KEY_A / _MODEL to enable AI-assisted output.',
  },
  {
    key: 'crawler',
    label: 'Built-in crawler',
    kind: 'crawler',
    envKeys: [],
    detect: () => true, // pure JavaScript, always present
    provides: ['html', 'headings', 'schema', 'links', 'robots', 'sitemaps', 'ttfb', 'status'],
    note: null,
  },
  {
    key: 'public',
    label: 'Keyless public endpoints',
    kind: 'public',
    envKeys: [],
    // Google Suggest, the Hacker News search API and Google/Bing News RSS all
    // answer unauthenticated requests. Reddit is also keyless but has its own
    // row, because it is the one source with a meaningful upgrade path and its
    // own tiered client — listing it here as well would give two rows claiming
    // the same capability.
    detect: () => process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1',
    provides: ['autocomplete', 'hackernews', 'news-rss'],
    note: 'Disabled by AISEO_DISABLE_PUBLIC_SOURCES=1.',
  },

  {
    key: 'web-mentions',
    label: 'Web mentions (DuckDuckGo, keyless)',
    kind: 'public',
    // A free proxy for "who mentions this domain": a same-day DuckDuckGo HTML
    // search for the domain, excluding the domain's own pages. See
    // ./webMentions.js for exactly what this is and is not — it is reported
    // as "referring pages found in a web search", never as a backlink or
    // referring-domain count, which needs a real link index.
    envKeys: [],
    detect: () => process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1',
    provides: ['referring-pages'],
    note: 'Disabled by AISEO_DISABLE_PUBLIC_SOURCES=1. Not a substitute for a verified backlink index (Ahrefs/Moz/Semrush) — a same-day search-result sample.',
  },

  {
    key: 'serp-lite',
    label: 'SERP sample (DuckDuckGo / Bing, keyless)',
    kind: 'public',
    // A country-aware sample of a NON-GOOGLE result page. See ./serpLite.js
    // for exactly what it is. It powers the keyword-difficulty proxy, the
    // keyword-gap table and the review-platform presence check — three things
    // that were previously impossible here and are now possible with the basis
    // stated on every number.
    envKeys: [],
    detect: () => process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1',
    provides: ['serp-sample', 'keyword-difficulty-proxy', 'related-searches', 'competitor-visibility'],
    note: 'Disabled by AISEO_DISABLE_PUBLIC_SOURCES=1. Samples DuckDuckGo and Bing, not Google — every metric derived from it is labelled a proxy.',
    enhancedBy: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    enhancedNote: 'Sampling a non-Google index. DataForSEO credentials would replace the sample with a live Google SERP for the same checks, turning the difficulty proxy into a measured keyword difficulty.',
  },

  {
    key: 'google-trends',
    label: 'Google Trends (keyless)',
    kind: 'public',
    // The only free, country-filterable demand signal available. Returns
    // RELATIVE interest 0-100, never a count — see ./keywordMetrics.js.
    envKeys: [],
    detect: () => process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1',
    provides: ['relative-interest', 'country-demand', 'demand-trend'],
    note: 'Disabled by AISEO_DISABLE_PUBLIC_SOURCES=1. Gives relative interest per country (0-100), which is the shape of demand rather than its size — it is never rendered as a search volume.',
  },

  {
    key: 'reddit',
    label: 'Reddit',
    kind: 'public',
    // No credential is required. src/lib/aiseo/redditClient.js scrapes Reddit
    // through a tiered chain whose RSS tier currently answers — verified
    // against the live endpoints, where /search.json 403s and old.reddit
    // redirects to a login wall. So availability tracks whether outbound
    // public calls are permitted at all, exactly like the other keyless
    // sources.
    envKeys: [],
    detect: () => process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1',
    provides: ['brand-mentions', 'forum-discussion', 'sentiment-source'],
    note: 'Disabled by AISEO_DISABLE_PUBLIC_SOURCES=1.',
    // A free "script" app removes the rate limiting and adds data the RSS
    // tier cannot carry.
    enhancedBy: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    enhancedNote: 'Working without a credential, via the RSS tier: rate-limited, no post scores, and post bodies without their comment threads. A free "script" app at reddit.com/prefs/apps (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) removes all three limits.',
  },

  // ---- optional commercial adapters -------------------------------------
  // None of these are wired to a live account here. Each is declared so the
  // features can name precisely what a key would add, and so adding one later
  // is a configuration change rather than a rewrite.
  {
    key: 'google-ads',
    label: 'Google Ads Keyword Planner',
    kind: 'keyword-tool',
    // The best volume source available and the cheapest: it reuses the Google
    // OAuth connection this app already holds, so the only thing missing is a
    // developer token (free, applied for in the Ads UI) and the manager
    // account id to bill the API call against.
    envKeys: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'],
    detect: () => Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      && process.env.GOOGLE_ADS_CUSTOMER_ID
      && process.env.GOOGLE_CLIENT_ID),
    provides: ['keyword-volume', 'keyword-cpc', 'keyword-competition', 'country-volume'],
    note: 'Set GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CUSTOMER_ID (and keep Google connected) to show the monthly search volumes Google itself reports, per country.',
  },
  {
    key: 'semrush',
    label: 'Semrush',
    kind: 'keyword-tool',
    envKeys: ['SEMRUSH_API_KEY'],
    provides: ['keyword-volume', 'keyword-difficulty', 'competitor-keywords', 'backlinks'],
    note: 'Set SEMRUSH_API_KEY to replace estimated volumes with measured ones.',
  },
  {
    key: 'ahrefs',
    label: 'Ahrefs',
    kind: 'backlinks',
    envKeys: ['AHREFS_API_TOKEN'],
    provides: ['referring-domains', 'anchor-text', 'keyword-difficulty', 'content-gap', 'link-index'],
    note: 'Set AHREFS_API_TOKEN to add measured referring-domain and anchor data.',
  },
  {
    key: 'moz',
    label: 'Moz',
    kind: 'backlinks',
    envKeys: ['MOZ_ACCESS_ID', 'MOZ_SECRET_KEY'],
    provides: ['domain-authority', 'referring-domains', 'anchor-text', 'link-index'],
    note: 'Set MOZ_ACCESS_ID and MOZ_SECRET_KEY to add authority metrics.',
  },
  {
    key: 'dataforseo',
    label: 'DataForSEO',
    kind: 'rank-tracker',
    envKeys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    provides: ['serp', 'keyword-volume', 'keyword-difficulty', 'ai-overview-presence', 'llm-citations', 'link-index', 'competitor-keywords'],
    note: 'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to add live SERP and AI Overview data.',
  },
];

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));

function has(key) {
  const p = BY_KEY.get(key);
  if (!p) return false;
  if (p.detect) return Boolean(p.detect());
  return p.envKeys.length > 0 && p.envKeys.every((k) => Boolean(process.env[k]));
}

// Is a provider that ALREADY works also running at full capability?
//
// Distinct from has(): a provider can be available and un-enhanced, which is a
// third state the UI must be able to show. Returns null where the concept does
// not apply, so a caller can tell "no enhancement defined" from "defined and
// absent".
function isEnhanced(key) {
  const p = BY_KEY.get(key);
  if (!p || !p.enhancedBy || !p.enhancedBy.length) return null;
  return p.enhancedBy.every((k) => Boolean(process.env[k]));
}

function decorate(p) {
  const enhanced = isEnhanced(p.key);
  return {
    ...p,
    available: has(p.key),
    // true = at full capability, false = working but limited, null = n/a
    enhanced,
    enhancementMissing: enhanced === false,
  };
}

function get(key) {
  const p = BY_KEY.get(key);
  if (!p) return null;
  return decorate(p);
}

function all() {
  return PROVIDERS.map(decorate);
}

// Everything that can supply a given capability, best-available first. A
// feature calls this rather than naming providers inline, so adding a key
// changes behaviour without touching the feature.
function providing(capability) {
  return all().filter((p) => p.available && p.provides.includes(capability));
}

function missing() {
  return all().filter((p) => !p.available);
}

// A short provenance line for a result page: the sources that produced it,
// and — stated plainly — the ones that would have improved it.
//
// `used` is the list of provider keys a run actually read from.
function provenance(used = []) {
  const usedSet = new Set(used);
  return {
    used: all().filter((p) => usedSet.has(p.key)).map((p) => ({ key: p.key, label: p.label })),
    wouldImprove: all()
      .filter((p) => !p.available && !usedSet.has(p.key))
      .filter((p) => ['keyword-tool', 'backlinks', 'rank-tracker'].includes(p.kind))
      .map((p) => ({ key: p.key, label: p.label, note: p.note })),
  };
}

// True when a brand can be analysed at all by a feature needing Search
// Console history. Used to explain an empty result instead of rendering a
// blank page.
function brandHasSearchData(brand) {
  return Boolean(brand && brand.gsc_property);
}

module.exports = {
  PROVIDERS, all, get, has, isEnhanced, providing, missing, provenance, brandHasSearchData,
  // Re-exported so a feature does not have to require config just for this.
  baseUrl: () => config.BASE_URL,
};
