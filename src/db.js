const fs = require('fs');
const path = require('path');
const { SqliteDatabase, configureJournal, configureBusyTimeout } = require('./lib/sqliteDriver');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

// SqliteDatabase is a thin adapter that prefers the native better-sqlite3 build
// and falls back to a WebAssembly SQLite when no native binary can be loaded —
// the normal case on shared hosting, which has no compiler. See
// lib/sqliteDriver.js. Everything below this line is engine-agnostic.
const db = new SqliteDatabase(config.DB_PATH, { driver: config.DB_DRIVER });
// Before anything else touches the file: a writer with no busy timeout fails
// instantly when the cron process or a second Passenger worker holds the lock.
const busyMs = configureBusyTimeout(db);
const journalMode = configureJournal(db);
db.pragma('foreign_keys = ON');
console.log(`[db] ${db.engineName}, journal=${journalMode}, busy_timeout=${busyMs}ms, file=${config.DB_PATH}`);

// --- pre-migration: retire the pre-1.0 alert_events shape -----------------
// v1 stored alert_events keyed to `alert_rules` (rule_id NOT NULL) with
// message/details/emailed columns. v2 keys them to brands + alert_subscriptions
// and carries severity/affected/suggested_action. Since the v1 table cannot
// accept a v2 insert, rebuild it — preserving nothing only when it is empty,
// and archiving the rows otherwise so nothing is silently destroyed.
try {
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='alert_events'"
  ).get();
  if (hasTable) {
    const cols = db.prepare('PRAGMA table_info(alert_events)').all().map((c) => c.name);
    if (!cols.includes('alert_key')) {
      const count = db.prepare('SELECT COUNT(*) c FROM alert_events').get().c;
      if (count > 0) {
        db.exec('ALTER TABLE alert_events RENAME TO alert_events_v1_archive');
        console.log(`[db] archived ${count} legacy alert_events row(s) to alert_events_v1_archive`);
      } else {
        db.exec('DROP TABLE alert_events');
      }
    }
  }
} catch (e) {
  console.error('[db] alert_events pre-migration warning:', e.message);
}

db.exec(`
-- ---------------------------------------------------------------- accounts
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS google_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  expiry INTEGER,
  scope TEXT,
  connected_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- ------------------------------------------------------------------ brands
-- A "brand" is the unit everything else hangs off: one website, optionally
-- paired with a verified GSC property and a GA4 property.
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  gsc_property TEXT,
  ga4_property_id TEXT,
  ga4_property_name TEXT,
  notify_email TEXT,
  slack_webhook TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, site_url)
);

-- ------------------------------------------------- consolidated GSC / GA4
CREATE TABLE IF NOT EXISTS gsc_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date)
);

CREATE TABLE IF NOT EXISTS gsc_page_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, page)
);
CREATE INDEX IF NOT EXISTS idx_gsc_page_daily_brand_date ON gsc_page_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS gsc_query_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_brand_date ON gsc_query_daily (brand_id, date);

-- query x page, stored per sync window rather than per day (GSC caps rows
-- hard on 2-dimension queries, so a daily breakdown is not reliable).
CREATE TABLE IF NOT EXISTS gsc_query_page (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, period_start, period_end, query, page)
);

CREATE TABLE IF NOT EXISTS ga4_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'Organic Search',
  sessions REAL NOT NULL DEFAULT 0,
  users REAL NOT NULL DEFAULT 0,
  engaged_sessions REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  bounce_rate REAL NOT NULL DEFAULT 0,
  avg_duration REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, channel)
);

-- GSC dimensions beyond page/query, mirroring the Performance report's
-- Countries / Devices / Search appearance breakdown tabs.
CREATE TABLE IF NOT EXISTS gsc_country_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  country TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, country)
);
CREATE INDEX IF NOT EXISTS idx_gsc_country_daily_brand_date ON gsc_country_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS gsc_device_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  device TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, device)
);
CREATE INDEX IF NOT EXISTS idx_gsc_device_daily_brand_date ON gsc_device_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS gsc_appearance_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  appearance TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, appearance)
);
CREATE INDEX IF NOT EXISTS idx_gsc_appearance_daily_brand_date ON gsc_appearance_daily (brand_id, date);

-- Sitemap browser: one row per submitted sitemap, replaced wholesale on each
-- sync since GSC only exposes current state, not history.
CREATE TABLE IF NOT EXISTS gsc_sitemaps (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  is_pending INTEGER NOT NULL DEFAULT 0,
  is_sitemaps_index INTEGER NOT NULL DEFAULT 0,
  type TEXT,
  last_submitted TEXT,
  last_downloaded TEXT,
  warnings INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  submitted_count INTEGER,
  indexed_count INTEGER,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brand_id, path)
);

CREATE TABLE IF NOT EXISTS ga4_page_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  page_path TEXT NOT NULL,
  sessions REAL NOT NULL DEFAULT 0,
  users REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, page_path)
);

-- GA4 dimensions beyond channel/page, mirroring GA4's Tech > Device/Browser,
-- Demographics > Country, Acquisition > Session source/medium, and
-- Engagement > Events reports.
CREATE TABLE IF NOT EXISTS ga4_device_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  device_category TEXT NOT NULL,
  browser TEXT NOT NULL DEFAULT '(not set)',
  sessions REAL NOT NULL DEFAULT 0,
  users REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, device_category, browser)
);
CREATE INDEX IF NOT EXISTS idx_ga4_device_daily_brand_date ON ga4_device_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS ga4_geo_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '(not set)',
  sessions REAL NOT NULL DEFAULT 0,
  users REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, country, city)
);
CREATE INDEX IF NOT EXISTS idx_ga4_geo_daily_brand_date ON ga4_geo_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS ga4_acquisition_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  sessions REAL NOT NULL DEFAULT 0,
  users REAL NOT NULL DEFAULT 0,
  new_users REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, source, medium)
);
CREATE INDEX IF NOT EXISTS idx_ga4_acquisition_daily_brand_date ON ga4_acquisition_daily (brand_id, date);

CREATE TABLE IF NOT EXISTS ga4_event_daily (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_count REAL NOT NULL DEFAULT 0,
  total_users REAL NOT NULL DEFAULT 0,
  event_value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, date, event_name)
);
CREATE INDEX IF NOT EXISTS idx_ga4_event_daily_brand_date ON ga4_event_daily (brand_id, date);

-- URL Inspection snapshots — the closest available substitute for GSC's Page
-- Indexing report (Google exposes no bulk "index coverage" API; this samples
-- pages one at a time via the URL Inspection API, quota-limited to ~2,000
-- calls/day/property, so it is a rolling sample rather than an exhaustive crawl).
CREATE TABLE IF NOT EXISTS url_inspections (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  verdict TEXT,
  coverage_state TEXT,
  robots_txt_state TEXT,
  indexing_state TEXT,
  page_fetch_state TEXT,
  google_canonical TEXT,
  user_canonical TEXT,
  last_crawl_time TEXT,
  error TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brand_id, url)
);
CREATE INDEX IF NOT EXISTS idx_url_inspections_brand ON url_inspections (brand_id, coverage_state);

-- --------------------------------------------- PageSpeed / CrUX / uptime
CREATE TABLE IF NOT EXISTS psi_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'mobile',
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  perf_score REAL,
  lcp REAL,
  inp REAL,
  cls REAL,
  fcp REAL,
  ttfb REAL,
  source TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_psi_brand ON psi_snapshots (brand_id, captured_at);

CREATE TABLE IF NOT EXISTS uptime_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  status_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  response_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_uptime_brand ON uptime_checks (brand_id, checked_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  rows_written INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- ------------------------------------------------------------ tool runs
CREATE TABLE IF NOT EXISTS audit_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  max_pages INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  pid INTEGER,
  error TEXT,
  json_result TEXT,
  docx_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS linking_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  used_gsc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  pid INTEGER,
  error TEXT,
  out_dir TEXT,
  json_result TEXT,
  docx_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- ------------------------------------------------------------- alerting
-- One row per (brand, alert type) the user has switched on, with their own
-- threshold, cadence and channels. The catalog of types lives in code
-- (src/lib/alertCatalog.js); this table only stores the user's choices.
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  params_json TEXT,
  frequency TEXT NOT NULL DEFAULT 'daily',
  channels TEXT NOT NULL DEFAULT 'email',
  recipients TEXT,
  severity TEXT,
  create_task INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brand_id, alert_key)
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES alert_subscriptions(id) ON DELETE SET NULL,
  alert_key TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  message TEXT,
  affected TEXT,
  suggested_action TEXT,
  details_json TEXT,
  dedupe_key TEXT,
  notified TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_events_user ON alert_events (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_dedupe ON alert_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ------------------------------------------------------ task management
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  category TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'backlog',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by TEXT,
  assignee TEXT,
  due_date TEXT,
  effort TEXT,
  affected_url TEXT,
  evidence_json TEXT,
  dedupe_key TEXT,
  completion_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------- keyword clustering
CREATE TABLE IF NOT EXISTS keyword_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  keyword_count INTEGER NOT NULL DEFAULT 0,
  cluster_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A cluster must be approved before a content brief can be generated for it
-- (mirrors the same human-in-the-loop philosophy already enforced for tasks
-- in tasks.js — briefs are cheap to generate, but generating them for
-- arbitrary keywords defeats the point of "approved" in the brief spec).
-- Clusters live inside keyword_runs.result_json, not their own rows, so
-- approval is keyed on (keyword_run_id, cluster_id) rather than a foreign key.
CREATE TABLE IF NOT EXISTS approved_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword_run_id INTEGER NOT NULL REFERENCES keyword_runs(id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL,
  primary_keyword TEXT,
  approved_by TEXT,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(keyword_run_id, cluster_id)
);

-- ------------------------------------------------------ weekly reports
CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  data_json TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brand_id, period_start, period_end)
);

-- --------------------------------------------------------- app settings
CREATE TABLE IF NOT EXISTS app_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key)
);
`);

// --- additive migrations for databases created by earlier versions --------
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

try {
  addColumn('audit_runs', 'brand_id', 'brand_id INTEGER');
  addColumn('audit_runs', 'log_tail', 'log_tail TEXT');
  addColumn('audit_runs', 'tasks_created', 'tasks_created INTEGER NOT NULL DEFAULT 0');
  addColumn('linking_runs', 'brand_id', 'brand_id INTEGER');
  addColumn('linking_runs', 'log_tail', 'log_tail TEXT');
  addColumn('linking_runs', 'tasks_created', 'tasks_created INTEGER NOT NULL DEFAULT 0');
  addColumn('linking_runs', 'max_pages', 'max_pages INTEGER');
  // One-time-per-brand inputs the Content Brief Agent cannot derive from any
  // synced data — what the brand actually sells, and how it wants to ask for
  // the sale. Set once in the brand's settings, reused by every brief after.
  addColumn('brands', 'services_json', 'services_json TEXT');
  addColumn('brands', 'cta_json', 'cta_json TEXT');
  // Vertical/locale config so clustering, opportunities and content briefs
  // stop assuming every brand is a services/agency business. `vertical` is
  // one of ecommerce|saas|local_service|professional_services|
  // publisher_content|marketplace|other; unset/NULL means 'other', which
  // must always degrade to the original generic behaviour, never crash.
  addColumn('brands', 'vertical', 'vertical TEXT');
  addColumn('brands', 'locale', 'locale TEXT');
  addColumn('brands', 'market', 'market TEXT');
} catch (e) {
  console.error('[db] migration warning:', e.message);
}

db.exec(`
CREATE TABLE IF NOT EXISTS content_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  keyword_run_id INTEGER REFERENCES keyword_runs(id) ON DELETE SET NULL,
  cluster_id INTEGER,
  primary_keyword TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_briefs_user ON content_briefs (user_id, created_at);
`);

// The pre-1.0 `alert_rules` table is superseded by `alert_subscriptions`.
// It is left in place (harmless) so no existing row is destroyed, but the
// scheduler no longer reads it.

// ------------------------------------------------------------------ AI Lab
// Additive, separate section for the AI Lab comparison area (see
// src/lib/ai/*, src/routes/aiLab.js). Every table here is purely additive —
// nothing above this block is touched — and every row is written only from
// an explicit, manual user action, never from a scheduled job.
db.exec(`
-- Every AI call this app ever makes is logged here for the hard spend cap
-- and the cost dashboard. Rows are never deleted by app code.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created ON ai_usage_log (created_at);

-- AI Content Brief: one row per (brand, cluster, inputs) — see input_hash.
CREATE TABLE IF NOT EXISTS ai_content_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  title TEXT,
  headings_json TEXT,
  angle_note TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_content_briefs_lookup ON ai_content_briefs (brand_id, cluster_key);

-- AI Opportunity Recommendations: one batched call per (brand, input set).
CREATE TABLE IF NOT EXISTS ai_opportunity_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  findings_json TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_opportunity_notes_lookup ON ai_opportunity_notes (brand_id, input_hash);

-- AI Linking Rationale.
CREATE TABLE IF NOT EXISTS ai_linking_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  notes_json TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_linking_notes_lookup ON ai_linking_notes (brand_id, input_hash);

-- AI Task Recommendations.
CREATE TABLE IF NOT EXISTS ai_task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  notes_json TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_task_notes_lookup ON ai_task_notes (brand_id, input_hash);

-- --------------------------------------------------- PageSpeed Insights
-- Full PSI reports, stored verbatim. psi_snapshots keeps the small numeric
-- series the CWV alerts read; this keeps the whole Lighthouse payload so a
-- report can be re-opened months later and rendered exactly as it ran,
-- without spending another API call.
CREATE TABLE IF NOT EXISTS psi_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'mobile',
  performance INTEGER,
  accessibility INTEGER,
  best_practices INTEGER,
  seo INTEGER,
  credential TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psi_reports_user ON psi_reports (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_psi_reports_url ON psi_reports (url, strategy, created_at);
`);

// ------------------------------------------------------------------- teams
// Everything in this app was originally owned by a single user_id. A team
// shares one owner's data: the owner's brands, tasks, reports and Google
// connection are the team's. Members are resolved to that owner at request
// time (see app.js), so every existing per-user query keeps working while
// the whole team now sees the same workspace.
db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Assignable people. Not every assignee needs a login: developers usually
-- just receive the task by email, so a person can exist here with only a name
-- and an address. Once captured, the address is remembered, which is what
-- makes "who did I give this to last time, and at what email" answerable.
CREATE TABLE IF NOT EXISTS team_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'seo',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_assigned_at TEXT,
  assignment_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_people_team ON team_people (team_id, active);

-- Delivery log for assignment emails: an assignment that silently failed to
-- send is worse than one that was never made, so every attempt is recorded.
CREATE TABLE IF NOT EXISTS task_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES team_people(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_notifications_task ON task_notifications (task_id);
`);

// --- post-migration: team columns on users and tasks -----------------------
try {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const addUser = (name, decl) => {
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${decl}`);
  };
  addUser('team_id', 'INTEGER REFERENCES teams(id) ON DELETE SET NULL');
  // admin  — runs the team: approves members, sets roles, assigns anything
  // seo    — does the SEO work; may be granted assignment rights
  // dev    — receives implementation tasks; read-only on everything else
  addUser('role', "TEXT NOT NULL DEFAULT 'admin'");
  // pending users can authenticate but see nothing until an admin approves.
  addUser('status', "TEXT NOT NULL DEFAULT 'active'");
  addUser('can_assign', 'INTEGER NOT NULL DEFAULT 0');

  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  const addTask = (name, decl) => {
    if (!taskCols.includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`);
  };
  // tasks.assignee stays as the display name so every existing query, filter
  // and export keeps working; these columns add the identity behind it.
  addTask('assignee_person_id', 'INTEGER REFERENCES team_people(id) ON DELETE SET NULL');
  addTask('assignee_email', 'TEXT');
  addTask('assigned_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addTask('assigned_at', 'TEXT');
} catch (e) {
  console.error('[db] team migration warning:', e.message);
}

// --- backfill: every existing account becomes the admin of its own team ----
// Data was per-user before, so one team per existing user preserves exactly
// what each of them could already see. Nobody gains access to anything.
try {
  const orphans = db.prepare('SELECT id, email, name FROM users WHERE team_id IS NULL').all();
  const makeTeam = db.prepare('INSERT INTO teams (name, owner_user_id, invite_code) VALUES (?,?,?)');
  const setUser = db.prepare("UPDATE users SET team_id=?, role='admin', status='active', can_assign=1 WHERE id=?");
  const addPerson = db.prepare(`INSERT OR IGNORE INTO team_people (team_id, user_id, name, email, role, created_by)
    VALUES (?,?,?,?,'admin',?)`);
  orphans.forEach((u) => {
    const label = u.name || String(u.email).split('@')[0];
    // A short, human-typeable code rather than a UUID — it gets read aloud.
    const code = `${label.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() || 'team'}-${u.id}${Math.random().toString(36).slice(2, 6)}`;
    const t = makeTeam.run(`${label}'s team`, u.id, code);
    setUser.run(t.lastInsertRowid, u.id);
    addPerson.run(t.lastInsertRowid, u.id, u.name || u.email, u.email, u.id);
  });
  if (orphans.length) console.log(`[db] created ${orphans.length} team(s) for existing user(s)`);
} catch (e) {
  console.error('[db] team backfill warning:', e.message);
}

// --- post-migration: assignment emails become a queue ----------------------
// Assigning six tasks to one developer used to mean six emails. Notifications
// are now queued and swept into ONE message per person, so the volume of email
// tracks the number of people you assigned to, not the number of tasks.
try {
  const cols = db.prepare('PRAGMA table_info(task_notifications)').all().map((c) => c.name);
  if (!cols.includes('status')) {
    // Existing rows were sent immediately, so they are already terminal.
    db.exec("ALTER TABLE task_notifications ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'");
  }
  if (!cols.includes('sent_at')) db.exec('ALTER TABLE task_notifications ADD COLUMN sent_at TEXT');
  if (!cols.includes('note')) db.exec('ALTER TABLE task_notifications ADD COLUMN note TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_notifications_queue ON task_notifications (status, email)');
} catch (e) {
  console.error('[db] task_notifications migration warning:', e.message);
}

// --- post-migration: widen url_inspections ---------------------------------
// The URL Inspection response carries more than the original columns kept:
// which Googlebot crawled the page, which sitemap it was found in, the pages
// linking to it, and the rich-result types Google detected. All of it arrives
// in the SAME API call that was already being made and was simply discarded —
// so backfilling these columns costs no extra quota, it just stops throwing
// the answer away. CREATE TABLE IF NOT EXISTS cannot add columns to an
// existing table, hence the explicit ALTERs.
try {
  const cols = db.prepare('PRAGMA table_info(url_inspections)').all().map((c) => c.name);
  const add = (name, decl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE url_inspections ADD COLUMN ${name} ${decl}`);
  };
  add('crawled_as', 'TEXT');            // DESKTOP | MOBILE — which bot indexed it
  add('sitemap', 'TEXT');               // sitemap(s) the URL was discovered in
  add('referring_urls', 'TEXT');        // internal/external pages Google followed
  add('rich_result_verdict', 'TEXT');   // PASS | FAIL | NEUTRAL | null when none
  add('rich_result_types', 'TEXT');     // e.g. "Product snippets, Review snippets"
  add('rich_result_issues', 'TEXT');    // JSON: [{type, severity, message}]
} catch (e) {
  console.error('[db] url_inspections migration warning:', e.message);
}

// Release the database when the process ends, however it ends.
//
// This matters far more with the WebAssembly engine than it did with the native
// one. node-sqlite3-wasm holds SQLite's file lock as a "<database>.lock"
// DIRECTORY, and only the process that created it removes it — so a process
// that exits without closing leaves the lock behind and every later connection
// fails with "database is locked" until someone deletes it by hand. It also
// leaves the WASM runtime's handles open, which is what produces the
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" crash on exit.
//
// Both symptoms appeared while running this project's own verification
// scripts back to back: the first script exited without closing, and every
// script after it failed to open the database at all.
//
// 'exit' fires for a normal return and for an explicit process.exit(), and only
// synchronous work is allowed there — which close() is. The signal handlers
// cover Passenger stopping an idle app. Nothing can be done about SIGKILL,
// which is what the stale-lock recovery in lib/sqliteDriver.js is for.
let closed = false;
function closeDb() {
  if (closed) return;
  closed = true;
  try { db.close(); } catch { /* already gone; nothing useful to do at exit */ }
}
process.on('exit', closeDb);
// beforeExit fires when the loop empties but the process may still continue, so
// it is deliberately NOT hooked — closing there would break a server that is
// merely idle between requests.
process.once('SIGINT', () => { closeDb(); process.exit(130); });
process.once('SIGTERM', () => { closeDb(); process.exit(143); });
// An uncaught exception is about to end the process; release the lock so the
// next start is not blocked by this crash.
process.once('uncaughtException', (err) => {
  console.error('[fatal]', err);
  closeDb();
  process.exit(1);
});

module.exports = db;
module.exports.closeDb = closeDb;
