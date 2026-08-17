// URL helpers, ported one-for-one from the Python tools so both
// implementations group, deduplicate and compare URLs identically.
//
// Small differences here would show up as different issue counts between the
// Python and JavaScript runs of the same audit, which would be far harder to
// explain than the crawl itself.
const { URL } = require('url');

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

// The registrable host, lower-cased, without credentials, port, or the www
// prefix. Two URLs are "same site" when these match.
function hostKey(url) {
  let net;
  try {
    net = new URL(normalizeUrl(url)).host.toLowerCase();
  } catch {
    return '';
  }
  if (net.includes('@')) net = net.split('@').pop();
  net = net.split(':')[0];
  if (net.startsWith('www.')) net = net.slice(4);
  return net;
}

function sameSite(a, b) {
  return hostKey(a) === hostKey(b);
}

// The canonical form used as a dictionary key throughout: scheme and host
// lower-cased, www stripped, default port dropped, trailing slash removed,
// fragment removed, query preserved.
function canonUrl(url) {
  let p;
  try {
    p = new URL(url);
  } catch {
    return String(url || '');
  }
  const scheme = (p.protocol || 'https:').toLowerCase().replace(':', '');
  let netloc = p.host.toLowerCase();
  if (netloc.startsWith('www.')) netloc = netloc.slice(4);
  if (scheme === 'http' && netloc.endsWith(':80')) netloc = netloc.slice(0, -3);
  if (scheme === 'https' && netloc.endsWith(':443')) netloc = netloc.slice(0, -4);
  let path = p.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return `${scheme}://${netloc}${path}${p.search || ''}`;
}

function joinUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

// Strips the fragment but keeps the query — the form links are stored in.
function stripFragment(url) {
  try {
    const p = new URL(url);
    p.hash = '';
    return p.href;
  } catch {
    return String(url || '').split('#')[0];
  }
}

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4[av]|mov|avi|wmv|webm|zip|gz|tar|rar|7z|dmg|exe|msi|css|js|json|xml|rss|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf|eot)(\?|#|$)/i;

const RESOURCE_EXT = /\.(css|js|json|pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4[av]|mov|avi|wmv|webm|zip|gz|tar|rar|7z|dmg|exe|msi|docx?|xlsx?|pptx?|woff2?|ttf|eot)(\?|#|$)/i;

function isCrawlableHtml(url) {
  return !NON_HTML_EXT.test(url);
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function truncate(s, n = 70) {
  const str = String(s == null ? '' : s).trim();
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

module.exports = {
  normalizeUrl, hostKey, sameSite, canonUrl, joinUrl, stripFragment,
  isCrawlableHtml, pathOf, truncate, NON_HTML_EXT, RESOURCE_EXT,
};
