// Password hashing that does not depend on a compiler.
//
// `bcrypt` is a native addon and fails to install on a host without build
// tools, which on shared hosting takes down the whole `npm install` — so the
// pure-JavaScript `bcryptjs` is the baseline. It implements the same algorithm
// and the same $2a$/$2b$ hash format, so hashes written by either library
// verify against the other and existing user passwords keep working unchanged.
//
// The native build is still preferred when present: it is several times faster,
// which matters because bcrypt cost 10 blocks the event loop for ~60ms per
// login in pure JS.
let impl;
let implName;
try {
  impl = require('bcrypt');
  implName = 'bcrypt (native)';
} catch {
  impl = require('bcryptjs');
  implName = 'bcryptjs (pure JS)';
}

module.exports = {
  implName,
  hash: (password, rounds) => impl.hash(password, rounds),
  compare: (password, hashed) => {
    // A user row with no password (invited but never activated) would otherwise
    // throw "data and hash arguments required" instead of simply not matching.
    if (!hashed) return Promise.resolve(false);
    return impl.compare(password, hashed);
  },
};
