// REAL PUBLISHING VELOCITY, BUILT BY DIFFING SITEMAPS OVER TIME
//
// competitive.js's velocityFromSitemap() infers a publish rate from a
// SINGLE sitemap's lastmod dates. It already detects and refuses the worst
// failure mode of that approach — a CMS that stamps every URL with today's
// date at deploy time — but even where lastmod is genuine, a single
// snapshot cannot see what was REMOVED, and "genuine lastmod" is itself a
// guess about a platform this app does not run.
//
// This module replaces guessing with observation: every time a competitive
// run reads a site's sitemap, it is diffed against every URL this app has
// ever seen for that (brand, site) pair. A URL that appears for the first
// time is new; a URL that was there last run and is not this run is
// removed. That is a fact, not an inference, and it costs nothing extra —
// the sitemap fetch already happens as part of the competitive run.
//
// THE ONE HONEST LIMITATION
// The history starts empty. The first run for a site has no prior snapshot
// to diff against, so every URL looks "new" — which is not a velocity
// figure, it is the starting inventory. That run is marked `baseline: true`
// and its counts are not offered as a rate. A real rate needs at least one
// earlier run to compare against, and callers must check `usable` before
// treating `newLast30`/`newLast90` as meaningful.
const db = require('../../db');

function run({ brandId, site, urls }) {
  const now = new Date();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);
  const priorRunCount = db.prepare('SELECT COUNT(*) c FROM sitemap_history_runs WHERE brand_id=? AND site=?')
    .get(brandId, site).c;

  const incoming = new Map();
  (urls || []).forEach((u) => {
    const loc = String((u && (u.loc || u)) || '').trim();
    if (!loc) return;
    incoming.set(loc, u && u.lastmod ? String(u.lastmod) : null);
  });

  const existing = db.prepare('SELECT url, removed_at FROM sitemap_url_history WHERE brand_id=? AND site=?')
    .all(brandId, site);
  const existingByUrl = new Map(existing.map((r) => [r.url, r]));

  const upsert = db.prepare(`INSERT INTO sitemap_url_history (brand_id, site, url, lastmod, first_seen_at, last_seen_at, removed_at)
      VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(brand_id, site, url) DO UPDATE SET
        lastmod = excluded.lastmod, last_seen_at = excluded.last_seen_at, removed_at = NULL`);
  const markRemoved = db.prepare(`UPDATE sitemap_url_history SET removed_at=? WHERE brand_id=? AND site=? AND url=? AND removed_at IS NULL`);

  let newCount = 0;
  incoming.forEach((lastmod, url) => {
    if (!existingByUrl.has(url)) newCount += 1;
    upsert.run(brandId, site, url, lastmod, nowIso, nowIso);
  });

  let removedCount = 0;
  existingByUrl.forEach((row) => {
    if (!incoming.has(row.url) && !row.removed_at) {
      markRemoved.run(nowIso, brandId, site, row.url);
      removedCount += 1;
    }
  });

  db.prepare(`INSERT INTO sitemap_history_runs (brand_id, site, run_at, total_urls, new_urls, removed_urls)
    VALUES (?,?,?,?,?,?)`).run(brandId, site, nowIso, incoming.size, newCount, removedCount);

  const baseline = priorRunCount === 0;

  const since = (days) => {
    const d = new Date(now.getTime() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    return d;
  };
  const countSince = (col, days) => db.prepare(`SELECT COUNT(*) c FROM sitemap_url_history WHERE brand_id=? AND site=? AND ${col} >= ?`)
    .get(brandId, site, since(days)).c;

  const newLast30 = baseline ? null : countSince('first_seen_at', 30);
  const newLast90 = baseline ? null : countSince('first_seen_at', 90);
  const removedLast30 = baseline ? null : countSince('removed_at', 30);
  const removedLast90 = baseline ? null : countSince('removed_at', 90);

  return {
    usable: !baseline,
    baseline,
    reason: baseline
      ? 'This is the first time this site\'s sitemap has been observed here — there is no prior snapshot to diff against, so this run is the starting inventory, not a velocity figure. Run competitive analysis again after some time has passed to see a real rate.'
      : null,
    priorRuns: priorRunCount,
    totalUrls: incoming.size,
    newThisRun: newCount,
    removedThisRun: removedCount,
    newLast30,
    newLast90,
    removedLast30,
    removedLast90,
    netLast90: baseline ? null : (newLast90 - removedLast90),
    perMonth: baseline ? null : Math.round((newLast90 / 3) * 10) / 10,
  };
}

module.exports = { run };
