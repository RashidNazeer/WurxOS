// ============================================================
// Weekly Performance Checkpoint — the deck (12 slides at 1280×720).
//
// Renders purely from the `data` object. The SAME nodes are shown in the live
// preview and captured to PDF, so preview === output. No instructional copy —
// only the APC's real content.
// ============================================================
import { forwardRef } from 'react';
import '../../styles/checkpoint.css';
import {
  num, pct, deltaPct, fmtInt, fmtNum, fmtMoney, fmtPct, fmtX, fmtKpi,
  SNAPSHOT_KPIS, STATUS_OPTIONS,
} from '../../lib/checkpointModel';

// ── small helpers ───────────────────────────────────────────────────
const V = ({ children }) => (children === '—' || children === '' || children == null)
  ? <span className="ck-empty">—</span> : <>{children}</>;

function Delta({ tone, arrow, text }) {
  if (!text) return null;
  const cls = tone === 'good' ? 'up' : tone === 'bad' ? 'down' : 'flat';
  const glyph = arrow === 'up' ? '▲' : arrow === 'down' ? '▼' : '—';
  return <span className={`ck-delta ${cls}`}><span className="ar">{glyph}</span>{text}</span>;
}

function kpiDelta(cur, prev, better) {
  const d = deltaPct(cur, prev);
  if (d === null) return null;
  const r = Math.round(d * 10) / 10;
  const arrow = r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  let tone = 'flat';
  if (better === 'up') tone = r > 0 ? 'good' : r < 0 ? 'bad' : 'flat';
  else if (better === 'down') tone = r < 0 ? 'good' : r > 0 ? 'bad' : 'flat';
  const sign = r > 0 ? '+' : '';
  return { tone, arrow, text: `${sign}${r.toFixed(1)}% wk/wk` };
}

function Stat({ label, value, delta, foot, small }) {
  return (
    <div className="ck-stat">
      <div className="lbl">{label}</div>
      <div className={`val ${small ? 'sm' : ''}`}><V>{value}</V></div>
      {(delta || foot) && (
        <div className="foot">{delta ? <Delta {...delta} /> : null}{foot ? <span>{foot}</span> : null}</div>
      )}
    </div>
  );
}

// proportional funnel: value on its own ink rail, conversion as a connector pill
// between stages (so text is NEVER white-on-light and can't overflow the bar)
function Funnel({ rows }) {
  const vals = rows.map((r) => num(r.value)).filter((v) => v !== null);
  const max = vals.length ? Math.max(...vals) : null;
  return (
    <div className="ck-funnel">
      {rows.map((r, i) => {
        const n = num(r.value);
        const w = (max && n !== null && max > 0) ? (n / max) * 100 : 0;
        const conn = i > 0 ? rows[i - 1].conv : '';
        return (
          <div key={i}>
            {i > 0 && (
              <div className="ck-funnel-conn">
                {conn
                  ? <span className="ck-funnel-conv"><span className="ar">▾</span>{conn}</span>
                  : <span className="ck-funnel-tick">▾</span>}
              </div>
            )}
            <div className="ck-funnel-row">
              <div className="fl">{r.label}</div>
              <div className="ck-funnel-bar">
                <div className="ck-funnel-fill" style={{ '--w': `${w}%`, minWidth: n > 0 ? 6 : 0 }} />
              </div>
              <div className="ck-funnel-val">{n === null ? <span className="ck-empty">—</span> : fmtInt(n)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// horizontal mini bars: rows = [{label, value(raw)}], scaled to max
function MiniBars({ rows, fmt = fmtInt }) {
  const vals = rows.map((r) => num(r.value)).filter((v) => v !== null);
  const max = vals.length ? Math.max(...vals) : null;
  return (
    <div className="ck-bars">
      {rows.map((r, i) => {
        const n = num(r.value);
        const w = (max && n !== null && max > 0) ? (n / max) * 100 : 0;
        return (
          <div className="ck-bar-row" key={i}>
            <div className="bl">{r.label}</div>
            <div className="ck-bar-track"><div className="ck-bar-fill" style={{ '--w': `${w}%` }} /></div>
            <div className="bv"><V>{n === null ? '—' : fmt(n)}</V></div>
          </div>
        );
      })}
    </div>
  );
}

function Note({ label, children, roomy }) {
  const empty = !children || (typeof children === 'string' && !children.trim());
  return (
    <div className={`ck-note${roomy ? ' roomy' : ''}`}>
      {label && <span className="k">{label} </span>}
      {empty ? <span className="ck-empty">—</span> : children}
    </div>
  );
}

// ── slide shell ─────────────────────────────────────────────────────
function Slide({ n, eyebrow, title, sub, accent, status, brand, week, children }) {
  const st = status ? STATUS_OPTIONS.find((s) => s.value === status) : null;
  return (
    <div className="ckpt-slide" style={accent ? { '--slide-accent': accent } : undefined}>
      <div className="ck-head">
        {n != null && <div className="ck-num">{String(n).padStart(2, '0')}</div>}
        <div className="ck-head-txt">
          {eyebrow && <div className="ck-eyebrow">{eyebrow}</div>}
          <div className="ck-title">{title}</div>
          {sub && <div className="ck-sub">{sub}</div>}
        </div>
        {st && (
          <div className="ck-head-meta">
            <span className={`ck-status ${status}`}><span className="dot" />{st.label}</span>
          </div>
        )}
      </div>
      <div className="ck-body">{children}</div>
      <div className="ck-foot">
        <span><b>Wurx&nbsp;Media</b>&nbsp;&nbsp;·&nbsp;&nbsp;Weekly Performance Checkpoint</span>
        <span>{brand ? <><b>{brand}</b>&nbsp;·&nbsp;</> : null}{week || ''}</span>
      </div>
    </div>
  );
}

// ============================================================
const CheckpointDeck = forwardRef(function CheckpointDeck({ data }, ref) {
  const sym = data.currency || '$';
  const brand = data.cover.brandName || '';
  const week = data.cover.weekLabel || '';
  const money = (v) => fmtMoney(v, sym);

  const f = data.funnel;
  const optInPct = pct(f.optedIn, f.targetInvites);
  const reqPct = pct(f.sampleRequests, f.optedIn);
  const apprPct = pct(f.approved, f.sampleRequests);
  const postedPct = pct(f.videosLive, f.approvedN2);

  const o = data.outreach;
  const reachTotal = ['reachInvites', 'reachCompetitors', 'reachDmEmail']
    .reduce((s, k) => s + (num(o[k]) || 0), 0);
  const optInDelta = (() => {
    const cur = optInPct, prev = num(o.optInRatePrev);
    if (cur === null || prev === null) return null;
    const pts = Math.round((cur - prev) * 10) / 10;
    return { tone: pts >= 0 ? 'good' : 'bad', arrow: pts > 0 ? 'up' : pts < 0 ? 'down' : 'flat', text: `${pts >= 0 ? '+' : ''}${pts} pts vs last wk` };
  })();

  const t = data.traffic;
  const ctr = pct(t.clicks, t.impressions);
  const ctrPrev = pct(t.clicksPrev, t.impressionsPrev);
  const ctor = pct(t.orders, t.clicks);
  const ctorPrev = pct(t.ordersPrev, t.clicksPrev);

  const p = data.paid;
  const roi = (() => { const r = num(p.grossRevenue) !== null && num(p.spend) ? num(p.grossRevenue) / num(p.spend) : null; return r; })();
  const cpo = (() => { const c = num(p.spend) !== null && num(p.skuOrders) ? num(p.spend) / num(p.skuOrders) : null; return c; })();
  const targetRoi = num(p.targetRoi);
  const breakEvenOk = roi !== null && targetRoi !== null && roi >= targetRoi;
  const roiBarMax = Math.max(roi || 0, targetRoi || 0, 0.01);

  const pc = data.paidCollab;
  const budgetPct = pct(pc.budgetAllocated, pc.totalBudget);
  const videosPct = pct(pc.videosCompleted, pc.totalVideos);

  return (
    <div className="ckpt-deck" ref={ref}>

      {/* ── COVER ─────────────────────────────────────────── */}
      <div className="ckpt-slide" style={{ '--slide-accent': '#4739c9' }}>
        <div className="ck-cover">
          <div className="ck-cover-top">
            <div className="kicker">Weekly Performance Checkpoint</div>
            <h1>The Tuesday<br /><span className="thin">Checkpoint.</span></h1>
            <div className="lede">One brand · one APC · one page of proof — what we did last week, how it landed, and what we do next.</div>
          </div>
          <div className="ck-cover-meta">
            <div className="m"><div className="k">Brand</div><div className="v"><V>{brand}</V></div></div>
            <div className="m"><div className="k">APC</div><div className="v"><V>{data.cover.apcName}</V></div></div>
            <div className="m"><div className="k">Team</div><div className="v"><V>{data.cover.team}</V></div></div>
            <div className="m"><div className="k">Week</div><div className="v"><V>{week}</V></div></div>
          </div>
        </div>
        <div className="ck-foot">
          <span><b>Wurx&nbsp;Media</b></span>
          <span>{week}</span>
        </div>
      </div>

      {/* ── 01 AFFILIATE FUNNEL ───────────────────────────── */}
      <Slide n={1} eyebrow="The affiliate engine" title="The affiliate funnel" accent="#4739c9" brand={brand} week={week}
        sub="Recruit is same-week. Video output is measured on the cohort approved ~2 weeks ago, not this week's approvals.">
        <div className="ck-cols" style={{ gridTemplateColumns: '1.5fr 1fr', height: '100%' }}>
          <div>
            <div className="ck-sectlabel">Recruit — this week</div>
            <Funnel rows={[
              { label: 'Target invites', value: f.targetInvites, conv: optInPct !== null ? `${fmtPct(optInPct)} opt-in` : '' },
              { label: 'Opted in', value: f.optedIn, conv: reqPct !== null ? `${fmtPct(reqPct)} requested` : '' },
              { label: 'Sample requests', value: f.sampleRequests, conv: apprPct !== null ? `${fmtPct(apprPct)} approved` : '' },
              { label: 'Approved', value: f.approved, conv: '' },
            ]} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center', height: '100%' }}>
            <div className="ck-sectlabel" style={{ marginBottom: 0 }}>Produce — cohort approved ~2 wks ago</div>
            <Stat label="Approved · Wk N-2" value={fmtInt(f.approvedN2)} small />
            <Stat label="Videos now live" value={fmtInt(f.videosLive)} small
              foot={postedPct !== null ? `${fmtPct(postedPct)} of that cohort posted` : null} />
            <Stat label="Affiliate orders" value={fmtInt(f.affiliateOrders)} small />
          </div>
        </div>
      </Slide>

      {/* ── 02 APC EFFORT LOG ─────────────────────────────── */}
      <Slide n={2} eyebrow="Effort is what you control" title="APC effort log" accent="#2b6cae" brand={brand} week={week}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          <Stat label="Invites sent" value={fmtInt(data.effort.invitesSent)} />
          <Stat label="Samples requested" value={fmtInt(data.effort.sampleRequested)} />
          <Stat label="Creators onboarded" value={fmtInt(data.effort.creatorsOnboarded)} />
          <Stat label="Via auto-approval" value={fmtInt(data.effort.onboardedAutoApproval)} />
          <Stat label="Ad-code follow-ups" value={fmtInt(data.effort.adCodeFollowups)} />
          <Stat label="Videos needing auth" value={fmtInt(data.effort.videosAuthNeeded)} />
        </div>
        <Note roomy label="What took the most time · proud of · blocked:">{data.effort.narrative}</Note>
      </Slide>

      {/* ── 03 OUTREACH & SOURCING ────────────────────────── */}
      <Slide n={3} eyebrow="Are we reaching the right creators?" title="Outreach & creator sourcing" accent="#0f766e" brand={brand} week={week}>
        <div className="ck-cols" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
          <div className="ck-panel">
            <div className="ck-sectlabel">How we reached out</div>
            <MiniBars rows={[
              { label: 'Target invites', value: o.reachInvites },
              { label: 'Competitors', value: o.reachCompetitors },
              { label: 'DM / Email', value: o.reachDmEmail },
            ]} />
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--ck-ink-3)', fontWeight: 700 }}>
              {reachTotal ? `${fmtInt(reachTotal)} creators contacted` : <span className="ck-empty">—</span>}
            </div>
          </div>
          <div className="ck-panel">
            <div className="ck-sectlabel">Who we targeted · by tier</div>
            <MiniBars rows={[
              { label: 'L0 + L1', value: o.tierL0L1 },
              { label: 'L2', value: o.tierL2 },
              { label: 'L3', value: o.tierL3 },
              { label: 'L3+', value: o.tierL3plus },
            ]} />
          </div>
        </div>
        <div className="ck-cols" style={{ gridTemplateColumns: '1fr 1.4fr', alignItems: 'start' }}>
          <Stat label="Opt-in rate" value={optInPct !== null ? fmtPct(optInPct) : '—'} delta={optInDelta} />
          <Note label="Niches & next move:">{[o.niches, o.readNext].filter(Boolean).join(' — ')}</Note>
        </div>
      </Slide>

      {/* ── 04 PERFORMANCE SNAPSHOT ───────────────────────── */}
      <Slide n={4} eyebrow="The headline scoreboard" title="Performance snapshot" accent="#4739c9"
        status={data.snapshot.status} brand={brand} week={week}>
        <div className="ck-kpigrid" style={{ marginBottom: 16 }}>
          {SNAPSHOT_KPIS.map((k) => {
            const kv = data.snapshot.kpis[k.key] || {};
            return (
              <Stat key={k.key} label={k.label} small
                value={fmtKpi(k.fmt, kv.cur, sym)}
                delta={kpiDelta(kv.cur, kv.prev, k.better)} />
            );
          })}
        </div>
        <Note roomy label="Why it moved:">{data.snapshot.whyMoved}</Note>
      </Slide>

      {/* ── 05 SAMPLES ────────────────────────────────────── */}
      <Slide n={5} eyebrow="Every approved sample is real cost" title="Samples" accent="#15803d" brand={brand} week={week}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
          <Stat label="Requests received" value={fmtInt(data.samples.requestsReceived)} small
            delta={kpiDelta(data.samples.requestsReceived, data.samples.requestsPrev, 'up')} />
          <Stat label="Approved · this week" value={fmtInt(data.samples.approvedThisWeek)} small />
          <Stat label="MTD approved" value={fmtInt(data.samples.mtdApproved)} small />
          <Stat label="Sample→video · N-2" value={data.samples.sampleToVideoN2 !== '' ? fmtPct(data.samples.sampleToVideoN2) : '—'} small />
        </div>
        <div className="ck-cols" style={{ gridTemplateColumns: '1fr 1.2fr' }}>
          <div className="ck-panel ck-panel--fill">
            <div className="ck-sectlabel">MTD approved · by tier</div>
            <MiniBars rows={[
              { label: 'L0', value: data.samples.tiers.L0 },
              { label: 'L1', value: data.samples.tiers.L1 },
              { label: 'L2', value: data.samples.tiers.L2 },
              { label: 'L3', value: data.samples.tiers.L3 },
              { label: 'L3+', value: data.samples.tiers.L3plus },
            ]} />
          </div>
          <div className="ck-panel">
            <div className="ck-sectlabel">By product</div>
            <table className="ck-table dense">
              <thead><tr><th>Product</th><th className="num">Approved</th></tr></thead>
              <tbody>
                {(() => {
                  const rows = data.samples.products.filter((r) => r.name || r.count);
                  if (!rows.length) return <tr><td colSpan={2} className="ck-empty">—</td></tr>;
                  return <>
                    {rows.slice(0, 9).map((r, i) => (
                      <tr key={i}><td className="strong">{r.name || '—'}</td><td className="num">{fmtInt(r.count)}</td></tr>
                    ))}
                    {rows.length > 9 && <tr className="more"><td colSpan={2}>+{rows.length - 9} more not shown</td></tr>}
                  </>;
                })()}
              </tbody>
            </table>
          </div>
        </div>
      </Slide>

      {/* ── 06 CONTENT & TRAFFIC ──────────────────────────── */}
      <Slide n={6} eyebrow="Did the videos pull traffic & convert?" title="Content & on-site traffic" accent="#2b6cae" brand={brand} week={week}>
        <div className="ck-cols" style={{ gridTemplateColumns: '1.15fr 1fr', height: '100%' }}>
          <div>
            <div className="ck-sectlabel">Traffic funnel — this week</div>
            <Funnel rows={[
              { label: 'Product impressions', value: t.impressions, conv: ctr !== null ? `${fmtPct(ctr, 2)} CTR` : '' },
              { label: 'Product clicks', value: t.clicks, conv: ctor !== null ? `${fmtPct(ctor, 2)} CTOR` : '' },
              { label: 'SKU orders', value: t.orders, conv: '' },
            ]} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              {ctrPrev !== null && <span className="ck-chip">CTR {fmtPct(ctrPrev, 2)} → {fmtPct(ctr, 2)}</span>}
              {ctorPrev !== null && <span className="ck-chip">CTOR {fmtPct(ctorPrev, 2)} → {fmtPct(ctor, 2)}</span>}
              {num(t.ordersPrev) !== null && <span className="ck-chip">Orders {fmtInt(t.ordersPrev)} → {fmtInt(t.orders)}</span>}
            </div>
          </div>
          <div>
            <div className="ck-sectlabel">Top videos this week</div>
            <table className="ck-table dense">
              <thead><tr><th>Creator</th><th>Angle</th><th className="num">GMV</th></tr></thead>
              <tbody>
                {(() => {
                  const rows = t.topVideos.filter((r) => r.creator || r.angle || r.gmv);
                  if (!rows.length) return <tr><td colSpan={3} className="ck-empty">—</td></tr>;
                  return <>
                    {rows.slice(0, 8).map((r, i) => (
                      <tr key={i}><td className="strong">{r.creator || '—'}</td><td>{r.angle || '—'}</td><td className="num">{money(r.gmv)}</td></tr>
                    ))}
                    {rows.length > 8 && <tr className="more"><td colSpan={3}>+{rows.length - 8} more not shown</td></tr>}
                  </>;
                })()}
              </tbody>
            </table>
            <div style={{ marginTop: 14 }}><Note label="Why:">{t.why}</Note></div>
          </div>
        </div>
      </Slide>

      {/* ── 07 CREATIVE ANGLES ────────────────────────────── */}
      <Slide n={7} eyebrow="Which hooks earn their spend?" title="Creative angle performance" accent="#6d28d9" brand={brand} week={week}>
        <table className="ck-table dense" style={{ marginBottom: 14 }}>
          <thead><tr><th>Angle</th><th className="num">Videos</th><th className="num">GMV</th><th className="num">CVR</th><th>Verdict</th></tr></thead>
          <tbody>
            {(() => {
              const rows = data.angles.rows.filter((r) => r.angle || r.gmv || r.videos);
              if (!rows.length) return <tr><td colSpan={5} className="ck-empty">—</td></tr>;
              return <>
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td className="strong">{r.angle || '—'}</td>
                    <td className="num">{fmtInt(r.videos)}</td>
                    <td className="num">{money(r.gmv)}</td>
                    <td className="num">{r.cvr !== '' ? fmtPct(r.cvr) : '—'}</td>
                    <td><span className={`ck-pill ${r.verdict}`}>{r.verdict}</span></td>
                  </tr>
                ))}
                {rows.length > 10 && <tr className="more"><td colSpan={5}>+{rows.length - 10} more not shown</td></tr>}
              </>;
            })()}
          </tbody>
        </table>
        <Note roomy label="The decision:">{data.angles.decision}</Note>
      </Slide>

      {/* ── 08 GMV MAX & PAID ─────────────────────────────── */}
      <Slide n={8} eyebrow="Amplifying winners, or buying below break-even?" title="GMV Max & paid" accent="#b45309" brand={brand} week={week}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
          <Stat label="Spend" value={money(p.spend)} small delta={kpiDelta(p.spend, p.spendPrev, 'flat')} />
          <Stat label="Gross revenue" value={money(p.grossRevenue)} small delta={kpiDelta(p.grossRevenue, p.grossRevenuePrev, 'up')} />
          <Stat label="ROI" value={roi !== null ? fmtX(roi) : '—'} small foot={targetRoi !== null ? `target ${fmtX(targetRoi)}` : null} />
          <Stat label="Cost / SKU order" value={cpo !== null ? money(cpo) : '—'} small delta={kpiDelta(cpo, p.costPerOrderPrev, 'down')} />
        </div>
        <div className="ck-cols" style={{ gridTemplateColumns: p.screenshot ? '1fr 1fr' : '1fr' }}>
          <div className="ck-panel">
            <div className="ck-sectlabel">Break-even check</div>
            <div className="ck-compare">
              <div className="ck-compare-row">
                <div className="cl">Break-even</div>
                <div className="ck-compare-track"><div className="ck-compare-fill target" style={{ '--w': `${Math.min(100, ((targetRoi || 0) / roiBarMax) * 100)}%` }} /></div>
                <div className="cv">{targetRoi !== null ? fmtX(targetRoi) : '—'}</div>
              </div>
              <div className="ck-compare-row">
                <div className="cl">Actual</div>
                <div className="ck-compare-track"><div className={`ck-compare-fill actual ${breakEvenOk ? 'ok' : ''}`} style={{ '--w': `${Math.min(100, ((roi || 0) / roiBarMax) * 100)}%` }} /></div>
                <div className="cv">{roi !== null ? fmtX(roi) : '—'}</div>
              </div>
            </div>
            <div style={{ marginTop: 14, fontSize: 13.5, color: 'var(--ck-ink-3)' }}>
              ROI protection: <b style={{ color: 'var(--ck-ink)' }}>{(p.roiProtection || '').toUpperCase() || '—'}</b>
              {p.mode ? <> &nbsp;·&nbsp; Mode: <b style={{ color: 'var(--ck-ink)' }}>{p.mode}</b></> : null}
            </div>
            <div style={{ marginTop: 12 }}><Note label="Spend decision:">{p.decision}</Note></div>
          </div>
          {p.screenshot && (
            <div className="ck-shot"><img src={p.screenshot} alt="Ads Manager" /></div>
          )}
        </div>
      </Slide>

      {/* ── 09 PAID COLLAB ────────────────────────────────── */}
      <Slide n={9} eyebrow="The paid-creator program" title="Paid Collab" accent="#be185d" brand={brand} week={week}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          <Stat label="Creators onboarded" value={fmtInt(pc.creatorsOnboarded)} small />
          <Stat label="Creators in pipeline" value={fmtInt(pc.creatorsInPipeline)} small />
          <Stat label="Videos completed" value={fmtInt(pc.videosCompleted)} small foot={num(pc.totalVideos) !== null ? `of ${fmtInt(pc.totalVideos)} planned` : null} />
        </div>
        <div className="ck-cols" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
          <div className="ck-panel">
            <div className="ck-sectlabel">Budget</div>
            <div className="ck-bar-row" style={{ gridTemplateColumns: '96px 1fr 96px' }}>
              <div className="bl">Allocated</div>
              <div className="ck-bar-track"><div className="ck-bar-fill" style={{ '--w': `${budgetPct === null ? 0 : Math.min(100, budgetPct)}%` }} /></div>
              <div className="bv">{money(pc.budgetAllocated)}</div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ck-muted)', marginTop: 8 }}>of {money(pc.totalBudget)} total{budgetPct !== null ? ` · ${fmtPct(budgetPct, 0)}` : ''}</div>
          </div>
          <div className="ck-panel">
            <div className="ck-sectlabel">Video completion</div>
            <div className="ck-bar-row" style={{ gridTemplateColumns: '96px 1fr 96px' }}>
              <div className="bl">Completed</div>
              <div className="ck-bar-track"><div className="ck-bar-fill" style={{ '--w': `${videosPct === null ? 0 : Math.min(100, videosPct)}%`, background: '#15803d' }} /></div>
              <div className="bv">{fmtInt(pc.videosCompleted)}</div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ck-muted)', marginTop: 8 }}>of {fmtInt(pc.totalVideos)} planned{videosPct !== null ? ` · ${fmtPct(videosPct, 0)}` : ''}</div>
          </div>
        </div>
        <Note label="Notes:">{pc.notes}</Note>
      </Slide>

      {/* ── 10 RESEARCH & SUGGESTIONS ─────────────────────── */}
      <Slide n={10} eyebrow="The one slide about next week" title="Research & suggestions" accent="#0f766e" brand={brand} week={week}>
        <div className="ck-cols" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="ck-panel">
            <div className="ck-sectlabel">New research</div>
            <div className="ck-list">
              {(() => {
                const items = data.research.findings.filter((x) => x && x.trim());
                if (!items.length) return <span className="ck-empty">—</span>;
                return <>
                  {items.slice(0, 6).map((x, i) => (
                    <div className="ck-listitem" key={i}><div className="idx">{i + 1}</div><div className="body">{x}</div></div>
                  ))}
                  {items.length > 6 && <div className="ck-listitem"><div className="body" style={{ color: 'var(--ck-ink-3)', fontWeight: 700 }}>+{items.length - 6} more not shown</div></div>}
                </>;
              })()}
            </div>
          </div>
          <div className="ck-panel">
            <div className="ck-sectlabel">Suggestions to test</div>
            <div className="ck-list">
              {(() => {
                const items = data.research.suggestions.filter((s) => s.suggestion && s.suggestion.trim());
                if (!items.length) return <span className="ck-empty">—</span>;
                return <>
                  {items.slice(0, 6).map((s, i) => (
                    <div className="ck-listitem" key={i}>
                      <div className="idx">{i + 1}</div>
                      <div className="body"><b style={{ color: 'var(--ck-ink)' }}>{s.suggestion}</b>{s.impact ? <div className="impact">→ {s.impact}</div> : null}</div>
                    </div>
                  ))}
                  {items.length > 6 && <div className="ck-listitem"><div className="body" style={{ color: 'var(--ck-ink-3)', fontWeight: 700 }}>+{items.length - 6} more not shown</div></div>}
                </>;
              })()}
            </div>
          </div>
        </div>
      </Slide>

      {/* ── 11 BOTTLENECKS & ACTIONS ──────────────────────── */}
      <Slide n={11} eyebrow="What's slowing results — who owns the fix" title="Bottlenecks & action tracker" accent="#1d4ed8" brand={brand} week={week}>
        {data.actions.bottlenecks.length > 0 && (
          <div className="ck-chips" style={{ marginBottom: 14 }}>
            {data.actions.bottlenecks.map((b, i) => <span className="ck-chip warn" key={i}>{b}</span>)}
          </div>
        )}
        <table className="ck-table dense">
          <thead><tr><th>Action / bottleneck</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>
            {(() => {
              const rows = data.actions.rows.filter((r) => r.action || r.owner);
              if (!rows.length) return <tr><td colSpan={4} className="ck-empty">—</td></tr>;
              return <>
                {rows.slice(0, 12).map((r, i) => (
                  <tr key={i}>
                    <td className="strong">{r.action || '—'}</td>
                    <td>{r.owner || '—'}</td>
                    <td>{r.due || '—'}</td>
                    <td><span className={`ck-pill ${r.status}`}>{r.status.replace('_', ' ')}</span></td>
                  </tr>
                ))}
                {rows.length > 12 && <tr className="more"><td colSpan={4}>+{rows.length - 12} more not shown</td></tr>}
              </>;
            })()}
          </tbody>
        </table>
      </Slide>

    </div>
  );
});

export default CheckpointDeck;
