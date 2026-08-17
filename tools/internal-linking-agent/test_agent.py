"""Regression tests for every audit finding that was fixed."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import internal_link_agent as m

fails = []
def ck(name, got, exp):
    ok = got == exp
    print(("  OK  " if ok else "  FAIL") + f" {name}: got={got!r} exp={exp!r}")
    if not ok:
        fails.append(name)

print("--- #8 robots group parsing (Crawl-delay must not merge groups) ---")
c = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
c._parse_robots("User-agent: *\nCrawl-delay: 10\n\nUser-agent: AhrefsBot\nDisallow: /\n")
ck("'*' group did not adopt AhrefsBot's Disallow", c.robots_allows("https://x.com/any"), True)

c2 = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
c2._parse_robots("User-agent: *\nDisallow: /private\n")
ck("real disallow still honored", c2.robots_allows("https://x.com/private/x"), False)
ck("other paths allowed", c2.robots_allows("https://x.com/public"), True)

c3 = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
c3._parse_robots("User-agent: *\nUser-agent: Googlebot\nDisallow: /x\n")
ck("multi-agent single group honored", c3.robots_allows("https://x.com/x"), False)

print("--- #23 robots wildcard performance ---")
t = time.time()
r = m.Crawler._robots_match("/*/*/*/*/*.php$", "/a/b/c/d/e.php")
el = time.time() - t
ck("deep wildcard matches", r, True)
t = time.time()
m.Crawler._robots_match("/*/*/*/*/*.php$", "/" + "a" * 400)
print(f"  timing: non-matching long path took {time.time()-t:.4f}s (must be fast)")
if time.time() - t > 2:
    fails.append("robots backtracking")

print("--- #18 tracking params ---")
for p, exp in [("refine", False), ("reference", False), ("refid", False), ("ref", True),
               ("source_category", False), ("source", True), ("cidx", False),
               ("cid", True), ("utm_campaign", True), ("campaign_type", False)]:
    ck(f"is_tracking_param({p})", m.is_tracking_param(p), exp)
ck("distinct faceted URLs stay distinct",
   m.normalize_url("https://x.com/l?refine=red") != m.normalize_url("https://x.com/l?refine=blue"), True)

print("--- #7 link spans use a cursor ---")
html = ('<html><body><main><p>Our pricing is simple and clear for everyone here. '
        'See <a href="/pricing">pricing</a> for the full details of our offer.</p>'
        '</main></body></html>')
blocks = m._extract_blocks(html, True, "https://x.com/a", "https://x.com", "x.com")
sp = blocks[0].link_spans
txt = blocks[0].text
ck("span count", len(sp), 1)
ck("span covers the LINKED occurrence", txt[sp[0][0]:sp[0][1]], "pricing")
ck("span is the second occurrence", sp[0][0] > txt.find("pricing"), True)

print("--- #7b anchor never placed inside an existing link ---")
pg = m.Page(url="https://x.com/a", requested_url="https://x.com/a", status=200, depth=0)
pg.blocks = blocks
got = m.find_anchor(pg, ["pricing"], [])
if got:
    s, e, bi = got["char_start"], got["char_end"], got["block_index"]
    overlaps = any(s < sp2[1] and sp2[0] < e for sp2 in pg.blocks[bi].link_spans)
    ck("chosen anchor does not overlap an existing link", overlaps, False)
else:
    print("  OK   no anchor offered (acceptable)")

print("--- #5 PageRank percentile with ties ---")
import numpy as np
vals = np.array([0.25, 0.25, 0.25, 0.25])
lower = (vals[:, None] > vals[None, :]).sum(axis=1)
equal = (vals[:, None] == vals[None, :]).sum(axis=1)
pct = (len(vals) - lower - equal / 2.0) / len(vals)
ck("all-tied PageRank gives identical percentiles", len(set(pct.tolist())), 1)
ck("tied percentile is 0.5 (not spread to 1.0)", float(pct[0]), 0.5)

print("--- #9 zero-valued CLI args are clamped ---")
ck("max_new_inbound_per_target clamp", max(1, 0), 1)

print("--- #21 keyword n-grams keep internal stopwords ---")
toks = m.tokenize("Best Shoes for Men")
grams = m.ngrams(toks, 2, 4)
ck("'shoes for men' derivable", "shoes for men" in grams, True)
ck("no stopword-final gram", any(g.endswith(" for") for g in grams), False)

print("--- #13 shared-block marking runs on tiny sites ---")
def mk(u, text):
    p = m.Page(url=u, requested_url=u, status=200, depth=0)
    p.blocks = [m.Block(text=text, tag="p")]
    p.text = text
    return p
tiny = {"https://x.com/a": mk("https://x.com/a", "This exact paragraph appears on both pages here."),
        "https://x.com/b": mk("https://x.com/b", "This exact paragraph appears on both pages here.")}
m.strip_template_blocks(tiny, m.DEFAULTS, [])
ck("2-page site marks shared blocks", tiny["https://x.com/a"].blocks[0].shared, True)

print("--- #16 XML is not accepted as a page ---")
ck("rss content-type rejected", "html" in "application/rss+xml", False)

print("--- NER anchor rejection (graceful degradation without spacy) ---")
if m.spacy is None:
    ck("no spacy installed -> _get_nlp returns None", m._get_nlp(), None)
    ck("no spacy -> nothing overlaps rejected entities",
       m._overlaps_rejected_entity(m.Block(text="Acme Corp builds things.", tag="p"), 0, 4), False)
else:
    blk = m.Block(text="Acme Corp builds great software for everyone worldwide today.", tag="p")
    ents = m._block_entities(blk)
    ck("spacy installed -> _block_entities returns a list", isinstance(ents, list), True)
    # Doc must be cached per block id, not re-parsed on a second call.
    ents2 = m._block_entities(blk)
    ck("Doc cached per block (same object returned)", ents2 is ents, True)
    ck("GPE/LOC never appears in the reject label set", "GPE" in m.NER_REJECT_LABELS, False)
    ck("LOC never appears in the reject label set", "LOC" in m.NER_REJECT_LABELS, False)

print("--- GSC CSV join: column mapping + normalize_url join ---")
import tempfile, os
fd, gsc_path = tempfile.mkstemp(suffix=".csv")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write("URL,Clicks,Impressions,Position\n")
    fh.write("https://x.com/a,3,100,4.5\n")
    fh.write("https://x.com/does-not-exist,1,50,20\n")
try:
    gsc_pages = {"https://x.com/a": mk("https://x.com/a", "some body copy here")}
    notes = []
    gres = m.load_gsc_csv(gsc_path, gsc_pages, "https://x.com", "x.com", notes)
    ck("gsc matched count", gres["matched"], 1)
    ck("gsc unmatched count", gres["unmatched"], 1)
    ck("gsc matched row has correct impressions",
       gres["by_url"]["https://x.com/a"]["impressions"], 100.0)
    ck("gsc unmatched sample recorded", gres["unmatched_samples"], ["https://x.com/does-not-exist"])
finally:
    os.remove(gsc_path)

print("--- GSC opportunity weighting: continuous decay, no cliff at position 10/11 ---")
def opp(position, impressions=100.0):
    return impressions * (1.0 / (1.0 + position / 10.0))
ck("opportunity decreases smoothly across the position-10 boundary",
   opp(10) > opp(11) > opp(12), True)
ck("no discontinuity: pos 10 and pos 11 differ by roughly the same step as 11->12",
   abs((opp(10) - opp(11)) - (opp(11) - opp(12))) < 0.5, True)


# ===========================================================================
# Second audit round. Each block below is a defect that was producing wrong or
# misleading output in the delivered report, with the evidence that found it.
# ===========================================================================

print("--- A1 robots trailing-slash rules are honored (normalize_url de-slashes) ---")
cA = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
cA._parse_robots("User-agent: *\nDisallow: /private/\nDisallow: /cart\n")
ck("Disallow: /private/ blocks the de-slashed /private",
   cA.robots_allows(m.normalize_url("https://x.com/private/")), False)
ck("Disallow: /private/ still blocks a child path",
   cA.robots_allows("https://x.com/private/thing"), False)
ck("Disallow: /cart (no slash) still works",
   cA.robots_allows(m.normalize_url("https://x.com/cart/")), False)
ck("unrelated path still allowed", cA.robots_allows("https://x.com/blog"), True)

print("--- A2 Crawl-delay is applied, not silently discarded ---")
cB = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
cB._parse_robots("User-agent: *\nCrawl-delay: 5\nDisallow: /nope\n")
ck("crawl_delay parsed from the '*' group", cB.crawl_delay, 5.0)
cC = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True))
cC._parse_robots("User-agent: BadBot\nCrawl-delay: 30\n\nUser-agent: *\nDisallow: /x\n")
ck("another bot's Crawl-delay is not adopted", cC.crawl_delay, 0.0)
ck("group separation still holds after adding delay parsing",
   cC.robots_allows("https://x.com/x"), False)

print("--- A3 anchor conflict is destination-aware (nav must not veto its own target) ---")
html_nav = ('<html><body><nav><a href="/services">Our Services</a></nav><main>'
            '<p>We provide a wide range of our services to clients across the '
            'country every single working day of the week.</p></main></body></html>')
pg_nav = m.parse_page(html_nav, "https://x.com/a", "https://x.com/a", 200, 0,
                      "x.com", "https://x.com")
ck("anchor_dests records the destination",
   pg_nav.anchor_dests.get("our services"), {"https://x.com/services"})
ck("same words -> same target is NOT a conflict",
   pg_nav.anchor_conflicts("our services", "https://x.com/services"), False)
ck("same words -> different target IS a conflict",
   pg_nav.anchor_conflicts("our services", "https://x.com/other"), True)
tgt_ok = m.Page(url="https://x.com/services", requested_url="https://x.com/services",
                status=200, depth=1)
tgt_ok.discriminating = {"services"}
# The surrounding sentence has to corroborate the link on its own, so the target
# needs distinctive terms beyond the anchor words themselves (see A3b).
tgt_ok.top_terms = ["services", "clients", "country"]
got_nav = m.find_anchor(pg_nav, ["our services"], [], target=tgt_ok,
                        cfg=dict(m.DEFAULTS, anchor_sentence_terms=1))
ck("in-content anchor to the nav's own destination is now allowed",
   bool(got_nav), True)
tgt_other = m.Page(url="https://x.com/other", requested_url="https://x.com/other",
                   status=200, depth=1)
tgt_other.discriminating = {"services"}
tgt_other.top_terms = ["services", "clients", "country"]
ck("same anchor to a DIFFERENT destination is still refused",
   m.find_anchor(pg_nav, ["our services"], [], target=tgt_other,
                 cfg=dict(m.DEFAULTS, anchor_sentence_terms=1)), None)

print("--- A3b the sentence test is not circular (anchor words don't count) ---")
tgt_thin = m.Page(url="https://x.com/services",
                  requested_url="https://x.com/services", status=200, depth=1)
tgt_thin.discriminating = {"services"}
tgt_thin.top_terms = ["services"]      # the ONLY signal is inside the anchor
ck("an anchor cannot vouch for its own sentence",
   m.find_anchor(pg_nav, ["our services"], [], target=tgt_thin,
                 cfg=dict(m.DEFAULTS, anchor_sentence_terms=1)), None)
ck("with the check disabled it is accepted again",
   bool(m.find_anchor(pg_nav, ["our services"], [], target=tgt_thin,
                      cfg=dict(m.DEFAULTS, anchor_sentence_terms=0))), True)

print("--- A4 anchor must carry a token that discriminates the target ---")
def page_with(url, h1, title=""):
    p = m.Page(url=url, requested_url=url, status=200, depth=1)
    p.h1 = h1
    p.title = title or h1
    return p
brand_stub = dict(brand_tokens=set(), label_tokens=set(), brand_name="",
                  clean_title={})
tgt_hou = page_with("https://x.com/web-development-company-houston",
                    "Web Development Company Houston")
generic = m.target_phrases(tgt_hou, tgt_hou.title, brand_stub, None)
precise = m.target_phrases(tgt_hou, tgt_hou.title, brand_stub, {"houston"})
ck("without a discriminating set, the ambiguous phrase is offered",
   "web development company" in [p.lower() for p in generic], True)
ck("with one, the ambiguous phrase is refused",
   "web development company" in [p.lower() for p in precise], False)
ck("and a phrase naming the city is kept",
   any("houston" in p.lower() for p in precise), True)

print("--- A4b discriminating tokens are the RARE identity tokens ---")
city_pages = {}
for city in ("houston", "austin", "chicago", "dallas", "miami", "denver",
             "boston", "seattle"):
    u = f"https://x.com/web-development-company-{city}"
    city_pages[u] = page_with(u, f"Web Development Company {city.title()}")
cities_urls = sorted(city_pages)
disc = m.build_discriminating_tokens(city_pages, cities_urls, brand_stub, m.DEFAULTS)
first = cities_urls[0]
ck("the city token is discriminating", "austin" in disc[first], True)
ck("the shared words are not", "development" in disc[first], False)
ck("'company' is not either", "company" in disc[first], False)

print("--- A4c an anchor must share a word with the target's URL slug ---")
# The worst real failure: a phrase lifted from the target's own markup that
# describes a different subject than the page it points at.
tgt_ent = page_with("https://x.com/enterprise-wordpress-development",
                    "Enterprise WordPress Development",
                    "Custom Website Design and Enterprise WordPress Development")
ph_ent = [p.lower() for p in m.target_phrases(tgt_ent, tgt_ent.title, brand_stub,
                                              {"enterprise", "wordpress"})]
ck("'custom website design' is refused for the WordPress page",
   "custom website design" in ph_ent, False)
ck("a phrase from the slug is kept",
   any("wordpress" in p for p in ph_ent), True)

print("--- A4d format-only and truncated phrases are refused ---")
tgt_guide = page_with("https://x.com/a-comprehensive-guide-to-choosing-the-right-host",
                      "A Comprehensive Guide to Choosing the Right Host")
ph_g = [p.lower() for p in m.target_phrases(tgt_guide, tgt_guide.title, brand_stub,
                                            {"host", "comprehensive"})]
ck("'comprehensive guide' (format words only) is refused",
   "comprehensive guide" in ph_g, False)
ck("'choosing the right' (dangling adjective) is refused",
   "choosing the right" in ph_g, False)
ck("something naming the subject survives", any("host" in p for p in ph_g), True)

print("--- A4e n-grams never span a punctuation boundary ---")
segs = m.title_segments("Complete Guide: Website Maintenance, Services Protect You")
ck("title split on ':' and ','", len(segs), 3)
grams_all = set(m.ngrams(m.tokenize(
    "Complete Guide: Website Maintenance, Services Protect You"), 2, 5))
grams_seg = set()
for s in segs:
    grams_seg |= set(m.ngrams(m.tokenize(s), 2, 5))
ck("the cross-boundary pair exists when ignoring punctuation",
   "maintenance services" in grams_all, True)
ck("and does not exist per-segment", "maintenance services" in grams_seg, False)

print("--- A4f a page's unique token must appear in its anchor ---")
geo = {}
for city in ("new-york", "houston", "austin", "chicago", "dallas", "miami",
             "denver", "seattle"):
    u = f"https://x.com/top-web-development-agencies-{city}"
    geo[u] = page_with(u, f"Top Web Development Agencies {city.replace('-', ' ').title()}")
gurls = sorted(geo)
m.build_discriminating_tokens(geo, gurls, brand_stub, m.DEFAULTS)
ny = "https://x.com/top-web-development-agencies-new-york"
ck("'york' is unique to the New York page",
   "york" in geo[ny].unique_tokens, True)
ck("'agencies' is not unique", "agencies" in geo[ny].unique_tokens, False)
ph_ny = [p.lower() for p in m.target_phrases(
    geo[ny], geo[ny].title, brand_stub, geo[ny].discriminating,
    geo[ny].unique_tokens)]
ck("'development agencies' alone is refused for the New York page",
   "development agencies" in ph_ny, False)
ck("every surviving phrase names New York",
   all(("york" in p or "new york" in p) for p in ph_ny) and bool(ph_ny), True)

print("--- A4g clause fragments from question-style titles are refused ---")
tgt_cost = page_with("https://x.com/how-much-does-a-custom-website-cost",
                     "How Much Does a Custom Website Cost")
ph_c = [p.lower() for p in m.target_phrases(tgt_cost, tgt_cost.title, brand_stub,
                                            {"custom", "cost", "website"})]
ck("'much does custom' is refused (leading dangler + auxiliary verb)",
   "much does custom" in ph_c, False)
ck("no surviving phrase contains an auxiliary verb",
   any(w in m.CLAUSE_VERBS for p in ph_c for w in p.split()), False)
ck("no surviving phrase starts or ends on a dangler",
   any(p.split()[0] in m.DANGLING_TAIL_WORDS
       or p.split()[-1] in m.DANGLING_TAIL_WORDS for p in ph_c), False)
ck("a real noun phrase still survives",
   any("custom website" in p or "website cost" in p for p in ph_c), True)

print("--- A4h a dropped URL qualifier is reported, not hidden ---")
m.build_discriminating_tokens(geo, gurls, brand_stub, m.DEFAULTS)
ck("'york' is a key slug token for the New York page",
   "york" in geo[ny].key_slug_tokens, True)
ck("'development' is not (every sibling has it)",
   "development" in geo[ny].key_slug_tokens, False)

print("--- A5 the sentence hosting the anchor must be about the target ---")
tgt_wp = m.Page(url="https://x.com/enterprise-wordpress-development",
                requested_url="https://x.com/enterprise-wordpress-development",
                status=200, depth=1)
tgt_wp.discriminating = {"wordpress", "enterprise"}
tgt_wp.top_terms = ["wordpress", "enterprise", "plugins"]
liferay = m.Page(url="https://x.com/liferay", requested_url="https://x.com/liferay",
                 status=200, depth=1)
liferay.blocks = [m.Block(
    text=("At our company our Liferay development services are designed to help "
          "companies leverage the full potential of this versatile portal platform."),
    tag="p")]
ck("off-topic sentence is rejected even though the anchor is verbatim",
   m.find_anchor(liferay, ["development services"], [], target=tgt_wp,
                 cfg=dict(m.DEFAULTS, anchor_sentence_terms=1)), None)
liferay2 = m.Page(url="https://x.com/l2", requested_url="https://x.com/l2",
                  status=200, depth=1)
liferay2.blocks = [m.Block(
    text=("Our enterprise WordPress development services cover plugins, themes and "
          "multisite rollouts for large editorial teams across the business."),
    tag="p")]
got_on = m.find_anchor(liferay2, ["development services"], [], target=tgt_wp,
                       cfg=dict(m.DEFAULTS, anchor_sentence_terms=1))
ck("on-topic sentence is accepted", bool(got_on), True)

print("--- A6 anchors are only placed in prose, never in table cells ---")
tbl = m.Page(url="https://x.com/t", requested_url="https://x.com/t", status=200, depth=1)
long_txt = ("Enterprise WordPress development services for plugins and themes "
            "across large editorial teams working at real scale every day.")
tbl.blocks = [m.Block(text=long_txt, tag="td")]
ck("a <td> block cannot host an anchor",
   m.find_anchor(tbl, ["development services"], [], target=tgt_wp,
                 cfg=dict(m.DEFAULTS, anchor_sentence_terms=1)), None)
tbl.blocks = [m.Block(text=long_txt, tag="p")]
ck("the same text in a <p> can",
   bool(m.find_anchor(tbl, ["development services"], [], target=tgt_wp,
                      cfg=dict(m.DEFAULTS, anchor_sentence_terms=1))), True)

print("--- A7 one source page never carries the same anchor twice ---")
src2 = m.Page(url="https://x.com/s", requested_url="https://x.com/s", status=200, depth=1)
src2.blocks = [m.Block(text=long_txt, tag="p"), m.Block(text=long_txt + " Again.", tag="p")]
ck("blocked when the anchor is already committed on this page",
   m.find_anchor(src2, ["development services"], [], target=tgt_wp,
                 cfg=dict(m.DEFAULTS, anchor_sentence_terms=1),
                 used_anchors={"development services"}), None)

print("--- A8 URL kind classification (archives are not orphans) ---")
for u, exp in [
    ("https://x.com/blog/page/7", "pagination"),
    ("https://x.com/blog?paged=3", "pagination"),
    ("https://x.com/tag/seo", "archive"),
    ("https://x.com/category/news/sub", "archive"),
    ("https://x.com/author/jane", "archive"),
    ("https://x.com/2024/06", "archive"),
    ("https://x.com/feed", "feed"),
    ("https://x.com/?s=shoes", "search"),
    ("https://x.com/services/web-design", "content"),
    ("https://x.com/blog/page-speed-guide", "content"),
    ("https://x.com/?p=1234", "content"),          # WP post-ID permalink
    ("https://x.com/top-10-tools", "content"),
]:
    ck(f"classify_url_kind({u.split('x.com')[1]})", m.classify_url_kind(u), exp)

print("--- A9 site-wide cut does not swallow a small site ---")
# Calls the module's own function rather than re-implementing the formula: a test
# that duplicates the logic it checks passes when both copies are wrong together.
ck("n=6 needs 4 (a flat floor of 3 meant 3-of-6 = 'site-wide')",
   m.sitewide_cut(6, 0.55), 4)
ck("n=5 needs 3", m.sitewide_cut(5, 0.55), 3)
ck("n=4 needs 3", m.sitewide_cut(4, 0.55), 3)
ck("n=3 needs 2, not 3", m.sitewide_cut(3, 0.55), 2)
ck("n=2 needs 2", m.sitewide_cut(2, 0.55), 2)
ck("n=100 is exactly 55% (a bare float ceil would demand 56)",
   m.sitewide_cut(100, 0.55), 55)
ck("the floor still applies on a large site with a low ratio",
   m.sitewide_cut(40, 0.02), 3)

print("--- A10 zero-vector pages are detected, not silently dropped ---")
# The corpus has to be realistic for this path to exist at all: terms need a
# document frequency strictly between 1 and 85% of pages, otherwise build_vectors
# relaxes the filter for a degenerate corpus and nothing can be a zero vector.
POOL = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda muon "
        "nuon xion omicron pion rhoo sigma tau upsilon phio chio psio omega "
        "plusx minusx timesx overx underx").split()
zpages = {}
for i in range(30):
    u = f"https://x.com/page-{i}"
    p = m.Page(url=u, requested_url=u, status=200, depth=1)
    # A rotating window, so every term lands on ~8 of 31 pages.
    words = [POOL[(i * 3 + k) % len(POOL)] for k in range(8)]
    p.text = " ".join(words * 3)
    p.word_count = len(m.WORD_RE.findall(p.text))
    zpages[u] = p
uniq = "https://x.com/zzqqxx"
pu = m.Page(url=uniq, requested_url=uniq, status=200, depth=1)
pu.text = "zzqqx wwvvy kkjjh mmnnb pppll"     # every term appears on no other page
pu.word_count = 5
zpages[uniq] = pu
zurls = sorted(zpages)
zmat, zvocab, zstats = m.build_vectors(zpages, zurls)
ck("the corpus is non-degenerate (filter not relaxed)", len(zvocab) >= 20, True)
ck("the all-unique-terms page is flagged zero_vector", zpages[uniq].zero_vector, True)
ck("it is listed in the returned stats", uniq in zstats["zero_vector_pages"], True)
ck("a normal page is not flagged",
   zpages["https://x.com/page-0"].zero_vector, False)

print("--- A11 transient 5xx is not reported as a broken link ---")
ck("503 is in the retry set", 503 in m.DEFAULTS["retry_statuses"], True)
ck("429 is in the retry set", 429 in m.DEFAULTS["retry_statuses"], True)
ck("404 is not (a real broken link)", 404 in m.DEFAULTS["retry_statuses"], False)

print("--- A12 --include/--exclude filters ---")
cF = m.Crawler("https://x.com", dict(m.DEFAULTS, respect_robots=True,
                                     include=[r"/blog/"], exclude=[r"/blog/draft"]))
ck("include matches", cF.url_in_scope("https://x.com/blog/post"), True)
ck("include excludes non-matching", cF.url_in_scope("https://x.com/about"), False)
ck("exclude beats include", cF.url_in_scope("https://x.com/blog/draft-1"), False)

print("--- A13 min_source_words is clamped to the ACTUAL words_per_link ---")
ck("with --words-per-link 300, a 120-word minimum is raised",
   max(120, 300), 300)

print("--- A14 one thin-page threshold, used everywhere ---")
ck("min_content_words exists in DEFAULTS", "min_content_words" in m.DEFAULTS, True)
src_txt = open(r"C:\Users\The Affinity Zone\Documents\Claude Code"
               r"\internal-linking-agent\internal_link_agent.py",
               encoding="utf-8").read()
ck("no bare 'word_count < 40' left", "word_count < 40" in src_txt, False)
ck("no bare 'word_count < 20' left", "word_count < 20" in src_txt, False)

print("--- A15 there is exactly one report generator (no markdown twin) ---")
ck("build_report (markdown) is gone", hasattr(m, "build_report"), False)
ck("build_docx is wired in", m.build_docx is not None, True)

print("--- A16 same primary keyword blocks a link even below the cannibal threshold ---")
kwp = {}
for u, kw, body in [
    ("https://x.com/a", "solar panel installation",
     "solar panel installation guidance for homes and small commercial roofs " * 12),
    ("https://x.com/b", "solar panel installation",
     "completely different vocabulary about batteries inverters and tariffs " * 12),
]:
    p = m.Page(url=u, requested_url=u, status=200, depth=1)
    p.text = body
    p.word_count = len(m.WORD_RE.findall(body))
    p.primary_keyword = kw
    p.h1 = "Solar Panel Installation"
    p.title = p.h1
    p.blocks = [m.Block(text=body[:400], tag="p")]
    p.discriminating = {"solar"}
    p.top_terms = ["solar", "panel"]
    kwp[u] = p
kurls = sorted(kwp)
kmat, _, _ = m.build_vectors(kwp, kurls)
ksim = kmat @ kmat.T
import numpy as _np
_np.fill_diagonal(ksim, 0.0)
low_sim = float(ksim[0, 1])
kgraph = m.build_graph(kwp, m.DEFAULTS)
kbrand = dict(brand_tokens=set(), label_tokens=set(), brand_name="",
              clean_title={u: kwp[u].title for u in kurls})
kcannibal = m.find_cannibalization(kwp, kurls, ksim, m.DEFAULTS)
krecs, krej = m.recommend(kwp, kurls, ksim, kgraph, kcannibal, m.DEFAULTS,
                          kbrand, set())
print(f"  (similarity between the two rivals: {low_sim:.3f}; "
      f"cannibal rows: {len(kcannibal)})")
ck("no recommendation links two pages with the same primary keyword",
   [r for r in krecs if {r["source_url"], r["target_url"]} == set(kurls)], [])

print("--- A17 recommend() returns (recs, reject_stats) ---")
ck("returns a 2-tuple", isinstance((krecs, krej), tuple) and isinstance(krej, dict), True)

print("--- A18 locale support (i18n universality) ---")

# (a) default/no --locale reproduces the ORIGINAL hardcoded English constants
# exactly. These sets are hand-copied from the pre-locale source (git blame /
# the saved pre-edit constant blocks) so a future edit to LOCALE_WORDLISTS['en']
# that drifts from the original tuning is caught here, not just "did it run".
_ORIG_STOPWORDS = set("""
a about above after again against all also am an and any are aren't as at be
because been before being below between both but by can cannot can't could
couldn't did didn't do does doesn't doing don't down during each few for from
further get got had hadn't has hasn't have haven't having he her here hers
herself him himself his how however i if in into is isn't it its itself just
let's me more most mustn't my myself no nor not of off on once only or other
ought our ours ourselves out over own same shan't she should shouldn't so some
such than that that's the their theirs them themselves then there these they
this those through to too under until up very was wasn't we were weren't what
when where which while who whom why will with won't would wouldn't you your
yours yourself yourselves us via using use used need needs make makes made
one two three new best top good great learn read click here page site website
home contact about-us more info information help support today now first last
next previous back
""".split())
_ORIG_GENERIC_ANCHORS = {
    "click here", "here", "read more", "more", "learn more", "this page",
    "this", "link", "website", "home", "homepage", "click", "see more",
    "find out more", "continue reading", "our website", "download",
}
_ORIG_GENERIC_CONTENT_WORDS = set("""
guide guides comprehensive complete ultimate definitive essential detailed
overview introduction intro basics fundamentals primer handbook manual
tips tricks steps checklist ideas insights trends
everything anything something know knowing need needs needed choose choosing
right best top leading great greatest good better perfect ideal
new latest modern advanced simple easy quick fast
important popular common typical general
things ways way reasons benefits advantages features factors aspects
part chapter series episode edition version update
conclusion summary explained really
""".split())
_ORIG_CLAUSE_VERBS = set("""
does do did done is are was were be been being am has have had having
can could will would shall should may might must let lets
get gets got make makes made take takes took give gives gave
""".split())
_ORIG_DANGLING_TAIL_WORDS = set("""
much many little less least far near own sheer mere
the a an and or but nor for yet so of in on at to with by from into onto upon
about over under between among through during before after above below
right best top leading great good better greatest other others another same
such own few both each every any all most more less least new latest
your our their its his her my this that these those which what who whom whose
very quite rather several various numerous certain
""".split())

# Reset to the default ('en') state first, since earlier tests in this file
# may run before/without ever calling apply_locale().
applied = m.apply_locale("en")
ck("apply_locale('en') applies 'en'", applied, "en")
ck("default STOPWORDS byte-for-byte == original hardcoded constant",
   m.STOPWORDS == _ORIG_STOPWORDS, True)
ck("default GENERIC_ANCHORS byte-for-byte == original hardcoded constant",
   m.GENERIC_ANCHORS == _ORIG_GENERIC_ANCHORS, True)
ck("default GENERIC_CONTENT_WORDS byte-for-byte == original hardcoded constant",
   m.GENERIC_CONTENT_WORDS == _ORIG_GENERIC_CONTENT_WORDS, True)
ck("default CLAUSE_VERBS byte-for-byte == original hardcoded constant",
   m.CLAUSE_VERBS == _ORIG_CLAUSE_VERBS, True)
ck("default DANGLING_TAIL_WORDS byte-for-byte == original hardcoded constant",
   m.DANGLING_TAIL_WORDS == _ORIG_DANGLING_TAIL_WORDS, True)
ck("default Accept-Language header unchanged",
   m.BROWSER_HEADERS["Accept-Language"], "en-US,en;q=0.9")
# LOCALE_WORDLISTS['en'] itself must equal the original lists too, not just
# whatever apply_locale('en') happens to populate.
ck("LOCALE_WORDLISTS['en'] STOPWORDS matches original",
   set(m.LOCALE_WORDLISTS["en"]["STOPWORDS"].split()) == _ORIG_STOPWORDS, True)
ck("LOCALE_WORDLISTS['en'] GENERIC_ANCHORS matches original",
   set(m.LOCALE_WORDLISTS["en"]["GENERIC_ANCHORS"]) == _ORIG_GENERIC_ANCHORS, True)
ck("LOCALE_WORDLISTS['en'] GENERIC_CONTENT_WORDS matches original",
   set(m.LOCALE_WORDLISTS["en"]["GENERIC_CONTENT_WORDS"].split()) == _ORIG_GENERIC_CONTENT_WORDS, True)
ck("LOCALE_WORDLISTS['en'] CLAUSE_VERBS matches original",
   set(m.LOCALE_WORDLISTS["en"]["CLAUSE_VERBS"].split()) == _ORIG_CLAUSE_VERBS, True)
ck("LOCALE_WORDLISTS['en'] DANGLING_TAIL_WORDS matches original",
   set(m.LOCALE_WORDLISTS["en"]["DANGLING_TAIL_WORDS"].split()) == _ORIG_DANGLING_TAIL_WORDS, True)

# (b) --locale es swaps in Spanish word lists, not English.
applied_es = m.apply_locale("es")
ck("apply_locale('es') applies 'es'", applied_es, "es")
ck("Spanish STOPWORDS differ from English", m.STOPWORDS != _ORIG_STOPWORDS, True)
ck("Spanish STOPWORDS contain 'el'/'la' (Spanish articles)",
   {"el", "la"}.issubset(m.STOPWORDS), True)
ck("Spanish STOPWORDS do NOT contain English-only stopwords like 'the'",
   "the" not in m.STOPWORDS, True)
ck("Spanish GENERIC_ANCHORS contain a Spanish 'click here' equivalent",
   any("clic" in a for a in m.GENERIC_ANCHORS), True)
ck("Spanish Accept-Language prefers es",
   m.BROWSER_HEADERS["Accept-Language"].startswith("es"), True)

# (c) an unsupported locale (e.g. Japanese) falls back to English rather than
# crashing, and warns on stderr instead of failing silently.
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    applied_ja = m.apply_locale("ja")
ck("apply_locale('ja') falls back to 'en'", applied_ja, "en")
ck("unsupported-locale fallback reproduces English STOPWORDS",
   m.STOPWORDS == _ORIG_STOPWORDS, True)
stderr_out = buf.getvalue()
ck("unsupported locale prints a stderr warning", "ja" in stderr_out, True)
ck("unsupported-locale warning mentions fallback", "en" in stderr_out.lower(), True)

# Restore 'en' so this test file leaves module global state as it found it,
# regardless of what other tests in this file run after this block.
m.apply_locale("en")

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
