import { useEffect, useMemo, useRef, useState } from 'react';
import { XIcon, RefreshIcon } from '../common/Icon';

// AvatarEditorModal — pick a file, drag to position, zoom to fit,
// preview as a circle, save as a 512×512 PNG.
//
// Design:
//   - Square frame (FRAME px on screen) holds the loaded image.
//   - Image is rendered with CSS transform: translate(x, y) scale(s),
//     so drag/zoom is GPU-cheap and the preview is always pixel-true.
//   - A circle mask sits over the frame so the user sees exactly
//     what'll be the avatar after save.
//   - On save, we draw to an off-screen 512×512 canvas using the
//     same offset + scale math, then upload the PNG blob via the
//     caller's onSave({ blob, dataUrl }).
//
// No external dependencies — keeps the bundle lean and matches the
// rest of the project's style.

const FRAME    = 320;   // on-screen frame size
const OUTPUT   = 512;   // saved avatar pixel size
const MIN_SCALE = 1;
const MAX_SCALE = 4;

export default function AvatarEditorModal({ file, onCancel, onSave, saving = false }) {
  const [imgUrl, setImgUrl]     = useState(null);
  const [natural, setNatural]   = useState({ w: 0, h: 0 });
  const [scale, setScale]       = useState(1);
  const [offset, setOffset]     = useState({ x: 0, y: 0 });
  const dragRef                  = useRef(null);
  const frameRef                 = useRef(null);

  // Load the file → object URL → image dimensions.
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      setNatural({ w: im.naturalWidth, h: im.naturalHeight });
      // Pre-fit so the smallest dimension covers the frame exactly.
      const fit = Math.max(FRAME / im.naturalWidth, FRAME / im.naturalHeight);
      setScale(fit);
      setOffset({ x: 0, y: 0 });
      setImgUrl(url);
    };
    im.onerror = () => setImgUrl(null);
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Image rendered size at the current scale.
  const renderSize = useMemo(() => ({
    w: natural.w * scale,
    h: natural.h * scale,
  }), [natural, scale]);

  // Clamp offset so the image never reveals empty space inside the frame.
  function clampOffset(next, s = scale) {
    const w = natural.w * s;
    const h = natural.h * s;
    const maxX = (w - FRAME) / 2;
    const maxY = (h - FRAME) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }

  // Re-clamp when scale changes — zooming out may put us out of bounds.
  useEffect(() => {
    setOffset((o) => clampOffset(o, scale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // Drag handlers (mouse + touch).
  function onPointerDown(e) {
    e.preventDefault();
    const pt = pointerFrom(e);
    dragRef.current = { startX: pt.x, startY: pt.y, startOffset: offset };
  }
  function onPointerMove(e) {
    if (!dragRef.current) return;
    const pt = pointerFrom(e);
    const dx = pt.x - dragRef.current.startX;
    const dy = pt.y - dragRef.current.startY;
    setOffset(clampOffset({
      x: dragRef.current.startOffset.x + dx,
      y: dragRef.current.startOffset.y + dy,
    }));
  }
  function onPointerUp() { dragRef.current = null; }

  // Wheel zoom — anchored on cursor position so it feels natural.
  function onWheel(e) {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(MIN_SCALE * fitScale(), Math.min(MAX_SCALE, scale * (dir > 0 ? 1.08 : 1 / 1.08)));
    setScale(next);
  }

  // The smallest scale that still covers the frame.
  function fitScale() {
    if (!natural.w || !natural.h) return 1;
    return Math.max(FRAME / natural.w, FRAME / natural.h);
  }

  const minSliderScale = fitScale();
  const sliderValue = scale;
  const sliderPct = ((sliderValue - minSliderScale) / Math.max(0.001, MAX_SCALE - minSliderScale)) * 100;

  async function handleSave() {
    if (!imgUrl || !natural.w) return;
    // Draw the visible-frame portion onto a 512×512 canvas.
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background fill — keeps PNG transparency from going black when
    // the avatar is shown on light/dark themes.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT, OUTPUT);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject; img.src = imgUrl;
    });

    // Map screen-space coords (frame is FRAME×FRAME centered, image
    // is at (offset.x, offset.y) with transform scale `scale`) to
    // output 512×512 coords. The image's CENTER lands at offset+frame-center.
    const ratio = OUTPUT / FRAME;
    const drawW = natural.w * scale * ratio;
    const drawH = natural.h * scale * ratio;
    const drawX = (OUTPUT - drawW) / 2 + offset.x * ratio;
    const drawY = (OUTPUT - drawH) / 2 + offset.y * ratio;
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const dataUrl = canvas.toDataURL('image/png');
      onSave({ blob, dataUrl });
    }, 'image/png', 0.92);
  }

  function reset() {
    setScale(fitScale());
    setOffset({ x: 0, y: 0 });
  }

  return (
    <div className="wx-modal-backdrop" onClick={onCancel}>
      <div
        className="wx-modal"
        style={{ maxWidth: 420, padding: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wx-modal-header" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="wx-modal-title">Adjust your photo</div>
          <button type="button" className="shell-icon-btn" onClick={onCancel} aria-label="Close" disabled={saving}>
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div
            ref={frameRef}
            onWheel={onWheel}
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onMouseLeave={onPointerUp}
            onTouchStart={onPointerDown}
            onTouchMove={onPointerMove}
            onTouchEnd={onPointerUp}
            style={{
              position: 'relative',
              width: FRAME, height: FRAME,
              margin: '0 auto 14px',
              borderRadius: 12,
              overflow: 'hidden',
              background: '#0f172a',
              cursor: imgUrl ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
              userSelect: 'none',
              touchAction: 'none',
            }}
          >
            {imgUrl && (
              <img
                src={imgUrl}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: renderSize.w,
                  height: renderSize.h,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  pointerEvents: 'none',
                }}
              />
            )}
            {/* Circle mask overlay — shows what'll be the avatar. */}
            <div
              aria-hidden
              style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                boxShadow: `0 0 0 9999px rgba(0, 0, 0, 0.55)`,
                clipPath: `circle(${FRAME / 2}px at center)`,
                WebkitClipPath: `circle(${FRAME / 2}px at center)`,
              }}
            />
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: '50%', top: '50%',
                width: FRAME, height: FRAME,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                border: '2px dashed rgba(255, 255, 255, 0.85)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <button
              type="button"
              className="wx-btn wx-btn-ghost"
              onClick={() => setScale((s) => Math.max(minSliderScale, s / 1.15))}
              disabled={!imgUrl || saving}
              style={{ padding: '6px 10px', fontSize: 16, lineHeight: 1, minWidth: 32 }}
              title="Zoom out"
            >−</button>
            <input
              type="range"
              min={minSliderScale}
              max={MAX_SCALE}
              step={0.01}
              value={scale}
              onChange={(e) => setScale(parseFloat(e.target.value))}
              disabled={!imgUrl || saving}
              style={{ flex: 1, accentColor: 'var(--accent)' }}
              aria-label="Zoom"
            />
            <button
              type="button"
              className="wx-btn wx-btn-ghost"
              onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.15))}
              disabled={!imgUrl || saving}
              style={{ padding: '6px 10px', fontSize: 16, lineHeight: 1, minWidth: 32 }}
              title="Zoom in"
            >+</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 16 }}>
            <span>Drag to position · Scroll or use the slider to zoom</span>
            <button
              type="button"
              onClick={reset}
              disabled={!imgUrl || saving}
              style={{
                background: 'transparent', border: 0, color: 'var(--text-secondary)',
                fontSize: 11.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
              title="Reset position and zoom"
            >
              <RefreshIcon width="11" height="11" /> Reset
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="wx-btn wx-btn-ghost"
              onClick={onCancel}
              disabled={saving}
            >Cancel</button>
            <button
              type="button"
              className="wx-btn wx-btn-primary"
              onClick={handleSave}
              disabled={!imgUrl || saving}
            >
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save photo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function pointerFrom(e) {
  if (e.touches && e.touches.length) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}
