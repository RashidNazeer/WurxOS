import React, { useMemo, useState } from 'react';
import { bossSaveArticle, normalizeUrl } from '../../lib/kbApi';

const VALID_TABS = ['delivery_roadmap', 'bootcamp', 'operational_sops', 'training_sops', 'policies'];
const SOP_TABS   = ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'];
const VALID_ROLES = ['tl', 'ol', 'apc', 'ipc', 'pctl'];
const VALID_VISIBILITY = ['everyone', 'roles', 'users'];

const HEADERS = ['title', 'url', 'description', 'tab', 'version', 'visibilityType', 'roles', 'userEmails'];

const TEMPLATE = [
  HEADERS.join(','),
  '"New Hire Onboarding","https://drive.google.com/...","Welcome packet","bootcamp",,"everyone",,',
  '"Leave & WFH Policy","https://docs.google.com/...","How to apply","policies","v2.0","roles","tl,ol,apc",',
  '"Exec-Only Roadmap","https://notion.so/...","Confidential","delivery_roadmap","v1.0","users",,"ceo@x.com;coo@x.com"',
].join('\n');

/* ── CSV parser (handles quoted fields and embedded commas/quotes) ───────── */
function parseCSV(text) {
  const rows = []; let current = []; let field = ''; let inQ = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { current.push(field); field = ''; }
    else if (ch === '\n') { current.push(field); field = ''; rows.push(current); current = []; }
    else field += ch;
  }
  if (field.length || current.length) { current.push(field); rows.push(current); }
  return rows.filter(r => r.some(c => c.trim().length));
}

function splitList(s) {
  return (s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function cleanCell(v) {
  let s = (v || '').trim();
  if (s.startsWith("'")) s = s.slice(1);
  return s;
}

function validateRow(raw, emailToUid, existingUrlMap, seenInCsv) {
  const r = Object.fromEntries(HEADERS.map(h => [h, cleanCell(raw[h])]));
  const errors = [];

  if (!r.title) errors.push('title is required');
  if (!r.url) errors.push('url is required');
  if (r.url && !/^https?:\/\//i.test(r.url)) errors.push('url must start with http(s)://');

  if (r.url) {
    const key = normalizeUrl(r.url);
    if (key) {
      if (existingUrlMap && existingUrlMap.has(key)) {
        errors.push(`duplicate of existing doc "${existingUrlMap.get(key)}" (same URL)`);
      } else if (seenInCsv && seenInCsv.has(key)) {
        errors.push('duplicate URL in this CSV (already appeared on an earlier row)');
      }
      if (seenInCsv) seenInCsv.add(key);
    }
  }

  if (!r.tab) errors.push('tab is required');
  else if (!VALID_TABS.includes(r.tab)) errors.push(`tab must be one of ${VALID_TABS.join('/')}`);

  const isSop = SOP_TABS.includes(r.tab);
  if (isSop && !r.version) errors.push('version is required for SOP tabs (policies/operational_sops/training_sops/delivery_roadmap)');

  if (!r.visibilityType) errors.push('visibilityType is required');
  else if (!VALID_VISIBILITY.includes(r.visibilityType)) errors.push(`visibilityType must be one of ${VALID_VISIBILITY.join('/')}`);

  let roles = [];
  let userIds = [];
  const unknownEmails = [];

  if (r.visibilityType === 'roles') {
    roles = splitList(r.roles).map(x => x.toLowerCase());
    if (roles.length === 0) errors.push('roles column must have at least one role when visibilityType=roles');
    const bad = roles.filter(x => !VALID_ROLES.includes(x));
    if (bad.length) errors.push(`unknown role(s): ${bad.join(', ')}`);
  } else if (r.visibilityType === 'users') {
    const emails = splitList(r.userEmails).map(e => e.toLowerCase());
    if (emails.length === 0) errors.push('userEmails column must have at least one email when visibilityType=users');
    emails.forEach(e => {
      const uid = emailToUid.get(e);
      if (uid) userIds.push(uid); else unknownEmails.push(e);
    });
    if (unknownEmails.length) errors.push(`unknown email(s): ${unknownEmails.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      title: r.title,
      url: r.url,
      description: r.description || '',
      tab: r.tab,
      version: isSop ? r.version : '',
      visibility: {
        type: r.visibilityType,
        roles: r.visibilityType === 'roles' ? roles : [],
        userIds: r.visibilityType === 'users' ? userIds : [],
      },
      isSop,
    },
  };
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'knowledge_base_template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Modal ──────────────────────────────────────────────────────────────── */
export default function BulkImportKnowledgeBaseModal({ allUsers, currentUser, existingItems = [], onClose, onImported }) {
  const [csvText, setCsvText] = useState('');
  const [parsed, setParsed]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [result, setResult]   = useState(null);

  const emailToUid = useMemo(() => {
    const m = new Map();
    (allUsers || []).forEach(u => { if (u.email) m.set(u.email.toLowerCase(), u.id); });
    return m;
  }, [allUsers]);

  const existingUrlMap = useMemo(() => {
    const m = new Map();
    (existingItems || []).forEach(it => {
      const key = normalizeUrl(it.url);
      if (key && !m.has(key)) m.set(key, it.title || it.url);
    });
    return m;
  }, [existingItems]);

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => setCsvText(String(ev.target?.result || ''));
    reader.readAsText(f);
  }

  function handleParse() {
    setResult(null);
    const rows = parseCSV(csvText || '');
    if (rows.length < 2) { setParsed({ rows: [], validCount: 0, invalidCount: 0, headerError: 'CSV is empty — need a header row + at least one data row.' }); return; }
    const header = rows[0].map(h => (h || '').trim());
    const missing = HEADERS.filter(h => !header.some(col => col.toLowerCase() === h.toLowerCase()));
    if (missing.length) {
      setParsed({ rows: [], validCount: 0, invalidCount: 0, headerError: `Missing column(s): ${missing.join(', ')}. Expected: ${HEADERS.join(', ')}` });
      return;
    }
    const idx = Object.fromEntries(HEADERS.map(h => [h, header.findIndex(col => col.toLowerCase() === h.toLowerCase())]));

    const out = [];
    const seenInCsv = new Set();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const raw = {};
      HEADERS.forEach(h => { raw[h] = idx[h] >= 0 ? (row[idx[h]] || '') : ''; });
      const res = validateRow(raw, emailToUid, existingUrlMap, seenInCsv);
      out.push({ lineNumber: i + 1, raw, ...res });
    }
    const valid = out.filter(r => r.ok).length;
    setParsed({ rows: out, validCount: valid, invalidCount: out.length - valid });
  }

  async function handleImport() {
    if (!parsed || parsed.validCount === 0) return;
    setSaving(true);
    const rowsToWrite = parsed.rows.filter(r => r.ok);
    let added = 0; let failed = 0;

    try {
      for (const r of rowsToWrite) {
        try {
          await bossSaveArticle({
            title:       r.data.title,
            url:         r.data.url,
            description: r.data.description,
            tab:         r.data.tab,
            visibility:  r.data.visibility,
            ...(r.data.isSop ? { version: r.data.version } : {}),
          });
          added += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      setSaving(false);
      setResult({ added, failed });
      if (added > 0 && onImported) onImported(added);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1060, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 820, zIndex: 1, borderRadius: 14, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="px-4 pt-4 pb-3 d-flex align-items-start justify-content-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <h6 className="fw-bold mb-0 d-flex align-items-center gap-2">
              <i className="bi bi-file-earmark-arrow-up" style={{ color: 'var(--info)' }} />
              Bulk Import Knowledge Base
            </h6>
            <div className="text-muted small mt-1">Paste CSV text or upload a .csv file. All rows are approved & visible by your rules.</div>
          </div>
          <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
            style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div className="flex-grow-1 p-4" style={{ overflowY: 'auto' }}>
          {/* Format guide */}
          <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-semibold small">CSV format</div>
              <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={downloadTemplate}>
                <i className="bi bi-download" /> Download template
              </button>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Columns (in any order, header row required):
              <div className="mt-1">
                <code>title, url, description, tab, version, visibilityType, roles, userEmails</code>
              </div>
              <ul className="mb-0 mt-2" style={{ paddingLeft: 18 }}>
                <li><strong>tab</strong>: <code>delivery_roadmap</code>, <code>bootcamp</code>, <code>operational_sops</code>, <code>training_sops</code>, <code>policies</code></li>
                <li><strong>version</strong>: required for every tab except <code>bootcamp</code></li>
                <li><strong>visibilityType</strong>: <code>everyone</code> / <code>roles</code> / <code>users</code></li>
                <li><strong>roles</strong>: comma-separated subset of <code>tl, ol, apc, ipc, pctl</code> (when visibilityType=roles)</li>
                <li><strong>userEmails</strong>: comma- or semicolon-separated emails resolved to the app's user accounts (when visibilityType=users)</li>
              </ul>
            </div>
            <div className="mt-2 rounded-2 p-2 d-flex align-items-start gap-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
              <i className="bi bi-exclamation-triangle-fill" style={{ color: 'var(--warning)', fontSize: '0.82rem', marginTop: 2 }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--warning)', lineHeight: 1.5 }}>
                <strong>Excel tip:</strong> Excel trims <code>1.0</code> → <code>1</code> on numeric cells. To keep version strings intact, either use <code>v1.0</code> / <code>1.0.0</code>, format the Version column as <strong>Text</strong> before typing, prefix the value with an apostrophe (<code>'1.0</code>), or edit in Google Sheets.
              </div>
            </div>
          </div>

          {/* File + textarea */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Upload CSV file (optional)</label>
            <input type="file" accept=".csv,text/csv" className="form-control form-control-sm" onChange={handleFile} />
          </div>
          <div className="mb-3">
            <label className="form-label small fw-semibold">Or paste CSV text</label>
            <textarea className="form-control form-control-sm" rows={6} value={csvText} onChange={e => setCsvText(e.target.value)}
              placeholder={HEADERS.join(',') + '\n"Example title","https://...","...","bootcamp",,"everyone",,'}
              style={{ fontFamily: 'monospace', fontSize: '0.75rem' }} />
          </div>

          <div className="d-flex gap-2 mb-3">
            <button className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8, fontSize: '0.78rem' }}
              onClick={handleParse} disabled={!csvText.trim()}>
              <i className="bi bi-search" /> Parse & validate
            </button>
            {parsed && parsed.validCount > 0 && (
              <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={handleImport} disabled={saving}>
                {saving ? <><span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} /> Importing…</>
                  : <><i className="bi bi-cloud-upload" /> Import {parsed.validCount} {parsed.validCount === 1 ? 'row' : 'rows'}</>}
              </button>
            )}
          </div>

          {parsed?.headerError && (
            <div className="alert alert-danger small py-2 px-3 mb-0">{parsed.headerError}</div>
          )}

          {parsed && !parsed.headerError && (
            <div>
              <div className="d-flex gap-3 mb-2 small">
                <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <i className="bi bi-check-circle me-1" />{parsed.validCount} valid
                </span>
                {parsed.invalidCount > 0 && (
                  <span className="badge rounded-pill" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
                    <i className="bi bi-exclamation-triangle me-1" />{parsed.invalidCount} with errors
                  </span>
                )}
              </div>

              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                <table className="table table-sm mb-0" style={{ fontSize: '0.72rem' }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={{ width: 40 }}>Line</th>
                      <th>Title</th>
                      <th>Tab</th>
                      <th>Visibility</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.map(r => (
                      <tr key={r.lineNumber} style={{ background: r.ok ? 'var(--surface-1)' : 'var(--danger-soft)' }}>
                        <td>{r.lineNumber}</td>
                        <td>{r.raw.title || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td><code>{r.raw.tab}</code></td>
                        <td>
                          <code>{r.raw.visibilityType}</code>
                          {r.raw.visibilityType === 'roles' && r.raw.roles && <span className="ms-1" style={{ color: 'var(--text-muted)' }}>{r.raw.roles}</span>}
                          {r.raw.visibilityType === 'users' && r.raw.userEmails && <span className="ms-1" style={{ color: 'var(--text-muted)' }}>{r.raw.userEmails}</span>}
                        </td>
                        <td>
                          {r.ok
                            ? <span style={{ color: 'var(--success)' }}>✓ OK</span>
                            : <span style={{ color: 'var(--danger)' }}>✗ {r.errors.join('; ')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result && (
            <div className="alert alert-success small py-2 px-3 mt-3 mb-0 d-flex align-items-center gap-2">
              <i className="bi bi-check-circle-fill" />
              Imported <strong>{result.added}</strong> document{result.added !== 1 ? 's' : ''}.
              {result.failed > 0 && <> <span className="text-danger ms-2">{result.failed} failed.</span></>}
            </div>
          )}
        </div>

        <div className="px-4 py-3 d-flex justify-content-end gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </div>
  );
}
