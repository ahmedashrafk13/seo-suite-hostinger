// Checks the JavaScript-rendering detector: the verdict thresholds, the
// Lighthouse parsing, and the PageSpeed card that renders it.
// No database, no network, no API calls.
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || __dirname;
const ejs = require(path.join(ROOT, 'node_modules/ejs'));
const VIEWS = path.join(ROOT, 'views');

const dbPath = require.resolve(path.join(ROOT, 'src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) },
};

const js = require(path.join(ROOT, 'src/lib/jsRendering.js'));

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// ------------------------------------------------- Lighthouse dom-size parsing
check('reads dom-size from a PSI envelope',
  js.renderedDomSize({ lighthouseResult: { audits: { 'dom-size': { numericValue: 1432.0 } } } }) === 1432);
check('reads dom-size from a bare lighthouse result',
  js.renderedDomSize({ audits: { 'dom-size': { numericValue: 900 } } }) === 900);
check('missing audit is null, not zero',
  js.renderedDomSize({ lighthouseResult: { audits: {} } }) === null);
check('malformed input is null, not a throw', js.renderedDomSize(null) === null);
check('a zero or negative count is treated as missing',
  js.renderedDomSize({ audits: { 'dom-size': { numericValue: 0 } } }) === null);

// -------------------------------------------------------------- the verdicts
const server = { domSize: 1300, words: 1800, headings: 22, links: 90, framework: null };
check('server-rendered page reads as fine', js.verdictFor(server, 1400).level === 'ok',
  js.verdictFor(server, 1400));

const shell = { domSize: 40, words: 12, headings: 0, links: 2, framework: 'React' };
check('an empty shell is caught', js.verdictFor(shell, 1400).level === 'shell', js.verdictFor(shell, 1400));

const partial = { domSize: 600, words: 700, headings: 8, links: 40, framework: 'Next.js' };
check('a partly-hydrated page is flagged as partial',
  js.verdictFor(partial, 1400).level === 'partial', js.verdictFor(partial, 1400));

// The second shell rule: plenty of ELEMENTS but almost no words. A shell full
// of empty layout divs would otherwise pass the ratio test.
const wordless = { domSize: 500, words: 20, headings: 0, links: 5, framework: 'Vue or Angular' };
check('many elements but no words still reads as a shell',
  js.verdictFor(wordless, 1200).level === 'shell', js.verdictFor(wordless, 1200));

check('no rendered figure means unknown, never "fine"',
  js.verdictFor(server, null).level === 'unknown', js.verdictFor(server, null));

// Threshold boundaries, so a later tweak cannot silently invert them.
check('exactly at the shell ratio is a shell',
  js.verdictFor({ domSize: 250, words: 900, headings: 9, links: 30 }, 1000).level === 'shell');
check('just above the shell ratio is partial',
  js.verdictFor({ domSize: 300, words: 900, headings: 9, links: 30 }, 1000).level === 'partial');
check('at the partial ceiling is ok',
  js.verdictFor({ domSize: 600, words: 900, headings: 9, links: 30 }, 1000).level === 'ok');

// ---------------------------------------------------------- the rendered card
function locals(extra) {
  return Object.assign({
    title: 'T', pageTitle: 'T', active: 'pagespeed', path: '/pagespeed', query: {},
    navCounts: {}, navBrands: [], perms: { isAdmin: true },
    currentUser: { name: 'A', email: 'a@b.c', role: 'admin' },
    team: null, setupRemaining: 0, pendingMembers: 0, assetVersion: '1',
    flash: null, flashError: null, csrfField: '',
    fmtInt: (n) => Number(n || 0).toLocaleString('en-US'),
    fmtPct: (n) => n + '%', fmtDate: (s) => s, fmtDateTime: (s) => s,
    shortUrl: (u) => u, severityMeta: {}, statusBadge: () => ({}),
    brands: [], history: [], connected: true, hasApiKey: true,
    url: 'https://example.com', strategy: 'mobile',
  }, extra);
}

// Built by psi.normalise itself rather than hand-written, so this harness
// cannot drift from the real report shape the view consumes.
const psi = require(path.join(ROOT, 'src/lib/psi.js'));
const report = psi.normalise({
  id: 'https://example.com',
  lighthouseResult: {
    requestedUrl: 'https://example.com',
    finalDisplayedUrl: 'https://example.com',
    fetchTime: '2026-09-11T00:00:00Z',
    lighthouseVersion: '11.0.0',
    configSettings: { formFactor: 'mobile' },
    environment: { hostUserAgent: 'test', benchmarkIndex: 1000 },
    categories: { performance: { title: 'Performance', score: 0.8 } },
    audits: { 'dom-size': { numericValue: 1400, title: 'DOM size', scoreDisplayMode: 'informative' } },
  },
});
const row = { id: 5, url: 'https://example.com', strategy: 'mobile', credential: 'api-key' };

function render(extra) {
  const file = path.join(VIEWS, 'pagespeed.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), locals(extra), { filename: file, views: [VIEWS] });
}

try {
  let html = render({ row, report, jsRender: null });
  check('card offers the check before it is run', html.indexOf('Check JavaScript rendering') >= 0);
  check('nothing is claimed before the check runs', html.indexOf('Readable without JavaScript') === -1);

  html = render({
    row,
    report,
    jsRender: {
      ok: true,
      verdict: js.verdictFor(shell, 1400),
      rendered: 1400,
      raw: shell,
      ratio: 3,
      google: { verdict: 'PASS', coverage_state: 'Submitted and indexed' },
    },
  });
  check('shell verdict is rendered', html.indexOf('Content needs JavaScript') >= 0);
  check('both element counts are shown', html.indexOf('1,400') >= 0 && html.indexOf('Raw HTML has') >= 0);
  check('the detected framework is named', html.indexOf('React') >= 0);
  check("Google's own verdict is shown alongside", html.indexOf('Submitted and indexed') >= 0);
  check('the limitation is stated, not hidden', html.indexOf('does not have') >= 0);

  html = render({
    row, report,
    jsRender: { ok: true, verdict: js.verdictFor(server, 1400), rendered: 1400, raw: server, ratio: 93, google: null },
  });
  check('a good page reads as good', html.indexOf('Readable without JavaScript') >= 0);
  check('no remediation note on a healthy page', html.indexOf('Fixing this needs a renderer') === -1);

  html = render({
    row, report,
    jsRender: {
      ok: false, rendered: 1400, google: null,
      verdict: { level: 'unknown', label: 'Could not check', summary: 'The raw HTML could not be fetched (timeout).' },
    },
  });
  check('a failed fetch says so rather than passing', html.indexOf('Could not check') >= 0);
  check('a failed fetch renders no element counts', html.indexOf('Raw HTML has') === -1);
} catch (e) {
  fail += 1;
  console.log('FAIL pagespeed.ejs -> ' + e.message);
}

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
