// VERBATIM PORT of v1 CampaignTrackerPage.js (1,006 LOC).
// Surgical patches only:
//   1. Firebase imports → v1-compat shim (campaignsApiV1.js)
//   2. useAuth() returns {user, profile} in v2 → reconstruct
//      v1's {currentUser, userRole, apcProfile}
//   3. onSnapshot → subscribeAllCampaigns
//   4. addDoc/updateDoc/deleteDoc → addCampaign/updateCampaign/deleteCampaign
//   5. Timestamp.fromDate → pass-through (the shim accepts Date or ISO string)
//   6. APC scoping: v1 read assignedBrands from apcProfile; v2 useBrands()
//      already returns only assigned brands for APC/IPC, so we filter by
//      whatever's in `brands`.
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import {
  subscribeAllCampaigns, addCampaign, updateCampaign, deleteCampaign, addCampaignsBulk,
} from '../../lib/campaignsApiV1';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['Ongoing', 'Upcoming', 'Ended', 'Deactivated'];

const STATUS_STYLE = {
  Ongoing:     { bg: 'rgba(34,197,94,0.12)',   color: '#15803d', border: 'rgba(34,197,94,0.3)'   },
  Upcoming:    { bg: 'rgba(59,130,246,0.12)',  color: '#1d4ed8', border: 'rgba(59,130,246,0.3)'  },
  Ended:       { bg: 'rgba(107,114,128,0.10)', color: '#6b7280', border: 'rgba(107,114,128,0.25)' },
  Deactivated: { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626', border: 'rgba(239,68,68,0.25)'  },
};

const EMPTY_FORM = {
  _id: null, brandId: '', brandName: '', promotionName: '',
  status: 'Ongoing', startTime: '', endTime: '', type: '', notes: '',
};

const STYLES = `
  .ct-paste-table td { vertical-align: middle; padding: 2px 4px !important; }
  .ct-paste-table input, .ct-paste-table select {
    background: transparent !important;
    border: 1px solid transparent !important;
    padding: 3px 6px !important;
    font-size: 0.78rem !important;
    width: 100%;
    border-radius: 4px;
  }
  .ct-paste-table input:focus, .ct-paste-table select:focus {
    background: #fff !important;
    border-color: #93c5fd !important;
    outline: none;
    box-shadow: 0 0 0 2px rgba(59,130,246,0.15) !important;
  }
  .ct-days-badge { display: inline-block; border-radius: 9999px; padding: 1px 8px; font-size: 0.72rem; font-weight: 600; }
  .ct-modal-tab-btn {
    border: none; background: none; padding: 8px 16px;
    font-size: 0.83rem; font-weight: 500; color: #94a3b8;
    border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.15s;
  }
  .ct-modal-tab-btn.active { color: #3b82f6; border-bottom-color: #3b82f6; font-weight: 600; }
  .ct-modal-tab-btn:hover:not(.active) { color: #475569; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalInput(ts) {
  if (!ts) return '';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

function formatDateTime(ts, fallback) {
  if (!ts) return fallback || '—';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

function daysUntil(ts) {
  if (!ts) return null;
  try {
    const end = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

// ─── Paste parser ─────────────────────────────────────────────────────────────

function normalizeStatus(s) {
  const l = (s || '').toLowerCase();
  if (l.includes('ongo'))                            return 'Ongoing';
  if (l.includes('upcom'))                           return 'Upcoming';
  if (l.includes('end') || l.includes('expir'))      return 'Ended';
  if (l.includes('deact') || l.includes('inact') || l.includes('pause')) return 'Deactivated';
  return 'Upcoming';
}

function parseDateTime(str) {
  if (!str || str === 'Indefinite') return '';
  // Strip timezone like "(PDT)", "(PST)", "(EST)" etc.
  const s = str.replace(/\s*\([A-Z]{2,5}\)\s*$/, '').replace(/\s*GMT[+-]?\d*/i, '').trim();
  const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
  const pad = n => String(n).padStart(2, '0');

  // "Mar 17, 2026 12:22 PM" (12-hour with AM/PM)
  const m = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
  if (m) {
    const [, mon, day, year, hr, min, ampm] = m;
    let h = parseInt(hr, 10);
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    return `${year}-${pad(MONTHS[mon])}-${pad(parseInt(day, 10))}T${pad(h)}:${pad(min)}`;
  }

  // "Apr 7, 2026 14:21" (24-hour, no AM/PM)
  const m24 = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})$/i);
  if (m24) {
    const [, mon, day, year, hr, min] = m24;
    return `${year}-${pad(MONTHS[mon])}-${pad(parseInt(day, 10))}T${pad(parseInt(hr, 10))}:${min}`;
  }

  // YYYY/MM/DD HH:MM or YYYY-MM-DD HH:MM
  const m2 = str.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m2) {
    return `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}T${m2[4].padStart(2,'0')}:${m2[5]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return str.slice(0, 16);
  return '';
}

function parsePastedData(raw) {
  const STATUSES   = new Set(['Ongoing', 'Upcoming', 'Ended', 'Deactivated']);
  const SKIP_LINES = new Set(['Promotion name', 'Status', 'GMV', 'Start time', 'End time', 'Type', 'Action', 'Updated', 'Shop-wide', 'From recommendations']);
  // Matches dates: "Mar 17, 2026 12:22 PM (PDT)" OR "Apr 7, 2026 14:21 (PDT)" (24-hour)
  const DATE_RE    = /^[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}/i;

  const lines = raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !SKIP_LINES.has(l));

  if (!lines.length) return { rows: [], error: 'No data found.' };

  // Find all status-line positions
  const statusIdxs = lines.reduce((acc, l, i) => { if (STATUSES.has(l)) acc.push(i); return acc; }, []);

  if (!statusIdxs.length) {
    return { rows: [], error: 'Could not detect campaign status lines. Make sure the data contains Ongoing/Upcoming/Ended/Deactivated.' };
  }

  const results = [];
  for (let si = 0; si < statusIdxs.length; si++) {
    const sIdx = statusIdxs[si];
    // Name is the line immediately before the status line
    const name = sIdx > 0 ? lines[sIdx - 1] : '';

    // Data lines: everything after the status up to (but not including) the name of the next record
    const nextNameIdx = si + 1 < statusIdxs.length ? statusIdxs[si + 1] - 1 : lines.length;
    const dataLines = lines.slice(sIdx + 1, nextNameIdx);

    const dateTimes = [];
    const typeLines = [];
    for (const line of dataLines) {
      if (line.startsWith('$')) continue;          // skip GMV
      if (DATE_RE.test(line))   { dateTimes.push(line); continue; }
      if (line === 'Indefinite') { dateTimes.push(''); continue; } // no end time
      typeLines.push(line);
    }

    if (!name || STATUSES.has(name)) continue;

    results.push({
      promotionName: name,
      status:        normalizeStatus(lines[sIdx]),
      startTime:     parseDateTime(dateTimes[0] || ''),
      endTime:       parseDateTime(dateTimes[1] || ''),
      type:          typeLines[0] || '',
      notes:         '',
    });
  }

  if (!results.length) return { rows: [], error: 'Could not extract any campaigns from the pasted data.' };
  return { rows: results, error: null };
}

// ─── Effective status (auto-transitions based on dates) ──────────────────────
// Manual status 'Deactivated' is always preserved. Otherwise date-based:
// now < startTime → Upcoming · now between → Ongoing · now > endTime → Ended.
function effectiveStatus(c) {
  if (c?.status === 'Deactivated') return 'Deactivated';
  const now = Date.now();
  const toMs = (t) => t ? (t.toDate ? t.toDate().getTime() : new Date(t).getTime()) : null;
  const start = toMs(c?.startTime);
  const end   = toMs(c?.endTime);
  if (start && now < start) return 'Upcoming';
  if (end && now > end)     return 'Ended';
  if (start || end)         return 'Ongoing';
  return c?.status || 'Ongoing';
}

// ─── Days-left badge ──────────────────────────────────────────────────────────

function DaysLeftBadge({ ts, status }) {
  const isActive = status === 'Ongoing' || status === 'Upcoming';
  if (!isActive) return <span className="text-muted">—</span>;
  const days = daysUntil(ts);
  if (days === null) return <span className="text-muted">—</span>;

  const [bg, color] =
    days <= 0  ? ['rgba(239,68,68,0.12)',   '#dc2626'] :
    days <= 1  ? ['rgba(239,68,68,0.12)',   '#dc2626'] :
    days <= 3  ? ['rgba(249,115,22,0.12)',  '#ea580c'] :
    days <= 7  ? ['rgba(234,179,8,0.12)',   '#ca8a04'] :
               ['rgba(34,197,94,0.12)',    '#16a34a'];

  return (
    <span className="ct-days-badge" style={{ background: bg, color }}>
      {days <= 0 ? 'Today' : `${days}d`}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CampaignTrackerPage() {
  // v2 auth shim → v1 shape
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc')
    ? { userName: profile?.display_name || '' }
    : null;

  const { brands: ctxBrands } = useBrands();
  const brands = useMemo(
    () => (ctxBrands || []).map(b => ({ id: b.id, name: b.brandName || b.brand_name || '', ownerId: b.ownerId || b.owner_id || null })),
    [ctxBrands],
  );

  // Data
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]     = useState(true);

  // Filters
  const [fSearch,     setFSearch]     = useState('');
  const [fStatus,     setFStatus]     = useState('');
  const [fBrand,      setFBrand]      = useState('');
  const [fType,       setFType]       = useState('');
  const [fAddedBy,    setFAddedBy]    = useState('');
  const [fStartFrom,  setFStartFrom]  = useState(''); // date string YYYY-MM-DD
  const [fEndTo,      setFEndTo]      = useState(''); // date string YYYY-MM-DD

  // Add/Edit modal
  const [showModal,  setShowModal]  = useState(false);
  const [modalMode,  setModalMode]  = useState('add');   // 'add' | 'edit'
  const [modalTab,   setModalTab]   = useState('manual'); // 'manual' | 'paste'
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');

  // Paste & Parse state
  const [pasteText,        setPasteText]        = useState('');
  const [pasteRows,        setPasteRows]        = useState(null);
  const [pasteBrandId,     setPasteBrandId]     = useState('');
  const [pasteError,       setPasteError]       = useState('');
  const [confirmingSave,   setConfirmingSave]   = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState(null);

  // ── Load campaigns ────────────────────────────────────────────────────────
  // Cap the listener to the most recent N campaigns so read cost is bounded
  // as the collection grows. Stash the refetch in a ref so action handlers
  // can force a fresh fetch after add/update/delete (realtime in v2 is
  // unreliable; never depend solely on it).
  const subRef = React.useRef(null);
  useEffect(() => {
    const unsub = subscribeAllCampaigns(
      (rows) => { setCampaigns(rows); setLoading(false); },
      () => setLoading(false),
    );
    subRef.current = unsub;
    return unsub;
  }, []);
  const refetch = () => subRef.current?.refetch?.();

  // ── Unique type values for dropdown ───────────────────────────────────────
  const typeOptions = useMemo(() => {
    const seen = new Set();
    campaigns.forEach(c => { if (c.type) seen.add(c.type); });
    return [...seen].sort();
  }, [campaigns]);

  // ── Unique addedBy users for dropdown ─────────────────────────────────────
  const addedByOptions = useMemo(() => {
    const map = new Map();
    campaigns.forEach(c => {
      if (c.addedBy && c.addedByName) map.set(c.addedBy, c.addedByName);
    });
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [campaigns]);

  // ── Filtered list ─────────────────────────────────────────────────────────
  // v1 used apcProfile.assignedBrands; v2 useBrands() already returns only
  // assigned brands for APC/IPC, so we derive the same allow-set from there.
  const filtered = useMemo(() => {
    const sl = fSearch.toLowerCase();
    const assignedIds = (userRole === 'apc' || userRole === 'ipc')
      ? new Set(brands.map(b => b.id))
      : null;
    const startFromMs = fStartFrom ? new Date(fStartFrom).getTime() : null;
    const endToMs     = fEndTo     ? new Date(fEndTo + 'T23:59:59').getTime() : null;

    return campaigns.filter(c => {
      // Role-based scoping
      if (userRole === 'tl' && c.ownerId && c.ownerId !== currentUser?.uid) return false;
      if (assignedIds && !assignedIds.has(c.brandId)) return false;
      // Filters
      if (fSearch && !c.promotionName?.toLowerCase().includes(sl)) return false;
      if (fStatus  && effectiveStatus(c) !== fStatus) return false;
      if (fBrand   && c.brandId !== fBrand)   return false;
      if (fType    && c.type !== fType)       return false;
      if (fAddedBy && c.addedBy !== fAddedBy) return false;
      if (startFromMs) {
        const st = c.startTime ? (c.startTime.toDate ? c.startTime.toDate() : new Date(c.startTime)).getTime() : null;
        if (!st || st < startFromMs) return false;
      }
      if (endToMs) {
        const et = c.endTime ? (c.endTime.toDate ? c.endTime.toDate() : new Date(c.endTime)).getTime() : null;
        if (!et || et > endToMs) return false;
      }
      return true;
    });
  }, [campaigns, fSearch, fStatus, fBrand, fType, fAddedBy, fStartFrom, fEndTo, userRole, brands, currentUser]);

  const hasFilters = fSearch || fStatus || fBrand || fType || fAddedBy || fStartFrom || fEndTo;

  function clearFilters() {
    setFSearch(''); setFStatus(''); setFBrand('');
    setFType(''); setFAddedBy(''); setFStartFrom(''); setFEndTo('');
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openAdd() {
    setForm(EMPTY_FORM);
    setModalMode('add');
    setModalTab('manual');
    setPasteText('');
    setPasteRows(null);
    setPasteError('');
    setPasteBrandId('');
    setFormError('');
    setShowModal(true);
  }

  function openEdit(c) {
    setForm({
      _id:           c.id,
      brandId:       c.brandId       || '',
      brandName:     c.brandName     || '',
      promotionName: c.promotionName || '',
      status:        c.status        || 'Ongoing',
      startTime:     toLocalInput(c.startTime),
      endTime:       toLocalInput(c.endTime),
      type:          c.type          || '',
      notes:         c.notes         || '',
    });
    setModalMode('edit');
    setModalTab('manual');
    setFormError('');
    setShowModal(true);
  }

  // ── Save (manual) ─────────────────────────────────────────────────────────
  async function handleSave() {
    if (!form.brandId)            { setFormError('Please select a brand.');           return; }
    if (!form.promotionName.trim()){ setFormError('Promotion name is required.');      return; }
    // endTime is optional (campaigns can be indefinite)

    setSaving(true);
    setFormError('');

    try {
      const brandName = brands.find(b => b.id === form.brandId)?.name || form.brandName;
      const addedByName = apcProfile?.userName || currentUser.displayName || currentUser.email?.split('@')[0] || 'User';
      const payload = {
        brandId:       form.brandId,
        brandName,
        promotionName: form.promotionName.trim(),
        status:        form.status,
        startTime:     form.startTime ? new Date(form.startTime) : null,
        endTime:       form.endTime ? new Date(form.endTime) : null,
        type:          form.type.trim(),
        notes:         form.notes.trim(),
        // Reset reminders when saved — checker recomputes on next run
        reminders:     {},
      };

      if (modalMode === 'add') {
        const selectedBrand = brands.find(b => b.id === form.brandId);
        const campaignOwnerId = selectedBrand?.ownerId || currentUser.uid;
        await addCampaign({
          ...payload,
          ownerId:       campaignOwnerId,
          addedBy:       currentUser.uid,
          addedByRole:   userRole || null,
        });
      } else {
        await updateCampaign(form._id, payload);
      }
      setShowModal(false);
      refetch();
    } catch {
      setFormError('Failed to save. Please try again.');
    }
    setSaving(false);
  }

  // ── Parse pasted text ─────────────────────────────────────────────────────
  function handleParse() {
    setPasteError('');
    const { rows, error } = parsePastedData(pasteText);
    if (error) { setPasteError(error); return; }
    setPasteRows(rows);
  }

  function updatePasteRow(idx, field, value) {
    if (field === '__delete__') {
      setPasteRows(r => r.filter((_, i) => i !== idx));
    } else {
      setPasteRows(r => r.map((row, i) => i === idx ? { ...row, [field]: value } : row));
    }
  }

  // ── Confirm paste rows ────────────────────────────────────────────────────
  async function handleConfirmPaste() {
    if (!pasteBrandId) { setPasteError('Please select a brand.'); return; }
    if (!pasteRows?.length) return;

    setConfirmingSave(true);
    const selectedBrand = brands.find(b => b.id === pasteBrandId);
    const brandName     = selectedBrand?.name || '';
    const pasteOwnerId  = selectedBrand?.ownerId || currentUser.uid;

    try {
      await addCampaignsBulk(pasteRows.map(row => ({
        brandId:       pasteBrandId,
        brandName,
        ownerId:       pasteOwnerId,
        addedBy:       currentUser.uid,
        addedByRole:   userRole || null,
        promotionName: row.promotionName,
        status:        row.status,
        startTime:     row.startTime ? new Date(row.startTime) : null,
        endTime:       row.endTime   ? new Date(row.endTime)   : null,
        type:          row.type,
        notes:         row.notes,
        reminders:     {},
      })));
      setShowModal(false);
      setPasteText('');
      setPasteRows(null);
      setPasteError('');
      setPasteBrandId('');
      refetch();
    } catch {
      setPasteError('Failed to save. Please try again.');
    }
    setConfirmingSave(false);
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteId) return;
    try { await deleteCampaign(deleteId); refetch(); } catch {}
    setDeleteId(null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{STYLES}</style>

      {/* ── Header ── */}
      <div className="d-flex align-items-start justify-content-between mb-4">
        <div>
          <h4 className="mb-1 fw-bold" style={{ color: '#1e293b' }}>Campaign Tracker</h4>
          <p className="mb-0 text-muted" style={{ fontSize: '0.82rem' }}>
            Track promotions across brands and get reminders before they expire.
          </p>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-primary btn-sm d-flex align-items-center gap-1" onClick={openAdd}>
            <i className="bi bi-plus-lg" style={{ fontSize: '0.8rem' }} />
            Add Campaign
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="card border-0 shadow-sm mb-3">
        <div className="card-body py-2 px-3">
          {/* Search bar */}
          <div className="position-relative mb-2">
            <i className="bi bi-search position-absolute"
              style={{ left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: '0.82rem' }} />
            <input
              className="form-control form-control-sm"
              placeholder="Search campaigns by name..."
              value={fSearch}
              onChange={e => setFSearch(e.target.value)}
              style={{ paddingLeft: 30, fontSize: '0.83rem' }}
            />
          </div>

          {/* Filter row */}
          <div className="d-flex flex-wrap gap-2 align-items-center">
            <select className="form-select form-select-sm" value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ width: 130 }}>
              <option value="">All Status</option>
              {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
            </select>

            <select className="form-select form-select-sm" value={fBrand} onChange={e => setFBrand(e.target.value)} style={{ width: 160 }}>
              <option value="">All Brands</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>

            <select className="form-select form-select-sm" value={fType} onChange={e => setFType(e.target.value)} style={{ width: 170 }}>
              <option value="">All Types</option>
              {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <select className="form-select form-select-sm" value={fAddedBy} onChange={e => setFAddedBy(e.target.value)} style={{ width: 170 }}>
              <option value="">All Added By</option>
              {addedByOptions.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>

            {/* Start time filter */}
            <div className="d-flex align-items-center gap-1">
              <span style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>Start from</span>
              <input
                type="date"
                className="form-control form-control-sm"
                value={fStartFrom}
                onChange={e => setFStartFrom(e.target.value)}
                style={{ width: 140, fontSize: '0.78rem' }}
              />
            </div>

            {/* End time filter */}
            <div className="d-flex align-items-center gap-1">
              <span style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>End by</span>
              <input
                type="date"
                className="form-control form-control-sm"
                value={fEndTo}
                onChange={e => setFEndTo(e.target.value)}
                style={{ width: 140, fontSize: '0.78rem' }}
              />
            </div>

            {hasFilters && (
              <button className="btn btn-link btn-sm text-muted py-0 px-1" onClick={clearFilters}>
                <i className="bi bi-x-circle me-1" style={{ fontSize: '0.75rem' }} />Clear
              </button>
            )}

            <span className="ms-auto text-muted" style={{ fontSize: '0.75rem' }}>
              {filtered.length}{hasFilters && campaigns.length !== filtered.length ? ` / ${campaigns.length}` : ''} campaign{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="text-center py-5 text-muted">
          <div className="spinner-border spinner-border-sm" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-5 text-muted">
          <i className="bi bi-megaphone" style={{ fontSize: '2.5rem', display: 'block', marginBottom: 10, opacity: 0.4 }} />
          <div style={{ fontWeight: 500 }}>
            {hasFilters ? 'No campaigns match the current filters.' : 'No campaigns yet.'}
          </div>
          {!hasFilters && (
            <button className="btn btn-primary btn-sm mt-3" onClick={openAdd}>
              <i className="bi bi-plus-lg me-1" />Add your first campaign
            </button>
          )}
        </div>
      ) : (
        <div className="card border-0 shadow-sm">
          <div className="table-responsive">
            <table className="table table-hover mb-0" style={{ fontSize: '0.83rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  {['Brand', 'Promotion Name', 'Status', 'Start Time', 'End Time', 'Type', 'Days Left', ''].map(h => (
                    <th key={h} className="px-3 py-2 fw-semibold" style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const effStatus = effectiveStatus(c);
                  const st = STATUS_STYLE[effStatus] || STATUS_STYLE.Ended;
                  return (
                    <tr
                      key={c.id}
                      style={deleteId === c.id ? { background: 'rgba(239,68,68,0.04)' } : {}}
                    >
                      <td className="px-3 py-2 fw-medium" style={{ whiteSpace: 'nowrap' }}>
                        {c.brandName || <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2" style={{ maxWidth: 260 }}>
                        <div className="fw-medium text-truncate">{c.promotionName}</div>
                        {c.notes && (
                          <div className="text-muted text-truncate" style={{ fontSize: '0.72rem' }}>{c.notes}</div>
                        )}
                        {c.addedByName && (
                          <div className="d-inline-flex align-items-center gap-1 mt-1" style={{ fontSize: '0.68rem', color: '#64748b' }}>
                            <i className="bi bi-person-circle" />
                            <span>Added by <span className="fw-medium">{c.addedByName}</span></span>
                            {c.addedByRole && (
                              <span className="badge bg-light text-muted border" style={{ fontSize: '0.58rem', padding: '1px 5px' }}>
                                {c.addedByRole.toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="badge rounded-pill" style={{
                          background: st.bg, color: st.color,
                          border: `1px solid ${st.border}`,
                          fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px',
                        }}>
                          {effStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.startTime)}</td>
                      <td className="px-3 py-2 text-muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.endTime, 'Indefinite')}</td>
                      <td className="px-3 py-2 text-muted">{c.type || '—'}</td>
                      <td className="px-3 py-2">
                        <DaysLeftBadge ts={c.endTime} status={effStatus} />
                      </td>
                      <td className="px-3 py-2" style={{ whiteSpace: 'nowrap' }}>
                        {deleteId === c.id ? (
                          <div className="d-flex align-items-center gap-1">
                            <span style={{ fontSize: '0.72rem', color: '#dc2626' }}>Delete?</span>
                            <button
                              className="btn btn-danger btn-sm py-0 px-2"
                              style={{ fontSize: '0.72rem' }}
                              onClick={handleDelete}
                            >Yes</button>
                            <button
                              className="btn btn-light btn-sm py-0 px-2"
                              style={{ fontSize: '0.72rem' }}
                              onClick={() => setDeleteId(null)}
                            >No</button>
                          </div>
                        ) : (
                          <div className="d-flex gap-1">
                            <button
                              className="btn btn-light btn-sm py-0 px-2"
                              title="Edit"
                              onClick={() => openEdit(c)}
                            >
                              <i className="bi bi-pencil" style={{ fontSize: '0.75rem' }} />
                            </button>
                            <button
                              className="btn btn-light btn-sm py-0 px-2"
                              title="Delete"
                              onClick={() => setDeleteId(c.id)}
                            >
                              <i className="bi bi-trash" style={{ fontSize: '0.75rem' }} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          Add / Edit Modal
      ══════════════════════════════════════════════════════════════════════ */}
      {showModal && (
        <div className="modal show d-block" style={{ background: 'rgba(0,0,0,0.45)', zIndex: 1050 }}>
          <div className="modal-dialog modal-lg modal-dialog-scrollable" style={{ maxWidth: modalTab === 'paste' && pasteRows ? 860 : 600 }}>
            <div className="modal-content">

              {/* Header */}
              <div className="modal-header border-0 pb-0">
                <h5 className="modal-title fw-bold">
                  {modalMode === 'add' ? 'Add Campaign' : 'Edit Campaign'}
                </h5>
                <button className="btn-close" onClick={() => setShowModal(false)} />
              </div>

              {/* Tab switcher (add mode only) */}
              {modalMode === 'add' && (
                <div className="px-4" style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <button
                    className={`ct-modal-tab-btn ${modalTab === 'manual' ? 'active' : ''}`}
                    onClick={() => { setModalTab('manual'); setFormError(''); }}
                  >
                    <i className="bi bi-pencil-square me-2" />Manual
                  </button>
                  <button
                    className={`ct-modal-tab-btn ${modalTab === 'paste' ? 'active' : ''}`}
                    onClick={() => { setModalTab('paste'); setFormError(''); }}
                  >
                    <i className="bi bi-clipboard-data me-2" />Paste &amp; Parse
                  </button>
                </div>
              )}

              <div className="modal-body pt-3">

                {/* ── Manual Form ── */}
                {(modalTab === 'manual' || modalMode === 'edit') && (
                  <div className="row g-3">
                    {/* Brand */}
                    <div className="col-12">
                      <label className="form-label fw-medium mb-1">Brand <span className="text-danger">*</span></label>
                      <select
                        className="form-select"
                        value={form.brandId}
                        onChange={e => {
                          const b = brands.find(x => x.id === e.target.value);
                          setForm(f => ({ ...f, brandId: e.target.value, brandName: b?.name || '' }));
                        }}
                      >
                        <option value="">Select brand...</option>
                        {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>

                    {/* Promotion Name */}
                    <div className="col-12">
                      <label className="form-label fw-medium mb-1">Promotion Name <span className="text-danger">*</span></label>
                      <input
                        className="form-control"
                        value={form.promotionName}
                        onChange={e => setForm(f => ({ ...f, promotionName: e.target.value }))}
                        placeholder="e.g. Summer Bundle Deal"
                      />
                    </div>

                    {/* Status + Type */}
                    <div className="col-md-5">
                      <label className="form-label fw-medium mb-1">Status</label>
                      <select
                        className="form-select"
                        value={form.status}
                        onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                      >
                        {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="col-md-7">
                      <label className="form-label fw-medium mb-1">Type</label>
                      <input
                        className="form-control"
                        value={form.type}
                        onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                        placeholder="e.g. Coupon, Bundle, Flash Sale"
                      />
                    </div>

                    {/* Start Time */}
                    <div className="col-md-6">
                      <label className="form-label fw-medium mb-1">Start Time</label>
                      <input
                        type="datetime-local"
                        className="form-control"
                        value={form.startTime}
                        onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                      />
                    </div>

                    {/* End Time */}
                    <div className="col-md-6">
                      <label className="form-label fw-medium mb-1">End Time <span className="text-muted" style={{ fontSize: '0.72rem', fontWeight: 400 }}>(leave empty for indefinite)</span></label>
                      <input
                        type="datetime-local"
                        className="form-control"
                        value={form.endTime}
                        onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                      />
                    </div>

                    {/* Notes */}
                    <div className="col-12">
                      <label className="form-label fw-medium mb-1">Notes</label>
                      <textarea
                        className="form-control"
                        value={form.notes}
                        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                        rows={2}
                        placeholder="Optional notes..."
                      />
                    </div>
                  </div>
                )}

                {/* ── Paste & Parse Tab ── */}
                {modalTab === 'paste' && modalMode === 'add' && (
                  <div>
                    {/* Brand selector (applies to all rows) */}
                    <div className="mb-3">
                      <label className="form-label fw-medium mb-1">
                        Brand <span className="text-danger">*</span>
                        <span className="text-muted fw-normal ms-1" style={{ fontSize: '0.78rem' }}>(applies to all pasted rows)</span>
                      </label>
                      <select
                        className="form-select"
                        value={pasteBrandId}
                        onChange={e => setPasteBrandId(e.target.value)}
                      >
                        <option value="">Select brand...</option>
                        {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>

                    {/* Step 1 — paste textarea */}
                    {!pasteRows && (
                      <>
                        <label className="form-label fw-medium mb-1">Paste Promotions Data</label>
                        <p className="text-muted mb-2" style={{ fontSize: '0.78rem' }}>
                          Copy the promotions table directly from TikTok Shop Seller Center and paste it below.
                          The app auto-detects columns (Name, Status, Start/End Time, Type).
                        </p>
                        <textarea
                          className="form-control font-monospace"
                          value={pasteText}
                          onChange={e => { setPasteText(e.target.value); setPasteError(''); }}
                          rows={8}
                          placeholder="Paste copied table data here..."
                          style={{ fontSize: '0.78rem', resize: 'vertical' }}
                        />
                        {pasteError && (
                          <div className="text-danger mt-1" style={{ fontSize: '0.8rem' }}>
                            <i className="bi bi-exclamation-circle me-1" />{pasteError}
                          </div>
                        )}
                        <button
                          className="btn btn-outline-primary btn-sm mt-2"
                          onClick={handleParse}
                          disabled={!pasteText.trim()}
                        >
                          <i className="bi bi-magic me-1" />Parse Data
                        </button>
                      </>
                    )}

                    {/* Step 2 — editable preview table */}
                    {pasteRows && (
                      <>
                        <div className="d-flex align-items-center justify-content-between mb-2">
                          <span className="fw-medium" style={{ fontSize: '0.85rem' }}>
                            <i className="bi bi-check-circle text-success me-1" />
                            {pasteRows.length} campaign{pasteRows.length !== 1 ? 's' : ''} detected — review and edit if needed
                          </span>
                          <button
                            className="btn btn-link btn-sm text-muted py-0"
                            onClick={() => { setPasteRows(null); setPasteError(''); }}
                          >
                            <i className="bi bi-arrow-counterclockwise me-1" />Re-paste
                          </button>
                        </div>

                        {pasteError && (
                          <div className="text-danger mb-2" style={{ fontSize: '0.8rem' }}>
                            <i className="bi bi-exclamation-circle me-1" />{pasteError}
                          </div>
                        )}

                        {pasteRows.length === 0 ? (
                          <div className="text-muted text-center py-3" style={{ fontSize: '0.82rem' }}>
                            All rows removed. Re-paste to start over.
                          </div>
                        ) : (
                          <div style={{ overflowX: 'auto' }}>
                            <table className="table table-sm table-bordered ct-paste-table mb-0" style={{ minWidth: 700 }}>
                              <thead style={{ background: '#f8fafc' }}>
                                <tr>
                                  <th style={{ width: 30, textAlign: 'center', fontSize: '0.72rem', color: '#64748b' }}>#</th>
                                  <th style={{ fontSize: '0.72rem', color: '#64748b' }}>Promotion Name</th>
                                  <th style={{ width: 130, fontSize: '0.72rem', color: '#64748b' }}>Status</th>
                                  <th style={{ width: 165, fontSize: '0.72rem', color: '#64748b' }}>Start Time</th>
                                  <th style={{ width: 165, fontSize: '0.72rem', color: '#64748b' }}>End Time</th>
                                  <th style={{ width: 115, fontSize: '0.72rem', color: '#64748b' }}>Type</th>
                                  <th style={{ width: 115, fontSize: '0.72rem', color: '#64748b' }}>Notes</th>
                                  <th style={{ width: 32 }} />
                                </tr>
                              </thead>
                              <tbody>
                                {pasteRows.map((row, i) => (
                                  <tr key={i}>
                                    <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.72rem' }}>{i + 1}</td>
                                    <td>
                                      <input
                                        value={row.promotionName}
                                        onChange={e => updatePasteRow(i, 'promotionName', e.target.value)}
                                        placeholder="Promotion name"
                                      />
                                    </td>
                                    <td>
                                      <select
                                        value={row.status}
                                        onChange={e => updatePasteRow(i, 'status', e.target.value)}
                                      >
                                        {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
                                      </select>
                                    </td>
                                    <td>
                                      <input
                                        type="datetime-local"
                                        value={row.startTime}
                                        onChange={e => updatePasteRow(i, 'startTime', e.target.value)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        type="datetime-local"
                                        value={row.endTime}
                                        onChange={e => updatePasteRow(i, 'endTime', e.target.value)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        value={row.type}
                                        onChange={e => updatePasteRow(i, 'type', e.target.value)}
                                        placeholder="Type"
                                      />
                                    </td>
                                    <td>
                                      <input
                                        value={row.notes}
                                        onChange={e => updatePasteRow(i, 'notes', e.target.value)}
                                        placeholder="Notes..."
                                      />
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <button
                                        className="btn btn-link p-0"
                                        style={{ color: '#ef4444', lineHeight: 1 }}
                                        onClick={() => updatePasteRow(i, '__delete__')}
                                        title="Remove row"
                                      >
                                        <i className="bi bi-x-lg" style={{ fontSize: '0.75rem' }} />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Form-level error */}
                {formError && (
                  <div className="alert alert-danger mt-3 py-2 mb-0" style={{ fontSize: '0.82rem' }}>
                    <i className="bi bi-exclamation-circle me-1" />{formError}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="modal-footer border-0 pt-0">
                <button className="btn btn-light" onClick={() => setShowModal(false)}>Cancel</button>

                {(modalTab === 'manual' || modalMode === 'edit') && (
                  <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                    {saving
                      ? <><span className="spinner-border spinner-border-sm me-1" />Saving...</>
                      : modalMode === 'add' ? 'Add Campaign' : 'Save Changes'
                    }
                  </button>
                )}

                {modalTab === 'paste' && modalMode === 'add' && pasteRows && pasteRows.length > 0 && (
                  <button
                    className="btn btn-success"
                    onClick={handleConfirmPaste}
                    disabled={confirmingSave}
                  >
                    {confirmingSave
                      ? <><span className="spinner-border spinner-border-sm me-1" />Saving...</>
                      : <><i className="bi bi-check2 me-1" />Confirm &amp; Add {pasteRows.length} Campaign{pasteRows.length !== 1 ? 's' : ''}</>
                    }
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
