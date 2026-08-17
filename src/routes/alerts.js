// Alerts: browse the catalog, subscribe per brand with your own thresholds and
// cadence, review what has fired, and run checks on demand.
const express = require('express');
const db = require('../db');
const catalog = require('../lib/alertCatalog');
const engine = require('../lib/alertEngine');
const notify = require('../lib/notify');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

function pickBrand(req) {
  const userId = req.dataUserId;
  const brands = brandsFor(userId);
  if (!brands.length) return { brands, brand: null };
  const wanted = req.query.brand || req.body.brand_id;
  const brand = brands.find((b) => String(b.id) === String(wanted)) || brands[0];
  return { brands, brand };
}

// The catalog + this brand's current choices.
router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const { brands, brand } = pickBrand(req);

    if (!brand) {
      return res.render('alerts', {
        title: 'Alerts', active: 'alerts', pageTitle: 'Alerts',
        brands: [], brand: null, groups: [], subs: new Map(), caps: {},
        events: [], catalogMeta: { frequencies: catalog.FREQUENCIES, channels: catalog.CHANNELS },
        smtpConfigured: notify.smtpConfigured(),
        flash: null, flashError: null, counts: { enabled: 0, total: catalog.all().length },
      });
    }

    const subs = engine.subscriptionMap(brand.id);
    const caps = catalog.brandCapabilities(brand);

    // Resolve each alert's effective parameter values so the form shows what
    // is actually in force, not just the catalog defaults.
    const groups = catalog.grouped().map((g) => ({
      group: g.group,
      items: g.items.map((def) => {
        const sub = subs.get(def.key) || null;
        let stored = {};
        if (sub && sub.params_json) { try { stored = JSON.parse(sub.params_json); } catch { stored = {}; } }
        return {
          def,
          sub,
          enabled: Boolean(sub && sub.enabled),
          available: def.requires === 'uptime' ? true : Boolean(caps[def.requires]),
          values: catalog.resolveParams(def, stored),
          channels: String((sub && sub.channels) || 'email').split(','),
          frequency: (sub && sub.frequency) || def.defaultFrequency,
          severity: (sub && sub.severity) || def.severity,
          recipients: (sub && sub.recipients) || brand.notify_email || '',
          createTask: sub ? Boolean(sub.create_task) : true,
          lastChecked: sub && sub.last_checked_at,
          lastFired: sub && sub.last_fired_at,
          firedCount: db.prepare('SELECT COUNT(*) n FROM alert_events WHERE brand_id=? AND alert_key=?').get(brand.id, def.key).n,
        };
      }),
    }));

    const enabledCount = [...subs.values()].filter((s) => s.enabled).length;

    res.render('alerts', {
      title: 'Alerts',
      active: 'alerts',
      pageTitle: 'Alerts',
      brands, brand, groups, subs, caps,
      events: engine.recentEvents(userId, { brandId: brand.id, limit: 25 }),
      catalogMeta: { frequencies: catalog.FREQUENCIES, channels: catalog.CHANNELS },
      smtpConfigured: notify.smtpConfigured(),
      counts: { enabled: enabledCount, total: catalog.all().length },
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// Save one alert's configuration (the per-card form).
router.post('/save', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));

    const alertKey = String(req.body.alert_key || '');
    const def = catalog.get(alertKey);
    if (!def) return res.redirect(`/alerts?brand=${brandId}&error=` + encodeURIComponent('Unknown alert type.'));

    // Parameters arrive as param_<key> so they cannot collide with the form's
    // own fields.
    const params = {};
    (def.params || []).forEach((p) => {
      const raw = req.body[`param_${p.key}`];
      if (raw === undefined || raw === '') return;
      params[p.key] = p.type === 'number' ? Number(raw) : raw;
    });

    const channels = [].concat(req.body.channels || []).filter(Boolean);

    engine.saveSubscription(userId, brandId, alertKey, {
      enabled: req.body.enabled === 'on' ? 1 : 0,
      params,
      frequency: req.body.frequency,
      channels: channels.length ? channels : ['email'],
      recipients: String(req.body.recipients || '').trim() || null,
      severity: req.body.severity || null,
      createTask: req.body.create_task === 'on' ? 1 : 0,
    });

    res.redirect(`/alerts?brand=${brandId}&msg=` + encodeURIComponent(`"${def.label}" saved.`) + `#alert-${alertKey}`);
  } catch (err) { next(err); }
});

// Quick on/off without opening the card.
router.post('/toggle', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));
    const alertKey = String(req.body.alert_key || '');

    const existing = db.prepare('SELECT * FROM alert_subscriptions WHERE brand_id=? AND alert_key=?').get(brandId, alertKey);
    if (existing) {
      engine.toggleSubscription(brandId, alertKey);
    } else {
      const def = catalog.get(alertKey);
      if (!def) return res.redirect(`/alerts?brand=${brandId}&error=` + encodeURIComponent('Unknown alert type.'));
      engine.saveSubscription(userId, brandId, alertKey, {
        enabled: 1, params: {}, frequency: def.defaultFrequency,
        channels: ['email'], recipients: brand.notify_email || null, createTask: 1,
      });
    }
    res.redirect(`/alerts?brand=${brandId}#alert-${alertKey}`);
  } catch (err) { next(err); }
});

// Enable the recommended starter set for whatever data the brand has.
router.post('/apply-defaults', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));
    const n = engine.applyRecommendedDefaults(userId, brand);
    res.redirect(`/alerts?brand=${brandId}&msg=` + encodeURIComponent(
      n ? `Enabled ${n} recommended alerts based on the data this brand has connected.`
        : 'No alerts could be enabled yet — sync Search Console or GA4 data for this brand first.'
    ));
  } catch (err) { next(err); }
});

router.post('/enable-all', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));
    const caps = catalog.brandCapabilities(brand);
    let n = 0;
    catalog.all().forEach((def) => {
      if (def.requires !== 'uptime' && !caps[def.requires]) return;
      engine.saveSubscription(userId, brandId, def.key, {
        enabled: 1, params: {}, frequency: def.defaultFrequency,
        channels: ['email'], recipients: brand.notify_email || null, createTask: 1,
      });
      n += 1;
    });
    res.redirect(`/alerts?brand=${brandId}&msg=` + encodeURIComponent(`Enabled all ${n} alerts this brand has data for.`));
  } catch (err) { next(err); }
});

router.post('/disable-all', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));
    db.prepare('UPDATE alert_subscriptions SET enabled=0 WHERE brand_id=?').run(brandId);
    res.redirect(`/alerts?brand=${brandId}&msg=` + encodeURIComponent('All alerts switched off for this brand.'));
  } catch (err) { next(err); }
});

// Run checks now, ignoring cadence.
router.post('/run-now', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
    const only = req.body.alert_key || null;

    if (brandId) {
      const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
      if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));
      const r = await engine.runBrand(brand, { force: true, only });
      const msg = r.fired
        ? `${r.fired} alert${r.fired === 1 ? '' : 's'} fired from ${r.evaluated} check${r.evaluated === 1 ? '' : 's'}.`
        : `${r.evaluated} check${r.evaluated === 1 ? '' : 's'} ran and nothing crossed its threshold.`;
      const errs = r.errors.length ? ` ${r.errors.length} check(s) errored — see the server log.` : '';
      return res.redirect(`/alerts?brand=${brandId}&msg=` + encodeURIComponent(msg + errs));
    }

    const results = await engine.runAll({ force: true, userId });
    const fired = results.reduce((a, x) => a + (x.fired || 0), 0);
    res.redirect('/alerts?msg=' + encodeURIComponent(`Checked every brand — ${fired} alert${fired === 1 ? '' : 's'} fired.`));
  } catch (err) { next(err); }
});

// Send a sample notification so channel wiring can be proven before an
// incident depends on it.
router.post('/test-notification', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brandId = Number(req.body.brand_id);
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(brandId, userId);
    if (!brand) return res.redirect('/alerts?error=' + encodeURIComponent('Brand not found.'));

    const channel = String(req.body.channel || 'email');
    const sample = {
      alertKey: 'test_notification',
      alertLabel: 'Test notification',
      severity: 'medium',
      brandName: brand.name,
      siteUrl: brand.site_url,
      title: 'Test alert — delivery is working',
      message: 'This is a test notification from the SEO Automation Suite. If you can read it, this channel is configured correctly and real alerts will reach you the same way.',
      affected: [brand.site_url],
      suggestedAction: 'No action needed — this is only a delivery test.',
      dashboardUrl: `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`}/alerts?brand=${brand.id}`,
      detectedAt: new Date().toISOString(),
    };

    const recipients = String(req.body.recipients || brand.notify_email || '').trim();
    let result;
    if (channel === 'slack') result = await notify.sendSlack(brand.slack_webhook, sample);
    else if (channel === 'webhook') result = await notify.sendWebhook(process.env.ALERT_WEBHOOK_URL, sample);
    else result = await notify.sendEmail(recipients, sample);

    const msg = result.sent
      ? `Test ${channel} notification sent successfully.`
      : `Test ${channel} notification was not sent: ${result.reason}`;
    res.redirect(`/alerts?brand=${brandId}&${result.sent ? 'msg' : 'error'}=` + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

// A single fired alert, in full.
router.get('/event/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const event = db.prepare(`SELECT e.*, b.name brand_name, b.site_url brand_url
      FROM alert_events e LEFT JOIN brands b ON b.id=e.brand_id
      WHERE e.id=? AND e.user_id=?`).get(req.params.id, userId);
    if (!event) {
      return res.status(404).render('error', { title: 'Not found', active: 'alerts', message: 'That alert event does not exist.' });
    }
    let affected = [];
    let details = {};
    let notified = null;
    try { affected = JSON.parse(event.affected || '[]'); } catch { affected = []; }
    try { details = JSON.parse(event.details_json || '{}'); } catch { details = {}; }
    try { notified = event.notified ? JSON.parse(event.notified) : null; } catch { notified = null; }

    const def = catalog.get(event.alert_key);
    const task = db.prepare('SELECT * FROM tasks WHERE dedupe_key=?').get(`task:${details.__dedupe || ''}`)
      || db.prepare("SELECT * FROM tasks WHERE source='alert' AND source_ref=? AND brand_id=? ORDER BY id DESC LIMIT 1")
        .get(event.alert_key, event.brand_id);

    res.render('alert-event', {
      title: event.title,
      active: 'alerts',
      pageTitle: 'Alert detail',
      event, affected, details, notified, def, task,
      severityMeta: notify.severityMeta(event.severity),
    });
  } catch (err) { next(err); }
});

router.post('/event/:id/acknowledge', (req, res) => {
  engine.acknowledge(req.params.id, req.dataUserId);
  res.redirect(req.body.back || '/alerts');
});

router.post('/acknowledge-all', (req, res) => {
  const userId = req.dataUserId;
  const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;
  if (brandId) {
    db.prepare("UPDATE alert_events SET acknowledged_at=datetime('now') WHERE user_id=? AND brand_id=? AND acknowledged_at IS NULL")
      .run(userId, brandId);
  } else {
    db.prepare("UPDATE alert_events SET acknowledged_at=datetime('now') WHERE user_id=? AND acknowledged_at IS NULL").run(userId);
  }
  res.redirect(brandId ? `/alerts?brand=${brandId}&msg=${encodeURIComponent('All alerts acknowledged.')}` : '/alerts');
});

// Full history, filterable.
router.get('/history', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const brandId = req.query.brand ? Number(req.query.brand) : null;
    res.render('alert-history', {
      title: 'Alert history',
      active: 'alerts',
      pageTitle: 'Alert history',
      brands, brandId,
      alertKey: req.query.key || null,
      events: engine.recentEvents(userId, { brandId, limit: 300, alertKey: req.query.key || null }),
      catalogAll: catalog.all(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
