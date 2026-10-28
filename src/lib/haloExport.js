// ============================================================
// Amazon Halo: download every uploaded sheet.
//
// Halo keeps the PARSED rows of each upload, not the original file, so these are
// rebuilt workbooks with the same data: one .xlsx per dataset, grouped in a
// folder per brand, inside a single .zip (a browser can't hand over a folder).
// Same layout as the offline export: a Metrics sheet (one row per period, one
// column per metric), Keywords / Keyword ranks / Product revenue when the upload
// had them, and an "About this upload" sheet.
//
// Only what the caller can already read is exported: rows come through
// getHaloRows, so the database's own access rules apply.
// ============================================================

import { getHaloRows } from './haloApi';

const GRAN_LABEL = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
const safe = (s) => String(s || 'Unnamed').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

function flat(rows, field, label) {
  const out = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r[field] || {})) {
      out.push({ date: r.date, [label]: k, value: typeof v === 'object' ? JSON.stringify(v) : v });
    }
  }
  return out;
}

function datasetWorkbook(XLSX, brandName, ds, rows) {
  const wb = XLSX.utils.book_new();
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.metrics || {})))].sort();
  const main = rows.map((r) => ({
    date: r.date,
    period_label: r.periodLabel || '',
    ...Object.fromEntries(keys.map((k) => [k, r.metrics?.[k] ?? ''])),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(main), 'Metrics');
  for (const [name, field, label] of [['Keywords', 'keywords', 'keyword'], ['Keyword ranks', 'keywordRanks', 'keyword'], ['Product revenue', 'productRevenue', 'product']]) {
    const data = flat(rows, field, label);
    if (data.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Brand', brandName],
    ['Sheet', GRAN_LABEL[ds.granularity] || ds.granularity || ''],
    ['Original file name', ds.source_filename || ''],
    ['Period', `${ds.period_start} → ${ds.period_end}`],
    ['Rows', rows.length],
    ['Currency', ds.currency || '$'],
    ['Uploaded', String(ds.created_at || '').slice(0, 10)],
  ]), 'About this upload');
  return wb;
}

/**
 * Build the zip for `entries` (the shape listHaloEnabledBrands() returns:
 * [{ brand, datasets: { day?, week?, month? } }]). Resolves to
 * { blob, fileCount, brandCount }.
 */
export async function buildHaloSheetsZip(entries) {
  const [XLSX, { default: JSZip }] = await Promise.all([import('xlsx'), import('jszip')]);
  const root = 'Amazon Halo Sheets';
  const zip = new JSZip();
  const index = [];

  for (const { brand, datasets } of entries) {
    for (const gran of ['day', 'week', 'month']) {
      const ds = datasets?.[gran];
      if (!ds) continue;
      const rows = await getHaloRows(ds.id);
      const wb = datasetWorkbook(XLSX, brand.brand_name, ds, rows);
      const source = String(ds.source_filename || ds.name || '').replace(/\.(xlsx?|csv)$/i, '');
      const file = `${GRAN_LABEL[gran]} ${ds.period_start} to ${ds.period_end}${source ? ` (${source})` : ''}.xlsx`;
      const path = `${root}/${safe(brand.brand_name)}/${safe(file)}`;
      zip.file(path, XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      index.push({ brand: brand.brand_name, sheet: GRAN_LABEL[gran], period: `${ds.period_start} → ${ds.period_end}`, rows: rows.length, original_file: ds.source_filename || '', uploaded: String(ds.created_at || '').slice(0, 10), file: path.slice(root.length + 1) });
    }
  }
  if (!index.length) throw new Error('No sheets have been uploaded yet.');

  const idx = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(idx, XLSX.utils.json_to_sheet(index), 'Index');
  zip.file(`${root}/_Index of all Halo uploads.xlsx`, XLSX.write(idx, { type: 'array', bookType: 'xlsx' }));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, fileCount: index.length, brandCount: new Set(index.map((i) => i.brand)).size };
}

/** Build the zip and hand it to the browser as "Amazon Halo Sheets.zip". */
export async function downloadHaloSheets(entries) {
  const { blob, fileCount, brandCount } = await buildHaloSheetsZip(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Amazon Halo Sheets.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { fileCount, brandCount };
}
