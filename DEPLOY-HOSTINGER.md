# Deploying to Hostinger shared/cloud hosting

This build of the SEO Automation Suite runs on Hostinger's shared Node.js
hosting. **No features were removed.** Everything that needed a compiler, a
Python interpreter, or a process that stays alive was given a path that works
without them.

If you only read one section, read **3. Scheduled jobs** — it is the one step
that fails silently if you skip it.

---

## What changed, and why

| Original | Problem on shared hosting | This build |
|---|---|---|
| `better-sqlite3` (native) | No compiler, no matching prebuild. A failed install aborts **the whole `npm install`**. | Optional dependency. Falls back to a WebAssembly SQLite. Same SQL, same file, no compiler. |
| `bcrypt` (native) | Same. | `bcryptjs`. Identical hash format, so existing passwords still work. |
| `connect-sqlite3` (native `sqlite3`) | Same, plus a second connection to a second file. | Session store on the app's own connection. |
| `node-cron` in-process | Passenger **stops the app when idle**, so timers never fire. Nothing errors; alerts just never happen. | Jobs are driven by an hPanel cron job calling a URL. |
| Python crawlers (`httpx`, `numpy`, `lxml`, `python-docx`…) | No Python, no `pip`. | JavaScript ports in `tools/node/`, selected automatically. |
| Database inside the app folder | A Git deploy **replaces the folder** and deletes it. | `DATA_DIR` points outside the app folder. |

Nothing above is one-way: on a VPS, install the native modules and set
`INPROCESS_CRON=1` and the app behaves exactly as the original did.

---

## 1. Create the Node.js application

In hPanel: **Websites → your domain → Node.js** (Business / Cloud plans; on
cPanel plans it is **Setup Node.js App**).

- **Node version:** 18 or newer
- **Application root:** e.g. `seo-suite`
- **Application startup file:** `app.js`
- **Application URL:** the domain or subdomain you want

Upload the project (or connect the Git repository) into the application root.
Do **not** upload `node_modules` — the panel installs dependencies itself.

Then press **Run NPM Install**. It should finish cleanly. If `better-sqlite3`
prints a build error, that is fine and expected: it is an *optional*
dependency, so the install continues and the app uses the WebAssembly engine.

## 2. Create the data directory (do this before the first run)

The application folder is replaced on every deployment. Anything inside it —
including the database — is deleted. Create a directory **outside** it:

```
/home/uXXXXXXXXX/seo-suite-data
```

Then set `DATA_DIR` to that path in `.env` (step 4). If you skip this, the app
still runs, and you lose every client's data on your next deploy.

Moving an existing install: stop the app, copy `data/app.db` into the new
directory, set `DATA_DIR`, start it again.

## 3. Scheduled jobs — REQUIRED

**Passenger stops the application whenever it is idle.** An in-process timer set
for 03:20 belongs to a process that was stopped at 23:10. Without this step,
alerts, the nightly Search Console/GA4 sync, the Monday reports and the database
backups **never run**, and nothing anywhere says so.

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Put it in `.env` as `CRON_TOKEN`, then in hPanel go to **Advanced → Cron Jobs**
and add one job:

- **Schedule:** every 15 minutes (or hourly — both work)
- **Command:**

```
wget -q -O /dev/null "https://your-domain.com/internal/cron?token=YOUR_CRON_TOKEN"
```

That single URL runs everything that is *due*. Each job keeps its own schedule
and its own last-run timestamp, so an hourly cron still sends the weekly report
exactly once, on Monday — and if the cron is down for two days, the next call
catches up instead of skipping a week.

Check it worked:

```
https://your-domain.com/internal/cron/status?token=YOUR_CRON_TOKEN
```

Every job should show a recent `lastRunAt` and `"lastStatus": "ok"`.

> If your plan gives you real SSH cron, `cd ~/seo-suite && node src/cron.js`
> does the same thing. Prefer the URL: the WebAssembly SQLite engine allows one
> writer at a time, and the URL runs the work **inside the web process** instead
> of contending with it.

## 4. Configure `.env`

Copy `.env.example` to `.env` and set at minimum:

```ini
NODE_ENV=production
TRUST_PROXY=1
SESSION_SECRET=<32+ random characters>
BASE_URL=https://your-domain.com
DATA_DIR=/home/uXXXXXXXXX/seo-suite-data
CRON_TOKEN=<the secret from step 3>
TOOL_RUNTIME=node
SIGNUP_REQUIRES_INVITE=0      # set to 1 after your team has signed up
```

`TRUST_PROXY=1` matters: Passenger terminates TLS, so without it Express does
not know the request arrived over HTTPS, `secure` cookies are never sent, and
**nobody can stay logged in**.

For Google Search Console / GA4, add
`https://your-domain.com/api/auth/google/callback` as an **additional** redirect
URI on your existing OAuth client, then set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`.

## 5. Check the deployment

```bash
npm run doctor
```

It reports each thing that can silently be wrong: whether the database opens and
which engine is in use, whether `DATA_DIR` will survive a deploy, whether the
session secret is still the default, whether scheduled jobs can actually run and
when each last ran, and which crawler implementation is active.

Fix every `PROBLEM` line. `WARN` lines are judgement calls.

## 6. First sign-in

Visit the site and sign up — the first account becomes the workspace owner. Then
set `SIGNUP_REQUIRES_INVITE=1` and restart, so the URL alone is no longer enough
to create an account.

---

## The crawlers

Both ship twice: the original Python programs in `tools/`, and JavaScript ports
in `tools/node/` that need only Node.

`TOOL_RUNTIME=auto` (the default) uses Python when an interpreter with the right
packages is found and the JavaScript ports otherwise, deciding per tool. On
Hostinger that means the ports. Set `TOOL_RUNTIME=node` to make the choice
explicit and stop the app probing for a Python that is not there.

**The ports were checked against the originals, not assumed equivalent:**

- *Technical audit* — run against real sites, comparing every check's
  `failed`/`total`/verdict. Two sites: 36/37 and 35/37 checks byte-identical,
  with **identical site-health scores** (84 vs 84, 67 vs 67). The differences are
  HTML-parser edge cases (duplicate `rel` attributes; a slightly different image
  denominator) and none changes a pass/fail verdict.
- *Internal linking* — identical output contract (the same five `.xlsx`
  workbooks with the same column headers, `crawl_data.json`, `summary.json` and a
  `.docx`), verified by reading both runs through the app's own `csvStore`. On a
  20-page crawl, 18 of 20 pages were the same and **every page in common matched
  exactly on word count and link count**; the two-page difference is which pages a
  truncated page budget happened to reach.

Two things are genuinely absent, because shared hosting cannot provide them, and
both are reported rather than hidden:

- **`--render`** (headless Chromium). If a site turns out to be a JavaScript
  shell, the audit says so in `content_warning` and caps the score, exactly as the
  Python does when Playwright is missing.
- **spaCy NER anchor filtering** in the linking agent — already optional in the
  Python and a no-op wherever spaCy is not installed.

## Operational notes

**One writer at a time.** The WebAssembly engine cannot use WAL, so writes lock
the file briefly. A 15-second busy timeout absorbs normal contention. This is
why the cron *URL* is preferred over the CLI.

**Killed processes.** The engine holds its lock as a `<database>.lock`
directory. The app removes a stale one at startup and closes the database on
exit, including on `SIGTERM` (which is how Passenger stops it). If you ever see
"database is locked" that will not clear, stop the app and delete that
directory.

**Backups** are written to `DATA_DIR/backups` by the scheduled `backup` job — so
they depend on step 3 as well. They use `VACUUM INTO`, which is safe on a live
database.

**Long crawls.** A 500-page audit can outlive a shared host's request limits.
Crawls already run in the background and the browser polls for status, so this
is normally invisible; if a run is marked `interrupted` after a deploy or
restart, that is the app correctly noticing that the process running it is gone.

**Upgrading to a VPS later.** Install `better-sqlite3` and `bcrypt`, set
`INPROCESS_CRON=1`, and delete the hPanel cron job. Nothing else changes.
