import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useToast } from '../components/ui';
import { Skeleton } from '../components/ui/Skeleton';

// /r/:reportId — day-1 stand-in for Engineer B's ReportLinkResolver (F2).
// Looks the report up (RLS-scoped) and replaces the URL with its cadence
// list. B swaps the route element for the real resolver, which opens the
// exact report via reportUrl().
const LIST_BY_TYPE = {
  weekly: '/weekly-reports',
  biweekly: '/biweekly-reports',
  monthly: '/monthly-reports',
};

export default function ReportLinkStub() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    supabase.from('reports').select('id, type').eq('id', reportId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          toast.error("That report isn't available to you.");
          navigate('/weekly-reports', { replace: true });
          return;
        }
        navigate(LIST_BY_TYPE[data.type] || '/weekly-reports', { replace: true });
      });
    return () => { cancelled = true; };
  }, [reportId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 720 }} aria-busy="true">
      <Skeleton w="40%" h={24} />
      <Skeleton h={120} radius="var(--radius-lg)" />
    </div>
  );
}
