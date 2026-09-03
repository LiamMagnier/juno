"use client";

import * as React from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReasoningOption } from "@/lib/model-metrics";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PAD = 2;
const THUMB_WIDTH = 20;

/**
 * Reasoning effort is a product control, not a model-provider demo.
 *
 * The previous version carried a private neutral/orange/violet canvas animation,
 * hard-coded dark surfaces and 20px mode buttons. Besides drifting from Juno's
 * accent setting, the animated "max" matrix had no semantic meaning: a model
 * tier looked more powerful because pixels shimmered. The control now uses the
 * shared semantic palette, keeps effort discrete and legible, and lets Reduced
 * Motion eliminate all decorative movement.
 */
export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
  className,
  fastMode = false,
  onFastModeChange,
  proMode = false,
  onProModeChange,
}: {
  options: ReasoningOption[];
  value: ReasoningOption["value"];
  onChange: (value: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode?: boolean;
  onFastModeChange?: (value: boolean) => void;
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
}) {
  const count = options.length;
  const found = options.findIndex((option) => option.value === value);
  const index = found < 0 ? 0 : found;
  const last = count - 1;
  const isTop = count > 1 && index === last;
  const fraction = last > 0 ? index / last : 0;
  const [held, setHeld] = React.useState(false);
  const releaseRef = React.useRef<AbortController | null>(null);

  const grab = React.useCallback(() => {
    releaseRef.current?.abort();
    const controller = new AbortController();
    releaseRef.current = controller;
    setHeld(true);
    const release = () => {
      setHeld(false);
      controller.abort();
    };
    window.addEventListener("pointerup", release, { signal: controller.signal });
    window.addEventListener("pointercancel", release, { signal: controller.signal });
  }, []);

  React.useEffect(() => () => releaseRef.current?.abort(), []);

  if (count < 2) return null;

  const current = options[index];
  const currentLabel =
    current?.label === "Extra high" ? "X-high" : current?.label ?? "Standard";

  return (
    <div className={cn("select-none space-y-3 p-0.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-ui">
          <span className="font-medium text-muted-foreground">Effort</span>
          <span className="font-semibold tracking-tight text-primary">
            {currentLabel}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {onFastModeChange && (
            <ModeChip
              label="Flash"
              help="Prefer faster generation when the selected model supports it."
              pressed={fastMode}
              disabled={disabled}
              onPress={() => onFastModeChange(!fastMode)}
            />
          )}
          {onProModeChange && (
            <ModeChip
              label="Pro"
              help="Prefer the model's deeper reasoning mode when available."
              pressed={proMode}
              disabled={disabled}
              onPress={() => onProModeChange(!proMode)}
            />
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:size-11 motion-reduce:transition-none"
                aria-label="About reasoning effort"
              >
                <HelpCircle className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Adjust how much reasoning the selected model uses before answering.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex items-center justify-between px-0.5 text-caption font-medium text-muted-foreground">
        <span>Faster</span>
        <span>Deeper</span>
      </div>

      <div
        className={cn(
          "relative flex h-9 w-full items-center overflow-hidden rounded-field border border-border/80 bg-muted/65 shadow-inner coarse:h-11",
          disabled && "opacity-55"
        )}
      >
        <div className="relative size-full">
          <div
            className={cn(
              "absolute inset-y-1 left-1 rounded-control transition-[width,background] duration-fast ease-out-soft motion-reduce:transition-none",
              isTop
                ? "bg-gradient-to-r from-primary via-primary to-foreground/75"
                : "bg-primary"
            )}
            style={{
              width: `calc(${PAD}px + (100% - ${PAD * 2}px - ${THUMB_WIDTH}px) * ${fraction} + ${THUMB_WIDTH / 2}px)`,
            }}
            aria-hidden="true"
          />

          <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-4">
            {options.map((option, optionIndex) => (
              <span
                key={`${option.value}-${option.label}`}
                className={cn(
                  "size-1 rounded-full transition-colors duration-fast motion-reduce:transition-none",
                  optionIndex <= index
                    ? "bg-primary-foreground/90"
                    : "bg-muted-foreground/35"
                )}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div
          className="pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 transition-[left,transform] duration-fast ease-out-soft motion-reduce:transition-none"
          style={{
            left: `calc(${PAD}px + (100% - ${PAD * 2}px - ${THUMB_WIDTH}px) * ${fraction})`,
          }}
          aria-hidden="true"
        >
          <div
            className={cn(
              "h-7 w-5 rounded-control border border-border/70 bg-background shadow-pop transition-transform duration-fast motion-reduce:transition-none coarse:h-9 coarse:w-6",
              held ? "scale-105" : ""
            )}
          />
        </div>

        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
          onPointerDown={grab}
          onChange={(event) => {
            const next = options[Number(event.target.value)];
            if (next) onChange(next.value);
          }}
          aria-label={`Reasoning effort: ${currentLabel}`}
          className="absolute inset-0 z-20 size-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
        />
      </div>
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
            "inline-flex min-h-8 items-center rounded-full px-2.5 font-mono text-caption font-medium transition-[background-color,color,box-shadow] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11 coarse:px-3 motion-reduce:transition-none",
            pressed
              ? "bg-foreground text-background shadow-pop"
              : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}
