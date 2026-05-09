import { useEffect, useState } from 'react';
import { getLeaveQuotaDefault, setLeaveQuotaDefault } from '../../../lib/paidCollabApi';
import { ClockIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

export default function LeaveDefaultsSection() {
  const [quota, setQuota]     = useState({ wfh: 2, medical: 1, emergency: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const [ok, setOk]           = useState('');

  useEffect(() => {
    let cancelled = false;
    getLeaveQuotaDefault()
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      await setLeaveQuotaDefault(quota);
      setOk('Defaults saved. New IPCs will start with these values.');
      setTimeout(() => setOk(''), 3000);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  const set = (k, v) => setQuota((q) => ({ ...q, [k]: Math.max(0, Number(v) || 0) }));

  return (
    <SectionShell
      icon={ClockIcon}
      title="Leave quota defaults"
      subtitle="Starting monthly leave balance for new users. Existing users keep their current quota until you edit them individually."
    >
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}
      {ok && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
          <CheckIcon width="14" height="14" /> <span>{ok}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {[
              { k: 'wfh',       label: 'WFH' },
              { k: 'medical',   label: 'Medical' },
              { k: 'emergency', label: 'Emergency' },
            ].map((f) => (
              <div key={f.k}>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>{f.label}</div>
                <input
                  type="number"
                  min={0}
                  className="wx-input"
                  value={quota[f.k] ?? 0}
                  onChange={(e) => set(f.k, e.target.value)}
                  disabled={saving}
                />
              </div>
            ))}
          </div>
          <div className="settings-footer-actions">
            <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save defaults'}
            </button>
          </div>
        </>
      )}
    </SectionShell>
  );
}
