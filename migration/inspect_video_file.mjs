import xlsx from 'xlsx';

// READ-ONLY structural inspection of the TikTok "all videos" export.
const FILE = 'C:/Users/RA_shid/Downloads/Video reviews test file.xlsx';

console.time('read');
const wb = xlsx.readFile(FILE, { cellDates: true });
console.timeEnd('read');

console.log('\nSheets:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws['!ref'];
  const range = xlsx.utils.decode_range(ref || 'A1');
  const rows = range.e.r - range.s.r + 1;
  const cols = range.e.c - range.s.c + 1;
  console.log(`\n=== Sheet "${name}" — ${rows} rows x ${cols} cols (ref ${ref}) ===`);

  // header row
  const json = xlsx.utils.sheet_to_json(ws, { defval: '', raw: false });
  if (!json.length) { console.log('  (empty)'); continue; }
  const headers = Object.keys(json[0]);
  console.log('  Columns:', JSON.stringify(headers));
  console.log('  Data rows:', json.length);

  // 3 sample rows (trimmed values)
  console.log('  Samples:');
  for (const r of json.slice(0, 3)) {
    const trimmed = {};
    for (const k of headers) trimmed[k] = String(r[k]).slice(0, 40);
    console.log('   ', JSON.stringify(trimmed));
  }
}
