// EVIDENCE COLLECTION for a client report, from nothing but a URL.
//
// WHAT IS DIFFERENT ABOUT A PROSPECT
// Every other report in this app is built for a brand that has connected
// Search Console and Analytics. A prospect has connected nothing - that is the
// point of the feature - so this module is restricted to what can be measured
// from the outside: a crawl, a PageSpeed run, a robots and schema read, and
// Google's own keyword data seeded from the domain.
//
// The consequence is stated in the report rather than hidden: current Google
// rankings and actual traffic are NOT knowable from outside, and this file
// never estimates them. See ./build.js, which carries that limitation into the
// document as a section rather than a footnote.
//
// EVERY STEP IS OPTIONAL
// Each collector is wrapped so that a failure - a timeout, an exhausted API
// quota, a site that blocks one user agent - costs the report that section and
// nothing else. A report missing its speed section is a smaller loss than a
// sales meeting with no report at all, and `ok: false` plus the reason is what
// lets the document say which is which.
//
// STEPS RUN IN SEQUENCE, NOT IN PARALLEL
// Deliberate. Several of these crawl, this deployment has a small memory
// allowance on shared hosting, and the AI SEO runner already limits itself to
// two concurrent analyses for the same reason. A report that finishes in six
// minutes beats one that gets the process killed at four.
const db = require('../../db');
const toolRunner = require('../toolRunner');
const psi = require('../psi');
const fetcher = require('../aiseo/fetcher');
const siteReadiness = require('../aiseo/siteReadiness');
const schemaAuto = require('../aiseo/schemaAuto');
const serpLite = require('../aiseo/serpLite');
const planner = require('../aiseo/keywordPlanner');
const markets = require('../aiseo/markets');

const { normalizeUrl, hostKey, fetchPage, sleep } = fetcher;

// Depth profiles. The form offers these two; everything that costs time or an
// API call is a number in here rather than a literal further down, so the
// difference between a quick scan and a full report is readable in one place.
const PROFILES = {
  quick: {
    label: 'Quick scan',
    crawlPages: 40,
    readinessPages: 25,
    psiUrls: 1,
    psiDesktop: false,
    keywordIdeas: 60,
    serpChecks: 8,
    linking: false,
    estimate: '3-5 minutes',
  },
  full: {
    label: 'Full report',
    crawlPages: 150,
    readinessPages: 80,
    psiUrls: 3,
    psiDesktop: true,
    keywordIdeas: 150,
    serpChecks: 20,
    linking: true,
    estimate: '10-20 minutes',
  },
};

// A crawl can take minutes; a stuck one must not hold the report forever.
const CRAWL_TIMEOUT_MS = Number(process.env.CLIENT_REPORT_CRAWL_TIMEOUT_MS || 12 * 60 * 1000);
const CRAWL_POLL_MS = 4000;

function profile(depth) {
  return PROFILES[depth] || PROFILES.full;
}

// Wraps a collector so one failed source never takes the report with it.
// The returned envelope is what build.js reads: `ok` decides whether a section
// renders, and `error` is what the internal view shows the team.
async function attempt(name, fn) {
  const startedMs = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, value, error: null, ms: Date.now() - startedMs };
  } catch (err) {
    return {
      name, ok: false, value: null, ms: Date.now() - startedMs,
      error: (err && err.message) || String(err),
    };
  }
}

// --------------------------------------------------------------- the site

// The first thing read, and the only step whose failure stops the report:
// if the homepage cannot be fetched there is nothing to audit, and a document
// full of empty sections is worse than an honest refusal.
async function readHomepage(url) {
  const res = await fetchPage(url, { timeout: 25000 });
  if (!res.ok || !res.body) {
    throw new Error(`The site did not return a readable page: ${res.status || res.error || 'no response'}.`);
  }
  const finalUrl = res.url || url;
  const doc = fetcher.parseDocument(finalUrl, res.body);
  const $ = fetcher.load(res.body);
  const title = String(doc.title || '').trim();
  return {
    url: finalUrl,
    status: res.status,
    title,
    // The company name a client report is addressed to. Taken from the site's
    // own branding rather than the domain, because "Acme Dental Care" on the
    // cover page is the difference between a document that was written for
    // them and one that was generated at them. The sales rep can override it.
    inferredCompany: inferCompany({ title, doc, $, url: finalUrl }),
    metaDescription: String(doc.metaDesc || '').trim() || null,
    h1: (doc.h1s || [])[0] || null,
    wordCount: doc.wordCount || 0,
    lang: doc.lang || null,
    // Carried so build.js can say whether the content is in the served HTML at
    // all - the single most consequential thing to know about a modern site,
    // because no AI retrieval fetcher runs JavaScript.
    spaMarker: Boolean(doc.spaMarker),
    jsonLdBlocks: (doc.jsonLd || []).length,
  };
}

// Order matters: an explicit organisation name beats the title, and the title
// beats the domain. Every fallback is a real string, so the cover page can
// never print "undefined".
function inferCompany({ title, doc, $, url }) {
  try {
    const orgNode = (doc.jsonLd || [])
      .filter((b) => b && b.ok && b.data)
      .map((b) => b.data)
      .flatMap((j) => (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])]))
      .filter(Boolean)
      .find((n) => n && /organization|localbusiness|store|corporation/i.test(String(n['@type'] || '')) && n.name);
    if (orgNode && String(orgNode.name).trim()) return String(orgNode.name).trim().slice(0, 120);
  } catch { /* fall through to the title */ }

  const og = $('meta[property="og:site_name"]').first().attr('content');
  if (og && og.trim()) return og.trim().slice(0, 120);

  // Site titles are overwhelmingly "Brand | What they do" or "Page - Brand".
  // Taking the shorter, more name-like half beats taking the whole string.
  if (title) {
    const parts = title.split(/\s+[|–—·-]\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const candidate = parts[parts.length - 1].length <= parts[0].length ? parts[parts.length - 1] : parts[0];
      if (candidate.length >= 2 && candidate.length <= 60) return candidate.slice(0, 120);
    }
    if (title.length <= 60) return title;
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const base = host.split('.')[0].replace(/[-_]+/g, ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch { return 'This website'; }
}

// ------------------------------------------------------------- the crawl

// Drives the existing technical audit and waits for it.
//
// The crawler runs as a separate process with its own run row, which is what
// makes it a good citizen here: the team can open /audit/<id> and see the raw
// evidence behind every issue the client report describes, and deleting the
// client report does not delete that evidence.
function startCrawl({ userId, url, maxPages }) {
  return toolRunner.startAudit({
    userId,
    brandId: null,
    domain: url,
    maxPages,
    render: 'auto',
    // A prospect audit must not fill the team's task board with work for a
    // site they have not been hired to fix.
    createTasks: false,
    auth: null,
    force: false,
  });
}

async function waitForCrawl(runId, { timeoutMs = CRAWL_TIMEOUT_MS, onTick = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare('SELECT id, status, error, json_result, log_tail FROM audit_runs WHERE id=?').get(runId);
    if (!row) throw new Error('The crawl record disappeared while it was running.');
    if (row.status === 'completed') {
      let parsed = null;
      try { parsed = JSON.parse(row.json_result); } catch { parsed = null; }
      if (!parsed) throw new Error('The crawl finished but its result could not be read.');
      return parsed;
    }
    if (row.status === 'error') throw new Error(row.error || 'The crawl failed.');
    // Someone stopped it from the audit page while the report was waiting.
    if (row.status === 'cancelled') throw new Error('The crawl was cancelled before it finished.');
    if (Date.now() > deadline) {
      // Cancelled rather than abandoned: the child process would otherwise
      // keep crawling a site nobody is waiting for, on a host with a small
      // memory allowance.
      try { toolRunner.cancel('audit', runId); } catch { /* best effort */ }
      throw new Error(`The crawl did not finish within ${Math.round(timeoutMs / 60000)} minutes and was stopped.`);
    }
    if (onTick) {
      const lines = String(row.log_tail || '').split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('{') && !l.startsWith('"') && !l.startsWith('}'));
      onTick(lines[lines.length - 1] || null);
    }
    await sleep(CRAWL_POLL_MS);
  }
}

// ------------------------------------------------------------- page speed

// PSI is the slowest single call in the report (30-60s is normal), so the URL
// list is capped by the profile and desktop is only run on the full report.
//
// Note the userId: PageSpeed authorises the PRINCIPAL, so the agency's own
// Google connection is what pays for these calls. The prospect has connected
// nothing, and needs to have connected nothing.
async function runPagespeed({ userId, urls, wantDesktop }) {
  const out = [];
  for (const url of urls) {
    const mobile = await psi.fetchReport(userId, { url, strategy: 'mobile' });
    out.push({ url, strategy: 'mobile', report: psi.normalise(mobile) });
    if (wantDesktop) {
      try {
        const desktop = await psi.fetchReport(userId, { url, strategy: 'desktop' });
        out.push({ url, strategy: 'desktop', report: psi.normalise(desktop) });
      } catch (err) {
        // A desktop failure must not lose the mobile result already in hand.
        // Mobile is the one that matters for ranking anyway.
        out.push({ url, strategy: 'desktop', report: null, error: err.message });
      }
    }
  }
  return out;
}

// Which pages to measure. The homepage always, then the two most linked-to
// pages the crawl found - which is the closest thing to "the pages that matter"
// available without analytics.
function speedTargets(homepageUrl, crawl, limit) {
  const urls = [homepageUrl];
  if (crawl && Array.isArray(crawl.findings)) {
    const seen = new Set([homepageUrl.replace(/\/$/, '')]);
    const candidates = [];
    crawl.findings.forEach((f) => {
      (f.items || []).forEach((it) => {
        const u = it && it.url;
        if (!u || !/^https?:\/\//i.test(u)) return;
        const norm = u.replace(/\/$/, '');
        if (seen.has(norm)) return;
        seen.add(norm);
        candidates.push(u);
      });
    });
    // Shortest paths first: on almost every site the shallowest URLs are the
    // service and category pages, and the deep ones are individual articles.
    candidates.sort((a, b) => a.length - b.length);
    urls.push(...candidates.slice(0, Math.max(0, limit - 1)));
  }
  return urls.slice(0, limit);
}

// --------------------------------------------------------------- keywords

// Google's own search volumes, seeded from the domain.
//
// This is the one number in the whole report that comes from Google Ads rather
// than from our own measurement, and it is the reason the keyword section can
// exist at all for a site with no Search Console: `siteSeed` asks Google what
// this domain is about and what people search for around it.
//
// A TEST-access developer token authenticates and returns nothing, which is
// why an empty result is reported as "no rows", never as a failure.
async function keywordDemand({ userId, url, market, limit }) {
  const res = await planner.ideas(userId, {
    url,
    seedMode: 'site',
    market,
    pageSize: Math.max(50, Math.min(500, limit * 3)),
    annotations: true,
  });
  const rows = (res.rows || [])
    .filter((r) => Number(r.volume || 0) > 0)
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, limit);
  return { ...res, rows, market: markets.resolve(market).code };
}

// Is the site visible for the terms it should own?
//
// SAMPLED FROM A NON-GOOGLE INDEX, and labelled that way everywhere it is
// shown. This deployment holds no SERP API credential, and scraping Google is
// both against its terms and unreliable enough that a blocked scrape would
// degrade silently to "no competition found" - the worst possible failure for a
// number a client is about to read. See lib/aiseo/serpLite.js.
async function visibilitySample({ domain, keywords, market, limit }) {
  const want = String(domain || '').replace(/^www\./, '').toLowerCase();
  const checked = [];
  for (const kw of keywords.slice(0, limit)) {
    const base = {
      keyword: kw.keyword,
      volume: kw.volume ?? null,
      competition: kw.competition || null,
      topBidHigh: kw.highBid ?? null,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      const serp = await serpLite.search(kw.keyword, { market, limit: 20 });
      if (!serp.ok) {
        // The sample itself failed. "Unknown", never "not ranking" - recording
        // it as the latter would turn a throttled request into a finding about
        // the client's site.
        checked.push({ ...base, position: null, visible: null, engine: null, rivals: [], note: serp.error || 'no sample' });
        continue;
      }
      const hit = serpLite.positionOf(serp, want);
      const rivals = (serp.results || [])
        .filter((r) => r.domain && r.domain !== want)
        .slice(0, 3)
        .map((r) => r.domain);
      checked.push({
        ...base,
        position: hit ? hit.position : null,
        visible: Boolean(hit),
        engine: serp.engine || null,
        rivals,
      });
    } catch (err) {
      checked.push({ ...base, position: null, visible: null, engine: null, rivals: [], note: err.message });
    }
  }
  return checked;
}

// ----------------------------------------------------------------- linking

// The internal linking crawler, for orphan pages and cannibalisation. Full
// reports only: it is a second full crawl of the site.
function startLinking({ userId, url, maxPages }) {
  return toolRunner.startLinking({
    userId, brandId: null, siteUrl: url, maxPages,
    useGsc: false, render: false, createTasks: false, auth: null, force: false,
  });
}

async function waitForLinking(runId, { timeoutMs = CRAWL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare('SELECT status, error, json_result FROM linking_runs WHERE id=?').get(runId);
    if (!row) throw new Error('The linking record disappeared while it was running.');
    if (row.status === 'completed') {
      try { return JSON.parse(row.json_result); } catch { throw new Error('The linking result could not be read.'); }
    }
    if (row.status === 'error') throw new Error(row.error || 'The linking crawl failed.');
    if (row.status === 'cancelled') throw new Error('The internal-link crawl was cancelled before it finished.');
    if (Date.now() > deadline) {
      try { toolRunner.cancel('linking', runId); } catch { /* best effort */ }
      throw new Error('The internal-link crawl did not finish in time and was stopped.');
    }
    await sleep(CRAWL_POLL_MS);
  }
}

module.exports = {
  PROFILES, profile, attempt,
  readHomepage, inferCompany,
  startCrawl, waitForCrawl, speedTargets,
  runPagespeed, keywordDemand, visibilitySample,
  startLinking, waitForLinking,
  siteReadiness, schemaAuto,
  normalizeUrl, hostKey,
};
