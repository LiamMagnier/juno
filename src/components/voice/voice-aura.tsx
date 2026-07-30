"use client";

import * as React from "react";
import { createPortal } from "react-dom";

export type VoiceAuraStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

/** The quiet light each state keeps when nothing is being said. */
const FLOOR: Record<VoiceAuraStatus, number> = {
  idle: 0,
  listening: 0.06,
  thinking: 0.2,
  speaking: 0.12,
  error: 0,
};

/**
 * The room, lit.
 *
 * Voice used to announce itself with a 36px orb inside a pill — a thing to
 * look AT while you talk, which is exactly backwards: in a voice conversation
 * your attention belongs to the words, not to a widget reporting on them. So
 * the signal moves off the control and onto the window itself. A band of light
 * pools along the bottom edge and sends two arms up the left and right sides,
 * fading out by mid-height so the page is framed rather than boxed in, and the
 * whole field breathes with whoever is talking.
 *
 * Mounted through a portal on `document.body`, deliberately. The dock renders
 * deep inside the chat column, under several ancestors that clip, isolate or
 * establish containing blocks; a `position: fixed` child of that subtree is at
 * the mercy of every one of them. The portal is the only way this reliably
 * measures the viewport instead of whatever box it happened to be born in.
 *
 * Amplitude arrives by ref and is written straight to a custom property inside
 * a rAF loop — no state, no re-render, so a live transcript scrolling behind
 * the light costs the light nothing.
 */
export function VoiceAura({
  status,
  levelRef,
}: {
  status: VoiceAuraStatus;
  levelRef?: React.MutableRefObject<number>;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef(status);
  const liveLevelRef = React.useRef(levelRef);
  statusRef.current = status;
  liveLevelRef.current = levelRef;

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Keyed on `mounted`, not `[]`. The first render returns null (there is no
  // `document` to portal into during SSR), so on an empty dependency list this
  // effect would run once against a ref that is still null, bail out, and never
  // run again — a perfectly styled aura that never moves.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    let smooth = FLOOR[statusRef.current];

    const render = () => {
      // The chat page already runs the hook's own smoothing loop and DotField's
      // canvas loop; a third one has no business burning a frame for a tab
      // nobody is looking at. DotField makes the same check.
      if (document.hidden) {
        frame = requestAnimationFrame(render);
        return;
      }
      const audio = Math.max(0, Math.min(1, liveLevelRef.current?.current ?? 0));
      const target = Math.max(FLOOR[statusRef.current], audio);
      // Asymmetric easing: light climbs quickly on a syllable and falls away
      // slowly. Matching the two makes the aura flicker on every consonant;
      // a slow release is what reads as a room responding rather than a meter.
      smooth += (target - smooth) * (target > smooth ? 0.28 : 0.075);
      root.style.setProperty("--voice-level", smooth.toFixed(4));
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div ref={rootRef} aria-hidden="true" data-status={status} className="voice-aura">
      <div className="voice-aura__edge voice-aura__edge--bottom">
        <i className="voice-aura__layer voice-aura__layer--a" />
        <i className="voice-aura__layer voice-aura__layer--b" />
      </div>
      <div className="voice-aura__edge voice-aura__edge--left">
        <i className="voice-aura__layer voice-aura__layer--a" />
        <i className="voice-aura__layer voice-aura__layer--b" />
      </div>
      <div className="voice-aura__edge voice-aura__edge--right">
        <i className="voice-aura__layer voice-aura__layer--a" />
        <i className="voice-aura__layer voice-aura__layer--b" />
      </div>
      <div className="voice-aura__grain" />
    </div>,
    document.body,
  );
}
