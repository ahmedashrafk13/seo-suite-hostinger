# SEO Automation Suite — shared-hosting build

> This is the Hostinger/shared-hosting build of the suite. It is the same
> application with the same features; what differs is that nothing requires a
> compiler, a Python interpreter, or a process that stays running. See
> **[DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md)** for what changed and why, and
> run `npm run doctor` on any deployment to check it is configured correctly.
>
> The one step that fails *silently* if skipped is the cron job — without it,
> alerts, the nightly sync, weekly reports and backups never run.

A centralised SEO automation platform: it consolidates Google Search Console
and GA4 data per brand, runs a technical SEO audit and an internal linking
audit, clusters keywords, detects content opportunities, raises configurable
alerts, and turns all of it into a managed task backlog — with an approval
gate on any change that could affect rankings if done wrong.

**Operating rule, enforced in code, not just documented:** the automation
identifies, analyses, recommends, reports, and creates tasks. Publishing
content, changing URLs, editing canonical tags, updating `robots.txt`,
removing or redirecting pages, adding large volumes of internal links, and
changing titles on high-performing pages all require explicit SEO-team
approval before a task touching them can be marked done (`src/lib/tasks.js`).

## What's in this repo

- **Node/Express app** (`src/`) — dashboard, brand management, alerting,
  tasks, keyword clustering, reporting, and the routes/views for all of it.
- **Two vendored Python crawlers** (`tools/`), each with its own
  `requirements.txt`:
  - `tools/webtechstackdetector/main.py` — technical SEO audit crawler
    (broken links, duplicate/missing titles and meta descriptions, H1 issues,
    redirect chains, non-indexable pages, canonical issues, missing alt text,
    slow pages, orphan indicators, sitemap/robots issues).
  - `tools/internal-linking-agent/internal_link_agent.py` — crawls a site,
    finds semantically related pages, and recommends source→target internal
    links with anchor text taken verbatim from the source page; also flags
    orphan pages, keyword cannibalisation, and broken links.

  Both run as separate Python processes, spawned by
  `src/lib/toolRunner.js`. This app does not reimplement their crawling logic
  — it drives them, parses their output, and turns findings into tasks and
  alerts.

## Setup

1. **Node dependencies**
   ```
   npm install
   ```

2. **Python dependencies** (Python 3.10+; each tool is independent)
   ```
   pip install -r tools/webtechstackdetector/requirements.txt
   pip install -r tools/internal-linking-agent/requirements.txt
   ```
   Optional extras (`playwright` for JS-rendered pages, `spacy` for anchor-text
   NER filtering in the linking agent) are commented in each `requirements.txt`
   with their post-install step.

3. **Configure**: `cp .env.example .env` and fill in:
   - `SESSION_SECRET` — any long random string.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — a
     Google Cloud OAuth client with the Search Console API and Google
     Analytics Data/Admin APIs enabled, and this app's callback URL added as
     an Authorized redirect URI.
   - `PSI_API_KEY` — optional; raises the PageSpeed Insights quota.
   - `SMTP_*` / `SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` — optional
     notification channels. With none configured, alerts are logged to the
     server console instead of sent, and nothing throws. `ALERT_WEBHOOK_URL`
     is the WhatsApp path: point it at a WhatsApp Business API relay
     (Twilio, 360dialog, Meta Cloud API) or an automation hook (n8n, Make,
     Zapier) and each alert is POSTed there as JSON.
   - `INTERNAL_LINK_AGENT_PATH` / `WEBTECHSTACK_DETECTOR_PATH` — leave unset.
     They default to the vendored copies in `tools/`; only set them to point
     at a different checkout during tool development.

4. **Run**
   ```
   npm start
   ```
   Visit `http://localhost:4200` (or whatever `PORT` you set).

## How the pieces fit together

```
Google (GSC + GA4) ──┐
PageSpeed Insights ──┼─→  src/lib/sync.js  ──→  SQLite (src/db.js)
HTTP uptime probe  ──┘         (nightly)              │
                                                        ├─→ src/lib/alertEngine.js  → tasks + notifications
tools/webtechstackdetector  ──→ toolRunner.js ─────────┤       (40 alert types, src/lib/alertCatalog.js)
tools/internal-linking-agent ─→ toolRunner.js ─────────┤
                                                        ├─→ src/lib/opportunities.js → tasks
                                                        ├─→ src/lib/clustering.js    → tasks
                                                        └─→ src/lib/reportBuilder.js → weekly report
```

Everything converges on `tasks` (`src/lib/tasks.js`): every alert, audit
finding, linking finding, cluster and opportunity opens a deduplicated task
carrying the evidence that produced it. The approval gate lives there too.

## Database

SQLite via `better-sqlite3`, file at `data/app.db` (gitignored — it holds
Google OAuth refresh tokens). Schema in `src/db.js`, created and migrated
automatically on boot. Brand-keyed consolidated tables: `gsc_daily`,
`gsc_page_daily`, `gsc_query_daily`, `gsc_query_page`, `ga4_daily`,
`ga4_page_daily`, `psi_snapshots`, `uptime_checks`. Everything else —
`brands`, `alert_subscriptions`, `alert_events`, `tasks`, `task_events`,
`keyword_runs`, `weekly_reports`, `audit_runs`, `linking_runs` — hangs off
those.

## Known limitations

- **Session store is memory-based** (`express-session` default
  `MemoryStore`). Fine for a single-instance deployment; restarting the
  server logs everyone out. Swap in `connect-sqlite3` or Redis for a
  multi-instance production deployment.
- **No true rank tracking.** Search Console's average position is a blended
  national figure across devices, not a fixed-location/device rank. See the
  workflow map (`/workflow`) for the backlog item to import a dedicated rank
  tracker's export.
- **`webtechstackdetector` cannot emit `--json` and a `.docx` in the same
  run** (the flags are mutually exclusive in the tool itself). This app
  takes `--json` and renders its own downloadable report from that
  structured result (`/audit/:id/export`, `/audit/:id/csv`), rather than
  crawling the site twice.
- **URL Inspection API is quota-limited** (~2,000 calls/day/property), so the
  `page_deindexed` alert samples the top N pages by clicks rather than
  checking every page.
