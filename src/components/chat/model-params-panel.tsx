"use client";

import * as React from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/lib/model-metrics";

// null = provider default (nothing sent to the API).
export interface ModelParams {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

const STORAGE_KEY = "juno:model-params:v1";

const EMPTY: ModelParams = { temperature: null, topP: null, maxTokens: null };

// Slider resting positions while a param is still "Auto".
const PROVIDER_DEFAULTS = { temperature: 1, topP: 1, maxTokens: 8192 } as const;

const EFFORT_LABEL: Record<Exclude<ReasoningEffort, null>, string> = {
  minimal: "Minimal effort",
  low: "Low effort",
  medium: "Medium effort",
  high: "High effort",
  xhigh: "Extra-high effort",
  max: "Max effort",
};

type ParamsStore = Record<string, ModelParams>;

function readStore(): ParamsStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ParamsStore;
  } catch {
    return {};
  }
}

function persistStore(store: ParamsStore) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // storage full / blocked — params just won't survive a reload
  }
}

function isCustomized(params: ModelParams): boolean {
  return params.temperature != null || params.topP != null || params.maxTokens != null;
}

function StatusPill({ label, active, value }: { label: string; active: boolean; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-caption font-medium">
      <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-success" : "bg-muted-foreground/40")} aria-hidden="true" />
      <span className={active ? "text-foreground" : "text-muted-foreground"}>{label}</span>
      {value && <span className="font-mono text-caption text-muted-foreground/70">{value}</span>}
    </span>
  );
}

interface ParamRowProps {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  fallback: number; // provider-default slider position while Auto
  format: (v: number) => string;
  onChange: (v: number) => void;
  onReset: () => void;
  locked?: boolean; // slider disabled entirely
  dimmed?: boolean; // mutually-exclusive param dimming
  caption?: string;
}

function ParamRow({ label, value, min, max, step, fallback, format, onChange, onReset, locked, dimmed, caption }: ParamRowProps) {
  const inert = locked || dimmed;
  return (
    <div className={cn("rounded-md bg-muted/20 px-2.5 py-2 transition-opacity duration-fast", dimmed && "opacity-50")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-label uppercase text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1">
          {value == null ? (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">
              Auto
            </span>
          ) : (
            <>
              <span className="font-mono text-xs text-foreground">{format(value)}</span>
              <button
                type="button"
                onClick={onReset}
                aria-label={`Reset ${label.toLowerCase()} to auto`}
                className="pressable flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-accent hover:text-foreground coarse:h-7 coarse:w-7"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? fallback}
        disabled={inert}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className={cn("w-full accent-primary", value == null && "opacity-40", inert && "cursor-not-allowed")}
      />
      {caption && <p className="mt-1 text-caption text-muted-foreground">{caption}</p>}
    </div>
  );
}

export function ModelParamsPanel({
  model,
  reasoningEffort,
  canvasEnabled,
  webSearchEnabled,
  canWebSearch,
  privateMode,
  disabled,
}: {
  model: ModelInfo | null;
  reasoningEffort: ReasoningEffort;
  canvasEnabled: boolean;
  webSearchEnabled: boolean;
  canWebSearch: boolean;
  privateMode?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const [store, setStore] = React.useState<ParamsStore>({});

  React.useEffect(() => {
    setStore(readStore());
  }, []);

  const modelId = model?.id ?? null;
  const params = (modelId ? store[modelId] : undefined) ?? EMPTY;
  const customized = isCustomized(params);

  const setParam = React.useCallback(
    (key: keyof ModelParams, value: number | null) => {
      if (!modelId) return;
      setStore((prev) => {
        const nextParams = { ...(prev[modelId] ?? EMPTY), [key]: value };
        const next = { ...prev };
        if (isCustomized(nextParams)) next[modelId] = nextParams;
        else delete next[modelId]; // all-Auto → drop the entry
        persistStore(next);
        return next;
      });
    },
    [modelId]
  );

  const resetAll = React.useCallback(() => {
    if (!modelId) return;
    setStore((prev) => {
      const next = { ...prev };
      delete next[modelId];
      persistStore(next);
      return next;
    });
  }, [modelId]);

  const isAnthropic = model?.provider === "anthropic";
  const tempLockedByThinking = isAnthropic && reasoningEffort !== null;
  // Claude treats temperature and top-p as mutually exclusive.
  const exclusiveCaption = "Set one of temperature / top-p on Claude.";
  const tempDimmed = isAnthropic && !tempLockedByThinking && params.topP != null && params.temperature == null;
  const topPDimmed = isAnthropic && params.temperature != null && params.topP == null;

  const reasoningLabel = reasoningEffort ? EFFORT_LABEL[reasoningEffort] : "Instant";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label="Model parameters"
              className={cn(
                "relative coarse:h-11 coarse:w-11 [&_svg]:size-3.5",
                customized ? "text-primary" : "text-muted-foreground",
                disabled && "pointer-events-none opacity-50"
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {customized && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Model parameters</TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(34rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg p-0"
      >
        {/* Header — stays pinned while the body scrolls on short viewports. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-label uppercase text-muted-foreground">Parameters</p>
            <p className="truncate font-mono text-sm text-foreground">{model?.name ?? "No model selected"}</p>
          </div>
          {customized && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetAll}
              className="h-6 shrink-0 px-2 text-caption text-muted-foreground hover:text-foreground"
            >
              Reset
            </Button>
          )}
        </div>

        {/* Scrollable body so the panel never exceeds the space above the trigger. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Parameter rows — outer rounded-lg (24px), section p-3 (12px) → inner rounded-md */}
        <div className="flex flex-col gap-1.5 p-3">
          <ParamRow
            label="Temperature"
            value={params.temperature}
            min={0}
            max={2}
            step={0.1}
            fallback={PROVIDER_DEFAULTS.temperature}
            format={(v) => v.toFixed(1)}
            onChange={(v) => setParam("temperature", v)}
            onReset={() => setParam("temperature", null)}
            locked={tempLockedByThinking || !model}
            dimmed={tempDimmed}
            caption={
              tempLockedByThinking
                ? "Thinking locks temperature to 1 on Claude models."
                : tempDimmed
                  ? exclusiveCaption
                  : undefined
            }
          />
          <ParamRow
            label="Top-P"
            value={params.topP}
            min={0}
            max={1}
            step={0.05}
            fallback={PROVIDER_DEFAULTS.topP}
            format={(v) => v.toFixed(2)}
            onChange={(v) => setParam("topP", v)}
            onReset={() => setParam("topP", null)}
            locked={!model}
            dimmed={topPDimmed}
            caption={topPDimmed ? exclusiveCaption : undefined}
          />
          <ParamRow
            label="Max tokens"
            value={params.maxTokens}
            min={256}
            max={16384}
            step={256}
            fallback={PROVIDER_DEFAULTS.maxTokens}
            format={(v) => v.toLocaleString()}
            onChange={(v) => setParam("maxTokens", v)}
            onReset={() => setParam("maxTokens", null)}
            locked={!model}
          />
        </div>

        {/* Active feature flags */}
        <div className="border-t border-border/60 p-3">
          <p className="px-0.5 font-mono text-label uppercase text-muted-foreground">Active for this model</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusPill
              label="Web search"
              active={webSearchEnabled && canWebSearch}
              value={canWebSearch ? undefined : "Unavailable"}
            />
            <StatusPill label="Canvas" active={canvasEnabled && !privateMode} />
            <StatusPill label="Reasoning" active={reasoningEffort !== null} value={reasoningLabel} />
          </div>
        </div>
        </div>

        {/* Footer — pinned below the scroll area. */}
        <div className="shrink-0 border-t border-border/60 bg-muted/20 px-4 py-2.5">
          <p className="text-caption text-muted-foreground">Saved per model on this device.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
