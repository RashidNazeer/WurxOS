// ============================================================
// Brand Analytics — CSV round-trip for bulk goal updates.
//
// GOALS ONLY, and deliberately so. brand_monthly_metrics holds five
// target/achieved pairs; a bulk sheet carries the TARGET side alone because the
// achieved side is overwritten every day by the APC clock-in gate (mig 311) and
// is what a GMV Max incentive line reads to decide it is payable (mig 366).
// A spreadsheet round-trip is the last place that number should be editable.
//
// Keyed on brand_id, never on brand_name: the October restructure matched brand
// rows to people by exact name string, matched nothing, and silently reassigned
// 13 of 19 brands. brand_name rides along for humans and is ignored on upload
// (Excel's ANSI save also garbles the apostrophe in "Dr. Harvey's").
//
// The month is NOT read back from the sheet. Excel and Sheets both coerce
// "2026-10" into a date and write back "Oct-26" or "10/1/2026", so a per-row
// month guard would fail every round-trip. The page's selected month at upload
// time is authoritative, and the UI states it plainly before applying.
//
// Pure — no supabase, no DOM — so every rule here is testable on a fixture.
// ============================================================
import { isManagedByUs } from './roles';

// header: what the sheet column is called. col: the database column.
// group: which brand statuses make the field applicable at all.
export const GOAL_FIELDS = [
  { col: 'gmv_target',             header: 'gmv_goal',           label: 'Monthly GMV Goal',   group: 'core',   unit: '$' },
  { col: 'samples_target',         header: 'sample_goal',        label: 'Sample Approvals',   group: 'core',   unit: '#' },
  { col: 'paid_collab_allocated',  header: 'paid_collab_budget', label: 'Paid Collab Budget', group: 'paid',   unit: '$' },
  { col: 'gmv_max_allocated',      header: 'gmv_max_budget',     label: 'GMV Max Budget',     group: 'gmvmax', unit: '$' },
  { col: 'roi_target',             header: 'target_roi',         label: 'Target ROI',         group: 'gmvmax', unit: 'x' },
];

export const CSV_HEADERS = ['brand_id', 'brand_name', ...GOAL_FIELDS.map((f) => f.header)];

// What a cell says when the metric does not apply to that brand. Mirrors the
// page hiding the card entirely (visibleMetricsFor / mig 263).
export const NA_CELL = 'n/a';

// Which goal fields apply to a brand, by the same rule the page uses to decide
// which cards to render.
export function goalFieldsForBrand(brand) {
  const paidOk = isManagedByUs(brand?.paid_collab_status);
  const gmvMaxOk = isManagedByUs(brand?.gmv_max_status);
  return GOAL_FIELDS.filter((f) => (f.group === 'paid' ? paidOk : f.group === 'gmvmax' ? gmvMaxOk : true));
}

// ── numbers ────────────────────────────────────────────────────────
// A blank cell means LEAVE UNCHANGED, never "clear to null". Deleting a column
// in a spreadsheet is far too easy for it to mean "erase these goals"; clearing
// a goal stays in the single-brand editor, where it is one deliberate act.
//
// Returns { skip:true } for blank / n/a, { value } for a real number, or
// { error } — never a silent null, which is how the existing coercion turns a
// typo into a wiped goal.
export function parseGoalNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.toLowerCase() === NA_CELL) return { skip: true };
  // Tolerate what a spreadsheet hands back: currency symbols, thousands
  // separators, stray spaces, and the "3.5x" an ROI column tends to acquire.
  const cleaned = s.replace(/[$£€,\s]/g, '').replace(/x$/i, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return { error: `"${s}" is not a number` };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { error: `"${s}" is not a number` };
  if (n < 0) return { error: `"${s}" is negative` };
  return { value: n };
}

// ── build ──────────────────────────────────────────────────────────
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV for the chosen brands and month.
 * `metricsByBrand` is brand_id -> brand_monthly_metrics row (or undefined).
 */
export function buildGoalsCsv({ brands, metricsByBrand = {}, month }) {
  const lines = [CSV_HEADERS.join(',')];
  for (const b of brands) {
    const applicable = new Set(goalFieldsForBrand(b).map((f) => f.col));
    const row = metricsByBrand[b.id] || {};
    const cells = [b.id, b.brand_name];
    for (const f of GOAL_FIELDS) {
      if (!applicable.has(f.col)) { cells.push(NA_CELL); continue; }
      const v = row[f.col];
      cells.push(v === null || v === undefined ? '' : String(v));
    }
    lines.push(cells.map(cell).join(','));
  }
  // A leading note would break the header row, so the month travels in the
  // filename instead (see suggestedFilename).
  return lines.join('\r\n') + '\r\n';
}

export function suggestedFilename(month) {
  return `brand-goals-${month}.csv`;
}

// ── parse ──────────────────────────────────────────────────────────
// Quoted fields, embedded commas and doubled quotes. Same shape as the
// knowledge-base bulk import, which has survived real sheets.
export function parseCsv(text) {
  const rows = []; let current = []; let field = ''; let inQ = false;
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { current.push(field); field = ''; }
    else if (ch === '\n') { current.push(field); field = ''; rows.push(current); current = []; }
    else field += ch;
  }
  if (field.length || current.length) { current.push(field); rows.push(current); }
  return rows.filter((r) => r.some((c) => String(c).trim().length));
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Turn CSV text into { headerError, rows:[{ brandId, raw:{col:cellText} }] }.
 * Unknown columns are ignored; brand_id is required.
 */
export function parseGoalsCsv(text) {
  const grid = parseCsv(text);
  if (grid.length < 2) {
    return { headerError: 'The file needs a header row and at least one brand row.', rows: [] };
  }
  const header = grid[0].map(norm);
  const idIdx = header.indexOf('brand_id');
  if (idIdx < 0) {
    return { headerError: 'No brand_id column. Download the sheet from this page rather than building one by hand.', rows: [] };
  }
  const colFor = {};
  for (const f of GOAL_FIELDS) {
    const i = header.indexOf(f.header);
    if (i >= 0) colFor[f.col] = i;
  }
  if (!Object.keys(colFor).length) {
    return { headerError: `No goal columns found. Expected at least one of: ${GOAL_FIELDS.map((f) => f.header).join(', ')}.`, rows: [] };
  }
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r];
    const brandId = String(line[idIdx] ?? '').trim();
    const raw = {};
    for (const [col, i] of Object.entries(colFor)) raw[col] = line[i] ?? '';
    rows.push({ brandId, raw, line: r + 1 });
  }
  return { headerError: null, rows, columns: Object.keys(colFor) };
}

// ── diff ───────────────────────────────────────────────────────────
/**
 * Compare parsed rows against what is stored, for the brands the user may edit.
 *
 * `editableBrands` is the authority — not whatever was ticked when the sheet was
 * downloaded, which is gone by upload time. Returns per-brand changes plus
 * blocking errors and non-blocking warnings.
 */
export function diffGoalRows({ rows, editableBrands, metricsByBrand = {} }) {
  const byId = new Map(editableBrands.map((b) => [b.id, b]));
  const changes = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  let unchanged = 0;

  for (const { brandId, raw, line } of rows) {
    if (!brandId) { errors.push({ line, message: 'No brand_id on this row.' }); continue; }
    if (seen.has(brandId)) {
      errors.push({ line, message: `brand_id ${brandId} appears more than once.` });
      continue;
    }
    seen.add(brandId);

    const brand = byId.get(brandId);
    if (!brand) {
      errors.push({ line, message: `brand_id ${brandId} is not a brand you can edit (or is not active).` });
      continue;
    }
    const applicable = new Set(goalFieldsForBrand(brand).map((f) => f.col));
    const stored = metricsByBrand[brandId] || {};
    const targets = {};
    const fields = [];
    let rowBad = false;

    for (const f of GOAL_FIELDS) {
      if (!(f.col in raw)) continue;
      const parsed = parseGoalNumber(raw[f.col]);
      if (parsed.error) {
        errors.push({ line, brand: brand.brand_name, message: `${f.header}: ${parsed.error}` });
        rowBad = true;
        continue;
      }
      if (parsed.skip) continue;
      if (!applicable.has(f.col)) {
        // Re-checked against the brand's CURRENT status, not the sheet's — the
        // status may have changed since download. Ignored, not applied, because
        // the page would hide the card and the figure would be invisible.
        warnings.push({
          line, brand: brand.brand_name,
          message: `${f.header} = ${parsed.value} ignored — not applicable to this brand.`,
        });
        continue;
      }
      const before = stored[f.col] == null ? null : Number(stored[f.col]);
      if (before !== null && before === parsed.value) continue;
      targets[f.col] = parsed.value;
      fields.push({ col: f.col, header: f.header, label: f.label, unit: f.unit, before, after: parsed.value });
    }

    if (rowBad) continue;
    if (!fields.length) { unchanged++; continue; }
    changes.push({
      brandId,
      brandName: brand.brand_name,
      targets,
      fields,
      // Mig 366: the GMV goal drives the target on every "Total Revenue in GMV
      // Max" incentive line for this brand — APC, TL, Ads Manager and OL alike.
      touchesIncentives: Object.prototype.hasOwnProperty.call(targets, 'gmv_target'),
    });
  }

  return { changes, errors, warnings, unchanged };
}
