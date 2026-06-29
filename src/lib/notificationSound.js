// ============================================================
// notificationSound — a tiny WebAudio chime for new in-app
// notifications. No asset file (zero bytes over the wire — matters
// for our low-bandwidth users), no service-worker coordination.
//
// Browser autoplay rule: audio can only start after a user gesture.
// So playNotificationChime() is a SILENT no-op until primeNotificationSound()
// has run once on a real gesture (login submit / first click). All calls
// are defensively wrapped — sound must NEVER throw into the notif flow.
// ============================================================

let ctx = null;
let unlocked = false;
let lastPlay = 0;

const MIN_GAP_MS = 1500; // collapse a burst of arrivals into one chime

function getCtx() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

// Call once on a genuine user gesture to satisfy the autoplay gate.
// Safe to call multiple times.
export function primeNotificationSound() {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  unlocked = true;
}

// Play a short two-note chime. No-op until primed; rate-limited.
export function playNotificationChime() {
  const c = getCtx();
  if (!c || !unlocked) return;
  const now = Date.now();
  if (now - lastPlay < MIN_GAP_MS) return;
  lastPlay = now;
  if (c.state === 'suspended') c.resume().catch(() => {});
  try {
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);          // A5
    osc.frequency.setValueAtTime(1175, t + 0.09);  // → D6 (gentle "ding-dong")
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);   // soft attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32); // decay
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.34);
  } catch { /* never let a sound glitch break notifications */ }
}
