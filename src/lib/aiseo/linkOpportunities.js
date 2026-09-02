// INTERNAL LINK OPPORTUNITIES — the run wrapper around ./linkFinder.js.
//
// ./linkFinder.js is pure: give it a URL, it returns rows. This is the thin
// layer that makes it one of the suite's nine features — it opens a run row,
// stores the result, raises the findings, and bridges to the task backlog, so
// the shared `feature()` router in src/routes/aiseo.js can serve it with no
// special-casing.
//
// Kept separate from linkFinder.js so the finder stays callable from anywhere —
// the architecture report calls it with a crawl it already has — without
// dragging in the database.
const store = require('./store');
const providers = require('./providers');
const linkFinder = require('./linkFinder');
const { normalizeUrl } = require('./fetcher');

async function run({
  userId, brand, adoptRunId = null, url, maxPages = 120, limit = 50,
  extraPhrases = [], minRelevance = 0.08,
}) {
  const brandId = brand ? brand.id : null;
  const target = normalizeUrl(url);
  if (!target) throw new Error('Give the URL you want internal links pointing at.');

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'link_opportunities', target,
    label: (() => { try { return new URL(target).pathname; } catch { return target; } })(),
    params: { url: target, maxPages, limit, minRelevance, extraPhrases },
  });

  try {
    const sources = ['crawler'];
    const found = await linkFinder.find(target, {
      site: brand ? brand.site_url : null,
      maxPages,
      limit,
      extraPhrases,
      minRelevance,
    });

    if (!found.ok) {
      return store.finish(runRow.id, {
        score: null,
        result: { empty: true, reason: found.reason, target, targetDoc: found.targetDoc || null },
        findings: [{
          checkKey: 'target_unusable',
          title: 'No link opportunities could be found for this URL',
          detail: found.reason,
          severity: 'high',
          affectedUrl: target,
          action: 'Fix the target URL, or give the anchor phrases explicitly on the form.',
          dedupeKey: `linkopps:unusable:${target}`,
        }],
        sources,
      });
    }

    const findings = [];

    if (found.rows.length) {
      findings.push({
        checkKey: 'link_opportunities',
        title: `${found.rows.length} page${found.rows.length === 1 ? '' : 's'} could link to this URL using a phrase already in their own copy`,
        detail: `Top by relevance: ${found.rows.slice(0, 5).map((r) => `${r.sourceUrl} → anchor "${r.anchorText}"`).join('; ')}. `
          + `${found.alreadyLinking.length} page${found.alreadyLinking.length === 1 ? '' : 's'} already link here. `
          + 'Every anchor listed is a verbatim substring of the source page\'s own editorial text, with the sentence it sits in — so implementing a row is wrapping an existing phrase, not writing a new one.',
        severity: found.alreadyLinking.length === 0 ? 'high' : 'medium',
        affectedUrl: target,
        affectedCount: found.rows.length,
        action: 'Work down the list. The relevance column is entity overlap plus vocabulary similarity with the target, so the top rows are the links a reader would most expect to find.',
        evidence: { rows: found.rows.slice(0, 60), alreadyLinking: found.alreadyLinking.slice(0, 30) },
        dedupeKey: `linkopps:rows:${target}`,
      });
    }

    if (!found.alreadyLinking.length) {
      findings.push({
        checkKey: 'orphan_target',
        title: 'Nothing on the crawled site links to this URL',
        detail: `${found.crawl.usable} page${found.crawl.usable === 1 ? '' : 's'} were crawled from ${found.crawl.startUrl} and none of them link to ${target}. `
          + (found.crawl.complete
            ? 'The crawl completed, so this is an orphan rather than a page the crawl did not reach.'
            : `The crawl stopped at its ${found.crawl.maxPages}-page cap before exhausting the site, so a linking page may exist beyond it — raise the cap to be certain.`),
        severity: found.crawl.complete ? 'high' : 'medium',
        affectedUrl: target,
        action: 'An orphan page depends entirely on the sitemap for discovery and receives no internal authority. Add at least two links from the rows below.',
        evidence: { crawl: found.crawl },
        dedupeKey: `linkopps:orphan:${target}`,
      });
    }

    if (found.relevantWithoutAnchor.length >= 3) {
      findings.push({
        checkKey: 'relevant_no_anchor',
        title: `${found.relevantWithoutAnchor.length} relevant pages carry no usable anchor phrase`,
        detail: `These pages are topically close to the target but none of the target's own phrases appear verbatim in their editorial content: ${found.relevantWithoutAnchor.slice(0, 6).map((r) => r.sourceUrl).join(', ')}. `
          + 'They are listed separately rather than mixed into the recommendations, because linking from them means writing a new sentence — a content task, not a linking task.',
        severity: 'low',
        affectedUrl: found.relevantWithoutAnchor[0].sourceUrl,
        affectedCount: found.relevantWithoutAnchor.length,
        action: 'Treat each as a small content edit: add one sentence that genuinely belongs, then link from it. Do not bolt on a sentence purely to carry a link.',
        evidence: { pages: found.relevantWithoutAnchor.slice(0, 30) },
        dedupeKey: `linkopps:noanchor:${target}`,
      });
    }

    // A score that means something specific: how well-linked this URL is
    // relative to the opportunity available. 100 means every relevant page
    // already links here.
    const denominator = found.alreadyLinking.length + found.rows.length;
    const score = denominator
      ? Math.round((found.alreadyLinking.length / denominator) * 100)
      : null;

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        target,
        targetPage: found.targetPage,
        phrases: found.phrases,
        rows: found.rows,
        alreadyLinking: found.alreadyLinking,
        relevantWithoutAnchor: found.relevantWithoutAnchor,
        crawl: found.crawl,
        counts: found.counts,
        basis: found.basis,
        truncated: found.truncated,
        scoreMeaning: score == null
          ? null
          : `${found.alreadyLinking.length} of ${denominator} pages that plausibly should link here already do.`,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId ? [
        { key: 'linkopps.inbound_now', url: target, value: found.alreadyLinking.length, status: found.alreadyLinking.length >= 3 ? 'good' : (found.alreadyLinking.length ? 'warn' : 'fail') },
        { key: 'linkopps.opportunities', url: target, value: found.rows.length, status: 'good' },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(runRecord, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  const rows = ((runRecord.result || {}).rows) || [];

  // One task PER LINK rather than one task for the finding. This is the one
  // feature in the suite where that is right: each row is a single, independent,
  // five-minute edit on a named page, and a single task saying "add 23 links"
  // cannot be assigned, tracked or closed.
  rows.slice(0, 40).forEach((r) => {
    const res = tasksLib.upsertTask({
      userId,
      brandId: runRecord.brand_id,
      title: `Link to ${(() => { try { return new URL(r.url).pathname; } catch { return r.url; } })()} from ${(() => { try { return new URL(r.sourceUrl).pathname; } catch { return r.sourceUrl; } })()}`,
      detail: `Wrap the existing phrase "${r.anchorText}" on ${r.sourceUrl} in a link to ${r.url}.\n\n`
        + `The phrase already appears in this sentence:\n"${r.sentence}"\n\n`
        + `Why this pair: ${r.why}.`,
      source: 'aiseo',
      sourceRef: `aiseo:link_opportunities:${runRecord.id}:${r.sourceUrl}`,
      category: 'Internal linking',
      severity: 'medium',
      affectedUrl: r.sourceUrl,
      evidence: r,
      dedupeKey: `aiseo:linkopps:${r.sourceUrl}->${r.url}`,
    });
    if (res.created) created += 1;
  });

  // The orphan finding is a separate, different task.
  (runRecord.findings || []).filter((f) => f.check_key === 'orphan_target').forEach((f) => {
    const res = tasksLib.upsertTask({
      userId,
      brandId: runRecord.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:link_opportunities:${runRecord.id}:${f.check_key}`,
      category: 'Internal linking',
      severity: f.severity,
      affectedUrl: f.affected_url || runRecord.target,
      evidence: f.evidence,
      dedupeKey: `aiseo:linkopps:orphan:${runRecord.target}`,
    });
    if (res.created) created += 1;
  });

  return { created };
}

module.exports = { run, toTasks };
