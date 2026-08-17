// Verification script for the vertical/locale hardening pass on
// clustering.js and opportunities.js. Run with: node tools/verify_clustering_opportunities.js
/* eslint-disable no-console */
const assert = require('assert');
const clustering = require('../src/lib/clustering');
const opportunities = require('../src/lib/opportunities');

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`OK   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- locale

check('en stemming (default/unset locale): plural collapses as before', () => {
  assert.deepStrictEqual(clustering.tokenize('web designers'), clustering.tokenize('web designer'));
});

check('non-English locale (es) skips English suffix rules, uses Spanish rules', () => {
  // "casas" (houses) under the OLD English-only rule would strip trailing
  // "s" -> "casa", which happens to look right by accident here, but the
  // real proof is that an English-only word run through 'es' is NOT
  // mangled by English-specific rules like "-ing"/"-ers".
  const es1 = clustering.tokenize('cocinas baratas', 'es'); // "cheap kitchens"
  const en1 = clustering.tokenize('cocinas baratas', 'en');
  assert.notDeepStrictEqual(es1, en1, 'es and en tokenization should differ for a Spanish phrase');
});

check('unsupported locale (it) does NOT apply English stemming (identity fallback)', () => {
  const word = 'houses'; // would be stemmed to "house" under English rules
  const it = clustering.stem(word, 'it'); // unsupported locale -> identity
  const en = clustering.stem(word, 'en'); // supported locale -> real stemming
  assert.strictEqual(it, word, 'unsupported locale must return the word unchanged, not English-stemmed');
  assert.notStrictEqual(en, word, 'sanity: en rules actually do something, proving the it path is a real, meaningful branch');
});

check('locale defaults to en when unset (brand.locale is null/undefined)', () => {
  assert.strictEqual(clustering.normalizeLocale(undefined), 'en');
  assert.strictEqual(clustering.normalizeLocale(null), 'en');
  assert.strictEqual(clustering.normalizeLocale('EN-US'), 'en');
  assert.strictEqual(clustering.normalizeLocale('fr-CA'), 'fr');
});

// ---------------------------------------------------------------- market

check('market whitelist: static token fallback works synchronously with no network', () => {
  const wl = clustering.marketPlaceWhitelist('Greater Manchester, UK');
  assert.ok(wl && wl.size > 0, 'expected a non-empty whitelist from the market string alone');
  assert.ok(wl.has('manchester') || wl.has('greater manchester'), 'expected the market name itself to be in the whitelist');
});

check('classifyIntent: brand-market place name drives Local intent even without "near/in"', () => {
  const market = 'Greater Manchester, UK';
  // Warm synchronously-available fallback (no await needed; whitelist is
  // seeded immediately, before any network call resolves).
  clustering.marketPlaceWhitelist(market);
  const result = clustering.classifyIntent(['emergency plumber manchester', 'boiler repair manchester'], 'local_service', market);
  assert.strictEqual(result.intent, 'Local', `expected Local intent, got ${result.intent}`);
});

check('classifyIntent: no market configured falls back to the original near/in + phrase heuristics only', () => {
  const result = clustering.classifyIntent(['plumber near me', 'boiler repair near me'], 'local_service', null);
  assert.strictEqual(result.intent, 'Local');
});

// ---------------------------------------------------------------- stats test

// Manual math check for the writeup:
// Case A: prior 100 clicks / 28 days, recent 40 clicks / 28 days (60% drop, high volume)
//   lambda1 = 100/28 = 3.5714   lambda2 = 40/28 = 1.4286
//   se1 = sqrt(100)/28 = 0.3571  se2 = sqrt(40)/28 = 0.2259
//   se = sqrt(0.3571^2+0.2259^2) = sqrt(0.1275+0.0510) = sqrt(0.1785) = 0.4225
//   z = (3.5714-1.4286)/0.4225 = 2.1429/0.4225 = 5.073  -> way above 1.645, SIGNIFICANT
check('significant drop: high-volume real drop (100->40 over 28d) is flagged', () => {
  const sig = opportunities.isSignificantRateDrop(100, 28, 40, 28, { confidence: 0.95, minRelativeDrop: 0.2 });
  assert.strictEqual(sig, true);
});

// Case B: prior 10 clicks / 28 days, recent 7 clicks / 28 days (30% drop, LOW volume — classic noise case)
//   lambda1 = 10/28 = 0.3571  lambda2 = 7/28 = 0.25
//   se1 = sqrt(10)/28 = 0.1129  se2 = sqrt(7)/28 = 0.0945
//   se = sqrt(0.01274+0.00893) = sqrt(0.02167) = 0.1472
//   z = (0.3571-0.25)/0.1472 = 0.1071/0.1472 = 0.728 -> below 1.645, NOT significant
// This is exactly the "10 clicks became 7" false-positive case the old
// heuristic's comment called out by name.
check('significant drop: low-volume noisy drop (10->7 over 28d) is NOT flagged', () => {
  const sig = opportunities.isSignificantRateDrop(10, 28, 7, 28, { confidence: 0.95, minRelativeDrop: 0.2 });
  assert.strictEqual(sig, false);
});

// Case C: same 30% relative drop as Case B, but at higher volume: 300 -> 210 over 28d
//   lambda1 = 300/28=10.714 lambda2=210/28=7.5
//   se1=sqrt(300)/28=0.618 se2=sqrt(210)/28=0.518
//   se=sqrt(0.618^2+0.518^2)=sqrt(0.382+0.268)=sqrt(0.650)=0.806
//   z=(10.714-7.5)/0.806=3.214/0.806=3.987 -> SIGNIFICANT
// Demonstrates the core point of switching to a real test: the SAME 30%
// drop is noise at n=10 but a real signal at n=300.
check('significant drop: same 30% relative drop is flagged at higher volume (300->210)', () => {
  const sig = opportunities.isSignificantRateDrop(300, 28, 210, 28, { confidence: 0.95, minRelativeDrop: 0.2 });
  assert.strictEqual(sig, true);
});

// Case D: unequal exposure windows (refreshCandidates shape): baseline 60
// clicks over 62 days vs recent 20 clicks over 28 days.
//   lambda1 = 60/62 = 0.968  lambda2 = 20/28 = 0.714
//   se1 = sqrt(60)/62 = 0.1249  se2 = sqrt(20)/28 = 0.1597
//   se = sqrt(0.0156+0.0255)=sqrt(0.0411)=0.2027
//   z = (0.968-0.714)/0.2027 = 0.254/0.2027 = 1.253 -> below 1.645, NOT significant
//   (relativeDrop = 26.2%, clears a 25% floor, but the z-test still says no)
check('significant drop: unequal windows correctly handled, floor-pct alone is insufficient', () => {
  const sig = opportunities.isSignificantRateDrop(60, 62, 20, 28, { confidence: 0.95, minRelativeDrop: 0.25 });
  assert.strictEqual(sig, false);
});

check('no drop / increase never flagged', () => {
  assert.strictEqual(opportunities.isSignificantRateDrop(50, 28, 60, 28, { confidence: 0.95 }), false);
  assert.strictEqual(opportunities.isSignificantRateDrop(0, 28, 0, 28, { confidence: 0.95 }), false);
});

console.log(`\n${pass} check(s) passed${process.exitCode ? ', with failures above' : ''}.`);
