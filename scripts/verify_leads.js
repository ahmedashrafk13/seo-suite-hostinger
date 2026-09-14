// End-to-end test for lead ingest, attribution, and client report share links.
//
// WHY THIS EXISTS RATHER THAN UNIT TESTS
// Both features are defined by things that can only be observed over HTTP:
//   - POST /api/leads must work WITHOUT a session and WITHOUT a CSRF token,
//     which is entirely a question of where its router is mounted in app.js. A
//     unit test of lib/leads.js would pass with the route mounted in the wrong
//     place, and the symptom in production is silent: forms stop posting and
//     nothing on any screen says so.
//   - A share link must be openable by someone with no session at all, must
//     stop working when revoked or expired, and must not carry a single lead's
//     name, email or phone number. "It does not render PII" is a claim about a
//     rendered page, so this test reads the rendered page.
//
// It drives the REAL app on a spare port against the real database, creates its
// own account and brand, and deletes everything it made.
//
// Run:  node verify_leads.js
require('dotenv').config();
// Must be an empty string, not deleted: src/app.js calls dotenv.config() again
// as it loads and would repopulate a deleted key, sending real mail.
process.env.SMTP_HOST = '';
process.env.INPROCESS_CRON = '0';
process.env.PORT = process.env.LEADS_TEST_PORT || '4403';

const db = require('../src/db');
const leadsLib = require('../src/lib/leads');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const STAMP = Date.now();
const EMAIL = `leads-test-${STAMP}@example.com`;
const PASSWORD = 'test-password-123';
const SITE = `https://leads-test-${STAMP}.nope.example`;

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`OK   ${name}`); } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

// Minimal cookie-jar fetch. Every state-changing post must carry the session's
// CSRF token, so the helper fetches one from a page first — the same thing a
// browser does by rendering the form.
function makeSession() {
  const jar = {};
  let csrf = null;
  async function call(path, { method = 'GET', form = null, headers = {}, body = null, redirect = 'manual' } = {}) {
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(csrf ? { ...form, _csrf: csrf } : form).toString();
    }
    const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      jar[pair.slice(0, idx)] = pair.slice(idx + 1);
    });
    const text = await res.text();
    const found = text.match(/name="_csrf" value="([^"]+)"/);
    if (found) csrf = found[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  return call;
}

// A session with no cookies at all — a client opening a link they were emailed.
async function anon(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function cleanup() {
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL);
  if (u) {
    // Leads, reports, shares and brands all cascade from the user row, but the
    // cascade is only trustworthy with foreign_keys ON — which db.js sets, and
    // which this deletes in dependency order anyway so a future engine change
    // cannot leave a client-looking brand on someone's dashboard.
    const brands = db.prepare('SELECT id FROM brands WHERE user_id=?').all(u.id);
    brands.forEach((b) => {
      db.prepare('DELETE FROM leads WHERE brand_id=?').run(b.id);
      db.prepare('DELETE FROM gsc_page_daily WHERE brand_id=?').run(b.id);
      db.prepare('DELETE FROM gsc_daily WHERE brand_id=?').run(b.id);
      db.prepare('DELETE FROM ga4_page_daily WHERE brand_id=?').run(b.id);
      const reports = db.prepare('SELECT id FROM weekly_reports WHERE brand_id=?').all(b.id);
      reports.forEach((r) => db.prepare('DELETE FROM report_shares WHERE report_id=?').run(r.id));
      db.prepare('DELETE FROM weekly_reports WHERE brand_id=?').run(b.id);
      db.prepare('DELETE FROM alert_subscriptions WHERE brand_id=?').run(b.id);
      db.prepare('DELETE FROM brands WHERE id=?').run(b.id);
    });
    db.prepare('DELETE FROM teams WHERE owner_user_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  }
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

(async () => {
  cleanup();
  require('../src/app');
  await new Promise((r) => setTimeout(r, 700));

  let brand;
  try {
    // -------------------------------------------------------------- account
    const ui = makeSession();
    await ui('/signup');
    let r = await ui('/signup', { method: 'POST', form: { email: EMAIL, password: PASSWORD, name: 'Leads Test' } });
    check('test account created', r.status === 302 && r.location === '/dashboard', `got ${r.status} ${r.location}`);

    await ui('/brands');
    r = await ui('/brands/create', { method: 'POST', form: { name: 'Leads Test Brand', site_url: SITE } });
    brand = db.prepare('SELECT * FROM brands WHERE name=? ORDER BY id DESC').get('Leads Test Brand');
    check('test brand created', !!brand, `create returned ${r.status} ${r.location}`);
    if (!brand) throw new Error('cannot continue without a brand');

    // ---------------------------------------------------- normalisation math
    //
    // This is the join the whole feature rests on: Search Console's absolute
    // URL, GA4's path, and whatever a form posts must all reduce to one string.
    const n = leadsLib.normalisePath;
    check('a GSC absolute URL reduces to a path', n(`${SITE}/services/roofing/`) === '/services/roofing', n(`${SITE}/services/roofing/`));
    check('a query string and fragment are dropped', n(`${SITE}/contact?utm_source=google#form`) === '/contact', n(`${SITE}/contact?utm_source=google#form`));
    check('a bare path is left as a path', n('/contact') === '/contact');
    check('index.html is the directory', n(`${SITE}/about/index.html`) === '/about');
    check('the root stays the root', n(`${SITE}/`) === '/' && n(SITE) === '/');
    check('case in the path is preserved', n(`${SITE}/Services`) === '/Services',
      'folding case would merge two URLs a server treats as two pages');

    const ch = leadsLib.deriveChannel;
    check('utm_medium=organic is organic', ch({ medium: 'organic' }) === 'organic');
    check('utm_medium=cpc is paid', ch({ medium: 'cpc' }) === 'paid');
    check('a Google referrer with no utm is organic', ch({ referrer: 'https://www.google.com/' }) === 'organic');
    check('a ChatGPT referrer is its own channel', ch({ referrer: 'https://chatgpt.com/' }) === 'ai');
    check('no referrer and no utm is direct', ch({}) === 'direct');
    check('an unknown referrer is referral, not organic', ch({ referrer: 'https://someblog.example/post' }) === 'referral',
      'guessing organic here would inflate the number used to argue SEO works');

    // ------------------------------------------------------------ ingest key
    await ui(`/leads?brand=${brand.id}`);
    r = await ui('/leads/key', { method: 'POST', form: { brand_id: String(brand.id) } });
    check('issuing a key redirects back to the brand', r.status === 302 && /\/leads\?brand=/.test(r.location || ''));
    r = await ui(`/leads?brand=${brand.id}`);
    const keyMatch = r.text.match(/<code id="new-key">([^<]+)<\/code>/);
    const KEY = keyMatch ? keyMatch[1].trim() : null;
    check('the new key is shown exactly once', !!KEY);
    r = await ui(`/leads?brand=${brand.id}`);
    check('the key is not shown again on a reload', !/<code id="new-key">/.test(r.text),
      'a key that stays on screen is a key that gets screenshotted');

    brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brand.id);
    check('only a hash of the key is stored', !!brand.lead_key_hash && brand.lead_key_hash !== KEY
      && !brand.lead_key_hash.includes(KEY.slice(8)));

    // ------------------------------------------------------- the ingest API
    async function post(body, headers = {}) {
      const res = await fetch(`${BASE}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* non-JSON is itself the failure */ }
      return { status: res.status, json };
    }

    let p = await post({ email: 'a@example.com' });
    check('a post with no key is refused', p.status === 401, `got ${p.status}`);
    p = await post({ email: 'a@example.com' }, { 'X-Lead-Key': 'sk_lead_not-a-real-key-at-all' });
    check('a post with a wrong key is refused', p.status === 401, `got ${p.status}`);

    // THE test for this feature's wiring: a valid post with no session and no
    // CSRF token. If routes/leadsApi.js is ever mounted below csrf.verify in
    // app.js, this is the line that fails.
    p = await post({
      email: 'jane@example.com', name: 'Jane Smith', phone: '+15550100',
      landing_page: `${SITE}/services/roofing/?utm_source=google`,
      medium: 'organic', external_id: 'form-1', value: '1,200',
    }, { 'X-Lead-Key': KEY });
    check('a valid lead posts with no session and no CSRF token', p.status === 201 && p.json && p.json.ok,
      `got ${p.status} ${JSON.stringify(p.json)}`);

    const lead = db.prepare('SELECT * FROM leads WHERE brand_id=? AND external_id=?').get(brand.id, 'form-1');
    check('the lead landed on a normalised path', lead && lead.landing_path === '/services/roofing', lead && lead.landing_path);
    check('the raw URL was kept unmodified', lead && lead.landing_url.includes('utm_source=google'));
    check('a value written as "1,200" parsed to 1200', lead && lead.value === 1200, lead && String(lead.value));
    check('the channel was derived on insert', lead && lead.channel === 'organic');

    p = await post({ email: 'jane@example.com', external_id: 'form-1', status: 'won', value: 2000 },
      { 'X-Lead-Key': KEY });
    check('a repeat of the same external_id is not a duplicate row', p.status === 200 && p.json.duplicate === true,
      `got ${p.status} ${JSON.stringify(p.json)}`);
    check('exactly one row exists for that external_id',
      db.prepare('SELECT COUNT(*) c FROM leads WHERE brand_id=? AND external_id=?').get(brand.id, 'form-1').c === 1);
    const updated = db.prepare('SELECT * FROM leads WHERE brand_id=? AND external_id=?').get(brand.id, 'form-1');
    check('the repeat updated the status and value from the CRM',
      updated.status === 'won' && updated.value === 2000, `${updated.status}/${updated.value}`);

    p = await post({ nothing: 'useful' }, { 'X-Lead-Key': KEY });
    check('a body with no recognisable field is rejected', p.status === 400, `got ${p.status}`);
    const afterError = db.prepare('SELECT lead_last_error FROM brands WHERE id=?').get(brand.id);
    check('the rejection is recorded on the brand so it is visible in the UI', !!afterError.lead_last_error,
      'otherwise a form posting into a 400 for months looks exactly like a quiet month');

    const ping = await fetch(`${BASE}/api/leads/ping`, { headers: { 'X-Lead-Key': KEY } });
    const pingJson = await ping.json();
    check('the ping endpoint confirms the key without creating a lead',
      ping.status === 200 && pingJson.brand === 'Leads Test Brand');

    // Two more leads on a second page, so attribution has something to rank.
    await post({ email: 'b@example.com', landing_page: `${SITE}/contact`, medium: 'organic', external_id: 'form-2' }, { 'X-Lead-Key': KEY });
    await post({ email: 'c@example.com', landing_page: `${SITE}/contact/`, medium: 'cpc', external_id: 'form-3' }, { 'X-Lead-Key': KEY });
    // One with no landing page at all — the wiring problem that must not be
    // folded into "direct".
    await post({ email: 'd@example.com', external_id: 'form-4' }, { 'X-Lead-Key': KEY });

    // ---------------------------------------------------------- attribution
    //
    // Two GSC URL spellings for one page, on purpose: the http/https and
    // trailing-slash pair is the ordinary case, and averaging two averaged
    // positions is the ordinary bug.
    const day = daysAgo(3);
    db.prepare('INSERT OR REPLACE INTO gsc_page_daily (brand_id,date,page,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?)')
      .run(brand.id, day, `${SITE}/services/roofing/`, 180, 3000, 0.06, 4.0);
    db.prepare('INSERT OR REPLACE INTO gsc_page_daily (brand_id,date,page,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?)')
      .run(brand.id, day, `${SITE}/services/roofing`, 20, 1000, 0.02, 12.0);
    db.prepare('INSERT OR REPLACE INTO gsc_page_daily (brand_id,date,page,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?)')
      .run(brand.id, day, `${SITE}/contact`, 40, 500, 0.08, 6.0);
    db.prepare('INSERT OR REPLACE INTO gsc_page_daily (brand_id,date,page,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?)')
      .run(brand.id, day, `${SITE}/blog/quiet-post`, 900, 20000, 0.045, 8.0);

    const rows = leadsLib.attribution(brand.id, leadsLib.windowDates(28));
    const roofing = rows.find((x) => x.path === '/services/roofing');
    const contact = rows.find((x) => x.path === '/contact');
    const quiet = rows.find((x) => x.path === '/blog/quiet-post');
    check('two GSC spellings of one page combine into one row', roofing && roofing.clicks === 200, roofing && String(roofing.clicks));
    check('position is combined by impression weight, not averaged',
      roofing && Math.abs(roofing.position - 6) < 0.01,
      `expected 6.0 ((4.0*3000 + 12.0*1000)/4000), got ${roofing && roofing.position}`);
    check('a lead posted with a trailing slash lands on the same page as one without',
      contact && contact.leads === 2, contact && String(contact.leads));
    check('leads per 100 clicks is computed', roofing && Math.abs(roofing.leadsPer100 - 0.5) < 0.001,
      roofing && String(roofing.leadsPer100));
    check('a high-traffic page with no leads still appears, with zero',
      quiet && quiet.leads === 0 && quiet.clicks === 900);
    check('the table is ordered by leads, not by clicks', rows[0].path !== '/blog/quiet-post',
      'ordering by traffic is what the existing Performance tab already does');

    const un = leadsLib.unattributed(brand.id, leadsLib.windowDates(28));
    check('a lead with no landing page is counted separately', un && un.n === 1,
      'folding it into a channel would quietly deflate every page\'s contribution');

    const sum = leadsLib.summary(brand.id, leadsLib.windowDates(28));
    check('the summary counts leads and won value', sum.leads === 4 && sum.wonValue === 2000,
      JSON.stringify({ leads: sum.leads, wonValue: sum.wonValue }));

    // ------------------------------------------------------------- the page
    r = await ui(`/leads?brand=${brand.id}`);
    check('the leads page renders the attribution table', r.status === 200 && r.text.includes('/services/roofing'));
    check('the leads page shows the unattributed warning', /arrived with no landing page/.test(r.text));

    // Signed out, /leads is not reachable at all.
    const stranger = makeSession();
    r = await stranger(`/leads?brand=${brand.id}`);
    check('the leads page requires a login', r.status === 302 && r.location === '/login', `got ${r.status} ${r.location}`);

    // --------------------------------------------------------- share links
    //
    // A report is needed first. Synthetic GSC rows across the report's week
    // give reportBuilder something real to build from.
    for (let i = 0; i < 14; i += 1) {
      const d = daysAgo(i + 1);
      db.prepare('INSERT OR REPLACE INTO gsc_daily (brand_id,date,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?)')
        .run(brand.id, d, 100 + i, 2000 + i * 10, 0.05, 7.5);
    }
    const reportBuilder = require('../src/lib/reportBuilder');
    const reportRow = reportBuilder.generate(brand, { weekEnd: daysAgo(1) });
    check('a weekly report was generated for the test brand', !!reportRow && !!reportRow.id);

    // A lead dated inside the report's own week. Every lead posted so far is
    // dated today, which is AFTER this report's period — so this also proves
    // the point of the window: a report dated three weeks ago must show that
    // week's enquiries, not this week's.
    await post({
      email: 'inweek@example.com', external_id: 'form-inweek', medium: 'organic',
      landing_page: `${SITE}/contact`, occurred_at: `${reportRow.period_end}T12:00:00Z`,
    }, { 'X-Lead-Key': KEY });
    const inWeek = leadsLib.summary(brand.id, { from: reportRow.period_start, to: reportRow.period_end });
    check('the report week sees only the lead dated inside it', inWeek.leads === 1,
      `expected 1, got ${inWeek.leads} — today's leads must not leak into an older report`);

    await ui(`/reports/${reportRow.id}`);
    r = await ui(`/reports/${reportRow.id}/commentary`, {
      method: 'POST',
      form: { commentary: 'Traffic held steady while enquiries rose.\n\nWe are pushing the roofing page next.' },
    });
    check('commentary saves', r.status === 302);

    // The print view renders the same template as the share link, so it has to
    // be exercised too — otherwise the two drift and the difference is only
    // found when a client sees a report the team never saw.
    r = await ui(`/reports/${reportRow.id}/print`);
    check('the print view renders the shared template with commentary',
      r.status === 200 && r.text.includes('Traffic held steady while enquiries rose.'),
      `got ${r.status}`);

    r = await ui(`/reports/${reportRow.id}/share`, { method: 'POST', form: { label: 'Test client' } });
    check('creating a share link redirects back to the report', r.status === 302);
    r = await ui(`/reports/${reportRow.id}`);
    const urlMatch = r.text.match(/<code id="new-share">([^<]+)<\/code>/);
    const shareUrl = urlMatch ? urlMatch[1].trim() : null;
    check('the share URL is shown exactly once', !!shareUrl, r.text.includes('share-panel') ? 'panel rendered but no URL' : 'panel missing');
    r = await ui(`/reports/${reportRow.id}`);
    check('the share URL is not shown again on a reload', !/<code id="new-share">/.test(r.text));

    const sharePath = shareUrl ? new URL(shareUrl).pathname : null;
    let pub = await anon(sharePath);
    check('a client with no session can open the share link', pub.status === 200, `got ${pub.status}`);
    check('the shared report carries the report figures', pub.text.includes('Search performance'));
    check('the shared report carries the commentary',
      pub.text.includes('Traffic held steady while enquiries rose.'));
    check('the shared report carries the lead totals', /Enquiries/.test(pub.text));

    // The security property this whole feature is judged on.
    check('the shared report carries NO lead email address',
      !pub.text.includes('jane@example.com') && !pub.text.includes('b@example.com'),
      'a shared URL is a URL that gets forwarded');
    check('the shared report carries no lead name or phone',
      !pub.text.includes('Jane Smith') && !pub.text.includes('+15550100'));
    check('the shared report is served noindex',
      /noindex/i.test(pub.headers.get('x-robots-tag') || ''), pub.headers.get('x-robots-tag'));
    check('the shared report sends no referrer',
      (pub.headers.get('referrer-policy') || '') === 'no-referrer');
    check('the shared report is not cacheable by a shared proxy',
      /no-store/.test(pub.headers.get('cache-control') || ''), pub.headers.get('cache-control'));

    const shareRow = db.prepare('SELECT * FROM report_shares WHERE report_id=?').get(reportRow.id);
    check('only a hash of the share token is stored',
      shareRow.token_hash !== shareUrl.split('/r/')[1] && shareRow.token_hash.length === 64);
    check('the view was counted', shareRow.views === 1 && !!shareRow.last_viewed_at,
      `views=${shareRow.views}`);

    pub = await anon('/r/this-is-not-a-real-token-at-all-x');
    check('an unknown token gets a 404 with a real explanation',
      pub.status === 404 && /not valid/i.test(pub.text), `got ${pub.status}`);

    // Expiry is checked before revocation, on a second link, so neither test
    // depends on the other's state.
    const shares = require('../src/lib/reportShares');
    const expired = shares.create(reportRow.id, db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL).id,
      { label: 'expired', expiresOn: daysAgo(2) });
    pub = await anon(`/r/${expired.token}`);
    check('an expired link is refused and says when it expired',
      pub.status === 410 && /expired on/i.test(pub.text), `got ${pub.status}`);

    await ui(`/reports/${reportRow.id}`);
    r = await ui(`/reports/${reportRow.id}/share/${shareRow.id}/revoke`, { method: 'POST', form: {} });
    check('revoking a link redirects back', r.status === 302);
    pub = await anon(sharePath);
    check('a revoked link stops working immediately', pub.status === 410, `got ${pub.status}`);
    check('a revoked link says it was turned off rather than "not found"',
      /turned off/i.test(pub.text));

    // ------------------------------------------------------------- erasure
    const toDelete = db.prepare('SELECT id FROM leads WHERE brand_id=? AND external_id=?').get(brand.id, 'form-2');
    await ui(`/leads?brand=${brand.id}`);
    r = await ui(`/leads/${toDelete.id}/delete`, { method: 'POST', form: {} });
    check('deleting a lead removes the row rather than flagging it',
      db.prepare('SELECT COUNT(*) c FROM leads WHERE id=?').get(toDelete.id).c === 0,
      'a "deleted" flag on a row still holding an email is not a GDPR erasure');
  } catch (err) {
    check('the test ran to completion', false, err.stack || err.message);
  } finally {
    cleanup();
    console.log(`\n${pass} passed, ${failures.length} failed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(failures.length ? 1 : 0);
  }
})();
