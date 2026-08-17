// PageSpeed Insights v5 — full report client.
//
// AUTHENTICATION
// The PageSpeed Insights API does NOT accept API keys on a project where it is
// enabled as a normal service: it answers a key with
// "API keys are not supported by this API. Expected OAuth2 access token or
// other authentication credentials that assert a principal."
// So the primary credential here is the user's existing Google connection —
// the same OAuth client already used for Search Console and GA4. No extra
// scope is needed: PSI authorises the *principal*, not a scope, so the token
// minted for webmasters.readonly + analytics.readonly is accepted as-is.
//
// Order of attempts:
//   1. The user's OAuth access token (per-project quota, the reliable path)
//   2. PSI_API_KEY, if one is set and the project does accept keys
//   3. No credential at all — Google's shared anonymous pool, which is small
//      and frequently exhausted (HTTP 429)
//
// The raw response is stored verbatim so a report can be re-rendered later
// without another API call; `normalise()` turns it into the shape the view
// renders, mirroring what Google's own PageSpeed Insights page shows.
const google = require('./google');

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

// Lighthouse scoring bands, identical to the ones PSI colours its gauges with.
function band(score) {
  if (score == null) return 'none';
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'average';
  return 'poor';
}

async function fetchReport(userId, { url, strategy = 'mobile', locale = 'en-US' }) {
  const params = new URLSearchParams({ url, strategy, locale });
  CATEGORIES.forEach((c) => params.append('category', c));

  const attempts = [];
  let token = null;
  if (userId) {
    try { token = await google.getValidAccessToken(userId); } catch { token = null; }
  }
  if (token) attempts.push({ via: 'oauth', headers: { Authorization: `Bearer ${token}` }, extra: '' });
  if (process.env.PSI_API_KEY) attempts.push({ via: 'api-key', headers: {}, extra: `&key=${encodeURIComponent(process.env.PSI_API_KEY)}` });
  attempts.push({ via: 'anonymous', headers: {}, extra: '' });

  let lastError = null;
  for (const attempt of attempts) {
    let res;
    try {
      // Lighthouse runs on Google's side and regularly takes 30-60s on a slow
      // page, so the timeout is generous rather than typical-request sized.
      res = await fetch(`${ENDPOINT}?${params.toString()}${attempt.extra}`, {
        headers: attempt.headers,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastError = new Error(`PageSpeed request failed (${attempt.via}): ${err.message}`);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      return { data, via: attempt.via };
    }
    const body = await res.text().catch(() => '');
    let message = `HTTP ${res.status}`;
    try { message = JSON.parse(body).error.message || message; } catch { /* keep the status */ }
    lastError = new Error(message);
    lastError.status = res.status;
    lastError.via = attempt.via;
    // 401/403/429 are credential or quota problems worth retrying on the next
    // credential; anything else (400 bad URL, 500 Lighthouse crash) will fail
    // the same way however it is authenticated.
    if (![401, 403, 429].includes(res.status)) break;
  }
  throw lastError || new Error('PageSpeed Insights request failed.');
}

// ------------------------------------------------------------ formatting
function kib(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${Math.round(n / 1024).toLocaleString('en-US')} KiB`;
}

function ms(v) {
  const n = Number(v) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

// Lighthouse table cells are either primitives or typed objects. Flattening
// them here keeps the template free of Lighthouse's internal shapes.
function cellText(value, valueType) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.type === 'url' || value.type === 'link') return value.value || value.url || value.text || '';
    if (value.type === 'node') return value.nodeLabel || value.selector || value.snippet || '';
    if (value.type === 'source-location') return `${value.url || ''}${value.line != null ? `:${value.line}` : ''}`;
    if (value.type === 'code' || value.type === 'text') return String(value.value ?? '');
    if (value.type === 'numeric') return cellText(value.value, valueType);
    if (value.type === 'debugdata') return '';
    if (Array.isArray(value)) return value.map((v) => cellText(v, valueType)).join(', ');
    if (value.value !== undefined) return cellText(value.value, valueType);
    return '';
  }
  switch (valueType) {
    case 'bytes': return kib(value);
    case 'ms':
    case 'timespanMs': return ms(value);
    case 'numeric': return typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
    default: return String(value);
  }
}

// Pulls a renderable table out of any audit's details, following the one level
// of nesting Lighthouse uses for `list`/`checklist` insight details.
function extractTable(details, depth = 0) {
  if (!details || depth > 2) return null;
  if ((details.type === 'table' || details.type === 'opportunity') && Array.isArray(details.headings) && details.headings.length) {
    const headings = details.headings.filter((h) => h.key || h.label);
    const rows = (details.items || []).slice(0, 12).map((item) => headings.map((h) => ({
      text: cellText(item[h.key], h.valueType),
      numeric: ['bytes', 'ms', 'timespanMs', 'numeric'].includes(h.valueType),
    })));
    if (!rows.length) return null;
    return {
      headings: headings.map((h) => ({
        label: h.label || h.key,
        numeric: ['bytes', 'ms', 'timespanMs', 'numeric'].includes(h.valueType),
      })),
      rows,
      truncated: Math.max(0, (details.items || []).length - 12),
    };
  }
  if (details.type === 'list' || details.type === 'checklist') {
    // `list` items are an array of nested details; `checklist` items are an
    // object keyed by check name.
    const kids = Array.isArray(details.items) ? details.items : Object.values(details.items || {});
    for (const kid of kids) {
      const t = extractTable(kid, depth + 1);
      if (t) return t;
    }
  }
  return null;
}

// A checklist detail (used by several insights, e.g. LCP request discovery) is
// a set of pass/fail claims, which reads better as its own list than squeezed
// into a table. It is usually nested one level inside a `list`.
function extractChecklist(details, depth = 0) {
  if (!details || depth > 2) return null;
  if (details.type === 'checklist' && details.items && !Array.isArray(details.items)) {
    const out = Object.values(details.items)
      .map((v) => ({ label: v.label, pass: Boolean(v.value) }))
      .filter((x) => x.label);
    return out.length ? out : null;
  }
  if (details.type === 'list' && Array.isArray(details.items)) {
    for (const kid of details.items) {
      const found = extractChecklist(kid, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// The element Lighthouse identified (LCP element, layout-shift culprit, …).
function extractNode(details, depth = 0) {
  if (!details || depth > 2) return null;
  if (details.type === 'node') return details.nodeLabel || details.selector || details.snippet || null;
  const kids = Array.isArray(details.items) ? details.items : [];
  for (const kid of kids) {
    const found = extractNode(kid, depth + 1);
    if (found) return found;
  }
  return null;
}

// The network dependency tree is a nested chain object rather than a table.
// Flattening it to "longest chain + the requests in it" keeps the one fact
// that matters — what is serialising the critical path.
function extractNetworkTree(details, depth = 0) {
  if (!details || depth > 2) return null;
  if (details.type === 'network-tree' || (details.value && details.value.type === 'network-tree')) {
    const tree = details.type === 'network-tree' ? details : details.value;
    const rows = [];
    const walk = (nodes) => {
      Object.values(nodes || {}).forEach((n) => {
        if (n.url) {
          rows.push({
            url: n.url,
            size: n.transferSize ? kib(n.transferSize) : '',
            time: n.navStartToEndTime != null ? ms(n.navStartToEndTime) : '',
          });
        }
        if (n.children) walk(n.children);
      });
    };
    walk(tree.chains);
    rows.sort((a, b) => (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0));
    return {
      longest: tree.longestChain && tree.longestChain.duration != null ? ms(tree.longestChain.duration) : null,
      rows: rows.slice(0, 12),
      truncated: Math.max(0, rows.length - 12),
    };
  }
  const kids = Array.isArray(details.items) ? details.items : [];
  for (const kid of kids) {
    const found = extractNetworkTree(kid, depth + 1);
    if (found) return found;
  }
  return null;
}

function auditView(audit) {
  const details = audit.details || {};
  const savingsMs = details.overallSavingsMs != null ? details.overallSavingsMs
    : (audit.metricSavings ? Math.max(0, ...Object.values(audit.metricSavings).map((v) => Number(v) || 0)) : null);
  const savingsBytes = details.overallSavingsBytes != null ? details.overallSavingsBytes : null;
  return {
    id: audit.id,
    title: audit.title,
    description: audit.description,
    score: audit.score,
    band: band(audit.score),
    scoreDisplayMode: audit.scoreDisplayMode,
    displayValue: audit.displayValue || null,
    savingsMs: savingsMs || null,
    savingsBytes: savingsBytes || null,
    savingsLabel: savingsBytes ? `Est savings of ${kib(savingsBytes)}`
      : (savingsMs ? `Est savings of ${Math.round(savingsMs)} ms` : null),
    table: extractTable(details),
    checklist: extractChecklist(details),
    node: extractNode(details),
    networkTree: extractNetworkTree(details),
  };
}

// ------------------------------------------------------------ field data
const FIELD_METRICS = [
  { key: 'LARGEST_CONTENTFUL_PAINT_MS', label: 'Largest Contentful Paint (LCP)', unit: 's', good: 2500, poor: 4000 },
  { key: 'INTERACTION_TO_NEXT_PAINT', label: 'Interaction to Next Paint (INP)', unit: 'ms', good: 200, poor: 500 },
  { key: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', label: 'Cumulative Layout Shift (CLS)', unit: 'cls', good: 0.1, poor: 0.25 },
  { key: 'FIRST_CONTENTFUL_PAINT_MS', label: 'First Contentful Paint (FCP)', unit: 's', good: 1800, poor: 3000 },
  { key: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', label: 'Time to First Byte (TTFB)', unit: 'ms', good: 800, poor: 1800 },
];

function fieldValue(percentile, unit) {
  if (percentile == null) return '—';
  if (unit === 's') return `${(percentile / 1000).toFixed(1)} s`;
  if (unit === 'cls') return (percentile / 100).toFixed(2);
  return `${Math.round(percentile)} ms`;
}

// CrUX buckets come back as three proportions (good / needs improvement /
// poor). PSI draws them as a stacked bar, which is the honest way to show a
// distribution — a single p75 number hides how split the population is.
function fieldSection(experience) {
  if (!experience || !experience.metrics) return { available: false };
  const metrics = FIELD_METRICS
    .filter((m) => experience.metrics[m.key])
    .map((m) => {
      const raw = experience.metrics[m.key];
      const dist = (raw.distributions || []).map((d) => Math.round((d.proportion || 0) * 1000) / 10);
      return {
        key: m.key,
        label: m.label,
        value: fieldValue(raw.percentile, m.unit),
        category: raw.category || null,
        band: raw.category === 'FAST' ? 'good' : (raw.category === 'AVERAGE' ? 'average' : 'poor'),
        good: dist[0] || 0,
        needsImprovement: dist[1] || 0,
        poor: dist[2] || 0,
      };
    });
  return {
    available: metrics.length > 0,
    overall: experience.overall_category || null,
    metrics,
  };
}

// ------------------------------------------------------------- normalise
function normalise(raw) {
  const lr = raw.lighthouseResult || {};
  const audits = lr.audits || {};
  const cats = lr.categories || {};
  const perfRefs = (cats.performance && cats.performance.auditRefs) || [];

  const metrics = perfRefs
    .filter((r) => r.group === 'metrics' && audits[r.id])
    .map((r) => ({
      id: r.id,
      acronym: r.acronym || '',
      title: audits[r.id].title,
      displayValue: audits[r.id].displayValue || '—',
      score: audits[r.id].score,
      band: band(audits[r.id].score),
    }));

  // Lighthouse 13 groups the actionable performance findings under `insights`
  // and keeps the older per-resource audits under `diagnostics`. PSI shows the
  // failing ones first, ordered by how much they cost.
  const collect = (group) => perfRefs
    .filter((r) => r.group === group && audits[r.id] && audits[r.id].scoreDisplayMode !== 'notApplicable')
    .map((r) => auditView(audits[r.id]));

  const rank = (a) => (a.savingsMs || 0) + (a.savingsBytes ? a.savingsBytes / 1024 : 0);
  const failing = (list) => list
    .filter((a) => a.score !== null && a.score < 0.9)
    .sort((a, b) => (a.score - b.score) || (rank(b) - rank(a)));
  const informative = (list) => list.filter((a) => a.score === null && a.scoreDisplayMode === 'informative');
  const passed = (list) => list.filter((a) => a.score !== null && a.score >= 0.9);

  const insightAudits = collect('insights');
  const diagnosticAudits = collect('diagnostics');

  const otherCategories = ['accessibility', 'best-practices', 'seo']
    .filter((id) => cats[id])
    .map((id) => {
      const list = (cats[id].auditRefs || [])
        .filter((r) => audits[r.id] && audits[r.id].scoreDisplayMode !== 'notApplicable' && audits[r.id].scoreDisplayMode !== 'manual')
        .map((r) => auditView(audits[r.id]));
      return {
        id,
        title: cats[id].title,
        score: cats[id].score,
        band: band(cats[id].score),
        failing: list.filter((a) => a.score !== null && a.score < 0.9).sort((a, b) => a.score - b.score),
        passedCount: list.filter((a) => a.score !== null && a.score >= 0.9).length,
      };
    });

  const filmstrip = ((audits['screenshot-thumbnails'] || {}).details || {}).items || [];
  const finalShot = (((audits['final-screenshot'] || {}).details || {}).data) || null;
  const cfg = lr.configSettings || {};
  const env = lr.environment || {};

  return {
    requestedUrl: lr.requestedUrl || raw.id || null,
    finalUrl: lr.finalDisplayedUrl || lr.finalUrl || null,
    strategy: cfg.formFactor || 'mobile',
    fetchTime: lr.fetchTime || null,
    lighthouseVersion: lr.lighthouseVersion || null,
    userAgent: env.hostUserAgent || null,
    // PSI runs through the Lighthouse-as-a-service channel, which strips the
    // throttling block from configSettings — so the label is derived from the
    // form factor, matching what pagespeed.web.dev prints for each: mobile is
    // throttled to Slow 4G, desktop to its own custom profile.
    throttling: cfg.throttlingMethod === 'provided'
      ? 'No throttling'
      : (cfg.formFactor === 'desktop' ? 'Custom throttling' : 'Slow 4G throttling'),
    emulated: cfg.formFactor === 'desktop' ? 'Emulated Desktop' : 'Emulated Moto G Power',
    benchmarkIndex: env.benchmarkIndex || null,

    categories: ['performance', 'accessibility', 'best-practices', 'seo']
      .filter((id) => cats[id])
      .map((id) => ({
        id,
        title: cats[id].title,
        score: cats[id].score == null ? null : Math.round(cats[id].score * 100),
        band: band(cats[id].score),
      })),

    field: fieldSection(raw.loadingExperience),
    originField: fieldSection(raw.originLoadingExperience),

    metrics,
    insights: failing(insightAudits),
    insightsInformative: informative(insightAudits),
    diagnostics: failing(diagnosticAudits),
    passed: [...passed(insightAudits), ...passed(diagnosticAudits)],
    otherCategories,

    filmstrip: filmstrip.map((f) => ({ timing: f.timing, data: f.data })),
    finalScreenshot: finalShot,
  };
}

module.exports = { fetchReport, normalise, CATEGORIES, band, kib, ms };
