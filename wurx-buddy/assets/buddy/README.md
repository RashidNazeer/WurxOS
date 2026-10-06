# Wurx Buddy mascot assets

## Source
`wurxbuddy-source.mp4`: the Owner's final animation (2026-09-30). AI-generated
(Dreamina AI), 1280×720, 60 fps, 5.09 s, white background, "Dreamina AI"
watermark bottom-right (removed by the square crop below). It starts and ends on
the same relaxed smile, so it loops seamlessly.
(The earlier `buddy-animation-v1.mp4` was deleted at the Owner's request; it
survives only in git history.)

## Web-ready files (`web/`), transparent background, no audio
| File | What | Use in the UI |
|---|---|---|
| `buddy-idle.webm` / `.webp` | 0.0–0.9 s: smile + slow blink | **Idle**: floating button, header |
| `buddy-thinking.webm` / `.webp` | 1.0–3.1 s: looks around, then "hmm"; ping-pong loop | **Thinking**: while an answer is generating |
| `buddy-happy.webm` / `.webp` | 3.3–4.4 s: squint smile → laugh + wink | **Happy / answer ready**: the unread-reply cue |
| `buddy-full.webm` / `.webp` | the whole 5 s loop | Greeting / empty state in the full chat |
| `buddy-calm-{128,256,512}.png` | still, relaxed smile (0.5 s) | **Calm** (serious topics) and **reduced motion** |

- **WebM** (VP9 with alpha, 256 px, 20 fps) is the primary format: Chrome, Edge, Firefox.
- **Animated WebP** (192 px, 20 fps) is the fallback for Safari.
- Always pair with the PNG still for `prefers-reduced-motion`.

## How these were made (`tools/`)
1. `ffmpeg -i wurxbuddy-source.mp4 -vf "crop=720:720:280:0,fps=30" rgb/f%04d.png` (square crop removes the watermark)
2. `python tools/cutout.py rgb rgba`
   - removes only the white that is **connected to the frame edge** (so eye whites and teeth stay);
   - colour-to-alpha on the edges and the floating shadow (no white halo; the shadow becomes soft semi-transparency).
   - Needs `numpy` + `opencv-python-headless`.
3. `powershell -File tools/encode.ps1` → the `web/` files. Paths inside point at the scratchpad; adjust before reuse.
