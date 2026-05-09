import { useMemo, useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  fetchCreators, formatMonth, PAYMENT_STATUSES, VIDEO_STATUSES, statusLabel,
  tiktokEmbedUrl,
} from '../../lib/paidCollabRemote';
import {
  listMySelectedBrands, listPaidCollabEligibleBrands,
  selectBrand, unselectBrand,
} from '../../lib/paidCollabApi';
import { paidCollabStatusLabel } from '../../lib/roles';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, StoreIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/brands.css';
import '../../styles/paidCollab.css';

export default function PaidCollabBrandsPage() {
  const { user, profile } = useAuth();
  const role   = profile?.role;
  const pctlId = user?.id;
  const isPCTL = role === 'pctl';

  const [q, setQ]                   = useState('');
  const [month, setMonth]           = useState('all');
  const [showPicker, setShowPicker] = useState(false);
  const [activeBrand, setActiveBrand] = useState(null);  // drilldown modal

  const qc = useQueryClient();

  // API data — the source of truth for brands/creators/videos (v1 parity).
  const { data: creators = [], isLoading: loadingCreators, error: apiErr } = useQuery({
    queryKey: ['paid-collab', 'creators'],
    queryFn:  () => fetchCreators({ force: false }),
  });

  // PCTL selection lives in Supabase (v2-only feature).
  const selectionResults = useQueries({
    queries: [
      { queryKey: ['pc-brands', 'selected', pctlId], queryFn: () => listMySelectedBrands(pctlId),   enabled: !!pctlId && isPCTL },
      { queryKey: ['pc-brands', 'eligible'],         queryFn: () => listPaidCollabEligibleBrands(), enabled: isPCTL },
    ],
  });
  const [selectedQ, eligibleQ] = selectionResults;
  const selectedWorkspace = selectedQ.data || [];
  const eligibleWorkspace = eligibleQ.data || [];
  const selectedByName = useMemo(() => {
    const s = new Set();
    for (const b of selectedWorkspace) s.add((b.brand_name || '').trim().toLowerCase());
    return s;
  }, [selectedWorkspace]);

  const loading = loadingCreators || (isPCTL && selectionResults.some((r) => r.isPending));
  const err     = apiErr?.message || selectionResults.find((r) => r.error)?.error?.message || '';

  const load = async (force = false) => {
    if (force) { try { await fetchCreators({ force: true }); } catch {} }
    qc.invalidateQueries({ queryKey: ['paid-collab'] });
    qc.invalidateQueries({ queryKey: ['pc-brands'] });
  };

  // --- Derive brands from API creators, filtered by month ---
  const months = useMemo(() => {
    const s = new Set(creators.map((c) => c.hiringMonth).filter(Boolean));
    return Array.from(s).sort().reverse();
  }, [creators]);

  const brands = useMemo(() => {
    const inMonth = (c) => month === 'all' || c.hiringMonth === month;
    // Stable per-creator key — handle wins, falls back to name. Same logic
    // as the PCTL dashboard so counts agree across pages.
    const creatorKey = (c) => {
      const handle = (c.tiktokAccount || '').toLowerCase().replace(/\/+$/, '').trim();
      if (handle) return handle;
      const n = (c.name || '').toLowerCase().trim();
      return n ? `name:${n}` : '';
    };
    const byBrand = new Map();
    for (const c of creators) {
      if (!c.brand) continue;
      if (!inMonth(c)) continue;
      const key = c.brand.trim();
      if (!byBrand.has(key)) {
        byBrand.set(key, {
          name:          key,
          creatorSet:    new Set(),  // unique creator keys
          deals:         0,           // raw deal-record count
          videos:        0,
          totalDeal:     0,
          paidDeal:      0,
          paymentCounts: { paid: 0, pending: 0, not_yet: 0 },
          videoCounts:   { paid: 0, pending: 0, not_yet: 0 },
          products:      new Set(),
          latestHire:    '',
        });
      }
      const b = byBrand.get(key);
      const k = creatorKey(c);
      if (k) b.creatorSet.add(k);
      b.deals  += 1;
      b.videos += Array.isArray(c.videoCodes) ? c.videoCodes.length : 0;
      b.totalDeal += Number(c.dealAmount || 0);
      if (c.paymentStatus === 'paid') b.paidDeal += Number(c.dealAmount || 0);
      b.paymentCounts[c.paymentStatus] = (b.paymentCounts[c.paymentStatus] || 0) + 1;
      b.videoCounts[c.videosStatus]    = (b.videoCounts[c.videosStatus] || 0) + 1;
      if (c.product) b.products.add(c.product);
      if (c.hiringDate && c.hiringDate > b.latestHire) b.latestHire = c.hiringDate;
    }
    return Array.from(byBrand.values())
      .map((b) => ({
        ...b,
        creators: b.creatorSet.size,    // expose unique-creator count
        products: Array.from(b.products),
      }))
      .sort((a, b) => b.deals - a.deals);
  }, [creators, month]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return brands;
    return brands.filter((b) =>
      b.name.toLowerCase().includes(qq) ||
      b.products.some((p) => (p || '').toLowerCase().includes(qq)),
    );
  }, [brands, q]);

  const summary = useMemo(() => {
    // Global unique-creator dedupe (same creator can hit multiple brands).
    // Sum of per-brand creator counts would double-count those.
    const inMonth = (c) => month === 'all' || c.hiringMonth === month;
    const uniq = new Set();
    let videos = 0, deal = 0, deals = 0;
    creators.forEach((c) => {
      if (!c.brand || !inMonth(c)) return;
      const handle = (c.tiktokAccount || '').toLowerCase().replace(/\/+$/, '').trim();
      const key = handle || `name:${(c.name || '').toLowerCase().trim()}`;
      if (key && key !== 'name:') uniq.add(key);
      videos += Array.isArray(c.videoCodes) ? c.videoCodes.length : 0;
      deal   += Number(c.dealAmount || 0);
      deals  += 1;
    });
    return {
      brands:   brands.length,
      creators: uniq.size,
      deals,
      videos,
      deal,
    };
  }, [brands, creators, month]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Paid Collab — Brands</h1>
          <p className="page-subtitle">
            {loading
              ? 'Loading…'
              : `${summary.brands} brand${summary.brands === 1 ? '' : 's'} · ${summary.creators} unique creator${summary.creators === 1 ? '' : 's'} (${summary.deals} deal${summary.deals === 1 ? '' : 's'}) · ${summary.videos} video${summary.videos === 1 ? '' : 's'} · $${summary.deal.toLocaleString()}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => load(true)} disabled={loading}>
            <RefreshIcon width="15" height="15" /> Refresh
          </button>
          {isPCTL && (
            <button className="wx-btn wx-btn-primary" onClick={() => setShowPicker(true)}>
              <PlusIcon width="16" height="16" /> Pick workspace brands
            </button>
          )}
        </div>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 220 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search brand or product…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="wx-input" style={{ maxWidth: 200 }} value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="all">All months</option>
          {months.map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}
        </select>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty">
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
            <StoreIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No brands in this view</div>
          <div>Try "All months" or a different search.</div>
        </div>
      ) : (
        <div className="brand-grid">
          {filtered.map((b) => (
            <BrandCard
              key={b.name}
              brand={b}
              highlighted={selectedByName.has(b.name.toLowerCase())}
              onClick={() => setActiveBrand(b.name)}
            />
          ))}
        </div>
      )}

      {showPicker && isPCTL && (
        <PickBrandsModal
          pctlId={pctlId}
          selected={selectedWorkspace}
          eligible={eligibleWorkspace}
          onClose={() => setShowPicker(false)}
          onDone={() => { setShowPicker(false); load(); }}
        />
      )}

      {activeBrand && (
        <BrandDetailModal
          brandName={activeBrand}
          creators={creators.filter((c) => (c.brand || '') === activeBrand
            && (month === 'all' || c.hiringMonth === month))}
          month={month}
          onClose={() => setActiveBrand(null)}
        />
      )}
    </>
  );
}

function BrandCard({ brand, highlighted, onClick }) {
  const b = brand;
  const doneVideos   = b.videoCounts.paid || 0;
  const totalVideos  = b.videos;
  const pct          = totalVideos > 0 ? Math.round((doneVideos / totalVideos) * 100) : 0;

  return (
    <div
      className="brand-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      style={{
        cursor: 'pointer',
        borderColor: highlighted ? 'color-mix(in srgb, var(--accent) 55%, var(--border-subtle))' : undefined,
        background:  highlighted ? 'color-mix(in srgb, var(--accent) 6%, var(--surface-1))' : undefined,
      }}>
      <div className="brand-card-header">
        <BrandAvatar brand={{ brand_name: b.name }} size={44} radius={10} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{b.name}</span>
            {highlighted && (
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                padding: '1px 6px', borderRadius: 999, textTransform: 'uppercase',
                background: 'var(--accent)', color: '#fff',
              }}>Managed</span>
            )}
          </div>
          <div className="brand-card-sub">
            {b.creators} creator{b.creators === 1 ? '' : 's'} · {b.deals} deal{b.deals === 1 ? '' : 's'}
            {b.products.length > 0 && ` · ${b.products.slice(0, 2).join(', ')}${b.products.length > 2 ? '…' : ''}`}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <StatTile
          label="Videos"
          value={`${doneVideos} / ${totalVideos}`}
          hint={`${pct}% done`}
        />
        <StatTile
          label="Deal value"
          value={`$${b.totalDeal.toLocaleString()}`}
          hint={`$${b.paidDeal.toLocaleString()} paid`}
        />
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PAYMENT_STATUSES.map((s) => {
          const n = b.paymentCounts[s.v] || 0;
          if (!n) return null;
          return (
            <span key={s.v} style={{
              fontSize: 10.5, padding: '2px 7px', borderRadius: 999,
              fontWeight: 700,
              background: tone(s.tone).bg, color: tone(s.tone).fg,
            }}>{n} {s.label.toLowerCase()}</span>
          );
        })}
      </div>
    </div>
  );
}

function StatTile({ label, value, hint }) {
  return (
    <div style={{
      padding: 10, background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function tone(t) {
  if (t === 'success') return { bg: 'color-mix(in srgb, var(--success) 16%, transparent)', fg: 'var(--success)' };
  if (t === 'warning') return { bg: 'color-mix(in srgb, var(--warning) 16%, transparent)', fg: 'var(--warning)' };
  return { bg: 'var(--surface-2)', fg: 'var(--text-muted)' };
}

// ============================================================
// PCTL workspace-brand picker (unchanged — writes to pctl_brand_selections)
// ============================================================
function PickBrandsModal({ pctlId, selected, eligible, onClose, onDone }) {
  const selectedIds = useMemo(() => new Set(selected.map((b) => b.id)), [selected]);
  const [busy, setBusy] = useState(null);
  const [err, setErr]   = useState('');

  async function toggle(b) {
    setErr(''); setBusy(b.id);
    try {
      if (selectedIds.has(b.id)) await unselectBrand(pctlId, b.id);
      else                       await selectBrand(pctlId, b.id);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Pick paid-collab brands</div>
          <button className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            These are workspace brands flagged as paid-collab. The list above comes from the live API and is separate.
          </div>
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" /> <span>{err}</span>
            </div>
          )}
          {eligible.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No brands are currently flagged as paid-collab. Ask the Boss or a TL to set the brand's Paid Collab Status.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {eligible.map((b) => {
                const on = selectedIds.has(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => toggle(b)}
                    disabled={busy === b.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer', textAlign: 'left',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <BrandAvatar brand={b} size={32} radius={6} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{b.brand_name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {paidCollabStatusLabel(b.paid_collab_status)}
                      </div>
                    </div>
                    {on && <CheckIcon width="16" height="16" style={{ color: 'var(--accent)' }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-primary" onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Brand detail — Creators / Videos tabs (v1 parity)
// ============================================================
function BrandDetailModal({ brandName, creators, month, onClose }) {
  const [tab, setTab] = useState('creators');

  // Flatten all videos across this brand's creators
  const videos = useMemo(() => {
    const out = [];
    for (const c of creators) {
      if (!Array.isArray(c.videoCodes) || c.videoCodes.length === 0) continue;
      c.videoCodes.forEach((vc, i) => out.push({
        key: `${c.id}-${i}`, creator: c, video: vc, idx: i + 1,
      }));
    }
    return out;
  }, [creators]);

  const [activeVideo, setActiveVideo] = useState(videos[0] || null);
  useMemo(() => {
    if (!activeVideo && videos.length > 0) setActiveVideo(videos[0]);
    if (activeVideo && !videos.find((v) => v.key === activeVideo.key)) {
      setActiveVideo(videos[0] || null);
    }
  }, [videos]);

  const totals = useMemo(() => {
    const total   = creators.reduce((s, c) => s + Number(c.dealAmount || 0), 0);
    const paid    = creators.filter((c) => c.paymentStatus === 'paid').reduce((s, c) => s + Number(c.dealAmount || 0), 0);
    const pending = creators.filter((c) => c.paymentStatus === 'pending').reduce((s, c) => s + Number(c.dealAmount || 0), 0);
    return { total, paid, pending };
  }, [creators]);

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 1100, width: '96vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {month === 'all' ? 'All time' : formatMonth(month)}
            </div>
            <div className="wx-modal-title" style={{ marginTop: 2 }}>{brandName}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
              {creators.length} creator{creators.length === 1 ? '' : 's'} · {videos.length} video{videos.length === 1 ? '' : 's'} ·
              {' '}${totals.total.toLocaleString()} total (${totals.paid.toLocaleString()} paid, ${totals.pending.toLocaleString()} pending)
            </div>
          </div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>

        <div style={{
          display: 'flex', gap: 4, padding: '10px 20px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <TabBtn active={tab === 'creators'} onClick={() => setTab('creators')}>
            Creators · {creators.length}
          </TabBtn>
          <TabBtn active={tab === 'videos'} onClick={() => setTab('videos')}>
            Videos · {videos.length}
          </TabBtn>
        </div>

        <div className="wx-modal-body" style={{ padding: tab === 'videos' ? 0 : undefined }}>
          {tab === 'creators' ? (
            <CreatorsTable creators={creators} />
          ) : videos.length === 0 ? (
            <div className="wx-empty" style={{ padding: 40 }}>
              <div className="wx-empty-title">No videos yet</div>
              <div>This brand's creators haven't delivered videos.</div>
            </div>
          ) : (
            <div className="pc-video-layout" style={{ padding: 16 }}>
              <div className="pc-video-stage">
                {activeVideo && (
                  <>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{activeVideo.creator.name}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {activeVideo.creator.product ? `${activeVideo.creator.product} · ` : ''}Video #{activeVideo.idx}
                      </div>
                    </div>
                    {tiktokEmbedUrl(activeVideo.video.video) ? (
                      <div className="pc-video-frame-wrap">
                        <iframe
                          src={tiktokEmbedUrl(activeVideo.video.video)}
                          allow="autoplay; encrypted-media; picture-in-picture"
                          allowFullScreen
                          title={`${activeVideo.creator.name} video ${activeVideo.idx}`}
                        />
                      </div>
                    ) : (
                      <div className="pc-video-empty">
                        {activeVideo.video.video
                          ? <a href={activeVideo.video.video} target="_blank" rel="noreferrer">Open on TikTok ↗</a>
                          : 'No video URL provided.'}
                      </div>
                    )}
                    {activeVideo.video.adCode && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Ad code</div>
                        <div className="pc-ad-code">{activeVideo.video.adCode}</div>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="pc-video-list">
                {videos.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className="pc-video-item"
                    data-active={activeVideo?.key === v.key}
                    onClick={() => setActiveVideo(v)}
                  >
                    <div className="pc-video-item-title">{v.creator.name} · #{v.idx}</div>
                    <div className="pc-video-item-sub">
                      {statusLabel(PAYMENT_STATUSES, v.creator.paymentStatus)}
                      {v.video.adCode ? ` · ${v.video.adCode}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        background: 'transparent',
        padding: '8px 14px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        background_: undefined,
        position: 'relative',
      }}
    >
      {children}
      {active && (
        <div style={{
          position: 'absolute', left: 10, right: 10, bottom: -11, height: 2,
          background: 'var(--accent)', borderRadius: 2,
        }} />
      )}
    </button>
  );
}

function CreatorsTable({ creators }) {
  return (
    <div className="wx-list">
      <div className="wx-list-row wx-list-header" style={{ gridTemplateColumns: '1.4fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr' }}>
        <div>Creator</div>
        <div>Product</div>
        <div>Deal</div>
        <div>Payment</div>
        <div>Videos</div>
        <div>Hired by</div>
        <div>Date</div>
      </div>
      {creators.map((c) => (
        <div key={c.id} className="wx-list-row" style={{ gridTemplateColumns: '1.4fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {c.tiktokAccount
                ? <a href={`https://www.tiktok.com/@${c.tiktokAccount.replace(/^@/, '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text-primary)' }}>{c.name}</a>
                : c.name}
            </div>
            {c.tiktokAccount && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{c.tiktokAccount.replace(/^@/, '')}</div>
            )}
          </div>
          <div style={{ fontSize: 12.5 }}>{c.product || '—'}</div>
          <div style={{ fontSize: 12.5 }}>{c.deal || '—'}</div>
          <div><StatusBadge statuses={PAYMENT_STATUSES} v={c.paymentStatus} /></div>
          <div><StatusBadge statuses={VIDEO_STATUSES}  v={c.videosStatus} /></div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{c.hiredBy || '—'}</div>
          <div style={{ fontSize: 12.5 }}>{c.hiringDate || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ statuses, v }) {
  const s = statuses.find((x) => x.v === v) || { label: v || '—', tone: 'muted' };
  const t = tone(s.tone);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 700,
      background: t.bg, color: t.fg,
    }}>{s.label}</span>
  );
}
