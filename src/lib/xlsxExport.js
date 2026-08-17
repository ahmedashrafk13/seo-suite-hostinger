// Shared helper for producing professional, styled .xlsx deliverables.
//
// Every generated spreadsheet in this app goes through here so the SEO team
// gets a consistent, genuinely usable file: a bold styled header row, frozen
// header, sane column widths, and dropdown validation on enum-like columns —
// instead of a plain CSV with a multi-line blob crammed into one cell.
const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const MAX_COL_WIDTH = 60;
const MIN_COL_WIDTH = 10;

// sheets: [{ name, columns: [{ header, key, width?, dropdown? }], rows: [obj] }]
function buildWorkbook({ sheets }) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  sheets.forEach((sheetDef) => {
    const ws = wb.addWorksheet(sheetDef.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    ws.columns = sheetDef.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || estimateWidth(c, sheetDef.rows),
    }));

    // Header styling.
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
    });
    headerRow.height = 20;

    (sheetDef.rows || []).forEach((row) => {
      ws.addRow(row);
    });

    // Dropdown validation for enum-like columns.
    sheetDef.columns.forEach((c, idx) => {
      if (!c.dropdown || !c.dropdown.length) return;
      const colLetter = ws.getColumn(idx + 1).letter;
      const formulaList = `"${c.dropdown.join(',')}"`;
      const lastRow = Math.max(2, (sheetDef.rows || []).length + 1);
      for (let r = 2; r <= lastRow; r += 1) {
        ws.getCell(`${colLetter}${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [formulaList],
          showErrorMessage: true,
          errorTitle: 'Invalid value',
          error: `Must be one of: ${c.dropdown.join(', ')}`,
        };
      }
    });
  });

  return wb;
}

function estimateWidth(col, rows) {
  let max = String(col.header || '').length;
  (rows || []).forEach((r) => {
    const v = r[col.key];
    const len = v == null ? 0 : String(v).length;
    if (len > max) max = len;
  });
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, max + 2));
}

async function sendWorkbook(res, workbook, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { buildWorkbook, sendWorkbook };
