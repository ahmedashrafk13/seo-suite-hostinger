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

On top of that sits the **AI SEO suite** (`/ai-seo`): nine analyses aimed at
the question classic SEO tooling does not answer — whether an AI answer engine
can find, read, and cite the site. See
[The AI SEO suite](#the-ai-seo-suite) below.

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
- **The AI SEO suite** (`src/lib/aiseo/`, routes in `src/routes/aiseo.js`,
  views in `views/aiseo/`) — nine analyses plus a twenty-check tracking board.
  Unlike the two crawlers above these run **in this process**, because they
  read one page or a handful rather than sweeping a whole site, and because a
  second process opening `data/app.db` while the app is running has corrupted
  it before. Long runs are detached through `src/lib/aiseo/runner.js` and
  polled, rather than held open in a request.

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
tools/webtechstackdetector  ──→ toolRunner.js ───────┤       (46 alert types, src/lib/alertCatalog.js)
tools/internal-linking-agent ─→ toolRunner.js ───────┤
                                                      ├─→ src/lib/opportunities.js → tasks
                                                      ├─→ src/lib/clustering.js    → tasks
                                                      ├─→ src/lib/reportBuilder.js → weekly report
                                                      │
  live pages / competitor sites ─→ aiseo/fetcher.js ──┤
  Google autocomplete, HN, news ──→ aiseo/*.js ───────┼─→ aiseo/store.js (runs, findings, metric series)
  Azure OpenAI ──────────────────→ aiseo/aiCalls.js ──┘        └─→ tasks
```

Everything converges on `tasks` (`src/lib/tasks.js`): every alert, audit
finding, linking finding, cluster, opportunity and AI SEO finding opens a
deduplicated task carrying the evidence that produced it. The approval gate
lives there too.

## The AI SEO suite

Nine analyses at `/ai-seo`, aimed at a question the rest of the app does not
ask: can an AI answer engine find this site, read it, and cite it?

| Analysis | What it measures |
|---|---|
| **Keyword & prompt research** | Search Console queries and Google autocomplete for the search box, and the AI model for the *prompts* people type into ChatGPT, Perplexity and Gemini — whole questions with a stated situation, which cannot be derived from a keyword list. Clustered by intent through the existing `clustering.js`. |
| **On-page score** | Semantic coverage against a named comparison set, readability, entity density, target-term placement, and **citability** — whether a passage can be lifted and attributed. Works on a live URL or a pasted draft. |
| **Schema & structured data** | Validates existing JSON-LD against per-type requirement tables, keeping Google's required-vs-recommended distinction, and generates the missing blocks from what is visibly on the page. |
| **Brand hub & llms.txt** | One canonical fact set rendered into `llms.txt`, the `Organization` block and a completeness checklist, so the three cannot disagree. |
| **AI-crawler readiness** | Per-agent access, tested against `robots.txt` **and** by requesting the page as each agent. Training crawlers and retrieval fetchers are reported separately, because blocking them means opposite things. |
| **Linking & architecture** | An entity graph of the site: topic clusters, hub/spoke completeness, orphans, crawl depth, breadcrumb trails, and specific link pairs worth adding. |
| **Competitive intelligence** | Crawls named competitors for topic coverage, sections, publishing velocity, schema, author signals, retrieval posture and internal anchor patterns. |
| **Reputation & ambient signals** | Reddit, Hacker News and Google/Bing News — the third-party discussion an assistant weighs when asked whether a brand is credible. Reddit gets its own tiered, block-aware scraper (see below). |
| **Freshness & intent drift** | Decay measured relative to the whole site, and drift measured as Jensen-Shannon divergence over the query mix between two Search Console snapshots. |
| **Tracking board** | Twenty checks covering every tracking element — crawl errors, robots changes, sitemap health, index coverage, Core Web Vitals, TTFB, page load, SSL and security headers, redirect chains, canonicals, URL structure, titles and meta, headings, content quality and cannibalisation, internal linking, images, structured data, JS rendering, mobile usability, AI crawler access. |

### The rule the whole suite is built on

**Nothing invents a number.** This deployment holds no Semrush, Ahrefs, Moz or
DataForSEO credential, so search volume, keyword difficulty, backlink counts,
competitor traffic and AI citation share are *not knowable here* — and a
fabricated one is indistinguishable on screen from a measured one once it
reaches a client report.

So every result page carries a provenance block naming the sources it used and
the questions it could not answer. `src/lib/aiseo/providers.js` declares each
commercial provider as an adapter that activates on an environment variable;
until then the gap is stated, not filled.

Two consequences worth knowing:

- **Measurement is deterministic and local.** Scores, similarities, densities
  and drift are computed in `src/lib/aiseo/nlp.js` and return the same answer
  twice. The AI model explains, drafts and rewrites — it never measures. A
  score that moved because a model felt different today could not be explained
  to a client, alerted on, or trusted.
- **A check that cannot measure returns `unknown`, never `good`.** Unknown
  metrics are excluded from the board score on *both* sides of the ratio.
  Collapsing "measured and fine" into "could not measure" is how a monitoring
  system reports green through an outage.

### The Reddit scraper

Reddit is the source an AI assistant leans on hardest for "is this brand any
good", and the most defended, so it gets its own module
(`src/lib/aiseo/redditClient.js`) rather than being one function among four.
The design is ported from this repo's sibling lead-gen agent: a tiered fallback
chain over a paced session that recognises a block and stops making it worse.

**Four endpoints, tried in order.** Measured against the live endpoints:

| Endpoint | Result | Kept because |
|---|---|---|
| authenticated API | used first when a credential exists | no rate limit, real scores, comment bodies |
| `/search.rss` | **200 with real entries** | the tier that currently answers |
| `/search.json` | 403 + a 185KB HTML block page | richest payload when it does answer |
| `/search/` (shreddit) | 200, but an 8KB JavaScript shell | last resort if the others close |

`old.reddit.com/search` was dropped from the chain entirely: it answers 200 and
then 302s to `/login/?reason=lor2`, which is a login wall wearing a success
code. Parsing it would have mined a login page for brand mentions.

**Three details that are load-bearing, and were each a bug first:**

- *Client hints must agree with the user agent.* A UA claiming Chrome 137 with
  no `Sec-CH-UA` header is a known bot signature. The full coherent header set
  is what the original suite's crawler was missing when it got a flat 403.
- *A 429 is not a 403.* A rate limit is temporary and about volume, so it earns
  a cooldown and counts toward giving up — and crucially the chain **stops**
  rather than trying two more endpoints on a host that just said "too many
  requests". A 403 is permanent for that endpoint, so it earns no cooldown, and
  the tier is marked dead for the rest of the session. Before that split, one
  permanently-closed endpoint dragged the whole source into a hard block: 17
  requests and 8 blocks for 0 results, versus 6 requests and 69 results after.
- *An empty array is not a failure.* A tier returns `[]` to mean "answered, and
  there is genuinely nothing" and `null` to mean "failed, try the next". Without
  that distinction a legitimately quiet brand burns two extra requests per term
  against the rate limit that matters.

**A transient rate limit no longer loses a term.** The cooldown has already
been served by the time the chain gives up on a tier, so the same tier is
retried once — recovering a search term that would otherwise have been reported
as having no mentions.

Per-brand subreddits can be set on the reputation page. Only the *primary* term
is searched per subreddit: every term against every subreddit multiplies
requests against the binding constraint, and the secondary terms are usually
near-variants of the first.

### Running the analyses

Each is a background run: the route creates the row, redirects to a result page
that polls, and the work continues detached (`src/lib/aiseo/runner.js`). Two may
run at once — each one crawls, and this host has a small memory allowance.

Three sweeps are also scheduled, through the same cron endpoint as everything
else (`aiseo_tracking` daily, `aiseo_reputation` daily, `aiseo_freshness`
weekly). Each sweeps the brand whose last sweep is oldest, one per tick — so
**with N brands each is swept every N days**. Raise
`AISEO_TRACKING_BRANDS_PER_TICK`, or add a cron line hitting
`/internal/cron?job=aiseo_tracking`, for a brand that needs daily monitoring.
The scheduled paths run with AI assistance **off**: a cron job that spends the
AI budget unattended exhausts the cap before anyone has read a finding.

Six alert types read the stored results (`src/lib/alertCatalog.js`, group
*AI SEO suite*), including `aiseo_stale_sweep` — which exists because the
failure mode of the other five is silent: a cron that stopped firing produces
no findings, which looks exactly like a healthy site.

### Verifying it

```bash
npm start                      # stop this before running the checks below
node verify_aiseo.js           # 82 checks: text measurement, HTML parsing,
                               # robots matching, schema validation, scoring,
                               # the Reddit tier chain, provider honesty,
                               # the store, live network
node verify_aiseo.js --full    # adds live crawling analyses (slower)
```

Run it with the server **stopped**: the WebAssembly SQLite driver is
single-writer, and a second process opening `data/app.db` while the app is
running has corrupted it before.

## Database

SQLite via `better-sqlite3`, file at `data/app.db` (gitignored — it holds
Google OAuth refresh tokens). Schema in `src/db.js`, created and migrated
automatically on boot. Brand-keyed consolidated tables: `gsc_daily`,
`gsc_page_daily`, `gsc_query_daily`, `gsc_query_page`, `ga4_daily`,
`ga4_page_daily`, `psi_snapshots`, `uptime_checks`. Everything else —
`brands`, `alert_subscriptions`, `alert_events`, `tasks`, `task_events`,
`keyword_runs`, `weekly_reports`, `audit_runs`, `linking_runs` — hangs off
those.

The AI SEO suite adds four generic tables rather than a pair per feature, since
all nine analyses have the same shape: `aiseo_runs` (one row per analysis,
`kind` says which), `aiseo_findings` (normalised out of the payload so the task
bridge and alert engine never parse JSON), `aiseo_metrics` (the tracking time
series — one row per brand/metric/url/capture, storing the value *and* the
verdict it was given at the time), and `aiseo_ai_cache`. Plus `competitors`,
`brand_facts` and `mentions`, which are genuinely relational.

## Known limitations

- **No SERP data.** There is no rank-tracker or SERP-API credential, so the
  on-page scorer compares against pasted URLs or the best-matching page on each
  named competitor domain rather than the live top 10, and no competitor
  ranking, traffic estimate or backlink count is shown anywhere. Every affected
  page says so; see `src/lib/aiseo/providers.js` for the adapters that activate
  on a key.
- **Reddit is rate-limited without a credential.** It is scraped successfully
  without one — see *The Reddit scraper* above — but the working tier is
  rate-limited, carries no post scores, and returns post bodies without their
  comment threads. A free "script" app at reddit.com/prefs/apps
  (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`) removes all three limits.
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
