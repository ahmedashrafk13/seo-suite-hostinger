// THE SEO TRACKING CATALOG
//
// Every element on the tracking specification, declared once, as a check that
// can be run on a schedule and whose result is a metric with a verdict.
//
// Each entry declares:
//   key         stable id; also the metric_key prefix in aiseo_metrics
//   element     the name from the tracking specification
//   group       board section
//   whatItTracks / whyItMatters   the two columns from the specification,
//                                 rendered in the UI so the board explains
//                                 itself rather than needing a separate doc
//   needs       capabilities that must be available (see ./providers.js)
//   scope       'site' or 'page' — a page-scoped check runs over a sample
//   run(ctx)    => { metrics: [], findings: [], detail: {} }
//
// WHY EVERY CHECK REPORTS A VERDICT AND A VALUE
// A tracking board that shows only current values cannot answer the question
// people actually ask it, which is "did something break". Every check returns
// both a number and a status, and the store keeps the series — so the board
// can show the value, the verdict, and the direction, and the alert engine has
// something to fire on.
//
// WHAT A CHECK MUST NEVER DO
// Return 'good' when it could not measure. A check with no data returns
// 'unknown' with the reason, and the board renders that distinctly. Collapsing
// "measured and fine" into the same colour as "could not measure" is how a
// monitoring system reports green through an outage.
const db = require('../../db');
const nlp = require('./nlp');
const providers = require('./providers');
const analytics = require('../analytics');
const { THRESHOLDS } = require('./readiness');
const {
  fetchPage, parseDocument, fetchRobots, robotsAllows, fetchSitemapUrls,
  fetchLlmsTxt, measureTtfb, inspectCertificate, canonUrl, crawlSite, sameSite,
  RETRIEVAL_AGENTS, mapLimit,
} = require('./fetcher');

const CATALOG = [];
function define(entry) { CATALOG.push(entry); return entry; }

const GROUP_ORDER = [
  'Crawlability & indexation',
  'Performance & Core Web Vitals',
  'Security',
  'URL & canonical health',
  'On-page elements',
  'Content quality',
  'Internal linking',
  'Images',
  'Structured data',
  'Rendering',
  'AI retrieval',
];

// Verdict helper shared by every threshold-based check.
const bandOf = (value, good, poor, { lowerIsBetter = true } = {}) => {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (lowerIsBetter) return value <= good ? 'good' : (value <= poor ? 'warn' : 'fail');
  return value >= good ? 'good' : (value >= poor ? 'warn' : 'fail');
};

// =========================================================================
// CRAWLABILITY & INDEXATION
// =========================================================================

define({
  key: 'crawl_errors',
  element: 'Crawlability & indexation — crawl errors',
  group: 'Crawlability & indexation',
  whatItTracks: '4xx and 5xx responses across the sampled URL set',
  whyItMatters: 'A page returning an error cannot be indexed, and internal links pointing at it waste the crawl budget spent reaching them.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000, method: 'GET' });
      return { url, status: res.status, ok: res.ok, error: res.error, redirects: res.redirectChain.length };
    });
    const checked = results.filter((r) => r && !r.__error);
    const client = checked.filter((r) => r.status >= 400 && r.status < 500);
    const server = checked.filter((r) => r.status >= 500);
    const dead = checked.filter((r) => r.status == null && r.error);

    const findings = [];
    if (server.length) {
      findings.push({
        checkKey: 'crawl_5xx',
        title: `${server.length} URL${server.length === 1 ? '' : 's'} returned a server error`,
        detail: server.slice(0, 8).map((r) => `${r.url} → ${r.status}`).join('; '),
        severity: 'critical',
        affectedCount: server.length,
        affectedUrl: server[0].url,
        action: 'Server errors on indexable URLs cause Google to slow its crawl of the whole site, not just those pages. Fix first.',
        evidence: { urls: server },
      });
    }
    if (client.length) {
      findings.push({
        checkKey: 'crawl_4xx',
        title: `${client.length} URL${client.length === 1 ? '' : 's'} returned a client error`,
        detail: client.slice(0, 8).map((r) => `${r.url} → ${r.status}`).join('; '),
        severity: 'high',
        affectedCount: client.length,
        affectedUrl: client[0].url,
        action: 'Redirect the ones that moved, and remove or fix the internal links pointing at the ones that did not.',
        evidence: { urls: client },
      });
    }
    if (dead.length) {
      findings.push({
        checkKey: 'crawl_unreachable',
        title: `${dead.length} URL${dead.length === 1 ? '' : 's'} could not be reached at all`,
        detail: dead.slice(0, 8).map((r) => `${r.url} → ${r.error}`).join('; '),
        severity: 'high',
        affectedCount: dead.length,
        affectedUrl: dead[0].url,
        action: 'DNS, connection or TLS failures. Check from a second network before treating it as a site problem.',
        evidence: { urls: dead },
      });
    }

    const errorCount = client.length + server.length + dead.length;
    return {
      metrics: [
        { key: 'track.crawl_errors', value: errorCount, status: errorCount === 0 ? 'good' : (errorCount <= 2 ? 'warn' : 'fail'), detail: `${checked.length} sampled` },
      ],
      findings,
      detail: { sampled: checked.length, client: client.length, server: server.length, unreachable: dead.length, results: checked },
    };
  },
});

// =========================================================================
// THE SITEWIDE 4xx / BROKEN-PAGE CHECK
//
// WHY IT IS SEPARATE FROM crawl_errors ABOVE
// crawl_errors checks the 12-URL sample. That answers "does this site have
// broken pages" and it CANNOT answer "which pages are broken", which is the
// question anyone actually has. A 4,000-page site with 60 dead product URLs
// shows a clean sample almost every time.
//
// So this check takes the full URL set in sitewide scope and adds the one thing
// a sitemap cannot supply: the TARGETS OF INTERNAL LINKS. Those are where dead
// URLs actually live — a page deleted from the CMS leaves the sitemap
// immediately and leaves the links pointing at it for years. A 404 nothing
// links to costs nothing; a 404 with eleven internal links pointing at it wastes
// crawl budget on every sweep and hands a reader a dead end.
//
// WHAT IS REPORTED, AND WHY EACH DISTINCTION MATTERS
//   4xx with inbound internal links   the actionable list, ordered by link count
//   4xx with no inbound links         usually a stale sitemap entry
//   5xx                               separated because Google responds to
//                                     server errors by slowing its crawl of the
//                                     WHOLE site, not just those URLs
//   soft 404                          HTTP 200 with "page not found" in the
//                                     content: invisible to a status check and
//                                     the most damaging of the four, because
//                                     the page gets indexed
//   unreachable                       DNS/TLS/timeout, which is a different
//                                     problem from a 404 and must not be
//                                     counted as one
define({
  key: 'broken_pages',
  element: 'Crawlability & indexation — 4xx and 5xx pages, sitewide',
  group: 'Crawlability & indexation',
  whatItTracks: 'Every URL in the sitemap, every page with Search Console traffic, and every internal link target — checked for 4xx, 5xx, soft 404s and unreachable responses, with the internal links pointing at each one',
  whyItMatters: 'A sample tells you a site has broken pages. This tells you which ones, and which of them are linked from elsewhere on the site — the difference between a list you can act on and a number you cannot.',
  needs: ['crawler'],
  scope: 'site',
  // Receives ctx.allUrls in sitewide scope; falls back to the sample otherwise.
  sitewideCapable: true,
  async run(ctx) {
    const sitewide = ctx.scope === 'sitewide' && Array.isArray(ctx.allUrls) && ctx.allUrls.length;
    const seen = new Set();
    const targets = [];
    const push = (url, from) => {
      if (!url) return;
      const key = canonUrl(url);
      if (seen.has(key)) {
        const existing = targets.find((t) => canonUrl(t.url) === key);
        if (existing && !existing.from.includes(from)) existing.from.push(from);
        return;
      }
      seen.add(key);
      targets.push({ url, from: [from] });
    };

    if (sitewide) ctx.allUrls.forEach((u) => push(u.url, u.from));
    else ctx.sample.forEach((u) => push(u, 'sample'));

    // Internal link targets. Only gathered in sitewide scope — a link crawl is
    // the expensive half of this check, and in sampled scope crawl_errors has
    // already covered the same ground more cheaply.
    const inboundLinks = new Map(); // canonical target -> [{ from, anchor }]
    let crawl = null;
    if (sitewide) {
      crawl = await crawlSite(ctx.site, { maxPages: 150, concurrency: 4 });
      crawl.pages.filter((p) => p.ok && p.doc).forEach((p) => {
        (p.doc.links || []).filter((l) => l.internal).forEach((l) => {
          if (!sameSite(ctx.site, l.url)) return;
          const key = canonUrl(l.url);
          if (!inboundLinks.has(key)) inboundLinks.set(key, []);
          const list = inboundLinks.get(key);
          if (list.length < 12) list.push({ from: p.url, anchor: (l.anchor || '').slice(0, 90), inMain: l.inMain });
          push(l.url, 'internal link');
        });
      });
    }

    if (!targets.length) return { unknown: 'no URLs to check' };

    // Capped, and the cap is reported rather than applied silently.
    const CAP = sitewide ? 1200 : 40;
    const capped = targets.slice(0, CAP);

    const results = await mapLimit(capped, 5, async (t) => {
      const res = await fetchPage(t.url, { timeout: 15000 });
      let soft404 = false;
      if (res.ok && res.body) {
        // A soft 404 is a 200 whose content says otherwise. Matched on the
        // TITLE and the H1 only — the phrase appearing somewhere in a footer or
        // a help article is not a soft 404, and matching the whole body would
        // flag every page with a "404 page" link in its sitemap.
        const doc = parseDocument(res.url, res.body);
        const headline = `${doc.title || ''} ${(doc.h1s || []).join(' ')}`.toLowerCase();
        soft404 = /\b(404|not found|page (?:not|cannot be) found|page does(?:n'?t| not) exist|no longer (?:available|exists)|gone missing|nothing here)\b/.test(headline);
      }
      return {
        url: t.url,
        from: t.from,
        status: res.status,
        ok: res.ok,
        error: res.error,
        finalUrl: res.url,
        redirects: res.redirectChain.length,
        soft404,
        inbound: inboundLinks.get(canonUrl(t.url)) || [],
      };
    });

    const rows = results.filter((r) => r && !r.__error);
    const client = rows.filter((r) => r.status >= 400 && r.status < 500);
    const server = rows.filter((r) => r.status >= 500);
    const soft = rows.filter((r) => r.soft404);
    const dead = rows.filter((r) => r.status == null && r.error);

    const withInbound = (list) => list.filter((r) => r.inbound.length)
      .sort((a, b) => b.inbound.length - a.inbound.length);
    const clientLinked = withInbound(client);
    const softLinked = withInbound(soft);

    const findings = [];

    if (server.length) {
      findings.push({
        checkKey: 'pages_5xx',
        title: `${server.length} URL${server.length === 1 ? '' : 's'} return a server error`,
        detail: server.slice(0, 10).map((r) => `${r.url} → ${r.status}`).join('; ')
          + '. Google responds to server errors by slowing its crawl of the whole site, not just the failing URLs, so these cost more than the pages themselves.',
        severity: 'critical',
        affectedCount: server.length,
        affectedUrl: server[0].url,
        action: 'Fix these before anything else on this report. A 5xx is an availability problem, not an SEO one.',
        evidence: { urls: server.slice(0, 100).map((r) => ({ url: r.url, status: r.status, from: r.from, inboundLinks: r.inbound.length })) },
      });
    }

    if (client.length) {
      findings.push({
        checkKey: 'pages_4xx',
        title: `${client.length} URL${client.length === 1 ? '' : 's'} return a client error (4xx)`,
        detail: `${clientLinked.length ? `${clientLinked.length} of them are linked from elsewhere on the site: ${clientLinked.slice(0, 6).map((r) => `${r.url} (${r.inbound.length} inbound link${r.inbound.length === 1 ? '' : 's'}, e.g. from ${r.inbound[0].from})`).join('; ')}. ` : ''}`
          + `${client.length - clientLinked.length} have no internal links pointing at them and are usually stale sitemap entries: ${client.filter((r) => !r.inbound.length).slice(0, 5).map((r) => `${r.url} (from ${r.from.join(', ')})`).join('; ')}.`,
        severity: clientLinked.length ? 'high' : 'medium',
        affectedCount: client.length,
        affectedUrl: (clientLinked[0] || client[0]).url,
        action: 'Split the work: URLs with inbound links need either a 301 to the right page or the links fixed — both, ideally. URLs with no inbound links need removing from the sitemap. Redirecting everything to the homepage is the wrong answer and Google treats it as a soft 404.',
        evidence: {
          linked: clientLinked.slice(0, 60).map((r) => ({ url: r.url, status: r.status, inbound: r.inbound, from: r.from })),
          unlinked: client.filter((r) => !r.inbound.length).slice(0, 60).map((r) => ({ url: r.url, status: r.status, from: r.from })),
        },
      });
    }

    if (soft.length) {
      findings.push({
        checkKey: 'soft_404',
        title: `${soft.length} URL${soft.length === 1 ? '' : 's'} return HTTP 200 with "not found" content`,
        detail: soft.slice(0, 8).map((r) => `${r.url}`).join('; ')
          + '. A soft 404 is the most damaging of the four kinds on this list: the status code says the page is fine, so it gets crawled and indexed, and a status-code check never sees it. Detected here from the page title and H1 rather than the whole body, so a footer link to a 404 page does not trigger it.',
        severity: 'high',
        affectedCount: soft.length,
        affectedUrl: soft[0].url,
        action: 'Return a real 404 or 410 status for these. If they are meant to exist, the content is broken rather than the status.',
        evidence: { urls: soft.slice(0, 60).map((r) => ({ url: r.url, status: r.status, inboundLinks: r.inbound.length, from: r.from })) },
      });
    }

    if (dead.length) {
      findings.push({
        checkKey: 'pages_unreachable',
        title: `${dead.length} URL${dead.length === 1 ? '' : 's'} could not be reached at all`,
        detail: dead.slice(0, 8).map((r) => `${r.url} → ${r.error}`).join('; ')
          + '. DNS, connection or TLS failures. Reported separately from 4xx because the cause and the fix are different.',
        severity: 'high',
        affectedCount: dead.length,
        affectedUrl: dead[0].url,
        action: 'Check from a second network before treating this as a site problem — an intermittent failure from one location is usually a rate limit rather than an outage.',
        evidence: { urls: dead.slice(0, 60).map((r) => ({ url: r.url, error: r.error, from: r.from })) },
      });
    }

    const broken = client.length + server.length + soft.length + dead.length;
    return {
      metrics: [
        {
          key: 'track.pages_4xx',
          value: client.length,
          status: client.length === 0 ? 'good' : (clientLinked.length ? 'fail' : 'warn'),
          detail: `${rows.length} URLs checked (${sitewide ? 'sitewide' : 'sample'})`,
        },
        {
          key: 'track.pages_5xx',
          value: server.length,
          status: server.length ? 'fail' : 'good',
          detail: `${rows.length} URLs checked`,
        },
        {
          key: 'track.soft_404',
          value: soft.length,
          status: soft.length ? 'fail' : 'good',
          detail: 'HTTP 200 with not-found content in the title or H1',
        },
        {
          key: 'track.broken_with_inbound_links',
          value: clientLinked.length + softLinked.length,
          status: (clientLinked.length + softLinked.length) ? 'fail' : 'good',
          detail: sitewide ? 'broken URLs that other pages link to' : 'not measured in sampled scope — internal link targets are only gathered sitewide',
        },
      ],
      findings,
      detail: {
        scope: sitewide ? 'sitewide' : 'sample',
        urlsConsidered: targets.length,
        urlsChecked: rows.length,
        cap: CAP,
        truncated: targets.length > CAP,
        truncationNote: targets.length > CAP
          ? `${targets.length - CAP} URL${targets.length - CAP === 1 ? '' : 's'} were NOT checked — the cap is ${CAP} per sweep. Raise the sitewide cap or re-run to cover the remainder; this is stated rather than left as a silent truncation.`
          : null,
        crawl: crawl ? { fetched: crawl.fetched, discovered: crawl.discovered, complete: crawl.complete } : null,
        counts: { broken, client: client.length, server: server.length, soft404: soft.length, unreachable: dead.length, clean: rows.length - broken },
        rows: rows.filter((r) => !r.ok || r.soft404).slice(0, 200),
        internalLinkTargetsResolved: inboundLinks.size,
      },
    };
  },
});

define({
  key: 'robots_changes',
  element: 'Crawlability & indexation — robots.txt changes',
  group: 'Crawlability & indexation',
  whatItTracks: 'The content of robots.txt, compared against the last capture',
  whyItMatters: 'A single accidental Disallow line can deindex a whole site, and nothing on the site itself looks different afterwards.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const robots = await fetchRobots(ctx.site);
    if (!robots.ok && !robots.present) {
      return {
        metrics: [{ key: 'track.robots_present', value: 0, status: 'warn', detail: `HTTP ${robots.status || 'error'}` }],
        findings: [],
        detail: { present: false, status: robots.status, error: robots.error },
      };
    }
    const body = String(robots.body || '');
    // A content hash rather than the whole file: the series answers "did it
    // change", and storing the file in a metrics row would be the wrong place
    // for it. The current body is kept in the run payload for the diff.
    const hash = require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 16);
    const prev = ctx.previousMetric('track.robots_hash');
    // Metric values are numeric, so the hash is carried in `detail` and the
    // numeric value is the byte length — which is itself a usable series.
    const changed = Boolean(prev && prev.detail && prev.detail !== hash);

    const findings = [];
    if (changed) {
      const blanketDisallow = robots.parsed.groups.some((g) => g.agents.includes('*') && g.disallow.includes('/'));
      findings.push({
        checkKey: 'robots_changed',
        title: 'robots.txt has changed since the last check',
        detail: `Previous fingerprint ${prev.detail}, now ${hash}.${blanketDisallow ? ' It now contains "Disallow: /" for all user agents, which blocks the entire site.' : ''}`,
        severity: blanketDisallow ? 'critical' : 'high',
        affectedUrl: robots.url,
        action: 'Confirm the change was intended. Compare against the previous capture below before doing anything else.',
        evidence: { previousHash: prev.detail, currentHash: hash, body: body.slice(0, 4000) },
      });
    }

    const blocked = RETRIEVAL_AGENTS.filter((a) => !robotsAllows(robots.parsed, a.token, '/').allowed);
    if (blocked.length) {
      findings.push({
        checkKey: 'robots_blocks_retrieval',
        title: `robots.txt blocks ${blocked.length} AI retrieval fetcher${blocked.length === 1 ? '' : 's'} from the site root`,
        detail: blocked.map((a) => a.label).join(', ') + '. These fetch pages in order to cite them in an answer.',
        severity: 'high',
        affectedUrl: robots.url,
        action: 'Remove the rules for the retrieval agents. Rules for training crawlers can stay if they were deliberate.',
        evidence: { blocked: blocked.map((a) => ({ key: a.key, label: a.label })) },
      });
    }

    return {
      metrics: [
        { key: 'track.robots_present', value: 1, status: 'good' },
        { key: 'track.robots_hash', value: body.length, status: changed ? 'warn' : 'good', detail: hash },
        { key: 'track.robots_sitemaps', value: robots.parsed.sitemaps.length, status: robots.parsed.sitemaps.length ? 'good' : 'warn' },
      ],
      findings,
      detail: { present: true, hash, changed, sitemaps: robots.parsed.sitemaps, groups: robots.parsed.groups, body: body.slice(0, 4000) },
    };
  },
});

define({
  key: 'sitemap_health',
  element: 'Crawlability & indexation — sitemap health',
  group: 'Crawlability & indexation',
  whatItTracks: 'Sitemap reachability, URL count, and the errors Search Console reports against each submitted sitemap',
  whyItMatters: 'A sitemap listing redirects, 404s or non-canonical URLs teaches Google to distrust it, which slows discovery of everything in it.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const robots = await fetchRobots(ctx.site);
    const sitemap = await fetchSitemapUrls(ctx.site, { limit: 3000, robots });
    const gscSitemaps = db.prepare('SELECT * FROM gsc_sitemaps WHERE brand_id=?').all(ctx.brandId);

    const findings = [];
    if (!sitemap.urls.length) {
      findings.push({
        checkKey: 'sitemap_missing',
        title: 'No usable sitemap',
        detail: sitemap.sources.length
          ? sitemap.sources.map((s) => `${s.url}: ${s.ok ? `${s.urls} URLs` : s.error || `HTTP ${s.status}`}`).join('; ')
          : 'Neither robots.txt nor the conventional paths returned a sitemap.',
        severity: 'high',
        affectedUrl: `${ctx.origin}/sitemap.xml`,
        action: 'Publish an XML sitemap and declare it in robots.txt.',
        evidence: { tried: sitemap.sources },
      });
    }

    const withErrors = gscSitemaps.filter((s) => (Number(s.errors) || 0) > 0);
    if (withErrors.length) {
      findings.push({
        checkKey: 'sitemap_errors',
        title: `Search Console reports errors on ${withErrors.length} sitemap${withErrors.length === 1 ? '' : 's'}`,
        detail: withErrors.map((s) => `${s.path}: ${s.errors} error${s.errors === 1 ? '' : 's'}, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`).join('; '),
        severity: 'high',
        action: 'Open each in Search Console — the error detail names the specific URLs.',
        evidence: { sitemaps: withErrors },
      });
    }

    const stale = gscSitemaps.filter((s) => {
      if (!s.last_downloaded) return false;
      const t = Date.parse(s.last_downloaded);
      return Number.isFinite(t) && (Date.now() - t) > 30 * 86400000;
    });
    if (stale.length) {
      findings.push({
        checkKey: 'sitemap_stale',
        title: `${stale.length} sitemap${stale.length === 1 ? ' has' : 's have'} not been fetched by Google in over 30 days`,
        detail: stale.map((s) => `${s.path} (last fetched ${String(s.last_downloaded).slice(0, 10)})`).join('; '),
        severity: 'medium',
        action: 'Usually means Google has stopped trusting it, or it has not changed. Confirm the lastmod dates are real, then resubmit.',
        evidence: { sitemaps: stale },
      });
    }

    return {
      metrics: [
        { key: 'track.sitemap_urls', value: sitemap.urls.length, status: sitemap.urls.length ? 'good' : 'fail' },
        { key: 'track.sitemap_errors', value: gscSitemaps.reduce((a, s) => a + (Number(s.errors) || 0), 0), status: withErrors.length ? 'fail' : 'good' },
      ],
      findings,
      detail: { urls: sitemap.urls.length, sources: sitemap.sources, searchConsole: gscSitemaps },
    };
  },
});

define({
  key: 'index_coverage',
  element: 'Crawlability & indexation — index coverage drift',
  group: 'Crawlability & indexation',
  whatItTracks: 'The share of inspected URLs Search Console says are indexed, and how that share has moved',
  whyItMatters: 'Coverage falling is the earliest possible warning of a technical problem, and it usually moves weeks before traffic does.',
  needs: ['gsc'],
  scope: 'site',
  async run(ctx) {
    const summary = analytics.indexingSummary(ctx.brandId);
    if (!summary || !summary.totals || !summary.totals.total) {
      return { unknown: 'no URL Inspection results stored yet — these are collected by the nightly sync' };
    }
    const t = summary.totals;
    const share = t.total ? Math.round((t.indexed / t.total) * 100) : null;
    const prev = ctx.previousMetric('track.indexed_share');
    const drift = (prev && prev.value != null && share != null) ? Math.round((share - prev.value) * 10) / 10 : null;

    const findings = [];
    if (share != null && share < 70) {
      findings.push({
        checkKey: 'low_index_coverage',
        title: `Only ${share}% of inspected URLs are indexed`,
        detail: `${t.indexed} of ${t.total} inspected URLs pass. Reasons reported: ${(summary.rows || []).slice(0, 5).map((r) => `${r.reason} (${r.pages})`).join('; ')}.`,
        severity: share < 50 ? 'high' : 'medium',
        action: 'Group by the coverage reason and work the largest group. A single templating problem usually accounts for most of a low coverage figure.',
        evidence: { summary },
      });
    }
    if (drift != null && drift <= -10) {
      findings.push({
        checkKey: 'index_coverage_drop',
        title: `Indexed share has fallen ${Math.abs(drift)} percentage points since the last check`,
        detail: `Was ${prev.value}%, now ${share}%.`,
        severity: 'high',
        action: 'Check robots.txt, canonical tags and the noindex header first — a coverage fall of this size is nearly always a directive change rather than a quality judgement.',
        evidence: { previous: prev, current: share, summary },
      });
    }

    return {
      metrics: [
        { key: 'track.indexed_share', value: share, status: bandOf(share, 90, 70, { lowerIsBetter: false }) },
        { key: 'track.indexed_pages', value: t.indexed, status: 'good' },
        { key: 'track.not_indexed_pages', value: t.notIndexed, status: t.notIndexed ? 'warn' : 'good' },
      ],
      findings,
      detail: { summary, drift, previous: prev },
    };
  },
});

// =========================================================================
// PERFORMANCE & CORE WEB VITALS
// =========================================================================

define({
  key: 'core_web_vitals',
  element: 'Core Web Vitals',
  group: 'Performance & Core Web Vitals',
  whatItTracks: 'LCP, INP and CLS at the 75th percentile from real Chrome users (CrUX), via the PageSpeed Insights API',
  whyItMatters: 'A confirmed ranking factor, and the only performance numbers Google itself acts on.',
  needs: ['psi'],
  scope: 'site',
  async run(ctx) {
    const psi = require('../psi');
    let raw;
    try {
      raw = await psi.fetchReport(ctx.userId, { url: ctx.site, strategy: 'mobile' });
    } catch (err) {
      return { unknown: `PageSpeed Insights failed: ${String(err.message).slice(0, 200)}` };
    }
    const data = raw.data || {};
    const le = (data.loadingExperience && data.loadingExperience.metrics)
      ? { metrics: data.loadingExperience.metrics, scope: 'url' }
      : ((data.originLoadingExperience && data.originLoadingExperience.metrics)
        ? { metrics: data.originLoadingExperience.metrics, scope: 'origin' }
        : null);
    if (!le) return { unknown: 'CrUX has no field data for this URL or origin — the site has too little Chrome traffic' };

    const spec = [
      { crux: 'LARGEST_CONTENTFUL_PAINT_MS', metric: 'track.lcp_ms', label: 'LCP', scale: 1, good: THRESHOLDS.lcpMs.googleGood, poor: THRESHOLDS.lcpMs.googleNeedsWork, brief: THRESHOLDS.lcpMs.target, unit: 'ms' },
      { crux: 'INTERACTION_TO_NEXT_PAINT', metric: 'track.inp_ms', label: 'INP', scale: 1, good: THRESHOLDS.inpMs.googleGood, poor: THRESHOLDS.inpMs.googleNeedsWork, brief: THRESHOLDS.inpMs.target, unit: 'ms' },
      { crux: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', metric: 'track.cls', label: 'CLS', scale: 0.01, good: THRESHOLDS.cls.googleGood, poor: THRESHOLDS.cls.googleNeedsWork, brief: THRESHOLDS.cls.target, unit: '' },
      { crux: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', metric: 'track.field_ttfb_ms', label: 'Field TTFB', scale: 1, good: THRESHOLDS.ttfbMs.googleGood, poor: THRESHOLDS.ttfbMs.googleNeedsWork, brief: THRESHOLDS.ttfbMs.target, unit: 'ms' },
    ];

    const metrics = [];
    const findings = [];
    const readings = [];
    spec.forEach((s) => {
      const m = le.metrics[s.crux];
      if (!m || m.percentile == null) return;
      const value = Math.round(m.percentile * s.scale * 1000) / 1000;
      const status = bandOf(value, s.good, s.poor);
      metrics.push({ key: s.metric, value, status, detail: le.scope });
      readings.push({ label: s.label, value, status, scope: le.scope, googleGood: s.good, projectTarget: s.brief });
      if (status !== 'good') {
        findings.push({
          checkKey: `cwv_${s.label.toLowerCase().replace(/\s+/g, '_')}`,
          title: `${s.label} is ${s.unit === 'ms' ? `${Math.round(value)}ms` : value.toFixed(3)} at the 75th percentile`,
          detail: `${le.scope === 'origin' ? 'Origin-wide figure — this URL has too little traffic for its own CrUX record. ' : ''}Google's "good" boundary is ${s.unit === 'ms' ? `${s.good}ms` : s.good}; this project targets ${s.unit === 'ms' ? `${s.brief}ms` : s.brief}.`,
          severity: status === 'fail' ? 'high' : 'medium',
          affectedUrl: ctx.site,
          action: 'Open the PageSpeed report for this URL — its opportunity list names the causes.',
          evidence: { value, status, scope: le.scope },
        });
      }
    });

    return { metrics, findings, detail: { scope: le.scope, readings, overall: data.loadingExperience && data.loadingExperience.overall_category } };
  },
});

define({
  key: 'ttfb',
  element: 'Site speed & performance — TTFB',
  group: 'Performance & Core Web Vitals',
  whatItTracks: 'Time to the first response byte, measured directly as the median of three samples',
  whyItMatters: 'TTFB is the floor on every other timing. An AI retrieval fetcher working to a short timeout gives up on a slow origin entirely.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const ttfb = await measureTtfb(ctx.site, { samples: 3 });
    if (ttfb.ms == null) return { unknown: ttfb.error || 'no successful response' };
    const status = bandOf(ttfb.ms, THRESHOLDS.ttfbMs.target, THRESHOLDS.ttfbMs.googleGood);
    const findings = [];
    if (status !== 'good') {
      findings.push({
        checkKey: 'ttfb_slow',
        title: `Time to first byte is ${ttfb.ms}ms`,
        detail: `Target ${THRESHOLDS.ttfbMs.target}ms; Google's "good" boundary ${THRESHOLDS.ttfbMs.googleGood}ms. Samples: ${ttfb.samples.map((s) => (s == null ? 'failed' : `${s}ms`)).join(', ')}.`,
        severity: ttfb.ms > THRESHOLDS.ttfbMs.googleGood ? 'high' : 'low',
        affectedUrl: ctx.site,
        action: 'Server-side: caching, query time, or origin location. A CDN does not improve TTFB for an uncached first request.',
        evidence: ttfb,
      });
    }
    return { metrics: [{ key: 'track.ttfb_ms', value: ttfb.ms, status }], findings, detail: ttfb };
  },
});

define({
  key: 'page_load',
  element: 'Site speed & performance — document load time',
  group: 'Performance & Core Web Vitals',
  whatItTracks: 'How long the HTML document itself takes to download, and how large it is',
  whyItMatters: 'Document time is a hard floor on page load, and an oversized HTML payload delays every render regardless of how fast the assets are.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample.slice(0, 10);
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 3, async (url) => {
      const res = await fetchPage(url, { timeout: 20000 });
      return { url, ms: res.totalMs, bytes: res.bytes, ok: res.ok, status: res.status };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };
    const slowest = ok.slice().sort((a, b) => b.ms - a.ms);
    const median = ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)];
    const heavy = ok.filter((r) => r.bytes > 500 * 1024);

    const findings = [];
    const slow = ok.filter((r) => r.ms > THRESHOLDS.loadMs.target);
    if (slow.length) {
      findings.push({
        checkKey: 'slow_documents',
        title: `${slow.length} of ${ok.length} sampled pages took over ${THRESHOLDS.loadMs.target}ms to deliver their HTML`,
        detail: slowest.slice(0, 5).map((r) => `${r.url} — ${r.ms}ms, ${(r.bytes / 1024).toFixed(0)} KB`).join('; '),
        severity: median > 3000 ? 'high' : 'medium',
        affectedCount: slow.length,
        affectedUrl: slowest[0].url,
        action: 'Compare against TTFB: if TTFB is fine and this is slow, the HTML is too large. If both are slow, it is the server.',
        evidence: { results: ok },
      });
    }
    if (heavy.length) {
      findings.push({
        checkKey: 'heavy_html',
        title: `${heavy.length} page${heavy.length === 1 ? '' : 's'} serve more than 500 KB of HTML`,
        detail: heavy.slice(0, 5).map((r) => `${r.url} — ${(r.bytes / 1024).toFixed(0)} KB`).join('; '),
        severity: 'medium',
        affectedCount: heavy.length,
        affectedUrl: heavy[0].url,
        action: 'Usually inlined JSON state, base64 images, or a page rendering its entire dataset. All three are removable.',
        evidence: { pages: heavy },
      });
    }

    return {
      metrics: [
        { key: 'track.doc_load_ms_median', value: median, status: bandOf(median, THRESHOLDS.loadMs.target, 3000), detail: `${ok.length} sampled` },
        { key: 'track.html_bytes_max', value: Math.max(...ok.map((r) => r.bytes)), status: heavy.length ? 'warn' : 'good' },
      ],
      findings,
      detail: { sampled: ok.length, median, results: ok },
    };
  },
});

// =========================================================================
// SECURITY
// =========================================================================

define({
  key: 'ssl_security',
  element: 'SSL & security',
  group: 'Security',
  whatItTracks: 'Certificate expiry with a 30-day warning, HTTPS coverage, and the presence of HSTS and CSP',
  whyItMatters: 'An expired certificate blocks every visitor and every crawler at once, and a compromised page earns a manual action that outlasts the compromise.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const cert = await inspectCertificate(ctx.site);
    const res = await fetchPage(ctx.site, { timeout: 15000 });
    const h = res.headers || {};

    // Does plain HTTP redirect to HTTPS? A site serving both is serving
    // duplicate content and leaking the first request of every session.
    let httpRedirects = null;
    try {
      const httpUrl = ctx.site.replace(/^https:/i, 'http:');
      if (httpUrl !== ctx.site) {
        const plain = await fetchPage(httpUrl, { timeout: 12000 });
        httpRedirects = {
          finalUrl: plain.url,
          upgraded: String(plain.url || '').toLowerCase().startsWith('https:'),
          chain: plain.redirectChain,
          status: plain.status,
        };
      }
    } catch { httpRedirects = null; }

    const findings = [];
    const metrics = [];

    if (cert.ok) {
      metrics.push({ key: 'track.ssl_days_left', value: cert.daysLeft, status: cert.daysLeft > 30 ? 'good' : (cert.daysLeft > 7 ? 'warn' : 'fail') });
      if (cert.daysLeft <= 30) {
        findings.push({
          checkKey: 'ssl_expiring',
          title: cert.daysLeft < 0 ? `Certificate EXPIRED ${Math.abs(cert.daysLeft)} days ago` : `Certificate expires in ${cert.daysLeft} days`,
          detail: `Issuer ${cert.issuer || 'unknown'}, valid to ${cert.validTo}.`,
          severity: cert.daysLeft <= 7 ? 'critical' : 'high',
          affectedUrl: ctx.site,
          action: 'Renew and confirm auto-renewal is running.',
          evidence: cert,
        });
      }
      if (!cert.authorized) {
        findings.push({
          checkKey: 'ssl_chain',
          title: 'Certificate does not validate',
          detail: cert.authorizationError,
          severity: 'critical',
          affectedUrl: ctx.site,
          action: 'A missing intermediate certificate is the usual cause, and some browsers hide it by caching the intermediate from another site.',
          evidence: cert,
        });
      }
    } else {
      metrics.push({ key: 'track.ssl_days_left', value: null, status: 'unknown', detail: cert.error });
    }

    if (httpRedirects) {
      metrics.push({
        key: 'track.https_upgrade',
        value: httpRedirects.upgraded ? 1 : 0,
        status: httpRedirects.upgraded ? 'good' : 'fail',
        detail: httpRedirects.upgraded ? `via ${httpRedirects.chain.length} hop(s)` : `http:// stayed on ${httpRedirects.finalUrl}`,
      });
      if (!httpRedirects.upgraded) {
        findings.push({
          checkKey: 'no_https_upgrade',
          title: 'Plain HTTP is served without redirecting to HTTPS',
          detail: `http:// resolved to ${httpRedirects.finalUrl} (HTTP ${httpRedirects.status}).`,
          severity: 'high',
          affectedUrl: ctx.site,
          action: 'Add a 301 from HTTP to HTTPS for every path, then add HSTS.',
          evidence: httpRedirects,
        });
      }
    }

    const headers = {
      hsts: h['strict-transport-security'] || null,
      csp: h['content-security-policy'] || null,
      xContentType: h['x-content-type-options'] || null,
      referrerPolicy: h['referrer-policy'] || null,
    };
    const missingHeaders = Object.entries(headers).filter(([, v]) => !v).map(([k]) => k);
    // Warn, never fail, however many are absent.
    //
    // A metric status drives the group's colour on the board, and an absent
    // hardening header is a hardening gap, not an outage — the finding it
    // raises is 'low' severity for the same reason. Reporting it as 'fail'
    // turned the whole Security group red on a site whose certificate was
    // valid for another 86 days, which is precisely how a board stops being
    // read: the one colour that should mean "act now" starts meaning
    // "somebody has not set Referrer-Policy". Certificate expiry and a missing
    // HTTPS upgrade keep 'fail', because those do break things.
    metrics.push({
      key: 'track.security_headers',
      value: 4 - missingHeaders.length,
      status: missingHeaders.length === 0 ? 'good' : 'warn',
      detail: `missing: ${missingHeaders.join(', ') || 'none'}`,
    });
    if (missingHeaders.includes('hsts') || missingHeaders.includes('csp')) {
      findings.push({
        checkKey: 'security_headers',
        title: `${missingHeaders.length} security header${missingHeaders.length === 1 ? '' : 's'} absent`,
        detail: `Missing: ${missingHeaders.join(', ')}.`,
        severity: 'low',
        affectedUrl: ctx.site,
        action: 'Add HSTS once every subdomain is HTTPS, and CSP in report-only mode first so it can be tuned without breaking the page.',
        evidence: headers,
      });
    }

    return { metrics, findings, detail: { certificate: cert, headers, httpRedirects } };
  },
});

// =========================================================================
// URL & CANONICAL HEALTH
// =========================================================================

define({
  key: 'redirect_chains',
  element: 'Redirect chains',
  group: 'URL & canonical health',
  whatItTracks: 'Chains longer than two hops, and redirect loops',
  whyItMatters: 'Every hop is a round trip. Google follows up to about five and gives up; some AI retrieval fetchers give up after two.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      return { url, hops: res.redirectChain.length, chain: res.redirectChain, finalUrl: res.url, status: res.status, error: res.error };
    });
    const ok = results.filter((r) => r && !r.__error);
    const long = ok.filter((r) => r.hops > 2);
    const anyRedirect = ok.filter((r) => r.hops > 0);
    const loops = ok.filter((r) => r.error && /redirect/i.test(r.error));

    const findings = [];
    if (long.length) {
      findings.push({
        checkKey: 'redirect_chains',
        title: `${long.length} URL${long.length === 1 ? '' : 's'} resolve through more than two redirects`,
        detail: long.slice(0, 5).map((r) => `${r.url}: ${r.chain.map((c) => c.status).join('→')}→200 (${r.hops} hops)`).join('; '),
        severity: 'medium',
        affectedCount: long.length,
        affectedUrl: long[0].url,
        action: 'Point the first URL directly at the final destination. Chains accumulate over years of migrations and nobody notices because the page still loads.',
        evidence: { chains: long },
      });
    }
    if (loops.length) {
      findings.push({
        checkKey: 'redirect_loops',
        title: `${loops.length} URL${loops.length === 1 ? '' : 's'} redirect in a loop`,
        detail: loops.slice(0, 5).map((r) => `${r.url}: ${r.error}`).join('; '),
        severity: 'critical',
        affectedCount: loops.length,
        affectedUrl: loops[0].url,
        action: 'A loop makes the page permanently unreachable for both users and crawlers.',
        evidence: { loops },
      });
    }

    return {
      metrics: [
        { key: 'track.redirect_chains', value: long.length, status: long.length ? 'warn' : 'good', detail: `${ok.length} sampled` },
        { key: 'track.redirect_loops', value: loops.length, status: loops.length ? 'fail' : 'good' },
        { key: 'track.urls_redirecting', value: anyRedirect.length, status: 'good' },
      ],
      findings,
      detail: { sampled: ok.length, results: ok },
    };
  },
});

define({
  key: 'canonicalisation',
  sitewideCapable: true,
  element: 'Canonicalisation',
  group: 'URL & canonical health',
  whatItTracks: 'Whether each sampled page declares a self-referential canonical, and whether that has drifted',
  whyItMatters: 'A templating error that canonicalises every page to one URL removes the whole site from the index, and looks like nothing in a browser.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false, status: res.status };
      const doc = parseDocument(res.url, res.body);
      let resolved = null;
      if (doc.canonical) {
        try { resolved = new URL(doc.canonical, res.url).href; } catch { resolved = doc.canonical; }
      }
      const self = resolved ? canonUrl(resolved) === canonUrl(res.url) : null;
      return { url, ok: true, finalUrl: res.url, declared: doc.canonical, resolved, selfReferential: self };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const missing = ok.filter((r) => !r.declared);
    const drifted = ok.filter((r) => r.declared && r.selfReferential === false);

    // Several pages canonicalising to the SAME target is the templating bug,
    // and it is much more serious than the same count of unrelated drifts.
    const targets = new Map();
    drifted.forEach((r) => targets.set(canonUrl(r.resolved), (targets.get(canonUrl(r.resolved)) || 0) + 1));
    const collapsed = [...targets.entries()].filter(([, n]) => n >= 3);

    const findings = [];
    if (collapsed.length) {
      findings.push({
        checkKey: 'canonical_collapse',
        title: `${collapsed[0][1]} sampled pages all canonicalise to the same URL`,
        detail: `${collapsed.map(([url, n]) => `${n} pages → ${url}`).join('; ')}. This is the signature of a templating error, and it removes every affected page from the index.`,
        severity: 'critical',
        affectedCount: collapsed.reduce((a, [, n]) => a + n, 0),
        affectedUrl: drifted[0].url,
        action: 'Fix the template so the canonical is generated from the current page URL. Nothing else on this board matters more.',
        evidence: { targets: collapsed, pages: drifted.slice(0, 20) },
      });
    } else if (drifted.length) {
      findings.push({
        checkKey: 'canonical_drift',
        title: `${drifted.length} page${drifted.length === 1 ? '' : 's'} canonicalise to a different URL`,
        detail: drifted.slice(0, 6).map((r) => `${r.url} → ${r.resolved}`).join('; '),
        severity: 'medium',
        affectedCount: drifted.length,
        affectedUrl: drifted[0].url,
        action: 'Correct for a genuine duplicate; a problem if the page is meant to rank on its own.',
        evidence: { pages: drifted },
      });
    }
    if (missing.length) {
      findings.push({
        checkKey: 'canonical_missing',
        title: `${missing.length} page${missing.length === 1 ? ' declares' : 's declare'} no canonical`,
        detail: missing.slice(0, 8).map((r) => r.url).join('; '),
        severity: 'low',
        affectedCount: missing.length,
        affectedUrl: missing[0].url,
        action: 'Add a self-referential canonical so parameterised variants cannot compete with the clean URL.',
        evidence: { pages: missing },
      });
    }

    const healthy = ok.filter((r) => r.selfReferential === true).length;
    const selfShare = Math.round((healthy / ok.length) * 100);
    return {
      metrics: [
        // Warn at worst. A page with no canonical raises a 'low' finding, and
        // a metric must never be redder than the finding it produces — a group
        // shown as failing for a missing canonical tag competes for attention
        // with a collapsed canonical, which is a completely different problem.
        // Genuine collapse is caught by track.canonical_drift below, which does
        // fail.
        { key: 'track.canonical_self_share', value: selfShare, status: selfShare >= 90 ? 'good' : 'warn' },
        { key: 'track.canonical_drift', value: drifted.length, status: collapsed.length ? 'fail' : (drifted.length ? 'warn' : 'good') },
      ],
      findings,
      detail: { sampled: ok.length, healthy, missing: missing.length, drifted: drifted.length, collapsed, results: ok },
    };
  },
});

define({
  key: 'url_structure',
  element: 'URL structure',
  group: 'URL & canonical health',
  whatItTracks: 'Duplicate URLs differing only by parameters or trailing slash, overlong URLs, and parameter sprawl in the sitemap',
  whyItMatters: 'Every duplicate form is a competing URL, and a parameterised URL space consumes crawl budget without adding a page.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const robots = await fetchRobots(ctx.site);
    const sitemap = await fetchSitemapUrls(ctx.site, { limit: 3000, robots });
    if (!sitemap.urls.length) return { unknown: 'no sitemap to read the URL inventory from' };

    const urls = sitemap.urls.map((u) => u.loc);
    const byCanon = new Map();
    urls.forEach((u) => {
      const key = canonUrl(u);
      if (!byCanon.has(key)) byCanon.set(key, []);
      byCanon.get(key).push(u);
    });
    const duplicates = [...byCanon.entries()].filter(([, list]) => list.length > 1);

    const withParams = urls.filter((u) => { try { return new URL(u).search.length > 1; } catch { return false; } });
    const paramNames = new Map();
    withParams.forEach((u) => {
      try {
        new URL(u).searchParams.forEach((_, k) => paramNames.set(k, (paramNames.get(k) || 0) + 1));
      } catch { /* skip */ }
    });
    const long = urls.filter((u) => u.length > 115);
    const upperCase = urls.filter((u) => { try { return /[A-Z]/.test(new URL(u).pathname); } catch { return false; } });

    const findings = [];
    if (duplicates.length) {
      findings.push({
        checkKey: 'duplicate_urls',
        title: `${duplicates.length} URL${duplicates.length === 1 ? '' : 's'} appear in the sitemap in more than one form`,
        detail: duplicates.slice(0, 5).map(([key, list]) => `${key}: ${list.join(' , ')}`).join('; '),
        severity: 'medium',
        affectedCount: duplicates.length,
        action: 'A sitemap must list one form per page. Listing several tells Google the site itself is unsure which is canonical.',
        evidence: { duplicates: duplicates.slice(0, 20) },
      });
    }
    if (withParams.length >= Math.max(5, urls.length * 0.1)) {
      findings.push({
        checkKey: 'parameterised_urls',
        title: `${withParams.length} sitemap URLs carry query parameters`,
        detail: `Most common: ${[...paramNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`).join(', ')}.`,
        severity: 'medium',
        affectedCount: withParams.length,
        action: 'Submit the clean form only. Parameters belong behind a canonical, not in the sitemap.',
        evidence: { parameters: [...paramNames.entries()], examples: withParams.slice(0, 15) },
      });
    }
    if (long.length) {
      findings.push({
        checkKey: 'long_urls',
        title: `${long.length} URL${long.length === 1 ? ' is' : 's are'} longer than 115 characters`,
        detail: long.slice(0, 4).map((u) => `${u.slice(0, 100)}…`).join('; '),
        severity: 'low',
        affectedCount: long.length,
        action: 'Not a ranking factor in itself, but long URLs are truncated in the SERP and are harder to share and to cite.',
        evidence: { urls: long.slice(0, 20) },
      });
    }
    if (upperCase.length) {
      findings.push({
        checkKey: 'mixed_case_urls',
        title: `${upperCase.length} URL${upperCase.length === 1 ? '' : 's'} contain uppercase characters in the path`,
        detail: upperCase.slice(0, 5).join('; '),
        severity: 'low',
        affectedCount: upperCase.length,
        action: 'Paths are case-sensitive on most servers, so an uppercase path creates a second URL for the same page whenever anyone links to the lowercase form.',
        evidence: { urls: upperCase.slice(0, 20) },
      });
    }

    return {
      metrics: [
        { key: 'track.sitemap_duplicate_urls', value: duplicates.length, status: duplicates.length ? 'warn' : 'good' },
        { key: 'track.parameterised_urls', value: withParams.length, status: withParams.length ? 'warn' : 'good' },
        { key: 'track.long_urls', value: long.length, status: long.length ? 'warn' : 'good' },
      ],
      findings,
      detail: { total: urls.length, duplicates: duplicates.length, withParams: withParams.length, long: long.length, upperCase: upperCase.length, parameters: [...paramNames.entries()] },
    };
  },
});

// =========================================================================
// ON-PAGE ELEMENTS
// =========================================================================

define({
  key: 'titles_meta',
  sitewideCapable: true,
  element: 'Title tags & meta descriptions',
  group: 'On-page elements',
  whatItTracks: 'Missing, duplicated and over-length titles and meta descriptions across the sample, plus the CTR trend for the site',
  whyItMatters: 'The title is the strongest on-page ranking signal and the description drives click-through; duplicates mean Google chooses which page to show.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      return {
        url: res.url, ok: true,
        title: doc.title, titleLength: (doc.title || '').length, titleCount: doc.titleCount,
        metaDesc: doc.metaDesc, metaLength: (doc.metaDesc || '').length, metaCount: doc.metaDescCount,
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const missingTitle = ok.filter((r) => !r.title);
    const missingMeta = ok.filter((r) => !r.metaDesc);
    const longTitle = ok.filter((r) => r.titleLength > 60);
    const shortTitle = ok.filter((r) => r.title && r.titleLength < 15);
    const longMeta = ok.filter((r) => r.metaLength > 160);
    const shortMeta = ok.filter((r) => r.metaDesc && r.metaLength < 70);
    const multipleTitle = ok.filter((r) => r.titleCount > 1);

    const groupDupes = (field) => {
      const m = new Map();
      ok.forEach((r) => {
        const v = (r[field] || '').trim();
        if (!v) return;
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(r.url);
      });
      return [...m.entries()].filter(([, list]) => list.length > 1);
    };
    const dupTitles = groupDupes('title');
    const dupMetas = groupDupes('metaDesc');

    // Site-level CTR trend, which is the "CTR trends" part of the element.
    let ctrTrend = null;
    const anchor = analytics.latestGscDate(ctx.brandId);
    if (anchor) {
      const cmp = analytics.comparisonWindows(anchor, 28);
      const read = (w) => {
        const r = db.prepare(`SELECT SUM(clicks) c, SUM(impressions) i FROM gsc_daily
          WHERE brand_id=? AND date BETWEEN ? AND ?`).get(ctx.brandId, w.startDate, w.endDate);
        const clicks = Number(r && r.c) || 0;
        const impressions = Number(r && r.i) || 0;
        return { clicks, impressions, ctr: impressions ? (clicks / impressions) * 100 : null };
      };
      const recent = read(cmp.recent);
      const prior = read(cmp.prior);
      if (recent.ctr != null && prior.ctr != null) {
        ctrTrend = {
          recent: Math.round(recent.ctr * 100) / 100,
          prior: Math.round(prior.ctr * 100) / 100,
          deltaPp: Math.round((recent.ctr - prior.ctr) * 100) / 100,
          windows: cmp,
        };
      }
    }

    const findings = [];
    if (dupTitles.length) {
      findings.push({
        checkKey: 'duplicate_titles',
        title: `${dupTitles.length} title${dupTitles.length === 1 ? '' : 's'} used on more than one page`,
        detail: dupTitles.slice(0, 4).map(([t, list]) => `"${t.slice(0, 60)}" on ${list.length} pages`).join('; '),
        severity: 'high',
        affectedCount: dupTitles.reduce((a, [, l]) => a + l.length, 0),
        affectedUrl: dupTitles[0][1][0],
        action: 'Give each page a distinct title. Duplicates make Google pick which page to show for a query, and it does not always pick the one you want.',
        evidence: { duplicates: dupTitles.slice(0, 20) },
      });
    }
    if (missingTitle.length) {
      findings.push({
        checkKey: 'missing_titles',
        title: `${missingTitle.length} page${missingTitle.length === 1 ? '' : 's'} have no title tag`,
        detail: missingTitle.slice(0, 6).map((r) => r.url).join('; '),
        severity: 'high',
        affectedCount: missingTitle.length,
        affectedUrl: missingTitle[0].url,
        action: 'Add one. Google will generate a title from the page content instead, and it is rarely the one you would choose.',
        evidence: { pages: missingTitle },
      });
    }
    if (multipleTitle.length) {
      findings.push({
        checkKey: 'multiple_titles',
        title: `${multipleTitle.length} page${multipleTitle.length === 1 ? ' has' : 's have'} more than one title tag`,
        detail: multipleTitle.slice(0, 6).map((r) => `${r.url} (${r.titleCount})`).join('; '),
        severity: 'medium',
        affectedCount: multipleTitle.length,
        affectedUrl: multipleTitle[0].url,
        action: 'Remove the extras — usually a plugin adding one on top of the theme\'s.',
        evidence: { pages: multipleTitle },
      });
    }
    if (longTitle.length + shortTitle.length) {
      findings.push({
        checkKey: 'title_length',
        title: `${longTitle.length + shortTitle.length} title${longTitle.length + shortTitle.length === 1 ? '' : 's'} outside the 15-60 character range`,
        detail: `${longTitle.length} over 60 characters (truncated in the SERP), ${shortTitle.length} under 15 (wasting the strongest on-page signal there is).`,
        severity: 'low',
        affectedCount: longTitle.length + shortTitle.length,
        action: 'Rewrite the over-length ones to put the distinguishing words first, so a truncation still reads.',
        evidence: { long: longTitle.slice(0, 15), short: shortTitle.slice(0, 15) },
      });
    }
    if (dupMetas.length || missingMeta.length) {
      findings.push({
        checkKey: 'meta_description',
        title: `${missingMeta.length} page${missingMeta.length === 1 ? '' : 's'} without a meta description, ${dupMetas.length} duplicated`,
        detail: [
          missingMeta.length ? `Missing on: ${missingMeta.slice(0, 5).map((r) => r.url).join(', ')}.` : '',
          dupMetas.length ? `Duplicated: ${dupMetas.slice(0, 3).map(([d, l]) => `"${d.slice(0, 50)}" ×${l.length}`).join('; ')}.` : '',
        ].filter(Boolean).join(' '),
        severity: 'low',
        affectedCount: missingMeta.length + dupMetas.length,
        action: 'Write descriptions for the pages that earn impressions first. Google rewrites descriptions often, but a good one is used more than a missing one.',
        evidence: { missing: missingMeta.slice(0, 20), duplicates: dupMetas.slice(0, 15) },
      });
    }
    if (ctrTrend && ctrTrend.deltaPp <= -0.3) {
      findings.push({
        checkKey: 'ctr_falling',
        title: `Site-wide click-through rate fell ${Math.abs(ctrTrend.deltaPp)} percentage points`,
        detail: `${ctrTrend.prior}% over ${ctrTrend.windows.prior.startDate}–${ctrTrend.windows.prior.endDate}, now ${ctrTrend.recent}%.`,
        severity: 'medium',
        action: 'Check whether impressions rose at the same time — a CTR fall with rising impressions usually means new, lower-intent queries rather than worse titles.',
        evidence: ctrTrend,
      });
    }

    return {
      metrics: [
        { key: 'track.duplicate_titles', value: dupTitles.length, status: dupTitles.length ? 'fail' : 'good' },
        { key: 'track.missing_titles', value: missingTitle.length, status: missingTitle.length ? 'fail' : 'good' },
        { key: 'track.missing_meta_desc', value: missingMeta.length, status: missingMeta.length ? 'warn' : 'good' },
        { key: 'track.title_length_violations', value: longTitle.length + shortTitle.length, status: (longTitle.length + shortTitle.length) ? 'warn' : 'good' },
        ...(ctrTrend ? [{ key: 'track.site_ctr', value: ctrTrend.recent, status: ctrTrend.deltaPp < -0.3 ? 'warn' : 'good' }] : []),
      ],
      findings,
      detail: { sampled: ok.length, dupTitles, dupMetas, missingTitle: missingTitle.length, missingMeta: missingMeta.length, ctrTrend, results: ok },
    };
  },
});

define({
  key: 'heading_structure',
  element: 'Header tags (H1-H6)',
  group: 'On-page elements',
  whatItTracks: 'Missing H1s, multiple H1s, and skipped heading levels',
  whyItMatters: 'Headings are how both a screen reader and an AI retrieval system decide what a section is about; a broken hierarchy makes passage extraction unreliable.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      // A level is "skipped" when a heading jumps more than one level deeper
      // than its predecessor — h2 followed by h4. Going back UP any number of
      // levels is normal and is not a fault.
      const skips = [];
      let prev = null;
      doc.headings.forEach((h) => {
        if (prev != null && h.level > prev + 1) skips.push({ from: prev, to: h.level, text: h.text.slice(0, 60) });
        prev = h.level;
      });
      return {
        url: res.url, ok: true,
        h1Count: doc.h1s.length, h1s: doc.h1s.slice(0, 3),
        headingCount: doc.headings.length, skips,
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const noH1 = ok.filter((r) => r.h1Count === 0);
    const manyH1 = ok.filter((r) => r.h1Count > 1);
    const skipped = ok.filter((r) => r.skips.length);
    const noHeadings = ok.filter((r) => r.headingCount === 0);

    const findings = [];
    if (noH1.length) {
      findings.push({
        checkKey: 'missing_h1',
        title: `${noH1.length} page${noH1.length === 1 ? '' : 's'} have no H1`,
        detail: noH1.slice(0, 6).map((r) => r.url).join('; '),
        severity: 'medium',
        affectedCount: noH1.length,
        affectedUrl: noH1[0].url,
        action: 'Add one H1 stating what the page is about. Where a design uses a styled div, change the element rather than the styling.',
        evidence: { pages: noH1 },
      });
    }
    if (manyH1.length) {
      findings.push({
        checkKey: 'multiple_h1',
        title: `${manyH1.length} page${manyH1.length === 1 ? ' has' : 's have'} more than one H1`,
        detail: manyH1.slice(0, 6).map((r) => `${r.url} (${r.h1Count})`).join('; '),
        severity: 'low',
        affectedCount: manyH1.length,
        affectedUrl: manyH1[0].url,
        action: 'Valid HTML5, and Google tolerates it — but a single H1 makes the page\'s subject unambiguous to a passage extractor, which multiple H1s do not.',
        evidence: { pages: manyH1 },
      });
    }
    if (skipped.length) {
      findings.push({
        checkKey: 'skipped_heading_levels',
        title: `${skipped.length} page${skipped.length === 1 ? '' : 's'} skip heading levels`,
        detail: skipped.slice(0, 5).map((r) => `${r.url}: ${r.skips.slice(0, 2).map((s) => `h${s.from}→h${s.to} at "${s.text}"`).join(', ')}`).join('; '),
        severity: 'low',
        affectedCount: skipped.length,
        affectedUrl: skipped[0].url,
        action: 'Choose heading levels by hierarchy and style them by CSS. A jump from h2 to h4 makes an extracted passage look like a sub-point of something that is not there.',
        evidence: { pages: skipped },
      });
    }
    if (noHeadings.length) {
      findings.push({
        checkKey: 'no_headings',
        title: `${noHeadings.length} page${noHeadings.length === 1 ? ' has' : 's have'} no headings at all`,
        detail: noHeadings.slice(0, 6).map((r) => r.url).join('; '),
        severity: 'medium',
        affectedCount: noHeadings.length,
        affectedUrl: noHeadings[0].url,
        action: 'Content with no headings cannot be chunked, so a retrieval system has no unit smaller than the whole page to cite.',
        evidence: { pages: noHeadings },
      });
    }

    return {
      metrics: [
        { key: 'track.missing_h1', value: noH1.length, status: noH1.length ? 'warn' : 'good' },
        { key: 'track.multiple_h1', value: manyH1.length, status: manyH1.length ? 'warn' : 'good' },
        { key: 'track.heading_skips', value: skipped.length, status: skipped.length ? 'warn' : 'good' },
      ],
      findings,
      detail: { sampled: ok.length, results: ok },
    };
  },
});

// =========================================================================
// CONTENT QUALITY
// =========================================================================

define({
  key: 'content_quality',
  element: 'Content quality',
  group: 'Content quality',
  whatItTracks: 'Thin pages, near-duplicate content across the sample, keyword cannibalisation from Search Console, and citability',
  whyItMatters: 'Thin and duplicated pages dilute the site; cannibalisation splits the signal for a query across URLs so none of them ranks well.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      return {
        url: res.url, ok: true, title: doc.title,
        words: doc.wordCount,
        // An index page's content IS its links, so it must not be counted as
        // thin — see the same reasoning in the js_rendering check above,
        // including why only main-region links are counted.
        isIndexPage: (function () {
          const links = doc.links.filter((l) => l.internal && l.inMain).length;
          return links >= 10 && doc.headings.length >= 5 && links > (doc.wordCount / 12);
        }()),
        textToHtml: doc.htmlLength ? Math.round((doc.mainText.length / doc.htmlLength) * 1000) / 10 : null,
        citability: nlp.citability(doc).score,
        readability: nlp.readability(doc.mainText).fleschReadingEase,
        tf: nlp.termFrequency(doc.mainText),
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const thin = ok.filter((r) => r.words < 200 && !r.isIndexPage);
    const lowRatio = ok.filter((r) => r.textToHtml != null && r.textToHtml < 10);

    // Near-duplicates by cosine similarity over term frequencies. 0.9 is a
    // deliberately high bar: two service pages for neighbouring towns are
    // legitimately similar, and flagging every one of those would bury the
    // genuine copies.
    const nearDupes = [];
    for (let i = 0; i < ok.length; i += 1) {
      for (let j = i + 1; j < ok.length; j += 1) {
        if (ok[i].words < 100 || ok[j].words < 100) continue;
        const sim = nlp.cosine(ok[i].tf, ok[j].tf);
        if (sim >= 0.9) nearDupes.push({ a: ok[i].url, b: ok[j].url, similarity: Math.round(sim * 100) / 100 });
      }
    }

    // Cannibalisation from Search Console: one query, several URLs, each with
    // a real share of the impressions.
    let cannibalised = [];
    const anchor = analytics.latestGscDate(ctx.brandId);
    if (anchor) {
      const period = db.prepare('SELECT period_start, period_end FROM gsc_query_page WHERE brand_id=? ORDER BY period_end DESC LIMIT 1').get(ctx.brandId);
      if (period) {
        const rows = db.prepare(`SELECT query, page, impressions, clicks, position FROM gsc_query_page
          WHERE brand_id=? AND period_start=? AND period_end=?`).all(ctx.brandId, period.period_start, period.period_end);
        const byQuery = new Map();
        rows.forEach((r) => {
          if (!byQuery.has(r.query)) byQuery.set(r.query, []);
          byQuery.get(r.query).push(r);
        });
        const brandTerms = require('../seoSignals').brandTerms(ctx.brand || {});
        cannibalised = [...byQuery.entries()]
          // Branded queries legitimately return several of a site's own pages;
          // including them makes every site look cannibalised.
          .filter(([query]) => !require('../seoSignals').isBrandedQuery(query, brandTerms))
          .map(([query, list]) => {
            const total = list.reduce((a, r) => a + (Number(r.impressions) || 0), 0);
            const meaningful = list.filter((r) => total > 0 && (Number(r.impressions) || 0) / total >= 0.15);
            return { query, total, urls: meaningful.length, pages: meaningful.map((r) => ({ page: r.page, impressions: Number(r.impressions) || 0, position: Number(r.position) || null })) };
          })
          .filter((c) => c.urls >= 3 && c.total >= 100)
          .sort((a, b) => b.total - a.total)
          .slice(0, 20);
      }
    }

    const findings = [];
    if (thin.length) {
      findings.push({
        checkKey: 'thin_content',
        title: `${thin.length} page${thin.length === 1 ? ' carries' : 's carry'} under 200 words of main content`,
        detail: thin.slice(0, 6).map((r) => `${r.url} (${r.words} words)`).join('; '),
        severity: 'medium',
        affectedCount: thin.length,
        affectedUrl: thin[0].url,
        action: 'Either develop them or consolidate them into a page that answers the whole question. Check first whether the content is being rendered by JavaScript — a thin count on a rich-looking page usually means that.',
        evidence: { pages: thin.map((r) => ({ url: r.url, words: r.words })) },
      });
    }
    if (nearDupes.length) {
      findings.push({
        checkKey: 'near_duplicate',
        title: `${nearDupes.length} page pair${nearDupes.length === 1 ? '' : 's'} are near-identical`,
        detail: nearDupes.slice(0, 5).map((d) => `${d.a} ≈ ${d.b} (${Math.round(d.similarity * 100)}%)`).join('; '),
        severity: 'medium',
        affectedCount: nearDupes.length,
        affectedUrl: nearDupes[0].a,
        action: 'Consolidate, or differentiate substantively. The 90% bar means these are copies rather than merely similar pages.',
        evidence: { pairs: nearDupes },
      });
    }
    if (cannibalised.length) {
      findings.push({
        checkKey: 'cannibalisation',
        title: `${cannibalised.length} quer${cannibalised.length === 1 ? 'y is' : 'ies are'} split across three or more of the site's own URLs`,
        detail: cannibalised.slice(0, 5).map((c) => `"${c.query}" (${c.urls} URLs, ${Math.round(c.total).toLocaleString('en-US')} impressions)`).join('; '),
        severity: 'high',
        affectedCount: cannibalised.length,
        action: 'Pick one URL to own each query, and make the others link to it rather than compete. Branded queries are excluded from this count, since several own pages ranking for the company name is normal.',
        evidence: { queries: cannibalised },
      });
    }
    if (lowRatio.length) {
      findings.push({
        checkKey: 'low_text_ratio',
        title: `${lowRatio.length} page${lowRatio.length === 1 ? ' has' : 's have'} a text-to-HTML ratio under 10%`,
        detail: lowRatio.slice(0, 6).map((r) => `${r.url} (${r.textToHtml}%)`).join('; '),
        severity: 'low',
        affectedCount: lowRatio.length,
        affectedUrl: lowRatio[0].url,
        action: 'The markup is doing far more work than the content. Usually inline scripts, inline state, or a builder emitting deeply nested wrappers.',
        evidence: { pages: lowRatio.map((r) => ({ url: r.url, ratio: r.textToHtml })) },
      });
    }

    const avgCitability = Math.round(ok.reduce((a, r) => a + r.citability, 0) / ok.length);

    // A metric that fails must always come with a finding that explains it.
    // Without this, average citability could turn the Content quality group red
    // with nothing on the page saying why — a colour with no explanation is
    // worse than no colour.
    if (avgCitability < 45) {
      const worst = ok.slice().sort((a, b) => a.citability - b.citability).slice(0, 6);
      findings.push({
        checkKey: 'low_citability',
        title: `Average citability across the sample is ${avgCitability}/100`,
        detail: `Weakest: ${worst.map((r) => `${r.url} (${r.citability})`).join('; ')}. Citability measures whether an AI answer engine can lift a passage and attribute it — self-contained paragraphs, structured blocks, concrete figures, a visible date, valid schema.`,
        severity: avgCitability < 30 ? 'high' : 'medium',
        affectedCount: ok.length,
        affectedUrl: worst[0].url,
        action: 'Run the on-page scorer on the weakest pages — it reports the specific signals each one is missing and which paragraphs cannot stand alone.',
        evidence: { average: avgCitability, pages: ok.map((r) => ({ url: r.url, citability: r.citability })) },
      });
    }

    return {
      metrics: [
        { key: 'track.thin_pages', value: thin.length, status: thin.length ? 'warn' : 'good' },
        { key: 'track.near_duplicates', value: nearDupes.length, status: nearDupes.length ? 'warn' : 'good' },
        { key: 'track.cannibalised_queries', value: cannibalised.length, status: cannibalised.length ? 'fail' : 'good' },
        { key: 'track.avg_citability', value: avgCitability, status: bandOf(avgCitability, 65, 45, { lowerIsBetter: false }) },
      ],
      findings,
      detail: {
        sampled: ok.length,
        avgCitability,
        thin: thin.length,
        nearDupes,
        cannibalised,
        pages: ok.map((r) => ({ url: r.url, title: r.title, words: r.words, textToHtml: r.textToHtml, citability: r.citability, readability: r.readability })),
      },
    };
  },
});

// =========================================================================
// INTERNAL LINKING
// =========================================================================

define({
  key: 'internal_linking',
  element: 'Internal linking',
  group: 'Internal linking',
  whatItTracks: 'Orphan pages, broken internal links, and how inbound links are distributed across the crawled set',
  whyItMatters: 'A page nothing links to is barely crawled and barely ranks; a broken internal link wastes the crawl budget spent following it.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const { crawlSite } = require('./fetcher');
    const crawl = await crawlSite(ctx.site, { maxPages: 40, concurrency: 4 });
    const okPages = crawl.pages.filter((p) => p.ok && p.doc);
    if (okPages.length < 3) return { unknown: `only ${okPages.length} page(s) crawlable — internal links may be rendered by JavaScript` };

    const inbound = new Map();
    const known = new Set(okPages.map((p) => canonUrl(p.url)));
    const internalTargets = new Set();
    okPages.forEach((p) => {
      p.doc.links.filter((l) => l.internal).forEach((l) => {
        const key = canonUrl(l.url);
        internalTargets.add(key);
        if (key === canonUrl(p.url)) return;
        inbound.set(key, (inbound.get(key) || 0) + 1);
      });
    });

    const startKey = canonUrl(ctx.site);
    const orphans = [...known].filter((k) => k !== startKey && !inbound.has(k));
    const weak = [...known].filter((k) => k !== startKey && inbound.get(k) === 1);

    // Internal links pointing at URLs the crawl never reached: either they are
    // outside the page budget, or they are broken. Checked directly so the
    // distinction is real rather than assumed.
    const unresolved = [...internalTargets].filter((k) => !known.has(k)).slice(0, 40);
    const checked = await mapLimit(unresolved, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 12000 });
      return { url, status: res.status, ok: res.ok, error: res.error };
    });
    const broken = checked.filter((c) => c && !c.__error && ((c.status >= 400) || (c.status == null && c.error)));

    const counts = [...known].map((k) => inbound.get(k) || 0).sort((a, b) => b - a);
    const total = counts.reduce((a, n) => a + n, 0);
    // Gini coefficient of the inbound-link distribution. A high value means
    // link equity is concentrated in a few pages, which is normal for a
    // homepage-heavy site and a problem when the concentration is accidental.
    let gini = null;
    if (counts.length > 1 && total > 0) {
      const asc = counts.slice().reverse();
      let cumulative = 0;
      asc.forEach((v, i) => { cumulative += (i + 1) * v; });
      gini = Math.round(((2 * cumulative) / (asc.length * total) - (asc.length + 1) / asc.length) * 1000) / 1000;
    }

    const findings = [];
    if (orphans.length) {
      findings.push({
        checkKey: 'orphan_pages',
        title: `${orphans.length} crawled page${orphans.length === 1 ? '' : 's'} have no inbound internal link`,
        detail: orphans.slice(0, 8).join('; '),
        severity: 'medium',
        affectedCount: orphans.length,
        affectedUrl: orphans[0],
        action: 'Link each from the most relevant hub. Note that these were discovered BY crawling, so they are reachable — a page reachable only from a sitemap would not appear here at all.',
        evidence: { orphans },
      });
    }
    if (broken.length) {
      findings.push({
        checkKey: 'broken_internal_links',
        title: `${broken.length} internal link target${broken.length === 1 ? '' : 's'} are broken`,
        detail: broken.slice(0, 8).map((b) => `${b.url} → ${b.status || b.error}`).join('; '),
        severity: 'high',
        affectedCount: broken.length,
        affectedUrl: broken[0].url,
        action: 'Fix or remove the links. Every one is a crawl request spent reaching nothing.',
        evidence: { broken },
      });
    }
    if (gini != null && gini > 0.7) {
      findings.push({
        checkKey: 'link_equity_concentration',
        title: `Inbound internal links are heavily concentrated (Gini ${gini})`,
        detail: `The most-linked page has ${counts[0]} inbound links; the median has ${counts[Math.floor(counts.length / 2)]}. Some concentration is correct — a homepage should be the most-linked page — but at this level most of the site receives almost no internal signal.`,
        severity: 'low',
        action: 'Add contextual links from the well-linked pages into the topics they cover. The architecture analysis proposes specific pairs.',
        evidence: { gini, distribution: counts.slice(0, 25) },
      });
    }

    return {
      metrics: [
        { key: 'track.orphan_pages', value: orphans.length, status: orphans.length ? 'warn' : 'good' },
        { key: 'track.broken_internal_links', value: broken.length, status: broken.length ? 'fail' : 'good' },
        { key: 'track.link_gini', value: gini, status: gini == null ? 'unknown' : (gini > 0.7 ? 'warn' : 'good') },
        { key: 'track.weakly_linked_pages', value: weak.length, status: 'good' },
      ],
      findings,
      detail: { crawled: okPages.length, orphans, weak, broken, unresolvedChecked: checked.length, gini, distribution: counts },
    };
  },
});

// =========================================================================
// IMAGES
// =========================================================================

define({
  key: 'images',
  element: 'Image optimisation',
  group: 'Images',
  whatItTracks: 'Missing alt text, oversized image files, missing width/height, and lazy-loading coverage',
  whyItMatters: 'Alt text is an accessibility requirement and an indexing signal; oversized images are usually the largest single cause of a poor LCP.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample.slice(0, 12);
    if (!sample.length) return { unknown: 'no URLs to sample' };

    const pages = await mapLimit(sample, 3, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      return { url: res.url, ok: true, images: doc.images };
    });
    const ok = pages.filter((p) => p && !p.__error && p.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const all = ok.flatMap((p) => p.images.map((i) => ({ ...i, page: p.url })));
    if (!all.length) {
      return {
        metrics: [{ key: 'track.images_missing_alt', value: 0, status: 'good', detail: 'no images found' }],
        findings: [],
        detail: { sampled: ok.length, images: 0 },
      };
    }

    const missingAlt = all.filter((i) => i.alt == null && i.src && !i.src.startsWith('data:'));
    const emptyAlt = all.filter((i) => i.alt === '');
    const noDimensions = all.filter((i) => !i.width || !i.height);
    const noLazy = all.filter((i) => !i.loading);
    const noSrcset = all.filter((i) => !i.srcset);

    // Actual byte sizes, for a bounded sample. Fetching every image on twelve
    // pages could be hundreds of requests, so this measures the first 20
    // distinct ones — enough to establish whether the site has an image-weight
    // problem, which is the question.
    const distinct = [...new Map(all.filter((i) => i.src && /^https?:/i.test(i.src)).map((i) => [i.src, i])).values()].slice(0, 20);
    const sized = await mapLimit(distinct, 4, async (img) => {
      const res = await fetchPage(img.src, { timeout: 15000 });
      return { src: img.src, page: img.page, bytes: res.bytes, status: res.status, type: res.contentType };
    });
    const fetchedImages = sized.filter((s) => s && !s.__error && s.bytes > 0);
    const oversized = fetchedImages.filter((s) => s.bytes > 200 * 1024);
    const nextGen = fetchedImages.filter((s) => /webp|avif/i.test(s.type || ''));

    const findings = [];
    if (missingAlt.length) {
      findings.push({
        checkKey: 'missing_alt',
        title: `${missingAlt.length} image${missingAlt.length === 1 ? '' : 's'} have no alt attribute`,
        detail: `Across ${new Set(missingAlt.map((i) => i.page)).size} sampled pages. Note that alt="" is valid for a decorative image and is counted separately (${emptyAlt.length} found) — this count is images where the attribute is absent entirely.`,
        severity: 'medium',
        affectedCount: missingAlt.length,
        affectedUrl: missingAlt[0].page,
        action: 'Describe what the image shows, for a reader who cannot see it. Where an image is purely decorative, add alt="" explicitly rather than leaving the attribute off.',
        evidence: { images: missingAlt.slice(0, 25) },
      });
    }
    if (oversized.length) {
      findings.push({
        checkKey: 'oversized_images',
        title: `${oversized.length} of ${fetchedImages.length} measured images exceed 200 KB`,
        detail: oversized.slice(0, 5).map((s) => `${s.src.split('/').pop()} — ${(s.bytes / 1024).toFixed(0)} KB (${s.type || 'unknown type'})`).join('; '),
        severity: 'medium',
        affectedCount: oversized.length,
        affectedUrl: oversized[0].page,
        action: `Convert to WebP or AVIF and serve responsive sizes. ${nextGen.length} of ${fetchedImages.length} measured images already use a next-generation format.`,
        evidence: { images: oversized },
      });
    }
    if (noDimensions.length >= all.length * 0.5) {
      findings.push({
        checkKey: 'missing_dimensions',
        title: `${noDimensions.length} of ${all.length} images declare no width and height`,
        detail: 'Without intrinsic dimensions the browser cannot reserve space, so the page shifts as each image loads — which is exactly what CLS measures.',
        severity: 'medium',
        affectedCount: noDimensions.length,
        action: 'Add width and height attributes. CSS can still control the rendered size; the attributes only supply the aspect ratio.',
        evidence: { images: noDimensions.slice(0, 25) },
      });
    }
    if (noLazy.length >= all.length * 0.8 && all.length > 5) {
      findings.push({
        checkKey: 'no_lazy_loading',
        title: `${noLazy.length} of ${all.length} images have no loading attribute`,
        detail: 'Every image is fetched immediately, including the ones far below the fold.',
        severity: 'low',
        affectedCount: noLazy.length,
        action: 'Add loading="lazy" to below-the-fold images. Do NOT add it to the hero image — lazy-loading the LCP element makes LCP worse, which is the most common mistake here.',
        evidence: { images: noLazy.slice(0, 25) },
      });
    }

    return {
      metrics: [
        { key: 'track.images_missing_alt', value: missingAlt.length, status: missingAlt.length ? 'warn' : 'good', detail: `${all.length} images on ${ok.length} pages` },
        { key: 'track.images_oversized', value: oversized.length, status: oversized.length ? 'warn' : 'good' },
        { key: 'track.images_nextgen_share', value: fetchedImages.length ? Math.round((nextGen.length / fetchedImages.length) * 100) : null, status: bandOf(fetchedImages.length ? (nextGen.length / fetchedImages.length) * 100 : null, 70, 30, { lowerIsBetter: false }) },
        { key: 'track.images_no_dimensions', value: noDimensions.length, status: noDimensions.length ? 'warn' : 'good' },
      ],
      findings,
      detail: {
        sampled: ok.length, images: all.length,
        missingAlt: missingAlt.length, emptyAlt: emptyAlt.length,
        noDimensions: noDimensions.length, noLazy: noLazy.length, noSrcset: noSrcset.length,
        measured: fetchedImages.length, oversized: oversized.length, nextGen: nextGen.length,
        largest: fetchedImages.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
      },
    };
  },
});

// =========================================================================
// STRUCTURED DATA
// =========================================================================

define({
  key: 'structured_data',
  element: 'Structured data / schema markup',
  group: 'Structured data',
  whatItTracks: 'Schema presence and validity across the sample, plus the rich-result types Search Console reports as eligible',
  whyItMatters: 'Invalid markup earns no rich result at all, and a JSON-LD block that does not parse is completely invisible while looking present in the source.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const schemaAuto = require('./schemaAuto');
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };

    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      const nodes = [];
      let parseErrors = 0;
      doc.jsonLd.forEach((block) => {
        if (!block.ok) { parseErrors += 1; return; }
        schemaAuto.extractNodes(block.data).forEach((entry) => nodes.push(schemaAuto.validateNode(entry)));
      });
      const errors = nodes.reduce((a, n) => a + (n.problems || []).filter((p) => p.severity === 'error').length, 0);
      return {
        url: res.url, ok: true,
        blocks: doc.jsonLd.length, parseErrors,
        types: [...new Set(nodes.map((n) => n.canonical || n.type))],
        errors,
        problems: nodes.flatMap((n) => (n.problems || []).filter((p) => p.severity === 'error').map((p) => ({ type: n.type, message: p.message }))),
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const noSchema = ok.filter((r) => r.blocks === 0);
    const withParseErrors = ok.filter((r) => r.parseErrors > 0);
    const withErrors = ok.filter((r) => r.errors > 0);
    const rich = analytics.richResultsSummary(ctx.brandId);

    const findings = [];
    if (withParseErrors.length) {
      findings.push({
        checkKey: 'schema_parse_error',
        title: `${withParseErrors.length} page${withParseErrors.length === 1 ? '' : 's'} carry JSON-LD that does not parse`,
        detail: withParseErrors.slice(0, 6).map((r) => `${r.url} (${r.parseErrors} block${r.parseErrors === 1 ? '' : 's'})`).join('; '),
        severity: 'critical',
        affectedCount: withParseErrors.length,
        affectedUrl: withParseErrors[0].url,
        action: 'The markup is present in the HTML and doing absolutely nothing. Usual causes: an unescaped quote in a description, a trailing comma, or a template variable that rendered empty.',
        evidence: { pages: withParseErrors },
      });
    }
    if (withErrors.length) {
      findings.push({
        checkKey: 'schema_required_missing',
        title: `${withErrors.length} page${withErrors.length === 1 ? '' : 's'} have schema missing required properties`,
        detail: withErrors.slice(0, 5).map((r) => `${r.url}: ${r.problems.slice(0, 2).map((p) => p.message).join(' ')}`).join('; '),
        severity: 'high',
        affectedCount: withErrors.length,
        affectedUrl: withErrors[0].url,
        action: 'Add the required properties, or remove the type. Incomplete markup earns no rich result, so it is pure overhead.',
        evidence: { pages: withErrors },
      });
    }
    if (noSchema.length >= ok.length * 0.5) {
      findings.push({
        checkKey: 'schema_coverage',
        title: `${noSchema.length} of ${ok.length} sampled pages have no structured data`,
        detail: noSchema.slice(0, 6).map((r) => r.url).join('; '),
        severity: 'medium',
        affectedCount: noSchema.length,
        affectedUrl: noSchema[0].url,
        action: 'Add at least Organization sitewide and a page-type block per template. The Schema page generates both from what is already on each page.',
        evidence: { pages: noSchema.map((r) => r.url) },
      });
    }

    const coverage = Math.round(((ok.length - noSchema.length) / ok.length) * 100);
    const totalErrors = ok.reduce((a, r) => a + r.errors + r.parseErrors, 0);
    // Rich-result eligibility comes from URL Inspection, which the nightly sync
    // collects. With nothing inspected the count is 0, and reporting 0 as
    // 'good' would state "no rich results, and that is fine" — so it is
    // reported as unknown until there is something to read.
    const inspected = (rich && rich.totals && Number(rich.totals.checked)) || 0;
    return {
      metrics: [
        // Absent schema is an opportunity (medium finding); INVALID schema is a
        // fault (critical/high finding). Only the second one fails, so the two
        // are distinguishable at a glance on the board.
        { key: 'track.schema_coverage', value: coverage, status: coverage >= 80 ? 'good' : 'warn' },
        { key: 'track.schema_errors', value: totalErrors, status: totalErrors ? 'fail' : 'good' },
        {
          key: 'track.rich_result_types',
          value: inspected ? ((rich.types || []).length) : null,
          status: inspected ? 'good' : 'unknown',
          detail: inspected ? `${inspected} URL(s) inspected` : 'no URL Inspection results stored yet — collected by the nightly sync',
        },
      ],
      findings,
      detail: {
        sampled: ok.length, coverage, totalErrors,
        typesFound: [...new Set(ok.flatMap((r) => r.types))],
        searchConsoleRichResults: rich,
        results: ok,
      },
    };
  },
});

// =========================================================================
// RENDERING
// =========================================================================

define({
  key: 'js_rendering',
  element: 'JavaScript rendering',
  group: 'Rendering',
  whatItTracks: 'How much of each page\'s content is present in the raw HTML, versus how much depends on JavaScript',
  whyItMatters: 'Every AI retrieval fetcher reads the served HTML and executes no JavaScript. Content that arrives by script is, to them, absent.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample;
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 18000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);

      // WHY THIS IS THREE VERDICTS AND NOT A WORD-COUNT THRESHOLD
      //
      // A word count alone gets index pages wrong, and gets them wrong in the
      // most damaging direction. A blog listing page on the first site this ran
      // against served 30 words of prose — and 23 headings and 131 links. It is
      // a perfectly rendered, fully readable index page; a bare threshold
      // reported it as "serves almost no content in its HTML", at critical
      // severity, alongside a genuine client-rendering failure. One
      // false positive of that size is enough to make someone stop reading the
      // whole board.
      //
      //   'ok'        substantial prose, or a page whose content IS its links
      //   'client'    little of either, AND evidence of client rendering
      //   'thin'      little of either, and no such evidence — a real problem,
      //               but a content problem, not a rendering one
      const words = doc.wordCount;
      const headings = doc.headings.length;
      // MAIN-REGION links only. A document-wide count classifies every page on
      // a normal site as an index page, because a header and footer alone carry
      // twenty links — which would let a genuinely blank client-rendered page
      // escape this check entirely.
      const links = doc.links.filter((l) => l.internal && l.inMain).length;
      // A navigational index: its job is to point elsewhere, and it does that
      // in the served HTML, which is all a retrieval fetcher needs from it.
      // The ratio test is what separates it from a thin page that happens to
      // have a few related links: on an index, the links ARE the content.
      const isIndexPage = links >= 10 && headings >= 5 && links > (words / 12);
      const hasProse = words >= 120;
      const renderMarkers = doc.spaMarker || doc.scriptCount >= 15;

      let verdict = 'ok';
      if (!hasProse && !isIndexPage) verdict = renderMarkers ? 'client' : 'thin';

      return {
        url: res.url, ok: true,
        servedWords: words,
        bodyWords: doc.bodyWordCount,
        scripts: doc.scriptCount,
        spaMarker: doc.spaMarker,
        headings,
        internalLinks: links,
        isIndexPage,
        verdict,
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const clientRendered = ok.filter((r) => r.verdict === 'client');
    const thin = ok.filter((r) => r.verdict === 'thin');
    const findings = [];

    if (clientRendered.length) {
      findings.push({
        checkKey: 'client_rendered_pages',
        title: `${clientRendered.length} of ${ok.length} sampled pages depend on JavaScript for their content`,
        detail: clientRendered.slice(0, 6).map((r) => `${r.url} — ${r.servedWords} words, ${r.headings} headings, ${r.internalLinks} internal links, ${r.scripts} scripts${r.spaMarker ? ', single-page-app markers present' : ''}`).join('; '),
        severity: 'critical',
        affectedCount: clientRendered.length,
        affectedUrl: clientRendered[0].url,
        action: 'Server-render or pre-render the main content. Googlebot does render JavaScript, on a delay; the AI retrieval fetchers do not render at all, so this is the single largest AI-visibility problem a site can have.',
        evidence: { pages: clientRendered },
      });
    }

    if (thin.length) {
      findings.push({
        checkKey: 'thin_served_html',
        title: `${thin.length} of ${ok.length} sampled pages serve little content and are not index pages`,
        detail: thin.slice(0, 6).map((r) => `${r.url} — ${r.servedWords} words, ${r.headings} headings, ${r.internalLinks} internal links`).join('; ')
          + '. No single-page-app markers and few scripts, so this is thin content rather than a rendering failure.',
        severity: 'medium',
        affectedCount: thin.length,
        affectedUrl: thin[0].url,
        action: 'Develop or consolidate these. Reported separately from client rendering because the fix is different: nothing here is hidden behind JavaScript, there simply is not much on the page.',
        evidence: { pages: thin },
      });
    }

    const problem = clientRendered.length + thin.length;
    const share = Math.round(((ok.length - problem) / ok.length) * 100);
    return {
      metrics: [
        { key: 'track.html_content_share', value: share, status: bandOf(share, 95, 70, { lowerIsBetter: false }) },
        { key: 'track.client_rendered_pages', value: clientRendered.length, status: clientRendered.length ? 'fail' : 'good' },
        { key: 'track.thin_served_pages', value: thin.length, status: thin.length ? 'warn' : 'good' },
        { key: 'track.index_pages_sampled', value: ok.filter((r) => r.isIndexPage).length, status: 'good', detail: 'excluded from the content-share ratio — their content is their links' },
      ],
      findings,
      detail: { sampled: ok.length, share, clientRendered: clientRendered.length, thin: thin.length, results: ok },
    };
  },
});

define({
  key: 'mobile_usability',
  element: 'Mobile usability',
  group: 'Rendering',
  whatItTracks: 'Viewport declaration, fixed-width layout hints, and font-size and tap-target problems reported by Lighthouse',
  whyItMatters: 'Mobile-first indexing means the mobile rendering is the one Google indexes, so a desktop-only page is indexed as a desktop-only page.',
  needs: ['crawler'],
  scope: 'page',
  async run(ctx) {
    const sample = ctx.sample.slice(0, 10);
    if (!sample.length) return { unknown: 'no URLs to sample' };
    const results = await mapLimit(sample, 4, async (url) => {
      const res = await fetchPage(url, { timeout: 15000 });
      if (!res.ok || !res.body) return { url, ok: false };
      const doc = parseDocument(res.url, res.body);
      const vp = String(doc.viewport || '');
      return {
        url: res.url, ok: true,
        hasViewport: doc.hasViewport,
        viewport: vp || null,
        // Two viewport mistakes that defeat the tag entirely.
        fixedWidth: /width\s*=\s*\d+/i.test(vp),
        zoomDisabled: /user-scalable\s*=\s*no/i.test(vp) || /maximum-scale\s*=\s*1(\.0)?\b/i.test(vp),
        // A fixed pixel width on a wrapper is the usual cause of horizontal
        // scrolling on mobile, and it is visible in the served HTML.
        fixedWidthStyles: (String(res.body).match(/style="[^"]*width\s*:\s*\d{3,}px/gi) || []).length,
      };
    });
    const ok = results.filter((r) => r && !r.__error && r.ok);
    if (!ok.length) return { unknown: 'no sampled URL returned a usable response' };

    const noViewport = ok.filter((r) => !r.hasViewport);
    const fixed = ok.filter((r) => r.fixedWidth);
    const zoomBlocked = ok.filter((r) => r.zoomDisabled);

    // Lighthouse's accessibility audits cover tap targets and font sizes,
    // which cannot be judged from HTML alone. Read once for the site, since
    // running it per URL would blow the PSI quota.
    let lighthouse = null;
    if (providers.has('psi')) {
      try {
        const psi = require('../psi');
        const raw = await psi.fetchReport(ctx.userId, { url: ctx.site, strategy: 'mobile' });
        const report = psi.normalise(raw.data);
        const a11y = (report.otherCategories || []).find((c) => c.id === 'accessibility');
        lighthouse = {
          accessibilityScore: a11y ? a11y.score : null,
          failing: a11y ? a11y.failing.slice(0, 10).map((f) => ({ title: f.title, score: f.score })) : [],
        };
      } catch (err) {
        lighthouse = { error: String(err.message).slice(0, 200) };
      }
    }

    const findings = [];
    if (noViewport.length) {
      findings.push({
        checkKey: 'no_viewport',
        title: `${noViewport.length} page${noViewport.length === 1 ? '' : 's'} have no viewport meta tag`,
        detail: noViewport.slice(0, 6).map((r) => r.url).join('; '),
        severity: 'high',
        affectedCount: noViewport.length,
        affectedUrl: noViewport[0].url,
        action: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        evidence: { pages: noViewport },
      });
    }
    if (fixed.length) {
      findings.push({
        checkKey: 'fixed_viewport',
        title: `${fixed.length} page${fixed.length === 1 ? '' : 's'} declare a fixed viewport width`,
        detail: fixed.slice(0, 6).map((r) => `${r.url}: ${r.viewport}`).join('; '),
        severity: 'high',
        affectedCount: fixed.length,
        affectedUrl: fixed[0].url,
        action: 'Use width=device-width. A pixel width makes the page render at that width on every device and scale, which is what mobile-first indexing sees.',
        evidence: { pages: fixed },
      });
    }
    if (zoomBlocked.length) {
      findings.push({
        checkKey: 'zoom_disabled',
        title: `${zoomBlocked.length} page${zoomBlocked.length === 1 ? '' : 's'} prevent zooming`,
        detail: zoomBlocked.slice(0, 6).map((r) => `${r.url}: ${r.viewport}`).join('; '),
        severity: 'medium',
        affectedCount: zoomBlocked.length,
        affectedUrl: zoomBlocked[0].url,
        action: 'Remove user-scalable=no and maximum-scale=1. Blocking zoom is an accessibility failure under WCAG 1.4.4 and Lighthouse reports it as one.',
        evidence: { pages: zoomBlocked },
      });
    }
    if (lighthouse && lighthouse.accessibilityScore != null && lighthouse.accessibilityScore < 0.9) {
      findings.push({
        checkKey: 'mobile_a11y',
        title: `Lighthouse mobile accessibility score is ${Math.round(lighthouse.accessibilityScore * 100)}`,
        detail: `Failing audits include: ${lighthouse.failing.slice(0, 5).map((f) => f.title).join('; ')}.`,
        severity: 'medium',
        affectedUrl: ctx.site,
        action: 'Tap-target size and font-size failures affect mobile usability directly; contrast and label failures affect every user.',
        evidence: lighthouse,
      });
    }

    return {
      metrics: [
        { key: 'track.viewport_coverage', value: Math.round(((ok.length - noViewport.length) / ok.length) * 100), status: noViewport.length ? 'fail' : 'good' },
        { key: 'track.mobile_viewport_problems', value: fixed.length + zoomBlocked.length, status: (fixed.length + zoomBlocked.length) ? 'warn' : 'good' },
        ...(lighthouse && lighthouse.accessibilityScore != null
          ? [{ key: 'track.mobile_a11y_score', value: Math.round(lighthouse.accessibilityScore * 100), status: bandOf(Math.round(lighthouse.accessibilityScore * 100), 90, 70, { lowerIsBetter: false }) }]
          : []),
      ],
      findings,
      detail: { sampled: ok.length, noViewport: noViewport.length, fixed: fixed.length, zoomBlocked: zoomBlocked.length, lighthouse, results: ok },
    };
  },
});

// =========================================================================
// AI RETRIEVAL
// =========================================================================

define({
  key: 'ai_crawler_access',
  element: 'AI crawler access',
  group: 'AI retrieval',
  whatItTracks: 'Whether each AI retrieval fetcher can actually read the site, tested both against robots.txt and by requesting the page as that agent',
  whyItMatters: 'A retrieval fetcher that is blocked cannot cite the brand in any answer. The usual cause is not robots.txt but an edge rule nobody knows about, which only a live request reveals.',
  needs: ['crawler'],
  scope: 'site',
  async run(ctx) {
    const readiness = require('./readiness');
    const robots = await fetchRobots(ctx.site);
    const baseline = await fetchPage(ctx.site, { timeout: 20000 });
    const doc = baseline.ok && baseline.body ? parseDocument(baseline.url, baseline.body) : null;
    const probes = baseline.ok
      ? await readiness.probeAgents(ctx.site, { agents: RETRIEVAL_AGENTS, baselineDoc: doc, baselineBytes: baseline.bytes })
      : [];
    const probeByKey = new Map(probes.map((p) => [p.key, p]));

    const agents = RETRIEVAL_AGENTS.map((a) => {
      const rv = robotsAllows(robots.parsed, a.token, '/');
      const probe = probeByKey.get(a.key) || null;
      let verdict = 'unknown';
      if (!rv.allowed) verdict = 'blocked';
      else if (probe && probe.challenge) verdict = 'blocked';
      else if (probe && probe.stripped) verdict = 'degraded';
      else if (probe && probe.ok) verdict = 'reachable';
      else if (!probe) verdict = 'allowed-by-robots';
      return {
        key: a.key, label: a.label, allowedByRobots: rv.allowed, rule: rv.rule,
        probeStatus: probe ? probe.status : null,
        challenge: probe ? probe.challenge : null,
        contentRatio: probe ? probe.contentRatio : null,
        verdict,
      };
    });

    const blocked = agents.filter((a) => a.verdict === 'blocked' || a.verdict === 'degraded');
    const llms = await fetchLlmsTxt(ctx.site);

    const findings = [];
    if (blocked.length) {
      findings.push({
        checkKey: 'ai_retrieval_blocked',
        title: `${blocked.length} of ${agents.length} AI retrieval fetchers cannot read this site`,
        detail: blocked.map((a) => `${a.label}: ${a.rule ? `robots.txt ${a.rule}` : (a.challenge || `HTTP ${a.probeStatus}`)}`).join('; '),
        severity: 'critical',
        affectedCount: blocked.length,
        affectedUrl: ctx.site,
        action: blocked.some((a) => a.rule)
          ? 'Remove the robots.txt rules for the retrieval agents; rules for training crawlers can stay if deliberate.'
          : 'robots.txt allows these, so the block is at the edge: Cloudflare bot-fight mode, a "block AI scrapers" plugin, or a WAF user-agent rule.',
        evidence: { agents: blocked },
      });
    }

    return {
      metrics: [
        { key: 'track.ai_retrieval_ok', value: agents.length - blocked.length, status: blocked.length ? 'fail' : 'good', detail: `${agents.length - blocked.length} of ${agents.length}` },
        { key: 'track.llms_txt', value: llms.present ? 1 : 0, status: llms.present ? 'good' : 'unknown', detail: llms.present ? 'present' : 'absent (optional; not used by Google)' },
      ],
      findings,
      detail: { agents, llms, robotsPresent: robots.present, baselineStatus: baseline.status },
    };
  },
});

// =========================================================================

function all() { return CATALOG; }
function get(key) { return CATALOG.find((c) => c.key === key) || null; }

function grouped() {
  const map = new Map(GROUP_ORDER.map((g) => [g, []]));
  CATALOG.forEach((c) => {
    if (!map.has(c.group)) map.set(c.group, []);
    map.get(c.group).push(c);
  });
  return [...map.entries()].filter(([, items]) => items.length).map(([group, items]) => ({ group, items }));
}

// Which checks can run given what is configured, and why the rest cannot.
function availability() {
  return CATALOG.map((c) => {
    const missing = (c.needs || []).filter((n) => !providers.has(n));
    return {
      key: c.key,
      element: c.element,
      group: c.group,
      whatItTracks: c.whatItTracks,
      whyItMatters: c.whyItMatters,
      scope: c.scope,
      sitewideCapable: Boolean(c.sitewideCapable),
      needs: c.needs,
      available: missing.length === 0,
      missing: missing.map((m) => {
        const p = providers.get(m);
        return { key: m, label: p ? p.label : m, note: p ? p.note : null };
      }),
    };
  });
}

module.exports = { all, get, grouped, GROUP_ORDER, availability, bandOf };
