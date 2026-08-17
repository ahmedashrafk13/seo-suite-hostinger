// Anchor discovery (verbatim only) and the recommendation engine.
//
// Ported from target_phrases(), title_segments(), _sentence_supports_target(),
// find_anchor() and recommend() in internal_link_agent.py.
//
// The spaCy NER rejection pass is deliberately not ported: it is optional in the
// Python (a no-op when spaCy is absent, which it is on any host that cannot pip
// install), so omitting it reproduces the behaviour of the environments this
// build targets. ner_anchor_rejections is reported as 0, exactly as it is on a
// machine without the model installed.
const { L, TIER_ORDER, ANCHOR_TAIL_PREPOSITIONS, PROSE_TAGS } = require('./config');
const { urlSlugWords, tokenize } = require('./urls');
const { topicH1, anchorConflicts, splitSentences } = require('./parse');
const { ngrams } = require('./analysis');

// Segments of a title, split on punctuation. n-grams must never span one of
// these boundaries: "Pricing | Acme Web Design" would otherwise yield the
// cross-boundary gram "pricing acme".
const SEGMENT_SPLIT = /\s*(?:\||»|·|–|—|::|•|,|;|:|\(|\)|\[|\]|\/)\s*|\s+-\s+/;
function titleSegments(text) {
  return String(text || '').split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

// Ranked candidate anchor phrases that genuinely describe this target page.
//
// Candidates come only from the target's own H1, title and URL slug — the three
// places that state what a page is about. Arbitrary high-TF-IDF body words are
// deliberately excluded: a word like "release" may be statistically distinctive
// yet says nothing about the target, and makes a misleading anchor.
function targetPhrases(page, brandlessTitle, brand, discriminating = null, uniqueTokens = null) {
  const phrases = [];
  const seen = new Set();
  const slug = urlSlugWords(page.url).filter((w) => !L.STOPWORDS.has(w));
  const slugSet = new Set(slug);
  const brandTokens = brand.brand_tokens;
  const labelTokens = brand.label_tokens;
  const brandLow = String(brand.brand_name || '').toLowerCase().trim();

  const add = (rawText, weight) => {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim()
      .replace(/^[\s\t–—\-|:,.]+|[\s\t–—\-|:,.]+$/g, '');
    if (!text) return;
    const low = text.toLowerCase();
    if (seen.has(low) || L.GENERIC_ANCHORS.has(low)) return;
    const wordList = low.split(' ');
    if (!(wordList.length >= 1 && wordList.length <= 8) || low.length < 6) return;
    if (wordList.every((w) => L.STOPWORDS.has(w))) return;

    // Never anchor on the site name, and never let a brand word bleed into an
    // anchor — "acme plumbing services" is a brand mention, not a topical
    // anchor. A brand word is tolerated only when the target's own URL slug
    // contains it too.
    if (brandLow && (low === brandLow || low.includes(brandLow))) return;
    const contentWords = wordList.filter((w) => !L.STOPWORDS.has(w));
    if (contentWords.some((w) => brandTokens.has(w) && !slugSet.has(w))) return;
    // A phrase made only of shared section labels describes a whole series.
    if (contentWords.length && contentWords.every((w) => labelTokens.has(w) || brandTokens.has(w))) return;
    // A single word is only acceptable when it is specific: long enough, not
    // generic, and corroborated by the target's own URL slug.
    if (contentWords.length < 2) {
      const solo = contentWords[0] || '';
      if (solo.length < 6 || !slugSet.has(solo)) return;
    }
    // The phrase must name what makes this page different from its siblings.
    // "web development company" describes 30 city pages equally well; only
    // "web development company houston" identifies one of them.
    if (discriminating && discriminating.size && !contentWords.some((w) => discriminating.has(w))) return;
    // It must also share a word with the target's own URL slug. The URL is the
    // most stable statement a page makes about its subject, and this single
    // rule catches the worst class of error: a phrase lifted from a page's own
    // markup that describes something else entirely.
    if (slugSet.size && !contentWords.some((w) => slugSet.has(w))) return;
    // At least one word must describe the SUBJECT, not the format or the sales
    // pitch. "comprehensive guide" and "choosing the right" are both real
    // phrases from real titles, and both are useless as anchors.
    if (contentWords.every((w) => L.GENERIC_CONTENT_WORDS.has(w))) return;
    // A phrase bounded by a determiner or attributive adjective is a fragment
    // cut out of a longer title, not a noun phrase.
    if (L.DANGLING_TAIL_WORDS.has(wordList[wordList.length - 1]) || L.DANGLING_TAIL_WORDS.has(wordList[0])) return;
    // An auxiliary or modal verb cannot sit inside a noun phrase, so its
    // presence means the candidate straddles a clause boundary.
    if (wordList.some((w) => L.CLAUSE_VERBS.has(w))) return;
    // A phrase ending in "<preposition> <word>" is a prepositional tail sliced
    // out of a longer title, not a usable anchor.
    if (wordList.length >= 2 && ANCHOR_TAIL_PREPOSITIONS.has(wordList[wordList.length - 2])) return;
    // An anchor that ends on a fragment of the brand name is a truncated brand
    // mention. Either the whole brand name is present or none of it.
    if (brandTokens.has(wordList[wordList.length - 1]) && !(brandLow && low.includes(brandLow))) return;
    // When the page has a word no other page's identity contains, the anchor
    // has to include it. Otherwise the anchor names a category rather than this
    // page — "development agencies" for the New York agency page.
    if (uniqueTokens && uniqueTokens.size && !contentWords.some((w) => uniqueTokens.has(w))) return;

    seen.add(low);
    phrases.push([weight, text]);
  };

  add(topicH1(page), 10);
  add(brandlessTitle, 9);
  // Per-segment n-grams: never span a punctuation boundary.
  for (const seg of titleSegments(topicH1(page))) {
    for (const gram of ngrams(tokenize(seg), 2, 5)) add(gram, 7);
  }
  for (const seg of titleSegments(brandlessTitle)) {
    for (const gram of ngrams(tokenize(seg), 2, 5)) add(gram, 6);
  }
  if (slug.length) {
    add(slug.slice(-4).join(' '), 5);
    for (const gram of ngrams(slug, 2, 4)) add(gram, 4);
  }
  // Prefer longer, more descriptive anchors at equal weight.
  phrases.sort((a, b) => (b[0] - a[0]) || (b[1].length - a[1].length));
  return phrases.map(([, p]) => p);
}

// Does the sentence hosting the anchor actually talk about the target page?
//
// Without this test the tool finds the words "development services" in a
// sentence about Liferay and links them to an Enterprise WordPress page. The
// anchor is verbatim and the offsets are exact, and the recommendation is still
// wrong: "verbatim" is a guarantee about honesty, not about relevance.
//
// The anchor's own words are removed before the comparison. Left in, the test
// is circular — the anchor is required to contain a token identifying the
// target, so it would always satisfy a test for that same token.
function sentenceSupportsTarget(sentence, target, minTerms, anchor = '') {
  if (minTerms <= 0) return true;
  const anchorToks = new Set(tokenize(anchor));
  const sentToks = new Set(tokenize(sentence).filter((t) => !anchorToks.has(t)));
  if (!sentToks.size) return false;
  // Signals are the target's DISCRIMINATING identity tokens plus its top TF-IDF
  // terms. The raw URL slug is deliberately not used: it contains the same
  // generic words as every sibling page, and including it let a sentence about
  // Liferay development satisfy the test for a WordPress page.
  let signals = new Set([...target.discriminating, ...target.top_terms.slice(0, 8)]);
  for (const t of L.STOPWORDS) signals.delete(t);
  if (!signals.size) {
    // Nothing distinctive is known about the target. Fall back to the slug
    // rather than accepting anything, and accept this is the weakest case.
    signals = new Set(urlSlugWords(target.url).filter((t) => !L.STOPWORDS.has(t)));
  }
  if (!signals.size) return false;
  let hits = 0;
  for (const t of sentToks) if (signals.has(t)) hits += 1;
  return hits >= minTerms;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate a verbatim occurrence of one of `phrases` in the source page's body
// copy that is not already inside a link, does not overlap a span already
// reserved by another recommendation for this page, and sits in a sentence
// genuinely about `target`.
function findAnchor(source, phrases, reserved, nerStats, target, cfg, usedAnchors, rejectStats) {
  const bump = (key) => {
    if (rejectStats) rejectStats[key] = (rejectStats[key] || 0) + 1;
  };
  const minTerms = target ? (cfg || {}).anchor_sentence_terms || 0 : 0;

  for (const phrase of phrases) {
    const plow = phrase.trim().toLowerCase();
    // Refuse a phrase already used as an anchor on this page for a DIFFERENT
    // destination. Pointing the same words at the page the nav already links to
    // is NOT a conflict, and refusing it threw away the most natural anchor.
    if (target) {
      if (anchorConflicts(source, plow, target.url)) { bump('anchor_conflict'); continue; }
    } else if (source.anchor_dests.has(plow)) {
      continue;
    }
    // One source page must never use the same anchor string for two different
    // recommendations, even from two different paragraphs.
    if (usedAnchors && usedAnchors.has(plow)) { bump('anchor_reused_on_source'); continue; }

    // Word-boundary match that tolerates any run of whitespace between words.
    // (?<![^\W_]) / (?![^\W_]) is Python's letter-or-digit boundary; the
    // JavaScript equivalent uses the same character class.
    const pattern = new RegExp(
      `(?<![^\\W_])${escapeRegex(phrase).replace(/\\ |\s/g, '[\\s ]+')}(?![^\\W_])`,
      'gi'
    );

    for (let bi = 0; bi < source.blocks.length; bi += 1) {
      const block = source.blocks[bi];
      if (block.tag.startsWith('h')) continue;      // never turn a heading into a link
      if (!PROSE_TAGS.has(block.tag)) continue;     // table cell / caption is not prose
      if (block.shared) continue;                   // duplicated copy — a link here edits a template
      if (block.text.length < 60) continue;

      pattern.lastIndex = 0;
      let m = pattern.exec(block.text);
      while (m) {
        let s = m.index;
        const e = m.index + m[0].length;
        // Candidate phrases are built from word tokens, so a leading number is
        // lost ("5-day challenge" -> "day challenge"). Put it back so the
        // anchor reads naturally.
        const lead = /(\d+[-‐-―\s]?)$/.exec(block.text.slice(0, s));
        if (lead) s = lead.index;

        const overlapsLink = block.link_spans.some((sp) => s < sp[1] && sp[0] < e);
        if (!overlapsLink) {
          // The leading-number expansion can change the matched string, so
          // re-check the string we actually ended up with.
          const finalLow = block.text.slice(s, e).trim().toLowerCase();
          let rejected = false;
          if (target) {
            if (anchorConflicts(source, finalLow, target.url)) { bump('anchor_conflict'); rejected = true; }
          } else if (source.anchor_dests.has(finalLow)) {
            rejected = true;
          }
          if (!rejected && usedAnchors && usedAnchors.has(finalLow)) {
            bump('anchor_reused_on_source');
            rejected = true;
          }
          if (!rejected && reserved.some(([rb, rs, re_]) => bi === rb && s < re_ && rs < e)) {
            rejected = true;
          }

          if (!rejected) {
            // Walk sentence offsets with a cursor. indexOf from 0 returns the
            // first occurrence, so a repeated sentence in one block selected the
            // wrong one — and a -1 result made the range test accidentally true,
            // attaching an unrelated sentence as "context".
            let sentence = block.text;
            let cur = 0;
            for (const sent of splitSentences(block.text)) {
              const pos = block.text.indexOf(sent, cur);
              if (pos < 0) continue;
              cur = pos + sent.length;
              if (pos <= s && s < pos + sent.length) { sentence = sent; break; }
            }
            // Last gate, and the one that separates a correct recommendation
            // from a merely well-formed one: the sentence must be talking about
            // the target.
            if (target && !sentenceSupportsTarget(sentence, target, minTerms, block.text.slice(s, e))) {
              bump('sentence_off_topic');
            } else {
              return {
                anchor_text: block.text.slice(s, e),
                matched_phrase: phrase,
                block_index: bi,
                block_tag: block.tag,
                char_start: s,
                char_end: e,
                context_sentence: sentence,
              };
            }
          }
        }
        m = pattern.exec(block.text);
      }
    }
  }
  return null;
}

// Percentile with ties averaged. A naive rank would spread tied values evenly
// across 0..1, so on a site with no editorial links — where every page has an
// identical PageRank of 1/n — it would invent a ranking and let the tool claim
// some pages are "top-quartile authority" purely by crawl order.
function tieAveragedPercentile(values) {
  const n = values.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let lower = 0;
    let equal = 0;
    for (let j = 0; j < n; j += 1) {
      if (values[j] > values[i]) lower += 1;
      else if (values[j] === values[i]) equal += 1;
    }
    out[i] = (n - lower - equal / 2) / (n || 1);
  }
  return out;
}

function stdev(values) {
  const n = values.length;
  if (!n) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
}

function recommend(pages, urls, sim, graph, cannibal, cfg, brand, dupPages,
  nerStats, gsc, rejectStatsIn) {
  const idx = graph.idx;
  const existing = graph.existing_pairs;
  const sitewide = graph.sitewide;
  const brandlessByUrl = brand.clean_title;
  const rejectStats = rejectStatsIn || {};

  const cannibalPairs = new Set();
  for (const row of cannibal) {
    cannibalPairs.add(`${row.page_a} ${row.page_b}`);
    cannibalPairs.add(`${row.page_b} ${row.page_a}`);
  }

  // The report has always promised that pages competing for the same primary
  // keyword are never recommended to link to each other. That promise was being
  // enforced only through the cannibalization list — and a pair only gets onto
  // that list when its similarity clears cannibal_kw_min_sim. Two pages with the
  // IDENTICAL derived keyword and a similarity of 0.25 were therefore never
  // flagged AND freely allowed to link to each other, on that very keyword. The
  // ban has to be stated independently of the reporting threshold.
  const sameKw = new Map();
  for (const u of urls) {
    const kw = String(pages.get(u).primary_keyword || '').trim().toLowerCase();
    if (!kw) continue;
    if (!sameKw.has(kw)) sameKw.set(kw, new Set());
    sameKw.get(kw).add(u);
  }
  const keywordRivals = new Map();
  const contestedKeywords = new Set();
  for (const [kw, group] of sameKw) {
    if (group.size < 2) continue;
    contestedKeywords.add(kw);
    for (const u of group) {
      if (!keywordRivals.has(u)) keywordRivals.set(u, new Set());
      for (const other of group) if (other !== u) keywordRivals.get(u).add(other);
    }
  }

  // A phrase that is a candidate anchor for several different pages identifies
  // none of them. Count how many pages claim each phrase and drop the shared
  // ones before a single recommendation is generated.
  const rawPhrases = new Map();
  for (const u of urls) {
    const p = pages.get(u);
    rawPhrases.set(u, targetPhrases(p, brandlessByUrl.get(u) || p.title, brand,
      p.discriminating, p.unique_tokens));
  }
  const phraseOwners = new Map();
  for (const plist of rawPhrases.values()) {
    for (const ph of new Set(plist.map((p) => p.toLowerCase()))) {
      phraseOwners.set(ph, (phraseOwners.get(ph) || 0) + 1);
    }
  }
  const maxOwners = Math.max(1, Math.floor(cfg.anchor_max_owners));
  let ambiguousDropped = 0;
  for (const [u, plist] of rawPhrases) {
    const kept = plist.filter((p) => (phraseOwners.get(p.toLowerCase()) || 0) <= maxOwners);
    ambiguousDropped += plist.length - kept.length;
    rawPhrases.set(u, kept);
  }
  rejectStats.ambiguous_phrases_dropped = ambiguousDropped;

  const prValues = urls.map((u) => pages.get(u).pagerank);
  const prPctArr = tieAveragedPercentile(prValues);
  const prPct = new Map(urls.map((u, i) => [u, prPctArr[i]]));
  const prHasVariance = Boolean(urls.length && stdev(prValues) > 1e-12);

  const slugTokenDf = new Map();
  for (const u of urls) {
    for (const t of new Set(urlSlugWords(u))) slugTokenDf.set(t, (slugTokenDf.get(t) || 0) + 1);
  }

  const phrasesFor = (u) => rawPhrases.get(u) || [];

  // Phrases the SOURCE page owns for itself. Handing one of these to another
  // page as anchor text is self-sabotage.
  const sourceOwned = (u) => {
    const own = new Set((rawPhrases.get(u) || []).map((p) => p.toLowerCase()));
    const kw = String(pages.get(u).primary_keyword || '').trim().toLowerCase();
    if (kw) own.add(kw);
    return own;
  };

  // Qualifier tokens the target's URL is built around that this anchor drops.
  // Reported, not suppressed: the recommendation is still true, but the reader
  // is not told the page is about New York, and whoever implements the link
  // should know that before they paste it in.
  const anchorOmissions = (anchor, tgt) => {
    const key = pages.get(tgt).key_slug_tokens;
    if (!key.size) return '';
    const have = new Set(tokenize(anchor));
    for (const t of have) if (key.has(t)) return '';
    // Rarest first, so the most informative qualifier leads.
    const missing = Array.from(key).sort((a, b) => {
      const da = slugTokenDf.get(a) || 0;
      const db = slugTokenDf.get(b) || 0;
      return (da - db) || a.localeCompare(b);
    });
    return missing.slice(0, 3).join(', ');
  };

  const validTarget = (u) => {
    const p = pages.get(u);
    // A page that serves another page's content cannot meaningfully receive a
    // topical link, and its title/H1 describe the wrong page.
    if (dupPages.has(u)) return false;
    if (p.noindex) return false;
    if (p.status !== 200) return false;
    // A page whose rel=canonical names a different URL is asking not to be
    // indexed under this address.
    if (p.canonical && p.canonical !== u) return false;
    if (p.kind !== 'content') return false;
    if (sitewide.has(u)) return false;
    if (p.word_count < cfg.min_content_words) return false;
    if (p.zero_vector) return false;
    return true;
  };

  const sourceAllowance = (u) => {
    const p = pages.get(u);
    if (p.word_count < cfg.min_source_words) return 0;
    if (p.noindex || dupPages.has(u)) return 0;
    // A paginated archive or tag listing is template output. Its copy is post
    // excerpts owned by other pages, so "edit this sentence" is not an
    // instruction anyone can carry out there.
    if (p.kind !== 'content') return 0;
    if (p.canonical && p.canonical !== u) return 0;
    const densityCap = Math.max(0, Math.floor(p.word_count / cfg.words_per_link) - p.outbound_editorial);
    const saturationCap = Math.max(0, cfg.max_editorial_out_per_page - p.outbound_editorial);
    return Math.floor(Math.min(cfg.max_new_links_per_source, densityCap, saturationCap));
  };

  const candidates = [];
  const n = urls.length;
  const topK = Math.min(cfg.top_k_similar, Math.max(1, n - 1));

  // True when the crawl found no in-content links anywhere. Several signals
  // below become constants in that case and must not be presented as if they
  // discriminated between candidates.
  const noEditorialGraph = graph.editorial_edges.size === 0;

  const needOf = new Map();
  for (const u of urls) {
    const ib = pages.get(u).inbound_editorial;
    needOf.set(u, Math.max(0, 1 - ib / cfg.max_new_inbound_per_target));
  }

  // GSC opportunity: impressions weighted by a continuous position decay (no
  // hard cliff at position 10/11), then percentile-ranked the same way as
  // PageRank — a single viral page must not dominate via min-max scaling.
  let oppPct = new Map();
  let gscHasVariance = false;
  if (gsc && gsc.by_url && Object.keys(gsc.by_url).length) {
    const oppRaw = urls.map((u) => {
      const row = gsc.by_url[u] || {};
      const impressions = row.impressions || 0;
      const position = row.position === undefined ? 100 : row.position;
      return impressions * (1 / (1 + position / 10));
    });
    const arr = tieAveragedPercentile(oppRaw);
    oppPct = new Map(urls.map((u, i) => [u, arr[i]]));
    gscHasVariance = stdev(oppRaw) > 1e-12;
  }

  for (let i = 0; i < urls.length; i += 1) {
    const src = urls[i];
    if (sourceAllowance(src) <= 0) continue;
    const own = sourceOwned(src);
    // Descending similarity order for this row.
    const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => sim[i][b] - sim[i][a]);
    let taken = 0;
    for (const j of order) {
      if (j === i) continue;
      // break, not continue: the row is sorted descending, so once enough
      // eligible neighbours have been considered nothing further can qualify.
      if (taken >= topK) break;
      const tgt = urls[j];
      const s = sim[i][j];
      if (s < cfg.min_similarity) break;
      if (!validTarget(tgt)) continue;
      // Only ELIGIBLE neighbours consume the top-k budget. Counting rejected
      // ones meant that on a site with a large menu the k slots were spent
      // entirely on pages that could never be recommended.
      taken += 1;
      if (existing.has(`${src} ${tgt}`)) continue;
      if (existing.has(`${tgt} ${src}`)) continue;   // no reciprocal link pairs
      if (cannibalPairs.has(`${src} ${tgt}`)) continue;
      if ((keywordRivals.get(src) || new Set()).has(tgt)) {
        rejectStats.same_primary_keyword = (rejectStats.same_primary_keyword || 0) + 1;
        continue;
      }

      let phraseList = phrasesFor(tgt).filter((p) => !own.has(p.toLowerCase()));
      if (!phraseList.length) {
        // No defensible way to describe this target in anchor text, so we
        // decline to guess one rather than emit a misleading suggestion.
        rejectStats.no_distinctive_phrase = (rejectStats.no_distinctive_phrase || 0) + 1;
        continue;
      }
      // An anchor must never BE a keyword that two or more pages contest.
      phraseList = phraseList.filter((p) => !contestedKeywords.has(p.toLowerCase()));
      if (!phraseList.length) {
        rejectStats.phrase_is_contested_keyword = (rejectStats.phrase_is_contested_keyword || 0) + 1;
        continue;
      }

      const anchor = findAnchor(pages.get(src), phraseList, [], nerStats,
        pages.get(tgt), cfg, null, rejectStats);
      let confidence;
      if (anchor) {
        // A one-word anchor is inherently weaker: a common word like "pricing"
        // can appear in a sentence that has nothing to do with the target.
        const w = tokenize(anchor.anchor_text).filter((x) => !L.STOPWORDS.has(x));
        confidence = w.length >= 2 ? 'high' : 'single-word';
      } else {
        confidence = 'needs-new-sentence';
      }

      const reasonBits = [`topical similarity ${s.toFixed(2)}`];
      // A reason that is true of EVERY recommendation explains nothing. When
      // the site has no editorial links at all, every target has zero editorial
      // inbound links, so this clause would fire on every recommendation —
      // reading as justification while carrying no information.
      if (noEditorialGraph) {
        // suppressed; the site-level note covers it instead
      } else if (pages.get(tgt).inbound_editorial === 0) {
        reasonBits.push('target is an orphan (0 editorial inbound links)');
      } else if (pages.get(tgt).inbound_editorial < 3) {
        reasonBits.push(`target is under-linked (${pages.get(tgt).inbound_editorial} editorial inbound)`);
      }
      if (prHasVariance && prPct.get(src) >= 0.75) {
        reasonBits.push('source is a high-authority page (top-quartile internal PageRank)');
      }
      if (gscHasVariance && (oppPct.get(tgt) || 0) >= 0.75) {
        reasonBits.push('target has high GSC search opportunity (top-quartile impressions/position)');
      }

      let score;
      if (gsc && gsc.by_url && Object.keys(gsc.by_url).length) {
        // Weights reduced proportionally (x0.85) to make room for the 0.15
        // opportunity term while still summing to 1.0.
        score = 0.425 * Math.min(s / 0.35, 1)
          + 0.255 * needOf.get(tgt)
          + 0.170 * (prHasVariance ? prPct.get(src) : 0.5)
          + 0.150 * (gscHasVariance ? (oppPct.get(tgt) || 0) : 0);
      } else {
        score = 0.50 * Math.min(s / 0.35, 1)
          + 0.30 * needOf.get(tgt)
          + 0.20 * (prHasVariance ? prPct.get(src) : 0.5);
      }
      if (!anchor) score *= 0.55;
      // An anchor that drops the target's URL qualifier is a weaker
      // recommendation and is scored as such, so better anchors sort to the top.
      if (anchor && anchorOmissions(anchor.anchor_text, tgt)) score *= 0.85;

      candidates.push({
        source_url: src,
        target_url: tgt,
        similarity: Number(s.toFixed(4)),
        score: Number(score.toFixed(4)),
        confidence,
        anchor_text: anchor ? anchor.anchor_text : phraseList[0],
        anchor_source: anchor
          ? 'verbatim text already on the source page'
          : 'REQUIRES NEW SENTENCE - phrase not present on source page',
        context_sentence: anchor ? anchor.context_sentence : '',
        block_index: anchor ? anchor.block_index : -1,
        char_start: anchor ? anchor.char_start : -1,
        char_end: anchor ? anchor.char_end : -1,
        reason: reasonBits.join('; '),
        target_title: pages.get(tgt).title,
        target_inbound_editorial: pages.get(tgt).inbound_editorial,
        source_words: pages.get(src).word_count,
        source_existing_editorial_out: pages.get(src).outbound_editorial,
        _anchor_obj: anchor,
      });
    }
  }

  // ---- greedy selection under caps ---------------------------------------
  // Tie-break explicitly. When a site has no editorial links, `needOf` is 1.0
  // for every target and PageRank has no variance, so the score collapses to a
  // handful of distinct values. Sorting on score alone then left `priority`
  // 2..58 in whatever order the pairs happened to be generated, while
  // presenting it as a ranking.
  candidates.sort((a, b) => {
    const ta = TIER_ORDER[a.confidence] === undefined ? 9 : TIER_ORDER[a.confidence];
    const tb = TIER_ORDER[b.confidence] === undefined ? 9 : TIER_ORDER[b.confidence];
    if (ta !== tb) return ta - tb;
    if (b.score !== a.score) return b.score - a.score;
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if (a.source_url !== b.source_url) return a.source_url.localeCompare(b.source_url);
    return a.target_url.localeCompare(b.target_url);
  });

  const perSource = new Map();
  const perTarget = new Map();
  const perAnchor = new Map();
  const allowance = new Map(urls.map((u) => [u, sourceAllowance(u)]));
  const reservedSpans = new Map();
  // Anchor strings already committed on each source page. One page must not
  // carry the same anchor twice: emitting "web development company" from one
  // source to the Houston page AND to the Austin page is both ambiguous to a
  // reader and a duplicate-anchor signal.
  const usedOnSource = new Map();
  const chosen = [];
  const chosenPairs = new Set();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const c of candidates) {
    const src = c.source_url;
    const tgt = c.target_url;
    if (chosenPairs.has(`${src} ${tgt}`) || chosenPairs.has(`${tgt} ${src}`)) continue;
    if ((perSource.get(src) || 0) >= (allowance.get(src) || 0)) continue;
    if ((perTarget.get(tgt) || 0) >= cfg.max_new_inbound_per_target) continue;

    if (c._anchor_obj) {
      // Re-resolve against spans and anchor strings already committed on this
      // source page. This can land on a different (often shorter) phrase than
      // the first pass, so the tier label must be recomputed from the anchor we
      // actually ended up with — otherwise a one-word anchor can be reported as
      // a "descriptive multi-word" recommendation.
      const ownSrc = sourceOwned(src);
      const freshPhrases = phrasesFor(tgt).filter(
        (p) => !ownSrc.has(p.toLowerCase()) && !contestedKeywords.has(p.toLowerCase())
      );
      if (!reservedSpans.has(src)) reservedSpans.set(src, []);
      if (!usedOnSource.has(src)) usedOnSource.set(src, new Set());
      const fresh = findAnchor(pages.get(src), freshPhrases, reservedSpans.get(src), nerStats,
        pages.get(tgt), cfg, usedOnSource.get(src), rejectStats);
      if (!fresh) continue;
      const w = tokenize(fresh.anchor_text).filter((x) => !L.STOPWORDS.has(x));
      c.anchor_text = fresh.anchor_text;
      c.context_sentence = fresh.context_sentence;
      c.block_index = fresh.block_index;
      c.char_start = fresh.char_start;
      c.char_end = fresh.char_end;
      c.confidence = w.length >= 2 ? 'high' : 'single-word';
    }
    delete c._anchor_obj;

    // Computed from the FINAL anchor, after the re-resolve above may have
    // landed on a different phrase than the first pass chose.
    c.anchor_omits = anchorOmissions(c.anchor_text, tgt);
    if (c.anchor_omits) {
      c.reason = `${c.reason}; anchor does not mention "${c.anchor_omits}" from the `
        + "target's URL - consider extending it";
    }
    const anchorKey = c.anchor_text.trim().toLowerCase();
    // Cap exact-anchor reuse using the FINAL anchor string, so the count that is
    // enforced and the count that is charged are the same key.
    if ((perAnchor.get(anchorKey) || 0) >= cfg.max_same_anchor) continue;
    if (!usedOnSource.has(src)) usedOnSource.set(src, new Set());
    if (usedOnSource.get(src).has(anchorKey)) continue;

    if (c.confidence !== 'needs-new-sentence') {
      if (!reservedSpans.has(src)) reservedSpans.set(src, []);
      reservedSpans.get(src).push([c.block_index, c.char_start, c.char_end]);
      usedOnSource.get(src).add(anchorKey);
    }
    chosen.push(c);
    chosenPairs.add(`${src} ${tgt}`);
    bump(perSource, src);
    bump(perTarget, tgt);
    bump(perAnchor, anchorKey);
  }

  candidates.forEach((c) => { delete c._anchor_obj; });

  chosen.sort((a, b) => {
    const ta = TIER_ORDER[a.confidence] === undefined ? 9 : TIER_ORDER[a.confidence];
    const tb = TIER_ORDER[b.confidence] === undefined ? 9 : TIER_ORDER[b.confidence];
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  });
  chosen.forEach((c, i) => { c.priority = i + 1; });
  return { recs: chosen, rejectStats };
}

module.exports = {
  titleSegments, targetPhrases, sentenceSupportsTarget, findAnchor,
  recommend, tieAveragedPercentile, stdev,
};
