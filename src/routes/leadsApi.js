// POST /api/leads - the one route in this app that is called by someone else's
// software.
//
// WHY IT IS MOUNTED WHERE IT IS
// This router is registered BEFORE csrf.verify in src/app.js, alongside
// /internal/cron, for the same reason: it authenticates with a shared secret in
// a header, not with a session, so there is no session to hold a CSRF token and
// the verifier would reject every post. That placement is load-bearing - moving
// this line below `app.use(csrf.verify)` breaks every client's form silently,
// and the breakage looks like "leads stopped arriving" rather than an error
// anyone sees.
//
// The CSRF exemption is safe here precisely because the endpoint does not
// authenticate by cookie: a forged cross-site post carries no ingest key, and a
// post that carries a valid key is authorised by definition, whoever sent it.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not accept a brand id from the caller. The key identifies the brand;
// a body field naming a different one would be an authorisation bypass dressed
// as a convenience.
const express = require('express');
const leads = require('../lib/leads');

const router = express.Router();

// A crude fixed-window limiter, per key, in memory.
//
// It is not a security control and is not pretending to be one - a real one
// needs shared state and this app runs one process. It exists to bound the
// damage from the failure that actually happens: a form plugin with a retry
// loop, or a CRM replaying its whole history on reconnect, either of which
// writes tens of thousands of rows into a SQLite file on shared hosting before
// anyone notices. The limit is far above any real form's volume.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const buckets = new Map();
function overLimit(keyHint) {
  const now = Date.now();
  const b = buckets.get(keyHint);
  if (!b || now - b.start > WINDOW_MS) {
    buckets.set(keyHint, { start: now, n: 1 });
    // Opportunistic sweep: without it the map grows by one entry per revoked
    // key for the life of the process.
    if (buckets.size > 500) {
      for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
    }
    return false;
  }
  b.n += 1;
  return b.n > MAX_PER_WINDOW;
}

// The key may arrive three ways because the sender's software decides which is
// possible: a Zapier or Make step sets headers freely, a WordPress form plugin
// often cannot set one at all and can only post fields, and a no-code webhook
// builder sometimes offers only a URL. All three are accepted; the query-string
// form is documented as the last resort it is, since a URL is logged by every
// proxy between here and the sender.
function keyFrom(req) {
  return req.get('x-lead-key')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    || (req.body && (req.body.key || req.body.lead_key))
    || req.query.key
    || null;
}

function auth(req, res, next) {
  const token = keyFrom(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Missing ingest key. Send it as an X-Lead-Key header.' });
  }
  const brand = leads.brandForKey(token);
  if (!brand) {
    // Deliberately does not say whether the key was malformed, revoked or
    // simply wrong: all three are "not a valid key" to the caller, and the
    // distinction is only useful to someone guessing.
    return res.status(401).json({ ok: false, error: 'Invalid or revoked ingest key.' });
  }
  if (overLimit(brand.lead_key_hint + brand.id)) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Slow down and retry.' });
  }
  req.leadBrand = brand;
  next();
}

// A liveness check for whoever is wiring the integration up. It confirms the
// key works and names the brand it belongs to, so the "is this the right key
// for the right site" question is answerable without posting a fake lead into a
// client's real numbers - which is otherwise exactly what people do, and then
// leave there.
router.get('/ping', auth, (req, res) => {
  res.json({
    ok: true,
    brand: req.leadBrand.name,
    site: req.leadBrand.site_url,
    message: 'Key is valid. POST a lead to this same URL without /ping.',
  });
});

router.post('/', auth, (req, res) => {
  const brand = req.leadBrand;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // An empty body is the single most common wiring mistake - a form tool
    // posting multipart, or posting JSON without a Content-Type - and it must
    // not become a row full of nulls that looks like a lead nobody can act on.
    const meaningful = ['email', 'phone', 'name', 'message', 'note', 'landing_page', 'page', 'url', 'external_id']
      .some((k) => body[k] != null && String(body[k]).trim() !== '');
    if (!meaningful) {
      const msg = 'Body had no recognisable lead fields. Send JSON with at least one of: email, phone, name, message.';
      leads.recordError(brand.id, msg);
      return res.status(400).json({ ok: false, error: msg });
    }

    const result = leads.record(brand, body);
    // 200 for a duplicate rather than 409: the sender is a retry loop, and a
    // 4xx teaches it to keep retrying something that already succeeded.
    res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      id: result.id,
      duplicate: result.duplicate,
      brand: brand.name,
    });
  } catch (err) {
    // Logged with the brand so a broken integration is findable, but the
    // message returned to the caller is generic - this response goes to a third
    // party's system and the internal message can carry SQL or a file path.
    console.error(`[leads] ingest failed for brand ${brand.id} (${brand.name}):`, err);
    try { leads.recordError(brand.id, err.message); } catch { /* the error page is not worth a second failure */ }
    res.status(500).json({ ok: false, error: 'Could not record the lead. It was not saved; retry is safe.' });
  }
});

// Anything else under /api/leads answers as JSON rather than falling through to
// the HTML 404 page, because the caller is a machine parsing a response body.
router.use((req, res) => {
  res.status(404).json({ ok: false, error: `No endpoint at ${req.method} /api/leads${req.path}` });
});

module.exports = router;
