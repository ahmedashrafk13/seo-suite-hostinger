// Verification for the AI SEO suite.
//
// Runs the deterministic layer against fixtures with KNOWN answers, then runs
// the live analyses against a real brand and asserts the shape and the
// provenance of what comes back.
//
// IMPORTANT: run this with the server STOPPED. This deployment uses the
// WebAssembly SQLite driver, which is single-writer — a second process opening
// data/app.db while the app is running has corrupted it before.
//
// Usage:
//   node verify_aiseo.js            deterministic checks + light live checks
//   node verify_aiseo.js --full     also runs the crawling analyses (slow)
const assert = require('assert');

const FULL = process.argv.includes('--full');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err.message });
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err.message });
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

(async () => {
  const nlp = require('./src/lib/aiseo/nlp');
  const fetcher = require('./src/lib/aiseo/fetcher');
  const schemaAuto = require('./src/lib/aiseo/schemaAuto');
  const providers = require('./src/lib/aiseo/providers');
  const trackingCatalog = require('./src/lib/aiseo/trackingCatalog');
  const onpage = require('./src/lib/aiseo/onpage');
  const reputation = require('./src/lib/aiseo/reputation');
  const competitive = require('./src/lib/aiseo/competitive');
  const db = require('./src/db');
  const store = require('./src/lib/aiseo/store');

  // =====================================================================
  section('1. Text measurement (nlp.js)');

  check('readability returns both Flesch scores and a sentence count', () => {
    const r = nlp.readability('The cat sat on the mat. It was a warm day and the sun shone brightly through the window.');
    assert.ok(r.fleschReadingEase > 50, `expected an easy score, got ${r.fleschReadingEase}`);
    assert.strictEqual(r.sentences, 2);
    assert.ok(r.fleschKincaidGrade != null);
  });

  check('readability on empty text returns nulls, not zeros', () => {
    const r = nlp.readability('');
    assert.strictEqual(r.fleschReadingEase, null, 'empty text must not score 0 — that reads as "unreadable"');
    assert.strictEqual(r.sentences, 0);
  });

  check('long-sentence count is right', () => {
    const long = `${Array(40).fill('word').join(' ')}.`;
    const r = nlp.readability(`Short one. ${long}`);
    assert.strictEqual(r.longSentences, 1);
  });

  check('entities finds acronyms, proper nouns and statistics but not sentence-initial words', () => {
    const ents = nlp.entities('The GDPR applies in Germany. Basel III raised capital ratios by 25% in 2019.');
    const surfaces = ents.map((e) => e.surface);
    assert.ok(surfaces.includes('GDPR'), `expected GDPR, got ${surfaces.join(', ')}`);
    assert.ok(surfaces.includes('Germany'), `expected Germany, got ${surfaces.join(', ')}`);
    assert.ok(surfaces.some((s) => s.includes('25%')), `expected the 25% statistic, got ${surfaces.join(', ')}`);
    assert.ok(!surfaces.includes('The'), '"The" must never be reported as an entity');
  });

  check('entity density is per-100-words, not a raw count', () => {
    const short = nlp.entityDensity('GDPR applies in Germany.');
    const padded = nlp.entityDensity(`GDPR applies in Germany. ${Array(200).fill('filler').join(' ')}`);
    assert.ok(short.density > padded.density,
      `padding a page with filler must LOWER density (${short.density} vs ${padded.density})`);
  });

  check('cosine similarity: identical text scores 1, unrelated scores low', () => {
    const a = nlp.termFrequency('compliance certification training for finance professionals');
    const b = nlp.termFrequency('compliance certification training for finance professionals');
    const c = nlp.termFrequency('gardening tools and outdoor furniture for patios');
    assert.ok(nlp.cosine(a, b) > 0.99, `identical should be ~1, got ${nlp.cosine(a, b)}`);
    assert.ok(nlp.cosine(a, c) < 0.2, `unrelated should be low, got ${nlp.cosine(a, c)}`);
  });

  check('Jensen-Shannon divergence: identical distributions are 0, disjoint are 1', () => {
    const a = new Map([['x', 10], ['y', 5]]);
    const b = new Map([['x', 20], ['y', 10]]);   // same shape, different scale
    const c = new Map([['p', 10], ['q', 5]]);    // no overlap at all
    assert.strictEqual(nlp.jensenShannon(a, b), 0, 'same distribution at a different scale must be 0 drift');
    assert.ok(Math.abs(nlp.jensenShannon(a, c) - 1) < 0.001, `disjoint should be 1 bit, got ${nlp.jensenShannon(a, c)}`);
  });

  check('Jensen-Shannon returns null when a distribution is empty', () => {
    assert.strictEqual(nlp.jensenShannon(new Map(), new Map([['x', 1]])), null);
  });

  check('sentiment handles negation', () => {
    assert.strictEqual(nlp.sentiment('This is great, really helpful and reliable.').label, 'positive');
    assert.strictEqual(nlp.sentiment('This is not great. Not helpful at all.').label, 'negative',
      '"not great" must not be scored as positive');
  });

  check('sentiment flags damaging claims with a severity', () => {
    const s = nlp.sentiment('This company is a total scam, they stole my money.');
    assert.strictEqual(s.label, 'negative');
    assert.ok(s.risk, 'a fraud accusation must set a risk');
    assert.strictEqual(s.risk.severity, 'critical');
  });

  check('sentiment on neutral text sets no risk', () => {
    const s = nlp.sentiment('They offer training courses in several cities.');
    assert.strictEqual(s.risk, null);
  });

  // =====================================================================
  section('2. HTML parsing (fetcher.js)');

  const SAMPLE_HTML = `<!doctype html><html lang="en"><head>
    <title>AML Certification — Example</title>
    <meta name="description" content="A description.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="https://example.com/aml">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"AML Certification"}</script>
    <script type="application/ld+json">{ this is broken json }</script>
  </head><body>
    <nav><a href="/">Home</a><a href="/courses">Courses</a></nav>
    <main><article>
      <h1>AML Certification</h1>
      <h2>What does the certification cover?</h2>
      <p>The programme covers customer due diligence, transaction monitoring and reporting obligations under the 2017 regulations. It runs over 12 weeks and costs 1,200 dollars.</p>
      <h4>Skipped a level deliberately</h4>
      <p>This means that candidates should prepare early.</p>
      <table><tr><td>Total</td><td>19</td></tr></table>
      <ul><li>One</li><li>Two</li></ul>
      <img src="/a.png" alt="A chart">
      <img src="/b.png">
      <time datetime="2026-01-15">15 January 2026</time>
    </article></main>
    <footer><a href="https://external.example.org/x">External</a></footer>
  </body></html>`;

  const doc = fetcher.parseDocument('https://example.com/aml', SAMPLE_HTML);

  check('title, meta and canonical are read', () => {
    assert.strictEqual(doc.title, 'AML Certification — Example');
    assert.strictEqual(doc.metaDesc, 'A description.');
    assert.strictEqual(doc.canonical, 'https://example.com/aml');
    assert.strictEqual(doc.lang, 'en');
    assert.ok(doc.hasViewport);
  });

  check('main content is read from <main>, not the whole body', () => {
    assert.strictEqual(doc.mainSelector, 'main');
    assert.ok(!doc.mainText.includes('External'), 'footer text must not be in mainText');
    assert.ok(doc.mainText.includes('customer due diligence'));
  });

  check('adjacent table cells are separated, not concatenated', () => {
    assert.ok(doc.mainText.includes('Total 19'),
      'cheerio .text() would give "Total19"; the BeautifulSoup-style join is required');
  });

  check('a broken JSON-LD block is reported rather than skipped', () => {
    assert.strictEqual(doc.jsonLd.length, 2);
    assert.strictEqual(doc.jsonLd.filter((j) => j.ok).length, 1);
    const bad = doc.jsonLd.find((j) => !j.ok);
    assert.ok(bad.error, 'the parse error must be captured — an unparseable block is invisible to Google');
  });

  check('a missing alt is distinguished from an empty one', () => {
    assert.strictEqual(doc.images.length, 2);
    assert.strictEqual(doc.images.filter((i) => i.alt == null).length, 1);
    assert.strictEqual(doc.images.filter((i) => i.alt === 'A chart').length, 1);
  });

  check('internal and external links are separated', () => {
    assert.strictEqual(doc.links.filter((l) => l.internal).length, 2);
    assert.strictEqual(doc.links.filter((l) => !l.internal).length, 1);
  });

  check('semantic landmarks are detected', () => {
    assert.ok(doc.semantic.main && doc.semantic.article && doc.semantic.nav && doc.semantic.table);
    assert.ok(doc.semantic.time, '<time> must be detected — it is a freshness signal');
  });

  check('citability rewards structure and penalises a dangling paragraph', () => {
    const c = nlp.citability(doc);
    assert.ok(c.score > 0 && c.score <= 100, `score out of range: ${c.score}`);
    assert.ok(c.signals.hasStructuredBlocks, 'a table and a list must count as structured');
    assert.ok(c.signals.questionHeadings >= 1, 'the "What does…?" heading must be counted');
    assert.ok(c.weakPassages.some((p) => p.preview.startsWith('This means that')),
      'a paragraph opening "This means that" cannot stand alone and must be flagged');
  });

  // =====================================================================
  section('3. robots.txt matching (fetcher.js)');

  const robots = fetcher.parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/public-page

User-agent: GPTBot
User-agent: CCBot
Disallow: /

User-agent: PerplexityBot
Disallow:
  `);

  check('consecutive User-agent lines share one rule group', () => {
    const gpt = fetcher.robotsAllows(robots, 'GPTBot', '/anything');
    const cc = fetcher.robotsAllows(robots, 'CCBot', '/anything');
    assert.strictEqual(gpt.allowed, false);
    assert.strictEqual(cc.allowed, false, 'CCBot shares GPTBot\'s group and must also be blocked');
  });

  check('longest match wins, and Allow beats Disallow on a tie', () => {
    assert.strictEqual(fetcher.robotsAllows(robots, 'Googlebot', '/private/secret').allowed, false);
    assert.strictEqual(fetcher.robotsAllows(robots, 'Googlebot', '/private/public-page').allowed, true,
      'the longer Allow must win over the shorter Disallow');
  });

  check('an empty Disallow value allows everything', () => {
    assert.strictEqual(fetcher.robotsAllows(robots, 'PerplexityBot', '/anything').allowed, true);
  });

  check('an unlisted agent falls back to the wildcard group', () => {
    const v = fetcher.robotsAllows(robots, 'SomeNewBot', '/private/x');
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.matchedAgent, '*');
  });

  check('the Disallow: / + Allow: /$ homepage-only pattern resolves correctly', () => {
    const r = fetcher.parseRobots('User-agent: *\nDisallow: /\nAllow: /$');
    assert.strictEqual(fetcher.robotsAllows(r, 'Googlebot', '/').allowed, true, 'the anchored Allow must match the root');
    assert.strictEqual(fetcher.robotsAllows(r, 'Googlebot', '/page').allowed, false);
  });

  check('no robots.txt means everything is allowed', () => {
    assert.strictEqual(fetcher.robotsAllows(fetcher.parseRobots(''), 'GPTBot', '/x').allowed, true);
  });

  // =====================================================================
  section('4. Schema validation (schemaAuto.js)');

  check('nodes inside @graph are found, not just top-level ones', () => {
    const nodes = schemaAuto.extractNodes({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Organization', name: 'X' }, { '@type': 'WebSite', name: 'Y', url: 'https://x' }],
    });
    const types = nodes.map((n) => n.canonical);
    assert.ok(types.includes('Organization') && types.includes('WebSite'),
      `@graph traversal failed: got ${types.join(', ')}`);
  });

  check('a missing REQUIRED property is an error', () => {
    const v = schemaAuto.validateNode({ type: 'Article', canonical: 'Article', node: { '@type': 'Article' } });
    const errors = v.problems.filter((p) => p.severity === 'error');
    assert.ok(errors.some((e) => e.property === 'headline'), 'Article without headline must be an error');
  });

  check('a missing RECOMMENDED property is only a warning', () => {
    const v = schemaAuto.validateNode({
      type: 'Article', canonical: 'Article',
      node: { '@context': 'https://schema.org', '@type': 'Article', headline: 'X' },
    });
    assert.strictEqual(v.problems.filter((p) => p.severity === 'error').length, 0);
    assert.ok(v.problems.some((p) => p.severity === 'warning' && p.property === 'image'));
  });

  check('Product with no offers/review/rating fails the oneOf rule', () => {
    const v = schemaAuto.validateNode({
      type: 'Product', canonical: 'Product',
      node: { '@context': 'https://schema.org', '@type': 'Product', name: 'Thing' },
    });
    assert.ok(v.problems.some((p) => p.severity === 'error' && String(p.property).includes('offers')),
      'a Product needs at least one of offers/review/aggregateRating');
  });

  check('an Offer with a price but no currency is an error', () => {
    const v = schemaAuto.validateNode({
      type: 'Product', canonical: 'Product',
      node: { '@context': 'https://schema.org', '@type': 'Product', name: 'T', offers: { price: 10 } },
    });
    assert.ok(v.problems.some((p) => /priceCurrency/.test(p.message)));
  });

  check('FAQPage with a question missing its answer is an error', () => {
    const v = schemaAuto.validateNode({
      type: 'FAQPage', canonical: 'FAQPage',
      node: {
        '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: [{ '@type': 'Question', name: 'Why?' }],
      },
    });
    assert.ok(v.problems.some((p) => /acceptedAnswer/.test(p.message)));
  });

  check('an unknown type is reported as unchecked, not as invalid', () => {
    const v = schemaAuto.validateNode({ type: 'SomeCustomThing', canonical: null, node: { '@type': 'SomeCustomThing' } });
    assert.strictEqual(v.known, false);
    assert.strictEqual(v.problems.length, 0, 'an unknown type must produce no errors — it is not wrong, just unchecked');
    assert.ok(v.note);
  });

  check('type aliases resolve to their canonical rule', () => {
    assert.strictEqual(schemaAuto.canonicalType('NewsArticle'), 'Article');
    assert.strictEqual(schemaAuto.canonicalType('ProfessionalService'), 'LocalBusiness');
    assert.strictEqual(schemaAuto.canonicalType('https://schema.org/Product'), 'Product');
  });

  check('generation never invents a value it cannot read', () => {
    const generated = schemaAuto.generateFromPage(doc, { id: 1, name: 'Example', site_url: 'https://example.com' }, []);
    const article = generated.find((g) => g.type === 'Article');
    if (article) {
      assert.strictEqual(article.jsonld.datePublished, null, 'a date that is not on the page must stay null');
      assert.ok(article.needsHumanInput.length, 'the null fields must be listed as needing input');
    }
    const org = generated.find((g) => g.type === 'Organization');
    assert.ok(org, 'an Organization block should be generated from the brand');
    assert.strictEqual(org.jsonld.name, 'Example');
  });

  check('llms.txt renders the declared facts and states its own caveat', () => {
    const out = schemaAuto.renderLlmsTxt({
      brand: { name: 'Example', site_url: 'https://example.com' },
      facts: [
        { fact_key: 'what_we_do', fact_value: 'We train compliance officers.', section: 'identity', source_url: 'https://example.com/about' },
        { fact_key: 'service_area', fact_value: 'United Kingdom', section: 'operations', source_url: null },
      ],
      sections: [],
    });
    assert.ok(out.includes('We train compliance officers.'));
    assert.ok(out.includes('United Kingdom'));
    assert.ok(/does not use llms\.txt/i.test(out), 'the file must state that Google does not use it');
  });

  // =====================================================================
  section('5. Scoring logic (onpage.js)');

  check('semantic coverage uses consensus terms, not the union', () => {
    const mine = fetcher.parseDocument('https://a/', '<main><p>alpha beta gamma</p></main>');
    const c1 = fetcher.parseDocument('https://b/', '<main><p>alpha beta delta</p></main>');
    const c2 = fetcher.parseDocument('https://c/', '<main><p>alpha beta epsilon</p></main>');
    const cov = onpage.semanticCoverage(mine, [c1, c2]);
    // alpha and beta are on both competitors (consensus); delta and epsilon are
    // on one each and must NOT be held against the page.
    assert.strictEqual(cov.pct, 100,
      `a page covering both consensus terms must score 100, got ${cov.pct}; missing=${cov.missing.join(',')}`);
  });

  check('coverage with no comparison set returns null, not 0', () => {
    const mine = fetcher.parseDocument('https://a/', '<main><p>alpha</p></main>');
    assert.strictEqual(onpage.semanticCoverage(mine, []).pct, null,
      '0% coverage against nothing would be a false failure');
  });

  check('the composite score renormalises when coverage is absent', () => {
    const args = {
      coverage: { pct: null },
      readability: { fleschReadingEase: 55, longSentences: 0, sentences: 10 },
      entity: { density: 3 },
      citabilityInfo: { score: 80 },
      placementInfo: { inTitle: true, inH1: true, inFirstHundredWords: true, inSubheading: true, inUrl: true },
    };
    const s = onpage.compositeScore(args);
    assert.ok(!s.parts.some((p) => p.key === 'semantic_coverage'), 'coverage must be excluded, not scored as 0');
    assert.ok(s.score > 80, `with everything else strong the score should be high, got ${s.score}`);
    assert.ok(/renormalised/.test(s.basis));
  });

  check('placement requires every content word of the term', () => {
    const d = fetcher.parseDocument('https://a/', '<title>AML training</title><main><h1>AML training</h1><p>x</p></main>');
    const p = onpage.placement(d, 'aml certification');
    assert.strictEqual(p.inTitle, false, '"aml certification" is not satisfied by "AML training"');
    assert.strictEqual(onpage.placement(d, 'aml training').inTitle, true);
  });

  check('competitor candidate scoring prefers a shallow matching slug', () => {
    const shallow = onpage.candidateScore('https://x.com/aml-certification', 'aml certification');
    const deep = onpage.candidateScore('https://x.com/blog/2019/notes/on/aml-certification-models', 'aml certification');
    assert.ok(shallow > deep, `shallow (${shallow}) should beat deep (${deep})`);
    assert.strictEqual(onpage.candidateScore('https://x.com/gardening', 'aml certification'), 0);
  });

  // =====================================================================
  section('6. Competitive helpers (competitive.js)');

  check('velocity refuses to report deploy-stamped lastmod dates', () => {
    const stamped = Array(20).fill(0).map(() => ({ loc: 'https://x/a', lastmod: '2026-03-01' }));
    const v = competitive.velocityFromSitemap(stamped);
    assert.strictEqual(v.usable, false, 'all dates on one day must not be reported as publishing activity');
    assert.ok(/deploy time/.test(v.reason));
  });

  check('velocity works on genuinely spread dates', () => {
    const spread = Array(20).fill(0).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (i * 4));
      return { loc: `https://x/${i}`, lastmod: d.toISOString().slice(0, 10) };
    });
    const v = competitive.velocityFromSitemap(spread);
    assert.strictEqual(v.usable, true, `expected usable, got: ${v.reason}`);
    assert.ok(v.perMonth > 0);
  });

  check('velocity reports too-few-dates rather than guessing', () => {
    const v = competitive.velocityFromSitemap([{ loc: 'https://x/a', lastmod: '2026-01-01' }]);
    assert.strictEqual(v.usable, false);
  });

  check('section profile groups by first path segment', () => {
    const s = competitive.sectionProfile([
      { loc: 'https://x/blog/a' }, { loc: 'https://x/blog/b' }, { loc: 'https://x/courses/c' }, { loc: 'https://x/' },
    ]);
    const blog = s.find((x) => x.section === 'blog');
    assert.strictEqual(blog.count, 2);
    assert.ok(s.some((x) => x.section === '(root)'));
  });

  // =====================================================================
  section('7. Reputation helpers (reputation.js)');

  check('dedupe key normalises host and strips query/fragment', () => {
    const a = reputation.dedupeKeyFor('https://www.reddit.com/r/x/comments/1/title/');
    const b = reputation.dedupeKeyFor('https://old.reddit.com/r/x/comments/1/title?utm_source=share#c');
    assert.strictEqual(a, b, 'the same thread reached two ways must be one row');
    assert.notStrictEqual(a, reputation.dedupeKeyFor('https://www.reddit.com/r/x/comments/2/other/'));
  });

  check('a loose keyword match is rejected as not about the brand', () => {
    const terms = ['acme compliance'];
    assert.strictEqual(reputation.mentionsBrand({ title: 'Acme Compliance review', snippet: '' }, terms), true);
    assert.strictEqual(reputation.mentionsBrand({ title: 'Compliance news roundup', snippet: 'nothing relevant' }, terms), false);
  });

  check('a three-character brand name is searchable, a two-character one is not', () => {
    // The floor was 4, which silently excluded Wix, IBM and SAP. Measured
    // consequence: a Wix scan searched only "wix.com", Reddit returned 50
    // posts, and every one was rejected because Reddit says "Wix" — fifty
    // relevant mentions collected and thrown away as "no mentions found".
    const wix = reputation.watchTerms({ name: 'Wix', site_url: 'https://www.wix.com/' });
    assert.ok(wix.includes('Wix'), `a 3-character brand name must be searchable, got ${JSON.stringify(wix)}`);
    assert.ok(wix.includes('wix.com'));
    const ge = reputation.watchTerms({ name: 'GE', site_url: 'https://www.ge.com/' });
    assert.ok(!ge.includes('GE'), 'two characters is still refused — word boundaries do not save "GE" from noise');
  });

  check('watch terms are case-insensitively unique', () => {
    const t = reputation.watchTerms({ name: 'Wix', site_url: 'https://www.wix.com/', mention_terms: 'wix\nWIX' });
    const lowered = t.map((x) => x.toLowerCase());
    assert.strictEqual(new Set(lowered).size, lowered.length, `duplicates survived: ${JSON.stringify(t)}`);
  });

  check('brand matching is word-boundary, not substring', () => {
    // This is what makes the 3-character floor safe. A substring test cannot
    // tell "Wix" from "Wixom", which is why short names had to be excluded
    // from searching at all before.
    const cases = [
      ['Wix', 'I built my site on Wix and it was fine', true],
      ['Wix', 'Anyone been to Wixom Michigan', false],
      ['Wix', 'wixel graphics look dated', false],
      ['Wix', 'wix2 is not a thing', false],
      // A dot or hyphen beside the term is a boundary, not part of it.
      ['Wix', 'Is Wix.com worth it?', true],
      ['Wix', 'moving off sub.wix.com next week', true],
      ['Wix', 'wix-alternatives thread', true],
      ['wix.com', 'Is Wix.com worth it?', true],
      ['wix.com', 'I built my site on Wix and it was fine', false],
      ['SAP', 'sapling growth rates', false],
      ['SAP', 'our SAP migration failed', true],
      // Whitespace inside a term matches any run of it, so a line break
      // between the words does not hide the mention.
      ['Acme Compliance', 'Acme\nCompliance let me down', true],
      ['Acme Compliance', 'compliance issues at Acme Corp', false],
    ];
    const wrong = cases.filter(([term, text, want]) => reputation.mentionsBrand({ title: text, snippet: '' }, [term]) !== want);
    assert.strictEqual(wrong.length, 0,
      wrong.map(([t, x, w]) => `"${t}" vs ${JSON.stringify(x)} should be ${w}`).join('; '));
  });

  check('a shared brand name is separated by topic, not by the name alone', () => {
    // The real case this exists for: searching "Wix" returns the website
    // builder AND WIX Filters, the car-parts manufacturer. Both genuinely
    // contain the word, so only topic can tell them apart.
    const webContext = {
      usable: true,
      source: 'test fixture',
      terms: new Set(['website', 'web', 'design', 'builder', 'site', 'portfolio', 'hosting', 'domain']),
    };
    const verdict = (title, snippet) => reputation.mentionConfidence({ title, snippet }, { context: webContext, domain: 'wix.com' }).level;

    assert.strictEqual(verdict('Moving my site off wix.com', 'exporting content'), 'certain',
      'naming the brand domain is the one unambiguous signal');
    assert.strictEqual(verdict('Best website builder for a portfolio', 'thinking about Wix'), 'likely');
    assert.strictEqual(verdict('Huskee Log Splitter Hydraulic Fluid and Filter Change', 'used a WIX filter, part 51410'), 'unclear',
      'a car-parts thread must not count as a mention of the website builder');
    assert.strictEqual(verdict('2023 Hybrid SE Air filters', 'WIX vs OEM air filter'), 'unclear');
  });

  check('where a mention lives counts as topic evidence', () => {
    // Ignoring the container produced real false negatives: "Transferring
    // Domain to Wix" in r/webdesign was excluded because its title shares no
    // vocabulary with the brand's query set, even though the subreddit it sits
    // in is squarely on topic.
    const ctx = { usable: true, source: 'fixture', terms: new Set(['website', 'web', 'design', 'builder', 'hosting']) };
    const at = (title, container, watched = []) => reputation.mentionConfidence(
      { title, snippet: '', context: container },
      { context: ctx, domain: 'wix.com', watchedContainers: watched },
    );
    assert.strictEqual(at('Transferring Domain to Wix', 'r/webdesign', ['webdesign']).level, 'likely',
      'a watched subreddit is topic evidence on its own');
    assert.strictEqual(at('Wix Collaborator', 'r/webdesign').level, 'likely',
      'a subreddit name carrying a context term is topic evidence — names are run together, so this must be a substring test');
    assert.strictEqual(at('Huskee Log Splitter Filter Change', 'r/Tools', ['webdesign']).level, 'unclear',
      'an off-topic container must not rescue an off-topic mention');
  });

  check('with no topic context nothing is excluded, and that is stated', () => {
    // A brand with no Search Console history has no basis for the judgement.
    // Guessing would silently drop real mentions, so it reports unassessable
    // and counts everything.
    const none = { usable: false, source: null, terms: new Set() };
    const v = reputation.mentionConfidence({ title: 'anything at all', snippet: '' }, { context: none, domain: 'example.com' });
    assert.strictEqual(v.level, 'unassessable');
    assert.ok(/no topic context/i.test(v.why), 'the reason must say why it could not be judged');
  });

  // ---- the Reddit client ----------------------------------------------
  const redditClient = require('./src/lib/aiseo/redditClient');

  check('browser headers carry client hints that AGREE with the user agent', () => {
    redditClient.BROWSER_PROFILES.forEach((p) => {
      const h = redditClient.browserHeaders(p);
      assert.strictEqual(h['User-Agent'], p.ua);
      assert.ok(h['Sec-CH-UA'], 'Sec-CH-UA is required — a UA claiming Chrome with no client hints is a known bot signature');
      assert.ok(h['Sec-Fetch-Mode'] && h['Sec-Fetch-Site'] && h['Sec-Fetch-Dest'], 'the Sec-Fetch triplet must be present');
      // The brand named in the hint must be the brand named in the UA.
      const brandInUa = /Edg\//.test(p.ua) ? 'Microsoft Edge' : 'Google Chrome';
      assert.ok(h['Sec-CH-UA'].includes(brandInUa),
        `Sec-CH-UA says "${h['Sec-CH-UA']}" but the UA is ${brandInUa} — inconsistent hints are worse than none`);
      assert.ok(!/br|zstd/.test(h['Accept-Encoding']),
        'advertising an encoding that cannot be decoded returns bytes nothing can read');
    });
  });

  check('Atom feeds parse (Reddit serves Atom, not RSS 2.0)', () => {
    const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'
      + '<entry><author><name>/u/someone</name></author>'
      + '<content type="html">&lt;div&gt;I need a new website built&lt;/div&gt;</content>'
      + '<id>t3_abc123</id>'
      + '<link href="https://www.reddit.com/r/webdev/comments/abc123/title/" />'
      + '<updated>2026-05-01T10:00:00+00:00</updated>'
      + '<title>Looking for a web designer</title></entry></feed>';
    const items = redditClient.parseFeed(atom);
    assert.strictEqual(items.length, 1, 'an Atom <entry> must be found');
    assert.strictEqual(items[0].title, 'Looking for a web designer');
    assert.strictEqual(items[0].author, '/u/someone');
    assert.ok(items[0].body.includes('I need a new website built'), 'escaped HTML in <content> must be decoded and stripped');
    assert.ok(items[0].publishedAt, '<updated> must be parsed');
    assert.strictEqual(items[0].thingId, 't3_abc123');
  });

  check('RSS 2.0 feeds still parse through the same reader', () => {
    const rss = '<rss><channel><item><title>A post</title>'
      + '<link>https://www.reddit.com/r/x/comments/1/a/</link>'
      + '<pubDate>Tue, 01 Apr 2026 10:00:00 GMT</pubDate>'
      + '<description>body text</description></item></channel></rss>';
    const items = redditClient.parseFeed(rss);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, 'A post');
    assert.ok(items[0].publishedAt);
  });

  check('the subreddit is read back off a permalink', () => {
    assert.strictEqual(redditClient.subredditOf('https://www.reddit.com/r/webdesign/comments/abc/title/'), 'r/webdesign');
    assert.strictEqual(redditClient.subredditOf('https://example.com/not-reddit'), null);
  });

  await checkAsync('a 403 kills that tier for the session; a 429 does not', async () => {
    const s = new redditClient.BrowserSession({ delayMs: 0, cooldownBaseMs: 1 });
    // A 403 must NOT count toward the block threshold: treating a permanently
    // closed endpoint as an angry host let one dead tier abandon the source.
    s.rateLimited = false;
    s.lastError = 'HTTP 403 (endpoint closed to unauthenticated callers)';
    assert.strictEqual(s.consecutiveBlocks, 0, 'a 403 must not increment the block counter');
    assert.strictEqual(s.hardBlocked, false);
    // Four rate limits, however, must stop the session.
    const rateLimited = new redditClient.BrowserSession({ delayMs: 0, cooldownBaseMs: 1 });
    rateLimited.consecutiveBlocks = 4;
    assert.strictEqual(rateLimited.hardBlocked, true, 'four consecutive rate limits must hard-block');
  });

  await checkAsync('a hard-blocked session refuses to make more requests', async () => {
    const s = new redditClient.BrowserSession({ delayMs: 0 });
    s.consecutiveBlocks = 99;
    const before = s.requests;
    const r = await s.get('https://www.reddit.com/search.rss?q=test');
    assert.strictEqual(r, null);
    assert.strictEqual(s.requests, before, 'no request may be made once hard-blocked — that is the point of the threshold');
  });

  check('RSS parsing handles CDATA and entities', () => {
    const items = reputation.parseRss(
      '<rss><channel><item><title><![CDATA[Acme &amp; Co under review]]></title>'
      + '<link>https://news.example/x</link><pubDate>Tue, 01 Apr 2026 10:00:00 GMT</pubDate>'
      + '<description>Some text</description></item></channel></rss>',
      'google-news',
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, 'Acme & Co under review');
    assert.ok(items[0].publishedAt);
  });

  // =====================================================================
  section('8. Provider honesty (providers.js)');

  check('the built-in crawler is always available', () => {
    assert.strictEqual(providers.has('crawler'), true);
  });

  check('Reddit reports as WORKING without a credential, not as unconfigured', () => {
    // Two states were not enough. Reddit is scraped successfully with no
    // credential at all — a credential only removes the rate limiting and adds
    // post scores. Rendering that as "not configured" told the reader the
    // source was dead while it was returning data.
    assert.strictEqual(providers.has('reddit'), true,
      'Reddit works without a credential, so it must report as available');
    const enhanced = providers.isEnhanced('reddit');
    if (!process.env.REDDIT_CLIENT_ID) {
      assert.strictEqual(enhanced, false, 'without a credential it is available but not enhanced');
      const row = providers.get('reddit');
      assert.strictEqual(row.enhancementMissing, true, 'the UI needs this flag to show the third badge');
      assert.ok(row.enhancedNote, 'the note must say what the credential would buy');
    } else {
      assert.strictEqual(enhanced, true);
    }
  });

  check('a provider with no enhancement concept reports null, not false', () => {
    // null and false must be distinguishable: "no upgrade exists" is not the
    // same claim as "an upgrade exists and is missing".
    assert.strictEqual(providers.isEnhanced('azure'), null);
    assert.strictEqual(providers.isEnhanced('crawler'), null);
    assert.strictEqual(providers.get('azure').enhancementMissing, false);
  });

  check('commercial providers with no credentials report unavailable', () => {
    ['semrush', 'ahrefs', 'moz', 'dataforseo'].forEach((k) => {
      const p = providers.get(k);
      assert.ok(p, `${k} must be declared`);
      if (!p.envKeys.every((e) => process.env[e])) {
        assert.strictEqual(p.available, false, `${k} must not claim to be available without its keys`);
        assert.ok(p.note, `${k} must explain how to enable it`);
      }
    });
  });

  check('provenance names the unavailable providers rather than hiding them', () => {
    const prov = providers.provenance(['crawler', 'gsc']);
    assert.ok(prov.used.some((p) => p.key === 'crawler'));
    const unset = ['semrush', 'ahrefs', 'moz', 'dataforseo']
      .filter((k) => !providers.has(k));
    if (unset.length) {
      assert.ok(prov.wouldImprove.length > 0, 'unavailable commercial providers must be surfaced');
    }
  });

  // =====================================================================
  section('9. Tracking catalog (trackingCatalog.js)');

  const TRACKING_ELEMENTS = [
    'crawl_errors', 'robots_changes', 'sitemap_health', 'index_coverage',
    'core_web_vitals', 'ttfb', 'page_load', 'ssl_security', 'redirect_chains',
    'canonicalisation', 'url_structure', 'titles_meta', 'heading_structure',
    'content_quality', 'internal_linking', 'images', 'structured_data',
    'js_rendering', 'mobile_usability', 'ai_crawler_access',
  ];

  check('every specified tracking element has a check', () => {
    const keys = new Set(trackingCatalog.all().map((c) => c.key));
    const missing = TRACKING_ELEMENTS.filter((k) => !keys.has(k));
    assert.strictEqual(missing.length, 0, `no check for: ${missing.join(', ')}`);
  });

  check('every check declares what it tracks, why, its scope and its needs', () => {
    trackingCatalog.all().forEach((c) => {
      assert.ok(c.element, `${c.key} has no element name`);
      assert.ok(c.whatItTracks, `${c.key} does not say what it tracks`);
      assert.ok(c.whyItMatters, `${c.key} does not say why it matters`);
      assert.ok(['site', 'page'].includes(c.scope), `${c.key} has an invalid scope`);
      assert.ok(Array.isArray(c.needs), `${c.key} declares no needs`);
      assert.strictEqual(typeof c.run, 'function', `${c.key} has no run()`);
    });
  });

  check('every check belongs to a declared group', () => {
    const groups = new Set(trackingCatalog.GROUP_ORDER);
    trackingCatalog.all().forEach((c) => {
      assert.ok(groups.has(c.group), `${c.key} is in undeclared group "${c.group}"`);
    });
  });

  check('bandOf never returns "good" for a null value', () => {
    assert.strictEqual(trackingCatalog.bandOf(null, 100, 200), 'unknown',
      'an unmeasured metric reported as good is how a board shows green through an outage');
  });

  check('bandOf handles both directions', () => {
    assert.strictEqual(trackingCatalog.bandOf(50, 100, 200), 'good');
    assert.strictEqual(trackingCatalog.bandOf(150, 100, 200), 'warn');
    assert.strictEqual(trackingCatalog.bandOf(300, 100, 200), 'fail');
    assert.strictEqual(trackingCatalog.bandOf(95, 90, 70, { lowerIsBetter: false }), 'good');
    assert.strictEqual(trackingCatalog.bandOf(50, 90, 70, { lowerIsBetter: false }), 'fail');
  });

  // =====================================================================
  section('10. Store and run lifecycle (store.js)');

  const brand = db.prepare('SELECT * FROM brands WHERE active=1 ORDER BY id LIMIT 1').get();
  if (!brand) {
    console.log('  --   skipped: no brand in the database to test against');
  } else {
    let testRunId = null;

    check('begin creates a running row', () => {
      const r = store.begin({ userId: brand.user_id, brandId: brand.id, kind: 'research', target: 'test://verify', label: 'verify' });
      testRunId = r.id;
      const row = store.get(r.id);
      assert.strictEqual(row.status, 'running');
      assert.strictEqual(row.kind, 'research');
    });

    check('adoptRunId reuses the row instead of inserting a second one', () => {
      const before = db.prepare("SELECT COUNT(*) n FROM aiseo_runs WHERE target='test://verify'").get().n;
      const r = store.begin({ userId: brand.user_id, brandId: brand.id, kind: 'research', target: 'test://verify', adoptRunId: testRunId });
      const after = db.prepare("SELECT COUNT(*) n FROM aiseo_runs WHERE target='test://verify'").get().n;
      assert.strictEqual(r.id, testRunId, 'the existing run must be adopted');
      assert.strictEqual(after, before, 'adoption must not insert another row');
    });

    check('finish writes the payload, the findings and the metrics in one transaction', () => {
      store.finish(testRunId, {
        score: 72,
        result: { empty: false, hello: 'world' },
        findings: [
          { checkKey: 'a', title: 'First', severity: 'high', detail: 'd', action: 'x', dedupeKey: 'verify:a' },
          { checkKey: 'b', title: 'Second', severity: 'info', detail: 'd', dedupeKey: 'verify:b' },
        ],
        metrics: [{ key: 'verify.metric', value: 5, status: 'good' }],
        sources: ['crawler'],
      });
      const row = store.get(testRunId);
      assert.strictEqual(row.status, 'completed');
      assert.strictEqual(row.score, 72);
      assert.strictEqual(row.result.hello, 'world');
      assert.deepStrictEqual(row.result.sources, ['crawler']);
      assert.strictEqual(row.findings.length, 2);
      assert.strictEqual(row.findings[0].severity, 'high', 'findings must come back severity-ordered');
    });

    check('re-finishing replaces findings rather than accumulating them', () => {
      store.finish(testRunId, {
        score: 80,
        result: { empty: false },
        findings: [{ checkKey: 'c', title: 'Only one now', severity: 'low', dedupeKey: 'verify:c' }],
      });
      assert.strictEqual(store.get(testRunId).findings.length, 1);
    });

    check('findings with no dedupe key of their own do not collapse into one row', () => {
      store.finish(testRunId, {
        result: { empty: false },
        findings: [
          { checkKey: 'x', title: 'One', severity: 'low', affectedUrl: 'https://a' },
          { checkKey: 'x', title: 'Two', severity: 'low', affectedUrl: 'https://b' },
        ],
      });
      assert.strictEqual(store.get(testRunId).findings.length, 2,
        'the unique index would silently drop one if the fallback dedupe key were not per-finding');
    });

    check('metric history returns a series and a previous value', () => {
      store.recordMetrics(brand.id, [{ key: 'verify.series', value: 1, status: 'good' }], '2026-01-01 00:00:00');
      store.recordMetrics(brand.id, [{ key: 'verify.series', value: 2, status: 'warn' }], '2026-01-02 00:00:00');
      const series = store.metricSeries(brand.id, 'verify.series');
      assert.strictEqual(series.length, 2);
      assert.strictEqual(series[0].value, 1, 'the series must be oldest-first');
      const prev = store.previousMetric(brand.id, 'verify.series');
      assert.strictEqual(prev.value, 1, 'previousMetric must skip the newest capture');
    });

    check('latestMetrics pairs each metric with its own newest capture', () => {
      const rows = store.latestMetrics(brand.id, { metricKeys: ['verify.series'] });
      const row = rows.find((r) => r.metric_key === 'verify.series');
      assert.ok(row, 'the metric should be present');
      assert.strictEqual(row.value, 2, 'a GROUP BY without a correlated subquery would pair the wrong value here');
    });

    check('fail records the reason', () => {
      const r = store.begin({ userId: brand.user_id, brandId: brand.id, kind: 'research', target: 'test://verify-fail' });
      store.fail(r.id, new Error('deliberate'));
      const row = store.get(r.id);
      assert.strictEqual(row.status, 'error');
      assert.ok(/deliberate/.test(row.error));
      db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(r.id);
    });

    // Clean up everything this section wrote.
    db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(testRunId);
    db.prepare("DELETE FROM aiseo_metrics WHERE brand_id=? AND metric_key LIKE 'verify.%'").run(brand.id);
  }

  // =====================================================================
  section('11. Live network checks');

  await checkAsync('a real page is fetched, parsed and timed', async () => {
    const res = await fetcher.fetchPage('https://example.com/', { timeout: 15000 });
    assert.ok(res.ok, `expected 200, got ${res.status} ${res.error || ''}`);
    assert.ok(res.totalMs > 0);
    const d = fetcher.parseDocument(res.url, res.body);
    assert.ok(d.title, 'example.com has a title');
  });

  await checkAsync('TTFB is measured as a median of samples', async () => {
    const t = await fetcher.measureTtfb('https://example.com/', { samples: 3 });
    assert.ok(t.ms > 0, `no reading: ${t.error || ''}`);
    assert.strictEqual(t.samples.length, 3);
  });

  await checkAsync('a live certificate is read, with days remaining', async () => {
    const c = await fetcher.inspectCertificate('https://example.com/');
    assert.ok(c.ok, `certificate not read: ${c.error}`);
    assert.ok(Number.isFinite(c.daysLeft), 'daysLeft must be a number');
    assert.strictEqual(typeof c.authorized, 'boolean');
  });

  await checkAsync('inspectCertificate refuses a plain-HTTP URL cleanly', async () => {
    const c = await fetcher.inspectCertificate('http://example.com/');
    assert.strictEqual(c.ok, false);
    assert.ok(/HTTPS/i.test(c.error));
  });

  if (providers.has('public')) {
    await checkAsync('Google autocomplete returns suggestions', async () => {
      const research = require('./src/lib/aiseo/research');
      const out = await research.suggest('seo audit');
      assert.ok(Array.isArray(out), 'must return an array');
      if (!out.length) {
        console.log('         (note: empty — usually rate limiting, not a code fault)');
      } else {
        assert.ok(out[0].keyword && out[0].rank === 1);
      }
    });
  }

  // =====================================================================
  if (FULL && brand) {
    section('12. Full live analyses (--full)');

    const readiness = require('./src/lib/aiseo/readiness');
    const tracking = require('./src/lib/aiseo/tracking');

    await checkAsync(`readiness runs end to end against ${brand.site_url}`, async () => {
      const run = await readiness.run({
        userId: brand.user_id, brand, includePsi: false, probeEdge: true,
      });
      assert.strictEqual(run.status, 'completed');
      assert.ok(run.result, 'a payload must be written');
      assert.ok(Array.isArray(run.result.agents) && run.result.agents.length, 'per-agent verdicts must be present');
      assert.ok(run.result.agents.every((a) => ['retrieval', 'training'].includes(a.purpose)),
        'every agent must declare its purpose — the retrieval/training split is the point of this check');
      assert.ok(run.result.provenance, 'provenance must be recorded');
      console.log(`         score ${run.score}, ${run.findings.length} finding(s), `
        + `${run.result.agentSummary.retrievalOk}/${run.result.agentSummary.retrievalTotal} retrieval fetchers OK`);
      db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(run.id);
    });

    await checkAsync('a tracking sample is representative, not just top pages', async () => {
      const sample = await tracking.buildSample(brand, { size: 8 });
      assert.ok(sample.urls.length > 0, 'the sample must not be empty');
      assert.strictEqual(sample.composition.homepage, 1, 'the homepage must always be in the sample');
      assert.ok(sample.basis, 'the composition must be described for the UI');
      console.log(`         ${sample.urls.length} URLs — ${sample.basis}`);
    });

    await checkAsync('a restricted tracking sweep runs and stores metrics', async () => {
      const run = await tracking.run({
        userId: brand.user_id, brand, only: ['ssl_security', 'ttfb', 'canonicalisation'], sampleSize: 4,
      });
      assert.strictEqual(run.status, 'completed');
      assert.strictEqual(run.result.checks.length, 3);
      run.result.checks.forEach((c) => {
        assert.ok(['good', 'warn', 'fail', 'unknown', 'error', 'unavailable'].includes(c.status),
          `${c.key} returned an invalid status "${c.status}"`);
      });
      const stored = db.prepare("SELECT COUNT(*) n FROM aiseo_metrics WHERE brand_id=? AND metric_key LIKE 'track.%'").get(brand.id).n;
      assert.ok(stored > 0, 'metrics must be written to the series');
      console.log(`         ${run.result.checks.map((c) => `${c.key}:${c.status}`).join(', ')}`);
      db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(run.id);
    });

    // THE BOARD'S CENTRAL INVARIANT
    //
    // A metric may not be redder than the finding it produces, and a failing
    // metric must always come with a finding that explains it. Both were
    // violated on the first real sweep: missing security headers (a 'low'
    // finding) turned the Security group red, a missing canonical tag (also
    // 'low') failed URL & canonical health, and average citability failed
    // Content quality with nothing on the page saying why.
    //
    // A red group with no explanation, or a red group for something trivial,
    // is how a board stops being read — so this is asserted rather than left
    // to review.
    await checkAsync('every failing metric has a finding of matching weight', async () => {
      const run = await tracking.run({ userId: brand.user_id, brand, sampleSize: 3 });
      const RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const problems = [];

      run.result.checks.forEach((c) => {
        const failing = (c.metrics || []).filter((m) => m.status === 'fail');
        if (!failing.length) return;
        if (!(c.findings || []).length) {
          problems.push(`${c.key}: metric(s) ${failing.map((m) => m.key).join(', ')} report "fail" but the check raised no finding`);
          return;
        }
        const worst = (c.findings || []).reduce((acc, f) => Math.max(acc, RANK[f.severity] ?? 0), 0);
        if (worst < RANK.medium) {
          problems.push(`${c.key}: metric(s) ${failing.map((m) => m.key).join(', ')} report "fail" but the strongest finding is only "${(c.findings || []).map((f) => f.severity).join('/')}"`);
        }
      });

      db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(run.id);
      assert.strictEqual(problems.length, 0, `\n         ${problems.join('\n         ')}`);
      console.log(`         checked ${run.result.checks.length} checks, ${run.result.counts.metricsMeasured} measured metrics`);
    });

    await checkAsync('no check reports "unknown" while it measured something', async () => {
      const run = await tracking.run({ userId: brand.user_id, brand, sampleSize: 3 });
      const wrong = run.result.checks.filter((c) => c.status === 'unknown'
        && (c.metrics || []).some((m) => m.status && m.status !== 'unknown'));
      db.prepare('DELETE FROM aiseo_runs WHERE id=?').run(run.id);
      assert.strictEqual(wrong.length, 0,
        `${wrong.map((c) => c.key).join(', ')} reported unknown despite having measured metrics — one unmeasurable sub-metric must not hide a real verdict`);
    });
  } else if (!FULL) {
    console.log('\n(skipping the crawling analyses — re-run with --full to include them)');
  }

  // =====================================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f.name}\n    ${f.error}`));
  }
  console.log(`${'='.repeat(60)}\n`);

  db.closeDb();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nverification crashed:', err);
  try { require('./src/db').closeDb(); } catch { /* already closed */ }
  process.exit(1);
});
