# SEO Automation Suite — container image for Fly.io.
#
# WHY THIS BUILD DIFFERS FROM THE HOSTINGER ONE
# The shared-hosting build exists to survive a host with no compiler, no
# Python and a process manager that stops the app when idle. A container has
# none of those limits, so two things are deliberately reversed here:
#
#   1. better-sqlite3 is COMPILED, not skipped. It is listed as an optional
#      dependency precisely so a host without a toolchain can fall back to the
#      WebAssembly engine — but the WASM engine has no cross-process write
#      safety, and this project has corrupted its database that way before.
#      The build tools are installed below so the native driver is available,
#      and src/lib/sqliteDriver.js picks it up automatically.
#
#   2. Cron runs IN PROCESS. On Hostinger, Passenger idles the app so timers
#      never fire, which is why jobs are driven by an external URL call. Here
#      the machine is kept alive (see fly.toml: auto_stop_machines = false),
#      so INPROCESS_CRON=1 works and no external caller is needed.
#
# Build tools live only in the builder stage; the runtime image carries the
# compiled binding without the compiler.

# ---------------------------------------------------------------- builder
FROM node:20-bookworm-slim AS builder

# python3, make and g++ are needed to compile better-sqlite3. They add ~250MB,
# which is why they do not survive into the final stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied first so a dependency install is cached independently of source edits.
COPY package.json package-lock.json* ./

# `npm ci` when a lockfile is present, `npm install` otherwise. Not silenced:
# if better-sqlite3 fails to compile the log needs to show why, since the app
# will then quietly fall back to the WASM driver at runtime.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runtime

# tini reaps zombies. The audit and internal-linking crawlers are spawned as
# child processes (src/lib/toolRunner.js), and without an init that reaps them
# a long-lived container accumulates defunct entries until it runs out of PIDs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Runtime configuration.
#
#   DATA_DIR / REPORTS_DIR  point at the mounted volume. A Fly deploy replaces
#                           the image, so anything written outside /data is
#                           gone on the next release. src/config.js creates
#                           these directories on boot, so a fresh, empty
#                           volume needs no preparation.
#   INPROCESS_CRON=1        the machine is kept alive (fly.toml:
#                           auto_stop_machines = false), so the app runs its
#                           own scheduler and needs no external cron caller.
#   TRUST_PROXY=1           Fly terminates TLS at the edge and forwards plain
#                           HTTP with X-Forwarded-Proto. Without a trusted
#                           proxy, `secure` session cookies are never sent and
#                           login fails with no error. NODE_ENV=production
#                           already implies this in src/app.js; it is set
#                           explicitly so the behaviour is not a side effect.
#   TMP_DIR                 kept off the volume on purpose: scratch files are
#                           regenerated per run and would otherwise consume
#                           volume space permanently.
#
# Comments are kept outside the ENV instruction rather than between its
# continued lines, where they are not reliably stripped.
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV REPORTS_DIR=/data/reports
ENV TMP_DIR=/tmp/seo-suite
ENV INPROCESS_CRON=1
ENV TRUST_PROXY=1
# Fly's own init is PID 1, so tini runs as a child and cannot reap by default.
# Without this the crawler subprocesses accumulate as zombies on a long-lived
# machine until it runs out of PIDs.
ENV TINI_SUBREAPER=1

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# The app writes to /data at runtime. Fly mounts the volume as root-owned, so
# this runs as root rather than fighting the mount's ownership — a single-
# tenant container with no untrusted input reaching the filesystem layer.
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/app.js"]
