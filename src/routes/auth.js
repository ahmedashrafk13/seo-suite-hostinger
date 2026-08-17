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

const router = express.Router();

// Simple in-memory throttle. Enough to make online password guessing
// impractical without adding a dependency or a schema; it resets on restart,
// which is acceptable for an app this size.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function throttleKey(req, email) {
  return `${req.ip || 'local'}|${String(email || '').toLowerCase().trim()}`;
}
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else rec.count += 1;
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
      req.session.userId = r.lastInsertRowid;
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

    req.session.userId = userId;
    res.redirect('/dashboard');
  } catch (err) {
    return fail('Could not create account: ' + err.message, 500);
  }
});

router.get('/login', (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('login', { title: 'Log In', active: null, error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const key = throttleKey(req, email);
  if (tooManyAttempts(key)) {
    return res.status(429).render('login', {
      title: 'Log In', active: null,
      error: 'Too many failed attempts. Wait a few minutes and try again.',
    });
  }
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
    const ok = user && await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      noteFailure(key);
      // One message for both cases, so this cannot be used to discover which
      // addresses have accounts.
      return res.status(400).render('login', { title: 'Log In', active: null, error: 'Invalid email or password.' });
    }
    if (user.status === 'suspended') {
      return res.status(403).render('login', {
        title: 'Log In', active: null,
        error: 'This account has been suspended. Contact your team admin.',
      });
    }
    attempts.delete(key);
    req.session.userId = user.id;
    if (user.status === 'pending') return res.redirect('/pending');
    res.redirect(req.session.returnTo || '/dashboard');
  } catch (err) {
    res.status(500).render('login', { title: 'Log In', active: null, error: 'Login failed: ' + err.message });
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
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
