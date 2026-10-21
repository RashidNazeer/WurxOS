// ============================================================
// Pick an APC's incentive options from the brand workbook.
//
// Upload the workbook -> expand a brand -> tick options -> the month's TARGET
// for each is read out of that brand's sheet and the ticked options become
// brand-linked lines on the plan.
//
// FIVE PER APC, across every brand combined -- not five per brand. The counter
// is on screen at all times and unticked boxes disable once five are reached,
// so the limit is visible before it is hit rather than explained afterwards.
//
// Targets only. The amount in PKR stays the OL's to type, and the achieved
// figure keeps coming from where it already comes from: the APC's clock-in
// entry (mig 311) for GMV Max, and by hand for the rest. The workbook never
// writes an achieved value.
//
// The workbook is read in the browser and thrown away -- nothing is uploaded
// or stored. xlsx is imported lazily so it stays out of the main bundle.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  INCENTIVE_OPTIONS, OPTION_BY_KEY, MAX_SELECTIONS_PER_APC,
  readBrandSheet, getTarget, formatTarget, availableMonths,
} from '../../lib/incentiveWorkbook';

const uid4 = () => Math.random().toString(36).slice(2, 10);
const canon = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const selKey = (brandId, optionKey) => `${brandId}::${optionKey}`;

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Lines already on the plan that came from the workbook, so reopening the
 * modal shows them ticked rather than offering to add them twice.
 */
function existingSelections(incentives, bonuses) {
  const out = new Map();
  for (const it of [...(incentives || []), ...(bonuses || [])]) {
    if (!it || !it.brandId) continue;
    // `wbOption` marks a workbook line. Plans built before this feature are
    // reconciled too, or ticking an option would add a SECOND line for a brand
    // that already has one — and two lines pay twice.
    //
    // A pre-existing per-brand GMV-Max line is flagged { source: 'gmv_max' }
    // and titled "Total Revenue in GMV Max", so it matches neither the marker
    // nor the workbook's label. Recognise it by its source.
    const key = it.wbOption
      || (it.source === 'gmv_max' ? 'gmv_max' : null)
      || INCENTIVE_OPTIONS.find((o) => canon(o.label) === canon(it.text))?.key;
    if (key) out.set(selKey(it.brandId, key), it.id);
  }
  return out;
}

export default function WorkbookIncentivesModal({
  brands = [], month, incentives = [], bonuses = [], onApply, onClose,
}) {
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [wbError, setWbError] = useState('');
  const [sheets, setSheets] = useState(null);     // brandId -> readBrandSheet() result | { missing: true }
  const [open, setOpen] = useState(() => (brands.length === 1 ? brands[0].id : null));
  const [picked, setPicked] = useState(() => new Set(existingSelections(incentives, bonuses).keys()));
  const fileRef = useRef(null);

  const already = useMemo(() => existingSelections(incentives, bonuses), [incentives, bonuses]);
  const count = picked.size;
  const atLimit = count >= MAX_SELECTIONS_PER_APC;

  useEffect(() => { if (brands.length === 1) setOpen(brands[0].id); }, [brands]);

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setWbError(''); setSheets(null); setParsing(true);
    try {
      const XLSX = await import('xlsx');
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      if (!wb.SheetNames?.length) throw new Error('That file has no sheets.');

      // Sheets were renamed to the app's brand names, so an exact match is the
      // normal case; canonical is a fallback, never a fuzzy guess.
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
        throw new Error(`None of this person's brands has a sheet in that workbook. Sheet names must match the brand names in WurxOS — run scripts/rename-workbook-sheets.mjs if they do not.`);
      }
      setSheets(map);
    } catch (err) {
      setWbError(err?.message || String(err));
      setSheets(null);
    } finally {
      setParsing(false);
    }
  }

  function toggle(brandId, optionKey) {
    const k = selKey(brandId, optionKey);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (next.size < MAX_SELECTIONS_PER_APC) next.add(k);
      return next;
    });
  }

  function selectAllForBrand(brandId, keys) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (next.size >= MAX_SELECTIONS_PER_APC) break;
        next.add(selKey(brandId, k));
      }
      return next;
    });
  }

  /** Build the lines and hand them back; the form owns the state. */
  function apply() {
    const addTo = { incentives: [], bonuses: [] };
    const updates = new Map();     // existing item id -> { targetValue }
    for (const k of picked) {
      const [brandId, optionKey] = k.split('::');
      const brand = brands.find((b) => b.id === brandId);
      const opt = OPTION_BY_KEY[optionKey];
      if (!brand || !opt) continue;
      const res = getTarget(sheets?.[brandId], optionKey, month);
      // A ratio target is stored as a PERCENTAGE, not the sheet's 0.95.
      // autoComplete is achieved / target >= 0.9, so a target of 0.95 against
      // an achieved figure anyone would type as 89 gives 93.7 — the line marks
      // itself complete and becomes payable at any value above 0.86.
      const targetValue = res.value === undefined ? ''
        : String(opt.unit === 'ratio' ? Math.round(res.value * 1000) / 10 : res.value);

      const existingId = already.get(k);
      // Stamp the marker on a line matched by label or source, or the database
      // guard in mig 422 will never count it.
      if (existingId) { updates.set(existingId, { targetValue, wbOption: opt.key }); continue; }
      addTo[opt.section].push({
        id: uid4(),
        text: opt.label,
        amount: '',
        suffix: opt.unit === 'ratio' ? '%' : '',
        targetValue,
        achievedValue: 0,
        completed: false,
        brandId: brand.id,
        brandName: brand.name,
        wbOption: opt.key,
        // The GMV-Max line already has an automatic achieved figure (mig 317):
        // the brand's gmv_achieved, which the APC enters at clock-in. Flagging
        // it keeps one source for that number instead of two.
        ...(opt.key === 'gmv_max' ? { source: 'gmv_max' } : {}),
      });
    }
    // Unticking removes the line it created.
    const removed = new Set();
    for (const [k, id] of already) if (!picked.has(k)) removed.add(id);
    onApply({ add: addTo, updates, removed });
  }

  const brandRows = brands.map((b) => {
    const sheet = sheets?.[b.id];
    const opts = INCENTIVE_OPTIONS.map((o) => {
      const res = sheet && !sheet.missing ? getTarget(sheet, o.key, month) : null;
      return { ...o, res, selected: picked.has(selKey(b.id, o.key)) };
    });
    return { brand: b, sheet, opts, chosen: opts.filter((o) => o.selected).length };
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(3.9px)' }} onClick={onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 740, zIndex: 1, borderRadius: 'var(--radius-xl)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>

        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className="bi bi-journal-arrow-down" style={{ fontSize: 20, color: 'var(--accent)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>Incentives from the brand workbook</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{monthLabel(month)} · targets only</div>
          </div>
          <span style={{
            padding: '5px 12px', borderRadius: 'var(--radius-pill)', fontSize: 12.5, fontWeight: 700,
            background: atLimit ? 'var(--warning-soft, rgba(217,119,6,.15))' : 'var(--surface-2)',
            color: atLimit ? 'var(--warning-text, #92400e)' : 'var(--text-muted)',
          }}>{count} of {MAX_SELECTIONS_PER_APC} selected</span>
          <button type="button" onClick={onClose} aria-label="Close" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* 1 — the workbook */}
          <section>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 8 }}>1 · Upload the brand workbook</div>
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="wx-input" style={{ width: '100%' }} onChange={onFile} />
            {parsing && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)' }}><span className="wx-spinner" /> Reading…</div>}
            {wbError && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(220,38,38,.1))', color: 'var(--danger, #dc2626)', fontSize: 12.5 }}>
                {wbError}
              </div>
            )}
            {sheets && !wbError && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--success, #16a34a)' }}>
                <i className="bi bi-check-circle-fill me-1" />
                {file?.name} read · {Object.values(sheets).filter((s) => !s.missing).length} of {brands.length} brand sheet(s) found
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              Read in your browser and discarded — nothing is uploaded or stored.
            </div>
          </section>

          {/* 2 — brands + options */}
          {sheets && (
            <section>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 8 }}>
                2 · Choose options {brands.length > 1 ? `across this person's ${brands.length} brands` : 'for this brand'}
              </div>
              {brands.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>This person has no active brands.</div>}

              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                {brandRows.map(({ brand, sheet, opts, chosen }) => {
                  const isOpen = open === brand.id;
                  const missing = !sheet || sheet.missing || !sheet.ok;
                  return (
                    <div key={brand.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <button type="button" onClick={() => setOpen(isOpen ? null : brand.id)}
                        style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', boxSizing: 'border-box' }}>
                        <i className={`bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ color: 'var(--text-muted)' }} />
                        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{brand.name}</span>
                        {chosen > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>{chosen} selected</span>}
                        {missing && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>no sheet</span>}
                      </button>

                      {isOpen && (
                        <div style={{ padding: '0 12px 12px 34px' }}>
                          {missing ? (
                            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                              {sheet?.missing
                                ? `The workbook has no sheet named "${brand.name}".`
                                : (sheet?.reason || 'This sheet could not be read.')}
                            </div>
                          ) : (
                            <>
                              {opts.map((o) => {
                                const value = o.res?.value;
                                // An option with no target would save an empty
                                // targetValue, which pays nothing and reads as
                                // a half-built line. Nothing to tick.
                                const blocked = (!o.selected && atLimit) || value === undefined;
                                return (
                                  <label key={o.key}
                                    style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '6px 0', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.5 : 1 }}>
                                    <input type="checkbox" checked={o.selected} disabled={blocked}
                                      onChange={() => toggle(brand.id, o.key)} style={{ marginTop: 3 }} />
                                    <span style={{ flex: 1, minWidth: 0 }}>
                                      <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{o.label}</span>
                                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                                        {o.section === 'bonuses' ? 'bonus' : 'incentive'}
                                      </span>
                                      <div style={{ fontSize: 12, color: value !== undefined ? 'var(--text-muted)' : 'var(--warning, #d97706)' }}>
                                        {value !== undefined
                                          ? <>Target {monthLabel(month)}: <strong style={{ color: 'var(--text-primary)' }}>{formatTarget(value, o.unit)}</strong></>
                                          : <>No target available — {o.res?.unavailable}</>}
                                      </div>
                                    </span>
                                  </label>
                                );
                              })}
                              <button type="button" className="wx-btn wx-btn-ghost" style={{ marginTop: 6, fontSize: 12 }}
                                disabled={atLimit}
                                onClick={() => selectAllForBrand(brand.id, opts.filter((o) => o.res?.value !== undefined).map((o) => o.key))}>
                                Select all available
                              </button>
                              {availableMonths(sheet).length > 0 && !availableMonths(sheet).includes(month) && (
                                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--warning, #d97706)' }}>
                                  This sheet has no column for {monthLabel(month)}. Latest it can answer: {monthLabel(availableMonths(sheet)[0])}.
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {atLimit && (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--warning-soft, rgba(217,119,6,.12))', fontSize: 12.5, color: 'var(--text-primary)' }}>
                  <i className="bi bi-info-circle me-1" />
                  This APC has all {MAX_SELECTIONS_PER_APC} selections in use, across every brand combined.
                  Untick one to choose a different option.
                </div>
              )}
            </section>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
            Adds the lines to the plan — you still set each amount, then Save.
          </div>
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="wx-btn wx-btn-primary" onClick={apply} disabled={!sheets}>
            <i className="bi bi-check2 me-1" /> Add {count} line{count === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
