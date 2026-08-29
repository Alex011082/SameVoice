/**
 * Getting a backgrounded tab noticed when the phone rings.
 *
 * A tester who tabbed away is the normal case, not the edge case, so the ring
 * uses three independent channels and treats every one of them as optional:
 *  - the document title (always works, survives throttling, visible in the tab
 *    strip and the macOS window list);
 *  - a short repeating tone (blocked until the page has had a user gesture —
 *    which by the contacts screen it has, but never assume it);
 *  - vibration on Android (absent everywhere else).
 *
 * Nothing here may throw: failing to be noticed must not break answering.
 */

const TITLE_BASE = document.title;
const TONE_INTERVAL_MS = 2400;

let titleTimer: number | null = null;
let toneTimer: number | null = null;
let audioCtx: AudioContext | null = null;

function ctor(): typeof AudioContext | null {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function beep(): void {
  try {
    const Ctor = ctor();
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => undefined);
    const now = audioCtx.currentTime;
    // Two short chirps: recognisably a ring, short enough not to fight speech
    // if the user is already talking to someone else.
    for (const offset of [0, 0.28]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.22);
    }
  } catch {
    // Autoplay policy, no AudioContext, a locked audio device — all fine.
  }
}

function vibrate(): void {
  try {
    navigator.vibrate?.([220, 180, 220]);
  } catch {
    // Not supported. Nothing to do.
  }
}

export function startRingingAttention(callerName: string): void {
  stopRingingAttention();

  let on = true;
  document.title = `☎ ${callerName} is calling`;
  titleTimer = window.setInterval(() => {
    on = !on;
    document.title = on ? `☎ ${callerName} is calling` : TITLE_BASE;
  }, 1200);

  beep();
  vibrate();
  toneTimer = window.setInterval(() => {
    beep();
    vibrate();
  }, TONE_INTERVAL_MS);
}

export function stopRingingAttention(): void {
  if (titleTimer !== null) {
    window.clearInterval(titleTimer);
    titleTimer = null;
  }
  if (toneTimer !== null) {
    window.clearInterval(toneTimer);
    toneTimer = null;
  }
  document.title = TITLE_BASE;
}
