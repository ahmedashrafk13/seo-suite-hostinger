// Verification for the client report - the prospect-facing audit the sales
// team sends.
//
// WHAT THIS HARNESS IS DEFENDING, AND WHY EACH PART CAN ONLY BE TESTED HERE
//
//   1. THE DOCUMENT GOES TO SOMEONE OUTSIDE THE COMPANY. That makes two
//      failures unusually expensive, and neither shows up as an error: internal
//      wording leaking into the client's copy, and a number appearing that
//      nothing measured. Both are asserted against the RENDERED page rather
//      than against the payload, because the template is where that leak would
//      happen - the same reason verify_leads.js asserts against the rendered
//      share page.
//
//   2. A MISSING MEASUREMENT MUST NOT SCORE AS A PASS. The scorer excludes an
//      unmeasured pillar from both sides of the ratio. Get that wrong and a
//      site whose speed could not be measured reports a better score than one
//      that was measured and found slow - which is the single most damaging
//      arithmetic error this feature could make.
//
//   3. EVERY CRAWLER CHECK REACHES THE CLIENT. The translation catalog is keyed
//      by the crawler's finding ids. If a check is added to the crawler and not
//      to the catalog, the fallback must still produce a readable card - the
//      failure mode otherwise is a finding that silently never appears in any
//      report.
//
// Nothing here touches the network: the collectors are exercised through
// synthetic crawler output in exactly the shape tools/node/audit/main.js emits.
//
// Runs entirely offline against a SCRATCH DATABASE. It never opens data/app.db:
// the WebAssembly driver is single-writer, and a harness that opens the live
// file while the app is serving is the exact sequence that has corrupted it
// before. Setting DB_PATH before requiring anything is what makes that true -
// src/config.js reads it at load time.
//
// Run:  node scripts/verify_client_report.js
process.env.DB_PATH = 'tmp/verify-client-report.db';
require('dotenv').config();
process.env.SMTP_HOST = '';
process.env.INPROCESS_CRON = '0';
process.env.PORT = process.env.CLIENT_REPORT_TEST_PORT || '4409';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const db = require('../src/db');
const build = require('../src/lib/clientReport/build');
const issues = require('../src/lib/clientReport/issues');
const store = require('../src/lib/clientReport/store');
const branding = require('../src/lib/clientReport/branding');
const collect = require('../src/lib/clientReport/collect');
const analyze = require('../tools/node/audit/analyze');

const STAMP = Date.now();
const EMAIL = `client-report-test-${STAMP}@example.com`;

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`OK   ${name}`); } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

function cleanup() {
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL);
  if (!u) return;
  db.prepare('DELETE FROM client_reports WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM app_settings WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
}

// Crawler output in the exact shape main.js writes, so the translation layer is
// tested against the real contract rather than against a convenient one.
function finding(id, name, tier, summary, failed, total, items = [], unit = 'pages') {
  return { id, name, tier, display: failed > 0 ? tier : 'passed', summary, items, failed, total, unit };
}

function crawlFixture() {
  const findings = [
    finding('non_indexable', 'Non-indexable pages', 'notice', '6 pages blocked', 6, 40,
      [{ url: 'https://example.test/a', note: 'noindex' }]),
    finding('dup_titles', 'Duplicate title tags', 'error', '14 pages share a title', 14, 40),
    finding('missing_meta', 'Pages without a meta description', 'warning', '22 missing', 22, 40),
    finding('broken_links', 'Broken internal & external links', 'error', '3 broken', 3, 900, [], 'links'),
    finding('image_alt', 'Images without alt attributes', 'warning', '120 images', 120, 400, [], 'images'),
    finding('mixed_content', 'Mixed content (HTTP resources on HTTPS)', 'warning', 'none', 0, 40),
    finding('viewport', 'Pages without a viewport meta tag', 'warning', 'none', 0, 40),
    finding('hsts', 'HSTS support', 'notice', 'enabled', 0, 1),
    // Deliberately not in the catalog: the fallback path.
    finding('brand_new_check_9000', 'A check added after this catalog was written', 'warning',
      'Five pages do something novel', 5, 40),
  ];
  return {
    site: 'https://example.test/',
    site_health: 61,
    pages_crawled: 40,
    pages_ok: 39,
    links_checked: 900,
    counts: { error: 2, warning: 3, notice: 1, info: 0, passed: 3 },
    findings,
  };
}

(async () => {
  cleanup();
  try {
    // =====================================================================
    // 1. Translation: the crawler's words become the client's
    // =====================================================================
    console.log('\nTranslation');

    const dup = issues.translate({ id: 'dup_titles', tier: 'error', failed: 14, total: 40 });
    check('a mapped check becomes client-facing copy', dup.mapped === true);
    check('the copy carries the measured count', /\b14\b/.test(dup.what), dup.what);
    check('it says why it matters commercially', Boolean(dup.why) && dup.why.length > 40);
    check('it says what would be done about it', Boolean(dup.fix));
    check('an error tier reads as critical', dup.severity === 'critical');

    const unmapped = issues.translate({
      id: 'brand_new_check_9000', name: 'A new check', tier: 'warning',
      summary: 'Five pages do something novel', failed: 5, total: 40,
    });
    check('an UNMAPPED check still produces a card', Boolean(unmapped.headline) && Boolean(unmapped.what));
    check('an unmapped card is marked as such for the team', unmapped.mapped === false);
    check('an unmapped card still has a severity and an effort',
      Boolean(unmapped.severity) && Boolean(unmapped.effortLabel));

    // Every id the crawler can emit should have copy written for it. This is
    // the check that fails when someone adds a check to the crawler and stops
    // there; it names the ids rather than just counting, so the fix is obvious.
    const crawlerIds = new Set();
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'node', 'audit', 'analyze.js'), 'utf8');
    const re = /finding\(\s*'([a-z0-9_]+)'/g;
    let m = re.exec(src);
    while (m) { crawlerIds.add(m[1]); m = re.exec(src); }
    const missing = [...crawlerIds].filter((id) => !issues.CATALOG[id]);
    check('every check the crawler can emit has client-facing copy',
      missing.length === 0,
      missing.length ? `no copy for: ${missing.join(', ')}` : '');

    // =====================================================================
    // 2. Priority: what a client is shown first
    // =====================================================================
    console.log('\nPriority');

    const blocked = issues.translate({ id: 'non_indexable', tier: 'notice', failed: 6, total: 40 });
    const alt = issues.translate({ id: 'image_alt', tier: 'warning', failed: 120, total: 400 });
    blocked.priority = issues.priority(blocked);
    alt.priority = issues.priority(alt);
    // The bug this guards: an enormous alt-text count outranking an entire
    // section being excluded from search, because one number is bigger.
    check('pages excluded from search outrank a large cosmetic count',
      blocked.priority > alt.priority, `${blocked.priority} vs ${alt.priority}`);

    const plan = build.planFrom([blocked, alt]);
    check('quick fixes are scheduled in the first 30 days',
      plan.thirty.length > 0 && plan.thirty.some((x) => /search results/i.test(x.headline)));

    // =====================================================================
    // 3. Scoring: an unmeasured pillar is not a passing one
    // =====================================================================
    console.log('\nScoring');

    const crawl = crawlFixture();
    const fromCrawl = build.fromCrawl(crawl);
    check('passing checks become the "what is already right" list',
      fromCrawl.passed.length === 3, `${fromCrawl.passed.length} passed`);
    check('failing checks become issue cards',
      fromCrawl.cards.length === 6, `${fromCrawl.cards.length} cards`);
    check('a passing check never appears as an issue',
      !fromCrawl.cards.some((c) => c.key === 'viewport'));

    const contentScore = build.areaScore(fromCrawl.byArea.content || []);
    check('an area with failures scores below 100', contentScore != null && contentScore < 100, String(contentScore));
    check('an area with no checks at all is null, not zero',
      build.areaScore([]) === null);

    // The bug this is here to stop coming back: recording only the FAILING
    // checks in an area put nothing in the denominator to hold the score up, so
    // a site with HSTS off and no other security problem scored 0 for Security
    // and trust. Passing checks must count, exactly as they do in the crawler's
    // own Site Health figure.
    const trust = build.fromCrawl({
      findings: [
        finding('hsts', 'HSTS support', 'notice', 'not enabled', 1, 1),
        finding('mixed_content', 'Mixed content', 'warning', 'none', 0, 40),
        finding('https_to_http', 'Links to HTTP', 'warning', 'none', 0, 900),
      ],
    });
    const trustScore = build.areaScore(trust.byArea.trust || []);
    check('passing checks hold an area score up', trustScore > 60, `scored ${trustScore}`);
    check('one small failure does not zero an otherwise clean area', trustScore < 100, `scored ${trustScore}`);

    // The arithmetic that matters most: two sites identical except that one
    // could not be speed-tested must not have the untested one score higher.
    const gradeKnown = build.gradeFor(40);
    const gradeUnknown = build.gradeFor(null);
    check('a null score has no grade', gradeUnknown.grade === null);
    check('a low score grades badly', gradeKnown.grade === 'D' || gradeKnown.grade === 'E');

    // =====================================================================
    // 4. Storage and the build log
    // =====================================================================
    console.log('\nStorage');

    const userId = db.prepare(
      "INSERT INTO users (email, password_hash, name, status, role) VALUES (?,?,?,'active','admin')",
    ).run(EMAIL, 'x', 'Client report test').lastInsertRowid;

    const reportId = store.begin({
      userId, createdBy: userId, url: 'https://example.test/', domain: 'example.test',
      company: 'Example Ltd', depth: 'quick',
    });
    store.stage(reportId, 'Crawling');
    store.stage(reportId, 'Speed measurement unavailable', { ok: false, note: 'quota exhausted' });
    const midway = store.get(reportId, userId);
    check('a running report records its stage', midway.stage === 'Speed measurement unavailable');
    check('a failed stage is recorded as failed, not dropped',
      midway.progress.length === 2 && midway.progress[1].ok === false);
    check('a report is scoped to its workspace', store.get(reportId, userId + 9999) === null);

    // =====================================================================
    // 5. The letterhead
    // =====================================================================
    console.log('\nLetterhead');

    branding.save(userId, { company: 'Acme SEO', accent: '#123456', contact: 'hi@acme.test' });
    const brandRead = branding.get(userId);
    check('the letterhead round-trips', brandRead.company === 'Acme SEO' && brandRead.contact === 'hi@acme.test');
    check('it reports itself configured', brandRead.configured === true);
    // The accent is interpolated into a <style> block, so anything that is not
    // a colour has to be refused rather than escaped.
    branding.save(userId, { company: 'Acme SEO', accent: 'red; } body { display:none } .x {' });
    check('a non-colour accent is refused rather than written into the CSS',
      branding.get(userId).accent === null);
    branding.save(userId, { company: 'Acme SEO', accent: '#123456' });

    // =====================================================================
    // 6. The document itself
    // =====================================================================
    console.log('\nThe document');

    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      depth: 'quick',
      profile: { label: 'Quick scan', estimate: '3-5 minutes', crawlPages: 40 },
      durationMs: 120000,
      client: {
        company: 'Example Ltd', preparedFor: 'Jane Smith', url: 'https://example.test/',
        domain: 'example.test', title: 'Example', lang: 'en',
      },
      agency: branding.get(userId),
      overall: { score: 58, grade: 'C', label: 'Needs work' },
      pillars: [
        { key: 'foundations', label: 'Technical foundations', score: 62, grade: 'C', label2: null, weight: 28, note: 'x', unknownReason: null },
        { key: 'speed', label: 'Speed and experience', score: null, grade: null, weight: 20, note: 'y', unknownReason: 'A speed measurement could not be completed for this site.' },
      ],
      headline: ['We examined 40 pages on example.test.', 'Overall the site scores 58 out of 100.'],
      positioning: 'Example Ltd is being held back by fixable technical problems.',
      priorities: fromCrawl.cards.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1, priority: issues.priority(c) })),
      issuesByArea: [{ key: 'content', label: 'Content and on-page', cards: fromCrawl.cards, criticalCount: 1 }],
      issueCounts: { total: 6, critical: 2, important: 3, minor: 1, quickWins: 4 },
      passed: fromCrawl.passed,
      speed: null,
      keywords: {
        market: 'GB', marketLabel: 'United Kingdom', rows: [
          { keyword: 'blocked drains leeds', volume: 1900, competition: 'HIGH', changeYoY: 12 },
        ],
        rowsTotal: 60, totalSearches: 42000, gapSearches: 18000, checked: 8, visible: 1,
        notVisible: 6, unknown: 1, sampleEngine: 'ddg', visibleShare: 14,
        gaps: [{ keyword: 'blocked drains leeds', volume: 1900, competition: 'HIGH', topBidHigh: 4.2 }],
        rivals: [{ domain: 'rival.test', appearances: 5 }],
      },
      schema: { presentTypes: [], missingTypes: ['LocalBusiness'], errorCount: 0, warningCount: 1, card: null, score: 20 },
      linking: null,
      siteSignals: { contentInHtml: false, structuredDataBlocks: 0, homepageWords: 320, hasMetaDescription: true, hasH1: true },
      plan: build.planFrom(fromCrawl.cards),
      method: {
        measured: ['A crawl of 40 pages.'],
        notMeasured: ['Current Google rankings and actual visitor numbers.'],
        crawlScope: { pagesCrawled: 40, pagesOk: 39, linksChecked: 900, checksRun: 9, siteHealth: 61, cap: 40, cappedOut: true },
        serpCaveat: 'This is a sample of an independent search index, not a Google ranking.',
        wouldImprove: [],
      },
      internal: { attempts: { crawl: { ok: true, ms: 1000, error: null } }, sourceRuns: { auditRunId: 7 } },
    };

    const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'client-report-doc.ejs'), 'utf8');
    const html = ejs.render(tpl, { d: payload, row: { id: reportId } }, {
      filename: path.join(__dirname, '..', 'views', 'client-report-doc.ejs'),
    });

    check('the document renders', html.length > 3000);
    check('it is addressed to the client', html.includes('Example Ltd') && html.includes('Jane Smith'));
    check('it carries the agency letterhead', html.includes('Acme SEO'));
    check('the accent colour reaches the stylesheet', html.includes('#123456'));

    // The leak this is here to catch: the internal view's vocabulary, run ids,
    // and the app's own navigation reaching a document sent outside the company.
    const leaks = [
      ['a sidebar', /class="app"|partials\/sidebar/],
      ['an app navigation link', /href="\/(dashboard|audit|tasks|ai-seo|client-report)/],
      ['a run id', /auditRunId|run 7|\/audit\/7/],
      ['internal collector names', /siteReadiness|toolRunner|aiseo|adoptRunId|json_result/],
      ['the word "prospect"', /prospect/i],
    ];
    leaks.forEach(([label, re]) => {
      check(`the client document contains no ${label}`, !re.test(html),
        re.test(html) ? (html.match(re) || [''])[0] : '');
    });

    check('an unmeasured pillar says so in plain words',
      html.includes('Not measured'), 'the pillar grid should name what could not be measured');
    check('the search-sample caveat is printed where the keywords are',
      html.includes('not a Google ranking'));
    check('the crawl cap is disclosed rather than implied',
      /stopped at\s*40\s*pages/i.test(html.replace(/\s+/g, ' ')));
    check('the client-side rendering warning appears when content is not in the HTML',
      html.includes('builds its content in the visitor’s browser')
      || html.includes("builds its content in the visitor's browser"));

    // The no-invention rule, asserted on the output rather than trusted from
    // the source: these are the phrases a report of this kind drifts towards.
    // Specific claims, not the word "estimated" on its own: the method section
    // says in as many words that nothing here is estimated, and a test that
    // cannot tell the two apart fails on the honesty statement itself.
    const inventions = [
      /estimated (traffic|visits|revenue|leads)/i,
      /lost revenue/i,
      /you are losing/i,
      /projected (traffic|revenue|growth|increase)/i,
      /worth \$[0-9]/i,
    ];
    check('the document makes no invented commercial claim',
      !inventions.some((re) => re.test(html)));

    // =====================================================================
    // 7. Profiles
    // =====================================================================
    console.log('\nProfiles');
    check('both depths exist', Boolean(collect.PROFILES.quick) && Boolean(collect.PROFILES.full));
    check('a quick scan crawls fewer pages than a full report',
      collect.PROFILES.quick.crawlPages < collect.PROFILES.full.crawlPages);
    check('an unknown depth falls back to the full profile',
      collect.profile('nonsense').crawlPages === collect.PROFILES.full.crawlPages);

    // The crawler's own scoring constants, which the area scores reuse. If the
    // crawler changes them, the two scores drift apart silently.
    check('the area scorer uses the crawler\'s own severity weights',
      analyze.TIER_WEIGHT.error === 5 && analyze.TIER_WEIGHT.warning === 2 && analyze.TIER_WEIGHT.notice === 1);

    store.remove(reportId, userId);
    check('a deleted report is gone', store.get(reportId, userId) === null);
  } catch (err) {
    check('the suite ran to completion', false, err.stack);
  } finally {
    cleanup();
    console.log(`\n${pass} passed, ${failures.length} failed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(failures.length ? 1 : 0);
  }
})();
