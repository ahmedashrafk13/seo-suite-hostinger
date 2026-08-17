// Place-name recognition for keyword clustering.
//
// WHY THIS EXISTS
// Clustering treated place names as ordinary content tokens, so the
// shared-head rule happily merged "web development services usa",
// "web development services atlanta" and "custom web development chicago"
// into one cluster — they all share the head "web development". The content
// brief then picked the highest-impression member as the title and produced
// "Web Design and Web Development Services Atlanta" as the recommended title
// for a NATIONAL keyword cluster, and listed "Atlanta Web Development" as a
// heading on a page about nothing of the sort.
//
// Geographic modifiers are not ordinary modifiers. "plumber austin" and
// "plumber dallas" are different pages targeting different SERPs, and no
// amount of lexical similarity changes that. So clustering partitions on the
// place token set: keywords carrying different places never merge, and
// keywords carrying no place form their own (national) cluster.
//
// SCOPE AND LIMITS — stated plainly rather than implied:
//   - This is a US-and-major-markets list, matching where this app is used.
//     It is NOT a gazetteer. A small town not on this list is invisible to it
//     and its keywords will cluster on lexical similarity as before, which is
//     the same behaviour as before this file existed — a miss degrades to the
//     old behaviour, it does not break anything.
//   - The brand's own configured `market` is merged in at call time, so a
//     brand operating in a town not listed here still gets correct handling
//     once that field is filled in.
//   - Ambiguous words that are both places and common nouns ("mobile",
//     "phoenix", "reading", "orange", "jackson") are handled by AMBIGUOUS
//     below: they only count as places when the keyword carries another
//     local signal, so "mobile app development" is not read as Mobile,
//     Alabama.

const US_STATES = `
alabama alaska arizona arkansas california colorado connecticut delaware
florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana
maine maryland massachusetts michigan minnesota mississippi missouri montana
nebraska nevada hampshire jersey mexico york carolina dakota ohio oklahoma
oregon pennsylvania rhode tennessee texas utah vermont virginia washington
wisconsin wyoming
`.trim().split(/\s+/);

const US_STATE_ABBR = `
al ak az ar ca co ct de fl ga hi id il in ia ks ky la md ma mi mn ms mo mt
ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc
`.trim().split(/\s+/);

// Major US cities plus common metro shorthands.
const US_CITIES = `
atlanta austin baltimore boston charlotte chicago cincinnati cleveland
columbus dallas denver detroit fresno houston indianapolis jacksonville
kansas lasvegas vegas losangeles louisville memphis miami milwaukee
minneapolis nashville newark neworleans newyork nyc oakland oklahoma omaha
orlando philadelphia pittsburgh portland raleigh sacramento saltlake
sanantonio sandiego sanfrancisco sanjose seattle stlouis tampa tucson tulsa
virginiabeach wichita brooklyn bronx queens manhattan scottsdale mesa
arlington aurora anaheim bakersfield boise buffalo chandler chesapeake
colorado corpus durham elpaso fortworth fremont garland gilbert glendale
greensboro henderson hialeah honolulu irvine irving laredo lexington lincoln
longbeach lubbock madison norfolk plano reno richmond riverside sanbernardino
santaana stockton toledo winston chula fontana modesto moreno oxnard
huntington montgomery amarillo grandrapids shreveport tacoma
`.trim().split(/\s+/);

// Non-US markets this app plausibly touches.
const COUNTRIES = `
usa america american uk britain england scotland wales ireland canada
canadian australia australian newzealand india pakistan uae dubai abudhabi
qatar saudi singapore malaysia germany france spain italy netherlands belgium
sweden norway denmark poland portugal mexico brazil argentina japan china
southafrica nigeria kenya egypt turkey philippines indonesia vietnam thailand
`.trim().split(/\s+/);

const INTL_CITIES = `
london manchester birmingham leeds liverpool glasgow edinburgh bristol
sheffield cardiff belfast toronto vancouver montreal calgary ottawa sydney
melbourne brisbane perth adelaide auckland wellington mumbai delhi bangalore
hyderabad chennai kolkata pune karachi lahore islamabad berlin munich hamburg
frankfurt paris lyon marseille madrid barcelona rome milan amsterdam
rotterdam brussels stockholm oslo copenhagen warsaw lisbon
`.trim().split(/\s+/);

// Words that are places AND ordinary vocabulary. Only treated as places when
// the keyword carries a second local signal, so "mobile app development" and
// "reading time" are not misread.
const AMBIGUOUS = new Set(`
  mobile phoenix reading orange jackson columbia salem springfield charlotte
  augusta savannah aurora arlington richmond hollywood pasadena berkeley
  cambridge oxford bath york lancaster manchester birmingham
`.trim().split(/\s+/));

const UNAMBIGUOUS_PLACES = new Set([
  ...US_STATES, ...US_CITIES, ...COUNTRIES, ...INTL_CITIES,
].filter((p) => !AMBIGUOUS.has(p)));

// State abbreviations are only recognised as a whole token, and only when
// they are not a common English word — "in", "or", "me", "la", "de", "hi",
// "ok", "pa", "co" would otherwise fire constantly.
const SAFE_STATE_ABBR = new Set(
  US_STATE_ABBR.filter((a) => !['in', 'or', 'me', 'la', 'hi', 'ok', 'pa', 'co', 'de', 'id', 'ma', 'mt', 'ne', 'oh', 'ar', 'al'].includes(a)),
);

// A second signal that a keyword is locally scoped, used to disambiguate the
// AMBIGUOUS list.
const LOCAL_HINT = /\b(near me|nearby|in|near|local|city|downtown|area|county|state)\b/;

// Extracts the set of place tokens in a keyword. `extraPlaces` lets a brand's
// own configured market participate without being hardcoded here.
function placesIn(keyword, extraPlaces = null) {
  const kw = String(keyword || '').toLowerCase();
  const found = new Set();
  if (!kw) return found;

  const tokens = kw.split(/[^a-z0-9]+/).filter(Boolean);
  const hasLocalHint = LOCAL_HINT.test(kw);

  tokens.forEach((t) => {
    if (UNAMBIGUOUS_PLACES.has(t)) { found.add(t); return; }
    if (SAFE_STATE_ABBR.has(t)) { found.add(t); return; }
    if (AMBIGUOUS.has(t) && hasLocalHint) found.add(t);
  });

  // Multi-word places written as separate tokens ("new york", "los angeles",
  // "san diego", "salt lake city").
  const squashed = tokens.join('');
  ['newyork', 'losangeles', 'sandiego', 'sanfrancisco', 'sanantonio', 'sanjose',
    'lasvegas', 'saltlake', 'neworleans', 'stlouis', 'fortworth', 'longbeach',
    'virginiabeach', 'grandrapids', 'newjersey', 'newmexico', 'northcarolina',
    'southcarolina', 'newhampshire', 'rhodeisland', 'westvirginia'].forEach((p) => {
    if (squashed.includes(p)) found.add(p);
  });

  if (extraPlaces && extraPlaces.size) {
    extraPlaces.forEach((p) => {
      const clean = String(p || '').toLowerCase().trim();
      if (clean.length > 2 && kw.includes(clean)) found.add(clean.replace(/\s+/g, ''));
    });
  }

  return found;
}

// Canonical, order-independent key for a keyword's geography.
// '' means national/unscoped.
function placeKey(keyword, extraPlaces = null) {
  return [...placesIn(keyword, extraPlaces)].sort().join('+');
}

function hasPlace(keyword, extraPlaces = null) {
  return placesIn(keyword, extraPlaces).size > 0;
}

// Words that follow "in"/"near" but are not places — so a keyword like
// "web design in 2026" or "links in bulk" is not reported as an unknown town.
const NOT_A_PLACE_AFTER_PREPOSITION = new Set(`
  stock bulk cart advance general detail details progress person private
  public minutes hours days weeks months years demand review reviews depth
  summary short brief full house mind time order place house terms house
  practice general google search html css javascript wordpress shopify
`.trim().split(/\s+/));

// Surfaces place-shaped words this module does NOT recognise.
//
// The gazetteer is a fixed list, so a town that is not on it is simply
// invisible: its keywords fall back to lexical clustering and nobody is told.
// That silence is the real problem — a miss is acceptable, an *unreported*
// miss is not. Callers report these so someone can see "you have keywords
// about Boise, and clustering did not treat it as a location" and add it to
// the brand's market, rather than quietly getting a worse cluster.
function unrecognisedPlaceCandidates(keywords, extraPlaces = null) {
  const counts = new Map();
  (keywords || []).forEach((kw) => {
    const s = String(kw || '').toLowerCase();
    const m = s.match(/\b(?:in|near)\s+([a-z][a-z.'-]{2,})\b/);
    if (!m) return;
    const word = m[1];
    if (NOT_A_PLACE_AFTER_PREPOSITION.has(word)) return;
    if (/^\d/.test(word)) return;
    // Already known — nothing to report.
    if (placesIn(word, extraPlaces).size) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, keywordCount: count }));
}

module.exports = {
  placesIn, placeKey, hasPlace, unrecognisedPlaceCandidates,
  UNAMBIGUOUS_PLACES, AMBIGUOUS, SAFE_STATE_ABBR,
};
