const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

// WHERE MUTABLE STATE LIVES
//
// On a developer machine the database, reports and temp files sit inside the
// project directory, which is fine because nothing ever deletes that directory.
// On Hostinger they must not: a Git deployment (or a re-upload) replaces the
// application folder wholesale, so a database stored under ROOT is destroyed by
// the next deploy. The fix is to keep state in a sibling directory that no
// deployment touches — typically ~/seo-suite-data — selected with DATA_DIR.
//
// DATA_DIR defaults to <ROOT>/data so local development is unchanged and no
// existing install has to be reconfigured.
function resolveDir(envValue, fallback) {
  const dir = envValue ? path.resolve(ROOT, envValue) : fallback;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* surfaced at first use */ }
  return dir;
}

const DATA_DIR = resolveDir(process.env.DATA_DIR, path.join(ROOT, 'data'));
const REPORTS_DIR = resolveDir(process.env.REPORTS_DIR, path.join(ROOT, 'reports'));
// Passenger gives each app a writable home, but /tmp is shared and can be
// wiped mid-run, so temp files default to a directory we control.
const TMP_DIR = resolveDir(process.env.TMP_DIR, path.join(ROOT, 'tmp'));

// Resolves a Python tool's entry script.
//
// The two crawlers are vendored under tools/ so a fresh clone is self-contained
// and needs nothing but `pip install -r`. Resolution order:
//   1. an explicit path in .env  — wins outright, so a developer working on the
//      tool can point at their own checkout
//   2. the vendored copy under tools/
//   3. the original sibling-directory layout, kept so existing installs that
//      predate vendoring keep working without editing .env
//
// On shared hosting none of these may be runnable at all — there is no
// guarantee of a Python interpreter, let alone one with httpx/numpy/lxml
// installed. That is not a failure case here: toolRunner falls back to the
// JavaScript ports in tools/node/, which need nothing but Node. The paths are
// still resolved because Python, when present, is the faster implementation.
function resolveTool(envValue, vendoredRelative, siblingRelative) {
  if (envValue) {
    const explicit = path.resolve(ROOT, envValue);
    // Only honour the override if it actually exists; otherwise fall through
    // rather than failing with a path nobody set deliberately.
    if (fs.existsSync(explicit)) return explicit;
  }
  const vendored = path.resolve(ROOT, vendoredRelative);
  if (fs.existsSync(vendored)) return vendored;
  return path.resolve(ROOT, siblingRelative);
}

// Public base URL of the deployment. Needed because behind Passenger the app
// cannot infer its own https://domain from PORT — OAuth redirects and the links
// inside emailed reports would otherwise point at localhost.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

module.exports = {
  ROOT,
  PORT: process.env.PORT || 4200,
  BASE_URL,
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI:
    process.env.GOOGLE_REDIRECT_URI ||
    (BASE_URL
      ? `${BASE_URL}/api/auth/google/callback`
      : `http://localhost:${process.env.PORT || 4200}/api/auth/google/callback`),
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'alerts@example.com',
  INTERNAL_LINK_AGENT_PATH: resolveTool(
    process.env.INTERNAL_LINK_AGENT_PATH,
    'tools/internal-linking-agent/internal_link_agent.py',
    '../internal-linking-agent/internal_link_agent.py'
  ),
  WEBTECHSTACK_DETECTOR_PATH: resolveTool(
    process.env.WEBTECHSTACK_DETECTOR_PATH,
    'tools/webtechstackdetector/main.py',
    '../webtechstackdetector/main.py'
  ),
  // JavaScript ports of the two crawlers. These always exist, so the audit and
  // internal-linking features work on a host with no Python at all.
  NODE_AUDIT_PATH: path.join(ROOT, 'tools', 'node', 'audit', 'main.js'),
  NODE_LINKING_PATH: path.join(ROOT, 'tools', 'node', 'linking', 'main.js'),
  // 'auto' prefers Python when a usable interpreter exists and falls back to
  // Node; 'node' and 'python' force one implementation (useful for comparing
  // the two, and for pinning behaviour on a host where Python is flaky).
  TOOL_RUNTIME: (process.env.TOOL_RUNTIME || 'auto').toLowerCase(),
  PYTHON_BIN: process.env.PYTHON_BIN || 'python',
  DATA_DIR,
  DB_PATH: process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(DATA_DIR, 'app.db'),
  // 'auto' uses the native better-sqlite3 build when one is installed and
  // silently falls back to the WebAssembly build, which needs no compiler and
  // therefore works on hosts with no build toolchain.
  DB_DRIVER: (process.env.DB_DRIVER || 'auto').toLowerCase(),
  REPORTS_DIR,
  TMP_DIR,
  // Shared secret for the HTTP cron endpoint. Scheduled work cannot run in
  // process on shared hosting (see src/lib/scheduler.js), so it is driven by an
  // external cron hitting a URL — which must not be publicly triggerable.
  CRON_TOKEN: process.env.CRON_TOKEN || '',
  // In-process node-cron is the right choice on a always-on server and the
  // wrong one behind Passenger. Default: on locally, off in production.
  INPROCESS_CRON:
    process.env.INPROCESS_CRON === '1' ||
    (process.env.INPROCESS_CRON !== '0' && process.env.NODE_ENV !== 'production'),
};
