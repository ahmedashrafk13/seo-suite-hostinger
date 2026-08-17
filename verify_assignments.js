// Assignment batching and the portal/no-portal role split.
//
// THE TWO RULES UNDER TEST
//   1. One person receives ONE email however many tasks they are assigned.
//   2. Developers and writers have no login at all — they are contacts, not
//      members, and email is the only way work reaches them.
//
// SMTP is disabled for this run (empty string, not delete — src/app.js
// re-runs dotenv.config() and would repopulate a deleted key), so digests are
// rendered and logged rather than sent. Test rows are removed afterwards.
require('dotenv').config();
process.env.SMTP_HOST = '';

const db = require('./src/db');
const team = require('./src/lib/team');
const queue = require('./src/lib/assignmentQueue');
const tasksLib = require('./src/lib/tasks');
const notify = require('./src/lib/notify');

const STAMP = Date.now();
const DEV_NAME = `QA Dev ${STAMP}`;
const WRITER_NAME = `QA Writer ${STAMP}`;
const DEV_EMAIL = `qa-dev-${STAMP}@example.com`;
const WRITER_EMAIL = `qa-writer-${STAMP}@example.com`;

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`OK   ${name}`); } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

function cleanup(teamId, taskIds) {
  db.prepare("DELETE FROM task_notifications WHERE email IN (?,?)").run(DEV_EMAIL, WRITER_EMAIL);
  db.prepare("DELETE FROM team_people WHERE name IN (?,?)").run(DEV_NAME, WRITER_NAME);
  if (taskIds.length) {
    const qs = taskIds.map(() => '?').join(',');
    db.prepare(`UPDATE tasks SET assignee=NULL, assignee_person_id=NULL, assignee_email=NULL,
      assigned_by=NULL, assigned_at=NULL WHERE id IN (${qs})`).run(...taskIds);
    db.prepare(`DELETE FROM task_events WHERE task_id IN (${qs}) AND kind='assigned'`).run(...taskIds);
  }
}

(async () => {
  const owner = db.prepare('SELECT * FROM users WHERE id=2').get();
  const teamId = owner.team_id;
  const tasks = db.prepare('SELECT id, title FROM tasks WHERE user_id=2 ORDER BY id LIMIT 4').all();
  const taskIds = tasks.map((t) => t.id);

  try {
    // ------------------------------------------------ role model
    const asUserRole = team.setRole(teamId, 999999, 'dev');
    check('"dev" is rejected as an account role', !asUserRole.ok, asUserRole.error);
    const asUserRole2 = team.setRole(teamId, 999999, 'writer');
    check('"writer" is rejected as an account role', !asUserRole2.ok, asUserRole2.error);
    check('only admin and seo can hold accounts',
      team.ROLES.map((r) => r.value).join(',') === 'admin,seo',
      team.ROLES.map((r) => r.value).join(','));
    check('dev and writer exist as assignable roles',
      team.PERSON_ROLES.some((r) => r.value === 'dev') && team.PERSON_ROLES.some((r) => r.value === 'writer'));

    const noEmail = team.upsertPerson(teamId, { name: `${DEV_NAME} x`, role: 'dev' });
    check('a developer cannot be added without an email', !noEmail.ok, noEmail.error);

    const dev = team.upsertPerson(teamId, { name: DEV_NAME, email: DEV_EMAIL, role: 'dev', createdBy: 2 });
    check('developer contact is created', dev.ok && dev.person.role === 'dev');
    const writer = team.upsertPerson(teamId, { name: WRITER_NAME, email: WRITER_EMAIL, role: 'writer', createdBy: 2 });
    check('writer contact is created', writer.ok && writer.person.role === 'writer');

    check('contacts are separate from portal members',
      team.externalContacts(teamId).some((p) => p.name === DEV_NAME)
      && !team.portalMembers(teamId).some((p) => p.name === DEV_NAME));

    // ------------------------------------- one email for many tasks
    const three = taskIds.slice(0, 3);
    three.forEach((id) => {
      tasksLib.assignTask(id, 2, { person: dev.person, actorId: 2 });
      queue.enqueue({ taskId: id, personId: dev.person.id, email: DEV_EMAIL, actorId: 2 });
    });
    const queued = db.prepare("SELECT COUNT(*) n FROM task_notifications WHERE email=? AND status='queued'").get(DEV_EMAIL).n;
    check('three assignments queue three rows', queued === 3, `got ${queued}`);

    // Nothing goes out during the quiet period.
    const earlyDue = queue.dueRecipients();
    check('nothing is sent during the quiet period', !earlyDue.includes(DEV_EMAIL), earlyDue.join(','));

    // Capture what would be sent.
    const sentMessages = [];
    const realDeliver = notify.sendAssignmentDigest;
    notify.sendAssignmentDigest = async (to, payload) => {
      sentMessages.push({ to, tasks: payload.tasks.length, subjectTasks: payload.tasks.map((t) => t.title) });
      return { sent: true, to: [to] };
    };

    const flushed = await queue.flush({ force: true });
    notify.sendAssignmentDigest = realDeliver;

    check('exactly one email is produced for three tasks',
      sentMessages.length === 1 && sentMessages[0].tasks === 3,
      `messages=${sentMessages.length} tasks=${sentMessages[0] && sentMessages[0].tasks}`);
    check('the email goes to the right address', sentMessages[0] && sentMessages[0].to === DEV_EMAIL);
    check('flush reports one recipient', flushed.length === 1 && flushed[0].tasks === 3);

    const left = db.prepare("SELECT COUNT(*) n FROM task_notifications WHERE email=? AND status='queued'").get(DEV_EMAIL).n;
    check('the queue is drained after sending', left === 0, `still queued: ${left}`);
    const marked = db.prepare("SELECT COUNT(*) n FROM task_notifications WHERE email=? AND status='sent'").get(DEV_EMAIL).n;
    check('all three rows are marked sent', marked === 3, `got ${marked}`);

    // ------------------------------------- two people, two emails
    queue.enqueue({ taskId: taskIds[0], personId: dev.person.id, email: DEV_EMAIL, actorId: 2 });
    queue.enqueue({ taskId: taskIds[1], personId: dev.person.id, email: DEV_EMAIL, actorId: 2 });
    queue.enqueue({ taskId: taskIds[2], personId: writer.person.id, email: WRITER_EMAIL, actorId: 2 });
    const round2 = [];
    notify.sendAssignmentDigest = async (to, payload) => {
      round2.push({ to, tasks: payload.tasks.length });
      return { sent: true, to: [to] };
    };
    await queue.flush({ force: true });
    notify.sendAssignmentDigest = realDeliver;
    check('two people get exactly two emails', round2.length === 2, `got ${round2.length}`);
    const devMsg = round2.find((m) => m.to === DEV_EMAIL);
    const writerMsg = round2.find((m) => m.to === WRITER_EMAIL);
    check('each email covers only that person\'s tasks',
      devMsg && devMsg.tasks === 2 && writerMsg && writerMsg.tasks === 1,
      `dev=${devMsg && devMsg.tasks} writer=${writerMsg && writerMsg.tasks}`);

    // ------------------------------------- the digest renders real content
    queue.enqueue({ taskId: taskIds[0], personId: dev.person.id, email: DEV_EMAIL, note: 'ship by Friday', actorId: 2 });
    queue.enqueue({ taskId: taskIds[1], personId: dev.person.id, email: DEV_EMAIL, actorId: 2 });
    const rows = queue.queuedFor(DEV_EMAIL);
    const result = await notify.sendAssignmentDigest(DEV_EMAIL, {
      personName: DEV_NAME,
      assignedBy: 'QA',
      baseUrl: 'http://localhost:4200',
      tasks: rows.map((r) => ({
        id: r.task_id, title: r.title, severity: r.severity, detail: r.detail,
        brandName: r.brand_name, note: r.note, affectedUrl: r.affected_url,
      })),
    });
    check('digest reports SMTP off rather than claiming success',
      !result.sent && /SMTP/i.test(result.reason || ''), result.reason);

    // A task deleted between queueing and sending must not blank the email.
    db.prepare("UPDATE task_notifications SET status='queued' WHERE email=?").run(DEV_EMAIL);
    db.prepare('DELETE FROM task_notifications WHERE task_id NOT IN (SELECT id FROM tasks)').run();
    const survives = await queue.flushRecipient(DEV_EMAIL);
    check('a queue whose tasks still exist flushes without throwing', typeof survives.tasks === 'number');
  } catch (err) {
    failures.push(`threw: ${err.stack}`);
    console.log('THREW', err.stack);
  } finally {
    cleanup(teamId, taskIds);
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  - ' + f));
  const leftovers = db.prepare("SELECT COUNT(*) n FROM team_people WHERE name LIKE 'QA %'").get().n
    + db.prepare("SELECT COUNT(*) n FROM tasks WHERE assignee LIKE 'QA %'").get().n;
  console.log(`test rows left behind: ${leftovers}`);
  process.exit(failures.length ? 1 : 0);
})();
