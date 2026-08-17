// AI Task Recommendations — reads open tasks via tasks.js's existing
// accessors (read-only), then makes ONE batched AI call covering all open
// tasks for the brand, asking GPT to rewrite each task's recommended action
// into more specific, context-aware phrasing given the task's real fields.
const db = require('../../db');
const tasksLib = require('../tasks');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const MAX_TASKS = 40;

const SYSTEM_PROMPT = 'You are an SEO operations lead. You will be given a JSON array of open SEO tasks, each with an id, title, severity, affected URL, and a summary/detail. For EACH one, rewrite the recommended action into a more specific, context-aware version (max ~35 words) that references the real fields given rather than generic phrasing. Return a JSON object of the exact shape {"actions": [{"id": "<same id>", "text": "..."}]}, one per input task, same order, no omissions. Return JSON only, no prose.';

function openTasksFor(brand) {
  return tasksLib.list(brand.user_id, { brandId: brand.id, onlyOpen: true, limit: MAX_TASKS });
}

function compactTasks(tasks) {
  return tasks.slice(0, MAX_TASKS).map((t) => ({
    id: String(t.id),
    title: t.title,
    severity: t.severity,
    category: t.category,
    affectedUrl: t.affected_url,
    detail: String(t.detail || '').slice(0, 500),
  }));
}

function findCached(brandId, inputHash) {
  return db.prepare(`SELECT * FROM ai_task_notes WHERE brand_id=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, inputHash);
}

async function generate(brand, { force = false } = {}) {
  const tasks = openTasksFor(brand);
  const compact = compactTasks(tasks);
  const inputHash = hashInputs(compact.map((t) => ({ id: t.id, title: t.title, detail: t.detail })));

  if (!force) {
    const cached = findCached(brand.id, inputHash);
    if (cached) return { ok: true, row: cached, cached: true, tasks, compact };
  }

  if (!compact.length) return { ok: true, row: null, cached: false, tasks, compact, empty: true };

  const userPrompt = JSON.stringify({ brand: brand.name, vertical: brand.vertical || 'other', tasks: compact });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'tasks', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt,
    maxTokens: Math.min(4000, 140 * compact.length + 200),
  });

  const actions = Array.isArray(data.actions) ? data.actions : [];
  const byId = new Map(actions.map((a) => [String(a.id), String(a.text || '')]));

  const res = db.prepare(`INSERT INTO ai_task_notes (brand_id, input_hash, notes_json, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?)`)
    .run(brand.id, inputHash, JSON.stringify(Object.fromEntries(byId)), promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_task_notes WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, tasks, compact };
}

module.exports = { generate, openTasksFor, compactTasks, findCached, MAX_TASKS };
