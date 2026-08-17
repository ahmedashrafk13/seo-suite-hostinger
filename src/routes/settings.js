const express = require('express');
const bcrypt = require('../lib/passwords');
const db = require('../db');
const google = require('../lib/google');
const notify = require('../lib/notify');
const toolRunner = require('../lib/toolRunner');
const catalog = require('../lib/alertCatalog');

const router = express.Router();

router.get('/', (req, res) => {
  const userId = req.dataUserId;
  const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id=?').get(userId);
  const conn = google.getConnection(userId);

  // Show which integrations are actually configured, without ever echoing a
  // secret back to the browser.
  const env = {
    smtp: Boolean(process.env.SMTP_HOST),
    smtpHost: process.env.SMTP_HOST || null,
    smtpFrom: process.env.SMTP_FROM || null,
    slack: Boolean(process.env.SLACK_WEBHOOK_URL),
    webhook: Boolean(process.env.ALERT_WEBHOOK_URL),
    psiKey: Boolean(process.env.PSI_API_KEY),
    googleOAuth: google.isConfigured(),
    alertCron: process.env.ALERT_CRON || '7 * * * *',
    syncCron: process.env.SYNC_CRON || '20 3 * * *',
    reportCron: process.env.REPORT_CRON || '30 6 * * 1',
    baseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`,
  };

  res.render('settings', {
    title: 'Settings',
    active: 'settings',
    pageTitle: 'Settings',
    user,
    connection: conn,
    env,
    tools: toolRunner.toolAvailability(),
    catalogSize: catalog.all().length,
    stats: {
      brands: db.prepare('SELECT COUNT(*) n FROM brands WHERE user_id=?').get(userId).n,
      subscriptions: db.prepare('SELECT COUNT(*) n FROM alert_subscriptions WHERE user_id=? AND enabled=1').get(userId).n,
      events: db.prepare('SELECT COUNT(*) n FROM alert_events WHERE user_id=?').get(userId).n,
      tasks: db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=?').get(userId).n,
      audits: db.prepare('SELECT COUNT(*) n FROM audit_runs WHERE user_id=?').get(userId).n,
      linkings: db.prepare('SELECT COUNT(*) n FROM linking_runs WHERE user_id=?').get(userId).n,
      reports: db.prepare('SELECT COUNT(*) n FROM weekly_reports WHERE user_id=?').get(userId).n,
      gscRows: db.prepare('SELECT COUNT(*) n FROM gsc_page_daily WHERE brand_id IN (SELECT id FROM brands WHERE user_id=?)').get(userId).n
        + db.prepare('SELECT COUNT(*) n FROM gsc_query_daily WHERE brand_id IN (SELECT id FROM brands WHERE user_id=?)').get(userId).n,
    },
    flash: req.query.msg || null,
    flashError: req.query.error || null,
  });
});

router.post('/profile', (req, res) => {
  const userId = req.dataUserId;
  const name = String(req.body.name || '').trim() || null;
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name, userId);
  res.redirect('/settings?msg=' + encodeURIComponent('Profile updated.'));
});

router.post('/password', async (req, res) => {
  const userId = req.dataUserId;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');

  if (next.length < 8) {
    return res.redirect('/settings?error=' + encodeURIComponent('The new password must be at least 8 characters.'));
  }
  const ok = await bcrypt.compare(current, user.password_hash);
  if (!ok) {
    return res.redirect('/settings?error=' + encodeURIComponent('That is not your current password.'));
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(next, 10), userId);
  res.redirect('/settings?msg=' + encodeURIComponent('Password changed.'));
});

router.post('/disconnect', (req, res) => {
  google.disconnect(req.dataUserId);
  res.redirect('/settings?msg=' + encodeURIComponent('Google account disconnected. Data already synced is kept; no new data will be pulled until you reconnect.'));
});

router.post('/test-email', async (req, res) => {
  const to = String(req.body.to || '').trim() || (res.locals.currentUser && res.locals.currentUser.email);
  const r = await notify.sendEmail(to, {
    title: 'SMTP test from the SEO Automation Suite',
    message: 'If you are reading this, email delivery is configured correctly and alerts will reach you.',
    severity: 'info',
    brandName: 'Configuration test',
    siteUrl: '—',
    alertLabel: 'Test',
    suggestedAction: 'No action needed.',
  });
  res.redirect(`/settings?${r.sent ? 'msg' : 'error'}=` + encodeURIComponent(
    r.sent ? `Test email sent to ${to}.` : `Could not send: ${r.reason}`
  ));
});

module.exports = router;
