// ============================================================
// Settings → Menu Layout. Lets a user reorder their sidebar and pin items to
// the top. Purely a per-user preference over their OWN role menu — it can only
// reorder/pin entries the role already has (never adds anything). Persisted to
// profiles.menu_layout (mig 265) exactly like notification_prefs.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { updateUserProfile } from '../../../lib/adminApi';
import { getMenuForRole, menuKey, applyMenuLayout } from '../../../components/layout/menu';
import { BookmarkIcon, AlertIcon, CheckIcon, StarIcon, ChevronDownIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function MenuLayoutSection() {
  const { user, profile, refreshProfile } = useAuth();
  const role = profile?.role;

  // The role menu (post-injection) + a key→entry map for rendering.
  const base = useMemo(() => (role ? getMenuForRole(role) : []), [role]);
  const entryByKey = useMemo(() => new Map(base.map((e) => [menuKey(e), e])), [base]);
  const defaultKeys = useMemo(() => base.map(menuKey), [base]);

  const deriveFromSaved = useMemo(() => (saved) => {
    const t = applyMenuLayout(base, saved || {});
    return {
      pinnedKeys: t.filter((e) => e._pinned).map(menuKey),
      restKeys: t.filter((e) => !e._pinned).map(menuKey),
    };
  }, [base]);

  const [pinnedKeys, setPinnedKeys] = useState(() => deriveFromSaved(profile?.menu_layout).pinnedKeys);
  const [restKeys, setRestKeys] = useState(() => deriveFromSaved(profile?.menu_layout).restKeys);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  // Re-sync from the stored value whenever it changes (our own save via
  // refreshProfile, or a change from another device). No profile change fires
  // during local editing, so this never clobbers unsaved edits.
  useEffect(() => {
    const { pinnedKeys: p, restKeys: r } = deriveFromSaved(profile?.menu_layout);
    setPinnedKeys(p); setRestKeys(r);
  }, [profile?.menu_layout, deriveFromSaved]);

  const savedNorm = useMemo(() => {
    const { pinnedKeys: p, restKeys: r } = deriveFromSaved(profile?.menu_layout);
    return { order: [...p, ...r], pinned: [...p] };
  }, [profile?.menu_layout, deriveFromSaved]);
  const current = { order: [...pinnedKeys, ...restKeys], pinned: [...pinnedKeys] };
  const dirty = !eq(current, savedNorm);
  const isDefault = pinnedKeys.length === 0 && eq(restKeys, defaultKeys);

  // ── mutations ──────────────────────────────────────────────────────
  const dragRef = useRef(null); // { list, key }

  const moveWithin = (list, fromKey, toKey) => {
    const arr = list.filter((k) => k !== fromKey);
    const idx = arr.indexOf(toKey);
    if (idx < 0) return list;
    arr.splice(idx, 0, fromKey);
    return arr;
  };
  const onDragOverRow = (listId, overKey, e) => {
    e.preventDefault();
    const d = dragRef.current;
    if (!d || d.list !== listId || d.key === overKey) return;
    if (listId === 'pinned') setPinnedKeys((cur) => moveWithin(cur, d.key, overKey));
    else setRestKeys((cur) => moveWithin(cur, d.key, overKey));
  };

  const bump = (listId, key, dir) => {
    const setList = listId === 'pinned' ? setPinnedKeys : setRestKeys;
    setList((cur) => {
      const i = cur.indexOf(key); const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const arr = [...cur]; [arr[i], arr[j]] = [arr[j], arr[i]]; return arr;
    });
  };

  const insertByBase = (list, key) => {
    const idxOf = (k) => defaultKeys.indexOf(k);
    const target = idxOf(key);
    const arr = [...list]; let i = 0;
    while (i < arr.length && idxOf(arr[i]) < target && idxOf(arr[i]) !== -1) i++;
    arr.splice(i, 0, key);
    return arr;
  };
  const pin = (key) => { setRestKeys((c) => c.filter((k) => k !== key)); setPinnedKeys((c) => (c.includes(key) ? c : [...c, key])); };
  const unpin = (key) => { setPinnedKeys((c) => c.filter((k) => k !== key)); setRestKeys((c) => insertByBase(c, key)); };

  function resetToDefault() {
    setPinnedKeys([]);
    setRestKeys(defaultKeys);
  }

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      await updateUserProfile(user.id, { menu_layout: isDefault ? {} : current });
      await refreshProfile();
      setOk('Menu layout saved.');
      setTimeout(() => setOk(''), 2500);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  if (!role) {
    return (
      <SectionShell icon={BookmarkIcon} title="Menu layout" subtitle="Pin & order your sidebar items">
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
      </SectionShell>
    );
  }

  const rowProps = (listId, key, i, len) => ({
    entry: entryByKey.get(key), keyStr: key, listId,
    isPinned: listId === 'pinned',
    canUp: i > 0, canDown: i < len - 1,
    onUp: () => bump(listId, key, -1),
    onDown: () => bump(listId, key, 1),
    onPinToggle: () => (listId === 'pinned' ? unpin(key) : pin(key)),
    onDragStart: () => { dragRef.current = { list: listId, key }; },
    onDragOver: (e) => onDragOverRow(listId, key, e),
    onDragEnd: () => { dragRef.current = null; },
  });

  return (
    <SectionShell
      icon={BookmarkIcon}
      title="Menu layout"
      subtitle="Reorder your sidebar and pin the items you use most to the top. This changes only your own menu."
    >
      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
      {ok && <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}><CheckIcon width="14" height="14" /> <span>{ok}</span></div>}

      {/* Pinned */}
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '2px 0 8px' }}>
        Pinned {pinnedKeys.length > 0 && <span style={{ color: 'var(--accent)' }}>({pinnedKeys.length})</span>}
      </div>
      {pinnedKeys.length === 0 ? (
        <div style={{ border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-md)', padding: '14px 16px', color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 18 }}>
          No pinned items. Click the <StarIcon width="12" height="12" /> star on any item below to keep it at the top of your sidebar.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {pinnedKeys.map((k, i) => <Row key={k} {...rowProps('pinned', k, i, pinnedKeys.length)} />)}
        </div>
      )}

      {/* All items */}
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '2px 0 8px' }}>Menu order</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {restKeys.map((k, i) => <Row key={k} {...rowProps('rest', k, i, restKeys.length)} />)}
      </div>

      <div className="settings-footer-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save layout'}
        </button>
        <button className="wx-btn wx-btn-ghost" onClick={resetToDefault} disabled={saving || isDefault}>
          Reset to default
        </button>
      </div>
    </SectionShell>
  );
}

// ── one draggable row ──────────────────────────────────────────────
function Row({ entry, keyStr, isPinned, canUp, canDown, onUp, onDown, onPinToggle, onDragStart, onDragOver, onDragEnd }) {
  if (!entry) return null;
  const Icon = entry.icon;
  const isGroup = !!entry.children;
  const btn = { display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'var(--surface-1)', cursor: 'pointer', color: 'var(--text-secondary)' };
  const btnDim = (on) => ({ ...btn, opacity: on ? 1 : 0.35, cursor: on ? 'pointer' : 'not-allowed' });
  return (
    <div
      onDragOver={onDragOver}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--surface-1)' }}
    >
      <span
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag to reorder"
        style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, userSelect: 'none', padding: '0 2px' }}
      >⠿</span>
      <span style={{ display: 'grid', placeItems: 'center', width: 22, color: 'var(--text-secondary)' }}>
        {Icon ? <Icon width="16" height="16" /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        {entry.label}
        {isGroup && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 5, padding: '1px 6px' }}>group</span>}
      </span>
      <button type="button" style={btnDim(canUp)} disabled={!canUp} onClick={onUp} aria-label="Move up"><ChevronDownIcon width="14" height="14" style={{ transform: 'rotate(180deg)' }} /></button>
      <button type="button" style={btnDim(canDown)} disabled={!canDown} onClick={onDown} aria-label="Move down"><ChevronDownIcon width="14" height="14" /></button>
      <button
        type="button"
        onClick={onPinToggle}
        aria-label={isPinned ? 'Unpin' : 'Pin'}
        title={isPinned ? 'Unpin' : 'Pin to top'}
        style={{ ...btn, width: 30, color: isPinned ? '#f59e0b' : 'var(--text-muted)', borderColor: isPinned ? '#f59e0b' : 'var(--border-subtle)', background: isPinned ? 'color-mix(in srgb, #f59e0b 12%, transparent)' : 'var(--surface-1)' }}
      >
        <StarIcon width="15" height="15" fill={isPinned ? '#f59e0b' : 'none'} />
      </button>
    </div>
  );
}
