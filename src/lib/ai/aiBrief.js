// AI Content Brief — AI Assist's AI-written fields for lib/contentBrief.js's briefs.
//
// Reuses clustering.js's already-computed cluster (via contentBrief.findCluster,
// which is a read-only lookup into an existing keyword_run — it does not call
// any of contentBrief.js's own generation logic) so the comparison is fair:
// the real, already-computed factual fields (word-count range, internal link
// suggestions) come from the same data both features share; only the
// creative fields (title, headings, angle note) are written by AI here.
const db = require('../../db');
const csvStore = require('../csvStore');
const contentBrief = require('../contentBrief');
const azureClient = require('./azureClient');
const { hashInputs } = require('./hash');

const SYSTEM_PROMPT = 'You are an SEO content strategist. Given a keyword cluster, return a JSON object with exactly these keys: "title" (a compelling, specific page title, no quotes), "headings" (an array of 4-7 short H2-style heading strings covering the topic in a logical order), and "angle_note" (1-2 sentences on the unique angle/hook this page should take versus generic competitor content). Be specific and concrete, never generic filler. Return JSON only, no prose.';

function crawlContextFor(brandId) {
  const latestLinking = db.prepare(`SELECT out_dir FROM linking_runs
    WHERE brand_id=? AND status='completed' AND out_dir IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(brandId);
  if (!latestLinking) return { wordCountRange: null, internalLinkCandidates: [] };
  const crawlPages = csvStore.readCrawlData(latestLinking.out_dir);
  const wordCountRange = contentBrief.wordCountRange(crawlPages);
  const internalLinkCandidates = crawlPages
    .filter((p) => p.kind === 'content' && p.url)
    .slice(0, 15)
    .map((p) => ({ url: p.url, title: p.title || null }));
  return { wordCountRange, internalLinkCandidates };
}

function clusterKeyFor(keywordRunId, clusterId) {
  return `${keywordRunId}:${clusterId}`;
}

function parseClusterKey(clusterKey) {
  const [keywordRunId, clusterId] = String(clusterKey || '').split(':');
  return { keywordRunId: Number(keywordRunId), clusterId: Number(clusterId) };
}

function findCached(brandId, clusterKey, inputHash) {
  return db.prepare(`SELECT * FROM ai_content_briefs WHERE brand_id=? AND cluster_key=? AND input_hash=?
    ORDER BY id DESC LIMIT 1`).get(brandId, clusterKey, inputHash);
}

function latestForClusterKey(brandId, clusterKey) {
  return db.prepare(`SELECT * FROM ai_content_briefs WHERE brand_id=? AND cluster_key=?
    ORDER BY id DESC LIMIT 1`).get(brandId, clusterKey);
}

// Resolves the cluster and its real, already-computed inputs. Returns null
// if the run/cluster cannot be found.
function resolve(userId, brand, clusterKey) {
  const { keywordRunId, clusterId } = parseClusterKey(clusterKey);
  if (!keywordRunId || !clusterId) return null;
  const found = contentBrief.findCluster(userId, keywordRunId, clusterId);
  if (!found) return null;
  const { run, cluster } = found;
  const crawl = crawlContextFor(brand.id);
  return { run, cluster, ...crawl };
}

async function generate(userId, brand, clusterKey, { force = false } = {}) {
  const resolved = resolve(userId, brand, clusterKey);
  if (!resolved) return { ok: false, error: 'Cluster not found in that keyword run.' };
  const { cluster, wordCountRange, internalLinkCandidates } = resolved;

  const inputHash = hashInputs({
    primaryKeyword: cluster.primaryKeyword,
    supportingKeywords: cluster.supportingKeywords,
    intent: cluster.intent,
    vertical: brand.vertical || 'other',
    services: brand.services_json || null,
  });

  if (!force) {
    const cached = findCached(brand.id, clusterKey, inputHash);
    if (cached) return { ok: true, row: cached, cached: true };
  }

  let services = [];
  try { services = brand.services_json ? JSON.parse(brand.services_json) : []; } catch { services = []; }

  const userPrompt = JSON.stringify({
    primaryKeyword: cluster.primaryKeyword,
    supportingKeywords: cluster.supportingKeywords.slice(0, 20),
    searchIntent: cluster.intent,
    vertical: brand.vertical || 'other',
    brandName: brand.name,
    brandServices: services.slice(0, 10).map((s) => s.name),
  });

  const { data, promptTokens, completionTokens, costUsd } = await azureClient.generate({
    feature: 'brief', brandId: brand.id, systemPrompt: SYSTEM_PROMPT, userPrompt, maxTokens: 600,
  });

  const headings = Array.isArray(data.headings) ? data.headings.map(String) : [];
  const title = String(data.title || cluster.primaryKeyword);
  const angleNote = String(data.angle_note || '');

  const res = db.prepare(`INSERT INTO ai_content_briefs
    (brand_id, cluster_key, input_hash, title, headings_json, angle_note, prompt_tokens, completion_tokens, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(brand.id, clusterKey, inputHash, title, JSON.stringify(headings), angleNote, promptTokens, completionTokens, costUsd);

  const row = db.prepare('SELECT * FROM ai_content_briefs WHERE id=?').get(res.lastInsertRowid);
  return { ok: true, row, cached: false, wordCountRange, internalLinkCandidates };
}

module.exports = {
  clusterKeyFor, parseClusterKey, resolve, generate, findCached, latestForClusterKey, crawlContextFor,
};
