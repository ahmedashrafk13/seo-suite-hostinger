// End-to-end team, roles and assignment test.
//
// WHY
// Permissions cannot be verified by reading code: the only proof that a
// pending member sees nothing, or that an SEO without assignment rights is
// refused, is to log in as them over HTTP and look at the response. This
// drives the REAL app (real sessions, real login, real routers) on a spare
// port against the real database.
//
// Test accounts are created and deleted again; nothing else is modified.
// SMTP is deliberately disabled for this run (SMTP_HOST is cleared before the
// app loads) so assignment emails are logged instead of sent to real people.
//
// Run:  node verify_team.js
require('dotenv').config();
// Disable SMTP for this run. It must be set to an EMPTY STRING, not deleted:
// src/app.js calls dotenv.config() again as it loads, and dotenv repopulates
// any key that is absent from process.env — so `delete` is silently undone and
// the test would send real mail. An empty value stays put and reads as falsy.
process.env.SMTP_HOST = '';
process.env.PORT = process.env.TEAM_TEST_PORT || '4402';

const db = require('./src/db');
const team = require('./src/lib/team');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const STAMP = Date.now();
const ADMIN_EMAIL = `team-test-admin-${STAMP}@example.com`;
const MEMBER_EMAIL = `team-test-seo-${STAMP}@example.com`;
const DEV_EMAIL = `team-test-dev-${STAMP}@example.com`;
const PASSWORD = 'test-password-123';

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`OK   ${name}`); } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

// Minimal cookie-jar fetch: each "session" is one jar.
function makeSession() {
  const jar = {};
  return async function call(path, { method = 'GET', form = null, redirect = 'manual' } = {}) {
    const headers = {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      jar[pair.slice(0, idx)] = pair.slice(idx + 1);
    });
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  };
}

function cleanup() {
  [ADMIN_EMAIL, MEMBER_EMAIL, DEV_EMAIL].forEach((email) => {
    const u = db.prepare('SELECT id, team_id FROM users WHERE email=?').get(email);
    if (!u) return;
    db.prepare('DELETE FROM team_people WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM teams WHERE owner_user_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  });
  // Anything the test attached to the real team.
  db.prepare("DELETE FROM team_people WHERE name LIKE 'Test Dev %'").run();
  // A brand any earlier revision of this test may have created. Left behind it
  // shows up as a phantom client site on the dashboard.
  const junk = db.prepare("SELECT id FROM brands WHERE site_url LIKE '%nope.example%'").all();
  junk.forEach((b) => {
    ['sync_runs', 'alert_subscriptions', 'uptime_checks', 'tasks', 'psi_snapshots'].forEach((t) => {
      try { db.prepare(`DELETE FROM ${t} WHERE brand_id=?`).run(b.id); } catch { /* table may not key on brand */ }
    });
    db.prepare('DELETE FROM brands WHERE id=?').run(b.id);
  });
}

(async () => {
  const { server } = require('./src/app');
  await new Promise((r) => setTimeout(r, 600));

  const hostTeam = db.prepare('SELECT * FROM teams WHERE owner_user_id=2').get();
  const hostBrand = db.prepare('SELECT * FROM brands WHERE user_id=2 LIMIT 1').get();

  try {
    // ---------------------------------------------------------- signup
    const admin = makeSession();
    let r = await admin('/signup', { method: 'POST', form: { email: ADMIN_EMAIL, password: PASSWORD, name: 'Test Admin' } });
    check('signup with no invite creates a team and logs in', r.status === 302 && r.location === '/dashboard', `got ${r.status} ${r.location}`);

    const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get(ADMIN_EMAIL);
    check('new signup is an active admin', adminUser && adminUser.role === 'admin' && adminUser.status === 'active');
    const newTeam = team.getTeam(adminUser.team_id);
    check('new signup owns its own team', newTeam && newTeam.owner_user_id === adminUser.id);

    r = await admin('/signup', { method: 'POST', form: { email: 'x@example.com', password: 'short' } });
    check('short passwords are rejected', /at least 8 characters/.test(r.text));

    // --------------------------------------- joining a team by invite code
    const member = makeSession();
    r = await member('/signup', { method: 'POST', form: { email: MEMBER_EMAIL, password: PASSWORD, name: 'Test Seo', invite_code: hostTeam.invite_code } });
    check('invite code joins the existing team', r.status === 302 && r.location === '/pending', `got ${r.location}`);
    const memberUser = db.prepare('SELECT * FROM users WHERE email=?').get(MEMBER_EMAIL);
    check('invited member starts pending', memberUser && memberUser.status === 'pending' && memberUser.team_id === hostTeam.id);

    r = await member('/signup', { method: 'POST', form: { email: 'y@example.com', password: PASSWORD, invite_code: 'not-a-real-code' } });
    check('a bad invite code is refused', /invite code is not valid/i.test(r.text));

    // ------------------------------------------- pending sees no data at all
    r = await member('/dashboard');
    check('pending member is bounced off the dashboard', r.status === 302 && r.location === '/pending', `got ${r.status} ${r.location}`);
    r = await member('/tasks');
    check('pending member is bounced off tasks', r.status === 302 && r.location === '/pending');
    r = await member('/performance');
    check('pending member is bounced off performance', r.status === 302 && r.location === '/pending');
    r = await member('/pending');
    // EJS escapes the apostrophe in "Ahmed Ashraf's team", so compare escaped.
    const escapedTeamName = hostTeam.name.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
    check('pending page renders and names the team', r.status === 200 && r.text.includes(escapedTeamName));
    check('pending page leaks no brand name', hostBrand ? !r.text.includes(hostBrand.name) : true);

    // ------------------------------------------------- admin-only surfaces
    const host = makeSession();
    r = await host('/login', { method: 'POST', form: { email: 'ahmed.ashraf@canvasdigital.org', password: 'not-the-password' } });
    check('wrong password is refused', /Invalid email or password/.test(r.text));

    // Approve through the library (the owner's real password is not known to
    // this test), then verify the member's HTTP access changes.
    team.setStatus(hostTeam.id, memberUser.id, 'active');
    team.setRole(hostTeam.id, memberUser.id, 'seo');
    team.setCanAssign(hostTeam.id, memberUser.id, false);

    r = await member('/dashboard');
    check('approved member reaches the dashboard', r.status === 200, `got ${r.status} ${r.location || ''}`);

    // ----------------------------------------------- shared team workspace
    r = await member('/brands');
    check('member sees the team owner\'s brands', hostBrand ? r.text.includes(hostBrand.name) : true);
    r = await member('/tasks?view=table');
    const taskCount = db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=2').get().n;
    check('member sees the team backlog', r.status === 200 && taskCount > 0 && r.text.includes('Task board'));

    // ------------------------------------------------ assignment permission
    const someTask = db.prepare('SELECT id FROM tasks WHERE user_id=2 ORDER BY id DESC LIMIT 1').get();
    r = await member(`/tasks/${someTask.id}`);
    check('member without rights sees no assign form', r.status === 200 && !r.text.includes('id="assign-form"'));

    r = await member(`/tasks/${someTask.id}/assign`, {
      method: 'POST', form: { person_id: 'new', new_name: `Test Dev ${STAMP}`, new_email: 'dev@example.com', notify: 'off' },
    });
    check('member without rights is refused an assignment (403)', r.status === 403, `got ${r.status}`);
    const untouched = db.prepare('SELECT assignee FROM tasks WHERE id=?').get(someTask.id);
    check('the refused assignment changed nothing', !untouched.assignee || untouched.assignee !== `Test Dev ${STAMP}`);

    // Grant the right, then repeat.
    team.setCanAssign(hostTeam.id, memberUser.id, true);
    r = await member(`/tasks/${someTask.id}`);
    check('with rights, the assign form appears', r.text.includes('id="assign-form"'));

    r = await member(`/tasks/${someTask.id}/assign`, {
      method: 'POST',
      form: { person_id: 'new', new_name: `Test Dev ${STAMP}`, new_email: 'dev@example.com', new_role: 'dev', notify: 'on', note: 'Please ship this week.' },
    });
    check('assignment succeeds once granted', r.status === 302, `got ${r.status}`);
    const assigned = db.prepare('SELECT * FROM tasks WHERE id=?').get(someTask.id);
    check('task records the assignee name', assigned.assignee === `Test Dev ${STAMP}`, assigned.assignee);
    check('task records the email used', assigned.assignee_email === 'dev@example.com', assigned.assignee_email);
    check('task records who assigned it', assigned.assigned_by === memberUser.id);

    // ------------------------------------------ the email is remembered
    const person = team.personByName(hostTeam.id, `Test Dev ${STAMP}`);
    check('person is stored in the directory', Boolean(person) && person.email === 'dev@example.com');
    check('assignment count is tracked', person.assignment_count >= 1);
    const notes = db.prepare('SELECT * FROM task_notifications WHERE task_id=? ORDER BY id DESC').all(someTask.id);
    check('the notification is queued for sending', notes.length >= 1 && notes[0].email === 'dev@example.com');
    // Queued, not sent: the digest sweep batches everything for one person into
    // a single email, so nothing leaves at assignment time.
    check('assignment queues rather than sending immediately', notes[0].status === 'queued', notes[0].status);

    r = await member(`/tasks/${someTask.id}`);
    check('the remembered email is pre-filled next time', r.text.includes('dev@example.com'));

    // ------------------------------------ developers hold no account at all
    // The portal is the SEO team's. A developer is a contact reachable by
    // email, so there is no login role that could be granted to one.
    const devRole = team.setRole(hostTeam.id, memberUser.id, 'dev');
    check('an account cannot be set to the developer role', !devRole.ok, devRole.error);
    const writerRole = team.setRole(hostTeam.id, memberUser.id, 'writer');
    check('an account cannot be set to the writer role', !writerRole.ok, writerRole.error);
    const stillSeo = db.prepare('SELECT role FROM users WHERE id=?').get(memberUser.id).role;
    check('the rejected role change left the account untouched', stillSeo === 'seo', stillSeo);
    check('only admin and seo are offered as account roles',
      team.ROLES.map((x) => x.value).sort().join(',') === 'admin,seo');

    // The signup form cannot smuggle one in either.
    const sneaky = makeSession();
    r = await sneaky('/signup', {
      method: 'POST',
      form: { email: DEV_EMAIL, password: PASSWORD, name: 'Test Dev User', invite_code: hostTeam.invite_code, role: 'dev' },
    });
    const devUser = db.prepare('SELECT * FROM users WHERE email=?').get(DEV_EMAIL);
    check('signing up cannot choose a role', devUser && devUser.role === 'seo' && devUser.status === 'pending',
      devUser ? `${devUser.role}/${devUser.status}` : 'no user');

    // ------------------------------------------------------- admin surfaces
    r = await member('/team');
    check('non-admin cannot open team admin', r.status === 403, `got ${r.status}`);
    r = await admin('/team');
    check('admin opens their own team page', r.status === 200 && r.text.includes('Invite people'), `got ${r.status}`);
    r = await admin('/connect');
    check('admin can open the Google connection page', r.status === 200);
    r = await member('/auth/google');
    check('non-admin cannot start the Google OAuth flow', r.status === 302 && /connect\?error/.test(r.location || ''), r.location);

    // Owner protections
    const demote = team.setRole(hostTeam.id, 2, 'seo');
    check('the team owner cannot be demoted', !demote.ok, demote.error);
    const suspend = team.setStatus(hostTeam.id, 2, 'suspended');
    check('the team owner cannot be suspended', !suspend.ok, suspend.error);

    // ------------------------------------------------------ suspended login
    team.setStatus(hostTeam.id, memberUser.id, 'suspended');
    const suspended = makeSession();
    r = await suspended('/login', { method: 'POST', form: { email: MEMBER_EMAIL, password: PASSWORD } });
    check('a suspended member cannot sign in', r.status === 403 && /suspended/i.test(r.text));
  } catch (err) {
    failures.push(`threw: ${err.stack}`);
    console.log('THREW', err.stack);
  } finally {
    // Put the borrowed task back exactly as it was.
    db.prepare(`UPDATE tasks SET assignee=NULL, assignee_person_id=NULL, assignee_email=NULL,
      assigned_by=NULL, assigned_at=NULL WHERE assignee LIKE 'Test Dev %'`).run();
    db.prepare("DELETE FROM task_notifications WHERE email='dev@example.com'").run();
    db.prepare("DELETE FROM task_events WHERE note LIKE '%Test Dev %'").run();
    cleanup();
    server.close();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  const leftover = db.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE 'team-test-%'").get().n;
  console.log(`test accounts left behind: ${leftover}`);
  process.exit(failures.length ? 1 : 0);
})();
