"use client";

/**
 * The timeline: animations, their tracks, and the keyframes on them.
 *
 * It docks under the canvas rather than joining Layers and History in the left
 * rail, and that is not a stylistic preference. A timeline is a *time axis* —
 * tracks are rows and milliseconds are the horizontal dimension — and the left
 * rail starts at 208 points and is not meant to hold a time axis at any width a
 * rail is worth. A keyframe grid squeezed in there would be a picture of a
 * timeline rather than one you can place a keyframe on, so the dock takes the
 * canvas's full width and the rails keep their full height. Its own height is
 * the editor's to set — see `panel-layout.tsx`.
 *
 * Every edit here is an ordinary operation on an ordinary transaction:
 * `setKeyframes` for anything inside a track, and `createAnimation` under the
 * animation's own id for the things the model has no narrower operation for —
 * the name, the duration, the loop flag, and removing a track. `createAnimation`
 * over an existing id inverts to the animation as it was, so undo restores the
 * whole thing; there is no "just this once" write path out of here.
 *
 * The playhead is the one thing that is *not* a transaction. Scrubbing derives a
 * preview document (see `motion-model.ts`) and hands it to the canvas for that
 * frame only. It is never applied, never persisted and never sent over the
 * bridge — which is why the canvas goes read-only while a preview is on screen,
 * and why the inspector keeps reading the committed document underneath. An
 * inspector pointed at an interpolated value would let someone commit a number
 * the playhead invented.
 */

import * as React from "react";
import { Pause, Play, Plus, Repeat, SkipBack, X } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import {
  ANIMATABLE_PROPERTIES,
  animationSpanMs,
  propertyApplies,
  propertyInfo,
  readNodeProperty,
  sampleTrack,
  sortedKeyframes,
} from "@/components/design/motion-model";
import { ColorField, PanelSelect, fieldClass } from "@/components/design/effects-panel";
import { hexToRgba, rgbaToHex } from "@/lib/design/variables";
import type {
  AnimatableProperty,
  AnimationId,
  DesignDocument,
  EasingCurve,
  Keyframe,
  MotionAnimation,
  MotionTrack,
  NodeId,
} from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

/** Where the playhead is, for the canvas to draw. Null means "show the real
 *  document" — the panel being open is not on its own a reason to preview. */
export interface MotionPreview {
  animationId: AnimationId;
  timeMs: number;
}

/** One lane row's height, shared by the track list and the keyframe lanes so the
 *  two columns line up without either measuring the other. */
const ROW_HEIGHT = 28;

/**
 * Points of lane kept clear at each end of the time axis.
 *
 * A keyframe is drawn centred on its time, so the one at 0 ms hung half outside
 * its lane and the one at the end hung half under the inspector — the two
 * keyframes every animation has, and the two hardest to grab. Time is mapped
 * into the lane inset by this much at both ends instead, which is why positions
 * are `calc()` rather than a plain percentage.
 */
const EDGE = 8;

/** What a new animation is worth: long enough to see, short enough to be UI
 *  motion rather than a film. */
const DEFAULT_DURATION_MS = 1000;

let motionCounter = 0;
const nextMotionId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(motionCounter++).toString(36)}`;

/** A track is addressed by the pair it is keyed on. The separator is a NUL,
 *  written as an escape so this file stays plain text: a node id is an
 *  arbitrary string, and any printable separator could appear inside one. */
const trackKey = (track: { nodeId: NodeId; property: AnimatableProperty }) => `${track.nodeId}\u0000${track.property}`;

/** Opacity lives 0..1 in the model and reads as a percentage everywhere a person
 *  meets it, including the inspector next door. */
function toDisplay(property: AnimatableProperty, value: number): number {
  return property === "opacity" ? value * 100 : value;
}
function fromDisplay(property: AnimatableProperty, value: number): number {
  return property === "opacity" ? value / 100 : value;
}

export function MotionPanel({
  document: doc,
  selection,
  onSelect,
  onApply,
  onPreview,
  onClose,
  readOnly,
  height = 244,
}: {
  /** The committed document. The panel never reads the preview it produces. */
  document: DesignDocument;
  selection: NodeId[];
  onSelect: (ids: NodeId[]) => void;
  onApply: (operations: DesignOperation[], summary: string) => void;
  /** Called with the playhead whenever a preview should be on the canvas, and
   *  with null the moment it should not be. */
  onPreview: (preview: MotionPreview | null) => void;
  onClose: () => void;
  readOnly?: boolean;
  /** Set by the editor's resize grip. How much of the window a timeline is
   *  worth depends on how many tracks the animation has, which is not a number
   *  this panel — or the shell — can guess. */
  height?: number;
}) {
  const animations = React.useMemo(() => Object.values(doc.animations), [doc.animations]);
  const [animationId, setAnimationId] = React.useState<AnimationId | null>(null);
  const [timeMs, setTimeMs] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  /** Whether the canvas is showing the playhead. Opening the dock is not enough:
   *  a preview takes the canvas read-only, and nobody asked for that by clicking
   *  a tab. Playing, scrubbing or dragging a keyframe does ask for it. */
  const [engaged, setEngaged] = React.useState(false);
  const [selectedKeyframe, setSelectedKeyframe] = React.useState<{ track: string; index: number } | null>(null);
  const [drag, setDrag] = React.useState<{ track: string; index: number; time: number; moved: boolean } | null>(null);
  const [newProperty, setNewProperty] = React.useState<AnimatableProperty>("opacity");

  const animation = animations.find((a) => a.id === animationId) ?? animations[0] ?? null;
  const span = animation ? Math.max(1, animationSpanMs(animation)) : 1;

  // Only offer properties at least one selected layer can actually animate — a
  // "Font size" row on a rectangle is a control that does nothing. The chosen
  // property falls back when the selection changes under it, so the picker never
  // shows a value it no longer lists.
  const selectableProperties = ANIMATABLE_PROPERTIES.filter((info) =>
    selection.length === 0
      ? true
      : selection.some((id) => {
          const node = doc.nodes[id];
          return !!node && propertyApplies(node, info.property);
        })
  );
  const activeProperty = selectableProperties.some((info) => info.property === newProperty)
    ? newProperty
    : (selectableProperties[0]?.property ?? newProperty);

  // The animation on screen can go away underneath the panel — deleted here, or
  // undone from the toolbar — and the playhead has to stop pointing at it.
  React.useEffect(() => {
    if (animationId && !doc.animations[animationId]) {
      setAnimationId(null);
      setEngaged(false);
      setPlaying(false);
    }
  }, [animationId, doc.animations]);

  // One writer for the preview: this effect. The canvas holds no timer of its
  // own, so there is exactly one place the playhead can come from.
  React.useEffect(() => {
    onPreview(engaged && animation ? { animationId: animation.id, timeMs } : null);
  }, [animation, engaged, onPreview, timeMs]);
  React.useEffect(() => () => onPreview(null), [onPreview]);

  // Playback. Wall-clock deltas rather than a frame count, so a dropped frame
  // costs smoothness and not accuracy — the playhead reads the same time on a
  // busy machine as on an idle one.
  const timeRef = React.useRef(timeMs);
  timeRef.current = timeMs;
  React.useEffect(() => {
    if (!playing || !animation) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = timeRef.current + (now - last);
      last = now;
      if (next >= span) {
        if (animation.loop) {
          setTimeMs(next % span);
        } else {
          setTimeMs(span);
          setPlaying(false);
          return;
        }
      } else {
        setTimeMs(next);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [animation, playing, span]);

  // ------------------------------------------------------------- operations

  const write = (next: MotionAnimation, summary: string) => {
    if (readOnly) return;
    onApply([{ op: "createAnimation", animation: next }], summary);
  };

  const writeTrack = (track: MotionTrack, summary: string) => {
    if (readOnly || !animation) return;
    onApply([{ op: "setKeyframes", animationId: animation.id, track }], summary);
  };

  const addAnimation = () => {
    if (readOnly) return;
    const id = nextMotionId("anim");
    onApply(
      [
        {
          op: "createAnimation",
          animation: { id, name: `Animation ${animations.length + 1}`, durationMs: DEFAULT_DURATION_MS, loop: false, tracks: [] },
        },
      ],
      "Add animation"
    );
    setAnimationId(id);
    setTimeMs(0);
  };

  const addTracks = () => {
    if (readOnly || !animation) return;
    const existing = new Set(animation.tracks.map(trackKey));
    const operations: DesignOperation[] = [];
    for (const nodeId of selection) {
      const node = doc.nodes[nodeId];
      if (!node || node.locked) continue;
      if (existing.has(trackKey({ nodeId, property: activeProperty }))) continue;
      const seed = readNodeProperty(node, activeProperty);
      if (seed === null) continue;
      operations.push({
        op: "setKeyframes",
        animationId: animation.id,
        // The track opens with the layer where it already is, at the playhead.
        // A track seeded at zero would slam the layer to the origin the instant
        // it was added, and the first thing anyone would do is type it back.
        track: { nodeId, property: activeProperty, keyframes: [{ time: Math.round(timeMs), value: seed, easing: { type: "ease-in-out" } }] },
      });
    }
    if (operations.length) onApply(operations, `Animate ${propertyInfo(activeProperty).label.toLowerCase()}`);
  };

  const removeTrack = (track: MotionTrack) => {
    if (!animation) return;
    write({ ...animation, tracks: animation.tracks.filter((t) => trackKey(t) !== trackKey(track)) }, "Remove track");
    setSelectedKeyframe(null);
  };

  /** Add a keyframe at the playhead holding whatever the track already says
   *  there — inserting a keyframe must not change the motion, only give the
   *  author somewhere to change it from. */
  const addKeyframe = (track: MotionTrack) => {
    const node = doc.nodes[track.nodeId];
    const at = Math.round(timeMs);
    const value = sampleTrack(track, at) ?? (node ? readNodeProperty(node, track.property) : null);
    if (value === null) return;
    const keyframes = sortedKeyframes([
      ...track.keyframes.filter((k) => Math.round(k.time) !== at),
      { time: at, value, easing: track.keyframes[track.keyframes.length - 1]?.easing ?? { type: "ease-in-out" } },
    ]);
    writeTrack({ ...track, keyframes }, "Add keyframe");
    setSelectedKeyframe({ track: trackKey(track), index: keyframes.findIndex((k) => k.time === at) });
  };

  const editKeyframe = (track: MotionTrack, index: number, patch: Partial<Keyframe>, summary: string) => {
    const frames = sortedKeyframes(track.keyframes);
    const target = frames[index];
    if (!target) return;
    // Editing a time re-sorts the track, so the selection follows the keyframe
    // object rather than the row it used to be on — otherwise dragging one
    // keyframe past another leaves the footer editing its neighbour.
    const edited = { ...target, ...patch };
    const next = sortedKeyframes(frames.map((k, i) => (i === index ? edited : k)));
    writeTrack({ ...track, keyframes: next }, summary);
    setSelectedKeyframe({ track: trackKey(track), index: next.indexOf(edited) });
  };

  const deleteKeyframe = (track: MotionTrack, index: number) => {
    const frames = sortedKeyframes(track.keyframes);
    writeTrack({ ...track, keyframes: frames.filter((_, i) => i !== index) }, "Delete keyframe");
    setSelectedKeyframe(null);
  };

  // ---------------------------------------------------------------- pointer

  const timeFromPointer = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const usable = rect.width - EDGE * 2;
    if (usable <= 0) return 0;
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left - EDGE) / usable)) * span);
  };

  /** Where a time sits along the lane, in CSS. `f * (100% - 2·EDGE) + EDGE`,
   *  written the way `calc` can express it. */
  const offsetFor = (time: number) => {
    const fraction = Math.max(0, Math.min(1, time / span));
    return `calc(${fraction * 100}% + ${EDGE - fraction * EDGE * 2}px)`;
  };

  /** Whether the ruler is mid-drag. Not `hasPointerCapture`: capture is an
   *  enhancement that can fail (see `capturePointer`), and a scrub that stopped
   *  tracking because capture was refused would be a worse bug than one that
   *  merely stops at the edge of the ruler. */
  const scrubbingRef = React.useRef(false);

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    capturePointer(event.currentTarget, event.pointerId);
    scrubbingRef.current = true;
    setPlaying(false);
    setEngaged(true);
    setTimeMs(timeFromPointer(event.clientX, event.currentTarget));
  };

  const scrubMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    setTimeMs(timeFromPointer(event.clientX, event.currentTarget));
  };

  // ----------------------------------------------------------------- render

  const selected = selectedKeyframe
    ? (() => {
        const track = animation?.tracks.find((t) => trackKey(t) === selectedKeyframe.track);
        if (!track) return null;
        const frames = sortedKeyframes(track.keyframes);
        const keyframe = frames[selectedKeyframe.index];
        return keyframe ? { track, keyframe, index: selectedKeyframe.index } : null;
      })()
    : null;

  return (
    <section className="flex min-h-0 shrink-0 flex-col border-t border-border/60 bg-card/40" aria-label="Motion timeline" style={{ height }}>
      {/* Transport and the animation being edited */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          disabled={!animation}
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (!animation) return;
            setEngaged(true);
            if (!playing && timeMs >= span) setTimeMs(0);
            setPlaying((value) => !value);
          }}
          className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          disabled={!animation}
          aria-label="Back to the start"
          onClick={() => {
            setPlaying(false);
            setTimeMs(0);
          }}
          className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <SkipBack className="size-3.5" aria-hidden />
        </button>
        <span className="w-16 shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground">{Math.round(timeMs)} ms</span>

        <span aria-hidden className="mx-1 h-4 w-px bg-border/60" />

        <PanelSelect
          ariaLabel="Animation"
          value={animation?.id}
          placeholder="No animations"
          options={animations.map((item) => ({ value: item.id, label: item.name }))}
          disabled={animations.length === 0}
          onChange={(next) => {
            setAnimationId(next);
            setSelectedKeyframe(null);
            setTimeMs(0);
          }}
          className="w-40"
        />

        {animation && (
          <>
            <InlineNumber
              label="Duration"
              value={animation.durationMs}
              min={0}
              step={50}
              suffix="ms"
              disabled={readOnly}
              onCommit={(value) => write({ ...animation, durationMs: Math.max(0, value) }, "Set animation duration")}
            />
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={animation.loop}
              aria-label="Loop"
              onClick={() => write({ ...animation, loop: !animation.loop }, animation.loop ? "Stop looping" : "Loop animation")}
              className={cn(
                "pressable rounded-md p-1 transition-colors disabled:opacity-40",
                animation.loop ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Repeat className="size-3.5" aria-hidden />
            </button>
          </>
        )}

        <button
          type="button"
          disabled={readOnly}
          onClick={addAnimation}
          className="pressable flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3" aria-hidden /> New
        </button>
        {animation && (
          <button
            type="button"
            disabled={readOnly}
            aria-label={`Delete ${animation.name}`}
            onClick={() => {
              onApply([{ op: "deleteAnimation", animationId: animation.id }], "Delete animation");
              setAnimationId(null);
              setEngaged(false);
              setPlaying(false);
            }}
            className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
          >
            <ActionIcons.delete className="size-3.5" aria-hidden />
          </button>
        )}

        <div className="flex-1" />

        {engaged && (
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setEngaged(false);
            }}
            className="pressable rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-micro text-primary transition-colors hover:bg-primary/15"
          >
            Previewing · back to the design
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the timeline"
          className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {!animation ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-caption text-muted-foreground">Nothing in this document animates yet.</p>
          <button
            type="button"
            disabled={readOnly}
            onClick={addAnimation}
            className="pressable rounded-control border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:min-h-10"
          >
            New animation
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Track list */}
          <div className="flex w-56 shrink-0 flex-col border-r border-border/60">
            <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2" style={{ height: ROW_HEIGHT }}>
              <PanelSelect
                ariaLabel="Property to animate"
                value={activeProperty}
                options={selectableProperties.map((info) => ({ value: info.property, label: info.label }))}
                disabled={readOnly}
                onChange={(next) => setNewProperty(next as AnimatableProperty)}
                className="h-5 min-w-0 flex-1 text-micro"
              />
              <button
                type="button"
                disabled={readOnly || selection.length === 0}
                onClick={addTracks}
                title={selection.length === 0 ? "Select a layer first" : undefined}
                aria-label="Add a track for the selected layers"
                className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                <Plus className="size-3" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {animation.tracks.length === 0 && (
                <p className="px-2 py-4 text-center text-caption text-muted-foreground">
                  {selection.length === 0 ? "Select a layer, then add a property to animate." : "Add a property to animate."}
                </p>
              )}
              {animation.tracks.map((track) => {
                const node = doc.nodes[track.nodeId];
                const info = propertyInfo(track.property);
                const applies = node ? propertyApplies(node, track.property) : false;
                return (
                  <div
                    key={trackKey(track)}
                    className="group flex items-center gap-1 border-b border-border/40 px-2"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <button
                      type="button"
                      onClick={() => node && onSelect([track.nodeId])}
                      className="min-w-0 flex-1 truncate text-left text-caption outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span className={cn("truncate", selection.includes(track.nodeId) ? "text-primary" : "text-foreground")}>
                        {node?.name ?? "Missing layer"}
                      </span>
                      <span className="pl-1 font-mono text-micro text-muted-foreground">{info.label}</span>
                    </button>
                    {!info.previewed && (
                      <span title="Authored here, drawn in the HTML prototype — the SVG canvas does not draw blur." className="shrink-0 font-mono text-micro text-muted-foreground">
                        ○
                      </span>
                    )}
                    {node && !applies && (
                      <span title={`This layer has no ${info.requires === "text" ? "text" : info.requires} to animate.`} className="shrink-0 font-mono text-micro text-warning-foreground">
                        !
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => addKeyframe(track)}
                      aria-label={`Add a keyframe to ${node?.name ?? track.nodeId} ${info.label}`}
                      className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                    >
                      <Plus className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => removeTrack(track)}
                      aria-label={`Remove the ${info.label} track`}
                      className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Ruler, lanes and playhead */}
          <div className="relative min-w-0 flex-1 overflow-hidden">
            <div
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={span}
              aria-valuenow={Math.round(timeMs)}
              aria-valuetext={`${Math.round(timeMs)} milliseconds`}
              onPointerDown={scrub}
              onPointerMove={scrubMove}
              onPointerUp={() => {
                scrubbingRef.current = false;
              }}
              onPointerCancel={() => {
                scrubbingRef.current = false;
              }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 100 : 10;
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  setEngaged(true);
                  setPlaying(false);
                  setTimeMs((value) => Math.max(0, Math.min(span, value + (event.key === "ArrowRight" ? step : -step))));
                }
                event.stopPropagation();
              }}
              className="relative shrink-0 cursor-ew-resize touch-none select-none border-b border-border/60"
              style={{ height: ROW_HEIGHT }}
            >
              {rulerTicks(span).map((tick) => (
                <span
                  key={tick}
                  className="pointer-events-none absolute top-0 h-full border-l border-border/50 pl-1 font-mono text-micro text-muted-foreground"
                  style={{ left: offsetFor(tick), lineHeight: `${ROW_HEIGHT}px` }}
                >
                  {tick}
                </span>
              ))}
            </div>

            <div className="min-h-0 overflow-y-auto" style={{ maxHeight: `calc(100% - ${ROW_HEIGHT}px)` }}>
              {animation.tracks.map((track) => {
                const frames = sortedKeyframes(track.keyframes);
                const key = trackKey(track);
                return (
                  <div
                    key={key}
                    className="relative border-b border-border/40"
                    style={{ height: ROW_HEIGHT }}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || event.target !== event.currentTarget) return;
                      setEngaged(true);
                      setPlaying(false);
                      setTimeMs(timeFromPointer(event.clientX, event.currentTarget));
                    }}
                  >
                    {/* The segment between two keyframes, so easing has somewhere
                        to read as a shape rather than a word in a menu. */}
                    {frames.slice(0, -1).map((from, index) => {
                      const start = liveTime(from, key, index, drag);
                      const end = liveTime(frames[index + 1], key, index + 1, drag);
                      return (
                        <span
                          key={`${from.time}-${index}`}
                          aria-hidden
                          className={cn(
                            "pointer-events-none absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full",
                            from.easing.type === "spring" ? "bg-primary/50" : "bg-primary/25"
                          )}
                          style={{ left: offsetFor(start), right: `calc(100% - ${offsetFor(Math.max(start, end))})` }}
                        />
                      );
                    })}
                    {frames.map((keyframe, index) => {
                      const at = liveTime(keyframe, key, index, drag);
                      const isSelected = selectedKeyframe?.track === key && selectedKeyframe.index === index;
                      return (
                        <button
                          key={index}
                          type="button"
                          aria-label={`Keyframe at ${Math.round(at)} ms`}
                          aria-pressed={isSelected}
                          className={cn(
                            "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-micro border transition-colors",
                            isSelected ? "border-primary bg-primary" : "border-primary/70 bg-background hover:bg-primary/40",
                            readOnly ? "cursor-default" : "cursor-grab"
                          )}
                          style={{ left: offsetFor(at) }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            if (event.button !== 0) return;
                            setSelectedKeyframe({ track: key, index });
                            if (readOnly) return;
                            capturePointer(event.currentTarget, event.pointerId);
                            setDrag({ track: key, index, time: keyframe.time, moved: false });
                          }}
                          onPointerMove={(event) => {
                            if (!drag || drag.track !== key || drag.index !== index) return;
                            const lane = event.currentTarget.parentElement;
                            if (!lane) return;
                            const next = timeFromPointer(event.clientX, lane);
                            setEngaged(true);
                            setPlaying(false);
                            setTimeMs(next);
                            setDrag({ ...drag, time: next, moved: true });
                          }}
                          onPointerUp={(event) => {
                            releasePointer(event.currentTarget, event.pointerId);
                            // One transaction per gesture, on release — a drag
                            // across the lane is one undo step, the same rule
                            // the canvas drags follow.
                            if (drag && drag.track === key && drag.index === index && drag.moved && drag.time !== keyframe.time) {
                              editKeyframe(track, index, { time: drag.time }, "Move keyframe");
                            }
                            setDrag(null);
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-primary"
              style={{ left: offsetFor(Math.min(timeMs, span)) }}
            />
          </div>
        </div>
      )}

      {/* The selected keyframe */}
      {selected && (
        <div className="flex shrink-0 flex-wrap items-end gap-2 border-t border-border/60 px-2 py-1.5">
          <InlineNumber
            label="Time"
            value={Math.round(selected.keyframe.time)}
            min={0}
            max={600_000}
            suffix="ms"
            disabled={readOnly}
            onCommit={(value) => editKeyframe(selected.track, selected.index, { time: Math.max(0, Math.round(value)) }, "Move keyframe")}
          />
          {typeof selected.keyframe.value === "number" ? (
            <InlineNumber
              label="Value"
              value={toDisplay(selected.track.property, selected.keyframe.value)}
              suffix={propertyInfo(selected.track.property).unit}
              disabled={readOnly}
              onCommit={(value) =>
                editKeyframe(selected.track, selected.index, { value: fromDisplay(selected.track.property, value) }, "Set keyframe value")
              }
            />
          ) : (
            // `ColorField`, not a bare `<input type="color">`: the OS draws that
            // control's well and its popup, and this one sat inches from the
            // Radix animation picker in the same strip.
            <div className="w-44">
              <ColorField
                label="Value"
                ariaLabel="Keyframe colour"
                value={rgbaToHex(selected.keyframe.value)}
                disabled={readOnly}
                onCommit={(hex) => {
                  const color = hexToRgba(hex);
                  if (color) editKeyframe(selected.track, selected.index, { value: color }, "Set keyframe colour");
                }}
              />
            </div>
          )}
          <EasingEditor
            label="Easing out of this keyframe"
            easing={selected.keyframe.easing}
            disabled={readOnly}
            onChange={(easing) => editKeyframe(selected.track, selected.index, { easing }, "Set keyframe easing")}
          />
          <div className="flex-1" />
          <button
            type="button"
            disabled={readOnly}
            onClick={() => deleteKeyframe(selected.track, selected.index)}
            className="pressable rounded-md px-1.5 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
          >
            Delete keyframe
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Ask for pointer capture, and carry on without it if the browser refuses.
 *
 * Capture is what keeps a drag alive once the pointer leaves the 10-point
 * diamond it started on, so it is worth asking for — but `setPointerCapture`
 * throws `NotFoundError` when the pointer it names is no longer active, and a
 * throw inside a pointer handler is an *uncaught* error. Inside the Mac host
 * that is not a swallowed console line: the bundle's window error handler
 * reports it to native as an editor failure. Observed exactly that while
 * driving the timeline through the accessibility tree, which is a synthetic
 * pointer and therefore never active.
 */
function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // No capture: the gesture still tracks while the pointer is over the lane.
  }
}

function releasePointer(element: Element, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // Already released, or never held. Either way there is nothing to undo.
  }
}

/** Where a keyframe is being drawn right now: the dragged position while a
 *  gesture is in flight, the stored time otherwise. */
function liveTime(keyframe: Keyframe, key: string, index: number, drag: { track: string; index: number; time: number } | null): number {
  return drag && drag.track === key && drag.index === index ? drag.time : keyframe.time;
}

/** Round tick positions for the ruler — five or so, on a 1/2/5 scale, so the
 *  labels read as times a person would type. */
function rulerTicks(span: number): number[] {
  const rough = span / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let t = 0; t < span; t += step) ticks.push(Math.round(t));
  return ticks;
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

/** Shared with the interactions panel next door. The easing editor in
 *  particular is the same control in both places — a keyframe's easing and a
 *  transition's easing are one `EasingCurve` — and two copies of it would drift
 *  the moment the model gained a curve. */
/**
 * Re-exported, not redeclared.
 *
 * This was a second, byte-identical copy of the string in `effects-panel.tsx`,
 * which is where the module note already says the generic field primitives
 * live. Two definitions of one control's appearance is a guarantee that the
 * panels drift: whichever one the next person edits, half the editor's fields
 * keep the old look, and nothing about that failure is visible in review.
 * `interactions-panel.tsx` imports it from here, so the name stays.
 */
export { fieldClass };

export function InlineNumber({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  // Uncontrolled while focused, so typing "120" does not fight a re-render at "1".
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-micro text-muted-foreground">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        type="number"
        className={cn(fieldClass, "h-6 w-20 py-0")}
        value={draft ?? String(Math.round(value * 100) / 100)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const parsed = Number.parseFloat(draft);
            if (Number.isFinite(parsed)) onCommit(parsed);
          }
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(null);
            (event.target as HTMLInputElement).blur();
          }
          event.stopPropagation(); // editor shortcuts must not fire while typing
        }}
      />
    </label>
  );
}

export function SmallSelect({
  label,
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  // The same Radix dropdown the inspector uses — see `PanelSelect`. This was a
  // native `<select>`, so the timeline's pickers were drawn by the OS while the
  // menus beside them were the product's own.
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-micro text-muted-foreground">{label}</span>
      <PanelSelect
        ariaLabel={label}
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
        className={className}
      />
    </label>
  );
}

/** Sensible starting points when someone switches curve type: a UI spring, and
 *  the anticipation curve people reach for when they pick "custom". */
const SPRING_DEFAULT = { stiffness: 180, damping: 20, mass: 1 };
const BEZIER_DEFAULT = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };

export function EasingEditor({
  label,
  easing,
  disabled,
  onChange,
}: {
  label: string;
  easing: EasingCurve;
  disabled?: boolean;
  onChange: (easing: EasingCurve) => void;
}) {
  return (
    <div className="flex items-end gap-1.5">
      <SmallSelect
        label={label}
        value={easing.type}
        disabled={disabled}
        className="w-32"
        options={[
          { value: "linear", label: "Linear" },
          { value: "ease-in", label: "Ease in" },
          { value: "ease-out", label: "Ease out" },
          { value: "ease-in-out", label: "Ease in out" },
          { value: "cubic-bezier", label: "Custom curve" },
          { value: "spring", label: "Spring" },
        ]}
        onChange={(type) => {
          if (type === "spring") onChange({ type: "spring", ...SPRING_DEFAULT });
          else if (type === "cubic-bezier") onChange({ type: "cubic-bezier", ...BEZIER_DEFAULT });
          else onChange({ type } as EasingCurve);
        }}
      />
      {easing.type === "spring" && (
        <>
          <InlineNumber
            label="Stiffness"
            value={easing.stiffness}
            min={0.1}
            max={10_000}
            step={10}
            disabled={disabled}
            onCommit={(value) => onChange({ ...easing, stiffness: Math.max(0.1, value) })}
          />
          <InlineNumber
            label="Damping"
            value={easing.damping}
            min={0}
            max={1_000}
            disabled={disabled}
            onCommit={(value) => onChange({ ...easing, damping: Math.max(0, value) })}
          />
          <InlineNumber
            label="Mass"
            value={easing.mass}
            min={0.01}
            max={1_000}
            step={0.1}
            disabled={disabled}
            onCommit={(value) => onChange({ ...easing, mass: Math.max(0.01, value) })}
          />
        </>
      )}
      {easing.type === "cubic-bezier" && (
        <>
          <InlineNumber label="x1" value={easing.x1} min={0} max={1} step={0.05} disabled={disabled} onCommit={(v) => onChange({ ...easing, x1: clampUnit(v) })} />
          <InlineNumber label="y1" value={easing.y1} min={-10} max={10} step={0.05} disabled={disabled} onCommit={(v) => onChange({ ...easing, y1: v })} />
          <InlineNumber label="x2" value={easing.x2} min={0} max={1} step={0.05} disabled={disabled} onCommit={(v) => onChange({ ...easing, x2: clampUnit(v) })} />
          <InlineNumber label="y2" value={easing.y2} min={-10} max={10} step={0.05} disabled={disabled} onCommit={(v) => onChange({ ...easing, y2: v })} />
        </>
      )}
    </div>
  );
}

/** The bezier's x controls are clamped where the schema clamps them: a timing
 *  function whose x leaves 0..1 is not a function of time at all. */
function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
