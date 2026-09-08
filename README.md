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
### Crawling a site that needs a login

Both crawlers request pages as an anonymous visitor, which is wrong for a
members-only site, a client portal, or a staging build behind HTTP basic auth.
Credentials are set per brand under **Crawl access** on the brand page (or typed
into either start form for a one-off run) and are carried by every request the
crawl makes — pages, `robots.txt`, sitemaps, link checks, asset checks — in all
four crawler implementations, Python and Node port alike. Three transports:

| Wall | What to supply |
|---|---|
| HTTP basic auth (staging sites) | username + password |
| A login form | a session cookie copied from a logged-in browser |
| A CDN/WAF rule answering 403 | whatever header the edge rules expect |

**Every run now probes the seed URL before spawning a crawler**
(`src/lib/crawlAuth.js`). This exists because of the failure mode that is worse
than a failed crawl: a site that 302s to `/login` serves that login page with
HTTP **200**, so the crawler used to follow its two or three links, finish
successfully, and report a health score for the login form. That is a login wall
wearing a success code — the same trap this repo already documents for
`old.reddit.com/search` — and nothing on screen distinguished it from a real
audit of a small site.

So a walled site now **fails before the crawl starts**, naming what was seen,
where the seed URL ended up, which credentials were sent, and how to fix it. One
request replaces a ten-minute crawl that returns nothing, and it catches the
failure that actually recurs: a saved cookie that has since expired. Session
cookies do expire, which is why the brand page has a **Test access** button and
stores the result of the last test — an expired credential is visible there
rather than discovered by a crawl that reads one page.

**A public site crawls exactly as it did before**, including one that has
accounts. A restaurant site with `/signup` and `/login` for order tracking is
still a public site: the pages a diner needs are served to anyone, so the check
passes and the signup and login pages are crawled like any other page. Having a
login is not being behind one.

That constraint shapes the whole feature, because a guard that stops a public
crawl on a bad guess costs more than the wall it catches. A run is stopped
**only** on evidence that cannot mean anything else:

- **401** — the server explicitly demanded credentials.
- **A redirect to a page that identifies itself as the sign-in page.**
- **A sign-in page served at the seed URL with a 200** — and only when four
  signals agree: a password field, under 150 words of visible text, a title or
  URL that says sign-in, *and* fewer than three links onward into the site.

That last condition is the one doing the real work, because it answers what the
guard is actually predicting — *would a crawl started here get anywhere?* A true
login wall is a dead end. A restaurant's login page carries the site's whole
header nav, so a crawl seeded there reaches the menu, the hours and the contact
page and produces a perfectly good audit. It is therefore never treated as a
wall, whatever its title says.

Everything else the probe can notice is a guess, and is recorded as a note while
the crawl proceeds untouched:

| Seen | Before | Now |
|---|---|---|
| 401, or a redirect to a sign-in page | crawled the login page, scored it | **run stopped**, with the reason and the fix |
| A dead-end sign-in page at the seed URL | same | **run stopped** (four signals must agree) |
| A public site with a signup/login page | crawled fine | **identical** |
| 403 from a WAF or bot rule | crawl ran | crawl runs, note added |
| 4xx/5xx, or a timed-out seed | crawl ran | crawl runs, note added |
| A sparse homepage with a "Client login" box | crawl ran | crawl runs, note added |
| Anything else public | crawl ran | **identical** |

The only cost to a public site is one extra HTTP request before a crawl that is
about to make hundreds. `verify_crawl_access.js` tests this directly against the
shapes a naive login detector gets wrong: a restaurant site with signup, order
tracking and a gated account area; a sparse homepage with a client login box; a
page whose copy contains "restricted access"; a one-line holding page; an
ordinary http→https redirect chain; and a redirect to
`/accounts-payable-services` (which a substring match on "account" would block).

Two further escapes from the guard:

- **"Scan anyway"** proceeds for the case the probe cannot distinguish — a gated
  homepage with a public section below it. The finding is kept as a note on the
  run rather than discarded.
- **Sitemap coverage** is checked after a crawl finishes and reported as a
  *note*, never a failure: a crawl that read 12 of 400 sitemap URLs is probably
  hitting a gated section, but a `--max-pages` cap legitimately produces the
  same ratio, so this cannot be a hard gate without crying wolf on every capped
  crawl.

Credentials travel to the crawlers in the **environment**, not on the command
line. On Linux `/proc/<pid>/cmdline` is world-readable, so on shared hosting a
`--cookie` argument hands a client's live session to every other tenant for the
length of the crawl; `environ` on the same process is owner-only. The
`--cookie` / `--header` flags still exist for running a crawler by hand, and an
explicit flag beats the inherited environment. A malformed credential variable
degrades to an anonymous crawl rather than failing one.

**Credentials are bound to one site and go nowhere else.** They are attached
per request and re-evaluated on every redirect hop, so an external link check,
a competitor crawl, a CDN subdomain or a hop that leaves the site all get
nothing. This is not theoretical tidiness: the first version merged them into
every request, and since the audit checks every external link a page points at,
a fixture recorded a client's live session cookie arriving at a partner domain.
The scope key is host-plus-port, deliberately stricter than the crawler's own
host grouping, because two services on one host are two different systems.

**The AI SEO analyses authenticate too.** They fetch from 87 call sites across
seventeen files, so the credentials live in async context for the length of a
run (`fetcher.runWithAuth`) rather than being threaded through each call —
AsyncLocalStorage rather than a module global, because two analyses run at once
and may belong to different brands. Two rules make that safe, and both matter
more than the feature: the credentials are scoped to the brand's own site, since
these analyses deliberately fetch competitors, Reddit, Hacker News and news
sites; and **the AI-crawler checks opt out** (`noAuth`), because their whole
question is what an *unauthenticated* agent can read, and answering it with a
logged-in session would report that GPTBot can read a members-only page.

**A wall that only exists in the browser is caught by rendering.** When a page
answers 200 but looks like a shell — under 150 visible words, or a declared
meta refresh — and a renderer is available, `tools/render_probe.py` loads it in
Chromium and the verdict is taken again. `app.slack.com/client` is the reference
case and the reason this exists:

```
static probe   200, 146 words, 18 nav links, no form, no redirect   looks fine
rendered       -> app.slack.com/workspace-signin                    a login wall
```

A page with real copy is never rendered, so an ordinary audit pays nothing for
it (measured: 2.1s versus 11.4s). A page that renders to nothing is reported
without stopping the run. Two things about the browser path were bugs first and
are worth not re-learning: a `Cookie` must go in the **cookie jar**, because
Chromium ignores one set through route interception and the crawl then renders
login pages while reporting that credentials were sent; and credentials must be
attached by routing rather than `extra_http_headers`, which a context applies to
every font, analytics beacon and vendor script the page pulls in.

**Sign-in paths cover 114 segments across 40-odd languages** — Latin,
Cyrillic, Greek, Arabic, Hebrew, Devanagari, Bengali, Tamil, Sinhala, Thai, Lao,
Khmer, Burmese, Georgian, Armenian, Ethiopic, and CJK. Matched as whole path
segments after percent-decoding: Node's `URL` renders `/登录` as
`/%E7%99%BB%E5%BD%95`, so without decoding the entire non-Latin half of the list
would be dead code that looked complete.

Credentials are stored in the clear in `data/app.db`, alongside the Google
refresh tokens already there — so the existing rule stands: that file is
gitignored and must not be copied off the host. Credential **values** are never
written to a run log, a report, or the audit JSON; only the names of the headers
used, because a report is shared more widely than a settings page.

Editing them is a merge, not a replace. The form cannot show a stored cookie or
password back to the user, so a blank field means "leave it alone" and removal
is an explicit checkbox — a plain replace silently destroyed the working cookie
of anyone who edited only their basic-auth username, and nothing on screen
connected that to the refused crawl that followed.

```bash
DB_PATH=tmp/verify-crawl-access.db node verify_crawl_access.js           # 162 checks
DB_PATH=tmp/verify-crawl-access.db node verify_crawl_access.js --live    # 175, adds live sites
```

It starts a local server per scenario and runs both crawlers, in both
implementations, against them. The scenario list is the point: the access check
fails silently in both directions — a missed wall reads as a healthy small site,
and a public page mistaken for a wall stops a crawl that used to work — so both
directions are tested explicitly.

**Walls it must catch:** a cookie login wall that answers 200, HTTP basic auth,
a sign-in page served at the seed URL, an expired session cookie, and a
Chinese-language login wall.

**Sites it must never block**, each of which crawled before and each of which
breaks a naive login detector: a restaurant with signup, order tracking and a
gated account area; a sparse homepage with a "Client login" box; an age gate; a
cookie-consent interstitial; a locale redirect; a news paywall with a subscribe
form; a JavaScript SPA shell; a 403 bot challenge; 429 and 503; a soft 404; an
empty 200; JSON or a PDF at the root; a redirect loop; a four-hop redirect
chain; a site answering HEAD differently from GET; gzip and latin-1 responses; a
page with no title or h1; and a site with an untrusted TLS certificate — which
must stay auditable, since a bad certificate is a finding the audit exists to
report.

**The path matcher** is table-tested over 45 Latin paths and 16 non-Latin ones,
in both directions. Two things in it are load-bearing and both were bugs first:

- *The segment boundary.* Without it `/sso` matched `/ssortment-of-cheeses`,
  `/login` matched `/logins-explained`, `/signin` matched `/signing-a-lease` and
  `/authenticate` matched `/authenticated-users-guide` — so a restaurant with an
  assortment page could have had its crawl stopped.
- *Percent-decoding before matching.* Node's `URL` renders `/登录` as
  `/%E7%99%BB%E5%BD%95`, so the non-Latin half of the list — Chinese, Japanese,
  Korean, Cyrillic, Arabic, Hebrew, Thai, Greek, Hindi, alongside French,
  German, Spanish, Portuguese, Italian, Dutch, Nordic, Polish, Turkish and
  Indonesian — was dead code until `pathForMatch()` decoded the path. An
  English-only matcher fails silently on exactly the sites least likely to be
  double-checked by an English-speaking operator.

**Rendered crawls are covered too.** The Playwright path is a separate HTTP
client — a browser context, not the requests session — so credentials have to
reach it independently. The fixture serves an empty shell whose content, title
and links are written by JavaScript and gates it on a cookie, so the test can
only pass if both the cookie and the rendering arrived. The controls matter as
much as the test: the same site without credentials still reaches only the login
page, and without rendering it reports as a JavaScript shell whose score is
capped.

**`--live` adds the real web**, because fixtures prove the logic and only live
sites prove the thresholds. Five public sites must pass (including one with a
consent wall, one deliberately sparse government site, and one whose homepage
carries a login link); five genuinely gated applications must be caught. It then
runs the full audit against the live brand site in **both** implementations and
asserts they agree on the health score, the page count and the exact set of
failing checks — the credential work touched the HTTP layer of both, and a
regression there would surface as a subtly different report rather than as an
error.

The live run is honest about one gap it cannot close: an app that answers 200
with a JavaScript shell and redirects in the browser (`app.slack.com` does
exactly this) is invisible to any server-side probe, so it is **not** caught.
What stops that being dangerous is the audit's own behaviour — a JS shell earns
a content warning and a capped health score, never a healthy one, which is
asserted rather than assumed.

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
