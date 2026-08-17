// Task management: board and table views, status changes, the approval gate,
// assignment, and generation from the opportunity engine.
const express = require('express');
const db = require('../db');
const tasksLib = require('../lib/tasks');
const teamLib = require('../lib/team');
const notify = require('../lib/notify');
const assignmentQueue = require('../lib/assignmentQueue');
const opportunities = require('../lib/opportunities');
const { buildWorkbook, sendWorkbook } = require('../lib/xlsxExport');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const filters = {
      brandId: req.query.brand ? Number(req.query.brand) : null,
      status: req.query.status || null,
      source: req.query.source || null,
      severity: req.query.severity || null,
      assignee: req.query.assignee || null,
      search: req.query.q || null,
      // Tri-state shortcuts the stat tiles link to. Kept as strings so the
      // view can round-trip them straight back into the query string.
      approval: req.query.approval === 'pending' || req.query.approval === 'approved' ? req.query.approval : null,
      overdue: req.query.overdue === '1' ? '1' : null,
      onlyOpen: req.query.open === '1' ? '1' : null,
    };
    const view = req.query.view === 'table' ? 'table' : 'board';

    const all = tasksLib.list(userId, { ...filters, limit: 1000 });

    // Group into columns for the board. Done and dismissed are capped so a
    // long history does not make the board unusable.
    const columns = tasksLib.STATUSES.map((s) => ({
      ...s,
      tasks: all.filter((t) => t.status === s.value).slice(0, s.value === 'done' || s.value === 'dismissed' ? 25 : 50),
      total: all.filter((t) => t.status === s.value).length,
    }));

    res.render('tasks', {
      title: 'Tasks',
      active: 'tasks',
      pageTitle: 'Task board',
      brands, filters, view, columns,
      tasks: all,
      counts: tasksLib.counts(userId, filters.brandId),
      statuses: tasksLib.STATUSES,
      sources: tasksLib.SOURCES,
      assignees: tasksLib.assignees(userId),
      people: teamLib.people(res.locals.currentUser.team_id),
      approvalRules: tasksLib.APPROVAL_RULES,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Exports the current filtered task list as a styled .xlsx workbook, same
// filters as the board/table view, so "export what I'm looking at" behaves
// as expected. Main sheet is one row per task with clean columns (no
// newline-joined blob); a second "Examples" sheet explodes each task's
// example URLs into individual rows so the SEO team can filter/sort every
// affected URL on its own.
router.get('/export/csv', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const filters = {
      brandId: req.query.brand ? Number(req.query.brand) : null,
      status: req.query.status || null,
      source: req.query.source || null,
      severity: req.query.severity || null,
      assignee: req.query.assignee || null,
      search: req.query.q || null,
      // Tri-state shortcuts the stat tiles link to. Kept as strings so the
      // view can round-trip them straight back into the query string.
      approval: req.query.approval === 'pending' || req.query.approval === 'approved' ? req.query.approval : null,
      overdue: req.query.overdue === '1' ? '1' : null,
      onlyOpen: req.query.open === '1' ? '1' : null,
    };
    const all = tasksLib.list(userId, { ...filters, limit: 5000 });

    const exampleUrlsFor = (t) => {
      try {
        const ev = t.evidence_json ? JSON.parse(t.evidence_json) : null;
        return (ev && (ev.exampleUrls || ev.items)) || [];
      } catch { return []; }
    };
    const affectedCountFor = (t, urls) => {
      try {
        const ev = t.evidence_json ? JSON.parse(t.evidence_json) : null;
        return (ev && (ev.affectedCount ?? ev.failed)) ?? urls.length;
      } catch { return urls.length; }
    };
    const totalCountFor = (t) => {
      try {
        const ev = t.evidence_json ? JSON.parse(t.evidence_json) : null;
        return (ev && ev.total) ?? '';
      } catch { return ''; }
    };

    const taskRows = [];
    const exampleRows = [];
    all.forEach((t) => {
      const urls = exampleUrlsFor(t);
      taskRows.push({
        id: t.id,
        title: t.title,
        brand_name: t.brand_name || '',
        status: t.status,
        severity: t.severity,
        source: t.source,
        category: t.category || '',
        assignee: t.assignee || '',
        affected_url: t.affected_url || '',
        summary: t.detail || '',
        affected_count: affectedCountFor(t, urls),
        total_count: totalCountFor(t),
        example_urls: urls.join('; '),
        due_date: t.due_date || '',
        effort: t.effort || '',
        requires_approval: t.requires_approval ? 'Yes' : 'No',
        approved_at: t.approved_at || '',
        approved_by: t.approved_by || '',
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at || '',
      });
      urls.forEach((url) => exampleRows.push({ task_id: t.id, title: t.title, url }));
    });

    const workbook = buildWorkbook({
      sheets: [
        {
          name: 'Tasks',
          columns: [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Title', key: 'title', width: 40 },
            { header: 'Brand', key: 'brand_name', width: 20 },
            { header: 'Status', key: 'status', width: 18, dropdown: tasksLib.STATUSES.map((s) => s.value) },
            { header: 'Severity', key: 'severity', width: 12, dropdown: Object.keys(tasksLib.SEVERITY_PRIORITY) },
            { header: 'Source', key: 'source', width: 16, dropdown: Object.keys(tasksLib.SOURCES) },
            { header: 'Category', key: 'category', width: 16 },
            { header: 'Assignee', key: 'assignee', width: 16 },
            { header: 'Affected URL', key: 'affected_url', width: 40 },
            { header: 'Summary', key: 'summary', width: 50 },
            { header: 'Affected Count', key: 'affected_count', width: 14 },
            { header: 'Total Count', key: 'total_count', width: 12 },
            { header: 'Example URLs', key: 'example_urls', width: 50 },
            { header: 'Due Date', key: 'due_date', width: 14 },
            { header: 'Effort', key: 'effort', width: 10 },
            { header: 'Requires Approval', key: 'requires_approval', width: 16, dropdown: ['Yes', 'No'] },
            { header: 'Approved At', key: 'approved_at', width: 18 },
            { header: 'Approved By', key: 'approved_by', width: 16 },
            { header: 'Created At', key: 'created_at', width: 18 },
            { header: 'Updated At', key: 'updated_at', width: 18 },
            { header: 'Completed At', key: 'completed_at', width: 18 },
          ],
          rows: taskRows,
        },
        {
          name: 'Examples',
          columns: [
            { header: 'Task ID', key: 'task_id', width: 10 },
            { header: 'Title', key: 'title', width: 40 },
            { header: 'URL', key: 'url', width: 60 },
          ],
          rows: exampleRows,
        },
      ],
    });

    await sendWorkbook(res, workbook, `tasks-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (err) { next(err); }
});

// -------------------------------------------------- opportunity generation

// The Content Opportunity view: analysis on demand, with a button to push
// selected findings into the backlog.
router.get('/opportunities/:brandId', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.brandId, userId);
    if (!brand) return res.redirect('/tasks?error=' + encodeURIComponent('Brand not found.'));

    const result = opportunities.analyse(brand);
    res.render('opportunities', {
      title: `Opportunities · ${brand.name}`,
      active: 'opportunities',
      pageTitle: `Content opportunities — ${brand.name}`,
      brand,
      brands: brandsFor(userId),
      result,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.get('/opportunities', (req, res) => {
  const userId = req.dataUserId;
  const brands = brandsFor(userId);
  if (!brands.length) return res.redirect('/brands?error=' + encodeURIComponent('Add a brand first.'));
  res.redirect(`/tasks/opportunities/${brands[0].id}`);
});

router.post('/opportunities/:brandId/promote', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.brandId, userId);
    if (!brand) return res.redirect('/tasks?error=' + encodeURIComponent('Brand not found.'));

    const types = [].concat(req.body.types || []).filter(Boolean);
    const result = opportunities.analyse(brand);
    const outcome = opportunities.toTasks(brand, result, tasksLib, {
      limit: Math.min(100, parseInt(req.body.limit, 10) || 40),
      types: types.length ? types : null,
    });
    const created = outcome.created;
    const retired = outcome.retired;

    // Retired tasks are reported alongside created ones. A run that quietly
    // closes six stale findings has done real work, and saying so is what
    // stops the backlog looking like it only ever grows.
    const parts = [];
    parts.push(created
      ? `${created} new task${created === 1 ? '' : 's'} added to the backlog. Existing tasks for the same page were updated rather than duplicated.`
      : 'No new tasks were created — every current opportunity already has a task.');
    if (retired && retired.resolved) {
      parts.push(`${retired.resolved} task${retired.resolved === 1 ? '' : 's'} auto-resolved because the finding is no longer detected.`);
    }
    if (retired && retired.annotated) {
      parts.push(`${retired.annotated} in-progress task${retired.annotated === 1 ? '' : 's'} flagged as no longer detected, but left open for you to close.`);
    }

    res.redirect(`/tasks/opportunities/${brand.id}?msg=` + encodeURIComponent(parts.join(' ')));
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const task = tasksLib.get(req.params.id, userId);
    if (!task) {
      return res.status(404).render('error', { title: 'Not found', active: 'tasks', message: 'That task does not exist.' });
    }
    res.render('task-detail', {
      title: task.title,
      active: 'tasks',
      pageTitle: 'Task',
      task,
      brands: brandsFor(userId),
      statuses: tasksLib.STATUSES,
      assignees: tasksLib.assignees(userId),
      people: teamLib.people(res.locals.currentUser.team_id),
      notifications: tasksLib.notificationsFor(task.id),
      roles: teamLib.ROLES,
      approvalRules: tasksLib.APPROVAL_RULES,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/create', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const title = String(req.body.title || '').trim();
    if (!title) return res.redirect('/tasks?error=' + encodeURIComponent('A task needs a title.'));

    const r = tasksLib.upsertTask({
      userId,
      brandId: req.body.brand_id ? Number(req.body.brand_id) : null,
      title,
      detail: String(req.body.detail || '').trim() || null,
      source: 'manual',
      category: String(req.body.category || '').trim() || null,
      severity: req.body.severity || 'medium',
      affectedUrl: String(req.body.affected_url || '').trim() || null,
      assignee: String(req.body.assignee || '').trim() || null,
      dueDate: String(req.body.due_date || '').trim() || null,
      effort: String(req.body.effort || '').trim() || null,
    });

    const note = r.task.requires_approval
      ? ' It was flagged as needing SEO approval because of what it changes.'
      : '';
    res.redirect(`/tasks/${r.task.id}?msg=` + encodeURIComponent(`Task created.${note}`));
  } catch (err) { next(err); }
});

// ------------------------------------------------------------- assignment
// Assignment is a privilege: admins always have it, others only when a team
// admin has granted it. Enforced here as well as hidden in the UI, because a
// hidden form is not a permission.
function requireAssign(req, res) {
  if (!res.locals.perms.canAssign) {
    res.status(403).render('error', {
      title: 'Not allowed', active: 'tasks',
      message: 'You do not have permission to assign tasks. A team admin can grant it on the Team page.',
    });
    return false;
  }
  return true;
}

router.post('/:id/assign', async (req, res, next) => {
  try {
    if (!requireAssign(req, res)) return;
    const teamId = res.locals.currentUser.team_id;
    const back = req.body.back || `/tasks/${req.params.id}`;
    const sep = back.includes('?') ? '&' : '?';
    const fail = (m) => res.redirect(`${back}${sep}error=` + encodeURIComponent(m));

    // Either an existing person from the directory, or a new one being added
    // inline — which is where a developer's personal email gets captured for
    // the first time, and remembered for next time.
    let person = null;
    if (req.body.person_id === 'new' || (!req.body.person_id && req.body.new_name)) {
      const r = teamLib.upsertPerson(teamId, {
        name: req.body.new_name,
        email: req.body.new_email,
        role: req.body.new_role || 'dev',
        createdBy: req.actorId,
      });
      if (!r.ok) return fail(r.error);
      person = r.person;
    } else if (req.body.person_id) {
      person = teamLib.person(teamId, Number(req.body.person_id));
      if (!person) return fail('That person is no longer in the team.');
      // An address supplied now updates the stored one — this is how a missing
      // email gets filled in at the moment it is actually needed.
      if (req.body.new_email && req.body.new_email.trim() && req.body.new_email.trim() !== person.email) {
        const r = teamLib.upsertPerson(teamId, {
          name: person.name, email: req.body.new_email, role: person.role, createdBy: req.actorId,
        });
        if (!r.ok) return fail(r.error);
        person = r.person;
      }
    } else {
      return fail('Pick who this is being assigned to.');
    }

    const r = tasksLib.assignTask(req.params.id, req.dataUserId, { person, actorId: req.actorId });
    if (!r.ok) return fail(r.error);
    teamLib.noteAssignment(person.id);

    let msg = `Assigned to ${person.name}.`;
    const wantsEmail = req.body.notify !== 'off';
    if (wantsEmail) {
      if (!person.email) {
        msg += ' No email address is on file for them, so nothing will be sent — add one to notify them.';
      } else {
        // Queued, not sent: everything assigned to this person in the next few
        // minutes goes out as ONE email rather than one per task.
        assignmentQueue.enqueue({
          taskId: r.task.id,
          personId: person.id,
          email: person.email,
          note: String(req.body.note || '').trim() || null,
          actorId: req.actorId,
        });
        const waiting = assignmentQueue.pendingSummary().find((x) => x.email === person.email);
        msg += waiting && waiting.tasks > 1
          ? ` ${waiting.tasks} tasks are queued for ${person.email} — they will arrive as one email shortly.`
          : ` ${person.email} will be emailed shortly.`;
      }
    }
    res.redirect(`${back}${sep}msg=` + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

// Re-sends the assignment email without changing the assignment — for when a
// developer says they never got it.
router.post('/:id/resend-assignment', async (req, res, next) => {
  try {
    if (!requireAssign(req, res)) return;
    const task = tasksLib.get(req.params.id, req.dataUserId);
    if (!task) return res.redirect('/tasks?error=' + encodeURIComponent('Task not found.'));
    const email = String(req.body.email || task.assignee_email || '').trim();
    if (!email) return res.redirect(`/tasks/${task.id}?error=` + encodeURIComponent('No email address on file for this assignee.'));

    const brand = task.brand_id ? db.prepare('SELECT name FROM brands WHERE id=?').get(task.brand_id) : null;
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`;
    const actor = res.locals.currentUser;
    assignmentQueue.enqueue({
      taskId: task.id,
      personId: task.assignee_person_id,
      email,
      note: String(req.body.note || '').trim() || null,
      actorId: req.actorId,
    });
    // A re-send is a deliberate "they say they never got it", so it goes now
    // rather than waiting for the quiet period.
    const [result] = await assignmentQueue.flush({ force: true });
    res.redirect(`/tasks/${task.id}?` + (result && result.sent
      ? 'msg=' + encodeURIComponent(`Sent to ${email}.`)
      : 'error=' + encodeURIComponent(`Email not sent: ${(result && result.reason) || 'unknown error'}`)));
  } catch (err) { next(err); }
});

// The main "mark it done" path, with the approval gate enforced in tasks.js.
router.post('/:id/status', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const r = tasksLib.setStatus(req.params.id, userId, req.body.status, req.body.note || null);
    const back = req.body.back || `/tasks/${req.params.id}`;
    const sep = back.includes('?') ? '&' : '?';
    if (!r.ok) {
      return res.redirect(`${back}${sep}error=` + encodeURIComponent(r.error));
    }
    return res.redirect(`${back}${sep}msg=` + encodeURIComponent(
      r.task.status === 'done' ? 'Task marked done.' : `Moved to ${r.task.status.replace('_', ' ')}.`
    ));
  } catch (err) { next(err); }
});

router.post('/:id/approve', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const approver = String(req.body.approved_by || '').trim()
      || (res.locals.currentUser && (res.locals.currentUser.name || res.locals.currentUser.email))
      || 'SEO team';
    const r = tasksLib.approve(req.params.id, userId, approver);
    const back = req.body.back || `/tasks/${req.params.id}`;
    const sep = back.includes('?') ? '&' : '?';
    if (!r.ok) return res.redirect(`${back}${sep}error=` + encodeURIComponent(r.error));
    return res.redirect(`${back}${sep}msg=` + encodeURIComponent(`Approved by ${approver}. It can now be marked done.`));
  } catch (err) { next(err); }
});

router.post('/:id/revoke-approval', (req, res) => {
  tasksLib.revokeApproval(req.params.id, req.dataUserId);
  const back = req.body.back || `/tasks/${req.params.id}`;
  const sep = back.includes('?') ? '&' : '?';
  res.redirect(`${back}${sep}msg=` + encodeURIComponent('Approval withdrawn.'));
});

router.post('/:id/update', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const fields = {};
    ['title', 'detail', 'assignee', 'due_date', 'severity', 'effort', 'category'].forEach((k) => {
      if (req.body[k] !== undefined) fields[k] = String(req.body[k]).trim();
    });
    if (req.body.brand_id !== undefined) {
      fields.brand_id = req.body.brand_id ? Number(req.body.brand_id) : null;
    }
    const r = tasksLib.update(req.params.id, userId, fields);
    if (!r.ok) return res.redirect(`/tasks/${req.params.id}?error=` + encodeURIComponent(r.error));
    res.redirect(`/tasks/${req.params.id}?msg=` + encodeURIComponent('Task updated.'));
  } catch (err) { next(err); }
});

router.post('/:id/comment', (req, res) => {
  const note = String(req.body.note || '').trim();
  if (note) tasksLib.logEvent(req.params.id, req.dataUserId, 'comment', note);
  res.redirect(`/tasks/${req.params.id}?msg=` + encodeURIComponent('Comment added.'));
});

router.post('/:id/delete', (req, res) => {
  tasksLib.remove(req.params.id, req.dataUserId);
  res.redirect('/tasks?msg=' + encodeURIComponent('Task deleted.'));
});

// Bulk actions from the table view.
router.post('/bulk', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const ids = [].concat(req.body.task_ids || []).map(Number).filter(Boolean);
    const action = String(req.body.action || '');
    if (!ids.length) return res.redirect('/tasks?error=' + encodeURIComponent('No tasks were selected.'));
    if (action === 'assign' && !requireAssign(req, res)) return;

    let done = 0;
    const blocked = [];

    let bulkPerson = null;
    if (action === 'assign') {
      const teamId = res.locals.currentUser.team_id;
      const raw = String(req.body.assignee || '').trim();
      if (!raw) return res.redirect('/tasks?view=table&error=' + encodeURIComponent('Type who to assign these tasks to.'));
      // An id from the picker, or a name typed by hand.
      const byId = /^\d+$/.test(raw) ? teamLib.person(teamId, Number(raw)) : null;
      if (byId) bulkPerson = byId;
      else {
        const up = teamLib.upsertPerson(teamId, { name: raw, role: 'seo', createdBy: req.actorId });
        if (!up.ok) return res.redirect('/tasks?view=table&error=' + encodeURIComponent(up.error));
        bulkPerson = up.person;
      }
    }

    ids.forEach((id) => {
      if (action === 'approve') {
        const r = tasksLib.approve(id, userId,
          (res.locals.currentUser && (res.locals.currentUser.name || res.locals.currentUser.email)) || 'SEO team');
        if (r.ok) done += 1;
      } else if (action === 'delete') {
        tasksLib.remove(id, userId);
        done += 1;
      } else if (action === 'assign') {
        // Bulk assign resolves through the same directory as single assignment,
        // so a name typed here reuses that person's remembered email — and all
        // of these tasks queue into ONE email rather than one per task.
        if (bulkPerson) {
          const a = tasksLib.assignTask(id, userId, { person: bulkPerson, actorId: req.actorId });
          if (a.ok) {
            teamLib.noteAssignment(bulkPerson.id);
            if (bulkPerson.email && req.body.notify !== 'off') {
              assignmentQueue.enqueue({
                taskId: id, personId: bulkPerson.id, email: bulkPerson.email, actorId: req.actorId,
              });
            }
            done += 1;
          }
        }
      } else {
        const r = tasksLib.setStatus(id, userId, action, null);
        if (r.ok) done += 1;
        else blocked.push(id);
      }
    });

    let msg = `${done} task${done === 1 ? '' : 's'} updated.`;
    if (action === 'assign' && bulkPerson) {
      msg = `${done} task${done === 1 ? '' : 's'} assigned to ${bulkPerson.name}.`;
      if (!bulkPerson.email) msg += ' No email on file for them, so nothing will be sent.';
      else if (req.body.notify !== 'off') msg += ` They will get one email covering all ${done}.`;
    }
    const warn = blocked.length
      ? ` ${blocked.length} could not be completed because they still need SEO approval.`
      : '';
    res.redirect('/tasks?view=table&msg=' + encodeURIComponent(msg + warn));
  } catch (err) { next(err); }
});

module.exports = router;
