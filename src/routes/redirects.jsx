import { Navigate, useLocation, useParams } from 'react-router-dom';

// Legacy report links. /reports/:id and /<cadence>-reports?report=<id>
// both go through the type-agnostic /r/:reportId resolver.
export function LegacyReportRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/r/${id}` : '/weekly-reports'} replace />;
}

export function ReportQueryRedirect({ children }) {
  const { search } = useLocation();
  const id = new URLSearchParams(search).get('report');
  if (id) return <Navigate to={`/r/${id}`} replace />;
  return children;
}
