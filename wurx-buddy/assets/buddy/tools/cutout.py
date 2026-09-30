"""Remove the white background from Buddy frames, keeping white INSIDE him (eyes, teeth).

For each RGB frame:
  1. background colour = median of the frame border;
  2. "ink" = pixels clearly different from the background (Chebyshev distance > T);
  3. Buddy = the ink component nearest the centre, with its holes filled
     (eye whites / teeth are enclosed or distinct from the background, so they stay);
  4. opaque core = Buddy eroded by 1 px; everywhere else (edge band, floating shadow,
     faint noise) uses colour-to-alpha against the background, so anti-aliased edges
     and the soft shadow become smooth semi-transparency instead of a white halo.
Writes RGBA PNGs.
"""
import sys, glob, os
import numpy as np
import cv2

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
T = 14          # ink threshold (0..255, per channel)
FLOOR = 0.035   # alpha below this -> 0 (kills background noise)

for path in sorted(glob.glob(os.path.join(src, '*.png'))):
    bgr = cv2.imread(path, cv2.IMREAD_COLOR).astype(np.float32)
    h, w, _ = bgr.shape
    border = np.concatenate([bgr[0], bgr[-1], bgr[:, 0], bgr[:, -1]])
    bg = np.median(border, axis=0)                                  # (3,)
    dist = np.max(np.abs(bgr - bg), axis=2)
    ink = (dist > T).astype(np.uint8)

    n, lab, stats, cent = cv2.connectedComponentsWithStats(ink, 8)
    if n <= 1:
        core = np.zeros((h, w), np.uint8)
    else:
        c = np.array([w / 2, h * 0.45])
        best = min(range(1, n), key=lambda i: (np.hypot(*(cent[i] - c)) - stats[i, cv2.CC_STAT_AREA] ** 0.5))
        body = (lab == best).astype(np.uint8)
        # fill holes: flood the outside from a corner; whatever isn't reached and isn't body is a hole
        flood = body.copy() * 255
        mask = np.zeros((h + 2, w + 2), np.uint8)
        cv2.floodFill(flood, mask, (0, 0), 128)
        holes = (flood == 0).astype(np.uint8)
        body = np.maximum(body, holes)
        core = cv2.erode(body, np.ones((3, 3), np.uint8), iterations=1)

    # colour-to-alpha against the background (everything is darker than the near-white bg)
    a = np.max(np.clip((bg - bgr) / np.maximum(bg, 1), 0, 1), axis=2)
    a[a < FLOOR] = 0
    alpha = np.where(core > 0, 1.0, a)
    safe = np.maximum(alpha, 1e-3)[..., None]
    col = np.where(core[..., None] > 0, bgr, (bgr - (1 - alpha[..., None]) * bg) / safe)
    col = np.clip(col, 0, 255)
    out = np.dstack([col, alpha * 255]).astype(np.uint8)
    cv2.imwrite(os.path.join(dst, os.path.basename(path)), out)
print('ok')
