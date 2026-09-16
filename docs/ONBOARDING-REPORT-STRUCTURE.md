# Client Onboarding Report — Structure

Mirrors the agency's existing SEO Audit & Keywords deliverable, built from data the
suite can collect **today, from nothing but a URL**. No client GA4 or Search Console
access required.

Source key:
- `crawl` — technical audit crawler
- `readiness` — lib/aiseo/siteReadiness
- `psi` — PageSpeed Insights (agency Google OAuth)
- `schema` — lib/aiseo/schemaAuto
- `planner` — Google Ads Keyword Planner (live, v25)
- `serpLite` — independent index sample (NOT Google), labelled as such
- `linking` — internal-link crawler (full reports only)
- `derived` — computed in build.js from the above

---

## 1. Cover

| Item | Source |
|---|---|
| Client URL, company name, date generated | `crawl` (title/og:site_name, domain fallback) |
| Report title, agency branding/logo | `branding.js` |

## 2. Contents

Static. Lists only the sections that actually rendered — a section whose collector
failed is omitted, not printed empty.

## 3. Executive Summary  *(new — not in the current deliverable)*

| Item | Source |
|---|---|
| Overall score + grade | `derived` |
| Pillar scores: Foundations / Content / Speed / Trust | `derived` |
| 3–5 sentence summary, each sentence about a measured number | `derived` |
| Positioning paragraph for the salesperson to read aloud | `derived` |

## 4. What This Report Can and Cannot Measure  *(new)*

States plainly that without Search Console access, actual traffic, impressions, CTR
and current Google rankings are not knowable from outside, and that nothing here
estimates them. Everything below is measured.

## 5. Website Indexing and Crawlability

| Check | Source | Notes |
|---|---|---|
| GA4 present | `crawl` | tag detection only |
| Search Console verification present | `crawl` | meta/DNS signal where visible |
| Indexed pages | `crawl` | count crawled + indexable; not a Google index count |
| XML sitemap | `crawl` | found, reachable, URL count, staleness |
| SSL / HTTPS + expiry | `crawl` | |
| robots.txt | `crawl` | fetched and parsed, disallow rules listed |
| noindex / X-Robots-Tag | `crawl` | flags only priority pages |
| 404 page | `crawl` | correct status code + branded page check |

## 6. Website Structure

| Check | Source |
|---|---|
| URL slug quality | `crawl` |
| Click depth distribution | `crawl` |
| Broken links (internal + external) | `crawl` |
| Orphan pages | `linking` |
| Keyword cannibalisation | `linking` |
| Redirects: 301 / 302 / chains | `crawl` |
| Canonical URLs, www/non-www | `crawl` |
| HTTP/HTTPS duplicates, mixed content | `crawl` |

## 7. Page Speed

| Item | Source |
|---|---|
| Mobile performance score + FCP, LCP, TBT, CLS, Speed Index | `psi` |
| Desktop equivalent | `psi` (full reports only) |
| Core Web Vitals field data (real Chrome users, CrUX) | `psi` |
| Top opportunities with estimated savings | `psi` |

Field data is the differentiator: it is Google's own measurement of real visitors,
available for any URL, and the current deliverable does not include it.

## 8. Mobile Friendliness & Usability

| Check | Source |
|---|---|
| Mobile performance | `psi` |
| Viewport, tap targets, font sizes | `crawl` |
| Intrusive interstitials | `crawl` |
| Layout shift (CLS) | `psi` |
| iOS / Android screenshots | **GAP — needs Playwright capture** |

## 9. On-Page SEO

| Check | Source |
|---|---|
| Meta titles: missing, duplicate, length | `crawl` |
| Meta descriptions: missing, duplicate, length | `crawl` |
| H1 / H2 structure | `crawl` |
| Internal anchor text quality | `linking` |
| Image alt attributes | `crawl` |
| OpenGraph / Twitter cards | `crawl` |
| Structured data (JSON-LD) present + valid | `schema` |
| Pagination | `crawl` |

## 10. Content & AI Readiness  *(new)*

| Item | Source |
|---|---|
| Passage-level citability, answer-shaped content | `readiness` |
| Thin content detection | `readiness` |
| AI crawler accessibility | `readiness` |

## 11. Keyword Research

| Item | Source |
|---|---|
| Seed keywords derived from the domain | `planner` (siteSeed) |
| Monthly search volume | `planner` — Google's own figures |
| Competition / difficulty band | `planner` |
| Visibility sample for priority terms | `serpLite` — labelled "independent index, not Google" |

Matches the existing 80-keyword tables. Same source the agency already uses
(Keyword Planner), generated automatically instead of compiled by hand.

## 12. Backlink Profile

**GAP — not currently collected.**

`lib/aiseo/competitive.js` already implements referring-domain gap analysis with a
verification crawler, but needs a vendor credential. Required for parity with the
current deliverable's Semrush pages: referring domains, total backlinks,
follow/nofollow split, anchor distribution, link types, spam score.

## 13. Priority Action Plan  *(new — not in the current deliverable)*

| Item | Source |
|---|---|
| Every finding as a client-facing card: what, why it matters, how to fix | `issues.js` |
| Impact (1–5) and effort (quick / moderate / project) per item | `issues.js` |
| Grouped into first 30 days / days 30–60 / days 60–90 | `derived` |

This is the section that turns an audit into a proposal. The current deliverable
lists problems; this one sequences the work.

## 14. Content Strategy

Template section: pillar pages, blog topics, FAQ/voice targets, local SEO actions.
Seeded from the `planner` keyword clusters rather than written per client.

## 15. Glossary

Static definitions block. Reused verbatim from the current deliverable.

## 16. Closing

Generated from the report's own numbers — client URL pulled from the run, so a
previous client's details cannot survive into a new report.

---

## Gaps to close for full parity

1. **Backlink section** — needs a data vendor credential (DataForSEO covers every
   panel in the current deliverable's Semrush pages for roughly $0.09 per report;
   $50 minimum top-up).
2. **Mobile screenshots** — Playwright capture, no external cost.

Everything else in this structure is collectable today.
