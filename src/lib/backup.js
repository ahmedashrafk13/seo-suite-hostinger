// Database backups.
//
// Everything this app knows lives in one SQLite file: every client site, 90+
// days of Search Console and GA4 history, the task backlog, approvals, reports
// and the team. Losing it means re-syncing what Google still has and losing
// outright what it does not — tasks, approvals, assignment history, reports.
//
// better-sqlite3's online backup is used rather than copying the file: a plain
// copy of a live WAL database can capture a torn state, whereas .backup()
// produces a consistent snapshot while the app keeps serving.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(config.DB_PATH), 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));

// YYYYMMDDHHmm — sorts chronologically as a plain string.
function stamp(d = new Date()) {
  const iso = d.toISOString(); // 2026-08-15T03:12:07.403Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

function list() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^app-\d+\.db$/.test(f))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const st = fs.statSync(full);
        return { file: f, path: full, size: st.size, mtime: st.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// Deletes the oldest beyond KEEP. Retention is by count, not age, so a machine
// that was off for a fortnight still keeps its last good snapshots.
function prune() {
  const extra = list().slice(KEEP);
  extra.forEach((b) => {
    try { fs.unlinkSync(b.path); } catch { /* a locked file is retried next run */ }
  });
  return extra.length;
}

async function run({ reason = 'scheduled' } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `app-${stamp()}.db`);

  // Same minute as an existing backup: nothing has meaningfully changed, and
  // overwriting risks clobbering a good snapshot with a worse one.
  if (fs.existsSync(dest)) {
    return { ok: true, skipped: true, file: path.basename(dest), reason };
  }

  try {
    await db.backup(dest);
    const size = fs.statSync(dest).size;
    const pruned = prune();
    console.log(`[backup] ${path.basename(dest)} (${Math.round(size / 1024)} KB, ${reason})${pruned ? `, pruned ${pruned}` : ''}`);
    return { ok: true, file: path.basename(dest), path: dest, size, pruned, reason };
  } catch (err) {
    console.error(`[backup] failed: ${err.message}`);
    return { ok: false, error: err.message, reason };
  }
}

function status() {
  const all = list();
  return {
    dir: BACKUP_DIR,
    keep: KEEP,
    count: all.length,
    latest: all[0] || null,
    totalSize: all.reduce((a, b) => a + b.size, 0),
  };
}

let timer = null;
function start() {
  if (timer) return;
  const hours = Math.max(1, Number(process.env.BACKUP_EVERY_HOURS || 12));

  // One at boot, so a fresh deploy is protected immediately rather than at the
  // first scheduled tick. Delayed slightly to stay out of the way of startup.
  setTimeout(() => { run({ reason: 'startup' }).catch(() => {}); }, 20_000).unref?.();

  timer = setInterval(() => {
    run({ reason: 'scheduled' }).catch(() => {});
  }, hours * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  console.log(`[backup] every ${hours}h into ${BACKUP_DIR} (keeping ${KEEP})`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, list, status, prune, start, stop, BACKUP_DIR, KEEP };
