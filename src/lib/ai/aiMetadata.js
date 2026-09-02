// AI Metadata Optimization — reads the pages the technical audit already
// flagged as missing or duplicating a title/meta description (read-only, the
// audit crawler itself is never touched), takes up to MAX_PAGES of them, and
// makes ONE batched AI call asking for a suggested title + meta description
// per page.
const db = require('../../db');
const csvStore = require('../csvStore');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const MAX_PAGES = 25;
const WEAK_ISSUE_IDS = ['missing_title', 'dup_titles', 'missing_meta', 'dup_meta'];

const SYSTEM_PROMPT = 'You are an SEO metadata specialist. You will be given a JSON array of pages with weak metadata (missing or duplicated title / meta description), each with an id, url, and the issue(s) found. For EACH one, write a suggested title tag (50-60 characters) and a suggested meta description (140-160 characters), both unique to that page and based on the URL/topic given. Return a JSON object of the exact shape {"suggestions": [{"id": "<same id>", "title": "...", "description": "..."}]}, one per input, same order, no omissions. Return JSON only, no prose.';

function latestCompletedRun(brandId) {
  return db.prepare(`SELECT * FROM audit_runs WHERE brand_id=? AND status='completed' AND json_result IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brandId);
}

// Pulls every page flagged for a missing/duplicated title or meta description
// out of the normalised audit findings, dedupes by URL (a page can appear in
// more than one of the four finding types), and caps at MAX_PAGES.
function weakMetadataPages(jsonResult) {
  const report = csvStore.normaliseAuditFindings(jsonResult);
  if (!report) return [];

  const byUrl = new Map();
  const allFindings = [...report.failing, ...report.passing];
  allFindings
    .filter((f) => WEAK_ISSUE_IDS.includes(f.id))
    .forEach((f) => {
      f.items.forEach((item) => {
        if (!item.url) return;
        if (!byUrl.has(item.url)) byUrl.set(item.url, { url: item.url, issues: [] });
        byUrl.get(item.url).issues.push(f.issue);
      });
    });

  return Array.from(byUrl.values()).slice(0, MAX_PAGES).map((p, i) => ({
    id: String(i),
    url: p.url,
    issues: [...new Set(p.issues)],
  }));
}

function findCached(brandId, inputHash) {
  return db.prepare(`SELECT * FROM ai_metadata_notes WHERE brand_id=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, inputHash);
}

async function generate(brand, { force = false } = {}) {
  const run = latestCompletedRun(brand.id);
  if (!run) return { ok: true, row: null, cached: false, run: null, pages: [], empty: true };

  const pages = weakMetadataPages(run.json_result);
  const inputHash = hashInputs({ runId: run.id, pages: pages.map((p) => [p.url, p.issues.join('|')]) });

  if (!force) {
    const cached = findCached(brand.id, inputHash);
    if (cached) return { ok: true, row: cached, cached: true, run, pages };
  }

  if (!pages.length) return { ok: true, row: null, cached: false, run, pages, empty: true };

  const userPrompt = JSON.stringify({ brand: brand.name, pages });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'metadata', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt,
    maxTokens: Math.min(4000, 120 * pages.length + 200),
  });

  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  const byId = new Map(suggestions.map((s) => [String(s.id), { title: String(s.title || ''), description: String(s.description || '') }]));

  const res = db.prepare(`INSERT INTO ai_metadata_notes (brand_id, input_hash, notes_json, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?)`)
    .run(brand.id, inputHash, JSON.stringify(Object.fromEntries(byId)), promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_metadata_notes WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, run, pages };
}

module.exports = { generate, weakMetadataPages, latestCompletedRun, findCached, MAX_PAGES };
