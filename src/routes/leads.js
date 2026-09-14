// Leads: the attribution view, the backlog of enquiries, and the ingest key.
//
// The page is organised around one question - which pages produce business - 
// so the attribution table is the body of it and the list of individual leads
// sits underneath. That ordering is deliberate: a list of enquiries is a CRM,
// and this is not one. The reason to hold leads here at all is to line them up
// against Search Console.
const express = require('express');
const db = require('../db');
const leads = require('../lib/leads');
const { buildWorkbook, sendWorkbook } = require('../lib/xlsxExport');

const router = express.Router();

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

function brandOr404(req, res) {
  const id = Number(req.body.brand_id || req.query.brand || 0);
  const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?').get(id, req.dataUserId);
  if (!brand) {
    res.redirect('/leads?error=' + encodeURIComponent('Brand not found.'));
    return null;
  }
  return brand;
}

// The window this page works in. Bounded rather than free: a 5-year window over
// gsc_page_daily on shared hosting is a request that times out, and no report
// this app produces looks further back than a year.
function windowFrom(query) {
  const days = Math.min(Math.max(Number(query.days) || 28, 1), 365);
  return { days, ...leads.windowDates(days) };
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const brands = brandsFor(userId);
    const brandId = req.query.brand ? Number(req.query.brand) : (brands[0] ? brands[0].id : null);
    const brand = brandId ? brands.find((b) => b.id === brandId) || null : null;
    const win = windowFrom(req.query);

    let view = null;
    if (brand) {
      const range = { from: win.from, to: win.to };
      view = {
        summary: leads.summaryWithPrior(brand.id, win.days),
        // Pages with no leads are dropped from the table: with them, a site of
        // 400 URLs shows 400 rows of zeroes and the six that matter are
        // invisible. The count of what was hidden is shown instead.
        rows: leads.attribution(brand.id, range, { includeZeroLead: false }),
        allPages: leads.attribution(brand.id, range).length,
        unattributed: leads.unattributed(brand.id, range),
        daily: leads.daily(brand.id, range),
        recent: leads.list(userId, { brandId: brand.id, from: win.from, to: win.to, limit: 50 }),
        total: leads.count(userId, { brandId: brand.id, from: win.from, to: win.to }),
        hasAny: leads.hasAny(brand.id),
      };
    }

    res.render('leads', {
      title: 'Leads',
      active: 'leads',
      pageTitle: 'Leads & attribution',
      brands,
      brand,
      win,
      view,
      statuses: leads.STATUSES,
      // Shown once, immediately after issuing, and never again - the plaintext
      // is not stored. Carried through the redirect in the session rather than
      // the query string, because a key in a URL lands in the browser history
      // and in any proxy log between here and the user.
      newKey: (() => { const k = req.session.newLeadKey; delete req.session.newLeadKey; return k || null; })(),
      baseUrl: `${req.protocol}://${req.get('host')}`,
      flash: req.query.msg || null,
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- ingest key
router.post('/key', (req, res, next) => {
  try {
    if (!res.locals.perms.canWrite) return res.status(403).redirect('/leads?error=' + encodeURIComponent('You do not have permission to change this.'));
    const brand = brandOr404(req, res);
    if (!brand) return undefined;
    // Issuing over an existing key replaces it, which immediately breaks
    // whatever is posting with the old one. The confirmation for that lives in
    // the view; there is no way to have both keys valid at once without a key
    // table, and a second table is not worth it for a credential that is
    // pasted into one form.
    req.session.newLeadKey = leads.issueKey(brand.id, req.dataUserId);
    return res.redirect(`/leads?brand=${brand.id}&msg=` + encodeURIComponent('New ingest key issued. Copy it now - it is not shown again.'));
  } catch (err) { return next(err); }
});

router.post('/key/revoke', (req, res, next) => {
  try {
    if (!res.locals.perms.canWrite) return res.status(403).redirect('/leads?error=' + encodeURIComponent('You do not have permission to change this.'));
    const brand = brandOr404(req, res);
    if (!brand) return undefined;
    leads.revokeKey(brand.id, req.dataUserId);
    return res.redirect(`/leads?brand=${brand.id}&msg=` + encodeURIComponent('Ingest key revoked. Any form posting with it will now be rejected.'));
  } catch (err) { return next(err); }
});

// ------------------------------------------------------------------- a lead
router.post('/:id/status', (req, res, next) => {
  try {
    if (!res.locals.perms.canWrite) return res.status(403).redirect('/leads?error=' + encodeURIComponent('You do not have permission to change this.'));
    const lead = leads.get(req.params.id, req.dataUserId);
    if (!lead) return res.redirect('/leads?error=' + encodeURIComponent('Lead not found.'));
    leads.setStatus(lead.id, req.dataUserId, String(req.body.status || 'new'));
    return res.redirect(`/leads?brand=${lead.brand_id}&msg=` + encodeURIComponent('Lead updated.'));
  } catch (err) { return next(err); }
});

router.post('/:id/delete', (req, res, next) => {
  try {
    if (!res.locals.perms.canWrite) return res.status(403).redirect('/leads?error=' + encodeURIComponent('You do not have permission to change this.'));
    const lead = leads.get(req.params.id, req.dataUserId);
    if (!lead) return res.redirect('/leads?error=' + encodeURIComponent('Lead not found.'));
    leads.remove(lead.id, req.dataUserId);
    return res.redirect(`/leads?brand=${lead.brand_id}&msg=` + encodeURIComponent('Lead deleted permanently.'));
  } catch (err) { return next(err); }
});

// ------------------------------------------------------------------ export
//
// Two sheets, and the split is the point: "Attribution" is the sheet that goes
// to a client, and "Leads" is the one with contact details on it that does not.
// Keeping them in one workbook with obvious names beats producing one merged
// sheet that someone forwards without reading.
router.get('/export', async (req, res, next) => {
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE id=? AND user_id=?')
      .get(Number(req.query.brand || 0), req.dataUserId);
    if (!brand) return res.redirect('/leads?error=' + encodeURIComponent('Brand not found.'));
    const win = windowFrom(req.query);
    const range = { from: win.from, to: win.to };

    const attribution = leads.attribution(brand.id, range, { includeZeroLead: false }).map((r) => ({
      path: r.path,
      leads: r.leads,
      organic: r.organicLeads,
      won: r.won,
      value: Number((r.value || 0).toFixed(2)),
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      position: r.position == null ? '' : Number(r.position.toFixed(1)),
      per100: r.leadsPer100 == null ? '' : Number(r.leadsPer100.toFixed(2)),
    }));

    const rows = leads.list(req.dataUserId, { brandId: brand.id, from: win.from, to: win.to, limit: 5000 })
      .map((l) => ({
        occurred_at: String(l.occurred_at).slice(0, 16).replace('T', ' '),
        status: l.status,
        channel: l.channel,
        landing_path: l.landing_path || '',
        name: l.name || '',
        email: l.email || '',
        phone: l.phone || '',
        company: l.company || '',
        value: l.value == null ? '' : l.value,
        source: l.source || '',
        medium: l.medium || '',
        campaign: l.campaign || '',
        note: l.note || '',
      }));

    const wb = buildWorkbook({
      sheets: [
        {
          name: 'Attribution',
          columns: [
            { header: 'Page', key: 'path', width: 46 },
            { header: 'Leads', key: 'leads', width: 10 },
            { header: 'Organic leads', key: 'organic', width: 14 },
            { header: 'Won', key: 'won', width: 8 },
            { header: 'Value', key: 'value', width: 14 },
            { header: 'Clicks', key: 'clicks', width: 11 },
            { header: 'Impressions', key: 'impressions', width: 13 },
            { header: 'Position', key: 'position', width: 10 },
            { header: 'Leads per 100 clicks', key: 'per100', width: 20 },
          ],
          rows: attribution,
        },
        {
          name: 'Leads (contains contact details)',
          columns: [
            { header: 'When', key: 'occurred_at', width: 18 },
            { header: 'Status', key: 'status', width: 12, dropdown: leads.STATUSES },
            { header: 'Channel', key: 'channel', width: 12 },
            { header: 'Landing page', key: 'landing_path', width: 34 },
            { header: 'Name', key: 'name', width: 22 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Phone', key: 'phone', width: 18 },
            { header: 'Company', key: 'company', width: 22 },
            { header: 'Value', key: 'value', width: 12 },
            { header: 'Source', key: 'source', width: 16 },
            { header: 'Medium', key: 'medium', width: 14 },
            { header: 'Campaign', key: 'campaign', width: 20 },
            { header: 'Note', key: 'note', width: 50 },
          ],
          rows,
        },
      ],
    });
    return sendWorkbook(res, wb, `leads-${brand.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${win.from}-to-${win.to}.xlsx`);
  } catch (err) { return next(err); }
});

module.exports = router;
