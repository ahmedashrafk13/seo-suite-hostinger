#!/usr/bin/env python3
"""Render one URL in a headless browser and report where it ended up.

WHY THIS EXISTS
One shape of login wall is invisible to any server-side check: the server
answers HTTP 200 with a JavaScript shell, and the redirect to the sign-in page
happens in the browser. `app.slack.com/client` does exactly this — it returns
200, its HTML contains no login form, and following its meta refresh lands on
the same shell. Nothing a plain HTTP request can see distinguishes it from an
ordinary JS-heavy site.

So when the access check in src/lib/crawlAuth.js meets a page that looks like a
shell — very little text, almost no links onward — and a renderer is available,
it calls this. Rendering the page is the only way to learn that a human would
have been bounced to a login.

Deliberately narrow: one page, one navigation, a hard timeout, JSON on stdout.
It is a probe, not a crawler; the crawlers do their own rendering.

Credentials arrive in CRAWL_AUTH_HEADERS (see crawlAuth.toEnv) and are attached
by routing, scoped to the requested site, so nothing is sent to the third-party
scripts and fonts a page pulls in.

Usage:  python render_probe.py <url> [--timeout-ms 15000] [--settle-ms 1200]
Output: {"ok":true,"finalUrl":...,"title":...,"hasPassword":...,"words":...,
         "internalLinks":...,"navigations":[...]}
        or {"ok":false,"error":"..."}
"""
import json
import os
import re
import sys
import urllib.parse


def auth_site_key(url):
    """Host (www folded) plus port — the credential scope key."""
    # .port raises ValueError on a malformed authority, and pages contain
    # plenty of malformed hrefs — one of them crashed the whole probe the first
    # time this ran against a real site. Accessing it inside the guard, not
    # after it, is the fix.
    try:
        parts = urllib.parse.urlparse(
            str(url) if "://" in str(url) else "https://" + str(url))
        host = (parts.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except Exception:
        return ""
    return "%s:%s" % (host, port)


def auth_headers_from_env():
    try:
        raw = json.loads(os.environ.get("CRAWL_AUTH_HEADERS") or "{}")
    except Exception:
        return {}
    out = {}
    for key, value in raw.items():
        if key and isinstance(value, str) and "\r" not in value and "\n" not in value:
            out[key] = value
    return out


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": str(message)[:300]}) + "\n")
    sys.exit(0)


def main():
    args = sys.argv[1:]
    if not args:
        fail("no URL given")
    url = args[0]
    timeout_ms = 15000
    settle_ms = 1200
    for i, a in enumerate(args):
        if a == "--timeout-ms" and i + 1 < len(args):
            timeout_ms = max(3000, min(60000, int(args[i + 1])))
        if a == "--settle-ms" and i + 1 < len(args):
            settle_ms = max(0, min(10000, int(args[i + 1])))

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        fail("playwright is not installed: %s" % exc)

    site_key = auth_site_key(url)
    auth = auth_headers_from_env()
    navigations = []

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1366, "height": 900})

            # A Cookie goes in the COOKIE JAR, not in an intercepted header.
            # Chromium manages cookies itself and ignores a Cookie header set
            # through route interception — which made the first version of this
            # render the login page while reporting that credentials were sent.
            cookie_header = None
            other = {}
            for name, value in auth.items():
                if name.lower() == "cookie":
                    cookie_header = value
                else:
                    other[name] = value

            if cookie_header:
                jar = []
                for pair in cookie_header.split(";"):
                    if "=" not in pair:
                        continue
                    cname, _, cvalue = pair.partition("=")
                    cname, cvalue = cname.strip(), cvalue.strip()
                    if cname:
                        jar.append({"name": cname, "value": cvalue, "url": url})
                if jar:
                    ctx.add_cookies(jar)

            if other:
                def _route(route, request):
                    # Scoped: a page pulls in fonts, analytics and vendor
                    # scripts, and none of them get the client's credentials.
                    if auth_site_key(request.url) == site_key:
                        merged = dict(request.headers)
                        merged.update(other)
                        route.continue_(headers=merged)
                    else:
                        route.continue_()

                ctx.route("**/*", _route)

            page = ctx.new_page()
            # Every navigation the page performs, which is the whole point: a
            # client-side bounce to /signin shows up here and nowhere else.
            page.on("framenavigated",
                    lambda frame: navigations.append(frame.url)
                    if frame == page.main_frame else None)

            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(settle_ms)

            final_url = page.url
            title = page.title() or ""
            html = page.content() or ""
            has_password = bool(re.search(
                r"<input[^>]+type\s*=\s*[\"']?password", html, re.I))
            text = page.evaluate(
                "() => (document.body && document.body.innerText) || ''") or ""
            words = len([w for w in re.split(r"\s+", text) if w])

            # Links that lead further into the same site, counted the way the
            # access check counts them: a page offering routes onward is not a
            # dead end whatever it calls itself.
            hrefs = page.evaluate(
                "() => Array.from(document.querySelectorAll('a[href]'))"
                ".map(a => a.href)") or []
            seen = set()
            for href in hrefs:
                if auth_site_key(href) != site_key:
                    continue
                try:
                    path = urllib.parse.urlparse(href).path or "/"
                except Exception:
                    continue
                path = path.rstrip("/") or "/"
                if path != (urllib.parse.urlparse(final_url).path.rstrip("/") or "/"):
                    seen.add(path)

            browser.close()
    except Exception as exc:
        fail(exc)

    sys.stdout.write(json.dumps({
        "ok": True,
        "requestedUrl": url,
        "finalUrl": final_url,
        "title": title[:300],
        "hasPassword": has_password,
        "words": words,
        "internalLinks": len(seen),
        "navigations": navigations[:12],
    }) + "\n")


if __name__ == "__main__":
    main()
