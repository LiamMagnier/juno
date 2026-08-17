"use client";

import * as React from "react";
import { HelpCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReasoningOption } from "@/lib/model-metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Codex-Inspired Effort Slider with Full Light & Dark Theme Adaptability.
 *
 * Geometric Radii Formula: Outer Radius (8px) = Inner Radius (6px) + Padding (2px)
 * - Standard Mode: Smooth solid accent bar with nested radii
 * - Max Mode: Pixelish matrix with smooth transition from accent color to violet
 * - Prominent, well-proportioned vertical pill thumb (w-5 h-7 rounded-xs)
 * - Clean "Faster" / "Smarter" labels and "Effort <Tier>" header
 */

const PAD = 2; // 2px track inset
const THUMB_WIDTH = 20; // 20px wide vertical capsule thumb

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
  onChange: (v: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode?: boolean;
  onFastModeChange?: (value: boolean) => void;
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
}) {
  const count = options.length;
  const found = options.findIndex((o) => o.value === value);
  const index = found < 0 ? 0 : found;
  const last = count - 1;
  const isTop = count > 1 && index === last;
  const frac = last > 0 ? index / last : 0;

  const [held, setHeld] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const releaseRef = React.useRef<AbortController | null>(null);

  const grab = React.useCallback(() => {
    releaseRef.current?.abort();
    const ac = new AbortController();
    releaseRef.current = ac;
    setHeld(true);
    const release = () => {
      setHeld(false);
      ac.abort();
    };
    window.addEventListener("pointerup", release, { signal: ac.signal });
    window.addEventListener("pointercancel", release, { signal: ac.signal });
  }, []);

  React.useEffect(() => () => releaseRef.current?.abort(), []);

  // Animate the digital pixel matrix ONLY on Max mode
  React.useEffect(() => {
    if (!isTop) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let t = 0;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        animId = requestAnimationFrame(render);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;

      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // Grid settings: 4 rows of clean micro-squares with nested spacing
      const rows = 4;
      const cols = 42;
      const gapX = 1.8;
      const gapY = 1.8;
      const padX = 3.5;
      const padY = 3.5;

      const dotW = (w - padX * 2 - (cols - 1) * gapX) / cols;
      const dotH = (h - padY * 2 - (rows - 1) * gapY) / rows;
      const dotRadius = 1.2;

      t += 0.025;

      // Detect dark theme
      const isDark = document.documentElement.classList.contains("dark");

      // Color interpolation: Accent (orange, rgb 249, 115, 22) -> Violet (rgb 167, 139, 250)
      for (let c = 0; c < cols; c++) {
        const x = padX + c * (dotW + gapX);
        const progress = c / (cols - 1);

        // Smooth color blend from primary accent (#f97316) to violet (#a78bfa)
        const rVal = Math.round(249 + (167 - 249) * progress);
        const gVal = Math.round(115 + (139 - 115) * progress);
        const bVal = Math.round(22 + (250 - 22) * progress);

        // Organic compute shimmer
        const shimmer = 0.78 + 0.22 * Math.sin(t + c * 0.4 + progress * 2);

        for (let r = 0; r < rows; r++) {
          const y = padY + r * (dotH + gapY);

          ctx.beginPath();
          ctx.roundRect(x, y, dotW, dotH, dotRadius);
          const alpha = isDark ? shimmer * 0.92 : shimmer * 0.95;
          ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha})`;
          ctx.fill();
        }
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [isTop]);

  if (count < 2) return null;
  const current = options[index];
  const currentLabel = current?.label === "Extra high" ? "X-high" : current?.label ?? "Standard";

  return (
    <div className={cn("select-none space-y-3 p-0.5", className)}>
      {/* Header Row: "Effort <Tier>" + (?) Tooltip & Flash/Pro Modes */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-ui">
          <span className="font-medium text-foreground/80">Effort</span>
          <span className="font-semibold tracking-tight text-primary transition-colors duration-fast">
            {currentLabel}
          </span>
        </div>

        {/* Both bolts below stay raw. `AppIcons.work` is the Juno Work
            destination; these two are the Flash/Pro effort chips, where the mark
            means speed. A destination glyph on an effort toggle would be a link
            to somewhere the button does not go. */}
        <div className="flex items-center gap-1.5">
          {onFastModeChange && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={fastMode}
                  onClick={() => onFastModeChange(!fastMode)}
                  className={cn(
                    "inline-flex h-5.5 items-center gap-1 rounded-full px-2 text-micro font-medium transition-all duration-base ease-out-soft",
                    fastMode
                      ? "bg-foreground text-background shadow-xs"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                  )}
                >
                  <Zap className={cn("size-2.5", fastMode && "fill-current")} />
                  <span>Flash</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Faster generation</TooltipContent>
            </Tooltip>
          )}

          {onProModeChange && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={proMode}
                  onClick={() => onProModeChange(!proMode)}
                  className={cn(
                    "inline-flex h-5.5 items-center gap-1 rounded-full px-2 text-micro font-medium transition-all duration-base ease-out-soft",
                    proMode
                      ? "bg-foreground text-background shadow-xs"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                  )}
                >
                  <Zap className={cn("size-2.5", proMode && "fill-current")} />
                  <span>Pro</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Deep reasoning tokens</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                aria-label="About reasoning effort"
              >
                <HelpCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Adjust how long Juno thinks before generating responses.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Subheader: "Faster" & "Smarter" */}
      <div className="flex items-center justify-between px-0.5 text-caption font-medium text-muted-foreground">
        <span>Faster</span>
        <span>Smarter</span>
      </div>

      {/* Slider Track Container (outer 8px radius = rounded-md) */}
      <div className="relative flex h-8 w-full items-center rounded-md border border-border/80 bg-neutral-200/80 dark:bg-[#121214] dark:border-white/10 shadow-inner overflow-hidden">
        {isTop ? (
          /* Max Mode: Pixelish Digital Matrix Canvas (Accent -> Violet) */
          <canvas ref={canvasRef} className="size-full block" />
        ) : (
          /* Standard Mode: Smooth Solid Accent Track with inner 6px radius (rounded-xs) */
          <div className="relative size-full">
            {/* Active Accent Fill */}
            <div
              className="absolute inset-y-1 left-1 rounded-xs bg-primary transition-[width] duration-fast ease-out-soft shadow-xs"
              style={{
                width: `calc(${PAD}px + (100% - ${PAD * 2}px - ${THUMB_WIDTH}px) * ${frac} + ${THUMB_WIDTH / 2}px)`,
              }}
            />
            {/* Discrete Detents */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-4">
              {options.map((o, i) => (
                <span
                  key={o.label}
                  className={cn(
                    "size-1 rounded-full transition-all duration-fast",
                    i <= index ? "bg-white/90" : "bg-neutral-400 dark:bg-white/20"
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* Prominent Vertical Pill Thumb (w-5, h-7, inner radius rounded-xs = 6px) */}
        <div
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 transition-[left,transform] duration-fast ease-out-soft z-10"
          style={{
            left: `calc(${PAD}px + (100% - ${PAD * 2}px - ${THUMB_WIDTH}px) * ${frac})`,
          }}
        >
          <div
            className={cn(
              "h-7 w-5 rounded-xs bg-white text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.08)] dark:bg-[#faf8ff] dark:shadow-[0_2px_10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.3)] transition-transform duration-fast",
              held ? "scale-108 shadow-2xl" : "hover:scale-104"
            )}
          />
        </div>

        {/* Hidden Range Input for direct tactile interaction */}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
          onPointerDown={grab}
          onChange={(e) => {
            const next = options[Number(e.target.value)];
            if (next) onChange(next.value);
          }}
          aria-label="Reasoning effort"
          className="absolute inset-0 size-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed z-20"
        />
      </div>
    </div>
  );
}
