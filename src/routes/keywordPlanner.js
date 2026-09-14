// Google Keyword Planner, as its own page.
//
// The suite already USES Keyword Planner - it is one of the volume sources
// behind /ai-seo/research - but only as an input to a blended number, which
// means the ideas expansion, the bid range, the concept groups and the
// forecast never reach a screen. This route is the direct line: one page, the
// three KeywordPlanIdeaService RPCs, and Google's own numbers shown unmerged
// and labelled with the account that produced them.
//
// RUNS ARE SAVED. This page was built stateless, on the theory that keyword
// research is transient and anything worth keeping leaves as a CSV. That was
// wrong in use: leaving the page and coming back discarded a result that had
// just cost a Google Ads call and up to a minute of Bing lookups, which reads
// as the app losing your work rather than as a deliberate design.
//
// Every run is now stored whole (see keyword_planner_runs in db.js) and can be
// reopened from the history list without spending the quota again. The CSV
// export still re-runs the query when it is exporting the CURRENT form, since
// that is the only way to guarantee the file matches what is on screen.

const express = require('express');
const db = require('../db');
const planner = require('../lib/aiseo/keywordPlanner');
const markets = require('../lib/aiseo/markets');
const google = require('../lib/google');

const router = express.Router();

const SORTS = [
  { value: 'volume', label: 'Search volume (high to low)' },
  { value: 'volume_asc', label: 'Search volume (low to high)' },
  { value: 'competition', label: 'Competition (low to high)' },
  { value: 'bid', label: 'Top-of-page bid (high to low)' },
  { value: 'trend', label: 'Trend (rising first)' },
  { value: 'alpha', label: 'Keyword (A-Z)' },
];

const SEED_MODES = [
  { value: 'keyword', label: 'Start with keywords' },
  { value: 'url', label: 'Start with a page URL' },
  { value: 'site', label: 'Start with an entire site' },
  { value: 'keyword_and_url', label: 'Keywords and a page URL' },
];

function bool(v) {
  return v === '1' || v === 'on' || v === 'true' || v === true;
}

// Every control on the page, read once. Returned verbatim to the view as well
// as passed to the library, so a submitted form comes back filled in - a
// twenty-field research form that resets itself on every run is unusable.
// Reads BOTH a posted form body and a stored params object. A saved run keeps
// the raw submitted fields, so replaying one through here refills every
// control exactly as it was - including the checkboxes, whose presence markers
// are stored alongside them.
function readForm(src) {
  const s = src || {};
  // A stored params object is already in the normalised shape this function
  // returns, so it is handed back with the marker fields it needs to survive
  // a second pass.
  if (s.keywordsText !== undefined) {
    return Object.assign({}, s, {
      geoIds: Array.isArray(s.geoIds) ? s.geoIds : [],
    });
  }
  return {
    tab: ['ideas', 'historical', 'forecast'].indexOf(s.tab) >= 0 ? s.tab : 'ideas',
    seedMode: SEED_MODES.some((m) => m.value === s.seed_mode) ? s.seed_mode : 'keyword',
    keywordsText: String(s.keywords || ''),
    url: String(s.url || '').trim(),
    market: String(s.market || 'US'),
    language: String(s.language || 'en'),
    network: String(s.network || 'GOOGLE_SEARCH'),
    geoIds: String(s.geo_ids || '').split(',').map((x) => x.trim()).filter(Boolean),
    geoLabels: String(s.geo_labels || ''),
    startYearMonth: String(s.start_month || ''),
    endYearMonth: String(s.end_month || ''),
    includeAdultKeywords: bool(s.adult),
    deviceBreakdown: bool(s.devices),
    showMonths: bool(s.show_months),
    bing: bool(s.bing),
    // Google defaults ON and is the only engine that can generate ideas, so
    // the same presence-marker trick the concept checkbox uses applies: an
    // absent field must mean "not asked", not "unticked".
    google: s.google_present ? bool(s.google) : true,
    // Concept grouping defaults ON, which makes an unchecked box and an absent
    // field mean opposite things and look identical in a POST body. The form
    // therefore submits a marker whenever that checkbox was on the page: with
    // the marker, the checkbox is authoritative; without it (a GET from a tab
    // link, say) the default stands.
    annotations: s.annotations_present ? bool(s.annotations) : true,
    pageSize: s.page_size || '',
    sort: SORTS.some((x) => x.value === s.sort) ? s.sort : 'volume',
    // refinements
    minVolume: s.min_volume || '',
    maxVolume: s.max_volume || '',
    maxCompetitionIndex: s.max_competition || '',
    maxTopBid: s.max_bid || '',
    includeTerms: String(s.include_terms || ''),
    excludeTerms: String(s.exclude_terms || ''),
    minWords: s.min_words || '',
    questionsOnly: bool(s.questions_only),
    // forecast
    matchType: planner.MATCH_TYPES.indexOf(s.match_type) >= 0 ? s.match_type : 'BROAD',
    maxCpcBid: s.max_cpc || '',
    startDate: String(s.start_date || ''),
    endDate: String(s.end_date || ''),
    conversionRate: s.conversion_rate || '',
    negativeKeywordsText: String(s.negative_keywords || ''),
  };
}

// Form shape -> library options.
function toOptions(form) {
  return {
    seedMode: form.seedMode,
    keywords: planner.parseKeywords(form.keywordsText),
    negativeKeywords: planner.parseKeywords(form.negativeKeywordsText),
    url: form.url,
    market: form.market,
    language: form.language,
    network: form.network,
    geoTargetIds: form.geoIds,
    startYearMonth: form.startYearMonth,
    endYearMonth: form.endYearMonth,
    includeAdultKeywords: form.includeAdultKeywords,
    deviceBreakdown: form.deviceBreakdown,
    annotations: form.annotations,
    pageSize: form.pageSize,
    sort: form.sort,
    minVolume: form.minVolume,
    maxVolume: form.maxVolume,
    maxCompetitionIndex: form.maxCompetitionIndex,
    maxTopBid: form.maxTopBid,
    includeTerms: form.includeTerms,
    excludeTerms: form.excludeTerms,
    minWords: form.minWords,
    questionsOnly: form.questionsOnly,
    matchType: form.matchType,
    maxCpcBid: form.maxCpcBid,
    startDate: form.startDate,
    endDate: form.endDate,
    conversionRate: form.conversionRate,
  };
}

// Is Keyword Planner reachable at all, and if not, precisely why? Resolved on
// every render so the page opens with the answer rather than making someone
// submit a form to discover the account is not connected. Deliberately the
// same resolver /connect probes with, so the two pages never disagree.
function access(userId) {
  if (!google.adsDeveloperToken()) {
    return {
      ok: false,
      reason: 'GOOGLE_ADS_DEVELOPER_TOKEN is not set, so no Keyword Planner call can be made.',
      fix: 'Add the developer token from Google Ads > Tools > API Center to the environment and restart.',
    };
  }
  const p = google.resolveAdsPrincipal(userId);
  if (!p.ok) {
    return {
      ok: false,
      reason: p.reason,
      fix: 'Connect Google with Ads access and pick an account on /connect.',
    };
  }
  return {
    ok: true,
    mode: p.mode,
    customerId: p.customerId,
    name: p.name || null,
    ownerEmail: p.ownerEmail || null,
    staleOwnSelection: p.staleOwnSelection || null,
  };
}

// One row per run. The result object is stored whole rather than normalised
// into columns: it is a snapshot of what two APIs said at a moment in time,
// and picking it apart into fields would mean migrating the table every time
// either API gains a metric.
function saveRun(userId, form, result) {
  const label = form.seedMode !== 'keyword' && form.url
    ? form.url
    : (planner.parseKeywords(form.keywordsText).slice(0, 3).join(', ') || 'untitled');
  const engines = [form.google ? 'google' : null, form.bing ? 'bing' : null].filter(Boolean).join('+');
  const info = db.prepare(`INSERT INTO keyword_planner_runs
      (user_id, kind, label, market, language, engines, row_count, params_json, result_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(userId, result.kind, label.slice(0, 200), form.market, form.language, engines,
      (result.rows || []).length, JSON.stringify(form), JSON.stringify(result));
  return info.lastInsertRowid;
}

function historyFor(userId) {
  return db.prepare(`SELECT id, kind, label, market, engines, row_count, created_at
    FROM keyword_planner_runs WHERE user_id=? ORDER BY id DESC LIMIT 25`).all(userId);
}

function render(req, res, extra) {
  res.render('keyword-planner', Object.assign({
    // Every render carries the history, so a saved run is reachable from
    // wherever you happen to be - including from an error page.
    history: historyFor(req.dataUserId),
    runId: null,
    title: 'Keyword Planner',
    active: 'keyword-planner',
    pageTitle: 'Keyword Planner',
    marketList: markets.all(),
    languages: planner.LANGUAGES,
    networks: planner.NETWORKS,
    matchTypes: planner.MATCH_TYPES,
    sorts: SORTS,
    seedModes: SEED_MODES,
    maxSeed: planner.MAX_SEED_KEYWORDS,
    maxHistorical: planner.MAX_HISTORICAL_KEYWORDS,
    result: null,
    error: null,
    flash: null,
  }, extra));
}

// Google's errors are the whole diagnosis here - a sunset API version, a
// test-access developer token and a missing scope all fail differently and are
// fixed differently - so the message is surfaced as-is rather than replaced
// with a friendly generic one. The hint adds context without hiding it.
function errorFrom(err) {
  const msg = err && err.message ? err.message : 'The Keyword Planner request failed.';
  let hint = null;
  if (err && err.noPrincipal) {
    hint = 'Connect Google with Ads access and choose an account on /connect.';
  } else if (/DEVELOPER_TOKEN_NOT_APPROVED|test account/i.test(msg)) {
    hint = 'A test-access developer token authenticates but returns no data against a real account. Apply for Basic access in the Google Ads API Center.';
  } else if (err && err.httpStatus === 404) {
    hint = 'The Ads API version may have been sunset. /connect runs a probe that reports which versions still serve this method.';
  } else if (/PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(msg)) {
    hint = 'The connected Google account cannot reach that Ads customer id. Check the account choice, and the login-customer-id if it is reached through a manager account.';
  } else if (/reconnect|scope/i.test(msg)) {
    hint = 'Reconnect Google on /connect to grant the Ads scope.';
  }
  return { message: msg, hint, raw: (err && err.rawBody) || null };
}

// ------------------------------------------------------------------- the page

router.get('/', (req, res, next) => {
  try {
    const form = readForm(req.query);
    render(req, res, { form, access: access(req.dataUserId) });
  } catch (err) { next(err); }
});

// One handler for all three RPCs: the request differs, the page does not.
function runHandler(kind) {
  return async (req, res, next) => {
    const form = readForm(req.body);
    form.tab = kind;
    const acc = access(req.dataUserId);
    try {
      // Bing-only: skip Google Ads entirely. Possible only for a supplied
      // keyword list - Bing has no keyword-ideas endpoint here, so the ideas
      // tab always needs Google.
      const bingOnly = !form.google && form.bing && kind === 'historical';
      if (!form.google && !form.bing) {
        return render(req, res, {
          form, access: acc,
          error: { message: 'Pick at least one search engine.', hint: 'Google answers keyword ideas and bids; Bing answers volume for a list you supply.' },
        });
      }
      if (!form.google && kind !== 'historical') {
        return render(req, res, {
          form, access: acc,
          error: {
            message: 'Bing cannot generate keyword ideas.',
            hint: 'Only Google Ads has a keyword-suggestion endpoint. Switch on Google here, or paste your own list into "Metrics for my list" and run it against Bing alone.',
          },
        });
      }

      const result = bingOnly
        ? planner.bingOnlyResult(toOptions(form).keywords, toOptions(form))
        : await planner[kind](req.dataUserId, toOptions(form));
      // Bing is a SECOND, independent engine's numbers, fetched after Google's
      // and merged onto the same rows - never blended into the Google column.
      // Skipped for forecasts, which have no per-keyword rows to attach to.
      if (form.bing && result.rows) {
        const withBing = await planner.attachBingVolume(result.rows, { market: form.market });
        result.rows = withBing.rows;
        result.bingNote = withBing.note;
        result.bingChecked = withBing.checked || 0;
        result.bingCapped = Boolean(withBing.capped);
      }
      // Saved before rendering, so what you see is what was stored.
      let runId = null;
      try {
        runId = saveRun(req.dataUserId, form, result);
      } catch (e) {
        // A storage failure must not lose the result that is already in hand.
        result.saveError = e.message;
      }
      render(req, res, { form, access: acc, result, runId });
    } catch (err) {
      // A failed lookup is not a server error - it is an answer the page has
      // to show next to the form that caused it, with the inputs still filled
      // in. next(err) would throw all of that away for a generic error page.
      if (err && (err.noPrincipal || err.httpStatus || /^Enter |seed needs/.test(err.message || ''))) {
        return render(req, res, { form, access: acc, error: errorFrom(err) });
      }
      return next(err);
    }
  };
}

router.post('/ideas', runHandler('ideas'));
router.post('/historical', runHandler('historical'));
router.post('/forecast', runHandler('forecast'));

// CSV of the current result. Re-runs the query rather than reading a cached
// copy: nothing is stored, and a stale export that silently disagrees with the
// table above it is worse than a second API call.
router.post('/export.csv', async (req, res, next) => {
  const form = readForm(req.body);
  try {
    const kind = form.tab === 'historical' ? 'historical' : 'ideas';
    const result = (!form.google && form.bing && kind === 'historical')
      ? planner.bingOnlyResult(toOptions(form).keywords, toOptions(form))
      : await planner[kind](req.dataUserId, toOptions(form));
    if (form.bing && result.rows) {
      result.rows = (await planner.attachBingVolume(result.rows, { market: form.market })).rows;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="keyword-planner-${kind}-${stamp}.csv"`);
    // A BOM so Excel on Windows reads the UTF-8 keywords correctly - without
    // it, accented and non-Latin terms arrive mangled.
    res.send('﻿' + planner.csv(result));
  } catch (err) {
    if (err && (err.noPrincipal || err.httpStatus)) {
      return render(req, res, { form, access: access(req.dataUserId), error: errorFrom(err) });
    }
    return next(err);
  }
});

// Reopen a stored run. No API call: this renders the snapshot exactly as it
// was captured, with the form refilled from the parameters that produced it so
// "run it again" is one click.
// NOTE ON THE PATH. This used to read ':id(\d+)'. That inline-regex syntax
// was removed by the path-to-regexp version this Express ships, so the route
// silently stopped matching and every request fell through to the 404 handler
// - a real bug, reproduced against this exact express build. Plain ':id' with
// an explicit numeric guard is what the rest of the app already does.
router.get('/run/:id', (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return next();
    const row = db.prepare('SELECT * FROM keyword_planner_runs WHERE id=? AND user_id=?')
      .get(req.params.id, req.dataUserId);
    if (!row) {
      return res.status(404).render('error', {
        title: 'Not found', active: 'keyword-planner', message: 'That Keyword Planner run does not exist.',
      });
    }
    const form = readForm(JSON.parse(row.params_json));
    const result = JSON.parse(row.result_json);
    render(req, res, { form, access: access(req.dataUserId), result, runId: row.id, savedAt: row.created_at });
  } catch (err) { next(err); }
});

router.post('/run/:id/delete', (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return next();
    db.prepare('DELETE FROM keyword_planner_runs WHERE id=? AND user_id=?')
      .run(req.params.id, req.dataUserId);
    res.redirect('/keyword-planner');
  } catch (err) { next(err); }
});

// Location autocomplete. Keyword Planner targets cities and metros, not just
// the countries in the markets table, and this is the only way to get their
// criteria ids. JSON because it backs a type-ahead; it degrades to the country
// dropdown with JavaScript off.
router.get('/geo', async (req, res) => {
  try {
    const rows = await planner.suggestGeoTargets(req.dataUserId, req.query.q, {
      countryCode: req.query.country,
      locale: req.query.locale,
    });
    res.json({ ok: true, results: rows.slice(0, 20) });
  } catch (err) {
    res.status(200).json({ ok: false, error: (err && err.message) || 'Location lookup failed.' });
  }
});

module.exports = router;
