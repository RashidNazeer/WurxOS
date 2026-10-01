import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { createResource, updateResource, detectSource } from '../../lib/resourcesApi';
import { ROLES } from '../../lib/roles';
import {
  AlertIcon, XIcon, CheckIcon, StarIcon, UserIcon, UsersIcon,
} from '../common/Icon';
// table.css came along with this modal's old home (pages/resources/ResourcesPage)
// and the Brand -> Resources panel relies on it; keep loading it here.
import '../../styles/table.css';
import '../../styles/modal.css';

const DESCRIPTION_MAX = 240;

// ============================================================
// Add / Edit modal — covers all v1 visibility scopes.
// ============================================================
export function ResourceModal({
  mode = 'create', resource = null, brands = [],
  canPickBrand = false, lockedBrandId = null,
  onClose, onSaved,
}) {
  const isEdit = mode === 'edit';
  const [name, setName]               = useState(resource?.name || '');
  const [url,  setUrl]                = useState(resource?.url  || '');
  const [desc, setDesc]               = useState(resource?.description || '');
  const [brandId, setBrandId]         = useState(resource?.brand_id || lockedBrandId || '');
  const [scope, setScope]             = useState(
    (resource?.brand_id || lockedBrandId) ? 'brand' : 'general',
  );
  const [visibility, setVisibility]   = useState(resource?.visibility || 'office');
  const [visibleToUid, setUid]        = useState(resource?.visible_to_uid || '');
  const [visibleToRoles, setRoles]    = useState(resource?.visible_to_roles || []);
  const [users, setUsers]             = useState([]);
  // Opt-in notifications — default off so silent edits don't ping
  // the brand team / group.
  const [notify, setNotify]           = useState(false);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  const detected = detectSource(url);

  // Lazy-load profiles for the user picker only when needed
  if (visibility === 'user' && users.length === 0) {
    supabase.from('profiles').select('id, display_name, email, role')
      .eq('is_active', true).order('display_name')
      .then(({ data }) => setUsers(data || []));
  }

  function toggleRole(r) {
    setRoles((cur) => cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]);
  }

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!name.trim() || !url.trim()) return setErr('Name and URL are required.');
    if (scope === 'brand' && !brandId) return setErr('Pick a brand for brand-scoped resources.');
    if (scope === 'general' && visibility === 'user' && !visibleToUid)
      return setErr('Pick the user this resource is shared with.');
    if (scope === 'general' && visibility === 'group' && visibleToRoles.length === 0)
      return setErr('Pick at least one role for group visibility.');
    setSaving(true);
    try {
      const payload = {
        brandId:        scope === 'brand'   ? brandId : null,
        type:           detected.type,
        name, url, description: desc,
        visibility:     scope === 'brand'   ? 'office' : visibility,
        visibleToUid:   visibility === 'user'  ? visibleToUid : null,
        visibleToRoles: visibility === 'group' ? visibleToRoles : [],
        notify,
      };
      if (isEdit) await updateResource(resource.id, payload);
      else        await createResource(payload);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  // --- URL helpers ----------------------------------------------
  // Strip the protocol we render as a pill prefix so the input field
  // shows only what the user types after "https://". Paste also works —
  // the onChange handler normalizes either http/https away.
  const urlCore = url.replace(/^https?:\/\//i, '');
  const urlStatus = (() => {
    if (!urlCore.trim()) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(urlCore)) return { tone: 'warn', label: 'Awaiting' };
    return { tone: 'ok', label: detected.label };
  })();

  // --- Keyboard shortcuts: Esc closes, Cmd/Ctrl+Enter submits ---
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('wx-resource-form')?.requestSubmit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const scopeCards = [
    { v: 'brand',   title: 'Brand',   sub: 'Brand-specific',          Icon: StarIcon },
    { v: 'general', title: 'General', sub: 'Visible across the workspace', Icon: GlobeGlyph },
  ];
  const visCards = [
    { v: 'private', label: 'Only me',       Icon: UserIcon },
    { v: 'user',    label: 'Specific user', Icon: UserPlusGlyph },
    { v: 'group',   label: 'Roles',         Icon: UsersIcon },
    { v: 'office',  label: 'Everyone',      Icon: GlobeGlyph },
  ];

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form id="wx-resource-form" onSubmit={submit}>
          {/* ---------- Header ---------- */}
          <div className="wx-m-head">
            <div className="wx-m-head-icon"><ResourceGlyph /></div>
            <div className="wx-m-head-text">
              <div className="wx-m-head-title">{isEdit ? 'Edit resource' : 'Add resource'}</div>
              <div className="wx-m-head-sub">Share a link, doc, or tool with your team</div>
            </div>
            <button type="button" className="wx-m-head-close" onClick={onClose} aria-label="Close">
              <XIcon width="14" height="14" />
            </button>
          </div>

          {/* ---------- Body ---------- */}
          <div className="wx-m-body">
            {err && (
              <div className="wx-alert wx-alert-danger">
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}

            {/* Name */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Resource name</div>
                <div className="wx-m-field-meta is-required">Required</div>
              </div>
              <input
                className="wx-m-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                autoFocus
                placeholder="e.g. Q2 Brand Guidelines"
              />
            </div>

            {/* URL */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">URL</div>
                <div className="wx-m-field-meta">Must be reachable</div>
              </div>
              <div className="wx-m-input-shell">
                <div className="wx-m-input-prefix">https://</div>
                <input
                  value={urlCore}
                  onChange={(e) => {
                    const stripped = e.target.value.replace(/^https?:\/\//i, '');
                    setUrl(stripped ? 'https://' + stripped : '');
                  }}
                  disabled={saving}
                  placeholder="notion.so/brand-guide"
                />
                {urlStatus && (
                  <span className={`wx-m-input-suffix is-${urlStatus.tone}`}>{urlStatus.label}</span>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Description</div>
                <div className="wx-m-field-meta">Optional</div>
              </div>
              <div className="wx-m-textarea-shell">
                <textarea
                  rows={3}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value.slice(0, DESCRIPTION_MAX))}
                  disabled={saving}
                  placeholder="A short note so teammates know what this is for…"
                />
                <div className={`wx-m-char-count ${desc.length > DESCRIPTION_MAX - 20 ? 'is-warn' : ''}`}>
                  {desc.length} / {DESCRIPTION_MAX}
                </div>
              </div>
            </div>

            {/* Scope */}
            {!lockedBrandId && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Scope</div>
                  <div className="wx-m-field-meta">
                    {scope === 'brand' ? 'Pinned to one brand' : 'Visible across the workspace'}
                  </div>
                </div>
                <div className="wx-m-cards" data-cols="2">
                  {scopeCards.map((c) => (
                    <button key={c.v} type="button"
                      className={`wx-m-card ${scope === c.v ? 'is-active' : ''}`}
                      onClick={() => setScope(c.v)} disabled={saving}>
                      <div className="wx-m-card-icon"><c.Icon width="15" height="15" /></div>
                      <div className="wx-m-card-main">
                        <div className="wx-m-card-title">{c.title}</div>
                        <div className="wx-m-card-sub">{c.sub}</div>
                      </div>
                      <span className="wx-m-card-check"><CheckIcon width="11" height="11" /></span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scope === 'brand' && !lockedBrandId && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Brand</div>
                  <div className="wx-m-field-meta is-required">Required</div>
                </div>
                <select className="wx-m-input" value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  disabled={saving || !canPickBrand}>
                  <option value="">— pick a brand —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
                </select>
              </div>
            )}

            {scope === 'general' && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Visibility</div>
                  <div className="wx-m-field-meta">
                    {visibility === 'group' && visibleToRoles.length > 0
                      ? `${visibleToRoles.length} role${visibleToRoles.length === 1 ? '' : 's'} will see this`
                      : visibility === 'private' ? 'Only you will see this'
                      : visibility === 'office'  ? 'Everyone in the workspace'
                      : visibility === 'user'    ? 'One teammate will see this'
                      : ''}
                  </div>
                </div>
                <div className="wx-m-cards" data-cols="4">
                  {visCards.map((c) => (
                    <button key={c.v} type="button"
                      className={`wx-m-card is-compact ${visibility === c.v ? 'is-active' : ''}`}
                      onClick={() => setVisibility(c.v)} disabled={saving}>
                      <div className="wx-m-card-icon"><c.Icon width="15" height="15" /></div>
                      <div className="wx-m-card-title">{c.label}</div>
                      <span className="wx-m-card-check"><CheckIcon width="11" height="11" /></span>
                    </button>
                  ))}
                </div>

                {visibility === 'user' && (
                  <select className="wx-m-input" style={{ marginTop: 8 }}
                    value={visibleToUid} onChange={(e) => setUid(e.target.value)} disabled={saving}>
                    <option value="">— pick a user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.role}</option>)}
                  </select>
                )}

                {visibility === 'group' && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {ROLES.map((r) => (
                      <button key={r.value} type="button"
                        className={`wx-role-chip ${visibleToRoles.includes(r.value) ? 'wx-role-chip-active' : ''}`}
                        onClick={() => toggleRole(r.value)} disabled={saving}>{r.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Opt-in notifications — default off. Audience follows scope. */}
            <label className={`wx-m-optin ${notify ? 'is-active' : ''}`}>
              <input type="checkbox" checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                disabled={saving} />
              <div>
                <div className="wx-m-optin-title">Notify the audience</div>
                <div className="wx-m-optin-sub">
                  {scope === 'brand'
                    ? 'Send the brand owner and assigned APCs an in-app + push notification.'
                    : visibility === 'user'
                      ? 'Send the selected user an in-app + push notification.'
                      : visibility === 'group'
                        ? 'Send everyone in the selected roles an in-app + push notification.'
                        : 'Leave off for a silent change — no notification is sent.'}
                </div>
              </div>
            </label>
          </div>

          {/* ---------- Footer ---------- */}
          <div className="wx-m-foot">
            <div className="wx-m-kbd-hints">
              <kbd>Esc</kbd> cancel
              <span>·</span>
              <kbd>⌘</kbd><kbd>↵</kbd> submit
            </div>
            <div className="wx-m-foot-actions">
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
                {saving
                  ? <><span className="wx-spinner" /> {isEdit ? 'Saving…' : 'Adding…'}</>
                  : <><CheckIcon width="14" height="14" /> {isEdit ? 'Save changes' : 'Add resource'}</>}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Inline glyphs used in the resource modal only --------------
function ResourceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 13a2 2 0 0 1 2-2h2" />
      <path d="M14 17a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}
function GlobeGlyph(props) {
  return (
    <svg width={props.width || 15} height={props.height || 15} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function UserPlusGlyph(props) {
  return (
    <svg width={props.width || 15} height={props.height || 15} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}
