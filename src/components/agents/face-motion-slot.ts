"use client";

/**
 * A cap on how many agent faces loop at once.
 *
 * A run can hold ten or twenty agents, most of them busy. Twenty bobbing faces
 * are noise and cost frames, so a face whose state loops asks for a motion
 * slot: the first `SHELL.galaxyMaxAnimating` faces that want one AND are on
 * screen get it (earliest mounted first, which is top-down in a list), every
 * other face keeps its state's pose, still (`AgentFace still`). A face that
 * scrolls away or settles hands its slot to the next in line. Same rule, and
 * the same token, as the galaxy marks' cap (docs/design/GALAXY_SPEC.md).
 *
 * One shared IntersectionObserver for every face; nothing runs on the server.
 */
import * as React from "react";
import { SHELL } from "@/lib/design/tokens.generated";

export const FACE_MOTION_SLOTS = SHELL.galaxyMaxAnimating;

let nextToken = 1;
let version = 0;
/** Tokens that want motion and are on screen, in mount order. */
const wanting = new Set<number>();
let granted = new Set<number>();
const listeners = new Set<() => void>();
const visibleOf = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | null = null;

let slots: number = FACE_MOTION_SLOTS;

/** Dev galleries only: review more characters moving than the product's cap allows. */
export function setFaceMotionSlots(n: number) {
  slots = Math.max(0, Math.floor(n));
  recompute(true);
}

function recompute(force = false) {
  const next = new Set([...wanting].sort((a, b) => a - b).slice(0, slots));
  if (!force && next.size === granted.size && [...next].every((t) => granted.has(t))) return;
  granted = next;
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => version;
const serverSnapshot = () => 0;

function observe(el: Element, onVisible: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible(true);
    return () => {};
  }
  observer ??= new IntersectionObserver((records) => {
    for (const r of records) visibleOf.get(r.target)?.(r.isIntersecting);
  });
  visibleOf.set(el, onVisible);
  observer.observe(el);
  return () => {
    visibleOf.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * Whether this face may loop. `wants` is whether its state loops at all;
 * `ref` is the element whose visibility counts (the face's own box).
 */
export function useFaceMotionSlot(wants: boolean, ref: React.RefObject<Element | null>): boolean {
  const [token] = React.useState(() => nextToken++);
  const [visible, setVisible] = React.useState(false);
  React.useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !wants) return;
    return observe(el, setVisible);
  }, [ref, wants]);

  React.useEffect(() => {
    if (wants && visible) wanting.add(token);
    else wanting.delete(token);
    recompute();
    return () => {
      wanting.delete(token);
      recompute();
    };
  }, [token, wants, visible]);

  return wants && granted.has(token);
}
