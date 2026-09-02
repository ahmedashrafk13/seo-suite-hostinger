// VERIFICATION — the modules added for the keyword-metrics, noise-filtering,
// page-type, schema-builder, link-finder, site-readiness, review-platform and
// gap-analysis work.
//
// Same shape and same rules as verify_aiseo.js: assertions against real inputs,
// no mocking of the things being tested, and every network check clearly
// separated so the suite is useful offline.
//
//   node verify_gaps.js          deterministic checks only
//   node verify_gaps.js --full   adds the live network checks
const assert = require('assert');

const FULL = process.argv.includes('--full');

let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

(async () => {
  const markets = require('./src/lib/aiseo/markets');
  const serpLite = require('./src/lib/aiseo/serpLite');
  const keywordMetrics = require('./src/lib/aiseo/keywordMetrics');
  const boilerplate = require('./src/lib/aiseo/boilerplate');
  const headings = require('./src/lib/aiseo/headings');
  const pageType = require('./src/lib/aiseo/pageType');
  const schemaBuilder = require('./src/lib/aiseo/schemaBuilder');
  const linkFinder = require('./src/lib/aiseo/linkFinder');
  const siteReadiness = require('./src/lib/aiseo/siteReadiness');
  const reviewPlatforms = require('./src/lib/aiseo/reviewPlatforms');
  const gapAnalysis = require('./src/lib/aiseo/gapAnalysis');
  const providers = require('./src/lib/aiseo/providers');
  const { parseDocument } = require('./src/lib/aiseo/fetcher');

  const doc = (url, html) => parseDocument(url, html);

  // =====================================================================
  section('1. Markets — one country, every identifier');

  check('a country resolves to the identifier each source expects', () => {
    const gb = markets.resolve('GB');
    assert.strictEqual(gb.gl, 'gb', 'Google wants gl=gb, not gl=uk');
    assert.strictEqual(gb.trendsGeo, 'GB');
    assert.strictEqual(gb.ddg, 'uk-en', 'DuckDuckGo uses uk-en for the same country');
    assert.strictEqual(gb.dfsLocation, 2826);
  });

  check('an unrecognised country resolves to worldwide rather than throwing', () => {
    const m = markets.resolve('not-a-country');
    assert.strictEqual(m.code, 'ZZ');
    assert.strictEqual(m.worldwide, true);
  });

  check('a lowercase Google gl resolves to the same row as the ISO code', () => {
    assert.strictEqual(markets.resolve('gb').code, markets.resolve('GB').code);
  });

  check('null resolves to worldwide, so a brand with no market never breaks a run', () => {
    assert.strictEqual(markets.resolve(null).code, 'ZZ');
    assert.strictEqual(markets.resolve('').code, 'ZZ');
  });

  // =====================================================================
  section('2. Boilerplate — what gets excluded before anything is measured');

  const chromeHtml = `<html><body>
    <header><nav><a href="/">Home</a><a href="/x">Learn More</a></nav></header>
    <main>
      <h1>Basel III capital adequacy</h1>
      <p>Basel III sets minimum capital requirements for internationally active banks, and the framework was published in 2010 after the financial crisis.</p>
      <div class="pricing"><span>From</span><span>$99</span><span>per month</span><span>Most Popular</span><span>Save 20%</span></div>
    </main>
    <footer><div class="social">Follow us</div><p>Copyright 2026 Acme Ltd. All rights reserved.</p></footer>
  </body></html>`;

  check('navigation, footer and social blocks are removed from the measured text', () => {
    const c = boilerplate.contentText(doc('https://x.test/', chromeHtml));
    assert.ok(!/Follow us/i.test(c.text), 'the social block survived');
    assert.ok(!/All rights reserved/i.test(c.text), 'the footer survived');
    assert.ok(/Basel III/.test(c.text), 'the real content was removed');
  });

  check('a repeated pricing label is removed even inside the main content region', () => {
    const c = boilerplate.contentText(doc('https://x.test/', chromeHtml));
    assert.ok(!/Most Popular/i.test(c.text), '"Most Popular" survived');
    assert.ok(!/\$99/.test(c.text), 'a bare price survived');
    const removedLabels = c.removed.filter((r) => r.selector === '(leaf label)').map((r) => r.preview);
    assert.ok(removedLabels.includes('Most Popular'), 'the removal was not recorded');
  });

  check('stripping never returns an empty body for a page that had one', () => {
    // A page built entirely of elements the filter treats as chrome.
    const allChrome = '<html><body><div class="widget"><p>The entire content of this page lives inside a widget div, which the selector list treats as furniture, and there is a good deal of it here.</p></div></body></html>';
    const c = boilerplate.contentText(doc('https://x.test/', allChrome));
    assert.ok(c.words > 0, 'the page was measured as empty');
    assert.ok(c.fellBack, 'the fallback was not recorded');
    assert.ok(/measured from the unstripped text/i.test(c.reason), 'the reason was not explained');
  });

  check('a generic UI label is recognised and a real name containing it is not', () => {
    assert.strictEqual(boilerplate.isGenericUi('Learn More'), true);
    assert.strictEqual(boilerplate.isGenericUi('Why Choose Us'), true);
    assert.strictEqual(boilerplate.isGenericUi('Office Headquarters'), true);
    assert.strictEqual(boilerplate.isGenericUi('Check'), true);
    assert.strictEqual(boilerplate.isGenericUi('Check Point Software'), false, 'a real company name was suppressed');
    assert.strictEqual(boilerplate.isGenericUi('Basel III'), false);
  });

  check('competitor brand terms are derived from the domain and the title', () => {
    const terms = boilerplate.competitorBrandTerms([
      { domain: 'starfish-bistro.com' },
      { domain: 'example.com', homeTitle: 'Menu | Saint Urbain' },
    ]);
    assert.ok(terms.has('starfish'), 'the domain label was not captured');
    assert.ok(terms.has('saint urbain'), 'the title brand was not captured');
    assert.ok(terms.has('urbain'), 'the distinctive word was not captured');
  });

  check('the entity filter suppresses competitor brands and generic labels, and says why', () => {
    const terms = boilerplate.competitorBrandTerms([{ domain: 'starfish-bistro.com' }, { domain: 'x.com', label: 'Saint Urbain' }]);
    const r = boilerplate.filterEntities([
      { surface: 'Starfish', type: 'proper-noun' },
      { surface: 'Saint Urbain', type: 'proper-noun' },
      { surface: 'Learn More', type: 'proper-noun' },
      { surface: 'Office Headquarters', type: 'proper-noun' },
      { surface: 'Basel III', type: 'proper-noun' },
    ], { competitorTerms: terms });
    assert.strictEqual(r.kept.length, 1, 'the wrong number of entities survived');
    assert.strictEqual(r.kept[0].surface, 'Basel III');
    assert.strictEqual(r.suppressedCount, 4);
    assert.ok(r.summary.some((x) => /competitor brand name/.test(x)), 'the reasons were not summarised');
  });

  check('a repeated list item is detected as template text, not only a repeated sentence', () => {
    // This is the case that produced six identical link recommendations on a
    // live site: a <li> with no terminating punctuation, in a plain div.
    const page = (n) => doc(`https://x.test/${n}`, `<html><body><main><h1>Page ${n}</h1><p>Unique prose for page ${n} that differs from every other page on this site entirely.</p><ul><li>Unlimited Pages Website with Unique Design</li></ul></main></body></html>`);
    const t = boilerplate.repeatedBlocks([page(1), page(2), page(3), page(4), page(5)]);
    assert.ok(t.usable, 'template detection did not run');
    assert.ok(t.blocks.has('unlimited pages website with unique design'), 'the repeated list item was not detected');
    assert.ok(!t.blocks.has('unique prose for page 1 that differs from every other page on this site entirely.'), 'unique prose was wrongly flagged as template');
  });

  // =====================================================================
  section('3. Heading hierarchy');

  const badHeadings = doc('https://x.test/', '<html><body><h5>Sidebar</h5><h1>Widget training</h1><h1>Second title</h1><h2>About it</h2><h4>Deep</h4><h2>Learn More</h2><h2>Learn More</h2><h3></h3></body></html>');

  check('a skipped level is detected, including a document opening below H2', () => {
    const h = headings.hierarchy(badHeadings);
    const skip = h.issues.find((i) => i.key === 'skipped_levels');
    assert.ok(skip, 'no skipped-level issue was raised');
    assert.ok(h.skips.some((s) => s.firstHeading && s.to === 5), 'the H5-before-H1 case was missed');
    assert.ok(h.skips.some((s) => s.from === 2 && s.to === 4), 'the H2 to H4 skip was missed');
  });

  check('duplicate adjacent headings are detected', () => {
    const h = headings.hierarchy(badHeadings);
    assert.ok(h.issues.find((i) => i.key === 'duplicate_adjacent'), 'the duplicate pair was missed');
    assert.strictEqual(h.duplicates.length, 1);
  });

  check('multiple H1s and empty headings are reported separately', () => {
    const h = headings.hierarchy(badHeadings);
    assert.ok(h.issues.find((i) => i.key === 'multiple_h1'));
    assert.ok(h.issues.find((i) => i.key === 'empty_headings'));
    assert.strictEqual(h.counts.empty, 1);
  });

  check('a clean outline scores 100 and raises nothing', () => {
    const good = doc('https://x.test/', '<html><body><h1>Subject</h1><h2>First part</h2><h3>Detail</h3><h2>Second part</h2></body></html>');
    const h = headings.hierarchy(good);
    assert.strictEqual(h.score, 100);
    assert.strictEqual(h.valid, true);
    assert.strictEqual(h.issues.length, 0);
  });

  check('a missing H1 is high severity, a duplicate is not', () => {
    const noH1 = doc('https://x.test/', '<html><body><h2>Only a subheading</h2><p>Text.</p></body></html>');
    const h = headings.hierarchy(noH1);
    const missing = h.issues.find((i) => i.key === 'missing_h1');
    assert.ok(missing);
    assert.strictEqual(missing.severity, 'high');
  });

  // =====================================================================
  section('4. Keyword stuffing');

  check('density below the ceiling with an even spread raises nothing', () => {
    const text = `${'Widget training helps teams work faster. '}${'Teams learn the fundamentals of process design, measurement and iteration across a series of practical sessions run by an experienced facilitator. '.repeat(10)}Widget training is delivered on site.`;
    const s = headings.stuffing(text, { keyword: 'widget training' });
    assert.ok(s.measurable, 'the text was too short to measure');
    assert.ok(s.target.densityPct < headings.NATURAL_DENSITY_CEILING, `density was ${s.target.densityPct}`);
    assert.ok(!s.issues.some((i) => i.key === 'target_density'), 'a natural density was flagged');
  });

  check('an over-dense term is flagged with its density and its distribution', () => {
    const text = `${'widget training widget training widget training. '.repeat(6)}${'Ordinary prose about scheduling, venues and materials for the sessions themselves. '.repeat(10)}`;
    const s = headings.stuffing(text, { keyword: 'widget training' });
    const issue = s.issues.find((i) => i.key === 'target_density');
    assert.ok(issue, 'stuffing was not detected');
    assert.strictEqual(s.target.distribution.length, 10, 'the distribution is not in tenths');
    assert.ok(s.target.clustered, 'clustering was not detected');
  });

  check('clustering is judged over a fifth of the page, not a tenth', () => {
    // The bug this guards: eighteen occurrences packed into the opening third
    // spread across three tenths at six each, so no SINGLE tenth held half of
    // them and an obviously stuffed block scored as evenly distributed.
    const stuffed = `${'widget training is widget training and widget training again here. '.repeat(6)}${'Neutral prose that discusses the venue, the schedule and the materials at some length. '.repeat(24)}`;
    const s = headings.stuffing(stuffed, { keyword: 'widget training' });
    assert.ok(s.target.exactMatches >= 6, `only ${s.target.exactMatches} matches`);
    assert.ok(s.target.heaviestAdjacentPair >= s.target.heaviestTenth, 'the pair window is not wider than the single tenth');
    assert.ok(s.target.clustered, 'a front-loaded block was read as evenly distributed');
  });

  check('a short page is reported as not measurable rather than as clean', () => {
    const s = headings.stuffing('Three words here.', { keyword: 'widget' });
    assert.strictEqual(s.measurable, false);
    assert.ok(/only \d+ words/.test(s.reason));
  });

  check('a duplicated sentence is detected', () => {
    const sentence = 'Every module concludes with a written assessment marked by an external examiner. ';
    const s = headings.stuffing(`${'Different opening prose that sets out the aims of the programme in some considerable detail here for the reader. '}${sentence.repeat(3)}${'More prose about the delivery schedule and the venues used across the year in question for each cohort. '.repeat(6)}`, { keyword: '' });
    assert.ok(s.measurable, `not measurable: ${s.reason}`);
    assert.ok(s.duplicatedSentences.length >= 1, 'the repeated sentence was missed');
  });

  check('the not-measurable return has the same shape as the measured one', () => {
    // A view reading .duplicatedSentences.length must not have to know which
    // branch produced the object.
    const short = headings.stuffing('Three words here.', { keyword: 'widget' });
    assert.ok(Array.isArray(short.duplicatedSentences), 'duplicatedSentences is missing on the short-page branch');
    assert.ok(Array.isArray(short.overUsedPhrases), 'overUsedPhrases is missing on the short-page branch');
    assert.ok(Array.isArray(short.issues));
    assert.ok(short.thresholds, 'thresholds are missing');
  });

  // =====================================================================
  section('5. Page type — the Product-on-a-service-page fix');

  const servicePage = doc('https://acme.test/services/commercial-roof-repair/',
    '<html><head><title>Commercial roof repair | Acme</title></head><body><main><h1>Commercial roof repair</h1><p>Our services include emergency attendance and planned replacement. We survey, quote and repair. Prices from $1,200 per project.</p><h2>How it works</h2><p>We agree a scope of work in writing before starting.</p></main><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Roof repair"}</script></body></html>');

  check('a service page with a price is classified as a service, not a product', () => {
    const c = pageType.classify(servicePage);
    assert.strictEqual(c.type, 'service', `classified as ${c.type}`);
    assert.strictEqual(c.confident, true);
  });

  check('a price with no purchase control is recorded as evidence AGAINST product', () => {
    const c = pageType.classify(servicePage);
    const counter = c.evidence.find((e) => e.counterEvidence);
    assert.ok(counter, 'no counter-evidence was recorded');
    assert.ok(/no purchase control/.test(counter.why));
  });

  check('Product declared on a service page is reported as a mismatch with a reason', () => {
    const c = pageType.classify(servicePage);
    assert.strictEqual(c.mismatches.length, 1);
    assert.strictEqual(c.mismatches[0].declared, 'Product');
    assert.ok(c.mismatches[0].reason.length > 40, 'the reason is not explained');
  });

  check('a real product page with a cart control IS classified as a product', () => {
    const p = doc('https://acme.test/products/blue-widget',
      '<html><body><main><h1>Blue widget 3000</h1><p>SKU: BW-3000. Price $99.00. In stock, ships within 2 days.</p><select name="variant"><option>Small</option></select><button>Add to cart</button></main></body></html>');
    const c = pageType.classify(p);
    assert.strictEqual(c.type, 'product');
    assert.ok(c.commerce.hasPurchase, 'the purchase control was not detected');
  });

  check('a listing page forbids Product markup', () => {
    let links = '';
    for (let i = 0; i < 30; i += 1) links += `<a href="/products/item${i}">Item ${i}</a>`;
    const c = pageType.classify(doc('https://acme.test/collections/widgets/', `<html><body><main><h1>All widgets</h1>${links}</main></body></html>`));
    assert.strictEqual(c.type, 'category');
    assert.ok(c.forbiddenSchema.Product, 'Product is not forbidden on a category page');
  });

  check('classification does not open the database', () => {
    // pageType is required by the tracking catalog and the schema generator; a
    // stray require of onpage.js would open data/app.db, which is single-writer.
    const src = require('fs').readFileSync('./src/lib/aiseo/pageType.js', 'utf8');
    assert.ok(!/require\('\.\/onpage'\)/.test(src), 'pageType requires onpage, which opens the database');
    assert.ok(!/require\('\.\.\/\.\.\/db'\)/.test(src), 'pageType requires the database directly');
  });

  // =====================================================================
  section('6. Schema builder — final blocks, no nulls, no forbidden types');

  const brand = { id: 1, name: 'Acme Roofing', site_url: 'https://acme.test/' };
  const facts = [{ fact_key: 'what_we_do', fact_value: 'Commercial roofing contractor.' }, { fact_key: 'service_area', fact_value: 'South East England' }];
  const built = schemaBuilder.build({ doc: servicePage, brand, facts });

  check('no generated block contains an explicit null', () => {
    built.blocks.forEach((b) => {
      assert.ok(!/:\s*null/.test(b.json), `${b.type} contains a null: Google treats it as malformed`);
    });
    if (built.graphJson) assert.ok(!/:\s*null/.test(built.graphJson), 'the combined graph contains a null');
  });

  check('Product is NOT generated for a service page, and the reason is given', () => {
    assert.ok(!built.blocks.some((b) => b.type === 'Product'), 'Product was generated on a service page');
    const skipped = built.skipped.find((s) => s.type === 'Product');
    assert.ok(skipped, 'the omission was silent');
    assert.ok(skipped.reason.length > 40, 'the reason is not explained');
  });

  check('Service IS generated, and carries the provider reference', () => {
    const svc = built.blocks.find((b) => b.type === 'Service');
    assert.ok(svc, 'no Service block');
    assert.ok(svc.node.provider, 'the Service has no provider');
    assert.ok(svc.final['@context'], 'the standalone block has no @context');
  });

  check('the combined @graph cross-references by @id', () => {
    assert.ok(built.graph, 'no graph was produced');
    const ids = new Set(built.graph['@graph'].map((n) => n['@id']).filter(Boolean));
    assert.ok(ids.size >= 2, 'nodes carry no @id');
    assert.ok(/#organization/.test(built.graphJson), 'the organisation node is not referenced');
  });

  check('an explicitly requested forbidden type is produced but flagged', () => {
    const forced = schemaBuilder.build({ doc: servicePage, brand, facts, wantedTypes: ['Product'] });
    const p = forced.blocks.find((b) => b.type === 'Product');
    assert.ok(p, 'the explicit request was ignored');
    assert.ok(p.forbiddenReason, 'the objection was not recorded');
  });

  check('FAQ answers are taken from the prose following each question heading', () => {
    const faqDoc = doc('https://acme.test/services/x/',
      '<html><body><main><h1>Service</h1><h2>What does a survey include?</h2><p>A survey includes a moisture scan, a photographic record of every defect, and a written report with costed options.</p><h2>How fast do you attend?</h2><p>We attend emergency callouts within four hours across the region and within one working day elsewhere.</p></main></body></html>');
    const b = schemaBuilder.build({ doc: faqDoc, brand, facts });
    const faq = b.blocks.find((x) => x.type === 'FAQPage');
    assert.ok(faq, 'no FAQPage was generated');
    const first = faq.node.mainEntity[0];
    assert.ok(/moisture scan/.test(first.acceptedAnswer.text), 'the wrong answer was paired to the question');
    assert.ok(faq.verifyRequired, 'the verify-before-publishing flag is not set');
  });

  check('a secondary type that cannot be completed is skipped, not offered half-built', () => {
    // LocalBusiness is optional for a service page and needs an address.
    const skipped = built.skipped.find((s) => s.type === 'LocalBusiness');
    assert.ok(skipped, 'an incomplete secondary type was offered');
    assert.ok(/address/.test(skipped.reason));
  });

  // =====================================================================
  section('7. Link finder — the verbatim-anchor rule');

  const targetDoc = doc('https://acme.test/services/commercial-roof-repair/',
    '<html><head><title>Commercial roof repair | Acme</title></head><body><main><h1>Commercial roof repair</h1><p>We handle commercial roof repair on flat and pitched roofs. Commercial roof repair work is guaranteed for ten years.</p></main></body></html>');
  const phrases = linkFinder.targetPhrases(targetDoc);

  check('anchor phrases come from the H1, title, slug and repeated phrases', () => {
    const top = phrases[0];
    assert.strictEqual(top.phrase, 'commercial roof repair');
    assert.ok(top.origins.includes('H1'));
    assert.ok(top.origins.includes('URL slug'));
  });

  check('an anchor is only offered where the phrase is in the editorial content', () => {
    const source = doc('https://acme.test/blog/flat-roof-leaks/',
      '<html><body><header><nav><a href="/services/">Commercial roof repair</a></nav></header><main><p>A leaking flat roof is usually a failed seam. If the membrane has split, commercial roof repair is the only durable fix.</p></main></body></html>');
    const a = linkFinder.anchorIn(source, phrases, { targetKey: 'x' });
    assert.ok(a, 'no anchor was found in real prose');
    assert.ok(/membrane has split/.test(a.sentence), 'the sentence was not returned');
  });

  check('a phrase that appears only in the nav or footer is rejected', () => {
    const navOnly = doc('https://acme.test/about/',
      '<html><body><nav><a href="/x">Commercial roof repair</a></nav><main><p>Acme was founded in 1998 by two roofers and now employs forty people across three depots in the county.</p></main><footer>Commercial roof repair</footer></body></html>');
    assert.strictEqual(linkFinder.anchorIn(navOnly, phrases, { targetKey: 'x' }), null, 'a boilerplate-only anchor was offered');
  });

  check('a sentence that repeats across the site is rejected as template text', () => {
    const banner = doc('https://acme.test/other/',
      '<html><body><main><p>Some genuinely unique prose about a different subject entirely on this page.</p><ul><li>Commercial roof repair included in every plan</li></ul></main></body></html>');
    const template = new Set(['commercial roof repair included in every plan']);
    const withTemplate = linkFinder.anchorIn(banner, phrases, { targetKey: 'x', templateBlocks: template });
    const withoutTemplate = linkFinder.anchorIn(banner, phrases, { targetKey: 'x' });
    assert.ok(withoutTemplate, 'the control case found no anchor, so the test proves nothing');
    assert.strictEqual(withTemplate, null, 'a sitewide template block was offered as an anchor');
  });

  check('the phrase regex tolerates a plural but not a substring', () => {
    const rx = linkFinder.phraseRegex('roof repair');
    assert.ok(rx.test('we do roof repairs here'), 'the plural was not matched');
    assert.ok(!rx.test('waterproofrepairs'), 'a substring inside a word was matched');
  });

  // =====================================================================
  section('8. Site readiness — the two checks a validator cannot do');

  check('non-crawlable navigation is counted separately from real anchors', () => {
    const d = doc('https://x.test/', '<html><body><main><a href="/real">Real</a><a href="#">Hash</a><a>No href</a><a href="javascript:go()">JS</a><div onclick="nav()">Div</div><a href="mailto:a@b.c">Mail</a></main></body></html>');
    const m = siteReadiness.linkMechanics(d);
    assert.strictEqual(m.realAnchors, 1, 'mailto was counted as navigation, or a real link was missed');
    assert.strictEqual(m.hashOnly, 1);
    assert.strictEqual(m.hrefless, 1);
    assert.strictEqual(m.jsHrefs, 1);
    assert.strictEqual(m.clickableDivs, 1);
    assert.strictEqual(m.realShare, 20);
  });

  check('a marked-up price and rating absent from the page are reported', () => {
    const d = doc('https://x.test/p', '<html><body><main><h1>Widget</h1><p>A widget costs ninety nine pounds.</p></main><script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"@type":"Offer","price":"149.00","priceCurrency":"GBP"},"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"812"}}</script></body></html>');
    const m = siteReadiness.markupMatchesVisible(d);
    const props = m.mismatches.map((x) => x.property);
    assert.ok(props.includes('price'), 'the invented price was not caught');
    assert.ok(props.includes('ratingValue'), 'the invented rating was not caught');
    assert.ok(m.mismatches.every((x) => x.severity === 'high'), 'these are not high severity');
  });

  check('a price present on the page in a different format is NOT reported', () => {
    const d = doc('https://x.test/p', '<html><body><main><h1>Widget</h1><p>Only £1,499.00 including delivery.</p></main><script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"@type":"Offer","price":"1499.00","priceCurrency":"GBP"}}</script></body></html>');
    const m = siteReadiness.markupMatchesVisible(d);
    assert.ok(!m.mismatches.some((x) => x.property === 'price'), 'a correctly-marked-up price was flagged');
  });

  check('an FAQ answer not visible on the page is reported as a policy problem', () => {
    const d = doc('https://x.test/f', '<html><body><main><h2>What is a widget?</h2><p>A widget is a small device used in testing.</p></main><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do you ship overseas?","acceptedAnswer":{"@type":"Answer","text":"Yes we ship to forty countries with tracked delivery on every order"}}]}</script></body></html>');
    const m = siteReadiness.markupMatchesVisible(d);
    assert.strictEqual(m.faqMismatches.length, 1);
    assert.ok(/VISIBLE/.test(m.faqMismatches[0].why));
  });

  check('a JSON-LD block that does not parse is reported rather than skipped', () => {
    const d = doc('https://x.test/b', '<html><body><script type="application/ld+json">{"@type":"Product", "name": "broken",}</script></body></html>');
    const m = siteReadiness.markupMatchesVisible(d);
    assert.strictEqual(m.parseErrors.length, 1);
    assert.strictEqual(m.ok, false);
  });

  // =====================================================================
  section('9. Gap analysis');

  const site = (label, pages) => ({ key: label, label, pages });
  const mk = (url, title, h1, body) => ({ url, doc: doc(url, `<html><head><title>${title}</title></head><body><main><h1>${h1}</h1><p>${body}</p></main></body></html>`) });

  check('the topic matrix distinguishes a site with a dedicated page from one without', () => {
    const ours = [
      mk('https://us.test/', 'Us', 'Roofing', 'We do roofing work across the county for commercial clients of every size.'),
      mk('https://us.test/a', 'Flat roofs', 'Flat roof repair', 'Flat roof repair and replacement across the county, including membrane systems and drainage design for large commercial spans.'),
    ];
    const them = [
      mk('https://them.test/', 'T', 'Roofing', 'Roofing services for the region.'),
      mk('https://them.test/g1', 'Green roof installation', 'Green roof installation', 'Green roof installation covers substrate depth, drainage layers, irrigation, plant selection and structural loading for commercial buildings.'),
      mk('https://them.test/g2', 'Green roof maintenance', 'Green roof maintenance', 'Green roof maintenance schedules, irrigation checks and substrate replenishment for extensive systems across the estate.'),
    ];
    const m = gapAnalysis.topicMatrix(
      [{ topic: 'green roof', terms: ['green roof'] }, { topic: 'flat roof', terms: ['flat roof'] }],
      [site('Our brand', ours), site('Competitor 1', them)],
    );
    const green = m.rows.find((r) => r.topic === 'green roof');
    assert.strictEqual(green.ourScore, 0, 'we were credited for a topic we do not cover');
    assert.ok(green.bestRivalScore > 0, 'the competitor was not credited');
    assert.strictEqual(green.universalGap, true, 'the universal gap was not flagged');
    const flat = m.rows.find((r) => r.topic === 'flat roof');
    assert.ok(flat.deficit < 0, 'we were not credited for a topic we lead on');
  });

  check('a two-word topic requires both words, so a partial match does not score', () => {
    // The bug this guards: a 50% threshold means "green roof" is satisfied by
    // "roof" alone, and every roofing site scores identically on every topic.
    const roofingOnly = [mk('https://x.test/a', 'Roofing', 'Roof repair', 'General roof repair work carried out across the county for many years now.')];
    const c = gapAnalysis.topicCoverage(['green roof'], roofingOnly);
    assert.strictEqual(c.score, 0, 'a partial word match scored');
  });

  check('near-duplicate topics collapse into one row', () => {
    const t = gapAnalysis.topicsFromGaps({
      entityGaps: [{ surface: 'Basel III', pages: 3 }],
      topicGaps: [{ phrase: 'capital adequacy', competitors: 2 }, { phrase: 'capital adequacy requirements', competitors: 2 }],
    });
    const labels = t.topics.map((x) => x.topic);
    assert.ok(labels.includes('capital adequacy'));
    assert.ok(!labels.includes('capital adequacy requirements'), 'a near-duplicate survived');
    assert.strictEqual(t.collapsed, 1);
  });

  check('noise is removed before the matrix is built', () => {
    const t = gapAnalysis.topicsFromGaps({
      entityGaps: [{ surface: 'Starfish', pages: 3 }, { surface: 'Office Headquarters', pages: 2 }, { surface: 'Basel III', pages: 3 }],
      topicGaps: [{ phrase: 'why choose us', competitors: 3 }],
      noiseOpts: { competitorTerms: new Set(['starfish']) },
    });
    assert.deepStrictEqual(t.topics.map((x) => x.topic), ['Basel III']);
    assert.strictEqual(t.suppressed.total, 3);
  });

  check('positionOf matches a domain regardless of www or subdomain', () => {
    const serp = { results: [{ position: 4, host: 'www.example.com', domain: 'example.com', url: 'https://www.example.com/x', title: 'X' }] };
    assert.strictEqual(serpLite.positionOf(serp, 'example.com').position, 4);
    assert.strictEqual(serpLite.positionOf(serp, 'www.example.com').position, 4);
    assert.strictEqual(serpLite.positionOf(serp, 'other.com'), null);
  });

  // =====================================================================
  section('10. Keyword difficulty proxy');

  check('an authority-heavy result set scores harder than a forum-heavy one', () => {
    const authority = {
      engine: 'duckduckgo',
      results: [
        { position: 1, domain: 'wikipedia.org', url: 'https://wikipedia.org/', title: 'widget training' },
        { position: 2, domain: 'forbes.com', url: 'https://forbes.com/a', title: 'widget training guide' },
        { position: 3, domain: 'harvard.edu', url: 'https://harvard.edu/b', title: 'widget training' },
        { position: 4, domain: 'coursera.org', url: 'https://coursera.org/c', title: 'widget training course' },
      ],
    };
    const forum = {
      engine: 'duckduckgo',
      results: [
        { position: 1, domain: 'reddit.com', url: 'https://reddit.com/r/x', title: 'anyone done widget training?' },
        { position: 2, domain: 'quora.com', url: 'https://quora.com/y', title: 'is widget training worth it' },
        { position: 3, domain: 'smallblog.co.uk', url: 'https://smallblog.co.uk/z', title: 'my notes' },
        { position: 4, domain: 'anotherblog.net', url: 'https://anotherblog.net/w', title: 'notes' },
      ],
    };
    const a = keywordMetrics.difficultyFromSerp('widget training', authority);
    const f = keywordMetrics.difficultyFromSerp('widget training', forum);
    assert.ok(a.difficulty > f.difficulty, `authority ${a.difficulty} was not harder than forum ${f.difficulty}`);
    assert.strictEqual(a.basis, 'serp-proxy');
    assert.ok(a.formula.length > 20, 'the formula is not stated');
  });

  check('an empty result set yields null difficulty, never zero', () => {
    const kd = keywordMetrics.difficultyFromSerp('x', { ok: false, engine: null, results: [], error: 'blocked' });
    assert.strictEqual(kd.difficulty, null, 'a blocked sample produced a difficulty');
    assert.strictEqual(kd.confidence, 'none');
    assert.ok(/blocked/.test(kd.reason));
  });

  check('a thin result set is scored with lowered confidence rather than discarded', () => {
    const kd = keywordMetrics.difficultyFromSerp('x', { engine: 'bing', results: [{ position: 1, domain: 'a.com', url: 'https://a.com/', title: 'x' }, { position: 2, domain: 'b.com', url: 'https://b.com/', title: 'y' }] });
    assert.ok(kd.difficulty > 0);
    assert.strictEqual(kd.confidence, 'very-low');
  });

  // =====================================================================
  section('11. Review platforms');

  check('platform relevance is decided by vertical, not by a flat list', () => {
    const saas = reviewPlatforms.platformsFor('saas').map((p) => p.key);
    const restaurant = reviewPlatforms.platformsFor('restaurant').map((p) => p.key);
    assert.ok(saas.includes('g2'), 'G2 is missing for SaaS');
    assert.ok(!restaurant.includes('g2'), 'G2 was offered to a restaurant');
    assert.ok(restaurant.includes('tripadvisor'), 'Tripadvisor is missing for a restaurant');
    assert.ok(saas.includes('google') && restaurant.includes('google'), 'Google is not universal');
  });

  check('every platform states why a missing profile costs something', () => {
    reviewPlatforms.PLATFORMS.forEach((p) => {
      assert.ok(p.why && p.why.length > 40, `${p.key} has no explanation`);
      assert.ok(Number.isFinite(p.weight), `${p.key} has no weight`);
    });
  });

  // =====================================================================
  section('12. Regressions found by running the engines against live sites');

  check('a reason phrase that already ends in a plural is not pluralised again', () => {
    // Produced "appears in this site template on most pagess" on a real run.
    assert.strictEqual(
      boilerplate.pluraliseReason('appears in this site template on most pages', 11),
      'appears in this site template on most pages',
    );
    assert.strictEqual(boilerplate.pluraliseReason('competitor brand name', 30), 'competitor brand names');
    assert.strictEqual(boilerplate.pluraliseReason('competitor brand name', 1), 'competitor brand name');
  });

  check('two filter results merge by ADDING counts, not by concatenating summaries', () => {
    // The union of two pre-rendered summary arrays put "21 competitor brand
    // names" and "30 competitor brand names" on the same line as two entries.
    const merged = { ...{ 'competitor brand name': 21 }, };
    Object.entries({ 'competitor brand name': 30, 'generic UI or section label': 8 }).forEach(([k, n]) => {
      merged[k] = (merged[k] || 0) + n;
    });
    const rendered = boilerplate.renderReasonSummary(merged);
    assert.strictEqual(rendered.filter((x) => /competitor brand name/.test(x)).length, 1, 'the reason appears twice');
    assert.ok(rendered[0].startsWith('51 '), `expected 51, got "${rendered[0]}"`);
  });

  check('filter results expose per-reason counts so callers can merge them', () => {
    const r = boilerplate.filterEntities(
      [{ surface: 'Learn More' }, { surface: 'Get Started' }, { surface: 'Basel III' }],
      {},
    );
    assert.ok(r.byReason, 'byReason is missing');
    assert.strictEqual(r.byReason['generic UI or section label'], 2);
  });

  check('a candidate page that does not name the domain is "irrelevant", not a "mention"', () => {
    // The first version reported every fetched-but-unlinked page as an unlinked
    // MENTION of the target without checking that the page named it. On a live
    // run the fallback engine ignored the -site: operator and returned
    // support.google.com and brainly.ph — all reported as mentions of the
    // target, which is a fabricated claim about a third-party page.
    const src = require('fs').readFileSync('./src/lib/aiseo/gapAnalysis.js', 'utf8');
    assert.ok(/state: 'irrelevant'/.test(src), 'the irrelevant bucket is gone');
    assert.ok(/const names = text\.includes\(clean\)/.test(src), 'the page is no longer checked for naming the domain');
    assert.ok(/candidateQuality/.test(src), 'candidate quality is not reported');
  });

  check('webMentions no longer parses the result page itself', () => {
    // It used a bot user agent (answered with HTTP 202 and a challenge page)
    // and a regex requiring class= before href=. Either alone returns zero
    // results reported as ok:true. Parsing now lives only in serpLite.
    //
    // Comments are stripped before asserting: the module's own explanation of
    // the bug names both `result__a` and the old user agent, and an assertion
    // that fires on the documentation of a fix rather than on the fix itself is
    // worse than no assertion — it forces the next person to delete the
    // explanation to get the suite green.
    const raw = require('fs').readFileSync('./src/lib/aiseo/webMentions.js', 'utf8');
    const code = raw.split(String.fromCharCode(10)).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(String.fromCharCode(10));
    assert.ok(!/result__a/.test(code), 'the fragile regex is still in the code');
    assert.ok(!/seo-suite-hostinger\/1\.0/.test(code), 'the bot user agent is still in the code');
    assert.ok(!/RESULT_LINK_RX/.test(code), 'the dead regex constant is still declared');
    assert.ok(/require\('\.\/serpLite'\)/.test(code), 'it does not delegate to serpLite');
  });

  check('Google Trends acquires a cookie before calling the API', () => {
    // Cookieless requests get a flat HTTP 429 every time — verified against the
    // live endpoint three times in a row. Relative interest is the DEFAULT
    // demand signal when no volume credential is configured, so without the
    // cookie it would have been permanently empty.
    const src = require('fs').readFileSync('./src/lib/aiseo/keywordMetrics.js', 'utf8');
    assert.ok(/trendsCookieHeader/.test(src), 'no cookie acquisition');
    assert.ok(/Cookie: cookie/.test(src), 'the cookie is not sent with the request');
    assert.ok(/ex\.status === 429/.test(src), 'no retry on an expired cookie');
    assert.strictEqual(typeof keywordMetrics.trendsCookieHeader, 'function', 'not exported for testing');
  });

  check('an FAQ answer given as a nested object is read, not skipped', () => {
    const nested = doc('https://x.test/f', '<html><body><main><p>Visible text only.</p></main><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q","acceptedAnswer":{"@type":"Answer","text":{"text":"Yes we ship to forty countries with tracked delivery on every order"}}}]}</script></body></html>');
    assert.strictEqual(siteReadiness.markupMatchesVisible(nested).faqMismatches.length, 1, 'a nested answer object was skipped');
  });

  check('an FAQ answer that IS visible is not flagged', () => {
    const ok = doc('https://x.test/f', '<html><body><main><p>Yes we ship to forty countries with tracked delivery on every order placed.</p></main><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q","acceptedAnswer":{"@type":"Answer","text":"Yes we ship to forty countries with tracked delivery on every order"}}]}</script></body></html>');
    assert.strictEqual(siteReadiness.markupMatchesVisible(ok).faqMismatches.length, 0, 'a visible answer was flagged');
  });

  // =====================================================================
  section('13. Providers — the new adapters');

  check('the keyless adapters are available and the paid ones are not claimed', () => {
    assert.strictEqual(providers.has('serp-lite'), process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1');
    assert.strictEqual(providers.has('google-trends'), process.env.AISEO_DISABLE_PUBLIC_SOURCES !== '1');
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      assert.strictEqual(providers.has('google-ads'), false, 'Google Ads is claimed without a developer token');
    }
  });

  check('a provider that would improve a feature is named rather than hidden', () => {
    const prov = providers.provenance(['crawler']);
    assert.ok(Array.isArray(prov.wouldImprove));
    if (!providers.has('dataforseo')) {
      assert.ok(prov.wouldImprove.some((p) => p.key === 'dataforseo'), 'DataForSEO is not named as an improvement');
    }
  });

  // =====================================================================
  if (FULL) {
    section('14. Live network checks');

    await checkAsync('a keyless SERP sample returns ranked results for a country', async () => {
      const s = await serpLite.search('flat roof repair cost', { market: 'GB', limit: 10 });
      assert.ok(s.ok, `no engine answered: ${s.error}`);
      assert.ok(s.results.length >= 5, `only ${s.results.length} results`);
      assert.ok(s.results[0].domain, 'results carry no domain');
      assert.strictEqual(s.keyless, true);
    });

    await checkAsync('the difficulty proxy computes from a live sample', async () => {
      const s = await serpLite.search('flat roof repair cost', { market: 'GB', limit: 10 });
      const kd = keywordMetrics.difficultyFromSerp('flat roof repair cost', s);
      assert.ok(kd.difficulty >= 5 && kd.difficulty <= 100, `difficulty was ${kd.difficulty}`);
      assert.ok(kd.components.resultsSampled > 0);
      assert.ok(kd.caveat.includes('not from Google'), 'the caveat does not state the basis');
    });

    await checkAsync('the second suggestion index returns phrasings Google does not', async () => {
      const research = require('./src/lib/aiseo/research');
      const bing = await serpLite.relatedSearches('flat roof repair cost', { market: 'GB' });
      assert.ok(bing.ok, `bing suggest failed: ${bing.error}`);
      const google = await research.suggest('flat roof repair cost', { market: 'GB' });
      const gset = new Set(google.map((g) => g.keyword));
      const additive = bing.related.filter((x) => !gset.has(x));
      assert.ok(additive.length > 0, 'the second index added nothing, so it is not worth the request');
    });

    await checkAsync('the URL set is the union of the sitemap and a crawl', async () => {
      const set = await siteReadiness.buildUrlSet('https://www.americanwebbuilders.com', { maxPages: 8 });
      assert.ok(set.sitemap.urls.length > 0, 'no sitemap was read');
      assert.ok(set.pages.length > 0, 'no page was crawled');
      assert.ok(Array.isArray(set.crawledNotInSitemap), 'the sitemap gap was not computed');
    });

    await checkAsync('Google Trends returns relative interest for a country', async () => {
      const t = await keywordMetrics.trendsInterest(['web design', 'web development'], { market: 'US' });
      assert.ok(t.ok, `Trends returned nothing: ${JSON.stringify(t.errors)}`);
      t.values.forEach((v) => {
        assert.ok(v.relativeInterest >= 0 && v.relativeInterest <= 100, `interest out of range: ${v.relativeInterest}`);
      });
    });

    await checkAsync('the referring-page search returns parseable results', async () => {
      // Guards the silent-zero: this returned ok:true with no items for months.
      const webMentions = require('./src/lib/aiseo/webMentions');
      const r = await webMentions.referringPages('wikipedia.org', { limit: 8 });
      assert.ok(r.ok, `search failed: ${r.error}`);
      assert.ok(r.resultsSeen > 0, 'the search returned no results at all — the parser is broken again');
    });

    await checkAsync('the link finder returns a verbatim anchor with its sentence', async () => {
      const res = await linkFinder.find('https://www.americanwebbuilders.com/services/', { maxPages: 15, limit: 10 });
      assert.ok(res.ok, res.reason);
      res.rows.forEach((row) => {
        assert.ok(row.url && row.sourceUrl && row.anchorText, 'a row is missing one of the three required columns');
        assert.ok(
          row.sentence.toLowerCase().includes(row.anchorText.toLowerCase()),
          `the anchor "${row.anchorText}" is not inside the sentence returned with it`,
        );
      });
    });
  } else {
    console.log('\n(skipping the live network checks — re-run with --full to include them)');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  console.log('='.repeat(60));
  if (failures.length) {
    failures.forEach((f) => console.log(`\n${f.name}\n${f.err.stack}`));
    process.exitCode = 1;
  }
  try { require('./src/db').closeDb(); } catch { /* already closed */ }
})();
