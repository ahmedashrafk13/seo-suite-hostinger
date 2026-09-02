// Generates the platform overview document for the SEO team.
//
//   node make_platform_report.js
//   -> reports/SEO-Platform-Overview.docx
//
// This is a WRITTEN DELIVERABLE, not a data export: it explains what every
// feature in the suite does, how it arrives at its numbers, and what an SEO
// gets out of it. It is regenerated from this file rather than hand-edited in
// Word, so a change to the platform can be reflected by changing the text here
// and re-running — a .docx that has been edited by hand diverges from the build
// within a fortnight and nobody can tell which version is true.
//
// Styling follows the convention already established by the internal-linking
// agent's report (tools/node/linking/report.js): navy headings, grey subtext,
// bordered tables with a filled header row.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, AlignmentType, PageBreak, TableLayoutType,
} = require('docx');

// TABLE WIDTHS MUST BE ABSOLUTE, NOT PERCENTAGES.
//
// Word treats a table without an explicit grid as auto-fit and recomputes the
// column widths itself, so percentage widths look correct there. Google Docs
// does not: it honours `<w:tblGrid>` literally, and the docx library defaults
// every gridCol to 100 twips (0.07 inch) when it is given percentages and no
// explicit column widths. The result is a table collapsed to a sliver with one
// character per line — which is exactly how this document first rendered in
// Google Docs while looking perfect in Word.
//
// So every table below declares real twip widths, computed from the page. A
// US Letter page is 12,240 twips wide; the section margins take 1,100 from
// each side, leaving this much for content.
const PAGE_MARGIN = 1100;
const CONTENT_WIDTH = 12240 - (PAGE_MARGIN * 2); // 10,040 twips

// Percentage-of-content-width -> twips, with the remainder given to the last
// column so the row always sums to exactly CONTENT_WIDTH. A table whose columns
// sum to slightly less than the grid renders with a ragged right edge.
function dxaWidths(pcts) {
  const raw = pcts.map((x) => Math.round((x / 100) * CONTENT_WIDTH));
  const drift = CONTENT_WIDTH - raw.reduce((a, b) => a + b, 0);
  raw[raw.length - 1] += drift;
  return raw;
}

const NAVY = '1F3A5F';
const GREY = '5A6472';
const GREEN = '1C7F4D';
const AMBER = 'A06A00';
const RED = 'B23B2E';

// --------------------------------------------------------------- primitives

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    spacing: { before: 240, after: 160 },
    children: [new TextRun({ text, bold: true, size: 32, color: NAVY })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, size: 26, color: NAVY })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 90 },
    children: [new TextRun({ text, bold: true, size: 22, color: NAVY })],
  });
}

function h4(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_4,
    spacing: { before: 160, after: 70 },
    children: [new TextRun({ text, bold: true, size: 20, color: GREY })],
  });
}

// Body text with inline emphasis.
//
// Written as a lightweight markup rather than as TextRun arrays at every call
// site: **bold**, *italic* and `code`. Assembling runs by hand for two hundred
// paragraphs is where a document like this stops being maintainable.
function rich(text, { size = 20, color, italics = false } = {}) {
  const runs = [];
  const rx = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = rx.exec(text))) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index), size, color, italics }));
    }
    const tok = m[0];
    if (tok.startsWith('**')) {
      runs.push(new TextRun({ text: tok.slice(2, -2), size, color, bold: true, italics }));
    } else if (tok.startsWith('`')) {
      runs.push(new TextRun({ text: tok.slice(1, -1), size: size - 1, color: color || GREY, font: 'Consolas' }));
    } else {
      runs.push(new TextRun({ text: tok.slice(1, -1), size, color, italics: true }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), size, color, italics }));
  return runs;
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after === undefined ? 130 : opts.after },
    alignment: opts.align,
    children: rich(text, opts),
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { after: 70 },
    children: rich(text, { size: 20 }),
  });
}

function numbered(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'steps', level },
    spacing: { after: 70 },
    children: rich(text, { size: 20 }),
  });
}

// A callout: a shaded, bordered single-cell table. Used for the operating rule
// and for the "why this is trustworthy" notes, which need to stop the eye.
function callout(title, text, fill = 'F2F5F9', accent = NAVY) {
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'D6DBE3' };
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    layout: TableLayoutType.FIXED,
    borders: {
      top: border, bottom: border, left: { style: BorderStyle.SINGLE, size: 18, color: accent }, right: border, insideHorizontal: border, insideVertical: border,
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
        margins: { top: 130, bottom: 130, left: 160, right: 160 },
        children: [
          new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: title, bold: true, size: 20, color: accent })] }),
          new Paragraph({ spacing: { after: 0 }, children: rich(text, { size: 19 }) }),
        ],
      })],
    })],
    margins: { top: 120, bottom: 120 },
  });
}

function cell(text, { header = false, bold = false, width, fill } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: header
      ? { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' }
      : (fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined),
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: String(text == null ? '' : text).split('\n').map((line, i, arr) => new Paragraph({
      spacing: { after: i === arr.length - 1 ? 0 : 50 },
      children: rich(line, { size: 18, color: header ? 'FFFFFF' : undefined })
        .map((r) => (header ? new TextRun({ ...r, bold: true }) : r)),
    })),
  });
}

// docx TextRun instances cannot be spread, so header runs are rebuilt.
function headerCell(text, width) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' },
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [new TextRun({ text: String(text), bold: true, size: 18, color: 'FFFFFF' })],
    })],
  });
}

// `widths` is a list of percentages of the content width. They are converted to
// absolute twips here and declared BOTH on the table grid and on every cell,
// which is what Google Docs needs in order to lay the table out at all.
//
// `noHeader` renders the first argument as an ordinary first row instead of a
// filled header — used by the cover metadata table, which has no column
// headings and would otherwise show an empty navy bar.
function table(headers, rows, widthPcts, { noHeader = false } = {}) {
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'D6DBE3' };
  const cols = widthPcts && widthPcts.length
    ? dxaWidths(widthPcts)
    : dxaWidths(new Array(headers.length).fill(100 / headers.length));

  const bodyRows = rows.map((r, ri) => new TableRow({
    children: r.map((v, i) => cell(v, {
      width: cols[i],
      fill: ri % 2 ? 'F7F9FB' : undefined,
      bold: noHeader && i === 0,
    })),
  }));

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: cols,
    layout: TableLayoutType.FIXED,
    borders: {
      top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border,
    },
    rows: noHeader ? bodyRows : [
      new TableRow({
        tableHeader: true,
        children: headers.map((hd, i) => headerCell(hd, cols[i])),
      }),
      ...bodyRows,
    ],
  });
}

function spacer(after = 160) {
  return new Paragraph({ spacing: { after }, children: [] });
}

// --------------------------------------------------------- feature template
//
// Every feature is described the same way, deliberately. An SEO reading this
// wants the same four things about each one and should not have to hunt for
// them in a different order per section.
function feature({ name, where, oneLiner, how, output, value, trust, note }) {
  const out = [];
  out.push(h3(name));
  if (where) {
    out.push(new Paragraph({
      spacing: { after: 110 },
      children: [new TextRun({ text: where, size: 18, color: GREY, font: 'Consolas' })],
    }));
  }
  out.push(p(oneLiner, { size: 21 }));

  out.push(h4('How it works'));
  how.forEach((x) => out.push(bullet(x)));

  out.push(h4('What you get'));
  output.forEach((x) => out.push(bullet(x)));

  out.push(h4('Why it is worth the time'));
  out.push(p(value));

  if (trust) out.push(callout('Why you can trust the number', trust, 'F2F7F3', GREEN));
  if (note) out.push(callout('Worth knowing', note, 'FBF7EF', AMBER));
  out.push(spacer(120));
  return out;
}

// =========================================================================
// CONTENT
// =========================================================================

const children = [];

// ------------------------------------------------------------------- cover
children.push(new Paragraph({
  spacing: { before: 1800, after: 100 },
  children: [new TextRun({ text: 'SEO Automation Suite', bold: true, size: 56, color: NAVY })],
}));
children.push(new Paragraph({
  spacing: { after: 80 },
  children: [new TextRun({ text: 'Platform overview for the SEO team', size: 30, color: GREY })],
}));
children.push(new Paragraph({
  spacing: { after: 500 },
  children: [new TextRun({
    text: 'What every feature does, how it reaches its numbers, and what you get out of it',
    size: 22, color: GREY, italics: true,
  })],
}));

children.push(table(
  ['Field', 'Value'],
  [
    ['Document', 'Platform overview and capability reference'],
    ['Audience', 'SEO team, account leads, and anyone reviewing the tooling'],
    ['Covers', 'The whole platform: data foundations, classic SEO tooling, the AI SEO suite, alerting, task governance and reporting'],
    ['Generated', new Date().toISOString().slice(0, 10)],
    ['Source', 'Generated from make_platform_report.js in the application repository'],
  ],
  [22, 78],
  { noHeader: true },
));

children.push(spacer(300));
children.push(callout(
  'The one rule everything else follows',
  'The platform **never invents a number.** Where a figure can be measured it is measured, and the source is printed beside it. '
  + 'Where it cannot be measured, the platform says so on the page instead of filling the gap with an estimate. '
  + 'This is enforced in code, not in a style guide: a check that cannot measure returns *unknown*, and unknown values are excluded from '
  + 'scores on **both** sides of the ratio — because collapsing "measured and fine" into "could not measure" is exactly how a monitoring '
  + 'system reports green through an outage.',
));

// ---------------------------------------------------------------- contents
children.push(h1('Contents'));
children.push(p('This document is organised so it can be read straight through or used as a reference. Each feature is described the same way — how it works, what you get, why it is worth the time — so nothing has to be hunted for in a different order per section.'));

children.push(table(
  ['Part', 'What it covers'],
  [
    ['1. What this platform is', 'The problem it solves, the operating rule, and the shape of the whole system in one diagram'],
    ['2. The data foundation', 'Brands, the Google connection, nightly consolidation, and the comparison maths every feature shares'],
    ['3. Classic SEO capabilities', 'Dashboard, technical audit, internal linking, keyword clustering, opportunities, briefs, page speed'],
    ['4. The AI SEO suite', 'Twelve analyses plus a 21-check tracking board, aimed at whether an AI answer engine can find, read and cite the site'],
    ['5. Alerting and governance', '46 alert types, the task backlog, and the approval gate on anything that can move rankings'],
    ['6. Reporting and team', 'Weekly client reports, exports, roles, assignment and the workflow map'],
    ['7. Where every number comes from', 'The full source inventory: measured, sampled, and genuinely unavailable'],
    ['8. Operating the platform', 'Schedules, background runs, spend caps and what needs a human'],
    ['9. Limits, and what a credential unlocks', 'Honest constraints and the exact upgrade path for each'],
    ['10. Recent improvements', 'What the latest release added, and the three figures that will have moved as a result'],
    ['Appendices', 'The 21 tracking checks, the 46 alert types, and how the platform is verified'],
  ],
  [30, 70],
));

// =========================================================================
children.push(h1('1. What this platform is'));

children.push(p(
  'A centralised SEO platform that consolidates Google Search Console and GA4 per client brand, runs a technical audit and an '
  + 'internal-linking audit, clusters keywords, detects content opportunities, monitors for regressions, and turns all of it into '
  + 'one managed task backlog with an approval gate on anything that could damage rankings if done carelessly.',
));
children.push(p(
  'On top of that sits the **AI SEO suite**: twelve analyses and a twenty-one-check monitoring board aimed at a question classic SEO tooling does not ask — whether an AI '
  + 'answer engine such as ChatGPT, Perplexity, Google AI Overviews or Copilot can *find* the site, *read* it, and *cite* it.',
));

children.push(h2('The problem it solves'));
children.push(p(
  'An agency running SEO for a portfolio of clients normally has the same information scattered across six places: Search Console '
  + 'in one tab, GA4 in another, a crawler that produces a spreadsheet nobody opens twice, a keyword tool, a rank tracker, and a '
  + 'shared document listing what everyone is supposed to be doing. Nothing reconciles. A 20% drop means one thing in the crawler '
  + 'and another in the analytics export, findings arrive as PDFs that go stale the day they are produced, and the work that comes '
  + 'out of all of it lives in whichever project tool the account manager prefers.',
));
children.push(p('This platform collapses that into one chain:'));
children.push(bullet('**One data layer.** Everything is consolidated nightly into brand-keyed tables, and every feature reads from those rather than calling Google directly. A metric means the same thing everywhere, and the app keeps working when a quota is exhausted.'));
children.push(bullet('**One definition of a change.** "Recent window versus prior window" is implemented once. A 20% drop on the dashboard, in an alert, in the weekly report and in the opportunity engine is the same calculation.'));
children.push(bullet('**One backlog.** Every alert, audit finding, linking recommendation, keyword cluster, content opportunity and AI SEO finding opens a **deduplicated task carrying the evidence that produced it**. Nothing is a finding that lives only in a report.'));
children.push(bullet('**One gate.** Anything that can move rankings if done wrong cannot be marked done without SEO sign-off.'));

children.push(h2('How the pieces fit together'));
children.push(p('Everything converges on tasks. That is the design, not a coincidence.'));

children.push(table(
  ['Stage', 'What happens', 'Where it lands'],
  [
    ['Collect', 'Search Console, GA4, PageSpeed Insights and an uptime probe are pulled nightly. Two Python crawlers sweep the site on demand. The AI SEO suite fetches live pages, competitor sites and keyless public endpoints.', 'Brand-keyed tables in one SQLite database'],
    ['Analyse', 'Alert evaluators, the opportunity engine, keyword clustering, the audit and linking parsers, and the twelve AI SEO analyses all read those tables.', 'Findings, metric time series, run records'],
    ['Decide', 'Findings are deduplicated, severity-ranked and turned into tasks. Anything risky is flagged for approval automatically from its own wording.', 'The task backlog'],
    ['Act', 'Tasks are assigned, worked, and closed — with the evidence that raised them attached, so nobody has to reconstruct why.', 'Task events, approvals, assignment digests'],
    ['Report', 'A weekly per-brand report is generated from the stored data, so an old report keeps showing the numbers as they were at the time.', 'Weekly reports, exports, client deliverables'],
  ],
  [14, 56, 30],
));

children.push(spacer());
children.push(callout(
  'Why findings become tasks automatically',
  'A finding that is only ever displayed gets read once and forgotten. A finding that opens a deduplicated backlog item with its '
  + 'evidence attached gets assigned, worked and closed — and if the same problem recurs next month it updates the existing task '
  + 'rather than creating a second one. The deduplication is what makes automated task creation usable rather than a spam generator.',
));

// =========================================================================
children.push(h1('2. The data foundation'));

children.push(p(
  'Nothing in the platform is more important than this layer, and none of it is visible on screen. Every feature described later in '
  + 'this document is only as good as what is underneath it.',
));

children.push(...feature({
  name: 'Brands',
  where: '/brands',
  oneLiner: 'A brand is one client site: its URL, its Search Console property, its GA4 property, its vertical, its market, its seed topics and its competitor list.',
  how: [
    'Search Console and GA4 are two separate inventories that nobody keeps in sync — GSC is keyed by URL, GA4 by a numeric id with a human-typed display name — so the platform **infers the pairing** and shows its confidence rather than quietly guessing.',
    'The vertical and market set on a brand are not cosmetic: they drive keyword intent classification, which review platforms are considered relevant, and which country the volume and difficulty figures are for.',
    'Seed topics stored on the brand are what the scheduled research run expands from, so a brand configured once keeps producing useful runs without anyone retyping.',
  ],
  output: [
    'One place where a client site is defined, with everything else keyed to it',
    'A confidence-rated GSC↔GA4 pairing, with weak matches surfaced for a human to confirm',
    'Bulk import for onboarding a portfolio rather than adding brands one at a time',
  ],
  value: 'Ten minutes of configuration per brand is what makes every later feature specific rather than generic. A brand with its vertical, market, seed topics and competitors set produces reports an account lead can send; one without produces reports that read like a template.',
}));

children.push(...feature({
  name: 'Google connection',
  where: '/connect',
  oneLiner: 'One OAuth connection per workspace covering Search Console, GA4 and PageSpeed Insights.',
  how: [
    'A single Google OAuth client, connected once, is reused by every feature that needs Google data. A team shares one connection, one set of brands and one backlog.',
    'PageSpeed Insights authorises the **principal** rather than a scope, so the token minted for Search Console and Analytics is accepted as-is — no extra consent screen, no separate key required.',
    'Tokens are refreshed automatically; the database file holding them is gitignored, and backups are taken as consistent snapshots rather than file copies.',
  ],
  output: [
    'Search Console queries, pages, impressions, clicks, positions, index coverage and sitemaps',
    'GA4 sessions, engagement and conversions',
    'PageSpeed Insights lab data and CrUX field data for Core Web Vitals',
  ],
  value: 'The connection is the single point of setup. Everything else is configuration rather than integration work.',
}));

children.push(...feature({
  name: 'Nightly consolidation',
  where: 'runs on a schedule',
  oneLiner: 'Search Console, GA4, PageSpeed and an uptime probe are pulled nightly and upserted into brand-keyed tables that every other feature reads.',
  how: [
    'All upserts are **idempotent**: re-syncing an overlapping date range replaces rows rather than double-counting.',
    'Search Console finalises its data two to three days late, so the sync window always re-pulls recent days to pick up revisions. A number that changed because Google revised it is captured; a number that changed because the sync ran twice is not.',
    'Everything downstream reads the consolidated tables, never Google directly — so an exhausted quota degrades one night\'s freshness rather than breaking the dashboard, the alerts and the reports simultaneously.',
  ],
  output: [
    '90+ days of history per brand at site, page, query and query-page level',
    'Country, device and search-appearance breakdowns',
    'Core Web Vitals snapshots and uptime history',
  ],
  value: 'This is why the platform is fast and why it keeps working. It is also why a weekly report generated in March still shows March\'s numbers in June, instead of silently changing when data is re-synced.',
  trust: 'Because everything reads one consolidated layer, a discrepancy between two screens is a bug rather than a fact of life. There is exactly one place a number can come from.',
}));

children.push(...feature({
  name: 'Comparison maths',
  where: 'shared by every feature',
  oneLiner: 'The "recent window versus prior window" comparison that alerts, reports, opportunities and the dashboard all share.',
  how: [
    'A window is `days` long, ending `endOffset` days before the most recent day of data held — so "last 7 days" and "the 7 days before those" are defined once and are always the same length.',
    'The anchor is the latest date the platform actually has data for, not today. A comparison that ends on an unfinalised day understates the recent window and manufactures a decline every single time it runs.',
  ],
  output: [
    'Absolute and percentage change at site, page and query level',
    'Identical results wherever the comparison appears',
  ],
  value: 'A "20% drop" means the same thing in an alert, in the weekly report, on the dashboard and in the opportunity engine. That sounds trivial until three of them disagree in front of a client.',
}));

// =========================================================================
children.push(h1('3. Classic SEO capabilities'));

children.push(...feature({
  name: 'Dashboard and performance',
  where: '/dashboard, /performance',
  oneLiner: 'Portfolio-level health across every brand, and per-brand performance with the breakdowns Search Console keeps in separate reports.',
  how: [
    'Reads the consolidated tables, so it loads instantly regardless of how many brands are in the portfolio.',
    'Clicks, impressions, CTR and average position over any window, with the prior period alongside — plus country, device and search-appearance splits.',
    'Open alerts, open tasks and last-sync status per brand, so an unhealthy account is visible from the portfolio view rather than only when someone opens it.',
  ],
  output: [
    'One screen that answers "is anything wrong across the portfolio this morning"',
    'Per-brand trend, breakdown and comparison views',
  ],
  value: 'The daily first-look. It replaces opening Search Console once per client and trying to hold the comparison in your head.',
}));

children.push(...feature({
  name: 'Technical SEO audit',
  where: '/audit',
  oneLiner: 'A full-site crawl reporting broken links, duplicate and missing titles and meta descriptions, H1 problems, redirect chains, non-indexable pages, canonical issues, missing alt text, slow pages, orphan indicators and sitemap/robots issues.',
  how: [
    'Runs a dedicated crawler as a separate process, because a full-site sweep takes minutes rather than seconds and must not hold a web request open.',
    'Progress is streamed into the run record, so reloading the page — or a server restart — still shows where the crawl reached.',
    'The structured result is parsed into first-class findings, and findings become deduplicated tasks with the affected URLs attached.',
  ],
  output: [
    'A categorised findings report with severity and affected URL counts',
    'Downloadable Word and CSV exports for client delivery',
    'Tasks in the backlog rather than a spreadsheet nobody opens twice',
  ],
  value: 'The standard technical audit, but the output is work rather than a document. The difference shows up a month later: findings that became tasks got fixed, findings that became a PDF did not.',
  note: 'The crawler cannot emit JSON and a Word document in the same run — the flags are mutually exclusive in the tool itself. The platform therefore takes the structured output and renders its own report from it, rather than crawling the site twice.',
}));

children.push(...feature({
  name: 'Internal linking audit',
  where: '/linking',
  oneLiner: 'Crawls the site, finds semantically related pages, and recommends source→target internal links with anchor text taken verbatim from the source page.',
  how: [
    'Every recommended anchor **already appears, word for word, in the source page\'s body copy**, and the exact sentence is given with it.',
    'Also flags orphan pages with no editorial inbound link, under-linked pages, keyword cannibalisation pairs, duplicate-content pairs and broken internal links.',
    'Produces five styled workbooks plus a Word report — the workbooks are what an SEO works from, the document is what a client reads.',
  ],
  output: [
    'Link recommendations split into three buckets: ready to paste in, single-word anchor needing a context check, and needs a new sentence written',
    'Orphan, cannibalisation, duplicate-content and broken-link registers',
    'A client-facing Word report and five spreadsheets',
  ],
  value: 'Internal linking is the highest-leverage work most sites are not doing, and the reason it does not get done is that recommendations normally arrive as "link to this page with this anchor" without saying where. Giving the exact existing sentence turns a research task into a five-minute edit.',
  trust: 'The three-bucket split is the honest part. A recommendation that needs a new sentence written is a content task, not a linking task, and it is labelled as one instead of being counted alongside the ones that can be implemented immediately.',
}));

children.push(...feature({
  name: 'Keyword clustering',
  where: '/keywords',
  oneLiner: 'Takes a keyword list — pasted, uploaded, or pulled straight from the brand\'s own Search Console queries — and returns clusters with a primary keyword, supporting keywords, search intent, a suggested page type and a build-or-improve recommendation.',
  how: [
    'Keywords are normalised (lowercased, punctuation stripped, stopwords dropped, lightly stemmed) so "web designer" and "web designers" share a token, then reduced to a signature of content-bearing tokens and agglomerated by overlap.',
    '**Place names are treated separately from ordinary modifiers.** Without that, "plumber austin" and "plumber dallas" merge into one cluster on the shared head "plumber" — and they are different pages targeting different result pages.',
    'Intent classification and page-type suggestion use a shared taxonomy, so "Transactional" means the same thing here as it does in the AI SEO research module.',
  ],
  output: [
    'Clusters ready to approve, each with a primary keyword, its supporting terms, intent and a suggested page type',
    'Approved clusters feed straight into the content brief generator',
  ],
  value: 'Turns a flat keyword export into a content plan. The place-name handling in particular prevents the classic failure where a national keyword set produces a city-specific recommended title.',
  note: 'Real SERP-overlap clustering is the gold standard but requires a paid SERP API call per keyword. This runs on data already held, with no external calls and no per-keyword cost — a deliberate trade of some precision for zero marginal cost and instant results.',
}));

children.push(...feature({
  name: 'Content opportunities',
  where: '/keywords → opportunities',
  oneLiner: 'A ranked list of specific, evidenced content actions read directly from Search Console and GA4.',
  how: [
    'Six opportunity types, each with its own evidence: **CTR gap** (high impressions, low CTR → rewrite title and meta), **striking distance** (position 4–20 with volume → strengthen the page), **declining** (losing clicks versus the prior period), **refresh** (decaying slowly over 90 days), and two more.',
    'Entirely deterministic — the same input always produces the same output, and every item carries the numbers that justify it.',
    'Branded queries are identified and handled separately, because they convert at multiples of the rate and earn three to ten times the CTR at the same position. Mixing them into a CTR-gap analysis produces nonsense.',
  ],
  output: [
    'A prioritised list where each item names the page, the queries, the numbers and the recommended action',
    'Tasks in the backlog with the evidence attached',
  ],
  value: 'This is the highest-value list in the platform for a working SEO. Everything on it is a page that already has demand and is underperforming against its own data — no speculation required.',
  trust: 'Deterministic by design. An opportunity that appeared because a model felt differently today could not be explained to a client, alerted on, or trusted.',
}));

children.push(...feature({
  name: 'Content briefs',
  where: '/keywords → briefs',
  oneLiner: 'Turns an approved keyword cluster into a brief: intent, recommended title, suggested headings, supporting keywords, a word-count range and internal-link suggestions.',
  how: [
    'Every field is built from data the platform already owns — the cluster supplies intent and supporting terms, the linking crawler\'s page inventory supplies a realistic word-count range for that site, and its recommendations supply the internal links.',
    'For a page that does not exist yet, the internal-link suggestions come from the existing pages with the closest topical overlap.',
    'An AI-assisted version is available on request as an explicit, logged action — never automatically.',
  ],
  output: ['A writer-ready brief per approved cluster, with zero external calls and zero ongoing cost'],
  value: 'Closes the loop between "we should target this cluster" and "someone can start writing". The word-count range being drawn from the site\'s own pages rather than a generic benchmark is what makes it usable.',
}));

children.push(...feature({
  name: 'Page speed and Core Web Vitals',
  where: '/pagespeed',
  oneLiner: 'Full PageSpeed Insights reports plus CrUX field data, stored as history rather than checked once.',
  how: [
    'Lab data and real-user field data are both captured, and reported separately — they answer different questions and a site can pass one while failing the other.',
    'Snapshots are stored, so a regression is visible as a change rather than as a number with no context.',
  ],
  output: ['Per-page and per-origin Core Web Vitals with history, and the diagnostics behind them'],
  value: 'Core Web Vitals only matter as a trend. A single score tells you nothing about whether last month\'s deployment made things worse.',
}));

// =========================================================================
children.push(h1('4. The AI SEO suite'));

children.push(p(
  'Twelve analyses plus a twenty-one-check tracking board, all aimed at a question the rest of the platform does not ask: '
  + '**can an AI answer engine find this site, read it, and cite it?**',
));
children.push(p(
  'This matters because the surface has changed. A growing share of queries are answered without a click, by a system that fetches a '
  + 'handful of pages at the moment someone asks, reads the HTML it is served, and quotes whichever passage it can attribute. Ranking '
  + 'in position three is worth considerably less if the assistant answering above the results cannot read your page — and none of the '
  + 'classic tooling checks whether it can.',
));

children.push(callout(
  'Three things distinguish this from a "GEO checker"',
  '**One.** Access is tested by *requesting the page as each AI agent*, not by reading robots.txt — because the dominant real failure is '
  + 'an edge rule nobody knows about (Cloudflare bot-fight, a WAF user-agent rule, a "block AI scrapers" plugin) returning 403 while '
  + 'robots.txt says Allow.  '
  + '**Two.** Training crawlers and retrieval fetchers are reported *separately*, because blocking them means opposite things: blocking '
  + 'a training crawler costs nothing in visibility and many publishers do it deliberately; blocking a retrieval fetcher means the brand '
  + 'cannot appear in that assistant\'s answers at all.  '
  + '**Three.** All measurement is deterministic and local. The AI model explains, drafts and rewrites — it never measures.',
));

children.push(h2('4.1 Discovery'));

children.push(...feature({
  name: 'Keyword and prompt research',
  where: '/ai-seo/research',
  oneLiner: 'Two kinds of demand, discovered separately: the queries people type into a search box, and the prompts they type into an assistant.',
  how: [
    '**Search demand** comes from Search Console — real impressions for this exact site, not an estimate — extended with Google autocomplete, an alphabet sweep of it ("term a", "term b" … which is where the long tail lives), and a second suggestion index that returns phrasings Google\'s does not.',
    '**Search volume** is looked up through an adapter chain: Google Ads Keyword Planner → DataForSEO → Semrush. Every value is labelled with the source that produced it.',
    '**Keyword difficulty** is the vendor\'s where a credential exists; otherwise it is computed from a sample of a live result page — how much of the top ten sits on a named high-authority domain, how many titles carry the exact phrase, how many results are homepages, how much is forum content — with the formula and every component shown.',
    '**Country filter** flows through every geo-aware source in the identifier that source expects: Google\'s `gl`/`hl`, a Trends `geo` code, a regional result sample, and a location code for any paid adapter.',
    '**Assistant prompts** are written by the AI model, because the sentences people type into ChatGPT are whole questions with a stated situation and cannot be derived from a keyword list by adding modifiers.',
  ],
  output: [
    'A keyword universe with volume, difficulty, relative interest, impressions, position and a priority score — each with its own provenance',
    'Topic clusters ordered by the demand evidence that actually exists, with cluster-level volume and average difficulty',
    'A "winnable keywords" list: the intersection of real demand and low difficulty',
    'Assistant prompts grouped by the job the person is trying to do, with what a page needs in order to be cited for each',
  ],
  value: 'The prompt half is the part no keyword tool produces, and it is where the next few years of discovery are going. The search half is now a complete keyword research workflow — volume, difficulty and country — rather than a demand-signal proxy.',
  trust: 'No search volume is displayed unless it was measured, and the source is printed under every value. Where no volume credential is configured, Search Console impressions (a measurement of *this* site) and Google Trends relative interest (0–100, the shape of demand rather than its size) are shown in their **own columns** under their own headings. An em dash always means unknown; it never means zero.',
}));

children.push(h2('4.2 The page itself'));

children.push(...feature({
  name: 'On-page optimisation score',
  where: '/ai-seo/optimizer',
  oneLiner: 'Scores a live URL or a pasted draft against the pages it actually competes with, on the things that decide whether it ranks and whether an assistant can quote it.',
  how: [
    'Six scored dimensions: **semantic coverage** against a named comparison set, **readability** against a target band, **entity density**, **citability**, **target-term placement** and **heading hierarchy** — with an over-optimisation penalty applied on top.',
    'The comparison set is real pages, not a guess: URLs you paste, or the best-matching page on each named competitor domain found by reading their own sitemap.',
    '**Every content metric is computed after the navigation, header, footer, social links, cookie banner, form controls and repeated pricing labels have been excluded.** On a short page those are most of the words, and including them moves every ratio.',
    '**Heading hierarchy** is validated in document order: missing or duplicated H1, skipped levels, an H5 before any H1, duplicate adjacent headings, empty heading tags, and headings whose entire text is a generic label.',
    '**Keyword stuffing** is measured as density *and* distribution, because density alone cannot tell a 3,000-word page that is genuinely about a subject from one with fifty mentions crammed into a single section.',
  ],
  output: [
    'A composite score with every component shown and the over-optimisation deduction itemised',
    'Consensus terms and named entities the comparison pages carry and this page does not',
    'A heading outline with each structural problem named, including its WCAG reference where one applies',
    'A keyword distribution chart across the page, plus over-used phrases and duplicated sentences',
    'Concrete suggested edits, anchored to the measured gaps',
  ],
  value: 'The score is actionable rather than abstract, because every component says what to change. Excluding the template from the measurement is what makes the numbers comparable between pages — before that, a page with a long footer scored differently from an identical page without one.',
  trust: 'The score is never presented as "you will rank". It is coverage *relative to a named comparison set*, and the set is listed. Where no comparison set could be built, semantic coverage is **excluded** and the remaining weights renormalise rather than scoring the page 0% against nothing.',
}));

children.push(...feature({
  name: 'Schema and structured data',
  where: '/ai-seo/schema',
  oneLiner: 'Classifies what kind of page it is, validates the markup that exists, and generates the complete, ready-to-paste block for every type that page type permits.',
  how: [
    '**The page type is decided first**, from four independent evidence sources: the URL path, the commerce apparatus present in the DOM, the headings and content, and the existing markup as a weak hint.',
    'The discriminator for a product page is the **transaction apparatus** — an add-to-cart control, an SKU, a variant selector — not the presence of a price. Service pages, pricing pages and course pages all quote prices.',
    'Existing JSON-LD is validated against per-type requirement tables transcribed from Google\'s own documentation, keeping the **required versus recommended** distinction: a missing required property means no rich result at all; a missing recommended one is a competitive disadvantage.',
    'Generated blocks **omit** anything that cannot be read from the page rather than writing `null` — Google treats an explicit null as malformed, which is worse than an absent property it would simply ignore.',
    'Output includes one **combined @graph with @id cross-references**, because separate blocks state unlinked facts: a standalone Article beside a standalone Organization does not say the article was published by the organisation.',
  ],
  output: [
    'A page-type verdict with the evidence that produced it',
    'Validation of existing markup, split into hard failures and competitive disadvantages',
    'A complete, valid block per permitted type, each with a checklist of any values that must be supplied and the exact shape expected',
    'The combined @graph and a downloadable ready-to-paste script tag',
    'A list of the types deliberately **not** generated, with the reason for each',
  ],
  value: 'Schema is normally either absent or wrong, and wrong is worse: markup that fails validation makes Google trust the site\'s structured data less broadly, not just that block. This produces markup that can be pasted as-is and refuses to produce markup that would misdescribe the page.',
  trust: 'Type selection is deterministic and shown. Where the classifier is not confident, it says so and offers the types that are safe for both candidate page types rather than asserting one. A type you request explicitly is still produced — flagged with the objection — because you may know something the classifier does not.',
}));

children.push(...feature({
  name: 'Brand hub and llms.txt',
  where: '/ai-seo/brand-hub',
  oneLiner: 'One canonical fact set about the organisation, rendered into llms.txt, the Organization schema block and a completeness checklist — so the three cannot disagree.',
  how: [
    'Facts are declared once: legal name, what the organisation does, who it serves, where it operates, how pricing works, accreditations, contact routes and official profile URLs.',
    'The **content map is built from the sitemap**, grouped by the site\'s own URL sections. Search Console — where it exists — only orders pages within each section and annotates the busiest.',
    'A completeness checklist names the specific facts an assistant needs in order to answer "what is this and can I trust it", and why each one matters.',
  ],
  output: [
    'A downloadable llms.txt with a canonical facts block and a sectioned content map',
    'The Organization schema built from the same facts',
    'A completeness score with the missing facts named and their consequence stated',
  ],
  value: 'The real value is not the file — it is that writing the canonical facts down once forces the organisation to decide what they are. Most brands discover during this exercise that three pages on their own site describe the business differently.',
  note: 'Stated plainly on the page: **Google has said it does not use llms.txt, and it is not a ranking factor anywhere.** What it does is give retrieval pipelines that *do* read it an unambiguous statement of what the brand is. The completeness checklist and the Organization block are the parts with certain value.',
}));

children.push(h2('4.3 Access and architecture'));

children.push(...feature({
  name: 'AI-crawler readiness — one page',
  where: '/ai-seo/readiness',
  oneLiner: 'Can each AI system reach this page, read the content in the HTML it is served, and do it fast enough not to time out?',
  how: [
    'Every AI user agent is tested twice: against robots.txt, **and** by making a real request as that agent and looking at what comes back.',
    'Agents are split by purpose — retrieval fetchers that cite pages, and training crawlers that do not affect visibility.',
    'Also measures time-to-first-byte as a median of samples, certificate validity, security headers, indexability directives, and whether the served HTML actually carries the content.',
  ],
  output: ['A per-agent verdict with the reason, plus speed, certificate, header and rendering diagnostics'],
  value: 'The fastest way to find out that a site everyone believes is fine is invisible to half the assistants people ask.',
  trust: 'A tool that reports "8 AI bots blocked" without splitting retrieval from training tells a publisher who deliberately blocked training crawlers that they have a problem, and tells a site whose WAF is silently 403-ing a retrieval fetcher that they are fine. Both are wrong.',
}));

children.push(...feature({
  name: 'AI-crawler readiness — whole site',
  where: '/ai-seo/site-readiness',
  oneLiner: 'The same question for the entire property, against an explicit eight-point checklist.',
  how: [
    'The URL set is the **union of the sitemap and a link crawl** — which is the only way "does the sitemap contain all target URLs" can be answered at all, since a sitemap compared against itself is never incomplete.',
    'Items are ordered and weighted by **what blocks what**: a page a fetcher cannot reach cannot be read; a page it reads but is told to ignore is not indexed; a page it reads and finds empty contributes nothing; markup contradicting the page comes last.',
  ],
  output: [
    '**1. robots.txt** — per agent, robots plus a live request',
    '**2. Sitemap coverage** — indexable crawled pages absent from it, and sitemap URLs the crawl never reached',
    '**3. Important pages return 200** — the homepage, any URL you name, and each section\'s entry point, fetched directly',
    '**4. No accidental noindex** — with a noindex page that is *also in the sitemap* flagged hardest, because that contradiction is never intentional',
    '**5. Canonical correctness** — missing, off-host, pointing at a broken URL, or several distinct pages collapsing onto one',
    '**6. Main content in the HTML** — client-rendered pages that are blank to every AI fetcher while perfect in a browser',
    '**7. Internal links are standard links** — real anchors counted against href="#", javascript: hrefs, anchors with no href, and divs wired with onclick',
    '**8. Structured data valid and matching the visible text** — including marked-up prices and ratings that do not appear on the page, and FAQ answers a reader cannot see',
  ],
  value: 'This is the audit to run before telling a client their AI visibility problem is a content problem. Items 6 and 7 in particular routinely find that a site has, from an assistant\'s point of view, one page.',
  trust: 'Items 7 and 8 are the two a conventional validator cannot do. A div wired with onclick passes every HTML validator and is invisible to every crawler; a marked-up rating that does not appear on the page passes every schema validator and is the most commonly penalised structured-data abuse there is.',
}));

children.push(...feature({
  name: 'Internal linking and architecture',
  where: '/ai-seo/architecture',
  oneLiner: 'An entity graph of the site: topic clusters, hub-and-spoke completeness, orphans, crawl depth, breadcrumb trails, and the specific link pairs worth adding.',
  how: [
    'Links are proposed from **overlap of named entities**, not keyword matching. Two pages that both discuss "Basel III" and "capital adequacy" are genuinely related; two that both contain "training" are not — and keyword matching returns most of the site.',
    'Direction is decided rather than guessed: a link should point from the narrower page to the broader one. Getting that backwards dilutes a hub instead of strengthening it.',
    'Orphans are cross-referenced against Search Console, because an orphan with 4,000 impressions is a different problem from one nobody has ever seen.',
  ],
  output: [
    'Topic clusters with their hub identified and hub/spoke completeness measured',
    'Orphan and weakly-linked page registers, ordered by whether the page already earns impressions',
    'Breadcrumb proposals built from the site\'s own URL hierarchy, with levels that would link to a 404 flagged',
  ],
  value: 'The graph view answers questions a pairwise spreadsheet cannot: which topics the site actually covers, where the hierarchy is flat when it should be nested, and which pages nothing links to.',
}));

children.push(...feature({
  name: 'Link opportunities for a URL',
  where: '/ai-seo/link-opportunities',
  oneLiner: 'Give it one URL and it returns the pages that should link to it — each with an anchor phrase already present in that page\'s own copy, and the sentence it sits in.',
  how: [
    'Anchor vocabulary is read from the target page: its H1, title, URL slug, subheadings and repeated phrases, each weighted and shown.',
    'Relevance is entity overlap with the target plus vocabulary similarity, so the ranking reflects what a reader would consider related.',
    '**Every anchor is a verbatim substring of the source page\'s own rendered text.** Anchors found only in navigation, headers, footers or any block repeating across the site are rejected, as are generic labels and phrases already linked elsewhere on that page.',
  ],
  output: [
    'A table with exactly the columns needed: **URL, Source URL, Anchor text** — plus the sentence, the relevance and the shared entities',
    'A CSV export',
    'Pages that already link to the target, with the anchor used and whether it is editorial or navigation',
    'Relevant pages with no usable anchor, listed **separately** because linking from those means writing a sentence — a content task, not a linking one',
  ],
  value: 'This is the fastest way to strengthen a specific page. Implementing a row is opening the source page, finding the sentence shown, and wrapping the phrase — no new copy, no judgement call about where it goes.',
  trust: 'A recommendation to "link with this anchor" is worthless if the phrase is not on the source page — the implementer then has to write a sentence and decide where it goes, and a five-minute linking task has quietly become a writing brief. That is why the verbatim rule is absolute.',
}));

children.push(h2('4.4 Competitive and external signals'));

children.push(...feature({
  name: 'Competitive intelligence',
  where: '/ai-seo/competitors',
  oneLiner: 'Crawls named competitors and reports, in tables, where they are ahead — on topics, on keywords, and on links.',
  how: [
    '**Topic coverage matrix** — one row per topic, one column per site, one score computed identically for everybody: breadth (share of pages discussing it) plus depth (share whose title or H1 is *about* it) plus a bonus where the deepest such page is substantial. The formula is printed under the table.',
    '**Keyword gap** — where each site appears for each candidate keyword, with a state per row: gap, behind, we lead, or nobody ranks. Candidates come from your own non-branded Search Console queries first, so the rows are keywords that matter to this brand.',
    '**Backlink gap** — referring domains per site, plus the domains linking to a competitor and not to you, sorted by how many competitors each links to.',
    'Also measured from a live fetch of their sites: content inventory, publishing velocity, internal anchor patterns (which reveal what they think their own money pages are), structured data coverage, author signals and AI-retrieval posture.',
    '**Every gap list is filtered.** Competitor brand names, generic button and section labels, and each site\'s own template text are suppressed — and what was suppressed is listed with its reason.',
  ],
  output: [
    'Three comparison tables plus a full competitor profile per domain',
    'Topics every competitor covers and you do not, flagged separately from topics where you are merely behind',
    'The domains linking to several competitors and not to you — the reachable link targets',
  ],
  value: 'The matrix answers "how far behind, and on what" rather than "here is a list of words they use". The multi-competitor backlink rows are the most directly actionable output in the whole module: a directory, a supplier page or an association list that has the entire category except this client.',
  trust: 'Referring domains are **verified**, not inferred: every candidate page is fetched and its outbound links are read, so a domain only counts where a real link exists. Pages that merely mention the domain without linking are counted in their own column — and unlinked mentions of *your* brand are the cheapest links available, because the publisher already decided to write about you.',
  note: 'Where no link-index or rank-tracker credential is configured, referring-domain counts are a **verified sample** — accurate but a floor rather than a total — and keyword positions are read from a non-Google result page and labelled as such on every row. Both are stated on the table itself, not in a footnote.',
}));

children.push(...feature({
  name: 'Reputation and ambient signals',
  where: '/ai-seo/reputation',
  oneLiner: 'Monitors Reddit, Hacker News and Google/Bing News — the third-party discussion an assistant weighs when asked whether a brand is credible.',
  how: [
    'Reddit gets its own module rather than being one function among four, because it is the source assistants lean on hardest for "is this brand any good" and the most defended. Four endpoints are tried in order over a paced session that recognises a block and stops making it worse.',
    'Sentiment is lexicon-based and deterministic. A scan returns hundreds of items; classifying all of them with a paid model would exhaust the AI budget on the cheapest part of the job.',
    'The model is used only for the part needing judgement: whether a negative mention is a factual claim that needs correcting.',
    'Risk patterns — fraud accusations, legal claims, out-of-business claims, data-safety claims, accreditation disputes — are matched explicitly and escalated.',
  ],
  output: [
    'A mention feed with sentiment, source and confidence',
    'A flagged register of risky claims needing a human decision',
    'Net sentiment tracked over time',
  ],
  value: 'When someone asks an assistant whether a brand is legitimate, the answer is assembled from whatever third parties have said. This is the only view of that input, and the risk register is the part that matters most: a single unanswered fraud accusation on a forum can become the loudest thing said about a brand.',
  trust: 'A source that fails is **reported as failed**, and Reddit additionally reports which tier answered. Reporting zero mentions when a source was blocked is the one outcome this module must never produce.',
}));

children.push(...feature({
  name: 'Review platform coverage',
  where: '/ai-seo/review-platforms',
  oneLiner: 'Which review platforms have a profile for this brand and which do not, chosen by vertical and weighted by what a missing profile actually costs.',
  how: [
    'Nineteen platforms, each declaring the verticals it matters for. A restaurant missing from G2 has no problem; a B2B software product missing from G2 has a serious one — so only the relevant ones plus the universal ones are checked.',
    'Presence is established either by probing the platform\'s conventional profile URL or by a site-restricted search. **No reviews are read**, which is what makes this possible on platforms that block automated access.',
    'A platform that blocks or rate-limits the request is recorded as **unknown**, never as missing, and unknowns are excluded from the score on both sides.',
  ],
  output: [
    'A per-platform verdict with the evidence, the profile URL where one was found, and the reason each platform matters',
    'A gap list ordered by consequence rather than by how well-known the platform is',
    'One task per gap',
  ],
  value: 'Review profiles are the evidence an assistant checks when asked whether a business is reputable — it will not take the brand\'s own site as an answer to that question. Where there is nothing else to read, it reports what a forum post said.',
  trust: 'Calling an unknown a gap would send someone to create a profile that already exists. "Unknown" is a first-class outcome with its own count, and it is excluded from the score rather than counted against the brand.',
}));

children.push(h2('4.5 Maintenance and monitoring'));

children.push(...feature({
  name: 'Freshness and intent drift',
  where: '/ai-seo/freshness',
  oneLiner: 'Finds pages losing ground faster than the site as a whole, and pages whose topic is unchanged while the question being asked of them has moved.',
  how: [
    'Decay is measured **relative to the site**, so a page declining while everything declines is not flagged as a page problem.',
    'Intent drift is measured as Jensen-Shannon divergence over the query mix between two Search Console snapshots — chosen because it is symmetric, always finite, and bounded, so a threshold means the same thing on every brand.',
    'Refresh work can be scheduled straight out of the report as dated tasks spread over the weeks ahead at a stated weekly capacity.',
  ],
  output: [
    'A decay register ordered by what the decline is actually costing',
    'A drift register naming the queries that entered and left',
    'A scheduled refresh plan',
  ],
  value: 'Content refresh is the work everyone agrees is valuable and nobody schedules. This makes it a dated backlog rather than an intention, and the drift half catches the subtler failure: a page that still ranks but for a question people have stopped asking.',
  note: 'Comparing top-10 query lists misses a shift that starts below the top 10 — which is where it starts. That is why divergence over the whole distribution is used instead.',
}));

children.push(...feature({
  name: 'SEO tracking board',
  where: '/ai-seo/monitoring',
  oneLiner: 'Twenty-one checks covering every tracking element, each with its own history, on one board.',
  how: [
    'Runs in two scopes. **Sampled** uses a deliberate cross-section — the homepage, the highest-impression pages, and one page per sitemap section — which is enough to detect a templating fault and cheap enough to run nightly.',
    '**Sitewide** additionally hands the full URL set to the checks that can absorb it. The rest keep the sample, because running PageSpeed against three thousand URLs would exhaust the daily quota on the first brand.',
    'Every check reports **which URL set it actually ran against**, so a count is never read against the wrong denominator.',
    'Every metric is stored as a time series with the value *and* the verdict it was given at the time.',
  ],
  output: [
    'Twenty-one checks across eleven groups, each with a status, its metrics and its history',
    'A board score that is the share of measured metrics in a good state',
    'A dedicated broken-page check listing every 4xx, 5xx, soft 404 and unreachable URL — **with the internal links pointing at each one**',
  ],
  value: 'The sampled sweep is the nightly heartbeat; the sitewide sweep is what you run when you need the actual list of affected URLs. The broken-page check in particular distinguishes a 404 nothing links to (a stale sitemap entry) from a 404 with eleven inbound links (a genuine problem wasting crawl budget on every sweep).',
  trust: 'A check that cannot measure returns **unknown**, and unknown metrics are excluded from the board score on both sides of the ratio. A site with no field data must not score badly for it — and must not score well for it either.',
}));

// =========================================================================
children.push(h1('5. Alerting and governance'));

children.push(...feature({
  name: 'Alerts',
  where: '/alerts',
  oneLiner: '46 alert types across ten groups, each individually subscribable per brand with its own threshold.',
  how: [
    'Each alert has its own evaluator running against the consolidated data. Findings are deduplicated, stored as events, optionally opened as tasks, and sent to the configured channels.',
    'Notifications are **batched into one digest per brand per channel per run**, so a bad morning produces one message rather than thirty.',
    'Channels: email, Slack, and a generic webhook — which is also the WhatsApp path, pointed at a Business API relay or an automation hook. With none configured, alerts are logged rather than lost, and nothing throws.',
  ],
  output: [
    'Groups covering traffic and visibility, keywords and rankings, landing pages, indexation, engagement and conversions, Core Web Vitals, availability, technical audit findings, data health, and the AI SEO suite',
    'An alert history with the evidence behind each event',
  ],
  value: 'This is what turns the platform from something you check into something that tells you. The batching is what stops people muting it in week two.',
  note: 'One alert type exists specifically to catch the failure mode of the others: a scheduled sweep that stopped running produces no findings, which looks exactly like a healthy site. **`aiseo_stale_sweep`** fires when the data behind the alerts has itself gone stale.',
}));

children.push(...feature({
  name: 'The task backlog',
  where: '/tasks',
  oneLiner: 'Every finding in the platform converges here as a deduplicated task carrying the evidence that produced it.',
  how: [
    'Tasks carry a source, a category, a severity, the affected URL and the structured evidence — so nobody has to reconstruct why a task exists.',
    'Deduplication is by a stable key: the same problem recurring updates the existing task rather than opening a second one.',
    'Status flow is backlog → in progress → awaiting approval → done, with blocked available at any point. A resolved finding auto-closes a backlog task but only *annotates* one that someone is actively working on.',
    'Assignment notifications are batched per person: one email listing six tasks, not six emails.',
  ],
  output: ['One backlog across every brand and every source, filterable, assignable and exportable'],
  value: 'The backlog is the product. Everything else in this document exists to fill it correctly.',
}));

children.push(h2('The approval gate'));
children.push(p(
  'The platform identifies, analyses, recommends, reports and creates tasks. It does not publish, redirect, deindex or edit. '
  + 'That boundary is **enforced in code**, not documented as a policy.',
));
children.push(p('A task whose wording matches any of these rules is created flagged and cannot be moved to *done* until an authorised person signs it off:'));

children.push(table(
  ['Action', 'Why it is gated'],
  [
    ['Publishing content', 'Live content is the one change that cannot be quietly reverted'],
    ['Changing URLs', 'A URL change without redirects loses every link and ranking the page had'],
    ['Editing canonical tags', 'A wrong canonical asks Google to index something else instead of the page'],
    ['Updating robots.txt', 'One line can deindex a section — and it will not be noticed for weeks'],
    ['Removing, redirecting or deindexing pages', 'Irreversible in effect even when reversible in fact'],
    ['Adding internal links in bulk', 'Bulk link application is where an automated tool does the most damage fastest'],
    ['Changing titles on high-performing pages', 'The page most worth improving is the page most costly to get wrong'],
    ['Changing the sitemap', 'Governs what gets discovered at all'],
  ],
  [34, 66],
));

children.push(spacer());
children.push(callout(
  'Why this is the most important paragraph in the document',
  'Every automation that has ever damaged a site did so by executing a correct-looking recommendation without a human reading it first. '
  + 'The gate means the platform can be aggressive about *finding* problems — which is where its value is — without being able to act on '
  + 'a false positive. An SEO reviewing this tooling should check this section before any other.',
  'FBF3F2', RED,
));

// =========================================================================
children.push(h1('6. Reporting and team'));

children.push(...feature({
  name: 'Weekly reports',
  where: '/reports',
  oneLiner: 'One standard report per brand per week, generated from the consolidated tables.',
  how: [
    'Covers organic traffic, impressions and clicks, average rankings, top gaining and declining keywords, top landing pages, conversion performance, technical issues, work completed, and what needs doing next week.',
    'Stored as data and rendered by the view layer, so **an old report keeps showing the numbers as they were at generation time** rather than silently changing when data is re-synced.',
    'Printable and exportable for client delivery.',
  ],
  output: ['A dated, stable, client-ready report per brand, produced without anyone assembling it'],
  value: 'Weekly reporting is the single largest recurring time cost in most agencies. This removes the assembly and leaves the commentary — which is the part clients are actually paying for.',
  trust: 'Because a report is stored rather than recomputed, the figure a client was shown in March is still the figure that report shows in June. A regenerating report is a report nobody can reference in a meeting.',
}));

children.push(...feature({
  name: 'Team, roles and assignment',
  where: '/team',
  oneLiner: 'A shared workspace with roles, an approval-capable admin tier, and the people a task can be assigned to.',
  how: [
    'A team shares one account\'s data — one Google connection, one set of brands, one backlog — while each member\'s own identity is used for anything that records **who** acted: approvals, assignment and the event log.',
    'Roles separate running the workspace from doing the work, with task-assignment permission grantable independently.',
    'External contacts (a client-side developer, a freelance writer) can be assigned work without being given access to the workspace.',
  ],
  output: ['Member management, invite codes, per-person assignment history and batched notification digests'],
  value: 'Makes the backlog a shared operational tool rather than one person\'s list.',
}));

children.push(...feature({
  name: 'Workflow map',
  where: '/workflow',
  oneLiner: 'A written map of the SEO workflow with live status against each step: what this platform automates, what it assists with, and what stays manual by policy.',
  how: [
    'Held as structured data rather than a static document, so the app renders it, exports it, and shows current status against each item.',
    'Nineteen tracked items, with the approval boundary drawn explicitly.',
  ],
  output: ['A shareable statement of what is automated and what is not, kept honest by being generated from the same source as the app'],
  value: 'Answers "what does this thing actually do for us" without anyone having to reverse-engineer it from screens — and answers it the same way six months from now.',
}));

children.push(...feature({
  name: 'AI Assist',
  where: '/ai-assist',
  oneLiner: 'AI-generated content briefs, opportunity recommendations, linking rationale, metadata rewrites and task rewrites — every one an explicit, logged button click.',
  how: [
    'Nothing here is ever called from an alert evaluator or a scheduled job. Every generation is a manual action, and every call is logged against a shared spend cap.',
    'Results are cached on their inputs, so re-opening a page does not spend again.',
  ],
  output: ['Drafted copy and written rationale, on demand, with the spend visible'],
  value: 'The AI is used where judgement and phrasing are the work, and kept away from anything that produces a number. A cron job that spends the AI budget unattended exhausts the cap before anyone has read a finding.',
}));

// =========================================================================
children.push(h1('7. Where every number comes from'));

children.push(p(
  'This is the section to read if you are assessing whether the platform can be trusted in front of a client. '
  + 'Every figure it produces falls into one of three categories, and each is labelled as such on screen.',
));

children.push(h2('Measured'));
children.push(p('Obtained directly, from a source that knows the answer.'));
children.push(table(
  ['Source', 'Authentication', 'What it provides'],
  [
    ['Google Search Console', 'Your OAuth connection', 'Queries, impressions, clicks, positions, index coverage, sitemaps — for this property only'],
    ['Google Analytics 4', 'Your OAuth connection', 'Sessions, engagement, conversions'],
    ['PageSpeed Insights / CrUX', 'OAuth or an optional key', 'Core Web Vitals lab and real-user field data'],
    ['The built-in crawler', 'None needed', 'HTML, headings, schema, links, robots, canonicals, status codes, TTFB — for your site *and* named competitors'],
    ['The two Python crawlers', 'None needed', 'Full-site technical audit and internal-linking analysis'],
    ['Google Ads Keyword Planner', 'Free developer token + your OAuth', 'Monthly search volume, CPC and competition — per country'],
    ['DataForSEO / Semrush / Moz / Ahrefs', 'Paid credential', 'Volume, difficulty, live Google positions, complete backlink counts'],
    ['Azure OpenAI', 'Your key', 'Assistant prompts, drafted edits, written rationale — never a measurement'],
  ],
  [26, 24, 50],
));

children.push(h2('Sampled — real, but bounded'));
children.push(p('Genuinely measured, but from a bounded sample rather than an exhaustive index. Every one is labelled, and the bound is stated on the table it appears in.'));
children.push(table(
  ['Signal', 'How it is obtained', 'How it is labelled'],
  [
    ['Google autocomplete', 'Keyless, country-aware', 'Suggestion rank, never a volume'],
    ['A second suggestion index', 'Keyless', 'Alternative phrasings from a different index — verified to return terms Google\'s does not'],
    ['Google Trends', 'Keyless, per country', '**Relative interest 0–100** in its own column. The shape of demand, not its size, and it cannot be converted into one'],
    ['Result-page sample', 'Keyless, country-aware', 'Explicitly **not Google**. Drives the difficulty proxy, the keyword gap and review-platform detection'],
    ['Keyword difficulty proxy', 'Computed from that sample', 'Labelled "proxy" everywhere, with the formula and every component shown'],
    ['Referring domains', 'Candidates found by search, then **each page fetched and its links read**', 'A verified sample — a floor, not a total. Only domains with a real link are counted'],
    ['Reddit, Hacker News, news RSS', 'Keyless, tiered, block-aware', 'Which tier answered is reported; a failed source is reported as failed'],
  ],
  [22, 34, 44],
));

children.push(h2('Not available — and stated as such'));
children.push(p('Where no source can answer, the platform says so on the page rather than estimating.'));
children.push(bullet('**Competitor organic traffic estimates.** No source. Not shown, not approximated.'));
children.push(bullet('**Actual AI citation share** — whether ChatGPT genuinely cited the brand. Needs a citation-tracking credential. What *is* measured is whether each engine can read and quote the site, which is a real component of it and is labelled as a readiness comparison rather than a citation count.'));
children.push(bullet('**True rank tracking.** Search Console\'s average position is a blended national figure across devices, not a fixed-location rank. Stated wherever position appears.'));

children.push(spacer());
children.push(callout(
  'The practical consequence',
  'A practitioner who knows the basis of a number can act on it. A fabricated Domain Authority is indistinguishable on screen from a '
  + 'real one once it reaches a client report — and the person who has to defend it in a meeting is the one who did not fabricate it. '
  + 'Every result page therefore carries a provenance block naming the sources it used **and the questions it could not answer**.',
));

// =========================================================================
children.push(h1('8. Operating the platform'));

children.push(h2('What runs on its own'));
children.push(table(
  ['Job', 'Frequency', 'What it does'],
  [
    ['Data sync', 'Nightly', 'Pulls Search Console, GA4, PageSpeed and uptime into the consolidated tables'],
    ['Alert evaluation', 'Per the alert schedule', 'Runs every enabled subscription, opens tasks, sends one digest per brand per channel'],
    ['Weekly reports', 'Weekly', 'Generates and stores the per-brand report'],
    ['Backups', 'Scheduled', 'Consistent database snapshots — not file copies, which can capture a torn state'],
    ['AI SEO tracking sweep', 'Daily, one brand per tick', 'The 21-check board'],
    ['Reputation sweep', 'Daily, one brand per tick', 'Mention scan and sentiment'],
    ['Freshness sweep', 'Weekly, one brand per tick', 'Decay and intent drift'],
    ['Assignment digests', 'Batched', 'One email per person however many tasks they were given'],
  ],
  [26, 22, 52],
));

children.push(spacer());
children.push(callout(
  'One setup step fails silently if skipped',
  'The scheduled jobs run through a cron endpoint rather than an in-process timer. On shared hosting the application is started on the '
  + 'first request and **stopped again once idle**, so a timer set for 03:20 belongs to a process that was killed at 23:10 — nothing '
  + 'errors, the alerts simply never fire, and the dashboard still looks fine. If the cron job is not configured, alerts, the nightly '
  + 'sync, weekly reports and backups never run. A built-in doctor command checks for exactly this.',
  'FBF7EF', AMBER,
));

children.push(h2('How the AI SEO analyses run'));
children.push(bullet('Each analysis is a **background run**: the page hands you a result URL immediately and polls until the work finishes. Crawls take minutes; nothing is held open in a request.'));
children.push(bullet('Two may run at once. Each one crawls, and concurrency is what gets a process killed on a small memory allowance.'));
children.push(bullet('An interrupted run is detected and reported as interrupted, rather than polling forever against a row nothing is working on.'));
children.push(bullet('The scheduled sweeps run with **AI assistance off**, so an unattended job cannot exhaust the spend cap before anyone has read a finding.'));
children.push(bullet('With N brands, each scheduled sweep reaches a given brand every N days by default. A brand needing daily monitoring gets its own cron line.'));

children.push(h2('Spend control'));
children.push(p(
  'Every AI call is logged against a shared cap and cached on its inputs. The AI is used for prompts, drafted edits and written '
  + 'rationale — never for a score, a similarity, a density or a drift figure. A number that moved because a model felt different '
  + 'today could not be explained to a client, alerted on, or trusted.',
));

// =========================================================================
children.push(h1('9. Limits, and what a credential unlocks'));

children.push(p(
  'These are stated on the affected pages as well as here. Each is a configuration change rather than a rewrite — the adapters exist '
  + 'and activate on an environment variable.',
));

children.push(table(
  ['Limit today', 'What it affects', 'What removes it'],
  [
    ['No measured search volume', 'The volume column in keyword research shows Search Console impressions and Trends relative interest instead', '**Google Ads Keyword Planner** — a free developer token on the Google connection you already have. This is the cheapest and highest-value upgrade available'],
    ['Keyword difficulty is a proxy', 'Difficulty is computed from a non-Google result sample, with its formula shown', 'DataForSEO or Semrush — replaces it with a measured KD'],
    ['Positions read from a non-Google sample', 'The competitive keyword gap compares visibility on a non-Google index', 'DataForSEO — replaces the sample with live Google result pages'],
    ['Referring domains are a verified sample', 'Backlink counts are accurate floors rather than totals', 'Moz — complete referring-domain and backlink counts, plus Domain Authority'],
    ['No competitor traffic estimate', 'Not shown at all', 'Semrush'],
    ['No AI citation tracking', 'Readiness is measured; actual citation share is not', 'A citation-tracking credential'],
    ['Reddit is rate-limited', 'Works without a credential, but rate-limited, without post scores, and without comment threads', 'A free "script" app at reddit.com/prefs/apps — removes all three limits'],
    ['No true rank tracking', 'Average position is a blended national figure', 'Importing a dedicated rank tracker\'s export — on the workflow backlog'],
    ['URL Inspection is quota-limited', 'The deindexation alert samples top pages rather than checking every page', 'Nothing — this is a Google quota (~2,000 calls/day/property)'],
  ],
  [26, 36, 38],
));

children.push(spacer());
children.push(p(
  '**The order to address these in, if budget is limited:** Google Ads Keyword Planner first — it is free beyond a token application '
  + 'and it converts the largest labelled gap in the platform into measured data. Then a Reddit script app, which is also free. Only '
  + 'then consider a paid credential, and DataForSEO before the others, because it resolves three limits at once.',
));

// =========================================================================
children.push(h1('10. Recent improvements'));

children.push(p(
  'The most recent release closed a set of gaps the SEO team raised. They are summarised here because several change how an existing '
  + 'screen should be read; a row-by-row account of each requirement and what was done about it is in the accompanying CSV, '
  + '`reports/ai-seo-findings-fixes.csv`.',
));

children.push(h2('New capabilities'));
children.push(table(
  ['Area', 'What is now available'],
  [
    ['Keyword research', 'Search volume through an adapter chain (Google Ads Keyword Planner first), keyword difficulty, a country filter reaching every geo-aware source, an alphabet sweep of autocomplete, and a second suggestion index'],
    ['On-page score', 'Heading-hierarchy validation and keyword-stuffing detection as scored components, with an over-optimisation penalty'],
    ['Schema', 'Page-type classification before generation, and complete ready-to-paste blocks per type plus a combined @graph'],
    ['AI-crawler readiness', 'A whole-site mode against an explicit eight-point checklist, alongside the existing single-page report'],
    ['Internal linking', 'A target-first view: one URL in, and the pages that should link to it out — with verbatim anchors and a CSV export'],
    ['Competitive intelligence', 'A topic coverage matrix, a keyword gap table and a backlink gap table'],
    ['Reputation', 'Review platform coverage: which platforms have a profile for the brand and which do not, weighted by consequence'],
    ['Tracking board', 'A sitewide scope, and a dedicated broken-page check covering 4xx, 5xx and soft 404s with their inbound internal links'],
  ],
  [26, 74],
));

children.push(h2('Corrections that change how a number should be read'));
children.push(p('Three of the changes were fixes to figures that were previously wrong or misleading. If you have historical exports, these are the ones worth knowing about.'));

children.push(bullet(
  '**Referring domains will have moved.** The previous figure counted pages that *mentioned* a domain — a page typing "example.com" '
  + 'in running text counted the same as one linking to it. Every candidate page is now fetched and its outbound links read, so only '
  + 'real links count. Mentions without a link now have their own column, and are useful in their own right.',
));
children.push(bullet(
  '**Content metrics will have moved.** Readability, entity density, keyword density and semantic coverage were being computed over '
  + 'the navigation, header, footer and cookie banner wherever no main-content container could be identified. They now exclude the '
  + 'template, and the result page shows the word count they were actually computed on alongside the page\'s total.',
));
children.push(bullet(
  '**Gap lists are shorter and more useful.** A competitor\'s own brand name is structurally the entity most certain to appear on '
  + 'their pages and not on yours, so it previously topped every gap list — the report was, in effect, recommending that the client '
  + 'write about their rivals. Competitor brands, generic button and section labels, and template text are now suppressed, and what '
  + 'was suppressed is listed with its reason so the filter can be audited.',
));

children.push(spacer());
children.push(callout(
  'Two of these were found by testing against live sites, not by review',
  'The link finder\'s first version returned six recommendations for one site that were all the same anchor inside the same sitewide '
  + 'banner — a feature block in a plain div with no navigation or template class on it, which no selector list would ever have caught. '
  + 'It needed cross-page repetition detection, which in turn needed the template detector taught to read list items as whole units. '
  + 'The keyword-stuffing detector had a similar issue: its original single-tenth window scored an obviously front-loaded block as '
  + 'evenly distributed. Both now have regression tests asserting the specific failure.',
));

// =========================================================================
children.push(h1('Appendix A — The 21 tracking checks'));
children.push(p('Each runs on the tracking board with its own metrics and history. Sitewide-capable checks receive the full URL set when the sweep is run in sitewide scope; the rest use the sample.'));

children.push(table(
  ['Group', 'Checks'],
  [
    ['Crawlability & indexation', 'Crawl errors · **Broken pages, sitewide** (4xx, 5xx, soft 404, unreachable — with the internal links pointing at each) · robots.txt changes · Sitemap health · Index coverage'],
    ['Performance & Core Web Vitals', 'Core Web Vitals · Time to first byte · Page load'],
    ['Security', 'SSL certificate and security headers'],
    ['URL & canonical health', 'Redirect chains · Canonicalisation · URL structure'],
    ['On-page elements', 'Titles and meta descriptions · Heading structure'],
    ['Content quality', 'Content quality and cannibalisation'],
    ['Internal linking', 'Internal linking'],
    ['Images', 'Image optimisation and alt text'],
    ['Structured data', 'Structured data'],
    ['Rendering', 'JavaScript rendering · Mobile usability'],
    ['AI retrieval', 'AI crawler access'],
  ],
  [30, 70],
));

children.push(h1('Appendix B — The 46 alert types'));
children.push(p('Each is individually subscribable per brand with its own threshold, and each can open a task automatically.'));

children.push(table(
  ['Group', 'Count', 'Examples of what it catches'],
  [
    ['Keywords & rankings', '7', 'Position drops, lost keywords, cannibalisation, striking-distance movement'],
    ['Traffic & visibility', '6', 'Click and impression declines against the prior period, at site and page level'],
    ['AI SEO suite', '6', 'New critical findings, score regressions, and a stale-sweep alert that fires when the monitoring itself stops'],
    ['Landing pages', '5', 'Top pages losing traffic, new pages failing to gain it'],
    ['Engagement & conversions', '5', 'Conversion and engagement declines from GA4'],
    ['Technical audit', '4', 'New broken links, title and meta regressions, crawl errors'],
    ['Indexation', '4', 'Deindexed pages, coverage drops, sitemap errors'],
    ['Core Web Vitals', '4', 'Field-data regressions on LCP, INP and CLS'],
    ['Availability', '3', 'Uptime failures, certificate expiry, server errors'],
    ['Data health', '2', 'Sync failures and stale data — so a silent pipeline is itself an alert'],
  ],
  [26, 10, 64],
));

children.push(h1('Appendix C — How the platform is verified'));

children.push(p(
  'The platform ships with executable verification suites rather than a claim of correctness. They assert against real inputs — '
  + 'real HTML, real robots.txt rules, real schema, live network calls — rather than mocking the thing being tested.',
));

children.push(table(
  ['Suite', 'Checks', 'What it covers'],
  [
    ['verify_aiseo.js', '82', 'Text measurement, HTML parsing, robots matching, schema validation, scoring, the Reddit tier chain, provider honesty, the run store, and live network calls'],
    ['verify_gaps.js', '57', 'Country resolution, boilerplate exclusion, heading hierarchy, keyword stuffing, page-type classification, schema generation, the verbatim-anchor rule, site-readiness checks, the gap analyses, the difficulty proxy, and review-platform relevance'],
    ['verify_links.js, verify_pages.js, verify_actions.js, verify_team.js and others', '—', 'Internal linking, page rendering, task actions, team and assignment behaviour'],
  ],
  [26, 10, 64],
));

children.push(spacer());
children.push(p(
  'Both AI SEO suites run in two modes: deterministic checks only, or with `--full` to add live crawling and network calls. '
  + 'They are run with the server stopped, because the database engine used on shared hosting is single-writer.',
));

children.push(spacer(240));
children.push(callout(
  'What to take away',
  'The platform\'s value is not that it produces more numbers than the tools it replaces. It is that every number it produces is '
  + 'traceable to a source, that findings become assigned work rather than documents, and that nothing which could damage a site can '
  + 'be executed without a person signing it off. Where something cannot be known, it says so — which is the property that makes the '
  + 'rest of it usable in front of a client.',
));

// =========================================================================
// BUILD
// =========================================================================

const doc = new Document({
  creator: 'SEO Automation Suite',
  title: 'SEO Automation Suite — Platform Overview',
  description: 'What every feature does, how it reaches its numbers, and what you get out of it',
  numbering: {
    config: [{
      reference: 'steps',
      levels: [{
        level: 0,
        format: 'decimal',
        text: '%1.',
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    }],
  },
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20 }, paragraph: { spacing: { line: 276 } } },
    },
  },
  sections: [{
    properties: {
      page: {
        // Kept in step with CONTENT_WIDTH above — changing one without the
        // other produces tables wider or narrower than the text column.
        margin: {
          top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN,
        },
      },
    },
    children,
  }],
});

const outDir = path.join(__dirname, 'reports');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'SEO-Platform-Overview.docx');

// The document is routinely open in Word or Google Drive while it is being
// regenerated, and Windows holds an exclusive lock on an open .docx. Failing
// the whole build for that is useless — so a locked target falls back to a
// suffixed filename beside it and says so loudly, rather than either crashing
// or silently writing nowhere.
function writeDoc(buf) {
  try {
    fs.writeFileSync(outFile, buf);
    return { path: outFile, fallback: false };
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
    const alt = outFile.replace(/\.docx$/, `-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.docx`);
    fs.writeFileSync(alt, buf);
    return { path: alt, fallback: true, reason: err.code };
  }
}

Packer.toBuffer(doc).then((buf) => {
  const out = writeDoc(buf);
  const paras = children.filter((c) => c instanceof Paragraph).length;
  const tables = children.filter((c) => c instanceof Table).length;
  console.log(`wrote ${out.path}`);
  console.log(`${(buf.length / 1024).toFixed(0)} KB · ${children.length} blocks (${paras} paragraphs, ${tables} tables/callouts)`);
  if (out.fallback) {
    console.log('');
    console.log(`NOTE: ${outFile} is locked (${out.reason}) — it is open in Word or syncing.`);
    console.log('      Close it, delete it, and rename the file above over it.');
  }
}).catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
