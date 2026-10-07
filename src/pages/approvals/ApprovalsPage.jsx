import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Button, EmptyState, PageHeader, SkeletonRows, Tabs } from '../../components/ui';
import { useDialogs } from '../../components/common/useDialogs';
import ApprovalRow from '../../components/approvals/ApprovalRow';
import { useApprovals, useApprovalAction, useMarkApprovalsRead, KIND_LABEL } from '../../lib/approvalsApi';
import '../../styles/today.css';

// /approvals — everything waiting on the signed-in TL / PCTL / OL / Boss in
// one list (spec F3). Tabs per source with counts (empty ones hidden), inline
// decisions, and batch approve for reports and attendance.
export default function ApprovalsPage() {
  const { profile } = useAuth();
  const role = profile?.role;
  const [params, setParams] = useSearchParams();
  const { kinds, items, sources, loading, count } = useApprovals();
  const tab = params.get('kind') || 'all';
  const setTab = (k) => setParams(k === 'all' ? {} : { kind: k }, { replace: true });
  const [selected, setSelected] = useState(() => new Set());
  const act = useApprovalAction();
  const markRead = useMarkApprovalsRead();
  const { ask } = useDialogs();

  const tabs = useMemo(() => {
    const t = [{ id: 'all', label: 'All', badge: count || undefined }];
    kinds.forEach((k) => {
      const s = sources[k];
      if ((s?.total || 0) > 0 || s?.error) t.push({ id: k, label: KIND_LABEL[k], badge: s?.count || undefined });
    });
    return t;
  }, [kinds, count, sources]);

  const list = items.filter((x) => tab === 'all' || x.kind === tab);
  const batchable = (x) => x.canAct && (x.kind === 'reports' || x.kind === 'attendance') && (role === 'tl' || role === 'ol');
  const chosen = list.filter((x) => selected.has(x.id) && batchable(x));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const approveSelected = async () => {
    const ok = await ask(`Approve ${chosen.length} item${chosen.length === 1 ? '' : 's'}?\n\n${chosen.slice(0, 8).map((x) => `• ${x.who} — ${x.title}`).join('\n')}${chosen.length > 8 ? '\n…' : ''}`,
      { title: 'Approve selected', confirmLabel: `Approve ${chosen.length}` });
    if (!ok) return;
    for (const item of chosen) {
      // Sequential: each keeps its own optimistic removal and rollback.
      // eslint-disable-next-line no-await-in-loop
      await act.mutateAsync({ item, action: 'approve' }).catch(() => {});
    }
    setSelected(new Set());
  };

  const failed = Object.entries(sources).filter(([k, s]) => s.error && (tab === 'all' || tab === k));

  return (
    <div className="appr-page">
      <PageHeader title="Approvals" subtitle="Everything waiting on you, in one place."
        actions={(
          <>
            <Button variant="secondary" disabled={count === 0} loading={markRead.isPending}
              onClick={() => markRead.mutate(items)}>Mark all as read</Button>
            {chosen.length > 0 && (
              <Button onClick={approveSelected} loading={act.isPending}>Approve selected ({chosen.length})</Button>
            )}
          </>
        )} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Approval types" />}
      {failed.map(([k, s]) => (
        <div key={k} className="today-card__error" role="alert">
          <span>{KIND_LABEL[k]} couldn't load. {s.error.message}</span>
          <Button size="sm" variant="secondary" onClick={() => s.refetch()}>Retry</Button>
        </div>
      ))}
      <div className="appr-list-wrap" aria-busy={loading || undefined}>
        {loading && list.length === 0 ? <SkeletonRows n={5} /> : list.length === 0 ? (
          <EmptyState icon={<i className="bi bi-inbox" />} title="Nothing waiting for you"
            description="New leave, attendance, report and brand requests show up here." />
        ) : (
          <ul className="today-list">
            {list.map((it) => (
              <ApprovalRow key={`${it.kind}:${it.id}`} item={it} role={role}
                selectable={batchable(it)} selected={selected.has(it.id)} onToggle={() => toggle(it.id)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
