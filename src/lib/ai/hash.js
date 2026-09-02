// Deterministic input hashing, shared by all of AI Assist's features so a
// cached result is only reused when the meaningful inputs are unchanged.
const crypto = require('crypto');

function hashInputs(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

module.exports = { hashInputs };
