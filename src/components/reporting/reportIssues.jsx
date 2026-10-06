import { createContext, useContext } from 'react';

// Submit-time validation shown inline next to each section (bi-weekly and
// monthly editors). The form's validate() is unchanged; its messages are
// grouped by section title here.
export const ReportIssuesContext = createContext({});

// Group validate() messages by the section title that owns them.
export function groupIssues(messages, sectionOf) {
  const out = {};
  messages.forEach((m) => {
    const s = sectionOf(m);
    (out[s] = out[s] || []).push(m);
  });
  return out;
}

export function scrollToIssue(title) {
  const el = document.querySelector(`[data-issue-section="${CSS.escape(title)}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function IssueList({ section }) {
  const issues = useContext(ReportIssuesContext)[section] || [];
  if (!issues.length) return null;
  return (
    <ul role="alert" className="mb-3"
      style={{
        listStyle: 'none', padding: '10px 12px', borderRadius: 'var(--radius-md)',
        background: 'var(--danger-soft)', color: 'var(--danger-text)',
        border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
        fontSize: '0.78rem', fontWeight: 600, display: 'grid', gap: 4,
      }}>
      {issues.map((m) => (
        <li key={m}><i className="bi bi-exclamation-circle-fill me-1" aria-hidden="true" />{m}</li>
      ))}
    </ul>
  );
}
