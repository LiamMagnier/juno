"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RotateCcw } from "@/components/ui/icons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { EffortPanelContext, SpeedGlyph, type SpeedTier } from "@/components/chat/reasoning-slider";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { useApp } from "@/components/app/app-provider";
import { isModelLocked, pushRecent } from "@/lib/model-picker";
import { chipLabelLadder, chipShortName, pickChipLabel, type ChipLabel } from "@/lib/model-chip-label";
import { PLANS, modelRequiredPlan } from "@/lib/plans";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { toast } from "sonner";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { COMPOSER_MENU_COLLISION_PADDING } from "@/components/chat/composer-menu";
import { catalogueCloseFocus } from "@/components/chat/catalogue-focus";
import { cn } from "@/lib/utils";

/**
 * The model control: a chip, and what it opens depends on the model.
 *
 * A model with thinking levels opens on the thinking slider first, the thing
 * most turns change; the model name in that panel opens the full catalogue.
 * Every other model (one effort, Auto, image, video, audio) opens the full
 * catalogue (model-catalogue.tsx) straight away: search, every lab, each
 * lab's Text / Image / Video / Audio sections, and the selected model in view.
 * The short favourites menu that used to sit between the chip and the
 * catalogue is gone (owner, 2026-10-03).
 *
 * ── The catalogue is fetched, not bundled ────────────────────────────────
 *
 * It shipped with the composer once, so every chat screen downloaded three
 * panes, sixteen lab marks and a detail panel to draw a chip. Its state lives
 * in its own module, which is what makes the dynamic import below buy
 * anything, and `prefetchCatalogue` hides the split: the chunk is requested
 * as the pointer reaches the chip (or focus does), a beat before the click
 * that opens it. Webpack dedupes it against the `nextDynamic` import, so the
 * two are one request.
 *
 * `catalogueMounted`, not `open`, gates the render: unmounting on close would
 * cut the popover's exit animation, and Radix already unmounts its own content
 * when closed. The catalogue is re-created per open by `key`, so its query and
 * cursor never persist.
 *
 * Anything both files need lives in `lib/model-picker.ts`, never in either
 * component file: one static import between the two undoes the split.
 *
 * ── A chunk that will not load never takes the chat with it ──────────────
 *
 * This used to be `next/dynamic`, which is `React.lazy` with no error
 * handling: when the chunk failed (a tab left open across a deploy, whose
 * old chunk is gone; a dropped connection) the rejection went to the route's
 * error boundary and the whole conversation was replaced by an error page.
 * `React.lazy` also remembers a failure, so every later click did it again
 * until a hard reload. The loader below is ours: a failed import is
 * forgotten (webpack resets the chunk too), the popover shows
 * `CatalogueUnavailable` with a retry in place of the list, and a render
 * error inside the catalogue stops at `CatalogueBoundary`, in the popover.
 */
type CatalogueComponent = typeof import("@/components/chat/model-catalogue").ModelCatalogue;
let catalogueRequest: Promise<CatalogueComponent> | null = null;
let catalogueLoaded: CatalogueComponent | null = null;

function loadCatalogue(): Promise<CatalogueComponent> {
  catalogueRequest ??= import("@/components/chat/model-catalogue").then(
    (m) => (catalogueLoaded = m.ModelCatalogue),
    (error: unknown) => {
      // Forget the failure, so the next attempt asks the network again.
      catalogueRequest = null;
      throw error;
    },
  );
  return catalogueRequest;
}

/** Warm the catalogue chunk before the chip is pressed. A failure here is silent: the click retries. */
function prefetchCatalogue() {
  loadCatalogue().catch(() => {});
}

/**
 * The catalogue component once its chunk is here, or why it is not. Starts
 * the load when `wanted` turns true; `retry` asks again after a failure.
 */
function useCatalogue(wanted: boolean) {
  const [component, setComponent] = React.useState<CatalogueComponent | null>(() => catalogueLoaded);
  const [failures, setFailures] = React.useState(0);
  const [attempt, setAttempt] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!wanted || component) return;
    let live = true;
    setLoading(true);
    loadCatalogue().then(
      (loaded) => {
        if (!live) return;
        setLoading(false);
        // A function, so React stores the component rather than calling it.
        setComponent(() => loaded);
      },
      () => {
        if (!live) return;
        setLoading(false);
        setFailures((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, component, attempt]);
  return { component, failures, loading, retry: () => setAttempt((n) => n + 1) };
}

/** Where the catalogue's stand-ins open: where the catalogue itself would. */
type CataloguePlacement = {
  side?: "top" | "bottom";
  /**
   * Where focus goes when the popover closes and Radix has no trigger to send
   * it to: opened from the thinking panel's model name, the catalogue's
   * popover has only an anchor, and Escape dropped focus to <body>.
   */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
};


/**
 * The popover the chip opens when the catalogue cannot be drawn: what
 * happened, in a sentence, and the way out. A second failure in a row offers
 * a reload as well, because by then the likeliest cause is a new release
 * whose files replaced the ones this tab was built against.
 */
function CatalogueUnavailable({
  side = "top",
  returnFocusTo,
  failures,
  busy,
  onRetry,
}: CataloguePlacement & { failures: number; busy: boolean; onRetry: () => void }) {
  const interactedOutside = React.useRef(false);
  return (
    <PopoverContent
      align="end"
      side={side}
      sideOffset={8}
      collisionPadding={COMPOSER_MENU_COLLISION_PADDING}
      aria-label="Models"
      className="w-[min(18.5rem,calc(100vw-1.5rem))] rounded-menu p-4"
      onInteractOutside={() => {
        interactedOutside.current = true;
      }}
      onCloseAutoFocus={(event) => catalogueCloseFocus(event, { returnFocusTo, interactedOutside: interactedOutside.current })}
    >
      <p className="text-ui font-medium text-foreground">Couldn&rsquo;t load the models</p>
      <p className="mt-1 text-caption text-muted-foreground">
        {failures > 1
          ? `Still not loading. If ${PRODUCT_NAME} was just updated, reloading the page fixes it.`
          : "Check your connection and try again."}
      </p>
      <div className="mt-3 flex items-center gap-2">
        {/* Busy, not disabled: a disabled button drops the focus it holds,
            so a retry that failed again left the keyboard on <body>, and a
            reopened card (already retrying) put focus on "Reload page". */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-busy={busy || undefined}
          onClick={() => {
            if (!busy) onRetry();
          }}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          {busy ? "Trying…" : "Try again"}
        </Button>
        {failures > 1 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        )}
      </div>
    </PopoverContent>
  );
}

/**
 * Keeps an error thrown while the catalogue renders inside its popover. The
 * chat around it carries on; the popover offers a retry, which draws the
 * catalogue afresh.
 */
class CatalogueBoundary extends React.Component<
  CataloguePlacement & { children: React.ReactNode },
  { failed: number; showing: boolean }
> {
  override state = { failed: 0, showing: false };
  static getDerivedStateFromError() {
    return { showing: true };
  }
  override componentDidCatch(error: unknown) {
    this.setState((s) => ({ failed: s.failed + 1 }));
    console.error("Model catalogue failed to render", error);
  }
  override render() {
    if (!this.state.showing) return this.props.children;
    return (
      <CatalogueUnavailable
        side={this.props.side}
        returnFocusTo={this.props.returnFocusTo}
        failures={this.state.failed}
        busy={false}
        onRetry={() => this.setState({ showing: false })}
      />
    );
  }
}

/** The mark the chip leads with: the Juno mark for Auto, the lab's for everything else. */
function ModelMark({ model, className }: { model: ModelInfo; className?: string }) {
  // `model-chip-mark` is a hook for `useChipFit`'s measuring, not a style.
  return isAutoModelId(model.id) ? (
    <JunoMark className={cn("model-chip-mark shrink-0", className)} />
  ) : (
    <ProviderLogo provider={model.provider} className={cn("model-chip-mark shrink-0", className)} />
  );
}

/**
 * Measures text exactly as the chip's name draws it: a hidden, unpositioned
 * copy beside the name, so it inherits every font setting the name has
 * (`tabular-nums` among them, which a canvas ignores: "GPT-6.1 Sol" came out
 * 8px short there, and the label it picked was then cut by CSS). The probe
 * leaves the document before the measure returns.
 */
function textMeasurer(beside: HTMLElement) {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;pointer-events:none;left:0;top:0";
  (beside.parentElement ?? beside).appendChild(probe);
  return {
    width(text: string) {
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    },
    done() {
      probe.remove();
    },
  };
}

const sameLabel = (a: ChipLabel | null, b: ChipLabel | null) =>
  a === b || (!!a && !!b && a.mark === b.mark && a.text === b.text && a.effort === b.effort);

/**
 * The rung of `chipLabelLadder` the composer's chip has room for (null: the
 * first rung, which the markup draws by itself, short name under `sm` and
 * full name above).
 *
 * The room is the chip's own width plus whatever the composer's controls row
 * has left over (`[data-composer-row]`, composer-shell.tsx): when the chip
 * fits, the row's slack sits beside it; when it does not, the chip has
 * already been squeezed to its slot. Either way the sum is the width this
 * label may use, and it does not change with the label, so picking a shorter
 * one never flips back. What a label needs is the chip as drawn minus the
 * name it is drawing, plus the candidate's name (measured on a canvas in the
 * chip's font) and, if it keeps one, the mark.
 */
function useChipFit({
  enabled,
  name,
  effortLabel,
  pro,
  chipRef,
  nameRef,
  deps,
}: {
  enabled: boolean;
  name: string;
  effortLabel: string | undefined;
  /** Pro is on: its word follows the name, so the name is never trimmed (model-chip-label.ts). */
  pro: boolean;
  chipRef: React.RefObject<HTMLButtonElement | null>;
  nameRef: React.RefObject<HTMLSpanElement | null>;
  deps: unknown[];
}) {
  const [fit, setFit] = React.useState<ChipLabel | null>(null);
  React.useLayoutEffect(() => {
    if (!enabled) {
      setFit(null);
      return;
    }
    const measure = () => {
      const chip = chipRef.current;
      const nameEl = nameRef.current;
      // Under 360px the name is not drawn at all (the mark stands alone).
      if (!chip || !nameEl || nameEl.getClientRects().length === 0) {
        setFit((prev) => (prev === null ? prev : null));
        return;
      }
      const chipStyle = getComputedStyle(chip);
      const gap = parseFloat(chipStyle.columnGap) || 0;
      const chipWidth = chip.getBoundingClientRect().width;
      let slack = 0;
      const row = chip.closest<HTMLElement>("[data-composer-row]");
      if (row) {
        const rowStyle = getComputedStyle(row);
        const items = [...row.children].filter((el) => el.getClientRects().length > 0);
        const used = items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
        slack =
          row.clientWidth -
          (parseFloat(rowStyle.paddingLeft) || 0) -
          (parseFloat(rowStyle.paddingRight) || 0) -
          used -
          (parseFloat(rowStyle.columnGap) || 0) * Math.max(0, items.length - 1);
      }
      const cap = parseFloat(chipStyle.maxWidth);
      const room = Math.min(Number.isFinite(cap) ? cap : Infinity, chipWidth + Math.max(0, slack));
      const mark = chip.querySelector(".model-chip-mark");
      const markCost = mark ? mark.getBoundingClientRect().width + gap : 16 + gap;
      const drawnName = nameEl.getBoundingClientRect().width;
      const effortEl = chip.querySelector(".model-chip-effort");
      const drawnEffort = effortEl ? effortEl.getBoundingClientRect().width : 0;
      // The chip without its name, mark or effort: padding, gaps, paid modes, chevron.
      const bare = chipWidth - drawnName - drawnEffort - (mark ? markCost : 0);
      const phone = !window.matchMedia("(min-width: 640px)").matches;
      const ladder = chipLabelLadder(name, { phone, effort: !!effortLabel, suffix: pro });
      const measurer = textMeasurer(nameEl);
      const effortCost = effortLabel ? measurer.width(` ${effortLabel}`) : 0;
      const at = pickChipLabel(
        ladder,
        (label) =>
          bare + (label.mark ? markCost : 0) + measurer.width(label.text) + (label.effort ? effortCost : 0) <=
          room + 0.5,
      );
      measurer.done();
      const next = at === 0 ? null : ladder[at];
      setFit((prev) => (sameLabel(prev, next) ? prev : next));
    };
    measure();
    const chip = chipRef.current;
    const row = chip?.closest<HTMLElement>("[data-composer-row]");
    if (!row || typeof ResizeObserver === "undefined") return;
    // The row for the window; its two halves for a neighbour that grows (a
    // task mode's label, a voice call's status) without the row changing.
    const observer = new ResizeObserver(() => measure());
    observer.observe(row);
    for (const el of row.children) observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` lists what else changes the label's width.
  }, [enabled, name, effortLabel, pro, ...deps]);
  return fit;
}

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
  thinking,
  inComposer = false,
  effortLabel,
  speed = "off",
  pro = false,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
  disabled?: boolean;
  /** The thinking-effort control for the chosen model. With one, the chip opens
   *  on it first and the model name inside opens the catalogue; without one
   *  (one effort, or an image/video/audio model) the chip opens the catalogue.
   *  Omit it (or pass null) when the model has one effort. */
  thinking?: React.ReactNode;
  /** The chat composer's chip: words only (C17), its popovers opening above it, over the draft. */
  inComposer?: boolean;
  /** The effort, in words, when it is not the model's usual one ("Opus Deep"): the label's third ink (C17). */
  effortLabel?: string;
  /**
   * A paid speed tier in force (Fast, or OpenAI's Ultra fast): the chip ends
   * on the thinking panel's own bolt, one or two. These multiply the price of
   * every turn and stick across chats, so they must be readable with the
   * panel closed, not only inside it.
   */
  speed?: SpeedTier;
  /** Pro mode in force: "Pro" after the effort, in the same third ink. */
  pro?: boolean;
}) {
  const router = useRouter();
  const { quota, models } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  /** The thinking panel the chip opens first, for a model with effort levels. */
  const [effortOpen, setEffortOpen] = React.useState(false);
  /**
   * Whether the catalogue has ever been opened. Once true it stays true, so
   * the chunk is fetched once and the popover keeps its exit animation.
   */
  const [catalogueMounted, setCatalogueMounted] = React.useState(false);
  /** A fresh catalogue per open: its query and cursor should not persist. */
  const [openCount, setOpenCount] = React.useState(0);
  const catalogue = useCatalogue(catalogueMounted);
  const ModelCatalogue = catalogue.component;
  /**
   * Whether the chip was last opened from the keyboard. A pointer opening
   * leaves focus on the chip (the panel is a glance, and the slider is one
   * drag away); a keyboard opening has to land INSIDE the panel, or the next
   * Tab walks to the control behind it and the panel closes with every
   * setting in it out of reach.
   */
  const openedByKeyboard = React.useRef(false);
  const effortContentRef = React.useRef<HTMLDivElement>(null);
  const focusEffortSlider = () =>
    effortContentRef.current?.querySelector<HTMLInputElement>('input[type="range"]')?.focus();

  // Both popovers open at the chip, just above it and over the composer's
  // draft (composer-menu.tsx, "Where they open"); Radix flips one below only
  // when there is no room above.
  const side = "top" as const;

  const current = isAutoModelId(value) ? AUTO_MODEL_INFO : (models.find((m) => m.id === value) ?? resolveModel(value));
  const autoSelected = isAutoModelId(value);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setCatalogueMounted(true);
      setOpenCount((n) => n + 1);
      // Opening again after a failed load is a retry in itself.
      if (!catalogue.component && catalogue.failures > 0 && !catalogue.loading) catalogue.retry();
    }
    setOpen(next);
  };

  // From the thinking panel's model name: the panel closes as the catalogue
  // opens, so two popovers on one chip are never on screen together.
  const openCatalogue = () => {
    setEffortOpen(false);
    onOpenChange(true);
  };

  /*
   * FOCUS COMES BACK TO THE CHIP after a pick. Picking a model whose thinking
   * panel differs from the current one (Auto → Claude Sonnet 5.5) remounts
   * the chip: with a panel it is drawn inside the panel's popover, without
   * one it is the catalogue's own trigger. Radix then returns focus to a
   * trigger that is no longer in the document and focus falls to <body>, so
   * a keyboard user lost their place. The chip that is mounted after the
   * pick's commit takes it instead.
   */
  const chipRef = React.useRef<HTMLButtonElement>(null);
  const refocusChip = React.useRef(false);
  React.useEffect(() => {
    if (!refocusChip.current) return;
    refocusChip.current = false;
    chipRef.current?.focus({ preventScroll: true });
  });

  const select = (m: ModelInfo) => {
    if (disabled) return;
    if (isAutoModelId(m.id)) {
      refocusChip.current = true;
      onChange(AUTO_MODEL_ID);
      setOpen(false);
      return;
    }
    if (m.comingSoon || m.unavailableReason) return;
    if (isModelLocked(m, plan)) {
      setOpen(false);
      // Say why the click went to /upgrade, and name the cheapest plan that
      // has the model, so the page is read with that card in mind.
      toast.message(`${m.name} is included from ${PLANS[modelRequiredPlan(m)].name}.`);
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    refocusChip.current = true;
    onChange(m.id);
    setOpen(false);
  };

  const name = current?.name ?? "Select model";
  // Below `sm` a lab mark leads the chip, so the lab's family word is spent
  // twice; Auto's mark names nothing, so "Auto" stays as it is.
  const shortName = current && !isAutoModelId(current.id) ? chipShortName(name) : name;
  /** The paid modes in force, in words, for the accessible name. */
  const modes = [pro ? "Pro" : null, speed === "ultra" ? "Ultra fast" : speed === "fast" ? "Fast" : null].filter(
    (mode): mode is string => !!mode,
  );

  /*
   * The label on a short row (model-chip-label.ts): the first whole label that
   * fits, so the chip never cuts a word in half. The mark goes first, then
   * the effort word (whole, and it stays in the accessible name), then whole
   * words off the end of the name; the paid modes never go. Measured in the
   * composer only; elsewhere the chip has the room it asks for.
   */
  const nameRef = React.useRef<HTMLSpanElement>(null);
  const fit = useChipFit({
    enabled: inComposer && !!current && !isAutoModelId(current.id),
    name,
    effortLabel,
    pro,
    chipRef,
    nameRef,
    deps: [speed],
  });
  const showEffort = !!effortLabel && (!fit || fit.effort);

  const chip = (
    <button
      ref={chipRef}
      type="button"
      disabled={disabled}
      aria-label={`Model: ${name}${effortLabel ? `, ${effortLabel}` : ""}${modes.map((mode) => `, ${mode}`).join("")}`}
      onPointerEnter={prefetchCatalogue}
      onFocus={prefetchCatalogue}
      onPointerDown={() => {
        openedByKeyboard.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          // The click that follows opens the popover (Radix's own trigger).
          openedByKeyboard.current = true;
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          // A menu button's arrows open it, as the + menu's do.
          if (disabled) return;
          event.preventDefault();
          openedByKeyboard.current = true;
          if (thinking && effortOpen) {
            // Opened by pointer a moment ago, focus still on the chip: step in.
            focusEffortSlider();
          } else if (thinking) {
            prefetchCatalogue();
            setEffortOpen(true);
          } else {
            onOpenChange(true);
          }
        }
      }}
      // The shared composer chip: flat text, a tone under the pointer and
      // while open. In the chat composer it is words only (C17): the short
      // name in the second ink, the effort in the third when it is not the
      // usual one, one chevron. No logo, no pill, no border. 44px under a
      // coarse pointer, like the + and the mic beside it (composer.css asks
      // for it too, but the shared chip's own `coarse:h-10` comes later).
      className={cn(
        composerChipClass,
        // In the composer the chip's label is measured against the room the
        // row really has (useChipFit), so a phone's cap is the desktop's: at
        // 11.5rem a 430px phone with room to spare still cut "Kimi K3.1 Pro
        // Highspeed" to "Kimi K3.1 Pro…", hiding the word that sets it apart.
        // Elsewhere CSS truncation still needs the narrower cap.
        inComposer ? "max-w-[16rem]" : "max-w-[11.5rem] sm:max-w-[16rem]",
        // A phone row's chip is short of room by a few pixels, so its own
        // padding and gaps give some back before the label has to.
        inComposer && "composer-model-chip coarse:h-11 max-sm:gap-1 max-sm:pl-2 max-sm:pr-1",
      )}
    >
      {current && (!fit || fit.mark) ? <ModelMark model={current} className="size-3.5" /> : null}
      {/* The name gives way, never the words after it: the name is the one
          part that can shrink (and only as a last resort, past the shortest
          whole label), the effort and Pro keep their width. */}
      {/* Proportional figures: the composer around it sets tabular ones,
          which made Inter's hyphen as wide as a digit ("GPT - 5"). */}
      <span aria-hidden="true" translate="no" className="flex min-w-0 items-baseline normal-nums max-[359px]:hidden">
        <span ref={nameRef} key={current?.id ?? "no-model"} className="min-w-0 truncate motion-safe:animate-fade-in">
          {fit ? (
            fit.text
          ) : shortName === name ? (
            name
          ) : (
            <>
              <span className="sm:hidden">{shortName}</span>
              <span className="hidden sm:inline">{name}</span>
            </>
          )}
        </span>
        {showEffort ? (
          <span className="model-chip-effort composer-model-chip__effort shrink-0 whitespace-pre"> {effortLabel}</span>
        ) : null}
        {/* No space before "Pro" when the name has stepped out (the mark leads alone). */}
        {pro ? <span className="composer-model-chip__effort shrink-0 whitespace-pre">{fit && fit.text === "" ? "Pro" : " Pro"}</span> : null}
      </span>
      {speed !== "off" ? (
        // The panel's own bolt, so the chip and the switch that set it read
        // as one thing: one bolt for Fast, two for Ultra fast.
        <SpeedGlyph
          tier={speed}
          className={cn("shrink-0 text-muted-foreground", speed === "ultra" ? "w-[18px]" : "w-3.5")}
          boltClassName="size-3.5"
        />
      ) : null}
      <ChevronDown className={composerChevronClass} motion="none" />
    </button>
  );

  return (
    <Popover open={open && !disabled} onOpenChange={onOpenChange}>
      {thinking ? (
        // Thinking first (owner): the chip opens the effort panel; its model
        // name opens the catalogue. The catalogue's popover is anchored to the
        // span around the chip, because the chip is already the panel's
        // trigger and two Radix triggers on one element fight over data-state.
        <PopoverAnchor asChild>
          <span className="inline-flex min-w-0">
            <Popover
              open={effortOpen && !disabled}
              onOpenChange={(next) => {
                if (next) prefetchCatalogue();
                setEffortOpen(next);
              }}
            >
              <PopoverTrigger asChild>{chip}</PopoverTrigger>
              <PopoverContent
                ref={effortContentRef}
                align="end"
                side={side}
                sideOffset={8}
                collisionPadding={COMPOSER_MENU_COLLISION_PADDING}
                className="w-[min(18.5rem,calc(100vw-1.5rem))] rounded-menu p-3"
                aria-label="Thinking"
                // By pointer, focus stays on the chip. By keyboard it lands on
                // the slider: arrows change the rung, Shift+Tab reaches reset,
                // the model name and the speed / Pro switches, Esc returns to
                // the chip.
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  if (openedByKeyboard.current) focusEffortSlider();
                }}
              >
                <EffortPanelContext.Provider value={{ modelName: current?.name ?? "Model", onOpenModels: openCatalogue }}>
                  {thinking}
                </EffortPanelContext.Provider>
              </PopoverContent>
            </Popover>
          </span>
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
      )}

      {catalogueMounted &&
        (ModelCatalogue ? (
          <CatalogueBoundary side={inComposer ? side : undefined} returnFocusTo={thinking ? chipRef : undefined}>
            <ModelCatalogue
              key={openCount}
              value={value}
              current={current}
              autoSelected={autoSelected}
              filter={modelFilter}
              onPick={select}
              side={inComposer ? side : undefined}
              // Opened from the thinking panel, the catalogue's popover has
              // an anchor and no trigger: Escape hands focus to the chip.
              returnFocusTo={thinking ? chipRef : undefined}
            />
          </CatalogueBoundary>
        ) : catalogue.failures > 0 ? (
          <CatalogueUnavailable
            side={inComposer ? side : undefined}
            returnFocusTo={thinking ? chipRef : undefined}
            failures={catalogue.failures}
            busy={catalogue.loading}
            onRetry={catalogue.retry}
          />
        ) : null)}
    </Popover>
  );
}
