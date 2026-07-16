"use client";

import * as React from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Layers3,
  Pause,
  Play,
  RotateCcw,
  Wand2,
  Zap,
  Terminal,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Reveal } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { StepLab, StepLabQuiz, StepLabStep, StepLabVisualType } from "@/lib/step-lab";

type TokenEntry = { text: string; id: number };
type VectorExample = { token: string; vector: number[] };
type Candidate = { token: string; probability: number; note?: string };

/** Autoplay step interval. Keep the `duration-[2200ms]` class in AutoplayFill in sync. */
const AUTOPLAY_INTERVAL_MS = 2200;

/**
 * The ONE sanctioned categorical palette for per-index coloring
 * (token chips, per-index accents). Do not add other raw palette classes.
 */
const TOKEN_PALETTE = [
  { bg: "bg-blue-500/10 dark:bg-blue-500/20", border: "border-blue-400/30 dark:border-blue-500/20", text: "text-blue-600 dark:text-blue-300", dot: "bg-blue-500/70" },
  { bg: "bg-emerald-500/10 dark:bg-emerald-500/20", border: "border-emerald-400/30 dark:border-emerald-500/20", text: "text-emerald-600 dark:text-emerald-300", dot: "bg-emerald-500/70" },
  { bg: "bg-violet-500/10 dark:bg-violet-500/20", border: "border-violet-400/30 dark:border-violet-500/20", text: "text-violet-600 dark:text-violet-300", dot: "bg-violet-500/70" },
  { bg: "bg-amber-500/10 dark:bg-amber-500/20", border: "border-amber-400/30 dark:border-amber-500/20", text: "text-amber-600 dark:text-amber-300", dot: "bg-amber-500/70" },
  { bg: "bg-cyan-500/10 dark:bg-cyan-500/20", border: "border-cyan-400/30 dark:border-cyan-500/20", text: "text-cyan-600 dark:text-cyan-300", dot: "bg-cyan-500/70" },
  { bg: "bg-rose-500/10 dark:bg-rose-500/20", border: "border-rose-400/30 dark:border-rose-500/20", text: "text-rose-600 dark:text-rose-300", dot: "bg-rose-500/70" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hashNumber(value: string, min = 200, max = 50000): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return min + (Math.abs(h) % (max - min));
}

/** True one frame after mount — lets width/opacity CSS transitions play from their zero state. */
function useEnteredFrame(): boolean {
  const [entered, setEntered] = React.useState(false);
  React.useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);
  return entered;
}

function fallbackTokens(step: StepLabStep): TokenEntry[] {
  const source = asString(isRecord(step.data) ? step.data.input : undefined) ?? `${step.title} ${step.summary}`;
  const words = source
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  const base = words.length ? words : ["input", "transform", "output"];
  return base.map((text) => ({ text, id: hashNumber(text) }));
}

function tokenData(step: StepLabStep): { input: string; tokens: TokenEntry[] } {
  const data = isRecord(step.data) ? step.data : {};
  const input = asString(data.input) ?? `${step.title}: ${step.summary}`;
  const tokens = Array.isArray(data.tokens)
    ? data.tokens
        .map((item) => {
          if (typeof item === "string") return { text: item, id: hashNumber(item) };
          if (!isRecord(item)) return null;
          const text = asString(item.text ?? item.token);
          if (!text) return null;
          return { text, id: asNumber(item.id) ?? hashNumber(text) };
        })
        .filter(Boolean)
    : [];
  return { input, tokens: (tokens.length ? tokens : fallbackTokens(step)) as TokenEntry[] };
}

function vectorExamples(step: StepLabStep): VectorExample[] {
  const data = isRecord(step.data) ? step.data : {};
  const examples = Array.isArray(data.examples)
    ? data.examples
        .map((item) => {
          if (!isRecord(item)) return null;
          const token = asString(item.token ?? item.text);
          const vector = Array.isArray(item.vector)
            ? item.vector.map(asNumber).filter((value): value is number => value != null).slice(0, 6)
            : [];
          if (!token || !vector.length) return null;
          return { token, vector };
        })
        .filter(Boolean)
    : [];
  if (examples.length) return examples as VectorExample[];
  return fallbackTokens(step).slice(0, 3).map((token, index) => ({
    token: token.text,
    vector: [0.12 + index * 0.14, -0.44 + index * 0.09, 0.87 - index * 0.11, 0.31 + index * 0.05],
  }));
}

function attentionData(step: StepLabStep): { tokens: string[]; matrix: number[][] } {
  const data = isRecord(step.data) ? step.data : {};
  const tokens = Array.isArray(data.tokens)
    ? data.tokens.map(asString).filter((token): token is string => !!token).slice(0, 7)
    : fallbackTokens(step).map((token) => token.text).slice(0, 6);
  const matrix = Array.isArray(data.matrix)
    ? data.matrix
        .map((row) => (Array.isArray(row) ? row.map(asNumber).filter((value): value is number => value != null).slice(0, tokens.length) : []))
        .filter((row) => row.length)
        .slice(0, tokens.length)
    : [];
  if (tokens.length && matrix.length === tokens.length) return { tokens, matrix };
  const fallback = tokens.map((_, rowIndex) =>
    tokens.map((__, colIndex) => {
      if (rowIndex === colIndex) return 0.16;
      const distance = Math.abs(rowIndex - colIndex);
      return Math.max(0.08, 0.42 - distance * 0.08);
    })
  );
  return { tokens, matrix: fallback };
}

function candidates(step: StepLabStep): Candidate[] {
  const data = isRecord(step.data) ? step.data : {};
  const parsed = Array.isArray(data.candidates)
    ? data.candidates
        .map((item) => {
          if (!isRecord(item)) return null;
          const token = asString(item.token ?? item.text);
          const probability = asNumber(item.probability ?? item.p);
          if (!token || probability == null) return null;
          const note = asString(item.note ?? item.explanation);
          return { token, probability: probability > 1 ? probability / 100 : probability, note };
        })
        .filter(Boolean)
    : [];
  if (parsed.length) return (parsed as Candidate[]).slice(0, 6);
  return [
    { token: "word", probability: 0.42 },
    { token: "token", probability: 0.27 },
    { token: "step", probability: 0.16 },
    { token: "output", probability: 0.1 },
    { token: ".", probability: 0.05 },
  ];
}

function visualLabel(type: StepLabVisualType): string {
  if (type === "probability-distribution") return "probabilities";
  if (type === "transformer-processing") return "layers";
  if (type === "next-token-selection") return "selection";
  return type.replace("-", " ");
}

function TokenizationVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const { input, tokens } = tokenData(step);
  const [selected, setSelected] = React.useState(0);
  const active = tokens[Math.min(selected, tokens.length - 1)] ?? tokens[0];

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {/* Tokenized Input Preview */}
      <div className={cn("rounded-lg border bg-muted/20", compact ? "p-2.5" : "p-3")}>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1.5">Tokenized Input</p>
        {/* input -> tokens transform hint */}
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">&quot;{input}&quot;</span>
          <ArrowRight className="size-3 shrink-0 text-primary" aria-hidden />
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">tokens</span>
        </div>
        <div className={cn("flex flex-wrap items-center gap-1 font-mono text-sm leading-relaxed bg-card rounded-md border", compact ? "p-2" : "p-2.5")}>
          {tokens.map((token, index) => {
            const color = TOKEN_PALETTE[index % TOKEN_PALETTE.length];
            const isSelected = index === selected;
            return (
              <Tooltip key={index}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSelected(index)}
                    className={cn(
                      "pressable cursor-pointer px-2 py-0.5 rounded-sm border text-xs sm:text-sm font-semibold select-none active:scale-[0.97]",
                      color.bg,
                      color.border,
                      color.text,
                      isSelected ? "ring-2 ring-primary ring-offset-2 ring-offset-background scale-105 shadow-soft" : "opacity-80 hover:opacity-100 hover:scale-[1.02]"
                    )}
                  >
                    {token.text.replace(/ /g, "␣")}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono text-[10px]">
                  Token {index} · id {token.id}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* Grid of Token Cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tokens.map((token, index) => {
          const color = TOKEN_PALETTE[index % TOKEN_PALETTE.length];
          const isSelected = index === selected;
          return (
            <button
              key={index}
              type="button"
              onClick={() => setSelected(index)}
              className={cn(
                "pressable relative flex flex-col items-start rounded-lg border text-left hover:shadow-soft hover:border-primary/45",
                compact ? "p-2.5" : "p-3",
                isSelected
                  ? "border-primary bg-primary/[0.03] ring-1 ring-primary/40 shadow-soft"
                  : "border-border bg-card/60 hover:bg-accent/10"
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", isSelected ? "bg-primary motion-safe:animate-pulse" : "bg-muted-foreground/35")} />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.14em] font-mono">T_{index}</span>
              </div>
              <div className={cn("mt-1.5 font-bold text-sm font-mono truncate w-full", color.text)}>
                {token.text.replace(/ /g, "␣")}
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                ID: <span className="font-semibold text-foreground">{token.id}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Connection Detail Flow */}
      {active && (
        <div className={cn("flex items-center justify-between rounded-lg border bg-primary/5 text-xs sm:text-sm", compact ? "px-3 py-2.5" : "px-4 py-3")}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground">Token {selected}</span>
            <span className="font-bold font-mono">&quot;{active.text}&quot;</span>
          </div>
          <ArrowRight className="size-4 text-primary shrink-0 motion-safe:animate-pulse" />
          <div className="flex items-center gap-1.5 font-mono">
            <span className="text-muted-foreground">Vocabulary Index</span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-bold text-primary">{active.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EmbeddingVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const examples = vectorExamples(step);
  const [selected, setSelected] = React.useState(0);
  const active = examples[Math.min(selected, examples.length - 1)] ?? examples[0];

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {/* Token Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {examples.map((example, index) => (
          <button
            key={example.token}
            type="button"
            onClick={() => setSelected(index)}
            className={cn(
              "pressable rounded-lg border text-xs sm:text-sm font-semibold coarse:min-h-9",
              compact ? "px-2.5 py-1" : "px-3 py-1.5",
              selected === index
                ? "bg-primary/10 border-primary text-primary shadow-soft"
                : "bg-card border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
            )}
          >
            {example.token}
          </button>
        ))}
      </div>

      {/* Bidirectional Plot */}
      {active && (
        <div className={cn("rounded-lg border bg-muted/20", compact ? "p-2.5" : "p-4")}>
          <div className={cn("flex flex-wrap items-center justify-between gap-2", compact ? "mb-3" : "mb-4")}>
            <div>
              <p className="text-sm font-semibold">Semantic Coordinate Vector ({active.token})</p>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                [{active.vector.map(v => v.toFixed(3)).join(", ")}]
              </p>
            </div>
            <Badge variant="muted" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">
              {active.vector.length}-Dim Vector
            </Badge>
          </div>

          <div className={cn("relative flex items-center justify-between border-l border-r border-dashed border-border/80 px-4 bg-card/45 rounded-lg py-2", compact ? "h-32" : "h-36")}>
            {/* Baseline indicators */}
            <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-border/70" />
            <span className="absolute left-1.5 top-[calc(50%-8px)] font-mono text-[10px] text-muted-foreground">0.0</span>
            <span className="absolute right-1.5 top-1.5 font-mono text-[10px] text-muted-foreground">+1.0</span>
            <span className="absolute right-1.5 bottom-1.5 font-mono text-[10px] text-muted-foreground">-1.0</span>

            <div className="flex w-full items-stretch justify-around h-full z-10">
              {active.vector.map((val, index) => {
                const percentage = Math.min(100, Math.round(Math.abs(val) * 100));
                const isPositive = val >= 0;
                return (
                  <div key={index} className="flex flex-col items-center justify-between w-6 h-full relative group">
                    <div className="flex-1 flex flex-col justify-end w-full relative">
                      {isPositive ? (
                        <div
                          className="absolute bottom-1/2 left-1/2 -translate-x-1/2 w-3 rounded-t bg-gradient-to-t from-indigo-500/80 to-cyan-400/80 hover:brightness-110 transition-all duration-base ease-out-soft"
                          style={{ height: `${percentage / 2}%` }}
                        />
                      ) : (
                        <div
                          className="absolute top-1/2 left-1/2 -translate-x-1/2 w-3 rounded-b bg-gradient-to-b from-rose-500/80 to-amber-500/80 hover:brightness-110 transition-all duration-base ease-out-soft"
                          style={{ height: `${percentage / 2}%` }}
                        />
                      )}
                    </div>
                    <div className="h-4 flex items-center justify-center">
                      <span className="font-mono text-[10px] text-muted-foreground">d_{index}</span>
                    </div>

                    {/* Tooltip on hover */}
                    <div className="pointer-events-none absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border text-popover-foreground text-[10px] px-2 py-1 rounded-md shadow-float opacity-0 group-hover:opacity-100 transition-opacity duration-base ease-out-soft z-20 font-mono whitespace-nowrap">
                      d_{index}: {val >= 0 ? "+" : ""}{val.toFixed(3)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttentionVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const { tokens, matrix } = attentionData(step);
  const [selectedRow, setSelectedRow] = React.useState(Math.min(1, tokens.length - 1));
  const row = matrix[selectedRow] ?? [];
  const strongestIndex = row.reduce((best, value, index) => (value > (row[best] ?? 0) ? index : best), 0);

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {/* Tab Row selection */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-xs text-muted-foreground font-mono mr-1">Query Token:</span>
        {tokens.map((token, index) => (
          <button
            key={token}
            type="button"
            onClick={() => setSelectedRow(index)}
            className={cn(
              "pressable rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:border-primary/40 coarse:min-h-9",
              selectedRow === index && "border-primary/55 bg-primary/10 text-primary shadow-soft"
            )}
          >
            {token}
          </button>
        ))}
      </div>

      <div className={cn("grid md:grid-cols-[1.2fr_1fr]", compact ? "gap-3" : "gap-4")}>
        {/* Heatmap Grid */}
        <div className={cn("rounded-lg border bg-card/45 flex flex-col justify-center", compact ? "p-2.5" : "p-3")}>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `minmax(2.5rem, 3rem) repeat(${tokens.length}, minmax(1.5rem, 1fr))` }}
          >
            <div />
            {tokens.map((token) => (
              <div key={`col-${token}`} className="truncate text-center font-mono text-[10px] text-muted-foreground font-semibold">
                {token}
              </div>
            ))}
            {tokens.map((rowToken, rowIndex) => (
              <React.Fragment key={rowToken}>
                <button
                  type="button"
                  onClick={() => setSelectedRow(rowIndex)}
                  className={cn(
                    "pressable truncate rounded-sm px-1.5 py-1.5 text-left text-xs font-semibold",
                    rowIndex === selectedRow ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {rowToken}
                </button>
                {tokens.map((colToken, colIndex) => {
                  const value = matrix[rowIndex]?.[colIndex] ?? 0;
                  const isActive = rowIndex === selectedRow;
                  const isStrongestCell = colIndex === strongestIndex && isActive;
                  return (
                    <Tooltip key={`${rowToken}-${colToken}`}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onMouseEnter={() => setSelectedRow(rowIndex)}
                          onClick={() => setSelectedRow(rowIndex)}
                          className={cn(
                            "pressable h-8 rounded-sm border text-[10px] font-mono font-semibold hover:scale-[1.05] active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                            isActive ? "border-primary/45" : "border-border/60",
                            isStrongestCell && "ring-1 ring-primary"
                          )}
                          style={{
                            backgroundColor: `hsl(var(--primary) / ${Math.max(0.08, Math.min(0.75, value))})`,
                            color: value > 0.45 ? "hsl(var(--primary-foreground))" : "inherit"
                          }}
                          aria-label={`${rowToken} attends to ${colToken}: ${Math.round(value * 100)} percent`}
                        >
                          {Math.round(value * 100)}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-[10px]">
                        {rowToken} → {colToken}: {Math.round(value * 100)}%
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Attention Flows */}
        <div className={cn("flex flex-col gap-2 rounded-lg border bg-muted/20", compact ? "p-2.5" : "p-3.5")}>
          <div className="flex items-center justify-between border-b pb-2 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] font-mono text-muted-foreground">Attention Flow</span>
            <span className="text-xs font-bold text-primary font-mono">from &quot;{tokens[selectedRow]}&quot;</span>
          </div>

          <div className="flex flex-col gap-2.5">
            {tokens.map((targetToken, targetIndex) => {
              const weight = matrix[selectedRow]?.[targetIndex] ?? 0;
              const pct = Math.round(weight * 100);
              const isStrongest = targetIndex === strongestIndex;
              return (
                <div key={targetToken} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-1.5">
                      <ArrowRight className={cn("size-3", isStrongest ? "text-primary motion-safe:animate-pulse" : "text-muted-foreground/60")} />
                      <span className={cn("font-medium", isStrongest && "text-primary font-bold")}>{targetToken}</span>
                    </div>
                    <span className={cn("font-bold", isStrongest ? "text-primary" : "text-muted-foreground")}>{pct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted/70">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-slow ease-out-soft",
                        isStrongest
                          ? "bg-gradient-to-r from-primary to-cyan-400"
                          : "bg-muted-foreground/45"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function TransformerVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const data = isRecord(step.data) ? step.data : {};
  const tokens = Array.isArray(data.tokens)
    ? data.tokens.map(asString).filter((token): token is string => !!token).slice(0, 5)
    : fallbackTokens(step).map((token) => token.text).slice(0, 5);
  const layersCount = typeof data.layers === "number" ? data.layers : 12;
  const [activeLayer, setActiveLayer] = React.useState(1);

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {/* Sequence Header */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-mono mr-1">Active sequence:</span>
        {tokens.map((token) => (
          <span key={token} className="rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-[10px] font-semibold">
            {token}
          </span>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-[1.3fr_1.1fr] items-start">
        {/* Layer visual stack */}
        <div className="flex flex-col gap-2">
          {[3, 2, 1].map((layerNum) => {
            const isActive = activeLayer === layerNum;
            const layerName = layerNum === 1 ? "Multi-Head Attention (MHA)" : layerNum === 2 ? "Feed Forward Net (FFN)" : "Layer Norm & Residuals";
            const layerDesc = layerNum === 1 ? "Token relation exchange" : layerNum === 2 ? "Factual data storage layers" : "Signal stability & additions";
            return (
              <button
                key={layerNum}
                type="button"
                onClick={() => setActiveLayer(layerNum)}
                className={cn(
                  "pressable flex items-center justify-between rounded-lg border text-left",
                  compact ? "p-2.5" : "p-3",
                  isActive
                    ? "border-primary bg-primary/[0.03] shadow-soft scale-[1.01]"
                    : "border-border bg-card/60 hover:bg-accent/10"
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded font-mono text-xs font-bold border",
                      isActive ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"
                    )}
                  >
                    L{layerNum}
                  </span>
                  <div>
                    <span className="block text-sm font-semibold">{layerName}</span>
                    <span className="block text-[10px] text-muted-foreground font-mono">{layerDesc}</span>
                  </div>
                </div>
                {isActive ? (
                  <span className="text-[10px] font-bold text-primary font-mono motion-safe:animate-pulse uppercase tracking-[0.14em] shrink-0">inspecting</span>
                ) : (
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">click to view</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Inspection box */}
        <div className={cn("rounded-lg border bg-muted/20 flex flex-col justify-between", compact ? "p-2.5 min-h-[150px]" : "p-4 min-h-[175px]")}>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="size-4 text-primary shrink-0 motion-safe:animate-pulse" />
              <h5 className="text-xs font-bold uppercase tracking-[0.14em] font-mono text-primary">
                {activeLayer === 1 ? "Attention Block" : activeLayer === 2 ? "Feed Forward Network" : "Skip Connection"}
              </h5>
            </div>
            {activeLayer === 1 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Tokens exchange semantic information in parallel. For example, <strong>&quot;can&quot;</strong> attends to <strong>&quot;AI&quot;</strong> to query relevant preceding context, building a rich representation.
              </p>
            )}
            {activeLayer === 2 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Each token&apos;s vector goes through deep linear layers. This accesses the model&apos;s factual knowledge base, updating the token representation based on database facts.
              </p>
            )}
            {activeLayer === 3 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Inputs bypass blocks using residual connections to prevent vanishing gradients. Layer Normalization standardizes activations to ensure stable training through all {layersCount} layers.
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-dashed border-border/80">
            <div className={cn("h-1.5 rounded-full transition-all duration-slow ease-out-soft", activeLayer === 1 ? "w-1/2 bg-primary" : "w-6 bg-muted")} />
            <div className={cn("h-1.5 rounded-full transition-all duration-slow ease-out-soft", activeLayer === 2 ? "w-1/2 bg-primary" : "w-6 bg-muted")} />
            <div className={cn("h-1.5 rounded-full transition-all duration-slow ease-out-soft", activeLayer === 3 ? "w-1/2 bg-primary" : "w-6 bg-muted")} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProbabilityVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const items = candidates(step);
  const [selected, setSelected] = React.useState(0);
  const entered = useEnteredFrame();
  const max = Math.max(...items.map((item) => item.probability), 0.01);

  return (
    <div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
      <div className="flex items-center justify-between px-1 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] font-mono text-muted-foreground">Softmax Probabilities</span>
        <span className="text-[10px] text-muted-foreground font-mono">Ranked Candidates</span>
      </div>
      {items.map((item, index) => {
        const active = index === selected;
        const pct = Math.round(item.probability * 100);
        const isTop = index === 0;
        return (
          <button
            key={item.token}
            type="button"
            onMouseEnter={() => setSelected(index)}
            onFocus={() => setSelected(index)}
            onClick={() => setSelected(index)}
            className={cn(
              "pressable relative rounded-lg border bg-background/50 text-left hover:border-primary/40",
              compact ? "p-2" : "p-2.5",
              active
                ? "border-primary bg-primary/[0.03] shadow-soft scale-[1.01]"
                : "border-border/60 hover:bg-accent/10"
            )}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 text-sm font-mono">
              <div className="flex items-center gap-1.5">
                <span className={cn("relative size-5 rounded flex items-center justify-center text-[10px] font-bold border", active ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground")}>
                  {isTop && <span aria-hidden className="absolute inset-0 rounded border border-primary/60 motion-safe:animate-pulse-ring" />}
                  {index + 1}
                </span>
                <span className="font-semibold text-foreground">&quot;{item.token}&quot;</span>
                {isTop && (
                  <Badge variant="success" className="rounded-md px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.14em] scale-90">
                    <Zap className="size-2.5 mr-0.5 inline" /> top
                  </Badge>
                )}
              </div>
              <span className={cn("font-bold", active ? "text-primary" : "text-muted-foreground")}>{pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/65">
              <div
                className={cn(
                  "h-full rounded-full ease-out-soft motion-safe:transition-[width] motion-safe:duration-slow",
                  isTop ? "bg-gradient-to-r from-primary to-cyan-400" : "bg-primary/50"
                )}
                style={{ width: entered ? `${Math.max(5, (item.probability / max) * 100)}%` : "0%" }}
              />
            </div>
            {active && item.note && (
              <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground motion-safe:animate-fade-in">{item.note}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}

function NextTokenSelectionVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const data = isRecord(step.data) ? step.data : {};
  const prompt = asString(data.prompt) ?? "The model predicts the next";
  const selectedToken = asString(data.selectedToken ?? data.token ?? data.output) ?? candidates(step)[0]?.token ?? "word";

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {/* Terminal emulator box — foreground/background inversion so it themes in light & dark */}
      <div className={cn("rounded-lg border border-foreground/15 bg-foreground/95 text-background shadow-inner font-mono text-sm leading-relaxed", compact ? "p-3" : "p-4")}>
        <div className="flex items-center justify-between border-b border-background/15 pb-2 mb-3">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-rose-500/70" />
            <span className="size-2.5 rounded-full bg-amber-500/70" />
            <span className="size-2.5 rounded-full bg-emerald-500/70" />
            <span className="text-[10px] text-background/55 uppercase tracking-[0.14em] font-mono ml-2">Prediction Terminal</span>
          </div>
          <Terminal className="size-3.5 text-background/55" />
        </div>

        <p className="break-words">
          <span className="text-background/55">guest@juno:~$</span> llm --predict
        </p>
        <p className="mt-2 break-words text-background/85 font-semibold leading-relaxed">
          {prompt}{" "}
          <span className="relative rounded bg-primary px-1.5 py-0.5 text-primary-foreground border border-primary/60 motion-safe:animate-pulse">
            {selectedToken}
            <span className="inline-block w-1.5 h-4 bg-primary-foreground/80 align-middle ml-1 motion-safe:animate-[blink_1s_infinite]" />
          </span>
        </p>
      </div>

      {/* Selector details block — stacks below sm (the arrow turns downward) like GenericProcessVisual. */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div className={cn("rounded-lg border bg-muted/20 text-center text-xs font-mono flex flex-col items-center", compact ? "p-2.5" : "p-3")}>
          <TrendingUp className="size-3.5 text-muted-foreground mb-1" />
          <span>Softmax logit scores</span>
        </div>
        <ArrowRight className="mx-auto size-4 rotate-90 text-primary motion-safe:animate-pulse shrink-0 sm:rotate-0" aria-hidden />
        <div className={cn("rounded-lg border bg-primary/5 text-center text-xs font-semibold font-mono flex flex-col items-center border-primary/25", compact ? "p-2.5" : "p-3")}>
          <Wand2 className="size-3.5 text-primary mb-1" />
          <span className="text-primary">Append &quot;{selectedToken}&quot;</span>
        </div>
      </div>

      <p className={cn("rounded-lg border bg-card text-xs sm:text-sm leading-relaxed text-muted-foreground", compact ? "px-3 py-2" : "px-3.5 py-2.5")}>
        The chosen token is appended back to the input prompt, and the entire transformer forward pass runs again to predict the subsequent token (autoregression loop).
      </p>
    </div>
  );
}

function GenericProcessVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const data = isRecord(step.data) ? step.data : {};
  const input = asString(data.input) ?? step.title;
  const transform = asString(data.transform ?? data.process) ?? step.summary;
  const output = asString(data.output) ?? "Clearer understanding";

  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
      {[input, transform, output].map((label, index) => (
        <React.Fragment key={`${label}-${index}`}>
          {index > 0 && <ArrowRight className="mx-auto hidden size-4 self-center text-primary sm:block shrink-0 motion-safe:animate-pulse" aria-hidden />}
          <div className={cn("rounded-lg border bg-card/65 flex flex-col justify-between", compact ? "p-2.5" : "p-3.5")}>
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground mb-1">
                {index === 0 ? "input" : index === 1 ? "transform" : "output"}
              </p>
              <p className="text-sm font-semibold leading-relaxed">{label}</p>
            </div>
            <div className={cn("h-1 w-8 rounded-full mt-3", index === 0 ? TOKEN_PALETTE[0].dot : index === 1 ? "bg-primary/60" : TOKEN_PALETTE[1].dot)} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function StepLabVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  if (step.visualType === "tokenization") return <TokenizationVisual step={step} compact={compact} />;
  if (step.visualType === "embedding") return <EmbeddingVisual step={step} compact={compact} />;
  if (step.visualType === "attention") return <AttentionVisual step={step} compact={compact} />;
  if (step.visualType === "transformer-processing") return <TransformerVisual step={step} compact={compact} />;
  if (step.visualType === "probability-distribution") return <ProbabilityVisual step={step} compact={compact} />;
  if (step.visualType === "next-token-selection") return <NextTokenSelectionVisual step={step} compact={compact} />;
  return <GenericProcessVisual step={step} compact={compact} />;
}

/** Thin 0->100% fill for the autoplay interval; remounted (keyed) per step to restart. */
function AutoplayFill() {
  const entered = useEnteredFrame();
  return (
    <div
      // duration must match AUTOPLAY_INTERVAL_MS
      className="h-full rounded-full bg-primary ease-linear motion-safe:transition-[width] motion-safe:duration-[2200ms]"
      style={{ width: entered ? "100%" : "0%" }}
    />
  );
}

function StepLabSidebar({
  steps,
  active,
  onSelect,
  compact,
}: {
  steps: StepLabStep[];
  active: number;
  onSelect: (index: number) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-y-auto rounded-lg border bg-muted/20 scrollbar-thin",
        compact ? "gap-1.5 max-h-44 p-1.5 lg:max-h-[19rem]" : "gap-2 max-h-56 p-2 lg:max-h-[23rem]"
      )}
    >
      {steps.map((step, index) => {
        const isActive = index === active;
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(index)}
            aria-current={isActive ? "step" : undefined}
            className={cn(
              "group flex w-full items-start gap-2.5 rounded-lg border text-left transition-all duration-base ease-out-soft hover:translate-x-0.5 hover:shadow-soft active:scale-[0.99]",
              compact ? "p-2" : "p-2.5",
              isActive
                ? "border-primary bg-primary/[0.03] shadow-soft motion-safe:translate-x-0.5 motion-safe:scale-[1.02]"
                : "border-border/60 bg-card/60 hover:border-primary/25 hover:bg-accent/50"
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md border font-mono text-[10px] font-bold transition-colors",
                isActive ? "border-primary bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground"
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block font-semibold leading-tight", compact ? "text-xs" : "text-sm", isActive && "text-primary")}>{step.title}</span>
              <span className="mt-1 line-clamp-2 block text-[11px] leading-tight text-muted-foreground">{step.summary}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StepLabQuizBlock({ quiz, compact }: { quiz: StepLabQuiz; compact?: boolean }) {
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedOption = selected == null ? null : quiz.options[selected];
  return (
    <div className={cn("rounded-lg border bg-muted/25", compact ? "p-2.5" : "p-3")}>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Check understanding</p>
      <h5 className={cn("mt-1 font-semibold leading-5", compact ? "text-xs" : "text-sm")}>{quiz.question}</h5>
      <div className="mt-2 grid gap-2">
        {quiz.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            onClick={() => setSelected(index)}
            className={cn(
              "pressable rounded-lg border bg-background/70 text-left hover:border-primary/35 coarse:min-h-11",
              compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm",
              selected === index && option.correct && "border-success/50 bg-success/10",
              selected === index && !option.correct && "border-destructive/40 bg-destructive/10"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {selectedOption && (
        <p className={cn("mt-2 leading-5 text-muted-foreground", compact ? "text-xs" : "text-sm")}>
          <span className="font-semibold text-foreground">{selectedOption.correct ? "Correct. " : "Not quite. "}</span>
          {selectedOption.explanation ?? "Review the active step and try again."}
        </p>
      )}
    </div>
  );
}

export const StepLabBlock = React.memo(function StepLabBlock({ lab, error }: { lab: StepLab; error?: string }) {
  const [active, setActive] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);
  const steps = lab.steps;
  const compact = lab.density === "compact";
  const selected = steps[Math.min(active, steps.length - 1)];

  React.useEffect(() => {
    setShowDetail(false);
  }, [active]);

  React.useEffect(() => {
    if (!playing || steps.length <= 1) return;
    const id = window.setInterval(() => {
      setActive((current) => {
        if (current >= steps.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, AUTOPLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, steps.length]);

  const go = React.useCallback(
    (next: number) => {
      setActive(Math.max(0, Math.min(steps.length - 1, next)));
    },
    [steps.length]
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(active + 1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(active - 1);
      }
    },
    [active, go]
  );

  return (
    <section
      className={cn("juno-step-lab overflow-hidden rounded-lg border bg-card text-foreground shadow-soft motion-safe:animate-rise-in", compact ? "my-3" : "my-4")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${lab.title} step lab`}
    >
      <div className={cn("border-b border-border/70 bg-card", compact ? "px-3 py-2.5" : "px-4 py-3")}>
        <div className="flex items-start gap-3">
          <span className={cn("mt-0.5 flex shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary shadow-soft", compact ? "size-8" : "size-9")}>
            <Layers3 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">
                {lab.label ?? "Step Lab"}
              </Badge>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {active + 1} of {steps.length}
              </span>
              {error && <Badge variant="outline" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">fallback</Badge>}
            </div>
            <h3 className={cn("mt-2 font-semibold leading-tight tracking-tight", compact ? "text-sm" : "text-base")}>{lab.title}</h3>
            {lab.description && <p className={cn("text-muted-foreground", compact ? "mt-0.5 text-xs leading-5" : "mt-1 text-sm leading-5")}>{lab.description}</p>}
          </div>
        </div>
      </div>

      <div className={cn("grid lg:grid-cols-[minmax(12rem,0.78fr)_minmax(0,1.45fr)]", compact ? "gap-2.5 p-2.5" : "gap-3 p-3")}>
        <StepLabSidebar steps={steps} active={active} onSelect={go} compact={compact} />
        <div className={cn("flex min-w-0 flex-col rounded-lg border bg-muted/20", compact ? "gap-2.5 p-2.5" : "gap-3 p-3")}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="muted" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">
                  {visualLabel(selected.visualType)}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">{Math.round(((active + 1) / steps.length) * 100)}%</span>
              </div>
              <h4 className={cn("mt-2 font-semibold leading-tight", compact ? "text-base" : "text-lg")}>{selected.title}</h4>
              <p className={cn("mt-1 text-muted-foreground", compact ? "text-xs leading-5" : "text-sm leading-5")}>{selected.summary}</p>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause Step Lab" : "Play Step Lab"}>
                    {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{playing ? "Pause" : "Auto-play"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setPlaying(false); go(0); }} aria-label="Restart Step Lab">
                    <RotateCcw data-icon="inline-start" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Restart</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Keyed by step so the stage remounts (and animates in) only on step change. */}
          <div
            key={`stage-${active}-${selected.id}`}
            onPointerDown={() => setPlaying(false)}
            className={cn(
              "rounded-lg border bg-card/60 motion-safe:animate-rise-in",
              compact ? "min-h-[10rem] p-2.5" : "min-h-[13rem] p-3"
            )}
          >
            <StepLabVisual step={selected} compact={compact} />
          </div>

          {playing && steps.length > 1 && (
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <AutoplayFill key={`autoplay-${active}-${selected.id}`} />
            </div>
          )}

          {selected.detail && (
            <div className="rounded-lg border bg-background/55 overflow-hidden">
              <button
                type="button"
                aria-expanded={showDetail}
                onClick={() => setShowDetail(!showDetail)}
                className={cn(
                  "w-full flex items-center justify-between text-xs sm:text-sm font-semibold leading-tight hover:bg-accent/10 transition-colors duration-fast coarse:min-h-11",
                  compact ? "px-2.5 py-2" : "px-3 py-2.5"
                )}
              >
                <span>Learn more details</span>
                <ChevronRight className={cn("size-4 text-muted-foreground transition-transform duration-base ease-out-soft", showDetail && "rotate-90 text-primary")} />
              </button>
              <Reveal open={showDetail}>
                <div className={cn(
                  "border-t border-dashed border-border/80 text-xs sm:text-sm leading-relaxed text-muted-foreground whitespace-pre-line",
                  compact ? "px-3 pb-2.5 pt-1.5" : "px-3.5 pb-3 pt-1.5"
                )}>
                  {selected.detail}
                </div>
              </Reveal>
            </div>
          )}

          {lab.quiz && active === steps.length - 1 && <StepLabQuizBlock quiz={lab.quiz} compact={compact} />}

          <div className={cn("flex flex-col gap-2 border-t border-border/70 sm:flex-row sm:items-center sm:justify-between", compact ? "pt-2.5" : "pt-3")}>
            <div className="flex items-center gap-0.5" aria-label="Step progress">
              {steps.map((step, index) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => go(index)}
                  aria-label={`Go to step ${index + 1}`}
                  aria-current={index === active ? "step" : undefined}
                  className="group/dot flex h-5 items-center justify-center px-1 coarse:h-7 coarse:px-1.5"
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full bg-muted transition-all duration-base ease-out-soft group-hover/dot:bg-muted-foreground/40",
                      index === active && "w-5 bg-primary group-hover/dot:bg-primary"
                    )}
                  />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={active === 0} onClick={() => go(active - 1)}>
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button type="button" size="sm" disabled={active === steps.length - 1} onClick={() => go(active + 1)}>
                Next
                <ChevronRight data-icon="inline-end" />
              </Button>
              {active === steps.length - 1 && (
                <Badge variant="success" className="rounded-md px-2 py-1">
                  <CheckCircle2 data-icon="inline-start" className="size-3.5" />
                  {lab.submitLabel ?? "Finish"}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});

StepLabBlock.displayName = "StepLabBlock";

export function StepLabFallback({ message }: { message?: string }) {
  return (
    <div className="my-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground motion-safe:animate-fade-in">
      <div className="flex items-center gap-2">
        <Wand2 className="size-4 text-primary motion-safe:animate-pulse" />
        <span>{message ?? "Building visual explanation..."}</span>
      </div>
    </div>
  );
}
