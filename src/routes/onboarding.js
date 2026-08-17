// First-run setup for a new workspace.
//
// Signing up is not the same as being ready to work: an admin still needs a
// workspace name, a Google connection, at least one client site, and a team.
// Left to a bare dashboard, a new admin sees empty charts and no indication of
// what is missing. This walks the four steps, checks each against real state
// rather than a "dismissed" flag, and stops nagging once they are done.
const express = require('express');
const db = require('../db');
const google = require('../lib/google');
const team = require('../lib/team');

const router = express.Router();

// Each step is derived from data, so it cannot claim to be complete when it is
// not — and it self-heals if something is later removed.
function steps(req, res) {
  const userId = req.dataUserId;
  const t = res.locals.team;
  const brands = db.prepare('SELECT COUNT(*) n FROM brands WHERE user_id=?').get(userId).n;
  const synced = db.prepare(`SELECT COUNT(*) n FROM gsc_daily
    WHERE brand_id IN (SELECT id FROM brands WHERE user_id=?)`).get(userId).n;
  const connected = Boolean(google.getConnection(userId));
  const members = t ? team.members(t.id).filter((m) => m.status === 'active').length : 1;
  const contacts = t ? team.externalContacts(t.id).length : 0;
  const named = Boolean(t && !/'s (team|workspace)$/i.test(t.name));

  return [
    {
      key: 'workspace',
      title: 'Name your workspace',
      done: named,
      body: 'Your clients and team live inside a workspace. Give it your agency name.',
      cta: 'Set the name',
      href: '/onboarding#workspace',
    },
    {
      key: 'google',
      title: 'Connect Google',
      done: connected,
      body: 'Search Console and GA4 data, PageSpeed and indexing checks all come from one connection. Only an admin can set it.',
      cta: 'Connect Google',
      href: '/connect',
    },
    {
      key: 'sites',
      title: 'Add your client sites',
      done: brands > 0,
      detail: brands > 0 ? `${brands} site${brands === 1 ? '' : 's'} added${synced ? '' : ' — first sync still running'}` : null,
      body: 'Import every property from your Google account in one pass, rather than typing them in one at a time.',
      cta: 'Import from Google',
      href: '/brands/import',
      blockedBy: connected ? null : 'google',
    },
    {
      key: 'team',
      title: 'Invite your SEO team, add your devs and writers',
      done: members > 1 || contacts > 0,
      detail: `${members} with portal access · ${contacts} email-only contact${contacts === 1 ? '' : 's'}`,
      body: 'SEO staff get accounts. Developers and writers do not — they receive tasks by email.',
      cta: 'Open the team page',
      href: '/team',
    },
  ];
}

router.get('/', (req, res, next) => {
  try {
    if (!res.locals.perms.isAdmin) return res.redirect('/dashboard');
    const list = steps(req, res);
    res.render('onboarding', {
      title: 'Get started',
      active: 'onboarding',
      pageTitle: 'Set up your workspace',
      steps: list,
      remaining: list.filter((s) => !s.done).length,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/workspace', (req, res) => {
  if (!res.locals.perms.isAdmin) return res.redirect('/dashboard');
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/onboarding?error=' + encodeURIComponent('Enter a name.'));
  db.prepare('UPDATE teams SET name=? WHERE id=?').run(name.slice(0, 80), res.locals.currentUser.team_id);
  res.redirect('/onboarding?msg=' + encodeURIComponent(`Workspace renamed to "${name}".`));
});

module.exports = router;
module.exports.steps = steps;
