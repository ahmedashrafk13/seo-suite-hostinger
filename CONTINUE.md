# Resuming work on seo-automation-suite

Paste this whole file as your first message in a new session. It supersedes
any earlier copy of this file — the project has moved a long way since the
last one was written; do not trust an old version pasted from memory.

## What this project is

An SEO automation platform for Canvas Digital's brands (currently
americanwebbuilders.com is the live test brand). It consolidates Google
Search Console + GA4 data at a level of detail matching GSC/GA4 themselves
(queries, pages, countries, devices, search appearance, sitemaps, page
indexing, GA4 channels/pages/devices/geo/acquisition/events, realtime), runs
two vendored Python crawlers (a technical SEO audit and an internal linking
audit), clusters keywords, detects content opportunities, raises 40+
configurable alerts, emails a weekly report per brand, and turns all of it
into a managed task backlog with an approval gate on anything that could hurt
rankings if done wrong.

Repo: local only, path `c:\Users\The Affinity Zone\Documents\Claude Code\seo-automation-suite`
(not yet pushed anywhere — check with the user before assuming a remote exists).

This file replaces the original two-line project brief the user gave verbally
(build an audit MVP + keyword clustering + data consolidation + alerts +
weekly reports, then two agents on top). That brief is fully captured below
in the "against the original brief" section, mapped item-by-item to what
exists now.

## Current state — READ THIS FIRST

**Everything is built and running against live data**, not a prototype.
GSC property `https://www.americanwebbuilders.com/` and GA4 property
`411317117` are connected under user id 2 (ahmed.ashraf@canvasdigital.org).
Brand id 1 exists with real synced data across every table.

Login: `ahmed.ashraf@canvasdigital.org`. **The current password is whatever
the user set most recently — do not guess it or reset it.** If you need to
verify something end-to-end and don't have credentials, either ask the user,
or do what this session did throughout: call the `src/lib/*.js` functions
directly from a one-off `node -e "..."` script against the real SQLite DB
(`data/app.db`), which needs no login at all and is the fastest way to prove
a change works against real data.

Boot: `cd seo-automation-suite && npm start` (or `node src/app.js` directly —
that's what this session used, since `npm start` and `node src/app.js` are
equivalent here). Server prints its URL on boot; no build step, EJS views are
read fresh per-request in this config so edits are visible on refresh, but
**anything under `src/routes/`, `src/lib/`, or `src/db.js` requires a server
restart** (Node module cache) — `views/*.ejs` and `public/*` do not.

### SMTP is live, not a stub

`.env` has real Gmail SMTP credentials (`ahmedashrafm13@gmail.com` + an App
Password) and weekly reports actually send. **Before scaling this to more
than a couple of brands, move off a personal Gmail account** — Gmail's
sending limits and deliverability reputation are not meant for transactional
volume. Swap to a real transactional provider (Postmark, SES, Resend) by
changing four `.env` values; `src/lib/notify.js` only needs standard SMTP,
nothing Gmail-specific.

## Directory map

```
src/
  app.js            Express app wiring, session, error handler
  db.js             SQLite schema (better-sqlite3, CREATE TABLE IF NOT EXISTS
                     block — safe to add tables, they appear on next boot)
  config.js         env var loading
  lib/
    google.js       OAuth + all Google API calls (GSC search analytics,
                     sitemaps, URL Inspection, GA4 reports incl. realtime,
                     PageSpeed/CrUX)
    sync.js         pulls from google.js into SQLite; syncBrand() is the
                     nightly full-sync driver; inspectSample() is the
                     quota-limited URL Inspection sampler (see "indexing"
                     note below — candidate selection here matters a lot)
    analytics.js    all "recent vs prior window" comparison math and every
                     dimension-breakdown query the UI reads from
    alertCatalog.js 40+ alert type definitions (params, evaluators, message
                     text)
    alertEngine.js  cron scheduler: hourly alert eval, nightly sync, Monday
                     weekly-report generation + email
    reportBuilder.js builds the weekly report JSON per brand
    notify.js       email/Slack/webhook senders + HTML renderers for both
                     alert emails and the weekly report email
    tasks.js        task CRUD, status machine, the approval gate
    opportunities.js the Content Opportunity Agent (6 detectors — see below)
    clustering.js   keyword clustering (SERP-independent, GSC-driven)
    csvStore.js     reads the Python tools' CSV/JSON output; also the broken
                     link / orphan page source used by inspectSample()
    toolRunner.js   spawns the two vendored Python tools as child processes
    workflowMap.js  a living, code-based status registry of the entire SEO
                     workflow — read this for another angle on what's
                     automated vs manual; it's more granular than this file
                     in places (it existed before this session and the
                     'automated'/'manual' statuses in it are still accurate)
  routes/           one file per nav item; performance.js is the largest
                     (12 tabs of GSC/GA4-parity data + AJAX tab switching)
views/
  partials/         shared shell (sidebar/topbar/head/foot), plus chart
                     partials: trendchart.ejs (ApexCharts area, with a
                     Day/Week/Month toggle), barchart.ejs (ApexCharts
                     horizontal bar), donut.ejs (ApexCharts donut),
                     worldmap.ejs (jsVectorMap choropleth), pagination.ejs
public/css/style.css  the whole design system — additive changes only
                     (see "design system" note below)
public/js/country-codes.js  ISO alpha-3/name → alpha-2 lookup, feeds the
                     world map partial
tools/
  internal-linking-agent/   Python, vendored, run via toolRunner.js
  webtechstackdetector/     Python, vendored, run via toolRunner.js
```

### Design system note

`public/css/style.css` was substantially redesigned this session (new color
palette — confident blue `#2563eb` + slate neutrals — Plus Jakarta
Sans/Inter/Roboto Mono typography, polished buttons with real shadows/press
states, entrance animations respecting `prefers-reduced-motion`, an SVG icon
set replacing the old Unicode-glyph sidebar icons). It is finished and
intentional — extend it, don't restructure it, same as the original design
system rule that predates this session.

Charts are ApexCharts + jsVectorMap loaded via CDN `<script>` tags in
`partials/head.ejs` (no bundler in this project, so CDN is deliberate, not a
shortcut). If you add a new chart anywhere, follow the existing partial
pattern (`trendchart.ejs`/`barchart.ejs`/`donut.ejs`) rather than hand-rolling
another SVG chart — there is no reason for two charting approaches to coexist
and the old hand-rolled SVG line chart is exactly what got this rebuilt.

## Against the original brief — what's done, what's not

### Engineer 1 — Audit + clustering

- **Technical SEO audit MVP** — done, `automated` in workflowMap.js. Covers
  every item in the brief (broken links, titles, meta, H1s, redirect chains,
  non-indexable pages, canonicals, alt text, slow pages, orphans, sitemap/
  robots) via the vendored `webtechstackdetector` tool + `routes/audit.js`.
- **Keyword clustering prototype** — done and beyond prototype status.
  `src/lib/clustering.js` outputs cluster, primary keyword, supporting
  keywords, intent, suggested page type, and an existing-page-or-new
  recommendation — every field the brief asked for.

### Engineer 2 — Data, monitoring, reporting

- **SEO data consolidation** — done, and materially expanded this session
  beyond the original brief's scope: GSC now covers date/page/query/country/
  device/search-appearance/sitemaps/URL-inspection-sampled-indexing; GA4 now
  covers date/channel/page/device/browser/country/city/source-medium/event,
  plus realtime. This is genuinely GSC/GA4 feature-parity now, not just a
  consolidation layer. **Not done**: rank-tracking platform data (see gap
  below) and lead/CRM conversion data (see gap below) — the brief listed
  these as sources but neither is connected; GA4's own conversions metric is
  what conversion reporting relies on today.
- **Automated SEO alerts** — done, 40+ types in `alertCatalog.js`, covers
  every situation the brief lists (traffic drops, ranking declines,
  deindexing, 404 spikes, downtime, CWV degradation, manual-action inference,
  high-value landing page drops) plus many more. Delivered via email (SMTP
  live) and Slack/webhook (configured, untested with a real endpoint since
  this session had no Slack workspace to point at — ask the user for a
  webhook URL if they want this verified).
- **Automated weekly report** — done, matches the brief's field list exactly,
  and now actually emails (this was the one piece that was built but not
  wired to send before this session's work).

### Phase 2 — Agents

- **Content Opportunity Agent** — done. `opportunities.js` implements
  exactly six detectors: CTR gap (high impressions/low CTR), striking
  distance (positions 4–20), declining pages, refresh candidates, new-page
  opportunities from unowned clusters, and cannibalisation. All six map
  directly onto the brief's list except "competitor topics not covered" —
  see gap below.
- **Internal Linking Agent** — done. Vendored Python crawler +
  `routes/linking.js` + `src/lib/tasks.js` `fromLinkingRun()` covers every
  brief item: semantic matching, source/target/anchor-text recommendations,
  orphan flagging, link-saturation limits, and cannibalisation-aware
  exclusion (won't recommend linking between two pages competing for the
  same query).
- **SEO Task Manager Agent** — done, functionally. Every detector/alert
  already produces a task with evidence-based reasoning text (e.g. "Clicks
  fell from 320 to 210 (34.4% down). Impressions moved 5,000 → 4,900" plus a
  diagnosis and action). It is not phrased as a literal `"...because
  X..."` template sentence like the brief's examples — it's declarative
  fact-then-diagnosis narrative instead, which carries the same information.
  If the team specifically wants the literal phrasing, that's a small
  find-and-restyle job in `opportunities.js`'s `summary`/`action` builders
  and `alertCatalog.js`'s `message` builders — not a new feature, a copy
  change.
- **Content Brief Agent — NOT built.** This is the one real gap in the
  Phase-2 agent list. See below for what exists toward it and how to build
  the rest.
- **Operating rule (approval gate)** — done, enforced server-side in
  `tasks.js` `setStatus()`/`classifyApproval()`, cannot be bypassed from a
  view. Covers every category the brief lists (publishing, URL changes,
  canonical/robots edits, page removal/redirects, bulk internal links,
  titles on high-performing pages).

## What's left, and how to build it

Do not build any of this without checking with the user first on priority —
this section is a plan, not a queue. Ordered roughly by how directly it
extends what already exists (cheapest/most-connected first).

### 1. Content Brief Agent (the main gap)

**What exists toward it:** `clustering.js` already produces intent, primary
keyword, supporting keywords, and suggested page type for every cluster —
call that "half a brief" like `workflowMap.js` already notes.

**What's missing and how to add each piece:**
- *Recommended title* — generatable purely from data already on hand
  (primary keyword + intent + the cluster's top-performing existing page
  title, if any) via an LLM call, or a rule-based template as a cheaper
  first pass (`"{Primary Keyword} | {Benefit phrase by intent}"`). No new
  data source needed.
- *Suggested headings* — same: LLM call over the cluster's supporting
  keywords, or rule-based (one H2 per supporting keyword group).
- *Questions to answer* — needs either an LLM call (cheap, no new
  integration) or real "People Also Ask" data, which needs a SERP API (see
  rank-tracking gap below — same underlying dependency).
- *Competitor coverage summary* — genuinely needs to see what's currently
  ranking for the keyword. Cannot be derived from GSC (GSC only reports
  queries the brand already appears for). Needs a SERP-scraping call or a
  third-party API (DataForSEO is the cheapest per-call option; SEMrush/Ahrefs
  are more expensive but also feed the competitor-gap-analysis and
  rank-tracking gaps at the same time, so if the budget allows one
  integration, make it this one — it unblocks three gaps at once).
- *Word-count range* — derivable today, no new dependency: look at
  `csvStore`'s word-count data from the linking agent's page inventory for
  the top few existing pages ranking for the same/similar query, or (better,
  once SERP access exists) the current top 10 results' word counts.
- *Internal-link suggestions* — this one is free: it's a direct call into
  the existing internal-linking agent's `recommendations.xlsx` output, filtered
  to the target URL once the brief's page is created/identified.
- *Products/services + CTA* — needs a brand-level config: a simple list of
  "this brand sells X, Y, Z, with CTA copy A" stored per brand (new `brands`
  table columns or a JSON config field), then keyword-matched or LLM-matched
  against the brief's topic. Not automatable from GSC/GA4 data at all — this
  is inherently a piece of brand knowledge someone has to enter once.

**Practical build order**: add title/headings/word-count/internal-links
first (zero new integrations, pure win), ship that as "brief draft," then
decide whether the competitor-coverage/questions piece justifies paying for
a SERP API before building it — that's a cost decision for the user, not an
engineering one.

### 2. Competitor gap analysis

Not implementable from Search Console alone — GSC only ever reports queries
the brand already has impressions for, so "topics competitors rank for that
we don't cover at all" is structurally invisible to it. Needs one of:
DataForSEO, SEMrush, or Ahrefs API access (a paid credential the user has to
provide/purchase). Once that credential exists, this becomes a new
`opportunities.js` detector (7th type) that diffs the brand's query set
against a competitor's, keeping the same shape (`title`, `summary`, `action`,
`severity`, `score`) the other six detectors already use, so it plugs into
the existing UI/task-creation path with no new plumbing beyond the detector
itself.

### 3. Rank-tracking platform integration

Same dependency as above (a third-party API/credential). Worth asking the
user explicitly whether they still want this once GSC's own average-position
data is this granular (it now includes country/device breakdowns) — a
dedicated rank tracker mainly adds value for tracking *specific* target
keywords daily regardless of whether they currently get impressions, and for
SERP-feature visibility (featured snippets, PAA, etc.) that GSC doesn't
expose. If the user confirms they want it, the integration point is a new
`sync.js` function following the exact pattern of the GSC/GA4 sync functions
(fetch → upsert into a new `rank_tracking_daily` table → expose via a new
`analytics.js` reader → new Performance tab), so the shape of the work is
already proven three times over in this codebase.

### 4. Lead/CRM conversion data

The brief lists this as a data source but no integration exists beyond GA4's
built-in conversions. Two realistic paths: (a) a generic inbound webhook
endpoint (`POST /api/leads`) that a CRM or form tool can push to, stored in a
new `leads` table keyed by brand + landing page + timestamp, joinable against
`gsc_page_daily`/`ga4_page_daily` for "which SEO pages actually produce
leads"; or (b) a direct integration with whatever CRM the user actually uses
(HubSpot, Salesforce, etc. — ask which, since each has a different API
shape). Path (a) is buildable with zero information from the user beyond "yes
we want this"; path (b) needs the user to name the CRM first.

### 5. Task/alert message literal "because X" phrasing (cosmetic, optional)

Only worth doing if the user specifically asks for the exact phrasing style
from the brief. It's a text-generation tweak in `opportunities.js`'s
per-detector `summary`/`action` strings and `alertCatalog.js`'s per-alert
`message` builders — no data or architecture change, purely a copy edit
across ~10-15 call sites. Low priority; the current phrasing already conveys
the same cause → diagnosis → action structure.

### 6. Things this session flagged but didn't fully resolve

- Slack/webhook notification channels are implemented in `notify.js` and
  configurable per alert subscription, but were never verified against a
  real Slack webhook — ask the user for one before claiming this works
  end-to-end.
- GSC's `searchAppearance` dimension is stored as a **window snapshot**, not
  a daily trend, because the GSC API rejects combining it with any other
  dimension including date (see the comment above `syncGscAppearance` in
  `sync.js`) — this is a genuine Google API limitation, not a bug, but worth
  knowing before someone "fixes" it into a trend chart that the API can't
  actually support.
- `inspectSample()`'s candidate selection (which pages get checked for
  indexing status) was rebuilt this session to prioritize broken links and
  orphan pages over top-traffic pages, specifically because sampling only
  high-traffic pages structurally guarantees you only ever find pages that
  are already indexed. If anyone touches this function again, preserve that
  reasoning — it's documented inline but easy to accidentally regress.

## Ground rules already established (don't relitigate these)

- Approval gate is enforced in `src/lib/tasks.js` `setStatus()` — never
  bypass it from a view or route.
- The two Python tools are vendored in `tools/` and run as child processes
  via `src/lib/toolRunner.js` — don't reimplement their crawling logic in JS.
- `webtechstackdetector`'s `--json` and `--doc` flags are mutually exclusive
  in the tool itself (not a bug in this app).
- Real credentials for GSC/GA4/SMTP are already connected — don't ask the
  user to reconnect Google or re-enter SMTP creds; if something looks broken,
  check `/connect` state, `sync_runs`, and `.env` before assuming the
  integration itself is at fault.
- After any change to `src/routes/*.js`, `src/lib/*.js`, or `src/db.js`,
  restart the node process before testing — it will not pick up changes on
  its own the way `views/*.ejs` does.
- When verifying a change works, prefer calling the relevant `src/lib/*.js`
  function directly against the real DB via `node -e "..."` over guessing —
  this repo has real synced data for brand id 1, so there's rarely a reason
  to fake data or write a mock.
