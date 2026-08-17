// Alert evaluation engine + scheduler.
//
// Walks every enabled subscription, runs its catalog evaluator, stores any
// finding as an alert_event (deduped), optionally opens a task, and notifies
// the chosen channels. Notifications are batched into one digest per
// (brand, channel) run so a bad morning does not produce thirty emails.
const cron = require('node-cron');
const db = require('../db');
const google = require('./google');
const catalog = require('./alertCatalog');
const notify = require('./notify');
const tasks = require('./tasks');
const sync = require('./sync');

const FREQ_ORDER = { hourly: 1, daily: 2, weekly: 3, monthly: 4, manual: 99 };

function baseUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4200}`;
}

function parseParams(sub) {
  try { return sub.params_json ? JSON.parse(sub.params_json) : {}; } catch { return {}; }
}

// Is this subscription due, given its cadence and when it last ran?
// `force` (a manual "run checks now") bypasses the cadence entirely.
function isDue(sub, now = new Date(), force = false) {
  if (force) return true;
  if (sub.frequency === 'manual') return false;
  if (!sub.last_checked_at) return true;
  const last = new Date(`${String(sub.last_checked_at).replace(' ', 'T')}Z`);
  const mins = (now - last) / 60000;
  switch (sub.frequency) {
    case 'hourly': return mins >= 55;
    // Slightly under a full day/week so a fixed-time cron never drifts past it.
    case 'daily': return mins >= 60 * 23;
    case 'weekly': return mins >= 60 * 24 * 6.8;
    case 'monthly': return mins >= 60 * 24 * 27;
    default: return true;
  }
}

// Runs one subscription and returns the findings it produced (already stored).
async function runSubscription(sub, brand) {
  const def = catalog.get(sub.alert_key);
  if (!def) return { findings: [], error: `Unknown alert type "${sub.alert_key}"` };

  const params = catalog.resolveParams(def, parseParams(sub));
  const ctx = { brand, params, db, google, sync };

  let findings = [];
  try {
    findings = def.evaluateAsync
      ? await def.evaluateAsync(ctx)
      : (def.evaluate ? def.evaluate(ctx) : []);
  } catch (err) {
    console.error(`[alerts] ${sub.alert_key} for brand ${brand.id} failed: ${err.message}`);
    db.prepare("UPDATE alert_subscriptions SET last_checked_at=datetime('now') WHERE id=?").run(sub.id);
    return { findings: [], error: err.message };
  }

  db.prepare("UPDATE alert_subscriptions SET last_checked_at=datetime('now') WHERE id=?").run(sub.id);

  const severity = sub.severity || def.severity;
  const stored = [];

  for (const f of findings) {
    const enriched = {
      ...f,
      alertKey: def.key,
      alertLabel: def.label,
      group: def.group,
      severity: f.severity || severity,
      brandName: brand.name,
      siteUrl: brand.site_url,
      suggestedAction: f.action || null,
      detectedAt: new Date().toISOString(),
    };

    // The unique index on dedupe_key does the deduplication, so a concurrent
    // run cannot slip a duplicate past a SELECT-then-INSERT check.
    let eventId;
    try {
      const res = db.prepare(`INSERT INTO alert_events
        (user_id, brand_id, subscription_id, alert_key, severity, title, message,
         affected, suggested_action, details_json, dedupe_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(brand.user_id, brand.id, sub.id, def.key, enriched.severity,
          enriched.title, enriched.message,
          JSON.stringify(enriched.affected || []),
          enriched.suggestedAction,
          JSON.stringify(enriched.evidence || {}),
          f.dedupe || null);
      eventId = res.lastInsertRowid;
    } catch (err) {
      // Already raised in this period — not an error, just nothing new to say.
      if (String(err.message).includes('UNIQUE')) continue;
      throw err;
    }

    enriched.eventId = eventId;
    enriched.dashboardUrl = `${baseUrl()}/alerts/event/${eventId}`;

    if (sub.create_task) {
      try {
        const r = tasks.fromAlertEvent(enriched, brand);
        if (r && r.task) enriched.taskId = r.task.id;
      } catch (err) {
        console.error(`[alerts] task creation failed for event ${eventId}: ${err.message}`);
      }
    }

    stored.push(enriched);
  }

  if (stored.length) {
    db.prepare("UPDATE alert_subscriptions SET last_fired_at=datetime('now') WHERE id=?").run(sub.id);
  }
  return { findings: stored };
}

// Evaluates every due subscription for one brand and notifies once per channel.
async function runBrand(brand, { force = false, only = null } = {}) {
  let subs = db.prepare('SELECT * FROM alert_subscriptions WHERE brand_id=? AND enabled=1').all(brand.id);
  if (only) subs = subs.filter((s) => s.alert_key === only);
  subs.sort((a, b) => (FREQ_ORDER[a.frequency] || 50) - (FREQ_ORDER[b.frequency] || 50));

  const due = subs.filter((s) => isDue(s, new Date(), force));
  const all = [];
  const errors = [];

  for (const sub of due) {
    const r = await runSubscription(sub, brand);
    if (r.error) errors.push({ alert: sub.alert_key, error: r.error });
    r.findings.forEach((f) => all.push({ ...f, _sub: sub }));
  }

  // Group by channel so each channel receives one message per run.
  const byChannel = new Map();
  all.forEach((f) => {
    String(f._sub.channels || 'email').split(',').map((c) => c.trim()).filter(Boolean)
      .forEach((ch) => {
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch).push(f);
      });
  });

  const notifications = [];
  for (const [channel, items] of byChannel) {
    // Recipients come from the subscription when set, else the brand default.
    const recipients = [...new Set(items.flatMap((f) =>
      String(f._sub.recipients || brand.notify_email || '').split(',').map((s) => s.trim()).filter(Boolean)
    ))];
    const dash = `${baseUrl()}/alerts?brand=${brand.id}`;

    if (channel === 'email') {
      if (items.length === 1) {
        notifications.push(await notify.sendEmail(recipients, items[0]));
      } else {
        notifications.push(await notify.sendDigest(
          recipients, `[SEO] ${items.length} alerts for ${brand.name}`, items, dash
        ));
      }
    } else if (channel === 'slack') {
      for (const f of items) {
        notifications.push(await notify.sendSlack(f._sub.slack_webhook || brand.slack_webhook, f));
      }
    } else {
      for (const f of items) {
        notifications.push(await notify.sendWebhook(process.env.ALERT_WEBHOOK_URL, f));
      }
    }
  }

  // Record what actually happened per event, so the UI can show delivery state.
  if (all.length) {
    const summary = JSON.stringify(notifications);
    const stmt = db.prepare('UPDATE alert_events SET notified=? WHERE id=?');
    all.forEach((f) => stmt.run(summary, f.eventId));
  }

  return { brand: brand.name, evaluated: due.length, fired: all.length, findings: all, errors, notifications };
}

async function runAll({ force = false, userId = null } = {}) {
  const brands = userId
    ? db.prepare('SELECT * FROM brands WHERE active=1 AND user_id=?').all(userId)
    : db.prepare('SELECT * FROM brands WHERE active=1').all();

  const results = [];
  for (const brand of brands) {
    try {
      results.push(await runBrand(brand, { force }));
    } catch (err) {
      console.error(`[alerts] brand ${brand.id} failed:`, err.message);
      results.push({ brand: brand.name, error: err.message });
    }
  }
  return results;
}

// -------------------------------------------------------- subscription CRUD

function listSubscriptions(brandId) {
  return db.prepare('SELECT * FROM alert_subscriptions WHERE brand_id=? ORDER BY alert_key').all(brandId);
}

function subscriptionMap(brandId) {
  const map = new Map();
  listSubscriptions(brandId).forEach((s) => map.set(s.alert_key, s));
  return map;
}

function saveSubscription(userId, brandId, alertKey, {
  enabled = 1, params = {}, frequency, channels, recipients, severity, createTask = 1,
}) {
  const def = catalog.get(alertKey);
  if (!def) throw new Error(`Unknown alert type "${alertKey}"`);
  const freq = frequency || def.defaultFrequency || 'weekly';
  const chan = Array.isArray(channels) ? channels.join(',') : (channels || 'email');

  db.prepare(`INSERT INTO alert_subscriptions
    (user_id, brand_id, alert_key, enabled, params_json, frequency, channels, recipients, severity, create_task)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, alert_key) DO UPDATE SET
      enabled=excluded.enabled, params_json=excluded.params_json,
      frequency=excluded.frequency, channels=excluded.channels,
      recipients=excluded.recipients, severity=excluded.severity,
      create_task=excluded.create_task`)
    .run(userId, brandId, alertKey, enabled ? 1 : 0, JSON.stringify(params || {}),
      freq, chan, recipients || null, severity || null, createTask ? 1 : 0);

  return db.prepare('SELECT * FROM alert_subscriptions WHERE brand_id=? AND alert_key=?').get(brandId, alertKey);
}

function toggleSubscription(brandId, alertKey) {
  const s = db.prepare('SELECT * FROM alert_subscriptions WHERE brand_id=? AND alert_key=?').get(brandId, alertKey);
  if (!s) return null;
  db.prepare('UPDATE alert_subscriptions SET enabled=? WHERE id=?').run(s.enabled ? 0 : 1, s.id);
  return db.prepare('SELECT * FROM alert_subscriptions WHERE id=?').get(s.id);
}

function deleteSubscription(brandId, alertKey) {
  db.prepare('DELETE FROM alert_subscriptions WHERE brand_id=? AND alert_key=?').run(brandId, alertKey);
}

// Switches on a sensible starter set for a new brand, limited to what its
// connected data can actually support. Better than an empty alerts page.
function applyRecommendedDefaults(userId, brand) {
  const caps = catalog.brandCapabilities(brand);
  const recommended = [
    'gsc_clicks_drop', 'gsc_impressions_drop', 'gsc_ctr_drop',
    'keyword_rank_drop', 'keyword_lost_top10', 'keyword_high_impressions_low_ctr',
    'page_clicks_drop', 'page_traffic_lost_entirely',
    'indexed_page_count_drop', 'gsc_manual_action', 'gsc_data_stalled',
    'ga4_organic_sessions_drop', 'ga4_conversions_drop', 'ga4_data_stalled',
    'site_down',
  ];
  let applied = 0;
  recommended.forEach((key) => {
    const def = catalog.get(key);
    if (!def) return;
    // uptime is always available — the probe runs on every sync.
    if (def.requires !== 'uptime' && !caps[def.requires]) return;
    saveSubscription(userId, brand.id, key, {
      enabled: 1, params: {}, frequency: def.defaultFrequency,
      channels: 'email', recipients: brand.notify_email || null, createTask: 1,
    });
    applied += 1;
  });
  return applied;
}

function recentEvents(userId, { brandId, limit = 50, alertKey, unacknowledged } = {}) {
  const where = ['e.user_id = ?'];
  const args = [userId];
  if (brandId) { where.push('e.brand_id = ?'); args.push(brandId); }
  if (alertKey) { where.push('e.alert_key = ?'); args.push(alertKey); }
  if (unacknowledged) where.push('e.acknowledged_at IS NULL');
  args.push(limit);
  return db.prepare(`SELECT e.*, b.name brand_name, b.site_url brand_url
    FROM alert_events e LEFT JOIN brands b ON b.id = e.brand_id
    WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(...args);
}

function acknowledge(eventId, userId) {
  db.prepare("UPDATE alert_events SET acknowledged_at=datetime('now') WHERE id=? AND user_id=?")
    .run(eventId, userId);
}

// ------------------------------------------------------------- scheduler

function start() {
  // Hourly tick. Each subscription's own cadence decides whether it runs, so
  // one cron expression serves hourly through monthly alerts.
  const schedule = process.env.ALERT_CRON || '7 * * * *';
  const valid = cron.validate(schedule);
  if (!valid) console.error(`[alerts] invalid ALERT_CRON "${schedule}" — falling back to hourly.`);
  const finalSchedule = valid ? schedule : '7 * * * *';

  cron.schedule(finalSchedule, () => {
    console.log('[alerts] evaluating due subscriptions…');
    runAll().then((r) => {
      const fired = r.reduce((a, x) => a + (x.fired || 0), 0);
      console.log(`[alerts] done — ${r.length} brand(s), ${fired} alert(s) fired.`);
    }).catch((e) => console.error('[alerts] run failed:', e.message));
  });
  console.log(`[alerts] scheduler started (${finalSchedule}); per-alert cadence applied per subscription.`);

  // Nightly data sync so alerts always compare fresh numbers.
  const syncSchedule = process.env.SYNC_CRON || '20 3 * * *';
  if (cron.validate(syncSchedule)) {
    cron.schedule(syncSchedule, () => {
      console.log('[sync] nightly consolidation starting…');
      sync.syncAllBrands({ days: 30, includePsi: true })
        .then((r) => console.log(`[sync] nightly done for ${r.length} brand(s).`))
        .catch((e) => console.error('[sync] nightly failed:', e.message));
    });
    console.log(`[sync] nightly consolidation scheduled (${syncSchedule}).`);
  }

  // Weekly report generation, Monday morning.
  const reportSchedule = process.env.REPORT_CRON || '30 6 * * 1';
  if (cron.validate(reportSchedule)) {
    cron.schedule(reportSchedule, () => {
      // Required lazily: reportBuilder imports this module's siblings, and a
      // top-level require here would create a cycle at boot.
      const reports = require('./reportBuilder');
      console.log('[reports] weekly generation + email starting…');
      reports.generateAndSendAllWeekly()
        .then((r) => {
          const emailed = r.filter((x) => x.emailed).length;
          console.log(`[reports] generated ${r.length} weekly report(s), emailed ${emailed}.`);
        })
        .catch((e) => console.error('[reports] weekly failed:', e.message));
    });
    console.log(`[reports] weekly generation scheduled (${reportSchedule}).`);
  }
}

module.exports = {
  start, runAll, runBrand, runSubscription, isDue,
  listSubscriptions, subscriptionMap, saveSubscription, toggleSubscription,
  deleteSubscription, applyRecommendedDefaults, recentEvents, acknowledge,
};
