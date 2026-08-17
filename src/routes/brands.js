// Brand management: the unit every other feature is keyed to.
const express = require('express');
const db = require('../db');
const google = require('../lib/google');
const sync = require('../lib/sync');
const alertEngine = require('../lib/alertEngine');
const catalog = require('../lib/alertCatalog');
const propertyMatch = require('../lib/propertyMatch');

const router = express.Router();

const VALID_VERTICALS = new Set([
  'ecommerce', 'saas', 'local_service', 'professional_services',
  'publisher_content', 'marketplace', 'other',
]);

function normaliseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    // Keep the trailing slash on a bare host so it matches GSC's URL-prefix form.
    return parsed.pathname === '/' ? `${parsed.origin}/` : `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}

router.get('/', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);

    const enriched = brands.map((b) => ({
      ...b,
      coverage: sync.dataCoverage(b.id),
      caps: catalog.brandCapabilities(b),
      alertCount: db.prepare('SELECT COUNT(*) n FROM alert_subscriptions WHERE brand_id=? AND enabled=1').get(b.id).n,
      openTasks: db.prepare("SELECT COUNT(*) n FROM tasks WHERE brand_id=? AND status IN ('backlog','in_progress','awaiting_approval','blocked')").get(b.id).n,
    }));

    // Offer the connected account's own GSC and GA4 inventory so a brand can be
    // created by picking from real properties rather than typing identifiers.
    let gscSites = null;
    let ga4Props = null;
    let fetchError = null;
    const connected = Boolean(google.getConnection(userId));
    if (connected) {
      try { gscSites = await google.listGscSites(userId); } catch (e) { fetchError = `Search Console: ${e.message}`; }
      try {
        const summaries = await google.listGa4Properties(userId);
        ga4Props = summaries.flatMap((acc) => (acc.propertySummaries || []).map((p) => ({
          account: acc.displayName,
          id: String(p.property || '').replace('properties/', ''),
          name: p.displayName,
        })));
      } catch (e) { fetchError = `${fetchError ? `${fetchError}; ` : ''}GA4: ${e.message}`; }
    }

    res.render('brands', {
      title: 'Brands',
      active: 'brands',
      pageTitle: 'Brands',
      brands: enriched,
      sites: gscSites,
      ga4Props,
      connected,
      fetchError,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------- bulk import
// An agency does not add clients one at a time by hand. This reads every
// Search Console property on the connected account, pairs each with its GA4
// property where the match is confident, and creates the missing ones in one
// pass — which is what makes the suite genuinely multi-client rather than
// multi-client-in-principle.
router.get('/import', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    if (!google.getConnection(userId)) {
      return res.redirect('/connect?error=' + encodeURIComponent('Connect a Google account first.'));
    }

    let gscSites = [];
    let ga4Properties = [];
    const errors = [];
    try { gscSites = await google.listGscSites(userId); } catch (e) { errors.push(`Search Console: ${e.message}`); }
    try {
      const summaries = await google.listGa4Properties(userId);
      ga4Properties = summaries.flatMap((acc) => (acc.propertySummaries || []).map((p) => ({
        account: acc.displayName,
        id: String(p.property || '').replace('properties/', ''),
        name: p.displayName,
      })));
    } catch (e) { errors.push(`GA4: ${e.message}`); }

    const existingBrands = db.prepare('SELECT * FROM brands WHERE user_id=?').all(userId);
    const proposals = propertyMatch.proposeBrands({ gscSites, ga4Properties, existingBrands });

    res.render('brands-import', {
      title: 'Import properties',
      active: 'brands',
      pageTitle: 'Import from Google',
      proposals,
      ga4Properties,
      unmatchedGa4: ga4Properties.filter((p) => !proposals.some((x) => x.ga4 && x.ga4.id === p.id)),
      errors,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/import', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const selected = [].concat(req.body.host || []).filter(Boolean);
    if (!selected.length) {
      return res.redirect('/brands/import?error=' + encodeURIComponent('Nothing selected.'));
    }

    const days = Math.min(480, Math.max(30, parseInt(req.body.days, 10) || 90));
    const created = [];
    const skipped = [];

    selected.forEach((host) => {
      const name = String(req.body[`name_${host}`] || '').trim();
      const gscProperty = String(req.body[`gsc_${host}`] || '').trim();
      const siteUrl = normaliseUrl(req.body[`url_${host}`] || '');
      const ga4Id = String(req.body[`ga4_${host}`] || '').trim() || null;
      if (!name || !siteUrl) { skipped.push(`${host}: missing name or URL`); return; }

      const ga4Name = ga4Id
        ? (String(req.body[`ga4name_${host}`] || '').trim() || null)
        : null;

      try {
        db.prepare(`INSERT INTO brands
          (user_id, name, site_url, gsc_property, ga4_property_id, ga4_property_name)
          VALUES (?,?,?,?,?,?)`)
          .run(userId, name, siteUrl, gscProperty || null, ga4Id, ga4Name);
        created.push({ name, id: db.prepare('SELECT id FROM brands WHERE user_id=? AND site_url=?').get(userId, siteUrl).id });
      } catch (err) {
        skipped.push(String(err.message).includes('UNIQUE') ? `${name}: already added` : `${name}: ${err.message}`);
      }
    });

    // Sync each new brand in the background. Sequential rather than parallel:
    // they share one Google quota, and a burst of concurrent Search Analytics
    // calls is the fastest way to get rate-limited on a multi-client account.
    (async () => {
      for (const c of created) {
        const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(c.id);
        if (!brand) continue;
        try {
          await sync.syncBrand(brand, { days });
          try { alertEngine.applyRecommendedDefaults(userId, brand); } catch (e) {
            console.error(`[import] default alerts for ${brand.name}: ${e.message}`);
          }
        } catch (e) {
          console.error(`[import] sync ${brand.name} failed: ${e.message}`);
        }
      }
    })();

    const parts = [];
    if (created.length) parts.push(`Added ${created.length} site${created.length === 1 ? '' : 's'}: ${created.map((c) => c.name).join(', ')}. Their first ${days}-day sync is running now.`);
    if (skipped.length) parts.push(`Skipped — ${skipped.join('; ')}.`);
    res.redirect('/brands?msg=' + encodeURIComponent(parts.join(' ')));
  } catch (err) { next(err); }
});

router.post('/create', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const name = String(req.body.name || '').trim();
    const siteUrl = normaliseUrl(req.body.site_url);
    if (!name || !siteUrl) {
      return res.redirect('/brands?error=' + encodeURIComponent('A brand needs both a name and a website URL.'));
    }

    const ga4Id = String(req.body.ga4_property_id || '').trim() || null;
    let ga4Name = null;
    if (ga4Id) {
      // Store the friendly name too, so reports do not show a bare numeric id.
      try {
        const summaries = await google.listGa4Properties(userId);
        summaries.forEach((acc) => (acc.propertySummaries || []).forEach((p) => {
          if (String(p.property || '').replace('properties/', '') === ga4Id) ga4Name = p.displayName;
        }));
      } catch { /* a missing display name is not worth failing the create for */ }
    }

    let brandId;
    try {
      brandId = db.prepare(`INSERT INTO brands
        (user_id, name, site_url, gsc_property, ga4_property_id, ga4_property_name, notify_email, slack_webhook)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(userId, name, siteUrl,
          String(req.body.gsc_property || '').trim() || null,
          ga4Id, ga4Name,
          String(req.body.notify_email || '').trim() || null,
          String(req.body.slack_webhook || '').trim() || null)
        .lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.redirect('/brands?error=' + encodeURIComponent('A brand with that website URL already exists.'));
      }
      throw err;
    }

    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);

    // First sync runs inline in the background so the brand is not empty when
    // the user lands back on the page. Errors are recorded on the sync run.
    sync.syncBrand(brand, { days: 90 })
      .then(() => {
        // Only now can capabilities be judged, so defaults are applied after.
        try { alertEngine.applyRecommendedDefaults(userId, brand); } catch (e) {
          console.error('[brands] default alerts failed:', e.message);
        }
      })
      .catch((e) => console.error(`[brands] initial sync for ${brand.name} failed:`, e.message));

    res.redirect('/brands?msg=' + encodeURIComponent(`"${name}" created. The first data sync is running now — it usually takes under a minute.`));
  } catch (err) { next(err); }
});

router.post('/:id/update', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!brand) return res.redirect('/brands?error=' + encodeURIComponent('Brand not found.'));

    const ga4Id = String(req.body.ga4_property_id || '').trim() || null;
    let ga4Name = brand.ga4_property_name;
    if (ga4Id !== brand.ga4_property_id) {
      ga4Name = null;
      if (ga4Id) {
        try {
          const summaries = await google.listGa4Properties(userId);
          summaries.forEach((acc) => (acc.propertySummaries || []).forEach((p) => {
            if (String(p.property || '').replace('properties/', '') === ga4Id) ga4Name = p.displayName;
          }));
        } catch { /* ignore */ }
      }
    }

    db.prepare(`UPDATE brands SET name=?, site_url=?, gsc_property=?, ga4_property_id=?,
      ga4_property_name=?, notify_email=?, slack_webhook=?, active=? WHERE id=?`)
      .run(
        String(req.body.name || brand.name).trim(),
        normaliseUrl(req.body.site_url || brand.site_url),
        String(req.body.gsc_property || '').trim() || null,
        ga4Id, ga4Name,
        String(req.body.notify_email || '').trim() || null,
        String(req.body.slack_webhook || '').trim() || null,
        req.body.active === 'on' ? 1 : 0,
        brand.id
      );
    res.redirect('/brands?msg=' + encodeURIComponent('Brand updated.'));
  } catch (err) { next(err); }
});

// One-time-per-brand inputs the Content Brief Agent needs and cannot derive
// from any synced data: what the brand sells, and how it asks for the sale.
// Plain-language textarea input, parsed into the JSON shape contentBrief.js
// reads — so nobody has to hand-write JSON to use this.
router.post('/:id/content-settings', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!brand) return res.redirect('/brands?error=' + encodeURIComponent('Brand not found.'));

    // "Service name: keyword one, keyword two" — the keyword part is optional.
    const services = String(req.body.services || '').split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => {
        const [name, kw] = line.split(':');
        return {
          name: (kw ? name : line).trim(),
          keywords: kw ? kw.split(',').map((k) => k.trim()).filter(Boolean) : [],
        };
      });

    // "pageType: CTA text" per line, e.g. "commercial: Book a free consultation"
    const rules = String(req.body.cta_rules || '').split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(':');
        if (idx < 0) return null;
        return { pageType: line.slice(0, idx).trim().toLowerCase(), cta: line.slice(idx + 1).trim() };
      }).filter(Boolean);

    const ctaDefault = String(req.body.cta_default || '').trim();
    const cta = (ctaDefault || rules.length) ? { default: ctaDefault || null, rules } : null;

    // Vertical/locale config — drives intent classification, page-type
    // taxonomy and title templates. Unset/invalid falls back to 'other',
    // which reproduces today's services-oriented behaviour unchanged.
    const verticalRaw = String(req.body.vertical || '').trim().toLowerCase();
    const vertical = VALID_VERTICALS.has(verticalRaw) ? verticalRaw : null;
    const locale = String(req.body.locale || '').trim() || null;
    const market = String(req.body.market || '').trim() || null;

    db.prepare('UPDATE brands SET services_json=?, cta_json=?, vertical=?, locale=?, market=? WHERE id=?').run(
      services.length ? JSON.stringify(services) : null,
      cta ? JSON.stringify(cta) : null,
      vertical, locale, market,
      brand.id
    );
    res.redirect(`/brands/${brand.id}?msg=` + encodeURIComponent('Content brief settings saved.'));
  } catch (err) { next(err); }
});

router.post('/:id/sync', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!brand) return res.redirect('/brands?error=' + encodeURIComponent('Brand not found.'));

    const days = Math.min(480, Math.max(7, parseInt(req.body.days, 10) || 90));
    const includePsi = req.body.include_psi === 'on';

    // PageSpeed adds up to a couple of minutes, so never block the response.
    sync.syncBrand(brand, { days, includePsi })
      .catch((e) => console.error(`[brands] sync for ${brand.name} failed:`, e.message));

    res.redirect(`/brands/${brand.id}?msg=` + encodeURIComponent(
      `Sync started for the last ${days} days${includePsi ? ', including PageSpeed measurements (these take a minute or two)' : ''}. Reload to see progress.`
    ));
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  const userId = req.dataUserId;
  db.prepare('DELETE FROM brands WHERE id=? AND user_id=?').run(req.params.id, userId);
  res.redirect('/brands?msg=' + encodeURIComponent('Brand and all of its data deleted.'));
});

// Brand detail: data coverage, sync history, and everything attached to it.
router.get('/:id', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!brand) return res.redirect('/brands?error=' + encodeURIComponent('Brand not found.'));

    const syncRuns = db.prepare('SELECT * FROM sync_runs WHERE brand_id=? ORDER BY id DESC LIMIT 15').all(brand.id)
      .map((r) => {
        let steps = null;
        try { steps = r.detail ? JSON.parse(r.detail) : null; } catch { steps = null; }
        return { ...r, steps };
      });

    // Every table the sync writes to, in sync order, each with the screen it
    // surfaces on — so "we pulled it" and "you can see it" stay in step. Keep
    // this list aligned with the task list in lib/sync.js syncBrand().
    const DATA_TABLES = [
      { table: 'gsc_daily', label: 'Site-level clicks, impressions, CTR, position', where: 'Performance → KPI row & trends' },
      { table: 'gsc_page_daily', label: 'Landing-page performance by day', where: 'Performance → Pages' },
      { table: 'gsc_query_daily', label: 'Keyword performance by day', where: 'Performance → Queries' },
      { table: 'gsc_query_page', label: 'Which URL ranks for which keyword', where: 'Performance → Query → page' },
      { table: 'gsc_country_daily', label: 'Search performance by country', where: 'Performance → Countries' },
      { table: 'gsc_device_daily', label: 'Search performance by device', where: 'Performance → Devices' },
      { table: 'gsc_appearance_daily', label: 'Rich-result / search appearance', where: 'Performance → Search appearance' },
      { table: 'gsc_sitemaps', label: 'Submitted sitemaps and their status', where: 'Performance → Sitemaps' },
      { table: 'url_inspections', label: 'Sampled indexation state per URL', where: 'Performance → Page indexing' },
      { table: 'ga4_daily', label: 'Sessions, engagement, conversions by channel', where: 'Performance → GA4 channels' },
      { table: 'ga4_page_daily', label: 'Organic landing pages and conversions', where: 'Performance → GA4 pages' },
      { table: 'ga4_device_daily', label: 'Sessions by device category and browser', where: 'Performance → GA4 tech' },
      { table: 'ga4_geo_daily', label: 'Sessions by country and city', where: 'Performance → GA4 geo' },
      { table: 'ga4_acquisition_daily', label: 'Sessions by source / medium', where: 'Performance → GA4 acquisition' },
      { table: 'ga4_event_daily', label: 'Event counts, users and value', where: 'Performance → GA4 events' },
      { table: 'psi_snapshots', label: 'Core Web Vitals measurements', where: 'This page & weekly reports' },
      { table: 'uptime_checks', label: 'Availability and response time', where: 'This page & uptime alerts' },
    ];
    const rowCounts = {};
    const dataTables = DATA_TABLES.map((t) => {
      const n = db.prepare(`SELECT COUNT(*) n FROM ${t.table} WHERE brand_id=?`).get(brand.id).n;
      rowCounts[t.table] = n;
      return { ...t, rows: n };
    });

    res.render('brand-detail', {
      title: brand.name,
      active: 'brands',
      pageTitle: brand.name,
      brand,
      coverage: sync.dataCoverage(brand.id),
      caps: catalog.brandCapabilities(brand),
      syncRuns,
      rowCounts,
      dataTables,
      audits: db.prepare('SELECT * FROM audit_runs WHERE brand_id=? ORDER BY id DESC LIMIT 5').all(brand.id),
      linkings: db.prepare('SELECT * FROM linking_runs WHERE brand_id=? ORDER BY id DESC LIMIT 5').all(brand.id),
      uptime: db.prepare('SELECT * FROM uptime_checks WHERE brand_id=? ORDER BY id DESC LIMIT 10').all(brand.id),
      psi: db.prepare('SELECT * FROM psi_snapshots WHERE brand_id=? ORDER BY id DESC LIMIT 6').all(brand.id),
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
