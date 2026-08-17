// Google connection: OAuth status, and the GSC / GA4 inventory it unlocks.
const express = require('express');
const db = require('../db');
const google = require('../lib/google');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    const conn = google.getConnection(userId);

    let sites = null;
    let properties = null;
    const errors = [];

    if (conn) {
      try {
        sites = await google.listGscSites(userId);
      } catch (err) {
        errors.push(`Search Console: ${err.message}`);
      }
      try {
        const summaries = await google.listGa4Properties(userId);
        properties = summaries.flatMap((acc) => (acc.propertySummaries || []).map((p) => ({
          account: acc.displayName,
          id: String(p.property || '').replace('properties/', ''),
          name: p.displayName,
          type: p.propertyType,
        })));
      } catch (err) {
        errors.push(`GA4: ${err.message}`);
      }
    }

    // Which properties are already claimed by a brand, so the page can show
    // what is left to set up rather than just a flat list.
    const brands = db.prepare('SELECT * FROM brands WHERE user_id=?').all(userId);
    const usedGsc = new Set(brands.map((b) => b.gsc_property).filter(Boolean));
    const usedGa4 = new Set(brands.map((b) => b.ga4_property_id).filter(Boolean));

    res.render('connect', {
      title: 'Connect Google',
      active: 'connect',
      pageTitle: 'Connected accounts',
      connection: conn,
      sites: sites ? sites.map((s) => ({ ...s, used: usedGsc.has(s.siteUrl) })) : null,
      properties: properties ? properties.map((p) => ({ ...p, used: usedGa4.has(p.id) })) : null,
      errors,
      brands,
      googleConfigured: google.isConfigured(),
      scopes: google.SCOPES,
      flash: req.query.success ? 'Google account connected successfully.' : (req.query.msg || null),
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
