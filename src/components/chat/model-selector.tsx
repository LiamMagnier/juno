"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import nextDynamic from "next/dynamic";
import { ArrowLeft, ChevronDown, ChevronRight, LayoutGrid, Lock } from "@/components/ui/icons";
import { EffortPanelContext } from "@/components/chat/reasoning-slider";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { menuGlyphInkClass, menuRowClass, menuSeparatorClass } from "@/components/ui/menu-recipe";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { useApp } from "@/components/app/app-provider";
import { isModelLocked, pushRecent, quickListModels, readRecent } from "@/lib/model-picker";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * The model control, in two stages.
 *
 * STAGE ONE is this file, and it is the only thing most turns need: a short
 * menu of the models you actually use (Auto, your favourites, the last few you
 * picked, and always the one you are on), then "More models", then how hard
 * the model should think. Switching between two models you use is two clicks,
 * the way Claude and ChatGPT do it. It used to be three: the chip opened a card
 * holding one "current model" row, that row opened the catalogue, and the pick
 * happened inside a 600px, three-pane surface built for browsing.
 *
 * STAGE TWO is the catalogue (model-catalogue.tsx), for finding a model you do
 * not use yet. "More models" opens it in place of the menu. Two popovers rather
 * than one with swapping content, because the two sizes are far apart (a
 * 288px menu against a 600px panel) and a box that resizes by 300px under the
 * pointer reads as a glitch.
 *
 * ── The catalogue is fetched, not bundled ────────────────────────────────
 *
 * It shipped with the composer once, so every chat screen downloaded three
 * panes, sixteen lab marks and a detail panel to draw a menu. Its state lives
 * in its own module, which is what makes the dynamic import below buy
 * anything, and `prefetchCatalogue` makes the split invisible: stage two is
 * only reachable THROUGH stage one, so the moment the menu opens, hundreds of
 * milliseconds before anyone can reach "More models", is a free place to
 * start the fetch. Webpack dedupes it against the `nextDynamic` import, so
 * the two are one request.
 *
 * `catalogueMounted`, not `pickerOpen`, gates the render: unmounting on close
 * would cut the popover's exit animation, and Radix already unmounts its own
 * content when closed. The catalogue is re-created per open by `key`, so its
 * query and cursor never persist.
 *
 * Anything both stages need lives in `lib/model-picker.ts`, never in either
 * component file: one static import between the two undoes the split.
 */
const ModelCatalogue = nextDynamic(
  () => import("@/components/chat/model-catalogue").then((m) => m.ModelCatalogue),
  { ssr: false },
);

/** Warm the catalogue chunk while stage one is open. Deduped by webpack. */
function prefetchCatalogue() {
  void import("@/components/chat/model-catalogue");
}

/** The mark a model row leads with: the Juno mark for Auto, the lab's for everything else. */
function ModelMark({ model, className }: { model: ModelInfo; className?: string }) {
  return isAutoModelId(model.id) ? (
    <JunoMark className={cn("shrink-0", className)} />
  ) : (
    <ProviderLogo provider={model.provider} className={cn("shrink-0", className)} />
  );
}

/** A model row's second line: what it is for, in a few words. */
/** The first clause of a description: "Anthropic's newest Opus: long-running
 *  agentic coding…" reads "Anthropic's newest Opus". A full sentence cut off
 *  by an ellipsis on every row was most of the menu's noise. */
function firstClause(text: string): string {
  const cut = text.split(/[:.;—(]| - /)[0]?.trim() ?? "";
  return cut.length > 44 ? `${cut.slice(0, 42).trimEnd()}…` : cut;
}

function modelLine(model: ModelInfo): string | undefined {
  if (isAutoModelId(model.id)) return "Picks the right model for each message";
  const what = model.description?.trim() ? firstClause(model.description.trim()) : "";
  if (model.cost === 3) return what ? `${what} · uses more of your limit` : "Uses more of your limit";
  return what || undefined;
}

/** Where the typeahead buffer resets: long enough to type "gpt", short enough that a pause starts over. */
const TYPEAHEAD_RESET_MS = 600;

/**
 * Stage one's menu, as a presentational component: rows in, picks out.
 *
 * Exported so `/dev/library` can draw it open from fixtures; the selector below
 * is the only production caller.
 *
 * MENU SEMANTICS, written out rather than borrowed from Radix's DropdownMenu,
 * because a menu is only half of this surface. Radix's menu owns Tab (it
 * swallows it, as the ARIA menu pattern says), and the thinking slider under
 * the list has to be reachable with Tab and drivable with its own arrow keys.
 * So the list is `role="menu"` with `menuitemradio` rows and one roving tab
 * stop, arrow keys and Home/End move between rows, typing a name's first
 * letters jumps to it, and Tab leaves the list for the slider. The pointer
 * and the keyboard share ONE highlight: hovering a row focuses it, which is
 * what Radix does too, so a stationary pointer and the arrow keys can never
 * light two rows at once.
 */
export function ModelQuickMenu({
  models,
  showAuto,
  value,
  isLocked,
  onPick,
  onMore,
  thinking,
  initialFocus = "checked",
}: {
  /** The model rows under Auto, in order. */
  models: ModelInfo[];
  showAuto: boolean;
  value: ModelId;
  isLocked: (model: ModelInfo) => boolean;
  onPick: (model: ModelInfo) => void;
  onMore: () => void;
  thinking?: React.ReactNode;
  /**
   * Opened from the keyboard, focus lands on the checked row, ready for the
   * arrow keys. Opened with the pointer, it lands on the list itself, so no
   * row is lit until the pointer or a key chooses one.
   */
  initialFocus?: "checked" | "menu" | "none";
}) {
  const menuRef = React.useRef<HTMLDivElement>(null);
  const typeahead = React.useRef({ buffer: "", timer: 0 });
  const autoSelected = isAutoModelId(value);
  const rows = showAuto ? [AUTO_MODEL_INFO, ...models] : models;
  const checkedId = autoSelected ? AUTO_MODEL_INFO.id : value;
  // The one tab stop: the row keyboard focus last sat on, else the checked one.
  const [tabStop, setTabStop] = React.useState<string>(() =>
    rows.some((m) => m.id === checkedId) ? checkedId : (rows[0]?.id ?? "more"),
  );

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-quick-item]:not([disabled])") ?? []);

  React.useEffect(() => {
    if (initialFocus === "none") return;
    const menu = menuRef.current;
    if (!menu) return;
    if (initialFocus === "menu") {
      menu.focus({ preventScroll: true });
      return;
    }
    const target = items().find((el) => el.dataset.quickItem === checkedId) ?? items()[0];
    target?.focus({ preventScroll: true });
    // Mount only: the menu is re-created per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at < 0 ? list.length - 1 : at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.key === " ") return;
    // Typeahead: the letters typed within the reset window, matched against
    // the start of each row's name, searching forward from the focused row so
    // pressing "g" twice walks through every model starting with G.
    const state = typeahead.current;
    window.clearTimeout(state.timer);
    state.buffer += event.key.toLowerCase();
    state.timer = window.setTimeout(() => {
      state.buffer = "";
    }, TYPEAHEAD_RESET_MS);
    // One letter, or the same letter again ("gg"), steps to the NEXT match;
    // a longer word keeps refining from the row already found.
    const cycling = /^(.)\1*$/.test(state.buffer);
    const needle = cycling ? state.buffer[0] : state.buffer;
    const start = cycling ? at + 1 : Math.max(at, 0);
    const ordered = [...list.slice(start), ...list.slice(0, start)];
    const hit = ordered.find((el) => (el.dataset.label ?? "").toLowerCase().startsWith(needle));
    if (hit) {
      event.preventDefault();
      hit.focus();
    }
  };

  const itemProps = (id: string, label: string) => ({
    "data-quick-item": id,
    "data-label": label,
    tabIndex: tabStop === id ? 0 : -1,
    onFocus: () => setTabStop(id),
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
    },
  });

  // Rows light on focus, never on hover: hover moves focus (above), so the
  // fill always marks the one row Enter would pick.
  const rowClass = cn(menuRowClass, menuGlyphInkClass, "w-full text-left focus:bg-accent");

  return (
    <div>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Models"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        // The pointer leaving the list takes the highlight with it, as it does
        // in every other menu in the product.
        onPointerLeave={() => {
          if (menuRef.current?.contains(document.activeElement)) menuRef.current.focus({ preventScroll: true });
        }}
        className="outline-none"
      >
        {rows.map((model) => {
          const checked = model.id === checkedId;
          const locked = isLocked(model);
          return (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              onClick={() => onPick(model)}
              className={rowClass}
              {...itemProps(model.id, model.name)}
            >
              <ModelMark model={model} className="size-4 self-start mt-0.5" />
              {/* The name, and one line saying what it is good at (MP1). A
                  model that uses much more of the allowance says so in words. */}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" translate="no">
                  {model.name}
                </span>
                {modelLine(model) ? (
                  <span className="truncate text-caption text-muted-foreground">{modelLine(model)}</span>
                ) : null}
              </span>
              {locked && <span className="sr-only">Needs an upgrade</span>}
              <span aria-hidden="true" className="flex w-4 shrink-0 items-center justify-center">
                {checked ? (
                  <StatusIcons.success className="size-3.5 text-primary" />
                ) : locked ? (
                  <Lock className="size-3.5 text-muted-foreground" />
                ) : null}
              </span>
            </button>
          );
        })}

        {rows.length > 0 && <div role="separator" className={menuSeparatorClass} />}

        <button
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          onClick={onMore}
          className={rowClass}
          {...itemProps("more", "All models")}
        >
          <LayoutGrid className="size-4" />
          <span className="min-w-0 flex-1 truncate">All models</span>
          <ChevronRight motion="none" className="size-3.5" />
        </button>
      </div>

      {thinking && (
        <>
          <div aria-hidden="true" className={menuSeparatorClass} />
          {/* The slider draws its own eyebrow, on the same line as the rung it
              names. It sits outside the menu element: it is a slider, not a
              menu item, and Tab reaches it from the list. */}
          <div className="px-2.5 pb-1.5 pt-1">{thinking}</div>
        </>
      )}
    </div>
  );
}

/**
 * How the chat composer places this control's popovers: OUTSIDE its own box,
 * never over the draft or the composer's buttons (critique 1; INTERACTION_SPEC
 * MP1). The popover is anchored to a virtual rect with the chip's x and the
 * composer's full height, so Radix's own flip and shift keep it on screen
 * while either side it lands on is clear of the composer.
 */
export interface ModelSelectorLayer {
  /** The composer surface. */
  box: React.RefObject<HTMLElement | null>;
  /** The side to open toward, chosen when it opens (below on the home, above in the dock, by room). */
  pickSide: (need: number) => "top" | "bottom";
  /** The side a popover is open on, or null when none is (the home moves its suggestions aside). */
  onSide?: (side: "top" | "bottom" | null) => void;
}

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
  thinking,
  layer,
  effortLabel,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
  disabled?: boolean;
  /** The thinking-effort control for the chosen model, drawn under the menu.
   *  Omit it (or pass null) when the model has one effort. */
  thinking?: React.ReactNode;
  /** Composer placement (the chat composer); other callers keep the chip-anchored popover. */
  layer?: ModelSelectorLayer;
  /** The effort, in words, when it is not the model's usual one ("Opus Deep"): the label's third ink (C17). */
  effortLabel?: string;
}) {
  const router = useRouter();
  const { quota, models, settings } = useApp();
  const plan = quota.plan;
  /** Stage one: the menu the composer chip opens. */
  const [open, setOpen] = React.useState(false);
  /** With an effort control the chip opens on Thinking; the model name inside switches to the list. */
  const [view, setView] = React.useState<"effort" | "models">("effort");
  /** Stage two: the catalogue, opened from "More models". */
  const [pickerOpen, setPickerOpen] = React.useState(false);
  /**
   * Whether the catalogue has ever been opened. Once true it stays true, so
   * the chunk is fetched once and the popover keeps its exit animation.
   */
  const [catalogueMounted, setCatalogueMounted] = React.useState(false);
  /** A fresh catalogue per open: its query and cursor should not persist. */
  const [openCount, setOpenCount] = React.useState(0);
  /** Read when the menu opens, not per render: it is localStorage. */
  const [recent, setRecent] = React.useState<string[]>([]);
  /** Opened by the pointer or the keyboard, which decides where focus lands. */
  const [openedWith, setOpenedWith] = React.useState<"pointer" | "keyboard">("pointer");

  const chipRef = React.useRef<HTMLButtonElement>(null);
  /** Where the popovers open: chosen as they open, so a short window picks the side with room. */
  const [side, setSide] = React.useState<"top" | "bottom">("top");
  const onSide = layer?.onSide;
  React.useEffect(() => {
    onSide?.(open || pickerOpen ? side : null);
  }, [onSide, open, pickerOpen, side]);

  const current = isAutoModelId(value) ? AUTO_MODEL_INFO : (models.find((m) => m.id === value) ?? resolveModel(value));
  const autoSelected = isAutoModelId(value);

  const quickModels = React.useMemo(
    () =>
      quickListModels({
        models,
        favorites: settings.favoriteModels ?? [],
        recent,
        currentId: autoSelected ? null : value,
        filter: modelFilter,
      }),
    [models, settings.favoriteModels, recent, autoSelected, value, modelFilter],
  );
  const showAuto = modelFilter ? modelFilter(AUTO_MODEL_INFO) : true;

  const closeAll = () => {
    setPickerOpen(false);
    setOpen(false);
  };

  const openCatalogue = () => {
    // Stage one closes as stage two opens: two popovers anchored to one chip
    // must never be on screen together.
    setOpen(false);
    setCatalogueMounted(true);
    setOpenCount((n) => n + 1);
    setPickerOpen(true);
  };

  const select = (m: ModelInfo) => {
    if (disabled) return;
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      closeAll();
      return;
    }
    if (m.comingSoon) return;
    if (isModelLocked(m, plan)) {
      closeAll();
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    onChange(m.id);
    closeAll();
  };

  const chip = (
    <button
      ref={chipRef}
      type="button"
      disabled={disabled}
      aria-label={`Model: ${current?.name ?? "Select model"}${effortLabel ? `, ${effortLabel}` : ""}`}
      onPointerDown={() => setOpenedWith("pointer")}
      onKeyDown={() => setOpenedWith("keyboard")}
      // The shared composer chip: flat text, a tone under the pointer and
      // while open. In the chat composer it is words only (C17): the short
      // name in the second ink, the effort in the third when it is not the
      // usual one, one chevron. No logo, no pill, no border.
      className={cn(composerChipClass, "max-w-[9rem] sm:max-w-[16rem]", layer && "composer-model-chip")}
    >
      {current ? <ModelMark model={current} className="size-3.5" /> : null}
      <span
        key={current?.id ?? "no-model"}
        aria-hidden="true"
        translate="no"
        className="min-w-0 truncate motion-safe:animate-fade-in max-[359px]:hidden"
      >
        {current?.name ?? "Select model"}
        {effortLabel ? <span className="composer-model-chip__effort"> {effortLabel}</span> : null}
      </span>
      <ChevronDown className={composerChevronClass} motion="none" />
    </button>
  );

  return (
    // Stage two WRAPS stage one, so its anchor is the span around the chip.
    // Anchoring it to the chip itself is not possible: the chip is already
    // stage one's trigger, and two Radix triggers on one element fight over
    // its `data-state`, leaving the chip stuck open-looking after a close.
    <Popover open={pickerOpen && !disabled} onOpenChange={setPickerOpen}>

      {/* Anchored to the CHIP, opening upward over the composer (owner: "why
          does it stay under the composer instead of overhanging it"). It used
          to anchor to the composer's whole box and sit outside it. */}
      <AnchorSpan virtual={false}>
          <Popover
            open={open && !disabled}
            onOpenChange={(next) => {
              if (next) {
                setView(thinking ? "effort" : "models");
                // The one place the catalogue chunk can be fetched for free:
                // the row that opens it is inside the menu this opens.
                prefetchCatalogue();
                setRecent(readRecent());
                setSide("top");
              }
              setOpen(next);
            }}
          >
      
            <PopoverTrigger asChild>{chip}</PopoverTrigger>
            <PopoverContent
              align="end"
              side={layer ? side : "top"}
              sideOffset={8}
              collisionPadding={12}
              // The menu rung, not the popover's: this is a list of rows, and
              // a 14px shell with p-1 holds the rows' 10px corners concentric.
              // In the composer it is capped to the room on its side, so a
              // short window scrolls the list rather than covering the draft.
              className={cn(
                "rounded-menu",
                thinking && view === "effort"
                  ? "w-[min(18.5rem,calc(100vw-1.5rem))] p-3"
                  : cn(
                      "w-72 p-1.5",
                      layer && "w-[min(21.5rem,calc(100vw-1.5rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain",
                    ),
              )}
              // Radix makes the content a dialog; a dialog needs a name.
              aria-label={thinking && view === "effort" ? "Thinking" : "Model"}
              // The menu places focus itself (see `initialFocus`).
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              {thinking && view === "effort" ? (
                <div key="effort" className="motion-safe:animate-fade-in">
                  <EffortPanelContext.Provider
                    value={{ modelName: current?.name ?? "Model", onOpenModels: openCatalogue }}
                  >
                    {thinking}
                  </EffortPanelContext.Provider>
                </div>
              ) : (
                <div key="models" className="motion-safe:animate-fade-in">
                  {thinking ? (
                    <button
                      type="button"
                      onClick={() => setView("effort")}
                      className={cn(menuRowClass, "w-full text-left text-muted-foreground hover:bg-accent hover:text-foreground")}
                    >
                      <ArrowLeft className="size-4" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">Thinking</span>
                    </button>
                  ) : null}
                  <ModelQuickMenu
                    models={quickModels}
                    showAuto={showAuto}
                    value={value}
                    isLocked={(m) => isModelLocked(m, plan)}
                    onPick={select}
                    onMore={openCatalogue}
                    initialFocus={openedWith === "pointer" ? "menu" : "checked"}
                  />
                </div>
              )}
            </PopoverContent>
          </Popover>
      </AnchorSpan>

      {/* ── Stage two: the catalogue ───────────────────────────────── */}
      {catalogueMounted && (
        <ModelCatalogue
          key={openCount}
          value={value}
          current={current}
          autoSelected={autoSelected}
          filter={modelFilter}
          onPick={select}
          side={layer ? side : undefined}
        />
      )}
    </Popover>
  );
}

/**
 * The span around the chip. Stage two is anchored to it when the chip's own
 * popover is (stage two WRAPS stage one: two Radix triggers on one element
 * fight over its `data-state`); in the composer both are anchored to the
 * virtual rect instead, and the span is only layout.
 */
function AnchorSpan({ virtual, children }: { virtual: boolean; children: React.ReactNode }) {
  const span = <span className="inline-flex min-w-0">{children}</span>;
  return virtual ? span : <PopoverAnchor asChild>{span}</PopoverAnchor>;
}
