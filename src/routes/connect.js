// Google connection: OAuth status, and the GSC / GA4 inventory it unlocks.
const express = require('express');
const db = require('../db');
const google = require('../lib/google');
const providers = require('../lib/aiseo/providers');

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

    // ---- Google Ads / Keyword Planner ---------------------------------
    //
    // Four independent conditions decide whether Keyword Planner works, and
    // the page renders each one separately rather than a single red cross:
    // the developer token, the `adwords` scope on this connection, the chosen
    // Ads account, and whether a real call returns volumes.
    //
    // The account list is only fetched when the first two hold. Calling it
    // without them produces a 401 whose message says nothing useful, which
    // would then be shown to the user as if the integration were broken.
    const adsDevToken = Boolean(google.adsDeveloperToken());
    const adsScopeGranted = google.hasAdsScope(conn);
    const adsNeedsReconnect = google.needsAdsReconnect(conn);
    // Not conditional on `conn`: in the shared agency model a team with NO
    // Google connection of its own still has working keyword volumes, and the
    // page has to be able to say so.
    const adsSelection = google.getAdsSelection(userId);
    let adsAccounts = null;
    let adsListError = null;
    // Only offer the picker to a team that could actually use it. A client
    // team served by the agency's shared account has nothing to choose, and
    // listing accounts on their connection would just produce a permission
    // error next to a feature that is working perfectly.
    const adsCanPick = Boolean(conn && adsDevToken && adsScopeGranted);
    if (adsCanPick) {
      try {
        adsAccounts = await google.listAccessibleAdsCustomers(userId);
      } catch (err) {
        adsListError = err.message;
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
      ads: {
        devToken: adsDevToken,
        scopeGranted: adsScopeGranted,
        needsReconnect: adsNeedsReconnect,
        selection: adsSelection,
        canPick: adsCanPick,
        accounts: adsAccounts,
        listError: adsListError,
        apiVersion: google.ADS_API_VERSION,
        // What the rest of the app currently believes, so /connect and the AI
        // SEO pages can never disagree about whether this source is live.
        providerAvailable: providers.has('google-ads'),
      },
      flash: req.query.success ? 'Google account connected successfully.' : (req.query.msg || null),
      flashError: req.query.error || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
