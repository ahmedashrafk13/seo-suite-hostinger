// Teams, roles and the people a task can be assigned to.
//
// OWNERSHIP MODEL
// Every data table in this app is keyed to a user_id. A team shares the data
// of one account — its owner — so a member's requests resolve to the owner's
// id for data access while their own id is still used for anything that has
// to say WHO acted (approvals, assignment, event log). That keeps 100+
// existing per-user queries correct without rewriting them, and means a team
// shares one Google connection, one set of brands, one backlog.
//
// ROLES
//   admin — runs the team: approves members, sets roles, grants assignment
//           rights, connects Google. Always allowed to assign.
//   seo   — does the work. Can assign only if granted can_assign.
//   dev   — receives implementation tasks. Read-only: cannot assign, approve,
//           run tools or change settings.
//
// A person who receives tasks does not need a login at all: team_people rows
// can carry just a name and an email, which is the normal case for developers.
const db = require('../db');

// WHO CAN SIGN IN
// Only the SEO team holds accounts. Developers and writers receive work by
// email and never see the portal — a client's Search Console data, backlog and
// reports are not theirs to browse, and an account they never asked for is one
// more password to leak. This is enforced by there being no login role for
// them at all, rather than by hiding pages from them.
const ROLES = [
  { value: 'admin', label: 'Admin', description: 'Runs the workspace — approves members, assigns work, connects Google.' },
  { value: 'seo', label: 'SEO', description: 'Does the SEO work in the portal. Can be granted permission to assign tasks.' },
];

// WHO CAN BE ASSIGNED WORK
// A superset of the above: the SEO team plus the outside specialists a task
// gets handed to. Only 'seo' maps to a login.
const PERSON_ROLES = [
  { value: 'seo', label: 'SEO', portal: true, description: 'Works in the portal.' },
  { value: 'dev', label: 'Developer', portal: false, description: 'Implements fixes. Receives tasks by email only.' },
  { value: 'writer', label: 'Writer', portal: false, description: 'Produces content. Receives briefs and tasks by email only.' },
];

const EXTERNAL_ROLES = ['dev', 'writer'];

const STATUSES = ['pending', 'active', 'suspended'];

function getTeam(teamId) {
  return db.prepare('SELECT * FROM teams WHERE id=?').get(teamId) || null;
}

function teamByInviteCode(code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM teams WHERE invite_code=?').get(String(code).trim().toLowerCase()) || null;
}

// The account whose data this user works in. Falls back to the user's own id
// so an account without a team (or with a broken team row) still sees its own
// workspace rather than nothing.
function dataOwnerId(user) {
  if (!user) return null;
  if (!user.team_id) return user.id;
  const team = getTeam(user.team_id);
  return team ? team.owner_user_id : user.id;
}

function members(teamId) {
  return db.prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.can_assign, u.created_at,
      (t.owner_user_id = u.id) AS is_owner
    FROM users u JOIN teams t ON t.id = u.team_id
    WHERE u.team_id = ?
    ORDER BY (t.owner_user_id = u.id) DESC,
      CASE u.status WHEN 'pending' THEN 0 ELSE 1 END,
      CASE u.role WHEN 'admin' THEN 0 WHEN 'seo' THEN 1 ELSE 2 END,
      u.email`).all(teamId);
}

function pendingCount(teamId) {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE team_id=? AND status='pending'").get(teamId).n;
}

// ------------------------------------------------------------- permissions
function isAdmin(user) {
  return Boolean(user && user.role === 'admin' && user.status === 'active');
}

function canAssign(user) {
  if (!user || user.status !== 'active') return false;
  return user.role === 'admin' || Boolean(user.can_assign);
}

// Everyone with an account is on the SEO team, so everyone active can work.
// Access is decided by who gets an account at all, not by degrading one.
function canWrite(user) {
  return Boolean(user && user.status === 'active');
}

function canManageTeam(user) {
  return isAdmin(user);
}

// ------------------------------------------------------------------ people
function people(teamId, { includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'AND p.active = 1';
  return db.prepare(`SELECT p.*, u.status user_status
    FROM team_people p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.team_id = ? ${where}
    ORDER BY p.last_assigned_at IS NULL, p.last_assigned_at DESC, p.name`).all(teamId);
}

function person(teamId, personId) {
  return db.prepare('SELECT * FROM team_people WHERE team_id=? AND id=?').get(teamId, personId) || null;
}

function personByName(teamId, name) {
  return db.prepare('SELECT * FROM team_people WHERE team_id=? AND name=?').get(teamId, String(name || '').trim()) || null;
}

// Adds a person or updates the one already recorded under that name. The email
// is deliberately sticky: re-assigning to someone should reuse the address
// captured last time rather than asking again, but a newly supplied address
// wins so a corrected email actually takes effect.
function upsertPerson(teamId, { name, email, role = 'seo', userId = null, createdBy = null }) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, error: 'A name is required.' };
  if (!PERSON_ROLES.some((r) => r.value === role)) return { ok: false, error: 'Unknown role.' };
  const mail = String(email || '').trim() || null;
  // A developer or writer is reachable only by email, so an address is not
  // optional for them — without one, assigning work to them does nothing.
  if (EXTERNAL_ROLES.includes(role) && !mail) {
    return { ok: false, error: 'An email address is required — this person has no portal access, so email is the only way they receive work.' };
  }
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { ok: false, error: `"${mail}" does not look like an email address.` };
  }
  const existing = personByName(teamId, clean);
  if (existing) {
    db.prepare(`UPDATE team_people SET email=COALESCE(?, email), role=?, active=1,
        user_id=COALESCE(?, user_id) WHERE id=?`)
      .run(mail, role, userId, existing.id);
    return { ok: true, person: person(teamId, existing.id), created: false };
  }
  const r = db.prepare(`INSERT INTO team_people (team_id, user_id, name, email, role, created_by)
    VALUES (?,?,?,?,?,?)`).run(teamId, userId, clean, mail, role, createdBy);
  return { ok: true, person: person(teamId, r.lastInsertRowid), created: true };
}

function deactivatePerson(teamId, personId) {
  db.prepare('UPDATE team_people SET active=0 WHERE team_id=? AND id=?').run(teamId, personId);
}

function noteAssignment(personId) {
  db.prepare(`UPDATE team_people SET last_assigned_at=datetime('now'),
    assignment_count=assignment_count+1 WHERE id=?`).run(personId);
}

// Keeps the directory in step with the member list, so an approved member is
// immediately assignable without being added twice.
function syncMemberPerson(teamId, user) {
  return upsertPerson(teamId, {
    name: user.name || String(user.email).split('@')[0],
    email: user.email,
    role: user.role,
    userId: user.id,
    createdBy: user.id,
  });
}

// -------------------------------------------------------------- membership
function setRole(teamId, userId, role) {
  if (!ROLES.some((r) => r.value === role)) {
    return { ok: false, error: 'Accounts can only be Admin or SEO — developers and writers work by email and have no login.' };
  }
  const team = getTeam(teamId);
  if (team && team.owner_user_id === Number(userId) && role !== 'admin') {
    return { ok: false, error: 'The team owner must stay an admin.' };
  }
  db.prepare('UPDATE users SET role=? WHERE id=? AND team_id=?').run(role, userId, teamId);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (u) syncMemberPerson(teamId, u);
  return { ok: true };
}

function setStatus(teamId, userId, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  const team = getTeam(teamId);
  if (team && team.owner_user_id === Number(userId) && status !== 'active') {
    return { ok: false, error: 'The team owner cannot be suspended.' };
  }
  db.prepare('UPDATE users SET status=? WHERE id=? AND team_id=?').run(status, userId, teamId);
  if (status === 'active') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (u) syncMemberPerson(teamId, u);
  }
  return { ok: true };
}

function setCanAssign(teamId, userId, allowed) {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND team_id=?').get(userId, teamId);
  if (!u) return { ok: false, error: 'Not a member of this team.' };
  db.prepare('UPDATE users SET can_assign=? WHERE id=? AND team_id=?').run(allowed ? 1 : 0, userId, teamId);
  return { ok: true };
}

function removeMember(teamId, userId) {
  const team = getTeam(teamId);
  if (team && team.owner_user_id === Number(userId)) {
    return { ok: false, error: 'The team owner cannot be removed.' };
  }
  // The account survives with no team, so their audit trail (approvals,
  // assignments) stays intact rather than being nulled out of history.
  db.prepare("UPDATE users SET team_id=NULL, status='suspended' WHERE id=? AND team_id=?").run(userId, teamId);
  db.prepare('UPDATE team_people SET active=0, user_id=NULL WHERE team_id=? AND user_id=?').run(teamId, userId);
  return { ok: true };
}

function rotateInviteCode(teamId) {
  const code = `inv-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('UPDATE teams SET invite_code=? WHERE id=?').run(code, teamId);
  return code;
}

// Split for the UI: people who log in vs people who only ever get emailed.
function portalMembers(teamId) {
  return people(teamId).filter((p) => !EXTERNAL_ROLES.includes(p.role));
}
function externalContacts(teamId, opts) {
  return people(teamId, opts).filter((p) => EXTERNAL_ROLES.includes(p.role));
}
function isExternalRole(role) { return EXTERNAL_ROLES.includes(role); }

module.exports = {
  ROLES, PERSON_ROLES, EXTERNAL_ROLES, STATUSES,
  portalMembers, externalContacts, isExternalRole,
  getTeam, teamByInviteCode, dataOwnerId, members, pendingCount,
  isAdmin, canAssign, canWrite, canManageTeam,
  people, person, personByName, upsertPerson, deactivatePerson, noteAssignment, syncMemberPerson,
  setRole, setStatus, setCanAssign, removeMember, rotateInviteCode,
};
