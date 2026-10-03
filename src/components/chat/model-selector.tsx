"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import nextDynamic from "next/dynamic";
import { ChevronDown } from "@/components/ui/icons";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { useApp } from "@/components/app/app-provider";
import { isModelLocked, pushRecent } from "@/lib/model-picker";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

/**
 * The model control: a chip that opens the catalogue.
 *
 * The chip opens the full catalogue (model-catalogue.tsx) straight away,
 * whatever kind of model is selected: search, every lab, each lab's Text /
 * Image / Video / Audio sections, and the selected model already in view and
 * highlighted. There used to be a first stage between the two, a short menu
 * of Auto, favourites and recents with "All models" under it (and, for a
 * thinking model, the effort slider in front of even that). The owner asked
 * for it to go: on a video or image thread it put a list of chat models
 * between the chip and the model you were looking for. Favourites still lead
 * the catalogue's All view, and the thinking effort for the selected model
 * sits at the foot of the catalogue's list.
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
  /** The thinking-effort control for the chosen model, drawn at the foot of
   *  the catalogue's list. Omit it (or pass null) when the model has one effort. */
  thinking?: React.ReactNode;
  /** Composer placement (the chat composer); other callers keep the chip-anchored popover. */
  layer?: ModelSelectorLayer;
  /** The effort, in words, when it is not the model's usual one ("Opus Deep"): the label's third ink (C17). */
  effortLabel?: string;
}) {
  const router = useRouter();
  const { quota, models } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  /**
   * Whether the catalogue has ever been opened. Once true it stays true, so
   * the chunk is fetched once and the popover keeps its exit animation.
   */
  const [catalogueMounted, setCatalogueMounted] = React.useState(false);
  /** A fresh catalogue per open: its query and cursor should not persist. */
  const [openCount, setOpenCount] = React.useState(0);

  // The catalogue opens above the chip in the composer, as the menu did.
  const side = "top" as const;
  const onSide = layer?.onSide;
  React.useEffect(() => {
    onSide?.(open ? side : null);
  }, [onSide, open, side]);

  const current = isAutoModelId(value) ? AUTO_MODEL_INFO : (models.find((m) => m.id === value) ?? resolveModel(value));
  const autoSelected = isAutoModelId(value);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setCatalogueMounted(true);
      setOpenCount((n) => n + 1);
    }
    setOpen(next);
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
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    onChange(m.id);
    setOpen(false);
  };

  return (
    <Popover open={open && !disabled} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>

      {catalogueMounted && (
        <ModelCatalogue
          key={openCount}
          value={value}
          current={current}
          autoSelected={autoSelected}
          filter={modelFilter}
          onPick={select}
          thinking={thinking}
          side={layer ? side : undefined}
        />
      )}
    </Popover>
  );
}
