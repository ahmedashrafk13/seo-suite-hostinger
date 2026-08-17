// URL canonicalisation and classification for the linking agent.
//
// Ported from normalize_url(), same_site(), url_slug_words(), url_depth(),
// classify_url_kind() and unify_origin() in internal_link_agent.py. These
// decide which URLs are the same page, which are crawlable, and which are
// editorial content — get any of them slightly wrong and the link graph comes
// out empty or doubled, so the Python's exact rules are preserved.
const { URL } = require('url');
const { SKIP_EXTENSIONS, isTrackingParam, WORD_RE } = require('./config');

// Canonical form of a URL, or null if it is not a crawlable page URL.
function normalizeUrl(url, base = null) {
  if (!url) return null;
  let u = String(url).trim();
  if (!u) return null;
  if (/^(#|mailto:|tel:|javascript:|data:|sms:|fax:|callto:)/i.test(u)) return null;

  // Repair a malformed absolute href with a single slash ("https:/host/path").
  // Left alone, URL resolution treats it as relative and produces a nonsense
  // URL like /section/https:/host/path, which then gets crawled as a real page.
  u = u.replace(/^(https?):\/(?!\/)/i, '$1://');

  let p;
  try {
    p = base ? new URL(u, base) : new URL(u);
  } catch {
    return null;
  }
  const scheme = p.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  if (!p.host) return null;

  let host = p.host.toLowerCase();
  if (host.endsWith(':80')) host = host.slice(0, -3);
  else if (host.endsWith(':443')) host = host.slice(0, -4);

  let pathname = (p.pathname || '/').replace(/\/{2,}/g, '/') || '/';
  // A scheme embedded inside the path means the source href was broken and the
  // resulting URL is not a real page. Do not invent a page for it.
  if (/https?:\//i.test(pathname)) return null;

  const low = pathname.toLowerCase();
  for (const name of ['/index.html', '/index.htm', '/index.php', '/default.html', '/default.aspx']) {
    if (low.endsWith(name)) {
      pathname = `${pathname.slice(0, -name.length)}/`;
      break;
    }
  }
  const lastSeg = low.split('/').pop() || '';
  const ext = lastSeg.includes('.') ? `.${lastSeg.split('.').pop()}` : '';
  if (SKIP_EXTENSIONS.has(ext)) return null;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }

  // Tracking parameters are dropped and the rest sorted, so ?a=1&b=2 and
  // ?b=2&a=1 are one page. parse_qsl(keep_blank_values=True) keeps "?x=".
  const kept = [];
  for (const [k, v] of p.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])));
  const query = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  return `${scheme}://${host}${pathname}${query ? `?${query}` : ''}`;
}

function registrableHost(host) {
  const h = String(host || '').toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

function sameSite(url, rootHost) {
  let h;
  try {
    h = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return registrableHost(h) === registrableHost(rootHost);
}

// Rewrite an internal URL onto the site's canonical origin.
//
// Sites routinely mix http/https and www/non-www in their markup, or redirect
// between them. Without this, links point at one spelling while crawled pages
// are keyed under another and the entire link graph silently comes out empty.
function unifyOrigin(url, origin, host) {
  if (!url) return null;
  if (!sameSite(url, host)) return url;
  let p;
  let o;
  try {
    p = new URL(url);
    o = new URL(origin);
  } catch {
    return url;
  }
  return `${o.protocol}//${o.host}${p.pathname}${p.search || ''}`;
}

function urlSlugWords(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  return pathname.split(/[/\-_.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && w.length > 2)
    .map((w) => w.toLowerCase());
}

function urlDepth(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// --- URL kind classification ----------------------------------------------
//
// Paginated archives, tag/category/author listings, search-result pages and
// feeds are real HTTP-200 HTML pages, but they are not editorial content.
// Treated as content they poison three results at once: they are reported as
// orphans the client cannot fix, they score as near-identical rivals of the
// articles they list, and recommending a contextual link to page 7 of an
// archive is never the right advice.
//
// They are still crawled (they are how articles are discovered) and links found
// on them still count, but they are excluded from target candidacy, orphan
// counts and cannibalization, and reported in their own section.
const PAGINATION_SIMPLE = /\/(?:page|pagina|seite)\/\d+$/i;
const PAGINATION_PARAMS = new Set(['page', 'paged', 'pg', 'p', 'offset', 'start', 'from']);
const ARCHIVE_SEGMENTS = /^\/(?:tag|tags|category|categories|cat|topic|topics|author|authors|archive|archives|label|labels|keyword|taxonomy)(?:\/|$)/i;
const DATE_ARCHIVE = /^\/(?:19|20)\d{2}(?:\/\d{1,2}){0,2}\/?$/;
const SEARCH_PARAMS = new Set(['s', 'q', 'query', 'search', 'keyword', 'keywords']);
const FEED_PATH = /\/(?:feed|rss|atom|comments\/feed)\/?$/i;

// Deliberately conservative: anything not clearly one of the non-content kinds
// stays "content", because wrongly excluding a real page is worse than
// including an archive.
function classifyUrlKind(url) {
  let p;
  try {
    p = new URL(url);
  } catch {
    return 'content';
  }
  const pathname = p.pathname || '/';
  const q = [];
  for (const [k, v] of p.searchParams.entries()) q.push([k, v]);

  if (FEED_PATH.test(pathname)) return 'feed';
  if (q.some(([k]) => SEARCH_PARAMS.has(k.toLowerCase()))) return 'search';
  if (PAGINATION_SIMPLE.test(pathname.replace(/\/+$/, ''))) return 'pagination';
  for (const [k, v] of q) {
    const key = k.toLowerCase();
    if (PAGINATION_PARAMS.has(key) && /^\d+$/.test(String(v).trim())) {
      // ?p=123 is WordPress's post-ID permalink, not pagination. Only treat a
      // numeric ?p= as pagination when it is small enough to be a page number.
      if (key === 'p' && Number(v) > 50) continue;
      return 'pagination';
    }
  }
  if (ARCHIVE_SEGMENTS.test(pathname)) return 'archive';
  if (DATE_ARCHIVE.test(pathname)) return 'archive';
  return 'content';
}

// Word tokens, lower-cased, longer than two characters — the Python's
// tokenize(). WORD_RE carries the /g flag, so a fresh matchAll is used rather
// than .test/.exec, whose lastIndex would leak between calls.
function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(WORD_RE)) {
    if (m[0].length > 2) out.push(m[0].toLowerCase());
  }
  return out;
}

// Every word token, no length filter — used for word counts, where the Python
// uses WORD_RE.findall() directly.
function words(text) {
  return String(text || '').match(WORD_RE) || [];
}

module.exports = {
  normalizeUrl, registrableHost, sameSite, unifyOrigin,
  urlSlugWords, urlDepth, classifyUrlKind, tokenize, words,
};
