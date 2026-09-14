// Checks that rendering spends a credit ONLY on a page that needs one.
//
// Runs against local HTTP servers, so the free/paid decision is observed
// exactly - every paid call is counted - without spending anything real.
const http = require('http');
const path = require('path');

const ROOT = process.argv[2] || __dirname;
const renderer = require(path.join(ROOT, 'tools/node/lib/renderer'));
const httpLib = require(path.join(ROOT, 'tools/node/lib/http'));

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

const WORDS = Array(300).fill('content').join(' ');
// A React shell: mount point present, no readable text, a fat inline bundle.
const SHELL = `<html><body><div id="root"></div><script>${Array(400).fill('var x="a b c";').join('')}</script></body></html>`;
// A server-rendered WordPress page.
const WP = `<html><body><main><h1>Title</h1><p>${WORDS}</p></main></body></html>`;
// React that DOES server-render: mount point present, content present too.
const REACT_SSR = `<html><body><div id="root"><h1>Title</h1><p>${WORDS}</p></div></body></html>`;

// Count every paid render attempt by pointing the renderer at a local stub.
let paidCalls = 0;
function serve(body, type = 'text/html') {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/v1')) { // the fake rendering provider
      paidCalls += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h1>Rendered</h1><p>${WORDS}</p></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  });
}

(async () => {
  const origin = await new Promise((resolve) => {
    const s = serve(SHELL);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
  // Point the renderer's endpoint at the stub. buildUrl reads ENDPOINT at
  // module scope, so it is overridden through the exported object.
  process.env.ZENROWS_ENDPOINT = `${origin}/v1/`;
  process.env.ZENROWS_API_KEYS = 'TESTKEY';
  renderer.resetPool();

  // ------------------------------------------------- the detector, in isolation
  check('an empty React shell is detected', renderer.looksLikeShell(SHELL) === true);
  check('a WordPress page is NOT detected', renderer.looksLikeShell(WP) === false);
  // The costly false positive: React that already server-renders. Firing here
  // would render a whole healthy site for nothing.
  check('React that already server-renders is NOT detected',
    renderer.looksLikeShell(REACT_SSR) === false);
  check('an inline JS bundle is not counted as readable words',
    renderer.visibleWordCount(SHELL) < renderer.SHELL_WORDS, renderer.visibleWordCount(SHELL));

  // -------------------------------------------------- no budget passed, no spend
  paidCalls = 0;
  let res = await httpLib.fetchMaybeRendered(`${origin}/`, {}, null);
  check('with no budget, a shell is NOT rendered (existing callers unchanged)',
    paidCalls === 0 && res.rendered === false, paidCalls);

  // ----------------------------------------------------------- a shell IS paid for
  paidCalls = 0;
  let budget = renderer.newBudget(100);
  res = await httpLib.fetchMaybeRendered(`${origin}/`, {}, budget);
  check('a shell is rendered, once', paidCalls === 1 && res.rendered === true, { paidCalls, rendered: res.rendered });
  check('and the spend is counted', budget.used === 1, budget.used);
  check('the crawler still sees the TARGET url, not the provider',
    res.url.startsWith(origin) && !res.url.includes('/v1/'), res.url);
  check('and the rendered body has the content the shell lacked',
    /Rendered/.test(res.body.toString()), res.body.toString().slice(0, 60));

  // --------------------------------------------- a healthy site costs NOTHING
  const wpOrigin = await new Promise((resolve) => {
    const s = serve(WP);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
  paidCalls = 0;
  budget = renderer.newBudget(100);
  for (let i = 0; i < 25; i += 1) await httpLib.fetchMaybeRendered(`${wpOrigin}/p${i}`, {}, budget);
  check('25 server-rendered pages cost zero credits', paidCalls === 0 && budget.used === 0, { paidCalls });
  check('and the run is not marked as needing rendering', budget.siteNeedsRendering === false);

  // ------------------------------------------------------------ the budget cap
  paidCalls = 0;
  budget = renderer.newBudget(100);          // limit = max(20, 25) = 25
  check('a 100-page crawl caps rendering at 25 pages', budget.limit === 25, budget.limit);
  for (let i = 0; i < 40; i += 1) await httpLib.fetchMaybeRendered(`${origin}/p${i}`, {}, budget);
  check('the cap stops the spend', paidCalls === 25 && budget.used === 25, { paidCalls, used: budget.used });
  check('and pages skipped for budget are counted, not hidden',
    budget.skippedForBudget === 15, budget.skippedForBudget);

  // RENDER_BUDGET=0 must be a true off switch, not "fall back to the default".
  process.env.RENDER_BUDGET = '0';
  check('RENDER_BUDGET=0 disables rendering outright', renderer.newBudget(500).limit === 0);
  delete process.env.RENDER_BUDGET;

  // --------------------------------------------------------- a 500-page audit
  check('a 500-page audit caps at 125 rendered pages ($0.63 worst case)',
    renderer.newBudget(500).limit === 125, renderer.newBudget(500).limit);

  delete process.env.ZENROWS_ENDPOINT;
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
