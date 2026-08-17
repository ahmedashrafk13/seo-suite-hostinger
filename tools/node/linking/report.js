// Deliverables: five styled .xlsx workbooks, two JSON files and the Word report.
//
// Ported from write_xlsx() in internal_link_agent.py and build_docx() in
// docx_report.py. openpyxl is replaced by exceljs and python-docx by the `docx`
// package, both already dependencies of the app.
//
// The COLUMN ORDER and the sheet filenames are contractual: src/lib/csvStore.js
// reads these workbooks by filename and addresses cells by header name, and the
// UI's table definitions name the same keys. A renamed column silently produces
// an empty column in the dashboard rather than an error.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType,
} = require('docx');

// --- xlsx ------------------------------------------------------------------
// A formatted header row, frozen panes and auto-filter — the styling the team
// gets instead of a broken-looking flat file.
async function writeXlsx(filePath, rows, columns) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Internal Linking Agent';
  const ws = wb.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = columns.map((c) => ({
    header: c,
    key: c,
    // Wide free-text columns get more room; everything else stays compact.
    width: ['context_sentence', 'reason', 'recommendation', 'evidence', 'anchor_text',
      'source_url', 'target_url', 'url', 'page_a', 'page_b', 'title', 'title_a', 'title_b',
      'linked_from'].includes(c) ? 46 : 16,
  }));

  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).height = 20;

  rows.forEach((row) => {
    const out = {};
    // extrasaction="ignore": only the declared columns are written, and a
    // missing key becomes an empty cell rather than throwing.
    columns.forEach((c) => {
      const v = row[c];
      if (v === undefined || v === null) out[c] = '';
      else if (Array.isArray(v)) out[c] = v.join(', ');
      else if (v instanceof Set) out[c] = Array.from(v).join(', ');
      else out[c] = v;
    });
    ws.addRow(out);
  });

  if (rows.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });

  await wb.xlsx.writeFile(filePath);
}

// --- Word report -----------------------------------------------------------
const NAVY = '1F3A5F';
const GREY = '5A6472';

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({
      text: String(text == null ? '' : text),
      size: opts.size || 20,
      bold: opts.bold || false,
      italics: opts.italics || false,
      color: opts.color || undefined,
    })],
    spacing: { after: opts.after === undefined ? 100 : opts.after },
  });
}

function cell(text, { bold = false, header = false, width } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: header
      ? { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' }
      : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({
      children: [new TextRun({
        text: String(text == null ? '' : text),
        bold: bold || header,
        size: 18,
        color: header ? 'FFFFFF' : undefined,
      })],
    })],
  });
}

function table(headers, rows, widths) {
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'D6DBE3' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border, bottom: border, left: border, right: border,
      insideHorizontal: border, insideVertical: border,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) => cell(h, { header: true, width: widths && widths[i] })),
      }),
      ...rows.map((r) => new TableRow({
        children: r.map((v, i) => cell(v, { width: widths && widths[i] })),
      })),
    ],
  });
}

const trunc = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

// The client-facing deliverable. The workbooks are what an SEO works from; this
// is the document that explains the findings, so it leads with what was found
// and what to do rather than with methodology.
async function buildDocx(filePath, ctx) {
  const {
    root, pages, recs, orphans, underlinked, cannibal, broken, nonContent,
    dupClusters, summary, cfg, elapsed, notes,
  } = ctx;

  const children = [];

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Internal Linking Audit', bold: true, size: 44, color: NAVY })],
    spacing: { after: 80 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: root, size: 24, color: GREY })],
    spacing: { after: 40 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({
      text: `${summary.pages_crawled} pages analysed · generated ${summary.generated_utc}`,
      size: 18,
      color: GREY,
    })],
    spacing: { after: 300 },
  }));

  // --- summary -------------------------------------------------------------
  children.push(heading('What was found'));
  children.push(table(
    ['Finding', 'Count'],
    [
      ['Pages analysed', summary.pages_crawled],
      ['Editorial internal links', summary.editorial_internal_links],
      ['Site-wide (nav/footer) links', summary.sitewide_internal_links],
      ['Orphan pages (no editorial inbound link)', summary.orphan_pages],
      ['Under-linked pages', summary.underlinked_pages],
      ['Keyword cannibalisation pairs', summary.cannibalization_pairs],
      ['Duplicate-content pairs', summary.duplicate_content_pairs],
      ['Broken internal links', summary.broken_internal_links],
      ['Link recommendations', summary.recommendations_total],
      ['  ready to paste in (verbatim anchor)', summary.recommendations_ready],
      ['  single-word anchor (verify context)', summary.recommendations_single_word_anchor],
      ['  need a new sentence written', summary.recommendations_need_new_copy],
    ].map(([a, b]) => [a, String(b)]),
    [70, 30]
  ));

  children.push(heading('How to read this report', HeadingLevel.HEADING_2));
  children.push(para(
    'Every recommendation below uses anchor text that ALREADY appears, word for word, in the '
    + 'source page\'s body copy. Nothing has to be written: the exact sentence and the character '
    + 'offset are given so the link can be placed and verified by hand. Recommendations marked '
    + '"needs-new-sentence" are the exception — those targets are relevant but no suitable phrase '
    + 'exists on the source page yet, so a sentence has to be written first.'
  ));

  if (notes && notes.length) {
    children.push(heading('Notes on this crawl', HeadingLevel.HEADING_2));
    notes.slice(0, 12).forEach((nText) => {
      children.push(new Paragraph({
        children: [new TextRun({ text: nText, size: 18, color: GREY })],
        bullet: { level: 0 },
        spacing: { after: 60 },
      }));
    });
  }

  // --- recommendations -----------------------------------------------------
  children.push(heading('Link recommendations'));
  if (!recs.length) {
    children.push(para('No defensible recommendations were produced for this crawl.', { italics: true }));
  } else {
    const ready = recs.filter((r) => r.confidence !== 'needs-new-sentence');
    const needCopy = recs.filter((r) => r.confidence === 'needs-new-sentence');

    if (ready.length) {
      children.push(heading(`Ready to implement (${ready.length})`, HeadingLevel.HEADING_2));
      // Capped: the workbook carries the full list, and a 3,000-row Word table
      // is unusable as a document.
      ready.slice(0, 120).forEach((r) => {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${r.priority}. `, bold: true, size: 20, color: NAVY }),
            new TextRun({ text: r.anchor_text, bold: true, size: 20 }),
            new TextRun({ text: `  (${r.confidence})`, size: 16, color: GREY }),
          ],
          spacing: { before: 140, after: 40 },
        }));
        children.push(para(`From:  ${r.source_url}`, { size: 17, color: GREY, after: 20 }));
        children.push(para(`To:    ${r.target_url}`, { size: 17, color: GREY, after: 20 }));
        if (r.context_sentence) {
          children.push(para(`Sentence: "${trunc(r.context_sentence, 400)}"`, { size: 17, italics: true, after: 20 }));
        }
        children.push(para(`Why: ${r.reason}`, { size: 16, color: GREY, after: 60 }));
      });
      if (ready.length > 120) {
        children.push(para(`… and ${ready.length - 120} more in recommendations.xlsx.`, { italics: true, color: GREY }));
      }
    }

    if (needCopy.length) {
      children.push(heading(`Relevant targets needing new copy (${needCopy.length})`, HeadingLevel.HEADING_2));
      children.push(para(
        'These pages are topically related but the source page contains no phrase that could '
        + 'honestly serve as anchor text. A sentence has to be written before a link can be added.'
      ));
      children.push(table(
        ['Link from', 'Link to', 'Suggested phrase'],
        needCopy.slice(0, 60).map((r) => [trunc(r.source_url, 60), trunc(r.target_url, 60), r.anchor_text]),
        [35, 35, 30]
      ));
    }
  }

  // --- orphans -------------------------------------------------------------
  children.push(heading('Orphan and under-linked pages'));
  if (!orphans.length && !underlinked.length) {
    children.push(para('No orphan or under-linked pages were found.', { italics: true }));
  } else {
    children.push(para(
      'An orphan page has no editorial (in-content) internal link pointing at it. Search engines '
      + 'reach it rarely, and it ranks poorly regardless of how good the content is.'
    ));
    children.push(table(
      ['Status', 'URL', 'Editorial in', 'Words'],
      [...orphans.map((o) => ['orphan', trunc(o.url, 70), String(o.inbound_editorial), String(o.word_count)]),
        ...underlinked.map((o) => ['under-linked', trunc(o.url, 70), String(o.inbound_editorial), String(o.word_count)])]
        .slice(0, 120),
      [15, 55, 15, 15]
    ));
  }

  // --- duplicates / cannibalisation ---------------------------------------
  if (dupClusters && dupClusters.length) {
    children.push(heading('Duplicate content'));
    children.push(para(
      'These URL groups serve substantially the same copy. Each group needs ONE canonical URL; '
      + 'the rest should 301 or rel=canonical to it — unless the cause is a rendering problem, '
      + 'which the evidence column in cannibalization.xlsx will say explicitly.'
    ));
    dupClusters.slice(0, 20).forEach((cl, i) => {
      children.push(para(`Group ${i + 1} — ${cl.length} URLs serving the same content:`, { bold: true, after: 40 }));
      cl.slice(0, 12).forEach((u) => {
        children.push(new Paragraph({
          children: [new TextRun({ text: u, size: 17, color: GREY })],
          bullet: { level: 0 },
          spacing: { after: 20 },
        }));
      });
    });
  }

  const rivalry = cannibal.filter((c) => c.severity === 'high' || c.severity === 'medium');
  if (rivalry.length) {
    children.push(heading('Keyword cannibalisation'));
    children.push(para(
      'These page pairs compete for the same keyword. Ranking signals split between them and '
      + 'Google picks one — often the weaker page.'
    ));
    children.push(table(
      ['Severity', 'Shared keyword', 'Page A', 'Page B'],
      rivalry.slice(0, 60).map((c) => [c.severity, c.shared_keyword, trunc(c.page_a, 55), trunc(c.page_b, 55)]),
      [12, 24, 32, 32]
    ));
  }

  // --- broken links --------------------------------------------------------
  const realBroken = broken.filter((b) => b.classification === 'broken link' && b.referring_pages);
  if (realBroken.length) {
    children.push(heading('Broken internal links'));
    children.push(table(
      ['Status', 'Broken URL', 'Linked from'],
      realBroken.slice(0, 80).map((b) => [String(b.status), trunc(b.url, 60), trunc(b.linked_from, 60)]),
      [12, 44, 44]
    ));
  }

  // --- excluded pages ------------------------------------------------------
  if (nonContent && nonContent.length) {
    children.push(heading('Pages excluded from recommendations'));
    children.push(para(
      'Pagination, tag/category archives, search results and feeds are real pages but not '
      + 'editorial content. They are crawled (they are how articles are discovered) and their '
      + 'links still count, but they are never recommended as link targets and never reported '
      + 'as orphans — an archive page cannot be "fixed" by adding a contextual link to it.'
    ));
    children.push(table(
      ['Kind', 'URL', 'Words'],
      nonContent.slice(0, 60).map((r) => [r.kind, trunc(r.url, 70), String(r.word_count)]),
      [15, 70, 15]
    ));
  }

  // --- method --------------------------------------------------------------
  children.push(heading('Method and limits'));
  children.push(para(
    `${summary.pages_crawled} pages were crawled in ${Math.round(elapsed)}s. Body copy was `
    + 'separated from navigation, headers, footers and template furniture; a link counts as '
    + '"editorial" only when it physically sits inside surviving body copy. Pages were compared '
    + 'by TF-IDF cosine similarity over that copy, boosted by title, H1 and URL slug.'
  ));
  if (summary.discovered_but_unfetched > 0) {
    children.push(para(
      `${summary.discovered_but_unfetched} discovered URL(s) were not fetched because the `
      + `${cfg.max_pages}-page budget ran out, so orphan status is provisional: a page reported `
      + 'as an orphan may be linked from a page that was never crawled. Re-run with a higher '
      + 'page budget for a definitive answer.',
      { color: GREY }
    ));
  }

  const doc = new Document({
    creator: 'Internal Linking Agent',
    title: `Internal Linking Audit — ${root}`,
    styles: {
      default: {
        heading1: { run: { size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 300, after: 120 } } },
        heading2: { run: { size: 24, bold: true, color: NAVY }, paragraph: { spacing: { before: 200, after: 100 } } },
      },
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
}

module.exports = { writeXlsx, buildDocx };
