"use client";

import * as React from "react";
import { ChevronDown, Search, Star } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { choiceTriggerClass } from "@/components/settings/choice-menu";
import { AUTO_MODEL_ID_SETTING, providerName, type PickerModel } from "@/components/settings/model-list";
import { PLANS, canUseModel, modelRequiredPlan } from "@/lib/plans";
import { cn } from "@/lib/utils";
import type { ClientQuota } from "@/types/chat";

/** One row of the list, in the order the keyboard walks it. */
type Row =
  | { kind: "auto"; id: string }
  | { kind: "header"; id: string; provider: PickerModel["provider"] }
  | { kind: "model"; id: string; model: PickerModel; locked: boolean }
  | { kind: "older"; id: string; count: number };

/**
 * A searchable list of the chat models, grouped by lab, in a popover.
 *
 * It replaces a Select holding every chat model in one flat list, about 120
 * of them with retired generations mixed in, each one "Name · Lab" in text
 * with no mark and no way to type. Here the labs are headed by their marks,
 * superseded generations fold behind one row at the end, and typing filters
 * across everything, older models included.
 *
 * Two modes over one list:
 *   single  choose one (the default model); choosing closes the popover.
 *   multi   toggle many (favorites); each row carries a star and the popover
 *           stays open, so pinning five models is five clicks, not five trips.
 *
 * Keyboard: focus stays in the search field, the arrows move a highlight
 * through the options (`aria-activedescendant`), Enter chooses, Escape
 * closes. The combobox pattern, so a screen reader hears each option as the
 * highlight reaches it while typing still works.
 */
export function ModelCombobox({
  models,
  plan,
  mode,
  selected,
  onSelect,
  includeAuto = false,
  children,
  label,
}: {
  models: readonly PickerModel[];
  plan: ClientQuota["plan"];
  mode: "single" | "multi";
  /** The chosen id (single) or the set of pinned ids (multi). */
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /** Offer Juno's Auto routing as the first option. */
  includeAuto?: boolean;
  /** The trigger. */
  children: React.ReactNode;
  /** Names the list for assistive tech. */
  label: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showOlder, setShowOlder] = React.useState(false);
  const [active, setActive] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const baseId = React.useId();
  const optionId = (id: string) => `${baseId}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  const rows = React.useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: PickerModel) =>
      m.name.toLowerCase().includes(q) || providerName(m.provider).toLowerCase().includes(q);
    // Searching reaches every generation; browsing shows the current ones
    // plus whatever is already chosen, so a pinned older model is never
    // hidden from the list that pins it.
    const visible = q
      ? models.filter(matches)
      : models.filter((m) => !m.legacy || showOlder || selected.has(m.id));
    const older = q || showOlder ? 0 : models.filter((m) => m.legacy && !selected.has(m.id)).length;

    const out: Row[] = [];
    if (includeAuto && (!q || "auto".includes(q) || "juno".includes(q))) {
      out.push({ kind: "auto", id: AUTO_MODEL_ID_SETTING });
    }
    let lastProvider: PickerModel["provider"] | null = null;
    for (const model of visible) {
      if (model.provider !== lastProvider) {
        out.push({ kind: "header", id: `header:${model.provider}`, provider: model.provider });
        lastProvider = model.provider;
      }
      out.push({ kind: "model", id: model.id, model, locked: !canUseModel(plan, model.id) });
    }
    if (older > 0) out.push({ kind: "older", id: "older", count: older });
    return out;
  }, [includeAuto, models, plan, query, selected, showOlder]);

  const focusable = React.useMemo(
    () => rows.filter((r) => r.kind === "auto" || r.kind === "older" || (r.kind === "model" && !r.locked)),
    [rows]
  );

  // Keep the highlight on something that exists as the list filters.
  React.useEffect(() => {
    if (!open) return;
    if (active && focusable.some((r) => r.id === active)) return;
    setActive(focusable[0]?.id ?? null);
  }, [active, focusable, open]);

  React.useEffect(() => {
    if (!open || !active) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from a stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const choose = (row: Row) => {
    if (row.kind === "older") {
      // The row disappears as it opens, so the highlight moves to the first
      // model it revealed. Left to the fallback below, it landed on the
      // list's first option (Auto) and scrolled the list back to the top,
      // away from everything that had just appeared.
      const revealed = models.find((m) => m.legacy && !selected.has(m.id) && canUseModel(plan, m.id));
      setShowOlder(true);
      if (revealed) setActive(revealed.id);
      return;
    }
    if (row.kind === "header" || (row.kind === "model" && row.locked)) return;
    onSelect(row.id);
    if (mode === "single") setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const at = focusable.findIndex((r) => r.id === active);
    const move = (index: number) => {
      event.preventDefault();
      const next = focusable[(index + focusable.length) % focusable.length];
      if (next) setActive(next.id);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at <= 0 ? focusable.length - 1 : at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(focusable.length - 1);
      case "Enter": {
        const row = focusable[at];
        if (row) {
          event.preventDefault();
          choose(row);
        }
      }
    }
  };

  const listId = `${baseId}-list`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setShowOlder(false);
          const first = [...selected][0];
          setActive(mode === "single" && first ? first : null);
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col rounded-menu p-0">
        <div className="flex items-center gap-2 border-b border-border/70 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label={label}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search models"
            className="h-10 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground coarse:h-11"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={mode === "multi" || undefined}
          className="max-h-[min(22rem,var(--radix-popover-content-available-height,22rem))] overflow-y-auto overscroll-contain p-1.5"
        >
          {rows.length === 0 && (
            <p className="px-2.5 py-6 text-center text-ui text-muted-foreground">No models match that search.</p>
          )}
          {rows.map((row) => {
            if (row.kind === "header") {
              return (
                <div
                  key={row.id}
                  role="presentation"
                  className="flex items-center gap-2 px-2.5 pb-1 pt-2.5 text-caption font-medium text-muted-foreground first:pt-1"
                >
                  <ProviderLogo provider={row.provider} className="size-3.5" />
                  <span translate="no">{providerName(row.provider)}</span>
                </div>
              );
            }
            const isActive = active === row.id;
            if (row.kind === "older") {
              return (
                <div
                  key={row.id}
                  id={optionId(row.id)}
                  role="option"
                  aria-selected={false}
                  onPointerMove={() => setActive(row.id)}
                  onClick={() => choose(row)}
                  className={cn(
                    "mt-1 flex min-h-8 cursor-pointer items-center rounded-control px-2.5 py-1.5 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft coarse:min-h-11",
                    isActive && "bg-accent text-foreground"
                  )}
                >
                  Show older models
                  <span className="ml-1.5 tabular-nums">({row.count})</span>
                </div>
              );
            }
            const isChosen = selected.has(row.id);
            const model = row.kind === "model" ? row.model : null;
            return (
              <div
                key={row.id}
                id={optionId(row.id)}
                role="option"
                aria-selected={isChosen}
                aria-disabled={row.kind === "model" && row.locked ? true : undefined}
                onPointerMove={() => {
                  if (!(row.kind === "model" && row.locked)) setActive(row.id);
                }}
                onClick={() => choose(row)}
                className={cn(
                  "group/option flex min-h-8 cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-ui transition-colors duration-fast ease-out-soft coarse:min-h-11",
                  isActive && "bg-accent",
                  row.kind === "model" && row.locked && "cursor-default opacity-50"
                )}
              >
                {row.kind === "auto" && <JunoMark className="size-4 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">
                    {model ? <span translate="no">{model.name}</span> : "Auto"}
                  </span>
                  {row.kind === "auto" && (
                    <span className="block truncate text-caption text-muted-foreground">
                      Picks a model for each message
                    </span>
                  )}
                </span>
                {row.kind === "model" && row.locked && (
                  <span className="shrink-0 text-caption text-muted-foreground" translate="no">
                    {PLANS[modelRequiredPlan(row.model)].name}
                  </span>
                )}
                {row.kind === "model" && !row.locked && model?.legacy && (
                  <span className="shrink-0 text-caption text-muted-foreground">Older</span>
                )}
                {mode === "multi" ? (
                  <Star
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 transition-opacity duration-fast ease-out-soft",
                      isChosen
                        ? "fill-current text-primary"
                        : cn("text-muted-foreground opacity-0 group-hover/option:opacity-100", isActive && "opacity-100")
                    )}
                  />
                ) : (
                  isChosen && <StatusIcons.success aria-hidden="true" className="size-4 shrink-0 text-primary" />
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The closed default-model control: the lab's mark, the model's name, a chevron. */
export const ModelTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & { model: PickerModel | null; label: string }
>(function ModelTrigger({ model, label, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn(choiceTriggerClass, "justify-start", className)} {...props}>
      <span className="sr-only">{label} </span>
      {model ? (
        <ProviderLogo provider={model.provider} className="size-4 text-foreground" />
      ) : (
        <JunoMark className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {model ? <span translate="no">{model.name}</span> : "Auto"}
      </span>
      <ChevronDown
        className="size-4 shrink-0 opacity-60 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </button>
  );
});
