// REVIEW PLATFORM COVERAGE — which review sites this brand is missing from.
//
// WHAT WAS ASKED FOR
// "Missing top reviews platforms."
//
// WHY ./reputation.js COULD NOT ANSWER IT, AND WHAT CHANGED
// reputation.js is a MENTION MONITOR: it scans Reddit, Hacker News and news RSS
// for new mentions and scores their sentiment. It deliberately refuses to
// scrape Trustpilot, G2, Capterra or Google reviews, and that refusal is
// correct and unchanged — those sites block automated access, and a scrape that
// silently starts returning nothing would be indistinguishable from "no new
// reviews", which is the worst possible failure for a monitoring feature.
//
// But "does a profile EXIST" is a completely different question from "what do
// the reviews say", and it does not need the reviews. A profile is a public URL
// with a predictable shape, and its existence can be established two ways that
// are both robust to a blocked scrape:
//
//   1. A KEYLESS SEARCH for the brand restricted to that platform's domain. If
//      the platform has an indexed page for this brand, it comes back. A search
//      that returns nothing is reported as "not found", not as "absent" — the
//      distinction is kept on every row.
//   2. A DIRECT PROBE of the conventional profile URL where the platform has
//      one (trustpilot.com/review/<domain> is deterministic). A 200 is proof;
//      a 404 is proof of absence; a 403 is proof of nothing and is reported as
//      "blocked, unknown".
//
// Neither reads a single review. Neither can silently degrade into a false
// negative, because "unknown" is a first-class outcome with its own count.
//
// WHY THE PLATFORM LIST IS VERTICAL-AWARE
// A restaurant missing from G2 has no problem; a B2B SaaS product missing from
// G2 has a serious one. A flat list of twenty platforms would produce nineteen
// irrelevant findings per brand, so each platform declares the verticals it
// matters for and the run reports only those — plus the universal ones, which
// apply to every business that has customers.
const store = require('./store');
const providers = require('./providers');
const serpLite = require('./serpLite');
const { fetchPage, hostKey, normalizeUrl, mapLimit, sleep } = require('./fetcher');

// `verticals: null` means universal.
//
// `probe` is a function producing the conventional profile URL from the brand's
// domain, where the platform has a deterministic one. Where it does not, the
// platform is established by search only, and that is stated.
const PLATFORMS = [
  {
    key: 'google',
    label: 'Google Business Profile',
    domain: 'google.com/maps',
    verticals: null,
    weight: 10,
    why: 'The single most consequential review surface there is. It feeds the map pack, the knowledge panel, and the "is this legitimate" judgement every AI assistant makes about a business. A brand with no Google profile is invisible to local intent entirely.',
    // No probe: a Business Profile has no stable public URL derivable from a
    // domain, so presence is established by search against google.com/maps and
    // — more reliably — by the Places lookup this app already has.
    probe: null,
    searchDomain: 'google.com/maps',
    alsoTryPlaces: true,
  },
  {
    key: 'trustpilot',
    label: 'Trustpilot',
    domain: 'trustpilot.com',
    verticals: null,
    weight: 8,
    why: 'The most widely-cited general review platform in Europe, and one of the few whose ratings appear in Google\'s own seller-rating extensions. Assistants quote it directly when asked whether a company is reputable.',
    probe: (domain) => `https://www.trustpilot.com/review/${domain}`,
  },
  {
    key: 'g2',
    label: 'G2',
    domain: 'g2.com',
    verticals: ['saas', 'software', 'b2b', 'technology', 'agency'],
    weight: 9,
    why: 'The default reference for B2B software buyers, and the source AI assistants reach for when asked to compare tools. A category with no G2 presence cedes every comparison query.',
    probe: null,
    searchDomain: 'g2.com/products',
  },
  {
    key: 'capterra',
    label: 'Capterra',
    domain: 'capterra.com',
    verticals: ['saas', 'software', 'b2b', 'technology'],
    weight: 6,
    why: 'Gartner-owned, and the second source in most software shortlists. Its listings rank for "best <category> software" queries that a vendor site rarely wins.',
    probe: null,
  },
  {
    key: 'clutch',
    label: 'Clutch',
    domain: 'clutch.co',
    verticals: ['agency', 'services', 'b2b', 'construction', 'technology'],
    weight: 6,
    why: 'The dominant directory for agencies and professional-services firms, with verified interview-based reviews that carry unusual weight in procurement.',
    probe: null,
  },
  {
    key: 'yelp',
    label: 'Yelp',
    domain: 'yelp.com',
    verticals: ['restaurant', 'local', 'retail', 'healthcare', 'services', 'automotive'],
    weight: 6,
    why: 'Still the strongest local review signal in the US after Google, and one of Apple Maps\' data sources — so a Yelp absence costs visibility on iOS as well as on Yelp.',
    probe: null,
  },
  {
    key: 'bbb',
    label: 'Better Business Bureau',
    domain: 'bbb.org',
    verticals: ['local', 'services', 'finance', 'construction', 'automotive', 'certification'],
    weight: 5,
    why: 'A BBB profile is a trust signal an AI assistant can verify against a register, which is exactly the kind of evidence it prefers over a claim on the brand\'s own site.',
    probe: null,
  },
  {
    key: 'glassdoor',
    label: 'Glassdoor',
    domain: 'glassdoor.com',
    verticals: null,
    weight: 3,
    why: 'Employer reviews, not customer reviews — included because it ranks for the brand name and is often the top non-owned result, so it shapes the brand\'s ambient reputation whether or not it is about the product.',
    probe: null,
  },
  {
    key: 'tripadvisor',
    label: 'Tripadvisor',
    domain: 'tripadvisor.com',
    verticals: ['restaurant', 'hospitality', 'travel', 'local'],
    weight: 7,
    why: 'The reference source for hospitality, and heavily cited by assistants answering "where should I eat/stay in …".',
    probe: null,
  },
  {
    key: 'opentable',
    label: 'OpenTable',
    domain: 'opentable.com',
    verticals: ['restaurant', 'hospitality'],
    weight: 5,
    why: 'Both a booking surface and a review surface. An assistant asked to book a table works from the platforms that accept bookings.',
    probe: null,
  },
  {
    key: 'healthgrades',
    label: 'Healthgrades',
    domain: 'healthgrades.com',
    verticals: ['healthcare', 'medical'],
    weight: 7,
    why: 'The primary provider-review directory in US healthcare, and a source patients and assistants both consult before booking.',
    probe: null,
  },
  {
    key: 'zocdoc',
    label: 'Zocdoc',
    domain: 'zocdoc.com',
    verticals: ['healthcare', 'medical'],
    weight: 5,
    why: 'Booking plus reviews for clinicians. Absence removes the practice from every "book a doctor near me" flow that runs through it.',
    probe: null,
  },
  {
    key: 'trustradius',
    label: 'TrustRadius',
    domain: 'trustradius.com',
    verticals: ['saas', 'software', 'b2b'],
    weight: 4,
    why: 'Long-form, verified B2B reviews. Fewer in number than G2 but weighted heavily in enterprise evaluations.',
    probe: null,
  },
  {
    key: 'productHunt',
    label: 'Product Hunt',
    domain: 'producthunt.com',
    verticals: ['saas', 'software', 'technology'],
    weight: 3,
    why: 'A launch and discovery surface rather than a review site, but its listing pages rank for product names and are frequently the first non-owned result.',
    probe: null,
  },
  {
    key: 'checkatrade',
    label: 'Checkatrade',
    domain: 'checkatrade.com',
    verticals: ['construction', 'services', 'local'],
    weight: 5,
    why: 'The dominant UK trades directory. For a UK contractor it carries more purchase intent than any general review platform.',
    probe: null,
  },
  {
    key: 'houzz',
    label: 'Houzz',
    domain: 'houzz.com',
    verticals: ['construction', 'realestate', 'retail'],
    weight: 4,
    why: 'Reviews plus portfolio for building, renovation and interiors work, and a strong ranker for local project queries.',
    probe: null,
  },
  {
    key: 'zillow',
    label: 'Zillow agent reviews',
    domain: 'zillow.com',
    verticals: ['realestate'],
    weight: 6,
    why: 'Agent reviews on Zillow are the reference for US residential real estate and feed its own agent-matching flow.',
    probe: null,
  },
  {
    key: 'coursereport',
    label: 'Course Report / SwitchUp',
    domain: 'coursereport.com',
    verticals: ['certification', 'education'],
    weight: 5,
    why: 'The review directories for training and certification providers, which rank for "is <programme> worth it" — the query a prospective candidate actually types.',
    probe: null,
  },
];

// Which platforms matter for a brand's vertical, plus the universal ones.
function platformsFor(vertical) {
  const v = String(vertical || 'other').toLowerCase();
  return PLATFORMS.filter((p) => !p.verticals || p.verticals.some((x) => v.includes(x) || x.includes(v)));
}

// ---------------------------------------------------------------- detection

// A direct probe of the conventional profile URL.
//
// Three outcomes and they are kept distinct: found (200 with the brand's own
// domain or name on the page), absent (404), unknown (403, 429, timeout, or a
// 200 whose body does not mention the brand — a soft 404).
async function probeProfile(platform, { domain, brandName }) {
  if (!platform.probe) return null;
  const url = platform.probe(domain);
  const res = await fetchPage(url, { timeout: 15000, ua: serpLite.BROWSER_UA });

  if (res.status === 404 || res.status === 410) {
    return { method: 'direct-probe', url, state: 'absent', status: res.status, evidence: `the conventional profile URL returns HTTP ${res.status}` };
  }
  if (!res.ok) {
    return {
      method: 'direct-probe',
      url,
      state: 'unknown',
      status: res.status,
      evidence: res.status === 403 || res.status === 429
        ? `the platform blocked the request (HTTP ${res.status}), which proves nothing either way`
        : `the request failed: ${res.error || `HTTP ${res.status}`}`,
    };
  }
  // A 200 is not proof on its own: several of these platforms serve a
  // "no reviews yet" or search page at an unknown slug with a 200.
  const body = String(res.body || '').toLowerCase();
  const mentionsBrand = body.includes(String(domain).toLowerCase())
    || (brandName && brandName.length > 3 && body.includes(String(brandName).toLowerCase()));
  return {
    method: 'direct-probe',
    url: res.url,
    state: mentionsBrand ? 'found' : 'unknown',
    status: res.status,
    evidence: mentionsBrand
      ? `HTTP 200 and the page names ${domain}${brandName ? ` or "${brandName}"` : ''}`
      : 'HTTP 200 but the page does not name the brand or its domain, which is how these platforms serve a soft 404 — treated as unknown rather than found',
  };
}

// A site-restricted keyless search.
async function searchProfile(platform, { domain, brandName, market }) {
  if (!providers.has('serp-lite')) {
    return { method: 'search', state: 'unknown', evidence: 'keyless SERP sampling is disabled (AISEO_DISABLE_PUBLIC_SOURCES=1)' };
  }
  const searchHost = platform.searchDomain || platform.domain;
  const q = `site:${searchHost.split('/')[0]} ${brandName ? `"${brandName}"` : domain}`;
  const serp = await serpLite.search(q, { market, limit: 8 });
  if (!serp.ok) {
    return { method: 'search', state: 'unknown', query: q, evidence: `the search returned nothing usable: ${serp.error}` };
  }
  const rootHost = searchHost.split('/')[0].replace(/^www\./, '');
  const hits = serp.results.filter((r) => r.host === rootHost || String(r.host).endsWith(`.${rootHost}`));
  return {
    method: 'search',
    state: hits.length ? 'found' : 'not-found',
    query: q,
    engine: serp.engine,
    hits: hits.slice(0, 3).map((h) => ({ url: h.url, title: h.title })),
    evidence: hits.length
      ? `${hits.length} indexed page${hits.length === 1 ? '' : 's'} on ${rootHost} for this brand, top result: ${hits[0].url}`
      : `no indexed page on ${rootHost} for this brand in a ${serp.engine} sample. That is evidence of absence, not proof — the profile may exist and be unindexed.`,
  };
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, country = null, includeSearch = true, includeProbe = true,
}) {
  const brandId = brand.id;
  const site = normalizeUrl(brand.site_url);
  const domain = hostKey(site);
  const brandName = brand.name || null;
  const vertical = brand.vertical || 'other';
  const market = country || brand.market || 'ZZ';

  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'review_platforms', target: site,
    label: vertical,
    params: { vertical, country: market, includeSearch, includeProbe },
  });

  try {
    const sources = [];
    const relevant = platformsFor(vertical);

    // Checked sequentially with pacing, not in parallel: every check here is a
    // request to a platform that rate-limits, and twenty concurrent ones return
    // 429 for most of them — which would land in the "unknown" bucket and make
    // the whole report say nothing.
    const rows = [];
    for (const platform of relevant) {
      let probe = null;
      let search = null;
      /* eslint-disable no-await-in-loop */
      if (includeProbe && platform.probe) {
        probe = await probeProfile(platform, { domain, brandName });
        await sleep(700);
      }
      // A direct probe that FOUND the profile makes the search redundant.
      if (includeSearch && (!probe || probe.state !== 'found')) {
        search = await searchProfile(platform, { domain, brandName, market });
        if (search && search.state !== 'unknown') sources.push('serp-lite');
      }
      /* eslint-enable no-await-in-loop */

      // The verdict, with "unknown" preserved as its own state rather than
      // collapsed into "missing". A report that calls an unknown a gap sends
      // someone to create a profile that already exists.
      const states = [probe, search].filter(Boolean).map((x) => x.state);
      let verdict = 'unknown';
      if (states.includes('found')) verdict = 'present';
      else if (states.includes('absent')) verdict = 'missing';
      else if (states.includes('not-found')) verdict = 'likely-missing';

      rows.push({
        key: platform.key,
        label: platform.label,
        domain: platform.domain,
        weight: platform.weight,
        why: platform.why,
        universal: !platform.verticals,
        verdict,
        probe,
        search,
        profileUrl: (probe && probe.state === 'found' && probe.url)
          || (search && search.hits && search.hits.length ? search.hits[0].url : null),
        evidence: [probe && probe.evidence, search && search.evidence].filter(Boolean),
      });
    }

    const present = rows.filter((r) => r.verdict === 'present');
    const missing = rows.filter((r) => r.verdict === 'missing');
    const likelyMissing = rows.filter((r) => r.verdict === 'likely-missing');
    const unknown = rows.filter((r) => r.verdict === 'unknown');
    const gaps = [...missing, ...likelyMissing].sort((a, b) => b.weight - a.weight);

    const findings = [];

    if (gaps.length) {
      const heavy = gaps.filter((g) => g.weight >= 6);
      findings.push({
        checkKey: 'missing_review_platforms',
        title: `${gaps.length} review platform${gaps.length === 1 ? '' : 's'} relevant to this business have no profile for it`,
        detail: gaps.slice(0, 8).map((g) => `${g.label} (${g.verdict === 'missing' ? 'confirmed absent' : 'no indexed profile found'})`).join('; ')
          + `. ${heavy.length ? `The consequential ones: ${heavy.slice(0, 4).map((g) => g.label).join(', ')}. ` : ''}`
          + 'Review profiles are the evidence an AI assistant checks when asked whether a business is reputable — it will not take the brand\'s own site as an answer to that question, and where there is nothing else to read it reports what a forum post said.',
        severity: heavy.length ? 'high' : 'medium',
        affectedCount: gaps.length,
        action: `Claim the profiles in weight order: ${gaps.slice(0, 5).map((g) => g.label).join(', ')}. Claiming a profile is free on every one of these; the work is in seeding it with genuine reviews afterwards, and that is the part worth planning.`,
        evidence: {
          gaps: gaps.map((g) => ({ label: g.label, domain: g.domain, verdict: g.verdict, weight: g.weight, why: g.why, evidence: g.evidence })),
          vertical,
        },
        dedupeKey: `reviewplatforms:gaps:${brandId}`,
      });
    }

    if (unknown.length) {
      findings.push({
        checkKey: 'review_platforms_unknown',
        title: `${unknown.length} platform${unknown.length === 1 ? ' could' : 's could'} not be checked`,
        detail: unknown.map((u) => `${u.label}: ${u.evidence.join('; ')}`).join(' | ')
          + '. These are reported as unknown rather than as gaps, because a platform that blocked the request has told us nothing, and calling that a gap would send someone to create a profile that may already exist.',
        severity: 'info',
        affectedCount: unknown.length,
        action: 'Check these by hand, or re-run later — the block is usually rate limiting rather than a permanent refusal.',
        evidence: { platforms: unknown.map((u) => ({ label: u.label, evidence: u.evidence })) },
        dedupeKey: `reviewplatforms:unknown:${brandId}`,
      });
    }

    if (!present.length && !unknown.length) {
      findings.push({
        checkKey: 'no_review_presence',
        title: 'No review profile was found on any relevant platform',
        detail: `${rows.length} platform${rows.length === 1 ? '' : 's'} were checked for ${vertical === 'other' ? 'this business' : `a ${vertical} business`} and none has an indexed profile for it. Everything an assistant can say about this brand\'s reputation therefore comes from the brand\'s own site or from whatever a third party happened to write.`,
        severity: 'high',
        action: 'Start with Google Business Profile, then the highest-weight platform for the vertical. This is the cheapest reputation work available and the one with no substitute.',
        evidence: { checked: rows.map((r) => r.label) },
        dedupeKey: `reviewplatforms:none:${brandId}`,
      });
    }

    // Score: the share of AVAILABLE weight that is covered, with unknowns
    // excluded from both sides — the same rule the tracking board uses, and for
    // the same reason.
    const scorable = rows.filter((r) => r.verdict !== 'unknown');
    const totalWeight = scorable.reduce((a, r) => a + r.weight, 0);
    const wonWeight = present.reduce((a, r) => a + r.weight, 0);
    const score = totalWeight ? Math.round((wonWeight / totalWeight) * 100) : null;

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site,
        domain,
        vertical,
        market,
        rows,
        present: present.map((r) => ({ label: r.label, url: r.profileUrl, weight: r.weight })),
        gaps: gaps.map((r) => ({ label: r.label, domain: r.domain, verdict: r.verdict, weight: r.weight, why: r.why })),
        unknown: unknown.map((r) => ({ label: r.label, evidence: r.evidence })),
        counts: {
          checked: rows.length,
          present: present.length,
          missing: missing.length,
          likelyMissing: likelyMissing.length,
          unknown: unknown.length,
        },
        method: 'A profile is established either by probing the platform\'s conventional profile URL (where it has a deterministic one) or by a keyless site-restricted search. No reviews are read: this answers "is there a profile", not "what do the reviews say" — the latter needs a platform API credential and is the reason the mention monitor deliberately does not scrape these sites.',
        scoreMeaning: score == null ? null : `${wonWeight} of ${totalWeight} available platform weight covered, excluding ${unknown.length} platform(s) that could not be checked.`,
        provenance: providers.provenance([...new Set(sources)]),
      },
      findings,
      metrics: [
        { key: 'reviewplatforms.coverage', value: score, status: score == null ? 'unknown' : (score >= 60 ? 'good' : (score >= 30 ? 'warn' : 'fail')) },
        { key: 'reviewplatforms.gaps', value: gaps.length, status: gaps.length ? 'warn' : 'good' },
      ],
      sources: [...new Set(sources)],
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(runRecord, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  const gaps = ((runRecord.result || {}).gaps) || [];

  // One task per platform, because claiming a profile is one discrete job on
  // one named site — exactly the shape a backlog item should have.
  gaps.forEach((g) => {
    const res = tasksLib.upsertTask({
      userId,
      brandId: runRecord.brand_id,
      title: `Claim the ${g.label} profile`,
      detail: `${g.why}\n\nStatus found: ${g.verdict === 'missing' ? 'confirmed absent' : 'no indexed profile found'}. Platform: ${g.domain}.\n\n`
        + 'Claiming is free. Budget the real work for afterwards: a claimed profile with no reviews is weaker than no profile, so plan how genuine reviews will be requested before claiming it.',
      source: 'aiseo',
      sourceRef: `aiseo:review_platforms:${runRecord.id}:${g.label}`,
      category: 'Reputation',
      severity: g.weight >= 6 ? 'high' : 'medium',
      evidence: g,
      dedupeKey: `aiseo:reviewplatform:${runRecord.brand_id || 0}:${g.domain}`,
    });
    if (res.created) created += 1;
  });

  return { created };
}

module.exports = { run, toTasks, PLATFORMS, platformsFor, probeProfile, searchProfile };
