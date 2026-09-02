// Deterministic text analysis shared by the AI SEO features.
//
// Everything here runs locally, costs nothing and returns the same answer
// twice. That matters more than it sounds: the on-page scorer, the freshness
// detector, the competitor gap analysis and the reputation scanner all need
// "how similar are these two texts", "what entities does this mention" and
// "how readable is this" — and if each asked an AI model instead, the same
// page would score differently on Tuesday, the spend cap would be gone in an
// afternoon, and nobody could explain a score to a client.
//
// The AI layer (./aiCalls.js) sits ON TOP of this: it explains and rewrites,
// it never measures. Measurement stays here.

// ------------------------------------------------------------- tokenisation
const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be
because been before being below between both but by can cannot could couldn't
did didn't do does doesn't doing don't down during each few for from further
had hadn't has hasn't have haven't having he her here hers herself him himself
his how i if in into is isn't it its itself let's me more most mustn't my
myself no nor not of off on once only or other ought our ours ourselves out
over own same shan't she should shouldn't so some such than that the their
theirs them themselves then there these they this those through to too under
until up very was wasn't we were weren't what when where which while who whom
why with won't would wouldn't you your yours yourself yourselves
`.trim().split(/\s+/));

// Words that look like entities to a naive capitalisation rule but are not.
// Without this list every sentence-initial "The", "This" and "How" is counted
// as a named entity and entity density becomes a measure of sentence count.
const NOT_ENTITIES = new Set(`
the this that these those there here how what when where why who which
a an and or but if then so because we you they it its our your their his her
in on at for from with without about into over under between during before
after above below all any both each few more most other some such no nor not
only own same than too very can will just don should now new best top guide
free how-to tips why-you when-to
`.trim().split(/\s+/).map((w) => w.toLowerCase()));

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

function contentWords(text) {
  return words(text).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Light English suffix stripping. Not a real stemmer — deliberately. An
// aggressive stemmer collapses "certification" and "certified" onto "certif",
// which is right for recall and wrong for the entity-coverage report a human
// reads, where those are different words a page may be missing.
function stem(word) {
  let w = String(word || '');
  if (w.length <= 4) return w;
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'est', 'ly', 'es', 's']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  }
  if (w.endsWith('i')) w = `${w.slice(0, -1)}y`;
  return w;
}

// ----------------------------------------------------------------- n-grams
function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

// Phrases worth reporting: 2-3 word runs of content words, ranked by frequency.
// Runs are cut at stopwords and punctuation so "certification for finance
// professionals" does not become the phrase "for finance".
function keyPhrases(text, { minCount = 2, limit = 40 } = {}) {
  const sentencesList = sentences(text);
  const counts = new Map();
  sentencesList.forEach((s) => {
    const toks = words(s);
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        [2, 3].forEach((n) => ngrams(run, n).forEach((g) => counts.set(g, (counts.get(g) || 0) + 1)));
      }
      run = [];
    };
    toks.forEach((t) => {
      if (STOPWORDS.has(t) || t.length < 3) flush();
      else run.push(t);
    });
    flush();
  });
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

// -------------------------------------------------------------- similarity
function termFrequency(text) {
  const tf = new Map();
  contentWords(text).map(stem).forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  return tf;
}

// Cosine similarity over raw term frequencies, L2-normalised. Used for
// "does this draft cover what the competitors cover" and "has this page's
// topic drifted", both of which want direction, not magnitude — a 400-word
// page and a 4,000-word page about the same thing should score as similar.
function cosine(tfA, tfB) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  tfA.forEach((v) => { na += v * v; });
  tfB.forEach((v, k) => {
    nb += v * v;
    const a = tfA.get(k);
    if (a) dot += a * v;
  });
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  let inter = 0;
  setA.forEach((v) => { if (setB.has(v)) inter += 1; });
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

// Jensen-Shannon divergence between two discrete distributions, in bits.
//
// This is the measure behind intent-drift detection. Two candidates were
// considered and rejected: comparing top-10 query lists (misses a shift that
// happens below the top 10, which is where it starts) and KL divergence
// (undefined when a query appears in one window and not the other — which is
// exactly the case drift produces). JSD is symmetric, always finite, and
// bounded at 1 bit, so a threshold means the same thing on every brand.
function jensenShannon(mapA, mapB) {
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const sum = (m) => { let t = 0; m.forEach((v) => { t += v; }); return t; };
  const totalA = sum(mapA);
  const totalB = sum(mapB);
  if (totalA <= 0 || totalB <= 0) return null;

  let divergence = 0;
  keys.forEach((k) => {
    const p = (mapA.get(k) || 0) / totalA;
    const q = (mapB.get(k) || 0) / totalB;
    const m = (p + q) / 2;
    if (p > 0) divergence += 0.5 * p * Math.log2(p / m);
    if (q > 0) divergence += 0.5 * q * Math.log2(q / m);
  });
  // Floating-point error can push a mathematically-zero result very slightly
  // negative, which would render as "-0.0% drift".
  return Math.max(0, Math.min(1, divergence));
}

// ------------------------------------------------------------- readability
function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// Syllable count, the heuristic Flesch implementations conventionally use:
// vowel groups, minus silent trailing 'e', floor of 1. It is approximate, and
// that is fine — Flesch itself is a rough instrument, and every SEO tool that
// reports it uses the same approximation, so the numbers are comparable.
function syllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// Flesch Reading Ease and Flesch-Kincaid Grade.
//
// Reported together because they answer different questions and a single
// number invites the wrong edit. Reading Ease says how hard the prose is;
// Grade says how many years of schooling it assumes. A page can score badly
// on Ease purely for having long technical terms it cannot avoid — a
// compliance page naming "Basel III capital adequacy requirements" is not
// improved by removing the term.
function readability(text) {
  const sents = sentences(text);
  const toks = words(text);
  if (!sents.length || !toks.length) {
    return { fleschReadingEase: null, fleschKincaidGrade: null, sentences: 0, words: 0, avgSentenceWords: null, longSentences: 0 };
  }
  const syl = toks.reduce((a, w) => a + syllables(w), 0);
  const wordsPerSentence = toks.length / sents.length;
  const syllablesPerWord = syl / toks.length;
  const ease = 206.835 - (1.015 * wordsPerSentence) - (84.6 * syllablesPerWord);
  const grade = (0.39 * wordsPerSentence) + (11.8 * syllablesPerWord) - 15.59;
  return {
    fleschReadingEase: Math.round(Math.max(0, Math.min(100, ease)) * 10) / 10,
    fleschKincaidGrade: Math.round(Math.max(0, grade) * 10) / 10,
    sentences: sents.length,
    words: toks.length,
    avgSentenceWords: Math.round(wordsPerSentence * 10) / 10,
    longSentences: sents.filter((s) => words(s).length > 30).length,
    passiveHints: countPassive(sents),
  };
}

// A crude passive-voice count: "was/were/is/are/been + past participle".
// Flagged as a hint, not an error — passive voice is correct in plenty of
// technical and regulatory writing.
function countPassive(sents) {
  const rx = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+(?:ed|en))\b/i;
  return sents.filter((s) => rx.test(s)).length;
}

// ---------------------------------------------------------------- entities
//
// Named-entity extraction without a model: runs of capitalised words that are
// not sentence-initial-only, plus acronyms, plus recognised numeric/date/money
// patterns. Deliberately conservative — a false entity in the report sends
// someone to add a term that does not exist.
function entities(text) {
  const found = new Map();
  const add = (surface, type) => {
    const key = surface.toLowerCase();
    if (NOT_ENTITIES.has(key)) return;
    const cur = found.get(key) || { surface, type, count: 0 };
    cur.count += 1;
    found.set(key, cur);
  };

  sentences(text).forEach((sentence) => {
    const toks = sentence.split(/\s+/);
    let run = [];
    const flush = (atSentenceStart) => {
      if (!run.length) { return; }
      const surface = run.join(' ').replace(/[.,;:!?)"']+$/, '');
      // A single capitalised word at the very start of a sentence is almost
      // always just capitalisation, not an entity.
      if (!(atSentenceStart && run.length === 1)) {
        const cleaned = surface.replace(/^["'(]+/, '');
        if (cleaned.length > 1 && /[A-Za-z]/.test(cleaned)) add(cleaned, 'proper-noun');
      }
      run = [];
    };
    toks.forEach((tok, i) => {
      const bare = tok.replace(/^["'(]+/, '').replace(/[.,;:!?)"']+$/, '');
      if (/^[A-Z]{2,6}(?:s)?$/.test(bare)) { flush(i - run.length === 0); add(bare, 'acronym'); return; }
      if (/^[A-Z][a-z'’-]+$/.test(bare) || /^[A-Z][a-z]*[A-Z][A-Za-z]*$/.test(bare)) {
        if (!run.length) run.startIndex = i;
        run.push(bare);
        return;
      }
      flush(run.startIndex === 0);
      run.startIndex = undefined;
    });
    flush(run.startIndex === 0);

    // Statistics, money, percentages, years: the concrete facts an AI answer
    // is most likely to lift and attribute.
    (sentence.match(/(?:[$£€]\s?\d[\d,.]*(?:\s?(?:million|billion|k|m|bn))?)|(?:\d[\d,.]*\s?%)|(?:\b(?:19|20)\d{2}\b)|(?:\b\d[\d,.]*\s+(?:years?|months?|days?|hours?|users?|customers?|students?|clients?|countries|per cent|percent)\b)/gi) || [])
      .forEach((m) => add(m.trim(), 'statistic'));
  });

  return [...found.values()].sort((a, b) => b.count - a.count);
}

// Entity density: distinct entities per 100 words of body copy.
//
// Why per-100-words and not a raw count: a 3,000-word page naturally names
// more things than a 500-word one, so a raw count ranks long pages as
// authoritative regardless of substance. Density asks whether the page is
// ABOUT specific, nameable things — which is what an AI retrieval system
// needs in order to decide the page answers a specific question.
function entityDensity(text) {
  const w = words(text).length;
  const ents = entities(text);
  if (!w) return { density: 0, distinct: 0, total: 0, words: 0, entities: [] };
  const total = ents.reduce((a, e) => a + e.count, 0);
  return {
    density: Math.round(((ents.length / w) * 100) * 100) / 100,
    distinct: ents.length,
    total,
    words: w,
    statistics: ents.filter((e) => e.type === 'statistic').length,
    entities: ents.slice(0, 60),
  };
}

// -------------------------------------------------------------- citability
//
// "Citability" is the property that decides whether an AI answer engine can
// lift a passage from a page and attribute it. It is not the same as ranking
// well, and it is not a vibe — it decomposes into things that are countable.
//
// The signals, and why each one is here:
//   selfContained  A passage that starts with "This means that…" cannot be
//                  quoted, because the referent is off-screen. Retrieval
//                  systems chunk pages and lose the surrounding context.
//   directAnswer   A passage that answers its heading's question in its first
//                  sentence is extractable; one that builds up to the answer
//                  in paragraph four is not.
//   attributable   Concrete facts — figures, dates, named sources — are what
//                  makes a passage worth citing rather than paraphrasing.
//   structured     Lists, tables and definition lists survive chunking intact.
//   scannable      Passages of 40-120 words are the size a citation uses. A
//                  600-word wall of text gets truncated mid-argument.
//   freshnessCue   A visible date or "as of" marker lets an engine judge
//                  currency; without one, a correct page loses to a dated one
//                  that says when it was written.
const QUESTION_STARTS = /^(what|why|how|when|where|which|who|can|do|does|is|are|should|will)\b/i;
const HEDGE_OPENERS = /^(this|that|these|those|it|they|he|she|such|however|therefore|moreover|furthermore|additionally|in addition|as a result|consequently|also)\b/i;

function citability(doc) {
  const paragraphs = (doc && doc.paragraphs) || [];
  const headings = (doc && doc.headings) || [];
  const text = (doc && doc.mainText) || '';

  const passages = paragraphs.map((p, i) => {
    const w = words(p).length;
    const sents = sentences(p);
    const first = sents[0] || '';
    const nums = (p.match(/\d/g) || []).length;
    const selfContained = !HEDGE_OPENERS.test(p.trim());
    const attributable = /\d/.test(p) && (nums >= 2 || /%|\$|£|€|\b(19|20)\d{2}\b/.test(p));
    const rightSized = w >= 40 && w <= 120;
    const score = (selfContained ? 40 : 0) + (attributable ? 25 : 0) + (rightSized ? 25 : 0)
      + (first && words(first).length <= 30 ? 10 : 0);
    return {
      index: i,
      words: w,
      preview: p.slice(0, 180),
      selfContained,
      attributable,
      rightSized,
      score,
    };
  });

  const questionHeadings = headings.filter((h) => QUESTION_STARTS.test(h.text) || h.text.trim().endsWith('?'));
  const strong = passages.filter((p) => p.score >= 65);
  const sem = (doc && doc.semantic) || {};

  const signals = {
    // Share of paragraphs that could be quoted as-is.
    selfContainedShare: passages.length ? Math.round((passages.filter((p) => p.selfContained).length / passages.length) * 100) : 0,
    quotablePassages: strong.length,
    passagesTotal: passages.length,
    questionHeadings: questionHeadings.length,
    hasStructuredBlocks: Boolean(sem.table || sem.lists || sem.definitionLists),
    listCount: sem.lists || 0,
    tableCount: sem.table ? 1 : 0,
    hasSemanticMain: Boolean(sem.main || sem.article),
    hasVisibleDate: Boolean(sem.time) || /\b(?:updated|reviewed|last modified|as of|published)\b/i.test(text.slice(0, 4000)),
    hasSchema: Boolean(doc && doc.jsonLd && doc.jsonLd.some((j) => j.ok)),
    statistics: (text.match(/\d[\d,.]*\s?%|[$£€]\s?\d|\b(?:19|20)\d{2}\b/g) || []).length,
  };

  // Weights sum to 100. Structure and self-containment carry the most,
  // because they are the two that decide whether extraction is POSSIBLE;
  // the rest decide whether it is attractive.
  const score = Math.round(
    (Math.min(1, signals.selfContainedShare / 80) * 25)
    + (Math.min(1, signals.quotablePassages / 5) * 20)
    + (Math.min(1, signals.questionHeadings / 3) * 12)
    + (signals.hasStructuredBlocks ? 12 : 0)
    + (signals.hasSemanticMain ? 8 : 0)
    + (signals.hasVisibleDate ? 8 : 0)
    + (signals.hasSchema ? 8 : 0)
    + (Math.min(1, signals.statistics / 6) * 7),
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    signals,
    passages: passages.sort((a, b) => b.score - a.score).slice(0, 12),
    weakPassages: passages.filter((p) => !p.selfContained).slice(0, 10),
  };
}

// --------------------------------------------------------------- sentiment
//
// Lexicon sentiment, for the reputation scanner.
//
// A lexicon rather than a model, for one specific reason: the scanner reads
// hundreds of Reddit comments and news headlines per run, and sending those to
// a paid model would exhaust the spend cap on the least valuable part of the
// job. The AI layer is used for the part that needs judgement — deciding
// whether a negative mention is a factual claim that needs correcting — on the
// handful of items this stage flags.
const POSITIVE = new Set(`
great excellent amazing awesome love loved loving best fantastic wonderful
helpful helped recommend recommended recommending reliable trustworthy honest
professional responsive quick fast easy smooth perfect solid impressed
impressive quality worth valuable useful legit legitimate happy satisfied
outstanding brilliant superb thorough knowledgeable friendly courteous
`.trim().split(/\s+/));

const NEGATIVE = new Set(`
scam scammed fraud fraudulent fake terrible awful horrible worst hate hated
avoid avoided warning beware sketchy shady dishonest lying lied lie misleading
deceptive rude unprofessional unresponsive slow useless waste wasted refund
refunded overpriced ripoff rip-off disappointed disappointing broken buggy
failed failure problem problems issue issues complaint complaints angry
frustrated frustrating never again unreliable dodgy predatory
`.trim().split(/\s+/));

const NEGATORS = new Set(['not', 'no', "don't", 'dont', 'never', "didn't", 'didnt', "wasn't", 'wasnt', "isn't", 'isnt', 'without', 'hardly', 'barely']);
const INTENSIFIERS = new Set(['very', 'extremely', 'really', 'absolutely', 'totally', 'completely', 'incredibly', 'so']);

// Claims that would be damaging if false, and are the kind of thing an AI
// engine repeats verbatim if it is the loudest thing said about a brand.
const RISK_PATTERNS = [
  { key: 'fraud_claim', label: 'Fraud or scam accusation', rx: /\b(scam|scammed|fraud|fraudulent|ponzi|stole|stolen|ripped me off|rip-?off)\b/i, severity: 'critical' },
  { key: 'legal', label: 'Legal or regulatory claim', rx: /\b(lawsuit|sued|suing|class action|attorney general|investigation|fined|sanction|cease and desist)\b/i, severity: 'high' },
  { key: 'closure', label: 'Out-of-business claim', rx: /\b(out of business|shut down|shutting down|went under|closed down|no longer operating|bankrupt)\b/i, severity: 'high' },
  { key: 'safety', label: 'Safety or data claim', rx: /\b(data breach|hacked|leaked|stole my data|unsafe|dangerous|injur)\w*\b/i, severity: 'critical' },
  { key: 'credential', label: 'Credential or accreditation dispute', rx: /\b(not accredited|fake certificate|not recognised|not recognized|unaccredited|worthless (?:cert|certificate|qualification))\b/i, severity: 'high' },
];

function sentiment(text) {
  const toks = words(text);
  let score = 0;
  let hits = 0;
  toks.forEach((tok, i) => {
    const s = stem(tok);
    let polarity = 0;
    if (POSITIVE.has(tok) || POSITIVE.has(s)) polarity = 1;
    else if (NEGATIVE.has(tok) || NEGATIVE.has(s)) polarity = -1;
    if (!polarity) return;
    hits += 1;
    let weight = 1;
    // Look back two tokens for a negator or intensifier — "not great" must not
    // count as positive, and "absolutely terrible" is worse than "terrible".
    for (let back = 1; back <= 2; back += 1) {
      const prev = toks[i - back];
      if (!prev) break;
      if (NEGATORS.has(prev)) { polarity *= -1; break; }
      if (INTENSIFIERS.has(prev)) weight = 1.5;
    }
    score += polarity * weight;
  });

  const normalised = hits ? Math.max(-1, Math.min(1, score / Math.sqrt(hits * 4))) : 0;
  let label = 'neutral';
  if (normalised >= 0.2) label = 'positive';
  else if (normalised <= -0.2) label = 'negative';

  const risks = RISK_PATTERNS.filter((r) => r.rx.test(text)).map((r) => ({ key: r.key, label: r.label, severity: r.severity }));

  return {
    label,
    score: Math.round(normalised * 100) / 100,
    matchedTerms: hits,
    risks,
    // The highest-severity risk pattern present, which is what an alert keys on.
    risk: risks.length ? (risks.find((r) => r.severity === 'critical') || risks[0]) : null,
  };
}

// --------------------------------------------------------------- utilities

// Search intent, delegated to the clustering engine's taxonomy so the research
// module and the existing keyword clustering agree on what "Transactional"
// means rather than each inventing a definition. Required lazily because
// clustering.js opens the database, and this module must stay importable by
// anything, including scripts that only want the text helpers.
//
// Returns clustering's own { intent, confidence, coverage, pageType, … }
// object; `intent` is the label, and `confidence` is what stops a caller
// presenting a one-keyword guess as a finding.
function classifyIntent(keywords, vertical = 'other', market = null) {
  const clustering = require('../clustering');
  const list = Array.isArray(keywords) ? keywords : [String(keywords || '')];
  return clustering.classifyIntent(list.map(String), vertical, market);
}

module.exports = {
  STOPWORDS, words, contentWords, stem, ngrams, keyPhrases,
  termFrequency, cosine, jaccard, jensenShannon,
  sentences, syllables, readability,
  entities, entityDensity, citability,
  sentiment, RISK_PATTERNS,
  classifyIntent,
};
