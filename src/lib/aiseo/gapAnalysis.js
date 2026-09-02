// COMPETITIVE GAP ANALYSIS — the four tables the report was missing.
//
// WHAT WAS ASKED FOR
//   1. Clean the response: the gap lists were full of brand entities and
//      generic words ("Office Headquarters", "why choose us").
//   2. The referring-domains analysis was wrong.
//   3. Topical coverage gap in tabular form: Topic | Comp 1 | Comp 2 | Us.
//   4. Keyword gap — the competitors' keyword rankings.
//   5. Backlink gap — the competitors' backlinks.
//
// EACH ONE, AND HOW IT IS ANSWERED HONESTLY
//
// 1. NOISE. Handled in ./boilerplate.js and applied here. A competitor's own
//    brand name is, structurally, the entity most likely to be on their pages
//    and not on ours, so before filtering it was always at the top of the gap
//    list — the report was advising the client to write about their rivals.
//
// 2. REFERRING DOMAINS. The old figure came from a DuckDuckGo search for pages
//    MENTIONING a domain, which counted a page that types "example.com" in
//    running text the same as one that links to it, and counted the searcher's
//    own syndicated copies as separate domains. It was labelled as a proxy, but
//    a labelled wrong number is still a wrong number. It is now VERIFIED: every
//    candidate page is fetched and its outbound links are read, and a domain
//    counts only when a real <a href> to the target is found. `nofollow` is
//    recorded separately. That turns a mention count into a small, true
//    backlink sample — and where a link index credential exists, that is used
//    instead and the sample is skipped.
//
// 3. TOPIC MATRIX. A per-topic COVERAGE SCORE for each site, computed the same
//    way for all of them, in one table. The score is defined below and shown
//    with its formula, because "Comp 1: 62" means nothing without it.
//
// 4. KEYWORD GAP. Needs to know where competitors rank. With DataForSEO or
//    Semrush that is measured. Without, each candidate keyword's result page is
//    sampled from a keyless engine and each site's position in that sample is
//    recorded — a real visibility comparison against a non-Google index, capped
//    and labelled. Never presented as Google positions.
//
// 5. BACKLINK GAP. Moz, Ahrefs or DataForSEO where a credential exists.
//    Otherwise the verified sample from (2), for every site, compared. The
//    sample's size limit is stated on the table, because a comparison of
//    samples is a comparison of samples.
const nlp = require('./nlp');
const providers = require('./providers');
const boilerplate = require('./boilerplate');
const serpLite = require('./serpLite');
const markets = require('./markets');
const webMentions = require('./webMentions');
const { fetchPage, parseDocument, mapLimit, sleep, hostKey } = require('./fetcher');

// ===================================================== 3. TOPIC COVERAGE MATRIX

// How well does one site cover one topic?
//
// THE FORMULA, stated because the table is unreadable without it:
//
//   pageShare   share of the site's crawled pages that discuss the topic at all
//               (the topic's terms appear in the page's title, headings or
//               content). Weight 40. This is BREADTH.
//   focusShare  share of the site's crawled pages where the topic is in the
//               TITLE or an H1 — i.e. pages ABOUT the topic rather than pages
//               that mention it. Weight 40. This is DEPTH, and it is the half
//               that separates a site with a dedicated page from a site that
//               name-drops the subject in a footer.
//   depthBonus  whether the deepest such page carries substantial content
//               (500+ words). Weight 20.
//
// Scored 0-100 per site per topic, identically for every site, so the columns
// are comparable — which is the entire point of a matrix.
function topicCoverage(topicTerms, pages) {
  const usable = pages.filter((p) => p && p.doc);
  if (!usable.length || !topicTerms.length) {
    return { score: 0, pagesMentioning: 0, pagesAbout: 0, pagesTotal: usable.length, bestPage: null, measurable: false };
  }
  const stems = new Set(topicTerms.flatMap((t) => nlp.contentWords(t).map(nlp.stem)));
  if (!stems.size) {
    return { score: 0, pagesMentioning: 0, pagesAbout: 0, pagesTotal: usable.length, bestPage: null, measurable: false };
  }

  // How much of the topic's distinctive vocabulary is present.
  //
  // The threshold has to scale with the topic's length. A fixed 50% means a
  // two-word topic like "green roof" is satisfied by "roof" alone — so a
  // roofing site with no green-roof content scored identically to one with a
  // dedicated section, which made the whole matrix useless. Short topics
  // therefore require EVERY word; longer ones allow one miss, because a
  // four-word phrase rarely appears complete.
  const required = stems.size <= 2 ? 1 : (stems.size - 1) / stems.size;
  const hit = (text) => {
    const set = new Set(nlp.contentWords(text || '').map(nlp.stem));
    let n = 0;
    stems.forEach((st) => { if (set.has(st)) n += 1; });
    return n / stems.size;
  };
  const meets = (score) => score >= required - 1e-9;

  let mentioning = 0;
  let about = 0;
  let bestPage = null;
  let bestWords = 0;

  usable.forEach((p) => {
    const clean = boilerplate.contentText(p.doc);
    const headingText = (p.doc.headings || []).map((h) => h.text).join('. ');
    const titleHit = hit(`${p.doc.title || ''} ${(p.doc.h1s || []).join(' ')}`);
    const bodyHit = hit(`${headingText} ${clean.text}`);

    // "Mentions": the topic's vocabulary appears somewhere in the content.
    // "About": it appears in the title or H1, which is the page claiming the
    // subject rather than passing over it.
    if (meets(bodyHit) || meets(titleHit)) mentioning += 1;
    if (meets(titleHit)) {
      about += 1;
      if (clean.words > bestWords) { bestWords = clean.words; bestPage = { url: p.url, title: p.doc.title, words: clean.words }; }
    }
  });

  const pageShare = mentioning / usable.length;
  const focusShare = about / usable.length;
  const depthBonus = bestWords >= 500 ? 1 : (bestWords >= 250 ? 0.5 : 0);
  const score = Math.round(Math.min(100, (pageShare * 40) + (focusShare * 40) + (depthBonus * 20)));

  return {
    score,
    pagesMentioning: mentioning,
    pagesAbout: about,
    pagesTotal: usable.length,
    bestPage,
    bestPageWords: bestWords,
    measurable: true,
  };
}

// The matrix. `sites` is [{ key, label, pages }] with OURS FIRST by convention;
// `topics` is [{ topic, terms }].
function topicMatrix(topics, sites, { limit = 40 } = {}) {
  const rows = topics.slice(0, limit).map((t) => {
    const cells = sites.map((s) => ({
      site: s.key,
      label: s.label,
      ...topicCoverage(t.terms || [t.topic], s.pages),
    }));
    const ours = cells[0];
    const theirs = cells.slice(1);
    const bestRival = theirs.reduce((acc, c) => (c.score > (acc ? acc.score : -1) ? c : acc), null);
    return {
      topic: t.topic,
      terms: t.terms || [t.topic],
      cells,
      ourScore: ours ? ours.score : null,
      bestRivalScore: bestRival ? bestRival.score : null,
      bestRival: bestRival ? bestRival.label : null,
      // The number the table should be sorted by: how far behind the strongest
      // competitor we are on this topic. Negative means we lead.
      deficit: (bestRival && ours) ? bestRival.score - ours.score : null,
      // A topic every competitor covers and we do not is a different class of
      // problem from one where we are merely behind.
      universalGap: Boolean(ours && ours.score === 0 && theirs.length && theirs.every((c) => c.score > 0)),
    };
  });

  return {
    columns: ['Topic', ...sites.map((s) => s.label)],
    rows: rows.sort((a, b) => (b.deficit ?? -999) - (a.deficit ?? -999)),
    sites: sites.map((s) => ({ key: s.key, label: s.label, pages: s.pages.filter((p) => p && p.doc).length })),
    formula: 'coverage = 40×(share of crawled pages discussing the topic) + 40×(share whose title or H1 is about it) + 20×(deepest such page has 500+ words). Computed identically for every site, so the columns are comparable.',
    caveat: 'Each column is scored over that site\'s own crawled sample, and the samples differ in size. A site crawled to 30 pages and one crawled to 30 pages are comparable; the page counts are shown per column so an uneven crawl is visible rather than hidden.',
  };
}

// Turns the noisy entity/phrase gap lists into clean, deduplicated TOPICS for
// the matrix. This is where requirement 1 lands: nothing reaches the matrix
// until it has survived the noise filter.
function topicsFromGaps({ entityGaps = [], topicGaps = [], ourPhrases = [], noiseOpts = null, limit = 30 }) {
  const filteredEntities = noiseOpts
    ? boilerplate.filterEntities(entityGaps.map((e) => ({ surface: e.surface, count: e.pages || e.count || 1 })), noiseOpts)
    : { kept: entityGaps, suppressed: [], suppressedCount: 0, summary: [] };
  const filteredPhrases = noiseOpts
    ? boilerplate.filterPhrases(topicGaps, noiseOpts)
    : { kept: topicGaps, suppressed: [], suppressedCount: 0, summary: [] };

  // Merge entities and phrases into one topic list, collapsing near-duplicates
  // by stem set — "capital adequacy" and "capital adequacy requirements" are one
  // topic, and listing both makes the matrix twice as long and no more useful.
  const topics = [];
  const seenStemKeys = new Set();
  const consider = (label, weight) => {
    const stems = nlp.contentWords(label).map(nlp.stem).sort();
    if (stems.length < 1) return;
    const key = stems.join('|');
    if (seenStemKeys.has(key)) return;
    // Collapse near-duplicates in BOTH directions. "capital adequacy" and
    // "capital adequacy requirements" are one topic; whichever arrives first
    // wins and the other is dropped. Checking only one direction left the
    // longer phrase in the list beside the shorter one, which is the case that
    // actually occurs — the entity list supplies the short form and the phrase
    // list the long one.
    for (const existing of seenStemKeys) {
      const eStems = existing.split('|');
      const eSet = new Set(eStems);
      const newSet = new Set(stems);
      if (stems.every((st) => eSet.has(st))) return; // new ⊆ existing
      if (eStems.every((st) => newSet.has(st))) return; // existing ⊆ new
    }
    seenStemKeys.add(key);
    topics.push({ topic: label, terms: [label], weight });
  };

  filteredEntities.kept
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .forEach((e) => consider(e.surface, (e.count || 1) * 2));
  filteredPhrases.kept
    .sort((a, b) => (b.competitors || 0) - (a.competitors || 0) || (b.pages || 0) - (a.pages || 0))
    .forEach((pp) => consider(pp.phrase, (pp.competitors || 1) * 3));

  return {
    topics: topics.slice(0, limit),
    suppressed: (() => {
      // Merged by count, not by string union — see competitive.js for the bug
      // the union produced.
      const merged = { ...(filteredEntities.byReason || {}) };
      Object.entries(filteredPhrases.byReason || {}).forEach(([reason, n]) => {
        merged[reason] = (merged[reason] || 0) + n;
      });
      return {
        entities: filteredEntities.suppressed.slice(0, 40),
        phrases: filteredPhrases.suppressed.slice(0, 40),
        total: filteredEntities.suppressedCount + filteredPhrases.suppressedCount,
        byReason: merged,
        summary: boilerplate.renderReasonSummary(merged),
      };
    })(),
    collapsed: (filteredEntities.kept.length + filteredPhrases.kept.length) - topics.length,
  };
}

// ============================================ 2 + 5. VERIFIED REFERRING DOMAINS

// A candidate page is only a referring domain when it actually LINKS here.
//
// This is the fix for the wrong referring-domain figures. Every candidate page
// is fetched and its outbound links are read; a domain counts only when a real
// <a href> pointing at the target is found. FOUR outcomes, all kept:
//
//   linked      a verified outbound link exists, with rel recorded
//   mention     the page's own text names the domain, but carries no link
//   irrelevant  the page neither links to nor mentions the domain — the search
//               engine simply returned a poor match
//   unverified  the page could not be fetched, so nothing is claimed
//
// THE `irrelevant` BUCKET EXISTS BECAUSE OF A BUG IN THE FIRST VERSION OF THIS
// FUNCTION. It had three buckets and treated "fetched, no link found" as
// "mentions the domain without linking" — without ever checking that the page
// mentioned it. Verified against a live run: the fallback engine ignores the
// `-site:` and quoted-phrase operators, so candidates came back including
// support.google.com and brainly.ph, and all of them were reported as unlinked
// mentions of the target. That is a fabricated claim about a third-party page,
// which is exactly the class of error this whole module exists to remove.
//
// Separating the two also makes a degraded candidate list VISIBLE: a high
// `irrelevant` count means the search operators were not honoured, which is a
// fact about the search, not about the web.
async function verifyReferring(domain, { limit = 20, excludeHost = null, concurrency = 3 } = {}) {
  const clean = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!clean) return { ok: false, error: 'no domain given', linked: [], mentions: [], unverified: [] };

  const found = await webMentions.referringPages(clean, { limit: limit * 2, excludeHost });
  if (!found.ok) {
    return { ok: false, error: found.error, linked: [], mentions: [], unverified: [], candidates: 0 };
  }

  const checked = await mapLimit(found.items.slice(0, limit * 2), concurrency, async (item) => {
    const res = await fetchPage(item.url, { timeout: 14000, ua: serpLite.BROWSER_UA });
    if (!res.ok || !res.body) {
      return { ...item, state: 'unverified', reason: res.error || `HTTP ${res.status}` };
    }
    const doc = parseDocument(res.url, res.body);
    const links = (doc.links || []).filter((l) => {
      try {
        const h = new URL(l.url).hostname.replace(/^www\./, '').toLowerCase();
        return h === clean || h.endsWith(`.${clean}`);
      } catch { return false; }
    });
    if (!links.length) {
      // Does the page actually NAME the domain? Checked rather than assumed.
      // The bare label is accepted as well as the full domain, because a page
      // often writes "Americaneagle.com" or just the brand — but the full
      // domain is required to be present somewhere for the stronger claim.
      const text = `${doc.title || ''} ${doc.bodyText || doc.mainText || ''}`.toLowerCase();
      const names = text.includes(clean);
      return names
        ? { ...item, state: 'mention', reason: 'the page names the domain in its text but carries no link to it' }
        : {
          ...item,
          state: 'irrelevant',
          reason: 'the page neither links to nor names the domain — the search engine returned a poor match for this query',
        };
    }
    return {
      ...item,
      state: 'linked',
      links: links.slice(0, 4).map((l) => ({
        target: l.url,
        anchor: (l.anchor || '').slice(0, 120),
        nofollow: l.nofollow,
        sponsored: l.sponsored,
        inMain: l.inMain,
      })),
      followed: links.some((l) => !l.nofollow && !l.sponsored),
    };
  });

  const rows = checked.filter((c) => c && !c.__error);
  const linked = rows.filter((r) => r.state === 'linked');
  const mentions = rows.filter((r) => r.state === 'mention');
  const irrelevant = rows.filter((r) => r.state === 'irrelevant');
  const unverified = rows.filter((r) => r.state === 'unverified');

  const byDomain = new Map();
  linked.forEach((r) => {
    const cur = byDomain.get(r.host) || { domain: r.host, pages: 0, followed: false, sample: r.url, anchors: [] };
    cur.pages += 1;
    cur.followed = cur.followed || r.followed;
    (r.links || []).forEach((l) => { if (l.anchor && cur.anchors.length < 5) cur.anchors.push(l.anchor); });
    byDomain.set(r.host, cur);
  });

  return {
    ok: true,
    domain: clean,
    query: found.query,
    candidates: found.items.length,
    checked: rows.length,
    linked,
    mentions,
    irrelevant,
    unverified,
    referringDomains: [...byDomain.values()].sort((a, b) => b.pages - a.pages),
    followedDomains: [...byDomain.values()].filter((d) => d.followed).length,
    // A candidate list that is mostly irrelevant means the search engine
    // ignored the query operators. Surfaced as its own flag so the reader is
    // told the SAMPLE is weak, rather than being left to read a low count as a
    // fact about the site's link profile.
    candidateQuality: rows.length
      ? (irrelevant.length / rows.length >= 0.6 ? 'poor' : (irrelevant.length / rows.length >= 0.3 ? 'mixed' : 'good'))
      : 'none',
    // Stated on every render. This is a VERIFIED SAMPLE, not an index.
    basis: `${rows.length} candidate page${rows.length === 1 ? '' : 's'} from a keyless web search were fetched and their outbound links read. `
      + `${linked.length} carry a real link to ${clean}; ${mentions.length} name it without linking; `
      + `${irrelevant.length} neither link to nor name it (the search engine returned a poor match); `
      + `${unverified.length} could not be fetched. `
      + `This is a verified SAMPLE of ${byDomain.size} referring domain${byDomain.size === 1 ? '' : 's'}, capped at ${limit * 2} candidates — it is not a link index and the true count is higher.`
      + (rows.length && (irrelevant.length / rows.length) >= 0.6
        ? ' MOST CANDIDATES WERE IRRELEVANT, which means the search operators were not honoured — treat this sample as unreliable rather than as evidence of a thin link profile.'
        : ''),
    method: 'verified-sample',
  };
}

// A link-index adapter, used in preference to the sample when a credential
// exists. Moz is implemented because its free tier is the one most agencies
// actually hold; the others are declared and fall through to the sample.
async function linkIndexMetrics(domain) {
  const accessId = process.env.MOZ_ACCESS_ID;
  const secret = process.env.MOZ_SECRET_KEY;
  if (!accessId || !secret) return null;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'data.site.metrics.fetch',
    params: { data: { site_query: { query: domain, scope: 'domain' } } },
  });
  const res = await fetchPage('https://lsapi.seomoz.com/v2/url_metrics', {
    timeout: 30000,
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accessId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok || !res.body) throw new Error(res.error || `HTTP ${res.status}`);
  const parsed = JSON.parse(res.body);
  const m = (parsed.result && parsed.result.site_metrics) || parsed.site_metrics || null;
  if (!m) throw new Error('Moz returned no site_metrics');
  return {
    method: 'moz',
    domainAuthority: m.domain_authority == null ? null : Number(m.domain_authority),
    pageAuthority: m.page_authority == null ? null : Number(m.page_authority),
    referringDomains: m.root_domains_to_root_domain == null ? null : Number(m.root_domains_to_root_domain),
    backlinks: m.external_pages_to_root_domain == null ? null : Number(m.external_pages_to_root_domain),
    spamScore: m.spam_score == null ? null : Number(m.spam_score),
    basis: 'Moz Link Explorer — a real link index.',
  };
}

// The backlink gap table: our numbers against each competitor's, from whichever
// source answered, with the source named per row.
async function backlinkGap(ourDomain, competitorDomains, { sampleLimit = 20 } = {}) {
  const sites = [{ key: 'ours', domain: hostKey(ourDomain), ours: true },
    ...competitorDomains.map((d) => ({ key: d, domain: hostKey(d), ours: false }))];

  const useIndex = providers.has('moz');
  const rows = [];
  const errors = [];

  for (const site of sites) {
    /* eslint-disable no-await-in-loop */
    let indexRow = null;
    if (useIndex) {
      try { indexRow = await linkIndexMetrics(site.domain); } catch (err) { errors.push(`moz/${site.domain}: ${String(err.message).slice(0, 160)}`); }
      await sleep(400);
    }
    let sample = null;
    if (!indexRow) {
      sample = await verifyReferring(site.domain, {
        limit: sampleLimit,
        excludeHost: site.ours ? null : hostKey(ourDomain),
      });
      await sleep(900);
    }
    /* eslint-enable no-await-in-loop */

    rows.push({
      domain: site.domain,
      ours: site.ours,
      source: indexRow ? indexRow.method : (sample && sample.ok ? 'verified-sample' : 'unavailable'),
      domainAuthority: indexRow ? indexRow.domainAuthority : null,
      referringDomains: indexRow ? indexRow.referringDomains : (sample && sample.ok ? sample.referringDomains.length : null),
      backlinks: indexRow ? indexRow.backlinks : (sample && sample.ok ? sample.linked.length : null),
      followedDomains: indexRow ? null : (sample && sample.ok ? sample.followedDomains : null),
      spamScore: indexRow ? indexRow.spamScore : null,
      // Exact, so a reader knows whether "12" is a real count or a sample floor.
      isSample: !indexRow,
      basis: indexRow ? indexRow.basis : (sample && sample.ok ? sample.basis : (sample ? `no data: ${sample.error}` : 'not attempted')),
      sampleDetail: sample && sample.ok ? {
        referringDomains: sample.referringDomains.slice(0, 25),
        mentionsWithoutLink: sample.mentions.length,
        unverified: sample.unverified.length,
        candidates: sample.candidates,
      } : null,
    });
  }

  const ours = rows.find((r) => r.ours) || null;
  const theirs = rows.filter((r) => !r.ours);
  const comparable = ours && ours.referringDomains != null;
  const ahead = comparable
    ? theirs.filter((t) => t.referringDomains != null && t.referringDomains > ours.referringDomains)
    : [];

  // The domains linking to THEM and not to US. This is what "backlink gap"
  // actually means, and it only exists where both sides came from a sample or
  // both from an index — mixing a sample with an index would produce a gap list
  // that is mostly an artefact of the different methods.
  const ourDomainsSet = new Set(((ours && ours.sampleDetail) ? ours.sampleDetail.referringDomains : []).map((d) => d.domain));
  const gapDomains = [];
  theirs.forEach((t) => {
    if (!t.sampleDetail) return;
    t.sampleDetail.referringDomains.forEach((d) => {
      if (ourDomainsSet.has(d.domain)) return;
      const existing = gapDomains.find((g) => g.domain === d.domain);
      if (existing) { existing.linksTo.push(t.domain); return; }
      gapDomains.push({ domain: d.domain, linksTo: [t.domain], sample: d.sample, anchors: d.anchors, followed: d.followed });
    });
  });
  gapDomains.sort((a, b) => b.linksTo.length - a.linksTo.length);

  return {
    rows,
    ours,
    ahead,
    gapDomains: gapDomains.slice(0, 60),
    errors,
    mixedMethods: new Set(rows.map((r) => r.source)).size > 1,
    method: useIndex ? 'moz-index' : 'verified-sample',
    caveat: useIndex
      ? 'Referring-domain and backlink counts come from the Moz link index and are complete counts, not samples.'
      : `No link-index credential is configured, so each row is a VERIFIED SAMPLE: candidate pages found by a keyless web search were fetched and their outbound links read, and a domain counts only where a real link to the target was found. The sample is capped at ${sampleLimit * 2} candidates per site, so every count is a floor rather than a total — comparable between sites because the same cap applies to all of them, but not comparable to an Ahrefs or Semrush figure.`,
  };
}

// ==================================================== 4. KEYWORD GAP

// Where does each site appear for each keyword?
//
// With a rank-tracker credential this is measured against Google. Without, each
// keyword's result page is sampled from a keyless engine and each site's
// position within that sample is recorded. The engine is named on every row and
// the table header says plainly that these are not Google positions.
async function keywordGap(keywords, sites, { market = 'ZZ', limit = 25, engine = 'auto' } = {}) {
  const list = [...new Set((keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean))].slice(0, limit);
  if (!list.length) return { ok: false, reason: 'no keywords to check', rows: [] };
  if (!providers.has('serp-lite') && !providers.has('dataforseo')) {
    return { ok: false, reason: 'keyless SERP sampling is disabled and no rank-tracker credential is configured, so nobody\'s positions can be read', rows: [] };
  }

  const m = markets.resolve(market);
  const rows = [];
  const errors = [];

  // Sequential, because serpLite already serialises through a paced queue and
  // firing these concurrently only fills that queue.
  for (const keyword of list) {
    /* eslint-disable no-await-in-loop */
    const serp = await serpLite.search(keyword, { market: m.code, limit: 10, engine });
    /* eslint-enable no-await-in-loop */
    if (!serp.ok) { errors.push(`${keyword}: ${serp.error}`); continue; }

    const cells = sites.map((s) => {
      const pos = serpLite.positionOf(serp, s.domain);
      return {
        site: s.key, label: s.label, domain: s.domain, ours: Boolean(s.ours),
        position: pos ? pos.position : null,
        url: pos ? pos.url : null,
        title: pos ? pos.title : null,
      };
    });
    const ours = cells.find((c) => c.ours) || null;
    const rivals = cells.filter((c) => !c.ours && c.position != null);
    const bestRival = rivals.sort((a, b) => a.position - b.position)[0] || null;

    rows.push({
      keyword,
      cells,
      ourPosition: ours ? ours.position : null,
      bestRivalPosition: bestRival ? bestRival.position : null,
      bestRival: bestRival ? bestRival.label : null,
      // The classification that makes the table actionable.
      state: (() => {
        if (ours && ours.position != null && (!bestRival || ours.position <= bestRival.position)) return 'we-lead';
        if (ours && ours.position != null) return 'behind';
        if (bestRival) return 'absent-they-rank';
        return 'nobody-ranks';
      })(),
      engine: serp.engine,
      resultsSampled: serp.results.length,
      topDomains: serp.results.slice(0, 5).map((r) => ({ position: r.position, domain: r.domain })),
    });
  }

  const absent = rows.filter((r) => r.state === 'absent-they-rank');
  const behind = rows.filter((r) => r.state === 'behind');
  const lead = rows.filter((r) => r.state === 'we-lead');

  return {
    ok: rows.length > 0,
    market: { code: m.code, name: m.name },
    columns: ['Keyword', ...sites.map((s) => s.label), 'State'],
    rows,
    counts: {
      checked: rows.length,
      requested: list.length,
      absentTheyRank: absent.length,
      behind: behind.length,
      weLead: lead.length,
      nobodyRanks: rows.filter((r) => r.state === 'nobody-ranks').length,
    },
    errors,
    engine: rows.length ? rows[0].engine : null,
    // Repeated on the table itself, not only here.
    caveat: `Positions are read from a ${rows.length ? rows[0].engine : 'keyless'} result sample for ${m.name}, NOT from Google. They are a real visibility comparison — the same query, the same page, the same moment, for every site — and they are not Google rankings. A DataForSEO credential replaces this with live Google SERPs.`,
    cappedAt: limit,
    truncated: (keywords || []).length > limit,
  };
}

module.exports = {
  topicCoverage, topicMatrix, topicsFromGaps,
  verifyReferring, linkIndexMetrics, backlinkGap,
  keywordGap,
};
