// PAGE TYPE — what kind of page is this, and therefore which schema fits.
//
// THE BUG THIS FIXES
// ./schemaAuto.js generated schema from three signals: a breadcrumb trail, a
// run of question-shaped headings, and "over 400 words inside <article> with
// one H1". Nothing in that decides whether the page sells a PRODUCT or
// describes a SERVICE, so a service page with a price on it was being handed
// Product markup. Product on a service page is not a near-miss: Product
// requires an offer with a price and availability for a thing that can be
// bought and shipped, Google validates it as such, and marking up a
// consultancy engagement as a Product is the kind of mismatch that gets
// structured data ignored sitewide.
//
// HOW THE TYPE IS DECIDED
// Weighted evidence from four independent places, scored and reported:
//   URL PATH      /services/, /product/, /blog/, /about, /contact — the
//                 strongest single signal, because it is a deliberate
//                 architectural choice rather than a coincidence of wording.
//   COMMERCE DOM  a price near an add-to-cart control, an SKU, a variant
//                 selector, a stock message. This is what separates a real
//                 product page from a service page that quotes a fee: the
//                 TRANSACTION APPARATUS, not the presence of a number.
//   HEADINGS      what the page's own outline says it is about.
//   EXISTING MARKUP  what the site already claims. Read as evidence, not as
//                 truth — the whole point of the check is that the existing
//                 claim may be wrong — but a site that marks every page
//                 Product is telling us something about its CMS.
//
// Every type comes back with its score and the evidence that produced it, so a
// disagreement with the classification is arguable rather than opaque. And
// where the top two scores are close, `confident` is false and the schema
// generator asks rather than asserts.
const boilerplate = require('./boilerplate');

// The types this module distinguishes, and the schema.org types each one
// legitimately supports. `never` is the important column: it is what stops a
// wrong suggestion, and each entry says why.
const PAGE_TYPES = {
  product: {
    label: 'Product page',
    schema: ['Product', 'Offer', 'BreadcrumbList', 'AggregateRating', 'Review'],
    also: ['Organization', 'WebSite', 'WebPage'],
    never: { Service: 'a page selling a specific purchasable item is a Product, not a Service' },
    requires: 'a price AND a purchase control (add to cart, buy now, a variant selector) or an SKU',
  },
  service: {
    label: 'Service page',
    schema: ['Service', 'Offer', 'BreadcrumbList', 'FAQPage'],
    also: ['Organization', 'LocalBusiness', 'WebSite', 'WebPage'],
    never: {
      Product: 'Product requires a purchasable item with an offer, price and availability. A service described on a page — even one with a fee — is a Service. Google validates Product against retail expectations and a mismatched Product block is commonly ignored across the whole site.',
      Article: 'a service page is a commercial landing page, not editorial content; Article markup on it misrepresents the page to every AI answer engine',
    },
    requires: 'a described offering with no purchase apparatus',
  },
  localBusiness: {
    label: 'Location / branch page',
    schema: ['LocalBusiness', 'PostalAddress', 'OpeningHoursSpecification', 'GeoCoordinates', 'BreadcrumbList'],
    also: ['Organization', 'Service', 'WebPage'],
    never: { Product: 'a location page describes a place, not a purchasable item' },
    requires: 'an address, and usually hours or a map',
  },
  article: {
    label: 'Article / blog post',
    schema: ['Article', 'BlogPosting', 'Person', 'BreadcrumbList'],
    also: ['Organization', 'WebSite', 'FAQPage', 'WebPage'],
    never: {
      Product: 'editorial content is not a purchasable item, whatever it reviews',
      Service: 'an article about a service is not the service',
    },
    requires: 'substantial prose with a single subject, usually a byline or date',
  },
  faq: {
    label: 'FAQ page',
    schema: ['FAQPage', 'Question', 'Answer', 'BreadcrumbList'],
    also: ['Organization', 'WebSite', 'WebPage'],
    never: {},
    requires: 'visible question/answer pairs',
  },
  category: {
    label: 'Category / listing page',
    schema: ['CollectionPage', 'ItemList', 'BreadcrumbList'],
    also: ['Organization', 'WebSite', 'WebPage'],
    never: {
      Product: 'a listing of many products is an ItemList or CollectionPage. Product markup on a category page claims the whole page is one item.',
      Article: 'a listing page has no single editorial subject',
    },
    requires: 'many links to sibling pages, little unique prose',
  },
  contact: {
    label: 'Contact page',
    schema: ['ContactPage', 'Organization', 'PostalAddress', 'ContactPoint'],
    also: ['LocalBusiness', 'BreadcrumbList', 'WebPage'],
    never: { Product: 'nothing on a contact page is purchasable', Article: 'a contact page is not editorial' },
    requires: 'a form, a phone number or an address as the page purpose',
  },
  about: {
    label: 'About page',
    schema: ['AboutPage', 'Organization', 'Person'],
    also: ['BreadcrumbList', 'WebSite', 'WebPage'],
    never: { Product: 'nothing on an about page is purchasable' },
    requires: 'the organisation or its people as the subject',
  },
  course: {
    label: 'Course / certification page',
    schema: ['Course', 'CourseInstance', 'EducationalOccupationalCredential', 'Offer', 'BreadcrumbList', 'FAQPage'],
    also: ['Organization', 'EducationalOrganization', 'WebPage'],
    never: {
      Product: 'a course is a Course; Product markup loses educationalCredentialAwarded and provider, which are the two things a course page exists to state',
    },
    requires: 'a syllabus, a credential or an enrolment path',
  },
  homepage: {
    label: 'Homepage',
    schema: ['Organization', 'WebSite', 'LocalBusiness'],
    also: ['Service', 'BreadcrumbList', 'WebPage'],
    never: {
      Product: 'a homepage is not one purchasable item',
      Article: 'a homepage has no single editorial subject',
    },
    requires: 'the site root',
  },
  pricing: {
    label: 'Pricing page',
    schema: ['Service', 'Offer', 'PriceSpecification', 'FAQPage', 'BreadcrumbList'],
    also: ['Organization', 'Product', 'WebPage'],
    never: { Article: 'a pricing page is commercial, not editorial' },
    requires: 'tiers or a price table as the page purpose',
  },
  other: {
    label: 'Unclassified page',
    schema: ['BreadcrumbList', 'WebPage'],
    also: ['Organization', 'WebSite', 'WebPage'],
    never: {},
    requires: null,
  },
};

// URL-path evidence. Weight 40 — the heaviest single signal.
const PATH_SIGNALS = [
  { type: 'product', rx: /\/(?:product|products|shop|store|item|items|p)\/[^/]+/i, weight: 40, why: 'the URL sits under a product path with a specific item slug' },
  { type: 'category', rx: /\/(?:category|categories|collections?|shop|catalog|browse|tag|tags)\/?$|\/(?:category|collections?|tag)\//i, weight: 32, why: 'the URL is a category or collection path' },
  { type: 'service', rx: /\/(?:services?|solutions?|what-we-do|capabilities|expertise|practice-areas?|offerings?)\//i, weight: 38, why: 'the URL sits under a services path' },
  { type: 'article', rx: /\/(?:blog|news|articles?|insights?|resources?|posts?|stories|guides?|journal)\//i, weight: 36, why: 'the URL sits under an editorial path' },
  { type: 'article', rx: /\/(?:19|20)\d{2}\/\d{2}\//, weight: 30, why: 'the URL carries a date, which is a blog-post convention' },
  { type: 'course', rx: /\/(?:courses?|training|certifications?|programmes?|programs?|qualifications?|diplomas?|classes)\//i, weight: 38, why: 'the URL sits under a course or certification path' },
  { type: 'localBusiness', rx: /\/(?:locations?|branch(?:es)?|stores?|offices?|clinics?|find-us|areas?-we-serve|service-areas?)\//i, weight: 36, why: 'the URL sits under a locations path' },
  { type: 'contact', rx: /\/contact(?:-us)?\/?$|\/get-in-touch\/?$|\/enquir(?:y|ies)\/?$/i, weight: 45, why: 'the URL is the contact page' },
  { type: 'about', rx: /\/about(?:-us)?\/?$|\/who-we-are\/?$|\/our-(?:story|team|people)\/?$|\/team\/?$/i, weight: 42, why: 'the URL is the about page' },
  { type: 'faq', rx: /\/faqs?\/?$|\/frequently-asked/i, weight: 42, why: 'the URL is the FAQ page' },
  { type: 'pricing', rx: /\/(?:pricing|prices|plans|packages|rates|fees|cost)\/?$/i, weight: 42, why: 'the URL is the pricing page' },
];

// Commerce apparatus. This is the discriminator that was missing.
function commerceSignals(doc) {
  const $ = doc && doc.$;
  const found = [];
  if (!$) return { found, score: 0 };

  const text = String(doc.mainText || doc.bodyText || '');
  const html = (() => { try { return $.html(); } catch { return ''; } })();

  const add = (key, weight, why) => found.push({ key, weight, why });

  // A purchase control. Matched on the visible label of a button or a link,
  // which is what a shopper clicks — not on a class name, which any theme may
  // carry on a page that sells nothing.
  const purchaseLabels = /(add to (?:cart|basket|bag)|buy now|buy it now|add to trolley|proceed to checkout|order now)/i;
  let hasPurchase = false;
  $('button, a, input[type="submit"]').each((_, el) => {
    if (hasPurchase) return;
    const label = `${$(el).text()} ${$(el).attr('value') || ''} ${$(el).attr('aria-label') || ''}`;
    if (purchaseLabels.test(label)) hasPurchase = true;
  });
  if (hasPurchase) add('purchase_control', 30, 'a purchase control (add to cart / buy now) is present');

  // An SKU or product code, labelled as such.
  if (/\b(?:sku|mpn|gtin|ean|upc|isbn|part\s*(?:no|number)|model\s*(?:no|number)|product\s*code)\b\s*[:#]?\s*[\w-]{3,}/i.test(text)) {
    add('sku', 22, 'a labelled SKU, MPN, GTIN or product code appears in the content');
  }

  // A variant selector — size, colour, quantity.
  if ($('select[name*="variant" i], select[name*="size" i], select[name*="colour" i], select[name*="color" i], [data-variant-id], input[name="quantity"], select[name="quantity"]').length) {
    add('variant_selector', 18, 'a variant or quantity selector is present');
  }

  // A stock or availability statement.
  if (/\b(?:in stock|out of stock|only \d+ left|\d+ in stock|backorder|pre-?order|ships? (?:in|within)|free (?:delivery|shipping))\b/i.test(text)) {
    add('availability', 14, 'a stock or shipping statement appears in the content');
  }

  // Ecommerce platform markers in the served HTML.
  if (/Shopify\.theme|cdn\.shopify|woocommerce|wc-block|BigCommerce|magento|Snipcart|squarespace-commerce/i.test(html)) {
    add('ecommerce_platform', 12, 'the page carries e-commerce platform markup');
  }

  // A price. Deliberately the WEAKEST commerce signal, and worth almost
  // nothing on its own: service pages, pricing pages and course pages all
  // quote prices. Its job is to confirm a purchase control, not to imply one.
  const priceCount = (text.match(/[$£€¥₹]\s?\d[\d,]*(?:\.\d{2})?/g) || []).length;
  if (priceCount) add('price', priceCount >= 1 && hasPurchase ? 10 : 3, `${priceCount} price${priceCount === 1 ? '' : 's'} in the content (weak on its own — service and pricing pages quote prices too)`);

  return { found, score: found.reduce((a, f) => a + f.weight, 0), priceCount, hasPurchase };
}

// Heading and content evidence.
function contentSignals(doc) {
  const found = [];
  const headings = (doc && doc.headings) || [];
  const h = headings.map((x) => String(x.text || '').toLowerCase());
  const joined = h.join(' | ');
  const text = String((doc && doc.mainText) || '').toLowerCase();
  const words = doc ? doc.wordCount : 0;

  const add = (type, weight, why) => found.push({ type, weight, why });

  const questionHeadings = headings.filter((x) => x.level >= 2
    && (String(x.text).trim().endsWith('?') || /^(what|why|how|when|where|which|who|can|do|does|is|are|should|will)\b/i.test(x.text)));
  if (questionHeadings.length >= 4) add('faq', 26, `${questionHeadings.length} question-shaped subheadings`);
  else if (questionHeadings.length >= 2) add('faq', 8, `${questionHeadings.length} question-shaped subheadings — enough for an FAQ section, not necessarily an FAQ page`);

  if (/\b(?:syllabus|curriculum|learning outcomes?|modules?|units?|accredit|credential|exam|assessment|enrol|enroll|cpd|ceu|prerequisite)\b/.test(text)
    && /\b(?:course|training|certification|programme|program|diploma|qualification)\b/.test(`${joined} ${text.slice(0, 3000)}`)) {
    add('course', 28, 'the content names a syllabus, credential or enrolment path alongside course language');
  }

  if (/\b(?:our (?:services|solutions)|we (?:offer|provide|deliver|specialise|specialize)|what (?:we|you) get|how (?:we|it) works?|scope of work|our approach)\b/.test(text)) {
    add('service', 18, 'the content describes an offering in service language');
  }

  if (/\b(?:opening hours|monday|mon\s*[-–]\s*fri|find us|parking|directions|located (?:at|in)|our address)\b/.test(text)
    && /\b(?:street|road|avenue|suite|floor|postcode|zip|city)\b/i.test(text)) {
    add('localBusiness', 22, 'the content carries an address alongside hours or directions');
  }

  if (/\b(?:per month|per year|per user|per seat|\/mo\b|\/yr\b|billed (?:monthly|annually)|most popular|best value|choose (?:your )?plan|compare plans)\b/.test(text)) {
    add('pricing', 20, 'the content reads as a plan or tier comparison');
  }

  if (doc && doc.semantic && doc.semantic.article && words > 500) add('article', 18, `${words} words inside an <article> element`);
  if (/\b(?:posted|published|written by|by\s+[A-Z][a-z]+\s+[A-Z][a-z]+|min read|reading time|last updated)\b/i.test(String((doc && doc.mainText) || '').slice(0, 2000))) {
    add('article', 16, 'a byline, publication date or reading time appears near the top of the content');
  }

  // A listing page: many internal links inside the main region, little prose.
  if (doc && doc.links) {
    const mainInternal = doc.links.filter((l) => l.internal && l.inMain).length;
    if (mainInternal >= 15 && words < 500) {
      add('category', 30, `${mainInternal} internal links inside the main content region against only ${words} words of prose — the page's content IS its links`);
    } else if (mainInternal >= 25 && words < 900) {
      add('category', 18, `${mainInternal} internal links in the main region with ${words} words of prose`);
    }
  }

  if (doc && doc.$) {
    try {
      const forms = doc.$('form').filter((_, el) => {
        const t = `${doc.$(el).attr('action') || ''} ${doc.$(el).attr('id') || ''} ${doc.$(el).attr('class') || ''} ${doc.$(el).text()}`;
        return !/search/i.test(t);
      }).length;
      const tel = doc.$('a[href^="tel:"]').length;
      const mailto = doc.$('a[href^="mailto:"]').length;
      if (forms && (tel || mailto) && words < 600) add('contact', 24, 'a non-search form with a phone or email link and little prose');
      else if (forms && (tel || mailto)) add('contact', 8, 'a contact form with a phone or email link');
    } catch { /* skip */ }
  }

  if (/\b(?:founded in|established in|our (?:story|history|mission|values|team)|since \d{4}|we are a|our people)\b/.test(text)) {
    add('about', 18, 'the content narrates the organisation itself');
  }

  return found;
}

// Pulls @type values out of a JSON-LD node, following @graph.
//
// Duplicated from ./onpage.js rather than imported, deliberately: onpage.js
// requires the database, and this module is required by the schema generator,
// the tracking catalog and the verification suite, none of which should open
// data/app.db as a side effect of asking "what kind of page is this". The WASM
// SQLite driver here is single-writer and a second opener has corrupted the
// file before, so a stray require is not a harmless one.
function schemaTypesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => schemaTypesOf(n, out)); return out; }
  if (node['@type']) {
    const t = node['@type'];
    (Array.isArray(t) ? t : [t]).forEach((x) => out.push(String(x)));
  }
  if (Array.isArray(node['@graph'])) node['@graph'].forEach((n) => schemaTypesOf(n, out));
  return out;
}

// ------------------------------------------------------------------ classify

function classify(doc, { brand = null } = {}) {
  const scores = new Map(Object.keys(PAGE_TYPES).map((k) => [k, 0]));
  const evidence = [];
  const add = (type, weight, why, source) => {
    if (!scores.has(type)) return;
    scores.set(type, scores.get(type) + weight);
    evidence.push({ type, weight, why, source });
  };

  let path = '/';
  let isRoot = false;
  try {
    const u = new URL(doc.url);
    path = u.pathname || '/';
    isRoot = path === '/' || path === '';
  } catch { /* a draft has no URL */ }

  if (isRoot) add('homepage', 60, 'the URL is the site root', 'url');

  PATH_SIGNALS.forEach((sig) => {
    if (sig.rx.test(path)) add(sig.type, sig.weight, sig.why, 'url');
  });

  const commerce = commerceSignals(doc);
  // The commerce apparatus only argues for `product` when a PURCHASE CONTROL
  // or an SKU is present. A price alone argues for nothing — this is the exact
  // inversion that produced the Product-on-a-service-page bug.
  const strongCommerce = commerce.found.filter((f) => ['purchase_control', 'sku', 'variant_selector'].includes(f.key));
  if (strongCommerce.length) {
    strongCommerce.forEach((f) => add('product', f.weight, f.why, 'commerce'));
    commerce.found.filter((f) => !strongCommerce.includes(f)).forEach((f) => add('product', Math.min(8, f.weight), f.why, 'commerce'));
  } else if (commerce.found.length) {
    // Weak commerce signals with no purchase apparatus. Recorded as evidence
    // AGAINST product, because that is what they are.
    evidence.push({
      type: 'product',
      weight: 0,
      why: `${commerce.found.map((f) => f.why).join('; ')} — but no purchase control, SKU or variant selector, so this is not a product page`,
      source: 'commerce',
      counterEvidence: true,
    });
  }

  contentSignals(doc).forEach((s) => add(s.type, s.weight, s.why, 'content'));

  // Existing markup, read as a weak hint.
  const declared = new Set((doc.jsonLd || []).filter((j) => j.ok)
    .flatMap((j) => schemaTypesOf(j.data))
    .map((t) => String(t)));
  const markupHints = {
    Product: 'product', Service: 'service', Course: 'course', FAQPage: 'faq',
    Article: 'article', BlogPosting: 'article', NewsArticle: 'article',
    LocalBusiness: 'localBusiness', ContactPage: 'contact', AboutPage: 'about',
    CollectionPage: 'category', ItemList: 'category',
  };
  declared.forEach((t) => {
    const mapped = markupHints[t];
    if (mapped) add(mapped, 6, `the page already declares ${t} markup (weak evidence — the point of this check is that the existing claim may be wrong)`, 'existing-markup');
  });

  const ranked = [...scores.entries()]
    .map(([type, score]) => ({ type, score, label: PAGE_TYPES[type].label }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] || { type: 'other', score: 0, label: PAGE_TYPES.other.label };
  const second = ranked[1] || null;
  // "Confident" means the winner clears the runner-up by a real margin. When it
  // does not, the schema generator offers both rather than asserting one.
  const margin = second ? top.score - second.score : top.score;
  const confident = top.score >= 25 && margin >= 12;

  const rule = PAGE_TYPES[top.type];
  return {
    type: top.type,
    label: rule.label,
    score: top.score,
    confident,
    margin,
    runnerUp: second,
    ranked,
    evidence: evidence.sort((a, b) => b.weight - a.weight),
    commerce,
    // What the generator is allowed to produce, and what it must not.
    allowedSchema: [...new Set([...rule.schema, ...rule.also])],
    primarySchema: rule.schema,
    forbiddenSchema: rule.never,
    requires: rule.requires,
    declaredTypes: [...declared],
    // Types the page currently declares that its own content contradicts.
    // This is the check the user actually asked for.
    mismatches: [...declared].map((t) => {
      const reason = rule.never[t];
      return reason ? { declared: t, pageType: top.type, pageLabel: rule.label, reason } : null;
    }).filter(Boolean),
  };
}

module.exports = {
  classify, PAGE_TYPES, PATH_SIGNALS, commerceSignals, contentSignals, schemaTypesOf,
};
