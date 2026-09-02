// REDDIT — the tiered, block-aware scraper.
//
// Ported from the lead-gen agent's `leadgen/scrapers/reddit.py` +
// `leadgen/http_client.py`, because that design solves the problem this one has:
// Reddit's anti-bot posture varies by endpoint, by IP reputation, and by week,
// so a single endpoint is not a strategy. What carries over is the ARCHITECTURE
// — a fallback chain, a paced session that backs off on a block and gives up
// cleanly, and the distinction between "this endpoint failed" and "this
// endpoint worked and there is genuinely nothing".
//
// WHAT DID NOT CARRY OVER, AND WHY
// Its tier order no longer reflects reality. Measured against the live
// endpoints from this machine:
//
//   /search.json          HTTP 403 + a 185KB HTML block page, with or without
//                         coherent client hints. Reddit has closed it to
//                         anonymous server-side callers.
//   old.reddit.com/search HTTP 200, but a 302 to /login/?reason=lor2 — a login
//                         wall wearing a 200.
//   /search/  (shreddit)  HTTP 200 and an 8KB JavaScript shell. No
//                         <shreddit-post> elements: the results are rendered
//                         client-side now, so there is nothing to parse.
//   /search.rss           HTTP 200 with real entries.  <-- the one that works
//
// So RSS leads. The other tiers are kept, in the order of how much data they
// yield when they do work, because "works from this IP today" is not a durable
// property and the whole point of a chain is that one endpoint closing does not
// zero out the feature.
//
// A NOTE ON PACING, WHICH IS NOT OPTIONAL
// Reddit answered 429 to the fourth request in a quick burst during
// development, and the RSS endpoint that had just returned 200 started
// returning nothing. The penalty outlives the request that triggered it, so
// hammering makes it worse. Hence the delay, the jitter, the escalating
// cooldown, and the hard stop.
const cheerio = require('cheerio');

const BASE = 'https://www.reddit.com';
const OLD_BASE = 'https://old.reddit.com';

// Real, current desktop browser profiles. The client hints must AGREE with the
// User-Agent: a UA claiming Chrome 137 with no Sec-CH-UA header is a known bot
// signature, and sending them inconsistently is worse than sending neither.
const BROWSER_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    platform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    platform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
    secChUa: '"Microsoft Edge";v="136", "Chromium";v="136", "Not/A)Brand";v="24"',
    platform: '"Windows"',
  },
];

function browserHeaders(profile) {
  return {
    'User-Agent': profile.ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    // No brotli or zstd: undici decodes gzip and deflate, and advertising an
    // encoding that cannot be decoded returns bytes nothing can read.
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA': profile.secChUa,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': profile.platform,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    Connection: 'keep-alive',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A paced session that recognises a block and stops making it worse.
class BrowserSession {
  constructor({
    // 6s, not the 4s the lead-gen agent uses. Measured: at 4s spacing the RSS
    // endpoint answered 429 on the second request from this network. The
    // penalty for being too fast is a 30-240s cooldown, so paying two extra
    // seconds per request is comfortably the cheaper side of the trade.
    delayMs = Number(process.env.REDDIT_DELAY_MS) || 6000,
    jitterMs = 800,
    timeoutMs = 25000,
    cooldownBaseMs = 30000,
    maxCooldownMs = 240000,
    blockThreshold = 4,
  } = {}) {
    this.delayMs = delayMs;
    this.jitterMs = jitterMs;
    this.timeoutMs = timeoutMs;
    this.cooldownBaseMs = cooldownBaseMs;
    this.maxCooldownMs = maxCooldownMs;
    this.blockThreshold = blockThreshold;

    this.consecutiveBlocks = 0;
    this.totalBlocks = 0;
    this.requests = 0;
    this.lastRequestAt = 0;
    this.lastError = null;
    // The last failure was a rate limit (429) rather than a closed door (403).
    // The caller uses this to decide whether falling through to the next tier
    // makes sense — see the note in searchTerm.
    this.rateLimited = false;
    // Tiers that answered 403. A 403 from Reddit is not "busy", it is "this
    // endpoint is closed to unauthenticated callers", and it will be 403 on
    // every subsequent request. Retrying it once per search term spent two
    // thirds of the request budget on a guaranteed failure — and each wasted
    // request pushed the session toward the rate limit that then broke the
    // tiers which DO work.
    this.deadTiers = new Set();
    // One profile for the whole session. Rotating the User-Agent between
    // requests from one IP is itself a bot signature.
    this.profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
    this.headers = browserHeaders(this.profile);
  }

  get hardBlocked() { return this.consecutiveBlocks >= this.blockThreshold; }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = this.delayMs + Math.random() * this.jitterMs - elapsed;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async coolDown() {
    // No point burning the wall clock when the caller is about to give up.
    if (this.hardBlocked) return;
    const delay = Math.min(this.cooldownBaseMs * (2 ** (this.consecutiveBlocks - 1)), this.maxCooldownMs);
    // eslint-disable-next-line no-console
    console.warn(`[reddit] blocked (#${this.consecutiveBlocks}) — cooling down ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }

  // Returns { ok, status, text } on success and null on failure, so one dead
  // endpoint never takes a run down.
  async get(url, extraHeaders = {}) {
    if (this.hardBlocked) return null;
    await this.throttle();
    this.requests += 1;

    let res;
    let text;
    try {
      res = await fetch(url, {
        headers: { ...this.headers, ...extraHeaders },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      this.lastError = `request failed: ${String(err.message).slice(0, 140)}`;
      return null;
    }

    // A 200 that redirected to the login wall is a block wearing a success
    // code. old.reddit.com/search does exactly this, and treating it as data
    // would parse a login page for brand mentions.
    if (/\/login\/?\?/.test(res.url || '')) {
      this.consecutiveBlocks += 1;
      this.totalBlocks += 1;
      this.lastError = 'redirected to the Reddit login wall';
      await this.coolDown();
      return null;
    }

    if (res.status === 200) {
      this.consecutiveBlocks = 0;
      this.rateLimited = false;
      return { ok: true, status: 200, text, finalUrl: res.url };
    }

    // A RATE LIMIT is temporary and is about volume, so it earns a cooldown and
    // counts toward giving up. Trying a different endpoint on the same host
    // immediately after being told "too many requests" makes it worse.
    if (res.status === 429) {
      this.consecutiveBlocks += 1;
      this.totalBlocks += 1;
      this.rateLimited = true;
      this.lastError = 'HTTP 429 (rate limited)';
      await this.coolDown();
      return null;
    }

    // A 403 is permanent for this endpoint in this credential state. It is NOT
    // evidence the host is angry, so it must not trigger a cooldown or count
    // toward the block threshold: doing so let a permanently-closed endpoint
    // abandon the entire source. The caller marks the tier dead instead.
    if (res.status === 403 || res.status === 401) {
      this.rateLimited = false;
      this.lastError = `HTTP ${res.status} (endpoint closed to unauthenticated callers)`;
      return null;
    }

    this.rateLimited = false;
    this.lastError = `HTTP ${res.status}`;
    return null;
  }

  // JSON needs the fetch metadata a same-origin XHR would send; sending
  // navigate/document headers to a .json endpoint is incoherent.
  async getJson(url) {
    const r = await this.get(url, {
      Accept: 'application/json, text/plain, */*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    });
    if (!r) return null;
    try { return JSON.parse(r.text); } catch {
      this.lastError = 'response was not JSON (usually a block page served with a 200)';
      return null;
    }
  }
}

// --------------------------------------------------------------- parsing

const decodeEntities = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const stripTags = (s) => decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Reddit's feeds are ATOM (<entry>, <updated>, <link href="">), not RSS 2.0
// (<item>, <pubDate>, <link>text</link>). Getting that wrong yields zero items
// from a perfectly good 200, which is indistinguishable from "no mentions" —
// so both shapes are handled.
function parseFeed(xml) {
  const text = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(text) || /<entry[\s>]/i.test(text);
  const blocks = isAtom ? text.split(/<entry[\s>]/i).slice(1) : text.split(/<item[\s>]/i).slice(1);

  return blocks.map((raw) => {
    const tag = (name) => {
      const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(raw);
      return m ? m[1] : null;
    };
    // Atom puts the URL in an attribute; RSS puts it in the element body.
    const linkAttr = /<link[^>]*href=["']([^"']+)["']/i.exec(raw);
    const url = linkAttr ? decodeEntities(linkAttr[1]) : (tag('link') ? stripTags(tag('link')) : null);
    const when = tag('updated') || tag('published') || tag('pubDate');
    const parsed = when ? Date.parse(stripTags(when)) : NaN;
    // Author is "/u/name" in Reddit's Atom feed.
    const authorName = tag('name');

    return {
      url,
      title: tag('title') ? stripTags(tag('title')) : null,
      body: stripTags(tag('content') || tag('summary') || tag('description') || ''),
      author: authorName ? stripTags(authorName) : null,
      publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
      // t3_ is a post, t5_ a subreddit, t1_ a comment. A sitewide search feed
      // mixes them, and a subreddit is not a mention of the brand by a person.
      thingId: tag('id') ? stripTags(tag('id')) : null,
    };
  }).filter((e) => e.url);
}

// Subreddit from a permalink: /r/<sub>/comments/...
function subredditOf(url) {
  const m = /reddit\.com\/r\/([^/]+)/i.exec(String(url || ''));
  return m ? `r/${m[1]}` : null;
}

function toMention(entry, matchedTerm) {
  return {
    source: 'reddit',
    url: String(entry.url).split('?')[0],
    title: entry.title || null,
    snippet: (entry.body || entry.title || '').slice(0, 800),
    author: entry.author || null,
    // The feeds carry no score. Reported as 0 rather than guessed — an invented
    // engagement number would sort the whole list wrongly.
    engagement: Number.isFinite(entry.engagement) ? entry.engagement : 0,
    publishedAt: entry.publishedAt || null,
    context: subredditOf(entry.url),
    matchedTerm,
  };
}

// ------------------------------------------------------------------ tiers

function searchParams({ term, sort, window: t, limit }) {
  const q = /\s/.test(term) ? `"${term}"` : term;
  const p = new URLSearchParams({ q, sort, limit: String(limit) });
  if (t && t !== 'all') p.set('t', t);
  return p;
}

// Tier order is deliberate: RSS is the one verified to answer, JSON is the
// richest when it answers, HTML is the last resort.
//
// Each tier returns an ARRAY (it worked — possibly empty) or NULL (it failed,
// try the next). That distinction is the whole reason the chain is cheap: a
// genuinely empty result must not burn two more requests against a rate limit
// that matters.
const TIERS = [
  {
    key: 'rss',
    label: 'RSS feed',
    async run(session, opts) {
      const p = searchParams(opts);
      const url = opts.subreddit
        ? `${BASE}/r/${encodeURIComponent(opts.subreddit)}/search.rss?${p}&restrict_sr=1`
        : `${BASE}/search.rss?${p}`;
      const r = await session.get(url);
      if (!r) return null;
      if (!/<(feed|rss)[\s>]/i.test(r.text)) return null; // a 200 that is not a feed is a block page
      return parseFeed(r.text)
        // Posts only. A sitewide feed also returns subreddits (t5_) and
        // comments (t1_); a subreddit is not somebody saying something.
        .filter((e) => !e.thingId || /(^|_)t3_/.test(e.thingId) || /\/comments\//.test(e.url))
        .map((e) => toMention(e, opts.term));
    },
  },
  {
    key: 'json',
    label: 'JSON endpoint',
    async run(session, opts) {
      const p = searchParams(opts);
      p.set('type', 'link');
      p.set('raw_json', '1'); // stop Reddit HTML-escaping &, < and >
      const url = opts.subreddit
        ? `${BASE}/r/${encodeURIComponent(opts.subreddit)}/search.json?${p}&restrict_sr=1`
        : `${BASE}/search.json?${p}`;
      const payload = await session.getJson(url);
      if (!payload || typeof payload !== 'object' || !payload.data) return null;
      const children = Array.isArray(payload.data.children) ? payload.data.children : [];
      return children.map((c) => c && c.data).filter(Boolean).map((d) => toMention({
        url: d.permalink ? `${BASE}${d.permalink}` : d.url,
        title: d.title || null,
        body: d.selftext || '',
        author: d.author ? `/u/${d.author}` : null,
        publishedAt: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : null,
        // Score plus comment count: discussion is what a retrieval system finds
        // and quotes, so a thread with 400 comments outranks 400 silent upvotes.
        engagement: (Number(d.score) || 0) + ((Number(d.num_comments) || 0) * 3),
        thingId: d.name || null,
      }, opts.term)).filter((m) => m.url);
    },
  },
  {
    key: 'html',
    label: 'HTML search page',
    async run(session, opts) {
      const p = searchParams(opts);
      p.set('type', 'posts');
      const url = opts.subreddit
        ? `${BASE}/r/${encodeURIComponent(opts.subreddit)}/search/?${p}&restrict_sr=1`
        : `${BASE}/search/?${p}`;
      const r = await session.get(url);
      if (!r) return null;

      const $ = cheerio.load(r.text);
      const out = [];

      // Reddit's current frontend emits <shreddit-post> custom elements whose
      // ATTRIBUTES carry the structured data. Far more stable than its CSS
      // class names, which are hashed and change constantly.
      $('shreddit-post').each((_, el) => {
        const $el = $(el);
        const permalink = $el.attr('permalink') || '';
        if (!permalink) return;
        out.push(toMention({
          url: /^https?:/.test(permalink) ? permalink : `${BASE}${permalink}`,
          title: $el.attr('post-title') || $el.find('[slot="title"]').first().text().trim() || null,
          body: $el.find('[slot="text-body"]').first().text().replace(/\s+/g, ' ').trim(),
          author: $el.attr('author') ? `/u/${$el.attr('author')}` : null,
          publishedAt: $el.attr('created-timestamp') || null,
          engagement: Number($el.attr('score')) || 0,
          thingId: $el.attr('id') || null,
        }, opts.term));
      });
      if (out.length) return out;

      // Fallback markup: any anchor carrying a /comments/ permalink.
      const seen = new Set();
      $('a[href*="/comments/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const label = $(el).text().replace(/\s+/g, ' ').trim();
        if (!label || label.length < 12) return;
        const abs = (/^https?:/.test(href) ? href : `${BASE}${href}`).split('?')[0];
        if (seen.has(abs)) return;
        seen.add(abs);
        out.push(toMention({ url: abs, title: label, body: '', author: null, publishedAt: null, thingId: null }, opts.term));
      });

      // An empty parse here is far more likely a markup change or a JavaScript
      // shell than a genuinely empty result page — this endpoint currently
      // returns an 8KB shell — so hand off rather than asserting "no results".
      return out.length ? out : null;
    },
  },
];

// The authenticated endpoint, used FIRST when a credential exists because it is
// strictly better: no blocks, real scores, and no scraping. A free "script" app
// at reddit.com/prefs/apps supplies the two values.
let tokenCache = null;

async function accessToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Reddit's API rules ask for a descriptive, unique agent and throttle
      // generic ones harder.
      'User-Agent': process.env.REDDIT_USER_AGENT || 'seo-suite/1.0 (brand mention monitoring)',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Reddit auth failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 140)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Reddit auth returned no access_token.');
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ((Number(json.expires_in) || 3600) * 1000) };
  return tokenCache.token;
}

const OAUTH_TIER = {
  key: 'oauth',
  label: 'authenticated API',
  async run(session, opts) {
    const token = await accessToken();
    if (!token) return null;
    const p = searchParams(opts);
    p.set('type', 'link');
    p.set('raw_json', '1');
    const url = opts.subreddit
      ? `https://oauth.reddit.com/r/${encodeURIComponent(opts.subreddit)}/search?${p}&restrict_sr=1`
      : `https://oauth.reddit.com/search?${p}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': process.env.REDDIT_USER_AGENT || 'seo-suite/1.0 (brand mention monitoring)',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      session.lastError = `authenticated API returned HTTP ${res.status}`;
      return null;
    }
    const payload = await res.json();
    const children = (payload && payload.data && payload.data.children) || [];
    return children.map((c) => c && c.data).filter(Boolean).map((d) => toMention({
      url: d.permalink ? `${BASE}${d.permalink}` : d.url,
      title: d.title || null,
      body: d.selftext || '',
      author: d.author ? `/u/${d.author}` : null,
      publishedAt: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : null,
      engagement: (Number(d.score) || 0) + ((Number(d.num_comments) || 0) * 3),
      thingId: d.name || null,
    }, opts.term)).filter((m) => m.url);
  },
};

function hasCredential() {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

// --------------------------------------------------------------- public API

// One term through the fallback chain. Never throws.
async function searchTerm(session, {
  term, subreddit = null, sort = 'new', window: win = 'year', limit = 50,
}) {
  const chain = hasCredential() ? [OAUTH_TIER, ...TIERS] : TIERS;
  const attempts = [];
  // One same-tier retry per term after a rate-limit cooldown, never more: a
  // retry loop against a rate limiter is the thing the cooldown exists to
  // prevent.
  let retriedAfterCooldown = false;

  for (const tier of chain) {
    if (session.hardBlocked) {
      attempts.push({ tier: tier.key, outcome: 'skipped', reason: 'session is hard-blocked' });
      break;
    }
    // Learned during this session: this endpoint already answered 403 and will
    // again. Skipping costs nothing and saves a request that would otherwise
    // push the working tiers toward the rate limit.
    if (session.deadTiers.has(tier.key)) {
      attempts.push({ tier: tier.key, outcome: 'skipped', reason: 'returned 403 earlier in this session' });
      continue;
    }

    let items;
    try {
      items = await tier.run(session, { term, subreddit, sort, window: win, limit });
    } catch (err) {
      // A parser change or an auth failure must not end the chain.
      attempts.push({ tier: tier.key, outcome: 'error', reason: String(err.message).slice(0, 160) });
      continue;
    }

    if (items === null) {
      const reason = session.lastError || 'endpoint returned nothing usable';
      attempts.push({ tier: tier.key, outcome: 'unavailable', reason });
      if (/HTTP 40[13]/.test(reason)) session.deadTiers.add(tier.key);

      // Being rate-limited is a statement about the HOST, not this endpoint, so
      // trying two more of its endpoints immediately is exactly how a transient
      // 429 becomes a hard block.
      //
      // But the cooldown has already been served by the time control gets here,
      // and this tier is the one that works — so retry IT once rather than
      // losing the term. Without this a single transient 429 silently dropped a
      // whole search term, and the UI reported that term as having no mentions.
      if (session.rateLimited && !retriedAfterCooldown && !session.hardBlocked) {
        retriedAfterCooldown = true;
        let retry;
        try {
          retry = await tier.run(session, { term, subreddit, sort, window: win, limit });
        } catch (err) {
          retry = null;
          attempts.push({ tier: tier.key, outcome: 'error', reason: `retry after cooldown: ${String(err.message).slice(0, 140)}` });
        }
        if (retry !== null && retry !== undefined) {
          attempts.push({ tier: tier.key, outcome: 'ok', items: retry.length, reason: 'succeeded on retry after the cooldown' });
          return { ok: true, tier: tier.key, tierLabel: tier.label, items: retry, attempts, retried: true };
        }
        attempts.push({ tier: tier.key, outcome: 'unavailable', reason: `still ${session.lastError} after the cooldown` });
      }

      if (session.rateLimited) {
        attempts.push({ tier: '(chain)', outcome: 'aborted', reason: 'rate limited — no further endpoints tried on the same host for this term' });
        break;
      }
      continue;
    }

    // An array — including an empty one — means this tier ANSWERED. Stop.
    attempts.push({ tier: tier.key, outcome: 'ok', items: items.length });
    return { ok: true, tier: tier.key, tierLabel: tier.label, items, attempts };
  }

  return {
    ok: false,
    items: [],
    attempts,
    error: session.hardBlocked
      ? `Reddit has rate-limited this IP after ${session.consecutiveBlocks} consecutive blocks. Remaining Reddit searches were abandoned and everything already collected was kept. Wait 15-60 minutes, raise REDDIT_DELAY_MS, or set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET for the authenticated endpoint.`
      : `Every Reddit tier failed (${attempts.map((a) => `${a.tier}: ${a.reason || a.outcome}`).join('; ')}).`,
  };
}

// Many terms, optionally across named subreddits. Aborts early once the IP is
// blocked and reports what it abandoned, because partial data beats no data and
// continuing only deepens the ban.
async function search(terms, {
  subreddits = [], sitewide = true, sort = 'new', window: win = 'year',
  limit = 50, session = null,
} = {}) {
  const s = session || new BrowserSession();
  const targets = [];
  // Sitewide first, deliberately: it is the broadest yield per request, so if
  // the IP is going to be blocked partway through, it is spent there.
  if (sitewide) terms.forEach((t) => targets.push({ term: t, subreddit: null }));
  // Subreddit-scoped search runs for the PRIMARY term only. Every term against
  // every subreddit multiplies requests against a rate limit that is the
  // binding constraint here, while the secondary terms are usually near-variants
  // of the first (a brand name, its domain, its domain label) — so the extra
  // requests buy very little and cost the working tiers a great deal.
  const primary = terms[0];
  if (primary) subreddits.forEach((sub) => targets.push({ term: primary, subreddit: sub }));

  const items = [];
  const perTarget = [];
  const tierCounts = {};
  let abandoned = 0;
  let retries = 0;

  for (let i = 0; i < targets.length; i += 1) {
    if (s.hardBlocked) {
      abandoned = targets.length - i;
      break;
    }
    const t = targets[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await searchTerm(s, { ...t, sort, window: win, limit });
    perTarget.push({
      term: t.term,
      subreddit: t.subreddit,
      ok: r.ok,
      tier: r.tier || null,
      items: r.items.length,
      error: r.error || null,
      attempts: r.attempts,
    });
    if (r.ok) {
      tierCounts[r.tier] = (tierCounts[r.tier] || 0) + r.items.length;
      if (r.retried) retries += 1;
      items.push(...r.items);
    }
  }

  const anyOk = perTarget.some((p) => p.ok);
  return {
    ok: anyOk,
    items,
    perTarget,
    stats: {
      requests: s.requests,
      totalBlocks: s.totalBlocks,
      hardBlocked: s.hardBlocked,
      abandoned,
      tierCounts,
      retries,
      authenticated: hasCredential(),
      // Which endpoints closed the door during this run. Surfaced because it
      // explains a thin result far better than a bare item count.
      closedEndpoints: [...s.deadTiers],
    },
    // One sentence the UI can show, naming which tier answered — the thing a
    // practitioner needs in order to trust or distrust the numbers.
    error: anyOk ? null : (perTarget[0] && perTarget[0].error) || 'Reddit returned nothing usable.',
  };
}

module.exports = {
  search, searchTerm, BrowserSession, browserHeaders, parseFeed,
  hasCredential, subredditOf, TIERS, BROWSER_PROFILES,
};
