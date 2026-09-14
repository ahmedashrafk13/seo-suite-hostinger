// Unit checks for src/lib/aiseo/keywordPlanner.js: the request bodies it
// builds and the responses it parses. lib/google is stubbed in the require
// cache, so no database and no Google Ads call.
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const googlePath = require.resolve(path.join(ROOT, 'src/lib/google.js'));
let lastCall = null;
let RESPONSE = {};
require.cache[googlePath] = {
  id: googlePath,
  filename: googlePath,
  loaded: true,
  exports: {
    ADS_API_VERSION: 'v25',
    resolveAdsPrincipal: () => ({ ok: true, mode: 'shared', userId: 7, customerId: '111', loginCustomerId: '222', ownerEmail: 'o@x.com' }),
    adsRequest: async (userId, p, opts) => { lastCall = { userId, path: p, opts }; return RESPONSE; },
  },
};

const kp = require(path.join(ROOT, 'src/lib/aiseo/keywordPlanner.js'));

let fail = 0;
function check(name, cond, detail) {
  if (cond) console.log('OK   ' + name);
  else { fail += 1; console.log('FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

function months(vals) {
  const names = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  return vals.map((v, i) => ({ year: 2025, month: names[i], monthlySearches: v }));
}

(async () => {
  // ---------------------------------------------------------------- ideas
  RESPONSE = {
    results: [
      { text: 'seo services', keywordIdeaMetrics: { avgMonthlySearches: 12100, competition: 'HIGH', competitionIndex: 88, lowTopOfPageBidMicros: '4200000', highTopOfPageBidMicros: '19500000', monthlySearchVolumes: months([100, 100, 100, 120, 130, 140, 150, 160, 170, 200, 200, 200]) }, keywordAnnotations: { concepts: [{ name: 'services', conceptGroup: { name: 'Services', type: 'OTHER' } }] } },
      { text: 'free seo tool', keywordIdeaMetrics: { avgMonthlySearches: 90, competition: 'LOW', competitionIndex: 5 } },
      { text: 'how to do seo', keywordIdeaMetrics: { avgMonthlySearches: 5000, competition: 'LOW', competitionIndex: 10 } },
    ],
    aggregateMetricResults: { deviceSearchesList: [{ device: 'MOBILE', searchCount: '7000' }, { device: 'DESKTOP', searchCount: '3000' }] },
    nextPageToken: 'tok',
  };

  let r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo services'], market: 'GB', language: 'de', network: 'GOOGLE_SEARCH_AND_PARTNERS', deviceBreakdown: true, geoTargetIds: ['1006886'] });
  let b = lastCall.opts.body;
  check('ideas hits generateKeywordIdeas', lastCall.path === '/customers/111:generateKeywordIdeas', lastCall.path);
  check('ideas acts as the principal, not the caller', lastCall.userId === 7);
  check('ideas sends the login-customer-id', lastCall.opts.loginCustomerId === '222');
  check('keyword seed built', JSON.stringify(b.keywordSeed) === '{"keywords":["seo services"]}', b.keywordSeed);
  check('language constant resolved', b.language === 'languageConstants/1001', b.language);
  check('country and extra geo both targeted', JSON.stringify(b.geoTargetConstants) === '["geoTargetConstants/2826","geoTargetConstants/1006886"]', b.geoTargetConstants);
  check('network passed', b.keywordPlanNetwork === 'GOOGLE_SEARCH_AND_PARTNERS');
  check('concept annotations requested', JSON.stringify(b.keywordAnnotation) === '["KEYWORD_CONCEPT"]');
  check('device aggregate requested', JSON.stringify(b.aggregateMetrics) === '{"aggregateMetricTypes":["DEVICE"]}');

  check('ideas parses volume', r.rows[0].volume === 12100);
  check('ideas converts bid micros to currency', r.rows[0].lowBid === 4.2 && r.rows[0].highBid === 19.5, [r.rows[0].lowBid, r.rows[0].highBid]);
  check('ideas sorts by volume', r.rows.map((x) => x.volume).join(',') === '12100,5000,90');
  check('seed row flagged', r.rows[0].isSeed === true && r.rows[1].isSeed === false);
  check('concept group extracted', r.rows[0].conceptGroup === 'Services');
  check('month curve ordered oldest first', r.rows[0].monthly[0].label === '2025-01' && r.rows[0].monthly[11].label === '2025-12');
  check('trend computed from the curve', r.rows[0].trendPct === 100, r.rows[0].trendPct);
  check('device split shares', r.devices[0].device === 'mobile' && r.devices[0].share === 70, r.devices);
  check('next page token surfaced', r.nextPageToken === 'tok');
  check('basis names the shared account', /shared agency account 111/.test(r.basis.account), r.basis.account);
  check('basis names country and language', r.basis.market === 'United Kingdom' && r.basis.language === 'German');

  // duplicate geo target must not be sent twice
  await kp.ideas(1, { seedMode: 'keyword', keywords: ['x'], market: 'US', geoTargetIds: ['2840'] });
  check('duplicate geo target de-duplicated', JSON.stringify(lastCall.opts.body.geoTargetConstants) === '["geoTargetConstants/2840"]', lastCall.opts.body.geoTargetConstants);

  // worldwide sends no country constant
  await kp.ideas(1, { seedMode: 'keyword', keywords: ['x'], market: 'ZZ' });
  check('worldwide sends no geo constant', JSON.stringify(lastCall.opts.body.geoTargetConstants) === '[]');

  // seed shapes
  await kp.ideas(1, { seedMode: 'site', url: 'https://example.com' });
  check('site seed shape', JSON.stringify(lastCall.opts.body.siteSeed) === '{"site":"https://example.com"}');
  await kp.ideas(1, { seedMode: 'url', url: 'https://example.com/a' });
  check('url seed shape', JSON.stringify(lastCall.opts.body.urlSeed) === '{"url":"https://example.com/a"}');
  await kp.ideas(1, { seedMode: 'keyword_and_url', keywords: ['a'], url: 'https://e.com' });
  check('combined seed shape', JSON.stringify(lastCall.opts.body.keywordAndUrlSeed) === '{"url":"https://e.com","keywords":["a"]}');
  let threw = null;
  try { await kp.ideas(1, { seedMode: 'url', url: '' }); } catch (e) { threw = e.message; }
  check('missing URL is rejected before the API call', /Enter a URL/.test(threw || ''), threw);
  threw = null;
  try { await kp.ideas(1, { seedMode: 'keyword', keywords: [] }); } catch (e) { threw = e.message; }
  check('empty seed is rejected before the API call', /at least one seed keyword/.test(threw || ''), threw);

  // seed cap
  const many = Array.from({ length: 25 }, (_, i) => 'kw' + i);
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: many });
  check('seed trimmed to Google\'s 20', lastCall.opts.body.keywordSeed.keywords.length === 20);
  check('the dropped seeds are reported', r.truncatedSeed === 5);

  // year-month range
  await kp.ideas(1, { seedMode: 'keyword', keywords: ['a'], startYearMonth: '2024-03', endYearMonth: '2025-02' });
  check('year-month range converted to enum months',
    JSON.stringify(lastCall.opts.body.historicalMetricsOptions.yearMonthRange) === '{"start":{"year":2024,"month":"MARCH"},"end":{"year":2025,"month":"FEBRUARY"}}',
    lastCall.opts.body.historicalMetricsOptions);

  // filters
  RESPONSE = {
    results: [
      { text: 'seo services', keywordIdeaMetrics: { avgMonthlySearches: 12100, competitionIndex: 88, highTopOfPageBidMicros: '19500000' } },
      { text: 'free seo tool', keywordIdeaMetrics: { avgMonthlySearches: 90, competitionIndex: 5 } },
      { text: 'how to do seo yourself', keywordIdeaMetrics: { avgMonthlySearches: 5000, competitionIndex: 10 } },
    ],
  };
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], minVolume: 100 });
  check('minimum volume filter', r.rows.map((x) => x.keyword).join(',') === 'seo services,how to do seo yourself', r.rows.map((x) => x.keyword));
  check('filtered count reported', r.filteredOut === 1 && r.returned === 3);
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], excludeTerms: 'free' });
  check('exclude-terms filter', r.rows.every((x) => x.keyword.indexOf('free') === -1));
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], questionsOnly: true });
  check('questions-only filter', r.rows.length === 1 && r.rows[0].keyword === 'how to do seo yourself', r.rows.map((x) => x.keyword));
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], maxCompetitionIndex: 20 });
  check('competition ceiling filter', r.rows.every((x) => x.competitionIndex <= 20));
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], minWords: 4 });
  check('minimum-words filter', r.rows.length === 1 && r.rows[0].keyword === 'how to do seo yourself');
  r = await kp.ideas(1, { seedMode: 'keyword', keywords: ['seo'], sort: 'alpha' });
  check('alphabetical sort', r.rows[0].keyword === 'free seo tool');

  // ----------------------------------------------------------- historical
  RESPONSE = {
    results: [
      { text: 'seo service', closeVariants: ['seo services'], keywordMetrics: { avgMonthlySearches: 12100, competition: 'HIGH', competitionIndex: 88, averageCpcMicros: '3300000' } },
    ],
  };
  r = await kp.historical(1, { keywords: ['seo services', 'seo service', 'nonexistent term'], market: 'US' });
  check('historical hits its own RPC', lastCall.path === '/customers/111:generateKeywordHistoricalMetrics', lastCall.path);
  check('historical sends the keyword list', JSON.stringify(lastCall.opts.body.keywords).indexOf('nonexistent term') >= 0);
  check('historical requests average CPC', lastCall.opts.body.historicalMetricsOptions.includeAverageCpc === true);
  check('average CPC converted', r.rows[0].averageCpc === 3.3, r.rows[0].averageCpc);
  check('close variants kept', JSON.stringify(r.rows[0].closeVariants) === '["seo services"]');
  check('a keyword merged into a close variant is not reported missing', r.missing.indexOf('seo services') === -1, r.missing);
  check('a keyword with no data is reported missing', JSON.stringify(r.missing) === '["nonexistent term"]', r.missing);
  threw = null;
  try { await kp.historical(1, { keywords: [] }); } catch (e) { threw = e.message; }
  check('historical rejects an empty list', /at least one keyword/.test(threw || ''), threw);

  // ------------------------------------------------------------- forecast
  RESPONSE = { campaignForecastMetrics: { impressions: 52000.4, clicks: 1900.2, clickThroughRate: 0.0365, averageCpcMicros: '2110000', costMicros: '4009000000', conversions: 47.5, averageCpaMicros: '84400000' } };
  r = await kp.forecast(1, { keywords: ['a', 'b'], market: 'US', maxCpcBid: '2.50', matchType: 'PHRASE', startDate: '2026-10-01', endDate: '2026-10-30', conversionRate: '2.5', negativeKeywords: ['free'] });
  b = lastCall.opts.body;
  check('forecast hits its own RPC', lastCall.path === '/customers/111:generateKeywordForecastMetrics', lastCall.path);
  // The shape below was derived by probing the live v25 endpoint - see the
  // comment block in forecast(). These assertions exist so a "tidy-up" cannot
  // quietly restore the documented-but-rejected field names.
  check('bid goes under manualCpcBiddingStrategy',
    b.campaign.biddingStrategy.manualCpcBiddingStrategy.maxCpcBidMicros === 2500000, b.campaign.biddingStrategy);
  check('keywords are FLAT text/matchType',
    b.campaign.adGroups[0].keywords[0].text === 'a' && b.campaign.adGroups[0].keywords[0].matchType === 'PHRASE',
    b.campaign.adGroups[0].keywords[0]);
  check('no per-keyword bid is sent', b.campaign.adGroups[0].keywords[0].maxCpcBidMicros === undefined);
  check('no biddableKeywords field', b.campaign.adGroups[0].biddableKeywords === undefined);
  check('geo sent as geoTargetConstants',
    JSON.stringify(b.campaign.geoTargetConstants) === '["geoTargetConstants/2840"]', b.campaign.geoTargetConstants);
  check('no geoModifiers field', b.campaign.geoModifiers === undefined);
  check('no keywordPlanNetwork on a forecast', b.campaign.keywordPlanNetwork === undefined);
  check('no negativeKeywords on a forecast', b.campaign.negativeKeywords === undefined);
  check('no conversionRate on a forecast', b.campaign.conversionRate === undefined);
  check('forecast period sent', b.forecastPeriod.startDate === '2026-10-01' && b.forecastPeriod.endDate === '2026-10-30');
  check('our derived `days` is stripped from the request', b.forecastPeriod.days === undefined);
  check('cost converted from micros', r.metrics.cost === 4009, r.metrics.cost);
  check('CTR rendered as a percentage', r.metrics.ctr === 3.65, r.metrics.ctr);
  check('cost per day derived', r.metrics.costPerDay === Math.round((4009 / 30) * 100) / 100, r.metrics.costPerDay);
  check('CPA converted', r.metrics.averageCpa === 84.4, r.metrics.averageCpa);
  threw = null;
  try { await kp.forecast(1, { keywords: ['a'], maxCpcBid: '0' }); } catch (e) { threw = e.message; }
  check('forecast rejects a zero bid', /maximum CPC bid/.test(threw || ''), threw);
  await kp.forecast(1, { keywords: ['a'], maxCpcBid: '1' });
  check('no conversion rate means the field is omitted', lastCall.opts.body.campaign.conversionRate === undefined);

  // ------------------------------------------------------------ geo search
  RESPONSE = { geoTargetConstantSuggestions: [{ geoTargetConstant: { id: '1023191', name: 'New York', targetType: 'City', countryCode: 'US' }, geoTargetConstantParents: [{ name: 'New York' }, { name: 'United States' }], reach: '19000000' }] };
  const geo = await kp.suggestGeoTargets(1, 'new york', { countryCode: 'US' });
  check('geo suggest hits the top-level endpoint', lastCall.path === '/geoTargetConstants:suggest', lastCall.path);
  check('geo suggest sends the name and country', lastCall.opts.body.locationNames.names[0] === 'new york' && lastCall.opts.body.countryCode === 'US');
  check('geo suggest parses id, name and parents', geo[0].id === '1023191' && geo[0].name === 'New York' && geo[0].parents.length === 2);
  check('empty query short-circuits', (await kp.suggestGeoTargets(1, '  ')).length === 0);

  console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('harness threw ->', e.stack); process.exit(1); });
