// Deterministic vs AI comparison sheet.
//
// PURPOSE
// The deterministic engines are the product. They run with no API key, no
// per-run cost and no network dependency, and nothing in the scheduled path
// (alerts, weekly reports, the task backlog) ever calls an AI model. This
// module does not change that.
//
// What it adds is a way to MEASURE whether the AI counterpart is worth
// anything. It pairs each deterministic output with the AI output for the same
// item, side by side, and exports the pair as a CSV with an empty scoring
// column. The SEO team fills that column in, and the answer to "is the AI
// better?" becomes evidence instead of opinion.
//
// Deliberate properties:
//   - Reads only. It never regenerates AI output, so opening or exporting the
//     comparison costs nothing. Rows where AI has not been generated yet are
//     included with an empty AI column and marked "not generated", which is
//     itself a useful signal about coverage.
//   - Both columns are shown in full. No summarising, no "winner" computed by
//     the app — the whole point is that a human judges them.
//   - Item identity is carried so two exports of the same run line up.
const db = require('../../db');
const csvStore = require('../csvStore');
const opportunities = require('../opportunities');
const contentBrief = require('../contentBrief');
const aiLinking = require('./aiLinking');
const aiOpportunities = require('./aiOpportunities');
const aiCannibalization = require('./aiCannibalization');

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// ------------------------------------------------------------------ linking
function linkingRows(brand) {
  const run = aiLinking.latestCompletedRun(brand.id);
  if (!run) return [];
  const recs = aiLinking.topRecommendations(run.out_dir);
  if (!recs.length) return [];

  // Read-only: whatever was last generated, if anything.
  const latest = db.prepare(`SELECT * FROM ai_linking_notes WHERE brand_id=?
    ORDER BY id DESC LIMIT 1`).get(brand.id);
  const notes = latest ? safeJson(latest.notes_json, {}) : {};

  // The deterministic reason column comes straight from the Python agent.
  const table = csvStore.readTable(run.out_dir, 'recommendations', { perPage: aiLinking.MAX_RECS, sort: 'priority', dir: 'asc' });
  const rows = table ? table.rows : [];

  return recs.map((r, i) => {
    const det = rows[i] || {};
    return {
      feature: 'Internal linking',
      item: `${r.source_url} -> ${r.target_url}`,
      context: `anchor: "${r.anchor_text}"${det.confidence ? ` (${det.confidence})` : ''}`,
      deterministic: det.reason || '(no reason recorded)',
      ai: notes[String(i)] || '',
      aiStatus: notes[String(i)] ? 'generated' : 'not generated',
    };
  });
}

// ----------------------------------------------------------- cannibalisation
function cannibalisationRows(brand) {
  const items = aiCannibalization.deterministicFindings(brand);
  if (!items.length) return [];

  let verdicts = {};
  try {
    aiCannibalization.ensureTable();
    const latest = db.prepare(`SELECT * FROM ai_cannibalization_notes WHERE brand_id=?
      ORDER BY id DESC LIMIT 1`).get(brand.id);
    verdicts = latest ? safeJson(latest.verdicts_json, {}) : {};
  } catch {
    verdicts = {};
  }

  return items.map((it) => {
    const v = verdicts[it.id];
    return {
      feature: 'Cannibalisation',
      item: (it.urls || []).join(' | '),
      context: `${it.source}; keyword: "${it.sharedKeyword || ''}"; severity: ${it.severity || 'n/a'}`,
      deterministic: [it.evidence, it.deterministicRecommendation].filter(Boolean).join(' — '),
      ai: v ? `[${v.action}${v.target ? ` -> ${v.target}` : ''}] ${v.text}` : '',
      aiStatus: v ? 'generated' : 'not generated',
    };
  });
}

// ------------------------------------------------------------ opportunities
function opportunityRows(brand) {
  let result;
  try {
    result = opportunities.analyse(brand);
  } catch {
    return [];
  }
  const findings = aiOpportunities.compactFindings(result);
  if (!findings.length) return [];

  const latest = db.prepare(`SELECT * FROM ai_opportunity_notes WHERE brand_id=?
    ORDER BY id DESC LIMIT 1`).get(brand.id);
  const notes = latest ? safeJson(latest.findings_json, {}) : {};

  return findings.map((f, i) => {
    const o = result.opportunities[i] || {};
    return {
      feature: 'Content opportunity',
      item: f.page || f.query || '',
      context: `${f.type}; ${f.estimatedGain}; score ${o.score != null ? o.score : ''}`,
      deterministic: f.existingRecommendation || '',
      ai: notes[f.id] || '',
      aiStatus: notes[f.id] ? 'generated' : 'not generated',
    };
  });
}

// ------------------------------------------------------------------ briefs
function briefRows(brand) {
  const rows = db.prepare(`SELECT b.id, b.keyword_run_id, b.cluster_id, b.primary_keyword, b.data_json
    FROM content_briefs b WHERE b.brand_id=? ORDER BY b.id DESC LIMIT 25`).all(brand.id);
  if (!rows.length) return [];

  return rows.map((r) => {
    const data = safeJson(r.data_json, {}) || {};
    const clusterKey = `${r.keyword_run_id}:${r.cluster_id}`;
    const ai = db.prepare(`SELECT * FROM ai_content_briefs WHERE brand_id=? AND cluster_key=?
      ORDER BY id DESC LIMIT 1`).get(brand.id, clusterKey);
    const aiHeadings = ai ? (safeJson(ai.headings_json, []) || []) : [];
    return {
      feature: 'Content brief',
      item: r.primary_keyword,
      context: `brief #${r.id}; cluster ${clusterKey}`,
      deterministic: [
        `TITLE: ${data.recommendedTitle || ''}`,
        `HEADINGS: ${(data.suggestedHeadings || []).join(' | ')}`,
      ].join('\n'),
      ai: ai
        ? [`TITLE: ${ai.title || ''}`, `HEADINGS: ${aiHeadings.join(' | ')}`,
          ai.angle_note ? `ANGLE: ${ai.angle_note}` : null].filter(Boolean).join('\n')
        : '',
      aiStatus: ai ? 'generated' : 'not generated',
    };
  });
}

function build(brand) {
  const rows = [
    ...linkingRows(brand),
    ...cannibalisationRows(brand),
    ...opportunityRows(brand),
    ...briefRows(brand),
  ];
  const generated = rows.filter((r) => r.aiStatus === 'generated').length;
  return {
    brand: { id: brand.id, name: brand.name },
    generatedAt: new Date().toISOString(),
    rows,
    total: rows.length,
    withAi: generated,
    withoutAi: rows.length - generated,
    byFeature: rows.reduce((acc, r) => {
      acc[r.feature] = (acc[r.feature] || 0) + 1;
      return acc;
    }, {}),
  };
}

// ---------------------------------------------------------------- CSV export
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The three scoring columns are intentionally left blank — they are what the
// SEO team fills in. `better` is deliberately a free-text column rather than a
// dropdown so a reviewer can write "neither" or "both wrong", which is a real
// and important answer that a forced binary choice would hide.
const HEADERS = [
  'feature', 'item', 'context',
  'deterministic_output', 'ai_output', 'ai_status',
  'better (deterministic / ai / neither / both)', 'why', 'reviewer',
];

function toCsv(comparison) {
  const lines = [HEADERS.map(csvEscape).join(',')];
  comparison.rows.forEach((r) => {
    lines.push([
      r.feature, r.item, r.context, r.deterministic, r.ai, r.aiStatus, '', '', '',
    ].map(csvEscape).join(','));
  });
  // BOM so Excel opens UTF-8 correctly, matching the other exports in this app.
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = {
  build, toCsv, HEADERS,
  linkingRows, cannibalisationRows, opportunityRows, briefRows,
};
