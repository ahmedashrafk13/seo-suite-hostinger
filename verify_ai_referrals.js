// Verification for the AI referral traffic feature (src/lib/aiseo/aiReferrals.js).
//
// Unlike the other verify_*.js scripts this one is SAFE TO RUN WITH THE SERVER
// UP: ./store, ./providers and ../google are stubbed before the module loads,
// so data/app.db is never opened and no GA4 credential is needed. Every number
// asserted below comes from the fixture, so the expected values are known
// exactly rather than eyeballed.
//
//   node verify_ai_referrals.js
const Module = require('module');
const path = require('path');
const ROOT = process.argv[2] || process.cwd();
const real = Module._load;

const captured = { finished: null };
const stubs = {
  store: {
    begin: () => ({ id: 1, kind: 'ai_referrals' }),
    finish: (id, payload) => { captured.finished = payload; return payload; },
    fail: (id, err) => { captured.finished = { error: err.message }; },
  },
  providers: { has: (k) => k === 'ga4' },
  google: {
    ga4DateToIso: (v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v),
    ga4RunReport: async (userId, prop, opts) => {
      if (opts.dimensions[0] === 'date') return FIXTURE.daily;
      return FIXTURE.landing;
    },
  },
};

Module._load = function (request, parent, isMain) {
  if (request === './store') return stubs.store;
  if (request === './providers') return stubs.providers;
  if (request === '../google') return stubs.google;
  return real.apply(this, arguments);
};

const row = (dims, sessions, users = 0, conversions = 0) => ({
  dimensions: dims, metrics: { sessions, totalUsers: users, conversions },
});

// 8 days. ChatGPT and Perplexity rising, google/organic as noise, bing.com as
// the ambiguous case that must stay out of the headline number.
const FIXTURE = {
  daily: [
    row(['20260101', 'google'], 500, 400, 10),
    row(['20260101', 'chatgpt.com'], 2, 2, 0),
    row(['20260102', 'google'], 500, 400, 10),
    row(['20260102', 'chat.openai.com'], 1, 1, 0),
    row(['20260103', 'perplexity.ai'], 1, 1, 0),
    row(['20260104', 'bing.com'], 40, 35, 2),
    row(['20260105', 'chatgpt.com'], 6, 5, 1),
    row(['20260106', 'www.perplexity.ai'], 4, 4, 0),
    row(['20260107', 'claude.ai'], 3, 3, 1),
    row(['20260108', 'chatgpt.com'], 8, 7, 2),
    row(['20260108', '(direct)'], 300, 250, 5),
  ],
  landing: [
    row(['/pricing', 'chatgpt.com'], 9, 0, 2),
    row(['/pricing', 'perplexity.ai'], 3, 0, 0),
    row(['/blog/guide', 'chatgpt.com'], 7, 0, 1),
    row(['/ignored', 'google'], 900, 0, 40),
    row(['/ignored-bing', 'bing.com'], 40, 0, 2),
  ],
};

const ai = require(path.join(ROOT, 'src/lib/aiseo/aiReferrals.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

// --- classifier ---
check('chatgpt.com classified', ai.classifySource('chatgpt.com').key, 'chatgpt');
check('legacy chat.openai.com still attributed', ai.classifySource('chat.openai.com').key, 'chatgpt');
check('www.perplexity.ai matched', ai.classifySource('www.perplexity.ai').key, 'perplexity');
check('bing flagged ambiguous', ai.classifySource('bing.com').ambiguous, true);
check('google is not an assistant', ai.classifySource('google'), null);
check('(direct) is not an assistant', ai.classifySource('(direct)'), null);
check('empty source safe', ai.classifySource(''), null);
check('foryou.com is NOT You.com', ai.classifySource('foryou.com'), null);
check('linux.ai is NOT Grok', ai.classifySource('linux.ai'), null);
check('notchatgpt.com is NOT ChatGPT', ai.classifySource('notchatgpt.com'), null);
check('mybing.com is NOT Bing', ai.classifySource('mybing.com'), null);
check('real you.com still matches', ai.classifySource('you.com').key, 'you');
check('subdomain still matches', ai.classifySource('news.perplexity.ai').key, 'perplexity');
check('trailing path trimmed', ai.classifySource('chatgpt.com/').key, 'chatgpt');

// --- trend ---
check('halfOverHalf too few days', ai.halfOverHalf([{ sessions: 1 }]), null);
check('halfOverHalf doubling', ai.halfOverHalf(
  [{ sessions: 5 }, { sessions: 5 }, { sessions: 10 }, { sessions: 10 }],
), { earlier: 10, later: 20, delta: 10, pct: 100 });

// --- full run ---
(async () => {
  await ai.run({
    userId: 1,
    brand: { id: 7, name: 'Test', site_url: 'https://example.com', ga4_property_id: '123' },
    days: 28,
  });
  const r = captured.finished.result;

  const expectedAi = 2 + 1 + 1 + 6 + 4 + 3 + 8; // 25, bing excluded
  check('AI sessions exclude bing and organic', r.totals.aiSessions, expectedAi);
  check('total sessions include everything', r.totals.totalSessions, 1365);
  check('bing reported separately', r.ambiguousEngines[0].sessions, 40);
  check('engines ranked by sessions', r.engines.map((e) => e.key), ['chatgpt', 'perplexity', 'claude']);
  check('chatgpt merges both hostnames', r.engines[0].sessions, 17);
  check('landing pages exclude non-AI sources', r.landingPages.map((p) => p.path), ['/pricing', '/blog/guide']);
  check('landing page merges engines', r.landingPages[0].engines, ['ChatGPT', 'Perplexity']);
  check('landing page sessions summed', r.landingPages[0].sessions, 12);
  check('share computed', r.totals.share, Math.round((expectedAi / 1365) * 10000) / 100);
  check('series is chronological', r.series.map((d) => d.date), [
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08',
  ]);
  check('no false "zero referrals" finding', captured.finished.findings.some((f) => f.checkKey === 'ai_referrals_none'), false);

  // --- zero-traffic case ---
  FIXTURE.daily = [row(['20260101', 'google'], 500, 400, 10)];
  await ai.run({
    userId: 1,
    brand: { id: 7, name: 'Test', site_url: 'https://example.com', ga4_property_id: '123' },
    days: 28,
  });
  check('zero AI traffic raises a finding', captured.finished.findings[0].checkKey, 'ai_referrals_none');
  check('zero AI traffic scores 0', captured.finished.score, 0);

  // --- no GA4 property ---
  await ai.run({ userId: 1, brand: { id: 7, name: 'Test', site_url: 'https://example.com' }, days: 28 });
  check('missing GA4 property returns empty, not an error', captured.finished.result.empty, true);

  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
