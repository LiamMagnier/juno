"use client";

import * as React from "react";

import type { VoiceCallParts } from "@/components/voice/realtime-voice";
import { useStreamLevel } from "@/components/voice/voice-glow-audio";
import type { GlowMode } from "@/components/voice/voice-glow-engine";
import { VoiceGlowStageContext, type VoiceGlowProps } from "@/components/voice/voice-glow-stage";
import { VoiceGlowSurface } from "@/components/voice/voice-glow-surface";
import { onVoiceFrame } from "@/components/voice/voice-level-loop";
import { easeLevel } from "@/lib/voice-call-state";
import { readVoiceLevel } from "@/lib/voice-level";
import { useReducedMotion } from "@/lib/motion-preference";

/**
 * THE VOICE LIGHT FOR DICTATION: the WebGL light the dictation row draws,
 * drawn by Alevr's own renderer rather than a recoloured stock effect. A call
 * no longer draws it: its edge light is `VoiceComposerGlow` below.
 *
 * The composer's edge is the object you speak into, so the light lives ON
 * that edge and OUTSIDE it, never as a haze over the field: the 1px V3 edge
 * takes the speaker's tone where it is lit, a soft falloff blooms outward
 * from it, and the text and controls stay exactly as crisp as at rest.
 *
 * - STATE IS THE LIGHT, with no meter. Ember while you speak, presence ink
 *   while Alevr speaks, the Continuum handoff (a beam from your end to
 *   Alevr's, ember to presence) while it thinks, still graphite when muted.
 *   The light is never the only telling: the call also names each state in
 *   one word beside `+` (VoiceCallStatus), and its live region says it aloud.
 * - EACH VOICE IS ITS OWN AUDIO. In a call, your microphone and Alevr's
 *   output as heard (`levels`, from the realtime hook's split envelopes), so
 *   talking over Alevr shows both. Otherwise one live `stream` (dictation's
 *   microphone) or a per-frame `level` getter, given to whoever `tone` names.
 * - SILENCE IS STILL. A faint, unmoving light marks whose floor it is; it
 *   never breathes, and a still frame is never redrawn.
 * - `processing` is the thinking gap; `paused` (connecting, reconnecting,
 *   ended, a closing dictation) takes the light away on the exit rung.
 *
 * Reduced motion: static tone states, 120 ms fades. Reduced transparency: a
 * solid, crisp edge and no falloff. Decorative throughout (`aria-hidden`).
 */
export function JunoVoiceGlow(props: VoiceGlowProps) {
  const stage = React.useContext(VoiceGlowStageContext);
  if (stage?.render) return <>{stage.render(props)}</>;
  return <AlevrVoiceGlow {...props} />;
}

/** The props' state → the light's model: who holds the floor. */
export function glowModeFor({ paused, processing, tone }: Pick<VoiceGlowProps, "paused" | "processing" | "tone">): GlowMode {
  if (paused) return "off";
  if (processing || tone === "thinking") return "thinking";
  if (tone === "muted") return "muted";
  if (tone === "juno") return "alevr";
  return "you";
}

/** `sensitivity` was tuned as voice-glow's input gain, whose default is 3.1. */
const SENSITIVITY_BASE = 3.1;

function AlevrVoiceGlow({
  stream,
  level,
  levels,
  sensitivity,
  processing = false,
  paused = false,
  tone = "you",
  className,
  children,
}: VoiceGlowProps) {
  const streamLevel = useStreamLevel(levels ? null : stream, (sensitivity ?? SENSITIVITY_BASE) / SENSITIVITY_BASE);
  const single = streamLevel ?? level ?? null;
  const you = levels ? (levels.you ?? null) : tone === "you" ? single : null;
  const alevr = levels ? (levels.alevr ?? null) : tone === "juno" ? single : null;
  const sources = React.useMemo(() => ({ you, alevr }), [you, alevr]);
  return (
    <VoiceGlowSurface mode={glowModeFor({ paused, processing, tone })} levels={sources} className={className}>
      {children}
    </VoiceGlowSurface>
  );
}

/** Whose light the edge carries, from a call's parts (older parts without `edge` read their tone). */
function edgeOf(call: VoiceCallParts | undefined): "you" | "alevr" | null {
  if (!call) return null;
  if (call.edge !== undefined) return call.edge;
  if (call.paused) return null;
  return call.tone === "you" ? "you" : call.tone === "juno" ? "alevr" : null;
}

/** The ring's floor while its voice is quiet: visibly on, visibly still. */
const RING_REST = 0.32;

/**
 * THE CALL'S EDGE LIGHT, and the one element the composer sits in.
 *
 * ALWAYS THE SAME ELEMENT. Outside a call this used to render its child bare
 * and, in a call, wrap it in the glow: React saw a different tree, unmounted
 * the whole composer and mounted a new one, so opening or ending a call threw
 * focus to <body>, lost an IME composition and flashed the field (voice audit
 * D5). The wrapper is now there whether or not a call is, and only the light's
 * layers come and go beside the composer.
 *
 * THE LIGHT. The WebGL glow (a signed-distance shader over a canvas reaching
 * 44px past the composer, drawn every frame anyone spoke) is gone from the
 * call. In its place, four absolutely placed layers over the composer's own
 * edge: a 1px ring and a soft bloom for each voice, graphite for yours and
 * the one accent (`--primary`) for Alevr's. The only thing that changes per frame is their
 * OPACITY, set from each voice's eased level (lib/voice-level.ts), so the
 * light is compositor work and nothing else. It is on only while audio moves
 * (C16): off while connecting, thinking, muted and after the call.
 *
 * Reduced motion: no per-frame change at all, a still 1px ring in the
 * speaker's tone while audio moves, cross-faded on the fast rung. Reduced
 * transparency: the ring without the bloom. Decorative (`aria-hidden`): the
 * chip says every state in words.
 */
export function VoiceComposerGlow({ call, children }: { call?: VoiceCallParts; children: React.ReactNode }) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const layers = React.useRef<Record<EdgeLayer, HTMLSpanElement | null>>({ youRing: null, youBloom: null, alevrRing: null, alevrBloom: null });
  const edge = edgeOf(call);
  const edgeRef = React.useRef(edge);
  edgeRef.current = edge;
  const reduced = useReducedMotion();
  const inCall = !!call;
  const [radius, setRadius] = React.useState<string | undefined>(undefined);

  // The light follows the composer's own corner, whichever composer it is
  // (chat's, Code's, the call bar's pill).
  React.useLayoutEffect(() => {
    if (!inCall) return;
    const child = frameRef.current?.firstElementChild;
    if (child) setRadius(getComputedStyle(child).borderTopLeftRadius || undefined);
  }, [inCall]);

  const loop = React.useRef<{ wake: () => void; stop: () => void } | null>(null);
  React.useEffect(() => {
    if (!inCall) return;
    const set = layers.current;
    const transparencyReduced = matchMedia("(prefers-reduced-transparency: reduce)").matches;
    if (reduced) {
      // Still: the ring alone, in the speaker's tone, while audio moves.
      const paint = () => {
        const now = edgeRef.current;
        for (const [key, el] of Object.entries(set) as [EdgeLayer, HTMLSpanElement | null][]) {
          if (!el) continue;
          el.style.transition = "opacity var(--dur-fast) var(--ease-out-soft)";
          el.style.opacity = key === "youRing" && now === "you" ? "0.7" : key === "alevrRing" && now === "alevr" ? "0.85" : "0";
        }
      };
      paint();
      loop.current = { wake: paint, stop: () => undefined };
      return () => {
        loop.current = null;
      };
    }
    for (const el of Object.values(set)) if (el) el.style.transition = "none";
    // Each voice: whether its light is on (eased, so a change of speaker
    // cross-fades) and its level (eased, quick up and slow down).
    const state = { youOn: 0, alevrOn: 0, you: 0, alevr: 0 };
    const written = { youRing: -1, youBloom: -1, alevrRing: -1, alevrBloom: -1 };
    const write = (key: EdgeLayer, value: number) => {
      const rounded = Math.round(value * 100) / 100;
      if (written[key] === rounded) return;
      written[key] = rounded;
      const el = set[key];
      if (el) el.style.opacity = String(rounded);
    };
    const handle = onVoiceFrame((_now, dt) => {
      const now = edgeRef.current;
      state.youOn = easeLevel(state.youOn, now === "you" ? 1 : 0, dt, 70, 110);
      state.alevrOn = easeLevel(state.alevrOn, now === "alevr" ? 1 : 0, dt, 70, 110);
      state.you = easeLevel(state.you, now === "you" ? readVoiceLevel("user") : 0, dt, 70, 240);
      state.alevr = easeLevel(state.alevr, now === "alevr" ? readVoiceLevel("assistant") : 0, dt, 70, 240);
      write("youRing", state.youOn * (RING_REST + (1 - RING_REST) * Math.min(1, state.you * 1.5)));
      write("alevrRing", state.alevrOn * (RING_REST + (1 - RING_REST) * Math.min(1, state.alevr * 1.5)));
      write("youBloom", transparencyReduced ? 0 : state.youOn * Math.min(1, state.you * 1.3));
      write("alevrBloom", transparencyReduced ? 0 : state.alevrOn * Math.min(1, state.alevr * 1.3));
      // Settled in the dark: sleep until the edge changes again.
      return now !== null || state.youOn + state.alevrOn > 0.004;
    });
    loop.current = handle;
    return () => {
      handle.stop();
      loop.current = null;
    };
  }, [inCall, reduced]);

  React.useEffect(() => {
    loop.current?.wake();
  }, [edge]);

  const ref = (key: EdgeLayer) => (el: HTMLSpanElement | null) => {
    layers.current[key] = el;
  };

  return (
    <div ref={frameRef} className="voice-call-frame relative w-full" data-voice-edge={inCall ? (edge ?? "off") : undefined}>
      {children}
      {inCall && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3]" style={{ borderRadius: radius }}>
          {/* Yours: graphite. The edge darkens toward ink and a soft halo follows your voice. */}
          <span ref={ref("youBloom")} className="absolute inset-0 rounded-inherit opacity-0 shadow-[0_0_14px_0_hsl(var(--foreground)/0.08),0_0_3px_0_hsl(var(--foreground)/0.06)]" />
          <span ref={ref("youRing")} className="absolute inset-0 rounded-inherit border border-foreground/25 opacity-0" />
          {/* Alevr's: the one accent, with a softer, wider bloom. */}
          <span ref={ref("alevrBloom")} className="absolute inset-0 rounded-inherit opacity-0 shadow-[0_0_22px_1px_hsl(var(--primary)/0.24),0_0_4px_0_hsl(var(--primary)/0.18)]" />
          <span ref={ref("alevrRing")} className="absolute inset-0 rounded-inherit border border-primary opacity-0" />
        </span>
      )}
    </div>
  );
}

type EdgeLayer = "youRing" | "youBloom" | "alevrRing" | "alevrBloom";
