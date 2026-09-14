// PUBLISHED CRAWLER IP RANGES - the only way to know a bot was really the bot.
//
// WHY THIS FILE EXISTS
// A user agent is a claim, not a credential. In a typical access log a large
// share of the requests calling themselves Googlebot are not Google, and a
// "Googlebot crawled 40,000 URLs" figure built from the user agent alone is
// wrong in the direction that makes a site look healthier than it is.
//
// Google, Bing and OpenAI publish their crawler ranges as plain JSON at stable
// URLs, with no key and no rate limit worth worrying about. So verification is
// available for free and there is no excuse for not doing it.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO
//   1. It does not fetch on demand during an import. A log import must work
//      offline and must not block on a network call - so the ranges are
//      fetched explicitly (a button, or the cron job) and cached on disk. An
//      import with no cache present says "UA-only, not verified" rather than
//      pretending.
//   2. It does not fail an import when a source is unreachable. A partial
//      range set verifies what it can; the result names which sources were
//      loaded and how old they are.
//   3. It does not invent ranges for crawlers that publish none. Applebot,
//      Yandex and Baidu document reverse-DNS verification instead, and those
//      are marked `rdns` in logAnalysis.js and verified by sampling - not
//      quietly counted as verified.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { fetchUrl, decodeBody } = require('../../tools/node/lib/http');

const CACHE_FILE = path.join(path.dirname(config.DB_PATH), 'bot-ranges.json');

// Each source is one published JSON file. `shape` says how to read it, because
// Google and Bing agree on the field names and OpenAI does not.
const SOURCES = [
  {
    key: 'googlebot',
    label: 'Googlebot',
    url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    owner: 'google',
  },
  {
    key: 'google-special',
    label: 'Google special crawlers (AdsBot, Google-Extended, GoogleOther)',
    url: 'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json',
    owner: 'google',
  },
  {
    key: 'google-user-triggered',
    label: 'Google user-triggered fetchers (Site Verifier, Inspection Tool)',
    url: 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json',
    owner: 'google',
  },
  {
    key: 'bingbot',
    label: 'Bingbot',
    url: 'https://www.bing.com/toolbox/bingbot.json',
    owner: 'bing',
  },
  {
    key: 'gptbot',
    label: 'OpenAI GPTBot',
    url: 'https://openai.com/gptbot.json',
    owner: 'openai',
  },
  {
    key: 'oai-searchbot',
    label: 'OpenAI SearchBot',
    url: 'https://openai.com/searchbot.json',
    owner: 'openai',
  },
  {
    key: 'chatgpt-user',
    label: 'OpenAI ChatGPT-User',
    url: 'https://openai.com/chatgpt-user.json',
    owner: 'openai',
  },
];

// All four publishers use the same envelope - {"prefixes":[{"ipv4Prefix":...}]}
// - but OpenAI omits `creationTime` and Bing has used `ipv6Prefix` only
// sporadically. Reading defensively costs three lines and means a publisher
// tweaking their format degrades one source rather than throwing.
function extractPrefixes(json, owner) {
  const out = [];
  const list = (json && (json.prefixes || json.Prefixes)) || [];
  for (const p of list) {
    const v4 = p.ipv4Prefix || p.ipv4prefix || p.ipv4 || null;
    const v6 = p.ipv6Prefix || p.ipv6prefix || p.ipv6 || null;
    if (v4) out.push({ cidr: String(v4), owner });
    if (v6) out.push({ cidr: String(v6), owner });
  }
  return out;
}

async function fetchSource(src, { timeout = 15000 } = {}) {
  try {
    const res = await fetchUrl(src.url, { timeout });
    if (res.status !== 200) return { key: src.key, ok: false, error: `HTTP ${res.status}`, ranges: [] };
    const json = JSON.parse(decodeBody(res));
    const ranges = extractPrefixes(json, src.owner);
    if (!ranges.length) return { key: src.key, ok: false, error: 'no prefixes in the response', ranges: [] };
    return { key: src.key, ok: true, ranges, count: ranges.length };
  } catch (err) {
    return { key: src.key, ok: false, error: String(err && err.message || err).slice(0, 200), ranges: [] };
  }
}

// Fetches every source and writes the cache. Partial success is success: the
// cache records which sources answered, so the UI can say "verified against
// Google and Bing; OpenAI's list could not be reached" instead of implying the
// verification was complete.
async function refresh() {
  const results = [];
  const ranges = [];
  for (const src of SOURCES) {
    /* eslint-disable no-await-in-loop */
    const r = await fetchSource(src);
    results.push({
      key: src.key, label: src.label, ok: r.ok, count: r.ranges.length, error: r.error || null,
    });
    ranges.push(...r.ranges);
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    sources: results,
    ranges,
  };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (err) {
    // A read-only data directory should not lose the ranges that were just
    // fetched - they are still returned and usable for this request.
    console.error('[botRanges] could not write the cache:', err.message);
  }
  return payload;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.ranges)) return null;
    return raw;
  } catch {
    return null;
  }
}

// Age is surfaced rather than enforced. A range list a month old is still
// overwhelmingly correct - publishers add ranges, they rarely reuse them for
// something else - so a stale cache is reported, not rejected.
function status() {
  const cached = load();
  if (!cached) {
    return {
      available: false,
      ranges: 0,
      fetchedAt: null,
      ageDays: null,
      sources: [],
      note: 'No cached crawler IP ranges. Log imports will count bot hits from the user agent only, '
        + 'and will label them unverified.',
    };
  }
  const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
  const ageDays = Math.floor(ageMs / 86400000);
  return {
    available: true,
    ranges: cached.ranges.length,
    fetchedAt: cached.fetchedAt,
    ageDays,
    sources: cached.sources || [],
    stale: ageDays > 30,
    note: ageDays > 30
      ? `The cached ranges are ${ageDays} days old. Refresh them so newly added crawler ranges are not counted as fake.`
      : null,
  };
}

function ranges() {
  const cached = load();
  return cached ? cached.ranges : null;
}

module.exports = { SOURCES, refresh, load, status, ranges, extractPrefixes, CACHE_FILE };
