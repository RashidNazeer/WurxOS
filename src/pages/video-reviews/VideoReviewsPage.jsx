import { useEffect, useMemo, useState } from 'react';
import { runVideoReviewTargets, downloadHandlesCsv, markGroupSent, listMyEukaBrands } from '../../lib/videoReviewApi';

// ── Pakistan-time date helpers ──────────────────────────────────────
// Default target date = 3 days before TODAY in Pakistan (Asia/Karachi).
// We format "now" in Karachi, then subtract days on that calendar date.
function pakistanToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // en-CA → YYYY-MM-DD
  return parts;
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const prettyDate = (ymd) => {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
};

// Monospace stack for the "STEP n" / generator labels (the tool feel).
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const FILE_DEFS = [
  { key: 'group1', no: 1, ord: '1st', title: 'send their 1st video review message' },
  { key: 'group2', no: 2, ord: '2nd', title: 'send their 2nd video review message' },
  { key: 'group3', no: 3, ord: '3rd', title: 'send their 3rd video review message' },
];

// ── Exclude-list helpers ────────────────────────────────────────────
// Handles are matched case-insensitively, without a leading '@' and trimmed,
// so an uploaded "@Creator" excludes a generated "creator".
const normHandle = (h) => String(h ?? '').trim().replace(/^@+/, '').toLowerCase();
const HEADER_TOKENS = new Set(['handle', 'handles', 'username', 'usernames', 'creator', 'creators']);

// Parse an exclude CSV: a single "Handle" column, one handle per row below it.
// Tolerant of a header row, quotes, '@' prefixes, blank lines and stray columns.
function parseExcludeCsv(text) {
  const set = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const first = (line.split(',')[0] || '').trim().replace(/^"|"$/g, '').trim();
    if (!first) continue;
    const n = normHandle(first);
    if (HEADER_TOKENS.has(n)) continue; // skip the "Handle" header (anywhere)
    set.add(n);
  }
  return set;
}

// A numbered step block in the control rail.
function Step({ n, title, hint, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.06em' }}>STEP {n}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>{title}</span>
        {hint ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

const SHELL_CSS = `
  .vrx-shell { display: grid; grid-template-columns: minmax(330px, 400px) 1fr; min-height: calc(100vh - 150px);
    border: 1px solid var(--border-subtle); border-radius: 18px; overflow: hidden; background: var(--surface-1); }
  .vrx-rail { border-right: 1px solid var(--border-subtle); padding: 30px 28px; display: flex; flex-direction: column; gap: 26px; }
  .vrx-output { padding: 40px 44px; background: radial-gradient(130% 90% at 100% 0%, color-mix(in srgb, var(--accent) 8%, transparent), transparent); }
  .vrx-cta { transition: filter .15s, transform .1s; }
  .vrx-cta:hover:not(:disabled) { filter: brightness(1.08); }
  .vrx-cta:active:not(:disabled) { transform: translateY(1px); }
  .vrx-cta:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
  .vrx-filerow { transition: border-color .15s; }
  .vrx-filerow:hover { border-color: var(--border-default); }
  @media (max-width: 900px) {
    .vrx-shell { grid-template-columns: 1fr; min-height: 0; }
    .vrx-rail { border-right: none; border-bottom: 1px solid var(--border-subtle); }
    .vrx-output { padding: 28px 22px; }
  }
`;

// Card used by the loading / no-brand states.
function CenteredCard({ children }) {
  return (
    <div style={{ padding: '4px 2px 40px' }}>
      <div className="wx-card" style={{ padding: 28, textAlign: 'center', maxWidth: 520, margin: '40px auto' }}>
        {children}
      </div>
    </div>
  );
}

export default function VideoReviewsPage() {
  // Default 3 days back so Euka has finished ingesting that day's creators/videos
  // (it lags ~2-3 days; running sooner undercounts the review groups).
  const defaultTarget = useMemo(() => addDays(pakistanToday(), -3), []);
  const [targetDate, setTargetDate] = useState(defaultTarget);
  const [missed, setMissed] = useState([]);          // up to 2 YYYY-MM-DD
  const [status, setStatus] = useState('idle');       // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [sentErr, setSentErr] = useState('');         // ledger write failed (files still fine)

  // Exclude list — creators to strip from ALL three files (optional upload).
  const [excludeSet, setExcludeSet] = useState(() => new Set());
  const [excludeName, setExcludeName] = useState('');
  const [excludeErr, setExcludeErr] = useState('');
  const applyExclude = (list) => (list || []).filter((h) => !excludeSet.has(normHandle(h)));

  async function onExcludeFile(e) {
    const f = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked after a clear
    if (!f) return;
    setExcludeErr('');
    try {
      const set = parseExcludeCsv(await f.text());
      if (set.size === 0) {
        setExcludeErr('No handles found. The file needs a "Handle" column with handles listed below it.');
        return;
      }
      setExcludeSet(set);
      setExcludeName(f.name);
    } catch {
      setExcludeErr('Could not read that file. Please upload a .csv.');
    }
  }
  function clearExclude() { setExcludeSet(new Set()); setExcludeName(''); setExcludeErr(''); }

  // Which Euka brands this user can run for (Boss/OL: all; APC: their own).
  const [brands, setBrands] = useState(null);         // null = loading
  const [brandId, setBrandId] = useState('');
  useEffect(() => {
    let cancelled = false;
    listMyEukaBrands()
      .then((list) => {
        if (cancelled) return;
        setBrands(list);
        if (list.length === 1) setBrandId(list[0].id); // preselect the only one
      })
      .catch(() => { if (!cancelled) setBrands([]); });
    return () => { cancelled = true; };
  }, []);

  const selectedBrand = (brands || []).find((b) => b.id === brandId) || null;
  const brandLabel = selectedBrand?.brand_name || 'Brand';
  const maxDate = pakistanToday();                    // can't target the future

  function addMissed() {
    if (missed.length >= 2) return;
    setMissed((m) => [...m, '']);
  }
  function setMissedAt(i, v) { setMissed((m) => m.map((x, idx) => (idx === i ? v : x))); }
  function removeMissed(i) { setMissed((m) => m.filter((_, idx) => idx !== i)); }

  async function generate() {
    setError('');
    if (!brandId) { setError('Pick a brand first.'); return; }
    const cleanMissed = [...new Set(missed.map((d) => d.trim()).filter(Boolean))]
      .filter((d) => d <= targetDate);
    setStatus('running');
    setResult(null);
    try {
      const data = await runVideoReviewTargets({ brandId, targetDate, missedDates: cleanMissed });
      setResult(data);
      // Auto-download the three files immediately, named by the brand.
      const label = data.brandLabel || brandLabel;
      for (const def of FILE_DEFS) {
        downloadHandlesCsv(applyExclude(data[def.key] || []), `${label} - ${def.ord} video review creators.csv`);
      }
      // Record the messages as SENT. The files go straight up to Euka, so this
      // is the commitment point — and it's what stops the same creator being
      // messaged again tomorrow now that overdue messages catch themselves up.
      // Excluded creators are deliberately NOT recorded: the APC removed them,
      // so they were never messaged and are still owed.
      try {
        for (const def of FILE_DEFS) {
          const handles = applyExclude(data[def.key] || []);
          if (handles.length) {
            await markGroupSent({
              brandId, handles, messageNo: def.no, sentOn: data.targetDate || targetDate,
            });
          }
        }
        setSentErr('');
      } catch (e) {
        // The files are already downloaded and usable — never fail the run over
        // this. But say so loudly: an unrecorded send means these creators WILL
        // reappear on the next run.
        setSentErr(e?.message || 'Could not record these as sent.');
      }
      setStatus('done');
    } catch (e) {
      setError(e?.message || 'Something went wrong.');
      setStatus('error');
    }
  }

  function redownload(def) {
    if (!result) return;
    const label = result.brandLabel || brandLabel;
    downloadHandlesCsv(applyExclude(result[def.key] || []), `${label} - ${def.ord} video review creators.csv`);
  }

  function reset() {
    setStatus('idle'); setResult(null); setError('');
  }

  const running = status === 'running';

  // ── Loading ─────────────────────────────────────────────────────
  if (brands === null) {
    return (
      <CenteredCard>
        <span className="wx-spinner" /> <span style={{ color: 'var(--text-muted)' }}>Loading your Euka brands…</span>
      </CenteredCard>
    );
  }

  // ── No Euka brand to run ────────────────────────────────────────
  if (brands.length === 0) {
    return (
      <CenteredCard>
        <i className="bi bi-camera-video" style={{ fontSize: 30, color: 'var(--text-muted)', opacity: 0.5 }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 10 }}>No Euka brand to run</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
          None of your brands are linked to a Euka store yet. Ask your Team Lead or the Boss to link the brand to Euka,
          then this page will let you generate its video-review files.
        </div>
      </CenteredCard>
    );
  }

  // ── Main: two-column generator ──────────────────────────────────
  return (
    <div style={{ padding: '4px 2px 40px' }}>
      <style>{SHELL_CSS}</style>
      <div className="vrx-shell">

        {/* ============ LEFT · control rail ============ */}
        <aside className="vrx-rail">
          {/* brand mark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #000))' }}>
              <i className="bi bi-camera-video-fill" style={{ color: '#fff', fontSize: '1.05rem' }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Video Reviews</div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 1 }}>
                Creator list generator
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border-subtle)' }} />

          {/* Step 1 · Brand */}
          <Step n={1} title="Choose a brand">
            {brands.length > 1 ? (
              <select className="wx-input" value={brandId} disabled={running}
                onChange={(e) => { setBrandId(e.target.value); reset(); }}>
                <option value="">— Select a brand —</option>
                {brands.map((b) => (<option key={b.id} value={b.id}>{b.brand_name}</option>))}
              </select>
            ) : (
              <div style={{ height: 46, padding: '0 14px', display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 700,
                color: 'var(--text-primary)', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 11 }}>
                {brandLabel}
              </div>
            )}
          </Step>

          {/* Step 2 · Target date */}
          <Step n={2} title="Target date">
            <input type="date" className="wx-input" value={targetDate} max={maxDate} disabled={running}
              onChange={(e) => setTargetDate(e.target.value)} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span style={{ padding: '3px 8px', borderRadius: 6, fontFamily: MONO, fontSize: 11, fontWeight: 700,
                background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}>
                {prettyDate(targetDate)}
              </span>
              <span>Defaults to 3 days ago · PKT (lets Euka finish ingesting that day)</span>
            </div>
          </Step>

          {/* Step 3 · Missed run dates */}
          <Step n={3} title="Missed run dates" hint="optional · max 2">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {missed.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 8 }}>
                  <input type="date" className="wx-input" value={d} max={targetDate} disabled={running}
                    onChange={(e) => setMissedAt(i, e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                  <button className="wx-btn wx-btn-ghost" onClick={() => removeMissed(i)} disabled={running}
                    title="Remove" style={{ padding: '0 10px', color: 'var(--danger)' }}>
                    <i className="bi bi-x-lg" />
                  </button>
                </div>
              ))}
              {missed.length < 2 && (
                <button className="wx-btn wx-btn-ghost align-self-start" onClick={addMissed} disabled={running}
                  style={{ borderStyle: 'dashed', fontSize: 12.5 }}>
                  <i className="bi bi-plus-circle me-1" /> Add a missed date
                </button>
              )}
            </div>
          </Step>

          {/* Step 4 · Exclude creators */}
          <Step n={4} title="Exclude creators" hint="optional">
            {excludeSet.size === 0 ? (
              <label className="wx-btn wx-btn-ghost" style={{ borderStyle: 'dashed', fontSize: 12.5, cursor: running ? 'not-allowed' : 'pointer' }}>
                <i className="bi bi-upload me-1" /> Upload exclude list (.csv)
                <input type="file" accept=".csv,text/csv" hidden onChange={onExcludeFile} disabled={running} />
              </label>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600,
                  color: 'var(--text-secondary)', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '5px 12px' }}>
                  <i className="bi bi-funnel" style={{ color: 'var(--accent)' }} />
                  {excludeSet.size} to exclude
                  {excludeName ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {excludeName}</span> : null}
                </span>
                <label className="wx-btn wx-btn-ghost" style={{ fontSize: 12, cursor: 'pointer', padding: '4px 10px' }}>
                  Replace
                  <input type="file" accept=".csv,text/csv" hidden onChange={onExcludeFile} disabled={running} />
                </label>
                <button className="wx-btn wx-btn-ghost" onClick={clearExclude} disabled={running}
                  style={{ fontSize: 12, padding: '4px 10px', color: 'var(--danger)' }}>Clear</button>
              </div>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              A single <strong style={{ fontFamily: MONO, color: 'var(--text-secondary)' }}>Handle</strong> column — removed from all three files.
            </span>
            {excludeErr && (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                <i className="bi bi-exclamation-triangle me-1" />{excludeErr}
              </div>
            )}
          </Step>

          {/* CTA */}
          <button className="vrx-cta" onClick={generate} disabled={running || !targetDate || !brandId}
            style={{ marginTop: 'auto', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              fontSize: 15, fontWeight: 700, color: '#fff', border: 'none', borderRadius: 13, cursor: 'pointer',
              background: 'linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #000))',
              boxShadow: '0 6px 20px color-mix(in srgb, var(--accent) 30%, transparent)' }}>
            <i className="bi bi-lightning-charge-fill" /> Generate review files
          </button>

          {status === 'error' && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: -12 }}>
              <i className="bi bi-exclamation-triangle me-2" />
              {error} <button className="wx-btn wx-btn-ghost ms-2" onClick={reset} style={{ padding: '2px 10px', fontSize: 12 }}>Try again</button>
            </div>
          )}
        </aside>

        {/* ============ RIGHT · output ============ */}
        <section className="vrx-output">
          {status === 'done' && result ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640 }}>
              {/* status header */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start', padding: '5px 11px', borderRadius: 999,
                  background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--success)', letterSpacing: '0.04em' }}>READY · DOWNLOADED</span>
                </span>
                <h1 style={{ margin: '8px 0 0', fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.25, color: 'var(--text-primary)' }}>
                  {result.brandLabel} review files for {prettyDate(result.targetDate)}
                </h1>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
                  {result.meta?.candidates ?? 0} creators posted in the window · saved to your Downloads folder
                  {result.missedDates?.length ? ` · missed: ${result.missedDates.join(', ')}` : ''}
                </p>
                {excludeSet.size > 0 && (() => {
                  const removed = FILE_DEFS.reduce((n, def) => n + ((result[def.key] || []).length - applyExclude(result[def.key] || []).length), 0);
                  return (
                    <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      <i className="bi bi-funnel me-1" style={{ color: 'var(--accent)' }} />
                      Excluding {excludeSet.size} uploaded creator{excludeSet.size === 1 ? '' : 's'} — {removed} removed.
                    </p>
                  );
                })()}
              </div>

              {/* ── Euka freshness warning ──────────────────────────────
                  A half-ingested day looks exactly like a quiet day, so without
                  this the tool hands over a confident, short list and the APC has
                  no reason to doubt it. That is what happened on Jul 10. */}
              {result.freshness?.stale && (
                <div style={{ display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 14,
                  background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}>
                  <i className="bi bi-exclamation-triangle-fill" style={{ color: 'var(--warning)', fontSize: '1.05rem', flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      Euka&apos;s data for this date looks incomplete
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
                      Only <strong>{result.freshness.targetVideos}</strong> videos for {prettyDate(result.targetDate)},
                      against a typical <strong>{result.freshness.typicalVideos}</strong> on nearby days — so this list is
                      probably short. Nobody is lost: anyone Euka delivers late is caught up automatically on a later run.
                    </div>
                  </div>
                </div>
              )}

              {/* ── Ledger write failed ─────────────────────────────────
                  The files are fine, but an unrecorded send means these creators
                  reappear tomorrow. Never silent. */}
              {sentErr && (
                <div style={{ display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 14,
                  background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)' }}>
                  <i className="bi bi-x-octagon-fill" style={{ color: 'var(--danger)', fontSize: '1.05rem', flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      Files are ready, but these sends were NOT recorded
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
                      {sentErr} — these creators will appear again on your next run. Tell an admin.
                    </div>
                  </div>
                </div>
              )}

              {/* summary stat strip */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {FILE_DEFS.map((def) => {
                  const count = applyExclude(result[def.key] || []).length;
                  return (
                    <div key={def.key} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: '16px 16px 14px' }}>
                      <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums',
                        color: count > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{count}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{def.ord} message</div>
                    </div>
                  );
                })}
              </div>

              {/* ── Catch-ups ───────────────────────────────────────────
                  Overdue messages being rescued now — the entire point of the
                  ledger. Shown so a creator from last week appearing on today's
                  list is explained, not mysterious. */}
              {(result.caughtUp || []).length > 0 && (
                <div style={{ padding: '14px 16px', borderRadius: 14,
                  background: 'var(--info-soft, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--info, #0d6efd) 30%, transparent)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <i className="bi bi-arrow-counterclockwise" style={{ color: 'var(--info, #0d6efd)', fontSize: '1rem' }} />
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {result.caughtUp.length} caught-up message{result.caughtUp.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '4px 0 10px', lineHeight: 1.5 }}>
                    These were due earlier but never went out — usually because Euka delivered the video late.
                    They&apos;re included in today&apos;s files so nobody is missed.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {result.caughtUp.slice(0, 12).map((c) => (
                      <div key={`${c.handle}-${c.messageNo}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                        <span style={{ fontFamily: MONO, color: 'var(--text-primary)', fontWeight: 600 }}>{c.handle}</span>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {c.messageNo === 1 ? '1st' : c.messageNo === 2 ? '2nd' : '3rd'} message · was due {c.dueOn}
                        </span>
                      </div>
                    ))}
                    {result.caughtUp.length > 12 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>…and {result.caughtUp.length - 12} more</div>
                    )}
                  </div>
                </div>
              )}

              {/* file rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {FILE_DEFS.map((def) => {
                  const count = applyExclude(result[def.key] || []).length;
                  return (
                    <div key={def.key} className="vrx-filerow" style={{ display: 'flex', alignItems: 'center', gap: 15, padding: '14px 16px',
                      background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
                        <i className="bi bi-filetype-csv" style={{ color: 'var(--accent)', fontSize: '1.05rem' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {result.brandLabel} - {def.ord} video review creators.csv
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Creators to {def.title}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{count}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>creator{count === 1 ? '' : 's'}</div>
                      </div>
                      <button className="wx-btn wx-btn-ghost" onClick={() => redownload(def)} title="Download again"
                        style={{ flexShrink: 0, padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                        <i className="bi bi-download" /> CSV
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* needs-manual flags (excluded creators removed here too) */}
              {(() => {
                const manual = (result.needsManual || []).filter((m) => !excludeSet.has(normHandle(m.handle)));
                if (manual.length === 0) return null;
                return (
                  <div style={{ padding: '12px 14px', border: '1px dashed var(--warning)', borderRadius: 12, background: 'var(--warning-soft)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      <i className="bi bi-flag me-1" /> Needs manual check ({manual.length})
                    </div>
                    {manual.map((m, i) => (
                      <div key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>@{m.handle} — {m.note}</div>
                    ))}
                  </div>
                );
              })()}

              <button className="wx-btn wx-btn-ghost align-self-start" onClick={reset} style={{ fontSize: 13 }}>
                <i className="bi bi-arrow-repeat me-1" /> Run for another date
              </button>
            </div>
          ) : (
            // Empty state
            <div style={{ minHeight: '58vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' }}>
              <div style={{ width: 68, height: 68, borderRadius: 18, border: '1.5px dashed var(--border-default)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="bi bi-file-earmark-text" style={{ fontSize: 28, color: 'var(--text-muted)', opacity: 0.6 }} />
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-secondary)' }}>No files yet</div>
                <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 4, maxWidth: 340 }}>
                  Set your brand and dates on the left, then generate to see the three review lists here.
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Non-dismissable processing dialog */}
      {running && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,18,24,0.55)', backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="wx-card" style={{ padding: 30, width: 380, maxWidth: '90vw', textAlign: 'center' }}>
            <div className="wx-spinner" style={{ width: 34, height: 34, margin: '0 auto 16px', borderWidth: 3 }} />
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
              Preparing video review files…
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Pulling each creator's full video history from Euka and working out who's due today.
              This can take a minute or two — please keep this tab open.
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 14 }}>
              Target date: <strong>{prettyDate(targetDate)}</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
