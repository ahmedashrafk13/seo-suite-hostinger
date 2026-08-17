// Session storage on the application's own SQLite connection.
//
// WHY NOT connect-sqlite3
// The original build stored sessions with connect-sqlite3, which depends on the
// native `sqlite3` addon — a second compiler dependency, and one that fails to
// install on shared hosting for the same reason better-sqlite3 does. It also
// opened a *second* connection to a second file, which is what forces its
// `concurrentDB` option and the locking that comes with it.
//
// This store writes to the database the app already has open, through the same
// engine-agnostic adapter (native or WebAssembly). That removes the native
// dependency, removes the second connection, and means sessions are covered by
// the same backup as everything else.
//
// The contract is express-session's: get/set/destroy are required, and
// touch/length/clear/all are optional but implemented because `rolling: true`
// calls touch on every request.
const { Store } = require('express-session');

const DAY = 86400000;

class SqliteSessionStore extends Store {
  constructor(db, options = {}) {
    super(options);
    this.db = db;
    this.table = options.table || 'sessions';
    this.ttl = options.ttl || 7 * DAY;

    // expires is stored as epoch milliseconds rather than a datetime string so
    // expiry comparisons are plain integer maths and need no SQLite date
    // functions.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        sid     TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        data    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.table}_expires ON ${this.table}(expires);
    `);

    this._get = this.db.prepare(`SELECT data FROM ${this.table} WHERE sid = ? AND expires > ?`);
    this._set = this.db.prepare(
      `INSERT INTO ${this.table} (sid, expires, data) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data`
    );
    this._touch = this.db.prepare(`UPDATE ${this.table} SET expires = ? WHERE sid = ?`);
    this._destroy = this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`);
    this._reap = this.db.prepare(`DELETE FROM ${this.table} WHERE expires <= ?`);

    this.reap();
    // Expired rows are cleared hourly. unref() so this timer never holds the
    // process open — under Passenger the app is stopped when idle, and a live
    // timer would delay shutdown for no benefit.
    const interval = options.reapInterval == null ? 3600000 : options.reapInterval;
    if (interval > 0) {
      this._timer = setInterval(() => this.reap(), interval);
      if (this._timer.unref) this._timer.unref();
    }
  }

  // express-session computes the expiry from cookie.maxAge when the session has
  // a cookie; a session saved before the cookie is configured falls back to the
  // store's ttl.
  _expiry(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    if (cookieExpires) {
      const t = new Date(cookieExpires).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return Date.now() + this.ttl;
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      if (!row) return cb(null, null);
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      // A corrupt row must not lock a user out of the site forever: drop it and
      // report "no session", which sends them to the login page.
      try { this._destroy.run(sid); } catch { /* nothing more to try */ }
      return cb(null, null);
    }
  }

  set(sid, sess, cb) {
    try {
      this._set.run(sid, this._expiry(sess), JSON.stringify(sess));
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this._touch.run(this._expiry(sess), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this._destroy.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  length(cb) {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) c FROM ${this.table} WHERE expires > ?`).get(Date.now());
      return cb(null, row.c);
    } catch (err) {
      return cb(err);
    }
  }

  all(cb) {
    try {
      const rows = this.db.prepare(`SELECT sid, data FROM ${this.table} WHERE expires > ?`).all(Date.now());
      const out = {};
      rows.forEach((r) => { try { out[r.sid] = JSON.parse(r.data); } catch { /* skip */ } });
      return cb(null, out);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb) {
    try {
      this.db.exec(`DELETE FROM ${this.table}`);
      return cb ? cb(null) : undefined;
    } catch (err) {
      return cb ? cb(err) : undefined;
    }
  }

  reap() {
    try {
      const info = this._reap.run(Date.now());
      return info.changes;
    } catch {
      return 0;
    }
  }
}

module.exports = SqliteSessionStore;
