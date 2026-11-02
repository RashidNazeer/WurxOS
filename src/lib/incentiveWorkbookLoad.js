// Fetch + parse the brand workbook in the browser. Shared by the target picker
// and the Fetch-achieved modal. Nothing is uploaded or stored; xlsx is imported
// lazily so it stays out of the main bundle.
import { readBrandSheet } from './incentiveWorkbook';

export const canon = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Download the published sheet. Throws an Error whose message is fit to show. */
export async function fetchWorkbookBuffer(url) {
  try {
    // Google's published sheet sits behind a cache; a fresh query string makes each click ask again.
    const fresh = /^https:\/\/docs\.google\.com\//i.test(url) ? `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}` : url;
    const res = await fetch(fresh, { cache: 'no-store' });
    if (!res.ok) throw new Error(`The sheet could not be fetched (HTTP ${res.status}). Check it is still published to the web.`);
    const buf = await res.arrayBuffer();
    // An unpublished or private sheet answers 200 with a Google sign-in PAGE; an xlsx is a zip ("PK").
    const head = new Uint8Array(buf.slice(0, 2));
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new Error("The link returned a web page, not a spreadsheet. In Google Sheets use File > Share > Publish to web, publish the ENTIRE document, then save the link again — or upload the file below.");
    }
    return buf;
  } catch (err) {
    throw /Failed to fetch|NetworkError/i.test(err?.message || '')
      ? new Error('Could not reach the sheet. It may no longer be published to the web — republish it, or upload the file below.')
      : err;
  }
}

/**
 * Parse a workbook into brandId -> readBrandSheet() result | { missing: true }.
 * Sheets were renamed to the app's brand names, so an exact match is the normal
 * case; canonical is a fallback, never a fuzzy guess.
 */
export async function parseWorkbookForBrands(buf, brands) {
  const XLSX = await import('xlsx');
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch { throw new Error('That file could not be read as a spreadsheet. Upload an .xlsx file.'); }
  if (!wb.SheetNames?.length) throw new Error('That workbook has no sheets.');

  const byCanon = new Map(wb.SheetNames.map((n) => [canon(n), n]));
  const map = {};
  let found = 0;
  for (const b of brands) {
    const name = wb.Sheets[b.name] ? b.name : byCanon.get(canon(b.name));
    if (!name) { map[b.id] = { missing: true }; continue; }
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    map[b.id] = { ...readBrandSheet(grid), sheetName: name };
    found++;
  }
  if (!found) {
    throw new Error('None of the brands on these plans has a tab in that workbook. Tab names must match the brand names in WurxOS — run scripts/rename-google-sheet-tabs.gs on the sheet if they do not.');
  }
  return map;
}
