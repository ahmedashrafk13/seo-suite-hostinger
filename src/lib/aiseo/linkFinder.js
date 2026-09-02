// INTERNAL LINK OPPORTUNITIES FOR ONE TARGET URL
//
// WHAT WAS ASKED FOR
// "Search for a URL and find internal linking opportunities, with columns:
// URL, Source URL, Anchor text."
//
// WHY THE EXISTING FEATURES DID NOT ANSWER IT
// There were two internal-linking tools and neither did this. /linking is a
// whole-site child-process crawl producing a spreadsheet of every pair on the
// site — right for an audit, useless when the question is "this one page needs
// links, where from". ./architecture.js builds the graph and proposes links,
// but it proposes them across the WHOLE graph and orders them by global
// overlap, so a specific target page's opportunities are scattered through
// sixty rows about other pages.
//
// This is the target-first view: give it one URL, it crawls the site, and it
// returns the pages that should link to that URL, ranked, each with a REAL
// ANCHOR PHRASE FOUND VERBATIM IN THE SOURCE PAGE'S OWN VISIBLE TEXT.
//
// THE ANCHOR RULE, AND WHY IT IS ABSOLUTE
// A recommendation of the form "link from /blog/x with the anchor 'commercial
// roof repair'" is worthless if that phrase does not appear on /blog/x — the
// implementer has to write a new sentence, judge where it goes, and the
// recommendation becomes a writing brief. So every anchor returned here is a
// substring of the source page's own rendered text, with the sentence it sits
// in returned alongside it. The implementer opens the page, finds the sentence,
// wraps the phrase. That is the difference between a list that gets used and a
// list that gets filed.
//
// WHAT IS EXCLUDED, AND WHY
//   - the target itself, and pages already linking to it
//   - anchors inside the nav, header, footer or any boilerplate region: a link
//     added there is sitewide and is not an editorial link
//   - anchors whose SENTENCE repeats verbatim across most of the crawled site.
//     This is the case the markup-based filter cannot catch and it matters more
//     than it sounds: verified against a live site, the top six recommendations
//     were all the anchor "Unique Design" inside the sentence "Unlimited Pages
//     Website with Unique Design" — a feature block rendered on every page, in
//     a plain <div> with no nav, footer or template class on it. Six identical
//     recommendations pointing at one repeated banner is worse than none, and no
//     selector list would ever have found it. Cross-page repetition would.
//   - anchors that are generic UI text ("Learn More"), which carry no signal
//   - anchors already used on the source page to point somewhere ELSE, because
//     wrapping the same phrase twice on one page to two destinations is worse
//     than not linking
const cheerio = require('cheerio');
const nlp = require('./nlp');
const boilerplate = require('./boilerplate');
const { crawlSite, fetchPage, parseDocument, normalizeUrl, canonUrl } = require('./fetcher');

// ------------------------------------------------------------ target terms

// The phrases a link to this page could legitimately be anchored on, taken from
// the page itself: its H1, its title, its own H2s, and the phrases it repeats.
// Ordered by how strongly each identifies the page.
function targetPhrases(doc, { extra = [], templateBlocks = null } = {}) {
  const out = new Map();
  const add = (phrase, weight, origin) => {
    const p = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim()
      .replace(/^[^a-z0-9]+|[^a-z0-9%)]+$/g, '');
    if (p.length < 8 || p.length > 70) return;
    if (boilerplate.isGenericUi(p)) return;
    // A phrase of only stopwords identifies nothing.
    if (nlp.contentWords(p).length < 2) return;
    // A phrase lifted from the site's own repeated template is not a phrase
    // that identifies THIS page — it identifies every page.
    if (templateBlocks && templateBlocks.has && templateBlocks.has(p)) return;
    const cur = out.get(p);
    if (cur) { cur.weight = Math.max(cur.weight, weight); cur.origins.add(origin); return; }
    out.set(p, { phrase: p, weight, origins: new Set([origin]) });
  };

  // The title's brand suffix is not part of the subject.
  const cleanTitle = String(doc.title || '').split(/\s+[|–—·•]\s+/)[0];
  (doc.h1s || []).forEach((h) => add(h, 100, 'H1'));
  add(cleanTitle, 90, 'title');

  // The slug, spelled out. Often the cleanest statement of the subject.
  try {
    const slug = new URL(doc.url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    if (slug) add(slug.replace(/[-_]+/g, ' ').replace(/\.\w+$/, ''), 85, 'URL slug');
  } catch { /* a draft has no URL */ }

  (doc.headings || []).filter((h) => h.level === 2).forEach((h) => add(h.text, 60, 'H2'));

  const clean = boilerplate.contentText(doc);
  nlp.keyPhrases(clean.text, { minCount: 2, limit: 25 }).forEach((kp) => {
    add(kp.phrase, 40 + Math.min(20, kp.count * 2), `repeated ${kp.count}× in the content`);
  });

  (extra || []).forEach((e) => add(e, 95, 'supplied'));

  return [...out.values()]
    .map((v) => ({ ...v, origins: [...v.origins] }))
    .sort((a, b) => b.weight - a.weight || b.phrase.length - a.phrase.length);
}

// ------------------------------------------------- anchor discovery in a page

// Escapes a phrase for a whole-phrase regex, tolerating any whitespace run and
// an optional trailing 's' on the last word — "roof repair" should match "roof
// repairs", which is how the phrase actually appears in prose.
function phraseRegex(phrase) {
  const escaped = phrase.split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?<![\\w-])(${escaped}(?:s|es)?)(?![\\w-])`, 'i');
}

// Finds, in ONE source page, the best verbatim anchor for the target.
//
// Works on a boilerplate-free copy of the DOM so a phrase that only occurs in
// the footer is never offered, and skips text already inside an <a> so an
// existing link is not proposed for re-wrapping.
function anchorIn(sourceDoc, phrases, { targetKey, templateBlocks = null }) {
  const html = sourceDoc.$ ? (() => { try { return sourceDoc.$.html(); } catch { return null; } })() : null;
  if (!html) return null;

  const $ = cheerio.load(html, { scriptingEnabled: false });
  boilerplate.BOILERPLATE_SELECTORS.forEach((sel) => {
    try { $(sel).remove(); } catch { /* unsupported selector */ }
  });
  // Existing anchors are removed from the candidate text entirely: their text
  // is already a link, and nesting is not an option.
  const existingAnchorText = new Set();
  $('a[href]').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (t) existingAnchorText.add(t);
    $(el).remove();
  });

  const root = $('main').first().length ? $('main').first()
    : ($('article').first().length ? $('article').first() : $('body'));

  // Paragraph-level candidates, so the sentence can be returned with the
  // anchor. A recommendation without the surrounding sentence is a search task.
  const blocks = [];
  root.find('p, li, td, dd, blockquote').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length >= 40) blocks.push(t);
  });
  if (!blocks.length) {
    const whole = root.text().replace(/\s+/g, ' ').trim();
    if (whole.length >= 40) blocks.push(whole);
  }

  const isTemplate = (text) => {
    if (!templateBlocks || !templateBlocks.has) return false;
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return templateBlocks.has(t);
  };

  for (const p of phrases) {
    if (existingAnchorText.has(p.phrase)) continue; // already an anchor here, to something else
    const rx = phraseRegex(p.phrase);
    for (const block of blocks) {
      const m = rx.exec(block);
      if (!m) continue;
      const matched = m[1];
      // The sentence the phrase sits in, for the implementer to find.
      const sentence = nlp.sentences(block).find((sn) => rx.test(sn)) || block;
      // A sentence that repeats across most of the site is a template block,
      // whatever markup it sits in. Wrapping a link around it puts the same
      // anchor on every page, which is the opposite of an editorial link — and
      // recommending it once per page produces a list of identical rows.
      if (isTemplate(sentence) || isTemplate(block)) continue;
      return {
        anchor: matched,
        anchorNormalised: p.phrase,
        anchorWeight: p.weight,
        anchorOrigins: p.origins,
        sentence: sentence.length > 320 ? `${sentence.slice(0, 317)}…` : sentence,
        // Where in the page it is, roughly, so an implementer can find it fast.
        blockIndex: blocks.indexOf(block),
        blocksInPage: blocks.length,
        exactCase: matched !== p.phrase,
        targetKey,
      };
    }
  }
  return null;
}

// --------------------------------------------------------------------- find

// The whole job.
//
// `targetUrl` is the page that needs links. Returns one row per source page,
// with the columns asked for — URL (the target), Source URL, Anchor text — plus
// the sentence, the relevance evidence and the reason each candidate ranks
// where it does.
async function find(targetUrl, {
  site = null, maxPages = 120, concurrency = 4, limit = 50,
  extraPhrases = [], minRelevance = 0.08, crawl: existingCrawl = null,
} = {}) {
  const target = normalizeUrl(targetUrl);
  const targetKey = canonUrl(target);

  // The target page itself, fetched first: its own content is where the anchor
  // vocabulary comes from, and a target that 404s makes the whole run moot.
  const targetRes = await fetchPage(target, { timeout: 25000 });
  if (!targetRes.ok || !targetRes.body) {
    return {
      ok: false,
      target,
      reason: targetRes.error
        ? `The target URL could not be fetched: ${targetRes.error}`
        : `The target URL returned HTTP ${targetRes.status}, so there is no point finding links to it until that is fixed.`,
      rows: [],
    };
  }
  const targetDoc = parseDocument(targetRes.url, targetRes.body);

  // The site, crawled. Reused if the caller already has a crawl in hand, which
  // is how ./architecture.js calls this without paying for a second sweep.
  //
  // This has to happen BEFORE the anchor phrases are derived, because the
  // template detection below needs several pages of the same site to work at
  // all — and a phrase drawn from the site's own repeated furniture must never
  // reach the phrase list in the first place.
  const startFrom = site ? normalizeUrl(site) : (() => {
    try { return new URL(target).origin; } catch { return target; }
  })();
  const crawl = existingCrawl || await crawlSite(startFrom, { maxPages, concurrency });
  const pages = crawl.pages.filter((p) => p.ok && p.doc);

  // THE TEMPLATE SET.
  //
  // Any string appearing verbatim on most pages of the site is that site's
  // furniture, whatever markup it sits in. This is the only filter that catches
  // a feature banner in a bare <div> with no nav, footer or template class —
  // and without it, the top recommendations on a real site were six identical
  // rows all anchoring the same sitewide banner.
  const template = boilerplate.repeatedBlocks([targetDoc, ...pages.map((p) => p.doc)]);
  const templateBlocks = template.usable ? template.blocks : null;

  const phrases = targetPhrases(targetDoc, { extra: extraPhrases, templateBlocks });

  if (!phrases.length) {
    return {
      ok: false,
      target,
      reason: template.usable
        ? `No usable anchor phrase could be read from the target page. Its H1, title, slug and repeated phrases are all either too short, too long, generic UI text, or part of the site template that appears on ${template.threshold}+ of the ${template.pages} pages crawled — so any anchor recommended would have to be invented, and this tool does not invent anchors.`
        : 'No usable anchor phrase could be read from the target page. Its H1, title, slug and repeated phrases are all either too short, too long, or generic UI text — so any anchor recommended would have to be invented, and this tool does not invent anchors.',
      rows: [],
      targetDoc: { title: targetDoc.title, h1s: targetDoc.h1s, wordCount: targetDoc.wordCount },
      template: template.usable ? { pages: template.pages, threshold: template.threshold, examples: template.examples } : null,
    };
  }

  // Who already links to the target. These are excluded, and counted — "12
  // pages already link here" is the first thing a reader needs to know before
  // reading a list of thirty more.
  const alreadyLinking = [];
  const candidates = [];
  const targetEntities = new Set(nlp.entities(boilerplate.contentText(targetDoc).text)
    .filter((e) => e.type !== 'statistic')
    .map((e) => e.surface.toLowerCase()));
  const targetTf = nlp.termFrequency(boilerplate.contentText(targetDoc).text);

  pages.forEach((page) => {
    const key = canonUrl(page.url);
    if (key === targetKey) return;

    const links = (page.doc.links || []).filter((l) => l.internal);
    if (links.some((l) => canonUrl(l.url) === targetKey)) {
      const existing = links.find((l) => canonUrl(l.url) === targetKey);
      alreadyLinking.push({
        sourceUrl: page.url,
        sourceTitle: page.doc.title,
        anchor: existing.anchor || '(no anchor text)',
        inMain: existing.inMain,
        nofollow: existing.nofollow,
      });
      return;
    }
    candidates.push(page);
  });

  // Relevance, per candidate. Two independent measures, both cheap:
  //   entity overlap  are these pages about the same NAMED things
  //   cosine          do they share vocabulary at all
  // Entity overlap is the selective one; cosine keeps a page whose entities are
  // sparse but whose subject clearly matches.
  const scored = candidates.map((page) => {
    const clean = boilerplate.contentText(page.doc);
    const ents = new Set(nlp.entities(clean.text).filter((e) => e.type !== 'statistic').map((e) => e.surface.toLowerCase()));
    const overlap = nlp.jaccard(ents, targetEntities);
    const cosine = nlp.cosine(nlp.termFrequency(clean.text), targetTf);
    const shared = [...ents].filter((e) => targetEntities.has(e));
    return {
      page,
      clean,
      relevance: Math.round(((overlap * 0.65) + (cosine * 0.35)) * 1000) / 1000,
      entityOverlap: Math.round(overlap * 1000) / 1000,
      cosine: Math.round(cosine * 1000) / 1000,
      sharedEntities: shared.slice(0, 10),
      inboundNow: 0,
    };
  }).filter((c) => c.relevance >= minRelevance)
    .sort((a, b) => b.relevance - a.relevance);

  // Anchors, for the most relevant candidates first. Capped, because finding an
  // anchor means walking a page's DOM and the list stops being useful long
  // before fifty rows.
  const rows = [];
  const noAnchor = [];
  for (const c of scored) {
    if (rows.length >= limit) break;
    const anchor = anchorIn(c.page.doc, phrases, { targetKey, templateBlocks });
    if (!anchor) {
      noAnchor.push({
        sourceUrl: c.page.url,
        sourceTitle: c.page.doc.title,
        relevance: c.relevance,
        sharedEntities: c.sharedEntities,
        reason: 'relevant, but none of the target page\'s own phrases appear verbatim in this page\'s editorial content outside the site template — an anchor here would have to be written rather than found',
      });
      continue;
    }
    rows.push({
      // The three columns asked for, named as asked.
      url: target,
      sourceUrl: c.page.url,
      anchorText: anchor.anchor,
      // Everything needed to act on the row without opening the page blind.
      sourceTitle: c.page.doc.title,
      sentence: anchor.sentence,
      anchorFrom: anchor.anchorOrigins.join(', '),
      relevance: c.relevance,
      entityOverlap: c.entityOverlap,
      cosine: c.cosine,
      sharedEntities: c.sharedEntities,
      sourceDepth: c.page.depth,
      sourceWords: c.clean.words,
      sourceOutLinks: (c.page.doc.links || []).filter((l) => l.internal && l.inMain).length,
      why: [
        `shares ${c.sharedEntities.length} named entit${c.sharedEntities.length === 1 ? 'y' : 'ies'} with the target${c.sharedEntities.length ? ` (${c.sharedEntities.slice(0, 4).join(', ')})` : ''}`,
        `the phrase "${anchor.anchor}" already appears in its editorial content`,
        `${c.page.depth} click${c.page.depth === 1 ? '' : 's'} from the crawl start`,
      ].join('; '),
    });
  }

  return {
    ok: true,
    target,
    targetPage: {
      url: targetDoc.url,
      title: targetDoc.title,
      h1: targetDoc.h1s[0] || null,
      wordCount: targetDoc.wordCount,
      status: targetRes.status,
    },
    phrases: phrases.slice(0, 20),
    rows,
    alreadyLinking,
    relevantWithoutAnchor: noAnchor.slice(0, 30),
    crawl: {
      startUrl: crawl.startUrl,
      fetched: crawl.fetched,
      discovered: crawl.discovered,
      usable: pages.length,
      complete: crawl.complete,
      maxPages,
      reused: Boolean(existingCrawl),
    },
    template: template.usable
      ? {
        detected: template.blocks.size,
        pages: template.pages,
        threshold: template.threshold,
        basis: template.basis,
        examples: template.examples,
      }
      : {
        detected: 0,
        pages: template.pages,
        usable: false,
        note: 'Fewer than three pages were crawled, so no cross-page template detection was possible. Anchors were filtered on markup and generic-label rules only, which can let a sitewide banner through.',
      },
    counts: {
      opportunities: rows.length,
      alreadyLinking: alreadyLinking.length,
      relevantWithoutAnchor: noAnchor.length,
      candidatesConsidered: candidates.length,
      belowRelevanceThreshold: candidates.length - scored.length,
    },
    basis: `${pages.length} page${pages.length === 1 ? '' : 's'} crawled from ${crawl.startUrl}; a page qualifies when its entity/vocabulary overlap with the target clears ${minRelevance} AND one of the target's own phrases appears verbatim in its editorial content`
      + ` — with the nav, header, footer, generic labels`
      + (template.usable ? ` and the ${template.blocks.size} strings that repeat across ${template.threshold}+ of the crawled pages` : '')
      + ' all excluded',
    truncated: rows.length >= limit && scored.length > rows.length,
  };
}

module.exports = { find, targetPhrases, anchorIn, phraseRegex };
