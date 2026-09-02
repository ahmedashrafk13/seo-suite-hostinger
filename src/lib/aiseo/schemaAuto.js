// 3. SCHEMA AND STRUCTURED DATA AUTOMATION
//
// Three jobs: read what structured data a page already has and validate it,
// generate what is missing, and maintain the brand's canonical-facts hub —
// llms.txt plus an Organization block — so the answer to "what is this
// company" is written down once and served identically everywhere.
//
// WHY VALIDATION IS LOCAL AND NOT A CALL TO GOOGLE
// Google's Rich Results Test has no public API, and the Schema Markup
// Validator has no documented one either. Scraping either would give a result
// that breaks silently on a UI change. So the required/recommended property
// tables below are transcribed from Google's own structured-data
// documentation, per feature type, and the check states which requirement it
// is applying. That is verifiable and stable; a scrape is neither.
//
// The distinction the tables preserve is the one that matters in practice:
// Google separates properties REQUIRED for rich-result eligibility from those
// merely RECOMMENDED. A missing required property means the rich result will
// not appear at all — a hard failure. A missing recommended one is a
// competitive disadvantage. Collapsing them into "errors" is how a report ends
// up demanding work that changes nothing.
const db = require('../../db');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const { schemaTypesOf } = require('./onpage');
const pageTypeLib = require('./pageType');
const schemaBuilder = require('./schemaBuilder');
const {
  fetchPage, parseDocument, fetchLlmsTxt, fetchRobots, fetchSitemapUrls, normalizeUrl,
} = require('./fetcher');

// Requirements per type, from Google's structured-data documentation.
// `required` — absence means no rich result.
// `recommended` — absence means a weaker one.
// `oneOf` — at least one of the listed properties must be present.
const TYPE_RULES = {
  Article: {
    label: 'Article / NewsArticle / BlogPosting',
    aliases: ['NewsArticle', 'BlogPosting', 'TechArticle', 'Report'],
    required: ['headline'],
    recommended: ['image', 'datePublished', 'dateModified', 'author', 'publisher'],
    notes: 'headline should stay under 110 characters; Google truncates beyond that. author must be a Person or Organization object, not a bare string, to be usable.',
  },
  FAQPage: {
    label: 'FAQPage',
    required: ['mainEntity'],
    recommended: [],
    notes: 'Every question must be VISIBLE on the page. Marking up questions a user cannot see is a policy violation, and FAQ rich results are now shown only for authoritative government and health sites — the markup is still read by AI answer engines, which is the reason to keep it.',
    validate(node) {
      const problems = [];
      const entities = Array.isArray(node.mainEntity) ? node.mainEntity : (node.mainEntity ? [node.mainEntity] : []);
      if (!entities.length) problems.push({ severity: 'error', message: 'mainEntity is empty — no questions declared.' });
      entities.forEach((q, i) => {
        if (!q || String(q['@type'] || '') !== 'Question') problems.push({ severity: 'error', message: `mainEntity[${i}] is not a Question.` });
        else {
          if (!q.name) problems.push({ severity: 'error', message: `Question ${i + 1} has no name (the question text).` });
          const answer = q.acceptedAnswer;
          if (!answer || !answer.text) problems.push({ severity: 'error', message: `Question ${i + 1} has no acceptedAnswer.text.` });
        }
      });
      return problems;
    },
  },
  HowTo: {
    label: 'HowTo',
    required: ['name', 'step'],
    recommended: ['image', 'totalTime', 'supply', 'tool', 'estimatedCost'],
    notes: 'Every step must correspond to visible content. HowTo rich results were retired from Google Search in 2023; the markup remains valuable for AI answer engines and for Assistant surfaces.',
    validate(node) {
      const problems = [];
      const steps = Array.isArray(node.step) ? node.step : (node.step ? [node.step] : []);
      if (steps.length < 2) problems.push({ severity: 'warning', message: `Only ${steps.length} step declared — a HowTo with fewer than two steps is not a procedure.` });
      steps.forEach((s, i) => {
        if (!s) return;
        if (!s.text && !s.itemListElement) problems.push({ severity: 'error', message: `Step ${i + 1} has neither text nor itemListElement.` });
      });
      return problems;
    },
  },
  Product: {
    label: 'Product',
    required: ['name'],
    oneOf: [['offers', 'review', 'aggregateRating']],
    recommended: ['image', 'description', 'sku', 'brand', 'offers'],
    notes: 'A Product with no offers, review or aggregateRating is ineligible for a product rich result. aggregateRating must reflect ratings genuinely collected and displayed on the page — inventing one is the single most commonly penalised structured-data abuse.',
    validate(node) {
      const problems = [];
      if (node.offers) {
        const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
        offers.forEach((o, i) => {
          if (!o) return;
          if (o.price == null && o.priceSpecification == null) problems.push({ severity: 'error', message: `offers[${i}] has no price or priceSpecification.` });
          if (!o.priceCurrency && o.price != null) problems.push({ severity: 'error', message: `offers[${i}] has a price but no priceCurrency.` });
          if (!o.availability) problems.push({ severity: 'warning', message: `offers[${i}] has no availability.` });
        });
      }
      if (node.aggregateRating) {
        const r = node.aggregateRating;
        if (r.ratingValue == null) problems.push({ severity: 'error', message: 'aggregateRating has no ratingValue.' });
        if (r.reviewCount == null && r.ratingCount == null) problems.push({ severity: 'error', message: 'aggregateRating has neither reviewCount nor ratingCount.' });
      }
      return problems;
    },
  },
  Organization: {
    label: 'Organization',
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs', 'contactPoint', 'description', 'address'],
    notes: 'This is the block that feeds the knowledge panel and gives AI engines a canonical identity for the brand. sameAs pointing at the brand\'s real profiles is the strongest entity-disambiguation signal available.',
  },
  LocalBusiness: {
    label: 'LocalBusiness',
    aliases: ['Store', 'ProfessionalService', 'MedicalBusiness', 'Restaurant', 'RealEstateAgent', 'FinancialService', 'EducationalOrganization'],
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHoursSpecification', 'geo', 'priceRange', 'url', 'image'],
    notes: 'address must be a PostalAddress object. A string address is accepted by the validator but is far weaker for local matching.',
    validate(node) {
      const problems = [];
      if (typeof node.address === 'string') problems.push({ severity: 'warning', message: 'address is a plain string — use a PostalAddress object with streetAddress, addressLocality, postalCode and addressCountry.' });
      else if (node.address && !node.address.addressCountry) problems.push({ severity: 'warning', message: 'address has no addressCountry.' });
      return problems;
    },
  },
  Service: {
    label: 'Service',
    required: ['name'],
    recommended: ['provider', 'areaServed', 'description', 'serviceType', 'offers'],
    notes: 'Service has no rich result of its own. It is worth marking up because it states plainly what the business does and for whom, which is exactly what an AI engine needs to decide the brand is relevant to a query.',
  },
  BreadcrumbList: {
    label: 'BreadcrumbList',
    required: ['itemListElement'],
    recommended: [],
    notes: 'Each ListItem needs position, name and item. The breadcrumb rich result replaces the URL in the SERP, and it also tells an AI crawler where the page sits in the site hierarchy.',
    validate(node) {
      const problems = [];
      const items = Array.isArray(node.itemListElement) ? node.itemListElement : [];
      if (items.length < 2) problems.push({ severity: 'warning', message: `Only ${items.length} breadcrumb item — a trail needs at least two.` });
      items.forEach((it, i) => {
        if (!it) return;
        if (it.position == null) problems.push({ severity: 'error', message: `itemListElement[${i}] has no position.` });
        if (!it.name) problems.push({ severity: 'error', message: `itemListElement[${i}] has no name.` });
      });
      return problems;
    },
  },
  WebSite: {
    label: 'WebSite',
    required: ['name', 'url'],
    recommended: ['potentialAction', 'publisher'],
    notes: 'potentialAction with a SearchAction enables the sitelinks search box. Only claim it if the site really has a working search endpoint at the stated URL.',
  },
  Person: {
    label: 'Person',
    required: ['name'],
    recommended: ['jobTitle', 'worksFor', 'sameAs', 'image', 'description'],
    notes: 'The author-credibility block. For any page making professional claims — medical, financial, legal, certification — an author Person with a real jobTitle and sameAs profile is the strongest experience signal available in markup.',
  },
  Course: {
    label: 'Course',
    required: ['name', 'description'],
    recommended: ['provider', 'hasCourseInstance', 'offers', 'educationalCredentialAwarded'],
    notes: 'provider must be an Organization. For certification content, educationalCredentialAwarded is what states plainly what the learner ends up holding.',
  },
  Event: {
    label: 'Event',
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'description', 'image', 'offers', 'performer', 'eventStatus'],
    notes: 'startDate must include a timezone offset. An online event needs location as a VirtualLocation with a url.',
  },
  Review: {
    label: 'Review',
    required: ['itemReviewed', 'reviewRating', 'author'],
    recommended: ['datePublished', 'reviewBody', 'publisher'],
    notes: 'A business must not mark up reviews of itself on its own site as Review — that is self-serving review markup and Google ignores or penalises it. Use aggregateRating on the reviewed item instead, and only for ratings genuinely collected.',
  },
};

const ALIAS_TO_CANONICAL = (() => {
  const m = new Map();
  Object.entries(TYPE_RULES).forEach(([canonical, rule]) => {
    m.set(canonical.toLowerCase(), canonical);
    (rule.aliases || []).forEach((a) => m.set(a.toLowerCase(), canonical));
  });
  return m;
})();

function canonicalType(type) {
  return ALIAS_TO_CANONICAL.get(String(type || '').replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()) || null;
}

// ----------------------------------------------------------- node extraction

// Flattens a JSON-LD document into the individual typed nodes worth checking,
// following @graph — which is how most CMS plugins now emit schema, and which a
// naive top-level-only reader misses entirely.
function extractNodes(data, out = [], depth = 0) {
  if (!data || typeof data !== 'object' || depth > 6) return out;
  if (Array.isArray(data)) { data.forEach((d) => extractNodes(d, out, depth + 1)); return out; }
  if (Array.isArray(data['@graph'])) data['@graph'].forEach((d) => extractNodes(d, out, depth + 1));
  if (data['@type']) {
    const types = Array.isArray(data['@type']) ? data['@type'] : [data['@type']];
    types.forEach((t) => out.push({ type: String(t), canonical: canonicalType(t), node: data }));
  }
  // Nested typed objects worth validating in their own right (an Article's
  // author Person, a Product's Offer) are reached through the known property
  // names rather than by walking everything, which would report the same node
  // several times.
  ['author', 'publisher', 'provider', 'mainEntityOfPage', 'itemReviewed'].forEach((key) => {
    if (data[key] && typeof data[key] === 'object') extractNodes(data[key], out, depth + 1);
  });
  return out;
}

// Validates one node against its type rule.
function validateNode(entry) {
  const rule = entry.canonical ? TYPE_RULES[entry.canonical] : null;
  const problems = [];
  if (!rule) {
    return {
      ...entry,
      known: false,
      problems: [],
      note: `No requirement table for "${entry.type}" — it is valid Schema.org vocabulary but has no Google rich-result requirements to check against.`,
    };
  }

  const node = entry.node;
  const present = (prop) => node[prop] != null && !(Array.isArray(node[prop]) && !node[prop].length)
    && !(typeof node[prop] === 'string' && !node[prop].trim());

  (rule.required || []).forEach((prop) => {
    if (!present(prop)) {
      problems.push({
        severity: 'error',
        message: `Missing required property "${prop}" — without it this ${rule.label} is not eligible for its rich result.`,
        property: prop,
      });
    }
  });

  (rule.oneOf || []).forEach((group) => {
    if (!group.some(present)) {
      problems.push({
        severity: 'error',
        message: `At least one of ${group.map((g) => `"${g}"`).join(', ')} is required and none are present.`,
        property: group.join('|'),
      });
    }
  });

  (rule.recommended || []).forEach((prop) => {
    if (!present(prop)) {
      problems.push({
        severity: 'warning',
        message: `Recommended property "${prop}" is absent — the markup is valid but the result will be weaker than a competitor's that has it.`,
        property: prop,
      });
    }
  });

  if (rule.validate) problems.push(...rule.validate(node));

  // Structural mistakes that apply to every type.
  if (!node['@context'] && !entry.inGraph) {
    problems.push({ severity: 'warning', message: 'No @context on this node. Valid inside an @graph whose parent declares it; an error if this node stands alone.' });
  }

  return { ...entry, known: true, rule: { label: rule.label, notes: rule.notes }, problems };
}

// ---------------------------------------------------- deterministic generation

// Everything below can be read off the page, so it is generated locally with
// no model involved and no possibility of invention. The model is asked only
// about type SELECTION and about properties that need reading comprehension —
// see aiCalls.schemaDraft.
function generateFromPage(doc, brand, facts) {
  const generated = [];
  const site = brand ? normalizeUrl(brand.site_url) : null;
  const origin = site ? (() => { try { return new URL(site).origin; } catch { return null; } })() : null;

  // BreadcrumbList — from the trail the page already renders. Generating this
  // from a trail that exists is safe; inventing a hierarchy is not.
  if (doc.breadcrumbTrail.trail.length >= 2) {
    generated.push({
      type: 'BreadcrumbList',
      basis: `read from the page's ${doc.breadcrumbTrail.source} breadcrumbs`,
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: doc.breadcrumbTrail.trail.map((name, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name,
          // The intermediate URLs are not knowable from the trail text, so
          // only the current page's own URL is asserted. A guessed URL would
          // produce a breadcrumb pointing at a 404.
          ...(i === doc.breadcrumbTrail.trail.length - 1 ? { item: doc.url } : {}),
        })),
      },
      needsHumanInput: doc.breadcrumbTrail.trail.length > 1
        ? ['item URLs for the intermediate breadcrumb levels — they cannot be read from the trail text']
        : [],
    });
  }

  // FAQPage — only from question/answer pairs genuinely visible in the markup.
  const faqPairs = [];
  doc.headings.forEach((h, i) => {
    const isQuestion = h.text.trim().endsWith('?') || /^(what|why|how|when|where|which|who|can|do|does|is|are|should|will)\b/i.test(h.text);
    if (!isQuestion || h.level < 2) return;
    // The answer is the prose that follows the heading, up to the next heading
    // of the same or higher level. Approximated from the paragraph list, which
    // is in document order.
    const answer = doc.paragraphs.find((p) => p.length > 60);
    if (answer) faqPairs.push({ question: h.text.trim(), answerHint: answer.slice(0, 40) });
  });
  if (faqPairs.length >= 2) {
    generated.push({
      type: 'FAQPage',
      basis: `${faqPairs.length} question-shaped headings found on the page`,
      // Deliberately NOT filled in: the answer text has to be the exact
      // visible answer, and pairing headings to paragraphs by position is
      // reliable enough to detect the opportunity but not to assert the
      // content. Marking up the wrong answer text is a policy violation.
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqPairs.map((p) => ({
          '@type': 'Question',
          name: p.question,
          acceptedAnswer: { '@type': 'Answer', text: null },
        })),
      },
      needsHumanInput: ['acceptedAnswer.text for each question — must be the exact answer text visible on the page'],
    });
  }

  // Article — for a page that reads as one. Every field here is read off the
  // page; nothing is guessed.
  const looksLikeArticle = doc.wordCount > 400 && doc.h1s.length === 1 && doc.semantic.article;
  if (looksLikeArticle) {
    generated.push({
      type: 'Article',
      basis: `${doc.wordCount} words inside an <article> element with a single H1`,
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: (doc.h1s[0] || doc.title || '').slice(0, 110),
        description: doc.metaDesc || null,
        image: doc.openGraph.image ? [doc.openGraph.image] : [],
        mainEntityOfPage: { '@type': 'WebPage', '@id': doc.url },
        datePublished: null,
        dateModified: null,
        author: null,
        publisher: brand ? {
          '@type': 'Organization',
          name: brand.name,
          ...(origin ? { url: origin } : {}),
        } : null,
      },
      needsHumanInput: ['datePublished and dateModified in ISO 8601', 'author as a Person object with a real name and jobTitle'],
    });
  }

  // Organization — assembled entirely from the declared brand facts, which is
  // the whole point of keeping them: one source, three renderings.
  if (brand) {
    const factMap = new Map((facts || []).map((f) => [f.fact_key, f.fact_value]));
    const sameAs = String(factMap.get('social_profiles') || '')
      .split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    const org = {
      '@context': 'https://schema.org',
      '@type': factMap.get('organization_type') || 'Organization',
      name: factMap.get('legal_name') || brand.name,
      url: origin || site,
      description: factMap.get('what_we_do') || null,
      ...(factMap.get('logo_url') ? { logo: factMap.get('logo_url') } : {}),
      ...(sameAs.length ? { sameAs } : {}),
      ...(factMap.get('phone') || factMap.get('support_email') ? {
        contactPoint: [{
          '@type': 'ContactPoint',
          contactType: 'customer support',
          ...(factMap.get('phone') ? { telephone: factMap.get('phone') } : {}),
          ...(factMap.get('support_email') ? { email: factMap.get('support_email') } : {}),
          ...(factMap.get('service_area') ? { areaServed: factMap.get('service_area') } : {}),
        }],
      } : {}),
      ...(factMap.get('street_address') ? {
        address: {
          '@type': 'PostalAddress',
          streetAddress: factMap.get('street_address'),
          addressLocality: factMap.get('city') || null,
          addressRegion: factMap.get('region') || null,
          postalCode: factMap.get('postal_code') || null,
          addressCountry: factMap.get('country') || null,
        },
      } : {}),
      ...(factMap.get('founded') ? { foundingDate: factMap.get('founded') } : {}),
    };
    const missing = ['logo_url', 'social_profiles', 'what_we_do'].filter((k) => !factMap.get(k));
    generated.push({
      type: 'Organization',
      basis: `assembled from ${factMap.size} declared brand fact${factMap.size === 1 ? '' : 's'}`,
      jsonld: org,
      needsHumanInput: missing.length
        ? [`declare these brand facts to complete it: ${missing.join(', ')}`]
        : [],
    });
  }

  return generated;
}

// --------------------------------------------------------------- llms.txt

// Renders the brand's canonical facts and content map as llms.txt.
//
// Two honest caveats stated in the output itself, because they are the ones
// people get wrong: Google has said publicly it does not use llms.txt, and it
// is not a ranking factor anywhere. What it does is give retrieval pipelines
// that DO read it an unambiguous statement of what the brand is, and — more
// usefully — it forces the canonical facts to be written down once.
function renderLlmsTxt({ brand, facts, sections = [] }) {
  const factMap = new Map((facts || []).map((f) => [f.fact_key, { value: f.fact_value, source: f.source_url }]));
  const get = (k) => (factMap.get(k) ? factMap.get(k).value : null);
  const site = brand ? normalizeUrl(brand.site_url) : '';
  let origin = site;
  try { origin = new URL(site).origin; } catch { /* keep as given */ }

  const lines = [];
  lines.push(`# ${get('legal_name') || brand.name}`);
  lines.push('');
  if (get('what_we_do')) lines.push(`> ${get('what_we_do')}`);
  lines.push('');

  const canonical = [
    ['Website', origin],
    ['Legal name', get('legal_name')],
    ['Founded', get('founded')],
    ['What we do', get('what_we_do')],
    ['Who we serve', get('who_we_serve')],
    ['Service area', get('service_area')],
    ['Accreditations', get('accreditations')],
    ['Regulated by', get('regulated_by')],
    ['Pricing basis', get('pricing_basis')],
    ['Contact', get('support_email') || get('phone')],
  ].filter(([, v]) => v);

  if (canonical.length) {
    lines.push('## Canonical facts');
    lines.push('');
    canonical.forEach(([k, v]) => {
      const src = factMap.get(k.toLowerCase().replace(/\s+/g, '_'));
      lines.push(`- **${k}:** ${v}${src && src.source ? ` (source: ${src.source})` : ''}`);
    });
    lines.push('');
  }

  // Any fact not covered by the canonical block above, grouped by section, so
  // nothing a user declares is silently dropped from the output.
  const covered = new Set(['legal_name', 'founded', 'what_we_do', 'who_we_serve', 'service_area',
    'accreditations', 'regulated_by', 'pricing_basis', 'support_email', 'phone',
    'organization_type', 'logo_url', 'social_profiles', 'street_address', 'city',
    'region', 'postal_code', 'country']);
  const extraBySection = new Map();
  (facts || []).forEach((f) => {
    if (covered.has(f.fact_key) || !f.fact_value) return;
    if (!extraBySection.has(f.section)) extraBySection.set(f.section, []);
    extraBySection.get(f.section).push(f);
  });
  extraBySection.forEach((items, section) => {
    lines.push(`## ${section.charAt(0).toUpperCase()}${section.slice(1)}`);
    lines.push('');
    items.forEach((f) => {
      lines.push(`- **${f.fact_key.replace(/_/g, ' ')}:** ${f.fact_value}${f.source_url ? ` (source: ${f.source_url})` : ''}`);
    });
    lines.push('');
  });

  // The content map. Sections come from the sitemap's own URL structure, so
  // this is a statement of what the site CONTAINS rather than of what has
  // happened to rank — see contentSections() below for why that inversion
  // matters. Where a section held more pages than are listed, the total is
  // stated, because a truncated list that does not say it is truncated reads as
  // a complete inventory.
  (sections || []).forEach((sec) => {
    if (!sec.links || !sec.links.length) return;
    const total = sec.totalInSitemap && sec.totalInSitemap > sec.links.length
      ? ` (${sec.links.length} of ${sec.totalInSitemap} pages in this section)`
      : '';
    lines.push(`## ${sec.title}${total}`);
    lines.push('');
    sec.links.forEach((l) => {
      lines.push(`- [${l.title}](${l.url})${l.note ? `: ${l.note}` : ''}`);
    });
    lines.push('');
  });

  lines.push('## About this file');
  lines.push('');
  lines.push('This file states the canonical facts about this organisation for AI systems that read it.');
  lines.push('It is not a ranking signal, and Google has stated it does not use llms.txt.');
  lines.push('Where a fact carries a source URL, that page is the authoritative statement of it.');
  if (sections && sections.basis) {
    lines.push(`Content map basis: ${sections.basis}.`);
  }
  lines.push(`Last generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  return lines.join('\n');
}

// THE CONTENT MAP FOR llms.txt — BUILT FROM THE SITEMAP.
//
// This used to be built from Search Console: the pages with the most clicks
// over 90 days. That was wrong for what llms.txt is for, in two ways that both
// matter.
//
//   COVERAGE. llms.txt is a statement of WHAT THIS SITE CONTAINS. Search
//   Console only knows the pages Google has shown, so a brand-new section, a
//   page that has never ranked, and every page on a site with no GSC history
//   were all absent from the file. A retrieval system reading it concluded
//   those pages did not exist.
//
//   STRUCTURE. A flat "most-visited pages" list expresses no architecture. The
//   sitemap does: its URL paths are the site's own declared sections, so the
//   file can be grouped the way the site is organised, which is what makes it
//   readable to a machine and to a person.
//
// So the sitemap is now the source of record, and Search Console — where it
// exists — is used only to ORDER pages within each section and to annotate the
// busiest ones. That inverts the old relationship: coverage from the sitemap,
// prominence from GSC. Where a brand has no GSC history the file is complete
// and merely unordered, instead of empty.
async function contentSections(brandId, brand, {
  limit = 200, perSection = 25, maxSections = 12, useGsc = true,
} = {}) {
  const site = brand ? normalizeUrl(brand.site_url) : null;
  if (!site) return [];

  const robots = await fetchRobots(site);
  const sitemap = await fetchSitemapUrls(site, { limit: 5000, robots });
  if (!sitemap.urls.length) {
    return [{
      title: 'Content map unavailable',
      empty: true,
      basis: `no sitemap could be read for ${site}${robots.present ? '' : ' (and no robots.txt was served to point at one)'}`,
      links: [],
    }];
  }

  // Prominence, where Search Console has it. Optional by design.
  const clicksByUrl = new Map();
  if (useGsc && brandId) {
    try {
      const analytics = require('../analytics');
      const anchor = analytics.latestGscDate(brandId);
      if (anchor) {
        const w = analytics.windowFrom(anchor, 90);
        db.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions
          FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
          GROUP BY page`).all(brandId, w.startDate, w.endDate)
          .forEach((r) => clicksByUrl.set(String(r.page).replace(/\/$/, ''), {
            clicks: Number(r.clicks) || 0,
            impressions: Number(r.impressions) || 0,
          }));
      }
    } catch { /* GSC is an enrichment here, never a requirement */ }
  }

  const titleFromPath = (path) => {
    if (path === '/' || !path) return 'Homepage';
    const last = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    return last.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').replace(/\b\w/g, (c) => c.toUpperCase()) || path;
  };

  const bySection = new Map();
  sitemap.urls.forEach((u) => {
    const loc = u.loc || u;
    let path = '/';
    try { path = new URL(loc).pathname || '/'; } catch { return; }
    const section = path === '/' ? '(root)' : (path.split('/').filter(Boolean)[0] || '(root)');
    if (!bySection.has(section)) bySection.set(section, []);
    const perf = clicksByUrl.get(String(loc).replace(/\/$/, '')) || null;
    bySection.get(section).push({
      url: loc,
      path,
      title: titleFromPath(path),
      lastmod: u.lastmod || null,
      clicks: perf ? perf.clicks : null,
      impressions: perf ? perf.impressions : null,
    });
  });

  const sectionLabel = (key) => (key === '(root)'
    ? 'Top-level pages'
    : key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  let emitted = 0;
  const sections = [...bySection.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxSections)
    .map(([key, pages]) => {
      // Within a section: measured prominence first where it exists, then
      // most-recently-modified, then shallowest. Every ordering rule is a real
      // signal; none of them invents one.
      const ordered = pages.sort((a, b) => {
        if ((b.clicks || 0) !== (a.clicks || 0)) return (b.clicks || 0) - (a.clicks || 0);
        if ((b.impressions || 0) !== (a.impressions || 0)) return (b.impressions || 0) - (a.impressions || 0);
        const am = a.lastmod ? Date.parse(a.lastmod) : 0;
        const bm = b.lastmod ? Date.parse(b.lastmod) : 0;
        if (bm !== am) return bm - am;
        return a.path.split('/').length - b.path.split('/').length;
      });
      const take = ordered.slice(0, Math.max(1, Math.min(perSection, limit - emitted)));
      emitted += take.length;
      return {
        title: sectionLabel(key),
        sectionKey: key,
        totalInSitemap: pages.length,
        shown: take.length,
        withMeasuredTraffic: take.filter((x) => x.clicks != null).length,
        links: take.map((x) => ({
          url: x.url,
          title: x.title,
          note: [
            x.clicks != null && (x.clicks || x.impressions)
              ? `${x.clicks.toLocaleString('en-US')} clicks / ${x.impressions.toLocaleString('en-US')} impressions, 90 days`
              : null,
            x.lastmod ? `updated ${String(x.lastmod).slice(0, 10)}` : null,
          ].filter(Boolean).join(' · ') || null,
        })),
      };
    })
    .filter((sec) => sec.links.length);

  const totalUrls = sitemap.urls.length;
  const shown = sections.reduce((a, sec) => a + sec.shown, 0);
  sections.basis = `${totalUrls.toLocaleString('en-US')} URL${totalUrls === 1 ? '' : 's'} read from ${sitemap.sources.length} sitemap source${sitemap.sources.length === 1 ? '' : 's'}, grouped into ${sections.length} section${sections.length === 1 ? '' : 's'}; ${shown} listed`
    + (clicksByUrl.size ? `, ordered within each section by Search Console clicks where available (${clicksByUrl.size} URL${clicksByUrl.size === 1 ? '' : 's'} matched)` : ', with no Search Console history to order by');
  sections.sitemapUrls = totalUrls;
  sections.sitemapSources = sitemap.sources;
  sections.gscMatched = clicksByUrl.size;
  sections.truncated = totalUrls > shown;
  return sections;
}

// --------------------------------------------------------------------- run

async function run({ userId, brand, adoptRunId = null, url, wantedTypes = [], wantAi = true, force = false }) {
  const brandId = brand ? brand.id : null;
  const target = normalizeUrl(url);
  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'schema', target,
    label: wantedTypes.length ? wantedTypes.join(', ') : null,
    params: { url: target, wantedTypes },
  });

  try {
    const sources = ['crawler'];
    const res = await fetchPage(target, { timeout: 25000 });
    if (!res.ok || !res.body) {
      return store.finish(runRow.id, {
        score: null,
        result: { empty: true, reason: res.error ? `Could not fetch the page: ${res.error}` : `The page returned HTTP ${res.status}.` },
        findings: [{
          checkKey: 'unfetchable',
          title: 'The page could not be fetched',
          detail: res.error || `HTTP ${res.status}`,
          severity: 'critical',
          affectedUrl: target,
          action: 'Confirm the URL is public and returns 200.',
          dedupeKey: `schema:unfetchable:${target}`,
        }],
        sources,
      });
    }

    const doc = parseDocument(res.url, res.body);

    // What is there now.
    const detected = [];
    doc.jsonLd.forEach((block, blockIndex) => {
      if (!block.ok) {
        detected.push({
          type: '(unparseable)', canonical: null, blockIndex, known: false,
          parseError: block.error, raw: block.raw,
          problems: [{ severity: 'error', message: `This JSON-LD block does not parse: ${block.error}. Google and every AI crawler ignore it entirely.` }],
        });
        return;
      }
      extractNodes(block.data).forEach((entry) => {
        detected.push({ ...validateNode({ ...entry, inGraph: Boolean(block.data['@graph']) }), blockIndex });
      });
    });

    // Microdata and RDFa, detected but not validated. Worth reporting because
    // a site using microdata is often assumed to have no structured data at
    // all, and duplicate markup in two formats is a real, common problem.
    const microdata = doc.$('[itemscope][itemtype]').map((_, el) => String(doc.$(el).attr('itemtype') || '')).get();

    const facts = brandId ? db.prepare('SELECT * FROM brand_facts WHERE brand_id=? ORDER BY sort_order, fact_key').all(brandId) : [];

    // WHAT KIND OF PAGE IS THIS.
    //
    // Everything below depends on the answer, and getting it wrong is how a
    // service page ends up being handed Product markup. See ./pageType.js for
    // how it is decided and what evidence is reported.
    const classified = pageTypeLib.classify(doc, { brand });

    // The FINAL, pasteable blocks — one per type the page type permits, each
    // with its unknowable properties omitted rather than nulled, plus the
    // combined @graph that actually goes on the page. See ./schemaBuilder.js.
    const built = schemaBuilder.build({
      doc, brand, facts, wantedTypes, pageType: classified,
    });

    // The old fragment generator is kept because two of its outputs are still
    // the clearest way to show WHY a type was offered — but the pasteable
    // artefact is now `built`, and the UI leads with that.
    const generated = generateFromPage(doc, brand, facts);

    let aiDraft = null;
    if (wantAi) {
      aiDraft = await aiCalls.schemaDraft({
        brandId, doc, detected: detected.filter((d) => d.canonical),
        wantedTypes,
        // The classifier's verdict is passed in so the model reasons about
        // properties rather than re-litigating the type. A model asked "what
        // schema should this page have" reaches for Product on anything with a
        // price; told "this is a Service page and Product is forbidden because
        // …", it does the job it is actually good at.
        pageType: {
          type: classified.type,
          label: classified.label,
          confident: classified.confident,
          allowed: built.pageType ? classified.allowedSchema : [],
          forbidden: classified.forbiddenSchema,
        },
        brandFacts: facts.map((f) => ({ key: f.fact_key, value: f.fact_value })),
        force,
      });
      if (aiDraft.ok) sources.push('azure');
    }

    // ------------------------------------------------------------ findings
    const findings = [];
    const errors = detected.flatMap((d) => (d.problems || []).filter((p) => p.severity === 'error').map((p) => ({ ...p, type: d.type })));
    const warnings = detected.flatMap((d) => (d.problems || []).filter((p) => p.severity === 'warning').map((p) => ({ ...p, type: d.type })));

    // THE WRONG-TYPE FINDING.
    //
    // A declared type the page's own content contradicts. Reported at high
    // severity because it is not a missing improvement — it is markup that
    // actively misdescribes the page, and Google's response to a Product block
    // that fails retail validation is to distrust the site's structured data
    // more broadly, not only that one block.
    if (classified.mismatches.length) {
      classified.mismatches.forEach((mm) => {
        findings.push({
          checkKey: `wrong_type_${mm.declared.toLowerCase()}`,
          title: `${mm.declared} markup on a page whose content reads as a ${mm.pageLabel.toLowerCase()}`,
          detail: `${mm.reason} The classification rests on: ${classified.evidence.filter((e) => e.type === classified.type).slice(0, 4).map((e) => e.why).join('; ')}.`
            + (classified.confident
              ? ''
              : ` The classifier is NOT confident here — ${classified.label} scored ${classified.score} against ${classified.runnerUp ? `${classified.runnerUp.label} at ${classified.runnerUp.score}` : 'nothing else'} — so confirm the page type before removing anything.`),
          severity: classified.confident ? 'high' : 'medium',
          affectedUrl: target,
          action: built.blocks.length
            ? `Replace it with the ${built.blocks.filter((b) => b.allowedForPageType).map((b) => b.type).slice(0, 3).join(' / ')} block(s) generated below, which are built from what is actually on this page.`
            : `Remove it. ${mm.declared} cannot be made correct on a page of this type.`,
          evidence: {
            declared: mm.declared,
            pageType: classified.type,
            confident: classified.confident,
            score: classified.score,
            runnerUp: classified.runnerUp,
            evidence: classified.evidence.slice(0, 12),
            commerce: classified.commerce,
          },
          dedupeKey: `schema:wrongtype:${target}:${mm.declared}`,
        });
      });
    }

    // Blocks that could not be produced complete. Stated as a finding so the
    // required-property gap appears in the report rather than only beside the
    // code block.
    const needingInput = built.blocks.filter((b) => b.requiredPlaceholders.length);
    if (needingInput.length) {
      findings.push({
        checkKey: 'generated_needs_input',
        title: `${needingInput.length} generated block${needingInput.length === 1 ? ' needs' : 's need'} a value that is not on the page`,
        detail: needingInput.map((b) => `${b.type}: ${b.requiredPlaceholders.map((x) => x.property).join(', ')}`).join('; ')
          + '. These properties were OMITTED rather than written as null, so each block is valid JSON-LD as it stands — but the rich result it targets needs them.',
        severity: 'low',
        affectedUrl: target,
        affectedCount: built.counts.requiredPlaceholders,
        action: 'Fill in the values listed against each block. Every one states the exact shape expected and where to get it.',
        evidence: { blocks: needingInput.map((b) => ({ type: b.type, required: b.requiredPlaceholders })) },
        dedupeKey: `schema:needsinput:${target}`,
      });
    }

    if (!doc.jsonLd.length && !microdata.length) {
      findings.push({
        checkKey: 'no_structured_data',
        title: 'The page has no structured data at all',
        detail: 'No JSON-LD and no microdata. The page is ineligible for every rich result, and AI answer engines have no machine-readable statement of what it is about.',
        severity: 'high',
        affectedUrl: target,
        action: built.blocks.length
          ? `This page is a ${classified.label.toLowerCase()}. Paste the combined @graph generated below — it carries ${built.blocks.map((g) => g.type).join(', ')}, all built from content already visible on the page, and ${built.counts.readyToPaste} of ${built.counts.blocks} block(s) need no further input.`
          : 'Add at least an Organization block sitewide and a page-type block here.',
        evidence: { generated: built.blocks.map((g) => g.type), pageType: classified.type },
        dedupeKey: `schema:none:${target}`,
      });
    }

    doc.jsonLd.filter((b) => !b.ok).forEach((b, i) => {
      findings.push({
        checkKey: 'invalid_json',
        title: 'A JSON-LD block on the page does not parse',
        detail: `${b.error}. This block is invisible to Google and to every AI crawler — the markup is present in the source but has no effect whatsoever.`,
        severity: 'critical',
        affectedUrl: target,
        action: 'Fix the JSON syntax. The usual causes are an unescaped quote in a description, a trailing comma, or a template variable that rendered empty.',
        evidence: { raw: b.raw },
        dedupeKey: `schema:invalidjson:${target}:${i}`,
      });
    });

    if (errors.length) {
      const byType = new Map();
      errors.forEach((e) => {
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type).push(e.message);
      });
      byType.forEach((messages, type) => {
        findings.push({
          checkKey: `required_missing_${type.toLowerCase()}`,
          title: `${type} markup is missing ${messages.length} required propert${messages.length === 1 ? 'y' : 'ies'}`,
          detail: messages.join(' '),
          severity: 'high',
          affectedUrl: target,
          affectedCount: messages.length,
          action: 'Add the required properties. Until they are present this type earns no rich result, so the markup is doing nothing.',
          evidence: { messages },
          dedupeKey: `schema:required:${target}:${type}`,
        });
      });
    }

    if (warnings.length >= 3) {
      findings.push({
        checkKey: 'recommended_missing',
        title: `${warnings.length} recommended properties are absent`,
        detail: warnings.slice(0, 10).map((w) => `${w.type}: ${w.message}`).join(' '),
        severity: 'low',
        affectedUrl: target,
        affectedCount: warnings.length,
        action: 'Fill these in where the page genuinely carries the information. Do not invent values to satisfy the checklist.',
        evidence: { warnings: warnings.slice(0, 30) },
        dedupeKey: `schema:recommended:${target}`,
      });
    }

    // Types the page plainly ought to have and does not.
    //
    // Taken from the classifier and the builder rather than from a short list
    // of hand-written conditions: a type is "missing" when the builder could
    // actually produce it from this page's own content and the page does not
    // already declare it. That is a claim with a generated block sitting
    // directly below it, rather than a checklist item.
    const detectedCanonical = new Set(detected.map((d) => d.canonical).filter(Boolean));
    const declaredRaw = new Set(doc.jsonLd.filter((j) => j.ok).flatMap((j) => schemaTypesOf(j.data)).map(String));
    const oughtTo = built.blocks
      .filter((b) => b.allowedForPageType)
      .filter((b) => !declaredRaw.has(b.type) && !detectedCanonical.has(canonicalType(b.type) || b.type))
      .map((b) => b.type);
    if (oughtTo.length && doc.jsonLd.length) {
      findings.push({
        checkKey: 'missing_types',
        title: `${oughtTo.length} schema type${oughtTo.length === 1 ? '' : 's'} this page qualifies for but does not declare`,
        detail: `The page classifies as a ${classified.label.toLowerCase()}, and each of these can be built from content already visible on it: ${oughtTo.join(', ')}.`,
        severity: 'medium',
        affectedUrl: target,
        affectedCount: oughtTo.length,
        action: 'Paste the combined @graph below. Organization and WebSite belong in the shared layout rather than on this page alone — the block list says which is which.',
        evidence: { types: oughtTo, pageType: classified.type },
        dedupeKey: `schema:missingtypes:${target}`,
      });
    }

    if (microdata.length && doc.jsonLd.length) {
      findings.push({
        checkKey: 'duplicate_formats',
        title: 'The page carries both JSON-LD and microdata',
        detail: `Microdata types present: ${[...new Set(microdata)].slice(0, 6).join(', ')}. Two formats describing the same thing is a common source of contradictory markup — Google reads both and does not always prefer the one you intend.`,
        severity: 'low',
        affectedUrl: target,
        action: 'Consolidate on JSON-LD and remove the microdata attributes, or confirm the two do not contradict each other.',
        evidence: { microdata: [...new Set(microdata)] },
        dedupeKey: `schema:dupformats:${target}`,
      });
    }

    // Scored on required-property compliance first, coverage second: a page
    // whose markup is complete for the types it has scores well even with few
    // types, because it does what it claims.
    const totalNodes = Math.max(1, detected.filter((d) => d.known).length);
    const errorPenalty = Math.min(60, errors.length * 12);
    const warnPenalty = Math.min(20, warnings.length * 2);
    const coverageBonus = Math.min(20, detectedCanonical.size * 5);
    // A type that misdescribes the page costs more than a missing property.
    // Markup that is complete and wrong is worse than markup that is
    // incomplete and right, and the score has to say so or the page reads as
    // healthy while telling Google the wrong thing.
    const mismatchPenalty = classified.mismatches.length
      ? Math.min(45, classified.mismatches.length * (classified.confident ? 25 : 12))
      : 0;
    const score = doc.jsonLd.length || microdata.length
      ? Math.max(0, Math.min(100, 80 - errorPenalty - warnPenalty - mismatchPenalty + coverageBonus))
      : 0;

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        url: target,
        page: { title: doc.title, h1s: doc.h1s, wordCount: doc.wordCount, breadcrumbTrail: doc.breadcrumbTrail },
        detected,
        detectedTypes: [...detectedCanonical],
        rawTypes: doc.jsonLd.filter((j) => j.ok).flatMap((j) => schemaTypesOf(j.data)),
        microdata: [...new Set(microdata)],
        counts: {
          blocks: doc.jsonLd.length, nodes: detected.length,
          errors: errors.length, warnings: warnings.length,
          generatedBlocks: built.counts.blocks,
          readyToPaste: built.counts.readyToPaste,
          skippedTypes: built.counts.skipped,
        },
        // What kind of page this is, with the evidence — the answer everything
        // below depends on.
        pageType: built.pageType,
        // The pasteable artefact: one complete block per permitted type, the
        // combined @graph, and the list of types deliberately NOT generated
        // with the reason for each.
        build: {
          blocks: built.blocks,
          skipped: built.skipped,
          graphJson: built.graphJson,
          graphScript: built.graphScript,
          sitewideTypes: built.sitewideTypes,
          counts: built.counts,
        },
        generated,
        oughtTo,
        aiDraft: aiDraft ? {
          ok: aiDraft.ok, cached: aiDraft.cached, reason: aiDraft.reason,
          error: aiDraft.error, data: aiDraft.ok ? aiDraft.data : null,
        } : null,
        typeRules: Object.fromEntries(Object.entries(TYPE_RULES).map(([k, v]) => [k, { label: v.label, required: v.required || [], recommended: v.recommended || [], notes: v.notes }])),
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId ? [
        { key: 'schema.score', url: target, value: score, status: score >= 75 ? 'good' : (score >= 50 ? 'warn' : 'fail') },
        { key: 'schema.errors', url: target, value: errors.length, status: errors.length ? 'fail' : 'good' },
        { key: 'schema.type_mismatches', url: target, value: classified.mismatches.length, status: classified.mismatches.length ? 'fail' : 'good' },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

// --------------------------------------------------------- brand hub review

// Checks the brand's declared facts and the live llms.txt, and reports what an
// AI engine would be unable to establish about the brand.
async function reviewBrandHub({
  userId, brand, wantAi = true, force = false, useGscOrdering = true,
}) {
  const brandId = brand.id;
  const facts = db.prepare('SELECT * FROM brand_facts WHERE brand_id=? ORDER BY sort_order, fact_key').all(brandId);
  const live = await fetchLlmsTxt(brand.site_url);
  const sections = await contentSections(brandId, brand, {
    useGsc: useGscOrdering,
  });
  const rendered = renderLlmsTxt({ brand, facts, sections });

  let ai = null;
  if (wantAi && facts.length) {
    ai = await aiCalls.brandHubReview({
      brandId, brand,
      facts: facts.map((f) => ({ key: f.fact_key, value: f.fact_value, source: f.source_url })),
      force,
    });
  }

  // The facts an AI engine needs in order to answer "what is this and can I
  // trust it". Checked as a fixed list, because "what is missing" must not
  // depend on a model being configured.
  const ESSENTIAL = [
    { key: 'what_we_do', label: 'What the organisation does', why: 'Without it, an engine describes the brand from whatever a third party said.' },
    { key: 'who_we_serve', label: 'Who it serves', why: 'Decides whether the brand is returned for "for small businesses" style qualifiers.' },
    { key: 'service_area', label: 'Where it operates', why: 'The most common reason a brand is excluded from a location-qualified answer.' },
    { key: 'pricing_basis', label: 'How pricing works', why: 'Assistants are asked about cost constantly; silence is filled by a competitor or a forum post.' },
    { key: 'accreditations', label: 'Accreditations or registrations', why: 'The verifiable trust signal an engine can check against a register.' },
    { key: 'support_email', label: 'A contact route', why: 'Part of every "is this legitimate" assessment.' },
    { key: 'social_profiles', label: 'Official profile URLs', why: 'Feeds sameAs, which is the strongest entity-disambiguation signal available.' },
    { key: 'legal_name', label: 'Registered legal name', why: 'Links the brand to public records; a trading name alone often cannot be verified.' },
  ];
  const have = new Map(facts.map((f) => [f.fact_key, f.fact_value]));
  const missingEssential = ESSENTIAL.filter((e) => !have.get(e.key));

  return {
    facts, live, rendered, sections,
    missingEssential,
    completeness: Math.round(((ESSENTIAL.length - missingEssential.length) / ESSENTIAL.length) * 100),
    ai: ai ? { ok: ai.ok, cached: ai.cached, reason: ai.reason, error: ai.error, data: ai.ok ? ai.data : null } : null,
  };
}

function saveFacts(brandId, entries) {
  const upsert = db.prepare(`INSERT INTO brand_facts (brand_id, section, fact_key, fact_value, source_url, sort_order, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(brand_id, fact_key) DO UPDATE SET
      section=excluded.section, fact_value=excluded.fact_value,
      source_url=excluded.source_url, sort_order=excluded.sort_order,
      updated_at=datetime('now')`);
  const del = db.prepare('DELETE FROM brand_facts WHERE brand_id=? AND fact_key=?');
  let saved = 0;
  db.transaction(() => {
    entries.forEach((e) => {
      if (!e.key) return;
      const value = e.value == null ? '' : String(e.value).trim();
      // An emptied field means "I no longer assert this", which must remove
      // the fact rather than store an empty string that renders as a blank
      // line in llms.txt.
      if (!value) { del.run(brandId, e.key); return; }
      upsert.run(brandId, e.section || 'general', e.key, value,
        e.sourceUrl ? String(e.sourceUrl).trim() : null, Number(e.sortOrder) || 100);
      saved += 1;
    });
  })();
  return saved;
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: `${f.title} — ${run.target}`,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:schema:${run.id}:${f.check_key}`,
      category: 'Structured data',
      severity: f.severity,
      affectedUrl: f.affected_url || run.target,
      evidence: f.evidence,
      dedupeKey: `aiseo:schema:${f.check_key}:${f.affected_url || run.target}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, TYPE_RULES, canonicalType, extractNodes, validateNode,
  generateFromPage, renderLlmsTxt, contentSections, reviewBrandHub, saveFacts,
};
