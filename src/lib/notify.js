// Notification fan-out for alert events.
//
// Three channels, each independently optional:
//   email   — SMTP via nodemailer (falls back to console logging)
//   slack   — Slack Incoming Webhook URL
//   webhook — any HTTPS endpoint receiving JSON. This is the WhatsApp path:
//             point it at a WhatsApp Business API relay (Twilio, 360dialog,
//             Meta Cloud API, or an n8n/Zapier hook) and the payload below is
//             delivered as-is. No WhatsApp provider is hard-coded, because
//             every provider's send API differs.
//
// Every send is best-effort: a failing channel is recorded and never throws
// into the alert engine, so one broken webhook cannot stop alert evaluation.
const nodemailer = require('nodemailer');

const SEVERITY_META = {
  critical: { label: 'Critical', emoji: '\u{1F534}', color: '#c92a2a' },
  high: { label: 'High', emoji: '\u{1F7E0}', color: '#e8590c' },
  medium: { label: 'Medium', emoji: '\u{1F7E1}', color: '#f08c00' },
  low: { label: 'Low', emoji: '\u{1F535}', color: '#1971c2' },
  info: { label: 'Info', emoji: '\u{2139}', color: '#495057' },
};

function severityMeta(sev) {
  return SEVERITY_META[sev] || SEVERITY_META.medium;
}

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// An "alert" here is the shape produced by alertEngine:
// { brandName, siteUrl, alertKey, alertLabel, severity, title, message,
//   affected: [strings], suggestedAction, dashboardUrl }
function renderText(alert) {
  const m = severityMeta(alert.severity);
  const lines = [
    `${m.emoji}  ${m.label.toUpperCase()} — ${alert.title}`,
    '',
    `Brand:     ${alert.brandName || '(unassigned)'}`,
    `Website:   ${alert.siteUrl || '-'}`,
    `Issue:     ${alert.alertLabel || alert.alertKey}`,
    `Severity:  ${m.label}`,
    '',
    alert.message || '',
  ];
  if (alert.affected && alert.affected.length) {
    lines.push('', 'Affected:');
    alert.affected.slice(0, 15).forEach((a) => lines.push(`  - ${a}`));
    if (alert.affected.length > 15) {
      lines.push(`  ... and ${alert.affected.length - 15} more`);
    }
  }
  if (alert.suggestedAction) {
    lines.push('', 'Suggested next step:', `  ${alert.suggestedAction}`);
  }
  if (alert.dashboardUrl) {
    lines.push('', `Open in dashboard: ${alert.dashboardUrl}`);
  }
  return lines.join('\n');
}

function renderHtml(alert) {
  const m = severityMeta(alert.severity);
  const affected = (alert.affected || []).slice(0, 15)
    .map((a) => `<li style="margin:2px 0;word-break:break-all">${escapeHtml(a)}</li>`).join('');
  const more = (alert.affected || []).length > 15
    ? `<li style="color:#868e96">… and ${alert.affected.length - 15} more</li>` : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#212529">
  <div style="border-left:4px solid ${m.color};padding:2px 0 2px 14px;margin-bottom:18px">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${m.color};font-weight:700">${m.label} alert</div>
    <div style="font-size:19px;font-weight:600;margin-top:3px">${escapeHtml(alert.title)}</div>
  </div>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">
    <tr><td style="padding:3px 14px 3px 0;color:#868e96">Brand</td><td style="padding:3px 0"><strong>${escapeHtml(alert.brandName || '(unassigned)')}</strong></td></tr>
    <tr><td style="padding:3px 14px 3px 0;color:#868e96">Website</td><td style="padding:3px 0">${escapeHtml(alert.siteUrl || '-')}</td></tr>
    <tr><td style="padding:3px 14px 3px 0;color:#868e96">Issue type</td><td style="padding:3px 0">${escapeHtml(alert.alertLabel || alert.alertKey)}</td></tr>
  </table>
  <p style="font-size:14.5px;line-height:1.6">${escapeHtml(alert.message || '')}</p>
  ${affected ? `<p style="font-size:13px;color:#868e96;margin-bottom:4px;font-weight:600">Affected</p><ul style="font-size:13px;padding-left:20px;margin-top:0">${affected}${more}</ul>` : ''}
  ${alert.suggestedAction ? `<div style="background:#f8f9fa;border-radius:6px;padding:12px 14px;font-size:14px;margin-top:16px"><strong>Suggested next step:</strong><br>${escapeHtml(alert.suggestedAction)}</div>` : ''}
  ${alert.dashboardUrl ? `<p style="margin-top:20px"><a href="${escapeHtml(alert.dashboardUrl)}" style="background:#1c7ed6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;display:inline-block">Open in dashboard</a></p>` : ''}
</div>`;
}

async function sendEmail(recipients, alert) {
  const to = (Array.isArray(recipients) ? recipients : String(recipients || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { channel: 'email', sent: false, reason: 'no recipients configured' };

  const m = severityMeta(alert.severity);
  const subject = `[${m.label}] ${alert.brandName || 'SEO'}: ${alert.title}`;
  const transport = getTransport();

  if (!transport) {
    console.log(`[notify:email] SMTP not configured — alert logged instead of sent.\n  To: ${to.join(', ')}\n  Subject: ${subject}\n${renderText(alert)}\n`);
    return { channel: 'email', sent: false, reason: 'SMTP not configured (logged to console)' };
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'seo-alerts@localhost',
      to: to.join(', '),
      subject,
      text: renderText(alert),
      html: renderHtml(alert),
    });
    return { channel: 'email', sent: true, to };
  } catch (err) {
    console.error('[notify:email] send failed:', err.message);
    return { channel: 'email', sent: false, reason: err.message };
  }
}

async function sendSlack(webhookUrl, alert) {
  const url = webhookUrl || process.env.SLACK_WEBHOOK_URL || '';
  if (!url) return { channel: 'slack', sent: false, reason: 'no Slack webhook configured' };

  const m = severityMeta(alert.severity);
  const fields = [
    { type: 'mrkdwn', text: `*Brand*\n${alert.brandName || '(unassigned)'}` },
    { type: 'mrkdwn', text: `*Severity*\n${m.emoji} ${m.label}` },
    { type: 'mrkdwn', text: `*Website*\n${alert.siteUrl || '-'}` },
    { type: 'mrkdwn', text: `*Issue*\n${alert.alertLabel || alert.alertKey}` },
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${m.emoji} ${alert.title}`.slice(0, 150) } },
    { type: 'section', fields },
  ];
  if (alert.message) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alert.message.slice(0, 2900) } });
  }
  if (alert.affected && alert.affected.length) {
    const list = alert.affected.slice(0, 10).map((a) => `• ${a}`).join('\n');
    const extra = alert.affected.length > 10 ? `\n_…and ${alert.affected.length - 10} more_` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Affected*\n${(list + extra).slice(0, 2900)}` } });
  }
  if (alert.suggestedAction) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Suggested next step*\n${alert.suggestedAction.slice(0, 2900)}` } });
  }
  if (alert.dashboardUrl) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: alert.dashboardUrl }],
    });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${m.emoji} ${alert.title}`, blocks }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { channel: 'slack', sent: false, reason: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    return { channel: 'slack', sent: true };
  } catch (err) {
    return { channel: 'slack', sent: false, reason: err.message };
  }
}

// Generic JSON webhook — the integration point for WhatsApp or anything else.
async function sendWebhook(webhookUrl, alert) {
  const url = webhookUrl || process.env.ALERT_WEBHOOK_URL || '';
  if (!url) return { channel: 'webhook', sent: false, reason: 'no webhook URL configured' };
  const payload = {
    event: 'seo_alert',
    alert_key: alert.alertKey,
    alert_label: alert.alertLabel,
    severity: alert.severity,
    brand: alert.brandName,
    website: alert.siteUrl,
    title: alert.title,
    message: alert.message,
    affected: alert.affected || [],
    suggested_action: alert.suggestedAction || null,
    dashboard_url: alert.dashboardUrl || null,
    // Pre-formatted single-string body, for relays that just forward text
    // straight into a WhatsApp/SMS template variable.
    text: renderText(alert),
    detected_at: alert.detectedAt || new Date().toISOString(),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { channel: 'webhook', sent: false, reason: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    return { channel: 'webhook', sent: true };
  } catch (err) {
    return { channel: 'webhook', sent: false, reason: err.message };
  }
}

// Dispatches one alert across the requested channels. `channels` is a
// comma-separated string ("email,slack") as stored on the subscription.
async function dispatch(alert, { channels, recipients, slackWebhook, webhookUrl }) {
  const wanted = String(channels || 'email').split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const ch of wanted) {
    if (ch === 'email') results.push(await sendEmail(recipients, alert));
    else if (ch === 'slack') results.push(await sendSlack(slackWebhook, alert));
    else if (ch === 'webhook' || ch === 'whatsapp') results.push(await sendWebhook(webhookUrl, alert));
    else results.push({ channel: ch, sent: false, reason: 'unknown channel' });
  }
  return results;
}

// Digest email covering many alerts at once, used by the daily/weekly roll-up
// so a noisy morning does not produce 30 separate emails.
async function sendDigest(recipients, subject, alerts, dashboardUrl) {
  const to = (Array.isArray(recipients) ? recipients : String(recipients || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { channel: 'email', sent: false, reason: 'no recipients configured' };

  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const sorted = [...alerts].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const rows = sorted.map((a) => {
    const m = severityMeta(a.severity);
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e9ecef;white-space:nowrap"><span style="color:${m.color};font-weight:700;font-size:12px">${m.label}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e9ecef;font-size:13px">${escapeHtml(a.brandName || '-')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e9ecef;font-size:13px"><strong>${escapeHtml(a.title)}</strong><br><span style="color:#868e96">${escapeHtml(a.message || '')}</span>${a.suggestedAction ? `<br><span style="color:#1971c2">→ ${escapeHtml(a.suggestedAction)}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;color:#212529">
  <h2 style="margin:0 0 4px">SEO alert digest</h2>
  <p style="color:#868e96;font-size:13px;margin:0 0 18px">${alerts.length} alert${alerts.length === 1 ? '' : 's'} triggered</p>
  <table style="border-collapse:collapse;width:100%">
    <tr><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#868e96;border-bottom:2px solid #dee2e6">Severity</th>
        <th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#868e96;border-bottom:2px solid #dee2e6">Brand</th>
        <th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#868e96;border-bottom:2px solid #dee2e6">Issue</th></tr>
    ${rows}
  </table>
  ${dashboardUrl ? `<p style="margin-top:22px"><a href="${escapeHtml(dashboardUrl)}" style="background:#1c7ed6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;display:inline-block">Open dashboard</a></p>` : ''}
</div>`;

  const text = sorted.map((a) => `[${severityMeta(a.severity).label}] ${a.brandName || '-'} — ${a.title}\n  ${a.message || ''}${a.suggestedAction ? `\n  -> ${a.suggestedAction}` : ''}`).join('\n\n');

  const transport = getTransport();
  if (!transport) {
    console.log(`[notify:digest] SMTP not configured — digest logged instead.\n  To: ${to.join(', ')}\n  Subject: ${subject}\n${text}\n`);
    return { channel: 'email', sent: false, reason: 'SMTP not configured (logged to console)' };
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'seo-alerts@localhost',
      to: to.join(', '), subject, text, html,
    });
    return { channel: 'email', sent: true, to };
  } catch (err) {
    return { channel: 'email', sent: false, reason: err.message };
  }
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function deltaColor(abs, invert) {
  if (!abs) return '#868e96';
  const good = invert ? abs < 0 : abs > 0;
  return good ? '#2f9e44' : '#e03131';
}

// Simple table-based bar so movement reads at a glance in email clients that
// don't render SVG/canvas reliably (Outlook, some mobile Gmail views).
function barCell(value, max, color) {
  const pct = max > 0 ? Math.max(2, Math.round((Math.abs(value) / max) * 100)) : 0;
  return `<div style="background:#f1f3f5;border-radius:3px;overflow:hidden;height:8px;width:120px">
    <div style="background:${color};height:8px;width:${pct}%"></div>
  </div>`;
}

function statCard(label, delta, opts = {}) {
  const { invert = false, isPct = false, decimals = 0 } = opts;
  const color = deltaColor(delta.abs, invert);
  const val = isPct ? `${delta.recent.toFixed(decimals)}%` : fmtNum(delta.recent);
  return `<td style="padding:14px 16px;background:#f8f9fa;border-radius:8px" width="25%">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#868e96;font-weight:600">${label}</div>
    <div style="font-size:24px;font-weight:700;color:#212529;margin-top:4px">${val}</div>
    <div style="font-size:12.5px;font-weight:600;color:${color};margin-top:2px">${delta.pct == null ? (delta.abs === 0 ? 'flat' : fmtNum(delta.abs)) : fmtPct(delta.pct)}</div>
  </td>`;
}

function queryRows(rows, useImpressions) {
  if (!rows || !rows.length) return '<tr><td style="padding:8px 10px;color:#868e96;font-size:13px" colspan="3">No movement this week.</td></tr>';
  const max = Math.max(...rows.map((r) => Math.abs(useImpressions ? r.impressionDelta : r.clickDelta)), 1);
  return rows.map((r) => {
    const d = useImpressions ? r.impressionDelta : r.clickDelta;
    const color = deltaColor(d, false);
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.entity)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right;font-weight:600;color:${color};white-space:nowrap">${d > 0 ? '+' : ''}${fmtNum(d)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5">${barCell(d, max, color)}</td>
    </tr>`;
  }).join('');
}

function pageRows(rows) {
  if (!rows || !rows.length) return '<tr><td style="padding:8px 10px;color:#868e96;font-size:13px" colspan="3">No data.</td></tr>';
  return rows.map((r) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:12.5px;word-break:break-all">${escapeHtml(r.entity)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right;white-space:nowrap">${fmtNum(r.recentClicks)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right;white-space:nowrap;color:${deltaColor(r.clickDelta, false)};font-weight:600">${r.clickDelta > 0 ? '+' : ''}${fmtNum(r.clickDelta)}</td>
  </tr>`).join('');
}

function taskRows(rows, dateField) {
  if (!rows || !rows.length) return '<tr><td style="padding:8px 10px;color:#868e96;font-size:13px" colspan="3">None.</td></tr>';
  return rows.map((t) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px">${escapeHtml(t.title)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:12px"><span style="background:#e7f5ff;color:#1971c2;padding:2px 7px;border-radius:10px">${escapeHtml(t.severity || t.status || '')}</span></td>
    <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:12px;color:#868e96;white-space:nowrap">${escapeHtml((t[dateField] || '').toString().slice(0, 10))}</td>
  </tr>`).join('');
}

// Full weekly SEO performance report — the email counterpart of
// reportBuilder's build() output, rendered as one self-contained HTML email
// with organic traffic, keyword and page movement, conversions, technical
// health, work completed, and next actions.
function renderReportHtml(report, dashboardUrl) {
  const b = report.brand;
  const period = `${report.period.startDate} → ${report.period.endDate}`;
  const s = report.search;
  const a = report.analytics;

  const headline = (report.headline || [])
    .map((h) => `<li style="margin-bottom:6px;line-height:1.5">${escapeHtml(h)}</li>`).join('');

  const useImp = report.keywords.useImpressionFallback;
  const gainRows = queryRows(useImp ? report.keywords.impressionGainers : report.keywords.gainers, useImp);
  const declRows = queryRows(useImp ? report.keywords.impressionDecliners : report.keywords.decliners, useImp);

  const cwvRows = ['mobile', 'desktop'].map((k) => {
    const v = report.cwv && report.cwv[k];
    if (!v) return '';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-transform:capitalize">${k}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right">${v.score != null ? Math.round(v.score) : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right">${v.lcp != null ? `${(v.lcp / 1000).toFixed(2)}s` : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right">${v.inp != null ? `${v.inp}ms` : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right">${v.cls != null ? v.cls.toFixed(3) : '—'}</td>
    </tr>`;
  }).join('');

  const techSection = report.technical ? `
  <h2 style="font-size:16px;margin:28px 0 10px">Technical health</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:6px">
    <tr><td style="padding:4px 0;font-size:13px;color:#868e96">Health score</td><td style="padding:4px 0;font-size:13px;text-align:right;font-weight:700">${report.technical.health != null ? Math.round(report.technical.health) : '—'}/100</td></tr>
    <tr><td style="padding:4px 0;font-size:13px;color:#868e96">Pages crawled</td><td style="padding:4px 0;font-size:13px;text-align:right">${fmtNum(report.technical.pagesCrawled)}</td></tr>
    <tr><td style="padding:4px 0;font-size:13px;color:#868e96">Critical / high issues</td><td style="padding:4px 0;font-size:13px;text-align:right;font-weight:700;color:${((report.technical.bySeverity && (report.technical.bySeverity.critical || 0) + (report.technical.bySeverity.high || 0)) || 0) ? '#e03131' : '#2f9e44'}">${fmtNum((report.technical.bySeverity && (report.technical.bySeverity.critical || 0)) + (report.technical.bySeverity && (report.technical.bySeverity.high || 0)))}</td></tr>
  </table>
  ${report.technical.top && report.technical.top.length ? `<table style="border-collapse:collapse;width:100%">
    <tr><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Issue</th><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Severity</th><th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Failing</th></tr>
    ${report.technical.top.slice(0, 8).map((t) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px">${escapeHtml(t.issue)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:12px"><span style="background:#fff3bf;color:#997404;padding:2px 7px;border-radius:10px">${escapeHtml(t.severity)}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:13px;text-align:right">${fmtNum(t.failed)}</td>
    </tr>`).join('')}
  </table>` : ''}` : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;color:#212529">
  <div style="border-bottom:3px solid #1c7ed6;padding-bottom:16px;margin-bottom:20px">
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#1c7ed6;font-weight:700">Weekly SEO Report</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px">${escapeHtml(b.name)}</div>
    <div style="font-size:13px;color:#868e96;margin-top:2px">${escapeHtml(b.site_url || '')} &middot; ${period}</div>
  </div>

  ${headline ? `<ul style="padding-left:18px;font-size:14px;margin:0 0 22px">${headline}</ul>` : ''}

  <h2 style="font-size:16px;margin:0 0 10px">Search performance</h2>
  <table style="border-collapse:separate;border-spacing:8px 0;width:100%;margin:0 0 20px -8px"><tr>
    ${statCard('Clicks', s.clicks)}
    ${statCard('Impressions', s.impressions)}
    ${statCard('Avg. CTR', s.ctr, { isPct: true, decimals: 2 })}
    ${statCard('Avg. position', { recent: s.position.recent, abs: s.position.abs, pct: null }, { invert: true, isPct: false, decimals: 1 })}
  </tr></table>

  ${a.hasData ? `<h2 style="font-size:16px;margin:0 0 10px">Traffic &amp; conversions (GA4, organic)</h2>
  <table style="border-collapse:separate;border-spacing:8px 0;width:100%;margin:0 0 20px -8px"><tr>
    ${statCard('Sessions', a.sessions)}
    ${statCard('Users', a.users)}
    ${statCard('Conversions', a.conversions)}
    ${statCard('Conv. rate', a.convRate, { isPct: true, decimals: 2 })}
  </tr></table>` : ''}

  <table style="width:100%;margin-bottom:6px"><tr>
    <td valign="top" width="50%" style="padding-right:10px">
      <h3 style="font-size:14px;margin:16px 0 8px">Top gaining ${useImp ? 'keywords (by impressions)' : 'keywords'}</h3>
      <table style="border-collapse:collapse;width:100%">${gainRows}</table>
    </td>
    <td valign="top" width="50%" style="padding-left:10px">
      <h3 style="font-size:14px;margin:16px 0 8px">Top declining ${useImp ? 'keywords (by impressions)' : 'keywords'}</h3>
      <table style="border-collapse:collapse;width:100%">${declRows}</table>
    </td>
  </tr></table>

  <h2 style="font-size:16px;margin:24px 0 10px">Top landing pages</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
    <tr><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Page</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Clicks</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Change</th></tr>
    ${pageRows(report.pages.topLanding.slice(0, 8))}
  </table>

  ${cwvRows ? `<h2 style="font-size:16px;margin:0 0 10px">Core Web Vitals</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
    <tr><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Device</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">Score</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">LCP</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">INP</th>
        <th align="right" style="padding:6px 10px;font-size:11px;text-transform:uppercase;color:#868e96;border-bottom:2px solid #dee2e6">CLS</th></tr>
    ${cwvRows}
  </table>` : ''}

  ${techSection}

  <h2 style="font-size:16px;margin:28px 0 10px">Work completed this week</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:20px">${taskRows(report.work.completed, 'completed_at')}</table>

  <h2 style="font-size:16px;margin:0 0 10px">Actions required next week</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:8px">${taskRows(report.work.nextActions, 'due_date')}</table>
  ${report.work.awaitingApproval.length ? `<p style="font-size:13px;color:#e8590c;font-weight:600">${report.work.awaitingApproval.length} task(s) are waiting on your approval.</p>` : ''}

  ${dashboardUrl ? `<p style="margin-top:24px"><a href="${escapeHtml(dashboardUrl)}" style="background:#1c7ed6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;display:inline-block;font-weight:600">Open full report in dashboard</a></p>` : ''}
  <p style="font-size:11.5px;color:#adb5bd;margin-top:28px">Automated weekly report generated ${new Date(report.generatedAt).toLocaleString('en-US')}.</p>
</div>`;
}

function renderReportText(report) {
  const b = report.brand;
  const s = report.search;
  const lines = [
    `WEEKLY SEO REPORT — ${b.name}`,
    `${b.site_url || ''}  (${report.period.startDate} to ${report.period.endDate})`,
    '',
    ...(report.headline || []).map((h) => `- ${h}`),
    '',
    `Clicks: ${fmtNum(s.clicks.recent)} (${fmtPct(s.clicks.pct)})`,
    `Impressions: ${fmtNum(s.impressions.recent)} (${fmtPct(s.impressions.pct)})`,
    `Avg CTR: ${s.ctr.recent.toFixed(2)}%`,
    `Avg position: ${s.position.recent != null ? s.position.recent.toFixed(1) : '—'}`,
  ];
  if (report.analytics.hasData) {
    lines.push('', `Sessions: ${fmtNum(report.analytics.sessions.recent)}`, `Conversions: ${fmtNum(report.analytics.conversions.recent)}`);
  }
  lines.push('', `Tasks completed this week: ${report.work.completed.length}`, `Awaiting approval: ${report.work.awaitingApproval.length}`);
  return lines.join('\n');
}

async function sendWeeklyReport(recipients, report, dashboardUrl) {
  const to = (Array.isArray(recipients) ? recipients : String(recipients || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { channel: 'email', sent: false, reason: 'no recipients configured' };

  const subject = `Weekly SEO Report — ${report.brand.name} (${report.period.startDate} to ${report.period.endDate})`;
  const transport = getTransport();
  if (!transport) {
    console.log(`[notify:report] SMTP not configured — report logged instead of sent.\n  To: ${to.join(', ')}\n  Subject: ${subject}\n`);
    return { channel: 'email', sent: false, reason: 'SMTP not configured (logged to console)' };
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'seo-alerts@localhost',
      to: to.join(', '),
      subject,
      text: renderReportText(report),
      html: renderReportHtml(report, dashboardUrl),
    });
    return { channel: 'email', sent: true, to };
  } catch (err) {
    console.error('[notify:report] send failed:', err.message);
    return { channel: 'email', sent: false, reason: err.message };
  }
}

// One place that actually puts a message on the wire, so every sender behaves
// the same when SMTP is not configured: log it and report why, rather than
// throwing or silently reporting success.
async function deliver(to, subject, text, html) {
  const recipients = (Array.isArray(to) ? to : String(to || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no recipients' };

  const transport = getTransport();
  if (!transport) {
    console.log(`[notify:email] SMTP not configured — message logged instead of sent.\n  To: ${recipients.join(', ')}\n  Subject: ${subject}\n${text}\n`);
    return { sent: false, reason: 'SMTP not configured (logged to console)', to: recipients };
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'seo-alerts@localhost',
      to: recipients.join(', '),
      subject,
      text,
      html,
    });
    return { sent: true, to: recipients };
  } catch (err) {
    console.error('[notify:email] send failed:', err.message);
    return { sent: false, reason: err.message, to: recipients };
  }
}

// ------------------------------------------------------- task assignment
// Sent to whoever a task is assigned to — usually a developer who does not
// have an account here, so the email has to carry enough of the task to be
// actionable on its own, not just a link into an app they cannot open.
async function sendTaskAssignment(recipient, { task, assignedBy, brandName, url, note }) {
  const to = String(recipient || '').trim();
  if (!to) return { sent: false, reason: 'no recipient' };

  const m = severityMeta(task.severity);
  const rows = [
    ['Brand', brandName || '—'],
    ['Severity', String(task.severity || 'medium')],
    ['Source', String(task.source || 'manual')],
    ['Due', task.due_date || 'not set'],
    ['Effort', task.effort || 'not estimated'],
    ['Affected URL', task.affected_url || '—'],
  ].filter(([, v]) => v && v !== '—' || true);

  const text = [
    `You have been assigned an SEO task${assignedBy ? ` by ${assignedBy}` : ''}.`,
    '',
    task.title,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(task.detail ? ['', 'Detail:', task.detail] : []),
    ...(note ? ['', 'Note from the assigner:', note] : []),
    ...(task.requires_approval ? ['', 'NOTE: this task needs SEO sign-off before it goes live.'] : []),
    ...(url ? ['', `Open the task: ${url}`] : []),
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#212529">
  <div style="border-left:4px solid ${m.color};padding:2px 0 2px 14px;margin-bottom:18px">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${m.color};font-weight:700">${m.label} priority · task assigned</div>
    <div style="font-size:19px;font-weight:600;margin-top:3px">${escapeHtml(task.title)}</div>
  </div>
  <p style="font-size:14.5px;line-height:1.6">You have been assigned this task${assignedBy ? ` by <strong>${escapeHtml(assignedBy)}</strong>` : ''}.</p>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">
    ${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#868e96">${escapeHtml(k)}</td><td style="padding:3px 0;word-break:break-all">${escapeHtml(String(v))}</td></tr>`).join('')}
  </table>
  ${task.detail ? `<p style="font-size:13.5px;color:#495057;line-height:1.6;white-space:pre-wrap">${escapeHtml(task.detail)}</p>` : ''}
  ${note ? `<div style="background:#f8f9fa;border-radius:6px;padding:12px 14px;font-size:14px;margin-top:12px"><strong>Note from the assigner:</strong><br>${escapeHtml(note)}</div>` : ''}
  ${task.requires_approval ? '<p style="font-size:13.5px;color:#8a5a00;background:#fff9db;border-radius:6px;padding:10px 12px">This task needs SEO sign-off before it goes live.</p>' : ''}
  ${url ? `<p style="margin-top:20px"><a href="${escapeHtml(url)}" style="background:#1c7ed6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;display:inline-block">Open the task</a></p>` : ''}
</div>`;

  const subject = `[${String(task.severity || 'medium').toUpperCase()}] ${task.title}${brandName ? ` — ${brandName}` : ''}`;
  return deliver(to, subject, text, html);
}

// One message covering every task assigned to one person. Written to stand on
// its own: the recipient is usually a developer or writer with no account
// here, so the email has to carry the work, not merely announce it.
async function sendAssignmentDigest(recipient, { tasks = [], personName, assignedBy, baseUrl }) {
  const to = String(recipient || '').trim();
  if (!to) return { sent: false, reason: 'no recipient' };
  if (!tasks.length) return { sent: false, reason: 'no tasks' };

  const one = tasks.length === 1;
  const subject = one
    ? `[${String(tasks[0].severity || 'medium').toUpperCase()}] ${tasks[0].title}${tasks[0].brandName ? ` — ${tasks[0].brandName}` : ''}`
    : `${tasks.length} tasks assigned to you${assignedBy ? ` by ${assignedBy}` : ''}`;

  const line = (t) => {
    const bits = [
      `• ${t.title}`,
      `  Severity: ${t.severity || 'medium'}${t.brandName ? `  |  Site: ${t.brandName}` : ''}`,
      t.dueDate ? `  Due: ${t.dueDate}` : null,
      t.effort ? `  Effort: ${t.effort}` : null,
      t.affectedUrl ? `  URL: ${t.affectedUrl}` : null,
      t.detail ? `  ${String(t.detail).split('\n').join('\n  ')}` : null,
      t.note ? `  Note: ${t.note}` : null,
      t.requiresApproval ? '  Needs SEO sign-off before it goes live.' : null,
      baseUrl ? `  Open: ${baseUrl}/tasks/${t.id}` : null,
    ].filter(Boolean);
    return bits.join('\n');
  };

  const text = [
    personName ? `Hi ${personName},` : 'Hi,',
    '',
    one
      ? `You have been assigned the following task${assignedBy ? ` by ${assignedBy}` : ''}:`
      : `You have been assigned ${tasks.length} tasks${assignedBy ? ` by ${assignedBy}` : ''}:`,
    '',
    tasks.map(line).join('\n\n'),
  ].join('\n');

  const card = (t) => `
    <div style="border:1px solid #e5e9f0;border-left:4px solid ${severityMeta(t.severity).color};border-radius:6px;padding:12px 14px;margin-bottom:12px">
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${escapeHtml(t.title)}</div>
      <table style="border-collapse:collapse;font-size:13px;margin-bottom:8px">
        <tr><td style="padding:2px 12px 2px 0;color:#868e96">Priority</td><td style="padding:2px 0"><strong>${escapeHtml(String(t.severity || 'medium'))}</strong></td></tr>
        ${t.brandName ? `<tr><td style="padding:2px 12px 2px 0;color:#868e96">Site</td><td style="padding:2px 0">${escapeHtml(t.brandName)}</td></tr>` : ''}
        ${t.dueDate ? `<tr><td style="padding:2px 12px 2px 0;color:#868e96">Due</td><td style="padding:2px 0">${escapeHtml(t.dueDate)}</td></tr>` : ''}
        ${t.effort ? `<tr><td style="padding:2px 12px 2px 0;color:#868e96">Effort</td><td style="padding:2px 0">${escapeHtml(t.effort)}</td></tr>` : ''}
        ${t.affectedUrl ? `<tr><td style="padding:2px 12px 2px 0;color:#868e96">URL</td><td style="padding:2px 0;word-break:break-all">${escapeHtml(t.affectedUrl)}</td></tr>` : ''}
      </table>
      ${t.detail ? `<div style="font-size:13px;color:#495057;line-height:1.55;white-space:pre-wrap">${escapeHtml(t.detail)}</div>` : ''}
      ${t.note ? `<div style="background:#f8f9fa;border-radius:5px;padding:9px 11px;font-size:13px;margin-top:9px"><strong>Note:</strong> ${escapeHtml(t.note)}</div>` : ''}
      ${t.requiresApproval ? '<div style="font-size:12.5px;color:#8a5a00;margin-top:8px">Needs SEO sign-off before it goes live.</div>' : ''}
      ${baseUrl ? `<div style="margin-top:10px"><a href="${escapeHtml(`${baseUrl}/tasks/${t.id}`)}" style="font-size:13px;color:#1c7ed6">Open this task</a></div>` : ''}
    </div>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:660px;color:#212529">
    <p style="font-size:14.5px;line-height:1.6">${personName ? `Hi ${escapeHtml(personName)},` : 'Hi,'}</p>
    <p style="font-size:14.5px;line-height:1.6">
      ${one ? 'You have been assigned the following task' : `You have been assigned <strong>${tasks.length} tasks</strong>`}${assignedBy ? ` by <strong>${escapeHtml(assignedBy)}</strong>` : ''}.
    </p>
    ${tasks.map(card).join('')}
    <p style="font-size:12px;color:#868e96;margin-top:18px">
      You are receiving this because work was assigned to you in the SEO suite. Replies go to the person who assigned it.
    </p>
  </div>`;

  return deliver(to, subject, text, html);
}

module.exports = {
  dispatch, sendEmail, sendSlack, sendWebhook, sendDigest, sendWeeklyReport,
  sendTaskAssignment, sendAssignmentDigest,
  renderReportHtml, renderReportText,
  severityMeta, SEVERITY_META, smtpConfigured, renderText, renderHtml,
  // kept so any older import path keeps working
  sendAlertEmail: async (to, subject, text) => sendEmail(to, { title: subject, message: text, severity: 'medium' }),
};
