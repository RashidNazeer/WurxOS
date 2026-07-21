import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listMyReviewBrands, fetchTracker, markSent,
  downloadHandlesCsv, creatorKey,
} from '../../lib/videoReviewFileApi';
import { buildDueLists, markSentUpdates } from '../../lib/videoReviewQueue';

// ── date helpers (PKT) ──────────────────────────────────────────────
function pakistanToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
const prettyDate = (ymd) => {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const FILE_DEFS = [
  { key: 'group1', gnum: 1, ord: '1st', title: 'send their 1st video review message' },
  { key: 'group2', gnum: 2, ord: '2nd', title: 'send their 2nd video review message' },
  { key: 'group3', gnum: 3, ord: '3rd', title: 'send their 3rd video review message' },
];

// ── exclude-list parsing (same tolerant format as Euka mode) ────────
const HEADER_TOKENS = new Set(['handle', 'handles', 'username', 'usernames', 'creator', 'creators']);
function parseExcludeCsv(text) {
  const set = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const first = (line.split(',')[0] || '').trim().replace(/^"|"$/g, '').trim();
    if (!first) continue;
    const n = creatorKey(first);
    if (HEADER_TOKENS.has(n)) continue;
    set.add(n);
  }
  return set;
}

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

function CenteredCard({ children }) {
  return (
    <div style={{ padding: '4px 2px 40px' }}>
      <div className="wx-card" style={{ padding: 28, textAlign: 'center', maxWidth: 520, margin: '40px auto' }}>{children}</div>
    </div>
  );
}

export default function FileMode() {
  const [brands, setBrands] = useState(null);          // null = loading
  const [brandId, setBrandId] = useState('');
  const selectedBrand = (brands || []).find((b) => b.id === brandId) || null;
  const brandLabel = selectedBrand?.brand_name || 'Brand';

  // parsed file
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);           // { creators, stats }
  const [parseErr, setParseErr] = useState('');
  const [fileName, setFileName] = useState('');

  // run
  const [runDate, setRunDate] = useState(pakistanToday());
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);           // { group1, group2, group3, blockedToday }
  const [genErr, setGenErr] = useState('');
  const [sentGroups, setSentGroups] = useState(() => new Set());
  const trackerRef = useRef(new Map());

  // exclude list
  const [excludeSet, setExcludeSet] = useState(() => new Set());
  const [excludeName, setExcludeName] = useState('');
  const applyExclude = (list) => (list || []).filter((h) => !excludeSet.has(creatorKey(h)));

  const maxDate = pakistanToday();

  useEffect(() => {
    let cancelled = false;
    listMyReviewBrands()
      .then((list) => { if (cancelled) return; setBrands(list); if (list.length === 1) setBrandId(list[0].id); })
      .catch(() => { if (!cancelled) setBrands([]); });
    return () => { cancelled = true; };
  }, []);

  // Switching brand clears the prior run AND the parsed file (a file uploaded
  // for one brand must not generate another's).
  useEffect(() => {
    setResult(null); setGenErr(''); setSentGroups(new Set());
    setParsed(null); setFileName(''); setParseErr('');
  }, [brandId]);

  function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setParseErr(''); setParsing(true); setParsed(null); setResult(null); setFileName(f.name);
    const worker = new Worker(new URL('../../workers/videoFileParser.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.ok) { setParsed({ creators: m.creators, stats: m.stats }); }
      else { setParseErr(m.error || 'Could not read that file.'); }
      setParsing(false); worker.terminate();
    };
    worker.onerror = () => { setParseErr('Could not read that file.'); setParsing(false); worker.terminate(); };
    f.arrayBuffer().then((buf) => worker.postMessage({ buffer: buf }, [buf]))
      .catch(() => { setParseErr('Could not read that file.'); setParsing(false); worker.terminate(); });
  }

  function onExcludeFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    f.text().then((t) => { const s = parseExcludeCsv(t); setExcludeSet(s); setExcludeName(f.name); }).catch(() => {});
  }
  function clearExclude() { setExcludeSet(new Set()); setExcludeName(''); }

  async function generate() {
    setGenErr('');
    if (!brandId) { setGenErr('Pick a brand first.'); return; }
    if (!parsed) { setGenErr('Upload the TikTok video file first.'); return; }
    setGenerating(true); setResult(null); setSentGroups(new Set());
    try {
      const tracker = await fetchTracker(brandId);
      trackerRef.current = tracker;
      // ONE date does both jobs: we clip each creator's videos to on/before it,
      // and it's the baseline too — videos before it are prior history (counted,
      // treated as already reviewed), a video ON it can make a creator due.
      const creators = [];
      for (const c of parsed.creators) {
        const days = c.days.filter((d) => cmp(d, runDate) <= 0);
        if (days.length) creators.push({ creator: c.creator, days });
      }
      const lists = buildDueLists({ creators, startDate: runDate, runDate, tracker, keyOf: (c) => creatorKey(c.creator) });
      setResult(lists);
    } catch (e) {
      setGenErr(e?.message || 'Something went wrong.');
    } finally {
      setGenerating(false);
    }
  }

  // The creators list clipped to the run date — needed by mark-sent.
  const clippedCreators = useMemo(() => {
    if (!parsed) return [];
    return parsed.creators
      .map((c) => ({ creator: c.creator, days: c.days.filter((d) => cmp(d, runDate) <= 0) }))
      .filter((c) => c.days.length);
  }, [parsed, runDate]);

  function download(def) {
    if (!result) return;
    downloadHandlesCsv(applyExclude(result[def.key] || []), `${brandLabel} - ${def.ord} video review creators.csv`);
  }

  const [markingSent, setMarkingSent] = useState(false);
  const allSent = result && FILE_DEFS.every((def) => sentGroups.has(def.key));

  // APCs always send all three lists, so it's one action: advance every creator
  // shown (across all three lists, minus excludes) by one message in a single write.
  async function markAllSent() {
    if (!result || allSent) return;
    setMarkingSent(true);
    try {
      const updates = [];
      for (const def of FILE_DEFS) {
        const group = applyExclude(result[def.key] || []);   // only creators we actually messaged
        if (!group.length) continue;
        updates.push(...markSentUpdates({
          creators: clippedCreators, group, runDate, startDate: runDate,
          tracker: trackerRef.current, keyOf: (c) => creatorKey(c.creator),
        }));
      }
      if (updates.length) {
        await markSent(brandId, updates);
        // reflect locally so a re-generate won't re-show them today
        for (const u of updates) trackerRef.current.set(u.key, { sentCount: u.sentCount, lastSentDate: u.lastSentDate });
      }
      setSentGroups(new Set(FILE_DEFS.map((def) => def.key)));
    } catch (e) {
      setGenErr(e?.message || 'Could not mark as sent.');
    } finally {
      setMarkingSent(false);
    }
  }

  // ── loading / empty ─────────────────────────────────────────────
  if (brands === null) {
    return <CenteredCard><span className="wx-spinner" /> <span style={{ color: 'var(--text-muted)' }}>Loading your brands…</span></CenteredCard>;
  }
  if (brands.length === 0) {
    return (
      <CenteredCard>
        <i className="bi bi-camera-video" style={{ fontSize: 30, color: 'var(--text-muted)', opacity: 0.5 }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 10 }}>No brand assigned</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>You have no brands assigned yet, so there's nothing to generate reviews for.</div>
      </CenteredCard>
    );
  }

  const totalDue = result ? FILE_DEFS.reduce((n, def) => n + applyExclude(result[def.key] || []).length, 0) : 0;

  return (
    <div style={{ padding: '4px 2px 40px' }}>
      <div className="vrx-shell">
        {/* ============ LEFT · control rail ============ */}
        <aside className="vrx-rail">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #000))' }}>
              <i className="bi bi-filetype-xlsx" style={{ color: '#fff', fontSize: '1.05rem' }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>From TikTok file</div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 1 }}>
                Upload · queue-tracked
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border-subtle)' }} />

          {/* Step 1 · Brand */}
          <Step n={1} title="Choose a brand">
            {brands.length > 1 ? (
              <select className="wx-input" value={brandId} disabled={generating}
                onChange={(e) => setBrandId(e.target.value)}>
                <option value="">— Select a brand —</option>
                {brands.map((b) => (<option key={b.id} value={b.id}>{b.brand_name}</option>))}
              </select>
            ) : (
              <div style={{ height: 46, padding: '0 14px', display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 700,
                color: 'var(--text-primary)', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 11 }}>{brandLabel}</div>
            )}
          </Step>

          {/* Step 2 · Upload file */}
          <Step n={2} title="Upload TikTok video file" hint=".xlsx / .csv">
            <label className="wx-btn wx-btn-ghost vrx-filerow" style={{ borderStyle: 'dashed', fontSize: 12.5, cursor: parsing ? 'wait' : 'pointer', justifyContent: 'center', padding: '12px' }}>
              {parsing ? (<><span className="wx-spinner" style={{ width: 15, height: 15 }} /> Reading file…</>)
                : (<><i className="bi bi-upload me-1" /> {parsed ? 'Replace file' : 'Choose file'}</>)}
              <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={onFile} disabled={parsing || generating} />
            </label>
            {parsed && (
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <i className="bi bi-check-circle-fill me-1" style={{ color: 'var(--success)' }} />
                {parsed.stats.videos.toLocaleString()} videos · {parsed.stats.creators.toLocaleString()} creators · {parsed.stats.minDay} → {parsed.stats.maxDay}
                {fileName ? <span style={{ color: 'var(--text-muted)' }}> · {fileName}</span> : null}
              </div>
            )}
            {parseErr && <div style={{ fontSize: 12, color: 'var(--danger)' }}><i className="bi bi-exclamation-triangle me-1" />{parseErr}</div>}
          </Step>

          {/* Step 3 · Date */}
          <Step n={3} title="Sending reviews for">
            <input type="date" className="wx-input" value={runDate} max={maxDate} disabled={generating}
              onChange={(e) => { setRunDate(e.target.value); setResult(null); setSentGroups(new Set()); }} />
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              The day you're sending reviews for. We read each creator's full history to place them; videos before this day just count toward where they stand. Defaults to today (PKT).
            </span>
          </Step>

          {/* Step 4 · Exclude (optional) */}
          <Step n={4} title="Exclude creators" hint="optional">
            {excludeSet.size === 0 ? (
              <label className="wx-btn wx-btn-ghost" style={{ borderStyle: 'dashed', fontSize: 12.5, cursor: 'pointer' }}>
                <i className="bi bi-upload me-1" /> Upload exclude list (.csv)
                <input type="file" accept=".csv,text/csv" hidden onChange={onExcludeFile} disabled={generating} />
              </label>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)',
                  background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '5px 12px' }}>
                  <i className="bi bi-funnel" style={{ color: 'var(--accent)' }} />{excludeSet.size} to exclude
                  {excludeName ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {excludeName}</span> : null}
                </span>
                <button className="wx-btn wx-btn-ghost" onClick={clearExclude} style={{ fontSize: 12, padding: '4px 10px', color: 'var(--danger)' }}>Clear</button>
              </div>
            )}
          </Step>

          <button className="vrx-cta" onClick={generate} disabled={generating || !brandId || !parsed}
            style={{ marginTop: 'auto', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              fontSize: 15, fontWeight: 700, color: '#fff', border: 'none', borderRadius: 13, cursor: 'pointer',
              background: 'linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #000))',
              boxShadow: '0 6px 20px color-mix(in srgb, var(--accent) 30%, transparent)' }}>
            {generating ? <><span className="wx-spinner" style={{ width: 16, height: 16 }} /> Working…</> : <><i className="bi bi-lightning-charge-fill" /> Generate review lists</>}
          </button>

          {genErr && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: -12 }}>
              <i className="bi bi-exclamation-triangle me-2" />{genErr}
            </div>
          )}
        </aside>

        {/* ============ RIGHT · output ============ */}
        <section className="vrx-output">
          {result ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start', padding: '5px 11px', borderRadius: 999,
                  background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} />
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--success)', letterSpacing: '0.04em' }}>READY</span>
                </span>
                <h1 style={{ margin: '8px 0 0', fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.25, color: 'var(--text-primary)' }}>
                  {brandLabel} review lists for {prettyDate(runDate)}
                </h1>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
                  {totalDue} creator{totalDue === 1 ? '' : 's'} due today
                  {result.blockedToday.length ? ` · ${result.blockedToday.length} already messaged today` : ''}
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {FILE_DEFS.map((def) => {
                  const count = applyExclude(result[def.key] || []).length;
                  const sent = sentGroups.has(def.key);
                  return (
                    <div key={def.key} className="vrx-filerow" style={{ display: 'flex', alignItems: 'center', gap: 15, padding: '14px 16px',
                      background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, opacity: sent ? 0.7 : 1 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
                        <i className="bi bi-filetype-csv" style={{ color: 'var(--accent)', fontSize: '1.05rem' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{def.ord} video review</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Creators to {def.title}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{count}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>creator{count === 1 ? '' : 's'}</div>
                      </div>
                      <button className="wx-btn wx-btn-ghost" onClick={() => download(def)} disabled={count === 0} title="Download CSV"
                        style={{ flexShrink: 0, padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                        <i className="bi bi-download" /> CSV
                      </button>
                    </div>
                  );
                })}
              </div>

              <div style={{ padding: '11px 14px', border: '1px dashed var(--border-default)', borderRadius: 12, background: 'var(--surface-2)', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <i className="bi bi-info-circle me-1" style={{ color: 'var(--accent)' }} />
                Download all three lists and send them, then hit <strong>Mark all as sent</strong>. Creators who posted several new videos get their next message the following day, so run again tomorrow with a fresh file.
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button className="wx-btn wx-btn-primary" onClick={markAllSent} disabled={allSent || markingSent || totalDue === 0}
                  style={{ padding: '10px 18px', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700 }}>
                  {allSent ? <><i className="bi bi-check-lg" /> All marked sent</>
                    : markingSent ? <><span className="wx-spinner" style={{ width: 15, height: 15 }} /> Saving…</>
                    : <><i className="bi bi-check2-all" /> Mark all as sent</>}
                </button>
                <button className="wx-btn wx-btn-ghost" onClick={() => { setResult(null); setSentGroups(new Set()); }} style={{ fontSize: 13 }}>
                  <i className="bi bi-arrow-repeat me-1" /> Clear results
                </button>
              </div>
            </div>
          ) : (
            <div style={{ minHeight: '58vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' }}>
              <div style={{ width: 68, height: 68, borderRadius: 18, border: '1.5px dashed var(--border-default)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="bi bi-cloud-arrow-up" style={{ fontSize: 28, color: 'var(--text-muted)', opacity: 0.6 }} />
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-secondary)' }}>No lists yet</div>
                <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 4, maxWidth: 360 }}>
                  Pick a brand, upload the TikTok video file, choose the day (usually today), then generate the three review lists.
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
