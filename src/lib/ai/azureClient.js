// Shared Azure OpenAI client for the AI Lab.
//
// Wraps the OpenAI-compatible chat completions surface Azure exposes at
// `${AZURE_OPENAI_ENDPOINT}/chat/completions`. Confirmed working via a real
// call: HTTP 200, `response_format: { type: 'json_object' }` returns clean
// parseable JSON with no prose padding, and usage is reported as
// `{ prompt_tokens, completion_tokens }` in the OpenAI shape.
//
// Cost control lives in ./budget.js, which every call here goes through
// BEFORE any HTTP request is made — this module never calls the API without
// that check passing first, and never retries more than once (Key A, then
// Key B, then fail).
const budget = require('./budget');

function endpointUrl() {
  const base = String(process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

async function callOnce(apiKey, body) {
  const res = await fetch(endpointUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`Azure OpenAI request failed (HTTP ${res.status}): ${(json && json.error && json.error.message) || text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// { feature, brandId, systemPrompt, userPrompt, maxTokens }
// Returns { data, promptTokens, completionTokens, costUsd } where `data` is
// the parsed JSON object the model returned.
//
// `feature` and `brandId` are only used for the pre-flight estimate and the
// usage-log row written after a successful call — the caller does not need
// to log usage itself.
async function generate({ feature, brandId = null, systemPrompt, userPrompt, maxTokens = 800 }) {
  if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_KEY_A) {
    throw new Error('Azure OpenAI is not configured (missing AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY_A).');
  }

  // Hard cap + conservative pre-flight estimate — refuses BEFORE any network
  // call if the cap is already reached or this call alone could blow past it.
  const preflight = budget.preflightCheck({ systemPrompt, userPrompt, maxTokens });
  if (!preflight.allowed) {
    const err = new Error(preflight.reason);
    err.budgetBlocked = true;
    throw err;
  }

  const body = {
    model: process.env.AZURE_OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };

  let json;
  try {
    json = await callOnce(process.env.AZURE_OPENAI_KEY_A, body);
  } catch (firstErr) {
    // Retry exactly once, with Key B, in case Key A is rotated/rate-limited.
    if (!process.env.AZURE_OPENAI_KEY_B) throw firstErr;
    json = await callOnce(process.env.AZURE_OPENAI_KEY_B, body);
  }

  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  const content = message ? message.content : null;
  if (!content) throw new Error('Azure OpenAI returned no content.');

  let data;
  try { data = JSON.parse(content); } catch (e) {
    throw new Error(`Azure OpenAI did not return valid JSON: ${e.message}`);
  }

  const usage = json.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const costUsd = budget.costFor(promptTokens, completionTokens);

  budget.logUsage({ brandId, feature, promptTokens, completionTokens, costUsd });

  return { data, promptTokens, completionTokens, costUsd };
}

module.exports = { generate, endpointUrl };
