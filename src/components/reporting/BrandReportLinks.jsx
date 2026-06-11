import React, { useEffect, useMemo, useState } from 'react';
import { getBrandReportResources, sectionAppliesTo } from '../../utils/brandReportResources';

/**
 * Brand-default "Report Links" — auto-rendered link sections in reports.
 *
 * Two render modes (the parent view picks):
 *
 * 1. Embedded: when a saved section's name matches an existing report
 *    section (e.g. "Operational Updates"), the links are embedded at the
 *    bottom of that section. Use <EmbeddedLinks> for this.
 *
 * 2. Standalone: when a saved section name doesn't match any existing
 *    report section, it renders as its own card. Use
 *    <UnmatchedReportLinkSections> for this — pass it the array returned
 *    by useBrandReportLinks().getUnmatched(knownNames).
 */

const PALETTE = ['#d97706', '#0ea5e9', '#16a34a', '#8b5cf6', '#ec4899', '#f97316'];

const norm = (s) => (s || '').trim().toLowerCase();

function detectLinkKind(url = '') {
  const u = url.toLowerCase();
  if (u.includes('docs.google.com/document'))   return { icon: 'bi-file-earmark-text', tint: '#4285F4', bg: '#e8f0fe', label: 'Google Docs' };
  if (u.includes('docs.google.com/spreadsheet') || u.includes('sheets.google.com')) return { icon: 'bi-grid-3x3', tint: '#0F9D58', bg: '#e6f4ea', label: 'Google Sheets' };
  if (u.includes('docs.google.com/presentation') || u.includes('slides.google.com')) return { icon: 'bi-easel2', tint: '#F4B400', bg: '#fef7e0', label: 'Google Slides' };
  if (u.includes('drive.google.com'))            return { icon: 'bi-cloud-fill', tint: '#4285F4', bg: '#e8f0fe', label: 'Google Drive' };
  if (u.includes('youtube.com') || u.includes('youtu.be')) return { icon: 'bi-youtube', tint: '#FF0000', bg: '#fff0f0', label: 'YouTube' };
  if (u.includes('tiktok.com'))                  return { icon: 'bi-tiktok', tint: '#1e293b', bg: '#f1f5f9', label: 'TikTok' };
  if (u.includes('figma.com'))                   return { icon: 'bi-pentagon-fill', tint: '#F24E1E', bg: '#fff3f0', label: 'Figma' };
  if (u.includes('notion.so'))                   return { icon: 'bi-journal-richtext', tint: '#37352F', bg: '#f5f5f5', label: 'Notion' };
  if (u.includes('dropbox.com'))                 return { icon: 'bi-box', tint: '#0061FF', bg: '#e8f0ff', label: 'Dropbox' };
  if (u.includes('airtable.com'))                return { icon: 'bi-table', tint: '#FCB400', bg: '#fff7e0', label: 'Airtable' };
  return { icon: 'bi-link-45deg', tint: '#475569', bg: '#f1f5f9', label: 'Link' };
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function LinkCard({ link, accent }) {
  const kind = detectLinkKind(link.url);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="d-flex align-items-center gap-3 text-decoration-none"
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '14px 16px',
        color: 'var(--text-primary)',
        transition: 'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 6px 18px rgba(15,23,42,0.08)';
        e.currentTarget.style.borderColor = accent + '88';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
      }}
      title={link.url}>
      <div style={{
        width: 42, height: 42, borderRadius: 10,
        background: kind.bg, color: kind.tint,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <i className={`bi ${kind.icon}`} style={{ fontSize: '1.1rem' }} />
      </div>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{link.label}</div>
        <div className="d-flex align-items-center gap-2 mt-1">
          <span style={{
            fontSize: '0.62rem', fontWeight: 600,
            background: kind.bg, color: kind.tint,
            padding: '1px 7px', borderRadius: 999,
            letterSpacing: '0.02em',
          }}>{kind.label}</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {getDomain(link.url)}
          </span>
        </div>
      </div>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: accent + '14', color: accent,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <i className="bi bi-arrow-up-right" style={{ fontSize: '0.85rem' }} />
      </div>
    </a>
  );
}

/**
 * Inline links to embed at the bottom of an existing report section
 * whose name matches a saved brand resource section.
 *
 * Props:
 *   section — the saved-section object (or null/undefined → renders nothing)
 *   accent — accent color for the open-button circle (defaults to amber)
 */
export function EmbeddedLinks({ section, accent = '#d97706' }) {
  const links = (section && section.links) ? section.links.filter(l => l && l.url) : [];
  if (links.length === 0) return null;
  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
      <div className="row g-2">
        {links.map(l => (
          <div key={l.id} className="col-12 col-md-6">
            <LinkCard link={l} accent={accent} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Standalone card per unmatched brand resource section. Each gets its own
 * icon-circle header.
 */
function StandaloneSection({ section, accent }) {
  const links = (section.links || []).filter(l => l && l.url);
  if (links.length === 0) return null;
  return (
    <div className="mt-3" style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 14,
      padding: '20px 22px',
    }}>
      <div className="d-flex align-items-center gap-3 mb-3">
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: accent + '15', color: accent,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <i className="bi bi-bookmark-fill" style={{ fontSize: '1rem' }} />
        </div>
        <div>
          <div style={{ fontSize: '1.02rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em', lineHeight: 1.2 }}>
            {section.name}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
            {links.length} link{links.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>
      <div className="row g-2">
        {links.map(l => (
          <div key={l.id} className="col-12 col-md-6">
            <LinkCard link={l} accent={accent} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the brand-resource sections that did NOT match any existing
 * report section (and therefore should appear as their own cards).
 */
export function UnmatchedReportLinkSections({ sections }) {
  if (!sections || sections.length === 0) return null;
  return (
    <>
      {sections.map((section, i) => (
        <StandaloneSection key={section.id} section={section} accent={PALETTE[i % PALETTE.length]} />
      ))}
    </>
  );
}

/**
 * Hook: loads brand resource sections and returns a few helpers.
 *
 * Returns:
 *   sections: full list (raw)
 *   loaded:   bool
 *   findByName(name): returns the saved section whose name matches `name`
 *                    (case-insensitive, trim) or null
 *   getUnmatched(knownNames): returns sections whose names DON'T appear in
 *                             the provided knownNames list
 */
export function useBrandReportLinks(brandId, reportType, injectedSections = null) {
  const [fetched, setFetched] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // The client portal injects sections from the get_client_access payload:
    // brand_report_resources is RLS-gated to authenticated users (mig 103), so
    // an anonymous client can't fetch it directly. When injected, skip the fetch.
    if (injectedSections != null) { setLoaded(true); return; }
    let cancelled = false;
    if (!brandId) { setLoaded(true); return; }
    setLoaded(false);
    getBrandReportResources(brandId)
      .then(s => { if (!cancelled) setFetched(s); })
      .catch(() => { if (!cancelled) setFetched([]); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [brandId, injectedSections]);

  const allSections = injectedSections != null ? injectedSections : fetched;

  // Filter to sections that apply to this report type. Legacy sections
  // (no appliesTo field) keep showing in all three for back-compat.
  // A missing reportType (older callers) is treated as legacy too —
  // shows everything.
  const sections = useMemo(
    () => allSections.filter(s => sectionAppliesTo(s, reportType)),
    [allSections, reportType]
  );

  const byName = useMemo(() => {
    const m = {};
    sections.forEach(s => { m[norm(s.name)] = s; });
    return m;
  }, [sections]);

  const findByName = (name) => byName[norm(name)] || null;

  const getUnmatched = (knownNames = []) => {
    const used = new Set(knownNames.map(norm));
    return sections.filter(s => !used.has(norm(s.name)));
  };

  return { sections, loaded, findByName, getUnmatched };
}

/**
 * Backwards-compatible default export. Renders ALL sections as standalone
 * cards. New code should prefer the hook + EmbeddedLinks pattern so that
 * matching names embed into existing report sections instead of duplicating.
 */
export default function BrandReportLinks({ brandId, knownSectionNames = [], reportType, injectedSections = null }) {
  const { getUnmatched, loaded } = useBrandReportLinks(brandId, reportType, injectedSections);
  if (!loaded) return null;
  const unmatched = getUnmatched(knownSectionNames);
  if (unmatched.length === 0) return null;
  return <UnmatchedReportLinkSections sections={unmatched} />;
}
