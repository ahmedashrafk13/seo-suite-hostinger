// One SQLite API, two engines.
//
// WHY THIS EXISTS
// The application was written against better-sqlite3, which is a native addon:
// installing it either downloads a prebuilt binary matching the exact
// platform/Node-ABI pair, or compiles one with node-gyp. On Hostinger's shared
// Node hosting neither is guaranteed — there is no compiler toolchain, and a
// Node version bump on their side can invalidate a prebuild that worked
// yesterday. A native module that fails to load takes the whole app down at
// require() time, before a single route is registered.
//
// So the engine is not assumed. This module exposes exactly the better-sqlite3
// surface the application uses and backs it with whichever engine is available:
//
//   better-sqlite3    native, fastest — used when it loads cleanly
//   node-sqlite3-wasm WebAssembly, no compiler, no ABI coupling — always works
//
// Both are real SQLite (the wasm build is SQLite 3.53.4), so the SQL, the
// schema and the query results are identical. Nothing in src/ had to be
// rewritten for the fallback: every `db.prepare(...).get(...)` call site works
// unchanged against either engine.
//
// DIFFERENCES THE ADAPTER ABSORBS
//   1. Statement lifetime. node-sqlite3-wasm is not garbage-collected: a
//      prepared statement that is never finalized leaks WASM heap. The app
//      calls db.prepare() inside request handlers ~500 times, so statements are
//      cached by SQL text and reused instead — which fixes the leak and is
//      faster than re-preparing. Safe here because the app only ever uses
//      get/all/run, each of which runs the statement to completion before
//      returning (no open cursors to invalidate).
//   2. Binding style. better-sqlite3 takes varargs — stmt.get(a, b) — while
//      node-sqlite3-wasm takes a single array. The adapter collects varargs.
//   3. lastInsertRowid. node-sqlite3-wasm returns BigInt past 2^53; the app
//      feeds that value straight back into queries and into res.redirect(), so
//      it is narrowed to a Number when it fits (it always will here).
//   4. pragma(), transaction() and backup() have no wasm equivalent and are
//      implemented below.
const path = require('path');
const fsMod = require('fs');

// --- engine selection -----------------------------------------------------
// Order matters: try the fast engine, fall back without ceremony. A failure
// here is not an error condition, it is the expected state on shared hosting,
// so it is logged at info level rather than thrown.
function loadEngine(preference) {
  const tryNative = () => {
    const Database = require('better-sqlite3');
    return { name: 'better-sqlite3', Database };
  };
  const tryWasm = () => {
    const { Database } = require('node-sqlite3-wasm');
    return { name: 'node-sqlite3-wasm', Database };
  };

  if (preference === 'native' || preference === 'better-sqlite3') return tryNative();
  if (preference === 'wasm' || preference === 'node-sqlite3-wasm') return tryWasm();

  try {
    return tryNative();
  } catch (err) {
    console.log(
      `[db] native better-sqlite3 unavailable (${err.code || err.message.split('\n')[0]}); ` +
      'using the WebAssembly build'
    );
    return tryWasm();
  }
}

// --- number narrowing -----------------------------------------------------
function narrow(v) {
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  return v;
}

function normalizeInfo(info) {
  if (!info) return { changes: 0, lastInsertRowid: 0 };
  return {
    changes: narrow(info.changes),
    lastInsertRowid: narrow(info.lastInsertRowid),
  };
}

// --- statement wrapper (wasm engine only) ---------------------------------
// Presents better-sqlite3's varargs signature over node-sqlite3-wasm's
// single-argument one.
class WasmStatement {
  constructor(stmt) {
    this._stmt = stmt;
  }

  static _bind(args) {
    // better-sqlite3: .get(), .get(1), .get(1, 2), .get([1, 2]) all valid.
    // node-sqlite3-wasm wants undefined or one array/object.
    if (args.length === 0) return undefined;
    if (args.length === 1) {
      const a = args[0];
      if (a === undefined) return undefined;
      if (Array.isArray(a)) return a;
      if (a !== null && typeof a === 'object' && !(a instanceof Uint8Array)) return WasmStatement._namedParams(a);
      return [a];
    }
    return Array.from(args);
  }

  // better-sqlite3 binds a named object against `@foo`/`:foo`/`$foo` in the
  // SQL using the bare key ("foo"); node-sqlite3-wasm calls
  // sqlite3_bind_parameter_index with the key as-is, which requires the
  // sigil to be part of the key itself ("@foo"), or it throws "Unknown
  // binding parameter". Every named param in this codebase is written as
  // `@name`, so add that sigil here rather than at each call site.
  static _namedParams(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
      out[/^[@:$]/.test(k) ? k : `@${k}`] = obj[k];
    }
    return out;
  }

  get(...args) {
    const row = this._stmt.get(WasmStatement._bind(args));
    return row === undefined || row === null ? undefined : narrowRow(row);
  }

  all(...args) {
    return this._stmt.all(WasmStatement._bind(args)).map(narrowRow);
  }

  run(...args) {
    return normalizeInfo(this._stmt.run(WasmStatement._bind(args)));
  }
}

// Row values can come back as BigInt for large INTEGERs. Views format these
// with toLocaleString() and arithmetic mixes them with Numbers, both of which
// throw on BigInt, so they are narrowed on the way out.
function narrowRow(row) {
  let touched = false;
  for (const k in row) {
    if (typeof row[k] === 'bigint') { touched = true; break; }
  }
  if (!touched) return row;
  const out = {};
  for (const k in row) out[k] = narrow(row[k]);
  return out;
}

// --- stale lock recovery --------------------------------------------------
//
// node-sqlite3-wasm's VFS implements SQLite's file locking with an atomic
// mkdir of "<database>.lock". That works, but the directory is only removed by
// the process that created it — so a process killed mid-write (SIGKILL, an OOM
// kill, or Passenger stopping an idle app) leaves the directory behind and
// EVERY later connection fails with "database is locked", permanently. The app
// does not recover on restart; it stays broken until someone deletes a
// directory they have no reason to know about.
//
// That failure mode is close to guaranteed on shared hosting, where the process
// is stopped whenever it goes idle, so the lock is cleared here when it is
// clearly stale. "Clearly stale" is judged by age: this application's writes
// are single-statement or short transactions measured in milliseconds, so a
// lock still held after a minute belongs to a process that no longer exists.
// A live writer's lock is never old enough to be touched.
const LOCK_STALE_MS = Number(process.env.SQLITE_LOCK_STALE_MS || 60000);

// How often a live process re-stamps a lock it is holding. Must stay well
// inside LOCK_STALE_MS or a healthy process's lock will still age out.
const LOCK_HEARTBEAT_MS = Number(process.env.SQLITE_LOCK_HEARTBEAT_MS || 10000);

// --- ownership, and why the age check alone is not enough -----------------
//
// The engine's lock is a directory:
//
//   function _nodejsLock(fi, level) {
//     if (!_isLocked(fi)) {
//       try { fs.mkdirSync(`${_path(fi)}.lock`) }
//       catch (err) { return err.code == "EEXIST" ? SQLITE_BUSY : SQLITE_IOERR_LOCK }
//
// mkdirSync is atomic, so as a mutex this is sound. But note what it does NOT
// do: it records nothing about who holds the lock, it ignores SQLite's lock
// LEVEL entirely (readers take the same exclusive lock as writers), and the
// directory's mtime is stamped once at creation and never refreshed while the
// lock is held.
//
// That last point breaks the age heuristic below. A lock legitimately held by a
// live process looks arbitrarily old, so clearing on age alone DELETES A LIVE
// PROCESS'S LOCK — after which two processes write the same file with no mutex
// between them. That is not a theoretical risk: it corrupted this database,
// destroying the content_briefs B-tree root page while every other table
// survived.
//
// So each process records its own ownership here, and a lock is cleared only
// when no other LIVE process has the database open.
function ownersDir(dbPath) { return `${dbPath}.owners`; }

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// PIDs other than ours that still exist. Dead entries are pruned as we go, so
// a crashed process cannot block recovery forever.
function liveForeignOwners(dbPath) {
  const dir = ownersDir(dbPath);
  let entries;
  try { entries = fsMod.readdirSync(dir); } catch { return []; }
  const live = [];
  entries.forEach((name) => {
    const pid = Number(name);
    if (!pid || pid === process.pid) return;
    if (pidAlive(pid)) { live.push(pid); return; }
    try { fsMod.rmSync(`${dir}/${name}`, { force: true }); } catch { /* best effort */ }
  });
  return live;
}

// Records this process as having the database open, and reports any other live
// process that already did. Cleaned up on exit so the record does not outlive
// the process by more than a crash.
function claimOwnership(dbPath) {
  const dir = ownersDir(dbPath);
  const foreign = liveForeignOwners(dbPath);
  const mine = `${dir}/${process.pid}`;
  try {
    fsMod.mkdirSync(dir, { recursive: true });
    fsMod.writeFileSync(mine, new Date().toISOString());
    const release = () => { try { fsMod.rmSync(mine, { force: true }); } catch { /* exiting */ } };
    process.once('exit', release);
    process.once('SIGINT', () => { release(); process.exit(130); });
    process.once('SIGTERM', () => { release(); process.exit(143); });
  } catch { /* an unwritable data dir is reported elsewhere */ }
  return foreign;
}

// Whether ownership records can be trusted for this database. When the owners
// directory is readable, "no live owner" is a fact; when it is missing or
// unreadable we know nothing and must fall back to the age heuristic.
function ownershipIsReadable(dbPath) {
  try { fsMod.readdirSync(ownersDir(dbPath)); return true; } catch { return false; }
}

function clearStaleLock(dbPath) {
  const lockDir = `${dbPath}.lock`;
  let st;
  try {
    st = fsMod.statSync(lockDir);
  } catch {
    return false;               // no lock present — the normal case
  }
  if (!st.isDirectory()) return false;
  // Ownership beats age. A live owner's lock is never stale no matter how old
  // the directory looks, because its mtime is never refreshed.
  const live = liveForeignOwners(dbPath);
  if (live.length) {
    console.warn(
      `[db] another live process (pid ${live.join(', ')}) has this database open; leaving its lock alone. `
      + 'This engine has no cross-process write safety, so concurrent writes can corrupt the file — '
      + 'run one writer at a time.'
    );
    return false;
  }
  // The age check is only a FALLBACK for when there is no ownership record to
  // consult. If the owners directory is readable and lists no live process,
  // the lock is definitively abandoned however young it looks — without this,
  // a crash left the app unable to start for LOCK_STALE_MS, which is exactly
  // the "database is locked" loop the recovery above exists to prevent.
  if (ownershipIsReadable(dbPath)) {
    try {
      fsMod.rmSync(lockDir, { recursive: true, force: true });
      console.warn(
        '[db] removed an abandoned lock directory: no live process owns this '
        + 'database. This is expected after the app was stopped abruptly; the '
        + 'database itself is intact.'
      );
      return true;
    } catch (err) {
      console.error(`[db] could not remove abandoned lock ${lockDir}: ${err.message}`);
      return false;
    }
  }

  const age = Date.now() - st.mtimeMs;
  if (age < LOCK_STALE_MS) return false;   // someone may genuinely be writing
  try {
    fsMod.rmSync(lockDir, { recursive: true, force: true });
    console.warn(
      `[db] removed a stale lock directory (${Math.round(age / 1000)}s old) left by a `
      + 'process that was killed mid-write. This is expected when the app is stopped '
      + 'abruptly; the database itself is intact.'
    );
    return true;
  } catch (err) {
    console.error(`[db] could not remove stale lock ${lockDir}: ${err.message}`);
    return false;
  }
}

// --- the adapter ----------------------------------------------------------
class SqliteDatabase {
  constructor(file, options = {}) {
    const engine = loadEngine(options.driver || 'auto');
    this.engineName = engine.name;
    this.isWasm = engine.name === 'node-sqlite3-wasm';
    // Only the WebAssembly engine uses the lock-directory scheme.
    if (this.isWasm) {
      // Claim first, so clearStaleLock can see who else is here, and so a
      // second process is told plainly that it is about to share a file this
      // engine cannot safely share.
      const foreign = claimOwnership(file);
      if (foreign.length) {
        console.warn(
          `[db] WARNING: pid ${foreign.join(', ')} already has ${file} open, and the WebAssembly `
          + 'engine provides no cross-process write safety. Concurrent writes CAN CORRUPT this '
          + 'database. Stop the other process (or set DB_DRIVER/install better-sqlite3) before writing.'
        );
      }
      clearStaleLock(file);
      this._startLockHeartbeat(file);
    }
    this._db = new engine.Database(file, this.isWasm ? {} : options.nativeOptions || {});
    this._file = file;
    this._cache = new Map();
    this._txDepth = 0;
  }

  // Keeps the engine's lock directory as young as it actually is.
  //
  // clearStaleLock decides staleness from the lock's mtime, and that heuristic
  // is correct in spirit — a lock nobody is refreshing belongs to a process
  // that is gone. The problem is that the engine stamps the mtime once at
  // mkdir and never touches it again, so a lock held by a perfectly healthy
  // process ages into looking abandoned, and another process then deletes it
  // and writes concurrently. Refreshing it here makes "old lock" mean what
  // clearStaleLock already assumes it means, without depending on any PID
  // bookkeeping surviving.
  //
  // utimesSync throws when no lock is currently held (the common case between
  // writes); that is not an error, so it is swallowed.
  _startLockHeartbeat(file) {
    const lockDir = `${file}.lock`;
    this._heartbeat = setInterval(() => {
      try {
        const now = new Date();
        fsMod.utimesSync(lockDir, now, now);
      } catch { /* no lock held at this instant */ }
    }, LOCK_HEARTBEAT_MS);
    // Never keep the process alive just to tick.
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
  }

  prepare(sql) {
    if (!this.isWasm) return this._db.prepare(sql);
    let stmt = this._cache.get(sql);
    if (!stmt) {
      stmt = new WasmStatement(this._db.prepare(sql));
      this._cache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  // better-sqlite3's pragma() returns rows, or the bare value with
  // { simple: true }. db.js calls it in statement form ('journal_mode = WAL'),
  // and the health check calls it in query form.
  pragma(source, options = {}) {
    if (!this.isWasm) return this._db.pragma(source, options);
    const sql = `PRAGMA ${source}`;
    // A pragma that sets a value still returns a row for some pragmas
    // (journal_mode) and nothing for others (foreign_keys). all() copes with
    // both; prepare() would throw on a statement with no result columns, so
    // the convenience method is used directly.
    let rows;
    try {
      rows = this._db.all(sql);
    } catch {
      this._db.exec(sql);
      return options.simple ? undefined : [];
    }
    if (options.simple) {
      const first = rows[0];
      return first ? narrow(first[Object.keys(first)[0]]) : undefined;
    }
    return rows.map(narrowRow);
  }

  // better-sqlite3's transaction() returns a callable that wraps the function
  // in BEGIN/COMMIT and rolls back on throw. Nested calls must not issue a
  // second BEGIN — SQLite rejects that — so depth is tracked and inner levels
  // use SAVEPOINTs, matching better-sqlite3's own behaviour.
  transaction(fn) {
    const self = this;
    return function transactionRunner(...args) {
      const depth = self._txDepth;
      const name = `sp_${depth}`;
      if (depth === 0) self._db.exec('BEGIN');
      else self._db.exec(`SAVEPOINT ${name}`);
      self._txDepth = depth + 1;
      try {
        const result = fn.apply(this, args);
        if (depth === 0) self._db.exec('COMMIT');
        else self._db.exec(`RELEASE ${name}`);
        self._txDepth = depth;
        return result;
      } catch (err) {
        self._txDepth = depth;
        try {
          if (depth === 0) self._db.exec('ROLLBACK');
          else self._db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        } catch { /* connection already unwound */ }
        throw err;
      }
    };
  }

  // better-sqlite3 exposes the SQLite online backup API and returns a promise.
  // The wasm build does not, so VACUUM INTO is used: it is likewise safe on a
  // live database (it takes a read transaction for the duration) and produces a
  // compacted, fully self-contained copy — which is what a backup wants.
  backup(destination) {
    if (!this.isWasm) return this._db.backup(destination);
    return new Promise((resolve, reject) => {
      try {
        // VACUUM INTO refuses to overwrite, so a stale file must go first.
        const fs = require('fs');
        if (fs.existsSync(destination)) fs.unlinkSync(destination);
        this._db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
        resolve({ totalPages: 0, remainingPages: 0 });
      } catch (err) {
        reject(err);
      }
    });
  }

  close() {
    if (this.isWasm) {
      // Statements must be finalized before close or the WASM heap leaks.
      for (const stmt of this._cache.values()) {
        try { stmt._stmt.finalize(); } catch { /* already gone */ }
      }
      this._cache.clear();
    }
    this._db.close();
  }

  get name() { return this._file; }
  get inTransaction() {
    return this.isWasm ? this._db.inTransaction : this._db.inTransaction;
  }
}

// Journal mode.
//
// WAL is the right mode for a native build: readers do not block the writer.
// The wasm build cannot use it — WAL needs shared memory across processes,
// which the JavaScript VFS does not implement — and silently stays in the
// previous mode if asked. Rather than assume, the mode is set and then read
// back, falling back to TRUNCATE (the fastest rollback journal) when WAL did
// not take. Getting this wrong is not cosmetic: a database left in WAL mode
// with no WAL support is read as if the -wal file's committed transactions do
// not exist.
// How long a writer waits for another process to release the database before
// giving up with SQLITE_BUSY.
//
// This is not optional here. better-sqlite3 sets a 5-second busy timeout by
// default; node-sqlite3-wasm sets NONE, so a second writer fails instantly with
// "database is locked". That is exactly the shape of this deployment — the web
// app under Passenger (which may run more than one process) plus `npm run cron`
// plus the backup job, all writing the same file — so without this the app
// works in testing and throws intermittently in production. It surfaced
// immediately when two of the app's own verification scripts ran back to back.
//
// The rollback-journal mode the wasm build has to use locks the whole file for
// the duration of a write, which makes contention more likely than under WAL,
// so the timeout is set generously.
const BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT || 15000);

function configureBusyTimeout(db) {
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return BUSY_TIMEOUT_MS;
  } catch {
    return 0;
  }
}

function configureJournal(db) {
  let mode;
  try {
    db.pragma('journal_mode = WAL');
    mode = String(db.pragma('journal_mode', { simple: true }) || '').toLowerCase();
  } catch {
    mode = '';
  }
  if (mode !== 'wal') {
    try {
      db.pragma('journal_mode = TRUNCATE');
      mode = String(db.pragma('journal_mode', { simple: true }) || 'truncate').toLowerCase();
    } catch {
      mode = 'delete';
    }
  }
  return mode;
}

module.exports = {
  SqliteDatabase, configureJournal, configureBusyTimeout, clearStaleLock,
  claimOwnership, liveForeignOwners, pidAlive,
  BUSY_TIMEOUT_MS, LOCK_STALE_MS, LOCK_HEARTBEAT_MS,
};
