# Internal Linking Agent

Give it a site URL. It discovers everything else and produces a verifiable
internal-linking audit.

```bash
python internal_link_agent.py https://example.com
```

No API keys. No paid data sources. Scoring is deterministic TF-IDF, so the same
site produces the same result every time.

---

## Quick start

```bash
# 1. Run the audit (start here; --max-pages 400 covers most sites)
python internal_link_agent.py https://example.com --max-pages 400

# 2. Confirm the tool's own logic still holds (offline, ~1 second)
python test_agent.py

# 3. Independently verify the report against the live site (re-fetches pages)
python verify_report.py reports/example.com-<timestamp>
```

Step 3 matters before you send a report to anyone. It re-downloads the source
pages and checks that every recommended anchor and its sentence really are
present, using BeautifulSoup directly rather than the agent's own extraction
code — so it cannot confirm the agent's own mistakes. Expect:

```
  OK   no anchor missing from its live source page  (0 missing)
  OK   no context sentence missing from its live source page  (0 missing)
  OK   no anchor already links to a different destination  (0 conflicts)
  OK   no source page uses the same anchor string twice  (observed 1)
  OK   every placed anchor shares a word with its target's URL slug
  OK   no recommendation links two pages with the same primary keyword
  ... 28 checks total
VERIFICATION PASSED: every check held.
```

It exits non-zero if any check fails, so it can gate a delivery.

---

## Input

**Required:** the site URL. That's it.

Everything else is discovered at runtime:

| Discovered | How |
|---|---|
| Page inventory | `robots.txt` → `Sitemap:` directives → sitemap index expansion → common sitemap paths → BFS link crawl as fallback and supplement |
| Canonical origin | Homepage's post-redirect scheme + host, so `http`/`https` and `www`/non-`www` collapse to one spelling |
| Page content | Main-content region isolated, template chrome stripped |
| Keywords | Derived from title, H1, URL slug — validated against body copy |
| Brand & section labels | Repeated title segments and repeated `<h1>` values |
| Existing links | Separated into editorial (in-content) vs site-wide (nav/footer) |

### Flags

| Flag | Default | When to change it |
|---|---|---|
| `--max-pages N` | 300 | Raise to cover the whole site. Orphan detection is definitive only when the crawl covers every analyzable URL. |
| `--concurrency N` | 8 | Lower to 3–4 for small or rate-limited hosts. |
| `--delay S` | 0.15 | Raise if the host returns 429s. |
| `--max-new-links-per-source N` | 3 | Link volume cap per page. |
| `--max-new-inbound-per-target N` | 5 | Link volume cap per target. |
| `--max-same-anchor N` | 2 | How often one exact anchor string may be reused site-wide. |
| `--boilerplate-ratio F` | 0.55 | Share of pages a destination must be linked from to count as site-wide nav. Raise (e.g. `0.95`) on sites with huge mega-menus. |
| `--min-source-words N` | 120 | Minimum body copy for a page to be a link source (floored at the effective `--words-per-link`). |
| `--words-per-link N` | 125 | Link-density ceiling: at most one new in-content link per N words. |
| `--max-editorial-out-per-page N` | 18 | Hard ceiling on editorial outbound links per page. |
| `--top-k-similar N` | 8 | Nearest topical neighbours considered per page. Only *eligible* neighbours consume the budget. |
| `--min-similarity F` | 0.045 | Absolute cosine floor below which a pair is never considered related. |
| `--min-content-words N` | 40 | The single "too thin to analyse" threshold, used everywhere. |
| `--anchor-max-owners N` | 1 | How many pages one candidate anchor phrase may describe before it is rejected as too generic. `1` means the phrase must identify exactly one page. |
| `--anchor-sentence-terms N` | 1 | Distinctive terms the hosting sentence must share with the target, *excluding the anchor's own words*. `0` disables the check (not recommended). |
| `--crawl-delay-cap S` | 2.0 | Upper bound on a `robots.txt` `Crawl-delay`, so a site asking for 30s cannot make the run take days. |
| `--include REGEX` | none | Only crawl URLs matching this regex. Repeatable. |
| `--exclude REGEX` | none | Never crawl URLs matching this regex. Repeatable; beats `--include`. |
| `--user-agent STR` | Chrome UA | Set a bot-identifying UA if the site owner prefers it. Note many WAFs block those. |
| `--verify-tls` | off | Enforce TLS certificate validation. |
| `--ignore-robots` | off | Only with the site owner's permission. |
| `--out DIR` | `reports/<host>-<timestamp>` | Custom output location. |
| `--render` | off | Re-fetch thin pages and HTTP-403 failures with a headless Chromium tab before analysis. See "Optional: JS rendering" below. |
| `--gsc-csv PATH` | off | Join a Search Console/GA4 export onto crawled pages and blend search opportunity into scoring. See "Optional: GSC/GA4 join" below. |

---

## Optional: JS rendering (`--render`)

The crawler reads server-rendered HTML only, by design (see "Known limits"
below) — but that means a page whose copy is injected by client-side
JavaScript looks thin or empty, and a page blocked by a WAF (HTTP 403) looks
unreachable. `--render` adds an opt-in second pass, after the crawl and before
any canonical/dedup analysis, that re-fetches exactly those pages — pages below
`--min-content-words` (the single thin-page threshold used everywhere), plus any
page that returned HTTP 403 — through a headless
Chromium tab (bounded to a few concurrent tabs; browser tabs are far heavier
than HTTP requests). A page is only replaced by its rendered version if the
rendered word count is meaningfully larger (>2x) than the static one; otherwise
it was genuinely thin, and the static version stands. Replaced pages are
tagged `extraction_mode: "rendered"` in `crawl_data.json`/`summary.json`, and
the report distinguishes "was JS-hidden, now has content" from "still thin
after rendering."

Install:

```bash
pip install playwright
python -m playwright install chromium
```

Without these, `--render` exits immediately with the exact commands above
rather than silently skipping the pass. Without the flag at all, nothing
changes — no extra dependency is required to run the tool normally.

## Optional: GSC/GA4 join (`--gsc-csv PATH`)

Pass a Search Console "Pages" (or "Queries aggregated by page") export — or an
equivalent GA4 export — with columns `url, clicks, impressions, position` (any
column order, case-insensitive headers). Rows are joined onto crawled pages
using the same URL normalization the rest of the tool uses, so http/https and
www/non-www variants still match. Unmatched rows are never silently dropped —
the report lists a sample of up to 10 so a host/domain mismatch is visible
immediately instead of a mystery.

Matched impressions and position feed an "opportunity" score
(`impressions * 1/(1 + position/10)`, a continuous decay with no cliff at
position 10/11), which is percentile-ranked the same way internal PageRank
already is (so one viral page can't dominate via min-max scaling) and blended
into the recommendation score as an additional weighted term. Orphan pages are
also re-sorted by impressions descending when this data is present, instead of
the default word-count sort — so the orphans already getting search traffic
surface first.

## Automatic: spaCy company/person/product anchor filtering

If `spacy` and its `en_core_web_sm` model are installed, candidate anchor text
that overlaps a detected `ORG`, `PERSON`, `PRODUCT`, or `WORK_OF_ART` entity is
rejected automatically — no flag required. (`GPE`/`LOC` — city and place names
— are deliberately allowed; they're legitimate anchors for location pages.)
The count of anchors rejected this way is logged and added to the crawl notes.
Without spaCy or the model installed, this step is skipped with a one-line log
notice; nothing crashes and nothing else changes. Install with:

```bash
pip install spacy
python -m spacy download en_core_web_sm
```

---

## Why the output is trustworthy

Built precision-first: a wrong number is worse than a missing one.

**"Editorial link" has exactly one definition.** A link is editorial when it
physically sits inside a content block that survived template removal — not when
its CSS class happens to look content-ish. Deriving it from class names was
measurably wrong: on an Elementor site, `elementor-nav-menu` slipped past the
chrome heuristics while carousel links whose anchor text appeared nowhere in the
page copy were counted as editorial. Because orphan status is computed from
editorial inbound links, that error went straight to the headline numbers
(one site reported 316 editorial links and 54 orphans; the correct figures were
52 and 171).

**Anchor text is never invented.** A `high`-tier anchor is a verbatim substring of
the source page's own body copy, quoted with its full sentence so you can find it.
When no suitable phrase exists, the recommendation is labelled
`needs-new-sentence` rather than dressed up as ready to use.

**Verbatim is not the same as relevant, and both are enforced.** An early build
found the words "development services" on a page about Liferay and recommended
linking them to an *Enterprise WordPress* page. The anchor was verbatim, the
character offsets were exact, and the recommendation was wrong. Four rules now
stand between a phrase and publication:

1. **Discrimination.** The phrase must contain a token that distinguishes the
   target from its siblings. On a site with one page per city,
   `web development company` describes thirty pages equally well — it is refused;
   `web development company houston` is not. The same build was emitting that
   phrase *twice from one source page*, once to the Houston page and once to
   Austin.
2. **Uniqueness.** The phrase must not be a candidate anchor for any other crawled
   page (`--anchor-max-owners`). A phrase that identifies two pages identifies
   neither.
3. **Slug agreement.** The phrase must share a word with the target's URL slug.
   The URL is the most stable statement a page makes about its subject, and this
   one rule caught `custom website design` being offered as the anchor for
   `/enterprise-wordpress-development`.
4. **Context.** The sentence hosting the anchor must share a distinctive term with
   the target — **excluding the anchor's own words**, since the anchor is already
   required to contain an identifying token and would otherwise vouch for itself.

Phrases made only of format or pitch words (`comprehensive guide`), fragments
bounded by a determiner (`choosing the right`), and clause fragments carrying an
auxiliary verb (`much does custom`, from "How Much Does a Custom Website Cost")
are refused outright. N-grams are generated per punctuation segment of a title, so
an anchor cannot straddle two unrelated clauses.

Every one of these filters reports how much it rejected, in the report and in
`summary.json`. A filter that reports nothing is indistinguishable from a filter
that is not running.

**A dropped URL qualifier is disclosed, not hidden.** When the chosen anchor is
unambiguous but still omits the qualifier its target's URL is built around, the
recommendation says so and is scored lower. It fires only when the anchor shares
*none* of the target's distinguishing slug tokens — a warning that fires on every
rare word in a long blog slug is noise that trains the reader to skip it.

**Anchor conflicts are destination-aware.** The rule is "one page must not carry
two identical anchors pointing at *different* URLs". Keying on the anchor string
alone meant a nav item reading "Our Services" and linking to `/services` made
"our services" unusable as an in-content anchor for `/services` — the single most
natural anchor on the page, rejected for pointing where it already pointed.

**Non-editorial pages are excluded, not reported as orphans.** Paginated archives,
tag and category listings, search-result pages and feeds have no in-content
inbound links by design and never will. Counting them inflated the orphan list
with rows nobody can act on, and their shared post excerpts made them score as
near-identical rivals of each other and of the articles they list. They are still
crawled, and links found on them still count; they get their own section.

**Competing pages are blocked independently of the cannibalization threshold.**
The promise "two pages targeting the same keyword are never recommended to link to
each other" used to be enforced *through* the cannibalization list — so a pair
with an identical derived keyword but a similarity below the reporting threshold
was neither flagged nor blocked, and was freely linked on that very keyword. The
ban is now stated on its own, and a contested keyword is never used as anchor text
anywhere.

**Link positions come from the DOM, not string search.** In "Our pricing is
simple. See <a>pricing</a> for details" a text search finds the wrong "pricing"
and would place a link inside the existing link. Offsets are built during a single
DOM walk, so they are exact by construction.

**Template text is detected by repetition, not guesswork.** Any paragraph whose
exact text repeats across pages is template furniture, whatever its class is
called. This matters twice: shared widget text otherwise makes unrelated pages
look near-identical (one run manufactured 92 false cannibalization pairs from a
"recent posts" widget), and injecting a link into shared copy would silently
create a site-wide link. Anchors are never placed in a paragraph that appears on
more than one page.

**Duplicate content is separated from cannibalization.** Pages ≥0.95 similar are
not competing for a keyword — they are the same page at different URLs, a more
serious problem with a different fix. They are grouped into clusters (6 URLs, not
15 pairs) and excluded from recommendations entirely, because their titles
describe the wrong content so any anchor derived from them would be wrong.

**Cannibalization requires corroborating evidence.** A shared keyword alone isn't
enough — sibling pages in one content cluster legitimately share a topic phrase.
A pair is flagged only when a multi-word keyword match is backed by body
similarity, both pages clear a content-length floor, and their titles overlap.

**Brand and section names are excluded from keywords and anchors.** Templates put
the site name in `<h1>` on every page, and titles often carry a series label
(`Page - Series - Brand`). Both are detected and set aside. The `<h1>` is *kept*
in the data files — it is reported, just not treated as the page's topic.

**Link volume is capped.** Max 3 new links per source, 5 new inbound per target,
one in-content link per 125 words, 18 editorial outbound per page, no reciprocal
pairs, no anchor string reused more than twice site-wide, never the same anchor
string twice on one source page, and no anchor that already links elsewhere from
that page. Total per-page link load is reported separately.

**Coverage is judged by set membership, not by comparing totals.** A crawl can
fetch more pages than the sitemap lists while still having missed some of its
URLs. The report distinguishes "budget ran out" (orphan status provisional) from
"those URLs error or redirect" (orphan status definitive). URLs discovered as link
targets but never fetched because the budget ran out are counted and disclosed,
rather than vanishing from both the page list and the failure list.

**A server having a bad day is not reported as a broken site.** 429 and 5xx
responses are retried with exponential backoff, honouring `Retry-After`. A URL that
still fails after every retry is classified "server unavailable during the crawl —
re-check before acting", never as a broken link. Without this, one transient 503
became a permanent broken-link finding *and* made every page it links to look like
an orphan.

**robots.txt is actually obeyed.** `Disallow: /private/` is matched against both
the slashed and de-slashed forms of a URL. Because URL normalisation strips
trailing slashes, matching only the normalised form silently ignored every rule
written with a trailing slash — the most common way to disallow a section — and the
crawler walked straight into it. `Crawl-delay` is honoured too (bounded by
`--crawl-delay-cap`) instead of being parsed and discarded.

**Pages that fall out of the similarity space are named.** A page whose every term
is either unique to it or present on nearly every page produces an all-zero TF-IDF
vector, scores 0 against everything, and can neither give nor receive a
recommendation. It used to disappear from the analysis with no trace, which reads
as "this page is fine".

**Small sites are not swallowed by the site-wide-chrome test.** The threshold for
"linked from enough pages to be navigation" had a flat floor of 3, which on a
5-page crawl meant "linked from 3 of 5 pages" counted as chrome — excluding most of
a small site as a link target and returning almost nothing. The floor now applies
only once the site is large enough for it to be the stricter condition.

**"Excessive links" is measured against the total, not just editorial links.** The
editorial-only count cannot see a several-hundred-link mega-menu, so a page could
pass the saturation test while carrying an enormous link load. Both are reported.

**Pages it could not read are flagged, not silently analyzed.** If a page yields
almost no body text, its similarity and keyword results are unreliable and the
report says so instead of publishing confident numbers derived from nothing.

**Nothing is estimated.** No invented traffic, difficulty, or authority figures.

---

## Recommendation tiers

| Tier | Meaning |
|---|---|
| `high` | Descriptive multi-word anchor already present verbatim on the source page, in a paragraph unique to that page, in a sentence that shares vocabulary with the target, and containing a token that identifies the target. Ready to implement. |
| `single-word` | Verbatim, but one word. A common word can appear in a sentence that isn't about the target — the sentence is shown so you can judge. |
| `needs-new-sentence` | Target is relevant but the source has no suitable phrase. Copy must be written. |

---

## Outputs

| File | Contents |
|---|---|
| `internal-linking-audit-<host>.docx` | **The deliverable.** Cover page, executive summary, prioritised work queue, every finding with evidence, and its own limitations section. |
| `recommendations.xlsx` | Every recommendation: source, target, anchor, dropped URL qualifiers, context sentence, block index, character offsets, score, reason |
| `orphans.xlsx` | Orphan and under-linked pages, with `noindex` flagged |
| `cannibalization.xlsx` | Competing pairs and duplicate pairs, with evidence and severity |
| `broken_links.xlsx` | Error-status URLs, their referring pages, and broken-vs-transient classification |
| `non_editorial_pages.xlsx` | Archive, pagination, search and feed pages excluded from the analysis |
| `crawl_data.json` | Per-page extracted data |
| `summary.json` | Machine-readable totals, coverage, config, precision-filter counts, notes |

There is deliberately **no `report.md`**. Two renderers over one set of numbers is
how a deliverable ends up disagreeing with itself; the Word document is the only
report generator, and it derives no metrics of its own.

---

## Known limits

- **JavaScript-rendered content is not seen.** The crawler reads server HTML. On a
  site whose copy only appears after client-side rendering, results will be thin —
  visible as low `word_count` in `crawl_data.json`, and called out in the report.
- **Similarity is lexical, not semantic.** TF-IDF matches shared vocabulary. Two
  pages about the same subject in entirely different words score low. The tradeoff
  buys determinism and zero API cost.
- **Named entities aren't recognised unless spaCy is installed.** Without it, an
  anchor can land inside a company name ("JSL Marketing & Web Design"). With
  `spacy` + `en_core_web_sm` installed, this class of anchor is rejected
  automatically (see "Automatic: spaCy company/person/product anchor filtering"
  above); skim anchors before bulk-applying either way.
- **English stopwords.** Other languages work (tokenization is Unicode-aware) but
  stopword filtering is weaker, so anchors deserve a closer look.
- **A single-word anchor may not fit its sentence.** That is exactly why they are a
  separate tier with the sentence shown.
- **Recall is traded for precision, deliberately.** The relevance filters move a
  large share of candidates out of "ready to implement" and into "needs new copy".
  That reclassification is the point: a pair that cannot be linked honestly with
  existing words is reported as needing a sentence, not dressed up as ready. The
  Word report states how many candidates each filter rejected, so the tradeoff is
  visible rather than implied.
- **Page-kind classification is by URL pattern.** A site using unconventional URLs
  for its archives (no `/tag/`, `/page/2`, `?paged=`) will have them treated as
  content pages. Use `--exclude` to handle those explicitly.

## Requirements

Python 3.11+, `httpx`, `beautifulsoup4`, `lxml`, `numpy`, `python-docx` (see
`requirements.txt`). `python-docx` is required, not optional — the Word document is
the deliverable, and a missing dependency fails immediately with the install
command rather than after a long crawl.
`playwright` (`--render`) and `spacy` (automatic NER anchor filtering) are
optional extras, also listed in `requirements.txt`; the tool runs its default,
deterministic pipeline without either installed.
