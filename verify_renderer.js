// Checks the JavaScript-rendering fetch path: the provider request it builds,
// the two refusals that must never be bypassed (credentials, non-GET), the
// fallback when the provider fails, and the URL integrity that everything
// downstream depends on.
//
// The offline checks run with no network. The live checks run only when
// ZENROWS_API_KEY is set, and they spend a small number of credits.
require('dotenv').config();
const path = require('path');

const ROOT = process.argv[2] || __dirname;
const dbPath = require.resolve(path.join(ROOT, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) } };

const renderer = require(path.join(ROOT, 'tools/node/lib/renderer'));
const fetcher = require(path.join(ROOT, 'src/lib/aiseo/fetcher'));

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// ------------------------------------------------------ the provider request
const saved = process.env.ZENROWS_API_KEY;
const savedMany = process.env.ZENROWS_API_KEYS;
// The pool reads BOTH variables, so anything that disables rendering has to
// clear both - clearing one and leaving the other is exactly the silent
// half-off state the single-source rule exists to prevent.
process.env.ZENROWS_API_KEYS = '';
process.env.ZENROWS_API_KEY = 'TESTKEY';
const built = new URL(renderer.buildUrl('https://a.example/x?b=1&c=2'));
check('targets the provider endpoint', built.origin + built.pathname === 'https://api.zenrows.com/v1/');
check('asks for JavaScript rendering', built.searchParams.get('js_render') === 'true');
check('passes the target URL whole, query string included',
  built.searchParams.get('url') === 'https://a.example/x?b=1&c=2', built.searchParams.get('url'));
check('sends a settle wait, so a half-built DOM is never read',
  Number(built.searchParams.get('wait')) === renderer.DEFAULT_WAIT_MS);
// Premium proxies cost roughly ten times the credits. A default-on would be an
// invisible tenfold bill, so its absence is worth a test of its own.
check('premium proxies are OFF unless asked for', built.searchParams.get('premium_proxy') === null);
check('premium is available when asked for',
  new URL(renderer.buildUrl('https://a.example/', { premium: true })).searchParams.get('premium_proxy') === 'true');

// ---------------------------------------------------------- provider errors
check('a JSON error body is caught',
  /REQS001/.test(renderer.providerError('{"code":"REQS001","title":"forbidden"}', 400) || ''));
check('an error under a 2xx envelope is still caught',
  renderer.providerError('{"code":"AUTH001","title":"bad key"}', 200) !== null);
check('real HTML is not mistaken for an error',
  renderer.providerError('<!doctype html><html><body>hi</body></html>', 200) === null);
// A page whose body legitimately starts with a brace must survive.
check('a non-error JSON body is not treated as a failure',
  renderer.providerError('{"products":[1,2,3]}', 200) === null);
check('an empty body under an error status is caught',
  renderer.providerError('', 502) !== null);

// ------------------------------------------------------------- the refusals
check('credentials refuse rendering', renderer.refuseForAuth({ headers: {}, site: 'x' }) !== null);
check('no credentials, no refusal', renderer.refuseForAuth(null) === null);

process.env.ZENROWS_API_KEY = '';
check('no key means disabled', renderer.isEnabled() === false);
process.env.ZENROWS_API_KEYS = 'A,B';
check('ZENROWS_API_KEYS alone is enough to enable', renderer.isEnabled() === true);
process.env.ZENROWS_API_KEYS = '';
process.env.ZENROWS_API_KEY = 'TESTKEY';
check('a key means enabled', renderer.isEnabled() === true);
process.env.ZENROWS_API_KEY = saved || '';
process.env.ZENROWS_API_KEYS = savedMany || '';

(async () => {
  // -------------------------------------------------------- refusal, in situ
  // The credential refusal is the one that protects a client's session, so it
  // is checked through fetchPage rather than on the helper alone.
  if (renderer.isEnabled()) {
    const res = await fetcher.runWithAuth(
      { headers: { Cookie: 'session=secret' }, site: 'example.com' },
      () => fetcher.fetchPage('https://example.com/', { render: true }),
    );
    check('a credentialed run is NOT rendered', res.rendered === false, res.renderSkipped);
    check('and says why', /credential/i.test(res.renderSkipped || ''), res.renderSkipped);

    const post = await fetcher.fetchPage('https://example.com/', { render: true, method: 'POST', body: 'x=1' });
    check('a POST is not rendered', post.rendered === false && /GET/.test(post.renderSkipped || ''), post.renderSkipped);
  }

  // --------------------------------------------------------- disabled is safe
  const key = process.env.ZENROWS_API_KEY;
  const many = process.env.ZENROWS_API_KEYS;
  process.env.ZENROWS_API_KEY = '';
  process.env.ZENROWS_API_KEYS = '';
  const off = await fetcher.fetchPage('https://example.com/', { render: true });
  check('with no key, render:true still returns the raw page', off.ok === true && off.rendered === false, off.error);
  check('and reports that it was not rendered', /ZENROWS_API_KEY/.test(off.renderSkipped || ''), off.renderSkipped);
  process.env.ZENROWS_API_KEY = key;
  process.env.ZENROWS_API_KEYS = many;

  // ------------------------------------------------------------- live checks
  if (!renderer.isEnabled()) {
    console.log('\nSKIP live checks: ZENROWS_API_KEY is not set');
  } else {
    const target = 'https://demo.realworld.show/';
    const raw = await fetcher.fetchPage(target);
    const ren = await fetcher.fetchPage(target, { render: true });
    check('the live fetch renders', ren.rendered === true, ren.renderSkipped || ren.error);
    check('rendering recovers content the raw HTML does not have',
      ren.body.length > raw.body.length * 1.2, { raw: raw.body.length, rendered: ren.body.length });

    // If out.url became the provider's host, every relative link, same-site
    // test and canonical comparison downstream would resolve against
    // api.zenrows.com. This is the check that keeps the crawlers honest.
    check('the reported URL is the TARGET, never the provider',
      ren.url === target && !/zenrows/.test(ren.url), ren.url);
    check('the redirect chain is empty rather than the provider\'s own',
      Array.isArray(ren.redirectChain) && ren.redirectChain.length === 0, ren.redirectChain);
    check('a rendered page parses like any other', (() => {
      const $ = fetcher.load(ren.body);
      return $('a[href]').length > 10;
    })());

    // A URL the provider refuses: the audit must survive it.
    const blocked = await fetcher.fetchPage('https://quotes.toscrape.com/js/', { render: true });
    check('a refused target falls back to the raw fetch instead of failing',
      blocked.rendered === false && blocked.ok === true, { skipped: blocked.renderSkipped, status: blocked.status });
    check('and the refusal reason is reported',
      /not rendered/.test(blocked.renderSkipped || ''), blocked.renderSkipped);
  }

  // =========================================================== the key pool
  // Driven against a fake transport, so the failover rules are proved without
  // spending a credit per case.
  const poolSaved = process.env.ZENROWS_API_KEYS;
  const poolSavedOne = process.env.ZENROWS_API_KEY;
  process.env.ZENROWS_API_KEY = '';
  process.env.ZENROWS_API_KEYS = 'KEY_A,KEY_B,KEY_C';

  // Records which key each attempt used and replies with whatever the
  // scenario says that key should return.
  function fakeTransport(reply) {
    const used = [];
    return {
      used,
      t: {
        fetchUrl: async (u) => {
          const key = new URL(u).searchParams.get('apikey');
          used.push(key);
          return { status: 200, body: Buffer.from(reply(key)), headers: {} };
        },
        decodeBody: (r) => r.body.toString(),
      },
    };
  }

  renderer.resetPool();
  check('pool reads every key, in order', renderer.keys().join(',') === 'KEY_A,KEY_B,KEY_C');
  process.env.ZENROWS_API_KEYS = 'KEY_A,KEY_B,KEY_A';
  check('a duplicated key is listed once, not tried twice', renderer.keys().length === 2, renderer.keys());
  process.env.ZENROWS_API_KEYS = 'KEY_A,KEY_B,KEY_C';

  // An exhausted first account hands over to the second.
  renderer.resetPool();
  let f = fakeTransport((k) => (k === 'KEY_A'
    ? '{"code":"AUTH004","title":"credit allowance spent"}'
    : '<html><body>rendered</body></html>'));
  let got = await renderer.renderPage('https://x.example/', {}, f.t);
  check('an exhausted key fails over to the next', got.key === 'KEY_B', f.used);
  check('and the exhausted key is retired',
    renderer.poolStatus().live === 2 && renderer.poolStatus().retired.length === 1, renderer.poolStatus());

  // The retirement has to persist, or every later page pays a wasted credit
  // on the spent key before failing over again.
  f = fakeTransport(() => '<html><body>ok</body></html>');
  got = await renderer.renderPage('https://x.example/2', {}, f.t);
  check('the next page starts on the live key, not the spent one',
    got.key === 'KEY_B' && !f.used.includes('KEY_A'), f.used);

  // THE CREDIT-WASTING CASE. A blocked or missing TARGET is not the key's
  // fault. Rotating on it would spend one credit per key to learn the same
  // thing three times over.
  renderer.resetPool();
  f = fakeTransport(() => '{"code":"REQS001","title":"Requests to this domain are forbidden"}');
  try { await renderer.renderPage('https://blocked.example/', {}, f.t); } catch (e) { /* expected */ }
  check('a blocked TARGET is tried once only, never against every key', f.used.length === 1, f.used);
  check('and no key is retired over a target error', renderer.poolStatus().retired.length === 0);

  // A busy key hands over WITHOUT being written off.
  renderer.resetPool();
  f = fakeTransport((k) => (k === 'KEY_A'
    ? '{"code":"AUTH006","title":"concurrency limit reached"}'
    : '<html><body>ok</body></html>'));
  got = await renderer.renderPage('https://x.example/', {}, f.t);
  check('a rate-limited key hands over but stays in the pool',
    got.key === 'KEY_B' && renderer.poolStatus().live === 3, renderer.poolStatus());

  // Every key spent: give up, do not loop.
  renderer.resetPool();
  f = fakeTransport(() => '{"code":"AUTH004","title":"spent"}');
  let threw = false;
  try { await renderer.renderPage('https://x.example/', {}, f.t); } catch (e) { threw = true; }
  check('with every key spent it throws rather than looping', threw && f.used.length === 3, f.used);
  check('and rendering then reports itself disabled', renderer.isEnabled() === false);

  // Keys are secrets: nothing that reaches a log, report or the UI may carry one.
  check('keys are masked', renderer.mask('18fd60cb617ca31b4f71e7a05e9c4867864438b6') === '18fd...38b6');
  check('a pool-status report carries no full key',
    !/KEY_A|KEY_B|KEY_C/.test(JSON.stringify(renderer.poolStatus())), renderer.poolStatus());

  renderer.resetPool();
  process.env.ZENROWS_API_KEYS = poolSaved || '';
  process.env.ZENROWS_API_KEY = poolSavedOne || '';

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
