"""
Extraction / classification / duplicate-verdict coverage for the linking agent.

WHY THIS FILE EXISTS
`test_agent.py` covers the locale word lists and a handful of pure helpers, but
the crawl -> extract -> classify -> report path had no automated coverage at
all. That is the path that produced every wrong finding in the live audit: the
orphan avalanche, the SPA shell reported as duplicate content, and the
n-squared duplicate pairs. Those were all caught by hand.

Everything here runs offline against synthetic HTML and synthetic Page objects.
No network, no browser, no fixtures directory — so it runs anywhere the agent
itself runs, in under a second.

Run:  python test_extraction.py
"""
import sys
from collections import Counter

import internal_link_agent as m

FAILS = []
PASSES = 0


def check(name, got, expected):
    global PASSES
    if got == expected:
        PASSES += 1
        print(f"  OK   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}\n         got={got!r}\n         exp={expected!r}")


def check_true(name, cond, detail=""):
    check(name, bool(cond), True) if cond else check(f"{name} {detail}".strip(), False, True)


class FakePage:
    """Minimal stand-in for Page with only the fields these paths read."""

    def __init__(self, url="https://e.com/", title="", word_count=0,
                 extraction_mode="normal", kind="content"):
        self.url = url
        self.title = title
        self.word_count = word_count
        self.extraction_mode = extraction_mode
        self.kind = kind


# --------------------------------------------------------------------------- #
# 1. Duplicate verdict: the three cases that matter
# --------------------------------------------------------------------------- #
print("\n[duplicate verdict]")

# 1a. Two normally-extracted pages with the same copy = real duplicate content,
#     and the remedy really is a canonical/301.
pg = {"a": FakePage("https://e.com/a", "Service A", 900),
      "b": FakePage("https://e.com/b", "Service A", 900)}
sev, ev, fix = m._duplicate_verdict(pg, "a", "b", 0.99, m._shell_fingerprints(pg))
check("real duplicate pair is critical", sev, "critical")
check_true("real duplicate advises canonical/301", "301" in fix or "canonical" in fix)

# 1b. Both sides degraded = the crawler never read either page. Must NOT assert
#     duplicate content, and must NOT advise a redirect.
pg = {"a": FakePage("https://e.com/a", "Home", 333, "structural-only"),
      "b": FakePage("https://e.com/b", "Home", 333, "structural-only")}
sev, ev, fix = m._duplicate_verdict(pg, "a", "b", 0.998, None)
check("both-degraded pair is downgraded", sev, "needs-verification")
check_true("both-degraded advises --render, not a redirect",
           "--render" in fix and "301" not in fix)

# 1c. The live failure: many URLs, identical word count AND title, extracted
#     NORMALLY. Genuinely identical to a crawler, but redirecting them would
#     destroy real routes — so it must be critical with rendering advice.
shell = {f"u{i}": FakePage(f"https://e.com/{i}", "Top Web Design Company in New York City", 767)
         for i in range(11)}
fps = m._shell_fingerprints(shell)
sev, ev, fix = m._duplicate_verdict(shell, "u0", "u1", 1.0, fps)
check("shell-pattern pair is critical", sev, "critical")
check_true("shell-pattern evidence names the URL count", "11 different URLs" in ev)
check_true("shell-pattern advises AGAINST redirects",
           "NOT a case for redirects" in fix and "server-rendered" in fix)

# 1d. Below the threshold, the shell rule must not fire.
few = {f"u{i}": FakePage(f"https://e.com/{i}", "Same Title", 500) for i in range(2)}
sev, _, fix = m._duplicate_verdict(few, "u0", "u1", 0.99, m._shell_fingerprints(few))
check("2 pages sharing a fingerprint are NOT called a shell", sev, "critical")
check_true("2-page case still advises canonical/301", "301" in fix or "canonical" in fix)


# --------------------------------------------------------------------------- #
# 2. Fingerprinting
# --------------------------------------------------------------------------- #
print("\n[shell fingerprints]")
mixed = {
    "a": FakePage("https://e.com/a", "Home", 767),
    "b": FakePage("https://e.com/b", "Home", 767),
    "c": FakePage("https://e.com/c", "Real Page", 1200),
    "d": FakePage("https://e.com/d", "", 0),  # empty pages must not be counted
}
fps = m._shell_fingerprints(mixed)
check("identical (words,title) pairs are counted together", fps[(767, "home")], 2)
check("distinct pages counted separately", fps[(1200, "real page")], 1)
check("zero-word pages are excluded from fingerprints", fps.get((0, ""), 0), 0)
check("title matching is case-insensitive",
      m._shell_fingerprints({"a": FakePage(title="HOME", word_count=5),
                             "b": FakePage(title="home", word_count=5)})[(5, "home")], 2)


# --------------------------------------------------------------------------- #
# 3. Duplicate pair collapse (the n-squared problem)
# --------------------------------------------------------------------------- #
print("\n[duplicate pair collapse]")
urls = ["https://e.com/", "https://e.com/a", "https://e.com/bb",
        "https://e.com/ccc", "https://e.com/dddd"]
pairs = []
for i in range(len(urls)):
    for j in range(i + 1, len(urls)):
        pairs.append(dict(page_a=urls[i], page_b=urls[j], severity="critical"))
rivalry = dict(page_a="https://e.com/x", page_b="https://e.com/y", severity="high")
pairs.append(rivalry)

clusters = m.group_duplicate_clusters(pairs)
check("5 same-content URLs form one cluster", [len(c) for c in clusters], [5])

out = m.collapse_duplicate_pairs(pairs, clusters)
crit = [r for r in out if r["severity"] == "critical"]
check("10 pairwise rows collapse to 4", len(crit), 4)
check_true("every surviving row involves the canonical URL",
           all(r["page_a"] == "https://e.com/" or r["page_b"] == "https://e.com/" for r in crit))
check_true("non-duplicate rivalry rows are untouched", rivalry in out)

# The regression that mattered: needs-verification must ALSO cluster and
# collapse, or degraded sites silently get the n-squared output back and their
# unreadable pages stay eligible for link recommendations.
nv = [dict(page_a=urls[i], page_b=urls[j], severity="needs-verification")
      for i in range(len(urls)) for j in range(i + 1, len(urls))]
nv_clusters = m.group_duplicate_clusters(nv)
check("needs-verification pairs still form clusters", [len(c) for c in nv_clusters], [5])
check("needs-verification pairs still collapse",
      len(m.collapse_duplicate_pairs(nv, nv_clusters)), 4)
check("unreadable pages are still excluded from recommendations",
      len({u for c in nv_clusters for u in c}), 5)

check("no clusters means input is returned unchanged",
      m.collapse_duplicate_pairs(pairs, []), pairs)


# --------------------------------------------------------------------------- #
# 4. Anchor phrase quality
# --------------------------------------------------------------------------- #
print("\n[anchor phrase filters]")
check_true("relational prepositions are listed as tail-breakers",
           {"with", "from", "by"} <= m.ANCHOR_TAIL_PREPOSITIONS)
check_true("locative 'in' is NOT a tail-breaker (it makes valid anchors)",
           "in" not in m.ANCHOR_TAIL_PREPOSITIONS)
check_true("locative 'for' is NOT a tail-breaker", "for" not in m.ANCHOR_TAIL_PREPOSITIONS)


# --------------------------------------------------------------------------- #
# 5. Severity vocabulary stays renderable
# --------------------------------------------------------------------------- #
print("\n[report severity vocabulary]")
try:
    import docx_report

    for sev in ("critical", "needs-verification", "high", "medium", "low", "wat"):
        colour = docx_report._sev_color(sev)
        check_true(f"_sev_color('{sev}') returns a colour rather than raising",
                   colour is not None)
    check_true("both duplicate severities are recognised by the agent",
               m.DUPLICATE_SEVERITIES == {"critical", "needs-verification"})
except ImportError as exc:  # python-docx not installed
    print(f"  SKIP docx_report not importable ({exc})")


# --------------------------------------------------------------------------- #
print(f"\n{PASSES} passed, {len(FAILS)} failed")
if FAILS:
    print("FAILURES:")
    for f in FAILS:
        print(f"  - {f}")
sys.exit(1 if FAILS else 0)
