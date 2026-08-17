// Assignment notifications, batched per person.
//
// THE RULE
// One person gets ONE email, however many tasks were assigned to them. A
// developer handed six fixes should receive a single message listing six
// items, not six messages — six is how an inbox filter gets written and how a
// team stops reading your email.
//
// HOW
// Assigning queues a row instead of sending. A sweep runs on a timer and, for
// each person with queued rows, sends a single digest — but only once their
// queue has been quiet for QUIET_SECONDS. That quiet period is what collapses
// "assign, assign, assign" across separate clicks into one message, and it is
// short enough that a lone assignment still lands promptly.
const db = require('../db');
const notify = require('./notify');

// How long a person's queue must be idle before it is sent. Long enough to
// absorb someone working through a backlog, short enough not to feel broken.
const QUIET_SECONDS = Number(process.env.ASSIGNMENT_DIGEST_QUIET_SECONDS || 90);
// A backstop so a queue that keeps being appended to still goes out.
const MAX_HOLD_SECONDS = Number(process.env.ASSIGNMENT_DIGEST_MAX_HOLD_SECONDS || 900);

function baseUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`;
}

// Queues one assignment. Returns the row id so the caller can report it.
function enqueue({ taskId, personId, email, note = null, actorId = null }) {
  const r = db.prepare(`INSERT INTO task_notifications
    (task_id, person_id, email, sent, status, note, sent_by)
    VALUES (?,?,?,0,'queued',?,?)`)
    .run(taskId, personId || null, String(email).trim(), note || null, actorId || null);
  return r.lastInsertRowid;
}

// Recipients whose queue is ready to send.
function dueRecipients({ force = false } = {}) {
  const rows = db.prepare(`SELECT email,
      COUNT(*) n,
      MAX(strftime('%s','now') - strftime('%s', created_at)) oldest,
      MIN(strftime('%s','now') - strftime('%s', created_at)) newest
    FROM task_notifications
    WHERE status='queued' AND email IS NOT NULL AND email <> ''
    GROUP BY email`).all();
  if (force) return rows.map((r) => r.email);
  return rows
    .filter((r) => r.newest >= QUIET_SECONDS || r.oldest >= MAX_HOLD_SECONDS)
    .map((r) => r.email);
}

function queuedFor(email) {
  return db.prepare(`SELECT n.id, n.task_id, n.note, n.person_id, n.sent_by,
      t.title, t.severity, t.source, t.detail, t.due_date, t.effort, t.affected_url,
      t.requires_approval, t.brand_id,
      b.name brand_name, p.name person_name,
      u.name assigner_name, u.email assigner_email
    FROM task_notifications n
    LEFT JOIN tasks t ON t.id = n.task_id
    LEFT JOIN brands b ON b.id = t.brand_id
    LEFT JOIN team_people p ON p.id = n.person_id
    LEFT JOIN users u ON u.id = n.sent_by
    WHERE n.email = ? AND n.status='queued'
    ORDER BY n.id`).all(email);
}

function markSent(ids, result) {
  const stmt = db.prepare(`UPDATE task_notifications
    SET status=?, sent=?, error=?, sent_at=datetime('now') WHERE id=?`);
  const tx = db.transaction(() => {
    ids.forEach((id) => stmt.run(
      result.sent ? 'sent' : 'failed',
      result.sent ? 1 : 0,
      result.sent ? null : (result.reason || 'unknown'),
      id
    ));
  });
  tx();
}

// Sends one person's queue as a single message.
async function flushRecipient(email) {
  const rows = queuedFor(email);
  if (!rows.length) return { email, sent: false, reason: 'nothing queued', tasks: 0 };

  // A row whose task was deleted between queueing and sending has nothing to
  // say — drop it rather than emailing a blank line.
  const live = rows.filter((r) => r.title);
  const dead = rows.filter((r) => !r.title).map((r) => r.id);
  if (dead.length) markSent(dead, { sent: true });
  if (!live.length) return { email, sent: false, reason: 'tasks no longer exist', tasks: 0 };

  const assigners = [...new Set(live.map((r) => r.assigner_name || r.assigner_email).filter(Boolean))];
  const result = await notify.sendAssignmentDigest(email, {
    personName: live[0].person_name || null,
    assignedBy: assigners.join(', ') || null,
    baseUrl: baseUrl(),
    tasks: live.map((r) => ({
      id: r.task_id,
      title: r.title,
      severity: r.severity,
      source: r.source,
      detail: r.detail,
      dueDate: r.due_date,
      effort: r.effort,
      affectedUrl: r.affected_url,
      requiresApproval: r.requires_approval,
      brandName: r.brand_name,
      note: r.note,
    })),
  });

  markSent(live.map((r) => r.id), result);
  return { email, sent: result.sent, reason: result.reason, tasks: live.length };
}

// Sweeps every recipient whose queue is ready. Safe to call on a timer.
async function flush({ force = false } = {}) {
  const out = [];
  for (const email of dueRecipients({ force })) {
    /* eslint-disable no-await-in-loop */
    try {
      out.push(await flushRecipient(email));
    } catch (err) {
      console.error(`[assignments] digest to ${email} failed: ${err.message}`);
      out.push({ email, sent: false, reason: err.message });
    }
  }
  return out;
}

// What is waiting to go out, for the UI to be honest about pending email.
function pendingSummary() {
  return db.prepare(`SELECT n.email, COUNT(*) tasks,
      MIN(n.created_at) queued_since,
      (SELECT p.name FROM team_people p WHERE p.id = n.person_id) person_name
    FROM task_notifications n
    WHERE n.status='queued' GROUP BY n.email ORDER BY queued_since`).all();
}

function pendingForTask(taskId) {
  return db.prepare("SELECT COUNT(*) n FROM task_notifications WHERE task_id=? AND status='queued'")
    .get(taskId).n;
}

let timer = null;
function start() {
  if (timer) return;
  const everyMs = Number(process.env.ASSIGNMENT_DIGEST_TICK_MS || 30_000);
  timer = setInterval(() => {
    flush().then((sent) => {
      const real = sent.filter((s) => s.sent);
      if (real.length) {
        console.log(`[assignments] sent ${real.length} digest(s): ${real.map((s) => `${s.email} (${s.tasks})`).join(', ')}`);
      }
    }).catch((e) => console.error('[assignments] sweep failed:', e.message));
  }, everyMs);
  if (timer.unref) timer.unref();
  console.log(`[assignments] digest sweep every ${Math.round(everyMs / 1000)}s (quiet period ${QUIET_SECONDS}s).`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  QUIET_SECONDS, MAX_HOLD_SECONDS,
  enqueue, flush, flushRecipient, dueRecipients, queuedFor,
  pendingSummary, pendingForTask, start, stop,
};
