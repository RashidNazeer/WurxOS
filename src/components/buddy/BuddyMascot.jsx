import { useEffect, useRef, useState } from 'react';

// The transparent Buddy mascot (public/buddy, from Assistant/assets/buddy/web).
// WebM with alpha everywhere but Safari, which renders VP9 alpha badly and
// gets the animated WebP instead. The calm PNG is the poster, so something
// shows while a clip loads. Decorative: the surrounding control has the label.
//
// idle / happy play once, then again every ~8 s (paused on the last frame in
// between, which is the relaxed smile), so Buddy never becomes a distraction.
// thinking / full loop.

export const BUDDY_STILL = '/mascot/buddy-calm-256.png';
const REPLAY_MS = 8000;
const SAFARI = typeof navigator !== 'undefined'
  && /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

export default function BuddyMascot({ clip = 'idle', size = 56, className = '' }) {
  const periodic = clip === 'idle' || clip === 'happy';
  const style = { width: size, height: size };
  const cls = `bd-mascot ${className}`;
  if (SAFARI) return <SafariMascot clip={clip} periodic={periodic} style={style} className={cls} />;
  return <VideoMascot key={clip} clip={clip} periodic={periodic} style={style} className={cls} />;
}

function VideoMascot({ clip, periodic, style, className }) {
  const ref = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onEnded = () => {
    if (!periodic) return;
    timer.current = setTimeout(() => {
      const v = ref.current;
      if (!v) return;
      v.currentTime = 0;
      v.play().catch(() => {});
    }, REPLAY_MS);
  };
  return (
    <video
      ref={ref}
      className={className}
      style={style}
      autoPlay
      muted
      playsInline
      loop={!periodic}
      poster={BUDDY_STILL}
      onEnded={onEnded}
      aria-hidden="true"
      tabIndex={-1}
      disablePictureInPicture
    >
      <source src={`/mascot/buddy-${clip}.webm`} type="video/webm" />
    </video>
  );
}

function SafariMascot({ clip, periodic, style, className }) {
  const [playing, setPlaying] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!periodic) return undefined;
    // An animated WebP can't report its end: show it for about one clip length.
    const off = setTimeout(() => setPlaying(false), 1200);
    const on = setTimeout(() => { setPlaying(true); setN((x) => x + 1); }, REPLAY_MS);
    return () => { clearTimeout(off); clearTimeout(on); };
  }, [periodic, n]);
  const src = !periodic || playing ? `/mascot/buddy-${clip}.webp` : BUDDY_STILL;
  return <img key={`${clip}-${n}`} src={src} alt="" aria-hidden="true" className={className} style={style} draggable="false" />;
}
