// 5. INTERNAL LINKING AND SITE ARCHITECTURE AUTOMATION
//
// Builds an entity/topic graph of the site, then uses it for the three things
// architecture work actually consists of: proposing internal links that a
// reader benefits from, identifying which pages should be hubs and which
// should be spokes, and checking that breadcrumbs express the hierarchy the
// links imply.
//
// HOW THIS DIFFERS FROM THE EXISTING /linking FEATURE
// The existing internal-linking crawler is a large, child-process job that
// sweeps a whole site and produces a spreadsheet of anchor-text
// recommendations. It is the right tool for a full audit and it is not
// replaced here.
//
// This is the graph view of the same data: which topics the site covers, which
// pages compete for the same topic, where the hierarchy is flat when it should
// be nested, and which pages nothing links to. Those questions need the whole
// link structure in memory at once, which is exactly what a CSV of pairs
// cannot give you.
//
// WHY LINKS ARE PROPOSED FROM ENTITY OVERLAP AND NOT KEYWORD MATCHING
// Matching a target page's keyword against a source page's body finds every
// page that happens to use the word, which on a well-written site is most of
// them. Overlap of NAMED ENTITIES is far more selective: two pages that both
// discuss "Basel III" and "capital adequacy" are genuinely related, whereas
// two pages that both contain "training" are not. The candidate list that
// comes out is short enough for a human to review, which is the only length
// that gets used.
const db = require('../../db');
const nlp = require('./nlp');
const store = require('./store');
const providers = require('./providers');
const aiCalls = require('./aiCalls');
const analytics = require('../analytics');
const { crawlSite, normalizeUrl, canonUrl } = require('./fetcher');

// A page's topic fingerprint: the entities it names and the phrases it repeats.
// Titles and headings are weighted more heavily than body text, because a page
// ABOUT something says it in a heading, while a page that merely mentions it
// says it once in a paragraph.
function fingerprint(page) {
  const doc = page.doc;
  const headingText = doc.headings.map((h) => h.text).join('. ');
  const weighted = `${doc.title || ''}. ${doc.title || ''}. ${headingText}. ${headingText}. ${doc.mainText || ''}`;
  const ents = nlp.entities(`${doc.title || ''}. ${headingText}. ${(doc.mainText || '').slice(0, 12000)}`);
  return {
    url: page.url,
    title: doc.title,
    depth: page.depth,
    wordCount: doc.wordCount,
    tf: nlp.termFrequency(weighted),
    entities: new Set(ents.filter((e) => e.type !== 'statistic').map((e) => e.surface.toLowerCase())),
    entityList: ents.slice(0, 30),
    phrases: nlp.keyPhrases(doc.mainText || '', { minCount: 2, limit: 15 }).map((p) => p.phrase),
    headings: doc.headings,
    breadcrumbTrail: doc.breadcrumbTrail,
    outLinks: doc.links.filter((l) => l.internal).map((l) => canonUrl(l.url)),
  };
}

// The link graph, keyed on canonical URL.
function buildGraph(pages) {
  const nodes = new Map();
  pages.filter((p) => p.ok && p.doc).forEach((p) => {
    const key = canonUrl(p.url);
    if (nodes.has(key)) return;
    nodes.set(key, { key, ...fingerprint(p), inLinks: new Set(), outLinksResolved: new Set() });
  });

  nodes.forEach((node) => {
    node.outLinks.forEach((targetKey) => {
      if (targetKey === node.key) return; // a self-link is not a link
      if (!nodes.has(targetKey)) return; // off-crawl target; not part of this graph
      node.outLinksResolved.add(targetKey);
      nodes.get(targetKey).inLinks.add(node.key);
    });
  });

  return nodes;
}

// Topic communities, by agglomerating pages whose entity sets overlap.
//
// A full clustering algorithm is overkill for 60-200 pages and would be harder
// to explain. This is single-link agglomeration with a fixed threshold: two
// pages join the same topic when their entity Jaccard overlap clears the bar.
// The result is reported with its own cohesion, so a loose community is
// visible as loose rather than presented as a finding.
function topicCommunities(nodes, { threshold = 0.22 } = {}) {
  const list = [...nodes.values()];
  const parent = new Map(list.map((n) => [n.key, n.key]));
  const find = (k) => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression, so a long chain does not make later lookups quadratic.
    let cur = k;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.entities.size < 3 || b.entities.size < 3) continue;
      const overlap = nlp.jaccard(a.entities, b.entities);
      if (overlap >= threshold) {
        union(a.key, b.key);
        pairs.push({ a: a.key, b: b.key, overlap });
      }
    }
  }

  const groups = new Map();
  list.forEach((n) => {
    const root = find(n.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  });

  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((members) => {
      // The hub is the member with the broadest entity coverage that also has
      // the shallowest depth — a topic's overview page is normally both.
      const scored = members.map((m) => ({
        node: m,
        breadth: m.entities.size,
        depth: m.depth,
        inbound: m.inLinks.size,
      })).sort((a, b) => (a.depth - b.depth) || (b.breadth - a.breadth) || (b.inbound - a.inbound));
      const hub = scored[0].node;
      const spokes = scored.slice(1).map((s) => s.node);

      // Shared entities across the whole community — the topic's actual name,
      // as far as the site expresses it.
      const counts = new Map();
      members.forEach((m) => m.entities.forEach((e) => counts.set(e, (counts.get(e) || 0) + 1)));
      const shared = [...counts.entries()]
        .filter(([, c]) => c >= Math.max(2, Math.ceil(members.length / 2)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([e]) => e);

      // How connected the community actually is: what share of the possible
      // internal links between its own members exist.
      let internalLinks = 0;
      const memberKeys = new Set(members.map((m) => m.key));
      members.forEach((m) => m.outLinksResolved.forEach((t) => { if (memberKeys.has(t)) internalLinks += 1; }));
      const possible = members.length * (members.length - 1);

      return {
        hub: hub.key,
        hubTitle: hub.title,
        members: members.map((m) => ({ url: m.key, title: m.title, depth: m.depth, inLinks: m.inLinks.size, outLinks: m.outLinksResolved.size, words: m.wordCount })),
        spokes: spokes.map((s) => s.key),
        sharedEntities: shared,
        size: members.length,
        internalLinks,
        connectedness: possible ? Math.round((internalLinks / possible) * 100) : 0,
        // A hub that its own spokes do not link to is not functioning as a hub,
        // whatever the site map says.
        spokesLinkingToHub: spokes.filter((s) => s.outLinksResolved.has(hub.key)).length,
        hubLinksToSpokes: spokes.filter((s) => hub.outLinksResolved.has(s.key)).length,
      };
    })
    .sort((a, b) => b.size - a.size);
}

// Link candidates: pairs that share entities and are not linked.
//
// Directionality matters and is decided, not guessed. A link should point from
// the page with LESS authority on the shared topic to the one with more —
// which here means from the narrower page to the broader one, and from the page
// with fewer inbound links to the one with more when depth is equal. Getting
// this backwards produces recommendations that dilute a hub instead of
// strengthening it.
function linkCandidates(nodes, communities, { limit = 60, minOverlap = 0.18 } = {}) {
  const list = [...nodes.values()];
  const out = [];
  const communityOf = new Map();
  communities.forEach((c, i) => c.members.forEach((m) => communityOf.set(m.url, i)));

  for (let i = 0; i < list.length; i += 1) {
    for (let j = 0; j < list.length; j += 1) {
      if (i === j) continue;
      const source = list[i];
      const targetNode = list[j];
      if (source.outLinksResolved.has(targetNode.key)) continue; // already linked
      if (source.entities.size < 3 || targetNode.entities.size < 3) continue;

      const overlap = nlp.jaccard(source.entities, targetNode.entities);
      if (overlap < minOverlap) continue;

      // Direction: prefer pointing at the broader / better-linked page.
      const targetIsBroader = targetNode.entities.size > source.entities.size
        || (targetNode.depth < source.depth)
        || (targetNode.inLinks.size > source.inLinks.size);
      if (!targetIsBroader) continue;

      const shared = [...source.entities].filter((e) => targetNode.entities.has(e));
      out.push({
        sourceUrl: source.key,
        sourceTitle: source.title,
        targetUrl: targetNode.key,
        targetTitle: targetNode.title,
        similarity: Math.round(overlap * 100) / 100,
        sharedEntities: shared.slice(0, 10),
        sameCommunity: communityOf.get(source.key) != null && communityOf.get(source.key) === communityOf.get(targetNode.key),
        targetInboundNow: targetNode.inLinks.size,
        sourceDepth: source.depth,
        targetDepth: targetNode.depth,
      });
    }
  }

  return out
    // Within-topic links first — they are the ones that build topical
    // authority rather than merely adding a path.
    .sort((a, b) => (Number(b.sameCommunity) - Number(a.sameCommunity))
      || (b.similarity - a.similarity)
      || (a.targetInboundNow - b.targetInboundNow))
    .slice(0, limit);
}

// Breadcrumb proposals from the URL hierarchy plus the topic graph.
//
// Built from the path segments, because that is the hierarchy the site already
// commits to in its URLs — proposing a trail that contradicts the URL would
// be worse than proposing none. The topic graph supplies a readable label for
// a segment whose slug is uninformative.
function breadcrumbProposals(nodes, siteUrl) {
  const byPath = new Map();
  nodes.forEach((n) => {
    let path = '/';
    try { path = new URL(n.key).pathname; } catch { /* keep */ }
    byPath.set(path.replace(/\/+$/, '') || '/', n);
  });

  const label = (segment, node) => {
    if (node && node.title) {
      // A title of the form "Thing | Brand" reads better as just "Thing".
      return node.title.split(/\s+[|–—·]\s+/)[0].slice(0, 60);
    }
    return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const proposals = [];
  nodes.forEach((n) => {
    let path = '/';
    try { path = new URL(n.key).pathname; } catch { return; }
    const segments = path.split('/').filter(Boolean);
    if (!segments.length) return; // homepage needs no breadcrumb

    const trail = [{ name: 'Home', url: (() => { try { return new URL(siteUrl).origin; } catch { return siteUrl; } })() }];
    let acc = '';
    segments.forEach((seg, i) => {
      acc += `/${seg}`;
      const node = byPath.get(acc);
      const isLast = i === segments.length - 1;
      trail.push({
        name: label(seg, isLast ? n : node),
        url: isLast ? n.key : (node ? node.key : null),
        // A level whose URL is not a real page is the classic broken
        // breadcrumb: it renders as a link to a 404. Flagged rather than
        // silently emitted.
        exists: isLast ? true : Boolean(node),
      });
    });

    const current = n.breadcrumbTrail;
    const hasTrail = current && current.trail.length >= 2;
    proposals.push({
      url: n.key,
      title: n.title,
      depth: segments.length,
      currentTrail: hasTrail ? current.trail : null,
      currentSource: hasTrail ? current.source : null,
      proposed: trail,
      missingLevels: trail.filter((t) => t.exists === false).map((t) => t.name),
      needsBreadcrumb: !hasTrail && segments.length >= 2,
    });
  });

  return proposals.sort((a, b) => b.depth - a.depth);
}

// --------------------------------------------------------------------- run

async function run({
  userId, brand, adoptRunId = null, maxPages = 60, wantAi = true, force = false,
}) {
  const brandId = brand ? brand.id : null;
  const site = normalizeUrl(brand.site_url);
  const runRow = store.begin({
    adoptRunId,
    userId, brandId, kind: 'architecture', target: site,
    params: { maxPages },
  });

  try {
    const sources = ['crawler'];
    const crawl = await crawlSite(site, { maxPages, concurrency: 4 });
    const okPages = crawl.pages.filter((p) => p.ok && p.doc);

    if (okPages.length < 3) {
      return store.finish(runRow.id, {
        score: null,
        result: {
          empty: true,
          reason: `Only ${okPages.length} page${okPages.length === 1 ? '' : 's'} could be crawled, which is not enough to build a link graph. Check that the site is reachable and that internal links are present in the served HTML rather than added by JavaScript.`,
          crawl: { fetched: crawl.fetched, discovered: crawl.discovered, failures: crawl.pages.filter((p) => !p.ok).slice(0, 10) },
        },
        findings: [{
          checkKey: 'crawl_too_small',
          title: 'Not enough pages could be crawled to analyse architecture',
          detail: `${crawl.fetched} fetched, ${okPages.length} usable.`,
          severity: 'high',
          affectedUrl: site,
          action: 'If the site renders its navigation with JavaScript, the crawler sees no links. Server-render the navigation, or run the full /linking crawl which can render pages.',
          dedupeKey: `architecture:toosmall:${site}`,
        }],
        sources,
      });
    }

    const nodes = buildGraph(crawl.pages);
    const communities = topicCommunities(nodes);
    const candidates = linkCandidates(nodes, communities);
    const breadcrumbs = breadcrumbProposals(nodes, site);

    // Search Console context: which of these pages actually earn impressions.
    // An orphan page with 4,000 impressions is a different problem from an
    // orphan nobody has ever seen, and ordering the backlog without that
    // distinction wastes the first week of work.
    let performanceByUrl = new Map();
    if (brandId) {
      const anchor = analytics.latestGscDate(brandId);
      if (anchor) {
        const w = analytics.windowFrom(anchor, 28);
        db.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions
          FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
          GROUP BY page`).all(brandId, w.startDate, w.endDate)
          .forEach((r) => performanceByUrl.set(canonUrl(r.page), { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }));
        if (performanceByUrl.size) sources.push('gsc');
      }
    }

    const nodeList = [...nodes.values()].map((n) => ({
      url: n.key,
      title: n.title,
      depth: n.depth,
      words: n.wordCount,
      inLinks: n.inLinks.size,
      outLinks: n.outLinksResolved.size,
      entities: n.entityList.slice(0, 12).map((e) => e.surface),
      performance: performanceByUrl.get(n.key) || null,
    })).sort((a, b) => a.inLinks - b.inLinks || b.depth - a.depth);

    // The start URL always has zero inbound links inside its own crawl,
    // because nothing above it was crawled. Excluding it is not a special case
    // — it is the difference between a real orphan and an artefact of where the
    // crawl began.
    const startKey = canonUrl(site);
    const orphans = nodeList.filter((n) => n.inLinks === 0 && n.url !== startKey);
    const weaklyLinked = nodeList.filter((n) => n.inLinks === 1 && n.url !== startKey);
    const deep = nodeList.filter((n) => n.depth >= 4);

    let aiLinks = null;
    if (wantAi && candidates.length) {
      aiLinks = await aiCalls.linkRationale({ brandId, candidates: candidates.slice(0, 25), force });
      if (aiLinks.ok) sources.push('azure');
    }

    // ------------------------------------------------------------ findings
    const findings = [];

    if (orphans.length) {
      const withTraffic = orphans.filter((o) => o.performance && o.performance.impressions > 0);
      findings.push({
        checkKey: 'orphans',
        title: `${orphans.length} page${orphans.length === 1 ? '' : 's'} have no internal links pointing to them`,
        detail: `${withTraffic.length ? `${withTraffic.length} of these already earn Search Console impressions, so they rank despite being unreachable by navigation: ${withTraffic.slice(0, 5).map((o) => `${o.url} (${o.performance.impressions.toLocaleString('en-US')} impr)`).join('; ')}. ` : ''}`
          + `Full list starts: ${orphans.slice(0, 8).map((o) => o.url).join(', ')}.`,
        severity: withTraffic.length ? 'high' : 'medium',
        affectedCount: orphans.length,
        affectedUrl: orphans[0].url,
        action: 'Link each from the most relevant hub. Pages already earning impressions come first — they are proven to have demand and are being held back only by internal signals.',
        evidence: { orphans: orphans.slice(0, 40) },
        dedupeKey: `architecture:orphans:${site}`,
      });
    }

    const brokenHubs = communities.filter((c) => c.size >= 3 && c.hubLinksToSpokes < Math.ceil((c.size - 1) / 2));
    if (brokenHubs.length) {
      findings.push({
        checkKey: 'incomplete_hubs',
        title: `${brokenHubs.length} topic cluster${brokenHubs.length === 1 ? '' : 's'} where the hub does not link to its own pages`,
        detail: brokenHubs.slice(0, 4).map((c) => `"${c.hubTitle || c.hub}" covers ${c.sharedEntities.slice(0, 3).join(', ')} across ${c.size} pages but links to only ${c.hubLinksToSpokes} of them`).join('; ') + '.',
        severity: 'medium',
        affectedCount: brokenHubs.length,
        affectedUrl: brokenHubs[0].hub,
        action: 'Add a links section on each hub page listing its spokes, and a link back to the hub from each spoke. This is the structure that consolidates topical authority; a set of pages that merely share a subject does not.',
        evidence: { clusters: brokenHubs.slice(0, 10) },
        dedupeKey: `architecture:hubs:${site}`,
      });
    }

    if (candidates.length) {
      const inTopic = candidates.filter((c) => c.sameCommunity);
      findings.push({
        checkKey: 'link_opportunities',
        title: `${candidates.length} internal link opportunities from entity overlap (${inTopic.length} within an existing topic cluster)`,
        detail: `Highest-overlap pairs: ${candidates.slice(0, 5).map((c) => `${c.sourceUrl} → ${c.targetUrl} (shares ${c.sharedEntities.slice(0, 3).join(', ')})`).join('; ')}.`,
        severity: 'low',
        affectedCount: candidates.length,
        action: 'Review before applying. Bulk-applying internal links is one of the actions that requires sign-off in this system precisely because a link nobody needs makes the site worse, not better.',
        evidence: { candidates: candidates.slice(0, 40) },
        dedupeKey: `architecture:linkopps:${site}`,
      });
    }

    const needBreadcrumb = breadcrumbs.filter((b) => b.needsBreadcrumb);
    if (needBreadcrumb.length) {
      findings.push({
        checkKey: 'missing_breadcrumbs',
        title: `${needBreadcrumb.length} nested page${needBreadcrumb.length === 1 ? '' : 's'} have no breadcrumb trail`,
        detail: `Pages two or more levels deep with no breadcrumbs in markup or BreadcrumbList schema. Starts: ${needBreadcrumb.slice(0, 6).map((b) => b.url).join(', ')}.`,
        severity: 'medium',
        affectedCount: needBreadcrumb.length,
        affectedUrl: needBreadcrumb[0].url,
        action: 'Add breadcrumbs with BreadcrumbList markup. They replace the URL in the SERP, and they tell an AI crawler where a page sits in the hierarchy — which is how it decides whether a page is the authoritative one on a subtopic.',
        evidence: { pages: needBreadcrumb.slice(0, 30) },
        dedupeKey: `architecture:breadcrumbs:${site}`,
      });
    }

    const brokenTrails = breadcrumbs.filter((b) => b.missingLevels.length);
    if (brokenTrails.length) {
      findings.push({
        checkKey: 'breadcrumb_gaps',
        title: `${brokenTrails.length} URL path${brokenTrails.length === 1 ? '' : 's'} contain a level with no real page`,
        detail: `The URL implies a hierarchy level that does not exist as a page, so a breadcrumb built from the path would link to a 404. Examples: ${brokenTrails.slice(0, 5).map((b) => `${b.url} (missing: ${b.missingLevels.join(', ')})`).join('; ')}.`,
        severity: 'low',
        affectedCount: brokenTrails.length,
        affectedUrl: brokenTrails[0].url,
        action: 'Either create the intermediate listing page — usually worth having anyway, as a hub — or render that breadcrumb level as plain text rather than a link.',
        evidence: { pages: brokenTrails.slice(0, 30) },
        dedupeKey: `architecture:breadcrumbgaps:${site}`,
      });
    }

    if (deep.length) {
      findings.push({
        checkKey: 'deep_pages',
        title: `${deep.length} page${deep.length === 1 ? ' is' : 's are'} four or more clicks from the homepage`,
        detail: `Crawl depth is a proxy for how much internal authority reaches a page. Deepest: ${deep.slice(0, 5).map((d) => `${d.url} (depth ${d.depth})`).join('; ')}.`,
        severity: 'low',
        affectedCount: deep.length,
        affectedUrl: deep[0].url,
        action: 'Link the important ones from a hub closer to the homepage. Depth is only a problem for pages that matter — a deep archive page is fine where it is.',
        evidence: { pages: deep.slice(0, 30) },
        dedupeKey: `architecture:depth:${site}`,
      });
    }

    // Score: orphan rate and hub completeness, the two things a reader
    // actually experiences.
    const orphanRate = nodeList.length ? orphans.length / nodeList.length : 0;
    const hubHealth = communities.length
      ? communities.reduce((a, c) => a + (c.size > 1 ? c.hubLinksToSpokes / (c.size - 1) : 1), 0) / communities.length
      : 0.5;
    const breadcrumbCoverage = breadcrumbs.length
      ? breadcrumbs.filter((b) => b.currentTrail).length / breadcrumbs.length
      : 0;
    const score = Math.round(Math.max(0, Math.min(100,
      (1 - orphanRate) * 40 + hubHealth * 35 + breadcrumbCoverage * 25)));

    return store.finish(runRow.id, {
      score,
      result: {
        empty: false,
        site,
        crawl: {
          fetched: crawl.fetched, discovered: crawl.discovered,
          complete: crawl.complete, maxPages,
          failures: crawl.pages.filter((p) => !p.ok).slice(0, 20).map((p) => ({ url: p.url, status: p.status, error: p.error })),
        },
        graph: {
          nodes: nodeList,
          nodeCount: nodeList.length,
          edgeCount: nodeList.reduce((a, n) => a + n.outLinks, 0),
          avgOutLinks: nodeList.length ? Math.round((nodeList.reduce((a, n) => a + n.outLinks, 0) / nodeList.length) * 10) / 10 : 0,
          maxDepth: nodeList.length ? Math.max(...nodeList.map((n) => n.depth)) : 0,
        },
        communities,
        candidates,
        breadcrumbs: breadcrumbs.slice(0, 120),
        orphans,
        weaklyLinked,
        deep,
        aiLinks: aiLinks ? {
          ok: aiLinks.ok, cached: aiLinks.cached, reason: aiLinks.reason,
          error: aiLinks.error, data: aiLinks.ok ? aiLinks.data : null,
        } : null,
        provenance: providers.provenance(sources),
      },
      findings,
      metrics: brandId ? [
        { key: 'architecture.score', value: score, status: score >= 75 ? 'good' : (score >= 50 ? 'warn' : 'fail') },
        { key: 'architecture.orphans', value: orphans.length, status: orphans.length ? 'warn' : 'good' },
        { key: 'architecture.topic_clusters', value: communities.length, status: 'good' },
        { key: 'architecture.max_depth', value: nodeList.length ? Math.max(...nodeList.map((n) => n.depth)) : 0, status: 'good' },
      ] : [],
      sources,
    });
  } catch (err) {
    store.fail(runRow.id, err);
    throw err;
  }
}

function toTasks(run, brand, { userId }) {
  const tasksLib = require('../tasks');
  let created = 0;
  (run.findings || []).forEach((f) => {
    if (f.severity === 'info') return;
    const r = tasksLib.upsertTask({
      userId,
      brandId: run.brand_id,
      title: f.title,
      detail: `${f.detail}\n\nRecommended: ${f.action || ''}`.trim(),
      source: 'aiseo',
      sourceRef: `aiseo:architecture:${run.id}:${f.check_key}`,
      category: 'Site architecture',
      severity: f.severity,
      affectedUrl: f.affected_url || run.target,
      evidence: f.evidence,
      dedupeKey: `aiseo:architecture:${f.check_key}:${run.brand_id || 0}`,
    });
    if (r.created) created += 1;
  });
  return { created };
}

module.exports = {
  run, toTasks, buildGraph, fingerprint, topicCommunities,
  linkCandidates, breadcrumbProposals,
};
