// AI Opportunity Recommendations — AI Assist's rewrite of
// lib/opportunities.js's findings. Reads the real, already-computed findings via
// opportunities.analyse() (read-only), then makes ONE batched AI call
// covering every finding for the brand, asking for a punchier, more specific
// recommendation string per finding. The underlying numbers are identical
// either way — only the recommendation text differs.
const db = require('../../db');
const opportunities = require('../opportunities');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const SYSTEM_PROMPT = 'You are a senior SEO consultant. You will be given a JSON array of SEO findings, each with an id, type, page/query and key numbers. For EACH finding, write one punchy, specific, human-readable recommendation sentence (max ~30 words) that goes beyond a generic template — reference the actual numbers/URL/query given. Return a JSON object of the exact shape {"recommendations": [{"id": "<same id as input>", "text": "..."}]}, one entry per input finding, same order, no omissions. Return JSON only, no prose.';

function compactFindings(result) {
  return result.opportunities.slice(0, 60).map((o, i) => ({
    id: `${o.type}:${i}`,
    type: o.typeLabel,
    page: o.page || null,
    query: o.query || null,
    estimatedGain: o.estimatedGain,
    severity: o.severity,
    existingRecommendation: o.action,
  }));
}

function findCached(brandId, inputHash) {
  return db.prepare(`SELECT * FROM ai_opportunity_notes WHERE brand_id=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, inputHash);
}

async function generate(brand, { force = false } = {}) {
  const result = opportunities.analyse(brand);
  const findings = compactFindings(result);

  const inputHash = hashInputs(findings.map((f) => ({ id: f.id, page: f.page, query: f.query, estimatedGain: f.estimatedGain })));

  if (!force) {
    const cached = findCached(brand.id, inputHash);
    if (cached) return { ok: true, row: cached, cached: true, result, findings };
  }

  if (!findings.length) {
    return { ok: true, row: null, cached: false, result, findings, empty: true };
  }

  const userPrompt = JSON.stringify({ brand: brand.name, vertical: brand.vertical || 'other', findings });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'opportunities', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt,
    maxTokens: Math.min(4000, 120 * findings.length + 200),
  });

  const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
  const byId = new Map(recs.map((r) => [String(r.id), String(r.text || '')]));

  const res = db.prepare(`INSERT INTO ai_opportunity_notes (brand_id, input_hash, findings_json, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?)`)
    .run(brand.id, inputHash, JSON.stringify(Object.fromEntries(byId)), promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_opportunity_notes WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, result, findings };
}

module.exports = { generate, compactFindings, findCached };
