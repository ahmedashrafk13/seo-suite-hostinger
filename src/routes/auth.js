// Sign-up, log-in, log-out.
//
// Sign-up has two shapes:
//   with an invite code    → joins that team as a PENDING member. They can log
//                            in but see nothing until an admin approves them,
//                            so a leaked URL cannot expose a client's data.
//   without an invite code → creates a new team with this account as its admin.
//                            Set SIGNUP_REQUIRES_INVITE=1 to close that door
//                            once the team is set up.
const express = require('express');
const bcrypt = require('../lib/passwords');
const db = require('../db');
const team = require('../lib/team');
const csrf = require('../lib/csrf');

const router = express.Router();

// In-memory login throttle. Enough to make online guessing impractical without
// adding a dependency or a schema; it resets on restart, which is acceptable
// for an app this size.
//
// TWO COUNTERS, NOT ONE
// The original keyed only on ip+email, which stops guessing one account's
// password but does nothing about the attack that actually works against a
// small team: one guess of a common password against each of many addresses.
// Every attempt lands on a different key, so no key ever reaches its limit. A
// per-IP counter is kept alongside it with a looser limit, so a single source
// cannot keep spraying regardless of how many addresses it spreads across.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;        // per ip+email - one account under attack
const MAX_PER_IP = 30;         // per ip - spraying across many accounts
// A hard ceiling on tracked keys. The map was never pruned except when a key
// was hit again, so a spray across a large address list left an entry per
// address in memory until the process restarted.
const MAX_KEYS = 20000;

function ipKey(req) { return `ip|${req.ip || 'local'}`; }
function userKey(req, email) {
  return `u|${req.ip || 'local'}|${String(email || '').toLowerCase().trim()}`;
}

function live(key) {
  const rec = attempts.get(key);
  if (!rec) return null;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return null; }
  return rec;
}

function tooManyAttempts(req, email) {
  const perUser = live(userKey(req, email));
  if (perUser && perUser.count >= MAX_ATTEMPTS) return true;
  const perIp = live(ipKey(req));
  return Boolean(perIp && perIp.count >= MAX_PER_IP);
}

function bump(key) {
  const rec = live(key);
  if (rec) { rec.count += 1; return; }
  attempts.set(key, { first: Date.now(), count: 1 });
}

// Drops entries whose window has closed. Called on each failure, which is the
// only path that grows the map.
function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, rec] of attempts) {
    if (rec.first < cutoff) attempts.delete(k);
  }
  // Still oversized after pruning: a sustained spray. Clearing is the safe
  // direction to fail - it costs one window of memory of attacker progress
  // rather than growing without bound.
  if (attempts.size > MAX_KEYS) attempts.clear();
}

function noteFailure(req, email) {
  bump(userKey(req, email));
  bump(ipKey(req));
  prune();
}
function clearFailures(req, email) {
  attempts.delete(userKey(req, email));
}

// SESSION FIXATION
// Writing userId into the session that the visitor arrived with means a session
// id planted beforehand - by anyone who could set a cookie for this host, which
// on a shared domain includes a sibling subdomain - is still valid after the
// login and now carries the account. Issuing a fresh id at the moment of the
// privilege change breaks that, and is why the token is rotated with it.
//
// The pre-login session holds one thing worth keeping: returnTo.
function signIn(req, userId) {
  return new Promise((resolve, reject) => {
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      if (returnTo) req.session.returnTo = returnTo;
      csrf.rotate(req);
      // The id is only durable once the store has it: redirecting before the
      // write lands is a race that shows the login page again.
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

// Where to send someone after a successful login.
//
// returnTo comes from req.originalUrl so it is always a local path today, but
// it is read back out of session state and turned into a redirect - the exact
// shape that becomes an open redirect the moment anything else ever writes to
// it. Validated rather than trusted, and consumed so it cannot strand a later
// login on a stale destination.
function consumeReturnTo(req) {
  const raw = req.session.returnTo;
  delete req.session.returnTo;
  if (typeof raw !== 'string' || !raw) return '/dashboard';
  // Must be a single-slash-rooted path. "//evil.com" and "https://evil.com"
  // are both browser-honoured absolute destinations; "/\evil.com" is treated
  // as protocol-relative by some browsers.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  // Never bounce back to an auth page - that reads as a login that failed.
  if (/^\/(login|signup|logout|pending)(\/|$)/.test(raw)) return '/dashboard';
  return raw;
}

router.get('/signup', (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('signup', {
    title: 'Sign Up',
    active: null,
    error: null,
    inviteCode: req.query.invite || '',
    requiresInvite: process.env.SIGNUP_REQUIRES_INVITE === '1',
  });
});

router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body;
  const inviteCode = String(req.body.invite_code || '').trim();
  const requiresInvite = process.env.SIGNUP_REQUIRES_INVITE === '1';
  const fail = (message, status = 400) => res.status(status).render('signup', {
    title: 'Sign Up', active: null, error: message, inviteCode, requiresInvite,
  });

  if (!email || !password) return fail('Email and password are required.');
  if (String(password).length < 8) return fail('Use a password of at least 8 characters.');

  try {
    const clean = String(email).toLowerCase().trim();
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(clean)) {
      return fail('An account with that email already exists.');
    }

    let joining = null;
    if (inviteCode) {
      joining = team.teamByInviteCode(inviteCode);
      if (!joining) return fail('That invite code is not valid. Ask your team admin for the current one.');
    } else if (requiresInvite) {
      return fail('An invite code is required to join. Ask your team admin for it.');
    }

    const hash = await bcrypt.hash(password, 10);
    const displayName = String(name || '').trim() || null;

    if (joining) {
      // Pending: authenticated, but holds no data access until approved.
      const r = db.prepare(`INSERT INTO users (email, password_hash, name, team_id, role, status, can_assign)
        VALUES (?,?,?,?,'seo','pending',0)`).run(clean, hash, displayName, joining.id);
      await signIn(req, r.lastInsertRowid);
      return res.redirect('/pending');
    }

    // No invite: this account starts its own team and owns it.
    const r = db.prepare(`INSERT INTO users (email, password_hash, name, role, status, can_assign)
      VALUES (?,?,?,'admin','active',1)`).run(clean, hash, displayName);
    const userId = r.lastInsertRowid;
    const label = displayName || clean.split('@')[0];
    const code = `${label.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() || 'team'}-${userId}${Math.random().toString(36).slice(2, 6)}`;
    const t = db.prepare('INSERT INTO teams (name, owner_user_id, invite_code) VALUES (?,?,?)')
      .run(`${label}'s team`, userId, code);
    db.prepare('UPDATE users SET team_id=? WHERE id=?').run(t.lastInsertRowid, userId);
    team.upsertPerson(t.lastInsertRowid, {
      name: label, email: clean, role: 'admin', userId, createdBy: userId,
    });

    await signIn(req, userId);
    res.redirect('/dashboard');
  } catch (err) {
    // The underlying message is a SQLite or bcrypt error carrying table names
    // and absolute paths; it was being rendered straight onto a public page.
    console.error('[signup] failed:', err);
    return fail('Could not create the account. Please try again, or contact your team admin if it keeps happening.', 500);
  }
});

router.get('/login', (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('login', { title: 'Log In', active: null, error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (tooManyAttempts(req, email)) {
    return res.status(429).render('login', {
      title: 'Log In', active: null,
      error: 'Too many failed attempts. Wait a few minutes and try again.',
    });
  }
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
    const ok = user && await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      noteFailure(req, email);
      // One message for both cases, so this cannot be used to discover which
      // addresses have accounts.
      return res.status(400).render('login', { title: 'Log In', active: null, error: 'Invalid email or password.' });
    }
    if (user.status === 'suspended') {
      // Counted as a failure too: without it, a suspended account is an
      // unlimited oracle for guessing that account's password.
      noteFailure(req, email);
      return res.status(403).render('login', {
        title: 'Log In', active: null,
        error: 'This account has been suspended. Contact your team admin.',
      });
    }
    clearFailures(req, email);
    await signIn(req, user.id);
    if (user.status === 'pending') return res.redirect('/pending');
    res.redirect(consumeReturnTo(req));
  } catch (err) {
    console.error('[login] failed:', err);
    res.status(500).render('login', {
      title: 'Log In', active: null,
      error: 'Sign-in could not be completed. Please try again.',
    });
  }
});

// Holding page for an approved-but-not-yet account. Deliberately renders no
// brand, task or client data of any kind.
router.get('/pending', (req, res) => {
  const user = res.locals.currentUser;
  if (!user) return res.redirect('/login');
  if (user.status === 'active') return res.redirect('/dashboard');
  const t = user.team_id ? team.getTeam(user.team_id) : null;
  const admins = user.team_id
    ? db.prepare("SELECT email, name FROM users WHERE team_id=? AND role='admin' AND status='active'").all(user.team_id)
    : [];
  res.render('pending', { title: 'Awaiting approval', active: null, team: t, admins });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[logout] session destroy failed:', err);
    // The row is gone from the store, but the browser keeps presenting the old
    // cookie on every request until it expires - each one costing a lookup and
    // leaving a signed id for a destroyed session in the logs. Clearing it
    // makes the sign-out complete on both sides.
    res.clearCookie('seosuite.sid');
    res.redirect('/login');
  });
});

module.exports = router;
