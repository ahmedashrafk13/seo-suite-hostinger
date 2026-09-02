// Persistence for every AI SEO analysis: runs, findings, metric time series.
//
// One store rather than nine, because the nine features have one shape. See
// the schema comment in src/db.js for why the tables are generic.
//
// The contract each feature keeps to:
//   const run = store.begin({ userId, brandId, kind, target, params });
//   ... do the work ...
//   store.finish(run.id, { score, result, findings, metrics });
//
// finish() is what writes the findings out of the payload into their own
// table, so the task bridge and the alert engine never have to parse JSON.
const db = require('../../db');
const { hashInputs } = require('../ai/hash');

const KINDS = {
  research: 'Keyword & prompt research',
  onpage: 'On-page optimisation score',
  schema: 'Schema & structured data',
  readiness: 'AI-crawler readiness',
  architecture: 'Internal linking & architecture',
  competitive: 'Competitive intelligence',
  reputation: 'Reputation & ambient signals',
  freshness: 'Freshness & intent drift',
  tracking: 'SEO tracking sweep',
  // Whole-site AI-crawler readiness. Distinct from 'readiness', which scores a
  // single URL: the two answer different questions and a run of one must never
  // be rendered by the other's result page, which is why it is its own kind
  // rather than a flag on the existing one.
  site_readiness: 'AI-crawler readiness (whole site)',
  // Internal link opportunities for ONE target URL. Separate from
  // 'architecture' for the same reason: architecture reports on the whole graph,
  // this reports on one page's inbound gap.
  link_opportunities: 'Internal link opportunities for a URL',
  // Review-platform presence and gaps.
  review_platforms: 'Review platform coverage',
  // Measured AI referral traffic from GA4. The only feature here that reports
  // what AI visibility actually DELIVERED rather than whether it is possible,
  // which is why it is a kind of its own and not a panel on another report.
  ai_referrals: 'AI referral traffic (measured)',
};

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// Opens a run.
//
// `adoptRunId` exists for the background runner in ./runner.js. These analyses
// crawl sites and call PageSpeed, which regularly takes a minute or more —
// far too long to hold an HTTP request open on shared hosting, where Passenger
// will time it out. So the runner creates the row synchronously, hands the
// browser a URL that can be polled, and starts the work detached; the engine
// then ADOPTS that row instead of inserting a second one.
//
// Without adoption the same analysis would produce two rows — one 'running'
// forever from the runner and one real one from the engine — and the result
// page would poll the wrong one indefinitely.
function begin({
  userId, brandId = null, kind, target = null, label = null,
  params = null, inputHash = null, adoptRunId = null,
}) {
  if (!KINDS[kind]) throw new Error(`unknown analysis kind "${kind}"`);
  if (adoptRunId) {
    const existing = db.prepare('SELECT id, kind FROM aiseo_runs WHERE id=?').get(adoptRunId);
    if (existing) {
      // The runner may not have known the final target or label — it is
      // derived inside the engine for several of these — so they are filled
      // in here rather than left null on the row the UI is already showing.
      db.prepare(`UPDATE aiseo_runs SET target=COALESCE(?, target), label=COALESCE(?, label),
        params_json=COALESCE(?, params_json) WHERE id=?`)
        .run(target, label, params ? JSON.stringify(params) : null, adoptRunId);
      return { id: Number(existing.id), kind: existing.kind, startedMs: Date.now(), adopted: true };
    }
    // A vanished row (the user deleted the run while it was in flight) falls
    // through to a fresh insert rather than throwing, so the work is not lost.
  }
  const res = db.prepare(`INSERT INTO aiseo_runs
    (user_id, brand_id, kind, target, label, status, params_json, input_hash)
    VALUES (?,?,?,?,?,'running',?,?)`)
    .run(userId, brandId, kind, target, label, params ? JSON.stringify(params) : null, inputHash);
  return { id: Number(res.lastInsertRowid), kind, startedMs: Date.now() };
}

// Writes the result and normalises the findings.
//
// The whole thing is one transaction. Without that, a crash between the run
// row and the findings leaves a "completed" run whose findings are missing —
// which reads on screen as "this page has no problems" rather than as a
// failure, and is the worst way for this to break.
function finish(runId, { score = null, result = null, findings = [], metrics = [], sources = [] } = {}) {
  const run = db.prepare('SELECT * FROM aiseo_runs WHERE id=?').get(runId);
  if (!run) throw new Error(`run ${runId} not found`);

  const payload = result == null ? null : JSON.stringify({ ...result, sources });
  const ms = Date.now() - Date.parse(`${String(run.started_at).replace(' ', 'T')}Z`) || null;

  db.transaction(() => {
    db.prepare(`UPDATE aiseo_runs SET status='completed', score=?, json_result=?,
      finished_at=datetime('now'), ms=? WHERE id=?`)
      .run(score, payload, Number.isFinite(ms) && ms > 0 ? ms : null, runId);

    // Re-running the same analysis replaces its findings rather than
    // accumulating them, so "how many problems does this run report" always
    // has one answer.
    db.prepare('DELETE FROM aiseo_findings WHERE run_id=?').run(runId);

    const insert = db.prepare(`INSERT OR REPLACE INTO aiseo_findings
      (run_id, user_id, brand_id, kind, check_key, title, detail, severity,
       affected_url, affected_count, action, evidence_json, dedupe_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    findings.forEach((f, i) => {
      const severity = SEVERITIES.includes(f.severity) ? f.severity : 'medium';
      // A finding with no dedupe key of its own still needs one, or the unique
      // index collapses every such finding in a run into a single row.
      const dedupe = f.dedupeKey || `${run.kind}:${f.checkKey || 'finding'}:${f.affectedUrl || i}`;
      insert.run(runId, run.user_id, run.brand_id, run.kind,
        f.checkKey || 'finding', String(f.title || 'Finding').slice(0, 300),
        f.detail == null ? null : String(f.detail),
        severity, f.affectedUrl || null, Number(f.affectedCount) || 1,
        f.action == null ? null : String(f.action),
        f.evidence ? JSON.stringify(f.evidence) : null, dedupe);
    });

    if (metrics.length && run.brand_id) recordMetrics(run.brand_id, metrics);
  })();

  return get(runId);
}

function fail(runId, err) {
  db.prepare(`UPDATE aiseo_runs SET status='error', error=?, finished_at=datetime('now') WHERE id=?`)
    .run(String((err && err.message) || err).slice(0, 500), runId);
}

function get(runId, userId = null) {
  const run = userId == null
    ? db.prepare('SELECT * FROM aiseo_runs WHERE id=?').get(runId)
    : db.prepare('SELECT * FROM aiseo_runs WHERE id=? AND user_id=?').get(runId, userId);
  if (!run) return null;
  let result = null;
  if (run.json_result) { try { result = JSON.parse(run.json_result); } catch { result = null; } }
  let params = null;
  if (run.params_json) { try { params = JSON.parse(run.params_json); } catch { params = null; } }
  return {
    ...run,
    result,
    params,
    findings: findingsFor(runId),
    kindLabel: KINDS[run.kind] || run.kind,
  };
}

function findingsFor(runId) {
  return db.prepare('SELECT * FROM aiseo_findings WHERE run_id=? ORDER BY id').all(runId)
    .map((f) => {
      let evidence = null;
      if (f.evidence_json) { try { evidence = JSON.parse(f.evidence_json); } catch { evidence = null; } }
      return { ...f, evidence };
    })
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

// The list a feature's landing page shows. Findings are counted rather than
// loaded: a list of 30 runs must not pull 30 payloads into memory.
function listRuns({ userId, kind = null, brandId = null, limit = 25 } = {}) {
  const where = ['r.user_id = ?'];
  const args = [userId];
  if (kind) { where.push('r.kind = ?'); args.push(kind); }
  if (brandId) { where.push('r.brand_id = ?'); args.push(brandId); }
  args.push(limit);
  return db.prepare(`SELECT r.id, r.brand_id, r.kind, r.target, r.label, r.status, r.score,
      r.error, r.started_at, r.finished_at, r.ms, b.name brand_name,
      (SELECT COUNT(*) FROM aiseo_findings f WHERE f.run_id = r.id) findings,
      (SELECT COUNT(*) FROM aiseo_findings f WHERE f.run_id = r.id AND f.severity IN ('critical','high')) urgent
    FROM aiseo_runs r LEFT JOIN brands b ON b.id = r.brand_id
    WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`).all(...args);
}

function latestRun({ userId, kind, brandId = null, target = null }) {
  const where = ['user_id = ?', 'kind = ?', "status = 'completed'"];
  const args = [userId, kind];
  if (brandId) { where.push('brand_id = ?'); args.push(brandId); }
  if (target) { where.push('target = ?'); args.push(target); }
  const row = db.prepare(`SELECT id FROM aiseo_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`).get(...args);
  return row ? get(row.id) : null;
}

// The completed run BEFORE the given one, for the same brand/kind/target. This
// is what makes every result page able to say "better or worse than last
// time" rather than only "here is a number".
function previousRun(run) {
  if (!run) return null;
  const where = ['user_id = ?', 'kind = ?', "status = 'completed'", 'id < ?'];
  const args = [run.user_id, run.kind, run.id];
  if (run.brand_id) { where.push('brand_id = ?'); args.push(run.brand_id); }
  if (run.target) { where.push('target = ?'); args.push(run.target); }
  const row = db.prepare(`SELECT id FROM aiseo_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`).get(...args);
  return row ? get(row.id) : null;
}

function removeRun(runId, userId) {
  return db.prepare('DELETE FROM aiseo_runs WHERE id=? AND user_id=?').run(runId, userId).changes;
}

// ---------------------------------------------------------------- metrics

// A metric: { key, url?, value, status?, detail? }
//
// `status` is the tracking board's verdict for that capture — 'good',
// 'warn', 'fail' or 'unknown' — stored alongside the value because the
// threshold that produced it can change, and a historical row should keep the
// verdict it was given at the time rather than be re-judged by today's rule.
function recordMetrics(brandId, metrics, capturedAt = null) {
  if (!brandId || !metrics || !metrics.length) return 0;
  const at = capturedAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const insert = db.prepare(`INSERT OR REPLACE INTO aiseo_metrics
    (brand_id, metric_key, url, captured_at, value, status, detail) VALUES (?,?,?,?,?,?,?)`);
  let n = 0;
  metrics.forEach((m) => {
    if (!m || !m.key) return;
    insert.run(brandId, m.key, m.url || '', at,
      m.value == null ? null : Number(m.value),
      m.status || null, m.detail == null ? null : String(m.detail).slice(0, 500));
    n += 1;
  });
  return n;
}

function metricSeries(brandId, metricKey, { url = '', limit = 90 } = {}) {
  return db.prepare(`SELECT captured_at, value, status, detail FROM aiseo_metrics
    WHERE brand_id=? AND metric_key=? AND url=? ORDER BY captured_at DESC LIMIT ?`)
    .all(brandId, metricKey, url, limit).reverse();
}

function latestMetrics(brandId, { metricKeys = null } = {}) {
  // The newest capture per (metric, url). A plain MAX(captured_at) GROUP BY
  // would give the right timestamp with a value from an arbitrary row, which
  // is the classic SQL mistake here — the correlated subquery avoids it.
  const rows = db.prepare(`SELECT m.* FROM aiseo_metrics m
    WHERE m.brand_id = ? AND m.captured_at = (
      SELECT MAX(m2.captured_at) FROM aiseo_metrics m2
      WHERE m2.brand_id = m.brand_id AND m2.metric_key = m.metric_key AND m2.url = m.url
    ) ORDER BY m.metric_key, m.url`).all(brandId);
  if (!metricKeys) return rows;
  const wanted = new Set(metricKeys);
  return rows.filter((r) => wanted.has(r.metric_key));
}

// The value one capture earlier, so a check can report a delta. Returns null
// when there is no history — which the UI must render as "first capture",
// never as "no change".
function previousMetric(brandId, metricKey, url = '') {
  return db.prepare(`SELECT captured_at, value, status, detail FROM aiseo_metrics
    WHERE brand_id=? AND metric_key=? AND url=? ORDER BY captured_at DESC LIMIT 1 OFFSET 1`)
    .get(brandId, metricKey, url) || null;
}

// --------------------------------------------------------------- AI cache

function cachedAi(feature, inputHash) {
  const row = db.prepare('SELECT * FROM aiseo_ai_cache WHERE feature=? AND input_hash=?').get(feature, inputHash);
  if (!row) return null;
  try { return { ...row, data: JSON.parse(row.data_json) }; } catch { return null; }
}

function cacheAi({ brandId = null, feature, inputHash, data, costUsd = 0 }) {
  db.prepare(`INSERT OR REPLACE INTO aiseo_ai_cache (brand_id, feature, input_hash, data_json, cost_usd)
    VALUES (?,?,?,?,?)`).run(brandId, feature, inputHash, JSON.stringify(data), costUsd);
  return cachedAi(feature, inputHash);
}

// ------------------------------------------------------------ cross-cutting

// Open findings across every AI SEO feature for a brand, newest run per kind.
// The monitoring board and the dashboard read this.
function openFindings({ userId, brandId = null, limit = 200 } = {}) {
  const where = ['f.user_id = ?'];
  const args = [userId];
  if (brandId) { where.push('f.brand_id = ?'); args.push(brandId); }
  args.push(limit);
  return db.prepare(`SELECT f.*, r.target, r.kind run_kind, r.finished_at, b.name brand_name
    FROM aiseo_findings f
    JOIN aiseo_runs r ON r.id = f.run_id
    LEFT JOIN brands b ON b.id = f.brand_id
    WHERE ${where.join(' AND ')}
      AND r.id = (SELECT MAX(r2.id) FROM aiseo_runs r2
                  WHERE r2.kind = r.kind AND r2.user_id = r.user_id
                    AND (r2.brand_id IS r.brand_id) AND r2.status='completed')
    ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.id DESC
    LIMIT ?`).all(...args)
    .map((f) => {
      let evidence = null;
      if (f.evidence_json) { try { evidence = JSON.parse(f.evidence_json); } catch { evidence = null; } }
      return { ...f, evidence };
    });
}

function summaryByKind({ userId, brandId = null } = {}) {
  const where = ['r.user_id = ?', "r.status = 'completed'"];
  const args = [userId];
  if (brandId) { where.push('r.brand_id = ?'); args.push(brandId); }
  const rows = db.prepare(`SELECT r.kind, MAX(r.id) run_id, MAX(r.finished_at) last_run, COUNT(*) runs
    FROM aiseo_runs r WHERE ${where.join(' AND ')} GROUP BY r.kind`).all(...args);
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return Object.entries(KINDS).map(([kind, label]) => {
    const row = byKind.get(kind);
    if (!row) return { kind, label, runs: 0, lastRun: null, score: null, findings: 0, urgent: 0 };
    const run = db.prepare('SELECT score FROM aiseo_runs WHERE id=?').get(row.run_id);
    const counts = db.prepare(`SELECT COUNT(*) n,
        SUM(CASE WHEN severity IN ('critical','high') THEN 1 ELSE 0 END) urgent
      FROM aiseo_findings WHERE run_id=?`).get(row.run_id);
    return {
      kind, label, runs: row.runs, lastRun: row.last_run, runId: row.run_id,
      score: run ? run.score : null,
      findings: counts.n || 0, urgent: counts.urgent || 0,
    };
  });
}

module.exports = {
  KINDS, SEVERITIES, SEVERITY_RANK,
  begin, finish, fail, get, findingsFor, listRuns, latestRun, previousRun, removeRun,
  recordMetrics, metricSeries, latestMetrics, previousMetric,
  cachedAi, cacheAi, hashInputs,
  openFindings, summaryByKind,
};
