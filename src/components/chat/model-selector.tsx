"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import nextDynamic from "next/dynamic";
import { ChevronDown } from "@/components/ui/icons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EffortPanelContext } from "@/components/chat/reasoning-slider";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { useApp } from "@/components/app/app-provider";
import { isModelLocked, pushRecent } from "@/lib/model-picker";
import { PLANS, modelRequiredPlan } from "@/lib/plans";
import { toast } from "sonner";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { COMPOSER_MENU_COLLISION_PADDING } from "@/components/chat/composer-menu";
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
 */
const ModelCatalogue = nextDynamic(
  () => import("@/components/chat/model-catalogue").then((m) => m.ModelCatalogue),
  { ssr: false },
);

/** Warm the catalogue chunk before the chip is pressed. Deduped by webpack. */
function prefetchCatalogue() {
  void import("@/components/chat/model-catalogue");
}

/** The mark the chip leads with: the Juno mark for Auto, the lab's for everything else. */
function ModelMark({ model, className }: { model: ModelInfo; className?: string }) {
  return isAutoModelId(model.id) ? (
    <JunoMark className={cn("shrink-0", className)} />
  ) : (
    <ProviderLogo provider={model.provider} className={cn("shrink-0", className)} />
  );
}

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
  thinking,
  inComposer = false,
  effortLabel,
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
    }
    setOpen(next);
  };

  // From the thinking panel's model name: the panel closes as the catalogue
  // opens, so two popovers on one chip are never on screen together.
  const openCatalogue = () => {
    setEffortOpen(false);
    onOpenChange(true);
  };

  const select = (m: ModelInfo) => {
    if (disabled) return;
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      setOpen(false);
      return;
    }
    if (m.comingSoon) return;
    if (isModelLocked(m, plan)) {
      setOpen(false);
      // Say why the click went to /upgrade, and name the cheapest plan that
      // has the model, so the page is read with that card in mind.
      toast.message(`${m.name} is included from ${PLANS[modelRequiredPlan(m)].name}.`);
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    onChange(m.id);
    setOpen(false);
  };

  const chip = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Model: ${current?.name ?? "Select model"}${effortLabel ? `, ${effortLabel}` : ""}`}
      onPointerEnter={prefetchCatalogue}
      onFocus={prefetchCatalogue}
      // The shared composer chip: flat text, a tone under the pointer and
      // while open. In the chat composer it is words only (C17): the short
      // name in the second ink, the effort in the third when it is not the
      // usual one, one chevron. No logo, no pill, no border.
      className={cn(composerChipClass, "max-w-[9rem] sm:max-w-[16rem]", inComposer && "composer-model-chip")}
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
                align="end"
                side={side}
                sideOffset={8}
                collisionPadding={COMPOSER_MENU_COLLISION_PADDING}
                className="w-[min(18.5rem,calc(100vw-1.5rem))] rounded-menu p-3"
                aria-label="Thinking"
                onOpenAutoFocus={(event) => event.preventDefault()}
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

      {catalogueMounted && (
        <ModelCatalogue
          key={openCount}
          value={value}
          current={current}
          autoSelected={autoSelected}
          filter={modelFilter}
          onPick={select}
          side={inComposer ? side : undefined}
        />
      )}
    </Popover>
  );
}
