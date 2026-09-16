// Persistence for client reports.
//
// The row is created before any work starts and updated as the collector moves
// through its stages, because the whole run takes minutes and the page the
// sales rep is looking at has to be able to say WHICH minute it is in. A
// spinner with no stage name is indistinguishable from a hang.
const db = require('../../db');

function parse(json, fallback = null) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    result: parse(row.json_result),
    progress: parse(row.progress_json, []),
    sourceRuns: parse(row.source_runs_json, {}),
  };
}

function begin({
  userId, createdBy = null, url, domain = null, company = null,
  preparedFor = null, market = null, depth = 'full',
}) {
  const info = db.prepare(`INSERT INTO client_reports
      (user_id, created_by, url, domain, company, prepared_for, market, depth, status, stage, progress_json)
    VALUES (?,?,?,?,?,?,?,?,'running',?,?)`)
    .run(userId, createdBy, url, domain, company, preparedFor, market, depth,
      'Starting', JSON.stringify([]));
  return Number(info.lastInsertRowid);
}

// One line per completed stage, kept as a list rather than a single "current
// stage" string: when a collector step fails, the report is still produced
// from the rest, and the list is the only record of which steps contributed.
function stage(reportId, label, { ok = true, note = null } = {}) {
  const row = db.prepare('SELECT progress_json FROM client_reports WHERE id=?').get(reportId);
  if (!row) return;
  const progress = parse(row.progress_json, []);
  progress.push({ label, ok, note, at: new Date().toISOString().slice(11, 19) });
  db.prepare('UPDATE client_reports SET stage=?, progress_json=? WHERE id=?')
    .run(label, JSON.stringify(progress.slice(-40)), reportId);
}

function finish(reportId, { score = null, grade = null, result = null, sourceRuns = null } = {}) {
  const row = db.prepare('SELECT started_at FROM client_reports WHERE id=?').get(reportId);
  const ms = row
    ? Date.now() - Date.parse(`${String(row.started_at).replace(' ', 'T')}Z`)
    : null;
  db.prepare(`UPDATE client_reports SET status='completed', score=?, grade=?, json_result=?,
      source_runs_json=?, stage='Done', finished_at=datetime('now'), ms=? WHERE id=?`)
    .run(score, grade, result ? JSON.stringify(result) : null,
      sourceRuns ? JSON.stringify(sourceRuns) : null,
      Number.isFinite(ms) && ms > 0 ? ms : null, reportId);
}

function fail(reportId, err) {
  const message = (err && err.message) || String(err || 'Unknown error');
  db.prepare(`UPDATE client_reports SET status='error', error=?, stage='Failed',
      finished_at=datetime('now') WHERE id=?`)
    .run(message.slice(0, 2000), reportId);
}

function get(reportId, userId) {
  return hydrate(db.prepare('SELECT * FROM client_reports WHERE id=? AND user_id=?')
    .get(reportId, userId));
}

function list(userId, limit = 50) {
  return db.prepare(`SELECT id, url, domain, company, prepared_for, depth, status, stage,
      score, grade, error, started_at, finished_at, ms
    FROM client_reports WHERE user_id=? ORDER BY id DESC LIMIT ?`).all(userId, limit);
}

function remove(reportId, userId) {
  db.prepare('DELETE FROM client_reports WHERE id=? AND user_id=?').run(reportId, userId);
}

// Status for the polling page. `live` is answered by the runner, not here.
function status(reportId, userId) {
  const row = db.prepare(`SELECT id, status, stage, progress_json, score, grade, error
    FROM client_reports WHERE id=? AND user_id=?`).get(reportId, userId);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: parse(row.progress_json, []),
    score: row.score,
    grade: row.grade,
    error: row.error,
  };
}

// Called at boot, for the same reason the AI SEO runner reconciles: Passenger
// stops this app whenever it idles, and a row left saying 'running' polls
// forever, which reads as "still working" rather than "was interrupted".
function reconcileOnBoot() {
  const stale = db.prepare("SELECT id FROM client_reports WHERE status='running'").all();
  if (!stale.length) return { reconciled: 0 };
  db.prepare(`UPDATE client_reports SET status='error',
      error='Interrupted - the application was stopped or restarted while this report was being built. Start it again.',
      stage='Interrupted', finished_at=datetime('now')
    WHERE status='running'`).run();
  return { reconciled: stale.length };
}

module.exports = { begin, stage, finish, fail, get, list, remove, status, reconcileOnBoot };
