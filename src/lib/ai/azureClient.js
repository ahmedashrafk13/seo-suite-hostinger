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

// The largest cap a truncation retry may ask for. Deliberately finite: the
// retry exists to rescue an answer that nearly fitted, not to let one call
// consume the whole daily budget.
const TRUNCATION_RETRY_CEILING = Number(process.env.AZURE_OPENAI_MAX_TOKENS_CEILING || 8000);

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

  const buildBody = (cap) => ({
    model: process.env.AZURE_OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: cap,
    temperature,
    response_format: { type: 'json_object' },
  });
  const body = buildBody(maxTokens);

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

  // TRUNCATION IS THE COMMON FAILURE, AND IT USED TO LIE ABOUT ITSELF.
  //
  // response_format json_object guarantees the model AIMS at valid JSON, not
  // that it finishes: when the answer needs more room than max_tokens allows,
  // the reply is cut off mid-string and JSON.parse reports something like
  // "Unterminated string in JSON at position 8401". That reads as a broken
  // model or a broken prompt. It is neither — it is a budget that was too
  // small, and the API says so plainly in finish_reason, which nothing here
  // was reading.
  //
  // So: detect it, and RETRY ONCE with a bigger cap rather than merely
  // explaining the failure. Most truncations clear on the second attempt
  // because the first got most of the way there.
  const readChoice = (payload) => {
    const choice = payload && payload.choices && payload.choices[0];
    return {
      content: (choice && choice.message) ? choice.message.content : null,
      finishReason: choice ? choice.finish_reason : null,
    };
  };

  let { content, finishReason } = readChoice(json);
  let effectiveCap = maxTokens;

  if (finishReason === 'length') {
    // Double it, but stay inside a ceiling: an unbounded retry could bill a
    // large call twice over, and a prompt that needs more than this is asking
    // the wrong question rather than needing more room.
    const retryCap = Math.min(maxTokens * 2, TRUNCATION_RETRY_CEILING);
    if (retryCap > maxTokens) {
      // The retry costs real tokens, so it goes through the same budget gate
      // as the first attempt rather than sneaking past it.
      const retryPreflight = budget.preflightCheck({ systemPrompt, userPrompt, maxTokens: retryCap });
      if (retryPreflight.allowed) {
        try {
          const retryJson = await callOnce(process.env.AZURE_OPENAI_KEY_A, buildBody(retryCap));
          const retry = readChoice(retryJson);
          if (retry.content) {
            json = retryJson;
            content = retry.content;
            finishReason = retry.finishReason;
            effectiveCap = retryCap;
          }
        } catch (retryErr) {
          // Keep the first response and let the checks below report on it —
          // a failed retry must not replace "the answer was too long" with a
          // network error that happened afterwards.
        }
      }
    }
  }

  if (!content) throw new Error('Azure OpenAI returned no content.');

  if (finishReason === 'length') {
    throw new Error(
      `Azure OpenAI ran out of output room: the reply was cut off at the ${effectiveCap}-token limit`
      + `${effectiveCap !== maxTokens ? ` (retried from ${maxTokens})` : ''}`
      + ', so the JSON it returned is incomplete. Ask for fewer items, or raise maxTokens for this feature.'
    );
  }

  let data;
  try { data = JSON.parse(content); } catch (e) {
    // Reaching here with a normal finish_reason means the model produced
    // something that is genuinely not JSON, which is a different problem from
    // truncation and deserves a different message.
    throw new Error(
      `Azure OpenAI did not return valid JSON: ${e.message}`
      + ` (finish_reason=${finishReason || 'unknown'}, ${String(content).length} characters returned)`
    );
  }

  const usage = json.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const costUsd = budget.costFor(promptTokens, completionTokens);

  budget.logUsage({ brandId, feature, promptTokens, completionTokens, costUsd });

  return { data, promptTokens, completionTokens, costUsd };
}

module.exports = { generate, endpointUrl };
