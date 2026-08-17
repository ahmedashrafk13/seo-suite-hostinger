// Team administration: who is in the team, what they may do, and who work can
// be assigned to. Every route here is admin-only except the read-only view of
// the people directory, which anyone who can assign needs.
const express = require('express');
const db = require('../db');
const team = require('../lib/team');
const assignmentQueue = require('../lib/assignmentQueue');

const router = express.Router();

// Applied to the WHOLE router, including the read-only view. The page exposes
// every member's email, the live invite code and the assignment history —
// none of which a developer or an unprivileged member should see, and a
// leaked invite code lets anyone request access to the client's data.
function adminOnly(req, res, next) {
  if (!res.locals.perms.isAdmin) {
    return res.status(403).render('error', {
      title: 'Admins only', active: 'team',
      message: 'Only a team admin can manage members.',
    });
  }
  next();
}
router.use(adminOnly);

function teamIdOf(res) {
  return res.locals.currentUser.team_id;
}

router.get('/', (req, res, next) => {
  try {
    const teamId = teamIdOf(res);
    if (!teamId) {
      return res.status(404).render('error', {
        title: 'No team', active: 'team', message: 'This account is not attached to a team.',
      });
    }
    const t = team.getTeam(teamId);
    const all = team.members(teamId);
    res.render('team', {
      title: 'Team',
      active: 'team',
      pageTitle: 'Team',
      team: t,
      members: all.filter((m) => m.status !== 'pending'),
      pending: all.filter((m) => m.status === 'pending'),
      people: team.people(teamId, { includeInactive: true }),
      contacts: team.externalContacts(teamId, { includeInactive: true }),
      roles: team.ROLES,
      personRoles: team.PERSON_ROLES,
      pendingEmails: assignmentQueue.pendingSummary(),
      // Assignment history, so "who did I give this to, and at what address"
      // is answerable without opening every task.
      recentAssignments: db.prepare(`SELECT t.id, t.title, t.assignee, t.assignee_email, t.assigned_at,
          u.name assigned_by_name, u.email assigned_by_email, b.name brand_name,
          (SELECT sent FROM task_notifications n WHERE n.task_id=t.id ORDER BY n.id DESC LIMIT 1) last_sent
        FROM tasks t
        LEFT JOIN users u ON u.id = t.assigned_by
        LEFT JOIN brands b ON b.id = t.brand_id
        WHERE t.user_id=? AND t.assignee IS NOT NULL
        ORDER BY t.assigned_at DESC, t.id DESC LIMIT 25`).all(req.dataUserId),
      signupUrl: `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`}/signup?invite=${t ? t.invite_code : ''}`,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------- membership
router.post('/members/:id/approve', adminOnly, (req, res) => {
  const r = team.setStatus(teamIdOf(res), Number(req.params.id), 'active');
  if (!r.ok) return res.redirect('/team?error=' + encodeURIComponent(r.error));
  if (req.body.role) team.setRole(teamIdOf(res), Number(req.params.id), req.body.role);
  if (req.body.can_assign === 'on') team.setCanAssign(teamIdOf(res), Number(req.params.id), true);
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(req.params.id);
  res.redirect('/team?msg=' + encodeURIComponent(`${u ? u.email : 'Member'} approved.`));
});

router.post('/members/:id/role', adminOnly, (req, res) => {
  const r = team.setRole(teamIdOf(res), Number(req.params.id), req.body.role);
  res.redirect(r.ok ? '/team?msg=' + encodeURIComponent('Role updated.')
    : '/team?error=' + encodeURIComponent(r.error));
});

router.post('/members/:id/assign-rights', adminOnly, (req, res) => {
  const r = team.setCanAssign(teamIdOf(res), Number(req.params.id), req.body.allowed === '1');
  res.redirect(r.ok
    ? '/team?msg=' + encodeURIComponent(req.body.allowed === '1'
      ? 'They can now assign tasks.' : 'Assignment rights removed.')
    : '/team?error=' + encodeURIComponent(r.error));
});

router.post('/members/:id/suspend', adminOnly, (req, res) => {
  const r = team.setStatus(teamIdOf(res), Number(req.params.id), 'suspended');
  res.redirect(r.ok ? '/team?msg=' + encodeURIComponent('Member suspended — they can no longer sign in.')
    : '/team?error=' + encodeURIComponent(r.error));
});

router.post('/members/:id/reactivate', adminOnly, (req, res) => {
  const r = team.setStatus(teamIdOf(res), Number(req.params.id), 'active');
  res.redirect(r.ok ? '/team?msg=' + encodeURIComponent('Member reactivated.')
    : '/team?error=' + encodeURIComponent(r.error));
});

router.post('/members/:id/remove', adminOnly, (req, res) => {
  const r = team.removeMember(teamIdOf(res), Number(req.params.id));
  res.redirect(r.ok ? '/team?msg=' + encodeURIComponent('Member removed from the team.')
    : '/team?error=' + encodeURIComponent(r.error));
});

router.post('/invite/rotate', adminOnly, (req, res) => {
  const code = team.rotateInviteCode(teamIdOf(res));
  res.redirect('/team?msg=' + encodeURIComponent(`New invite code: ${code}. The old one no longer works.`));
});

// ----------------------------------------------------------------- people
// A person can be added without a login — the normal case for a developer who
// only ever receives tasks by email.
router.post('/people', adminOnly, (req, res) => {
  const r = team.upsertPerson(teamIdOf(res), {
    name: req.body.name,
    email: req.body.email,
    role: req.body.role || 'dev',
    createdBy: req.actorId,
  });
  if (!r.ok) return res.redirect('/team?error=' + encodeURIComponent(r.error));
  res.redirect('/team?msg=' + encodeURIComponent(
    `${r.person.name} ${r.created ? 'added' : 'updated'}${r.person.email ? ` (${r.person.email})` : ''}.`
  ));
});

router.post('/people/:id/remove', adminOnly, (req, res) => {
  team.deactivatePerson(teamIdOf(res), Number(req.params.id));
  res.redirect('/team?msg=' + encodeURIComponent('Person removed from the assignable list.'));
});

module.exports = router;
