// Web Worker: parse a TikTok "all videos" export off the main thread so a
// 13 MB / 70k-row file never freezes the page. Returns, per creator, their
// unique video post-days (deduped by video id) so the queue logic can count
// milestones. Handles both .xlsx and .csv (SheetJS sniffs the format).
import * as XLSX from 'xlsx';

// The export has a date-range banner and a blank row above the real header,
// so we don't hardcode a row — we scan the first rows for the columns we need.
const NEEDED = ['Creator name', 'Video ID', 'Time'];

function findHeader(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = (aoa[i] || []).map((x) => String(x).trim());
    const name = row.indexOf('Creator name');
    const vid = row.indexOf('Video ID');
    const time = row.indexOf('Time');
    if (name >= 0 && vid >= 0 && time >= 0) return { i, name, vid, time };
  }
  return null;
}

const toDay = (s) => String(s).trim().split(' ')[0].replace(/\//g, '-'); // "2026/07/19 11:00" -> "2026-07-19"
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parse(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  if (!wb.SheetNames.length) throw new Error('The file has no sheets.');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });

  const h = findHeader(aoa);
  if (!h) {
    throw new Error(`Could not find the columns ${NEEDED.map((n) => `"${n}"`).join(', ')}. Make sure this is the TikTok video export (Seller Center > Videos).`);
  }

  const byCreator = new Map(); // name -> Map(videoId -> day)
  // Full accounting so the total rows always reconcile: unique videos +
  // duplicate video rows + skipped (non-blank but missing name/id/valid date).
  let videos = 0, dupes = 0, skipped = 0, minDay = null, maxDay = null;
  for (let r = h.i + 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((x) => String(x).trim() === '')) continue; // truly blank — not counted
    const name = String(row[h.name] || '').trim();
    const vid = String(row[h.vid] || '').trim();
    const day = toDay(row[h.time]);
    if (!name || !vid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) { skipped++; continue; }
    let m = byCreator.get(name);
    if (!m) { m = new Map(); byCreator.set(name, m); }
    if (!m.has(vid)) {
      m.set(vid, day);
      videos++;
      if (!minDay || day < minDay) minDay = day;
      if (!maxDay || day > maxDay) maxDay = day;
    } else {
      dupes++;   // same video listed more than once — counted once
    }
  }

  const creators = [];
  for (const [name, m] of byCreator) {
    creators.push({ creator: name, days: [...m.values()].sort(cmp) });
  }
  return { creators, stats: { videos, creators: creators.length, dupes, skipped, minDay, maxDay } };
}

self.onmessage = (e) => {
  const { buffer } = e.data || {};
  try {
    if (!buffer) throw new Error('No file received.');
    self.postMessage({ ok: true, ...parse(buffer) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
