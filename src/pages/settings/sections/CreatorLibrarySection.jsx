import { useEffect, useMemo, useState } from 'react';
import { getSheetConfig, saveSheetConfig } from '../../../lib/creatorLibraryApi';

// The Apps Script the user pastes into their sheet (Extensions → Apps Script),
// then deploys as a Web App. ${SECRET} is substituted with the saved secret so
// the copy button hands them a ready-to-paste script.
function appsScript(secret) {
  return `// WurxOS Creator Library bridge — paste into Extensions → Apps Script,
// then Deploy → New deployment → Web app → Execute as: Me,
// Who has access: Anyone. Copy the /exec URL into WurxOS settings.
const SECRET = '${secret || 'PASTE-THE-SAME-SECRET-FROM-WURXOS'}';
const HANDLE_COL = 'Tiktok Handle';
const BRAND_COL  = 'Brand';
const STATUS_COL = 'Status';
const NOTE_COL   = 'Notes';

function doPost(e) {
  const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  if (body.secret !== SECRET) return out({ error: 'unauthorized' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function (h) { return String(h).trim(); });
  const idx = function (n) { return headers.map(function (h) { return h.toLowerCase(); }).indexOf(n.toLowerCase()); };
  const norm = function (s) { return String(s == null ? '' : s).trim().replace(/^@+/, '').toLowerCase(); };

  if (body.action === 'read') {
    const rows = [];
    for (var i = 1; i < data.length; i++) {
      var o = {};
      for (var c = 0; c < headers.length; c++) o[headers[c]] = String(data[i][c] == null ? '' : data[i][c]).trim();
      rows.push(o);
    }
    return out({ headers: headers, rows: rows });
  }

  if (body.action === 'write') {
    var hc = idx(HANDLE_COL), bc = idx(BRAND_COL), sc = idx(STATUS_COL), nc = idx(NOTE_COL);
    var wantH = norm(body.handle), wantB = String(body.brand || '').trim().toLowerCase();
    for (var i = 1; i < data.length; i++) {
      if (norm(data[i][hc]) === wantH && String(data[i][bc]).trim().toLowerCase() === wantB) {
        if (sc >= 0) sheet.getRange(i + 1, sc + 1).setValue(body.status || '');
        if (nc >= 0 && body.note) sheet.getRange(i + 1, nc + 1).setValue(body.note);
        return out({ ok: true, updated: 1 });
      }
    }
    return out({ ok: true, updated: 0 });
  }
  return out({ error: 'bad action' });
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`;
}

function randomSecret() {
  const a = new Uint8Array(24);
  (crypto || window.crypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default function CreatorLibrarySection() {
  const [csvUrl, setCsvUrl] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    getSheetConfig()
      .then((c) => { setCsvUrl(c.sheet_url || ''); setHookUrl(c.sheet_webhook_url || ''); setSecret(c.sheet_webhook_secret || ''); })
      .catch((e) => setErr(e.message || String(e)))
      .finally(() => setLoaded(true));
  }, []);

  const script = useMemo(() => appsScript(secret), [secret]);
  const copy = (text, tag) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(tag); setTimeout(() => setCopied(''), 1400); })
      .catch(() => {});
  };

  async function save() {
    setSaving(true); setErr(''); setMsg('');
    try {
      await saveSheetConfig({ sheetUrl: csvUrl, webhookUrl: hookUrl, webhookSecret: secret });
      setMsg('Saved. Instant sync + write-back are active once the script is deployed with this URL & secret.');
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  const live = !!hookUrl && !!secret;

  return (
    <div>
      <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 14 }}>
        The Creator Library reads ONE shared Google Sheet the IPCs manage. Columns: <em>Tiktok Handle, Name, Brand,
        Status, Paypal details, Discord, Notes</em> — the <strong>Brand</strong> cell must match a brand name in WurxOS.
        Connect it <strong>live</strong> (below) for instant sync and to write approval Status/Notes back into the sheet.
      </p>

      {/* Live connection status */}
      <div className="d-flex align-items-center gap-2 mb-3" style={{ fontSize: 13 }}>
        <span className="badge" style={{ background: live ? 'var(--success-soft)' : 'var(--warning-soft)', color: live ? 'var(--success)' : 'var(--warning)', fontWeight: 700 }}>
          <i className={`bi ${live ? 'bi-lightning-charge-fill' : 'bi-hourglass-split'} me-1`} />
          {live ? 'Live (instant sync + write-back)' : 'Not connected — using published CSV (delayed, read-only)'}
        </span>
      </div>

      {/* Apps Script web app */}
      <div className="wx-card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="fw-bold mb-2" style={{ fontSize: 14 }}><i className="bi bi-lightning-charge me-1" style={{ color: 'var(--accent)' }} />Live connection (Google Apps Script)</div>

        <label className="wx-label">Web App URL</label>
        <input className="wx-input" value={hookUrl} disabled={!loaded || saving}
          placeholder="https://script.google.com/macros/s/…/exec"
          onChange={(e) => setHookUrl(e.target.value)} />

        <label className="wx-label" style={{ marginTop: 10 }}>Shared secret</label>
        <div className="d-flex gap-2">
          <input className="wx-input" value={secret} disabled={!loaded || saving}
            placeholder="A long random string — must match the script"
            onChange={(e) => setSecret(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          <button className="wx-btn wx-btn-sm" onClick={() => setSecret(randomSecret())} disabled={saving} title="Generate a random secret">
            <i className="bi bi-shuffle" />
          </button>
          <button className="wx-btn wx-btn-sm" onClick={() => copy(secret, 'secret')} disabled={!secret} title="Copy secret">
            {copied === 'secret' ? 'Copied!' : <i className="bi bi-clipboard" />}
          </button>
        </div>

        <div className="d-flex gap-2 mt-3">
          <button className="wx-btn wx-btn-sm" onClick={() => setShowScript((s) => !s)}>
            <i className={`bi bi-chevron-${showScript ? 'up' : 'down'} me-1`} />{showScript ? 'Hide' : 'Show'} setup script
          </button>
          <button className="wx-btn wx-btn-sm" onClick={() => copy(script, 'script')} title="Copy the Apps Script">
            {copied === 'script' ? 'Copied!' : <><i className="bi bi-clipboard me-1" />Copy script</>}
          </button>
        </div>

        {showScript && (
          <>
            <ol className="text-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '10px 0 6px', paddingLeft: 18 }}>
              <li>Generate &amp; copy a secret above (and <strong>Save</strong> here so WurxOS has it).</li>
              <li>In the sheet: <strong>Extensions → Apps Script</strong>. Delete any code, paste the script below.</li>
              <li><strong>Deploy → New deployment → Web app</strong>. Execute as <strong>Me</strong>, Who has access <strong>Anyone</strong>. Authorize.</li>
              <li>Copy the <strong>/exec</strong> URL into “Web App URL” above and <strong>Save</strong>.</li>
            </ol>
            <pre style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 10, fontSize: 11, overflowX: 'auto', maxHeight: 260 }}>{script}</pre>
          </>
        )}
      </div>

      {/* Fallback CSV */}
      <label className="wx-label">Published CSV URL <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(fallback for reads if the live connection is off)</span></label>
      <input className="wx-input" value={csvUrl} disabled={!loaded || saving}
        placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv"
        onChange={(e) => setCsvUrl(e.target.value)} />

      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 10 }}><span>{err}</span></div>}
      {msg && <div style={{ marginTop: 10, color: 'var(--success)', fontSize: 13 }}><i className="bi bi-check2-circle me-1" />{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <button className="wx-btn wx-btn-primary wx-btn-sm" onClick={save} disabled={!loaded || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-save me-1" /> Save</>}
        </button>
      </div>
    </div>
  );
}
