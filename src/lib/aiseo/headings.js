// HEADING HIERARCHY AND KEYWORD REPETITION
//
// Two structural checks the on-page score was missing, both of which are
// deterministic, both of which matter more for AI retrieval than for ranking.
//
// WHY HEADING ORDER IS NOT A STYLE PREFERENCE
// A retrieval system chunks a page by its heading tree: an H3 is understood as
// belonging to the H2 above it, and the H2 to the H1. A page that goes
// H1 → H4 → H2 → H2 has no tree, so the chunker either flattens it (losing
// which passage answers which question) or nests wrongly (attributing a
// passage to the wrong subject). Screen readers have the same problem for the
// same reason, which is why this is also a WCAG 1.3.1 issue.
//
// The checks, and the severity each earns:
//   missing H1          the page states no subject at all — high
//   multiple H1s        two competing subjects; a retrieval system picks one — medium
//   skipped level       H2 → H4, or an H5 before any H1 — medium
//   H1 not first        a heading precedes the page's own title heading — low
//   duplicate adjacent  two consecutive headings at the same level with the
//                       same text, which is nearly always a template bug that
//                       renders a section title twice — low
//   empty heading       a heading tag with no text: invisible to a reader,
//                       counted by a parser — low
//
// WHY KEYWORD STUFFING IS MEASURED AS DENSITY *AND* DISTRIBUTION
// Density alone is a bad test. A 300-word page mentioning its term six times
// is at 2% and reads naturally; a 3,000-word page mentioning it sixty times is
// also at 2% and, if fifty of those are in one section, reads like spam. So
// both are reported: the density, and how unevenly the term is spread. The
// second is what actually distinguishes a stuffed page.
const nlp = require('./nlp');
const boilerplate = require('./boilerplate');

// ---------------------------------------------------------------- hierarchy

function normaliseHeading(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Validates the heading tree of a parsed document.
//
// `headings` must be in DOCUMENT ORDER, which is what fetcher.parseDocument
// produces — the order is the whole point, and a sorted list would make every
// skipped-level check pass.
function hierarchy(doc) {
  const headings = (doc && doc.headings) || [];
  const issues = [];
  const outline = [];

  const h1s = headings.filter((h) => h.level === 1);
  const nonEmpty = headings.filter((h) => normaliseHeading(h.text));

  // Empty tags. Counted from the raw list, which is why parseDocument's own
  // filter matters: it drops headings with no text, so an empty <h2> never
  // reaches here and is detected from the DOM instead.
  let emptyCount = 0;
  if (doc && doc.$) {
    try {
      doc.$('h1, h2, h3, h4, h5, h6').each((_, el) => {
        const t = doc.$(el).text().replace(/\s+/g, ' ').trim();
        if (!t) emptyCount += 1;
      });
    } catch { /* a document without a live $ simply skips this check */ }
  }

  if (!h1s.length) {
    issues.push({
      key: 'missing_h1',
      severity: 'high',
      message: headings.length
        ? `The page has ${headings.length} heading${headings.length === 1 ? '' : 's'} but no H1, so it never states its own subject. The first heading is an H${headings[0].level}: "${headings[0].text.slice(0, 80)}".`
        : 'The page has no headings at all.',
      wcag: '1.3.1 Info and Relationships',
    });
  } else if (h1s.length > 1) {
    issues.push({
      key: 'multiple_h1',
      severity: 'medium',
      message: `${h1s.length} H1 elements: ${h1s.slice(0, 4).map((h) => `"${h.text.slice(0, 50)}"`).join(', ')}. A retrieval system treats one of them as the page's subject and the choice is not yours.`,
      count: h1s.length,
    });
  }

  if (h1s.length && headings.length && headings[0].level !== 1) {
    issues.push({
      key: 'h1_not_first',
      severity: 'low',
      message: `The first heading in the document is an H${headings[0].level} ("${headings[0].text.slice(0, 60)}"), before the H1. Usually a header or hero component emitting a heading tag it should not.`,
    });
  }

  // Skipped levels, walked in document order.
  let previous = null;
  const skips = [];
  nonEmpty.forEach((h, i) => {
    outline.push({ index: i, level: h.level, text: h.text.slice(0, 120) });
    if (previous == null) {
      // The first heading being deeper than H2 is itself a skip: an H5 with no
      // H1 above it is exactly the "H5 before H1" case.
      if (h.level > 2) {
        skips.push({ from: null, to: h.level, at: i, text: h.text.slice(0, 80), firstHeading: true });
      }
    } else if (h.level > previous + 1) {
      skips.push({ from: previous, to: h.level, at: i, text: h.text.slice(0, 80) });
    }
    previous = h.level;
  });

  if (skips.length) {
    issues.push({
      key: 'skipped_levels',
      severity: 'medium',
      message: `${skips.length} place${skips.length === 1 ? '' : 's'} in the outline skip a heading level: `
        + skips.slice(0, 6).map((s) => (s.firstHeading
          ? `the document opens at H${s.to} ("${s.text}")`
          : `H${s.from} → H${s.to} at "${s.text}"`)).join('; ')
        + '. A chunker cannot tell which passage belongs to which subject across a skip.',
      count: skips.length,
      detail: skips.slice(0, 20),
      wcag: '1.3.1 Info and Relationships',
    });
  }

  // Duplicate adjacent headings at the same level.
  const duplicates = [];
  for (let i = 1; i < nonEmpty.length; i += 1) {
    const a = nonEmpty[i - 1];
    const b = nonEmpty[i];
    if (a.level === b.level && normaliseHeading(a.text) === normaliseHeading(b.text)) {
      duplicates.push({ level: a.level, text: a.text.slice(0, 90), at: i });
    }
  }
  if (duplicates.length) {
    issues.push({
      key: 'duplicate_adjacent',
      severity: 'low',
      message: `${duplicates.length} consecutive heading pair${duplicates.length === 1 ? ' repeats' : 's repeat'} the same text at the same level: `
        + duplicates.slice(0, 5).map((d) => `H${d.level} "${d.text}"`).join('; ')
        + '. Almost always a template rendering a section title twice — once visibly and once for mobile, or once per breakpoint.',
      count: duplicates.length,
      detail: duplicates.slice(0, 20),
    });
  }

  // The same heading text repeated non-adjacently, which is a different
  // problem: several sections claiming to answer the same question.
  const textCounts = new Map();
  nonEmpty.forEach((h) => {
    const k = normaliseHeading(h.text);
    if (k.length < 4) return;
    textCounts.set(k, (textCounts.get(k) || 0) + 1);
  });
  const repeatedText = [...textCounts.entries()].filter(([, c]) => c >= 3)
    .map(([text, count]) => ({ text: text.slice(0, 90), count }))
    .sort((a, b) => b.count - a.count);
  if (repeatedText.length) {
    issues.push({
      key: 'repeated_heading_text',
      severity: 'low',
      message: `${repeatedText.length} heading text${repeatedText.length === 1 ? ' appears' : 's appear'} three or more times: `
        + repeatedText.slice(0, 4).map((r) => `"${r.text}" ×${r.count}`).join('; ')
        + '. Where several sections carry the same heading, no single passage is identifiable as the answer to it.',
      count: repeatedText.length,
      detail: repeatedText.slice(0, 15),
    });
  }

  if (emptyCount) {
    issues.push({
      key: 'empty_headings',
      severity: 'low',
      message: `${emptyCount} heading element${emptyCount === 1 ? ' contains' : 's contain'} no text. A reader sees nothing; a parser sees a heading level and nests the following content under it.`,
      count: emptyCount,
    });
  }

  // Headings whose entire text is UI chrome — "Learn More" as an H3 is a
  // structural claim the page does not mean to make.
  const chromeHeadings = nonEmpty.filter((h) => boilerplate.isGenericUi(h.text));
  if (chromeHeadings.length >= 2) {
    issues.push({
      key: 'chrome_headings',
      severity: 'low',
      message: `${chromeHeadings.length} headings are generic labels rather than statements of subject: `
        + chromeHeadings.slice(0, 5).map((h) => `H${h.level} "${h.text.slice(0, 40)}"`).join(', ')
        + '. Each one occupies a level in the outline while telling a retrieval system nothing.',
      count: chromeHeadings.length,
    });
  }

  const levelCounts = {};
  [1, 2, 3, 4, 5, 6].forEach((l) => { levelCounts[`h${l}`] = headings.filter((h) => h.level === l).length; });

  // A single, explainable score: full marks for a clean tree, with a stated
  // deduction per issue class so the number can be traced back.
  const weights = {
    missing_h1: 30, multiple_h1: 15, skipped_levels: 15, h1_not_first: 5,
    duplicate_adjacent: 8, repeated_heading_text: 8, empty_headings: 6, chrome_headings: 6,
  };
  const deductions = issues.map((i) => ({ key: i.key, points: weights[i.key] || 5 }));
  const score = Math.max(0, 100 - deductions.reduce((a, d) => a + d.points, 0));

  return {
    score,
    valid: issues.length === 0,
    issues,
    deductions,
    outline: outline.slice(0, 120),
    counts: { total: headings.length, ...levelCounts, empty: emptyCount },
    skips,
    duplicates,
    repeatedText,
  };
}

// ---------------------------------------------------- repetition / stuffing

// Google's own guidance names two things as spam: a term repeated beyond what
// reading requires, and blocks of the same text duplicated on a page. Both are
// countable.
//
// `text` should be the BOILERPLATE-STRIPPED content text — otherwise a footer
// repeating the brand name on every page reads as stuffing. That is the caller's
// responsibility and ./onpage.js passes the cleaned text.
const NATURAL_DENSITY_CEILING = 2.8; // per cent, for an exact target term
const NGRAM_DENSITY_CEILING = 3.5; // per cent, for any repeated 2-3 word phrase

function stuffing(text, { keyword = '', headings = [], minWords = 120 } = {}) {
  const words = nlp.words(text);
  const total = words.length;
  if (total < minWords) {
    // The same SHAPE as the measured return, with empty collections rather than
    // missing keys. A caller that reads `.duplicatedSentences.length` must not
    // have to know which branch produced the object — the two returns differing
    // in shape is how a view ends up throwing on a short page.
    return {
      measurable: false,
      reason: `only ${total} words of body content after boilerplate was excluded — density is meaningless below ${minWords} and is not reported`,
      words: total,
      target: null,
      overUsedPhrases: [],
      duplicatedSentences: [],
      issues: [],
      worstSeverity: null,
      clean: true,
      thresholds: { targetDensityPct: NATURAL_DENSITY_CEILING, phraseDensityPct: NGRAM_DENSITY_CEILING },
    };
  }

  const issues = [];

  // --- the target term -----------------------------------------------
  let target = null;
  const kw = String(keyword || '').toLowerCase().trim();
  if (kw) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = (String(text).toLowerCase().match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
    const kwWordCount = kw.split(/\s+/).filter(Boolean).length;
    const density = total ? (exact * kwWordCount) / total * 100 : 0;

    // Distribution: how the occurrences are spread over the page, in tenths.
    const buckets = new Array(10).fill(0);
    const positions = [];
    const rx = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m;
    const lower = String(text);
    while ((m = rx.exec(lower))) {
      positions.push(m.index);
      const bucket = Math.min(9, Math.floor((m.index / Math.max(1, lower.length)) * 10));
      buckets[bucket] += 1;
      if (positions.length > 500) break;
    }
    const occupied = buckets.filter((b) => b > 0).length;
    const heaviest = Math.max(...buckets, 0);
    // The heaviest ADJACENT PAIR of tenths, not the heaviest single tenth.
    //
    // A single-tenth window is too narrow to be the test it is meant to be:
    // eighteen occurrences packed into the opening third of a page spread
    // across three tenths at six each, so no single tenth held half of them and
    // an obviously stuffed block scored as evenly distributed. A section of a
    // page is a fifth of it, not a tenth, so the window has to be two buckets
    // wide to match what a reader would call "one part of the page".
    let heaviestPair = 0;
    for (let i = 0; i < buckets.length - 1; i += 1) {
      heaviestPair = Math.max(heaviestPair, buckets[i] + buckets[i + 1]);
    }
    const clustered = exact >= 6
      && (heaviestPair / exact >= 0.5 || heaviest / exact >= 0.4);

    target = {
      keyword: kw,
      exactMatches: exact,
      densityPct: Math.round(density * 100) / 100,
      ceiling: NATURAL_DENSITY_CEILING,
      distribution: buckets,
      tenthsCovered: occupied,
      heaviestTenth: heaviest,
      heaviestAdjacentPair: heaviestPair,
      clustered,
      inHeadings: headings.filter((h) => String(h.text || '').toLowerCase().includes(kw)).length,
      headingsTotal: headings.length,
    };

    if (density > NATURAL_DENSITY_CEILING) {
      issues.push({
        key: 'target_density',
        severity: density > NATURAL_DENSITY_CEILING * 1.8 ? 'high' : 'medium',
        message: `"${kw}" appears ${exact} times in ${total} words of body content — ${target.densityPct}% density, against a natural ceiling of ${NATURAL_DENSITY_CEILING}%. `
          + (clustered
            ? `${heaviestPair} of those ${exact} occurrences sit in one fifth of the page, which is what distinguishes stuffing from a page that is simply about the subject.`
            : 'Spread evenly, so this reads as over-use rather than a stuffed block — but it is still above what prose requires.'),
        action: 'Replace the surplus occurrences with pronouns and near-synonyms. Search engines resolve those; the reader prefers them.',
      });
    } else if (clustered) {
      issues.push({
        key: 'target_clustered',
        severity: 'low',
        message: `"${kw}" is at a natural ${target.densityPct}% overall, but ${heaviestPair} of its ${exact} occurrences fall inside one fifth of the page. That block reads as optimised even though the page as a whole does not.`,
        action: 'Rewrite the dense passage. The rest of the page is fine.',
      });
    }

    if (exact === 0) {
      issues.push({
        key: 'target_absent',
        severity: 'medium',
        message: `"${kw}" does not appear as an exact phrase anywhere in the body content. That is not automatically wrong — the page may cover the subject in other words — but it should be deliberate.`,
        action: 'Either work the phrase in once, naturally, or accept that this page is targeting a different phrasing and score it against that instead.',
      });
    }
  }

  // --- any over-repeated phrase, target or not -------------------------
  const phrases = nlp.keyPhrases(text, { minCount: 3, limit: 60 });
  const overUsed = phrases
    .map((p) => {
      const n = p.phrase.split(/\s+/).length;
      return { ...p, densityPct: Math.round(((p.count * n) / total) * 100 * 100) / 100, wordsInPhrase: n };
    })
    .filter((p) => p.densityPct > NGRAM_DENSITY_CEILING)
    .sort((a, b) => b.densityPct - a.densityPct)
    .slice(0, 15);

  if (overUsed.length) {
    issues.push({
      key: 'phrase_repetition',
      severity: overUsed[0].densityPct > NGRAM_DENSITY_CEILING * 2 ? 'medium' : 'low',
      message: `${overUsed.length} phrase${overUsed.length === 1 ? '' : 's'} occupy more than ${NGRAM_DENSITY_CEILING}% of the body content each: `
        + overUsed.slice(0, 5).map((p) => `"${p.phrase}" ×${p.count} (${p.densityPct}%)`).join('; ')
        + '.',
      action: 'Check each against the page: a genuinely central term repeats naturally, and a filler phrase repeated this often is usually a template block that escaped the content-region filter.',
      detail: overUsed,
    });
  }

  // --- duplicated sentences -------------------------------------------
  const sentenceCounts = new Map();
  nlp.sentences(text).forEach((s) => {
    const t = s.trim().toLowerCase();
    if (t.length < 40) return;
    sentenceCounts.set(t, (sentenceCounts.get(t) || 0) + 1);
  });
  const duplicatedSentences = [...sentenceCounts.entries()].filter(([, c]) => c >= 2)
    .map(([sentence, count]) => ({ sentence: sentence.slice(0, 160), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (duplicatedSentences.length) {
    issues.push({
      key: 'duplicated_sentences',
      severity: 'low',
      message: `${duplicatedSentences.length} sentence${duplicatedSentences.length === 1 ? ' appears' : 's appear'} more than once in the body content: `
        + duplicatedSentences.slice(0, 3).map((d) => `"${d.sentence.slice(0, 70)}…" ×${d.count}`).join('; ')
        + '.',
      action: 'Deduplicate. A repeated sentence dilutes the passage a retrieval system would otherwise quote, because two identical chunks compete for the same citation.',
      detail: duplicatedSentences,
    });
  }

  // --- heading over-optimisation ---------------------------------------
  if (kw && headings.length >= 4) {
    const withKw = headings.filter((h) => String(h.text || '').toLowerCase().includes(kw)).length;
    const share = withKw / headings.length;
    if (share > 0.6) {
      issues.push({
        key: 'heading_stuffing',
        severity: 'medium',
        message: `${withKw} of ${headings.length} headings contain "${kw}" (${Math.round(share * 100)}%). A page whose every subheading repeats the target term is describing one subject in one way, which gives a retrieval system no distinct question to match a passage to.`,
        action: 'Make each subheading the specific question that section answers. One or two carrying the exact term is right; most of them is not.',
      });
    }
  }

  const worst = issues.reduce((acc, i) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[i.severity] ?? 2) < (rank[acc] ?? 3) ? i.severity : acc;
  }, null);

  return {
    measurable: true,
    words: total,
    target,
    overUsedPhrases: overUsed,
    duplicatedSentences,
    issues,
    worstSeverity: worst,
    clean: issues.filter((i) => i.key !== 'target_absent').length === 0,
    thresholds: { targetDensityPct: NATURAL_DENSITY_CEILING, phraseDensityPct: NGRAM_DENSITY_CEILING },
  };
}

module.exports = {
  hierarchy, stuffing, normaliseHeading,
  NATURAL_DENSITY_CEILING, NGRAM_DENSITY_CEILING,
};
