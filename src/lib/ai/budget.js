// Cost tracking + hard budget guard, shared by AI Assist and the AI SEO
// suite (the env var is named AI_LAB_SPEND_CAP_USD for historical reasons —
// it still caps combined spend across both).
//
// Pricing constants are env-configurable, with defaults matching gpt-4.1-mini
// public list pricing as of early 2026: $0.40 / 1M input tokens,
// $1.60 / 1M output tokens. THESE ARE APPROXIMATE DEFAULTS — verify/adjust
// them against the actual Azure Enterprise Agreement pricing page, since
// negotiated rates can differ from public list price.
const db = require('../../db');

const PRICE_INPUT_PER_1M = Number(process.env.AZURE_PRICE_INPUT_PER_1M) || 0.40;
const PRICE_OUTPUT_PER_1M = Number(process.env.AZURE_PRICE_OUTPUT_PER_1M) || 1.60;
const SPEND_CAP_USD = Number(process.env.AI_LAB_SPEND_CAP_USD) || 20;

function costFor(promptTokens, completionTokens) {
  const inputCost = (Number(promptTokens) || 0) * (PRICE_INPUT_PER_1M / 1_000_000);
  const outputCost = (Number(completionTokens) || 0) * (PRICE_OUTPUT_PER_1M / 1_000_000);
  return inputCost + outputCost;
}

function totalSpend() {
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) total FROM ai_usage_log').get();
  return Number(row.total) || 0;
}

// Rough token estimate for text that hasn't been sent yet: ~chars/4, which is
// the same conservative rule of thumb the spec calls for.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Refuses BEFORE any HTTP call is made if:
//  (a) cumulative spend is already at/over the cap, or
//  (b) this call's own worst-case cost (prompt estimate + full maxTokens
//      ceiling for output) would itself push cumulative spend over the cap.
function preflightCheck({ systemPrompt, userPrompt, maxTokens }) {
  const spent = totalSpend();
  if (spent >= SPEND_CAP_USD) {
    return { allowed: false, reason: `AI spend cap of $${SPEND_CAP_USD.toFixed(2)} reached — see the cost dashboard.`, spent };
  }
  const estPromptTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  const estCost = costFor(estPromptTokens, Number(maxTokens) || 0);
  if (spent + estCost > SPEND_CAP_USD) {
    return {
      allowed: false,
      reason: `AI spend cap of $${SPEND_CAP_USD.toFixed(2)} reached — see the cost dashboard.`,
      spent, estCost,
    };
  }
  return { allowed: true, spent, estCost };
}

function logUsage({ brandId, feature, promptTokens, completionTokens, costUsd }) {
  db.prepare(`INSERT INTO ai_usage_log (brand_id, feature, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?)`).run(brandId || null, feature, promptTokens || 0, completionTokens || 0, costUsd || 0);
}

function remaining() {
  return Math.max(0, SPEND_CAP_USD - totalSpend());
}

// Dashboard summary: total spend, spend by feature, remaining budget, history.
function dashboard({ historyLimit = 100 } = {}) {
  const spent = totalSpend();
  const byFeature = db.prepare(`SELECT feature, COUNT(*) calls, SUM(prompt_tokens) prompt_tokens,
      SUM(completion_tokens) completion_tokens, SUM(cost_usd) cost_usd
    FROM ai_usage_log GROUP BY feature ORDER BY cost_usd DESC`).all();
  const history = db.prepare(`SELECT l.*, b.name brand_name FROM ai_usage_log l
    LEFT JOIN brands b ON b.id = l.brand_id
    ORDER BY l.id DESC LIMIT ?`).all(historyLimit);
  return {
    spent, cap: SPEND_CAP_USD, remaining: Math.max(0, SPEND_CAP_USD - spent),
    byFeature, history,
    pricing: { inputPer1M: PRICE_INPUT_PER_1M, outputPer1M: PRICE_OUTPUT_PER_1M },
  };
}

module.exports = {
  PRICE_INPUT_PER_1M, PRICE_OUTPUT_PER_1M, SPEND_CAP_USD,
  costFor, totalSpend, estimateTokens, preflightCheck, logUsage, remaining, dashboard,
};
