/**
 * One animation frame for everything in a call that follows the audio: the
 * chip's meter and the composer's edge light.
 *
 * Each used to run a loop of its own (the glow had its own clock beside the
 * hook's level loop). They share one here, which runs only while something
 * is subscribed and asks to keep going: a subscriber returns `false` once it
 * has settled (silence, thinking, a muted line), and the loop stops when
 * every one has, until a subscriber wakes it again. A hidden tab gets no
 * frames anyway.
 *
 * `dtMs` is the time since the last frame, capped, so easing is by elapsed
 * time and moves alike at 60 Hz and 120 Hz.
 */

type FrameFn = (now: number, dtMs: number) => boolean;

const subscribers = new Set<FrameFn>();
const awake = new Set<FrameFn>();
let raf = 0;
let last = 0;

function tick(now: number) {
  const dt = last ? Math.min(64, now - last) : 16;
  last = now;
  for (const fn of [...awake]) {
    if (!subscribers.has(fn)) {
      awake.delete(fn);
      continue;
    }
    if (fn(now, dt) === false) awake.delete(fn);
  }
  if (awake.size > 0) raf = requestAnimationFrame(tick);
  else {
    raf = 0;
    last = 0;
  }
}

function ensureRunning() {
  if (raf || awake.size === 0 || typeof requestAnimationFrame === "undefined") return;
  raf = requestAnimationFrame(tick);
}

/**
 * Subscribe to the call's frames. Returns `wake` (call it when the input
 * changes, so a settled subscriber runs again) and `stop`.
 */
export function onVoiceFrame(fn: FrameFn): { wake: () => void; stop: () => void } {
  subscribers.add(fn);
  awake.add(fn);
  ensureRunning();
  return {
    wake() {
      if (!subscribers.has(fn)) return;
      awake.add(fn);
      ensureRunning();
    },
    stop() {
      subscribers.delete(fn);
      awake.delete(fn);
      if (awake.size === 0 && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      }
    },
  };
}
