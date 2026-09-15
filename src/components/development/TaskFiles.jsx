// Files on a task: pick, drop or paste them in. Stored privately; every link is
// a signed URL that expires after ten minutes.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDev, WORKSPACE_KEY } from '../../pages/development/DevelopmentContext';
import { deleteFile, fileUrl, listFiles, uploadFile } from '../../lib/developmentApi';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(file) {
  const mime = file.mime || '';
  const name = (file.name || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'bi-file-earmark-pdf';
  if (/zip|compressed/.test(mime) || /\.(zip|rar|7z)$/.test(name)) return 'bi-file-earmark-zip';
  if (mime.startsWith('video/')) return 'bi-file-earmark-play';
  if (mime.startsWith('text/') || /\.(csv|txt|md|json)$/.test(name)) return 'bi-file-earmark-text';
  if (/sheet|excel/.test(mime) || /\.(xlsx|xls)$/.test(name)) return 'bi-file-earmark-spreadsheet';
  return 'bi-file-earmark';
}

export function useTaskFiles(taskId) {
  return useQuery({
    queryKey: ['development', 'files', taskId],
    queryFn: () => listFiles(taskId),
    enabled: !!taskId,
    staleTime: 15_000,
  });
}

export function FileTile({ file, canRemove, onRemove, compact = false }) {
  const isImage = /^image\//.test(file.mime || '');
  const link = useQuery({
    queryKey: ['development', 'file-url', file.path],
    queryFn: () => fileUrl(file.path, { download: !isImage, name: file.name }),
    staleTime: 8 * 60_000,
  });

  return (
    <div className={`dv-file${isImage ? ' is-image' : ''}${compact ? ' is-compact' : ''}`}>
      <a
        className="dv-file-open"
        href={link.data || undefined}
        target="_blank"
        rel="noreferrer"
        aria-disabled={!link.data}
        title={`Open ${file.name}`}
      >
        {isImage && link.data ? (
          <img src={link.data} alt={file.name} loading="lazy" />
        ) : (
          <span className="dv-file-ph"><i className={`bi ${isImage ? 'bi-image' : iconFor(file)}`} aria-hidden="true" /></span>
        )}
        <span className="dv-file-meta">
          <span className="dv-file-name">{file.name}</span>
          <span className="dv-file-size">{formatBytes(file.size_bytes)}</span>
        </span>
      </a>
      {canRemove && (
        <button type="button" className="dv-file-remove" onClick={() => onRemove(file)} aria-label={`Remove ${file.name}`}>
          <i className="bi bi-x" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default function TaskFiles({ task, editable }) {
  const qc = useQueryClient();
  const { profile, isBoss, notify, confirm } = useDev();
  const files = useTaskFiles(task.id);
  const taskFiles = (files.data || []).filter((f) => !f.comment_id);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef(null);
  const section = useRef(null);

  const sync = () => {
    qc.invalidateQueries({ queryKey: ['development', 'files', task.id] });
    qc.invalidateQueries({ queryKey: WORKSPACE_KEY });
  };

  const uploadRef = useRef(null);
  uploadRef.current = async (list) => {
    const picked = [...list].filter(Boolean);
    if (!picked.length) return;
    setUploading((n) => n + picked.length);
    for (const file of picked) {
      try {
        await uploadFile({ taskId: task.id, file });
      } catch (error) {
        notify(`${file.name}: ${error.message}`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
    sync();
  };

  // Paste a screenshot anywhere in the open panel (not while typing a comment
  // or a description, which handle their own pastes).
  useEffect(() => {
    if (!editable) return undefined;
    const onPaste = (event) => {
      const layers = document.querySelectorAll('[data-dv-layer]');
      const top = layers[layers.length - 1];
      if (!top || !top.contains(section.current)) return;
      if (event.target?.closest?.('.dv-composer, .ProseMirror, input, textarea, [contenteditable="true"]')) return;
      const pasted = [...(event.clipboardData?.files || [])];
      if (!pasted.length) return;
      event.preventDefault();
      uploadRef.current(pasted);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [editable]);

  async function remove(file) {
    const yes = await confirm({ title: `Remove ${file.name}?`, confirmLabel: 'Remove file', danger: true });
    if (!yes) return;
    try {
      await deleteFile(file);
      sync();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  return (
    <section
      ref={section}
      className={`dv-section dv-files${dragOver ? ' is-drop' : ''}`}
      aria-label="Files"
      onDragOver={(event) => {
        if (!editable || !event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!editable || !event.dataTransfer?.files?.length) return;
        event.preventDefault();
        setDragOver(false);
        uploadRef.current(event.dataTransfer.files);
      }}
    >
      <div className="dv-section-head">
        <h3>Files</h3>
        {taskFiles.length > 0 && <span className="dv-count">{taskFiles.length}</span>}
        {editable && (
          <button type="button" className="dv-link" onClick={() => input.current?.click()}>
            <i className="bi bi-paperclip" aria-hidden="true" /> Add files
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = [...event.target.files];
            event.target.value = '';
            uploadRef.current(picked);
          }}
        />
      </div>
      {taskFiles.length > 0 && (
        <div className="dv-file-grid">
          {taskFiles.map((file) => (
            <FileTile
              key={file.id}
              file={file}
              canRemove={isBoss || file.uploaded_by === profile?.id}
              onRemove={remove}
            />
          ))}
        </div>
      )}
      {uploading > 0 && <p className="dv-muted"><span className="dv-spinner is-sm" /> Uploading {uploading} file{uploading === 1 ? '' : 's'}…</p>}
      {editable && !taskFiles.length && uploading === 0 && (
        <button type="button" className="dv-dropzone" onClick={() => input.current?.click()}>
          <i className="bi bi-cloud-arrow-up" aria-hidden="true" />
          Drop files here, paste a screenshot, or choose files · up to 25 MB each
        </button>
      )}
      {!editable && !taskFiles.length && <p className="dv-muted">No files.</p>}
    </section>
  );
}
