"use client";

import * as React from "react";
import { BlockShell, CaptionLine, Reveal, TextToggle, LessonKicker, Microcap } from "@/components/chat/learning/block-shell";
import { QuizInteraction } from "@/components/chat/learning/quiz-block";
import { cn } from "@/lib/utils";
import type { StepLab, StepLabStep } from "@/lib/step-lab";

type TokenEntry = { text: string; id: number };
type VectorExample = { token: string; vector: number[] };
type Candidate = { token: string; probability: number; note?: string };

/* ── Data extraction (tolerant, with deterministic fallbacks) ─────────────── */

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

/** Deterministic PRNG — the SAMPLE draw must replay identically per press count. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True one frame after mount — lets width/transform transitions play from zero. */
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
  // Fall back whenever the parsed list can't draw an attention RELATION (<2
  // tokens) — matching the empty-after-filter convention of the other parsers.
  // An `Array.isArray`-only gate let `tokens: []` / one-token payloads through
  // and broke the arc geometry (query -1, endpoint at 150%).
  const parsedTokens = Array.isArray(data.tokens)
    ? data.tokens.map(asString).filter((token): token is string => !!token).slice(0, 7)
    : [];
  const fallback = fallbackTokens(step).map((token) => token.text).slice(0, 6);
  const tokens = parsedTokens.length >= 2 ? parsedTokens : fallback.length >= 2 ? fallback : ["input", "process", "output"];
  const matrix = Array.isArray(data.matrix)
    ? data.matrix
        .map((row) => (Array.isArray(row) ? row.map(asNumber).filter((value): value is number => value != null).slice(0, tokens.length) : []))
        .filter((row) => row.length)
        .slice(0, tokens.length)
    : [];
  if (tokens.length && matrix.length === tokens.length) return { tokens, matrix };
  const fallbackMatrix = tokens.map((_, rowIndex) =>
    tokens.map((__, colIndex) => {
      if (rowIndex === colIndex) return 0.16;
      const distance = Math.abs(rowIndex - colIndex);
      return Math.max(0.08, 0.42 - distance * 0.08);
    })
  );
  return { tokens, matrix: fallbackMatrix };
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

const showSpaces = (text: string) => text.replace(/ /g, "␣");

/* ── Visuals ──────────────────────────────────────────────────────────────
 * Every visual follows the same grammar: rendered directly on the paper (only
 * a field-needing chart gets the single bg-muted/30 well), exactly two inks
 * (foreground + coral) plus sanctioned semantic hues, one CaptionLine readout
 * whose empty state is the visual's action prompt, and motion ONLY as an A→B
 * response to the learner (or a one-shot self-drawing of the data encoding).
 */

/** Tokenization as typesetting: the same text re-set with visible boundaries. */
function TokenizationVisual({ step }: { step: StepLabStep }) {
  const { input, tokens } = tokenData(step);
  const [selected, setSelected] = React.useState<number | null>(null);
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const active = selected != null ? tokens[selected] : null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    const from = selected ?? 0;
    const next = event.key === "ArrowRight" ? Math.min(tokens.length - 1, from + 1) : Math.max(0, from - 1);
    setSelected(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-serif text-[15px] leading-6 text-muted-foreground">&ldquo;{input}&rdquo;</p>
      <div className="flex flex-wrap items-center gap-y-1 font-mono text-[13px] leading-8" role="group" aria-label="Tokens" onKeyDown={onKeyDown}>
        {tokens.map((token, index) => (
          <button
            key={index}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            tabIndex={index === (selected ?? 0) ? 0 : -1}
            aria-pressed={index === selected}
            onClick={() => setSelected(index)}
            className={cn(
              "rounded-sm px-1 py-0.5 outline-none transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring",
              index === selected
                ? "bg-primary/[0.12] text-primary"
                : index % 2 === 0
                  ? "bg-muted/70 hover:bg-muted"
                  : "bg-transparent hover:bg-muted/50"
            )}
          >
            {showSpaces(token.text)}
          </button>
        ))}
      </div>
      <CaptionLine prompt="Select a token" contentKey={selected ?? undefined}>
        {active && (
          <>
            T{selected} · &ldquo;{active.text}&rdquo; · vocab id <span className="text-foreground">{active.id}</span>
          </>
        )}
      </CaptionLine>
    </div>
  );
}

/** Embeddings as a lollipop chart whose stems MORPH between tokens. */
function EmbeddingVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const examples = vectorExamples(step);
  const [selected, setSelected] = React.useState(0);
  const [dim, setDim] = React.useState<number | null>(null);
  const active = examples[Math.min(selected, examples.length - 1)] ?? examples[0];
  const dims = active?.vector.length ?? 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label="Tokens">
        {examples.map((example, index) => (
          <button
            key={example.token}
            type="button"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index);
              setDim(null);
            }}
            className={cn(
              "group/tok relative py-1 font-mono text-[13px] outline-none transition-colors duration-base ease-out-soft",
              "focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
              selected === index ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {example.token}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-0 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform duration-base ease-spring",
                selected === index ? "scale-x-100" : "scale-x-0"
              )}
            />
          </button>
        ))}
      </div>

      {/* The chart well — stems and dots persist and MORPH on token switch. */}
      {active && (
        <div className="rounded-[10px] bg-muted/30 p-3">
          <div className={cn("relative", compact ? "h-28" : "h-32")}>
            <span aria-hidden className="absolute left-0 right-0 top-1/2 border-t border-dashed border-border/70" />
            <span aria-hidden className="absolute right-0 top-0 font-mono text-[10px] text-muted-foreground">+1</span>
            <span aria-hidden className="absolute right-0 top-1/2 -translate-y-full font-mono text-[10px] text-muted-foreground">0</span>
            <span aria-hidden className="absolute bottom-0 right-0 font-mono text-[10px] text-muted-foreground">−1</span>
            {active.vector.map((value, index) => {
              const clamped = Math.max(-1, Math.min(1, value));
              const positive = clamped >= 0;
              const magnitude = Math.abs(clamped) * 45; // % of half-height
              const center = `${(index + 0.5) * (100 / dims)}%`;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => setDim(index)}
                  aria-label={`Dimension ${index}: ${value.toFixed(3)}`}
                  className="absolute inset-y-0 w-8 -translate-x-1/2 outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-[8px]"
                  style={{ left: center }}
                >
                  <span
                    aria-hidden
                    className="absolute left-1/2 w-[1.5px] -translate-x-1/2 bg-foreground/25 transition-[top,height] duration-slow ease-out-expo"
                    style={{
                      top: positive ? `${50 - magnitude}%` : "50%",
                      height: `${magnitude}%`,
                      transitionDelay: `${index * 40}ms`,
                    }}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[top,background-color] duration-slow ease-out-expo",
                      positive ? "bg-primary" : "bg-foreground/60",
                      dim === index && "ring-2 ring-ring ring-offset-1 ring-offset-background"
                    )}
                    style={{ top: `${50 - clamped * 45}%`, transitionDelay: `${index * 40}ms` }}
                  />
                </button>
              );
            })}
          </div>
          <div className="flex pt-1" aria-hidden>
            {active.vector.map((_, index) => (
              <span key={index} className="flex-1 text-center font-mono text-[10px] text-muted-foreground">
                d{index}
              </span>
            ))}
          </div>
        </div>
      )}
      <CaptionLine prompt="Switch tokens — watch the shape change" contentKey={`${selected}:${dim}`}>
        {dim != null && active && (
          <>
            &ldquo;{active.token}&rdquo; · d{dim} = <span className="text-foreground">{active.vector[dim]?.toFixed(3)}</span>
          </>
        )}
      </CaptionLine>
    </div>
  );
}

/** Attention as an arc diagram: the query token reaches for its context. */
function AttentionVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  const { tokens, matrix } = attentionData(step);
  const [query, setQuery] = React.useState(Math.min(1, tokens.length - 1));
  const [matrixOpen, setMatrixOpen] = React.useState(false);
  const [cell, setCell] = React.useState<{ row: number; col: number } | null>(null);
  const matrixId = React.useId();
  const entered = useEnteredFrame();
  const row = matrix[query] ?? [];
  const strongest = row.reduce((best, value, index) => (index !== query && value > (row[best] ?? 0) ? index : best), query === 0 ? 1 : 0);
  const center = (index: number) => ((index + 0.5) / tokens.length) * 100;

  return (
    <div className="flex flex-col gap-2">
      {/* Arcs — SVG strokes don't scale (non-scaling-stroke); endpoint dot is HTML. */}
      <div className={cn("relative", compact ? "h-14" : "h-[72px]")}>
        <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 32" preserveAspectRatio="none">
          {tokens.map((_, target) => {
            if (target === query) return null;
            const weight = row[target] ?? 0;
            const x1 = center(query);
            const x2 = center(target);
            const lift = Math.min(30, 8 + Math.abs(x1 - x2) * 0.45);
            return (
              <path
                key={target}
                d={`M ${x1} 31 Q ${(x1 + x2) / 2} ${31 - lift} ${x2} 31`}
                fill="none"
                stroke="hsl(var(--primary))"
                strokeOpacity={entered ? 0.25 + weight * 0.6 : 0}
                strokeWidth={1 + weight * 2.5}
                vectorEffect="non-scaling-stroke"
                className="transition-[stroke-opacity,stroke-width] duration-base ease-out-soft"
              />
            );
          })}
        </svg>
        <span
          aria-hidden
          className="absolute bottom-0 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-primary transition-[left] duration-base ease-spring"
          style={{ left: `${center(strongest)}%` }}
        />
      </div>
      <div className="flex" role="group" aria-label="Query token">
        {tokens.map((token, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={index === query}
            onClick={() => {
              setQuery(index);
              setCell(null);
            }}
            className={cn(
              "group/q relative min-w-0 flex-1 truncate px-0.5 py-1 text-center font-mono text-[12px] outline-none",
              "transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
              index === query ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {token}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-2 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform duration-base ease-spring",
                index === query ? "scale-x-100" : "scale-x-0"
              )}
            />
          </button>
        ))}
      </div>

      {/* Weight strip — full-precision continuous bars. */}
      <div className="flex flex-col gap-1 pt-1">
        {tokens.map((token, target) => {
          if (target === query) return null;
          const weight = row[target] ?? 0;
          const pct = Math.round(weight * 100);
          const isStrongest = target === strongest;
          return (
            <div key={target} className="grid grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_2.5rem] items-center gap-3">
              <span className={cn("truncate font-mono text-[11px]", isStrongest ? "text-foreground" : "text-muted-foreground")}>{token}</span>
              <span className="h-[3px] overflow-hidden rounded-full bg-muted/60">
                <span
                  className={cn("block h-full rounded-full transition-[width] duration-base ease-out-soft", isStrongest ? "bg-primary" : "bg-primary/30")}
                  style={{ width: entered ? `${pct}%` : "0%" }}
                />
              </span>
              <span className={cn("text-right font-mono text-[11px] tabular-nums", isStrongest ? "font-semibold text-primary" : "text-muted-foreground")}>
                {pct}%
              </span>
            </div>
          );
        })}
      </div>

      <CaptionLine prompt="Select a query token" contentKey={cell ? `c${cell.row}:${cell.col}` : `q${query}`}>
        {cell ? (
          <>
            &ldquo;{tokens[cell.row]}&rdquo; → &ldquo;{tokens[cell.col]}&rdquo; · <span className="text-foreground">{Math.round((matrix[cell.row]?.[cell.col] ?? 0) * 100)}%</span>
          </>
        ) : (
          <>
            &ldquo;{tokens[query]}&rdquo; attends most to &ldquo;{tokens[strongest]}&rdquo; — <span className="text-foreground">{Math.round((row[strongest] ?? 0) * 100)}%</span>
          </>
        )}
      </CaptionLine>

      {/* The full matrix, demoted to curiosity. */}
      <TextToggle open={matrixOpen} onToggle={() => setMatrixOpen((value) => !value)} label="Matrix" controls={matrixId} />
      <Reveal open={matrixOpen} id={matrixId}>
        <div className="rounded-[10px] bg-muted/30 p-3">
          <div className="grid gap-0.5" style={{ gridTemplateColumns: `minmax(2.5rem,auto) repeat(${tokens.length}, minmax(1.25rem, 1fr))` }}>
            <span />
            {tokens.map((token, colIndex) => (
              <span key={colIndex} className="truncate text-center font-mono text-[10px] text-muted-foreground">
                {token}
              </span>
            ))}
            {tokens.map((rowToken, rowIndex) => (
              <React.Fragment key={rowIndex}>
                <span className={cn("truncate pr-1.5 text-right font-mono text-[10px] leading-6", rowIndex === query ? "text-primary" : "text-muted-foreground")}>
                  {rowToken}
                </span>
                {tokens.map((_, colIndex) => {
                  const value = matrix[rowIndex]?.[colIndex] ?? 0;
                  const isSelected = cell?.row === rowIndex && cell?.col === colIndex;
                  return (
                    <button
                      key={colIndex}
                      type="button"
                      onClick={() => {
                        setCell({ row: rowIndex, col: colIndex });
                        setQuery(rowIndex);
                      }}
                      aria-label={`${rowToken} attends to ${tokens[colIndex]}: ${Math.round(value * 100)} percent`}
                      className={cn(
                        "h-6 rounded-sm outline-none transition-shadow duration-fast focus-visible:ring-1 focus-visible:ring-ring",
                        isSelected && "ring-1 ring-primary"
                      )}
                      style={{ backgroundColor: `hsl(var(--primary) / ${Math.max(0.07, Math.min(0.8, value))})` }}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

const TRANSFORMER_STAGES = [
  {
    name: "Multi-head attention",
    role: "context exchange",
    copy: "Tokens exchange information in parallel — each one queries the sequence for what matters to it and folds the answers into its own representation.",
  },
  {
    name: "Feed-forward network",
    role: "stored knowledge",
    copy: "Each token's vector passes through deep linear layers where the model's learned facts and associations live, updating the token with what the model knows.",
  },
  {
    name: "Norm + residuals",
    role: "signal stability",
    copy: "Residual connections let the input bypass each block so nothing is lost, and normalization keeps activations in range — this is what makes very deep stacks trainable.",
  },
] as const;

/** The transformer as a vertical flow the learner steps a signal through. */
function TransformerVisual({ step }: { step: StepLabStep }) {
  const data = isRecord(step.data) ? step.data : {};
  const tokens = Array.isArray(data.tokens)
    ? data.tokens.map(asString).filter((token): token is string => !!token).slice(0, 5)
    : fallbackTokens(step).map((token) => token.text).slice(0, 5);
  const layers = typeof data.layers === "number" ? data.layers : 12;
  const [stage, setStage] = React.useState(0);

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-[11px] text-muted-foreground">
        {tokens.map((token, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="px-1.5 text-muted-foreground/50">·</span>}
            {token}
          </React.Fragment>
        ))}
      </p>

      <div className="flex gap-3">
        {/* The signal rail — ONE coral dot travels to the selected stage. */}
        <div aria-hidden className="relative w-1.5 shrink-0">
          <span className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border/60" />
          <span
            className="absolute left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary transition-[top] duration-base ease-spring"
            style={{ top: `calc(${((stage + 0.5) / TRANSFORMER_STAGES.length) * 100}% - 3px)` }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5" role="group" aria-label="Transformer stages">
          {TRANSFORMER_STAGES.map((item, index) => (
            <button
              key={index}
              type="button"
              aria-pressed={stage === index}
              onClick={() => setStage(index)}
              className={cn(
                "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-[10px] border border-l-2 px-3.5 py-2.5 text-left outline-none",
                "transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
                stage === index
                  ? "border-primary/30 border-l-primary bg-primary/[0.08]"
                  : "border-border/40 border-l-transparent hover:bg-accent/30"
              )}
            >
              <span className="font-serif text-sm font-medium text-foreground">{item.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{item.role}</span>
            </button>
          ))}
        </div>
        <div aria-hidden className="hidden shrink-0 flex-col items-center justify-center gap-1 sm:flex">
          <span className="h-6 w-px bg-border/60" />
          <span className="font-mono text-[11px] text-muted-foreground">×{layers}</span>
          <span className="h-6 w-px bg-border/60" />
        </div>
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">enriched representations ↓</p>
      <p key={stage} className="text-sm leading-6 text-muted-foreground motion-safe:animate-fade-in">
        {TRANSFORMER_STAGES[stage].copy}
      </p>
    </div>
  );
}

/** Probabilities as poll results — plus SAMPLE, the argmax-vs-sampling lesson. */
function ProbabilityVisual({ step }: { step: StepLabStep }) {
  const items = candidates(step);
  const entered = useEnteredFrame();
  const max = Math.max(...items.map((item) => item.probability), 0.01);
  const [focused, setFocused] = React.useState<number | null>(null);
  const [drawn, setDrawn] = React.useState<number | null>(null);
  const [sweep, setSweep] = React.useState<number | null>(null);
  const pressCount = React.useRef(0);
  const timeouts = React.useRef<number[]>([]);
  React.useEffect(() => () => timeouts.current.forEach((id) => window.clearTimeout(id)), []);

  const sample = () => {
    if (sweep != null) return; // one draw at a time
    pressCount.current += 1;
    const rand = mulberry32(pressCount.current * 2654435761)();
    const total = items.reduce((sum, item) => sum + item.probability, 0);
    let cursor = rand * total;
    let target = 0;
    for (let i = 0; i < items.length; i++) {
      cursor -= items[i].probability;
      if (cursor <= 0) {
        target = i;
        break;
      }
    }
    setDrawn(null);
    // One highlight pass down the rows, then settle on the drawn row.
    items.forEach((_, index) => {
      timeouts.current.push(
        window.setTimeout(() => {
          setSweep(index);
          if (index === items.length - 1) {
            timeouts.current.push(
              window.setTimeout(() => {
                setSweep(null);
                setDrawn(target);
              }, 90)
            );
          }
        }, index * 90)
      );
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col" role="group" aria-label="Next-token candidates">
        {items.map((item, index) => {
          const pct = Math.round(item.probability * 100);
          const isTop = index === 0;
          const isDrawn = drawn === index;
          return (
            <button
              key={index}
              type="button"
              onClick={() => setFocused(index)}
              onFocus={() => setFocused(index)}
              className={cn(
                "grid grid-cols-[1.5rem_minmax(0,1fr)_3.25rem] items-center gap-3 border-b border-l-2 border-border/25 py-2 text-left outline-none last:border-b-0",
                "transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring",
                sweep === index ? "bg-accent/50" : isDrawn ? "border-l-primary/70 bg-primary/[0.04]" : "border-l-transparent"
              )}
            >
              <span className="text-center font-mono text-[11px] text-muted-foreground">{index + 1}</span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-[13px] font-medium text-foreground">&ldquo;{item.token}&rdquo;</span>
                <span className="h-[3px] w-full overflow-hidden rounded-full">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width] duration-slow ease-out-expo",
                      isTop ? "bg-primary" : "bg-foreground/20"
                    )}
                    style={{ width: entered ? `${(item.probability / max) * 100}%` : "0%", transitionDelay: `${index * 40}ms` }}
                  />
                </span>
              </span>
              <span
                className={cn(
                  "text-right font-mono text-[12px] tabular-nums",
                  isDrawn ? "font-semibold text-primary" : isTop ? "font-semibold text-primary" : "text-muted-foreground"
                )}
              >
                {pct}%
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-baseline justify-between gap-3 pt-1">
        <CaptionLine
          prompt="Press Sample a few times"
          className="min-w-0 flex-1"
          contentKey={drawn != null ? `drawn-${drawn}-${pressCount.current}` : `note-${focused}`}
        >
          {drawn != null ? (
            <>
              sampled <span className="text-foreground">&ldquo;{items[drawn].token}&rdquo;</span> · {Math.round(items[drawn].probability * 100)}% likely
              {drawn !== 0 && " — not the top pick"}
            </>
          ) : focused != null && items[focused]?.note ? (
            items[focused].note
          ) : undefined}
        </CaptionLine>
        <button
          type="button"
          onClick={sample}
          className="shrink-0 rounded-[8px] py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary outline-none transition-colors duration-fast hover:text-primary focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
        >
          Sample
        </button>
      </div>
    </div>
  );
}

/** Next-token selection as a proofreader's insertion + the autoregression loop. */
function NextTokenSelectionVisual({ step }: { step: StepLabStep }) {
  const data = isRecord(step.data) ? step.data : {};
  const prompt = asString(data.prompt) ?? "The model predicts the next";
  const selectedToken = asString(data.selectedToken ?? data.token ?? data.output) ?? candidates(step)[0]?.token ?? "word";
  const [run, setRun] = React.useState(0);

  return (
    <div className="flex flex-col gap-3" key={run}>
      {/* Animation longhands (delay/iteration-count) live in inline styles, NOT
          arbitrary-property classes: the animate-* shorthand is emitted later in
          the stylesheet and silently resets them at equal specificity. The token
          is hidden-at-rest only under motion-safe, so reduced-motion users see
          it statically. */}
      <p className="font-serif text-[16px] leading-8 text-foreground">
        {prompt}{" "}
        <span
          aria-hidden
          className="inline-block h-[1.1em] w-px translate-y-[0.2em] bg-primary motion-safe:animate-blink"
          style={{ animationIterationCount: 3 }}
        />
        <span
          className="rounded-sm bg-primary/[0.12] px-1.5 font-medium text-primary motion-safe:opacity-0 motion-safe:animate-pop-in"
          style={{ animationDelay: "300ms" }}
        >
          {selectedToken}
        </span>
      </p>

      <div className="relative flex flex-col gap-1">
        <svg aria-hidden className="pointer-events-none absolute -top-2 right-2 h-5 w-40 max-w-[60%]" viewBox="0 0 160 20" fill="none">
          <path
            d="M 152 18 C 120 2, 40 2, 8 14"
            stroke="hsl(var(--foreground) / 0.4)"
            strokeWidth="1"
            strokeDasharray="160"
            className="motion-safe:animate-stroke-draw"
            style={{ "--draw-len": "160", animationDelay: "400ms" } as React.CSSProperties}
            markerEnd="url(#return-arrow)"
          />
          <defs>
            <marker id="return-arrow" viewBox="0 0 6 6" refX="4" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="hsl(var(--foreground) / 0.4)" strokeWidth="1" />
            </marker>
          </defs>
        </svg>
        <Microcap className="text-primary">Autoregression</Microcap>
        <p className="text-sm leading-6 text-muted-foreground">
          &ldquo;{selectedToken}&rdquo; joins the prompt; the whole forward pass runs again for the next token.
        </p>
      </div>

      <button
        type="button"
        onClick={() => setRun((value) => value + 1)}
        className="self-start rounded-[8px] py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground outline-none transition-colors duration-fast hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
      >
        Replay
      </button>
    </div>
  );
}

/** Generic process: three typographic stations, one one-shot causality pass. */
function GenericProcessVisual({ step }: { step: StepLabStep }) {
  const data = isRecord(step.data) ? step.data : {};
  const stations = [
    { cap: "input", value: asString(data.input) ?? step.title, capTone: "text-muted-foreground" },
    { cap: "transform", value: asString(data.transform ?? data.process) ?? step.summary, capTone: "text-primary" },
    { cap: "output", value: asString(data.output) ?? "Clearer understanding", capTone: "text-muted-foreground" },
  ];
  // One-shot dot pass: hop 0 (first connector) → hop 1 (second) → gone.
  const [hop, setHop] = React.useState<number | null>(null);
  React.useEffect(() => {
    const timers = [
      window.setTimeout(() => setHop(0), 350),
      window.setTimeout(() => setHop(1), 350 + 440),
      window.setTimeout(() => setHop(null), 350 + 880),
    ];
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-start">
      {stations.map((station, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <span aria-hidden className="relative hidden self-center px-1 font-mono text-[13px] text-muted-foreground/50 sm:block">
              →
              <span
                className={cn(
                  "absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary transition-[transform,opacity] duration-slow ease-out-soft motion-reduce:hidden",
                  hop === index - 1 ? "translate-x-4 opacity-100" : "translate-x-0 opacity-0"
                )}
              />
            </span>
          )}
          <div className={cn("flex flex-col gap-1", "border-l border-border/50 pl-4 sm:border-l-0 sm:pl-0")}>
            <Microcap className={cn("text-[10px]", station.capTone)}>{station.cap}</Microcap>
            <p className="font-serif text-[15px] leading-6 text-foreground">{station.value}</p>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function StepLabVisual({ step, compact }: { step: StepLabStep; compact?: boolean }) {
  if (step.visualType === "tokenization") return <TokenizationVisual step={step} />;
  if (step.visualType === "embedding") return <EmbeddingVisual step={step} compact={compact} />;
  if (step.visualType === "attention") return <AttentionVisual step={step} compact={compact} />;
  if (step.visualType === "transformer-processing") return <TransformerVisual step={step} />;
  if (step.visualType === "probability-distribution") return <ProbabilityVisual step={step} />;
  if (step.visualType === "next-token-selection") return <NextTokenSelectionVisual step={step} />;
  return <GenericProcessVisual step={step} />;
}

/* ── The lab ──────────────────────────────────────────────────────────────── */

export const StepLabBlock = React.memo(function StepLabBlock({ lab, error }: { lab: StepLab; error?: string }) {
  const steps = lab.steps;
  const compact = lab.density === "compact";
  const [active, setActive] = React.useState(0);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [quizCorrect, setQuizCorrect] = React.useState(false);
  const dirRef = React.useRef(1);
  const detailId = React.useId();
  const selected = steps[Math.min(active, steps.length - 1)];
  const last = steps.length - 1;
  const onLast = active === last;
  // Only labs with something to DO can be "completed" — a one-step quiz-less
  // lab would otherwise celebrate at mount, before any interaction.
  const completable = steps.length > 1 || !!lab.quiz;
  // Completion is sticky: once earned, the rail stays lit even navigating back.
  const [completedOnce, setCompletedOnce] = React.useState(false);
  const completed = completedOnce || (completable && onLast && (!lab.quiz || quizCorrect));
  React.useEffect(() => {
    if (completable && onLast && (!lab.quiz || quizCorrect)) setCompletedOnce(true);
  }, [completable, onLast, lab.quiz, quizCorrect]);

  React.useEffect(() => setDetailOpen(false), [active]);

  const go = React.useCallback(
    (next: number) => {
      setActive((current) => {
        const clamped = Math.max(0, Math.min(steps.length - 1, next));
        dirRef.current = clamped >= current ? 1 : -1;
        return clamped;
      });
    },
    [steps.length]
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      // Only when the shell ITSELF is focused: descendant controls (token
      // groups, matrix cells, sliders) own their arrow keys, and a bubbled
      // arrow press would remount the keyed stage and destroy their focus.
      if (event.target !== event.currentTarget) return;
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
    <BlockShell
      className="juno-step-lab"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${lab.title} step lab`}
    >
      {/* Header: kicker + the numbered step rail (the only meta), then title. */}
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <LessonKicker className="text-primary">{lab.label ?? "Step Lab"}</LessonKicker>
          {steps.length > 1 && (
            <span className="flex items-baseline" role="group" aria-label="Steps">
              {steps.map((step, index) => {
                const isActive = index === active;
                const isPast = index < active;
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => go(index)}
                    aria-current={isActive ? "step" : undefined}
                    aria-label={`Step ${index + 1}: ${step.title}`}
                    className={cn(
                      "group/rail relative px-1.5 py-1 font-mono text-[12px] tabular-nums outline-none",
                      "transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring",
                      "after:absolute after:-inset-1 after:content-[''] coarse:after:-inset-2",
                      completed
                        ? "text-primary"
                        : isActive
                          ? "text-primary"
                          : isPast
                            ? "text-foreground hover:text-primary"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                    style={completed ? { transitionDelay: `${Math.abs(index - active) * 30}ms` } : undefined}
                  >
                    {String(index + 1).padStart(2, "0")}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-x-1.5 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform duration-base ease-spring",
                        isActive ? "scale-x-100" : "scale-x-0"
                      )}
                    />
                  </button>
                );
              })}
            </span>
          )}
        </div>
        <h4 className="font-serif text-[21px] font-medium leading-tight tracking-[-0.01em]">{lab.title}</h4>
        {lab.description && !compact && <p className="text-[15px] leading-7 text-muted-foreground">{lab.description}</p>}
      </header>

      {/* Stage — keyed remount slides in from the travel direction. Reserved
          min-height so navigating never reflows the streaming text below. */}
      <div
        // Index in the key too — belt-and-braces against any duplicate ids the
        // parser dedupe might miss (legacy conversion paths).
        key={`${active}-${selected.id}`}
        className={cn(
          "flex flex-col motion-safe:animate-stage-in",
          compact ? "min-h-[10rem] gap-3 pt-3" : "min-h-[13rem] gap-4 pt-4"
        )}
        style={{ "--stage-dx": dirRef.current > 0 ? "12px" : "-12px" } as React.CSSProperties}
      >
        <div className="flex flex-col gap-1">
          <h5 className="font-serif text-[18px] font-medium leading-tight">{selected.title}</h5>
          <p className="text-[15px] leading-7 text-foreground/80">{selected.summary}</p>
        </div>

        <StepLabVisual step={selected} compact={compact} />

        {selected.notice && (
          <p className="flex gap-2 text-[14px] leading-6">
            <Microcap className="shrink-0 pt-0.5 text-primary">Notice</Microcap>
            <span className="min-w-0 font-serif italic text-foreground/75">{selected.notice}</span>
          </p>
        )}

        {selected.detail && (
          <div className="flex flex-col">
            <TextToggle open={detailOpen} onToggle={() => setDetailOpen((value) => !value)} label="More detail" controls={detailId} />
            <Reveal open={detailOpen} id={detailId}>
              <p className="whitespace-pre-line border-l border-border pl-4 pt-1 text-sm leading-7 text-foreground/85">
                {selected.detail}
              </p>
            </Reveal>
          </div>
        )}

        {/* The check — shared with the standalone quiz, so the two never drift. */}
        {lab.quiz && onLast && (
          <div className="flex flex-col gap-1 border-t border-border/50 pt-3">
            <Microcap className="text-primary">Check</Microcap>
            <p className="pb-1 font-serif text-[15px] font-medium leading-6">{lab.quiz.question}</p>
            <QuizInteraction
              quiz={{
                options: lab.quiz.options.map((option) => ({ label: option.label, correct: option.correct === true, explanation: option.explanation })),
                hint: lab.quiz.hint,
              }}
              onAnswered={(correct) => {
                if (correct) setQuizCorrect(true);
              }}
            />
          </div>
        )}

        {completed && onLast && (
          <div className="flex flex-col gap-2">
            <p className="flex items-baseline gap-2 font-serif text-[15px] italic leading-6 text-foreground/85">
              <span aria-hidden className="font-mono not-italic text-success motion-safe:animate-pop-in">✓</span>
              Lab complete
            </p>
            {lab.takeaway && (
              <p className="border-l-2 border-primary/70 pl-4 font-serif text-[16px] italic leading-7 text-foreground/85 motion-safe:animate-fade-in-up">
                {lab.takeaway}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer — quiet mono navigation; the rail above is the map. */}
      {steps.length > 1 && (
        <footer className="mt-4 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
          <button
            type="button"
            aria-disabled={active === 0}
            onClick={() => go(active - 1)}
            className={cn(
              "rounded-[8px] py-1 pr-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground outline-none",
              "transition-colors duration-fast hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
              active === 0 && "pointer-events-none opacity-40"
            )}
          >
            ‹ Previous
          </button>
          <span aria-live="polite" className="sr-only">
            Step {active + 1} of {steps.length} — {selected.title}
          </span>
          {error && <Microcap className="text-[10px] text-muted-foreground normal-case">approximate</Microcap>}
          <button
            type="button"
            aria-disabled={onLast}
            onClick={() => go(active + 1)}
            className={cn(
              "rounded-[8px] py-1 pl-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] outline-none",
              "transition-colors duration-fast focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
              onLast ? "pointer-events-none text-muted-foreground opacity-40" : "text-primary hover:text-primary",
            )}
          >
            Next ›
          </button>
        </footer>
      )}
    </BlockShell>
  );
});

StepLabBlock.displayName = "StepLabBlock";
