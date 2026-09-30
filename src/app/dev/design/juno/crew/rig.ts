/**
 * The crew face rig: one shared controller for every live CrewFace on the
 * page. It only writes attributes and CSS custom properties; every visual
 * consequence and every transition lives in face.css.
 *
 * Event-driven, calm:
 *  - BLINK: rare (every 4.5 to 11 s, one in eight is a double), randomised
 *    per face, only while the eyes are open, the face is on screen, the tab
 *    is visible and someone has touched the page in the last 20 s.
 *  - ATTENTION: hovering the face or the row that holds it (an ancestor with
 *    `.jc-face-trigger`) makes it notice (one blink if it has not blinked
 *    lately) and look toward the pointer within a small range. Leaving
 *    returns it to its state's pose.
 *  - SACCADES: while thinking, the gaze makes a small shift every 1.8 to
 *    3.4 s, the way someone looks around while they think. Nothing else idles.
 *  - GESTURES on a change of state: waiting gets one attention hop, working
 *    one settle; paused falls asleep slowly (CSS); offline fades.
 *  - ARRIVAL: when a face mounts with `arrive`, it is lit for the first time.
 *
 * Costs: one pointermove listener (only while a trigger is hovered), one
 * IntersectionObserver, one 250 ms ticker for all faces. Nothing runs under
 * prefers-reduced-motion except the state cross-fade.
 */

import type { CrewState } from "./face";

interface Entry {
  el: SVGSVGElement;
  state: CrewState;
  size: number;
  visible: boolean;
  nextBlink: number;
  nextSaccade: number;
  lastBlink: number;
  trigger: Element;
  hovering: boolean;
  cleanup: (() => void)[];
}

const entries = new Set<Entry>();
let ticker: number | null = null;
let observer: IntersectionObserver | null = null;
let lastInput = typeof performance !== "undefined" ? performance.now() : 0;
let inputBound = false;
const IDLE_MS = 20000;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const now = () => performance.now();

function reducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
function finePointer() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
}

const EYES_OPEN = new Set<CrewState>(["available", "thinking", "working", "waiting"]);

function blink(e: Entry, double = false) {
  const el = e.el;
  el.setAttribute("data-blink", "");
  e.lastBlink = now();
  window.setTimeout(() => {
    el.removeAttribute("data-blink");
    if (double) window.setTimeout(() => blink(e), 170);
  }, 95);
}

function scheduleBlink(e: Entry, from = now()) {
  e.nextBlink = from + rand(4500, 11000);
}

function tick() {
  const t = now();
  const active = !document.hidden && t - lastInput < IDLE_MS;
  for (const e of entries) {
    if (!e.visible || !active) continue;
    if (EYES_OPEN.has(e.state) && t >= e.nextBlink) {
      blink(e, Math.random() < 0.125);
      scheduleBlink(e, t);
    }
    if (e.state === "thinking" && !e.hovering && t >= e.nextSaccade) {
      // Small shifts around the thinking pose: up and to either side.
      e.el.style.setProperty("--jc-look-x", rand(-0.28, 0.28).toFixed(3));
      e.el.style.setProperty("--jc-look-y", rand(-0.18, 0.1).toFixed(3));
      e.nextSaccade = t + rand(1800, 3400);
    }
  }
}

function ensureShared() {
  if (!inputBound) {
    inputBound = true;
    const mark = () => {
      lastInput = now();
    };
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const) {
      window.addEventListener(type, mark, { passive: true, capture: true });
    }
  }
  if (ticker == null) ticker = window.setInterval(tick, 250);
  if (!observer && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((records) => {
      for (const r of records) {
        for (const e of entries) if (e.el === r.target) e.visible = r.isIntersecting;
      }
    });
  }
}

function releaseShared() {
  if (entries.size > 0) return;
  if (ticker != null) window.clearInterval(ticker);
  ticker = null;
  observer?.disconnect();
  observer = null;
}

function gesture(el: SVGSVGElement, name: string, ms: number) {
  el.removeAttribute("data-gesture");
  // Restart the animation even when the same gesture repeats.
  void el.getBoundingClientRect();
  el.setAttribute("data-gesture", name);
  window.setTimeout(() => {
    if (el.getAttribute("data-gesture") === name) el.removeAttribute("data-gesture");
  }, ms);
}

function resetLook(el: SVGSVGElement) {
  el.style.setProperty("--jc-look-x", "0");
  el.style.setProperty("--jc-look-y", "0");
}

export function registerFace(
  el: SVGSVGElement,
  opts: { state: CrewState; size: number; arrive: boolean },
): () => void {
  const rm = reducedMotion();
  const trigger = el.closest(".jc-face-trigger") ?? el;
  const e: Entry = {
    el,
    state: opts.state,
    size: opts.size,
    visible: true,
    nextBlink: 0,
    nextSaccade: 0,
    lastBlink: 0,
    trigger,
    hovering: false,
    cleanup: [],
  };

  // A change of state arrives as an event from the component.
  const onState = (ev: Event) => {
    const next = (ev as CustomEvent<CrewState>).detail;
    if (next === e.state) return;
    const prev = e.state;
    e.state = next;
    if (rm) {
      gesture(el, "swap", 260);
      return;
    }
    if (!e.hovering) resetLook(el);
    if (next === "waiting") gesture(el, "attend", 760);
    else if (next === "working" && prev !== "working") gesture(el, "settle", 560);
    if (EYES_OPEN.has(next) && !EYES_OPEN.has(prev)) {
      // Waking: a blink shortly after the eyes open.
      window.setTimeout(() => blink(e), 700);
    }
    scheduleBlink(e);
  };
  el.addEventListener("jc-face-state", onState);
  e.cleanup.push(() => el.removeEventListener("jc-face-state", onState));

  if (rm) {
    return () => e.cleanup.forEach((f) => f());
  }

  ensureShared();
  entries.add(e);
  observer?.observe(el);
  scheduleBlink(e, now() - rand(0, 3000));
  e.nextSaccade = now() + rand(600, 1600);

  // Arrival: start in the dark with the eyes shut, then light up.
  if (opts.arrive) {
    el.setAttribute("data-arrival", "start");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.setAttribute("data-arrival", "run");
        window.setTimeout(() => {
          el.removeAttribute("data-arrival");
          blink(e);
        }, 1500);
      }),
    );
  }

  // Pointer attention.
  if (finePointer()) {
    let frame = 0;
    let px = 0;
    let py = 0;
    const apply = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const reach = Math.max(160, r.width * 4);
      const dx = Math.max(-1, Math.min(1, (px - cx) / reach));
      const dy = Math.max(-1, Math.min(1, (py - cy) / reach));
      // Reach is small on purpose: a glance, not a stare. Sleeping faces do not look.
      const gain = e.state === "paused" || e.state === "offline" ? 0 : e.state === "working" ? 0.55 : 1;
      el.style.setProperty("--jc-look-x", (dx * 0.42 * gain).toFixed(3));
      el.style.setProperty("--jc-look-y", (dy * 0.34 * gain).toFixed(3));
    };
    const onMove = (ev: PointerEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onEnter = (ev: PointerEvent) => {
      e.hovering = true;
      onMove(ev);
      if (EYES_OPEN.has(e.state) && now() - e.lastBlink > 1600) blink(e);
      trigger.addEventListener("pointermove", onMove as EventListener, { passive: true });
    };
    const onLeave = () => {
      e.hovering = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      trigger.removeEventListener("pointermove", onMove as EventListener);
      resetLook(el);
    };
    trigger.addEventListener("pointerenter", onEnter as EventListener);
    trigger.addEventListener("pointerleave", onLeave);
    e.cleanup.push(() => {
      trigger.removeEventListener("pointerenter", onEnter as EventListener);
      trigger.removeEventListener("pointerleave", onLeave);
      trigger.removeEventListener("pointermove", onMove as EventListener);
      if (frame) cancelAnimationFrame(frame);
    });
  }

  return () => {
    e.cleanup.forEach((f) => f());
    observer?.unobserve(el);
    entries.delete(e);
    releaseShared();
  };
}
