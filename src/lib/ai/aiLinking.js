// AI Linking Rationale — reads the existing recommendations.xlsx output via
// csvStore (read-only, existing reader; the Python agent itself is never
// touched), takes the top N by priority (capped at 25 to control cost), and
// makes ONE batched AI call asking for a short "why this link matters"
// rationale per source -> target -> anchor triple.
const db = require('../../db');
const csvStore = require('../csvStore');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const MAX_RECS = 25;

const SYSTEM_PROMPT = 'You are an SEO internal-linking specialist. You will be given a JSON array of internal link recommendations, each with an id, source URL, target URL, and anchor text. For EACH one, write a short (1 sentence, max ~25 words) plain-English rationale explaining why this specific link matters for SEO/user journey, referencing the actual URLs/anchor given. Return a JSON object of the exact shape {"rationales": [{"id": "<same id>", "text": "..."}]}, one per input, same order, no omissions. Return JSON only, no prose.';

function latestCompletedRun(brandId) {
  return db.prepare(`SELECT * FROM linking_runs WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brandId);
}

function topRecommendations(outDir) {
  const table = csvStore.readTable(outDir, 'recommendations', { perPage: MAX_RECS, sort: 'priority', dir: 'asc' });
  if (!table) return [];
  return table.rows.slice(0, MAX_RECS).map((r, i) => ({
    id: String(i),
    source_url: r.source_url,
    target_url: r.target_url,
    anchor_text: r.anchor_text,
  }));
}

function findCached(brandId, inputHash) {
  return db.prepare(`SELECT * FROM ai_linking_notes WHERE brand_id=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, inputHash);
}

async function generate(brand, { force = false } = {}) {
  const run = latestCompletedRun(brand.id);
  if (!run) return { ok: true, row: null, cached: false, run: null, recs: [], empty: true };

  const recs = topRecommendations(run.out_dir);
  const inputHash = hashInputs({ runId: run.id, recs: recs.map((r) => [r.source_url, r.target_url, r.anchor_text]) });

  if (!force) {
    const cached = findCached(brand.id, inputHash);
    if (cached) return { ok: true, row: cached, cached: true, run, recs };
  }

  if (!recs.length) return { ok: true, row: null, cached: false, run, recs, empty: true };

  const userPrompt = JSON.stringify({ brand: brand.name, recommendations: recs });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'linking', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt,
    maxTokens: Math.min(3000, 100 * recs.length + 200),
  });

  const rationales = Array.isArray(data.rationales) ? data.rationales : [];
  const byId = new Map(rationales.map((r) => [String(r.id), String(r.text || '')]));

  const res = db.prepare(`INSERT INTO ai_linking_notes (brand_id, input_hash, notes_json, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?)`)
    .run(brand.id, inputHash, JSON.stringify(Object.fromEntries(byId)), promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_linking_notes WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, run, recs };
}

module.exports = { generate, topRecommendations, latestCompletedRun, findCached, MAX_RECS };
