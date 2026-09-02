// 7. REPUTATION AND AMBIENT SIGNAL MONITORING
//
// Scans the human-led sources AI answer engines lean on when they decide
// whether to trust what a brand says about itself — Reddit, forums, news, and
// discussion aggregators — and reports mentions, sentiment, and claims that
// would be damaging if repeated.
//
// WHY THIS IS AN SEO FEATURE AND NOT A MARKETING ONE
// When an assistant is asked "is <brand> any good", it does not read the
// brand's own site and stop. It weights third-party discussion heavily,
// because that is the part the brand did not write. A single confident Reddit
// thread asserting something false about a company can become the assistant's
// stated answer, repeated to every person who asks, indefinitely — and nothing
// on the brand's own site displaces it. Monitoring those sources is therefore
// part of search visibility, not adjacent to it.
//
// SOURCES
//   Reddit        ./redditClient.js — a tiered, block-aware scraper. Reddit is
//                 the most valuable source here and the most defended, so it
//                 gets its own module: four endpoints tried in order, browser
//                 client hints, paced requests, escalating backoff, and a hard
//                 stop that keeps what it already has. Ported from the
//                 lead-gen agent's Reddit scraper.
//   Hacker News   Algolia's public search API — keyless
//   Google News   the RSS feed behind news.google.com — keyless
//   Bing News     the RSS feed behind bing.com/news — keyless
//
// A brand's own review profiles (Trustpilot, G2, Google) are NOT scraped: each
// blocks automated access, and a scrape that silently starts returning nothing
// would look identical to "no new reviews" — the worst possible failure for a
// monitoring feature. Where those matter they belong behind their own API
// credential, and are declared unavailable rather than faked.
//
// Whatever the reason, a source that fails is REPORTED, and Reddit additionally
// reports WHICH tier answered. Reporting zero mentions when a source was
// blocked is the one outcome this module must never produce.
//
// SENTIMENT IS LEXICON-BASED, DELIBERATELY
// A scan can return several hundred items. Classifying all of them with a paid
// model would exhaust the AI spend cap on the cheapest part of the job, and
// would make the same comment score differently between runs. The lexicon in
// ./nlp.js classifies everything deterministically; the model is asked only
// about the handful of items carrying a damaging factual claim, where the
// judgement — assertion versus opinion, and what would settle it — genuinely
// needs reading comprehension.
const crypto = require('crypto');
const db = require('../../db');
const nlp = require('./nlp');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const { fetchPage, sleep, hostKey } = require('./fetcher');
const reddit = require('./redditClient');

const SOURCES = {
  reddit: { label: 'Reddit', kind: 'forum' },
  hackernews: { label: 'Hacker News', kind: 'forum' },
  'google-news': { label: 'Google News', kind: 'news' },
  'bing-news': { label: 'Bing News', kind: 'news' },
};

// The terms to watch: the brand name, its domain, its domain label, and
// anything the user added. Multi-word terms are quoted at search time so
// "acme legal" does not return every page containing "legal".
//
// THE LENGTH FLOOR IS 3, NOT 4, AND THAT MATTERS
// It was 4, which silently excluded real brand names — "Wix", "IBM", "SAP".
// Measured consequence: a scan of Wix searched only "wix.com", Reddit returned
// 50 posts, and the brand-match filter then rejected all 50 because Reddit
// posts say "Wix", not "wix.com". Fifty relevant mentions collected and thrown
// away, reported as "no mentions found".
//
// The floor existed because matching was a SUBSTRING test, where "wix" hits
// "wixom" and "wixel". That is now a word-boundary test (see mentionsBrand), so
// a short name is safe to search and the floor can come down. Two characters is
// still refused: word boundaries do not save "AI" or "GE" from being noise, and
// a brand that short needs a qualified term the user supplies.
const MIN_TERM_LENGTH = 3;

function watchTerms(brand) {
  const terms = [];
  if (brand.name) terms.push(String(brand.name).trim());
  const host = hostKey(brand.site_url);
  if (host) {
    terms.push(host);
    const label = host.split('.')[0];
    if (label && label.toLowerCase() !== String(brand.name || '').toLowerCase()) terms.push(label);
  }
  String(brand.mention_terms || '').split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean)
    .forEach((t) => terms.push(t));

  // Case-insensitively unique, preserving the first spelling seen — "Wix" and
  // "wix" are one term, and the one the user wrote is the one to show.
  const seen = new Set();
  return terms
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ------------------------------------------------- is it the RIGHT company?
//
// A brand name is rarely unique. Searching "Wix" returns the website builder
// AND WIX Filters, the automotive parts manufacturer — a real result from a
// real scan, which brought back "Huskee Log Splitter Hydraulic Fluid and Filter
// Change Spec" and "2023 Hybrid SE Air filters" as brand mentions. Both are
// genuine keyword matches about the wrong company, and both were being counted
// into the sentiment mix and the damaging-claim total.
//
// Word-boundary matching cannot fix this: the word really is there. What
// separates the two is TOPIC, so each mention is scored for whether it also
// talks about something this brand does.
//
// Context terms come from the brand's own Search Console queries with its
// branded terms removed — the most reliable statement of what a brand is about
// that this app holds, because it is what people actually searched before
// arriving. Where a brand has no such history the confidence is reported as
// unassessable rather than guessed, and nothing is excluded on the strength of
// a signal that does not exist.
const seoSignals = require('../seoSignals');

const CONTEXT_STOPWORDS = new Set(['www', 'com', 'net', 'org', 'the', 'and', 'for', 'with']);

function topicContext(brandId, brand) {
  const terms = new Set();
  let source = null;

  // 1. What the brand sells, if someone has stated it.
  if (brand.services_json) {
    try {
      const parsed = JSON.parse(brand.services_json);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {}).flat();
      list.forEach((svc) => nlp.contentWords(String(svc)).forEach((w) => terms.add(w)));
      if (terms.size) source = 'the services declared on the brand';
    } catch { /* malformed settings must not break a scan */ }
  }

  // 2. Its own non-branded Search Console queries — the strongest signal here.
  if (brandId) {
    try {
      const anchor = db.prepare('SELECT MAX(date) d FROM gsc_query_daily WHERE brand_id=?').get(brandId);
      if (anchor && anchor.d) {
        const start = new Date(`${anchor.d}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - 179);
        const rows = db.prepare(`SELECT query, SUM(impressions) imp FROM gsc_query_daily
          WHERE brand_id=? AND date BETWEEN ? AND ?
          GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 200`)
          .all(brandId, start.toISOString().slice(0, 10), anchor.d);
        const bt = seoSignals.brandTerms(brand);
        rows.forEach((r) => {
          // Branded queries describe the brand, not its subject, so they carry
          // no disambiguating power.
          if (seoSignals.isBrandedQuery(r.query, bt)) return;
          nlp.contentWords(r.query).forEach((w) => { if (w.length > 3) terms.add(w); });
        });
        if (terms.size) {
          source = source
            ? `${source} and its non-branded Search Console queries`
            : 'its non-branded Search Console queries';
        }
      }
    } catch { /* no history is a normal state, handled below */ }
  }

  CONTEXT_STOPWORDS.forEach((w) => terms.delete(w));
  // The brand's own name words are deliberately NOT context: they are the thing
  // being disambiguated.
  nlp.contentWords(String(brand.name || '')).forEach((w) => terms.delete(w));

  return { terms, source, usable: terms.size >= 5 };
}

// How sure are we this mention is about THIS company?
//
//   certain       it names the brand's own domain — nothing else does that
//   likely        it also talks about something the brand does
//   unclear       the name is there and nothing else corroborates it
//   unassessable  there is no topic context to judge against
//
// Only `unclear` is held back from the headline numbers, and it is still stored
// and listed — a mention wrongly excluded is worse than one shown with a
// caveat, so the caveat is the mechanism.
function mentionConfidence(item, { context, domain, watchedContainers = [] }) {
  const text = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
  if (domain && text.includes(domain.toLowerCase())) {
    return { level: 'certain', why: `names ${domain}` };
  }
  if (!context.usable) {
    return { level: 'unassessable', why: 'no topic context available for this brand' };
  }

  // WHERE a mention lives is topic evidence in its own right, and ignoring it
  // caused real false negatives: "Transferring Domain to Wix" posted in
  // r/webdesign was excluded because its title happens to share no vocabulary
  // with the brand's query set, even though the subreddit it sits in is
  // squarely on topic. A thread in a subreddit the user chose to watch, or one
  // whose name carries a context term, is about the right subject.
  const container = String(item.context || '').toLowerCase();
  if (container) {
    const bare = container.replace(/^r\//, '');
    if (watchedContainers.some((w) => String(w).toLowerCase() === bare)) {
      return { level: 'likely', why: `posted in ${item.context}, a subreddit being watched for this brand` };
    }
    // Subreddit names are usually run-together words ("webdesign",
    // "smallbusiness"), so a substring test is the right one here — token
    // splitting would find nothing.
    const containerHit = [...context.terms].find((t) => t.length > 3 && bare.includes(t));
    if (containerHit) {
      return { level: 'likely', why: `posted in ${item.context}, which is about ${containerHit}` };
    }
  }

  const words = new Set(nlp.contentWords(text));
  const hits = [];
  context.terms.forEach((t) => { if (words.has(t) && hits.length < 5) hits.push(t); });
  if (hits.length) return { level: 'likely', why: `also discusses ${hits.slice(0, 3).join(', ')}` };
  return { level: 'unclear', why: 'the name appears but neither the text nor its source relates to what this brand does' };
}

// ------------------------------------------------------------------ reddit
//
// Delegated to ./redditClient.js. Reddit needed to stop being one function
// among four: its endpoints move, it rate-limits aggressively, and the tier
// that answers is itself information a practitioner needs in order to trust
// the numbers.
async function searchReddit(terms, { window: win = 'year', limit = 50, subreddits = [] } = {}) {
  const r = await reddit.search(terms, {
    window: win, limit, subreddits, sitewide: true, sort: 'new',
  });
  return {
    ok: r.ok,
    error: r.error,
    items: r.items,
    stats: r.stats,
    perTarget: r.perTarget,
  };
}

// ------------------------------------------------------------ hacker news

async function searchHackerNews(term, { limit = 30 } = {}) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=(story,comment)&hitsPerPage=${limit}`;
  const res = await fetchPage(url, { timeout: 15000 });
  if (!res.ok || !res.body) return { ok: false, error: res.error || `HTTP ${res.status}`, items: [] };
  let json;
  try { json = JSON.parse(res.body); } catch { return { ok: false, error: 'Hacker News search returned a non-JSON response.', items: [] }; }
  const hits = Array.isArray(json.hits) ? json.hits : [];
  return {
    ok: true,
    items: hits.map((h) => ({
      source: 'hackernews',
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title || h.story_title || null,
      snippet: String(h.comment_text || h.story_text || h.title || '').replace(/<[^>]+>/g, ' ').slice(0, 800),
      author: h.author ? `hn/${h.author}` : null,
      engagement: (Number(h.points) || 0) + ((Number(h.num_comments) || 0) * 3),
      publishedAt: h.created_at || null,
      context: h.story_title && h.title !== h.story_title ? `on: ${h.story_title}` : null,
    })),
  };
}

// ------------------------------------------------------------------- news

// Both news sources are RSS. Parsed with a small regex reader rather than
// pulling in an XML library: the feeds are simple, well-formed and stable, and
// the failure mode of a bad parse (zero items) is visible in the run summary.
function parseRss(xml, source) {
  const items = [];
  const blocks = String(xml || '').split(/<item[\s>]/i).slice(1);
  blocks.forEach((raw) => {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(raw);
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim() || null;
    };
    const link = pick('link');
    if (!link) return;
    const pubDate = pick('pubDate');
    items.push({
      source,
      url: link,
      title: pick('title'),
      snippet: pick('description') || pick('title') || '',
      author: pick('source') || null,
      engagement: 0,
      publishedAt: pubDate && Number.isFinite(Date.parse(pubDate)) ? new Date(Date.parse(pubDate)).toISOString() : null,
      context: null,
    });
  });
  return items;
}

async function searchGoogleNews(term) {
  const q = /\s/.test(term) ? `"${term}"` : term;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetchPage(url, { timeout: 15000 });
  if (!res.ok || !res.body) return { ok: false, error: res.error || `HTTP ${res.status}`, items: [] };
  return { ok: true, items: parseRss(res.body, 'google-news') };
}

async function searchBingNews(term) {
  const q = /\s/.test(term) ? `"${term}"` : term;
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`;
  const res = await fetchPage(url, { timeout: 15000 });
  if (!res.ok || !res.body) return { ok: false, error: res.error || `HTTP ${res.status}`, items: [] };
  return { ok: true, items: parseRss(res.body, 'bing-news') };
}

// ----------------------------------------------------------------- storage

function dedupeKeyFor(url) {
  // Normalised so the same thread reached by two URL forms is one row: the
  // canonical Reddit permalink, the same permalink with a tracking parameter,
  // and the old.reddit host are all the same conversation.
  let normalised = String(url || '').trim().toLowerCase();
  try {
    const u = new URL(normalised);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.replace(/^(www|old|np|amp)\./, '');
    normalised = `${u.hostname}${u.pathname.replace(/\/+$/, '')}`;
  } catch { /* use the raw string */ }
  return crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 24);
}

// Does this item actually mention the brand, or did the search engine match
// loosely? Checked explicitly, because news RSS in particular returns
// tangential results, and a false mention in an alert destroys trust in the
// whole feature faster than a missed one does.
//
// WORD BOUNDARIES, NOT SUBSTRINGS
// A substring test cannot tell "Wix" from "Wixom" or "SAP" from "sapling", so
// short brand names had to be excluded from searching altogether to keep the
// noise out — which threw away every mention of them. Matching on boundaries
// makes a short name safe, so it can be searched.
//
// The boundary is "not a word character" on each side. Excluding the dot and
// hyphen as well was tried first and was wrong in the other direction: it
// stopped the term "Wix" matching the text "Is Wix.com worth it?", which is
// plainly a mention of Wix. A dot or hyphen next to the term is a boundary, not
// part of it — "wix.com", "sub.wix.com" and "wix-alternatives" all mention Wix,
// while "wixom", "wixel" and "wix2" do not.
const termMatchers = new Map();

function matcherFor(term) {
  const key = term.toLowerCase();
  if (termMatchers.has(key)) return termMatchers.get(key);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whitespace inside a term is allowed to match any run of whitespace, so a
  // line break between the words of "Acme Compliance" does not hide it.
  const body = escaped.replace(/\s+/g, '\\s+');
  const rx = new RegExp(`(^|[^\\w])${body}($|[^\\w])`, 'i');
  termMatchers.set(key, rx);
  return rx;
}

function mentionsBrand(item, terms) {
  const haystack = `${item.title || ''} ${item.snippet || ''}`;
  return terms.some((t) => matcherFor(t).test(haystack));
}

function upsertMention({ userId, brandId, item, sentimentInfo, confidence = null }) {
  const key = dedupeKeyFor(item.url);
  const existing = db.prepare('SELECT * FROM mentions WHERE brand_id=? AND dedupe_key=?').get(brandId, key);
  if (existing) {
    // Engagement grows; sentiment can change as a thread develops. Both are
    // refreshed, but first_seen_at is preserved — it is what "new mention"
    // alerting keys on, and overwriting it would re-alert every scan.
    db.prepare(`UPDATE mentions SET snippet=?, sentiment=?, sentiment_score=?, engagement=?,
        risk=?, confidence=COALESCE(?, confidence), confidence_why=COALESCE(?, confidence_why),
        last_seen_at=datetime('now') WHERE id=?`)
      .run(item.snippet ? String(item.snippet).slice(0, 2000) : existing.snippet,
        sentimentInfo.label, sentimentInfo.score,
        Math.max(Number(existing.engagement) || 0, Number(item.engagement) || 0),
        sentimentInfo.risk ? sentimentInfo.risk.key : null,
        confidence ? confidence.level : null,
        confidence ? confidence.why : null,
        existing.id);
    return { created: false, id: existing.id };
  }
  const res = db.prepare(`INSERT INTO mentions
    (user_id, brand_id, source, url, title, snippet, author, sentiment, sentiment_score,
     engagement, risk, published_at, dedupe_key, confidence, confidence_why)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, brandId, item.source, item.url,
      item.title ? String(item.title).slice(0, 500) : null,
      item.snippet ? String(item.snippet).slice(0, 2000) : null,
      item.author || null, sentimentInfo.label, sentimentInfo.score,
      Number(item.engagement) || 0,
      sentimentInfo.risk ? sentimentInfo.risk.key : null,
      item.publishedAt || null, key,
      confidence ? confidence.level : null,
      confidence ? confidence.why : null);
  return { created: true, id: Number(res.lastInsertRowid) };
}

function listMentions(brandId, { limit = 200, sentiment = null, risky = false } = {}) {
  const where = ['brand_id = ?'];
  const args = [brandId];
  if (sentiment) { where.push('sentiment = ?'); args.push(sentiment); }
  if (risky) where.push('risk IS NOT NULL');
  args.push(limit);
  return db.prepare(`SELECT * FROM mentions WHERE ${where.join(' AND ')}
    ORDER BY (risk IS NOT NULL) DESC, COALESCE(published_at, first_seen_at) DESC LIMIT ?`).all(...args);
}

function markReviewed(brandId, mentionId) {
  return db.prepare("UPDATE mentions SET reviewed_at=datetime('now') WHERE id=? AND brand_id=?")
    .run(mentionId, brandId).changes;
}

// --------------------------------------------------------------------- run

async function run({ userId, brand, adoptRunId = null, wantAi = true, window = 'year', force = false }) {
  const brandId = brand.id;
  const terms = watchTerms(brand);

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'reputation', target: brand.site_url,
    label: terms.join(', ').slice(0, 120),
    params: { terms, window },
  });

  try {
    const sources = [];

    if (!terms.length) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'No usable search terms. The brand name is too short or generic to search on its own — add specific terms (the legal name, a product name, a common misspelling) in the brand\'s mention terms.',
          terms: [],
        },
        findings: [],
        sources,
      });
    }

    if (!providers.has('public')) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'Outbound calls to public sources are disabled (AISEO_DISABLE_PUBLIC_SOURCES=1), so reputation scanning cannot run.',
          terms,
        },
        findings: [],
        sources,
      });
    }
    sources.push('public');

    const raw = [];
    const sourceStatus = [];
    let redditStats = null;

    // Reddit is run as ONE batched call across every term rather than
    // interleaved with the other sources, because its client owns the pacing
    // and the block state. Interleaving would reset nothing but would scatter
    // its requests among three other hosts' latencies, making the 4-second
    // spacing it depends on impossible to hold — and a block costs the whole
    // source, not one term.
    const watchSubreddits = String((brand.mention_subreddits || '')).split(/[\s,;]+/)
      .map((x) => x.replace(/^\/?r\//i, '').trim()).filter(Boolean).slice(0, 6);

    const redditResult = await searchReddit(terms.slice(0, 4), {
      window, limit: 50, subreddits: watchSubreddits,
    });
    redditStats = redditResult.stats;
    redditResult.items.forEach((item) => raw.push({ ...item, matchedTerm: item.matchedTerm }));
    (redditResult.perTarget || []).forEach((t) => {
      sourceStatus.push({
        source: 'reddit',
        term: t.subreddit ? `${t.term} in r/${t.subreddit}` : t.term,
        ok: t.ok,
        error: t.error || null,
        items: t.items,
        // Which endpoint answered. Shown in the UI: an RSS answer carries no
        // score, the authenticated one does, and a reader comparing engagement
        // numbers between runs needs to know which they are looking at.
        tier: t.tier,
      });
    });

    // The remaining three are cheap, unguarded and independent, so they keep
    // the simple paced loop.
    for (const term of terms.slice(0, 4)) {
      const runners = [
        ['hackernews', () => searchHackerNews(term)],
        ['google-news', () => searchGoogleNews(term)],
        ['bing-news', () => searchBingNews(term)],
      ];
      for (const [key, fn] of runners) {
        /* eslint-disable no-await-in-loop */
        const r = await fn();
        sourceStatus.push({ source: key, term, ok: r.ok, error: r.error || null, items: r.items.length });
        r.items.forEach((item) => raw.push({ ...item, matchedTerm: term }));
        await sleep(400);
        /* eslint-enable no-await-in-loop */
      }
    }

    // Filter to genuine mentions, classify, and persist.
    const context = topicContext(brandId, brand);
    const domain = hostKey(brand.site_url);

    const kept = [];
    const rejected = [];
    raw.forEach((item) => {
      if (!mentionsBrand(item, terms)) { rejected.push(item); return; }
      const sentimentInfo = nlp.sentiment(`${item.title || ''}. ${item.snippet || ''}`);
      const confidence = mentionConfidence(item, { context, domain, watchedContainers: watchSubreddits });
      const stored = upsertMention({ userId, brandId, item, sentimentInfo, confidence });
      kept.push({
        ...item, sentiment: sentimentInfo, confidence, isNew: stored.created, id: stored.id,
      });
    });

    // Triage the damaging claims with the model — a small, high-value subset.
    const flagged = kept.filter((k) => k.sentiment.risk).slice(0, 12);
    let triage = null;
    if (wantAi && flagged.length) {
      triage = await aiCalls.mentionTriage({
        brandId, brand,
        mentions: flagged.map((f) => ({ url: f.url, source: f.source, title: f.title, snippet: f.snippet, risk: f.sentiment.risk.label })),
        force,
      });
      if (triage.ok) sources.push('azure');
    }

    // Sentiment mix, over everything stored for this brand rather than only
    // this scan — one scan is a sample, the stored set is the picture.
    const allStored = listMentions(brandId, { limit: 1000 });
    // Mentions that name the brand but relate to nothing it does are stored and
    // listed, and kept OUT of the headline numbers. This is what stops WIX
    // Filters threads driving the sentiment and damaging-claim totals for Wix
    // the website builder.
    const confident = allStored.filter((m) => m.confidence !== 'unclear');
    const unclear = allStored.filter((m) => m.confidence === 'unclear');
    const mix = {
      total: confident.length,
      positive: confident.filter((m) => m.sentiment === 'positive').length,
      neutral: confident.filter((m) => m.sentiment === 'neutral').length,
      negative: confident.filter((m) => m.sentiment === 'negative').length,
      risky: confident.filter((m) => m.risk).length,
      unreviewed: confident.filter((m) => m.risk && !m.reviewed_at).length,
      // Reported separately and prominently, never folded in or hidden.
      unclear: unclear.length,
      storedTotal: allStored.length,
      byConfidence: ['certain', 'likely', 'unassessable', 'unclear'].map((level) => ({
        level, count: allStored.filter((m) => (m.confidence || 'unassessable') === level).length,
      })),
    };
    // Net sentiment on a -100..100 scale, over items that carry any sentiment
    // at all. Neutral items are excluded from the denominator: on most brands
    // they are the majority, and including them compresses every brand toward
    // zero and hides real movement.
    const opinionated = mix.positive + mix.negative;
    const netSentiment = opinionated ? Math.round(((mix.positive - mix.negative) / opinionated) * 100) : null;

    const bySource = Object.keys(SOURCES).map((key) => ({
      key,
      label: SOURCES[key].label,
      stored: allStored.filter((m) => m.source === key).length,
      thisScan: kept.filter((k) => k.source === key).length,
      status: sourceStatus.filter((s) => s.source === key),
      // Reddit alone reports how it got in, because it alone has a choice.
      tiers: key === 'reddit' && redditStats ? redditStats.tierCounts : null,
      stats: key === 'reddit' ? redditStats : null,
    }));

    // ------------------------------------------------------------ findings
    const findings = [];

    // A damaging claim about a different company with the same name is not a
    // damaging claim about this brand, so an unclear mention cannot raise a
    // critical alert.
    const newRisky = kept.filter((k) => k.isNew && k.sentiment.risk && k.confidence.level !== 'unclear');
    if (newRisky.length) {
      const critical = newRisky.filter((k) => k.sentiment.risk.severity === 'critical');
      findings.push({
        checkKey: 'damaging_claims',
        title: `${newRisky.length} new mention${newRisky.length === 1 ? '' : 's'} carrying a damaging claim`,
        detail: newRisky.slice(0, 6).map((k) => `[${SOURCES[k.source] ? SOURCES[k.source].label : k.source}] ${k.sentiment.risk.label}: ${k.title || k.url}`).join('; ')
          + '. An assistant asked about this brand can repeat an unchallenged claim as its answer.',
        severity: critical.length ? 'critical' : 'high',
        affectedUrl: newRisky[0].url,
        affectedCount: newRisky.length,
        action: 'Read each one before responding. Where a claim is factually wrong, correct it at the source and publish a page stating the correct fact plainly, so both a human and a retrieval system can find it.',
        evidence: { mentions: newRisky.map((k) => ({ url: k.url, source: k.source, title: k.title, risk: k.sentiment.risk, snippet: (k.snippet || '').slice(0, 300) })) },
        dedupeKey: `reputation:risky:${brandId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }

    if (netSentiment != null && netSentiment < -20 && opinionated >= 5) {
      findings.push({
        checkKey: 'negative_sentiment',
        title: `Net sentiment across third-party mentions is ${netSentiment}`,
        detail: `${mix.negative} negative against ${mix.positive} positive, out of ${mix.total} mentions stored. Neutral mentions are excluded from the ratio.`,
        severity: netSentiment < -50 ? 'high' : 'medium',
        affectedCount: mix.negative,
        action: 'Work the specific complaints rather than the aggregate. Read the negative mentions for a repeated cause — one operational problem usually accounts for most of them.',
        evidence: { mix, netSentiment },
        dedupeKey: `reputation:sentiment:${brandId}:${new Date().toISOString().slice(0, 7)}`,
      });
    }

    if (mix.unclear >= 5 && mix.unclear >= allStored.length * 0.25) {
      findings.push({
        checkKey: 'ambiguous_brand_name',
        title: `${mix.unclear} of ${allStored.length} mentions name the brand but relate to nothing it does`,
        detail: `"${terms[0]}" appears to be shared with something else. Those mentions are stored and listed but excluded from the sentiment and damaging-claim totals, because counting them would describe a different company.`
          + (context.usable ? ` Topic context was derived from ${context.source}.` : ' No topic context was available, so this is based on the domain alone.'),
        severity: 'info',
        action: 'Add more specific watch terms — the legal name, a product name, or the brand plus a qualifier — so the search itself excludes the other company rather than the filter having to.',
        evidence: { unclear: mix.unclear, total: allStored.length, contextSource: context.source, sample: unclear.slice(0, 8).map((m) => ({ url: m.url, title: m.title })) },
        dedupeKey: `reputation:ambiguous:${brandId}`,
      });
    }

    if (mix.total === 0) {
      findings.push({
        checkKey: 'no_mentions',
        title: 'No third-party mentions found anywhere',
        detail: `Searched ${terms.length} term${terms.length === 1 ? '' : 's'} across Reddit, Hacker News, Google News and Bing News. Absence of discussion is itself a visibility problem: an assistant asked whether this brand is credible has nothing independent to weigh, and defaults to hedging or to whatever a competitor's content says.`,
        severity: 'medium',
        action: 'Build the ambient signal deliberately: answer questions in the communities where the audience already asks them, get listed in industry directories, and pursue coverage that names the brand. This is slow, and it is the part of AI visibility that cannot be shortcut on-site.',
        evidence: { terms, sourceStatus },
        dedupeKey: `reputation:nomentions:${brandId}`,
      });
    }

    if (redditStats && redditStats.hardBlocked) {
      findings.push({
        checkKey: 'reddit_blocked',
        title: 'Reddit rate-limited this IP mid-scan',
        detail: `${redditStats.totalBlocks} block(s) across ${redditStats.requests} request(s); `
          + `${redditStats.abandoned} remaining Reddit search(es) were abandoned and everything already collected was kept. `
          + 'Reddit is the source an assistant leans on hardest for "is this brand any good", so a blocked scan leaves a real gap rather than a cosmetic one.',
        severity: 'medium',
        action: redditStats.authenticated
          ? 'The authenticated endpoint is configured but still blocked — check the app credentials are valid.'
          : 'Raise REDDIT_DELAY_MS, wait 15-60 minutes, or create a free "script" app at reddit.com/prefs/apps and set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET to use the authenticated endpoint, which is not rate-limited this way.',
        evidence: { stats: redditStats },
        dedupeKey: `reputation:redditblocked:${brandId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }

    const brokenSources = bySource.filter((s) => s.status.length && s.status.every((x) => !x.ok));
    if (brokenSources.length) {
      findings.push({
        checkKey: 'source_unavailable',
        title: `${brokenSources.length} monitoring source${brokenSources.length === 1 ? '' : 's'} returned nothing usable`,
        detail: brokenSources.map((s) => `${s.label}: ${s.status.map((x) => x.error).filter(Boolean)[0] || 'no items'}`).join('; ')
          + '. Reported explicitly, because a silently failing source looks exactly like a quiet one.',
        severity: 'info',
        action: 'Usually rate limiting, which clears on its own. If a source fails on every scan, treat its coverage as absent rather than as clean.',
        evidence: { sources: brokenSources },
        dedupeKey: `reputation:sourcefail:${brandId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }

    // A visibility score, not a sentiment score: how much independent
    // discussion exists, and how much of it is favourable.
    const volumeComponent = Math.min(50, Math.round(Math.log10(mix.total + 1) * 25));
    const sentimentComponent = netSentiment == null ? 25 : Math.round(((netSentiment + 100) / 200) * 40);
    const riskPenalty = Math.min(20, mix.unreviewed * 5);
    const score = Math.max(0, Math.min(100, volumeComponent + sentimentComponent + 10 - riskPenalty));

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        terms,
        window,
        mix,
        netSentiment,
        confidence: {
          context: context.source,
          usable: context.usable,
          termCount: context.terms.size,
        },
        unclearMentions: unclear.slice(0, 40),
        bySource,
        sourceStatus,
        reddit: redditStats,
        watchSubreddits,
        scanned: raw.length,
        kept: kept.length,
        rejected: rejected.length,
        newThisScan: kept.filter((k) => k.isNew).length,
        mentions: listMentions(brandId, { limit: 150 }),
        triage: triage ? { ok: triage.ok, cached: triage.cached, reason: triage.reason, error: triage.error, data: triage.ok ? triage.data : null } : null,
        notMonitored: [
          { label: 'Trustpilot, G2, Capterra, Google reviews', why: 'All block automated access. A scrape that starts returning nothing would be indistinguishable from "no new reviews", so these are left to a dedicated API credential rather than faked.' },
          { label: 'X / Twitter, LinkedIn, Facebook', why: 'No keyless public search endpoint remains for any of them.' },
          { label: 'Reddit comment bodies', why: 'The tier that currently answers is the RSS feed, which carries the post body but not the comment thread beneath it, and no score. The authenticated API returns both — set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.' },
        ],
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: [
        { key: 'reputation.mentions_total', value: mix.total, status: mix.total > 0 ? 'good' : 'warn' },
        { key: 'reputation.net_sentiment', value: netSentiment, status: netSentiment == null ? 'unknown' : (netSentiment >= 0 ? 'good' : (netSentiment > -40 ? 'warn' : 'fail')) },
        { key: 'reputation.risky_unreviewed', value: mix.unreviewed, status: mix.unreviewed ? 'fail' : 'good' },
      ],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:reputation:${run.id}:${f.check_key}`,
      category: 'Reputation',
      severity: f.severity,
      affectedUrl: f.affected_url || null,
      evidence: f.evidence,
      dedupeKey: `aiseo:reputation:${f.check_key}:${run.brand_id || 0}:${String(f.dedupe_key || '').slice(-10)}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, SOURCES, watchTerms, listMentions, markReviewed,
  searchReddit, searchHackerNews, searchGoogleNews, searchBingNews,
  parseRss, dedupeKeyFor, mentionsBrand, matcherFor, MIN_TERM_LENGTH,
  topicContext, mentionConfidence,
  // Re-exported so the verification suite can exercise the tier chain directly.
  reddit,
};
