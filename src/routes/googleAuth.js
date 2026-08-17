// Google OAuth handshake.
//
// The connection belongs to the TEAM, not to whoever happened to click
// Connect: tokens are stored against the team's data owner, so every member
// works from one Search Console / GA4 connection. Only an admin may connect
// or disconnect it — a member re-authorising with their own Google account
// would otherwise silently repoint the whole team's data.
const express = require('express');
const google = require('../lib/google');

const router = express.Router();

function requireAdmin(req, res) {
  if (!req.session.userId) { res.redirect('/login'); return false; }
  if (!res.locals.perms || !res.locals.perms.isAdmin) {
    res.redirect('/connect?error=' + encodeURIComponent('Only a team admin can change the Google connection.'));
    return false;
  }
  return true;
}

router.get('/auth/google', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!google.isConfigured()) {
    return res.redirect('/connect?error=' + encodeURIComponent('Google OAuth is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.'));
  }
  res.redirect(google.buildAuthUrl());
});

router.get('/api/auth/google/callback', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { code, error } = req.query;
  if (error) {
    return res.redirect('/connect?error=' + encodeURIComponent('Google returned an error: ' + error));
  }
  if (!code) {
    return res.redirect('/connect?error=' + encodeURIComponent('Missing authorization code from Google.'));
  }
  try {
    const tokens = await google.exchangeCodeForTokens(code);
    const email = await google.getEmailFromIdToken(tokens);
    google.saveConnection(req.dataUserId, tokens, email);
    res.redirect('/connect?success=1');
  } catch (err) {
    console.error('[google-auth] token exchange failed:', err.message);
    res.redirect('/connect?error=' + encodeURIComponent('Token exchange failed: ' + err.message));
  }
});

router.post('/connect/disconnect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  google.disconnect(req.dataUserId);
  res.redirect('/connect?msg=' + encodeURIComponent('Google account disconnected for the whole team.'));
});

module.exports = router;
