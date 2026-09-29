/**
 * The face rig: what makes a drawn agent feel present rather than printed.
 *
 * One shared controller for every `AgentFace` on the page, so a roster of
 * twenty faces costs one pointer listener, one IntersectionObserver and at
 * most one animation frame per pointer move:
 *
 *  - GAZE. A face looks at the pointer while it is near (reach grows with the
 *    face's size), with a strength that eases off with distance. Away from the
 *    pointer it glances around on its own every few seconds, the way someone
 *    at a desk does. Its state scales how much it cares: a waiting face seeks
 *    you out, a working one mostly keeps its eyes on the job.
 *  - BLINK. Every few seconds, at a per-face random interval, sometimes twice.
 *    Hovering the control a face belongs to makes it blink once: it noticed.
 *
 * The rig only writes CSS custom properties (`--gx`, `--gy`, `--blink`) on the
 * face's <svg>; every visual consequence, and every transition, is CSS in
 * agent-face.css. Nothing runs under `prefers-reduced-motion`, and gaze does
 * not follow a coarse pointer (there is no hover on touch).
 */

type RigState = string;

interface Entry {
  el: SVGSVGElement;
  state: RigState;
  size: number;
  visible: boolean;
  /** The glance target used while the pointer is away, in drawing units. */
  idleX: number;
  idleY: number;
  glanceTimer: number | null;
  blinkTimer: number | null;
  trigger: Element | null;
  onEnter: (() => void) | null;
}

/** How far the eyes travel at full strength, in the drawing's 64-unit space. */
const MAX_X = 3.4;
const MAX_Y = 2.6;
/** A pointer that has not moved for this long is no longer "someone here". */
const POINTER_STALE_MS = 5000;

/** How much each state lets the pointer pull the eyes. */
const GAZE_GAIN: Record<string, number> = {
  idle: 1,
  waiting: 1.15,
  listening: 0.9,
  done: 0.8,
  thinking: 0.25,
  working: 0.35,
  blocked: 0.5,
  sleeping: 0,
};

/** States whose eyes are closed or replaced, so there is nothing to blink. */
const NO_BLINK = new Set(["sleeping", "done", "blocked"]);

const entries = new Set<Entry>();
let pointer: { x: number; y: number; at: number } | null = null;
let frame = 0;
let observer: IntersectionObserver | null = null;
let listening = false;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function finePointer(): boolean {
  return typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function setGaze(entry: Entry, x: number, y: number) {
  entry.el.style.setProperty("--gx", x.toFixed(2));
  entry.el.style.setProperty("--gy", y.toFixed(2));
}

/** Reads every visible face's box, then writes every gaze: one layout read per frame. */
function update() {
  frame = 0;
  const now = performance.now();
  const fresh = pointer && now - pointer.at < POINTER_STALE_MS ? pointer : null;
  const live: { entry: Entry; rect: DOMRect }[] = [];
  for (const entry of entries) {
    if (entry.visible) live.push({ entry, rect: entry.el.getBoundingClientRect() });
  }
  for (const { entry, rect } of live) {
    const gain = GAZE_GAIN[entry.state] ?? 1;
    if (fresh && gain > 0) {
      const dx = fresh.x - (rect.left + rect.width / 2);
      const dy = fresh.y - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      const reach = Math.max(280, rect.width * 6);
      if (distance < reach) {
        // Ease-out falloff: close means full attention, the edge of reach a glance.
        const t = 1 - distance / reach;
        const strength = (1 - (1 - t) * (1 - t)) * gain;
        // Right on top of the face, it looks at you, not at a point beside it.
        const near = Math.min(1, distance / Math.max(24, rect.width * 0.6));
        const ux = distance ? dx / distance : 0;
        const uy = distance ? dy / distance : 0;
        setGaze(entry, ux * MAX_X * strength * near, uy * MAX_Y * strength * near);
        continue;
      }
    }
    setGaze(entry, entry.idleX * gain, entry.idleY * gain);
  }
}

function schedule() {
  if (!frame && typeof window !== "undefined") frame = window.requestAnimationFrame(update);
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  schedule();
}

function onPointerLeave() {
  pointer = null;
  schedule();
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  if (finePointer()) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
  }
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        for (const entry of entries) {
          if (entry.el === record.target) entry.visible = record.isIntersecting;
        }
      }
      schedule();
    });
  }
}

function stopListening() {
  if (!listening || entries.size > 0) return;
  listening = false;
  window.removeEventListener("pointermove", onPointerMove);
  document.documentElement.removeEventListener("pointerleave", onPointerLeave);
  observer?.disconnect();
  observer = null;
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
}

function blink(entry: Entry, twice = false) {
  if (NO_BLINK.has(entry.state) || !entry.visible) return;
  entry.el.style.setProperty("--blink", "0.08");
  window.setTimeout(() => {
    entry.el.style.setProperty("--blink", "1");
    if (twice) window.setTimeout(() => blink(entry), 150);
  }, 95);
}

function scheduleBlink(entry: Entry) {
  entry.blinkTimer = window.setTimeout(() => {
    blink(entry, Math.random() < 0.16);
    scheduleBlink(entry);
  }, rand(2600, 6400));
}

/** Picks the next place to look while nobody is near. Mostly ahead, sometimes aside. */
function scheduleGlance(entry: Entry) {
  entry.glanceTimer = window.setTimeout(() => {
    const ahead = Math.random() < 0.45;
    entry.idleX = ahead ? 0 : rand(-1, 1) * MAX_X * 0.7;
    entry.idleY = ahead ? 0 : rand(-0.6, 0.8) * MAX_Y * 0.6;
    schedule();
    scheduleGlance(entry);
  }, rand(1800, 5200));
}

export interface FaceRigHandle {
  setState(state: RigState): void;
  release(): void;
}

/**
 * Puts a face on the rig. Returns a handle to tell it the face's state, and to
 * take it off again. A no-op handle under reduced motion or on the server.
 */
export function attachFaceRig(el: SVGSVGElement, state: RigState, size: number): FaceRigHandle {
  if (typeof window === "undefined" || prefersReducedMotion()) {
    return { setState() {}, release() {} };
  }
  ensureListening();
  const entry: Entry = {
    el,
    state,
    size,
    visible: true,
    idleX: 0,
    idleY: 0,
    glanceTimer: null,
    blinkTimer: null,
    trigger: el.closest("[data-face-trigger], a, button, [role='button'], [role='link']"),
    onEnter: null,
  };
  entries.add(entry);
  observer?.observe(el);
  scheduleBlink(entry);
  scheduleGlance(entry);
  if (entry.trigger) {
    entry.onEnter = () => blink(entry);
    entry.trigger.addEventListener("pointerenter", entry.onEnter);
  }
  schedule();
  return {
    setState(next) {
      entry.state = next;
      schedule();
    },
    release() {
      entries.delete(entry);
      observer?.unobserve(el);
      if (entry.blinkTimer !== null) window.clearTimeout(entry.blinkTimer);
      if (entry.glanceTimer !== null) window.clearTimeout(entry.glanceTimer);
      if (entry.trigger && entry.onEnter) entry.trigger.removeEventListener("pointerenter", entry.onEnter);
      stopListening();
    },
  };
}
