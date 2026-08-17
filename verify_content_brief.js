// Verifies contentBrief.js's data-derived recommendedTitle/suggestedHeadings
// pipeline against three scenarios:
//   (a) a brand with historical top-performing page titles -> brand-history title
//   (b) a brand with GSC query data but no crawled pages -> query-derived title
//   (c) a cold-start brand with no data at all -> template fallback, correctly labeled
//
// Uses the real sqlite db (data/app.db) with disposable rows (a dedicated test
// user + three test brands), cleaned up in a `finally` block regardless of
// outcome. Run with: node verify_content_brief.js
const assert = require('assert');
const db = require('./src/db');
const contentBrief = require('./src/lib/contentBrief');

const MARK = 'verify-content-brief-tmp';
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`OK   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${e.message}`);
  }
}

function makeCluster(overrides) {
  return Object.assign({
    id: 1,
    primaryKeyword: 'commercial cleaning services',
    supportingKeywords: ['office cleaning cost', 'commercial cleaning near me', 'best commercial cleaning company'],
    keywordCount: 4,
    recommendation: 'new-page',
    recommendationReason: null,
    existingPage: null,
    intent: 'Commercial investigation',
    intentConfidence: 0.8,
    suggestedPageType: 'service',
  }, overrides);
}

let userId;
const brandIds = [];

function makeBrand(name) {
  const r = db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`).run(`${MARK}-unused@example.com`);
  return r;
}

try {
  // One throwaway user, three throwaway brands (one per scenario).
  const userRow = db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`).run(`${MARK}@example.com`);
  userId = userRow.lastInsertRowid;

  const brandHistoryBrand = db.prepare(`INSERT INTO brands (user_id, name, site_url) VALUES (?,?,?)`)
    .run(userId, `${MARK}-history`, 'https://history.example.com');
  const queryOnlyBrand = db.prepare(`INSERT INTO brands (user_id, name, site_url) VALUES (?,?,?)`)
    .run(userId, `${MARK}-query`, 'https://queryonly.example.com');
  const coldStartBrand = db.prepare(`INSERT INTO brands (user_id, name, site_url) VALUES (?,?,?)`)
    .run(userId, `${MARK}-cold`, 'https://cold.example.com');
  brandIds.push(brandHistoryBrand.lastInsertRowid, queryOnlyBrand.lastInsertRowid, coldStartBrand.lastInsertRowid);

  // --- Scenario (a): brand-history --------------------------------------
  const historyBrand = { id: brandHistoryBrand.lastInsertRowid, name: 'Sparkle Facilities', vertical: 'default' };
  db.prepare(`INSERT INTO gsc_page_daily (brand_id, date, page, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)`)
    .run(historyBrand.id, '2026-01-01', 'https://history.example.com/office-cleaning-services', 500, 5000, 0.1, 3.2);
  // topPages()/latestGscDate() anchor off gsc_daily, not gsc_page_daily.
  db.prepare(`INSERT INTO gsc_daily (brand_id, date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)`)
    .run(historyBrand.id, '2026-01-01', 500, 5000, 0.1, 3.2);
  const crawlPages = [{
    kind: 'content',
    url: 'https://history.example.com/office-cleaning-services',
    title: 'Best Office Cleaning Services | Sparkle Facilities',
    primary_keyword: 'office cleaning services',
    top_terms: ['office', 'cleaning', 'commercial'],
    word_count: 900,
    pagerank: 0.4,
  }];
  const cluster = makeCluster();
  const historyResult = contentBrief.recommendedTitle(cluster, historyBrand, crawlPages);

  check('brand-history: derives method=brand-history', () => {
    assert.strictEqual(historyResult.method, 'brand-history');
  });
  check('brand-history: keeps the source page\'s wrapper words ("Best", brand suffix)', () => {
    assert.ok(/^Best /.test(historyResult.title), `expected leading "Best ", got "${historyResult.title}"`);
    assert.ok(historyResult.title.includes('| Sparkle Facilities'), `expected brand suffix, got "${historyResult.title}"`);
  });
  check('brand-history: swaps in the NEW keyword, not the old one', () => {
    assert.ok(/commercial cleaning services/i.test(historyResult.title), `expected new keyword in "${historyResult.title}"`);
    assert.ok(!/^Best Office Cleaning/i.test(historyResult.title), `old keyword should have been replaced, got "${historyResult.title}"`);
  });
  check('brand-history: not a generic vertical template string', () => {
    const generic = contentBrief.templatedTitle(cluster, historyBrand);
    assert.notStrictEqual(historyResult.title, generic);
  });

  // --- Scenario (b): query-derived, no crawled pages ----------------------
  const queryBrand = { id: queryOnlyBrand.lastInsertRowid, name: 'CleanCo', vertical: 'default' };
  db.prepare(`INSERT INTO gsc_query_daily (brand_id, date, query, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)`)
    .run(queryBrand.id, '2026-01-01', 'commercial cleaning services cost', 40, 3000, 0.013, 8.1);
  db.prepare(`INSERT INTO gsc_query_daily (brand_id, date, query, clicks, impressions, ctr, position)
    VALUES (?,?,?,?,?,?,?)`)
    .run(queryBrand.id, '2026-01-01', 'unrelated widget topic', 5, 50, 0.1, 2);
  // gsc_daily row so analytics' latestGscDate() anchor resolves.
  db.prepare(`INSERT INTO gsc_daily (brand_id, date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)`)
    .run(queryBrand.id, '2026-01-01', 45, 3050, 0.02, 7);
  const queryResult = contentBrief.recommendedTitle(cluster, queryBrand, []);

  check('query-derived: derives method=query when no crawl data exists', () => {
    assert.strictEqual(queryResult.method, 'query');
  });
  check('query-derived: title is the real top query, not invented', () => {
    assert.strictEqual(queryResult.title.toLowerCase(), 'commercial cleaning services cost');
  });

  // --- Scenario (c): cold start, no data at all ---------------------------
  const coldBrand = { id: coldStartBrand.lastInsertRowid, name: 'BrandNew Co', vertical: 'default' };
  const coldResult = contentBrief.recommendedTitle(cluster, coldBrand, []);
  check('cold-start: falls back to template without crashing', () => {
    assert.strictEqual(coldResult.method, 'template');
    assert.strictEqual(coldResult.title, contentBrief.templatedTitle(cluster, coldBrand));
  });

  // --- Headings: query-derived vs template fallback -----------------------
  const headingsQueryResult = contentBrief.suggestedHeadings(cluster, queryBrand);
  // `method` is now a two-value summary ('data' | 'template') because the
  // intro headings and the body headings are derived by different routes and
  // can disagree. The specific route each half took is reported separately as
  // introMethod / bodyMethod.
  check('headings: query brand reports data-derived intro headings from real queries', () => {
    assert.strictEqual(headingsQueryResult.method, 'data');
    assert.strictEqual(headingsQueryResult.introMethod, 'query');
    assert.ok(headingsQueryResult.headings.some((h) => /cost/i.test(h)), `expected a cost-related heading, got ${JSON.stringify(headingsQueryResult.headings)}`);
  });
  const headingsColdResult = contentBrief.suggestedHeadings(cluster, coldBrand);
  check('headings: cold-start brand falls back to template', () => {
    assert.strictEqual(headingsColdResult.method, 'template');
  });
  // CONTRACT CHANGE (deliberate): supporting keywords are no longer emitted
  // verbatim as headings one-for-one.
  //
  // The old behaviour produced outlines where most headings restated the same
  // thing — the live brand's stored brief listed "Website Design Usa",
  // "Website Design In Usa" and "Website Design Services Usa" as three
  // separate sections, which no writer can build a page from. Body headings
  // now come from clustering's sub-topics where they exist, and near-duplicate
  // headings are collapsed.
  //
  // What is still guaranteed: every supporting keyword is REPRESENTED by some
  // heading, even when its exact wording was merged into a sibling.
  check('headings: every supporting keyword is represented by some heading', () => {
    const headingBlob = headingsQueryResult.headings.join(' ').toLowerCase();
    cluster.supportingKeywords.forEach((k) => {
      const contentWords = k.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const represented = contentWords.length === 0
        || contentWords.some((w) => headingBlob.includes(w.slice(0, Math.max(4, w.length - 2))));
      assert.ok(represented, `supporting keyword "${k}" is not represented in ${JSON.stringify(headingsQueryResult.headings)}`);
    });
  });

  check('headings: no two headings restate the same section', () => {
    const seen = new Set();
    headingsQueryResult.headings.forEach((h) => {
      const sig = h.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3).sort()
        .join(' ');
      if (!sig) return;
      assert.ok(!seen.has(sig), `duplicate heading section: "${h}"`);
      seen.add(sig);
    });
  });

  // --- Full build() pipeline doesn't crash and labels fieldSources correctly
  const fullBrand = db.prepare('SELECT * FROM brands WHERE id=?').get(coldStartBrand.lastInsertRowid);
  const built = contentBrief.build(fullBrand, cluster);
  check('build(): cold-start brand output has fieldSources.recommendedTitle=template', () => {
    assert.strictEqual(built.fieldSources.recommendedTitle, 'template');
    assert.strictEqual(built.fieldSources.suggestedHeadings, 'template');
  });

  const fullHistoryBrandRow = db.prepare('SELECT * FROM brands WHERE id=?').get(brandHistoryBrand.lastInsertRowid);
  const builtHistory = contentBrief.build(fullHistoryBrandRow, cluster);
  check('build(): brand with GSC history but no linking_runs still runs cleanly (falls back to template)', () => {
    // No linking_runs row exists for this test brand, so build()'s own
    // crawlPages lookup (via linking_runs -> csvStore.readCrawlData) is
    // empty regardless of the crawlPages array used in the unit-level test
    // above — this only re-confirms build() doesn't crash end-to-end and
    // still labels the result 'template' honestly when it has no crawl
    // inventory wired up, rather than crashing or mislabeling.
    assert.strictEqual(builtHistory.fieldSources.recommendedTitle, 'template');
  });
} finally {
  // Clean up every disposable row, children first (FK ON DELETE CASCADE
  // covers brands->gsc_* already, but user delete cascades brands too — this
  // is just explicit/defensive).
  brandIds.forEach((id) => {
    db.prepare('DELETE FROM gsc_page_daily WHERE brand_id=?').run(id);
    db.prepare('DELETE FROM gsc_query_daily WHERE brand_id=?').run(id);
    db.prepare('DELETE FROM gsc_daily WHERE brand_id=?').run(id);
    db.prepare('DELETE FROM brands WHERE id=?').run(id);
  });
  if (userId) db.prepare('DELETE FROM users WHERE id=?').run(userId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
