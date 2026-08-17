// Coverage for the task lifecycle, geographic partitioning and brand-signal
// helpers.
//
// These are the paths where a mistake is silent and expensive:
//   - reconcile() closes tasks automatically. If it over-reaches it deletes
//     someone's work; if it under-reaches the backlog fills with dead rows.
//     The cross-engine case is the dangerous one: keyword clustering and the
//     opportunity engine both write tasks with source 'opportunity', so
//     scoping by source alone would make each retire the other's tasks.
//   - the geo partition decides whether "web design atlanta" can share a
//     cluster with "web design usa". Getting it wrong puts a city name in a
//     national page's title, which is what shipped before.
//   - branded-query exclusion decides whether a company's own name is filed
//     as a cannibalisation defect.
//
// Runs against a temporary in-memory-ish brand inside a transaction that is
// always rolled back, so it never touches real data.
//
// Run:  node verify_lifecycle_and_places.js
const assert = require('assert');

const db = require('./src/db');
const tasksLib = require('./src/lib/tasks');
const clustering = require('./src/lib/clustering');
const places = require('./src/lib/places');
const S = require('./src/lib/seoSignals');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

db.prepare('BEGIN').run();
try {
  const userRow = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const userId = userRow ? userRow.id : 1;
  const brandIns = db.prepare(
    "INSERT INTO brands (user_id, name, site_url, active) VALUES (?,'Lifecycle Test','https://lifecycle-test.example',1)",
  ).run(userId);
  const brandId = brandIns.lastInsertRowid;

  const mkTask = (dedupeKey, status = 'backlog') => {
    const r = tasksLib.upsertTask({
      userId,
      brandId,
      title: `T ${dedupeKey}`,
      detail: 'x',
      source: 'opportunity',
      dedupeKey,
    });
    if (status !== 'backlog') {
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, r.task.id);
    }
    return r.task.id;
  };

  // ---------------------------------------------------------------- reconcile
  console.log('\n[task lifecycle]');

  const keep = mkTask(`task:opp:${brandId}:ctr_gap:/keep`);
  const gone = mkTask(`task:opp:${brandId}:ctr_gap:/gone`);
  const started = mkTask(`task:opp:${brandId}:ctr_gap:/started`, 'in_progress');
  const alreadyDone = mkTask(`task:opp:${brandId}:ctr_gap:/done`, 'done');
  const otherFamily = mkTask(`task:cluster:${brandId}:some topic`);

  const res = tasksLib.reconcile(userId, brandId, 'opportunity',
    [`task:opp:${brandId}:ctr_gap:/keep`], {
      sourceRef: 'test run',
      keyPrefix: `task:opp:${brandId}:`,
    });

  const statusOf = (id) => db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;

  check('a still-detected finding stays in the backlog', () => {
    assert.strictEqual(statusOf(keep), 'backlog');
  });
  check('a finding that disappeared is auto-resolved', () => {
    assert.strictEqual(statusOf(gone), 'dismissed');
    assert.strictEqual(res.resolved, 1);
  });
  check('a task someone has STARTED is never auto-closed', () => {
    assert.strictEqual(statusOf(started), 'in_progress');
    assert.strictEqual(res.annotated, 1);
  });
  check('the started task is annotated so the change is visible', () => {
    const ev = db.prepare("SELECT COUNT(*) c FROM task_events WHERE task_id=? AND kind='stale'").get(started);
    assert.ok(ev.c >= 1, 'expected a stale event on the in-progress task');
  });
  check('an already-closed task is left alone', () => {
    assert.strictEqual(statusOf(alreadyDone), 'done');
  });
  check('auto-resolution is written to the event log', () => {
    const ev = db.prepare("SELECT COUNT(*) c FROM task_events WHERE task_id=? AND kind='auto_resolved'").get(gone);
    assert.strictEqual(ev.c, 1);
  });
  check('a completion note explains why it closed', () => {
    const t = db.prepare('SELECT completion_note FROM tasks WHERE id=?').get(gone);
    assert.ok(/no longer detected/i.test(t.completion_note || ''), t.completion_note);
  });

  // The cross-engine guard. Both engines use source 'opportunity'.
  check('reconcile NEVER touches another engine\'s task family', () => {
    assert.strictEqual(statusOf(otherFamily), 'backlog');
  });

  check('reconcile without a keyPrefix stays inside its source', () => {
    const auditTask = tasksLib.upsertTask({
      userId, brandId, title: 'audit thing', detail: 'x', source: 'audit', dedupeKey: 'task:audit:1',
    }).task.id;
    tasksLib.reconcile(userId, brandId, 'opportunity', [], { keyPrefix: `task:opp:${brandId}:` });
    assert.strictEqual(statusOf(auditTask), 'backlog');
  });

  check('reconcile is scoped to one brand', () => {
    const otherBrand = db.prepare(
      "INSERT INTO brands (user_id, name, site_url, active) VALUES (?,'Other','https://other.example',1)",
    ).run(userId).lastInsertRowid;
    const otherId = tasksLib.upsertTask({
      userId, brandId: otherBrand, title: 'other brand task', detail: 'x',
      source: 'opportunity', dedupeKey: `task:opp:${otherBrand}:ctr_gap:/x`,
    }).task.id;
    tasksLib.reconcile(userId, brandId, 'opportunity', [], { keyPrefix: 'task:opp:' });
    assert.strictEqual(statusOf(otherId), 'backlog');
  });

  // ------------------------------------------------------------------ places
  console.log('\n[geographic partitioning]');

  check('different cities never share a cluster', () => {
    const r = clustering.cluster([
      { keyword: 'web design atlanta', impressions: 100 },
      { keyword: 'web design chicago', impressions: 90 },
    ]);
    assert.strictEqual(r.clusters.length, 2, JSON.stringify(r.clusters.map((c) => c.primaryKeyword)));
  });

  check('a city keyword never joins a national cluster', () => {
    const r = clustering.cluster([
      { keyword: 'web design services usa', impressions: 100 },
      { keyword: 'web design services atlanta', impressions: 90 },
    ]);
    assert.strictEqual(r.clusters.length, 2);
  });

  check('same-city keywords DO cluster together', () => {
    const r = clustering.cluster([
      { keyword: 'web design atlanta', impressions: 100 },
      { keyword: 'web design services atlanta', impressions: 90 },
    ]);
    assert.strictEqual(r.clusters.length, 1);
  });

  check('a cluster reports the geography it targets', () => {
    const r = clustering.cluster([{ keyword: 'web design atlanta', impressions: 10 }]);
    assert.strictEqual(r.clusters[0].isGeoTargeted, true);
    assert.strictEqual(r.clusters[0].placeKey, 'atlanta');
  });

  check('a national cluster is not marked geo-targeted', () => {
    const r = clustering.cluster([{ keyword: 'custom web development', impressions: 10 }]);
    assert.strictEqual(r.clusters[0].isGeoTargeted, false);
  });

  check('"mobile app development" is not read as Mobile, Alabama', () => {
    assert.strictEqual(places.hasPlace('mobile app development'), false);
  });

  check('an unrecognised town is reported rather than swallowed', () => {
    const found = places.unrecognisedPlaceCandidates(['plumber in stockport', 'plumber in stockport ltd']);
    assert.ok(found.some((f) => f.word === 'stockport'), JSON.stringify(found));
  });

  check('a recognised city is NOT reported as unrecognised', () => {
    const found = places.unrecognisedPlaceCandidates(['web design in chicago']);
    assert.strictEqual(found.length, 0, JSON.stringify(found));
  });

  check('non-places after a preposition are not reported as towns', () => {
    const found = places.unrecognisedPlaceCandidates(['buy links in bulk', 'items in stock']);
    assert.strictEqual(found.length, 0, JSON.stringify(found));
  });

  // ------------------------------------------------------------- intent/brand
  console.log('\n[intent and brand signals]');

  check('country-scale "in usa" is not Local intent', () => {
    const r = clustering.classifyIntent(['website design services in usa'], 'professional_services', null);
    assert.notStrictEqual(r.intent, 'Local');
  });

  check('a market of "United States" cannot force Local intent', () => {
    const r = clustering.classifyIntent(
      ['web design united states', 'web development united states'], 'professional_services', 'United States',
    );
    assert.notStrictEqual(r.intent, 'Local');
  });

  check('"near me" is still Local intent', () => {
    const r = clustering.classifyIntent(['web design near me'], 'other', null);
    assert.strictEqual(r.intent, 'Local');
  });

  check('intent confidence is no longer "high" for a single weak signal', () => {
    const r = clustering.classifyIntent(['web design company'], 'other', null);
    assert.notStrictEqual(r.confidence, 'high');
  });

  check('a brand name is detected as branded', () => {
    const terms = S.brandTerms({ name: 'American Web Builders', site_url: 'https://www.americanwebbuilders.com/' });
    assert.strictEqual(S.isBrandedQuery('american web builders reviews', terms), true);
    assert.strictEqual(S.isBrandedQuery('americanwebbuilders', terms), true);
  });

  check('generic words inside a brand name are NOT branded on their own', () => {
    const terms = S.brandTerms({ name: 'American Web Builders', site_url: 'https://www.americanwebbuilders.com/' });
    assert.strictEqual(S.isBrandedQuery('web design usa', terms), false);
    assert.strictEqual(S.isBrandedQuery('custom web development company', terms), false);
  });

  check('the CTR curve never returns zero for a real position', () => {
    const curve = S.ctrCurve(null, null);
    [1, 3, 8, 18, 45, 90].forEach((p) => {
      assert.ok(S.lookupCurve(curve.curve, p) > 0, `position ${p} returned a zero benchmark`);
    });
  });

  // ------------------------------------------------------------ empty inputs
  console.log('\n[degenerate input]');

  check('an all-stopword keyword list returns a complete, saveable result', () => {
    const r = clustering.cluster(['the and for', 'a of to']);
    assert.strictEqual(r.clusterCount, 0);
    assert.ok(r.emptyReason, 'expected an emptyReason explaining why');
    const id = clustering.saveRun(userId, brandId, 'empty', 'paste', r);
    assert.ok(id, 'saveRun should not throw on an empty result');
  });

  check('an empty keyword list explains that nothing was supplied', () => {
    const r = clustering.cluster([]);
    assert.match(r.emptyReason, /No keywords were supplied/i);
  });
} finally {
  db.prepare('ROLLBACK').run();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
