// 9. AI REFERRAL TRAFFIC — the demand side of GEO/AEO.
//
// Every other AI-SEO feature in this directory measures whether a page COULD
// be cited: can the fetchers reach it, is the content in the served HTML, is
// there schema, is a passage quotable. None of them answer the question the
// client actually asks, which is whether any of it worked.
//
// This one does, and it does it from the only ground truth available without a
// citation-tracking credential: people who read an AI answer about the brand,
// clicked the link in it, and arrived. GA4 records the assistant as the
// session source. That is a measurement of a human being, not an estimate of a
// model's behaviour, and it is free.
//
// WHAT THIS CAN AND CANNOT SEE — the important part
//
//   CAN SEE   Clicks from assistants that send a real referrer: ChatGPT,
//             Perplexity, Claude, Copilot, Gemini, and the rest of the list
//             below. A session here is proof the brand was cited AND that the
//             citation was persuasive enough to click.
//
//   CANNOT SEE  Google AI Overviews. An AI Overview click is reported by GA4
//             as google / organic, identical to an ordinary blue-link click.
//             Google publishes no way to separate them. Any tool claiming to
//             count AI Overview traffic in GA4 is inferring it, and this one
//             will not pretend otherwise — the shortfall is stated on screen
//             rather than quietly filled with a guess.
//
//   CANNOT SEE  Citations that were never clicked. An assistant naming the
//             brand in an answer the user simply read is invisible here. So
//             this is a FLOOR on AI visibility, never a total, and it is
//             labelled that way in the view.
//
// WHY EACH ASSISTANT HAS SEVERAL HOSTNAMES
// Assistants rename themselves — chat.openai.com became chatgpt.com,
// bard.google.com became gemini.google.com — and GA4 keeps whatever the
// referrer said at the time. Every historical hostname is therefore listed
// and matched, so a rename does not silently drop months of attributed
// sessions. Matching is anchored to a hostname boundary; see classifySource.
const store = require('./store');
const providers = require('./providers');
const google = require('../google');

// The assistants worth attributing, with the hostnames GA4 actually reports.
const AI_SOURCES = [
  { key: 'chatgpt', label: 'ChatGPT', match: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  { key: 'perplexity', label: 'Perplexity', match: ['perplexity.ai'] },
  { key: 'gemini', label: 'Gemini', match: ['gemini.google.com', 'bard.google.com'] },
  { key: 'copilot', label: 'Microsoft Copilot', match: ['copilot.microsoft.com', 'copilot.cloud.microsoft'] },
  { key: 'claude', label: 'Claude', match: ['claude.ai'] },
  { key: 'meta-ai', label: 'Meta AI', match: ['meta.ai'] },
  { key: 'grok', label: 'Grok', match: ['grok.com', 'x.ai'] },
  { key: 'deepseek', label: 'DeepSeek', match: ['deepseek.com'] },
  { key: 'mistral', label: 'Le Chat (Mistral)', match: ['mistral.ai'] },
  { key: 'you', label: 'You.com', match: ['you.com'] },
  { key: 'poe', label: 'Poe', match: ['poe.com'] },
  { key: 'phind', label: 'Phind', match: ['phind.com'] },
  { key: 'huggingface', label: 'HuggingChat', match: ['huggingface.co'] },
];

// Sources that carry BOTH assistant traffic and ordinary search traffic, with
// no way to split them. bing.com sends Copilot answer clicks and plain Bing
// searches under one name. These are counted separately and never folded into
// the headline number — inflating AI referrals with plain search traffic is
// the exact failure this feature exists to avoid.
const AMBIGUOUS_SOURCES = [
  {
    key: 'bing',
    label: 'Bing (Copilot answers not separable from ordinary Bing search)',
    match: ['bing.com'],
  },
];

// Classifies one GA4 sessionSource string. Returns null for everything that is
// not an assistant, which is most of the property's traffic.
// Matching is anchored to a hostname boundary — the whole host, or a subdomain
// of it — never a bare substring. A substring test looks harmless until a
// referrer like "foryou.com" is attributed to You.com, or "linux.ai" to Grok,
// and a silently inflated AI number is worse than no number at all.
function hostMatches(source, token) {
  return source === token || source.endsWith('.' + token);
}

function classifySource(raw) {
  // GA4 normally reports a bare host, but a path or a trailing qualifier turns
  // up often enough to be worth trimming before the comparison.
  const s = String(raw || '').toLowerCase().trim().split(/[/\s?]/)[0].replace(/\.$/, '');
  if (!s) return null;
  for (const src of AI_SOURCES) {
    if (src.match.some((m) => hostMatches(s, m))) {
      return { key: src.key, label: src.label, ambiguous: false };
    }
  }
  for (const src of AMBIGUOUS_SOURCES) {
    if (src.match.some((m) => hostMatches(s, m))) {
      return { key: src.key, label: src.label, ambiguous: true };
    }
  }
  return null;
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// Splits the daily series in half and compares the halves. Deliberately crude:
// with the small counts AI referrals produce on most sites, a regression line
// would imply a precision the data does not have.
function halfOverHalf(days) {
  if (days.length < 4) return null;
  const mid = Math.floor(days.length / 2);
  const earlier = days.slice(0, mid).reduce((a, d) => a + d.sessions, 0);
  const later = days.slice(mid).reduce((a, d) => a + d.sessions, 0);
  return {
    earlier,
    later,
    delta: later - earlier,
    pct: earlier > 0 ? Math.round(((later - earlier) / earlier) * 100) : null,
  };
}

async function run({
  userId, brand, adoptRunId = null, days = 90, includeLandingPages = true,
}) {
  const brandId = brand.id;
  const window = Math.min(365, Math.max(28, parseInt(days, 10) || 90));

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'ai_referrals', target: brand.site_url || null,
    params: { days: window, includeLandingPages },
  });

  try {
    if (!providers.has('ga4')) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: 'Google is not connected, so GA4 cannot be read. Connect Google under Settings, then pair a GA4 property on this brand.',
        },
        findings: [],
        sources: [],
      });
    }
    if (!brand.ga4_property_id) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: `No GA4 property is paired with ${brand.name || 'this brand'}. AI referral traffic is read from GA4 session sources, so there is nothing to read until a property is linked on the brand.`,
        },
        findings: [],
        sources: [],
      });
    }

    const startDate = isoDaysAgo(window);
    // Yesterday, not today: the current day is still filling and would render
    // as a collapse at the right-hand end of every chart.
    const endDate = isoDaysAgo(1);

    // One report, every source, classified here rather than filtered in the
    // API. A dimensionFilter would have to enumerate hostnames, which is the
    // enum this module deliberately avoids — a renamed assistant would vanish
    // from the report with no error to notice.
    const rows = await google.ga4RunReport(userId, brand.ga4_property_id, {
      startDate,
      endDate,
      dimensions: ['date', 'sessionSource'],
      metrics: ['sessions', 'totalUsers', 'conversions'],
      limit: 25000,
    });

    const byDate = new Map();
    const bySource = new Map();
    const ambiguous = new Map();
    let totalSessions = 0;
    let aiSessions = 0;
    let aiUsers = 0;
    let aiConversions = 0;

    rows.forEach((r) => {
      const date = google.ga4DateToIso(r.dimensions[0]);
      const sessions = r.metrics.sessions || 0;
      const users = r.metrics.totalUsers || 0;
      const conversions = r.metrics.conversions || 0;
      totalSessions += sessions;

      const hit = classifySource(r.dimensions[1]);
      if (!hit) return;

      const bucket = hit.ambiguous ? ambiguous : bySource;
      const prev = bucket.get(hit.key)
        || { key: hit.key, label: hit.label, sessions: 0, users: 0, conversions: 0, dates: new Set() };
      prev.sessions += sessions;
      prev.users += users;
      prev.conversions += conversions;
      prev.dates.add(date);
      bucket.set(hit.key, prev);

      if (hit.ambiguous) return;
      aiSessions += sessions;
      aiUsers += users;
      aiConversions += conversions;
      const d = byDate.get(date) || { date, sessions: 0 };
      d.sessions += sessions;
      byDate.set(date, d);
    });

    const flatten = (m) => [...m.values()]
      .map((s) => ({
        key: s.key, label: s.label, sessions: s.sessions, users: s.users,
        conversions: s.conversions, activeDays: s.dates.size,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const engines = flatten(bySource);
    const ambiguousEngines = flatten(ambiguous);
    const trend = halfOverHalf(series);
    const share = totalSessions > 0 ? aiSessions / totalSessions : 0;

    // Which pages the assistants actually send people to — the only part of
    // this feature that says something actionable about individual pages.
    let landingPages = [];
    if (includeLandingPages && aiSessions > 0) {
      const lp = await google.ga4RunReport(userId, brand.ga4_property_id, {
        startDate,
        endDate,
        dimensions: ['landingPagePlusQueryString', 'sessionSource'],
        metrics: ['sessions', 'conversions'],
        limit: 25000,
      });
      const pages = new Map();
      lp.forEach((r) => {
        const hit = classifySource(r.dimensions[1]);
        if (!hit || hit.ambiguous) return;
        const path = r.dimensions[0] || '(not set)';
        const prev = pages.get(path) || { path, sessions: 0, conversions: 0, engines: new Set() };
        prev.sessions += r.metrics.sessions || 0;
        prev.conversions += r.metrics.conversions || 0;
        prev.engines.add(hit.label);
        pages.set(path, prev);
      });
      landingPages = [...pages.values()]
        .map((p) => ({
          path: p.path, sessions: p.sessions, conversions: p.conversions,
          engines: [...p.engines].sort(),
        }))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 50);
    }

    // ------------------------------------------------------------ findings
    const findings = [];
    const metrics = [];

    if (aiSessions === 0) {
      findings.push({
        checkKey: 'ai_referrals_none',
        title: `No AI assistant sent a single visitor in ${window} days`,
        detail: 'Not one session from ChatGPT, Perplexity, Copilot, Gemini, Claude or any other assistant that passes a referrer. '
          + 'Read this as a floor rather than a verdict: an assistant that named the brand without the reader clicking leaves no trace here, and Google AI Overviews are indistinguishable from ordinary organic traffic in GA4. '
          + 'What it does rule out is the thing worth ruling out — that the brand is being cited AND clicked at any measurable rate.',
        severity: 'high',
        affectedUrl: brand.site_url || null,
        action: 'Run the AI-crawler readiness check first: a retrieval fetcher that cannot read the site cannot cite it, and that is the most common cause of a flat zero here.',
        dedupeKey: `aiseo:ai_referrals_none:${brandId}`,
      });
    } else if (trend && trend.pct != null && trend.pct <= -30 && trend.earlier >= 10) {
      findings.push({
        checkKey: 'ai_referrals_falling',
        title: `AI referral sessions fell ${Math.abs(trend.pct)}% across this window`,
        detail: `${trend.earlier} sessions in the first half against ${trend.later} in the second. `
          + 'A drop this size usually has a supply-side cause visible elsewhere in this app: a retrieval fetcher newly blocked at the edge, a page that started rendering client-side, or a nosnippet directive added.',
        severity: 'medium',
        affectedUrl: brand.site_url || null,
        action: 'Re-run AI-crawler readiness and compare against the previous run — the change is usually there.',
        evidence: { trend, engines },
        dedupeKey: `aiseo:ai_referrals_falling:${brandId}`,
      });
    }

    // One assistant carrying everything is a concentration worth naming: it
    // usually means the site is readable to one fetcher and not the others,
    // which the readiness report can confirm in a minute.
    if (engines.length === 1 && aiSessions >= 20) {
      findings.push({
        checkKey: 'ai_referrals_single_engine',
        title: `Every AI referral came from ${engines[0].label} alone`,
        detail: `${aiSessions} sessions, all from one assistant, with nothing from the others in ${window} days. On a site readable to all of them this is unusual — the usual explanation is that only one retrieval fetcher can reach the content.`,
        severity: 'medium',
        affectedUrl: brand.site_url || null,
        action: 'Check the per-agent verdict table in AI-crawler readiness for the assistants that sent nothing.',
        evidence: { engines },
        dedupeKey: `aiseo:ai_referrals_single_engine:${brandId}`,
      });
    }

    metrics.push({
      key: 'ai_referrals.sessions', url: brand.site_url || null, value: aiSessions,
      status: aiSessions > 0 ? 'good' : 'fail', detail: `${window}-day window`,
    });
    metrics.push({
      key: 'ai_referrals.share', url: brand.site_url || null, value: Math.round(share * 10000) / 100,
      status: 'info', detail: `${aiSessions} of ${totalSessions} sessions`,
    });
    metrics.push({
      key: 'ai_referrals.engines', url: brand.site_url || null, value: engines.length,
      status: 'info', detail: engines.map((e) => e.label).join(', ') || 'none',
    });

    // Share-of-traffic based, with a deliberately low ceiling: 2% of sessions
    // from assistants is a strong result today, and a scale that only reached
    // 100 at 20% would report every healthy site as failing.
    const score = Math.max(0, Math.min(100, Math.round((share / 0.02) * 100)));

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        window: { days: window, startDate, endDate },
        totals: {
          aiSessions,
          aiUsers,
          aiConversions,
          totalSessions,
          share: Math.round(share * 10000) / 100,
        },
        engines,
        ambiguousEngines,
        series,
        trend,
        landingPages,
        knownGaps: [
          'Google AI Overviews are reported by GA4 as google / organic and cannot be separated from ordinary organic clicks. No AI Overview traffic is included in these numbers.',
          'Citations that were read but not clicked leave no trace in analytics. These figures are a floor on AI visibility, never a total.',
          'Assistants that strip the referrer, and privacy browsers that block it, land in (direct) and are not counted here.',
        ],
      },
      findings,
      metrics,
      sources: ['ga4'],
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(runRecord, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (runRecord.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const res = tasksLib.upsertTask({
      userId,
      brandId: runRecord.brand_id,
      title: f.title,
      detail: `${f.detail}\n\n${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:ai_referrals:${runRecord.id}:${f.check_key}`,
      category: 'AI visibility',
      severity: f.severity,
      dedupeKey: f.dedupe_key,
    });
    if (res && res.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, classifySource, halfOverHalf, AI_SOURCES, AMBIGUOUS_SOURCES,
};
