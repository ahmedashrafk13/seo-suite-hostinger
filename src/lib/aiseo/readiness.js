// 4. TECHNICAL SEO AND AI-CRAWLER READINESS
//
// The question this answers is narrower and more useful than "is the site
// technically sound": can each AI retrieval system reach this page, read the
// content in the HTML it is served, and do it fast enough not to time out?
//
// THE DISTINCTION EVERY "AI CRAWLER CHECK" GETS WRONG
// There are two kinds of AI user agent and they have opposite implications:
//
//   TRAINING crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended,
//   Applebot-Extended) collect text for model training. Blocking them costs a
//   brand nothing in visibility. Plenty of publishers block them deliberately.
//
//   RETRIEVAL fetchers (OAI-SearchBot, ChatGPT-User, PerplexityBot,
//   Perplexity-User, Claude-User, Googlebot, Bingbot) fetch a page at the
//   moment a user asks a question, in order to cite it. Blocking one of these
//   means the brand cannot appear in that assistant's answers at all.
//
// A tool that reports "8 AI bots blocked" without that split tells a publisher
// who deliberately blocked training crawlers that they have a problem, and
// tells a site whose WAF is silently 403ing PerplexityBot that they are fine.
// So every check here is reported per agent, with its purpose stated.
//
// ROBOTS.TXT IS NOT ENOUGH, AND THAT IS THE MOST COMMON REAL FAILURE
// The dominant cause of an AI fetcher being unable to read a page is not a
// robots.txt rule someone wrote. It is an edge rule nobody knows about: a
// Cloudflare bot-fight setting, a security plugin's "block AI scrapers"
// toggle, a WAF rule matching on user agent. Those return 403 or a challenge
// page while robots.txt says Allow. The only way to find them is to make the
// request as that agent and look at what comes back — which is what this does.
const store = require('./store');
const providers = require('./providers');
const psi = require('../psi');
const {
  AI_AGENTS, fetchPage, measureTtfb, inspectCertificate,
  parseDocument, fetchRobots, robotsAllows, fetchLlmsTxt, fetchSitemapUrls,
  normalizeUrl, mapLimit,
} = require('./fetcher');

// Thresholds, taken from the requirement and from Google's own published
// Core Web Vitals bands. Where the requirement is stricter than Google's, both
// are reported — a site at LCP 2.3s passes Google and misses the brief, and
// conflating those two produces an argument nobody can settle.
const THRESHOLDS = {
  ttfbMs: { target: 200, googleGood: 800, googleNeedsWork: 1800 },
  loadMs: { target: 1000 },
  lcpMs: { target: 2000, googleGood: 2500, googleNeedsWork: 4000 },
  inpMs: { target: 200, googleGood: 200, googleNeedsWork: 500 },
  cls: { target: 0.1, googleGood: 0.1, googleNeedsWork: 0.25 },
};

// A challenge or block page dressed as a 200. Cloudflare, Akamai and several
// WAFs answer a suspicious user agent with HTTP 200 and an interstitial, so
// status alone cannot decide whether an agent can read the page.
function looksLikeChallenge(body, status) {
  if (status === 403 || status === 401 || status === 429) return { blocked: true, why: `HTTP ${status}` };
  const head = String(body || '').slice(0, 4000).toLowerCase();
  const markers = [
    ['cf-browser-verification', 'Cloudflare browser verification'],
    ['checking your browser before accessing', 'Cloudflare interstitial'],
    ['just a moment...', 'Cloudflare "Just a moment" challenge'],
    ['/cdn-cgi/challenge-platform', 'Cloudflare challenge platform'],
    ['attention required! | cloudflare', 'Cloudflare block page'],
    ['access denied', 'an access-denied page'],
    ['request unsuccessful. incapsula', 'Imperva/Incapsula block'],
    ['ddos protection by', 'a DDoS-protection interstitial'],
    ['enable javascript and cookies to continue', 'a JavaScript/cookie gate'],
    ['<title>403', 'a 403 page served with a 200 status'],
  ];
  for (const [needle, label] of markers) {
    if (head.includes(needle)) return { blocked: true, why: label };
  }
  return { blocked: false };
}

// Fetches the page once as each agent and compares what came back against
// what a normal browser gets.
//
// Comparing CONTENT LENGTH, not just status, is what catches the subtler
// failure: some edge configurations serve an AI agent a stripped page, or a
// consent wall, with a 200 and no challenge marker. A body that is a fraction
// of the browser's is a real problem even though every status code says fine.
async function probeAgents(url, { agents = AI_AGENTS, baselineDoc = null, baselineBytes = 0 } = {}) {
  const probeable = agents.filter((a) => a.ua);
  const results = await mapLimit(probeable, 3, async (agent) => {
    const res = await fetchPage(url, { ua: agent.ua, timeout: 20000 });
    const challenge = looksLikeChallenge(res.body, res.status);
    let contentRatio = null;
    let textRatio = null;
    if (res.ok && res.body && baselineBytes > 0) {
      contentRatio = Math.round((res.bytes / baselineBytes) * 100) / 100;
      if (baselineDoc) {
        const doc = parseDocument(res.url, res.body);
        textRatio = baselineDoc.wordCount > 0
          ? Math.round((doc.wordCount / baselineDoc.wordCount) * 100) / 100
          : null;
      }
    }
    // "Served a different page" is only claimed when the shortfall is large.
    // Personalisation, A/B tests and cache variants move byte counts by a few
    // per cent on every site, and reporting that as bot cloaking would make
    // the check useless.
    const stripped = contentRatio != null && contentRatio < 0.6;
    return {
      key: agent.key,
      token: agent.token,
      label: agent.label,
      purpose: agent.purpose,
      status: res.status,
      ok: res.ok,
      error: res.error,
      bytes: res.bytes,
      ms: res.totalMs,
      challenge: challenge.blocked ? challenge.why : null,
      contentRatio,
      textRatio,
      stripped,
      reachable: Boolean(res.ok && !challenge.blocked && !stripped),
    };
  });
  return results.filter((r) => r && !r.__error);
}

// A blocked bot user agent means one of two very different things, and without
// a control probe there is no way to tell them apart.
//
//   TARGETED BLOCK: the edge holds a denylist of AI user-agent tokens. An
//   unknown-but-harmless user agent sails through; anything with "GPTBot" in
//   it gets a 403. The real crawler is blocked too, and this is a genuine,
//   fixable visibility problem.
//
//   UNVERIFIED-CLIENT BLOCK: the edge rejects every client it cannot verify,
//   AI token or not. Cloudflare's verified-bot enforcement is the common case.
//   The real GPTBot, arriving from OpenAI's published IP range with matching
//   reverse DNS, is verified and let through — while this tool, impersonating
//   it from an ordinary IP, is not. Reporting that as "GPTBot is blocked" is a
//   false positive, and it is the single biggest way a check like this lies.
//
// The control is a user agent that is unmistakably not a browser and not on
// any AI denylist. If it is refused alongside the AI agents, the block is not
// about AI and the verdict is downgraded accordingly.
const CONTROL_UA = 'Mozilla/5.0 (compatible; ReadinessControl/1.0; +https://example.invalid/control)';

async function probeControls(url) {
  const res = await fetchPage(url, { ua: CONTROL_UA, timeout: 20000 });
  const challenge = looksLikeChallenge(res.body, res.status);
  return {
    ua: CONTROL_UA,
    status: res.status,
    ok: Boolean(res.ok && !challenge.blocked),
    error: res.error,
    challenge: challenge.blocked ? challenge.why : null,
    // When this is false the edge refuses unrecognised clients as a class, so
    // a refusal of an AI agent proves nothing about that agent specifically.
    discriminates: Boolean(res.ok && !challenge.blocked),
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, url = null, includePsi = true, probeEdge = true, force = false,
}) {
  const brandId = brand ? brand.id : null;
  const target = normalizeUrl(url || (brand && brand.site_url));
  if (!target) throw new Error('Give a URL, or pick a brand with a site URL.');

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'readiness', target,
    params: { url: target, includePsi, probeEdge },
  });

  try {
    const sources = ['crawler'];
    let origin = target;
    try { origin = new URL(target).origin; } catch { /* keep */ }

    // --- baseline fetch, as a browser -----------------------------------
    const baseline = await fetchPage(target, { timeout: 25000 });
    const doc = baseline.ok && baseline.body ? parseDocument(baseline.url, baseline.body) : null;

    // --- robots.txt, per agent -----------------------------------------
    const robots = await fetchRobots(target);
    let path = '/';
    try { path = new URL(target).pathname || '/'; } catch { /* keep */ }
    const robotsVerdicts = AI_AGENTS.map((agent) => {
      const v = robotsAllows(robots.parsed, agent.token, path);
      return {
        key: agent.key, token: agent.token, label: agent.label, purpose: agent.purpose,
        allowed: v.allowed, rule: v.rule, matchedAgent: v.matchedAgent,
      };
    });

    // --- edge probe -----------------------------------------------------
    let probes = [];
    let control = null;
    if (probeEdge && baseline.ok) {
      // The control goes first: every agent verdict below is read against it.
      control = await probeControls(target);
      probes = await probeAgents(target, {
        agents: AI_AGENTS,
        baselineDoc: doc,
        baselineBytes: baseline.bytes,
      });
    }
    const probeByKey = new Map(probes.map((p) => [p.key, p]));
    // True when a plain unrecognised client got through, which is what makes a
    // refusal of an AI agent attributable to that agent rather than to blanket
    // anti-bot enforcement.
    const controlDiscriminates = Boolean(control && control.discriminates);

    // Merged per-agent verdict: robots says one thing, the wire says another,
    // and the wire wins — an Allow line is worth nothing if the WAF 403s.
    const agentStatus = robotsVerdicts.map((v) => {
      const probe = probeByKey.get(v.key) || null;
      let verdict = 'unknown';
      let reason = null;
      if (!v.allowed) { verdict = 'blocked'; reason = `robots.txt: ${v.rule}`; }
      else if (probe && probe.challenge && controlDiscriminates) {
        verdict = 'blocked';
        reason = `robots.txt allows it, but the server answered with ${probe.challenge} — while an unrecognised control agent was served normally, so the block targets this user agent specifically`;
      } else if (probe && probe.challenge) {
        // The edge refused the control too. It refuses unverified clients as a
        // class, and the real crawler authenticates by source IP and reverse
        // DNS, which cannot be reproduced here. Calling this "blocked" would be
        // a guess presented as a measurement.
        verdict = 'unverifiable';
        reason = `the server answered with ${probe.challenge}, but it answered the same way to a neutral control agent — this edge refuses every client it cannot verify, and the real crawler may still be let through on its published IP range. Confirm in server logs.`;
      }
      else if (probe && probe.stripped) { verdict = 'degraded'; reason = `served ${Math.round(probe.contentRatio * 100)}% of the bytes a browser gets — the content may be stripped for this agent`; }
      else if (probe && probe.ok) { verdict = 'reachable'; reason = `HTTP ${probe.status} with a full-size body`; }
      else if (probe && probe.error) { verdict = 'unknown'; reason = `probe failed: ${probe.error}`; }
      else if (!probe) { verdict = v.allowed ? 'allowed-by-robots' : 'blocked'; reason = 'no live probe (this agent publishes no user-agent string to test with)'; }
      return { ...v, probe, verdict, reason };
    });

    const retrievalBlocked = agentStatus.filter((a) => a.purpose === 'retrieval' && (a.verdict === 'blocked' || a.verdict === 'degraded'));
    const trainingBlocked = agentStatus.filter((a) => a.purpose === 'training' && a.verdict === 'blocked');
    // Reported apart from the confirmed blocks, and never mixed into them: an
    // unverifiable agent is a thing to go and check in the logs, not a finding.
    const retrievalUnverifiable = agentStatus.filter((a) => a.purpose === 'retrieval' && a.verdict === 'unverifiable');

    // --- speed ----------------------------------------------------------
    const ttfb = await measureTtfb(target, { samples: 3 });
    const cert = await inspectCertificate(target);

    // --- field and lab performance --------------------------------------
    let psiReport = null;
    let cruxRaw = null;
    if (includePsi && providers.has('psi')) {
      try {
        const raw = await psi.fetchReport(userId, { url: target, strategy: 'mobile' });
        psiReport = psi.normalise(raw.data);
        // normalise() formats field values for display ("2.4 s") and drops the
        // raw percentile, which is what a threshold comparison needs. The
        // page-level CrUX record is preferred; the origin record is the
        // fallback, because a URL with too little traffic has no page-level
        // data at all and reporting "no field data" there would hide a real
        // sitewide problem.
        cruxRaw = (raw.data && raw.data.loadingExperience && raw.data.loadingExperience.metrics)
          ? { metrics: raw.data.loadingExperience.metrics, scope: 'url' }
          : ((raw.data && raw.data.originLoadingExperience && raw.data.originLoadingExperience.metrics)
            ? { metrics: raw.data.originLoadingExperience.metrics, scope: 'origin' }
            : null);
        sources.push('psi');
      } catch (err) {
        psiReport = { error: String(err.message).slice(0, 300) };
      }
    }

    // --- llms.txt and sitemaps ------------------------------------------
    const llms = await fetchLlmsTxt(target);
    const sitemap = await fetchSitemapUrls(target, { limit: 500, robots });

    // --- indexability ---------------------------------------------------
    const robotsMeta = doc ? String(doc.robotsMeta || '') : '';
    const xRobots = String((baseline.headers || {})['x-robots-tag'] || '');
    const noindex = /noindex/i.test(robotsMeta) || /noindex/i.test(xRobots);
    const nosnippet = /nosnippet|max-snippet\s*:\s*0/i.test(robotsMeta) || /nosnippet|max-snippet\s*:\s*0/i.test(xRobots);

    // --- security headers -----------------------------------------------
    const h = baseline.headers || {};
    const security = {
      hsts: h['strict-transport-security'] || null,
      csp: h['content-security-policy'] || null,
      xContentType: h['x-content-type-options'] || null,
      referrerPolicy: h['referrer-policy'] || null,
      permissionsPolicy: h['permissions-policy'] || null,
      xFrameOptions: h['x-frame-options'] || null,
    };

    // --- JavaScript dependence ------------------------------------------
    // The single most damaging AI-readiness problem, and invisible in a
    // browser. Every AI retrieval fetcher reads the served HTML and executes
    // no JavaScript. A page whose content arrives via script is, to them, a
    // blank page — while looking perfect to the author.
    const jsDependence = doc ? {
      spaMarker: doc.spaMarker,
      scriptCount: doc.scriptCount,
      servedWordCount: doc.wordCount,
      servedBodyWordCount: doc.bodyWordCount,
      // The threshold is deliberately low. A page serving under 120 words with
      // SPA markers present is almost certainly rendering client-side; a page
      // serving 400 words is delivering readable content whatever else it does.
      likelyClientRendered: Boolean(doc.spaMarker && doc.wordCount < 120),
      contentInHtml: doc.wordCount >= 120,
    } : null;

    // ------------------------------------------------------------ findings
    const findings = [];
    const metrics = [];

    if (!baseline.ok) {
      findings.push({
        checkKey: 'unreachable',
        title: `The page is not reachable: ${baseline.error || `HTTP ${baseline.status}`}`,
        detail: 'Nothing else on this report can be trusted while the page does not return a 200 to a normal browser.',
        severity: 'critical',
        affectedUrl: target,
        action: 'Fix availability first, then re-run.',
        dedupeKey: `readiness:unreachable:${target}`,
      });
    }

    if (retrievalBlocked.length) {
      findings.push({
        checkKey: 'ai_retrieval_blocked',
        title: `${retrievalBlocked.length} AI retrieval fetcher${retrievalBlocked.length === 1 ? '' : 's'} cannot read this page`,
        detail: retrievalBlocked.map((a) => `${a.label}: ${a.reason}`).join('; ')
          + '. These fetch pages at the moment a user asks a question, in order to cite them — while they are blocked, this page cannot appear in those assistants\' answers.',
        severity: 'critical',
        affectedUrl: target,
        affectedCount: retrievalBlocked.length,
        action: retrievalBlocked.some((a) => a.reason && a.reason.startsWith('robots.txt:'))
          ? 'Remove the robots.txt rules blocking the retrieval agents (keep any training-crawler rules you set deliberately), then confirm with a live probe.'
          : 'robots.txt allows these agents, so the block is at the edge: check Cloudflare bot-fight mode, any "block AI scrapers" plugin, and WAF user-agent rules.',
        evidence: { agents: retrievalBlocked },
        dedupeKey: `readiness:retrieval_blocked:${target}`,
      });
    }

    if (retrievalUnverifiable.length) {
      findings.push({
        checkKey: 'ai_retrieval_unverifiable',
        title: `${retrievalUnverifiable.length} AI retrieval fetcher${retrievalUnverifiable.length === 1 ? '' : 's'} could not be tested — the edge blocks all unverified clients`,
        detail: `${retrievalUnverifiable.map((a) => a.label).join(', ')}. Each was refused, but so was a neutral control agent, so the refusal is blanket anti-bot enforcement rather than an AI-specific rule. Cloudflare and similar edges verify a crawler by source IP and reverse DNS, which this probe cannot reproduce — the real fetcher may well be admitted. This is deliberately not reported as a block, because guessing either way would be wrong.`,
        severity: 'medium',
        affectedUrl: target,
        affectedCount: retrievalUnverifiable.length,
        action: 'Settle it from the server side: grep the access logs for these user agents and check whether the requests carried a verified-bot signature. If the edge has a "verified bots" allowlist, confirm these agents are on it.',
        evidence: { agents: retrievalUnverifiable, control },
        dedupeKey: `readiness:retrieval_unverifiable:${target}`,
      });
    }

    if (trainingBlocked.length) {
      findings.push({
        checkKey: 'ai_training_blocked',
        title: `${trainingBlocked.length} AI training crawler${trainingBlocked.length === 1 ? ' is' : 's are'} blocked`,
        detail: `${trainingBlocked.map((a) => a.label).join(', ')}. This is reported for completeness, not as a problem — blocking training crawlers does not affect whether the brand can be cited in AI answers, and many publishers block them deliberately.`,
        severity: 'info',
        affectedUrl: target,
        affectedCount: trainingBlocked.length,
        action: 'No action needed unless the block was unintentional.',
        evidence: { agents: trainingBlocked },
        dedupeKey: `readiness:training_blocked:${target}`,
      });
    }

    if (jsDependence && jsDependence.likelyClientRendered) {
      findings.push({
        checkKey: 'client_rendered',
        title: 'The served HTML carries almost no content — the page is rendered by JavaScript',
        detail: `The HTML this server returns contains ${jsDependence.servedWordCount} words of main content and shows single-page-app markers. Every AI retrieval fetcher reads this HTML and runs no JavaScript, so to them the page is effectively blank. Googlebot does render, but on a delay and not always.`,
        severity: 'critical',
        affectedUrl: target,
        action: 'Server-render or pre-render the main content so it is present in the initial HTML response. This is the single highest-impact AI-visibility fix available on a client-rendered site.',
        evidence: jsDependence,
        dedupeKey: `readiness:client_rendered:${target}`,
      });
    }

    if (ttfb.ms != null) {
      metrics.push({ key: 'readiness.ttfb_ms', url: target, value: ttfb.ms, status: ttfb.ms <= THRESHOLDS.ttfbMs.target ? 'good' : (ttfb.ms <= THRESHOLDS.ttfbMs.googleGood ? 'warn' : 'fail') });
      if (ttfb.ms > THRESHOLDS.ttfbMs.target) {
        const beyondGoogle = ttfb.ms > THRESHOLDS.ttfbMs.googleGood;
        findings.push({
          checkKey: 'ttfb',
          title: `Time to first byte is ${ttfb.ms}ms (target ${THRESHOLDS.ttfbMs.target}ms)`,
          detail: `Median of ${ttfb.samples.filter((s) => s != null).length} samples: ${ttfb.samples.map((s) => (s == null ? 'failed' : `${s}ms`)).join(', ')}. `
            + (beyondGoogle
              ? `This is also past Google's 800ms "good" boundary, so it is costing Core Web Vitals as well as risking retrieval timeouts.`
              : `This still sits inside Google's 800ms "good" band, so it is a stretch target rather than a Core Web Vitals failure.`),
          severity: beyondGoogle ? 'high' : 'low',
          affectedUrl: target,
          action: 'Server response time is the fix: caching layer, database query time, or origin location. A CDN in front of an uncached origin does not improve TTFB for a first request.',
          evidence: { ttfb, thresholds: THRESHOLDS.ttfbMs },
          dedupeKey: `readiness:ttfb:${target}`,
        });
      }
    }

    if (baseline.totalMs != null) {
      metrics.push({ key: 'readiness.html_load_ms', url: target, value: baseline.totalMs, status: baseline.totalMs <= THRESHOLDS.loadMs.target ? 'good' : 'warn' });
      if (baseline.totalMs > THRESHOLDS.loadMs.target) {
        findings.push({
          checkKey: 'html_load',
          title: `The HTML document took ${baseline.totalMs}ms to download (target under ${THRESHOLDS.loadMs.target}ms)`,
          detail: `${(baseline.bytes / 1024).toFixed(0)} KB of HTML. This is document time only — no images, scripts or stylesheets — so it is a floor on how fast the page can possibly be.`,
          severity: baseline.totalMs > 3000 ? 'high' : 'medium',
          affectedUrl: target,
          action: 'Reduce the HTML payload and the server time behind it. Compression, and removing inlined data blocks, are the usual wins.',
          evidence: { ms: baseline.totalMs, bytes: baseline.bytes },
          dedupeKey: `readiness:htmlload:${target}`,
        });
      }
    }

    if (cert.ok) {
      metrics.push({ key: 'readiness.ssl_days_left', url: target, value: cert.daysLeft, status: cert.daysLeft > 30 ? 'good' : (cert.daysLeft > 7 ? 'warn' : 'fail') });
      if (cert.daysLeft <= 30) {
        findings.push({
          checkKey: 'ssl_expiry',
          title: cert.daysLeft < 0
            ? `The TLS certificate EXPIRED ${Math.abs(cert.daysLeft)} days ago`
            : `The TLS certificate expires in ${cert.daysLeft} days`,
          detail: `Issued by ${cert.issuer || 'an unknown authority'}, valid to ${cert.validTo}.`,
          severity: cert.daysLeft <= 7 ? 'critical' : 'high',
          affectedUrl: target,
          action: 'Renew, and confirm auto-renewal is actually running. An expired certificate blocks every crawler and every visitor simultaneously.',
          evidence: cert,
          dedupeKey: `readiness:ssl:${target}`,
        });
      }
      if (!cert.authorized) {
        findings.push({
          checkKey: 'ssl_invalid',
          title: 'The TLS certificate does not validate',
          detail: `${cert.authorizationError}. Browsers will interstitial, and crawlers treat this as unreachable.`,
          severity: 'critical',
          affectedUrl: target,
          action: 'Fix the certificate chain — a missing intermediate certificate is the usual cause and is invisible in some browsers.',
          evidence: cert,
          dedupeKey: `readiness:sslinvalid:${target}`,
        });
      }
    } else if (cert.error && cert.error !== 'not served over HTTPS') {
      findings.push({
        checkKey: 'ssl_unknown',
        title: 'The TLS certificate could not be read',
        detail: cert.error,
        severity: 'medium',
        affectedUrl: target,
        action: 'Check the certificate manually — this usually means the handshake itself is failing.',
        dedupeKey: `readiness:sslunknown:${target}`,
      });
    }

    if (!security.hsts) {
      findings.push({
        checkKey: 'no_hsts',
        title: 'No Strict-Transport-Security header',
        detail: 'Without HSTS the first request of a session can still be made over plain HTTP and downgraded.',
        severity: 'low',
        affectedUrl: target,
        action: 'Add Strict-Transport-Security with a max-age of at least 31536000 once you are certain every subdomain serves HTTPS.',
        dedupeKey: `readiness:hsts:${target}`,
      });
    }
    if (!security.csp) {
      findings.push({
        checkKey: 'no_csp',
        title: 'No Content-Security-Policy header',
        detail: 'CSP is the control that limits what an injected script can do. Its absence is not an SEO problem directly, but a compromised page is: injected spam links and cloaked content are how a clean site earns a manual action.',
        severity: 'low',
        affectedUrl: target,
        action: 'Add a Content-Security-Policy, starting in report-only mode so it can be tuned without breaking the page.',
        dedupeKey: `readiness:csp:${target}`,
      });
    }

    if (noindex) {
      findings.push({
        checkKey: 'noindex',
        title: 'The page is marked noindex',
        detail: `robots meta: "${robotsMeta || '(none)'}"; X-Robots-Tag: "${xRobots || '(none)'}". The page will not appear in search results, and Google-derived AI surfaces will not cite it.`,
        severity: 'critical',
        affectedUrl: target,
        action: 'Remove the noindex if this page is meant to be indexed. If it is deliberate, no action — but confirm nothing links to it expecting indexation.',
        dedupeKey: `readiness:noindex:${target}`,
      });
    }
    if (nosnippet) {
      findings.push({
        checkKey: 'nosnippet',
        title: 'The page forbids snippets',
        detail: 'nosnippet (or max-snippet:0) is set. This prevents Google from showing any text extract — which also means the page cannot be used in an AI Overview, since those are built from snippet-eligible content.',
        severity: 'high',
        affectedUrl: target,
        action: 'Remove nosnippet unless it was set deliberately for licensing reasons. If content control is the goal, use max-snippet with a length rather than forbidding snippets entirely.',
        dedupeKey: `readiness:nosnippet:${target}`,
      });
    }

    if (!robots.present) {
      findings.push({
        checkKey: 'no_robots',
        title: 'No robots.txt',
        detail: `${origin}/robots.txt returned ${robots.status || 'nothing'}. Crawling still works — the default is allow — but there is no way to state a sitemap location or to control any agent.`,
        severity: 'low',
        affectedUrl: `${origin}/robots.txt`,
        action: 'Add a robots.txt with a Sitemap line. It is also where any future AI-agent policy has to live.',
        dedupeKey: `readiness:norobots:${target}`,
      });
    } else if (robots.parsed && !robots.parsed.sitemaps.length) {
      findings.push({
        checkKey: 'robots_no_sitemap',
        title: 'robots.txt declares no sitemap',
        detail: 'A Sitemap line is how a crawler that has never seen the site finds the URL inventory without guessing.',
        severity: 'low',
        affectedUrl: `${origin}/robots.txt`,
        action: `Add "Sitemap: ${origin}/sitemap.xml" (or wherever it lives) to robots.txt.`,
        dedupeKey: `readiness:robotsnositemap:${target}`,
      });
    }

    if (!sitemap.urls.length) {
      findings.push({
        checkKey: 'no_sitemap',
        title: 'No usable XML sitemap found',
        detail: sitemap.sources.length
          ? `Tried: ${sitemap.sources.map((s) => `${s.url} (${s.ok ? `${s.urls} URLs` : s.error || `HTTP ${s.status}`})`).join('; ')}.`
          : 'Neither robots.txt nor the conventional locations produced a sitemap.',
        severity: 'medium',
        affectedUrl: `${origin}/sitemap.xml`,
        action: 'Publish an XML sitemap and reference it from robots.txt. Without one, discovery depends entirely on internal linking.',
        evidence: { tried: sitemap.sources },
        dedupeKey: `readiness:nositemap:${target}`,
      });
    }

    if (!llms.present) {
      findings.push({
        checkKey: 'no_llms_txt',
        title: 'No llms.txt',
        detail: 'Optional, and explicitly not used by Google — reported as an opportunity, not a defect. It gives retrieval pipelines that do read it a canonical statement of what the brand is, and writing one forces the brand facts to be settled in one place.',
        severity: 'info',
        affectedUrl: `${origin}/llms.txt`,
        action: 'Generate one from the brand facts on the Schema & brand hub page, then publish it at the site root.',
        dedupeKey: `readiness:nollms:${target}`,
      });
    }

    if (doc) {
      const sem = doc.semantic;
      const missingLandmarks = [!sem.main && '<main>', !sem.article && '<article>', !sem.header && '<header>', !sem.nav && '<nav>'].filter(Boolean);
      if (missingLandmarks.length >= 3) {
        findings.push({
          checkKey: 'semantic_html',
          title: `The page uses few semantic landmarks (missing ${missingLandmarks.join(', ')})`,
          detail: 'AI retrieval systems chunk pages by structure. Without landmarks, boilerplate — navigation, footers, cookie notices — is indistinguishable from the content, so extracted passages are diluted with it.',
          severity: 'medium',
          affectedUrl: target,
          action: `Wrap the primary content in <main> (or <article>) and mark navigation as <nav>. Currently the best guess at the content container is "${doc.mainSelector}".`,
          evidence: { semantic: sem, mainSelector: doc.mainSelector },
          dedupeKey: `readiness:semantic:${target}`,
        });
      }

      const redirects = baseline.redirectChain || [];
      if (redirects.length > 2) {
        findings.push({
          checkKey: 'redirect_chain',
          title: `${redirects.length} redirect hops before this page resolves`,
          detail: redirects.map((r) => `${r.status} ${r.url}`).join(' → ') + ` → ${baseline.url}`,
          severity: 'medium',
          affectedUrl: target,
          affectedCount: redirects.length,
          action: 'Collapse the chain to a single hop. Every hop is a round trip against the retrieval timeout, and some fetchers give up after two.',
          evidence: { chain: redirects, finalUrl: baseline.url },
          dedupeKey: `readiness:redirects:${target}`,
        });
      }

      if (doc.canonical) {
        let canonicalAbs = doc.canonical;
        try { canonicalAbs = new URL(doc.canonical, baseline.url).href; } catch { /* keep raw */ }
        const selfReferential = canonicalAbs.replace(/\/$/, '') === String(baseline.url).replace(/\/$/, '');
        if (!selfReferential) {
          findings.push({
            checkKey: 'canonical_drift',
            title: 'The canonical tag points at a different URL',
            detail: `This page (${baseline.url}) declares ${canonicalAbs} as canonical, so it defers indexing to that URL. Correct for a duplicate; a serious problem if this page is meant to rank in its own right.`,
            severity: 'medium',
            affectedUrl: target,
            action: 'Confirm this is deliberate. A templating error that canonicalises every page to the homepage is one of the most damaging and most common SEO faults, and it looks like nothing in a browser.',
            evidence: { declared: doc.canonical, resolved: canonicalAbs, actual: baseline.url },
            dedupeKey: `readiness:canonical:${target}`,
          });
        }
      } else {
        findings.push({
          checkKey: 'no_canonical',
          title: 'No canonical tag',
          detail: 'Without a self-referential canonical, any parameterised or duplicated version of this URL competes with it.',
          severity: 'low',
          affectedUrl: target,
          action: 'Add a self-referential canonical link.',
          dedupeKey: `readiness:nocanonical:${target}`,
        });
      }

      if (!doc.hasViewport) {
        findings.push({
          checkKey: 'no_viewport',
          title: 'No viewport meta tag',
          detail: 'Mobile-first indexing means the mobile rendering is the one Google indexes. Without a viewport declaration the page is rendered at desktop width and scaled down.',
          severity: 'high',
          affectedUrl: target,
          action: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
          dedupeKey: `readiness:viewport:${target}`,
        });
      }
    }

    // Core Web Vitals from real Chrome users.
    //
    // CrUX reports the 75th percentile, which is the number Google's own
    // ranking systems use — so it is the one worth alerting on. The lab
    // (Lighthouse) score is kept in the payload for the opportunity list, but
    // never used for a pass/fail verdict: lab numbers move with the test
    // machine, and a finding that flips between runs on an unchanged page
    // trains people to ignore findings.
    if (cruxRaw) {
      const bandOf = (v, good, poor) => (v == null ? 'unknown' : (v <= good ? 'good' : (v <= poor ? 'warn' : 'fail')));
      const scopeNote = cruxRaw.scope === 'origin'
        ? 'This URL has too little traffic for its own CrUX record, so these are origin-wide figures for the whole site.'
        : 'Measured from real Chrome users on this URL, at the 75th percentile.';

      const CWV = [
        { crux: 'LARGEST_CONTENTFUL_PAINT_MS', key: 'cwv_lcp', metric: 'readiness.lcp_ms', label: 'LCP', scale: 1, unit: 'ms', good: THRESHOLDS.lcpMs.googleGood, poor: THRESHOLDS.lcpMs.googleNeedsWork, brief: THRESHOLDS.lcpMs.target },
        { crux: 'INTERACTION_TO_NEXT_PAINT', key: 'cwv_inp', metric: 'readiness.inp_ms', label: 'INP', scale: 1, unit: 'ms', good: THRESHOLDS.inpMs.googleGood, poor: THRESHOLDS.inpMs.googleNeedsWork, brief: THRESHOLDS.inpMs.target },
        // CrUX reports CLS multiplied by 100 so it can travel as an integer.
        { crux: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', key: 'cwv_cls', metric: 'readiness.cls', label: 'CLS', scale: 0.01, unit: '', good: THRESHOLDS.cls.googleGood, poor: THRESHOLDS.cls.googleNeedsWork, brief: THRESHOLDS.cls.target },
        { crux: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', key: 'cwv_ttfb', metric: 'readiness.field_ttfb_ms', label: 'Field TTFB', scale: 1, unit: 'ms', good: THRESHOLDS.ttfbMs.googleGood, poor: THRESHOLDS.ttfbMs.googleNeedsWork, brief: THRESHOLDS.ttfbMs.target },
      ];

      CWV.forEach((m) => {
        const raw = cruxRaw.metrics[m.crux];
        if (!raw || raw.percentile == null) return;
        const value = Math.round(raw.percentile * m.scale * 1000) / 1000;
        const band = bandOf(value, m.good, m.poor);
        metrics.push({ key: m.metric, url: target, value, status: band, detail: cruxRaw.scope });
        if (band === 'good') return;
        const shown = m.unit === 'ms' ? `${Math.round(value)}ms` : value.toFixed(3);
        findings.push({
          checkKey: m.key,
          title: `${m.label} is ${shown} — ${band === 'fail' ? 'poor' : 'needs improvement'}`,
          detail: `${scopeNote} Google's "good" boundary is ${m.unit === 'ms' ? `${m.good}ms` : m.good}; the target set for this project is ${m.unit === 'ms' ? `${m.brief}ms` : m.brief}.`,
          severity: band === 'fail' ? 'high' : 'medium',
          affectedUrl: target,
          action: `Open the PageSpeed report for this URL — its opportunity list names the specific causes for ${m.label}.`,
          evidence: { value, scope: cruxRaw.scope, googleGood: m.good, googlePoor: m.poor, projectTarget: m.brief },
          dedupeKey: `readiness:${m.key}:${target}`,
        });
      });
    }

    // The score: what share of RETRIEVAL agents can actually read the page,
    // weighted with the things that stop a readable page being cited.
    const retrievalTotal = agentStatus.filter((a) => a.purpose === 'retrieval').length;
    const retrievalOk = agentStatus.filter((a) => a.purpose === 'retrieval'
      && (a.verdict === 'reachable' || a.verdict === 'allowed-by-robots')).length;
    // Agents the control probe showed to be untestable are taken out of the
    // denominator rather than counted as failures. Leaving them in would drive
    // the score of every Cloudflare-fronted site to near zero on the strength
    // of a measurement that was never made.
    const retrievalMeasured = retrievalTotal - retrievalUnverifiable.length;
    const accessShare = retrievalMeasured > 0 ? retrievalOk / retrievalMeasured : 0;
    let score = Math.round(accessShare * 55);
    if (jsDependence && jsDependence.contentInHtml) score += 15;
    if (!noindex && !nosnippet) score += 10;
    if (doc && (doc.semantic.main || doc.semantic.article)) score += 8;
    if (ttfb.ms != null && ttfb.ms <= THRESHOLDS.ttfbMs.googleGood) score += 7;
    if (cert.ok && cert.authorized && cert.daysLeft > 30) score += 5;
    score = Math.max(0, Math.min(100, score));

    metrics.push({ key: 'readiness.score', url: target, value: score, status: score >= 80 ? 'good' : (score >= 55 ? 'warn' : 'fail') });
    metrics.push({ key: 'readiness.retrieval_agents_ok', url: target, value: retrievalOk, status: retrievalOk === retrievalMeasured ? 'good' : 'fail', detail: `${retrievalOk} of ${retrievalMeasured} testable${retrievalUnverifiable.length ? ` (${retrievalUnverifiable.length} untestable — edge blocks unverified clients)` : ''}` });

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        url: target,
        origin,
        fetch: {
          status: baseline.status, ok: baseline.ok, error: baseline.error,
          bytes: baseline.bytes, ms: baseline.totalMs, finalUrl: baseline.url,
          redirectChain: baseline.redirectChain,
        },
        agents: agentStatus,
        agentSummary: {
          retrievalTotal,
          retrievalMeasured,
          retrievalOk,
          retrievalBlocked: retrievalBlocked.length,
          retrievalUnverifiable: retrievalUnverifiable.length,
          trainingTotal: agentStatus.filter((a) => a.purpose === 'training').length,
          trainingBlocked: trainingBlocked.length,
          probed: probes.length,
        },
        control,
        robots: {
          present: robots.present, status: robots.status, url: robots.url,
          sitemaps: robots.parsed ? robots.parsed.sitemaps : [],
          groups: robots.parsed ? robots.parsed.groups : [],
          body: robots.body ? String(robots.body).slice(0, 4000) : null,
        },
        llms,
        sitemap: { count: sitemap.urls.length, sources: sitemap.sources },
        ttfb,
        certificate: cert,
        security,
        indexability: { robotsMeta, xRobots, noindex, nosnippet, canonical: doc ? doc.canonical : null },
        jsDependence,
        semantic: doc ? doc.semantic : null,
        psi: psiReport,
        crux: cruxRaw ? { scope: cruxRaw.scope, metrics: cruxRaw.metrics } : null,
        thresholds: THRESHOLDS,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId ? metrics : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}\n\nURL: ${f.affected_url || run.target}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:readiness:${run.id}:${f.check_key}`,
      category: 'AI-crawler readiness',
      severity: f.severity,
      affectedUrl: f.affected_url || run.target,
      evidence: f.evidence,
      dedupeKey: `aiseo:readiness:${f.check_key}:${f.affected_url || run.target}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = { run, toTasks, probeAgents, probeControls, looksLikeChallenge, THRESHOLDS };
