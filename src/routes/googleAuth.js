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

// ------------------------------------------------ Google Ads / Keyword Planner

// Choose which Google Ads account this team's keyword volumes are billed
// against. The list comes from listAccessibleCustomers, so the admin picks
// from accounts the connected login can actually reach rather than typing a
// ten-digit id and finding out it was wrong three screens later.
//
// The value posted is "<customerId>" or "<customerId>:<loginCustomerId>" — the
// second form is used when the account is reached through a manager (MCC),
// which needs the manager id in the login-customer-id header.
router.post('/connect/ads-account', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const raw = String(req.body.ads_account || '').trim();
  if (!raw) {
    google.clearAdsSelection(req.dataUserId);
    return res.redirect('/connect?msg=' + encodeURIComponent('Google Ads account cleared. Keyword volumes will fall back to the next available source.'));
  }
  const [customerId, loginCustomerId] = raw.split(':');
  const name = String(req.body.ads_account_name || '').trim() || null;
  try {
    google.saveAdsSelection(req.dataUserId, { customerId, loginCustomerId, name });
    res.redirect('/connect?msg=' + encodeURIComponent('Google Ads account saved. Use "Test Keyword Planner" to confirm it returns volumes.'));
  } catch (err) {
    res.redirect('/connect?error=' + encodeURIComponent(err.message));
  }
});

// Run one real generateKeywordIdeas call and report exactly what came back.
//
// This exists because every way this integration fails looks identical from
// the outside: a missing scope, a test-access developer token, an Ads account
// with no billing and a sunset API version all end with "no keyword volumes".
// The probe names which one it is.
router.post('/connect/ads-test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const verdict = await google.probeKeywordPlanner(req.dataUserId);
    const q = verdict.ok
      ? 'msg=' + encodeURIComponent('Keyword Planner: ' + verdict.message)
      : 'error=' + encodeURIComponent('Keyword Planner not working (' + verdict.stage + '): ' + verdict.message);
    res.redirect('/connect?' + q);
  } catch (err) {
    res.redirect('/connect?error=' + encodeURIComponent('Keyword Planner test failed: ' + err.message));
  }
});

module.exports = router;
