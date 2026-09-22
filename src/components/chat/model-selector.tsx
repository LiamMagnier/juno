"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import nextDynamic from "next/dynamic";
import { ChevronDown, ChevronUp } from "@/components/ui/icons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { useApp } from "@/components/app/app-provider";
import { isModelLocked, pushRecent } from "@/lib/model-picker";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

/**
 * The model control, in two stages.
 *
 * STAGE ONE is this file, and it is the only thing most turns need: the model
 * you are on, and how hard it should think. Effort is the setting that changes
 * between messages; which model you are using changes a few times a day.
 * Opening a 680px catalogue to move a slider was answering the rare question
 * first — ChatGPT's menu has the same shape for the same reason.
 *
 * STAGE TWO is the catalogue (model-catalogue.tsx), and the model row in stage
 * one is its door: a row carrying the current model with an arrow pointing UP,
 * which is where the bigger surface comes from. Two popovers rather than one
 * with swapping content, because the two sizes are far apart (a ~150px card
 * against a 460px panel) and a box that resizes by 300px under the pointer
 * reads as a glitch.
 *
 * ── The catalogue is fetched, not bundled ────────────────────────────────
 *
 * It was the same component and it shipped with the composer, so every chat
 * screen downloaded three panes, sixteen lab marks and a detail panel to draw
 * a 150px card. Moving the catalogue's own state into the catalogue is what
 * made the split possible; `PREFETCH` is what makes it invisible.
 *
 * A dynamic import alone would put a chunk fetch between "Change model" and
 * the catalogue appearing. But stage two is only reachable THROUGH stage one,
 * so the moment the chip opens — hundreds of milliseconds before anyone can
 * reach the row that opens the catalogue — is a free place to start the
 * fetch. Webpack dedupes it against the `nextDynamic` import below, so the
 * two are one request.
 *
 * `MOUNTED`, not `pickerOpen`, gates the render: unmounting on close would cut
 * the popover's exit animation, and Radix already unmounts its own content
 * when closed, so keeping the component mounted after the first open costs
 * nothing and keeps the catalogue's state (its query, its cursor) honest —
 * it is re-created per open by `key`.
 */
const ModelCatalogue = nextDynamic(
  () => import("@/components/chat/model-catalogue").then((m) => m.ModelCatalogue),
  { ssr: false },
);

/** Warm the catalogue chunk while stage one is open. Deduped by webpack. */
function prefetchCatalogue() {
  void import("@/components/chat/model-catalogue");
}

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
  thinking,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
  disabled?: boolean;
  /** The thinking-effort control for the chosen model, drawn as a footer
   *  under the panes. Omit it (or pass null) when the model has one effort. */
  thinking?: React.ReactNode;
}) {
  const router = useRouter();
  const { quota, models } = useApp();
  const plan = quota.plan;
  /** Stage one: the model + effort card the composer chip opens. */
  const [open, setOpen] = React.useState(false);
  /** Stage two: the catalogue, opened from stage one's model row. */
  const [pickerOpen, setPickerOpen] = React.useState(false);
  /**
   * Whether the catalogue has ever been opened. Once true it stays true, so
   * the chunk is fetched once and the popover keeps its exit animation.
   */
  const [catalogueMounted, setCatalogueMounted] = React.useState(false);
  /** A fresh catalogue per open — its query and cursor should not persist. */
  const [openCount, setOpenCount] = React.useState(0);

  const current = isAutoModelId(value) ? AUTO_MODEL_INFO : (models.find((m) => m.id === value) ?? resolveModel(value));
  const autoSelected = isAutoModelId(value);

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
      type="button"
      disabled={disabled}
      aria-label={`Model: ${current?.name ?? "Select model"}`}
      // The shared composer chip: flat text, accent fill on hover and while
      // open. The name is set in the UI face, not mono — it is a label on a
      // control, not a value in a table.
      className={cn(composerChipClass, "max-w-[9rem] sm:max-w-[16rem]")}
    >
      {autoSelected ? (
        <JunoMark className="size-3.5 shrink-0 rounded-sm sm:size-4" />
      ) : current ? (
        <ProviderLogo provider={current.provider} className="size-3.5 shrink-0 rounded-sm sm:size-4" />
      ) : null}
      <span
        key={current?.id ?? "no-model"}
        aria-hidden="true"
        className="min-w-0 truncate motion-safe:animate-fade-in max-[359px]:hidden"
      >
        {current?.name ?? "Select model"}
      </span>
      <ChevronDown className={composerChevronClass} />
    </button>
  );

  return (
    // Stage two WRAPS stage one, so its anchor is the span around the chip.
    // Anchoring it to the chip itself is not possible — the chip is already
    // stage one's trigger, and two Radix triggers on one element fight over
    // its `data-state`, leaving the chip stuck open-looking after a close.
    <Popover open={pickerOpen && !disabled} onOpenChange={setPickerOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex min-w-0">
      {/* ── Stage one ──────────────────────────────────────────────────
          What the chip opens, and all most turns need: which model, and how
          hard it thinks. The model row is the door to stage two, and its
          arrow points UP because that is where the catalogue appears. */}
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          // The one place the catalogue chunk can be fetched for free: the
          // row that opens it is inside the card this opens.
          if (next) prefetchCatalogue();
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={16}
          className="w-[min(24rem,calc(100vw-2rem))] max-w-none rounded-popover p-1.5"
        >
          <button
            type="button"
            onClick={openCatalogue}
            className={cn(
              "flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left outline-none",
              "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
              "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          >
            {autoSelected ? (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card">
                <JunoMark className="size-3" />
              </span>
            ) : current ? (
              <ProviderLogo provider={current.provider} className="size-5 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-foreground">
                {current?.name ?? "Select model"}
              </span>
              <span className="block font-mono text-micro text-muted-foreground/60">Change model</span>
            </span>
            <ChevronUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>

          {thinking && (
            <>
              <div aria-hidden className="mx-2 my-1.5 h-px bg-border/70" />
              {/* No eyebrow here any more: the slider draws its own, on the
                  same line as the rung it names. Two surfaces cannot both own
                  one label without one of them eventually saying something
                  the other does not. */}
              <div className="px-2 pb-1">{thinking}</div>
            </>
          )}
        </PopoverContent>
      </Popover>
        </span>
      </PopoverAnchor>

      {/* ── Stage two: the catalogue ───────────────────────────────── */}
      {catalogueMounted && (
        <ModelCatalogue
          key={openCount}
          value={value}
          current={current}
          autoSelected={autoSelected}
          filter={modelFilter}
          onPick={select}
        />
      )}
    </Popover>
  );
}
