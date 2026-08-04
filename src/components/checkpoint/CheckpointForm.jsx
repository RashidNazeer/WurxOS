// ============================================================
// Weekly Checkpoint — the input form. All manual entry (v1). Bound to the
// nested `data` object by dot-path. Styled with the app's own tokens/classes
// (this is app UI, distinct from the self-contained deck).
// ============================================================
import { createContext, useContext, useMemo } from 'react';
import { XIcon } from '../common/Icon';
import {
  SNAPSHOT_KPIS, VERDICTS, ACTION_STATUSES, STATUS_OPTIONS, COMMON_BOTTLENECKS,
} from '../../lib/checkpointModel';

// Field primitives read the live data + setter from context so they can stay at
// module scope (defining them inside the component would remount every input on
// each keystroke and drop focus).
const FieldCtx = createContext(null);

// §04 KPIs that are the SAME number as a field in another section — typing the
// KPI's "this week" value also fills the sibling (two-way; the siblings mirror
// back). Only genuine same-type pairs (NOT the GMV-Max-only §08 SKU orders).
const KPI_MIRROR = { orders: 'traffic.orders', gmvMaxSpend: 'paid.spend' };

// ── immutable nested get/set by dot-path ────────────────────────────
function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setIn(obj, path, value) {
  const keys = path.split('.');
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

export default function CheckpointForm({
  data, setData,
  // §09 Paid Collab is owned by the paid collab team. 'readonly' = the brand is on
  // the team list → show their values + a Remind button; 'hidden' = not on the list
  // → drop §09; 'edit' = legacy fallback (old editable inputs).
  paidCollabMode = 'edit', paidCollabEntry = null,
  onRemindPaidCollab, remindingPaidCollab, paidCollabRemindMsg,
  onPullPaidCollab, pullingPaidCollab, paidCollabPulled = false, paidCollabHasWeekEntry = false,
}) {
  const set = (path, value) => setData((d) => setIn(d, path, value));
  const addRow = (path, empty) => setData((d) => setIn(d, path, [...getIn(d, path), empty]));
  const removeRow = (path, i) => setData((d) => {
    const arr = getIn(d, path).filter((_, x) => x !== i);
    return setIn(d, path, arr.length ? arr : getIn(d, path).slice(0, 1).map(() => empties(path)));
  });
  const ctx = useMemo(() => ({ data, set, setData, sym: data.currency || '$' }), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FieldCtx.Provider value={ctx}>
    <div className="ck-form">
      <Section title="Cover" accent="#4f46e5">
        <Grid>
          <Txt label="APC name" path="cover.apcName" />
          <Txt label="Team" path="cover.team" />
        </Grid>
      </Section>

      <Section n={1} title="Affiliate funnel" accent="#4f46e5">
        <SubLabel>Recruit — this week</SubLabel>
        <Grid cols={4}>
          <MirrorNum label="Target invites" path="funnel.targetInvites" mirror={['outreach.reachInvites', 'effort.invitesSent']} />
          <Num label="Opted in" path="funnel.optedIn" />
          <MirrorNum label="Sample requests" path="funnel.sampleRequests" mirror={['samples.requestsReceived', 'effort.sampleRequested']} />
          <MirrorNum label="Approved" path="funnel.approved" mirror={['samples.approvedThisWeek']} />
        </Grid>
        <SubLabel>Produce — cohort approved ~2 wks ago</SubLabel>
        <Grid cols={3}>
          <Num label="Approved · Wk N-2" path="funnel.approvedN2" />
          <Num label="Videos now live" path="funnel.videosLive"
            hint={(d) => {
              const n = d?.funnel?.approvedN2;
              return (n === '' || n == null)
                ? 'Videos those Wk N-2 approved creators have posted (enter manually)'
                : `Videos those ${n} approved creators (Wk N-2) have posted`;
            }} />
          <Num label="Affiliate orders" path="funnel.affiliateOrders" />
        </Grid>
      </Section>

      <Section n={2} title="APC effort log" accent="#0ea5e9">
        <Grid cols={3}>
          <MirrorNum label="Invites sent" path="effort.invitesSent" mirror={['funnel.targetInvites', 'outreach.reachInvites']} />
          <MirrorNum label="Samples requested" path="effort.sampleRequested" mirror={['funnel.sampleRequests', 'samples.requestsReceived']} />
          <Num label="Creators onboarded" path="effort.creatorsOnboarded" />
          <Num label="Via auto-approval" path="effort.onboardedAutoApproval" />
          <Num label="Ad-code follow-ups" path="effort.adCodeFollowups" />
          <Num label="Videos needing auth" path="effort.videosAuthNeeded" />
        </Grid>
        <Area label="What took the most time · proud of · blocked" path="effort.narrative" />
      </Section>

      <Section n={3} title="Outreach & sourcing" accent="#0d9488">
        <SubLabel>How we reached out</SubLabel>
        <Grid cols={3}>
          <MirrorNum label="Target invites" path="outreach.reachInvites" mirror={['funnel.targetInvites', 'effort.invitesSent']} />
          <Num label="Competitors" path="outreach.reachCompetitors" />
          <Num label="DM / Email" path="outreach.reachDmEmail" />
        </Grid>
        <SubLabel>Who we targeted · by tier</SubLabel>
        <Grid cols={4}>
          <Num label="L0 + L1" path="outreach.tierL0L1" />
          <Num label="L2" path="outreach.tierL2" />
          <Num label="L3" path="outreach.tierL3" />
          <Num label="L3+" path="outreach.tierL3plus" />
        </Grid>
        <Grid cols={2}>
          <Num label="Opt-in rate last week" path="outreach.optInRatePrev" sfx="%" />
        </Grid>
        <Txt label="Niches invited" path="outreach.niches" />
        <Area label="Read + next move" path="outreach.readNext" rows={2} />
      </Section>

      <Section n={4} title="Performance snapshot" accent="#4f46e5">
        <label className="ck-field" style={{ maxWidth: 260 }}>
          <span className="wx-label">Overall status</span>
          <select className="wx-input" value={data.snapshot.status}
            onChange={(e) => set('snapshot.status', e.target.value)}>
            {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <div className="ck-kpi-form">
          {SNAPSHOT_KPIS.map((k) => (
            <div className="ck-kpi-form-row" key={k.key}>
              <div className="ck-kpi-name">{k.label}</div>
              {/* type=text + inputMode=decimal (like Num) so decimal KPIs (ROI,
                  CTOR, money) don't get their trailing '.' swallowed, and the
                  mirrored value matches its type=text sibling exactly. */}
              <input type="text" inputMode="decimal" className="wx-input" placeholder="This week"
                value={data.snapshot.kpis[k.key].cur}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.\-]/g, ''); const mir = KPI_MIRROR[k.key];
                  setData((d) => { let x = setIn(d, `snapshot.kpis.${k.key}.cur`, v); if (mir) x = setIn(x, mir, v); return x; });
                }} />
              <input type="text" inputMode="decimal" className="wx-input" placeholder="Last week"
                value={data.snapshot.kpis[k.key].prev} onChange={(e) => set(`snapshot.kpis.${k.key}.prev`, e.target.value.replace(/[^0-9.\-]/g, ''))} />
            </div>
          ))}
        </div>
        <Area label="Why it moved" path="snapshot.whyMoved" />
      </Section>

      <Section n={5} title="Samples" accent="#16a34a">
        <Grid cols={4}>
          <MirrorNum label="Requests received" path="samples.requestsReceived" mirror={['funnel.sampleRequests', 'effort.sampleRequested']} />
          <Num label="Requests last week" path="samples.requestsPrev" />
          <MirrorNum label="Approved this week" path="samples.approvedThisWeek" mirror={['funnel.approved']} />
          <Num label="MTD approved" path="samples.mtdApproved" />
        </Grid>
        <Grid cols={4}>
          <SampleToVideoN2 />
        </Grid>
        <SubLabel>MTD approved · by tier</SubLabel>
        <Grid cols={5}>
          <Num label="L0" path="samples.tiers.L0" />
          <Num label="L1" path="samples.tiers.L1" />
          <Num label="L2" path="samples.tiers.L2" />
          <Num label="L3" path="samples.tiers.L3" />
          <Num label="L3+" path="samples.tiers.L3plus" />
        </Grid>
        <SubLabel>By product</SubLabel>
        {data.samples.products.map((r, i) => (
          <RowEditor key={i} onRemove={() => removeRow('samples.products', i)}>
            <input className="wx-input" placeholder="Product name" value={r.name}
              onChange={(e) => set(`samples.products.${i}.name`, e.target.value)} />
            <input type="number" className="wx-input" placeholder="Approved" style={{ maxWidth: 130 }}
              value={r.count} onChange={(e) => set(`samples.products.${i}.count`, e.target.value)} />
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('samples.products', { name: '', count: '' })}>+ Add product</AddBtn>
        <Area label="Notes" path="samples.notes" rows={2} />
      </Section>

      <Section n={6} title="Content & traffic" accent="#0ea5e9">
        <SubLabel>Traffic funnel — this week vs last</SubLabel>
        <Grid cols={3}>
          <Num label="Impressions" path="traffic.impressions" />
          <Num label="Clicks" path="traffic.clicks" />
          <MirrorNum label="SKU orders" path="traffic.orders" mirror={['snapshot.kpis.orders.cur']} />
          <Num label="Impressions · last wk" path="traffic.impressionsPrev" />
          <Num label="Clicks · last wk" path="traffic.clicksPrev" />
          <Num label="Orders · last wk" path="traffic.ordersPrev" />
        </Grid>
        <SubLabel>Top videos this week</SubLabel>
        {data.traffic.topVideos.map((r, i) => (
          <RowEditor key={i} onRemove={() => removeRow('traffic.topVideos', i)}>
            <input className="wx-input" placeholder="Creator" value={r.creator}
              onChange={(e) => set(`traffic.topVideos.${i}.creator`, e.target.value)} />
            <input className="wx-input" placeholder="Angle" value={r.angle}
              onChange={(e) => set(`traffic.topVideos.${i}.angle`, e.target.value)} />
            <input type="number" className="wx-input" placeholder="GMV" style={{ maxWidth: 130 }}
              value={r.gmv} onChange={(e) => set(`traffic.topVideos.${i}.gmv`, e.target.value)} />
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('traffic.topVideos', { creator: '', angle: '', gmv: '' })}>+ Add video</AddBtn>
        <Area label="Why (on-page / creative)" path="traffic.why" rows={2} />
      </Section>

      <Section n={7} title="Creative angles" accent="#7c3aed">
        {data.angles.rows.map((r, i) => (
          <RowEditor key={i} onRemove={() => removeRow('angles.rows', i)}>
            <input className="wx-input" placeholder="Angle / hook" value={r.angle}
              onChange={(e) => set(`angles.rows.${i}.angle`, e.target.value)} />
            <input type="number" className="wx-input" placeholder="Videos" style={{ maxWidth: 100 }}
              value={r.videos} onChange={(e) => set(`angles.rows.${i}.videos`, e.target.value)} />
            <input type="number" className="wx-input" placeholder="GMV" style={{ maxWidth: 120 }}
              value={r.gmv} onChange={(e) => set(`angles.rows.${i}.gmv`, e.target.value)} />
            <input type="number" className="wx-input" placeholder="CVR %" style={{ maxWidth: 100 }}
              value={r.cvr} onChange={(e) => set(`angles.rows.${i}.cvr`, e.target.value)} />
            <select className="wx-input" style={{ maxWidth: 120 }} value={r.verdict}
              onChange={(e) => set(`angles.rows.${i}.verdict`, e.target.value)}>
              {VERDICTS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('angles.rows', { angle: '', videos: '', gmv: '', cvr: '', verdict: 'scale' })}>+ Add angle</AddBtn>
        <Area label="The decision — one to scale, one to kill" path="angles.decision" rows={2} />
      </Section>

      <Section n={8} title="GMV Max & paid" accent="#d97706">
        <Grid cols={4}>
          <MirrorNum label="Spend" path="paid.spend" mirror={['snapshot.kpis.gmvMaxSpend.cur']} money />
          <Money label="Gross revenue" path="paid.grossRevenue" />
          <Num label="SKU orders" path="paid.skuOrders" />
          <Num label="Target ROI (break-even)" path="paid.targetRoi" sfx="x" />
        </Grid>
        <Grid cols={3}>
          <Money label="Spend · last wk" path="paid.spendPrev" />
          <Money label="Gross rev · last wk" path="paid.grossRevenuePrev" />
          <Money label="Cost/order · last wk" path="paid.costPerOrderPrev" />
        </Grid>
        <Grid cols={2}>
          <label className="ck-field">
            <span className="wx-label">ROI protection</span>
            <select className="wx-input" value={data.paid.roiProtection}
              onChange={(e) => set('paid.roiProtection', e.target.value)}>
              <option value="on">On</option><option value="off">Off</option>
            </select>
          </label>
          <Txt label="Mode" path="paid.mode" ph="e.g. Maximise gross revenue" />
        </Grid>
        <Area label="Spend decision — hold, cut or scale" path="paid.decision" rows={2} />
        <label className="ck-field" style={{ gridColumn: '1 / -1' }}>
          <span className="wx-label">Ads Manager screenshot (optional)</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0]; if (!file) return;
              const rd = new FileReader(); rd.onload = () => set('paid.screenshot', rd.result); rd.readAsDataURL(file);
            }} />
            {data.paid.screenshot && (
              <button type="button" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }}
                onClick={() => set('paid.screenshot', '')}>Remove</button>
            )}
          </div>
        </label>
      </Section>

      {paidCollabMode !== 'hidden' && (
        <Section n={9} title="Paid Collab" accent="#db2777">
          {paidCollabMode === 'readonly' ? (
            <PaidCollabReadOnly entry={paidCollabEntry} sym={data.currency || '$'}
              onRemind={onRemindPaidCollab} reminding={remindingPaidCollab} remindMsg={paidCollabRemindMsg}
              onPull={onPullPaidCollab} pulling={pullingPaidCollab}
              pulled={paidCollabPulled} hasWeekEntry={paidCollabHasWeekEntry} />
          ) : (
            <>
              <Grid cols={3}>
                <Num label="Creators onboarded" path="paidCollab.creatorsOnboarded" />
                <Num label="Creators in pipeline" path="paidCollab.creatorsInPipeline" />
                <Num label="Videos completed" path="paidCollab.videosCompleted" />
                <Num label="Videos planned (total)" path="paidCollab.totalVideos" />
                <Money label="Total budget" path="paidCollab.totalBudget" />
                <Money label="Budget allocated" path="paidCollab.budgetAllocated" />
              </Grid>
              <Area label="Notes" path="paidCollab.notes" rows={2} />
            </>
          )}
        </Section>
      )}

      <Section n={10} title="Research & suggestions" accent="#0d9488">
        <SubLabel>New research / findings</SubLabel>
        {data.research.findings.map((x, i) => (
          <RowEditor key={i} onRemove={() => removeRow('research.findings', i)}>
            <input className="wx-input" placeholder="A finding (cite the source)" value={x}
              onChange={(e) => set(`research.findings.${i}`, e.target.value)} />
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('research.findings', '')}>+ Add finding</AddBtn>
        <SubLabel>Suggestions to test</SubLabel>
        {data.research.suggestions.map((s, i) => (
          <RowEditor key={i} onRemove={() => removeRow('research.suggestions', i)}>
            <input className="wx-input" placeholder="Suggestion" value={s.suggestion}
              onChange={(e) => set(`research.suggestions.${i}.suggestion`, e.target.value)} />
            <input className="wx-input" placeholder="Expected impact" value={s.impact}
              onChange={(e) => set(`research.suggestions.${i}.impact`, e.target.value)} />
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('research.suggestions', { suggestion: '', impact: '' })}>+ Add suggestion</AddBtn>
      </Section>

      <Section n={11} title="Bottlenecks & actions" accent="#2563eb">
        <SubLabel>Bottlenecks</SubLabel>
        <div className="ck-chips-form">
          {COMMON_BOTTLENECKS.map((b) => {
            const on = data.actions.bottlenecks.includes(b);
            return (
              <button type="button" key={b} className={`ck-chip-btn ${on ? 'on' : ''}`}
                onClick={() => set('actions.bottlenecks', on
                  ? data.actions.bottlenecks.filter((x) => x !== b)
                  : [...data.actions.bottlenecks, b])}>
                {on ? '✓ ' : ''}{b}
              </button>
            );
          })}
        </div>
        <SubLabel>Action tracker</SubLabel>
        {data.actions.rows.map((r, i) => (
          <RowEditor key={i} onRemove={() => removeRow('actions.rows', i)}>
            <input className="wx-input" placeholder="Action / bottleneck" value={r.action}
              onChange={(e) => set(`actions.rows.${i}.action`, e.target.value)} />
            <input className="wx-input" placeholder="Owner" style={{ maxWidth: 140 }} value={r.owner}
              onChange={(e) => set(`actions.rows.${i}.owner`, e.target.value)} />
            <input className="wx-input" placeholder="Due" style={{ maxWidth: 110 }} value={r.due}
              onChange={(e) => set(`actions.rows.${i}.due`, e.target.value)} />
            <select className="wx-input" style={{ maxWidth: 130 }} value={r.status}
              onChange={(e) => set(`actions.rows.${i}.status`, e.target.value)}>
              {ACTION_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </RowEditor>
        ))}
        <AddBtn onClick={() => addRow('actions.rows', { action: '', owner: '', due: '', status: 'open' })}>+ Add action</AddBtn>
      </Section>
    </div>
    </FieldCtx.Provider>
  );
}

// ── field primitives (module scope, context-fed) ────────────────────
function Num({ label, path, sfx, hint }) {
  const { data, set } = useContext(FieldCtx);
  const hintText = typeof hint === 'function' ? hint(data) : hint;
  return (
    <label className="ck-field">
      <span className="wx-label">{label}</span>
      <div style={{ position: 'relative' }}>
        {/* type="text" + inputMode="decimal" (NOT type="number"): a controlled
            number input swallows the decimal point ("0." reads back as "" in
            Chrome), so users could never type rates like 0.4. This keeps exactly
            what they type — digits, a dot, a leading minus. */}
        <input type="text" inputMode="decimal" className="wx-input" value={getIn(data, path) ?? ''}
          onChange={(e) => set(path, e.target.value.replace(/[^0-9.\-]/g, ''))} placeholder="—"
          style={sfx ? { paddingRight: 34 } : undefined} />
        {sfx && <span className="ck-sfx">{sfx}</span>}
      </div>
      {hintText && <span className="ck-hint">{hintText}</span>}
    </label>
  );
}
// A number field that also mirrors its value into other paths that hold the SAME
// number (so the APC types it once). Two-way: put a MirrorNum at each spot with
// the OTHER paths in `mirror`. Same sanitiser as Num; optional currency prefix.
function MirrorNum({ label, path, mirror = [], sfx, money, hint }) {
  const { data, setData, sym } = useContext(FieldCtx);
  const hintText = typeof hint === 'function' ? hint(data) : hint;
  const write = (val) => setData((d) => [path, ...mirror].reduce((acc, p) => setIn(acc, p, val), d));
  return (
    <label className="ck-field">
      <span className="wx-label">{label}</span>
      <div style={{ position: 'relative' }}>
        {money && <span className="ck-pfx">{sym}</span>}
        <input type="text" inputMode="decimal" className="wx-input" value={getIn(data, path) ?? ''}
          onChange={(e) => write(e.target.value.replace(/[^0-9.\-]/g, ''))} placeholder="—"
          style={money ? { paddingLeft: 26 } : (sfx ? { paddingRight: 34 } : undefined)} />
        {sfx && !money && <span className="ck-sfx">{sfx}</span>}
      </div>
      {hintText && <span className="ck-hint">{hintText}</span>}
    </label>
  );
}
// A read-only field whose value is derived from other inputs, not typed.
function Derived({ label, value, sfx, hint }) {
  const shown = (value === '' || value == null) ? '' : value;
  return (
    <label className="ck-field">
      <span className="wx-label">{label}</span>
      <div style={{ position: 'relative' }}>
        <input className="wx-input" value={shown} readOnly placeholder="—"
          style={{ background: 'var(--surface-2, #f1f5f9)', cursor: 'default', ...(sfx ? { paddingRight: 34 } : null) }} />
        {sfx && <span className="ck-sfx">{sfx}</span>}
      </div>
      {hint && <span className="ck-hint">{hint}</span>}
    </label>
  );
}

// "Sample→video · N-2" is a live ratio, not a typed number: it equals
// "Videos now live" ÷ "Approved · Wk N-2" (the same N-2 cohort ratio the deck's
// §01 shows). Derived read-only so it can never drift from those two fields, and
// never sourced from this-week's videosPosted.
function SampleToVideoN2() {
  const { data } = useContext(FieldCtx);
  const v = getIn(data, 'funnel.videosLive');
  const a = getIn(data, 'funnel.approvedN2');
  const vn = (v === '' || v == null) ? null : Number(v);
  const an = (a === '' || a == null) ? null : Number(a);
  const val = (vn != null && Number.isFinite(vn) && an) ? Math.round((vn / an) * 1000) / 10 : '';
  const hint = (an && vn != null)
    ? `Auto · ${vn} videos ÷ ${an} approved (Wk N-2)`
    : 'Auto from Videos now live ÷ Approved · Wk N-2';
  return <Derived label="Sample→video · N-2" value={val} sfx="%" hint={hint} />;
}

function Money({ label, path }) {
  const { data, set, sym } = useContext(FieldCtx);
  return (
    <label className="ck-field">
      <span className="wx-label">{label}</span>
      <div style={{ position: 'relative' }}>
        <span className="ck-pfx">{sym}</span>
        <input type="text" inputMode="decimal" className="wx-input" value={getIn(data, path) ?? ''}
          onChange={(e) => set(path, e.target.value.replace(/[^0-9.\-]/g, ''))} placeholder="—" style={{ paddingLeft: 26 }} />
      </div>
    </label>
  );
}
function Txt({ label, path, ph }) {
  const { data, set } = useContext(FieldCtx);
  return (
    <label className="ck-field">
      <span className="wx-label">{label}</span>
      <input className="wx-input" value={getIn(data, path) ?? ''} placeholder={ph || '—'}
        onChange={(e) => set(path, e.target.value)} />
    </label>
  );
}
function Area({ label, path, rows = 3 }) {
  const { data, set } = useContext(FieldCtx);
  return (
    <label className="ck-field" style={{ gridColumn: '1 / -1' }}>
      <span className="wx-label">{label}</span>
      <textarea className="wx-input" rows={rows} value={getIn(data, path) ?? ''}
        onChange={(e) => set(path, e.target.value)} style={{ resize: 'vertical' }} />
    </label>
  );
}


// empties for the "never drop the last row" guard
function empties(path) {
  if (path === 'samples.products') return { name: '', count: '' };
  if (path === 'traffic.topVideos') return { creator: '', angle: '', gmv: '' };
  if (path === 'angles.rows') return { angle: '', videos: '', gmv: '', cvr: '', verdict: 'scale' };
  if (path === 'research.findings') return '';
  if (path === 'research.suggestions') return { suggestion: '', impact: '' };
  if (path === 'actions.rows') return { action: '', owner: '', due: '', status: 'open' };
  return {};
}

// ── layout primitives (app-styled) ─────────────────────────────────
function Section({ n, title, accent, children }) {
  return (
    <section className="ck-sec" id={`cksec-${n ?? 'cover'}`}>
      <div className="ck-sec-head">
        {n != null && <span className="ck-sec-num" style={{ background: accent }}>{String(n).padStart(2, '0')}</span>}
        <h3 className="ck-sec-title">{title}</h3>
      </div>
      <div className="ck-sec-body">{children}</div>
    </section>
  );
}
function Grid({ cols = 2, children }) {
  return <div className="ck-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{children}</div>;
}
function SubLabel({ children }) { return <div className="ck-sublabel">{children}</div>; }
function RowEditor({ children, onRemove }) {
  return (
    <div className="ck-roweditor">
      <div className="ck-roweditor-fields">{children}</div>
      <button type="button" className="ck-row-x" onClick={onRemove} aria-label="Remove row">
        <XIcon width="14" height="14" />
      </button>
    </div>
  );
}
function AddBtn({ children, onClick }) {
  return <button type="button" className="ck-add-btn" onClick={onClick}>{children}</button>;
}

// §09 for the APC checkpoint on a paid-collab-managed brand: read-only view of what
// the Paid Collab team entered for the week + a "remind them" button. The team fills
// the values in their own dashboard; the APC only sees the status and can nudge.
function PaidCollabReadOnly({
  entry, sym = '$', onRemind, reminding, remindMsg,
  onPull, pulling, pulled = false, hasWeekEntry = false,
}) {
  const d = entry?.data || {};
  const filled = Object.values(d).some((v) => v != null && String(v).trim() !== '');
  // Money values may have been typed with a currency symbol / commas ("$5,000",
  // even "$$5,000"); strip to the number and re-format so we never show "$$…".
  const fmt = (v, money) => {
    if (v === '' || v == null) return '—';
    if (!money) return String(v);
    const clean = String(v).replace(/[^0-9.]/g, '');
    return clean ? sym + Number(clean).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);
  };
  const stat = (label, val, money) => (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 10px' }}>
      <div className="text-muted" style={{ fontSize: '0.68rem', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(val, money)}</div>
    </div>
  );
  const pulledWeek = pulled && entry?.week_start
    ? new Date(`${entry.week_start}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Filled by the Paid Collab team.</span>
        <span className="badge" style={{
          background: filled ? 'var(--success-soft)' : 'var(--surface-2)',
          color: filled ? 'var(--success)' : 'var(--text-muted)', fontSize: '0.66rem', fontWeight: 700,
        }}>
          {hasWeekEntry ? '✓ Filled for this week' : (filled && pulled) ? '✓ Pulled from team data' : 'Not filled for this week'}
          {entry?.updated_at ? ` · ${new Date(entry.updated_at).toLocaleDateString()}` : ''}
        </span>
      </div>
      {pulled && filled && pulledWeek && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>
          <i className="bi bi-info-circle me-1" />
          Showing the team's latest entry (tagged to the week of {pulledWeek}) — this data isn't tied to a specific week.
        </div>
      )}
      {filled ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          {stat('Creators onboarded', d.creatorsOnboarded)}
          {stat('Creators in pipeline', d.creatorsInPipeline)}
          {stat('Videos completed', d.videosCompleted)}
          {stat('Videos planned', d.totalVideos)}
          {stat('Total budget', d.totalBudget, true)}
          {stat('Budget allocated', d.budgetAllocated, true)}
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>
          The Paid Collab team hasn't entered any data for this brand yet.
        </div>
      )}
      {d.notes && String(d.notes).trim() && (
        <div style={{ marginTop: 10, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
          <strong>Notes:</strong> {d.notes}
        </div>
      )}
      <div className="d-flex align-items-center gap-2 mt-3 flex-wrap">
        {/* Data now auto-falls-back to the team's latest entry, so this manual
            pull only appears when there's genuinely nothing to show. */}
        {!hasWeekEntry && !filled && (
          <button type="button" className="btn btn-sm btn-primary" disabled={pulling} onClick={onPull}>
            {pulling
              ? <><span className="spinner-border spinner-border-sm me-1" /> Pulling…</>
              : <><i className="bi bi-download me-1" /> {pulled ? 'Re-pull' : 'Pull'} Paid Collab data</>}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-outline-secondary" disabled={reminding} onClick={onRemind}>
          {reminding ? <><span className="spinner-border spinner-border-sm me-1" /> Sending…</> : <><i className="bi bi-bell me-1" /> Remind Paid Collab team</>}
        </button>
        {remindMsg && <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{remindMsg}</span>}
      </div>
    </div>
  );
}
