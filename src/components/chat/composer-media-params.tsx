"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ChevronDown, Volume2 } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerMenuClass, MenuGlide } from "@/components/chat/composer-menu";
import { applyParamChange, capabilitiesFor, type MediaParamKey, type MediaParams } from "@/lib/media-params";
import {
  MEDIA_PARAMS_STORE_KEY,
  aspectBox,
  aspectRatioValue,
  fixedFacts,
  formatFramePixels,
  framePixels,
  orderAspectChoices,
  paramControls,
  paramsForModel,
  paramsForRequest,
  parseStoredParams,
  type ParamChoice,
  type ParamControl,
  type ParamsByModel,
} from "@/lib/media-params-ui";
import { cn } from "@/lib/utils";

/*
 * THE GENERATION ROW: what an image, video or music model lets a person pick
 * before it runs (aspect, resolution, quality, length, sound, how many, file
 * format), drawn from media-params.ts so a control only exists where the
 * model has the option, and a value only where the model takes it.
 *
 *   [▭ 16:9 ⌄] [ 720p · 1080p · 4K ] [ 8s ⌄ ] [🔈 Sound] [ PNG ⌄ ]      [▣ Project]
 *
 * ONE LINE, always. The row sits on the composer's tray shelf (one 6px inset,
 * concentric corners) in the tray's 28px pill language, and when it is wider
 * than the shelf it scrolls sideways inside itself with soft edge fades rather
 * than wrapping. One chip language: a pill with a value; a segmented group is
 * one pill whose selection is a thumb that glides (transform, expo ease); a
 * two-way toggle is a two-way segment ("Vocals | Instrumental"); Sound is a
 * pill whose glyph is struck through when off. Values in tabular numerals,
 * two weights (400, 500).
 *
 * The aspect ratio opens the FRAME CHOOSER: a stage on the left where the
 * chosen or hovered ratio is drawn as a hairline frame on a faint
 * construction (the number line through its centre, two orbits, mono ticks)
 * and morphs between ratios, the ratio set large in Newsreader with its name
 * and output size in mono; on the right a grid of proportional tiles, tall to
 * square to wide, the current one ringed in presence blue.
 *
 * Every menu opens OUTSIDE the composer (`layer`, the composer's own
 * placement: below the home's tray, above the dock), never over the draft.
 * Styles: composer-media-params.css, loaded from globals.css (a component
 * module carries no CSS import: the unit tests render components under tsx,
 * which cannot load a stylesheet). A value the current combination rules out
 * is drawn quieter but stays pickable: picking it moves whatever blocked it
 * (applyParamChange), and the control says what will move.
 */

// ---------------------------------------------------------------------------
// State: choices per model, carried across a model switch
// ---------------------------------------------------------------------------

function readStore(): ParamsByModel {
  try {
    return parseStoredParams(window.localStorage.getItem(MEDIA_PARAMS_STORE_KEY));
  } catch {
    return {};
  }
}

function writeStore(all: ParamsByModel) {
  try {
    window.localStorage.setItem(MEDIA_PARAMS_STORE_KEY, JSON.stringify(all));
  } catch {
    // Private windows and full quotas: the choices still apply to this session.
  }
}

export interface MediaParamsState {
  /** Null for a model with nothing to choose (chat models). */
  caps: ReturnType<typeof capabilitiesFor>;
  params: MediaParams;
  set: (key: MediaParamKey, value: unknown) => void;
  /** What /api/generate takes as `params`, or undefined for a chat model. */
  request: Record<string, string | number | boolean> | undefined;
}

/**
 * The composer's generation choices for `model`. Remembered per model (this
 * browser only); a model never set before inherits what still fits from the
 * one before it (paramsForModelSwitch), then its own defaults.
 */
export function useMediaParams(model: string): MediaParamsState {
  const caps = capabilitiesFor(model);
  const [saved, setSaved] = React.useState<ParamsByModel>({});
  const [active, setActive] = React.useState<{ model: string; params: MediaParams; carried: MediaParams | null }>(() => ({
    model,
    params: paramsForModel({}, model, null),
    carried: null,
  }));

  // The stored choices arrive after mount (no storage on the server, and a
  // first paint that matched the server's). `loaded` makes the merge happen
  // once, in render, rather than through an effect that sets state.
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    const id = window.setTimeout(() => setLoaded(true), 0);
    return () => window.clearTimeout(id);
  }, []);
  const [merged, setMerged] = React.useState(false);
  if (loaded && !merged) {
    const store = readStore();
    setMerged(true);
    setSaved(store);
    if (store[model]) setActive({ model, params: paramsForModel(store, model, null), carried: active.carried });
  }

  // A model switch: carry the last media choices across (chat models carry none).
  if (active.model !== model) {
    const carried = Object.keys(active.params).length ? active.params : active.carried;
    setActive({ model, params: paramsForModel(saved, model, carried), carried });
  }

  const params = active.model === model ? active.params : paramsForModel(saved, model, null);
  const set = React.useCallback(
    (key: MediaParamKey, value: unknown) => {
      const next = applyParamChange(active.model, active.params, key, value);
      setActive({ ...active, params: next });
      setSaved((prev) => ({ ...prev, [active.model]: next }));
    },
    [active],
  );
  // Written only after the stored map was read, so the empty first state can
  // never overwrite what an earlier visit saved.
  React.useEffect(() => {
    if (merged) writeStore(saved);
  }, [merged, saved]);

  const request = React.useMemo(() => (caps ? paramsForRequest(params) : undefined), [caps, params]);
  return { caps, params, set, request };
}

// ---------------------------------------------------------------------------
// Placement: the composer decides which side a menu opens on
// ---------------------------------------------------------------------------

/**
 * The composer's layer placement (composer.tsx `pickMenuLayer`): given the
 * trigger and the height a menu wants, the side and offset that put the menu
 * OUTSIDE the composer box (below the home's tray, above the dock's
 * composer), so it never covers the text field.
 */
export interface MediaParamsLayer {
  pick: (trigger: HTMLElement, need: number) => { side: "top" | "bottom"; sideOffset: number };
  onSide?: (side: "top" | "bottom" | null) => void;
}

type Placed = { side: "top" | "bottom"; sideOffset: number; alignOffset: number };

/**
 * `width(viewportWidth)` is the width the layer will take, so a layer opened
 * from a chip near the right edge (a scrolled row, a phone) is pulled left to
 * stay on screen: with the composer's side fixed, Radix's own collision shift
 * is off along with its flip.
 */
function usePlacement(layer: MediaParamsLayer | undefined, fallback: "top" | "bottom", need: number, width: (vw: number) => number) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [placed, setPlaced] = React.useState<Placed>({ side: fallback, sideOffset: 8, alignOffset: 0 });
  const onOpenChange = (next: boolean) => {
    let side = placed.side;
    const trigger = triggerRef.current;
    if (next && trigger) {
      const vw = window.innerWidth;
      const left = trigger.getBoundingClientRect().left;
      const room = vw - 12 - left;
      const w = Math.min(width(vw), vw - 24);
      const alignOffset = w > room ? Math.round(room - w) : left < 12 ? Math.round(12 - left) : 0;
      const p = layer ? layer.pick(trigger, need) : { side: fallback, sideOffset: 8 };
      side = p.side;
      setPlaced({ ...p, alignOffset });
    }
    layer?.onSide?.(next ? side : null);
  };
  const contentProps = {
    side: layer ? placed.side : fallback,
    sideOffset: layer ? placed.sideOffset : 8,
    align: "start" as const,
    alignOffset: placed.alignOffset,
    // The composer chose a side that clears its own box; letting Radix flip
    // would put the menu back over the draft.
    avoidCollisions: !layer,
    collisionPadding: 12,
  };
  return { triggerRef, onOpenChange, contentProps };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export function ComposerMediaParams({
  modelId,
  state,
  disabled,
  side = "bottom",
  layer,
}: {
  modelId: string;
  state: MediaParamsState;
  disabled?: boolean;
  /** Which way the menus open when the composer gives no `layer`. */
  side?: "top" | "bottom";
  layer?: MediaParamsLayer;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useEdgeFades(ref);
  const controls = paramControls(modelId, state.params);
  const facts = fixedFacts(state.caps);
  if (!controls.length && !facts.length) return null;
  const kindLabel = state.caps?.kind === "video" ? "Video settings" : state.caps?.kind === "audio" ? "Music settings" : "Image settings";
  const common = { disabled, side, layer };

  return (
    <div ref={ref} className="cparams" role="group" aria-label={kindLabel} data-disabled={disabled ? "" : undefined}>
      {controls.map((control) => {
        const onPick = (value: unknown) => state.set(control.key, value);
        switch (control.kind) {
          case "aspect":
            return <FrameChooser key={control.key} control={control} onPick={onPick} modelId={modelId} params={state.params} {...common} />;
          case "segmented":
            return <Segmented key={control.key} label={control.label} value={control.value} choices={control.choices} onPick={onPick} disabled={disabled} />;
          case "toggle":
            return control.key === "instrumental" ? (
              <Segmented
                key={control.key}
                label="Vocals"
                value={control.value === true}
                choices={[
                  { value: false, label: "Vocals" },
                  { value: true, label: "Instrumental" },
                ]}
                onPick={onPick}
                disabled={disabled}
              />
            ) : (
              <TogglePill key={control.key} control={control} onPick={onPick} disabled={disabled} />
            );
          case "slider":
            return <LengthPopover key={control.key} control={control} onPick={onPick} {...common} />;
          default:
            // A two-way choice reads better side by side than behind a menu (MP3 | WAV).
            return control.choices.length === 2 ? (
              <Segmented key={control.key} label={control.label} value={control.value} choices={control.choices} onPick={onPick} disabled={disabled} />
            ) : (
              <ChoiceMenu key={control.key} control={control} onPick={onPick} {...common} />
            );
        }
      })}
      {facts.map((fact) => (
        <span key={fact} className="cparams__fact">
          {fact}
        </span>
      ))}
    </div>
  );
}

/**
 * The row scrolls sideways when it is wider than the shelf; each edge fades
 * only while there is more that way, so a row that fits is never dimmed.
 */
function useEdgeFades(ref: React.RefObject<HTMLDivElement | null>) {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // On the home tray the Project control drops its word when the row would
    // otherwise scroll, and takes it back only once there is clearly room for
    // it again (the slack), so the two never chase each other.
    const line = el.closest<HTMLElement>(".composer-tray__line");
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.dataset.fadeStart = el.scrollLeft > 1 ? "true" : "false";
      el.dataset.fadeEnd = max - el.scrollLeft > 1 ? "true" : "false";
      const first = el.firstElementChild;
      const last = el.lastElementChild;
      if (line && first && last) {
        const content = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
        const slack = el.clientWidth - content;
        const tight = line.hasAttribute("data-tight");
        if (!tight && max > 1) line.setAttribute("data-tight", "");
        else if (tight && slack > 96) line.removeAttribute("data-tight");
      }
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const watch = () => Array.from(el.children).forEach((child) => resize.observe(child));
    watch();
    const mutate = new MutationObserver(() => {
      watch();
      update();
    });
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [ref]);
}

/** The shape of a ratio, drawn as a small hairline frame. */
function AspectGlyph({ value, size = 12 }: { value: unknown; size?: number }) {
  const box = aspectBox(value, size);
  return (
    <span aria-hidden="true" className="cparams__glyph" style={{ width: size, height: size }}>
      {box ? (
        <span className="cparams__frame" style={{ width: Math.max(box.width, 3), height: Math.max(box.height, 3) }} />
      ) : (
        <span className="cparams__frame cparams__frame--auto" style={{ width: size * 0.78, height: size * 0.78 }} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Segmented: one pill, a gliding thumb
// ---------------------------------------------------------------------------

type SegChoice = { value: string | number | boolean; label: string; detail?: string; conflict?: boolean; consequence?: string };

function Segmented({
  label,
  value,
  choices,
  onPick,
  disabled,
}: {
  label: string;
  value: unknown;
  choices: SegChoice[];
  onPick: (value: unknown) => void;
  disabled?: boolean;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  const placedRef = React.useRef(false);

  // The thumb sits under the chosen segment, moved with a transform. The
  // first placement (and any resize: fonts, a coarse pointer) lands without
  // travel; a pick glides.
  const place = React.useCallback((animate: boolean) => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const on = track.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!on) {
      thumb.dataset.on = "false";
      return;
    }
    if (!animate) thumb.style.transition = "none";
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    thumb.dataset.on = "true";
    if (!animate) {
      void thumb.offsetWidth;
      thumb.style.transition = "";
    }
  }, []);
  React.useLayoutEffect(() => {
    place(placedRef.current);
    placedRef.current = true;
  });
  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const resize = new ResizeObserver(() => place(false));
    resize.observe(track);
    return () => resize.disconnect();
  }, [place]);

  return (
    <div ref={trackRef} className="cparams__seg" role="radiogroup" aria-label={label}>
      <span ref={thumbRef} aria-hidden="true" className="cparams__thumb" data-on="false" />
      {choices.map((choice) => {
        const on = choice.value === value;
        const note = choice.conflict && choice.consequence ? choice.consequence : choice.detail;
        const button = (
          <button
            key={String(choice.value)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={note ? `${choice.label}. ${note}` : undefined}
            disabled={disabled}
            className="cparams__seg-item"
            data-conflict={choice.conflict ? "" : undefined}
            onClick={() => !on && onPick(choice.value)}
          >
            {choice.label}
          </button>
        );
        return note ? (
          <Tooltip key={String(choice.value)}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top" className="cparams-tip">
              {note}
            </TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}

/** Sound on or off: one pill, the glyph struck through when off. */
function TogglePill({
  control,
  onPick,
  disabled,
}: {
  control: ParamControl;
  onPick: (value: unknown) => void;
  disabled?: boolean;
}) {
  const on = control.value === true;
  return (
    <button
      type="button"
      className="cparams__chip cparams__chip--toggle"
      aria-pressed={on}
      aria-label={control.label}
      disabled={disabled}
      onClick={() => onPick(!on)}
    >
      <span className="cparams__sound" data-on={on ? "true" : "false"} aria-hidden="true">
        <Volume2 className="size-4" motion="none" />
      </span>
      <span className="cparams__toggle-text">
        {control.label}
        <span className="cparams__toggle-state">{on ? " on" : " off"}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Option menus: one recipe (the `.cmenu` shell), a mono head, a presence mark
// ---------------------------------------------------------------------------

/** A pill with a value and a chevron; Radix's trigger props land on the button. */
const ChipTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ children, className, ...props }, ref) => (
    <button ref={ref} type="button" className={cn("cparams__chip", className)} {...props}>
      {children}
      <ChevronDown aria-hidden="true" className="cparams__chevron size-3.5" motion="none" />
    </button>
  ),
);
ChipTrigger.displayName = "ChipTrigger";

function ChoiceMenu({
  control,
  onPick,
  disabled,
  side,
  layer,
}: {
  control: ParamControl;
  onPick: (value: unknown) => void;
  disabled?: boolean;
  side: "top" | "bottom";
  layer?: MediaParamsLayer;
}) {
  const numeric = typeof control.value === "number";
  const { triggerRef, onOpenChange, contentProps } = usePlacement(layer, side, 48 + control.choices.length * 40, () => 240);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <ChipTrigger ref={triggerRef} aria-label={`${control.label}: ${control.chip}`} disabled={disabled}>
          <span>{control.chip}</span>
        </ChipTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...contentProps} className={cn(composerMenuClass, "cparams-menu")}>
        <MenuGlide />
        <div className="cparams-head" aria-hidden="true">
          {control.label}
        </div>
        <DropdownMenuPrimitive.RadioGroup value={String(control.value)} onValueChange={(v) => onPick(numeric ? Number(v) : v)}>
          {control.choices.map((choice) => (
            <ChoiceRow key={String(choice.value)} choice={choice} />
          ))}
        </DropdownMenuPrimitive.RadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChoiceRow({ choice }: { choice: ParamChoice }) {
  const note = choice.conflict && choice.consequence ? choice.consequence : undefined;
  return (
    <DropdownMenuPrimitive.RadioItem
      value={String(choice.value)}
      className="cparams-row"
      data-conflict={choice.conflict ? "" : undefined}
    >
      <span className="cparams-row__text">
        <span className="cparams-row__label">{choice.label}</span>
        {note ? <span className="cparams-note">{note}</span> : null}
      </span>
      {choice.detail && !note ? <span className="cparams-row__meta">{choice.detail}</span> : null}
    </DropdownMenuPrimitive.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// The frame chooser
// ---------------------------------------------------------------------------

// The stage: a 200 × 160 drawing; the frame fits a 116 × 88 box at its centre,
// inside the outer orbit, so the construction always reads round it.
const STAGE_W = 200;
const STAGE_H = 160;
const FRAME_W = 116;
const FRAME_H = 88;
const BASE = 100;

function stageFrame(value: unknown): { w: number; h: number; auto: boolean } {
  const r = aspectRatioValue(value);
  if (r == null) return { w: 84, h: 84, auto: true };
  const w = r >= FRAME_W / FRAME_H ? FRAME_W : FRAME_H * r;
  const h = r >= FRAME_W / FRAME_H ? FRAME_W / r : FRAME_H;
  return { w: Math.max(w, 6), h: Math.max(h, 6), auto: false };
}

/** A tile's shape: the ratio itself, inside a 28px square. */
function tileShape(value: unknown): { width: number; height: number } {
  const box = aspectBox(value, 28);
  return box ? { width: Math.max(box.width, 3), height: Math.max(box.height, 3) } : { width: 22, height: 22 };
}

function FrameChooser({
  control,
  onPick,
  disabled,
  side,
  layer,
  modelId,
  params,
}: {
  control: ParamControl;
  onPick: (value: unknown) => void;
  disabled?: boolean;
  side: "top" | "bottom";
  layer?: MediaParamsLayer;
  modelId: string;
  params: MediaParams;
}) {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<string | number | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const glideRef = React.useRef<HTMLSpanElement>(null);
  const choices = React.useMemo(() => orderAspectChoices(control.choices), [control.choices]);
  // Balanced, never an orphan: up to five frames sit in one row, more fill
  // as few rows as possible with the columns spread evenly (14 → 5/5/4).
  const cols = Math.max(2, Math.ceil(choices.length / Math.ceil(choices.length / 5)));
  const rows = Math.ceil(choices.length / cols);
  const { triggerRef, onOpenChange, contentProps } = usePlacement(layer, side, Math.max(236, 40 + rows * 64), (vw) =>
    vw <= 560 ? vw - 24 : 188 + 6 + 14 + cols * 56 + (cols - 1) * 4,
  );

  const change = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
    if (!next) setPreview(null);
  };

  const shown = preview ?? (control.value as string | number);
  const shownChoice = choices.find((c) => c.value === shown);
  const frame = stageFrame(shown);
  const pixels = formatFramePixels(framePixels(modelId, params, shown));
  const ratioText = shown === "auto" ? "Auto" : String(shown);
  const note = shownChoice?.conflict ? shownChoice.consequence : undefined;

  // The glide: one highlight under the tiles that moves to whichever tile the
  // pointer or the keyboard is on, instead of a fill blinking tile to tile.
  const glideTo = (tile: HTMLElement | null) => {
    const glide = glideRef.current;
    if (!glide) return;
    if (!tile) {
      glide.dataset.on = "false";
      return;
    }
    const arriving = glide.dataset.on !== "true";
    if (arriving) glide.style.transition = "none";
    glide.style.width = `${tile.offsetWidth}px`;
    glide.style.height = `${tile.offsetHeight}px`;
    glide.style.transform = `translate(${tile.offsetLeft}px, ${tile.offsetTop}px)`;
    if (arriving) {
      void glide.offsetWidth;
      glide.style.transition = "";
    }
    glide.dataset.on = "true";
  };

  const tiles = () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = tiles();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const cols = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").length : 4;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    let next: number | null = null;
    if (event.key in step) next = Math.min(list.length - 1, Math.max(0, index + step[event.key]));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next == null) return;
    event.preventDefault();
    list[next].focus();
  };

  const pick = (value: string | number) => {
    if (value !== control.value) onPick(value);
    change(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={change}>
      <PopoverPrimitive.Trigger asChild disabled={disabled}>
        <ChipTrigger ref={triggerRef} aria-label={`${control.label}: ${shownLabel(control)}`} disabled={disabled}>
          <AspectGlyph value={control.value} />
          <span>{control.chip}</span>
        </ChipTrigger>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...contentProps}
          className={cn(composerMenuClass, "cframe z-popper")}
          aria-label={control.label}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const list = tiles();
            const current = list.find((tile) => tile.getAttribute("aria-checked") === "true") ?? list[0];
            current?.focus({ preventScroll: true });
          }}
        >
          <div className="cframe__stage" aria-hidden="true">
            <svg className="cframe__svg" viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}>
              <line className="cframe__axis cframe__draw" x1="0" x2={STAGE_W} y1={STAGE_H / 2} y2={STAGE_H / 2} pathLength={1} style={{ ["--i" as string]: 0 }} />
              <line className="cframe__axis cframe__draw" x1={STAGE_W / 2} x2={STAGE_W / 2} y1="10" y2={STAGE_H - 10} pathLength={1} style={{ ["--i" as string]: 1 }} />
              <ellipse className="cframe__orbit cframe__draw" cx={STAGE_W / 2} cy={STAGE_H / 2} rx="64" ry="22" pathLength={1} style={{ ["--i" as string]: 2 }} />
              <ellipse className="cframe__orbit cframe__orbit--faint cframe__draw" cx={STAGE_W / 2} cy={STAGE_H / 2} rx="98" ry="33" pathLength={1} style={{ ["--i" as string]: 3 }} />
              {[-98, -64, 64, 98].map((dx) => (
                <line key={dx} className="cframe__tick" x1={STAGE_W / 2 + dx} x2={STAGE_W / 2 + dx} y1={STAGE_H / 2 - 3} y2={STAGE_H / 2 + 3} />
              ))}
              <text className="cframe__tick-label" x={STAGE_W / 2 + 67} y={STAGE_H / 2 + 12}>
                ℵ<tspan fontSize="5.5" dy="2">0</tspan>
              </text>
              <text className="cframe__tick-label" x={STAGE_W / 2 + 101} y={STAGE_H / 2 + 12}>
                ℵ<tspan fontSize="5.5" dy="2">1</tspan>
              </text>
              <g transform={`translate(${STAGE_W / 2} ${STAGE_H / 2})`}>
                <rect
                  className="cframe__rect"
                  data-auto={frame.auto ? "" : undefined}
                  x={-BASE / 2}
                  y={-BASE / 2}
                  width={BASE}
                  height={BASE}
                  style={{ transform: `scale(${frame.w / BASE}, ${frame.h / BASE})` }}
                />
                {[
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ].map(([sx, sy]) => (
                  <g
                    key={`${sx}${sy}`}
                    className="cframe__corner"
                    style={{ transform: `translate(${(sx * frame.w) / 2 + sx * 4}px, ${(sy * frame.h) / 2 + sy * 4}px)` }}
                  >
                    <path d={`M0 ${-sy * 6} V0 H${-sx * 6}`} />
                  </g>
                ))}
              </g>
            </svg>
            <div className="cframe__caption">
              <span key={ratioText} className="cframe__ratio">
                {ratioText}
              </span>
              <span className="cframe__annot">{shown === "auto" ? "Model decides" : (shownChoice?.label ?? "")}</span>
              <span className="cframe__annot">{pixels ?? (shown === "auto" ? "From the prompt" : " ")}</span>
              {note ? <span className="cparams-note cframe__note">{note}</span> : null}
            </div>
          </div>
          <div
            ref={gridRef}
            className="cframe__grid"
            style={{ ["--cols" as string]: cols }}
            role="radiogroup"
            aria-label={control.label}
            onKeyDown={onKeyDown}
            onPointerLeave={() => {
              setPreview(null);
              glideTo(gridRef.current?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null);
            }}
          >
            <span ref={glideRef} aria-hidden="true" className="cframe__glide" data-on="false" />
            {choices.map((choice, i) => {
              const current = choice.value === control.value;
              const shape = tileShape(choice.value);
              return (
                <button
                  key={String(choice.value)}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  aria-label={`${choice.label}${choice.value === "auto" ? "" : ` ${choice.value}`}${choice.conflict && choice.consequence ? `. ${choice.consequence}` : ""}`}
                  tabIndex={current ? 0 : -1}
                  className="cframe__tile"
                  data-conflict={choice.conflict ? "" : undefined}
                  style={{ ["--i" as string]: i }}
                  onPointerEnter={(event) => {
                    setPreview(choice.value);
                    glideTo(event.currentTarget);
                  }}
                  onFocus={(event) => {
                    setPreview(choice.value);
                    glideTo(event.currentTarget);
                  }}
                  onClick={() => pick(choice.value)}
                >
                  <span className="cframe__well">
                    <span className="cframe__shape" data-auto={choice.value === "auto" ? "" : undefined} style={shape} />
                  </span>
                  <span className="cframe__label">{choice.value === "auto" ? "Auto" : String(choice.value)}</span>
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function shownLabel(control: ParamControl): string {
  const choice = control.choices.find((c) => c.value === control.value);
  return choice && choice.label !== control.chip ? `${choice.label} ${control.chip}` : control.chip;
}

// ---------------------------------------------------------------------------
// Length: a ruler and a slider
// ---------------------------------------------------------------------------

/** A length range (1 to 15s, 4 to 30s): a ruler, a slider, and Auto where the model can pick. */
function LengthPopover({
  control,
  onPick,
  disabled,
  side,
  layer,
}: {
  control: ParamControl;
  onPick: (value: unknown) => void;
  disabled?: boolean;
  side: "top" | "bottom";
  layer?: MediaParamsLayer;
}) {
  const range = control.range!;
  const auto = control.value === "auto";
  const seconds = typeof control.value === "number" ? control.value : Math.round((range.min + range.max) / 2);
  const [draft, setDraft] = React.useState<number | null>(null);
  const shown = draft ?? seconds;
  const { triggerRef, onOpenChange, contentProps } = usePlacement(layer, side, 200, () => 288);
  const steps = Math.round((range.max - range.min) / range.step);
  const ticks = Array.from({ length: steps + 1 }, (_, i) => range.min + i * range.step);
  const labelled = (v: number) => v === range.min || v === range.max || (v % 5 === 0 && v - range.min >= 3 && range.max - v >= 3);

  return (
    <PopoverPrimitive.Root
      onOpenChange={(next) => {
        onOpenChange(next);
        setDraft(null);
      }}
    >
      <PopoverPrimitive.Trigger asChild disabled={disabled}>
        <ChipTrigger ref={triggerRef} aria-label={`${control.label}: ${control.chip}`} disabled={disabled}>
          <span>{control.chip}</span>
        </ChipTrigger>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...contentProps} className={cn(composerMenuClass, "cparams-length z-popper")} aria-label={control.label}>
          <div className="cparams-length__head">
            <span className="cparams-head">{control.label}</span>
            {range.auto ? (
              <Segmented
                label="Length mode"
                value={auto && draft == null ? "auto" : "set"}
                choices={[
                  { value: "auto", label: "Auto" },
                  { value: "set", label: "Set" },
                ]}
                onPick={(v) => onPick(v === "auto" ? "auto" : seconds)}
              />
            ) : null}
          </div>
          <div className="cparams-length__value" aria-hidden="true">
            {auto && draft == null ? (
              <>
                <span className="cparams-length__num">Auto</span>
                <span className="cframe__annot">{range.auto ?? "Model decides"}</span>
              </>
            ) : (
              <>
                <span className="cparams-length__num">
                  {shown}
                  <span className="cparams-length__unit">s</span>
                </span>
                <span className="cframe__annot">
                  {range.min} to {range.max}s
                </span>
              </>
            )}
          </div>
          <div className="cparams-length__ruler" aria-hidden="true" data-auto={auto && draft == null ? "" : undefined}>
            {ticks.map((v) => (
              <span key={v} className="cparams-length__tick" data-major={labelled(v) ? "" : undefined} data-on={v <= shown ? "" : undefined}>
                {labelled(v) ? <span className="cparams-length__tick-label">{v}</span> : null}
              </span>
            ))}
          </div>
          <Slider
            className="cparams-length__slider"
            min={range.min}
            max={range.max}
            step={range.step}
            value={[shown]}
            aria-label={control.label}
            onValueChange={([v]) => setDraft(v)}
            onValueCommit={([v]) => {
              setDraft(null);
              onPick(v);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
