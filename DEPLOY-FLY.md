# Deploying to Fly.io

This is the container path. Unlike the Hostinger build, nothing has to be
worked around here: the machine stays alive, so the app runs its own scheduler,
and a compiler is available, so the native SQLite driver is used instead of the
WebAssembly fallback.

**Read section 4 before deploying.** Google OAuth breaks silently if you skip
it, and section 6 explains the one setting that must never change.

---

## Why not Netlify or Vercel

Both are serverless, and this app is not.

| What the app does | Why serverless cannot |
|---|---|
| Stores everything in one SQLite file (`src/config.js`) | No persistent writable disk. Every user, run and session is lost when the invocation ends. |
| Runs analyses for minutes (`src/lib/aiseo/runner.js`) | Functions are killed at 10–60s. Every crawl dies mid-flight. |
| Spawns crawler subprocesses (`src/lib/toolRunner.js:182`) | Child processes are not available. |
| Runs hourly and nightly jobs (`src/lib/scheduler.js`) | Vercel's free plan allows one cron per day. |
| Paces search requests to 1 per 1.4s using in-process state (`src/lib/aiseo/serpLite.js:38`) | Isolated invocations each keep their own counter, so N concurrent invocations make N unpaced request streams and get the IP blocked. |

Making it fit would mean replacing SQLite with hosted Postgres, moving long
runs to a queue service, and deleting the subprocess crawlers. That is a
rewrite, not a deployment.

---

## 0. Cost — check this before you start

Fly is **not** guaranteed free. The old always-free allowance was withdrawn for
new organisations and replaced with pay-as-you-go plus a small monthly credit,
and the terms have changed more than once. This config asks for one
`shared-cpu-1x` machine with 512MB of RAM and a 3GB volume, kept always-on —
which is the cheapest shape that actually works, but **verify the current price
on your own account before deploying.**

If it is not free for you, the genuinely free options are an Oracle Cloud
Always Free VM, or staying on Hostinger — see `DEPLOY-HOSTINGER.md`, which
still works and is what this project was originally built for.

---

## 1. Install the CLI and create the app

```bash
fly auth login
fly launch --no-deploy
```

Answer **no** when it offers to create a Postgres or Redis database — this app
needs neither. Then set `app` and `primary_region` in `fly.toml` to match what
`fly launch` created.

You do **not** need Docker installed locally. `fly deploy` builds on Fly's
remote builders by default.

## 2. Create the volume

Everything that must survive a deploy lives here: the database, generated
reports and backups. A deploy replaces the image; only the volume persists.

```bash
fly volumes create seo_suite_data --size 3 --region ams
```

Use the same region as `primary_region`. The name must match the `[[mounts]]`
block in `fly.toml`.

## 3. Set the secrets

Never put these in `fly.toml` — it is committed to the repository. `fly secrets`
stores them encrypted and restarts the app with them in the environment.

```bash
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
```

Then add whichever of these you use:

| Secret | Needed for |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Search Console, GA4, PageSpeed, and the AI referral report |
| `BASE_URL` | Absolute links in reports and the OAuth callback (see section 4) |
| `AZURE_OPENAI_*` | The AI-written parts: prompt research, schema drafting, rewrites |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Alert emails |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | Measured keyword search volume |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Live Google SERPs and real keyword difficulty |

The app refuses to start in production with the default session secret, so the
first command above is not optional.

**Set `SIGNUP_REQUIRES_INVITE=1` before the app is publicly reachable.** Without
it, sign-up is open and anyone who finds the URL can create their own
workspace. The app warns about this in its boot log and nowhere else.

```bash
fly secrets set SIGNUP_REQUIRES_INVITE=1 --app seo-suite-hostinger
```

## 4. Point Google OAuth at the new domain

This is the step that fails quietly. `src/config.js:69` derives the OAuth
callback from `BASE_URL`, falling back to `http://localhost:4200/...` when it is
unset — and Google rejects any redirect URI it has not been told about.

```bash
fly secrets set BASE_URL="https://your-app.fly.dev"
```

Then in the Google Cloud console, add the exact callback to **Authorised
redirect URIs**:

```
https://your-app.fly.dev/api/auth/google/callback
```

A mismatch produces `redirect_uri_mismatch` at sign-in and nothing in the app's
own logs.

## 5. Deploy

```bash
fly deploy
```

Watch the build output for `better-sqlite3`. If it compiles, the app uses the
native driver. If it fails, the app still starts on the WebAssembly engine —
correct, but slower and without cross-process write safety. Confirm which one
you got:

```bash
fly ssh console -C "curl -s localhost:8080/healthz"
```

It prints `ok better-sqlite3` or `ok node-sqlite3-wasm`.

## 6. The setting that must not change

`fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1`.

Fly's default is to suspend an idle machine and wake it on the next request.
That default would reintroduce exactly the bug the Hostinger build exists to
work around: **a suspended process runs no timers.** The hourly keyword
difficulty backfill, the nightly Search Console sync and every alert would
never fire, and nothing would appear in the logs to say so.

It also matters for long runs. An analysis started from the browser keeps going
for minutes after the HTTP response is sent. A machine that suspends when the
request ends would kill it mid-crawl and leave the run stuck at `running`
forever.

**And never scale beyond one machine.** A Fly volume attaches to a single
machine, so a second one would create its own separate database. Logins and
analyses would appear and disappear depending on which machine served the
request. `max_machines_running = 1` is there to prevent it.

## 7. Confirm the scheduler is running

Unlike Hostinger, no external cron caller is needed — `INPROCESS_CRON=1` is set
in the Dockerfile and the machine stays alive to honour it.

```bash
fly ssh console -C "node src/cron.js --status"
```

Every job should show a schedule and, after the first hour, a `lastRunAt`. The
keyword difficulty backfill (`aiseo_kd_backfill`) runs at 25 minutes past each
hour.

## 8. Back up the database

The volume is not a backup — it is one disk on one machine.

```bash
fly ssh console -C "cat /data/app.db" > backup-$(date +%F).db
```

Worth doing before every deploy until you trust the setup.

---

## Troubleshooting

**Login redirects back to the login page.** The session cookie is `secure` in
production and needs a trusted proxy. `TRUST_PROXY=1` is set in the Dockerfile;
confirm it survived with `fly ssh console -C "printenv TRUST_PROXY"`.

**The database is empty after a deploy.** The volume did not mount. Check
`fly volumes list` and that the name matches `[[mounts]].source`. Data written
while it was unmounted went into the container filesystem and is gone.

**Runs are killed part-way through.** Out of memory. Raise `memory` in the
`[[vm]]` block, or lower `AISEO_MAX_CONCURRENT` (default 2) with
`fly secrets set AISEO_MAX_CONCURRENT=1`.

**Difficulty scores stop appearing.** The backfill stops early on a rate limit
by design. Check `fly logs` for `stopped early on rate limit`; it resumes on
the next tick.
