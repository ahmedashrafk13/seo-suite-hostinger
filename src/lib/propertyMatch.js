// Pairing Google properties into brands.
//
// An agency's Search Console and GA4 accounts are two separate inventories
// that nobody keeps in sync: GSC is keyed by URL ("https://www.example.com/"
// or "sc-domain:example.com") while GA4 is keyed by a numeric id with a
// human-typed display name ("Example Ltd", "Website"). Nothing links them, so
// the pairing has to be inferred — and where the inference is weak, the UI has
// to say so rather than quietly guess.
//
// Everything here is pure, so the matching can be tested without API calls.

// "https://www.example.co.uk/shop" and "sc-domain:example.co.uk" both reduce
// to "example.co.uk".
function hostOf(gscProperty) {
  const raw = String(gscProperty || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('sc-domain:')) {
    return raw.slice('sc-domain:'.length).toLowerCase().replace(/^www\./, '');
  }
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

// The distinctive part of a host: "novellapublishers.com" -> "novellapublishers".
// Multi-part public suffixes (.co.uk, .com.au) would otherwise leave "co".
const MULTI_PART_TLDS = new Set(['co.uk', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp', 'co.in', 'com.mx']);
function rootLabel(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? (parts[parts.length - 3] || '') : parts[parts.length - 2];
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A GA4 property is a candidate for a site when its display name reduces to
// the site's root label, or contains it (or vice versa). "Novella Publishers"
// -> "novellapublishers" matches novellapublishers.com. Generic names like
// "Website" match nothing, which is the correct outcome — better unmatched
// than wrongly attached to a client's data.
function scoreGa4Match(host, ga4Name) {
  const root = slug(rootLabel(host));
  const name = slug(ga4Name);
  if (!root || !name) return 0;
  if (name === root) return 100;
  if (name.includes(root)) return 80;
  if (root.includes(name) && name.length >= 5) return 60;
  return 0;
}

function bestGa4For(host, ga4Properties) {
  let best = null;
  ga4Properties.forEach((p) => {
    const score = scoreGa4Match(host, p.name);
    if (score > 0 && (!best || score > best.score)) best = { ...p, score };
  });
  return best;
}

// Prefers a URL-prefix property over a domain property when Google exposes
// both for the same host: the URL form is what site_url should be, and both
// report the same data.
function preferredProperty(candidates) {
  const urlForm = candidates.find((c) => !String(c.siteUrl).toLowerCase().startsWith('sc-domain:'));
  return urlForm || candidates[0];
}

// Builds one proposed brand per distinct host across every GSC property,
// annotated with what already exists so the UI can show "already added"
// instead of offering a duplicate.
function proposeBrands({ gscSites = [], ga4Properties = [], existingBrands = [] }) {
  const byHost = new Map();
  gscSites.forEach((s) => {
    // Restricted permission levels cannot read Search Analytics, so importing
    // them would create a brand that can never sync.
    if (s.permissionLevel === 'siteUnverifiedUser') return;
    const host = hostOf(s.siteUrl);
    if (!host) return;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(s);
  });

  const existingByHost = new Map();
  existingBrands.forEach((b) => {
    [b.site_url, b.gsc_property].filter(Boolean).forEach((v) => {
      const h = hostOf(v);
      if (h) existingByHost.set(h, b);
    });
  });
  const usedGa4 = new Set(existingBrands.map((b) => b.ga4_property_id).filter(Boolean));

  return [...byHost.entries()].map(([host, candidates]) => {
    const chosen = preferredProperty(candidates);
    const existing = existingByHost.get(host) || null;
    const ga4 = bestGa4For(host, ga4Properties);
    const label = rootLabel(host);
    return {
      host,
      gscProperty: chosen.siteUrl,
      permissionLevel: chosen.permissionLevel,
      alternateProperties: candidates.filter((c) => c.siteUrl !== chosen.siteUrl).map((c) => c.siteUrl),
      siteUrl: String(chosen.siteUrl).toLowerCase().startsWith('sc-domain:')
        ? `https://${host}/`
        : chosen.siteUrl,
      // A confidently matched GA4 property carries a human-written name
      // ("Novella Publishers"), which beats title-casing a domain label
      // ("Novellapublishers").
      suggestedName: (ga4 && ga4.score >= 80 && ga4.name)
        ? ga4.name
        : (label ? label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : host),
      ga4: ga4 ? { id: ga4.id, name: ga4.name, account: ga4.account, score: ga4.score } : null,
      ga4Ambiguous: Boolean(ga4 && ga4.score < 80),
      ga4AlreadyUsed: Boolean(ga4 && usedGa4.has(ga4.id)),
      existing,
    };
  }).sort((a, b) => {
    // Not-yet-added first: that is the list the user came here to act on.
    if (Boolean(a.existing) !== Boolean(b.existing)) return a.existing ? 1 : -1;
    return a.host.localeCompare(b.host);
  });
}

module.exports = { hostOf, rootLabel, slug, scoreGa4Match, bestGa4For, proposeBrands };
