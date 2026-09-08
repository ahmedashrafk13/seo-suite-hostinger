// PER-CLIENT CREDENTIALS FOR THIRD-PARTY SEO DATA
//
// Search volume, keyword difficulty and backlink data come from vendors who
// charge for API access. Holding one set of keys in .env means the agency pays
// for every client's data. This module lets a client's own subscription be used
// for that client's brand instead, falling back to the agency's keys when the
// brand has none — the same shape as the Google Ads account resolution in
// lib/google.js, for the same reason.
//
// WHY OAUTH IS NOT USED HERE, since it is the obvious question. Of the vendors
// this app reads, only Google offers OAuth that grants data access. Semrush
// runs an OAuth server but it authorises App Center apps, while the Analytics
// API this app calls wants a profile API key and consumes purchased API units.
// Moz uses an id/secret pair, Ahrefs an API key, DataForSEO basic auth. None of
// them has a delegated-authorisation flow a third-party tool can use, so a
// stored credential is the only mechanism available.
//
// THESE ARE OTHER PEOPLE'S PAID CREDENTIALS. A leaked database must not hand an
// attacker a client's Semrush subscription, so every value is encrypted with
// AES-256-GCM before it is written, and the key is NOT derived from anything
// else the app already stores. Without CREDENTIAL_SECRET set, saving is refused
// outright rather than silently falling back to plaintext — an encryption
// feature that quietly stops encrypting is worse than not having it.
const crypto = require('crypto');
const db = require('../db');

// What each vendor needs, and which .env variable is the agency-wide fallback.
// Adding a vendor here is all that is required for the UI and the resolver;
// the adapter that consumes it lives with the feature that needs it.
const VENDORS = [
  {
    key: 'dataforseo',
    label: 'DataForSEO',
    help: 'Live Google volumes, keyword difficulty and SERPs. Pay-as-you-go; the account email and API password from app.dataforseo.com.',
    fields: [
      { name: 'login', label: 'API login (email)', env: 'DATAFORSEO_LOGIN' },
      { name: 'password', label: 'API password', env: 'DATAFORSEO_PASSWORD', secret: true },
    ],
  },
  {
    key: 'semrush',
    label: 'Semrush',
    help: 'Volume, CPC, competition and keyword difficulty. Needs a plan with API units; the key is in the Semrush profile menu.',
    fields: [
      { name: 'key', label: 'API key', env: 'SEMRUSH_API_KEY', secret: true },
    ],
  },
  {
    key: 'moz',
    label: 'Moz',
    help: 'Domain Authority and complete referring-domain counts. Replaces the verified-sample floor in the backlink gap table.',
    fields: [
      { name: 'accessId', label: 'Access ID', env: 'MOZ_ACCESS_ID' },
      { name: 'secretKey', label: 'Secret key', env: 'MOZ_SECRET_KEY', secret: true },
    ],
  },
  {
    key: 'bing',
    label: 'Bing Webmaster Tools',
    help: 'Free measured search volume — Bing demand, not Google. Key from bing.com/webmasters, Settings > API access.',
    fields: [
      { name: 'key', label: 'API key', env: 'BING_WEBMASTER_API_KEY', secret: true },
    ],
  },
  {
    key: 'ahrefs',
    label: 'Ahrefs',
    help: 'Referring domains, anchor text and content gap. Requires an Ahrefs plan that includes API access.',
    fields: [
      { name: 'token', label: 'API token', env: 'AHREFS_API_TOKEN', secret: true },
    ],
  },
];

const BY_KEY = new Map(VENDORS.map((v) => [v.key, v]));

// ---------------------------------------------------------------- encryption

function secretConfigured() {
  return Boolean(process.env.CREDENTIAL_SECRET
    && String(process.env.CREDENTIAL_SECRET).length >= 16);
}

// scrypt with a per-record salt rather than a single derived key, so two brands
// storing the same Semrush key do not produce identical ciphertext — otherwise
// the database would leak which brands share a subscription.
function deriveKey(salt) {
  if (!secretConfigured()) {
    throw new Error('CREDENTIAL_SECRET is not set (or is shorter than 16 characters), so per-client credentials cannot be stored. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return crypto.scryptSync(String(process.env.CREDENTIAL_SECRET), salt, 32);
}

function encrypt(plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(blob) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('stored credential is not in the expected format');
  const [, saltB, ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(Buffer.from(saltB, 'base64')),
    Buffer.from(ivB, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  // GCM authentication means a wrong CREDENTIAL_SECRET and a tampered row are
  // both rejected here rather than yielding garbage that gets sent to a vendor.
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

// ------------------------------------------------------------------- storage

// Saves only the fields actually supplied. A blank field CLEARS that field
// rather than storing an empty string, so "leave blank to use the agency
// default" behaves the way the form promises.
function save(brandId, userId, vendorKey, values) {
  const vendor = BY_KEY.get(vendorKey);
  if (!vendor) throw new Error(`unknown data vendor: ${vendorKey}`);
  if (!secretConfigured()) deriveKey(Buffer.alloc(16)); // throws the explanatory error

  const kept = {};
  vendor.fields.forEach((f) => {
    const v = values && values[f.name] != null ? String(values[f.name]).trim() : '';
    if (v) kept[f.name] = v;
  });

  if (!Object.keys(kept).length) {
    clear(brandId, vendorKey);
    return { cleared: true };
  }
  const payload = encrypt(JSON.stringify(kept));
  db.prepare(`INSERT INTO brand_data_credentials (user_id, brand_id, vendor, payload, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(brand_id, vendor) DO UPDATE SET payload=excluded.payload, updated_at=datetime('now')`)
    .run(userId, brandId, vendorKey, payload);
  return { saved: Object.keys(kept) };
}

function clear(brandId, vendorKey) {
  db.prepare('DELETE FROM brand_data_credentials WHERE brand_id=? AND vendor=?').run(brandId, vendorKey);
}

function readBrand(brandId, vendorKey) {
  if (!brandId) return null;
  const row = db.prepare('SELECT payload FROM brand_data_credentials WHERE brand_id=? AND vendor=?')
    .get(brandId, vendorKey);
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.payload));
  } catch (e) {
    // A decryption failure is reported, never swallowed: it means the secret
    // changed or the row was altered, and silently falling back to the agency
    // key would bill the agency for a client who believes they are on their own
    // subscription.
    const err = new Error(`the stored ${vendorKey} credential for this brand could not be decrypted (${e.message}). If CREDENTIAL_SECRET was changed, re-enter it on the brand.`);
    err.credentialDecryptFailed = true;
    throw err;
  }
}

// Whatever the agency has set, complete or not. Used to fill gaps in a brand's
// partial credential.
function readEnvFields(vendorKey) {
  const vendor = BY_KEY.get(vendorKey);
  if (!vendor) return {};
  const out = {};
  vendor.fields.forEach((f) => {
    const v = process.env[f.env];
    if (v) out[f.name] = v;
  });
  return out;
}

// The agency credential ONLY when it is complete. A half-set agency credential
// is not usable on its own and must not be presented as configured — this is
// deliberately stricter than readEnvFields above, which exists to patch a
// brand's missing field.
function readEnv(vendorKey) {
  const vendor = BY_KEY.get(vendorKey);
  if (!vendor) return null;
  const out = readEnvFields(vendorKey);
  return vendor.fields.every((f) => out[f.name]) ? out : null;
}

// ----------------------------------------------------------------- resolution

// The brand's own credential first, the agency's .env second, nothing third.
// `source` is returned so every view and every provenance line can say WHOSE
// subscription produced a number — a client on their own units is entitled to
// know, and so is the agency paying for the ones who are not.
function resolve(vendorKey, { brandId = null } = {}) {
  const vendor = BY_KEY.get(vendorKey);
  if (!vendor) return { source: null, values: null, vendor: null };

  let brandValues = null;
  let error = null;
  try {
    brandValues = readBrand(brandId, vendorKey);
  } catch (e) {
    error = e.message;
  }
  if (brandValues) {
    // Partial brand credentials are completed from env where possible, because
    // a brand that supplied only a DataForSEO login and no password should not
    // silently send half a credential.
    // Partial env values are usable HERE, unlike the pure-agency path below:
    // the brand has supplied part of the credential and the agency only needs
    // to cover the remainder.
    const envValues = readEnvFields(vendorKey);
    const merged = {};
    let complete = true;
    vendor.fields.forEach((f) => {
      const v = brandValues[f.name] || envValues[f.name];
      if (v) merged[f.name] = v; else complete = false;
    });
    if (complete) {
      const mixed = vendor.fields.some((f) => !brandValues[f.name] && envValues[f.name]);
      return { source: mixed ? 'brand+agency' : 'brand', values: merged, vendor, error };
    }
    return { source: null, values: null, vendor, error: error || `incomplete ${vendor.label} credential on this brand` };
  }

  const envValues = readEnv(vendorKey);
  if (envValues) return { source: 'agency', values: envValues, vendor, error };
  return { source: null, values: null, vendor, error };
}

// Everything a run needs, resolved once so an analysis does not hit the
// database (and the decryption) per keyword batch.
function resolveAll({ brandId = null } = {}) {
  const out = {};
  VENDORS.forEach((v) => { out[v.key] = resolve(v.key, { brandId }); });
  return out;
}

// What the brand settings page renders: configured or not, and from where,
// without ever returning a secret value to a template.
function status(brandId) {
  return VENDORS.map((v) => {
    const r = resolve(v.key, { brandId });
    return {
      key: v.key,
      label: v.label,
      help: v.help,
      fields: v.fields.map((f) => ({ name: f.name, label: f.label, env: f.env, secret: Boolean(f.secret) })),
      configured: Boolean(r.values),
      source: r.source,
      error: r.error || null,
      // Which fields this brand has stored, so the form can show "set" beside
      // them without revealing them.
      brandFields: (() => {
        try {
          const b = readBrand(brandId, v.key);
          return b ? Object.keys(b) : [];
        } catch (e) { return []; }
      })(),
    };
  });
}

module.exports = {
  VENDORS, save, clear, resolve, resolveAll, status, secretConfigured,
  // Exported for the test harness only.
  _encrypt: encrypt, _decrypt: decrypt,
};
