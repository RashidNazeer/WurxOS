import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBrandReportResources } from '../../lib/brandReportResourcesApi';

/**
 * Brand Report Links — auto-rendered link sections in reports.
 *
 * Two render modes:
 *
 * 1. Embedded: when a saved section's name matches an existing report
 *    section heading (e.g. "Recommendations & Action Items"), the links
 *    are embedded at the bottom of that section. Use <EmbeddedLinks> for
 *    this.
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
  if (u.includes('docs.google.com/document'))     return { tint: '#4285F4', bg: '#e8f0fe', label: 'Google Docs',   glyph: '📄' };
  if (u.includes('docs.google.com/spreadsheet') ||
      u.includes('sheets.google.com'))            return { tint: '#0F9D58', bg: '#e6f4ea', label: 'Google Sheets', glyph: '📊' };
  if (u.includes('docs.google.com/presentation') ||
      u.includes('slides.google.com'))            return { tint: '#F4B400', bg: '#fef7e0', label: 'Google Slides', glyph: '🎞' };
  if (u.includes('drive.google.com'))             return { tint: '#4285F4', bg: '#e8f0fe', label: 'Google Drive',  glyph: '☁' };
  if (u.includes('youtube.com') ||
      u.includes('youtu.be'))                     return { tint: '#FF0000', bg: '#fff0f0', label: 'YouTube',       glyph: '▶' };
  if (u.includes('tiktok.com'))                   return { tint: '#1e293b', bg: '#f1f5f9', label: 'TikTok',        glyph: '♪' };
  if (u.includes('figma.com'))                    return { tint: '#F24E1E', bg: '#fff3f0', label: 'Figma',         glyph: '◆' };
  if (u.includes('notion.so'))                    return { tint: '#37352F', bg: '#f5f5f5', label: 'Notion',        glyph: '✎' };
  if (u.includes('dropbox.com'))                  return { tint: '#0061FF', bg: '#e8f0ff', label: 'Dropbox',       glyph: '📦' };
  if (u.includes('airtable.com'))                 return { tint: '#FCB400', bg: '#fff7e0', label: 'Airtable',      glyph: '⊞' };
  return { tint: 'var(--text-secondary)', bg: 'var(--surface-2)', label: 'Link', glyph: '🔗' };
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

// ============================================================
// Single link card — used in both Embedded and Standalone.
// ============================================================
function LinkCard({ link, accent }) {
  const kind = detectLinkKind(link.url);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="brand-report-link-card"
      style={{
        '--brl-accent': accent,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '12px 14px',
        color: 'var(--text-primary)',
        display: 'flex', alignItems: 'center', gap: 12,
        textDecoration: 'none',
        transition: 'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease',
      }}
      title={link.url}>
      <div style={{
        width: 38, height: 38, borderRadius: 10,
        background: kind.bg, color: kind.tint,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        fontSize: 16,
      }}>
        {kind.glyph}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {link.label}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <span style={{
            fontSize: 9.5, fontWeight: 700,
            background: kind.bg, color: kind.tint,
            padding: '1px 7px', borderRadius: 999,
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{kind.label}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {getDomain(link.url)}
          </span>
        </div>
      </div>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
        color: accent,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        fontSize: 13, fontWeight: 700,
      }}>↗</div>
    </a>
  );
}

// ============================================================
// EmbeddedLinks — drop these inside an existing report section
// whose name matches a saved brand resource section.
// ============================================================
export function EmbeddedLinks({ section, accent = '#d97706' }) {
  const links = (section?.links || []).filter((l) => l && l.url);
  if (links.length === 0) return null;
  return (
    <div style={{
      marginTop: 12, paddingTop: 12,
      borderTop: '1px dashed var(--border-subtle)',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
        gap: 8,
      }}>
        {links.map((l) => <LinkCard key={l.id} link={l} accent={accent} />)}
      </div>
    </div>
  );
}

// ============================================================
// StandaloneSection — its own card with header + grid of links.
// ============================================================
function StandaloneSection({ section, accent }) {
  const links = (section.links || []).filter((l) => l && l.url);
  if (links.length === 0) return null;
  return (
    <div className="report-section" style={{ marginTop: 12 }}>
      <div className="report-section-head">
        <div className="report-section-title">
          <span className="report-section-title-icon"
            style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}>
            🔖
          </span>
          <div>
            <div>{section.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
              {links.length} link{links.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      </div>
      <div className="report-section-body">
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
          gap: 8,
        }}>
          {links.map((l) => <LinkCard key={l.id} link={l} accent={accent} />)}
        </div>
      </div>
    </div>
  );
}

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

// ============================================================
// Hook — returns sections + match helpers for the parent view.
// ============================================================
export function useBrandReportLinks(brandId) {
  const { data: sections = [], isPending } = useQuery({
    queryKey: ['brand-report-resources', brandId],
    queryFn: () => getBrandReportResources(brandId),
    enabled: !!brandId,
    staleTime: 60_000,
  });

  const byName = useMemo(() => {
    const m = {};
    sections.forEach((s) => { m[norm(s.name)] = s; });
    return m;
  }, [sections]);

  const findByName = (name) => byName[norm(name)] || null;

  const getUnmatched = (knownNames = []) => {
    const used = new Set(knownNames.map(norm));
    return sections.filter((s) => !used.has(norm(s.name)));
  };

  return { sections, loaded: !isPending, findByName, getUnmatched };
}
