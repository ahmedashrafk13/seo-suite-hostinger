// Task management.
//
// Tasks are the system's output. Alerts, audits, linking crawls and the
// opportunity engine all converge here as concrete, assignable work — which is
// the whole point of the operating rule: the automation identifies, analyses,
// recommends and creates tasks, and a human decides and executes.
//
// APPROVAL GATE
// Certain actions must never be applied automatically because getting them
// wrong damages rankings. A task whose work touches one of those actions is
// created with requires_approval = 1 and cannot be moved to "done" until
// someone on the SEO team has explicitly approved it. The list is defined
// once, here, and matched against every task as it is created.
const db = require('../db');

// The restricted actions, straight from the operating rule.
const APPROVAL_RULES = [
  { id: 'publish_content', label: 'Publishing content', test: /\b(publish|go live|publishing)\b/i },
  { id: 'change_urls', label: 'Changing URLs', test: /\b(change|rename|update|migrate)\s+(the\s+)?url|url\s+(change|structure|slug)|change\s+slug\b/i },
  { id: 'canonical', label: 'Editing canonical tags', test: /\bcanonical/i },
  { id: 'robots', label: 'Updating robots.txt', test: /robots\.txt/i },
  { id: 'remove_redirect', label: 'Removing or redirecting pages', test: /\b(redirect|301|410|remove the page|delete the page|deindex|noindex)\b/i },
  { id: 'bulk_internal_links', label: 'Adding large volumes of internal links', test: /\b(bulk|large volume|all recommended|apply all)\b.*\blinks?\b|\blinks?\b.*\b(in bulk|bulk apply)\b/i },
  { id: 'high_perf_titles', label: 'Changing titles on high-performing pages', test: /\b(title|meta title)\b.*\b(high[- ]performing|top[- ]performing|best[- ]performing)\b/i },
  { id: 'sitemap', label: 'Changing the sitemap', test: /\bsitemap\b/i },
];

const STATUSES = [
  { value: 'backlog', label: 'Backlog', description: 'Identified, not started' },
  { value: 'in_progress', label: 'In progress', description: 'Someone is working on it' },
  { value: 'awaiting_approval', label: 'Awaiting SEO approval', description: 'Work is ready but needs sign-off before it goes live' },
  { value: 'blocked', label: 'Blocked', description: 'Cannot proceed — waiting on something external' },
  { value: 'done', label: 'Done', description: 'Completed and verified' },
  { value: 'dismissed', label: 'Dismissed', description: 'Reviewed and deliberately not doing' },
];

const OPEN_STATUSES = ['backlog', 'in_progress', 'awaiting_approval', 'blocked'];

const SEVERITY_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4, info: 5 };

const SOURCES = {
  alert: 'Alert',
  audit: 'Technical audit',
  linking: 'Internal linking',
  opportunity: 'Content opportunity',
  manual: 'Added by hand',
};

// Decides whether a task needs sign-off, and which rules triggered that.
function classifyApproval(title, detail) {
  const text = `${title || ''}\n${detail || ''}`;
  const matched = APPROVAL_RULES.filter((r) => r.test.test(text));
  return { requiresApproval: matched.length > 0, matched: matched.map((m) => m.label) };
}

// Creates a task, or updates the existing one when `dedupeKey` has been seen.
// Dedupe is what keeps a daily scheduler from producing 400 duplicate tasks:
// the same finding in the same period maps to one task, and re-running the
// engine refreshes its evidence rather than cloning it.
function upsertTask({
  userId, brandId, title, detail, source = 'manual', sourceRef = null,
  category = null, severity = 'medium', affectedUrl = null,
  evidence = null, dedupeKey = null, assignee = null, dueDate = null,
  effort = null, requiresApproval = null,
}) {
  const approval = classifyApproval(title, detail);
  const needsApproval = requiresApproval == null ? approval.requiresApproval : Boolean(requiresApproval);
  const priority = SEVERITY_PRIORITY[severity] || 3;
  const evidenceJson = evidence ? JSON.stringify({
    ...evidence,
    ...(approval.matched.length ? { approvalReasons: approval.matched } : {}),
  }) : (approval.matched.length ? JSON.stringify({ approvalReasons: approval.matched }) : null);

  if (dedupeKey) {
    const existing = db.prepare('SELECT * FROM tasks WHERE dedupe_key = ?').get(dedupeKey);
    if (existing) {
      // Never resurrect a task someone has already closed out — that would
      // undo a deliberate human decision on every scheduler tick.
      if (existing.status === 'done' || existing.status === 'dismissed') {
        return { task: existing, created: false, skipped: 'already closed' };
      }
      // The title has to be refreshed along with the detail, or it goes stale
      // and contradicts its own body. A re-run that finds 149 orphan pages was
      // updating the detail while leaving the title reading "Link to 60 orphan
      // pages" — and the title is the part anyone actually reads in a list.
      //
      // Human edits win: `update()` logs an `edited` event, so a task whose
      // title someone has deliberately rewritten keeps that wording and only
      // its detail and evidence are refreshed.
      const manuallyEdited = db.prepare(
        "SELECT COUNT(*) c FROM task_events WHERE task_id=? AND kind='edited'",
      ).get(existing.id).c > 0;

      if (manuallyEdited) {
        db.prepare(`UPDATE tasks SET detail=?, severity=?, priority=?, evidence_json=?,
          affected_url=COALESCE(?, affected_url), updated_at=datetime('now') WHERE id=?`)
          .run(detail, severity, priority, evidenceJson, affectedUrl, existing.id);
      } else {
        db.prepare(`UPDATE tasks SET title=?, detail=?, severity=?, priority=?, evidence_json=?,
          affected_url=COALESCE(?, affected_url), updated_at=datetime('now') WHERE id=?`)
          .run(title, detail, severity, priority, evidenceJson, affectedUrl, existing.id);
      }
      return { task: db.prepare('SELECT * FROM tasks WHERE id=?').get(existing.id), created: false, updated: true };
    }
  }

  const res = db.prepare(`INSERT INTO tasks
    (user_id, brand_id, title, detail, source, source_ref, category, severity, priority,
     status, requires_approval, assignee, due_date, effort, affected_url, evidence_json, dedupe_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, brandId, title, detail, source, sourceRef, category, severity, priority,
      'backlog', needsApproval ? 1 : 0, assignee, dueDate, effort, affectedUrl, evidenceJson, dedupeKey);

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(res.lastInsertRowid);
  logEvent(task.id, userId, 'created', `Created from ${SOURCES[source] || source}`);
  if (needsApproval) {
    logEvent(task.id, userId, 'approval_required',
      `Needs SEO approval before going live: ${approval.matched.join(', ')}`);
  }
  return { task, created: true };
}

// --------------------------------------------------------------- reconcile
//
// Closes the loop that `upsertTask` leaves open.
//
// upsertTask creates and refreshes findings, but nothing ever retired one. A
// task therefore outlived the finding that produced it: when a re-run no
// longer detected the problem — because it was fixed, or because it was a
// false positive that a later version of the engine stopped emitting — the
// task stayed in the backlog forever. Over weeks that turns the backlog into a
// list nobody trusts, and it is the single most likely reason a team stops
// using this.
//
// `reconcile` is called by an engine right after it has finished upserting, and
// is given every dedupeKey it emitted this run. Any OPEN task from the same
// source and brand whose key is absent is no longer supported by evidence.
//
// What it deliberately does NOT do:
//   - It never touches a task somebody has started. `backlog` tasks are
//     auto-resolved; `in_progress`, `awaiting_approval` and `blocked` ones are
//     only annotated, because a human has invested work and silently closing
//     that is worse than a stale row.
//   - It never touches `done` or `dismissed` tasks.
//   - It never touches tasks from another source, so a linking re-run cannot
//     retire an audit finding.
//   - It is scoped to a brand, so one brand's run cannot affect another's.
//
// Every change is written to the task event log with the run reference, so
// "why did this disappear?" is always answerable.
const RECONCILABLE_STATUSES = ['backlog'];
const ANNOTATE_ONLY_STATUSES = ['in_progress', 'awaiting_approval', 'blocked'];

// `keyPrefix` is REQUIRED in practice, because `source` alone is too coarse.
// The keyword-clustering engine and the opportunity engine both write tasks
// with source 'opportunity'; without a prefix, each one's reconcile pass would
// retire every task belonging to the other, since neither knows about the
// other's dedupe keys. Scoping to the key family an engine actually owns is
// what makes this safe.
function reconcile(userId, brandId, source, currentDedupeKeys, {
  sourceRef = null, reason = null, keyPrefix = null,
} = {}) {
  const keys = new Set((currentDedupeKeys || []).filter(Boolean));
  const scope = brandId ? 'AND brand_id = ?' : 'AND brand_id IS NULL';
  const prefixClause = keyPrefix ? 'AND dedupe_key LIKE ?' : '';
  const args = brandId ? [userId, source, brandId] : [userId, source];
  if (keyPrefix) args.push(`${keyPrefix}%`);

  const open = db.prepare(`SELECT * FROM tasks
    WHERE user_id = ? AND source = ? ${scope} ${prefixClause}
      AND status IN (${[...RECONCILABLE_STATUSES, ...ANNOTATE_ONLY_STATUSES].map(() => '?').join(',')})
      AND dedupe_key IS NOT NULL`)
    .all(...args, ...RECONCILABLE_STATUSES, ...ANNOTATE_ONLY_STATUSES);

  const gone = open.filter((t) => !keys.has(t.dedupe_key));
  const note = reason
    || `No longer detected${sourceRef ? ` as of ${sourceRef}` : ''}. Either it was fixed, or the analysis that raised it has changed.`;

  let resolved = 0;
  let annotated = 0;

  gone.forEach((t) => {
    if (ANNOTATE_ONLY_STATUSES.includes(t.status)) {
      logEvent(t.id, userId, 'stale',
        `This finding was not detected in the latest run. ${note} Someone is already working on it, so it has been left open — close it manually if it is no longer needed.`);
      db.prepare("UPDATE tasks SET updated_at=datetime('now') WHERE id=?").run(t.id);
      annotated += 1;
      return;
    }
    db.prepare(`UPDATE tasks SET status='dismissed', completion_note=?,
      completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .run(`Auto-resolved: ${note}`, t.id);
    logEvent(t.id, userId, 'auto_resolved', note);
    resolved += 1;
  });

  return { resolved, annotated, checked: open.length, stillPresent: open.length - gone.length };
}

function logEvent(taskId, userId, kind, note) {
  db.prepare('INSERT INTO task_events (task_id, user_id, kind, note) VALUES (?,?,?,?)')
    .run(taskId, userId || null, kind, note || null);
}

// Status transition with the approval gate enforced. Returns
// { ok, task, error } rather than throwing, so routes can show a message.
function setStatus(taskId, userId, status, note) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (!STATUSES.some((s) => s.value === status)) return { ok: false, error: 'Unknown status.' };

  // THE GATE: a task flagged as needing approval cannot be completed until it
  // has actually been approved.
  if (status === 'done' && task.requires_approval && !task.approved_at) {
    return {
      ok: false,
      error: 'This task changes something that requires SEO-team approval (for example publishing, a redirect, a canonical or robots.txt edit). Approve it first, then mark it done.',
      needsApproval: true,
      task,
    };
  }

  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE tasks SET status=?, completion_note=COALESCE(?, completion_note),
    completed_at=${completedAt}, updated_at=datetime('now') WHERE id=?`)
    .run(status, status === 'done' || status === 'dismissed' ? (note || null) : null, taskId);

  logEvent(taskId, userId, 'status', `${task.status} → ${status}${note ? ` — ${note}` : ''}`);
  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) };
}

function approve(taskId, userId, approverName) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
  if (!task) return { ok: false, error: 'Task not found.' };
  db.prepare("UPDATE tasks SET approved_at=datetime('now'), approved_by=?, updated_at=datetime('now') WHERE id=?")
    .run(approverName || 'SEO team', taskId);
  logEvent(taskId, userId, 'approved', `Approved by ${approverName || 'SEO team'}`);
  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) };
}

function revokeApproval(taskId, userId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
  if (!task) return { ok: false, error: 'Task not found.' };
  db.prepare("UPDATE tasks SET approved_at=NULL, approved_by=NULL, updated_at=datetime('now') WHERE id=?").run(taskId);
  logEvent(taskId, userId, 'approval_revoked', 'Approval withdrawn');
  return { ok: true };
}

function update(taskId, userId, fields) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
  if (!task) return { ok: false, error: 'Task not found.' };
  const allowed = ['title', 'detail', 'assignee', 'due_date', 'severity', 'effort', 'category', 'brand_id'];
  const sets = [];
  const args = [];
  allowed.forEach((k) => {
    if (fields[k] !== undefined) { sets.push(`${k}=?`); args.push(fields[k] === '' ? null : fields[k]); }
  });
  if (fields.severity !== undefined) { sets.push('priority=?'); args.push(SEVERITY_PRIORITY[fields.severity] || 3); }
  if (!sets.length) return { ok: true, task };
  args.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...args);
  logEvent(taskId, userId, 'edited', Object.keys(fields).filter((k) => allowed.includes(k)).join(', '));
  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) };
}

function remove(taskId, userId) {
  db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(taskId, userId);
  return { ok: true };
}

function get(taskId, userId) {
  const task = db.prepare(`SELECT t.*, b.name brand_name, b.site_url brand_url
    FROM tasks t LEFT JOIN brands b ON b.id = t.brand_id
    WHERE t.id=? AND t.user_id=?`).get(taskId, userId);
  if (!task) return null;
  task.events = db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC').all(taskId);
  try { task.evidence = task.evidence_json ? JSON.parse(task.evidence_json) : null; } catch { task.evidence = null; }
  return task;
}

// Filtered list for the board / table views.
function list(userId, { brandId, status, source, severity, assignee, search, onlyOpen, approval, overdue, limit = 500 } = {}) {
  const where = ['t.user_id = ?'];
  const args = [userId];
  if (brandId) { where.push('t.brand_id = ?'); args.push(brandId); }
  if (status) { where.push('t.status = ?'); args.push(status); }
  if (onlyOpen) { where.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); args.push(...OPEN_STATUSES); }
  // Approval and overdue are counted by counts() and shown on the board's stat
  // tiles, so they have to be filterable too — otherwise "21 need approval" is
  // a number with no way to see which 21, and clicking it lands on an empty
  // board (those tasks sit in Backlog, not in the Awaiting-approval column).
  if (approval === 'pending') {
    where.push(`t.requires_approval = 1 AND t.approved_at IS NULL AND t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
    args.push(...OPEN_STATUSES);
  } else if (approval === 'approved') {
    where.push('t.approved_at IS NOT NULL');
  }
  if (overdue) {
    where.push(`t.due_date IS NOT NULL AND t.due_date < date('now') AND t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
    args.push(...OPEN_STATUSES);
  }
  if (source) { where.push('t.source = ?'); args.push(source); }
  if (severity) { where.push('t.severity = ?'); args.push(severity); }
  if (assignee) { where.push('t.assignee = ?'); args.push(assignee); }
  if (search) { where.push('(t.title LIKE ? OR t.detail LIKE ? OR t.affected_url LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  args.push(limit);
  return db.prepare(`SELECT t.*, b.name brand_name, b.site_url brand_url
    FROM tasks t LEFT JOIN brands b ON b.id = t.brand_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE t.status WHEN 'awaiting_approval' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'blocked' THEN 2 WHEN 'backlog' THEN 3 ELSE 4 END,
      t.priority ASC, t.updated_at DESC
    LIMIT ?`).all(...args);
}

function counts(userId, brandId) {
  const where = brandId ? 'AND brand_id = ?' : '';
  const args = brandId ? [userId, brandId] : [userId];
  const rows = db.prepare(`SELECT status, COUNT(*) n FROM tasks WHERE user_id=? ${where} GROUP BY status`).all(...args);
  const out = { total: 0 };
  STATUSES.forEach((s) => { out[s.value] = 0; });
  rows.forEach((r) => { out[r.status] = r.n; out.total += r.n; });
  out.open = OPEN_STATUSES.reduce((a, s) => a + (out[s] || 0), 0);
  out.needsApproval = db.prepare(`SELECT COUNT(*) n FROM tasks
    WHERE user_id=? ${where} AND requires_approval=1 AND approved_at IS NULL AND status IN ('backlog','in_progress','awaiting_approval','blocked')`)
    .get(...args).n;
  out.overdue = db.prepare(`SELECT COUNT(*) n FROM tasks
    WHERE user_id=? ${where} AND due_date IS NOT NULL AND due_date < date('now')
      AND status IN ('backlog','in_progress','awaiting_approval','blocked')`).get(...args).n;
  return out;
}

function assignees(userId) {
  return db.prepare('SELECT DISTINCT assignee FROM tasks WHERE user_id=? AND assignee IS NOT NULL ORDER BY assignee')
    .all(userId).map((r) => r.assignee);
}

// Assigns a task to someone in the team's people directory, recording who did
// it and which address the work was sent to. The email is stored on the task
// as well as on the person, so the record of "this task went to this address"
// survives even if the person's address is later corrected.
//
// Returns the task plus what should be emailed; delivery itself is the
// caller's job, so a mail failure cannot roll back the assignment.
function assignTask(taskId, ownerUserId, { person, actorId }) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, ownerUserId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (!person) return { ok: false, error: 'Pick who this is being assigned to.' };

  db.prepare(`UPDATE tasks SET assignee=?, assignee_person_id=?, assignee_email=?,
      assigned_by=?, assigned_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(person.name, person.id, person.email || null, actorId || null, taskId);

  logEvent(taskId, actorId, 'assigned',
    `Assigned to ${person.name}${person.email ? ` (${person.email})` : ''}.`);

  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) };
}

function recordNotification(taskId, personId, email, result, actorId) {
  db.prepare(`INSERT INTO task_notifications (task_id, person_id, email, sent, error, sent_by)
    VALUES (?,?,?,?,?,?)`)
    .run(taskId, personId || null, email, result.sent ? 1 : 0, result.sent ? null : (result.reason || 'unknown'), actorId || null);
}

function notificationsFor(taskId) {
  return db.prepare(`SELECT n.*, u.name sent_by_name, u.email sent_by_email
    FROM task_notifications n LEFT JOIN users u ON u.id = n.sent_by
    WHERE n.task_id=? ORDER BY n.id DESC`).all(taskId);
}

// ------------------------------------------------- generation from sources

// Turns one alert event into a task. Called by the alert engine.
function fromAlertEvent(event, brand) {
  // Structured fields instead of a single multi-line blob: summary is a clean
  // sentence, the affected URLs live in evidence.exampleUrls (and
  // affected_count/total_count) so the export step can lay them out as real
  // columns / a separate "Examples" sheet instead of a bullet list crammed
  // into one cell.
  const affected = event.affected || [];
  const detail = [event.message || '', event.suggestedAction ? `Recommended action: ${event.suggestedAction}` : '']
    .filter(Boolean).join(' ');

  return upsertTask({
    userId: brand.user_id,
    brandId: brand.id,
    title: event.title,
    detail,
    source: 'alert',
    sourceRef: event.alertKey,
    category: event.group || null,
    severity: event.severity,
    affectedUrl: affected.length === 1 ? affected[0] : null,
    evidence: {
      ...(event.evidence || {}),
      summary: event.message || '',
      affectedCount: affected.length,
      exampleUrls: affected.slice(0, 50),
      recommendedAction: event.suggestedAction || null,
    },
    // Same dedupe as the event, so one finding produces exactly one task.
    dedupeKey: `task:${event.dedupe}`,
  });
}

// Turns failing technical-audit findings into tasks, one per failing check.
function fromAuditRun(run, brand, { minTier = 'warning', maxTasks = 40 } = {}) {
  let parsed;
  try { parsed = JSON.parse(run.json_result); } catch { return { created: 0, skipped: 'unparseable audit result' }; }
  const findings = parsed.findings || [];

  const tierRank = { error: 1, warning: 2, notice: 3, info: 4, passed: 9 };
  const cutoff = tierRank[minTier] || 2;
  const severityFor = { error: 'critical', warning: 'high', notice: 'medium', info: 'low' };

  const failing = findings
    .filter((f) => (f.failed || 0) > 0 && (tierRank[f.display] || 9) <= cutoff)
    .sort((a, b) => (tierRank[a.display] || 9) - (tierRank[b.display] || 9) || (b.failed || 0) - (a.failed || 0))
    .slice(0, maxTasks);

  let created = 0;
  failing.forEach((f) => {
    const items = (f.items || []).map((i) => (typeof i === 'string' ? i : (i.url || i.page || JSON.stringify(i))));
    // A clean one-line summary — no embedded bullet list. The example URLs
    // live in evidence.items so the export step can put them in their own
    // column / "Examples" sheet instead of a newline-joined blob.
    const detail = `${f.summary || ''} (${f.failed} of ${f.total || '?'} ${f.unit || 'pages'} affected.) `
      + `Source: technical audit run #${run.id} on ${String(run.created_at).slice(0, 16)} (${run.domain}).`;

    const r = upsertTask({
      userId: brand ? brand.user_id : run.user_id,
      brandId: brand ? brand.id : run.brand_id,
      title: `Fix: ${f.name} (${f.failed} ${f.unit || 'pages'})`,
      detail,
      source: 'audit',
      sourceRef: `audit:${run.id}:${f.id}`,
      category: 'Technical',
      severity: severityFor[f.display] || 'medium',
      affectedUrl: items.length === 1 ? items[0] : null,
      evidence: {
        findingId: f.id, failed: f.failed, total: f.total, runId: run.id,
        summary: f.summary || '', items: items.slice(0, 50), exampleUrls: items.slice(0, 50),
      },
      // Keyed on the check rather than the run, so a recurring issue keeps one
      // task across crawls instead of creating a fresh one every week.
      dedupeKey: `task:audit:${brand ? brand.id : run.user_id}:${f.id}`,
    });
    if (r.created) created += 1;
  });

  db.prepare('UPDATE audit_runs SET tasks_created=? WHERE id=?').run(created, run.id);
  return { created, considered: failing.length };
}

// Turns internal-linking output into tasks: orphan pages, cannibalisation, and
// one grouped task for the link recommendations themselves.
function fromLinkingRun(run, brand, { maxTasks = 30 } = {}) {
  let parsed;
  try { parsed = JSON.parse(run.json_result); } catch { return { created: 0, skipped: 'unparseable linking result' }; }

  const userId = brand ? brand.user_id : run.user_id;
  const brandId = brand ? brand.id : run.brand_id;
  const scope = brandId || `u${userId}`;
  let created = 0;

  const recs = parsed.recommendations || [];
  if (recs.length) {
    const byTarget = new Map();
    recs.forEach((r) => {
      const t = r.target_url;
      if (!t) return;
      if (!byTarget.has(t)) byTarget.set(t, []);
      byTarget.get(t).push(r);
    });
    const top = [...byTarget.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxTasks);

    top.forEach(([target, list]) => {
      const detail = [
        `${list.length} internal link${list.length === 1 ? '' : 's'} recommended into this page, each using anchor text that already appears verbatim on the source page.`,
        '',
        ...list.slice(0, 12).map((r, i) => `${i + 1}. From ${r.source_url}\n     anchor: "${r.anchor_text}"\n     reason: ${r.reason || 'topical relevance'}`),
        ...(list.length > 12 ? ['', `… and ${list.length - 12} more in the full CSV.`] : []),
        '',
        `Source: internal linking run #${run.id} on ${String(run.created_at).slice(0, 16)}.`,
      ].join('\n');

      const r = upsertTask({
        userId, brandId,
        title: `Add ${list.length} internal link${list.length === 1 ? '' : 's'} to ${target.replace(/^https?:\/\/[^/]+/, '') || '/'}`,
        detail,
        source: 'linking',
        sourceRef: `linking:${run.id}`,
        category: 'Internal linking',
        severity: list.length >= 4 ? 'medium' : 'low',
        affectedUrl: target,
        evidence: { target, recommendations: list.slice(0, 30), runId: run.id },
        dedupeKey: `task:linking:${scope}:target:${target}`,
        // Bulk link insertion is on the restricted list.
        requiresApproval: list.length >= 5,
      });
      if (r.created) created += 1;
    });
  }

  const orphans = (parsed.orphans || []).filter((o) => o.status === 'orphan');
  if (orphans.length) {
    const r = upsertTask({
      userId, brandId,
      title: `Link to ${orphans.length} orphan page${orphans.length === 1 ? '' : 's'}`,
      detail: [
        `${orphans.length} page${orphans.length === 1 ? ' has' : 's have'} no editorial internal links pointing at ${orphans.length === 1 ? 'it' : 'them'}. Orphan pages are crawled rarely and rank poorly regardless of content quality.`,
        '',
        ...orphans.slice(0, 25).map((o) => `  • ${o.url}${o.title ? `\n      ${o.title}` : ''}${o.gsc_impressions ? `\n      ${o.gsc_impressions} impressions in the GSC data supplied` : ''}`),
        ...(orphans.length > 25 ? [`  … and ${orphans.length - 25} more`] : []),
        '',
        'Use the recommendations CSV from the same run to find the best source pages and anchor text.',
      ].join('\n'),
      source: 'linking',
      sourceRef: `linking:${run.id}`,
      category: 'Internal linking',
      severity: 'medium',
      evidence: { orphans: orphans.slice(0, 50), runId: run.id },
      dedupeKey: `task:linking:${scope}:orphans`,
    });
    if (r.created) created += 1;
  }

  const cannibal = parsed.cannibalization || [];
  if (cannibal.length) {
    const r = upsertTask({
      userId, brandId,
      title: `Resolve ${cannibal.length} keyword cannibalisation pair${cannibal.length === 1 ? '' : 's'}`,
      detail: [
        `${cannibal.length} pair${cannibal.length === 1 ? '' : 's'} of pages compete for the same keyword, splitting ranking signals.`,
        '',
        ...cannibal.slice(0, 15).map((c) => `  • "${c.shared_keyword}" (${c.severity || 'medium'})\n      A: ${c.page_a}\n      B: ${c.page_b}\n      ${c.recommendation || ''}`),
        ...(cannibal.length > 15 ? [`  … and ${cannibal.length - 15} more`] : []),
        '',
        'Decide one canonical page per keyword before making any change. Consolidation via redirect or canonical requires SEO approval.',
      ].join('\n'),
      source: 'linking',
      sourceRef: `linking:${run.id}`,
      category: 'Internal linking',
      severity: 'medium',
      evidence: { cannibalization: cannibal.slice(0, 40), runId: run.id },
      dedupeKey: `task:linking:${scope}:cannibalization`,
    });
    if (r.created) created += 1;
  }

  const broken = parsed.broken_links || [];
  if (broken.length) {
    const r = upsertTask({
      userId, brandId,
      title: `Fix ${broken.length} broken link${broken.length === 1 ? '' : 's'}`,
      // Clean one-line summary; the individual broken URLs live in
      // evidence.exampleUrls for the export step's "Examples" sheet, not
      // crammed into this cell as a bullet list.
      detail: `${broken.length} link target${broken.length === 1 ? '' : 's'} returned an error during the crawl.`,
      source: 'linking',
      sourceRef: `linking:${run.id}`,
      category: 'Technical',
      severity: 'high',
      evidence: {
        broken: broken.slice(0, 50),
        runId: run.id,
        exampleUrls: broken.slice(0, 50).map((b) => b.url),
      },
      dedupeKey: `task:linking:${scope}:broken`,
    });
    if (r.created) created += 1;
  }

  db.prepare('UPDATE linking_runs SET tasks_created=? WHERE id=?').run(created, run.id);
  return { created };
}

module.exports = {
  STATUSES, OPEN_STATUSES, SOURCES, APPROVAL_RULES, SEVERITY_PRIORITY,
  classifyApproval, upsertTask, setStatus, approve, revokeApproval,
  update, remove, get, list, counts, assignees, logEvent,
  assignTask, recordNotification, notificationsFor,
  fromAlertEvent, fromAuditRun, fromLinkingRun,
  reconcile, RECONCILABLE_STATUSES, ANNOTATE_ONLY_STATUSES,
};
