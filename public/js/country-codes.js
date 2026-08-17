// Maps GSC's ISO-3166-1 alpha-3 country codes and GA4's full English country
// names to the alpha-2 codes jsVectorMap's "world" map uses as region ids.
// Deliberately generous rather than exhaustive — anything not covered here
// still appears in the data table, it just won't shade on the map.
(function (global) {
  var ALPHA3_TO_ALPHA2 = {
    afg: 'af', alb: 'al', dza: 'dz', and: 'ad', ago: 'ao', arg: 'ar', arm: 'am',
    aus: 'au', aut: 'at', aze: 'az', bhs: 'bs', bhr: 'bh', bgd: 'bd', blr: 'by',
    bel: 'be', blz: 'bz', ben: 'bj', btn: 'bt', bol: 'bo', bih: 'ba', bwa: 'bw',
    bra: 'br', brn: 'bn', bgr: 'bg', bfa: 'bf', bdi: 'bi', khm: 'kh', cmr: 'cm',
    can: 'ca', caf: 'cf', tcd: 'td', chl: 'cl', chn: 'cn', col: 'co', com: 'km',
    cog: 'cg', cod: 'cd', cri: 'cr', civ: 'ci', hrv: 'hr', cub: 'cu', cyp: 'cy',
    cze: 'cz', dnk: 'dk', dji: 'dj', dma: 'dm', dom: 'do', ecu: 'ec', egy: 'eg',
    slv: 'sv', gnq: 'gq', eri: 'er', est: 'ee', swz: 'sz', eth: 'et', fji: 'fj',
    fin: 'fi', fra: 'fr', gab: 'ga', gmb: 'gm', geo: 'ge', deu: 'de', gha: 'gh',
    grc: 'gr', grd: 'gd', gtm: 'gt', gin: 'gn', gnb: 'gw', guy: 'gy', hti: 'ht',
    hnd: 'hn', hkg: 'hk', hun: 'hu', isl: 'is', ind: 'in', idn: 'id', irn: 'ir',
    irq: 'iq', irl: 'ie', isr: 'il', ita: 'it', jam: 'jm', jpn: 'jp', jor: 'jo',
    kaz: 'kz', ken: 'ke', kir: 'ki', prk: 'kp', kor: 'kr', kwt: 'kw', kgz: 'kg',
    lao: 'la', lva: 'lv', lbn: 'lb', lso: 'ls', lbr: 'lr', lby: 'ly', lie: 'li',
    ltu: 'lt', lux: 'lu', mac: 'mo', mkd: 'mk', mdg: 'mg', mwi: 'mw', mys: 'my',
    mdv: 'mv', mli: 'ml', mlt: 'mt', mhl: 'mh', mrt: 'mr', mus: 'mu', mex: 'mx',
    fsm: 'fm', mda: 'md', mco: 'mc', mng: 'mn', mne: 'me', mar: 'ma', moz: 'mz',
    mmr: 'mm', nam: 'na', npl: 'np', nld: 'nl', nzl: 'nz', nic: 'ni', ner: 'ne',
    nga: 'ng', nor: 'no', omn: 'om', pak: 'pk', plw: 'pw', pse: 'ps', pan: 'pa',
    png: 'pg', pry: 'py', per: 'pe', phl: 'ph', pol: 'pl', prt: 'pt', qat: 'qa',
    rou: 'ro', rus: 'ru', rwa: 'rw', kna: 'kn', lca: 'lc', vct: 'vc', wsm: 'ws',
    smr: 'sm', stp: 'st', sau: 'sa', sen: 'sn', srb: 'rs', syc: 'sc', sle: 'sl',
    sgp: 'sg', svk: 'sk', svn: 'si', slb: 'sb', som: 'so', zaf: 'za', ssd: 'ss',
    esp: 'es', lka: 'lk', sdn: 'sd', sur: 'sr', swe: 'se', che: 'ch', syr: 'sy',
    twn: 'tw', tjk: 'tj', tza: 'tz', tha: 'th', tls: 'tl', tgo: 'tg', ton: 'to',
    tto: 'tt', tun: 'tn', tur: 'tr', tkm: 'tm', tuv: 'tv', uga: 'ug', ukr: 'ua',
    are: 'ae', gbr: 'gb', usa: 'us', ury: 'uy', uzb: 'uz', vut: 'vu', vat: 'va',
    ven: 've', vnm: 'vn', yem: 'ye', zmb: 'zm', zwe: 'zw',
  };

  var NAME_TO_ALPHA2 = {
    afghanistan: 'af', albania: 'al', algeria: 'dz', andorra: 'ad', angola: 'ao',
    argentina: 'ar', armenia: 'am', australia: 'au', austria: 'at', azerbaijan: 'az',
    bahamas: 'bs', bahrain: 'bh', bangladesh: 'bd', belarus: 'by', belgium: 'be',
    belize: 'bz', benin: 'bj', bhutan: 'bt', bolivia: 'bo', 'bosnia & herzegovina': 'ba',
    'bosnia and herzegovina': 'ba', botswana: 'bw', brazil: 'br', brunei: 'bn',
    bulgaria: 'bg', 'burkina faso': 'bf', burundi: 'bi', cambodia: 'kh', cameroon: 'cm',
    canada: 'ca', 'cape verde': 'cv', 'central african republic': 'cf', chad: 'td',
    chile: 'cl', china: 'cn', colombia: 'co', comoros: 'km',
    'congo - brazzaville': 'cg', congo: 'cg', 'congo - kinshasa': 'cd',
    'democratic republic of congo': 'cd', 'costa rica': 'cr', 'ivory coast': 'ci',
    "cote d'ivoire": 'ci', croatia: 'hr', cuba: 'cu', cyprus: 'cy', czechia: 'cz',
    'czech republic': 'cz', denmark: 'dk', djibouti: 'dj', dominica: 'dm',
    'dominican republic': 'do', ecuador: 'ec', egypt: 'eg', 'el salvador': 'sv',
    'equatorial guinea': 'gq', eritrea: 'er', estonia: 'ee', eswatini: 'sz',
    swaziland: 'sz', ethiopia: 'et', fiji: 'fj', finland: 'fi', france: 'fr',
    gabon: 'ga', gambia: 'gm', georgia: 'ge', germany: 'de', ghana: 'gh',
    greece: 'gr', grenada: 'gd', guatemala: 'gt', guinea: 'gn', 'guinea-bissau': 'gw',
    guyana: 'gy', haiti: 'ht', honduras: 'hn', 'hong kong': 'hk', hungary: 'hu',
    iceland: 'is', india: 'in', indonesia: 'id', iran: 'ir', iraq: 'iq',
    ireland: 'ie', israel: 'il', italy: 'it', jamaica: 'jm', japan: 'jp',
    jordan: 'jo', kazakhstan: 'kz', kenya: 'ke', kiribati: 'ki', 'north korea': 'kp',
    'south korea': 'kr', kuwait: 'kw', kyrgyzstan: 'kg', laos: 'la', latvia: 'lv',
    lebanon: 'lb', lesotho: 'ls', liberia: 'lr', libya: 'ly', liechtenstein: 'li',
    lithuania: 'lt', luxembourg: 'lu', macao: 'mo', macau: 'mo',
    macedonia: 'mk', 'north macedonia': 'mk', madagascar: 'mg', malawi: 'mw',
    malaysia: 'my', maldives: 'mv', mali: 'ml', malta: 'mt',
    'marshall islands': 'mh', mauritania: 'mr', mauritius: 'mu', mexico: 'mx',
    micronesia: 'fm', moldova: 'md', monaco: 'mc', mongolia: 'mn', montenegro: 'me',
    morocco: 'ma', mozambique: 'mz', 'myanmar (burma)': 'mm', myanmar: 'mm',
    namibia: 'na', nepal: 'np', netherlands: 'nl', 'new zealand': 'nz',
    nicaragua: 'ni', niger: 'ne', nigeria: 'ng', norway: 'no', oman: 'om',
    pakistan: 'pk', palau: 'pw', palestine: 'ps', panama: 'pa',
    'papua new guinea': 'pg', paraguay: 'py', peru: 'pe', philippines: 'ph',
    poland: 'pl', portugal: 'pt', qatar: 'qa', romania: 'ro', russia: 'ru',
    'russian federation': 'ru', rwanda: 'rw', 'saint kitts & nevis': 'kn',
    'saint lucia': 'lc', 'st. lucia': 'lc', 'saint vincent & the grenadines': 'vc',
    samoa: 'ws', 'san marino': 'sm', 'sao tome & principe': 'st',
    'saudi arabia': 'sa', senegal: 'sn', serbia: 'rs', seychelles: 'sc',
    'sierra leone': 'sl', singapore: 'sg', slovakia: 'sk', slovenia: 'si',
    'solomon islands': 'sb', somalia: 'so', 'south africa': 'za', 'south sudan': 'ss',
    spain: 'es', 'sri lanka': 'lk', sudan: 'sd', suriname: 'sr', sweden: 'se',
    switzerland: 'ch', syria: 'sy', taiwan: 'tw', tajikistan: 'tj', tanzania: 'tz',
    thailand: 'th', 'timor-leste': 'tl', togo: 'tg', tonga: 'to',
    'trinidad & tobago': 'tt', 'trinidad and tobago': 'tt', tunisia: 'tn',
    turkey: 'tr', turkmenistan: 'tm', tuvalu: 'tv', uganda: 'ug', ukraine: 'ua',
    'united arab emirates': 'ae', 'united kingdom': 'gb', 'united states': 'us',
    'united states of america': 'us', uruguay: 'uy', uzbekistan: 'uz', vanuatu: 'vu',
    'vatican city': 'va', venezuela: 've', vietnam: 'vn', yemen: 'ye',
    zambia: 'zm', zimbabwe: 'zw', '(not set)': null,
  };

  function iso2FromAlpha3(code) {
    if (!code) return null;
    return ALPHA3_TO_ALPHA2[String(code).toLowerCase()] || null;
  }

  function iso2FromName(name) {
    if (!name) return null;
    var key = String(name).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAME_TO_ALPHA2, key) ? NAME_TO_ALPHA2[key] : null;
  }

  global.CountryCodes = { iso2FromAlpha3: iso2FromAlpha3, iso2FromName: iso2FromName };
})(window);
