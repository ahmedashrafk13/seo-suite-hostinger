// In-process page fetching and parsing for the AI SEO features.
//
// WHY NOT REUSE toolRunner
// The audit and internal-linking crawlers run as CHILD PROCESSES that write
// CSV to disk, because they crawl hundreds of pages and must not hold the web
// worker for minutes. The features in this directory are different: they read
// one page, or a handful, and need the result in the same request that asked
// for it. Spawning a process for that would cost more than the fetch.
//
// It matters that this stays in-process for a second reason. This deployment
// runs SQLite through the WebAssembly driver, which is single-writer: a second
// process opening data/app.db while the server is running has corrupted it
// before. Nothing in this module touches the database, and nothing here ever
// spawns a child that would.
//
// The HTTP layer is the crawlers' own (tools/node/lib/http.js) rather than
// global fetch, because these features need exactly the three things it exists
// to provide: the redirect chain (redirect-chain tracking), tolerance of a
// broken certificate (SSL checks must be able to see a bad certificate rather
// than fail on it), and a byte cap (a 200MB response must not end the process
// on a host with a small memory allowance).
const cheerio = require('cheerio');
const tls = require('tls');
const { URL } = require('url');
const {
  fetchUrl, requestOnce, decodeBody, mapLimit, sleep, UA,
} = require('../../../tools/node/lib/http');
const {
  normalizeUrl, hostKey, sameSite, canonUrl, joinUrl, isCrawlableHtml, truncate,
} = require('../../../tools/node/lib/urls');

// The user agents AI engines and search engines actually crawl with, as
// published by each operator. Used two ways: matched against robots.txt, and
// sent as a real request header to find out whether an edge rule (Cloudflare,
// a WAF, a "block AI bots" plugin) rejects them even when robots.txt allows.
//
// `purpose` distinguishes the two things people conflate. A TRAINING crawler
// blocked costs nothing in retrieval terms. A RETRIEVAL fetcher blocked means
// the brand cannot be cited in an answer, because the engine cannot read the
// page at the moment a user asks. Reporting them as one number is how sites
// end up "blocking AI" while believing they are visible in it.
const AI_AGENTS = [
  { key: 'gptbot', token: 'GPTBot', label: 'GPTBot (OpenAI)', purpose: 'training', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot' },
  { key: 'oai-searchbot', token: 'OAI-SearchBot', label: 'OAI-SearchBot (ChatGPT search index)', purpose: 'retrieval', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot' },
  { key: 'chatgpt-user', token: 'ChatGPT-User', label: 'ChatGPT-User (live browsing)', purpose: 'retrieval', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { key: 'claudebot', token: 'ClaudeBot', label: 'ClaudeBot (Anthropic)', purpose: 'training', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com' },
  { key: 'claude-user', token: 'Claude-User', label: 'Claude-User (live browsing)', purpose: 'retrieval', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com' },
  { key: 'perplexitybot', token: 'PerplexityBot', label: 'PerplexityBot (index)', purpose: 'retrieval', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot' },
  { key: 'perplexity-user', token: 'Perplexity-User', label: 'Perplexity-User (live fetch)', purpose: 'retrieval', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user' },
  { key: 'google-extended', token: 'Google-Extended', label: 'Google-Extended (Gemini training)', purpose: 'training', ua: null },
  { key: 'googlebot', token: 'Googlebot', label: 'Googlebot (also feeds AI Overviews)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { key: 'bingbot', token: 'bingbot', label: 'Bingbot (feeds Copilot)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { key: 'ccbot', token: 'CCBot', label: 'CCBot (Common Crawl)', purpose: 'training', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
  { key: 'applebot-extended', token: 'Applebot-Extended', label: 'Applebot-Extended (Apple Intelligence training)', purpose: 'training', ua: null },
  { key: 'meta-externalagent', token: 'meta-externalagent', label: 'Meta external agent', purpose: 'training', ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { key: 'amazonbot', token: 'Amazonbot', label: 'Amazonbot (Alexa)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)' },
  { key: 'bytespider', token: 'Bytespider', label: 'Bytespider (ByteDance)', purpose: 'training', ua: 'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)' },
  { key: 'applebot', token: 'Applebot', label: 'Applebot (Siri, Spotlight, Apple Intelligence answers)', purpose: 'retrieval', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)' },
  { key: 'meta-externalfetcher', token: 'Meta-ExternalFetcher', label: 'Meta-ExternalFetcher (Meta AI live fetch)', purpose: 'retrieval', ua: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { key: 'duckassistbot', token: 'DuckAssistBot', label: 'DuckAssistBot (DuckDuckGo AI answers)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; DuckAssistBot/1.0; +https://duckduckgo.com/duckassistbot)' },
  { key: 'mistralai-user', token: 'MistralAI-User', label: 'MistralAI-User (Le Chat live fetch)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://mistral.ai/mistralai-user)' },
  { key: 'youbot', token: 'YouBot', label: 'YouBot (You.com)', purpose: 'retrieval', ua: 'Mozilla/5.0 (compatible; YouBot (+http://www.you.com))' },
  { key: 'petalbot', token: 'PetalBot', label: 'PetalBot (Petal Search, Huawei)', purpose: 'retrieval', ua: 'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)' },
  { key: 'ai2bot', token: 'AI2Bot', label: 'AI2Bot (Allen Institute)', purpose: 'training', ua: 'Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)' },
  { key: 'cohere-ai', token: 'cohere-ai', label: 'cohere-ai (Cohere)', purpose: 'training', ua: 'Mozilla/5.0 (compatible; cohere-ai/1.0; +https://cohere.com)' },
  { key: 'diffbot', token: 'Diffbot', label: 'Diffbot (knowledge graph, resold to LLMs)', purpose: 'training', ua: 'Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)' },
];

const RETRIEVAL_AGENTS = AI_AGENTS.filter((a) => a.purpose === 'retrieval');

// ---------------------------------------------------------------- fetching

// One page, with the measurements the readiness and tracking checks need.
//
// TTFB is measured as time to the first response BYTE, which is what the
// metric actually means and what makes a <200ms target meaningful. Measuring
// to the last byte instead (the easy mistake) reports download time on a slow
// connection as a server problem.
async function fetchPage(url, {
  ua = UA, timeout = 20000, method = 'GET', headers: extraHeaders = null, body = null,
  maxBytes = null,
} = {}) {
  const started = Date.now();
  const out = {
    requestedUrl: url,
    url,
    status: null,
    ok: false,
    error: null,
    headers: {},
    body: '',
    contentType: '',
    bytes: 0,
    ttfbMs: null,
    totalMs: null,
    redirectChain: [],
    ua,
  };
  try {
    // requestOnce resolves once the body is complete; the redirect-following
    // wrapper is what exposes the chain. TTFB is taken from a separate
    // headers-only probe below where a check needs it, because attributing
    // total elapsed time to TTFB would be wrong.
    const res = await fetchUrl(url, {
      timeout,
      headers: { 'User-Agent': ua, ...(extraHeaders || {}) },
      method,
      ...(body != null ? { body } : {}),
      ...(maxBytes ? { maxBytes } : {}),
    });
    out.totalMs = Date.now() - started;
    out.status = res.status;
    out.url = res.url;
    out.ok = res.status >= 200 && res.status < 300;
    out.headers = res.headers || {};
    out.contentType = String(out.headers['content-type'] || '');
    out.bytes = res.body ? res.body.length : 0;
    out.redirectChain = (res.history || []).map((h) => ({ status: h.status, url: h.url }));
    if (res.body && res.body.length
      && (/html|xml|json|text|javascript/i.test(out.contentType || 'text/html') || !out.contentType)) {
      out.body = decodeBody(res);
    }
  } catch (err) {
    out.totalMs = Date.now() - started;
    out.error = `${err.kind || 'error'}: ${String(err.message).slice(0, 160)}`;
  }
  return out;
}

// Time to first byte, measured properly: the clock stops when the response
// headers arrive, not when the body finishes.
//
// Sampled three times and reported as the MEDIAN, because a single sample on
// shared hosting routinely lands on a cold cache or a noisy neighbour and a
// <200ms threshold judged on one sample flaps between pass and fail on an
// unchanged server.
async function measureTtfb(url, { samples = 3, ua = UA } = {}) {
  const readings = [];
  for (let i = 0; i < samples; i += 1) {
    const t0 = Date.now();
    try {
      // A HEAD would be cheaper, but plenty of servers handle HEAD on a
      // different (often faster, sometimes 405) path than GET — so this
      // measures the request a visitor actually makes, and the byte cap keeps
      // it from downloading the whole page.
      await requestOnce(url, { timeout: 15000, headers: { 'User-Agent': ua }, maxBytes: 2048 });
      readings.push(Date.now() - t0);
    } catch {
      readings.push(null);
    }
    if (i < samples - 1) await sleep(250);
  }
  const good = readings.filter((r) => r != null).sort((a, b) => a - b);
  if (!good.length) return { ms: null, samples: readings, error: 'no successful response' };
  return { ms: good[Math.floor(good.length / 2)], samples: readings };
}

// TLS certificate expiry. Read from the live handshake rather than inferred,
// because the failure this guards against — a certificate that silently
// expires — is invisible in the HTML and fatal to every other check at once.
function inspectCertificate(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let host;
    let port = 443;
    try {
      const u = new URL(normalizeUrl(url));
      if (u.protocol !== 'https:') {
        resolve({ ok: false, error: 'not served over HTTPS' });
        return;
      }
      host = u.hostname;
      if (u.port) port = Number(u.port);
    } catch {
      resolve({ ok: false, error: 'unparseable URL' });
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };

    // rejectUnauthorized: false so an ALREADY-EXPIRED certificate can still be
    // read and reported. Rejecting here would turn the exact condition being
    // checked for into an unexplained connection error.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) {
        finish({ ok: false, error: 'no certificate presented' });
        return;
      }
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
      finish({
        ok: true,
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || null,
        subject: (cert.subject && cert.subject.CN) || null,
        validFrom: cert.valid_from || null,
        validTo: cert.valid_to,
        daysLeft,
        authorized: socket.authorized,
        authorizationError: socket.authorized ? null : String(socket.authorizationError || 'unauthorized'),
      });
    });
    socket.on('timeout', () => finish({ ok: false, error: `TLS handshake timed out after ${timeoutMs}ms` }));
    socket.on('error', (err) => finish({ ok: false, error: String(err.message).slice(0, 160) }));
  });
}

// ----------------------------------------------------------------- parsing

// scriptingEnabled: false so <noscript> content parses as markup, matching the
// audit crawler. Without it a noscript fallback is one opaque text node and
// every selector below silently misses it — see tools/node/audit/page.js.
function load(html) {
  return cheerio.load(String(html || ''), { scriptingEnabled: false });
}

// Visible text, joined the way BeautifulSoup's get_text(" ") does — one
// separator between text nodes. cheerio's own .text() concatenates with
// nothing, which merges `<td>Total</td><td>19</td>` into "Total19" and
// deflates every word count and readability score downstream.
function visibleText($, root) {
  const parts = [];
  const walk = (el) => {
    if (el.type === 'text') {
      const t = String(el.data || '').trim();
      if (t) parts.push(t);
      return;
    }
    const tag = (el.name || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'svg') return;
    (el.children || []).forEach(walk);
  };
  (root || $('body')).toArray().forEach(walk);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// The structural read of a page every feature in this directory shares:
// headings in document order, paragraphs, lists, tables, JSON-LD blocks, the
// main-content text, and the metadata. Parsing this once per page and passing
// the result around is what keeps the on-page scorer, the schema checker and
// the architecture graph from each re-parsing the same HTML.
function parseDocument(url, html) {
  const $ = load(html);

  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    try {
      jsonLd.push({ ok: true, data: JSON.parse(raw), raw: raw.trim() });
    } catch (err) {
      // A JSON-LD block that does not parse is worth reporting, not skipping:
      // it is invisible to Google and the author almost never knows.
      jsonLd.push({ ok: false, error: String(err.message).slice(0, 120), raw: raw.trim().slice(0, 400) });
    }
  });

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = Number((el.name || 'h2').slice(1));
    const text = visibleText($, $(el));
    if (text) headings.push({ level, text });
  });

  // "Main content" in preference order. Scoring readability and entity density
  // over the whole <body> means scoring the nav, the cookie banner and the
  // footer, which on a short page can be most of the words.
  //
  // BUT THE CHOSEN CONTAINER IS VERIFIED BEFORE IT IS TRUSTED.
  //
  // Selector guessing fails in a specific and damaging way. A blog index on the
  // first site this ran against had a `<main>` wrapping only a 30-word intro
  // while the 23 post cards — the actual content, present in the served HTML —
  // sat outside it. Every downstream measurement then read that page as
  // 30 words: readability, entity density and citability were computed on an
  // intro paragraph, the thin-content check flagged it, and the
  // JavaScript-rendering check reported it as "content missing from the HTML"
  // at critical severity. The content was in the HTML the whole time.
  //
  // So a candidate container is accepted only if it actually holds a
  // substantial share of the body's text. Otherwise the page is measured from
  // <body>, which is imprecise but never wrong in this direction, and
  // `mainSelectorRejected` records that it happened so a caller can say so.
  const bodyText = visibleText($, $('body'));
  const MIN_MAIN_SHARE = 0.4;
  let mainSel = null;
  let mainSelectorRejected = null;
  for (const sel of ['main', 'article', '[role="main"]', '#content', '.content', '#main', '.entry-content', '.post-content']) {
    if (!$(sel).length) continue;
    const candidateText = visibleText($, $(sel).first());
    const share = bodyText.length ? candidateText.length / bodyText.length : 0;
    if (share >= MIN_MAIN_SHARE || bodyText.length < 400) { mainSel = sel; break; }
    // Remember the closest miss, so the rejection is explainable rather than
    // silent — a page measured from <body> reads differently and the reason
    // belongs in the payload.
    if (!mainSelectorRejected || share > mainSelectorRejected.share) {
      mainSelectorRejected = { selector: sel, share: Math.round(share * 100) / 100 };
    }
  }
  const mainNode = mainSel ? $(mainSel).first() : $('body');
  const mainText = visibleText($, mainNode);

  const paragraphs = [];
  mainNode.find('p').each((_, el) => {
    const t = visibleText($, $(el));
    if (t.length > 30) paragraphs.push(t);
  });

  const canonical = $('link[rel~="canonical"]').first().attr('href') || null;
  const metaDesc = $('meta[name="description"]').first().attr('content') || null;
  const robots = $('meta[name="robots"], meta[name="googlebot"]')
    .map((_, el) => String($(el).attr('content') || '').toLowerCase()).get().filter(Boolean).join(', ');

  const images = [];
  $('img').filter((_, el) => $(el).parents('noscript').length === 0).each((_, el) => {
    const $i = $(el);
    images.push({
      src: ($i.attr('src') || $i.attr('data-src') || '').trim(),
      alt: $i.attr('alt') == null ? null : String($i.attr('alt')),
      loading: ($i.attr('loading') || '').toLowerCase() || null,
      width: $i.attr('width') || null,
      height: $i.attr('height') || null,
      srcset: Boolean($i.attr('srcset') || $i.attr('data-srcset')),
    });
  });

  // Links, with a flag for whether each one sits INSIDE the main content
  // region rather than in the navigation, header or footer.
  //
  // That distinction matters more than it looks. Deciding "is this a listing
  // page, whose content is legitimately its links" from a document-wide link
  // count classifies almost every page on a normal site as a listing page,
  // because a header and footer alone carry twenty links. Counting only the
  // links in the main region is what makes the question answerable.
  const links = [];
  const collect = ($a, inMain) => {
    const href = String($a.attr('href') || '').trim();
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) return;
    let abs;
    try {
      const u = new URL(href, url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      u.hash = '';
      abs = u.href;
    } catch { return; }
    const rel = String($a.attr('rel') || '').toLowerCase();
    links.push({
      url: abs,
      anchor: visibleText($, $a).slice(0, 200),
      internal: sameSite(url, abs),
      nofollow: rel.includes('nofollow'),
      sponsored: rel.includes('sponsored') || rel.includes('ugc'),
      inMain,
    });
  };
  // The main-region anchors are identified by node identity rather than by
  // re-running a selector, because `mainNode` may be <body> itself — in which
  // case every anchor is "in main" and the distinction correctly collapses.
  const mainAnchors = new Set(mainNode.find('a[href]').toArray());
  $('a[href]').each((_, el) => collect($(el), mainAnchors.has(el)));

  // Semantic-HTML presence. AI retrieval systems chunk by structure, so a
  // page built entirely of <div> is harder to extract a citable passage from
  // than the same content in <article>/<section>/<h2>. Reported as which
  // landmarks exist rather than as one opaque score.
  const semantic = {
    main: $('main').length > 0,
    article: $('article').length > 0,
    section: $('section').length > 0,
    nav: $('nav').length > 0,
    header: $('header').length > 0,
    footer: $('footer').length > 0,
    aside: $('aside').length > 0,
    time: $('time').length > 0,
    figure: $('figure').length > 0,
    table: $('table').length > 0,
    lists: $('ul, ol').length,
    definitionLists: $('dl').length,
  };

  return {
    url,
    $,
    htmlLength: String(html || '').length,
    title: $('title').first().text().trim() || null,
    titleCount: $('title').length,
    metaDesc,
    metaDescCount: $('meta[name="description"]').length,
    canonical,
    robotsMeta: robots,
    lang: $('html').attr('lang') || null,
    headings,
    h1s: headings.filter((h) => h.level === 1).map((h) => h.text),
    paragraphs,
    mainText,
    bodyText,
    mainSelector: mainSel || 'body',
    // Present only when a candidate container was found and rejected for
    // holding too little of the page's text. Surfaced so a result page can
    // explain why a measurement was taken from <body>.
    mainSelectorRejected,
    wordCount: mainText ? mainText.split(/\s+/).filter(Boolean).length : 0,
    bodyWordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
    jsonLd,
    images,
    links,
    semantic,
    scriptCount: $('script').length,
    hasViewport: $('meta[name="viewport"]').length > 0,
    viewport: $('meta[name="viewport"]').first().attr('content') || null,
    // A rough read on whether the served HTML carries the content at all. A
    // page whose text lives behind JavaScript is invisible to every AI
    // retrieval fetcher, none of which execute scripts.
    spaMarker: /id=["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|data-reactroot|window\.__NUXT__|ng-version/i.test(String(html || '')),
    openGraph: {
      title: $('meta[property="og:title"]').first().attr('content') || null,
      description: $('meta[property="og:description"]').first().attr('content') || null,
      image: $('meta[property="og:image"]').first().attr('content') || null,
      type: $('meta[property="og:type"]').first().attr('content') || null,
    },
    breadcrumbTrail: extractBreadcrumbs($, url),
  };
}

// Breadcrumbs, from whichever of the three ways a site expresses them is
// present: BreadcrumbList JSON-LD, an aria-labelled nav, or a class name.
function extractBreadcrumbs($, url) {
  const fromJsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
    nodes.filter(Boolean).forEach((n) => {
      if (String(n['@type'] || '').includes('BreadcrumbList') && Array.isArray(n.itemListElement)) {
        n.itemListElement.forEach((item) => {
          const name = item && (item.name || (item.item && item.item.name));
          if (name) fromJsonLd.push(String(name));
        });
      }
    });
  });
  if (fromJsonLd.length) return { source: 'json-ld', trail: fromJsonLd };

  const nav = $('nav[aria-label*="readcrumb" i], .breadcrumb, .breadcrumbs, [class*="breadcrumb"]').first();
  if (nav.length) {
    const trail = nav.find('a, span, li').map((_, el) => visibleText($, $(el))).get()
      .map((t) => t.trim()).filter((t) => t && t.length < 80);
    if (trail.length) return { source: 'markup', trail: [...new Set(trail)] };
  }
  return { source: null, trail: [] };
}

// ------------------------------------------------------------------ robots

// robots.txt, parsed into per-agent group rules. Written here rather than
// reusing the audit crawler's matcher because the readiness check needs
// something that one does not expose: the ability to answer "is THIS agent
// allowed THIS path", agent by agent, including the wildcard fallback and
// Google's `Google-Extended` opt-out group which carries no crawl rules at all.
function parseRobots(text) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let current = null;
  const sitemaps = [];
  let sawDirective = false;

  lines.forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') { sitemaps.push(value); return; }
    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules — a detail that
      // is easy to miss and changes the answer for every agent listed after
      // the first.
      if (current && !sawDirective) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
        sawDirective = false;
      }
      return;
    }
    if (!current) return;
    sawDirective = true;
    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') current.crawlDelay = Number(value) || null;
  });

  return { groups, sitemaps, raw: String(text || '') };
}

// Longest-match wins, and on an equal-length tie Allow wins — the rule Google
// and Bing both document. Getting the tie wrong flips the verdict on the
// extremely common `Disallow: /` + `Allow: /$` homepage-only pattern.
function robotsAllows(robots, agentToken, path) {
  if (!robots || !robots.groups.length) return { allowed: true, rule: null, matchedAgent: null };
  const token = String(agentToken || '*').toLowerCase();

  // Most specific matching group: an exact agent group beats the wildcard.
  let group = robots.groups.find((g) => g.agents.some((a) => a === token));
  let matchedAgent = group ? token : null;
  if (!group) {
    group = robots.groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
    if (group) matchedAgent = group.agents.find((a) => a !== '*' && token.includes(a));
  }
  if (!group) {
    group = robots.groups.find((g) => g.agents.includes('*'));
    matchedAgent = group ? '*' : null;
  }
  if (!group) return { allowed: true, rule: null, matchedAgent: null };

  const matches = (pattern, target) => {
    if (pattern === '') return false; // "Disallow:" with no value allows everything
    // robots.txt wildcards: * is any run of characters, a trailing $ anchors
    // the end. Everything else is a literal prefix.
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const rx = new RegExp(`^${body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
    return rx.test(target);
  };

  let best = { allowed: true, rule: null, length: -1 };
  group.disallow.forEach((p) => {
    if (matches(p, path) && p.length > best.length) best = { allowed: false, rule: `Disallow: ${p}`, length: p.length };
  });
  group.allow.forEach((p) => {
    if (matches(p, path) && p.length >= best.length) best = { allowed: true, rule: `Allow: ${p}`, length: p.length };
  });
  return { allowed: best.allowed, rule: best.rule, matchedAgent, group };
}

async function fetchRobots(siteUrl) {
  let origin;
  try { origin = new URL(normalizeUrl(siteUrl)).origin; } catch { return { ok: false, error: 'unparseable site URL' }; }
  const res = await fetchPage(`${origin}/robots.txt`, { timeout: 12000 });
  if (res.error) return { ok: false, error: res.error, url: `${origin}/robots.txt` };
  if (res.status === 404) return { ok: true, present: false, status: 404, url: `${origin}/robots.txt`, parsed: parseRobots('') };
  return {
    ok: res.ok, present: res.ok, status: res.status, url: `${origin}/robots.txt`,
    body: res.body, parsed: parseRobots(res.body),
  };
}

// llms.txt — the emerging convention for a plain-text map of a site's
// canonical content, aimed at AI retrieval rather than at search crawlers.
//
// Worth being straight about in the UI: Google has stated it does not use
// llms.txt, and it is not a ranking factor anywhere. It is cheap, it is read
// by some retrieval pipelines, and it forces a brand to write its canonical
// facts down in one place — which is the part that actually helps. It is
// reported as an opportunity, never as an error.
async function fetchLlmsTxt(siteUrl) {
  let origin;
  try { origin = new URL(normalizeUrl(siteUrl)).origin; } catch { return { present: false }; }
  const res = await fetchPage(`${origin}/llms.txt`, { timeout: 10000 });
  return {
    url: `${origin}/llms.txt`,
    present: Boolean(res.ok && res.body && res.body.trim().length > 20 && !/<html/i.test(res.body.slice(0, 200))),
    status: res.status,
    bytes: res.bytes,
    body: res.ok ? res.body : null,
  };
}

// -------------------------------------------------------------- sitemaps

// Sitemap URLs, following index files one level deep. Capped, because a large
// news site's sitemap index expands to millions of URLs and nothing here needs
// more than a representative sample.
async function fetchSitemapUrls(siteUrl, { limit = 2000, robots = null } = {}) {
  let origin;
  try { origin = new URL(normalizeUrl(siteUrl)).origin; } catch { return { urls: [], sources: [] }; }

  const candidates = [];
  if (robots && robots.parsed && robots.parsed.sitemaps.length) candidates.push(...robots.parsed.sitemaps);
  else candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const urls = [];
  const sources = [];
  const seen = new Set();

  const readOne = async (sitemapUrl, depth) => {
    if (urls.length >= limit || seen.has(sitemapUrl) || depth > 1) return;
    seen.add(sitemapUrl);
    const res = await fetchPage(sitemapUrl, { timeout: 20000 });
    if (!res.ok || !res.body) {
      sources.push({ url: sitemapUrl, ok: false, status: res.status, error: res.error });
      return;
    }
    const $ = cheerio.load(res.body, { xmlMode: true });
    const nested = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
    const pages = $('urlset > url').map((_, el) => {
      const $u = $(el);
      return {
        loc: $u.find('loc').first().text().trim(),
        lastmod: $u.find('lastmod').first().text().trim() || null,
        changefreq: $u.find('changefreq').first().text().trim() || null,
        priority: $u.find('priority').first().text().trim() || null,
      };
    }).get().filter((u) => u.loc);

    sources.push({ url: sitemapUrl, ok: true, urls: pages.length, nested: nested.length });
    pages.forEach((p) => { if (urls.length < limit) urls.push(p); });
    for (const n of nested) {
      if (urls.length >= limit) break;
      await readOne(n, depth + 1);
    }
  };

  for (const c of candidates) {
    if (urls.length >= limit) break;
    await readOne(c, 0);
  }
  return { urls, sources };
}

// ------------------------------------------------------------------ crawl

// A small breadth-first crawl for the features that need site-wide structure
// (architecture graph, competitor content inventory) rather than one page.
//
// Deliberately modest by default: this runs inside a web request on shared
// hosting, so the page budget is small and the concurrency is low. A full
// site sweep is what the child-process crawler behind /audit is for.
async function crawlSite(startUrl, {
  maxPages = 60, concurrency = 4, sameHostOnly = true, onPage = null, timeout = 15000,
} = {}) {
  const start = normalizeUrl(startUrl);
  const queue = [{ url: start, depth: 0 }];
  const seen = new Set([canonUrl(start)]);
  const pages = [];
  let fetched = 0;

  while (queue.length && fetched < maxPages) {
    const batch = queue.splice(0, Math.min(concurrency, maxPages - fetched));
    // eslint-disable-next-line no-await-in-loop
    const results = await mapLimit(batch, concurrency, async (item) => {
      const res = await fetchPage(item.url, { timeout });
      return { item, res };
    });

    for (const entry of results) {
      if (!entry || entry.__error) continue;
      const { item, res } = entry;
      fetched += 1;
      if (!res.ok || !res.body || !/html/i.test(res.contentType || 'text/html')) {
        pages.push({ url: item.url, depth: item.depth, status: res.status, ok: false, error: res.error, doc: null });
        continue;
      }
      const doc = parseDocument(res.url, res.body);
      const page = {
        url: res.url,
        requestedUrl: item.url,
        depth: item.depth,
        status: res.status,
        ok: true,
        ttfbMs: null,
        totalMs: res.totalMs,
        bytes: res.bytes,
        headers: res.headers,
        redirectChain: res.redirectChain,
        doc,
      };
      pages.push(page);
      if (onPage) onPage(page);

      doc.links.forEach((l) => {
        if (sameHostOnly && !sameSite(start, l.url)) return;
        if (!isCrawlableHtml(l.url)) return;
        const key = canonUrl(l.url);
        if (seen.has(key)) return;
        seen.add(key);
        queue.push({ url: l.url, depth: item.depth + 1 });
      });
    }
  }

  return {
    startUrl: start,
    pages,
    fetched,
    discovered: seen.size,
    complete: queue.length === 0,
    truncatedAt: queue.length ? maxPages : null,
  };
}

module.exports = {
  AI_AGENTS, RETRIEVAL_AGENTS, UA,
  fetchPage, measureTtfb, inspectCertificate,
  load, visibleText, parseDocument, extractBreadcrumbs,
  parseRobots, robotsAllows, fetchRobots, fetchLlmsTxt, fetchSitemapUrls,
  crawlSite,
  // re-exported url helpers so features need one require, not three
  normalizeUrl, hostKey, sameSite, canonUrl, joinUrl, truncate,
  mapLimit, sleep,
};
