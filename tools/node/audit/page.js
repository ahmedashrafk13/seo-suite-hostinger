// Page model and HTML parsing — a direct port of the Page class and
// _parse_html() in tools/webtechstackdetector/main.py.
//
// BeautifulSoup is replaced by cheerio, which is pure JavaScript and parses
// with the same lenient, browser-like tolerance for broken markup. The
// selectors and the order of operations are kept deliberately close to the
// Python so the two implementations produce the same numbers on the same site;
// where a behaviour is subtle (what counts as a missing alt, what makes a link
// "unnamed") the original's reasoning is preserved in the comments below,
// because those rules were tuned against real Semrush output.
const cheerio = require('cheerio');
const { fetchUrl, decodeBody, sleep } = require('../lib/http');
const { sameSite, joinUrl, truncate } = require('../lib/urls');

const NONDESC_ANCHORS = new Set([
  'click here', 'click', 'here', 'read more', 'more', 'learn more',
  'this', 'link', 'this link', 'more info', 'details', 'continue',
  'continue reading', 'go', 'download',
]);

const RESOURCE_EXT = require('../lib/urls').RESOURCE_EXT;

const ERROR_URL_RE = /\/(404|not[-_]?found|page[-_]?not[-_]?found|error)(\/|\.php|\.html?|$)/i;
const ERROR_TITLE_RE = /^\s*(404\b|page not found|not found|error 404)/i;

function makePage(requestedUrl) {
  return {
    requested_url: requestedUrl,
    url: requestedUrl,
    status: null,
    ok: false,
    is_html: false,
    elapsed: 0,
    content_type: '',
    error: null,
    redirect_chain: [],      // [[status, url], ...] hops before final
    meta_refresh: null,
    title: null,
    title_count: 0,
    meta_desc: null,
    meta_desc_count: 0,
    h1s: [],
    canonicals: [],
    robots_meta: '',
    x_robots: '',
    hsts: null,
    images_total: 0,
    images_missing_alt: 0,
    missing_alt_samples: [],
    internal_links: new Set(),
    external_links: new Set(),
    nofollow_internal: new Set(),
    link_count: 0,
    empty_anchor: 0,
    empty_anchor_urls: [],
    nondesc_anchor: 0,
    resource_link_count: 0,
    http_from_https: 0,
    assets: new Set(),
    text_len: 0,
    html_len: 0,
    word_count: 0,
    content_sig: null,
    script_count: 0,
    iframe_count: 0,
    spa_marker: false,
    iframe_cross: [],
    rendered: false,
    mixed_content: 0,
    has_viewport: false,
    has_charset: false,
    has_doctype: false,
  };
}

// A cheap near-duplicate fingerprint: the set of overlapping 5-word shingles of
// the normalised visible text. Two pages are near-duplicates when their shingle
// sets overlap heavily (Jaccard similarity).
//
// \p{L}+ is the JavaScript equivalent of Python's [^\W\d_]+ with re.UNICODE —
// letters only, no digits, no underscores — so the same tokens are produced for
// non-English text.
const WORD_RE = /\p{L}+/gu;

function contentSignature(text) {
  const words = String(text || '').toLowerCase().match(WORD_RE) || [];
  if (words.length < 8) return new Set();
  const shingles = new Set();
  for (let i = 0; i + 5 <= words.length; i += 1) {
    shingles.add(words.slice(i, i + 5).join(' '));
  }
  return shingles;
}

// The equivalent of BeautifulSoup's get_text(" ", strip=True), which the
// Python tool uses for every text measurement.
//
// This is not the same as cheerio's .text(). BeautifulSoup visits each text
// node, strips it, and joins the results with the separator; cheerio
// concatenates the raw node contents with nothing between them. On real markup
// that difference is large and one-directional — adjacent block elements like
// `<td>Total</td><td>19</td>` become "Total19" instead of "Total 19" — which
// deflated text_len by ~30% on the first site tested and moved 11 pages across
// the low-text-to-HTML-ratio threshold. Word counts shift too, since merged
// tokens count once.
// `sep` mirrors BeautifulSoup's first argument: the body text is extracted with
// get_text(" ", …) but titles and headings use get_text(strip=True), which
// joins with nothing — so `<h1>Web<span>Builders</span></h1>` is "WebBuilders",
// not "Web Builders". Titles are compared for duplicates and measured against a
// character limit, so the wrong separator changes results.
function getText($, node, sep = ' ') {
  const parts = [];
  const walk = (el) => {
    if (el.type === 'text') {
      const t = String(el.data || '').trim();
      if (t) parts.push(t);
      return;
    }
    // BeautifulSoup 4.9+ classifies the contents of <script>, <style> and
    // <template> as Script/Stylesheet/TemplateString, which get_text() excludes
    // by default. Including them here counted minified JavaScript as page text:
    // on the first site tested that inflated text_len by 7,579 characters
    // (28%), which feeds directly into the text-to-HTML ratio check and the
    // near-duplicate content signature.
    const tag = (el.name || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return;
    const children = el.children || [];
    for (const child of children) walk(child);
  };
  node.toArray().forEach(walk);
  return parts.join(sep);
}

function parseHtml(page, text) {
  page.html_len = text.length;
  page.has_doctype = text.replace(/^\s+/, '').slice(0, 15).toLowerCase().startsWith('<!doctype');

  // scriptingEnabled: false makes parse5 parse <noscript> CONTENT AS MARKUP
  // rather than as one opaque text node, which is what BeautifulSoup's
  // html.parser does and what every check here assumes.
  //
  // With the default (true) the contents of <noscript> are invisible to
  // selectors: a LiveChat widget's <noscript><a href="…"> fallback links
  // disappeared from the external-link set, and — worse — the `img` filter
  // below that excludes noscript lazy-load duplicates could never match
  // anything, so it silently did nothing. Both bugs are the kind that produce a
  // plausible-looking report with quietly wrong numbers.
  const $ = cheerio.load(text, { scriptingEnabled: false });

  const body = $('body');
  const visible = body.length ? getText($, body) : '';
  page.text_len = visible.length;
  page.word_count = visible ? visible.split(/\s+/).filter(Boolean).length : 0;
  page.content_sig = contentSignature(visible);
  page.script_count = $('script').length;

  const iframes = $('iframe');
  page.iframe_count = iframes.length;
  iframes.each((_, el) => {
    const src = ($(el).attr('src') || '').trim();
    if (!src) return;
    const abs = joinUrl(page.url, src);
    if (/^https?:\/\//i.test(abs) && !sameSite(page.url, abs)) page.iframe_cross.push(abs);
  });
  page.spa_marker = /id=["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|data-reactroot|window\.__NUXT__|data-server-rendered|ng-version/i.test(text);

  const titles = $('title');
  page.title_count = titles.length;
  if (titles.length) page.title = getText($, titles.first(), '');

  const descs = $('meta').filter((_, el) => ($(el).attr('name') || '').trim().toLowerCase() === 'description');
  page.meta_desc_count = descs.length;
  if (descs.length) page.meta_desc = (descs.first().attr('content') || '').trim();

  page.h1s = $('h1').map((_, el) => getText($, $(el), '')).get();

  $('link').each((_, el) => {
    const relRaw = $(el).attr('rel') || '';
    const rel = relRaw.split(/\s+/).map((r) => r.toLowerCase()).filter(Boolean);
    const href = ($(el).attr('href') || '').trim();
    if (rel.includes('canonical') && href) page.canonicals.push(href);
    if (rel.includes('stylesheet') && href) page.assets.add(joinUrl(page.url, href).split('#')[0]);
  });

  $('script[src]').each((_, el) => {
    const src = ($(el).attr('src') || '').trim();
    if (src) page.assets.add(joinUrl(page.url, src).split('#')[0]);
  });

  const robotsVals = [];
  $('meta').each((_, el) => {
    const $el = $(el);
    const name = ($el.attr('name') || '').trim().toLowerCase();
    if (name === 'robots' || name === 'googlebot') robotsVals.push(($el.attr('content') || '').toLowerCase());
    if (name === 'viewport') page.has_viewport = true;
    if ($el.attr('charset') != null || ($el.attr('http-equiv') || '').toLowerCase() === 'content-type') {
      page.has_charset = true;
    }
  });
  page.robots_meta = robotsVals.filter(Boolean).join(', ');

  const refresh = $('meta').filter((_, el) => /^refresh$/i.test($(el).attr('http-equiv') || '')).first();
  if (refresh.length && refresh.attr('content')) {
    const m = /url\s*=\s*(.+)$/i.exec(refresh.attr('content'));
    if (m) page.meta_refresh = joinUrl(page.url, m[1].trim().replace(/^['"]|['"]$/g, ''));
  }

  // Images — exclude <noscript> lazy-load duplicates. A missing alt means the
  // attribute is ENTIRELY absent (alt="" is a valid decorative marker).
  const imgs = $('img').filter((_, el) => $(el).parents('noscript').length === 0);
  page.images_total = imgs.length;
  imgs.each((_, el) => {
    const $img = $(el);
    if ($img.attr('alt') != null) return;
    const src = ($img.attr('src') || $img.attr('data-src') || '').trim();
    if (src.startsWith('data:')) return;
    const w = $img.attr('width');
    const h = $img.attr('height');
    if (w === '0' || w === '1' || h === '0' || h === '1') return;
    page.images_missing_alt += 1;
    if (page.missing_alt_samples.length < 5) {
      page.missing_alt_samples.push(joinUrl(page.url, src || '(inline image)'));
    }
  });

  const pageIsHttps = page.url.toLowerCase().startsWith('https://');

  // Mixed content — an https page that loads a resource over plain http.
  if (pageIsHttps) {
    [['img', 'src'], ['script', 'src'], ['link', 'href'], ['iframe', 'src'],
      ['source', 'src'], ['video', 'src'], ['audio', 'src'], ['embed', 'src']]
      .forEach(([tag, attr]) => {
        $(tag).each((_, el) => {
          if (($(el).attr(attr) || '').trim().toLowerCase().startsWith('http://')) page.mixed_content += 1;
        });
      });
  }

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();
    const hl = href.toLowerCase();
    // Skip non-navigational links and MALFORMED contact links. A raw space in
    // an href, or a "tel"/"mailto"/"sms" prefix followed by any non-letter
    // (e.g. `href="tel+1 (332) …"` — missing the colon), means it is a
    // phone/e-mail link, NOT a page. The [:+.\s] class after the scheme keeps
    // real pages like /telephone-services (which continue with a letter)
    // crawlable.
    if (!href || href.includes(' ')
        || /^(#|javascript:|data:|vbscript:)/.test(hl)
        || /^(?:mailto|tel|sms|fax|callto|whatsapp|skype|viber)[:+.\s]/.test(hl)) {
      return;
    }
    let full = joinUrl(page.url, href);
    let parsed;
    try {
      parsed = new URL(full);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    parsed.hash = '';
    full = parsed.href;
    page.link_count += 1;

    const relRaw = $a.attr('rel') || '';
    const rel = relRaw.split(/\s+/).map((r) => r.toLowerCase()).filter(Boolean);

    // Anchor-text quality. A link "has no anchor text" when it has NO visible
    // text, NO accessible name, and NO visual child carrying its own text
    // alternative.
    //
    // An image/icon link counts as NAMED only if the visual actually supplies a
    // text alternative — <img alt="…"> or <svg><title>…</title>. Excusing EVERY
    // link with a visual child is wrong: an <img> with a missing or empty alt,
    // or a bare <svg>/<i> icon, gives Google nothing to read, which is exactly
    // the case this check exists to catch.
    const atext = getText($, $a, ' ');
    let aria = ($a.attr('aria-label') || $a.attr('title') || '').trim();
    if (!atext && !aria) {
      const descendants = $a.find('*').toArray();
      for (const d of descendants) {
        const $d = $(d);
        if (($d.attr('aria-label') || $d.attr('title') || '').trim()) { aria = 'x'; break; }
        const cls = $d.attr('class') || '';
        if (/sr-only|visually-hidden|screen-reader/i.test(cls)) { aria = 'x'; break; }
      }
    }
    let namedVisual = false;
    if (!atext && !aria) {
      const visuals = $a.find('img, svg').toArray();
      for (const v of visuals) {
        const $v = $(v);
        if (v.tagName && v.tagName.toLowerCase() === 'img') {
          if (($v.attr('alt') || '').trim()) { namedVisual = true; break; }
        } else {
          const st = $v.find('title').first();
          if (st.length && getText($, st, '')) { namedVisual = true; break; }
        }
      }
    }
    if (!atext && !aria && !namedVisual) {
      page.empty_anchor += 1;
      page.empty_anchor_urls.push(full);
    } else if (atext && NONDESC_ANCHORS.has(atext.toLowerCase())) {
      page.nondesc_anchor += 1;
    }

    if (RESOURCE_EXT.test(full)) page.resource_link_count += 1;
    if (pageIsHttps && parsed.protocol === 'http:') page.http_from_https += 1;

    if (sameSite(page.url, full)) {
      page.internal_links.add(full);
      if (rel.includes('nofollow')) page.nofollow_internal.add(full);
    } else {
      page.external_links.add(full);
    }
  });
}

// Fetches one page. Transient failures (timeout / connection reset — often just
// rate-limiting) get one retry so a throttled response does not silently drop
// the page from the crawl and make issue counts wobble between runs.
async function fetchPage(url) {
  const page = makePage(url);
  const t0 = Date.now();
  let lastTransient = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchUrl(url, { timeout: 20000 });
      page.elapsed = Number(((Date.now() - t0) / 1000).toFixed(3));
      page.status = res.status;
      page.url = res.url;
      page.ok = res.status === 200;
      page.content_type = res.headers['content-type'] || '';
      page.x_robots = res.headers['x-robots-tag'] || '';
      page.hsts = res.headers['strict-transport-security'] || null;
      page.redirect_chain = res.history.map((h) => [h.status, h.url]);
      page.is_html = page.content_type.toLowerCase().includes('html')
        || (!page.content_type && page.ok);
      if (page.is_html && res.body.length) {
        parseHtml(page, decodeBody(res));
      }
      return page;
    } catch (err) {
      if (err.kind === 'timeout' || err.kind === 'connection') {
        lastTransient = err;
        await sleep(600); // brief back-off, then retry once
        continue;
      }
      page.elapsed = Number(((Date.now() - t0) / 1000).toFixed(3));
      if (err.kind === 'redirect_loop') page.error = 'Redirect loop (too many redirects)';
      else if (err.kind === 'ssl') page.error = 'SSL error';
      else page.error = `${err.name}: ${String(err.message).slice(0, 80)}`;
      return page;
    }
  }

  page.elapsed = Number(((Date.now() - t0) / 1000).toFixed(3));
  page.error = lastTransient && lastTransient.kind === 'timeout'
    ? 'Timeout (>20s)'
    : 'Connection error / DNS failure';
  return page;
}

function isErrorPage(page) {
  let path = '';
  try { path = new URL(page.url).pathname; } catch { path = ''; }
  if (ERROR_URL_RE.test(path)) return true;
  return Boolean(page.title && ERROR_TITLE_RE.test(page.title));
}

function isThin(page) {
  return Boolean(page.is_html && page.ok && !page.error
    && page.text_len < 200
    && page.internal_links.size === 0
    && page.external_links.size === 0
    && page.images_total === 0
    && page.h1s.length === 0);
}

function thinCause(page) {
  if (page.iframe_cross.length) {
    return 'all content sits in a cross-origin iframe '
      + `(${truncate(page.iframe_cross[0], 55)}) — search engines will not `
      + 'index it as part of this domain';
  }
  if (page.iframe_count) return 'content is embedded in an iframe — poorly indexable';
  if (page.spa_marker || page.script_count >= 3) {
    return 'content is rendered client-side by JavaScript and is absent from '
      + 'the served HTML — run with --render to audit the rendered page';
  }
  return 'the page returned almost no HTML content';
}

module.exports = {
  makePage, parseHtml, fetchPage, isErrorPage, isThin, thinCause,
  contentSignature, NONDESC_ANCHORS,
};
