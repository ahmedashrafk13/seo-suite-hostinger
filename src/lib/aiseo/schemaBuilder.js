// SCHEMA BUILDER — the FINAL block, per type, ready to paste.
//
// WHAT WAS ASKED FOR AND WHY IT NEEDED A NEW MODULE
// ./schemaAuto.js already generated schema, but it generated FRAGMENTS with
// `null` where a value could not be read off the page, and it decided what to
// generate from three narrow signals that could not tell a service page from a
// product page. Two things follow from that:
//
//   1. A block containing `"datePublished": null` is not pasteable. Google
//      treats an explicit null as a malformed value — worse than an absent
//      property, which it simply ignores. So a fragment with nulls was more
//      dangerous than no output.
//   2. Nine separate half-blocks with no guidance on how to combine them is
//      not a deliverable. Real sites emit ONE @graph with cross-referenced
//      @id values, because that is how an entity graph is expressed — a
//      standalone Article block with a standalone Organization block beside it
//      states two unlinked facts instead of "this article was published by
//      this organisation".
//
// SO THIS MODULE PRODUCES, PER TYPE:
//   final        a complete block with every unknowable property OMITTED
//                rather than nulled, so it can be pasted as-is and is valid.
//   placeholders the properties that were omitted, each with the exact value
//                shape expected and where to get it. Rendered as a checklist
//                beside the block rather than smuggled into it.
//   graph        one combined @graph with @id cross-references wired up, which
//                is what actually goes on the page.
//
// AND IT ONLY PRODUCES WHAT THE PAGE TYPE PERMITS. ./pageType.js decides the
// type; anything on that type's `never` list is not generated at all, and the
// reason is reported instead. That is the fix for "suggesting Product schema on
// a service page".
const pageTypeLib = require('./pageType');
const boilerplate = require('./boilerplate');

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// Strips undefined, null, empty strings and empty arrays, recursively.
//
// This is the function that makes the output pasteable. It runs last, on a
// fully-assembled object, so a builder can write a property unconditionally
// and let this decide whether it survives.
function prune(value) {
  if (Array.isArray(value)) {
    const out = value.map(prune).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    });
    // An object left holding only its @type says nothing and is dropped.
    const meaningful = Object.keys(out).filter((k) => k !== '@type' && k !== '@context');
    return meaningful.length ? out : undefined;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  return value;
}

// A placeholder record. `shape` is what the value must look like, because
// "add datePublished" without "in ISO 8601 with a timezone offset" is how a
// date lands as "12 March 2024" and silently fails validation.
function ph(property, shape, where, required = false) {
  return { property, shape, where, required };
}

// ------------------------------------------------------------- fact plumbing

function factMap(facts) {
  return new Map((facts || []).map((f) => [f.fact_key || f.key, f.fact_value != null ? f.fact_value : f.value]));
}

function orgNode(brand, facts, { asRef = false } = {}) {
  const fm = factMap(facts);
  const site = brand ? String(brand.site_url || '') : '';
  const origin = originOf(site) || site || null;
  const id = origin ? `${origin}/#organization` : undefined;
  if (asRef) return id ? { '@id': id } : undefined;

  const sameAs = String(fm.get('social_profiles') || '')
    .split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));

  return {
    '@type': fm.get('organization_type') || 'Organization',
    '@id': id,
    name: fm.get('legal_name') || (brand ? brand.name : undefined),
    url: origin,
    description: fm.get('what_we_do'),
    logo: fm.get('logo_url') ? { '@type': 'ImageObject', url: fm.get('logo_url') } : undefined,
    sameAs: sameAs.length ? sameAs : undefined,
    telephone: fm.get('phone'),
    email: fm.get('support_email'),
    foundingDate: fm.get('founded'),
    address: fm.get('street_address') ? {
      '@type': 'PostalAddress',
      streetAddress: fm.get('street_address'),
      addressLocality: fm.get('city'),
      addressRegion: fm.get('region'),
      postalCode: fm.get('postal_code'),
      addressCountry: fm.get('country'),
    } : undefined,
    areaServed: fm.get('service_area'),
    contactPoint: (fm.get('phone') || fm.get('support_email')) ? [{
      '@type': 'ContactPoint',
      contactType: 'customer support',
      telephone: fm.get('phone'),
      email: fm.get('support_email'),
      areaServed: fm.get('service_area'),
      availableLanguage: fm.get('languages'),
    }] : undefined,
  };
}

function webPageId(url) { return `${String(url).split('#')[0]}#webpage`; }

// ----------------------------------------------------------------- builders
//
// One builder per type. Each returns { jsonld, placeholders, basis, notes }
// and each reads ONLY from the page and the declared brand facts.

const BUILDERS = {
  Organization(ctx) {
    const node = orgNode(ctx.brand, ctx.facts);
    const fm = factMap(ctx.facts);
    const placeholders = [];
    if (!fm.get('logo_url')) placeholders.push(ph('logo.url', 'an absolute HTTPS URL to a square image, at least 112×112px', 'declare logo_url on the brand hub', false));
    if (!fm.get('social_profiles')) placeholders.push(ph('sameAs', 'an array of absolute profile URLs (LinkedIn, X, Facebook, Crunchbase, Wikidata)', 'declare social_profiles on the brand hub — this is the strongest entity-disambiguation signal in markup', false));
    if (!fm.get('what_we_do')) placeholders.push(ph('description', 'one or two sentences stating what the organisation does', 'declare what_we_do on the brand hub', false));
    if (!fm.get('legal_name')) placeholders.push(ph('name', 'the registered legal name', 'declare legal_name on the brand hub; the trading name is used until then', false));
    return {
      jsonld: node,
      placeholders,
      basis: `assembled from ${factMap(ctx.facts).size} declared brand fact${factMap(ctx.facts).size === 1 ? '' : 's'}`,
      notes: 'Belongs sitewide, not on one page. Emit it once in the shared layout so every page carries the same @id.',
    };
  },

  WebSite(ctx) {
    const origin = originOf(ctx.doc.url);
    return {
      jsonld: {
        '@type': 'WebSite',
        '@id': origin ? `${origin}/#website` : undefined,
        name: ctx.brand ? ctx.brand.name : undefined,
        url: origin,
        publisher: orgNode(ctx.brand, ctx.facts, { asRef: true }),
        inLanguage: ctx.doc.lang || undefined,
      },
      placeholders: [
        ph('potentialAction', '{"@type":"SearchAction","target":{"@type":"EntryPoint","urlTemplate":"' + (origin || 'https://example.com') + '/?s={search_term_string}"},"query-input":"required name=search_term_string"}',
          'add ONLY if the site has a working search endpoint at that URL — claiming a sitelinks search box the site cannot serve is worse than omitting it', false),
      ],
      basis: 'the site origin and the brand name',
      notes: 'Sitewide, like Organization.',
    };
  },

  BreadcrumbList(ctx) {
    const trail = (ctx.doc.breadcrumbTrail && ctx.doc.breadcrumbTrail.trail) || [];
    if (trail.length < 2) return null;
    return {
      jsonld: {
        '@type': 'BreadcrumbList',
        '@id': `${String(ctx.doc.url).split('#')[0]}#breadcrumb`,
        itemListElement: trail.map((name, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name,
          // Only the last item's URL is knowable from the trail text. An
          // invented intermediate URL renders a breadcrumb pointing at a 404,
          // so the property is omitted and listed as a placeholder instead.
          item: i === trail.length - 1 ? String(ctx.doc.url).split('#')[0] : undefined,
        })),
      },
      placeholders: trail.length > 2
        ? [ph('itemListElement[n].item', 'the absolute URL of each intermediate level',
          `read from the site's own navigation — the trail text ("${trail.slice(0, -1).join(' › ')}") does not carry URLs, and a guessed one links to a 404`, true)]
        : [],
      basis: `read from the page's ${ctx.doc.breadcrumbTrail.source} breadcrumbs`,
    };
  },

  Service(ctx) {
    const name = (ctx.doc.h1s[0] || ctx.doc.title || '').split(/\s+[|–—·]\s+/)[0].trim();
    const fm = factMap(ctx.facts);
    return {
      jsonld: {
        '@type': 'Service',
        '@id': `${String(ctx.doc.url).split('#')[0]}#service`,
        name: name || undefined,
        description: ctx.doc.metaDesc || undefined,
        url: String(ctx.doc.url).split('#')[0],
        provider: orgNode(ctx.brand, ctx.facts, { asRef: true }) || (ctx.brand ? { '@type': 'Organization', name: ctx.brand.name } : undefined),
        areaServed: fm.get('service_area') || undefined,
        serviceType: name || undefined,
        mainEntityOfPage: { '@id': webPageId(ctx.doc.url) },
      },
      placeholders: [
        ...(ctx.doc.metaDesc ? [] : [ph('description', 'one or two sentences describing the service', 'write a meta description for this page; the same sentence serves both', false)]),
        ...(fm.get('service_area') ? [] : [ph('areaServed', 'a country, region or city name, or an array of them', 'declare service_area on the brand hub', false)]),
        ph('offers', '{"@type":"Offer","priceCurrency":"GBP","price":"1200","priceSpecification":{"@type":"PriceSpecification","minPrice":"1200"}}',
          'add only if a real price or minimum is published on the page. Omit it entirely for "contact us for a quote" — an Offer with no price is worse than no Offer.', false),
      ],
      basis: `the page's H1 and meta description, classified as a ${ctx.pageType.label} by ${ctx.pageType.evidence.filter((e) => e.type === 'service').length} signal(s)`,
      notes: 'Service has no rich result. It is worth emitting because it states plainly what the business does and for whom, which is what an AI answer engine reads to decide the brand is relevant.',
    };
  },

  Product(ctx) {
    const name = (ctx.doc.h1s[0] || ctx.doc.title || '').split(/\s+[|–—·]\s+/)[0].trim();
    const text = String(ctx.doc.mainText || '');
    const skuMatch = /\b(?:sku|mpn|part\s*(?:no|number)|product\s*code)\b\s*[:#]?\s*([\w-]{3,})/i.exec(text);
    const priceMatch = /([$£€¥₹])\s?(\d[\d,]*(?:\.\d{2})?)/.exec(text);
    const currencyOf = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' };
    const availability = /out of stock|sold out/i.test(text) ? 'https://schema.org/OutOfStock'
      : (/in stock|ships? (?:in|within)/i.test(text) ? 'https://schema.org/InStock' : undefined);

    return {
      jsonld: {
        '@type': 'Product',
        '@id': `${String(ctx.doc.url).split('#')[0]}#product`,
        name: name || undefined,
        description: ctx.doc.metaDesc || undefined,
        image: ctx.doc.openGraph.image ? [ctx.doc.openGraph.image] : undefined,
        sku: skuMatch ? skuMatch[1] : undefined,
        brand: ctx.brand ? { '@type': 'Brand', name: ctx.brand.name } : undefined,
        offers: priceMatch ? {
          '@type': 'Offer',
          url: String(ctx.doc.url).split('#')[0],
          price: priceMatch[2].replace(/,/g, ''),
          priceCurrency: currencyOf[priceMatch[1]],
          availability,
          seller: orgNode(ctx.brand, ctx.facts, { asRef: true }),
        } : undefined,
      },
      placeholders: [
        ...(priceMatch ? [] : [ph('offers', '{"@type":"Offer","price":"99.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"<this page>"}',
          'no price could be read from the page. Product is INELIGIBLE for a rich result without offers, review or aggregateRating.', true)]),
        ...(availability || !priceMatch ? [] : [ph('offers.availability', 'https://schema.org/InStock or /OutOfStock', 'read from live stock state — a hardcoded InStock on a sold-out product is a policy problem', true)]),
        ...(ctx.doc.openGraph.image ? [] : [ph('image', 'an array of absolute image URLs, 1200px on the long edge, in 16×9, 4×3 and 1×1 crops', 'the product photography on this page', true)]),
        ...(skuMatch ? [] : [ph('sku / gtin13 / mpn', 'the product identifier as a string', 'the product record in the catalogue', false)]),
        ph('aggregateRating', '{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"128"}',
          'ONLY from ratings genuinely collected AND displayed on this page. Inventing an aggregateRating is the most commonly penalised structured-data abuse there is.', false),
      ],
      basis: `commerce apparatus detected: ${ctx.pageType.commerce.found.map((f) => f.key).join(', ') || 'none'}`,
      notes: 'Generated only because a purchase control, SKU or variant selector is present on the page. A price alone is not enough — service and pricing pages quote prices too.',
    };
  },

  Course(ctx) {
    const name = (ctx.doc.h1s[0] || ctx.doc.title || '').split(/\s+[|–—·]\s+/)[0].trim();
    const fm = factMap(ctx.facts);
    return {
      jsonld: {
        '@type': 'Course',
        '@id': `${String(ctx.doc.url).split('#')[0]}#course`,
        name: name || undefined,
        description: ctx.doc.metaDesc || undefined,
        url: String(ctx.doc.url).split('#')[0],
        provider: orgNode(ctx.brand, ctx.facts, { asRef: true }) || (ctx.brand ? { '@type': 'Organization', name: ctx.brand.name } : undefined),
        educationalCredentialAwarded: fm.get('accreditations') || undefined,
        inLanguage: ctx.doc.lang || undefined,
      },
      placeholders: [
        ph('hasCourseInstance', '{"@type":"CourseInstance","courseMode":"online","courseWorkload":"PT40H","instructor":{"@type":"Person","name":"…"}}',
          'at least one instance is required for the course rich result: delivery mode, workload in ISO 8601 duration, and the instructor', true),
        ph('offers', '{"@type":"Offer","price":"1495","priceCurrency":"GBP","category":"Paid"}', 'the enrolment fee as published on the page', false),
        ...(fm.get('accreditations') ? [] : [ph('educationalCredentialAwarded', 'the exact name of the credential the learner ends up holding', 'declare accreditations on the brand hub, or read it from the syllabus', false)]),
      ],
      basis: 'syllabus, credential or enrolment language present alongside course wording',
      notes: 'educationalCredentialAwarded and provider are the two properties a certification page exists to state, and both are lost if this is marked up as a Product.',
    };
  },

  Article(ctx) {
    const headline = (ctx.doc.h1s[0] || ctx.doc.title || '').slice(0, 110);
    // A visible date, if the page publishes one. Read, never guessed.
    const dateText = String(ctx.doc.mainText || '').slice(0, 3000);
    const isoInText = /\b((?:19|20)\d{2}-\d{2}-\d{2})\b/.exec(dateText);
    const timeAttr = (() => {
      try { return ctx.doc.$('time[datetime]').first().attr('datetime') || null; } catch { return null; }
    })();
    const published = timeAttr || (isoInText ? isoInText[1] : null);

    return {
      jsonld: {
        '@type': 'Article',
        '@id': `${String(ctx.doc.url).split('#')[0]}#article`,
        headline: headline || undefined,
        description: ctx.doc.metaDesc || undefined,
        image: ctx.doc.openGraph.image ? [ctx.doc.openGraph.image] : undefined,
        datePublished: published || undefined,
        dateModified: published || undefined,
        publisher: orgNode(ctx.brand, ctx.facts, { asRef: true }),
        mainEntityOfPage: { '@id': webPageId(ctx.doc.url) },
        inLanguage: ctx.doc.lang || undefined,
        wordCount: ctx.doc.wordCount || undefined,
      },
      placeholders: [
        ph('author', '{"@type":"Person","name":"Full Name","jobTitle":"…","url":"<author page>","sameAs":["<LinkedIn>"]}',
          'a Person object, not a bare string. For any page making professional claims this is the strongest experience signal available in markup.', true),
        ...(published ? [ph('dateModified', 'ISO 8601 with a timezone offset, e.g. 2026-08-29T09:30:00+01:00',
          `a date was read from the page (${published}) and used for BOTH datePublished and dateModified. Split them if the article has been revised.`, false)]
          : [ph('datePublished / dateModified', 'ISO 8601 with a timezone offset, e.g. 2026-08-29T09:30:00+01:00',
            'no date is visible on the page. Publish one — an AI answer engine cannot judge currency without it, and a correct undated page loses to a dated one.', true)]),
        ...(ctx.doc.openGraph.image ? [] : [ph('image', 'an array of absolute image URLs, at least 1200px wide', 'the article hero image', true)]),
      ],
      basis: `${ctx.doc.wordCount} words classified as ${ctx.pageType.label}`,
      notes: headline.length >= 110 ? 'headline was truncated to 110 characters — Google truncates beyond that.' : null,
    };
  },

  FAQPage(ctx) {
    // Question/answer pairs taken from the DOM in document order, so the answer
    // is the prose that actually follows its heading. This is the fix for the
    // old pairing-by-position approach, which could attach the wrong answer
    // text — a policy violation, not a cosmetic error.
    const pairs = [];
    if (ctx.doc.$) {
      const $ = ctx.doc.$;
      $('h2, h3, h4, dt, summary').each((_, el) => {
        const q = $(el).text().replace(/\s+/g, ' ').trim();
        if (!q || q.length < 8) return;
        const isQuestion = q.endsWith('?') || /^(what|why|how|when|where|which|who|can|do|does|is|are|should|will)\b/i.test(q);
        if (!isQuestion) return;
        if (boilerplate.isGenericUi(q)) return;

        // Walk forward collecting prose until the next heading of the same or
        // higher level.
        const level = /^h(\d)$/i.test(el.name) ? Number(el.name.slice(1)) : null;
        const parts = [];
        let node = $(el).next();
        // <dt> answers live in the following <dd>; <summary> answers in the
        // rest of its own <details>.
        if (el.name === 'dt') {
          const dd = $(el).nextAll('dd').first();
          if (dd.length) parts.push(dd.text().replace(/\s+/g, ' ').trim());
        } else if (el.name === 'summary') {
          const details = $(el).parent();
          const clone = details.clone();
          clone.find('summary').remove();
          parts.push(clone.text().replace(/\s+/g, ' ').trim());
        } else {
          let guard = 0;
          while (node.length && guard < 20) {
            const tag = (node[0].name || '').toLowerCase();
            const m = /^h(\d)$/.exec(tag);
            if (m && level != null && Number(m[1]) <= level) break;
            if (m && level == null) break;
            const t = node.text().replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
            node = node.next();
            guard += 1;
          }
        }
        const answer = parts.join(' ').replace(/\s+/g, ' ').trim();
        if (answer.length < 40) return;
        pairs.push({ question: q, answer: answer.slice(0, 1200) });
      });
    }
    if (pairs.length < 2) return null;

    return {
      jsonld: {
        '@type': 'FAQPage',
        '@id': `${String(ctx.doc.url).split('#')[0]}#faq`,
        mainEntity: pairs.slice(0, 25).map((p) => ({
          '@type': 'Question',
          name: p.question,
          acceptedAnswer: { '@type': 'Answer', text: p.answer },
        })),
      },
      placeholders: [],
      basis: `${pairs.length} question/answer pair${pairs.length === 1 ? '' : 's'} read from the page in document order — each answer is the prose that follows its own heading`,
      notes: 'Every question and answer here is VISIBLE on the page, which is the policy requirement. Verify the extracted answer text matches what a reader sees before publishing — the walk stops at the next heading of the same or higher level, which is right for normal markup and can over-collect where a section has no closing heading. FAQ rich results are now shown only for authoritative government and health sites; the markup remains valuable because AI answer engines read it.',
      verifyRequired: true,
    };
  },

  LocalBusiness(ctx) {
    const fm = factMap(ctx.facts);
    const text = String(ctx.doc.mainText || '');
    const phone = fm.get('phone') || (() => {
      try { return (ctx.doc.$('a[href^="tel:"]').first().attr('href') || '').replace(/^tel:/, '') || null; } catch { return null; }
    })();
    return {
      jsonld: {
        '@type': fm.get('organization_type') && /Business|Store|Service|Restaurant|Agent/i.test(fm.get('organization_type'))
          ? fm.get('organization_type') : 'LocalBusiness',
        '@id': `${String(ctx.doc.url).split('#')[0]}#localbusiness`,
        name: fm.get('legal_name') || (ctx.brand ? ctx.brand.name : undefined),
        url: String(ctx.doc.url).split('#')[0],
        telephone: phone || undefined,
        email: fm.get('support_email'),
        image: ctx.doc.openGraph.image || undefined,
        address: fm.get('street_address') ? {
          '@type': 'PostalAddress',
          streetAddress: fm.get('street_address'),
          addressLocality: fm.get('city'),
          addressRegion: fm.get('region'),
          postalCode: fm.get('postal_code'),
          addressCountry: fm.get('country'),
        } : undefined,
        areaServed: fm.get('service_area'),
        parentOrganization: orgNode(ctx.brand, ctx.facts, { asRef: true }),
      },
      placeholders: [
        ...(fm.get('street_address') ? [] : [ph('address', '{"@type":"PostalAddress","streetAddress":"…","addressLocality":"…","postalCode":"…","addressCountry":"GB"}',
          'REQUIRED. Declare street_address, city, region, postal_code and country on the brand hub. A string address validates but is far weaker for local matching.', true)]),
        ph('openingHoursSpecification', '[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday"],"opens":"09:00","closes":"17:30"}]',
          `read from the hours published on the page${/\bmon|\bopening hours/i.test(text) ? ' — hours language was detected in the content but cannot be parsed reliably enough to assert' : ''}`, false),
        ph('geo', '{"@type":"GeoCoordinates","latitude":51.5074,"longitude":-0.1278}', 'the coordinates of the premises', false),
        ph('priceRange', 'a short string such as "££" or "$$-$$$"', 'the typical spend at this location', false),
      ],
      basis: 'address, hours or directions language on the page, plus the declared brand facts',
    };
  },

  ContactPage(ctx) {
    return {
      jsonld: {
        '@type': 'ContactPage',
        '@id': webPageId(ctx.doc.url),
        url: String(ctx.doc.url).split('#')[0],
        name: ctx.doc.title || undefined,
        mainEntity: orgNode(ctx.brand, ctx.facts, { asRef: true }),
        isPartOf: originOf(ctx.doc.url) ? { '@id': `${originOf(ctx.doc.url)}/#website` } : undefined,
      },
      placeholders: [],
      basis: 'the page is the contact page',
      notes: 'ContactPage earns no rich result. It matters because it tells an AI engine which URL to give someone who asks how to reach the brand.',
    };
  },

  AboutPage(ctx) {
    return {
      jsonld: {
        '@type': 'AboutPage',
        '@id': webPageId(ctx.doc.url),
        url: String(ctx.doc.url).split('#')[0],
        name: ctx.doc.title || undefined,
        mainEntity: orgNode(ctx.brand, ctx.facts, { asRef: true }),
        isPartOf: originOf(ctx.doc.url) ? { '@id': `${originOf(ctx.doc.url)}/#website` } : undefined,
      },
      placeholders: [],
      basis: 'the page is the about page',
    };
  },

  CollectionPage(ctx) {
    const items = (ctx.doc.links || [])
      .filter((l) => l.internal && l.inMain && l.anchor && l.anchor.length > 2 && !boilerplate.isGenericUi(l.anchor))
      .reduce((acc, l) => {
        if (!acc.seen.has(l.url)) { acc.seen.add(l.url); acc.list.push(l); }
        return acc;
      }, { seen: new Set(), list: [] }).list;
    if (items.length < 5) return null;
    return {
      jsonld: {
        '@type': 'CollectionPage',
        '@id': webPageId(ctx.doc.url),
        url: String(ctx.doc.url).split('#')[0],
        name: (ctx.doc.h1s[0] || ctx.doc.title || '').split(/\s+[|–—·]\s+/)[0] || undefined,
        isPartOf: originOf(ctx.doc.url) ? { '@id': `${originOf(ctx.doc.url)}/#website` } : undefined,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: items.length,
          itemListElement: items.slice(0, 60).map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: l.url,
            name: l.anchor.slice(0, 120),
          })),
        },
      },
      placeholders: [],
      basis: `${items.length} distinct internal links inside the main content region, with their visible anchor text as the item names`,
      notes: 'A listing page is a CollectionPage wrapping an ItemList. Product markup here would claim the whole page is one purchasable item.',
    };
  },

  WebPage(ctx) {
    return {
      jsonld: {
        '@type': 'WebPage',
        '@id': webPageId(ctx.doc.url),
        url: String(ctx.doc.url).split('#')[0],
        name: ctx.doc.title || undefined,
        description: ctx.doc.metaDesc || undefined,
        inLanguage: ctx.doc.lang || undefined,
        isPartOf: originOf(ctx.doc.url) ? { '@id': `${originOf(ctx.doc.url)}/#website` } : undefined,
        breadcrumb: (ctx.doc.breadcrumbTrail && ctx.doc.breadcrumbTrail.trail.length >= 2)
          ? { '@id': `${String(ctx.doc.url).split('#')[0]}#breadcrumb` } : undefined,
        primaryImageOfPage: ctx.doc.openGraph.image ? { '@type': 'ImageObject', url: ctx.doc.openGraph.image } : undefined,
      },
      placeholders: [],
      basis: 'the page metadata',
      notes: 'The node every other block on the page hangs off through mainEntityOfPage. Cheap and always correct.',
    };
  },
};

// The order blocks are offered in: the page's own primary type first, then the
// structural ones, then sitewide. A practitioner works down the list.
const OFFER_ORDER = [
  'Product', 'Service', 'Course', 'Article', 'FAQPage', 'LocalBusiness',
  'CollectionPage', 'ContactPage', 'AboutPage', 'WebPage', 'BreadcrumbList',
  'Organization', 'WebSite',
];

// ------------------------------------------------------------------- build

// Builds every block the page type permits, plus the combined @graph.
//
// `wantedTypes` lets a user ask for a specific type explicitly. A request for
// a type the page type forbids is HONOURED but flagged — the practitioner may
// know something the classifier does not, and refusing outright would make the
// feature unusable on an edge case. What it will not do is generate a
// forbidden type unasked, which is the actual bug.
function build({ doc, brand = null, facts = [], wantedTypes = [], pageType = null }) {
  const pt = pageType || pageTypeLib.classify(doc, { brand });
  const allowed = new Set(pt.allowedSchema);
  const requested = new Set((wantedTypes || []).map(String));

  const blocks = [];
  const skipped = [];

  OFFER_ORDER.forEach((type) => {
    const builder = BUILDERS[type];
    if (!builder) return;

    const isAllowed = allowed.has(type);
    const isRequested = requested.has(type);
    const forbidReason = pt.forbiddenSchema[type] || null;

    if (!isAllowed && !isRequested) {
      if (forbidReason) {
        skipped.push({
          type,
          reason: forbidReason,
          because: `this page is a ${pt.label}`,
          overridable: true,
        });
      }
      return;
    }

    let out;
    try { out = builder({ doc, brand, facts, pageType: pt }); } catch (err) {
      skipped.push({ type, reason: `could not be generated: ${String(err.message).slice(0, 140)}`, because: 'builder error' });
      return;
    }
    if (!out) {
      skipped.push({
        type,
        reason: `the page does not carry what this type needs (${(pageTypeLib.PAGE_TYPES[pt.type] || {}).requires || 'the required content'}), so nothing was invented to fill it`,
        because: 'insufficient content on the page',
      });
      return;
    }

    // A SECONDARY type — one on the page type's `also` list rather than its
    // primary list — is only offered when it can be produced complete.
    // Offering a LocalBusiness block with no address on every service page is
    // noise: the practitioner cannot paste it, and it pushes the blocks they
    // CAN paste down the page. A primary type is always offered, incomplete or
    // not, because its absence is the finding.
    const isPrimary = (pt.primarySchema || []).includes(type) || isRequested;
    const requiredMissing = (out.placeholders || []).filter((x) => x.required);
    if (!isPrimary && requiredMissing.length) {
      skipped.push({
        type,
        reason: `optional for a ${pt.label}, and it cannot be produced complete: ${requiredMissing.map((x) => x.property).join(', ')} ${requiredMissing.length === 1 ? 'is' : 'are'} required and could not be read from the page. Ask for it explicitly to get the partial block.`,
        because: 'secondary type, incomplete',
        overridable: true,
      });
      return;
    }

    const pruned = prune(out.jsonld);
    if (!pruned) {
      skipped.push({ type, reason: 'every property would have been empty', because: 'no readable values' });
      return;
    }

    blocks.push({
      type,
      // The standalone, pasteable block: @context added, nulls gone.
      final: { '@context': 'https://schema.org', ...pruned },
      // The same node without @context, for the combined graph.
      node: pruned,
      placeholders: out.placeholders || [],
      requiredPlaceholders: (out.placeholders || []).filter((p) => p.required),
      basis: out.basis || null,
      notes: out.notes || null,
      verifyRequired: Boolean(out.verifyRequired),
      allowedForPageType: isAllowed,
      requestedExplicitly: isRequested && !isAllowed,
      forbiddenReason: isRequested && forbidReason ? forbidReason : null,
      json: JSON.stringify({ '@context': 'https://schema.org', ...pruned }, null, 2),
      script: `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', ...pruned }, null, 2)}\n</script>`,
    });
  });

  // The combined @graph — one script tag, cross-referenced by @id. This is what
  // actually goes on the page.
  const graphNodes = blocks
    // Organization and WebSite belong in the sitewide layout, so they are
    // included but flagged: a reader needs to know not to paste them per-page.
    .map((b) => b.node);
  const graph = graphNodes.length
    ? { '@context': 'https://schema.org', '@graph': graphNodes }
    : null;

  return {
    pageType: {
      type: pt.type,
      label: pt.label,
      score: pt.score,
      confident: pt.confident,
      margin: pt.margin,
      runnerUp: pt.runnerUp,
      evidence: pt.evidence.slice(0, 14),
      requires: pt.requires,
      commerce: pt.commerce,
      declaredTypes: pt.declaredTypes,
      mismatches: pt.mismatches,
    },
    blocks,
    skipped,
    graph,
    graphJson: graph ? JSON.stringify(graph, null, 2) : null,
    graphScript: graph ? `<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>` : null,
    sitewideTypes: blocks.filter((b) => ['Organization', 'WebSite'].includes(b.type)).map((b) => b.type),
    counts: {
      blocks: blocks.length,
      requiredPlaceholders: blocks.reduce((a, b) => a + b.requiredPlaceholders.length, 0),
      skipped: skipped.length,
      readyToPaste: blocks.filter((b) => !b.requiredPlaceholders.length).length,
    },
  };
}

module.exports = { build, prune, BUILDERS, OFFER_ORDER, orgNode, factMap };
