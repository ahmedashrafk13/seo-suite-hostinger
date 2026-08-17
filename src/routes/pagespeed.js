// PageSpeed Insights — the full Lighthouse + CrUX report, in-app.
//
// Reports are run on demand, stored whole, and re-rendered from storage, so
// opening an old report costs nothing and the numbers never silently change
// under a client. Each run also writes the headline metrics into
// psi_snapshots, which is what the Core Web Vitals alerts already read — so
// running a report here keeps the alerting baseline fresh for free.
const express = require('express');
const db = require('../db');
const psi = require('../lib/psi');
const google = require('../lib/google');

const router = express.Router();

const STRATEGIES = ['mobile', 'desktop'];

function brandsFor(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id=? ORDER BY name').all(userId);
}

function historyFor(userId, limit = 25) {
  return db.prepare(`SELECT p.id, p.url, p.strategy, p.performance, p.accessibility,
      p.best_practices, p.seo, p.created_at, b.name brand_name
    FROM psi_reports p LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.user_id = ? ORDER BY p.id DESC LIMIT ?`).all(userId, limit);
}

function renderPage(req, res, extra) {
  const userId = req.dataUserId;
  res.render('pagespeed', Object.assign({
    title: 'PageSpeed Insights',
    active: 'pagespeed',
    pageTitle: 'PageSpeed Insights',
    brands: brandsFor(userId),
    history: historyFor(userId),
    connected: Boolean(google.getConnection(userId)),
    hasApiKey: Boolean(process.env.PSI_API_KEY),
    report: null,
    row: null,
    url: '',
    strategy: 'mobile',
    flash: req.query.msg || null,
    flashError: req.query.error || null,
  }, extra || {}));
}

router.get('/', (req, res, next) => {
  try {
    const userId = req.dataUserId;
    // Deep-linking a URL+strategy shows the most recent stored report for it,
    // mirroring how PSI keeps a report addressable.
    const url = (req.query.url || '').trim();
    const strategy = STRATEGIES.includes(req.query.strategy) ? req.query.strategy : 'mobile';
    let row = null;
    if (url) {
      row = db.prepare(`SELECT * FROM psi_reports WHERE user_id=? AND url=? AND strategy=?
        ORDER BY id DESC LIMIT 1`).get(userId, url, strategy);
    }
    renderPage(req, res, {
      url,
      strategy,
      row: row || null,
      report: row ? psi.normalise(JSON.parse(row.raw_json)) : null,
    });
  } catch (err) { next(err); }
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM psi_reports WHERE id=? AND user_id=?')
      .get(req.params.id, req.dataUserId);
    if (!row) {
      return res.status(404).render('error', {
        title: 'Not found', active: 'pagespeed', message: 'That PageSpeed report does not exist.',
      });
    }
    renderPage(req, res, {
      url: row.url,
      strategy: row.strategy,
      row,
      report: psi.normalise(JSON.parse(row.raw_json)),
    });
  } catch (err) { next(err); }
});

router.post('/run', async (req, res, next) => {
  try {
    const userId = req.dataUserId;
    let url = String(req.body.url || '').trim();
    if (!url) return res.redirect('/pagespeed?error=' + encodeURIComponent('Enter a URL to analyse.'));
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch {
      return res.redirect('/pagespeed?error=' + encodeURIComponent('That does not look like a valid URL.'));
    }

    const strategy = STRATEGIES.includes(req.body.strategy) ? req.body.strategy : 'mobile';
    const brandId = req.body.brand_id ? Number(req.body.brand_id) : null;

    let result;
    try {
      result = await psi.fetchReport(userId, { url, strategy });
    } catch (err) {
      const hint = err.status === 429
        ? ' Google\'s anonymous quota is shared and small — connect your Google account so the request uses your own project quota.'
        : (err.status === 401 || err.status === 403
          ? ' Enable the PageSpeed Insights API in the Google Cloud project behind your OAuth client, then reconnect.'
          : '');
      return res.redirect('/pagespeed?error=' + encodeURIComponent(`${err.message}${hint}`));
    }

    const report = psi.normalise(result.data);
    const scoreOf = (id) => {
      const c = report.categories.find((x) => x.id === id);
      return c ? c.score : null;
    };

    const info = db.prepare(`INSERT INTO psi_reports
      (user_id, brand_id, url, strategy, performance, accessibility, best_practices, seo, credential, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, brandId, url, strategy, scoreOf('performance'), scoreOf('accessibility'),
        scoreOf('best-practices'), scoreOf('seo'), result.via, JSON.stringify(result.data));

    // Feed the existing CWV alert baseline. Field data is preferred when CrUX
    // has it, matching what lib/google.pageSpeed() stores.
    if (brandId) {
      const lab = {};
      report.metrics.forEach((m) => { lab[m.id] = m; });
      const audits = (result.data.lighthouseResult || {}).audits || {};
      const num = (id) => (audits[id] && typeof audits[id].numericValue === 'number' ? audits[id].numericValue : null);
      const fieldOf = (key) => {
        const m = (report.field.metrics || []).find((x) => x.key === key);
        return m ? m : null;
      };
      const le = ((result.data.loadingExperience || {}).metrics) || {};
      const fieldNum = (key) => (le[key] && typeof le[key].percentile === 'number' ? le[key].percentile : null);
      try {
        db.prepare(`INSERT INTO psi_snapshots (brand_id, url, strategy, perf_score, lcp, inp, cls, fcp, ttfb, source)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(brandId, url, strategy, scoreOf('performance'),
            fieldNum('LARGEST_CONTENTFUL_PAINT_MS') ?? num('largest-contentful-paint'),
            fieldNum('INTERACTION_TO_NEXT_PAINT') ?? num('interaction-to-next-paint'),
            fieldNum('CUMULATIVE_LAYOUT_SHIFT_SCORE') != null
              ? fieldNum('CUMULATIVE_LAYOUT_SHIFT_SCORE') / 100
              : num('cumulative-layout-shift'),
            fieldNum('FIRST_CONTENTFUL_PAINT_MS') ?? num('first-contentful-paint'),
            fieldNum('EXPERIMENTAL_TIME_TO_FIRST_BYTE') ?? num('server-response-time'),
            fieldOf('LARGEST_CONTENTFUL_PAINT_MS') ? 'crux-field' : 'lighthouse-lab');
      } catch (e) {
        console.error('[pagespeed] snapshot write failed:', e.message);
      }
    }

    res.redirect(`/pagespeed/${info.lastInsertRowid}`);
  } catch (err) { next(err); }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM psi_reports WHERE id=? AND user_id=?').run(req.params.id, req.dataUserId);
  res.redirect('/pagespeed?msg=' + encodeURIComponent('Report deleted.'));
});

module.exports = router;
