// MARKETS — the country/locale registry every geo-aware call reads from.
//
// "Add a country filter for volume" is not one parameter. Every source that
// can be localised wants a DIFFERENT identifier for the same country:
//
//   Google Suggest         gl=gb  hl=en
//   Google Trends          geo=GB
//   DuckDuckGo HTML        kl=uk-en
//   Bing HTML              cc=GB / setLang
//   DataForSEO             location_code=2826, language_code=en
//   Semrush                database=uk
//
// Keeping one table means a user picks "United Kingdom" once and every
// adapter is handed the identifier it actually understands. Passing `gl=uk`
// to Google (which wants `gb`) or `geo=UK` to Trends silently returns
// worldwide data, which is the worst failure mode available here: a number
// labelled "United Kingdom" that is not.
//
// DataForSEO location codes are Google's own Geo Target IDs (criteria IDs),
// which is what their API expects. They are stable and published; the ones
// below are transcribed from Google's geotargets table.
const MARKETS = [
  { code: 'ZZ', name: 'Worldwide / no country filter', gl: null, hl: 'en', trendsGeo: '', ddg: 'wt-wt', dfsLocation: 2840, dfsLanguage: 'en', semrush: 'us', worldwide: true },
  { code: 'US', name: 'United States', gl: 'us', hl: 'en', trendsGeo: 'US', ddg: 'us-en', dfsLocation: 2840, dfsLanguage: 'en', semrush: 'us' },
  { code: 'GB', name: 'United Kingdom', gl: 'gb', hl: 'en', trendsGeo: 'GB', ddg: 'uk-en', dfsLocation: 2826, dfsLanguage: 'en', semrush: 'uk' },
  { code: 'CA', name: 'Canada', gl: 'ca', hl: 'en', trendsGeo: 'CA', ddg: 'ca-en', dfsLocation: 2124, dfsLanguage: 'en', semrush: 'ca' },
  { code: 'AU', name: 'Australia', gl: 'au', hl: 'en', trendsGeo: 'AU', ddg: 'au-en', dfsLocation: 2036, dfsLanguage: 'en', semrush: 'au' },
  { code: 'NZ', name: 'New Zealand', gl: 'nz', hl: 'en', trendsGeo: 'NZ', ddg: 'nz-en', dfsLocation: 2554, dfsLanguage: 'en', semrush: 'nz' },
  { code: 'IE', name: 'Ireland', gl: 'ie', hl: 'en', trendsGeo: 'IE', ddg: 'ie-en', dfsLocation: 2372, dfsLanguage: 'en', semrush: 'ie' },
  { code: 'IN', name: 'India', gl: 'in', hl: 'en', trendsGeo: 'IN', ddg: 'in-en', dfsLocation: 2356, dfsLanguage: 'en', semrush: 'in' },
  { code: 'PK', name: 'Pakistan', gl: 'pk', hl: 'en', trendsGeo: 'PK', ddg: 'pk-en', dfsLocation: 2586, dfsLanguage: 'en', semrush: null },
  { code: 'AE', name: 'United Arab Emirates', gl: 'ae', hl: 'en', trendsGeo: 'AE', ddg: 'xa-en', dfsLocation: 2784, dfsLanguage: 'en', semrush: 'ae' },
  { code: 'SA', name: 'Saudi Arabia', gl: 'sa', hl: 'ar', trendsGeo: 'SA', ddg: 'xa-ar', dfsLocation: 2682, dfsLanguage: 'ar', semrush: 'sa' },
  { code: 'ZA', name: 'South Africa', gl: 'za', hl: 'en', trendsGeo: 'ZA', ddg: 'za-en', dfsLocation: 2710, dfsLanguage: 'en', semrush: 'za' },
  { code: 'NG', name: 'Nigeria', gl: 'ng', hl: 'en', trendsGeo: 'NG', ddg: 'wt-wt', dfsLocation: 2566, dfsLanguage: 'en', semrush: 'ng' },
  { code: 'SG', name: 'Singapore', gl: 'sg', hl: 'en', trendsGeo: 'SG', ddg: 'sg-en', dfsLocation: 2702, dfsLanguage: 'en', semrush: 'sg' },
  { code: 'MY', name: 'Malaysia', gl: 'my', hl: 'en', trendsGeo: 'MY', ddg: 'my-en', dfsLocation: 2458, dfsLanguage: 'en', semrush: 'my' },
  { code: 'PH', name: 'Philippines', gl: 'ph', hl: 'en', trendsGeo: 'PH', ddg: 'ph-en', dfsLocation: 2608, dfsLanguage: 'en', semrush: 'ph' },
  { code: 'HK', name: 'Hong Kong', gl: 'hk', hl: 'en', trendsGeo: 'HK', ddg: 'hk-tzh', dfsLocation: 2344, dfsLanguage: 'en', semrush: 'hk' },
  { code: 'DE', name: 'Germany', gl: 'de', hl: 'de', trendsGeo: 'DE', ddg: 'de-de', dfsLocation: 2276, dfsLanguage: 'de', semrush: 'de' },
  { code: 'FR', name: 'France', gl: 'fr', hl: 'fr', trendsGeo: 'FR', ddg: 'fr-fr', dfsLocation: 2250, dfsLanguage: 'fr', semrush: 'fr' },
  { code: 'ES', name: 'Spain', gl: 'es', hl: 'es', trendsGeo: 'ES', ddg: 'es-es', dfsLocation: 2724, dfsLanguage: 'es', semrush: 'es' },
  { code: 'IT', name: 'Italy', gl: 'it', hl: 'it', trendsGeo: 'IT', ddg: 'it-it', dfsLocation: 2380, dfsLanguage: 'it', semrush: 'it' },
  { code: 'NL', name: 'Netherlands', gl: 'nl', hl: 'nl', trendsGeo: 'NL', ddg: 'nl-nl', dfsLocation: 2528, dfsLanguage: 'nl', semrush: 'nl' },
  { code: 'BE', name: 'Belgium', gl: 'be', hl: 'nl', trendsGeo: 'BE', ddg: 'be-nl', dfsLocation: 2056, dfsLanguage: 'nl', semrush: 'be' },
  { code: 'SE', name: 'Sweden', gl: 'se', hl: 'sv', trendsGeo: 'SE', ddg: 'se-sv', dfsLocation: 2752, dfsLanguage: 'sv', semrush: 'se' },
  { code: 'NO', name: 'Norway', gl: 'no', hl: 'no', trendsGeo: 'NO', ddg: 'no-no', dfsLocation: 2578, dfsLanguage: 'no', semrush: 'no' },
  { code: 'DK', name: 'Denmark', gl: 'dk', hl: 'da', trendsGeo: 'DK', ddg: 'dk-da', dfsLocation: 2208, dfsLanguage: 'da', semrush: 'dk' },
  { code: 'FI', name: 'Finland', gl: 'fi', hl: 'fi', trendsGeo: 'FI', ddg: 'fi-fi', dfsLocation: 2246, dfsLanguage: 'fi', semrush: 'fi' },
  { code: 'PL', name: 'Poland', gl: 'pl', hl: 'pl', trendsGeo: 'PL', ddg: 'pl-pl', dfsLocation: 2616, dfsLanguage: 'pl', semrush: 'pl' },
  { code: 'PT', name: 'Portugal', gl: 'pt', hl: 'pt', trendsGeo: 'PT', ddg: 'pt-pt', dfsLocation: 2620, dfsLanguage: 'pt', semrush: 'pt' },
  { code: 'CH', name: 'Switzerland', gl: 'ch', hl: 'de', trendsGeo: 'CH', ddg: 'ch-de', dfsLocation: 2756, dfsLanguage: 'de', semrush: 'ch' },
  { code: 'AT', name: 'Austria', gl: 'at', hl: 'de', trendsGeo: 'AT', ddg: 'at-de', dfsLocation: 2040, dfsLanguage: 'de', semrush: 'at' },
  { code: 'BR', name: 'Brazil', gl: 'br', hl: 'pt', trendsGeo: 'BR', ddg: 'br-pt', dfsLocation: 2076, dfsLanguage: 'pt', semrush: 'br' },
  { code: 'MX', name: 'Mexico', gl: 'mx', hl: 'es', trendsGeo: 'MX', ddg: 'mx-es', dfsLocation: 2484, dfsLanguage: 'es', semrush: 'mx' },
  { code: 'AR', name: 'Argentina', gl: 'ar', hl: 'es', trendsGeo: 'AR', ddg: 'ar-es', dfsLocation: 2032, dfsLanguage: 'es', semrush: 'ar' },
  { code: 'JP', name: 'Japan', gl: 'jp', hl: 'ja', trendsGeo: 'JP', ddg: 'jp-jp', dfsLocation: 2392, dfsLanguage: 'ja', semrush: 'jp' },
  { code: 'KR', name: 'South Korea', gl: 'kr', hl: 'ko', trendsGeo: 'KR', ddg: 'kr-kr', dfsLocation: 2410, dfsLanguage: 'ko', semrush: 'kr' },
  { code: 'ID', name: 'Indonesia', gl: 'id', hl: 'id', trendsGeo: 'ID', ddg: 'id-en', dfsLocation: 2360, dfsLanguage: 'id', semrush: 'id' },
  { code: 'TR', name: 'Türkiye', gl: 'tr', hl: 'tr', trendsGeo: 'TR', ddg: 'tr-tr', dfsLocation: 2792, dfsLanguage: 'tr', semrush: 'tr' },
  { code: 'IL', name: 'Israel', gl: 'il', hl: 'he', trendsGeo: 'IL', ddg: 'il-he', dfsLocation: 2376, dfsLanguage: 'he', semrush: 'il' },
  { code: 'EG', name: 'Egypt', gl: 'eg', hl: 'ar', trendsGeo: 'EG', ddg: 'xa-ar', dfsLocation: 2818, dfsLanguage: 'ar', semrush: 'eg' },
];

const BY_CODE = new Map(MARKETS.map((m) => [m.code, m]));

// Resolves whatever a brand or a form gave us into a market row.
//
// Accepts an ISO code ('GB'), a lowercase Google gl ('gb'), or null. Anything
// unrecognised resolves to worldwide rather than throwing, because a stale
// brand row must not break a research run — but the resolved market is always
// returned so the caller can render WHICH country the numbers are for.
function resolve(input) {
  if (!input) return BY_CODE.get('ZZ');
  const s = String(input).trim();
  if (!s) return BY_CODE.get('ZZ');
  const upper = s.toUpperCase();
  if (BY_CODE.has(upper)) return BY_CODE.get(upper);
  const byGl = MARKETS.find((m) => m.gl && m.gl.toLowerCase() === s.toLowerCase());
  if (byGl) return byGl;
  const byName = MARKETS.find((m) => m.name.toLowerCase() === s.toLowerCase());
  if (byName) return byName;
  return BY_CODE.get('ZZ');
}

function all() { return MARKETS; }

function label(input) {
  return resolve(input).name;
}

module.exports = { MARKETS, all, resolve, label, BY_CODE };
