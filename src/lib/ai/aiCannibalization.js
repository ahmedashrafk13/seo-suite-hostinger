// AI Cannibalisation Verdict — the AI Lab counterpart to the deterministic
// cannibalisation findings.
//
// The deterministic path is UNCHANGED and remains the source of truth: the
// Python linking agent's own cannibalization.xlsx (content-similarity based)
// and opportunities.js's `cannibalisation` detector (GSC query/page based)
// both run exactly as before, with no AI involvement and no cost.
//
// This module adds a second, independent opinion on the SAME findings so the
// SEO team can compare the two and decide which they trust. It never replaces
// a deterministic verdict, never writes to the task backlog, and is only ever
// invoked by an explicit button click in the AI Lab.
const db = require('../../db');
const csvStore = require('../csvStore');
const opportunities = require('../opportunities');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const MAX_ITEMS = 25;

const SYSTEM_PROMPT = 'You are a technical SEO specialist reviewing suspected keyword cannibalisation. You will be given a JSON array of findings, each with an id, the competing URLs, the shared keyword or query, and the supporting numbers. For EACH finding decide what should actually happen and return {"verdicts": [{"id": "<same id>", "action": "consolidate|differentiate|leave-alone|investigate", "target": "<the URL you would keep, or empty>", "text": "<one specific sentence, max ~35 words, referencing the actual URLs and numbers>"}]}, one entry per input, same order, no omissions. Return JSON only, no prose.';

function latestCompletedRun(brandId) {
  return db.prepare(`SELECT * FROM linking_runs WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brandId);
}

// Both deterministic sources, normalised into one shape.
//
// They genuinely measure different things — the crawler compares page CONTENT,
// the opportunity engine compares which URLs Google shows for a QUERY — so
// they are labelled by source rather than merged, and a page pair flagged by
// both is the strongest signal available.
function deterministicFindings(brand) {
  const items = [];

  const run = latestCompletedRun(brand.id);
  if (run) {
    const table = csvStore.readTable(run.out_dir, 'cannibalization', { perPage: 500 });
    (table ? table.rows : []).forEach((r, i) => {
      items.push({
        id: `crawl:${i}`,
        source: 'crawler (content similarity)',
        severity: r.severity || null,
        sharedKeyword: r.shared_keyword || null,
        urls: [r.page_a, r.page_b].filter(Boolean),
        evidence: r.evidence || null,
        deterministicRecommendation: r.recommendation || null,
        similarity: r.similarity != null ? Number(r.similarity) : null,
      });
    });
  }

  let gscFindings = [];
  try {
    gscFindings = opportunities.cannibalisation(brand.id, {}, null) || [];
  } catch {
    gscFindings = [];
  }
  gscFindings.forEach((o, i) => {
    items.push({
      id: `gsc:${i}`,
      source: 'search console (query/page split)',
      severity: o.severity,
      sharedKeyword: o.query,
      urls: (o.evidence && o.evidence.pages) || [],
      evidence: o.summary,
      deterministicRecommendation: o.action,
      impressions: o.evidence && o.evidence.impressions,
      expectedClicks: o.expectedClicks,
    });
  });

  return items.slice(0, MAX_ITEMS);
}

function compact(items) {
  return items.map((it) => ({
    id: it.id,
    sharedKeyword: it.sharedKeyword,
    urls: (it.urls || []).slice(0, 6),
    severity: it.severity,
    evidence: typeof it.evidence === 'string' ? it.evidence.slice(0, 300) : it.evidence,
  }));
}

function findCached(brandId, inputHash) {
  return db.prepare(`SELECT * FROM ai_cannibalization_notes WHERE brand_id=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, inputHash);
}

// Created lazily so this feature needs no migration step and an install that
// never opens the AI Lab never grows the table.
function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS ai_cannibalization_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    verdicts_json TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function generate(brand, { force = false } = {}) {
  ensureTable();
  const items = deterministicFindings(brand);
  if (!items.length) return { ok: true, row: null, cached: false, items, empty: true };

  const findings = compact(items);
  const inputHash = hashInputs(findings);

  if (!force) {
    const cached = findCached(brand.id, inputHash);
    if (cached) return { ok: true, row: cached, cached: true, items };
  }

  const userPrompt = JSON.stringify({ brand: brand.name, findings });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'cannibalization', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt,
    maxTokens: Math.min(4000, 140 * findings.length + 200),
  });

  const verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  const byId = Object.fromEntries(verdicts.map((v) => [String(v.id), {
    action: String(v.action || ''),
    target: String(v.target || ''),
    text: String(v.text || ''),
  }]));

  const res = db.prepare(`INSERT INTO ai_cannibalization_notes
    (brand_id, input_hash, verdicts_json, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?)`)
    .run(brand.id, inputHash, JSON.stringify(byId), promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_cannibalization_notes WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, items };
}

module.exports = { generate, deterministicFindings, findCached, ensureTable, MAX_ITEMS };
