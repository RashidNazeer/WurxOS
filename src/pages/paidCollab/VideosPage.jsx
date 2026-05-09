import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCreators, tiktokEmbedUrl, PAYMENT_STATUSES, statusLabel } from '../../lib/paidCollabRemote';
import {
  SearchIcon, AlertIcon, RefreshIcon, MegaphoneIcon, VideoIcon, PlayIcon, XIcon,
} from '../../components/common/Icon';
import {
  MonthNavigator, CreatorAvatar, TiktokHandle, currentMonthKey,
} from './_shared';
import '../../styles/table.css';
import '../../styles/paidCollab.css';

export default function PaidCollabVideosPage() {
  const [month, setMonth]   = useState(currentMonthKey());
  const [q, setQ]           = useState('');
  const [brand, setBrand]   = useState('all');
  const [creator, setCr]    = useState('all');
  const [active, setActive] = useState(null);   // { creator } opened in modal

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['paid-collab', 'creators'],
    queryFn: () => fetchCreators({ force: false }),
  });
  const err  = queryError?.message || '';
  const load = async ({ force = false } = {}) => {
    if (force) { try { await fetchCreators({ force: true }); } catch {} }
    qc.invalidateQueries({ queryKey: ['paid-collab'] });
  };

  const months = useMemo(() => {
    const s = new Set(rows.map((r) => r.hiringMonth).filter(Boolean));
    return Array.from(s).sort().reverse();
  }, [rows]);

  const brands = useMemo(() => {
    const s = new Set(rows.map((r) => r.brand).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const creatorsList = useMemo(() => {
    const s = new Set(rows.map((r) => r.name).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (month !== 'all' && r.hiringMonth !== month) return false;
      if (brand !== 'all' && r.brand !== brand) return false;
      if (creator !== 'all' && r.name !== creator) return false;
      if (qq && !(
        (r.name || '').toLowerCase().includes(qq) ||
        (r.brand || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, month, brand, creator, q]);

  const totalVideos = useMemo(
    () => filtered.reduce((n, r) => n + (r.videoCodes?.length || 0), 0),
    [filtered],
  );

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Videos</h1>
          <p className="page-subtitle">
            {loading
              ? 'Loading…'
              : `${filtered.length} creator${filtered.length === 1 ? '' : 's'} · ${totalVideos} video${totalVideos === 1 ? '' : 's'}`}
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={() => load({ force: true })} disabled={loading}>
          <RefreshIcon width="15" height="15" /> Refresh
        </button>
      </div>

      <MonthNavigator month={month} onChange={setMonth} availableMonths={months} />

      <div className="pc-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search creator or brand…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 180 }} value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="all">All Brands</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 200 }} value={creator} onChange={(e) => setCr(e.target.value)}>
          <option value="all">All Creators</option>
          {creatorsList.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          {filtered.length} creator{filtered.length === 1 ? '' : 's'}
        </div>
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
            <MegaphoneIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No creators in this view</div>
          <div>Try clearing filters or the month navigator.</div>
        </div>
      ) : (
        <div className="pc-card-grid">
          {filtered.map((r) => (
            <VideoCreatorCard key={r.id} creator={r} onOpen={() => setActive({ creator: r })} />
          ))}
        </div>
      )}

      {active && (
        <CreatorVideosModal
          creator={active.creator}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

function VideoCreatorCard({ creator, onOpen }) {
  const count = creator.videoCodes?.length || 0;
  const hasVideos = count > 0;

  return (
    <div
      className={`pc-creator-card ${hasVideos ? 'is-clickable' : ''}`}
      onClick={hasVideos ? onOpen : undefined}
      role={hasVideos ? 'button' : undefined}
      tabIndex={hasVideos ? 0 : undefined}
      onKeyDown={(e) => { if (hasVideos && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
    >
      <div className="pc-creator-card-head">
        <CreatorAvatar name={creator.name} />
        <div className="pc-creator-card-body">
          <div className="pc-creator-card-name">{creator.name}</div>
          <div className="pc-creator-card-sub">{creator.brand || '—'}</div>
        </div>
        <TiktokHandle handle={creator.tiktokAccount} />
      </div>

      <div className={`pc-creator-card-videos ${hasVideos ? '' : 'is-empty'}`}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <VideoIcon width="14" height="14" />
          {hasVideos ? `${count} video${count === 1 ? '' : 's'}` : 'No videos yet'}
        </span>
        {hasVideos && <span style={{ fontSize: 11.5 }}>Click to view</span>}
      </div>

      {hasVideos && (
        <button
          type="button"
          className="pc-creator-card-cta"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
        >
          <PlayIcon width="13" height="13" />
          View All Videos
        </button>
      )}
    </div>
  );
}

// ============================================================
// Creator videos modal — matches v1's split-pane player layout
// ============================================================
function CreatorVideosModal({ creator, onClose }) {
  const videos = useMemo(
    () => (creator.videoCodes || []).map((vc, i) => ({ idx: i + 1, video: vc })),
    [creator],
  );
  const [active, setActive] = useState(videos[0] || null);
  const embedUrl = active ? tiktokEmbedUrl(active.video.video) : null;

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 1060, width: '96vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CreatorAvatar name={creator.name} size={38} />
            <div>
              <div className="wx-modal-title">{creator.name}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {creator.brand}{creator.product ? ` · ${creator.product}` : ''} · {videos.length} video{videos.length === 1 ? '' : 's'} · {statusLabel(PAYMENT_STATUSES, creator.paymentStatus)}
              </div>
            </div>
          </div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>

        <div className="wx-modal-body" style={{ padding: 0 }}>
          {videos.length === 0 ? (
            <div className="wx-empty" style={{ padding: 40 }}>
              <div className="wx-empty-title">No videos yet</div>
              <div>This creator hasn't delivered any videos for the selected period.</div>
            </div>
          ) : (
            <div className="pc-video-layout" style={{ padding: 16 }}>
              <div className="pc-video-stage">
                {active && (
                  <>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>Video #{active.idx}</div>
                      {active.video.adCode && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ad code · {active.video.adCode}</div>
                      )}
                    </div>
                    {embedUrl ? (
                      <div className="pc-video-frame-wrap">
                        <iframe
                          src={embedUrl}
                          allow="autoplay; encrypted-media; picture-in-picture"
                          allowFullScreen
                          title={`${creator.name} video ${active.idx}`}
                        />
                      </div>
                    ) : (
                      <div className="pc-video-empty">
                        {active.video.video
                          ? <a href={active.video.video} target="_blank" rel="noreferrer">Open on TikTok ↗</a>
                          : 'No video URL provided.'}
                      </div>
                    )}
                    {active.video.adCode && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Ad code</div>
                        <div className="pc-ad-code">{active.video.adCode}</div>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="pc-video-list">
                {videos.map((v) => (
                  <button
                    key={v.idx}
                    type="button"
                    className="pc-video-item"
                    data-active={active?.idx === v.idx}
                    onClick={() => setActive(v)}
                  >
                    <div className="pc-video-item-title">Video #{v.idx}</div>
                    <div className="pc-video-item-sub">
                      {v.video.adCode || 'no ad code'}
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
