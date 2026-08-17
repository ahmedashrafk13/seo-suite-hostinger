// Page parsing and content-block extraction.
//
// Ported from parse_page(), _extract_blocks(), _text_and_link_spans(),
// _pick_main() and _is_boilerplate_ancestor() in internal_link_agent.py.
//
// The critical property preserved here is that a block's text and its link
// spans are produced in the SAME DOM walk. Searching the finished text for each
// anchor's string cannot be made correct: in "Our pricing is simple. See
// <a>pricing</a> for details." a search finds the plain-prose "pricing" first,
// records the span in the wrong place, and the tool then happily recommends
// inserting a link inside an existing link. Building both from one list of
// pieces makes the offsets exact by construction — which is what lets the
// report promise a character offset an editor can verify by hand.
const cheerio = require('cheerio');
const {
  looksBoilerplate, MAIN_SELECTORS, TEXT_BLOCK_TAGS, SENTENCE_SPLIT,
} = require('./config');
const {
  normalizeUrl, sameSite, unifyOrigin, classifyUrlKind, words,
} = require('./urls');

// scriptingEnabled: false makes parse5 treat <noscript> content as markup,
// which is what BeautifulSoup does. See the audit port's page.js for the bugs
// the default setting causes.
function load(html) {
  return cheerio.load(html, { scriptingEnabled: false });
}

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// BeautifulSoup's get_text(sep, strip=True): each text node stripped, joined by
// the separator, with <script>/<style>/<template> contents excluded.
function getText($, node, sep = ' ') {
  const parts = [];
  const walk = (el) => {
    if (el.type === 'text') {
      const t = String(el.data || '').trim();
      if (t) parts.push(t);
      return;
    }
    const tag = (el.name || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return;
    for (const child of el.children || []) walk(child);
  };
  (node.toArray ? node.toArray() : [node]).forEach(walk);
  return parts.join(sep);
}

function makeBlock(text, tag, linkSpans = []) {
  return {
    text,
    tag,
    link_spans: linkSpans,   // [start, end, targetUrl] — "" for external/unparseable
    // True when this exact text also appears on another crawled page. Such a
    // block is shared copy, so editing it is a template change rather than an
    // editorial link — it must not host a recommended anchor.
    shared: false,
  };
}

function makePage(url, requestedUrl, status, depth) {
  return {
    url,
    requested_url: requestedUrl,
    status,
    depth,
    title: '',
    h1: '',
    // True when this page's <h1> is the site name repeated site-wide. The H1 is
    // kept intact for reporting; this flag tells the topic logic to ignore it.
    h1_is_branding: false,
    meta_description: '',
    canonical: null,
    noindex: false,
    lang: '',
    word_count: 0,
    text: '',
    extraction_mode: 'normal',   // normal | structural-only | raw-text | rendered
    blocks: [],
    out_links: [],               // {url, anchor, editorial}
    aliases: [],
    malformed_hrefs: new Set(),
    kind: classifyUrlKind(url),
    // Every anchor string used as a link on this page -> the set of
    // destinations it points at ("" for external/unresolvable).
    //
    // This must be a mapping, not a set of strings. The rule being enforced is
    // "one page must not carry two identical anchors pointing at DIFFERENT
    // URLs". Keyed on the string alone, a nav item reading "Our Services"
    // linking to /services made "our services" unusable as an in-content anchor
    // for /services — the most natural anchor on the page, rejected for
    // pointing where it already points.
    anchor_dests: new Map(),
    // Every internal target linked from this page, captured before canonical
    // remapping drops links to URLs that were never successfully crawled.
    // Without this a broken link cannot be attributed to the page containing it.
    raw_out_urls: new Set(),
    inbound_editorial: 0,
    inbound_boilerplate: 0,
    outbound_editorial: 0,
    pagerank: 0,
    primary_keyword: '',
    top_terms: [],
    discriminating: new Set(),
    unique_tokens: new Set(),
    key_slug_tokens: new Set(),
    zero_vector: false,
    link_count_total: 0,
  };
}

// The H1 only when it describes this page rather than the whole site.
function topicH1(page) {
  return page.h1_is_branding ? '' : page.h1;
}

// True when this page already uses `anchor` as link text for somewhere OTHER
// than `target`. Linking the same words to the same place is not a conflict.
function anchorConflicts(page, anchor, target) {
  const dests = page.anchor_dests.get(String(anchor).trim().toLowerCase());
  if (!dests || !dests.size) return false;
  for (const d of dests) if (d !== target) return true;
  return false;
}

function isBoilerplateAncestor($, el) {
  let cur = el;
  let hops = 0;
  while (cur && hops < 25) {
    const name = (cur.name || '').toLowerCase();
    if (['nav', 'header', 'footer', 'aside'].includes(name)) return true;
    const attribs = cur.attribs || {};
    const role = String(attribs.role || '').toLowerCase();
    if (['navigation', 'contentinfo', 'banner', 'complementary', 'menu', 'menubar', 'search'].includes(role)) {
      return true;
    }
    if (looksBoilerplate(`${attribs.class || ''} ${attribs.id || ''}`)) return true;
    cur = cur.parent;
    hops += 1;
  }
  return false;
}

function pickMain($) {
  let best = null;
  let bestLen = 0;
  for (const sel of MAIN_SELECTORS) {
    let matched;
    try {
      matched = $(sel).toArray();
    } catch {
      continue;
    }
    for (const el of matched) {
      if (el.parent && isBoilerplateAncestor($, el.parent)) continue;
      const length = getText($, $(el)).length;
      if (length > bestLen) { best = el; bestLen = length; }
    }
  }
  const body = $('body').length ? $('body') : $.root();
  const bodyLen = getText($, body).length;
  // Only trust a semantic container if it holds a real share of the copy.
  if (best !== null && bestLen >= Math.max(200, bodyLen * 0.25)) return $(best);
  return body;
}

function splitSentences(text) {
  return String(text || '').split(SENTENCE_SPLIT).map((p) => p.trim()).filter(Boolean);
}

// Build a block's text and its link spans together, in one DOM walk.
function textAndLinkSpans($, el, pageUrl, origin, host) {
  const pieces = [];
  const rawSpans = [];

  const walk = (node, anchorAcc) => {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const txt = collapse(child.data);
        if (txt) {
          pieces.push(txt);
          if (anchorAcc) anchorAcc.idx.push(pieces.length - 1);
        }
      } else if (child.name) {
        if (child.name.toLowerCase() === 'a' && !anchorAcc) {
          const acc = { idx: [], href: (child.attribs || {}).href };
          walk(child, acc);
          if (acc.idx.length) rawSpans.push([acc.idx[0], acc.idx[acc.idx.length - 1], acc.href]);
        } else {
          walk(child, anchorAcc);
        }
      }
    }
  };

  const root = el.get ? el.get(0) : el;
  if (root) walk(root, null);
  const text = pieces.join(' ');

  const starts = [];
  let accLen = 0;
  for (const p of pieces) {
    starts.push(accLen);
    accLen += p.length + 1;
  }

  const spans = [];
  for (const [first, last, href] of rawSpans) {
    let dest = '';
    if (href && host) {
      let cand = normalizeUrl(href, pageUrl || origin);
      if (cand && sameSite(cand, host)) {
        cand = unifyOrigin(cand, origin, host);
        if (cand && cand !== pageUrl) dest = cand;
      }
    }
    spans.push([starts[first], starts[last] + pieces[last].length, dest]);
  }
  return { text, spans };
}

// Pull paragraph-level content blocks out of the page.
//
// aggressive=true also drops elements whose class/id look like template chrome.
// aggressive=false strips only unambiguous structural chrome, the safe fallback
// when the class-name heuristics have clearly misfired.
//
// A fresh parse happens here on purpose: this function destructively removes
// chrome, so it must not touch the caller's tree.
function extractBlocks(html, aggressive, pageUrl = '', origin = '', host = '') {
  const $ = load(html);

  $('script, style, noscript, template, svg, iframe, form, button, select, option, input, label, textarea').remove();
  $('nav, header, footer, aside').remove();
  $('*').each((_, el) => {
    const attribs = el.attribs || {};
    const role = String(attribs.role || '').toLowerCase();
    if (['navigation', 'contentinfo', 'banner', 'complementary', 'menu', 'menubar', 'search'].includes(role)) {
      $(el).remove();
    } else if (aggressive && looksBoilerplate(`${attribs.class || ''} ${attribs.id || ''}`)) {
      $(el).remove();
    }
  });

  const main = pickMain($);
  const blocks = [];
  const seenText = new Set();
  if (!main || !main.length) return blocks;

  const selector = TEXT_BLOCK_TAGS.join(', ');
  main.find(selector).each((_, el) => {
    const $el = $(el);
    // A wrapper around other blocks is not a leaf of copy.
    if ($el.find(selector).length) return;
    const { text: txt, spans } = textAndLinkSpans($, $el, pageUrl, origin, host);
    if (txt.length < 25) return;
    const norm = txt.toLowerCase();
    if (seenText.has(norm)) return;
    seenText.add(norm);
    blocks.push(makeBlock(txt, (el.name || 'p').toLowerCase(), spans));
  });
  return blocks;
}

function parsePage(html, url, requested, status, depth, host, origin) {
  const $ = load(html);
  const page = makePage(url, requested, status, depth);

  const titleEl = $('title').first();
  if (titleEl.length) page.title = collapse(getText($, titleEl, ''));
  const h1 = $('h1').first();
  if (h1.length) page.h1 = collapse(getText($, h1, ' '));
  const md = $('meta').filter((_, el) => /^description$/i.test(($(el).attr('name') || ''))).first();
  if (md.length && md.attr('content')) page.meta_description = collapse(md.attr('content'));
  const can = $('link').filter((_, el) => /canonical/i.test($(el).attr('rel') || '')).first();
  if (can.length && can.attr('href')) {
    page.canonical = unifyOrigin(normalizeUrl(can.attr('href'), url), origin, host);
  }
  $('meta').each((_, el) => {
    const name = $(el).attr('name') || '';
    if (/^robots$|^googlebot$/i.test(name) && String($(el).attr('content') || '').toLowerCase().includes('noindex')) {
      page.noindex = true;
    }
  });
  const htmlTag = $('html').first();
  if (htmlTag.length && htmlTag.attr('lang')) page.lang = String(htmlTag.attr('lang')).trim().slice(0, 12);

  // --- links: classify BEFORE stripping boilerplate ------------------------
  const seenPairs = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const rawHref = $a.attr('href');
    const atext = collapse(getText($, $a, ' '));
    // Flag the malformed single-slash form on sight. normalizeUrl repairs it so
    // the intended link is still followed, but the href itself is broken in the
    // page source and that is worth reporting.
    if (/^\s*https?:\/(?!\/)/i.test(rawHref)) page.malformed_hrefs.add(String(rawHref).trim());

    let target = normalizeUrl(rawHref, url);
    if (target && sameSite(target, host)) target = unifyOrigin(target, origin, host);

    // Record the anchor string together with where it points, including for
    // external and unresolvable links (destination ""), so the conflict test can
    // tell "same words, same place" from a genuine clash.
    if (atext) {
      const key = atext.toLowerCase();
      if (!page.anchor_dests.has(key)) page.anchor_dests.set(key, new Set());
      page.anchor_dests.get(key).add(target && sameSite(target, host) ? target : '');
    }
    if (!target || !sameSite(target, host)) return;
    if (target === url) return;

    const rel = String($a.attr('rel') || '').toLowerCase();
    const editorialOk = !rel.split(/\s+/).includes('nofollow');
    const anchor = atext;
    const editorial = editorialOk && !isBoilerplateAncestor($, el);
    page.raw_out_urls.add(target);
    const pairKey = `${target} ${anchor.toLowerCase()}`;
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    page.out_links.push({ url: target, anchor, editorial });
  });

  // How much visible text the page really has, measured before any stripping.
  // This is the yardstick for detecting an over-aggressive strip below.
  const rawBody = $('body').length ? $('body') : $.root();
  const rawLen = collapse(getText($, rawBody, ' ')).length;
  page.link_count_total = $('a[href]').length;

  let blocks = extractBlocks(html, true, url, origin, host);
  let bodyText = blocks.map((b) => b.text).join(' ');

  // Safety net: if class-based stripping removed nearly everything even though
  // the page clearly has copy, the heuristics misfired on this site's naming
  // scheme. Retry keeping only structural chrome (nav/header/footer/aside and
  // ARIA roles), which is unambiguous. Cross-page duplicate-block detection
  // still removes template text later, so nothing is lost by being cautious.
  if (rawLen > 400 && bodyText.length < rawLen * 0.15) {
    const retry = extractBlocks(html, false, url, origin, host);
    const retryText = retry.map((b) => b.text).join(' ');
    if (retryText.length > bodyText.length) {
      blocks = retry;
      bodyText = retryText;
      page.extraction_mode = 'structural-only';
    }
  }

  if (bodyText.length < 200) {
    // Sites that avoid <p> entirely (heavy div soup) — fall back to raw text.
    const fallback = collapse(getText($, rawBody, ' '));
    if (fallback.length > bodyText.length) {
      // Rebuild blocks from the fallback so text and blocks always describe the
      // same content. Taking raw text for `text` while blocks kept only the
      // extracted copy meant word_count measured one thing and the anchor
      // search another.
      blocks = splitSentences(fallback).filter((s) => s.length >= 40).map((s) => makeBlock(s, 'div'));
      if (!blocks.length) blocks = [makeBlock(fallback, 'div')];
      bodyText = blocks.map((b) => b.text).join(' ');
      page.extraction_mode = 'raw-text';
    }
  }

  page.blocks = blocks;
  page.text = bodyText;
  page.word_count = words(bodyText).length;

  // Set the initial editorial flag from the same source of truth used later by
  // recomputeEditorial(), so the value is never derived two different ways.
  const inContent = new Set();
  blocks.forEach((b) => b.link_spans.forEach((sp) => { if (sp[2]) inContent.add(sp[2]); }));
  page.out_links.forEach((link) => { link.editorial = inContent.has(link.url); });

  return page;
}

module.exports = {
  load, getText, collapse, makePage, makeBlock, topicH1, anchorConflicts,
  isBoilerplateAncestor, pickMain, splitSentences, textAndLinkSpans,
  extractBlocks, parsePage,
};
