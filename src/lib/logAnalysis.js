// SERVER LOG ANALYSIS — what the crawlers actually did, from the only source
// that records it.
//
// WHY THIS IS THE MOST VALUABLE FREE DATA SOURCE LEFT
// Every other signal in this suite is inferred. Search Console reports what
// Google chose to tell us, aggregated and sampled; the crawler reports what a
// page looks like to us. An access log is the one record of what Googlebot
// actually requested, when, and what it got back. It answers questions nothing
// else here can:
//
//   - Where is crawl budget going? (Usually: faceted URLs, parameters,
//     pagination and a redirect chain nobody knew was there.)
//   - Which important pages has Googlebot not fetched in weeks? That is the
//     real definition of an orphan, and it is invisible to a link crawl.
//   - Is Googlebot getting 404s or 5xxs that a browser never sees?
//   - Are the AI retrieval fetchers reaching the site at all? The readiness
//     check in aiseo/ tests whether they COULD; the log says whether they DID.
//
// And it needs no credential. On Hostinger the file is in hPanel under
// "Access logs"; on any other host it is /var/log/nginx/access.log or the
// domain's logs directory.
//
// WHY THE COUNTERS AND NOT THE LINES — see the header on log_bot_daily in
// src/db.js. In short: a month of logs is millions of lines and this database
// is a single-writer WebAssembly SQLite on shared hosting. The parse streams
// and only aggregates are stored.
//
// THE ONE THING THAT WOULD MAKE THIS LIE, AND WHAT IS DONE ABOUT IT
// A user agent string is self-declared. Roughly a third of the traffic calling
// itself Googlebot in a typical log is not Google — it is scrapers, SEO tools
// and the occasional attacker. A "Googlebot crawled you 40,000 times" figure
// built from the UA alone is therefore wrong by a wide and unpredictable
// margin, and it is wrong in the direction that makes a site look healthier
// than it is.
//
// Google publishes its crawler IP ranges as JSON, and those files need no key.
// So bot identity is verified against the published ranges where a range list
// is available, and every figure is labelled: `googlebot` counts verified hits,
// `googlebot-unverified` counts the rest. The two are never added together.
const dns = require('dns');
const db = require('../db');

// ==========================================================================
// Log line parsing
// ==========================================================================
//
// Three formats cover essentially all shared hosting and the two common
// reverse proxies. Each is a named regex rather than a field-position split,
// because the combined format's referrer and user-agent are quoted strings
// that can themselves contain spaces — the reason a naive split(' ') gets the
// user agent wrong on every line.
const FORMATS = [
  {
    key: 'combined',
    label: 'Apache/nginx combined',
    // 1.2.3.4 - - [10/Mar/2026:04:12:01 +0000] "GET /path HTTP/1.1" 200 5120 "ref" "ua"
    re: /^(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)(?:\s+([^"]*))?"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/,
    map: (m) => ({
      ip: m[1], time: m[3], method: m[4], path: m[5], status: Number(m[7]),
      bytes: m[8] === '-' ? 0 : Number(m[8]), referrer: m[9] || '', ua: m[10] || '',
    }),
  },
  {
    key: 'vhost_combined',
    label: 'Apache vhost_combined (domain first)',
    // example.com:443 1.2.3.4 - - [date] "GET /p HTTP/1.1" 200 512 "ref" "ua"
    re: /^\S+:\d+\s+(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)(?:\s+([^"]*))?"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/,
    map: (m) => ({
      ip: m[1], time: m[3], method: m[4], path: m[5], status: Number(m[7]),
      bytes: m[8] === '-' ? 0 : Number(m[8]), referrer: m[9] || '', ua: m[10] || '',
    }),
  },
  {
    key: 'nginx_time_iso',
    label: 'nginx with ISO timestamp',
    // 2026-03-10T04:12:01+00:00 1.2.3.4 "GET /p HTTP/1.1" 200 512 "ref" "ua"
    re: /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*)\s+(\S+)\s+"(\S+)\s+(\S+)[^"]*"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/,
    map: (m) => ({
      ip: m[2], time: m[1], method: m[3], path: m[4], status: Number(m[5]),
      bytes: m[6] === '-' ? 0 : Number(m[6]), referrer: m[7] || '', ua: m[8] || '',
    }),
  },
];

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Apache's date is "10/Mar/2026:04:12:01 +0000". The date is taken as written
// rather than converted to the server's local zone: a log covering a Monday in
// UTC must not shift into Sunday because the machine reading it is in Karachi.
function parseLogTime(raw) {
  const s = String(raw || '');
  let m = s.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const mo = MONTHS[m[2]];
    if (mo) return { date: `${m[3]}-${mo}-${m[1]}`, iso: `${m[3]}-${mo}-${m[1]}T${m[4]}:${m[5]}:${m[6]}` };
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return { date: m[1], iso: `${m[1]}T${m[2]}` };
  return null;
}

// Picks the format from a sample of real lines rather than the first one,
// which in a rotated log is often a blank or a truncated fragment.
function detectFormat(lines) {
  const sample = lines.filter((l) => l && l.trim().length > 20).slice(0, 40);
  let best = null;
  for (const fmt of FORMATS) {
    const hits = sample.filter((l) => fmt.re.test(l)).length;
    if (!best || hits > best.hits) best = { fmt, hits };
  }
  if (!best || !best.hits) return null;
  return { format: best.fmt, confidence: sample.length ? best.hits / sample.length : 0 };
}

function parseLine(fmt, line) {
  const m = fmt.re.exec(line);
  if (!m) return null;
  const raw = fmt.map(m);
  const t = parseLogTime(raw.time);
  if (!t) return null;
  return Object.assign(raw, { date: t.date, iso: t.iso });
}

// ==========================================================================
// Bot identification
// ==========================================================================
//
// Matched on the user agent, then verified where verification is possible.
// `verify` names the mechanism:
//   'ip-range'  the crawler publishes its IP ranges (Google, Bing, OpenAI,
//               Anthropic, Perplexity) — checked against the loaded ranges.
//   'rdns'      only reverse DNS can confirm it, which needs a lookup per IP
//               and is therefore done for a sample, not every line.
//   null        no published mechanism; the UA is taken at face value and the
//               bot is labelled as unverifiable in the UI.
const BOTS = [
  { key: 'googlebot', label: 'Googlebot', re: /googlebot(?!-image|-video|-news)|google-inspectiontool/i, verify: 'ip-range', group: 'search', important: true },
  { key: 'googlebot-image', label: 'Googlebot Image', re: /googlebot-image/i, verify: 'ip-range', group: 'search' },
  { key: 'googlebot-video', label: 'Googlebot Video', re: /googlebot-video/i, verify: 'ip-range', group: 'search' },
  { key: 'google-other', label: 'GoogleOther', re: /googleother/i, verify: 'ip-range', group: 'search' },
  { key: 'google-extended', label: 'Google-Extended (Gemini training)', re: /google-extended/i, verify: 'ip-range', group: 'ai-training' },
  { key: 'adsbot', label: 'AdsBot', re: /adsbot-google/i, verify: 'ip-range', group: 'ads' },
  { key: 'bingbot', label: 'Bingbot', re: /bingbot|adidxbot/i, verify: 'ip-range', group: 'search', important: true },
  { key: 'bing-preview', label: 'BingPreview', re: /bingpreview/i, verify: 'ip-range', group: 'search' },
  { key: 'duckduckbot', label: 'DuckDuckBot', re: /duckduckbot/i, verify: null, group: 'search' },
  { key: 'yandexbot', label: 'YandexBot', re: /yandex(bot|images)/i, verify: 'rdns', group: 'search' },
  { key: 'baiduspider', label: 'Baiduspider', re: /baiduspider/i, verify: 'rdns', group: 'search' },
  { key: 'applebot', label: 'Applebot', re: /applebot(?!-extended)/i, verify: 'rdns', group: 'search' },
  { key: 'applebot-extended', label: 'Applebot-Extended (Apple AI training)', re: /applebot-extended/i, verify: 'rdns', group: 'ai-training' },
  // The retrieval fetchers — the ones that matter for being cited in an answer.
  { key: 'oai-searchbot', label: 'OAI-SearchBot (ChatGPT search index)', re: /oai-searchbot/i, verify: 'ip-range', group: 'ai-retrieval', important: true },
  { key: 'chatgpt-user', label: 'ChatGPT-User (live fetch)', re: /chatgpt-user/i, verify: 'ip-range', group: 'ai-retrieval', important: true },
  { key: 'gptbot', label: 'GPTBot (OpenAI training)', re: /gptbot/i, verify: 'ip-range', group: 'ai-training' },
  { key: 'claudebot', label: 'ClaudeBot (Anthropic training)', re: /claudebot/i, verify: 'ip-range', group: 'ai-training' },
  { key: 'claude-user', label: 'Claude-User (live fetch)', re: /claude-user|claude-web/i, verify: 'ip-range', group: 'ai-retrieval', important: true },
  { key: 'perplexitybot', label: 'PerplexityBot', re: /perplexitybot/i, verify: 'ip-range', group: 'ai-retrieval', important: true },
  { key: 'perplexity-user', label: 'Perplexity-User (live fetch)', re: /perplexity-user/i, verify: 'ip-range', group: 'ai-retrieval' },
  { key: 'meta-ai', label: 'Meta AI crawler', re: /meta-externalagent|facebookbot|meta-externalfetcher/i, verify: null, group: 'ai-training' },
  { key: 'bytespider', label: 'Bytespider (TikTok)', re: /bytespider/i, verify: null, group: 'ai-training' },
  { key: 'amazonbot', label: 'Amazonbot', re: /amazonbot/i, verify: null, group: 'ai-training' },
  // SEO tools. Worth naming because on a small site they can be most of the
  // "bot traffic" and they consume real server capacity.
  { key: 'ahrefsbot', label: 'AhrefsBot', re: /ahrefsbot/i, verify: null, group: 'seo-tool' },
  { key: 'semrushbot', label: 'SemrushBot', re: /semrushbot/i, verify: null, group: 'seo-tool' },
  { key: 'mj12bot', label: 'MJ12bot (Majestic)', re: /mj12bot/i, verify: null, group: 'seo-tool' },
  { key: 'dotbot', label: 'DotBot (Moz)', re: /dotbot/i, verify: null, group: 'seo-tool' },
  { key: 'screamingfrog', label: 'Screaming Frog', re: /screaming frog/i, verify: null, group: 'seo-tool' },
  { key: 'other-bot', label: 'Other bots', re: /bot\b|crawler|spider|crawl|slurp|scrape|http-client|python-requests|curl\/|wget/i, verify: null, group: 'other' },
];
const BOT_BY_KEY = new Map(BOTS.map((b) => [b.key, b]));
const IMPORTANT_BOTS = BOTS.filter((b) => b.important).map((b) => b.key);

function classifyUa(ua) {
  const s = String(ua || '');
  for (const b of BOTS) if (b.re.test(s)) return b;
  return null;
}

function botMeta(key) {
  const base = String(key || '').replace(/-unverified$/, '');
  const b = BOT_BY_KEY.get(base);
  const unverified = /-unverified$/.test(String(key || ''));
  return {
    key,
    label: b ? `${b.label}${unverified ? ' (unverified)' : ''}` : (unverified ? `${base} (unverified)` : base),
    group: b ? b.group : 'other',
    verify: b ? b.verify : null,
    unverified,
  };
}

// --------------------------------------------------------- IP range checking
// The published ranges, as loaded by lib/botRanges.js. Passed in rather than
// fetched here so a parse can run entirely offline: with no ranges available
// every verifiable bot is counted as unverified, which is the honest reading —
// "we could not confirm this was Google" — rather than a silent pass.
function ipToNumber(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// Only IPv4 is range-checked. IPv6 crawler traffic is real and growing, and
// pretending otherwise would be the silent-failure pattern this file exists to
// avoid — so an IPv6 hit from a verifiable bot is counted as unverified and the
// UI says how many that was.
function makeRangeChecker(ranges) {
  const v4 = [];
  const v6Prefixes = [];
  (ranges || []).forEach((entry) => {
    const cidr = String(entry.cidr || entry || '');
    if (cidr.includes(':')) {
      // Compared as a string prefix on the first three hextets — coarse, and
      // deliberately labelled as such by the caller.
      v6Prefixes.push({ prefix: cidr.split('::')[0].toLowerCase(), owner: entry.owner || null });
      return;
    }
    const [base, bitsRaw] = cidr.split('/');
    const start = ipToNumber(base);
    const bits = Number(bitsRaw);
    if (start == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return;
    const size = 2 ** (32 - bits);
    v4.push({ start: start - (start % size), end: start - (start % size) + size - 1, owner: entry.owner || null });
  });
  v4.sort((a, b) => a.start - b.start);
  return function check(ip) {
    if (!ip) return false;
    if (ip.includes(':')) {
      const low = ip.toLowerCase();
      return v6Prefixes.some((p) => p.prefix && low.startsWith(p.prefix));
    }
    const n = ipToNumber(ip);
    if (n == null) return false;
    // Binary search over the sorted ranges: a linear scan over Google's ~1,200
    // ranges for every one of a million lines is the difference between a
    // ten-second import and a ten-minute one.
    let lo = 0;
    let hi = v4.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (n < v4[mid].start) hi = mid - 1;
      else if (n > v4[mid].end) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

// Reverse-then-forward DNS, the method Google, Bing and Yandex all document.
// A reverse lookup alone is forgeable; the forward confirmation is what makes
// it proof. Used on a SAMPLE of IPs, never per line — a DNS round trip per log
// line would take hours.
function verifyByRdns(ip, allowedSuffixes) {
  return new Promise((resolve) => {
    dns.reverse(ip, (err, names) => {
      if (err || !names || !names.length) return resolve({ ok: false, reason: 'no reverse DNS' });
      const name = names.find((n) => allowedSuffixes.some((s) => String(n).toLowerCase().endsWith(s)));
      if (!name) return resolve({ ok: false, reason: `reverse DNS is ${names[0]}` });
      return dns.resolve(name, (err2, addrs) => {
        if (err2 || !addrs) return resolve({ ok: false, reason: 'forward lookup failed' });
        resolve({ ok: addrs.includes(ip), reason: addrs.includes(ip) ? 'confirmed' : 'forward lookup did not match' });
      });
    });
  });
}

// ==========================================================================
// Path normalisation
// ==========================================================================
//
// Query strings are kept but truncated, and the parameter NAMES are what get
// grouped, because the finding is never "?page=47 was crawled 9 times" — it is
// "31% of Googlebot's budget went to URLs carrying ?page". A per-value grouping
// buries that under ten thousand rows.
function normalisePath(raw, { keepQuery = true } = {}) {
  let p = String(raw || '/');
  try {
    // A proxy sometimes logs an absolute URL rather than a path.
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname + (new URL(p).search || '');
  } catch { /* keep the raw string */ }
  const qi = p.indexOf('?');
  if (qi === -1) return p.slice(0, 400);
  if (!keepQuery) return p.slice(0, qi) || '/';
  const base = p.slice(0, qi) || '/';
  const params = p.slice(qi + 1).split('&').map((kv) => kv.split('=')[0]).filter(Boolean);
  const uniq = [...new Set(params)].sort();
  return `${base}${uniq.length ? `?${uniq.join('&')}` : ''}`.slice(0, 400);
}

// Static assets are excluded from the crawl-budget view by default. Googlebot
// fetching a CSS file is normal and necessary (it renders the page), and
// leaving them in makes every "top crawled URLs" table a list of images.
const ASSET_RE = /\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|gz|map)(?:$|\?)/i;

function isAsset(path) {
  return ASSET_RE.test(String(path || ''));
}

// ==========================================================================
// Import
// ==========================================================================
function bumpBotDaily(brandId) {
  return db.prepare(`INSERT INTO log_bot_daily
      (brand_id, date, bot, hits, bytes, status_2xx, status_3xx, status_4xx, status_5xx)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, date, bot) DO UPDATE SET
      hits=hits+excluded.hits, bytes=bytes+excluded.bytes,
      status_2xx=status_2xx+excluded.status_2xx, status_3xx=status_3xx+excluded.status_3xx,
      status_4xx=status_4xx+excluded.status_4xx, status_5xx=status_5xx+excluded.status_5xx`);
}

function bumpUrlStats(brandId) {
  return db.prepare(`INSERT INTO log_url_stats
      (brand_id, bot, path, hits, bytes, status_2xx, status_3xx, status_4xx, status_5xx,
       last_status, first_seen_at, last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(brand_id, bot, path) DO UPDATE SET
      hits=hits+excluded.hits, bytes=bytes+excluded.bytes,
      status_2xx=status_2xx+excluded.status_2xx, status_3xx=status_3xx+excluded.status_3xx,
      status_4xx=status_4xx+excluded.status_4xx, status_5xx=status_5xx+excluded.status_5xx,
      last_status=excluded.last_status,
      first_seen_at=MIN(first_seen_at, excluded.first_seen_at),
      last_seen_at=MAX(last_seen_at, excluded.last_seen_at)`);
}

// Parses text and writes the aggregates.
//
// `ranges` is the loaded IP-range list (see lib/botRanges.js). Omitting it does
// not fail the import — every otherwise-verifiable bot is simply counted as
// unverified, and the result says how many, so the reader knows the numbers are
// UA-only rather than believing they are verified.
function importText(userId, brand, text, {
  filename = null, ranges = null, actorId = null, maxLines = 4_000_000,
} = {}) {
  const lines = String(text).split(/\r?\n/);
  const detected = detectFormat(lines);
  if (!detected) {
    throw new Error('No line in that file matched a known log format (Apache/nginx combined, '
      + 'Apache vhost_combined, or nginx with an ISO timestamp). Check you pasted the access log '
      + 'rather than the error log.');
  }
  const inRange = ranges && ranges.length ? makeRangeChecker(ranges) : null;

  // Aggregated in memory, then written once per key. Writing per line would be
  // millions of statements against a single-writer database.
  const botDaily = new Map(); // `${date}|${bot}` -> counters
  const urlStats = new Map(); // `${bot}|${path}` -> counters
  const uaSamples = new Map();
  const unparsed = [];
  let seen = 0;
  let parsed = 0;
  let botHits = 0;
  let humanHits = 0;
  let bytesTotal = 0;
  let verifiedHits = 0;
  let spoofedHits = 0;
  let ipv6Unverifiable = 0;
  let firstIso = null;
  let lastIso = null;

  const bucket = (map, key, extra) => {
    let c = map.get(key);
    if (!c) {
      c = Object.assign({ hits: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0, last: null, first: null, lastSeen: null }, extra || {});
      map.set(key, c);
    }
    return c;
  };

  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    seen += 1;
    const rec = parseLine(detected.format, line);
    if (!rec) {
      if (unparsed.length < 5) unparsed.push(line.slice(0, 300));
      continue;
    }
    parsed += 1;
    bytesTotal += rec.bytes || 0;
    if (!firstIso || rec.iso < firstIso) firstIso = rec.iso;
    if (!lastIso || rec.iso > lastIso) lastIso = rec.iso;

    const bot = classifyUa(rec.ua);
    if (!bot) { humanHits += 1; continue; }
    botHits += 1;

    // The verification split. A bot that publishes ranges and fails the check
    // is counted under its own '-unverified' key rather than being dropped:
    // fake Googlebot traffic is a real finding (it is usually a scraper eating
    // server capacity), and dropping it would also hide a range list that has
    // gone stale.
    let key = bot.key;
    if (bot.verify === 'ip-range') {
      if (!inRange) {
        key = `${bot.key}-unverified`;
      } else if (rec.ip && rec.ip.includes(':') && !inRange(rec.ip)) {
        key = `${bot.key}-unverified`;
        ipv6Unverifiable += 1;
      } else if (inRange(rec.ip)) {
        verifiedHits += 1;
      } else {
        key = `${bot.key}-unverified`;
        spoofedHits += 1;
      }
    }

    if (uaSamples.size < 200 && !uaSamples.has(key)) uaSamples.set(key, rec.ua.slice(0, 200));

    const statusBand = rec.status >= 500 ? 's5' : rec.status >= 400 ? 's4' : rec.status >= 300 ? 's3' : 's2';

    const d = bucket(botDaily, `${rec.date}|${key}`);
    d.hits += 1; d.bytes += rec.bytes || 0; d[statusBand] += 1;

    const path = normalisePath(rec.path);
    const u = bucket(urlStats, `${key}|${path}`);
    u.hits += 1; u.bytes += rec.bytes || 0; u[statusBand] += 1;
    u.last = rec.status;
    if (!u.first || rec.iso < u.first) u.first = rec.iso;
    if (!u.lastSeen || rec.iso > u.lastSeen) u.lastSeen = rec.iso;
  }

  if (!parsed) {
    throw new Error(`Recognised the ${detected.format.label} format but could not parse a single line's `
      + 'timestamp. The file may be truncated or in a locale-specific date format.');
  }

  const daily = bumpBotDaily(brand.id);
  const urls = bumpUrlStats(brand.id);
  const write = db.transaction(() => {
    const info = db.prepare(`INSERT INTO log_imports
        (user_id, brand_id, filename, log_format, lines_seen, lines_parsed, lines_unparsed,
         first_hit_at, last_hit_at, bot_hits, human_hits, bytes_total, verified_bots, spoofed_bots,
         sample_unparsed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, brand.id, filename || null, detected.format.key, seen, parsed, seen - parsed,
        firstIso, lastIso, botHits, humanHits, bytesTotal, verifiedHits, spoofedHits,
        unparsed.length ? unparsed.join('\n') : null, actorId);

    for (const [k, c] of botDaily) {
      const [date, bot] = k.split('|');
      daily.run(brand.id, date, bot, c.hits, c.bytes, c.s2, c.s3, c.s4, c.s5);
    }
    for (const [k, c] of urlStats) {
      const idx = k.indexOf('|');
      const bot = k.slice(0, idx);
      const path = k.slice(idx + 1);
      urls.run(brand.id, bot, path, c.hits, c.bytes, c.s2, c.s3, c.s4, c.s5, c.last, c.first, c.lastSeen);
    }
    return info.lastInsertRowid;
  });

  return {
    importId: write(),
    format: detected.format.label,
    formatConfidence: Number(detected.confidence.toFixed(2)),
    linesSeen: seen,
    linesParsed: parsed,
    linesUnparsed: seen - parsed,
    botHits,
    humanHits,
    verifiedHits,
    spoofedHits,
    ipv6Unverifiable,
    rangesUsed: Boolean(inRange),
    bots: [...new Set([...botDaily.keys()].map((k) => k.split('|')[1]))],
    window: { from: firstIso, to: lastIso },
    sampleUnparsed: unparsed,
  };
}

// ==========================================================================
// Reading
// ==========================================================================
function imports(userId, brandId = null, limit = 25) {
  const where = brandId ? 'AND i.brand_id=?' : '';
  const args = brandId ? [userId, brandId, limit] : [userId, limit];
  return db.prepare(`SELECT i.*, b.name brand_name FROM log_imports i
    LEFT JOIN brands b ON b.id=i.brand_id
    WHERE i.user_id=? ${where} ORDER BY i.id DESC LIMIT ?`).all(...args);
}

function coverage(brandId) {
  const r = db.prepare(`SELECT MIN(date) from_date, MAX(date) to_date,
      COUNT(DISTINCT date) days, SUM(hits) hits FROM log_bot_daily WHERE brand_id=?`).get(brandId);
  return r && r.hits ? r : null;
}

function botTotals(brandId, { from = null, to = null } = {}) {
  const w = ['brand_id=?'];
  const a = [brandId];
  if (from) { w.push('date>=?'); a.push(from); }
  if (to) { w.push('date<=?'); a.push(to); }
  return db.prepare(`SELECT bot, SUM(hits) hits, SUM(bytes) bytes,
      SUM(status_2xx) s2, SUM(status_3xx) s3, SUM(status_4xx) s4, SUM(status_5xx) s5,
      MIN(date) first_date, MAX(date) last_date
    FROM log_bot_daily WHERE ${w.join(' AND ')}
    GROUP BY bot ORDER BY hits DESC`).all(...a)
    .map((r) => Object.assign(r, botMeta(r.bot), {
      errorRate: r.hits ? Number((((r.s4 + r.s5) / r.hits) * 100).toFixed(1)) : 0,
      redirectRate: r.hits ? Number(((r.s3 / r.hits) * 100).toFixed(1)) : 0,
    }));
}

function dailySeries(brandId, bot = 'googlebot', { days = 90 } = {}) {
  return db.prepare(`SELECT date, SUM(hits) hits, SUM(status_4xx) s4, SUM(status_5xx) s5, SUM(status_3xx) s3
    FROM log_bot_daily WHERE brand_id=? AND bot=?
    GROUP BY date ORDER BY date DESC LIMIT ?`).all(brandId, bot, days).reverse();
}

function topPaths(brandId, bot, { limit = 50, includeAssets = false } = {}) {
  const rows = db.prepare(`SELECT path, hits, bytes, status_2xx s2, status_3xx s3,
      status_4xx s4, status_5xx s5, last_status, first_seen_at, last_seen_at
    FROM log_url_stats WHERE brand_id=? AND bot=? ORDER BY hits DESC LIMIT ?`)
    .all(brandId, bot, includeAssets ? limit : limit * 4);
  const filtered = includeAssets ? rows : rows.filter((r) => !isAsset(r.path));
  return filtered.slice(0, limit);
}

// ------------------------------------------------------------- the findings
// Everything the analysis actually concludes, as a list of findings in the
// same shape the alert engine and task bridge already consume: a title, the
// evidence, and what to do about it.
function findings(brandId, { bot = 'googlebot', sitemapUrls = null } = {}) {
  const out = [];
  const cov = coverage(brandId);
  if (!cov) return out;

  const all = db.prepare(`SELECT path, hits, bytes, status_2xx s2, status_3xx s3, status_4xx s4,
      status_5xx s5, last_status, last_seen_at
    FROM log_url_stats WHERE brand_id=? AND bot=?`).all(brandId, bot);
  if (!all.length) return out;

  const totalHits = all.reduce((a, r) => a + r.hits, 0);
  const contentRows = all.filter((r) => !isAsset(r.path));
  const contentHits = contentRows.reduce((a, r) => a + r.hits, 0);
  const assetHits = totalHits - contentHits;

  // 1. Crawl budget spent on error responses.
  const errorRows = contentRows.filter((r) => r.s4 + r.s5 > 0)
    .sort((x, y) => (y.s4 + y.s5) - (x.s4 + x.s5));
  const errorHits = errorRows.reduce((a, r) => a + r.s4 + r.s5, 0);
  if (errorHits > 0) {
    const share = (errorHits / Math.max(1, contentHits)) * 100;
    out.push({
      key: 'crawl_errors',
      severity: share >= 5 ? 'high' : share >= 1 ? 'medium' : 'low',
      title: `${errorHits.toLocaleString('en-US')} of ${bot}'s requests returned an error`,
      summary: `${share.toFixed(1)}% of this crawler's content requests returned 4xx or 5xx across ${cov.days} day(s) of logs.`,
      action: 'Fix or redirect the URLs below. A crawler that keeps being served errors slows its crawl rate for the whole site, and a 5xx pattern can drop pages out of the index entirely.',
      rows: errorRows.slice(0, 25),
    });
  }

  // 2. Crawl budget spent on redirects.
  const redirectRows = contentRows.filter((r) => r.s3 > 0).sort((x, y) => y.s3 - x.s3);
  const redirectHits = redirectRows.reduce((a, r) => a + r.s3, 0);
  if (redirectHits / Math.max(1, contentHits) >= 0.1) {
    out.push({
      key: 'crawl_redirects',
      severity: 'medium',
      title: `${((redirectHits / contentHits) * 100).toFixed(0)}% of ${bot}'s requests were redirected`,
      summary: `${redirectHits.toLocaleString('en-US')} redirect responses. Every one is a request that fetched no content.`,
      action: 'Update the internal links and the sitemap to point at the final URLs. This is almost always a trailing-slash, http→https or www rule being hit from inside the site itself.',
      rows: redirectRows.slice(0, 25),
    });
  }

  // 3. Parameter and faceted URLs eating the budget.
  const paramRows = contentRows.filter((r) => r.path.includes('?')).sort((x, y) => y.hits - x.hits);
  const paramHits = paramRows.reduce((a, r) => a + r.hits, 0);
  if (paramHits / Math.max(1, contentHits) >= 0.15) {
    const byParam = new Map();
    paramRows.forEach((r) => {
      r.path.split('?')[1].split('&').forEach((p) => {
        byParam.set(p, (byParam.get(p) || 0) + r.hits);
      });
    });
    out.push({
      key: 'crawl_parameters',
      severity: 'medium',
      title: `${((paramHits / contentHits) * 100).toFixed(0)}% of the crawl went to parameterised URLs`,
      summary: `Most-crawled parameters: ${[...byParam].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([p, n]) => `${p} (${n.toLocaleString('en-US')})`).join(', ')}.`,
      action: 'Decide per parameter whether it should be crawled at all. Filters and sort orders normally want a canonical to the clean URL and a robots.txt disallow; pagination normally does not.',
      rows: paramRows.slice(0, 25),
    });
  }

  // 4. Assets dominating the crawl.
  if (assetHits / Math.max(1, totalHits) >= 0.6) {
    out.push({
      key: 'crawl_assets',
      severity: 'low',
      title: `${((assetHits / totalHits) * 100).toFixed(0)}% of the crawl was static assets`,
      summary: `${assetHits.toLocaleString('en-US')} of ${totalHits.toLocaleString('en-US')} requests were CSS, JS, images or fonts.`,
      action: 'Normal in itself — the crawler renders pages. Worth attention only if the asset URLs are cache-busted on every deploy, which makes every build look like a new set of files to crawl.',
      rows: all.filter((r) => isAsset(r.path)).sort((x, y) => y.hits - x.hits).slice(0, 15),
    });
  }

  // 5. Pages in the sitemap that this crawler has never requested.
  //
  // This is the real orphan test, and it is only possible with logs. A link
  // crawl can only tell you a page has no internal links; the log tells you
  // Googlebot has never fetched it, which is the thing that actually matters.
  if (sitemapUrls && sitemapUrls.length) {
    const crawled = new Set(all.map((r) => r.path.split('?')[0]));
    const missing = [];
    sitemapUrls.forEach((u) => {
      let p;
      try { p = new URL(u).pathname; } catch { p = String(u); }
      if (!crawled.has(p) && !crawled.has(p.replace(/\/$/, '')) && !crawled.has(`${p}/`)) missing.push(u);
    });
    if (missing.length) {
      out.push({
        key: 'never_crawled',
        severity: missing.length / sitemapUrls.length >= 0.2 ? 'high' : 'medium',
        title: `${missing.length} sitemap URL(s) were never requested by ${bot}`,
        summary: `Of ${sitemapUrls.length} URLs in the sitemap, ${missing.length} appear nowhere in ${cov.days} day(s) of logs. This is the strongest available evidence of a discovery problem — stronger than an internal-link orphan check, because it reflects what the crawler did rather than what it could have done.`,
        action: 'Check these are internally linked from a crawlable page, are not blocked in robots.txt, and are in a sitemap the property actually has submitted. Then submit the important ones for indexing.',
        rows: missing.slice(0, 40).map((u) => ({ path: u, hits: 0 })),
      });
    }
  }

  // 6. Fake crawler traffic.
  const spoofed = db.prepare(`SELECT bot, SUM(hits) hits FROM log_bot_daily
    WHERE brand_id=? AND bot LIKE '%-unverified' GROUP BY bot ORDER BY hits DESC`).all(brandId);
  const spoofedTotal = spoofed.reduce((a, r) => a + r.hits, 0);
  if (spoofedTotal > 0) {
    out.push({
      key: 'unverified_bots',
      severity: 'low',
      title: `${spoofedTotal.toLocaleString('en-US')} requests claimed to be a verifiable crawler but did not come from its published IP ranges`,
      summary: spoofed.slice(0, 6).map((r) => `${botMeta(r.bot).label}: ${r.hits.toLocaleString('en-US')}`).join(', '),
      action: 'These are scrapers or SEO tools wearing a crawler user agent, and they consume real server capacity. They are excluded from the verified counts above. Rate-limit or block them at the edge if the volume is material.',
      rows: [],
    });
  }

  return out;
}

// Wipes the aggregates for a brand. Offered because re-importing an
// overlapping window double-counts (see the schema note), so "start again" has
// to be a real option rather than something done with SQL by hand.
function resetBrand(brandId) {
  const run = db.transaction(() => {
    const a = db.prepare('DELETE FROM log_bot_daily WHERE brand_id=?').run(brandId).changes;
    const b = db.prepare('DELETE FROM log_url_stats WHERE brand_id=?').run(brandId).changes;
    const c = db.prepare('DELETE FROM log_imports WHERE brand_id=?').run(brandId).changes;
    return { botDaily: a, urlStats: b, imports: c };
  });
  return run();
}

module.exports = {
  FORMATS, BOTS, IMPORTANT_BOTS, botMeta, classifyUa,
  detectFormat, parseLine, parseLogTime, normalisePath, isAsset,
  makeRangeChecker, ipToNumber, verifyByRdns,
  importText, imports, coverage, botTotals, dailySeries, topPaths, findings, resetBrand,
};
