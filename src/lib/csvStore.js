// Access to the artifacts the Python tools write to disk.
//
// The internal linking agent writes a report directory per run containing a
// .docx plus five styled .xlsx workbooks and two JSON files. Those workbooks
// are the genuinely useful output — the .docx is for clients, the xlsx files
// are what an SEO actually works from — so this module reads them on demand
// and hands them to the UI as sortable, filterable, paginated tables, with
// the raw file still downloadable.
//
// They are read on demand rather than copied into SQLite because
// recommendations.xlsx can run to thousands of rows; the run row keeps the
// directory path and the summary only.
const fs = require('fs');
const path = require('path');
// SheetJS reads .xlsx synchronously (pure parsing, no I/O promises needed),
// which lets every existing sync call site (readTable/inventory and their
// callers across routes/linking.js, routes/performance.js, lib/contentBrief.js,
// lib/sync.js, lib/toolRunner.js) keep working unchanged now that the linking
// agent's five deliverables are styled .xlsx instead of plain CSV.
const XLSX = require('xlsx');

// The files the internal linking agent produces, with display metadata and the
// columns worth showing by default (the workbooks have up to 18 columns, most
// of which are diagnostic). These moved from plain CSV to styled .xlsx so the
// team gets a formatted header row, frozen panes and dropdowns instead of a
// broken-looking flat file.
const LINKING_FILES = [
  {
    file: 'recommendations.xlsx',
    key: 'recommendations',
    label: 'Link recommendations',
    description: 'Source page, target page and the exact anchor text to use — each anchor is text that already appears verbatim on the source page, so nothing has to be invented.',
    primary: true,
    columns: [
      { key: 'priority', label: '#', width: 'narrow' },
      { key: 'confidence', label: 'Confidence', width: 'narrow', badge: true },
      { key: 'source_url', label: 'Link from', url: true },
      { key: 'target_url', label: 'Link to', url: true },
      { key: 'anchor_text', label: 'Anchor text', emphasis: true },
      { key: 'context_sentence', label: 'Where it goes', wide: true },
      { key: 'similarity', label: 'Similarity', width: 'narrow', number: 3 },
      { key: 'reason', label: 'Why', wide: true },
    ],
  },
  {
    file: 'orphans.xlsx',
    key: 'orphans',
    label: 'Orphan & under-linked pages',
    description: 'Pages with no editorial internal links pointing at them, or too few. Orphans are crawled rarely and rank poorly regardless of content quality.',
    columns: [
      { key: 'status', label: 'Status', badge: true, width: 'narrow' },
      { key: 'url', label: 'URL', url: true },
      { key: 'title', label: 'Title' },
      { key: 'inbound_editorial', label: 'Editorial links in', width: 'narrow' },
      { key: 'inbound_boilerplate', label: 'Nav links in', width: 'narrow' },
      { key: 'word_count', label: 'Words', width: 'narrow' },
      { key: 'primary_keyword', label: 'Primary keyword' },
      { key: 'gsc_impressions', label: 'GSC impressions', width: 'narrow' },
    ],
  },
  {
    file: 'cannibalization.xlsx',
    key: 'cannibalization',
    label: 'Keyword cannibalisation',
    description: 'Pairs of pages competing for the same keyword. Ranking signals split between them and Google picks one, often the weaker.',
    columns: [
      { key: 'severity', label: 'Severity', badge: true, width: 'narrow' },
      { key: 'shared_keyword', label: 'Shared keyword', emphasis: true },
      { key: 'similarity', label: 'Similarity', width: 'narrow', number: 3 },
      { key: 'page_a', label: 'Page A', url: true },
      { key: 'page_b', label: 'Page B', url: true },
      { key: 'recommendation', label: 'Recommendation', wide: true },
    ],
  },
  {
    file: 'broken_links.xlsx',
    key: 'broken_links',
    label: 'Broken links',
    description: 'Link targets that returned an error during the crawl, with the pages that link to them.',
    columns: [
      { key: 'status', label: 'Status', badge: true, width: 'narrow' },
      { key: 'url', label: 'Broken URL', url: true },
      { key: 'classification', label: 'Type', width: 'narrow' },
      { key: 'linked_from', label: 'Linked from', url: true },
      { key: 'referring_pages', label: 'Referring pages', width: 'narrow' },
      { key: 'in_sitemap', label: 'In sitemap?', width: 'narrow' },
    ],
  },
  {
    file: 'non_editorial_pages.xlsx',
    key: 'non_editorial_pages',
    label: 'Non-editorial pages',
    description: 'Pages excluded from link recommendations because they are navigation, pagination, tag archives or otherwise not editorial content.',
    columns: [
      { key: 'kind', label: 'Kind', badge: true, width: 'narrow' },
      { key: 'url', label: 'URL', url: true },
      { key: 'title', label: 'Title' },
      { key: 'word_count', label: 'Words', width: 'narrow' },
      { key: 'inbound_editorial', label: 'Editorial links in', width: 'narrow' },
    ],
  },
];

const LINKING_BY_KEY = new Map(LINKING_FILES.map((f) => [f.key, f]));

// Runs completed before the CSV -> xlsx migration only have the old plain-CSV
// filename on disk (e.g. recommendations.csv, not recommendations.xlsx). Fall
// back to that legacy name rather than losing access to every pre-migration
// run's reports, and read it as CSV text rather than through the xlsx parser.
function resolveLinkingFile(outDir, def) {
  const xlsxPath = path.join(outDir, def.file);
  if (fs.existsSync(xlsxPath)) return { full: xlsxPath, legacy: false };
  const legacyName = def.file.replace(/\.xlsx$/, '.csv');
  const legacyPath = path.join(outDir, legacyName);
  if (fs.existsSync(legacyPath)) return { full: legacyPath, legacy: true };
  return null;
}

// Minimal CSV parser for legacy pre-migration files: handles quoted fields,
// embedded commas, and escaped quotes ("") — the same shape the old hand-
// rolled CSV writers produced.
function parseLegacyCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h).trim());
  const out = rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim().length))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; });
      return o;
    });
  return { headers, rows: out };
}

// ------------------------------------------------------------- xlsx parsing

// Reads the first worksheet of a styled .xlsx deliverable into the same
// { headers, rows } shape the old CSV parser produced, so every downstream
// consumer (table rendering, sort/filter/pagination, facet building) is
// unaffected by the CSV -> xlsx migration.
function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!grid.length) return { headers: [], rows: [] };
  const headers = grid[0].map((h) => String(h == null ? '' : h).trim());
  const out = grid.slice(1)
    .filter((r) => r.some((c) => String(c == null ? '' : c).trim().length))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; });
      return o;
    });
  return { headers, rows: out };
}

function readCsvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  // Guard against a pathological file eating all memory.
  if (stat.size > 40 * 1024 * 1024) {
    return { headers: [], rows: [], tooLarge: true, size: stat.size };
  }
  return { ...parseXlsx(fs.readFileSync(filePath)), size: stat.size };
}

// The linking crawler's full page inventory (every page it crawled, with
// word count, title, primary keyword, link counts) — not one of the five
// deliverable CSVs, so it isn't in LINKING_FILES, but it's the only place a
// real word-count baseline or topical-overlap signal can come from without
// an external crawl. Read on demand, same reasoning as the CSVs: it can run
// to hundreds of pages and isn't worth duplicating into SQLite.
function readCrawlData(outDir) {
  if (!outDir) return [];
  const p = path.join(outDir, 'crawl_data.json');
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ---------------------------------------------------- linking run artifacts

// What the run directory actually contains, so the UI shows real tabs rather
// than tabs that 404.
function inventory(outDir) {
  if (!outDir || !fs.existsSync(outDir)) return { exists: false, files: [] };
  const present = new Set(fs.readdirSync(outDir));
  const files = LINKING_FILES
    .map((f) => ({ f, resolved: resolveLinkingFile(outDir, f) }))
    .filter(({ resolved }) => resolved)
    .map(({ f, resolved }) => {
      const { full, legacy } = resolved;
      // Cheap row count: read once and count, since these are already parsed
      // whenever the tab is opened anyway.
      let rowCount = 0;
      try {
        const parsed = legacy ? parseLegacyCsv(fs.readFileSync(full, 'utf8')) : readCsvFile(full);
        rowCount = Math.max(0, (parsed || { rows: [] }).rows.length);
      } catch { rowCount = 0; }
      // Override `file` with the name actually on disk so download links (built
      // from this value in the view) resolve to the real legacy .csv rather
      // than a .xlsx name that doesn't exist for pre-migration runs.
      return { ...f, file: path.basename(full), legacy, rowCount, size: fs.statSync(full).size };
    });

  const docx = [...present].filter((n) => n.endsWith('.docx') || n.endsWith('.rtf'));
  return {
    exists: true,
    outDir,
    files,
    docx: docx.length ? path.join(outDir, docx[0]) : null,
    docxName: docx[0] || null,
    hasCrawlData: present.has('crawl_data.json'),
    hasSummary: present.has('summary.json'),
  };
}

// Reads one CSV with search / sort / pagination applied server-side, so a
// 5 000-row recommendations file does not have to be shipped to the browser.
function readTable(outDir, key, { search = '', sort = '', dir = 'asc', page = 1, perPage = 50, filters = {} } = {}) {
  const def = LINKING_BY_KEY.get(key);
  if (!def || !outDir) return null;
  const resolved = resolveLinkingFile(outDir, def);
  if (!resolved) return null;
  const parsed = resolved.legacy
    ? { ...parseLegacyCsv(fs.readFileSync(resolved.full, 'utf8')), size: fs.statSync(resolved.full).size }
    : readCsvFile(resolved.full);
  if (!parsed) return null;
  if (parsed.tooLarge) return { def, tooLarge: true, size: parsed.size, rows: [], total: 0 };

  let rows = parsed.rows;

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
  }

  Object.entries(filters).forEach(([col, val]) => {
    if (!val) return;
    rows = rows.filter((r) => String(r[col] || '').toLowerCase() === String(val).toLowerCase());
  });

  if (sort && parsed.headers.includes(sort)) {
    const numeric = rows.every((r) => r[sort] === '' || !Number.isNaN(Number(r[sort])));
    rows = [...rows].sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      const cmp = numeric ? (Number(x || 0) - Number(y || 0)) : String(x).localeCompare(String(y));
      return dir === 'desc' ? -cmp : cmp;
    });
  }

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const slice = rows.slice((current - 1) * perPage, current * perPage);

  // Distinct values for the low-cardinality columns, to drive filter dropdowns.
  const facets = {};
  ['confidence', 'status', 'severity', 'kind', 'classification', 'in_sitemap'].forEach((col) => {
    if (!parsed.headers.includes(col)) return;
    const vals = [...new Set(parsed.rows.map((r) => r[col]).filter(Boolean))];
    if (vals.length > 1 && vals.length <= 12) facets[col] = vals.sort();
  });

  return {
    def, headers: parsed.headers, rows: slice, total, page: current, pages, perPage,
    facets, search, sort, dir,
  };
}

function summary(outDir) {
  if (!outDir) return null;
  const p = path.join(outDir, 'summary.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Path resolution for downloads, with a containment check so a crafted
// filename cannot walk out of the run directory.
function resolveDownload(outDir, filename) {
  if (!outDir) return null;
  const base = path.resolve(outDir);
  const target = path.resolve(base, filename);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return target;
}

// ----------------------------------------------------- audit run findings

// Normalises the technical audit JSON into the deliverable shape asked for:
// severity, affected URL, issue type, recommended action.
const AUDIT_ACTIONS = {
  dup_titles: 'Give each page a unique title that describes that page specifically. Duplicate titles make Google choose between near-identical pages.',
  dup_meta: 'Write a unique meta description per page. Duplicates are usually a template writing the same text everywhere.',
  dup_content: 'Consolidate or differentiate the duplicated pages. Decide which URL should rank before adding canonicals — canonical changes need SEO approval.',
  missing_title: 'Add a title tag. A page with no title has Google invent one from the content, which almost always performs worse.',
  missing_h1: 'Add a single H1 that states what the page is about, using the wording searchers actually use.',
  multiple_h1: 'Keep one H1 per page and demote the rest to H2/H3 so the heading hierarchy reflects the content structure.',
  low_word_count: 'Either expand the page so it genuinely answers the query, or remove it and redirect if it serves no purpose. Removals and redirects need SEO approval.',
  text_ratio: 'Reduce template and script weight relative to content, or add substantive content to the page.',
  missing_alt: 'Add descriptive alt text to every content image. This is both an accessibility requirement and how images get found in search.',
  broken_links: 'Fix or remove each broken link. Update the target where the destination moved, and drop the link where it is genuinely gone.',
  broken_internal: 'Fix internal links pointing at dead URLs — these waste crawl budget and leak internal link equity.',
  broken_external: 'Update or remove links to external pages that no longer exist.',
  redirect_chains: 'Point each link directly at the final destination so there is a single hop. Chains slow crawling and dilute signals.',
  non_indexable: 'Confirm each non-indexable page is meant to be excluded. If a page should rank, remove the noindex or robots block — robots.txt changes need SEO approval.',
  canonical: 'Review each canonical tag. Every indexable page should normally canonicalise to itself; cross-page canonicals must be deliberate. Canonical edits need SEO approval.',
  slow_pages: 'Profile the slowest pages in PageSpeed Insights and address the largest opportunities — usually images, render-blocking resources and server response time.',
  orphans: 'Add editorial internal links to each orphan page from topically related content. Use the internal linking report to find the best sources and anchor text.',
  viewport: 'Add a viewport meta tag so the page renders correctly on mobile.',
  charset: 'Declare the character set in the document head to prevent encoding problems.',
  doctype: 'Add a doctype declaration so browsers do not fall back to quirks mode.',
  empty_anchor: 'Give every link visible, descriptive anchor text — or an aria-label where the link is an icon.',
  nondesc_anchor: 'Replace "click here" and "read more" with anchor text that describes the destination.',
  hsts: 'Enable HSTS so browsers only ever connect over HTTPS.',
  sitemap: 'Fix the sitemap so it lists only canonical, indexable, 200-status URLs. Sitemap changes need SEO approval.',
  robots: 'Review robots.txt. Confirm nothing important is disallowed and the sitemap is declared. Changes need SEO approval.',
};

const TIER_TO_SEVERITY = { error: 'critical', warning: 'high', notice: 'medium', info: 'low', passed: 'info' };

function normaliseAuditFindings(jsonResult) {
  let parsed;
  try { parsed = typeof jsonResult === 'string' ? JSON.parse(jsonResult) : jsonResult; } catch { return null; }
  if (!parsed || !Array.isArray(parsed.findings)) return null;

  const actionFor = (f) => {
    if (AUDIT_ACTIONS[f.id]) return AUDIT_ACTIONS[f.id];
    // Fall back on a keyword match so a new check id still gets useful advice.
    const key = Object.keys(AUDIT_ACTIONS).find((k) => f.id.includes(k.split('_')[0]));
    return key ? AUDIT_ACTIONS[key] : 'Review the affected URLs in the full audit report and address the issue described.';
  };

  const rank = { critical: 1, high: 2, medium: 3, low: 4, info: 5 };

  const findings = parsed.findings.map((f) => {
    const severity = TIER_TO_SEVERITY[f.display] || 'medium';
    const items = (f.items || []).map((i) => {
      if (typeof i === 'string') return { url: i, note: null };
      return { url: i.url || i.page || i.link || null, note: i.note || i.detail || i.status || i.title || null, raw: i };
    });
    return {
      id: f.id,
      issue: f.name,
      tier: f.display,
      severity,
      passed: f.display === 'passed' || (f.failed || 0) === 0,
      failed: f.failed || 0,
      total: f.total || 0,
      unit: f.unit || 'pages',
      summary: f.summary || '',
      action: actionFor(f),
      items,
    };
  });

  const failing = findings.filter((f) => !f.passed)
    .sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.failed - a.failed));
  const passing = findings.filter((f) => f.passed);

  const bySeverity = {};
  ['critical', 'high', 'medium', 'low', 'info'].forEach((s) => {
    bySeverity[s] = failing.filter((f) => f.severity === s).length;
  });

  return {
    site: parsed.site,
    health: parsed.site_health,
    pagesCrawled: parsed.pages_crawled,
    pagesOk: parsed.pages_ok,
    linksChecked: parsed.links_checked,
    externalChecked: parsed.external_checked,
    resourcesChecked: parsed.resources_checked,
    rendered: parsed.rendered,
    contentWarning: parsed.content_warning,
    counts: parsed.counts || {},
    bySeverity,
    failing,
    passing,
    totalIssueInstances: failing.reduce((a, f) => a + f.failed, 0),
  };
}

module.exports = {
  LINKING_FILES, LINKING_BY_KEY, parseXlsx, readCsvFile,
  inventory, readTable, readCrawlData, summary, resolveDownload,
  normaliseAuditFindings, AUDIT_ACTIONS, TIER_TO_SEVERITY,
};
