// Does this page need JavaScript to show its content?
//
// THE PROBLEM THIS ANSWERS. Every crawler in this app reads raw HTML and does
// not execute JavaScript. On a server-rendered site that is the whole page. On
// a React/Vue/Next site that ships an empty shell and builds the page in the
// browser, it is almost nothing - so the audit reports a word count near zero,
// no headings and no internal links, and every content check downstream is
// measuring a shell rather than the page a human sees.
//
// HOW IT IS ANSWERED WITHOUT A BROWSER. Google already rendered the page for
// us. A PageSpeed Insights report is produced by a real Chrome, and its
// `dom-size` audit counts the elements in the FINISHED, rendered DOM. Fetching
// the same URL as plain HTML costs one GET. Comparing the two is the whole
// test: if Chrome saw 1,400 elements and the raw HTML has 40, the content
// arrives via JavaScript and this app cannot read it.
//
// WHAT THIS DOES NOT DO. It does not render anything, and it cannot recover
// the missing content - that needs a real browser or a rendering service. Its
// job is to say, cheaply and for certain, WHICH pages have the problem, so
// that decision can be made on evidence instead of on a guess. Nothing here
// costs an API call beyond the PSI report the page already has.
const fetcher = require('./aiseo/fetcher');
const renderer = require('../../tools/node/lib/renderer');

// Ratios chosen to be conservative in the direction that matters: a false
// "this is fine" is worse than a false "check this", because the first hides a
// broken audit and the second only asks someone to look.
const SHELL_RATIO = 0.25;   // raw DOM under a quarter of rendered -> shell
const PARTIAL_RATIO = 0.6;  // under 60% -> meaningful content is injected
// Below this, "the page has words" is not a claim worth making either way.
const MIN_WORDS = 120;

// The root nodes the major frameworks mount into. Their presence is not proof
// on its own - plenty of server-rendered sites use these ids - so this only
// ever NAMES a likely framework once the element counts have already shown a
// gap. It never decides the verdict.
const MOUNT_HINTS = [
  { sel: '#__next', name: 'Next.js' },
  { sel: '#__nuxt', name: 'Nuxt' },
  { sel: '#root', name: 'React' },
  { sel: '#app', name: 'Vue or Angular' },
  { sel: '[data-reactroot]', name: 'React' },
  { sel: 'astro-island', name: 'Astro' },
];

// Lighthouse reports the rendered element count as dom-size. The audit has
// moved group and display format between Lighthouse versions but the numeric
// value has been stable, so that is what is read.
function renderedDomSize(rawJson) {
  try {
    const lr = (rawJson && rawJson.lighthouseResult) || rawJson || {};
    const audit = (lr.audits || {})['dom-size'];
    if (!audit) return null;
    const n = Number(audit.numericValue);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch (e) { return null; }
}

// What OUR crawlers see: the same URL, plain HTTP, no JavaScript.
//
// `render` swaps the plain fetch for the rendering service, which makes this
// same function the RECOVERY path as well as the diagnosis: the two snapshots
// are measured identically, so the numbers are directly comparable and a
// recovered page can be shown beside the shell it replaces.
async function rawSnapshot(url, { render = false } = {}) {
  const res = await fetcher.fetchPage(url, { render });
  if (!res || !res.ok || !res.body) {
    return { ok: false, error: (res && res.error) || `HTTP ${res && res.status}` };
  }
  const $ = fetcher.load(res.body);
  const text = fetcher.visibleText($);
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  const framework = MOUNT_HINTS.find((h) => $(h.sel).length);
  return {
    ok: true,
    status: res.status,
    rendered: !!res.rendered,
    renderSkipped: res.renderSkipped || null,
    domSize: $('*').length,
    words,
    headings: $('h1, h2, h3').length,
    links: $('a[href]').length,
    framework: framework ? framework.name : null,
  };
}

function verdictFor(raw, rendered) {
  const ratio = rendered ? raw.domSize / rendered : null;

  if (ratio == null) {
    return {
      level: 'unknown',
      label: 'Not checked',
      summary: 'This PageSpeed report has no rendered DOM size, so there is nothing to compare the raw HTML against.',
    };
  }
  if (ratio <= SHELL_RATIO || (raw.words < MIN_WORDS && rendered > 400)) {
    return {
      level: 'shell',
      label: 'Content needs JavaScript',
      summary: 'Chrome rendered a full page, but the raw HTML this app reads is nearly empty. '
        + 'Every crawler here - the technical audit, internal linking, on-page scoring and content checks - '
        + 'is measuring the shell, not the page. Treat their content findings for this URL as unreliable.',
    };
  }
  if (ratio < PARTIAL_RATIO) {
    return {
      level: 'partial',
      label: 'Partly rendered by JavaScript',
      summary: 'A meaningful part of this page is added by JavaScript after load. The main content is '
        + 'probably in the HTML, but some sections - often tabs, listings, reviews or related links - '
        + 'are not, so counts here will read low.',
    };
  }
  return {
    level: 'ok',
    label: 'Readable without JavaScript',
    summary: 'The raw HTML contains substantially what Chrome rendered, so every crawler in this app '
      + 'is reading the real page.',
  };
}

// Google's own verdict on the URL, if a Search Console inspection was stored.
// This is the second opinion that matters: our ratio says whether WE can read
// the page, and this says whether GOOGLE could.
function googleVerdict(url) {
  try {
    const db = require('../db');
    const row = db.prepare(`SELECT verdict, coverage_state, indexing_state, page_fetch_state, last_crawl_time
      FROM url_inspections WHERE url=? ORDER BY checked_at DESC LIMIT 1`).get(url);
    return row || null;
  } catch (e) { return null; }
}

async function analyse(url, rawJson) {
  const rendered = renderedDomSize(rawJson);
  let raw;
  try {
    raw = await rawSnapshot(url);
  } catch (err) {
    raw = { ok: false, error: err.message };
  }

  if (!raw.ok) {
    return {
      ok: false,
      // A fetch failure is reported, never guessed around: "we could not
      // fetch it" and "it renders fine" must not look the same on the page.
      verdict: {
        level: 'unknown',
        label: 'Could not check',
        summary: `The raw HTML could not be fetched (${raw.error}), so there is nothing to compare against Chrome's render.`,
      },
      rendered,
      google: googleVerdict(url),
    };
  }

  const verdict = verdictFor(raw, rendered);

  // RECOVERY. Until now this module could only name the problem. If the
  // verdict says content is missing and a rendering service is configured,
  // fetch the page again through a real browser and report what comes back.
  //
  // It is gated on the verdict on purpose. Rendering is billed per page, and
  // on a server-rendered site - which is most of them - it would buy a second
  // copy of HTML we already have. Spending it only on the pages the ratio has
  // already proven are broken is what makes this affordable at crawl scale.
  let recovered = null;
  if ((verdict.level === 'shell' || verdict.level === 'partial') && renderer.isEnabled()) {
    try {
      const snap = await rawSnapshot(url, { render: true });
      if (snap.ok && snap.rendered) recovered = snap;
      else if (snap.ok) recovered = { ok: false, error: snap.renderSkipped || 'the rendering service returned the raw page' };
    } catch (err) {
      // A rendering failure must never demote the diagnosis, which stands on
      // its own and cost nothing.
      recovered = { ok: false, error: String(err.message).slice(0, 160) };
    }
  }

  return {
    ok: true,
    verdict,
    rendered,
    raw,
    recovered,
    renderingAvailable: renderer.isEnabled(),
    ratio: rendered ? Math.round((raw.domSize / rendered) * 100) : null,
    google: googleVerdict(url),
  };
}

module.exports = { analyse, renderedDomSize, rawSnapshot, verdictFor, SHELL_RATIO, PARTIAL_RATIO };
