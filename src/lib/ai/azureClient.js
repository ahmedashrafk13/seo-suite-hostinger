// Shared Azure OpenAI client, used by both AI Assist and the AI SEO suite.
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

// A generation takes roughly 5-15 seconds in practice, so the ceiling is
// generous rather than tight — but it must exist.
//
// Originally there was none. That was survivable while every call sat inside a
// user's request, where the browser and Passenger both eventually gave up. It
// stopped being survivable once the AI SEO suite began running analyses in the
// background (src/lib/aiseo/runner.js): a request that never settles leaves the
// run row saying 'running' for as long as the process lives, and its result
// page polls forever showing "working…". A timeout turns that into an error
// the page can state.
const REQUEST_TIMEOUT_MS = Number(process.env.AZURE_OPENAI_TIMEOUT_MS) || 120000;

async function callOnce(apiKey, body) {
  const res = await fetch(endpointUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

// { feature, brandId, systemPrompt, userPrompt, maxTokens, temperature }
// Returns { data, promptTokens, completionTokens, costUsd } where `data` is
// the parsed JSON object the model returned.
//
// `feature` and `brandId` are only used for the pre-flight estimate and the
// usage-log row written after a successful call — the caller does not need
// to log usage itself.
//
// `temperature` defaults low (0.2) rather than the API's own default (~1.0).
// Every prompt in this app asks for extraction, classification or a
// structured judgement from data already supplied — never open-ended
// creative writing — so a low temperature does not narrow what the model is
// allowed to say, only how much it hedges/pads/rambles while saying it. Less
// rambling means fewer completion tokens billed for the same answer, and a
// more repeatable answer for the same cached inputs.
async function generate({
  feature, brandId = null, systemPrompt, userPrompt, maxTokens = 800, temperature = 0.2,
}) {
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
    temperature,
    response_format: { type: 'json_object' },
  };

  // A fetch abort surfaces as a bare "This operation was aborted", which reads
  // as an unexplained network fault. Restated so a failed run says what
  // actually happened.
  const describe = (err) => (err && (err.name === 'TimeoutError' || err.name === 'AbortError')
    ? new Error(`Azure OpenAI did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`)
    : err);

  let json;
  try {
    json = await callOnce(process.env.AZURE_OPENAI_KEY_A, body);
  } catch (firstErr) {
    // Retry exactly once, with Key B, in case Key A is rotated/rate-limited.
    if (!process.env.AZURE_OPENAI_KEY_B) throw describe(firstErr);
    try {
      json = await callOnce(process.env.AZURE_OPENAI_KEY_B, body);
    } catch (secondErr) {
      throw describe(secondErr);
    }
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
