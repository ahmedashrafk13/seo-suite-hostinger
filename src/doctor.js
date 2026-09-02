// Preflight check: `npm run doctor`.
//
// Every problem this deployment can have is one that fails QUIETLY. A missing
// CRON_TOKEN means alerts never fire, and the dashboard looks perfectly healthy.
// A DATA_DIR left inside the app folder works fine until the next deploy erases
// it. A native module that failed to install shows up as one broken page, days
// later. So this script asks each question out loud and prints an answer.
//
// It is safe to run at any time, including against a live install: it only
// reads, apart from touching its own temp file to confirm the directory is
// writable.
const fs = require('fs');
const path = require('path');
const config = require('./config');

let problems = 0;
let warnings = 0;

const ok = (label, detail) => console.log(`  ok      ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, detail) => { warnings += 1; console.log(`  WARN    ${label}${detail ? ` — ${detail}` : ''}`); };
const bad = (label, detail) => { problems += 1; console.log(`  PROBLEM ${label}${detail ? ` — ${detail}` : ''}`); };

console.log('\nSEO Automation Suite — deployment check\n');

// --- runtime --------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok('Node version', process.version);
else bad('Node version', `${process.version} — this app needs Node 18 or newer`);

// --- database -------------------------------------------------------------
let db;
try {
  db = require('./db');
  ok('Database opens', `${db.engineName} at ${config.DB_PATH}`);
  const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
  ok('Schema present', `${tables} tables`);
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (users === 0) warn('No accounts yet', 'sign up once to create the first workspace');
  else ok('Accounts', `${users} user(s)`);
} catch (err) {
  bad('Database', err.message);
}

// --- where state lives ----------------------------------------------------
// The single most damaging misconfiguration: a database inside the deploy
// directory is deleted by the next Git deployment or re-upload.
const insideApp = (p) => path.resolve(p).startsWith(path.resolve(config.ROOT) + path.sep);
if (insideApp(config.DATA_DIR)) {
  warn('DATA_DIR is inside the application folder',
    `${config.DATA_DIR} — a redeploy will DELETE the database. Set DATA_DIR to a `
    + 'directory outside the app (e.g. ~/seo-suite-data) and move data/ there.');
} else {
  ok('DATA_DIR is outside the application folder', config.DATA_DIR);
}

for (const [label, dir] of [['DATA_DIR', config.DATA_DIR], ['REPORTS_DIR', config.REPORTS_DIR], ['TMP_DIR', config.TMP_DIR]]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok(`${label} writable`, dir);
  } catch (err) {
    bad(`${label} not writable`, `${dir} — ${err.message}`);
  }
}

// --- security -------------------------------------------------------------
if (config.SESSION_SECRET === 'dev-insecure-secret-change-me') {
  bad('SESSION_SECRET is the default',
    'anyone can forge a signed cookie and sign in as an admin. Set a long random value.');
} else if (config.SESSION_SECRET.length < 24) {
  warn('SESSION_SECRET is short', 'use at least 32 random characters');
} else {
  ok('SESSION_SECRET set');
}

if (process.env.NODE_ENV === 'production') ok('NODE_ENV', 'production');
else warn('NODE_ENV is not production', 'error pages will show stack traces to visitors');

if (process.env.SIGNUP_REQUIRES_INVITE === '1') ok('Sign-up requires an invite');
else warn('Sign-up is open', 'anyone who finds the URL can create a workspace. Set SIGNUP_REQUIRES_INVITE=1.');

// --- scheduled work -------------------------------------------------------
// This is the check that exists because the failure is invisible.
if (config.INPROCESS_CRON) {
  ok('Scheduler', 'running in-process (correct for a server that stays up)');
} else if (!config.CRON_TOKEN) {
  bad('Scheduled jobs cannot run',
    'CRON_TOKEN is not set and the in-process scheduler is disabled, so alerts, the nightly '
    + 'sync, weekly reports and backups will NEVER run. See DEPLOY-HOSTINGER.md.');
} else {
  ok('CRON_TOKEN set');
  try {
    const scheduler = require('./lib/scheduler');
    const rows = scheduler.status();
    const everRan = rows.some((r) => r.lastRunAt);
    if (!everRan) {
      warn('No scheduled job has run yet',
        `confirm the hPanel cron job fetches ${config.BASE_URL || 'https://your-domain'}/internal/cron?token=…`);
    } else {
      rows.forEach((r) => {
        const when = r.lastRunAt ? r.lastRunAt.replace('T', ' ').slice(0, 16) : 'never';
        if (r.lastStatus === 'error') warn(`  job ${r.key}`, `last run ${when} FAILED: ${r.lastError}`);
        else console.log(`  ok      job ${r.key.padEnd(12)} last run ${when}`);
      });
    }
  } catch (err) {
    warn('Scheduler status unavailable', err.message);
  }
}

// --- crawlers -------------------------------------------------------------
try {
  const toolRunner = require('./lib/toolRunner');
  toolRunner.runtimeStatus().forEach((s) => {
    ok(s.label, `${s.using}${s.note ? ` (${s.note})` : ''}`);
  });
  const avail = toolRunner.toolAvailability();
  if (!avail.audit.exists) bad('Audit tool missing', avail.audit.script);
  if (!avail.linking.exists) bad('Linking tool missing', avail.linking.script);
} catch (err) {
  bad('Crawler check failed', err.message);
}

// --- integrations ---------------------------------------------------------
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  ok('Google OAuth configured');
  if (!config.BASE_URL && !process.env.GOOGLE_REDIRECT_URI) {
    warn('BASE_URL not set',
      `the OAuth redirect defaults to ${config.GOOGLE_REDIRECT_URI}, which will not work in production`);
  } else {
    ok('OAuth redirect URI', config.GOOGLE_REDIRECT_URI);
  }
} else {
  warn('Google OAuth not configured', 'Search Console and GA4 data cannot be connected');
}

if (config.SMTP_HOST) ok('SMTP configured', config.SMTP_HOST);
else warn('SMTP not configured', 'alert and report emails are written to the log instead of sent');

// --- native modules -------------------------------------------------------
// Not a problem — the whole point of this build is that it works without them.
// Reported so the performance difference is not a mystery.
try {
  require.resolve('better-sqlite3');
  ok('Native SQLite available', 'faster than the WebAssembly build');
} catch {
  // This used to read "everything works; it is simply slower", which is not
  // true and is the kind of reassurance that loses a database.
  //
  // The wasm VFS locks by creating a `<db>.lock` DIRECTORY (mkdir is atomic, so
  // EEXIST -> SQLITE_BUSY). That is a real mutex, but a coarse one: it ignores
  // SQLite's lock levels entirely, so readers take the same exclusive lock as
  // writers, and WAL is unavailable because the VFS has no shared memory. It
  // also records no owner and never refreshes the lock's mtime, which is what
  // previously let one process delete a live process's lock and corrupt the
  // file (see sqliteDriver.js). That specific hole is now closed, but a single
  // writer is still the only configuration this engine is really safe in.
  warn('WebAssembly SQLite engine in use (better-sqlite3 native is not installed)',
    'Prefer ONE writer process. Locking is a coarse whole-file mutex with no WAL, so the web app, `npm run cron` and the backup job all writing concurrently will serialise badly and leave less margin for error. Keep backups, and install better-sqlite3 (real locking plus WAL) wherever a compiler is available.');
}
try {
  require.resolve('bcrypt');
  ok('Native bcrypt available');
} catch {
  console.log('  note    bcrypt (native) is not installed — bcryptjs is in use. Same hashes, slower logins.');
}

// --- AI SEO suite ---------------------------------------------------------
// Reported rather than checked-and-failed, because none of it is required:
// every one of the nine analyses runs on the built-in crawler alone. What is
// worth surfacing is WHICH questions this deployment can answer, so nobody
// spends a week wondering why a backlink column is empty.
try {
  const providers = require('./lib/aiseo/providers');
  const trackingCatalog = require('./lib/aiseo/trackingCatalog');

  const availableChecks = trackingCatalog.availability().filter((c) => c.available).length;
  const totalChecks = trackingCatalog.all().length;
  if (availableChecks === totalChecks) {
    ok(`AI SEO tracking board: all ${totalChecks} checks runnable`);
  } else {
    const blocked = trackingCatalog.availability().filter((c) => !c.available);
    warn(`AI SEO tracking board: ${availableChecks} of ${totalChecks} checks runnable`,
      blocked.map((c) => `${c.key} needs ${c.missing.map((m) => m.label).join(', ')}`).join('; '));
  }

  if (providers.has('azure')) {
    ok('AI SEO: Azure OpenAI configured', 'prompt research, edit suggestions, schema drafting and mention triage are available');
  } else {
    warn('AI SEO: no Azure OpenAI credential',
      'every score, measurement and finding still works — it is computed locally. Only the AI-written half (prompts, edit suggestions, schema drafts, mention triage) is unavailable.');
  }

  if (!providers.has('public')) {
    warn('AI SEO: keyless public sources disabled (AISEO_DISABLE_PUBLIC_SOURCES=1)',
      'keyword expansion via Google autocomplete and all reputation scanning report themselves as disabled');
  } else if (providers.isEnhanced('reddit') === false) {
    console.log('  note    AI SEO: no Reddit credential. Reddit is still scraped successfully — the RSS tier');
    console.log('          answers where the JSON endpoint 403s — but it is rate-limited, carries no post');
    console.log('          scores, and returns post bodies without their comment threads. A free script app');
    console.log('          at reddit.com/prefs/apps removes all three limits. Raise REDDIT_DELAY_MS if scans');
    console.log('          report rate limits.');
  }

  const commercial = providers.all().filter((p) => ['keyword-tool', 'backlinks', 'rank-tracker'].includes(p.kind));
  const configured = commercial.filter((p) => p.available);
  if (configured.length) {
    ok(`AI SEO: ${configured.map((p) => p.label).join(', ')} configured`);
  } else {
    console.log('  note    AI SEO: no Semrush/Ahrefs/Moz/DataForSEO credential. Search volume, keyword');
    console.log('          difficulty, backlink counts, competitor traffic and AI citation share are NOT');
    console.log('          shown anywhere — they are not knowable here, and every affected page says so');
    console.log('          rather than estimating them. See .env.example to enable an adapter.');
  }
} catch (err) {
  warn('AI SEO suite could not be inspected', err.message);
}

console.log(`\n${problems} problem(s), ${warnings} warning(s).\n`);
if (problems) {
  console.log('Fix the PROBLEM lines before relying on this deployment.\n');
}
process.exit(problems ? 1 : 0);
