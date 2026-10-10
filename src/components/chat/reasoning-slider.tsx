"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, RotateCcw, Zap } from "@/components/ui/icons";
import type { ReasoningOption } from "@/lib/model-metrics";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Pro, said once wherever the switch is drawn, in the settings' words for effort. */
export const PRO_MODE_HELP = "The model's deeper reasoning mode. Slower and costs more.";

/** The Ultrafast tier's description, naming the premium the reader agrees to. */
export function ultraFastHelp(multiplier?: number): string {
  return multiplier ? `OpenAI's fastest tier, at ${multiplier}x the standard price.` : "OpenAI's fastest tier, at a premium.";
}

/** Where the speed control is: off, the lab's fast tier, or OpenAI's Ultrafast. */
export type SpeedTier = "off" | "fast" | "ultra";

/**
 * The speed control's one-line name for a tier, with the price it costs:
 * the tooltip and the accessible label ("Ultra fast · 6× standard price").
 */
export function speedTierLabel(tier: SpeedTier, multiplier?: number): string {
  const price = multiplier ? ` · ${+multiplier.toFixed(2)}× standard price` : "";
  if (tier === "ultra") return `Ultra fast${price}`;
  if (tier === "fast") return `Fast${price}`;
  return "Standard speed";
}

/**
 * The next tier one press of the speed control lands on: Off → Fast → Ultra
 * fast → Off, skipping a tier the model does not have.
 */
export function nextSpeedTier(tier: SpeedTier, has: { fast: boolean; ultra: boolean }): SpeedTier {
  const order: SpeedTier[] = ["off", ...(has.fast ? (["fast"] as const) : []), ...(has.ultra ? (["ultra"] as const) : [])];
  const at = order.indexOf(tier);
  return order[(at < 0 ? 0 : at + 1) % order.length];
}

/**
 * The speed control's glyph: one web bolt for Fast, the same bolt twice,
 * overlapped about 3px, for Ultra fast. The second bolt springs in and out
 * (transform + opacity only), and holds still under reduced motion.
 */
function SpeedGlyph({ tier }: { tier: SpeedTier }) {
  const two = tier === "ultra";
  return (
    <span aria-hidden className="relative inline-flex size-4 items-center justify-center">
      <Zap
        className={cn(
          "absolute size-4 transition-transform duration-base ease-spring motion-reduce:transition-none",
          two ? "-translate-x-[2px]" : "translate-x-0",
        )}
      />
      <Zap
        className={cn(
          "absolute size-4 transition-[transform,opacity] duration-base ease-spring motion-reduce:transition-none",
          two ? "translate-x-[3px] opacity-100" : "translate-x-0 opacity-0",
        )}
      />
    </span>
  );
}

/**
 * Thinking effort, as a slider.
 *
 * IT HAS BEEN FOUR THINGS, so the history is worth keeping.
 *
 * A range input with a neumorphic track and a shadowed thumb — the one
 * control that kept the Soft UI recipes after the flat retune
 * (docs/design/FLAT_UI.md §6). Then a row of six words, on the argument that a
 * discrete choice with six values is what a radio group is for. That is right
 * about semantics and wrong about the thing being chosen: effort is ORDERED.
 * Instant is less than Max and every rung between them is on the way, so a row
 * of equal words — which says "here are six options" — states something false
 * about the choice.
 *
 * Then a hairline rail with a 14px dot, which was a slider the way a volume
 * control buried in a settings pane is a slider: correct, and invisible. This
 * one is the object. A 28px pill, the accent filled up to where you are, a
 * knob big enough to look grabbable, the rungs marked inside the track, and
 * the rung you are on named above it in the accent.
 *
 * THE INTERACTION IS A NATIVE `input[type=range]`, invisible, stretched over
 * the painted pill. Drag, click-to-jump, arrows, Home/End, page keys and every
 * touch gesture come from the platform rather than from this file, and the
 * painted parts below are decoration that cannot fall out of sync with them.
 * `aria-valuetext` is what makes it say "High" rather than "3".
 *
 * The alignment between the invisible input and the painted knob is not a
 * coincidence and not a fudge: the browser insets a range thumb by half its
 * width at each end, so `.effort-range` in globals.css pins that thumb to
 * exactly THUMB px and the same inset is written into `atStop()` here. Change
 * one and you must change the other, which is why the number lives in one
 * place.
 *
 * THE TOP RUNG IS STILL. It used to breathe: first a sheen swept along the
 * fill on a loop (the skeleton-loader gesture, on a control that loads
 * nothing), then the whole fill brightened and settled every eight seconds.
 * Both were idle loops, and loops are for live state only — thinking,
 * streaming, recording (ICONS_AND_MOTION.md §2.9). Max is a setting, not
 * something happening, so it is the static accent fill like every other rung;
 * the knob's travel to the end of the track is the arrival, and the word
 * above it says the rest.
 *
 * The export keeps its old name so every composer that mounts it keeps
 * compiling; the props are unchanged.
 */

/**
 * Knob diameter, px. Must equal the width pinned in `.effort-range`.
 *
 * 28 — the full height of the track. The PAINTED knob is 24, sitting in the
 * track's 2px padding, but the inset a browser applies is half of the thumb
 * it was given, so the outer figure is what belongs here and in the CSS.
 */
const THUMB = 18;

/** Where stop `i` of `count` sits along the track, as a CSS length. */
const atStop = (i: number, count: number) => {
  const t = count > 1 ? i / (count - 1) : 0;
  return `calc(${(t * 100).toFixed(4)}% + ${(THUMB / 2 - t * THUMB).toFixed(3)}px)`;
};

/**
 * The effort panel's surroundings, supplied by the model chip's popover: the
 * model's name (pressing it opens the model list in the same popover).
 */
export const EffortPanelContext = React.createContext<{ modelName: string; onOpenModels: () => void } | null>(null);

const PANEL_THUMB = 28;
/** Where stop `i` of `count` sits on the panel track (4px inset at each end). */
const panelStop = (i: number, count: number) => {
  const t = count > 1 ? i / (count - 1) : 0;
  return `calc(${(t * 100).toFixed(4)}% + ${(PANEL_THUMB / 2 + 4 - t * (PANEL_THUMB + 8)).toFixed(3)}px)`;
};

export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
  className,
  fastMode = false,
  fastModeMultiplier,
  onFastModeChange,
  proMode = false,
  onProModeChange,
  ultraFast = false,
  ultraFastMultiplier,
  onUltraFastChange,
  defaultValue,
  variant = "inline",
}: {
  /** The model's own default rung, for the panel's reset. */
  defaultValue?: ReasoningOption["value"];
  /** `panel`: OpenAI's thinking-time popover (the owner's reference). */
  variant?: "inline" | "panel";
  options: ReasoningOption[];
  value: ReasoningOption["value"];
  onChange: (value: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode?: boolean;
  /** The fast tier's price multiple, for the speed control's label. */
  fastModeMultiplier?: number;
  onFastModeChange?: (value: boolean) => void;
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
  /** OpenAI Ultrafast: the speed control's third step, only where the model has it. */
  ultraFast?: boolean;
  ultraFastMultiplier?: number;
  onUltraFastChange?: (value: boolean) => void;
}) {
  const count = options.length;
  const found = options.findIndex((option) => option.value === value);
  const index = found < 0 ? 0 : found;
  const current = options[index];

  if (count < 2) return null;

  if (variant === "panel") {
    return (
      <EffortPanel
        options={options}
        index={index}
        onChange={onChange}
        disabled={disabled}
        className={className}
        fastMode={fastMode}
        fastModeMultiplier={fastModeMultiplier}
        onFastModeChange={onFastModeChange}
        proMode={proMode}
        onProModeChange={onProModeChange}
        ultraFast={ultraFast}
        ultraFastMultiplier={ultraFastMultiplier}
        onUltraFastChange={onUltraFastChange}
        defaultValue={defaultValue}
      />
    );
  }

  const head = atStop(index, count);
  return (
    <div className={cn("select-none", className)}>
      {/*
       * THE EFFORT DIAL, redrawn after the owner's reference (OpenAI's
       * thinking-time control): a hairline track, one stop per rung, a small
       * raised thumb and the rung names under their stops. The old control was
       * a 28px accent bar with a 28px knob, which read as a toggle switch or a
       * progress bar rather than as a choice among a few depths.
       */}
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-caption font-medium text-muted-foreground">Thinking</span>
        <span
          key={current?.label ?? ""}
          className={cn(
            "text-caption font-medium",
            "motion-safe:animate-fade-in motion-safe:[animation-duration:var(--dur-fast)]",
            disabled ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {current?.label ?? ""}
        </span>
      </div>
      <div className={cn("relative h-6 w-full coarse:h-11", disabled && "opacity-55")}>
        {/* Track. The fill is a full-width bar slid in from the left, so only
            transform travels (ICONS_AND_MOTION.md §2.2.8). */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="absolute inset-0 rounded-full bg-foreground/85 transition-transform duration-base ease-out-soft motion-reduce:transition-none"
            style={{ transform: `translateX(calc(-100% + ${head}))` }}
          />
        </div>
        {/* Stops, one per rung, sitting on the track. */}
        {options.map((option, i) => (
          <span
            key={`stop-${option.value}-${option.label}`}
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
              i < index ? "bg-background/70" : i === index ? "bg-transparent" : "bg-foreground/25",
            )}
            style={{ left: atStop(i, count) }}
          />
        ))}
        {/* The thumb rides a carriage that translates (never `left`), inside a
            frame of the track's size so the carriage cannot widen the page. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-0 transition-transform duration-base ease-out-soft motion-reduce:transition-none"
            style={{ transform: `translateX(${head})` }}
          >
            <div className="effort-thumb absolute left-0 top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/[0.06] bg-knob shadow-[0_1px_2px_rgb(0_0_0/0.12),0_2px_8px_rgb(0_0_0/0.08)] dark:border-white/10" />
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={count - 1}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Thinking effort"
          aria-valuetext={current?.label ?? String(index)}
          onChange={(event) => {
            const next = options[Number(event.target.value)];
            if (next) onChange(next.value);
          }}
          className="effort-range peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full opacity-0 ring-2 ring-ring transition-opacity duration-fast ease-out-soft peer-focus-visible:opacity-100 motion-reduce:transition-none"
        />
      </div>
      {/* The rung names, each under its stop and each a target of its own:
          the ends hug the edges, the middle ones centre on their stop. */}
      <div className="relative mt-1 h-4">
        {options.map((option, i) => (
          <button
            key={`label-${option.value}-${option.label}`}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "absolute top-0 whitespace-nowrap text-caption transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
              i === index ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              i === 0 ? "left-0" : i === count - 1 ? "right-0" : "-translate-x-1/2",
            )}
            style={i === 0 || i === count - 1 ? undefined : { left: atStop(i, count) }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {(onFastModeChange || onProModeChange || onUltraFastChange) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(onFastModeChange || onUltraFastChange) && (() => {
            // One chip for speed, cycling like the panel's bolt.
            const has = { fast: !!onFastModeChange, ultra: !!onUltraFastChange };
            const tier: SpeedTier = ultraFast && has.ultra ? "ultra" : fastMode && has.fast ? "fast" : "off";
            const next = nextSpeedTier(tier, has);
            return (
              <ModeChip
                label={tier === "ultra" ? "Ultra fast" : "Flash"}
                help={speedTierLabel(tier === "off" ? "fast" : tier, tier === "ultra" ? ultraFastMultiplier : fastModeMultiplier)}
                pressed={tier !== "off"}
                disabled={disabled}
                onPress={() => {
                  if (next === "fast") onFastModeChange?.(true);
                  else if (next === "ultra") onUltraFastChange?.(true);
                  else if (tier === "ultra") onUltraFastChange?.(false);
                  else onFastModeChange?.(false);
                }}
              />
            );
          })()}
          {onProModeChange && (
            <ModeChip
              label="Pro"
              help={PRO_MODE_HELP}
              pressed={proMode}
              disabled={disabled}
              onPress={() => onProModeChange(!proMode)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({
  label,
  help,
  pressed,
  disabled,
  onPress,
}: {
  label: string;
  help: string;
  pressed: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={pressed}
          onClick={onPress}
          className={cn(
            // `.pressable` times the colour cross-fade and the press dip on
            // their own rungs; a transition-* utility here would replace it.
            "pressable inline-flex h-7 items-center rounded-control border px-2.5 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-9 motion-reduce:active:scale-100",
            pressed
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}


/**
 * OpenAI's thinking-time panel, in Alevr's materials: the rung named large in
 * the middle with the model under it (press it to change model), Flash on the
 * left, reset on the right, and a thick pill track with one stop per rung and
 * a 40px thumb that travels on the compositor.
 */
function EffortPanel({
  options,
  index,
  onChange,
  disabled,
  className,
  fastMode,
  fastModeMultiplier,
  onFastModeChange,
  proMode = false,
  onProModeChange,
  ultraFast = false,
  ultraFastMultiplier,
  onUltraFastChange,
  defaultValue,
}: {
  options: ReasoningOption[];
  index: number;
  onChange: (value: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode: boolean;
  fastModeMultiplier?: number;
  onFastModeChange?: (value: boolean) => void;
  /** Absent where the model has no Pro mode: the capsule is not drawn at all. */
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
  ultraFast?: boolean;
  ultraFastMultiplier?: number;
  onUltraFastChange?: (value: boolean) => void;
  defaultValue?: ReasoningOption["value"];
}) {
  // The speed control: hidden without a fast tier, Ultra only where it exists.
  const hasFast = !!onFastModeChange;
  const hasUltra = !!onUltraFastChange;
  const showsSpeed = hasFast || hasUltra;
  const speedTier: SpeedTier = ultraFast && hasUltra ? "ultra" : fastMode && hasFast ? "fast" : "off";
  const speedMultiplier = speedTier === "ultra" ? ultraFastMultiplier : speedTier === "fast" ? fastModeMultiplier : undefined;
  const cycleSpeed = () => {
    const next = nextSpeedTier(speedTier, { fast: hasFast, ultra: hasUltra });
    if (next === "fast") onFastModeChange?.(true);
    else if (next === "ultra") onUltraFastChange?.(true);
    else if (speedTier === "ultra") onUltraFastChange?.(false);
    else onFastModeChange?.(false);
  };
  const panel = React.useContext(EffortPanelContext);
  const count = options.length;
  const current = options[index];
  const head = panelStop(index, count);
  const canReset = defaultValue !== undefined && current?.value !== defaultValue;
  const iconButton =
    "pressable grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35 coarse:size-11";
  return (
    <div className={cn("select-none", className)}>
      {/* One line: the speed control and Pro on the left, the rung and its
          model in the middle, reset on the right. The side columns share a
          width so the rung stays centred whichever controls the model has. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex items-center gap-1">
          {showsSpeed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={speedTierLabel(speedTier, speedMultiplier)}
                  aria-pressed={speedTier !== "off"}
                  disabled={disabled}
                  onClick={cycleSpeed}
                  className={cn(
                    iconButton,
                    // On (Fast or Ultra fast): the same filled ink circle as
                    // the Pro capsule, glyph inverted; the bolt count tells
                    // the two apart. Off stays a quiet unfilled glyph.
                    speedTier !== "off" && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
                  )}
                >
                  <SpeedGlyph tier={speedTier} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{speedTierLabel(speedTier, speedMultiplier)}</TooltipContent>
            </Tooltip>
          ) : null}
          {onProModeChange ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={proMode}
                  aria-label={proMode ? "Pro on: deeper reasoning" : "Pro: deeper reasoning"}
                  disabled={disabled}
                  onClick={() => onProModeChange(!proMode)}
                  className={cn(
                    // A capsule beside the bolt, in the same group: filled ink
                    // when on, a hairline when off.
                    "pressable inline-flex h-8 items-center rounded-full border px-2.5 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 coarse:h-9 motion-reduce:active:scale-100",
                    proMode
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  Pro
                </button>
              </TooltipTrigger>
              <TooltipContent>{PRO_MODE_HELP}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col items-center">
          <span key={current?.label} className="text-body font-medium text-foreground motion-safe:animate-fade-in">
            {current?.label}
          </span>
          {panel ? (
            <button
              type="button"
              onClick={panel.onOpenModels}
              className="group inline-flex max-w-full items-center gap-0.5 rounded-control px-1.5 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
            >
              <span className="truncate" translate="no">{panel.modelName}</span>
              <ChevronRight className="size-3.5 shrink-0 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="flex justify-end">
        <button
          type="button"
          aria-label="Reset to the model's default"
          title="Reset to the model's default"
          disabled={disabled || !canReset}
          onClick={() => defaultValue !== undefined && onChange(defaultValue)}
          className={iconButton}
        >
          <RotateCcw className="size-4" />
        </button>
        </div>
      </div>

      <div className={cn("relative mt-3 h-9 w-full", disabled && "opacity-55")}>
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full bg-foreground/[0.07] dark:bg-white/[0.08]">
          <div
            className={cn(
              "absolute inset-0 rounded-full bg-foreground/85 transition-[transform,opacity] duration-base ease-out-soft motion-reduce:transition-none dark:bg-white/25",
              index === 0 && "opacity-0",
            )}
            // The fill is a pill that holds the knob with the track's own 4px
            // inset on every side (36px track, 28px knob): it ends 4px past the
            // knob, so at the last rung it meets the track's end with no sliver
            // of the empty track showing, and the radii stay concentric.
            style={{ transform: `translateX(calc(-100% + ${head} + ${PANEL_THUMB / 2 + 4}px))` }}
          />
        </div>
        {options.map((option, i) => (
          <span
            key={`panel-stop-${option.value}-${option.label}`}
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-fast ease-out-soft",
              i < index ? "bg-background/55" : i === index ? "bg-transparent" : "bg-foreground/25"
            )}
            style={{ left: panelStop(i, count) }}
          />
        ))}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <div
            className="absolute inset-0 transition-transform duration-base ease-out-soft motion-reduce:transition-none"
            style={{ transform: `translateX(${head})` }}
          >
            <div className="absolute left-0 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.18),0_2px_8px_rgb(0_0_0/0.12)]" />
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={count - 1}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Thinking effort"
          aria-valuetext={current?.label ?? String(index)}
          onChange={(event) => {
            const next = options[Number(event.target.value)];
            if (next) onChange(next.value);
          }}
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] rounded-full opacity-0 ring-2 ring-foreground/20 transition-opacity duration-fast ease-out-soft peer-focus-visible:opacity-100"
        />
      </div>

      {/* Pro: a separate axis from the rung (the GPT-5.6 line reasons in a
          deeper mode on the same model), so a switch under the track rather
          than another stop on it. Only drawn where the model has the mode. */}
    </div>
  );
}
