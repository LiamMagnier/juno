"use client";

import * as React from "react";
import {
  AlertCircle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Circle,
  CornerDownRight,
  GitBranch,
  HelpCircle,
  Layers3,
  Lightbulb,
  ListChecks,
  Maximize2,
  Wand2,
  Table2,
  XCircle,
} from "lucide-react";
import { StepLabBlock } from "@/components/chat/step-lab-block";
import { stepLabFromLegacySteps } from "@/lib/step-lab";
import { cn } from "@/lib/utils";

type VisualKind = "cards" | "steps" | "flow" | "flowchart" | "diagram" | "comparison" | "table" | "quiz" | "callout" | "timeline";

interface VisualItem {
  title?: string;
  label?: string;
  body?: string;
  text?: string;
  detail?: string;
  value?: string;
  tone?: string;
}

interface VisualOption extends VisualItem {
  correct?: boolean;
  explanation?: string;
}

interface VisualRow extends VisualItem {
  values?: unknown;
}

interface VisualEdge {
  from?: string;
  to?: string;
  label?: string;
}

interface VisualBlock {
  type: VisualKind;
  title?: string;
  subtitle?: string;
  body?: string;
  items?: VisualItem[];
  steps?: VisualItem[];
  cards?: VisualItem[];
  nodes?: VisualItem[];
  edges?: VisualEdge[];
  columns?: string[];
  rows?: VisualRow[];
  question?: string;
  options?: VisualOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(asString).filter(Boolean) as string[];
  return out.length ? out : undefined;
}

function visualItem(value: unknown): VisualItem | null {
  if (typeof value === "string") return { body: value };
  if (!isRecord(value)) return null;
  return {
    title: asString(value.title ?? value.name),
    label: asString(value.label ?? value.step ?? value.id ?? value.date),
    body: asString(value.body ?? value.description ?? value.content),
    text: asString(value.text),
    detail: asString(value.detail ?? value.details),
    value: asString(value.value),
    tone: asString(value.tone),
  };
}

function itemArray(value: unknown): VisualItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(visualItem).filter(Boolean) as VisualItem[];
  return out.length ? out : undefined;
}

function optionArray(value: unknown): VisualOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => {
      const base = visualItem(item);
      if (!base) return null;
      return {
        ...base,
        correct: isRecord(item) ? item.correct === true : undefined,
        explanation: isRecord(item) ? asString(item.explanation ?? item.why) : undefined,
      };
    })
    .filter(Boolean) as VisualOption[];
  return out.length ? out : undefined;
}

function rowArray(value: unknown): VisualRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => {
      const base = visualItem(item);
      if (!base) return null;
      return { ...base, values: isRecord(item) ? item.values ?? item.cells : undefined };
    })
    .filter(Boolean) as VisualRow[];
  return out.length ? out : undefined;
}

function edgeArray(value: unknown): VisualEdge[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter(isRecord)
    .map((edge) => ({ from: asString(edge.from), to: asString(edge.to), label: asString(edge.label) }))
    .filter((edge) => edge.from || edge.to || edge.label);
  return out.length ? out : undefined;
}

function parseVisualBlock(source: string): VisualBlock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const type = (asString(raw.type ?? raw.kind) ?? "cards").toLowerCase() as VisualKind;
  const allowed: VisualKind[] = ["cards", "steps", "flow", "flowchart", "diagram", "comparison", "table", "quiz", "callout", "timeline"];
  if (!allowed.includes(type)) return null;

  return {
    type,
    title: asString(raw.title),
    subtitle: asString(raw.subtitle ?? raw.description),
    body: asString(raw.body ?? raw.text),
    items: itemArray(raw.items),
    steps: itemArray(raw.steps),
    cards: itemArray(raw.cards),
    nodes: itemArray(raw.nodes),
    edges: edgeArray(raw.edges),
    columns: stringArray(raw.columns),
    rows: rowArray(raw.rows),
    question: asString(raw.question),
    options: optionArray(raw.options),
  };
}

function primaryText(item: VisualItem): string {
  return item.body ?? item.text ?? item.detail ?? item.value ?? "";
}

function itemTitle(item: VisualItem, fallback: string): string {
  return item.title ?? item.label ?? fallback;
}

function itemsFor(block: VisualBlock): VisualItem[] {
  return block.items ?? block.steps ?? block.cards ?? block.nodes ?? [];
}

function iconFor(type: VisualKind) {
  if (type === "steps") return ListChecks;
  if (type === "flow" || type === "flowchart" || type === "diagram") return GitBranch;
  if (type === "comparison" || type === "table") return Table2;
  if (type === "quiz") return HelpCircle;
  if (type === "callout") return Lightbulb;
  if (type === "timeline") return Layers3;
  return Brain;
}

function typeLabel(type: VisualKind): string {
  if (type === "steps") return "Step lab";
  if (type === "flow" || type === "flowchart" || type === "diagram") return "Flow map";
  if (type === "comparison" || type === "table") return "Compare";
  if (type === "quiz") return "Quick check";
  if (type === "callout") return "Key idea";
  if (type === "timeline") return "Timeline";
  return "Visual cards";
}

function itemCount(block: VisualBlock): number {
  if (block.type === "quiz") return block.options?.length ?? 0;
  if (block.type === "comparison" || block.type === "table") return block.rows?.length ?? 0;
  return itemsFor(block).length;
}

function Header({ block }: { block: VisualBlock }) {
  const Icon = iconFor(block.type);
  const count = itemCount(block);
  return (
    <div className="border-b border-border/70 bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-primary/10 shadow-soft">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border bg-muted/45 px-2 py-1 font-mono text-[10px] text-muted-foreground">
              {typeLabel(block.type)}
            </span>
            {count > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {count} {count === 1 ? "part" : "parts"}
              </span>
            )}
          </div>
          {block.title && <h3 className="mt-2 text-lg font-semibold leading-tight tracking-tight">{block.title}</h3>}
          {block.subtitle && <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{block.subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

function CardsBlock({ block }: { block: VisualBlock }) {
  const items = itemsFor(block);
  const [active, setActive] = React.useState(0);
  const selected = items[Math.min(active, Math.max(0, items.length - 1))];
  if (items.length === 0) return null;
  return (
    <div className="grid gap-3 p-3 md:grid-cols-[0.95fr_1.25fr]">
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1">
        {items.map((item, index) => {
          const isActive = index === active;
          return (
            <button
              key={index}
              type="button"
              onPointerDown={() => setActive(index)}
              onClick={() => setActive(index)}
              className={cn(
                "group flex min-h-20 items-start gap-3 rounded-lg border bg-background/65 p-3 text-left transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent/35 active:translate-y-0 active:scale-[0.99]",
                isActive && "border-primary/55 bg-primary/10 shadow-soft"
              )}
            >
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-card font-mono text-[11px] font-semibold transition-colors duration-base ease-out-soft", isActive && "border-primary/40 text-primary")}>
                {item.label ?? index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-5">{itemTitle(item, `Card ${index + 1}`)}</span>
                {primaryText(item) && <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{primaryText(item)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {/* Keyed so the focus panel animates on each selection. */}
      <div key={active} className="rounded-lg border bg-muted/30 p-4 motion-safe:animate-fade-in">
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <Maximize2 className="h-3.5 w-3.5" /> Focus
        </div>
        <h4 className="mt-3 text-base font-semibold leading-6">{itemTitle(selected, "Selected card")}</h4>
        {primaryText(selected) && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">{primaryText(selected)}</p>}
        {selected.detail && selected.detail !== primaryText(selected) && (
          <p className="mt-3 rounded-md bg-background/65 px-3 py-2 text-sm leading-6 text-muted-foreground">{selected.detail}</p>
        )}
      </div>
    </div>
  );
}

function FlowBlock({ block }: { block: VisualBlock }) {
  const nodes = itemsFor(block);
  const [active, setActive] = React.useState(0);
  const selected = nodes[Math.min(active, Math.max(0, nodes.length - 1))];
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">
        {nodes.map((node, index) => {
          const isActive = index === active;
          return (
          <React.Fragment key={index}>
            <button
              type="button"
              onPointerDown={() => setActive(index)}
              onClick={() => setActive(index)}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-lg border bg-background/65 p-3 text-left transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent/35 active:translate-y-0 active:scale-[0.99]",
                isActive && "border-primary/55 bg-primary/10 shadow-soft"
              )}
            >
              <Circle className={cn("mt-1 h-3.5 w-3.5 shrink-0 fill-muted text-muted-foreground", isActive && "fill-primary/25 text-primary")} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-5">{itemTitle(node, `Node ${index + 1}`)}</span>
                {primaryText(node) && <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{primaryText(node)}</span>}
              </span>
            </button>
            {index < nodes.length - 1 && (
              <div className="hidden items-center justify-center text-muted-foreground sm:flex">
                <ArrowRight className="h-4 w-4" />
              </div>
            )}
          </React.Fragment>
          );
        })}
      </div>
      {/* Keyed so the detail panel animates on each selection. */}
      <div key={active} className="rounded-lg border bg-muted/30 p-4 motion-safe:animate-fade-in">
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <CornerDownRight className="h-3.5 w-3.5 text-primary" /> Selected node
        </div>
        <h4 className="mt-3 text-lg font-semibold leading-tight">{itemTitle(selected, `Node ${active + 1}`)}</h4>
        {primaryText(selected) && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">{primaryText(selected)}</p>}
      </div>
      {block.edges && block.edges.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {block.edges.map((edge, index) => (
            <span key={index} className="rounded-md border bg-muted/45 px-2 py-1 font-mono text-[10px] text-muted-foreground">
              {[edge.from, edge.label, edge.to].filter(Boolean).join(" -> ")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function valueFor(row: VisualRow, column: string, index: number): string {
  const values = row.values;
  if (Array.isArray(values)) return asString(values[index]) ?? "";
  if (isRecord(values)) return asString(values[column] ?? values[column.toLowerCase()] ?? values[index]) ?? "";
  return index === 0 ? primaryText(row) : "";
}

function ComparisonBlock({ block }: { block: VisualBlock }) {
  const columns = block.columns?.length ? block.columns : ["Option A", "Option B"];
  const rows = block.rows?.length ? block.rows : itemsFor(block).map((item) => ({ ...item, values: [primaryText(item)] }));
  return (
    <div className="overflow-x-auto p-3">
      <div className="min-w-[34rem] space-y-2">
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `minmax(7rem, 0.8fr) repeat(${columns.length}, minmax(9rem, 1fr))` }}
      >
        <div className="rounded-lg border bg-muted/45 px-3 py-2 font-mono text-[10px] text-muted-foreground">
          Focus
        </div>
        {columns.map((col) => (
          <div key={col} className="rounded-lg border bg-muted/45 px-3 py-2 text-sm font-semibold">
            {col}
          </div>
        ))}
      </div>
      <div className="space-y-2 overflow-x-auto pb-1">
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="grid min-w-[34rem] gap-2"
            style={{ gridTemplateColumns: `minmax(7rem, 0.8fr) repeat(${columns.length}, minmax(9rem, 1fr))` }}
          >
            <div className="rounded-lg border bg-background/65 px-3 py-3 text-sm font-semibold">{itemTitle(row, `Row ${rowIndex + 1}`)}</div>
            {columns.map((col, colIndex) => (
              <div key={col} className="rounded-lg border bg-card/50 px-3 py-3 text-sm leading-6 text-muted-foreground">
                {valueFor(row, col, colIndex)}
              </div>
            ))}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

function QuizBlock({ block }: { block: VisualBlock }) {
  const options = block.options ?? [];
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedOption = selected == null ? null : options[selected];
  return (
    <div className="space-y-3 p-4">
      <div>
        <p className="font-mono text-[10px] text-muted-foreground">Quick check</p>
        <h4 className="mt-1 text-base font-semibold leading-snug">{block.question ?? block.title ?? "Which option fits best?"}</h4>
      </div>
      <div className="grid gap-2">
        {options.map((option, index) => {
          const active = selected === index;
          const answered = selected !== null;
          const correct = option.correct === true;
          return (
            <button
              key={index}
              type="button"
              onPointerDown={() => setSelected(index)}
              onClick={() => setSelected(index)}
              className={cn(
                "group flex items-start gap-3 rounded-lg border bg-background/65 p-3 text-left transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent/35 active:translate-y-0 active:scale-[0.99]",
                active && correct && "border-success/60 bg-success/10 shadow-soft",
                active && answered && !correct && "border-destructive/50 bg-destructive/10 shadow-soft"
              )}
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-card font-mono text-[10px] font-semibold">
                {active && correct ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : active ? <XCircle className="h-3.5 w-3.5 text-destructive" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-5">{itemTitle(option, `Option ${index + 1}`)}</span>
                {primaryText(option) && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{primaryText(option)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {selectedOption && (
        <div
          className={cn(
            "rounded-lg border px-3 py-3 text-sm leading-6 motion-safe:animate-rise-in",
            selectedOption.correct === true ? "border-success/45 bg-success/10" : "border-destructive/40 bg-destructive/10"
          )}
        >
          <span className="font-semibold">{selectedOption.correct === true ? "Correct. " : "Not quite. "}</span>
          <span className="text-muted-foreground">
            {selectedOption.explanation ?? selectedOption.detail ?? "Try comparing the options against the main idea above."}
          </span>
        </div>
      )}
    </div>
  );
}

function CalloutBlock({ block }: { block: VisualBlock }) {
  const items = itemsFor(block);
  return (
    <div className="space-y-3 p-4">
      {block.body && <p className="text-sm leading-6 text-muted-foreground">{block.body}</p>}
      {items.length > 0 && (
        <div className="grid gap-2">
          {items.map((item, index) => (
            <div key={index} className="flex gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <Wand2 className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" />
              <p className="text-sm leading-6">
                <span className="font-semibold">{itemTitle(item, `Point ${index + 1}`)}</span>
                {primaryText(item) ? <span className="text-muted-foreground"> - {primaryText(item)}</span> : null}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineBlock({ block }: { block: VisualBlock }) {
  const items = itemsFor(block);
  return (
    <div className="p-4">
      {items.map((item, index) => (
        <div
          key={index}
          className="grid grid-cols-[5rem_1fr] gap-3 border-l border-border pb-4 pl-3 last:pb-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          style={{ animationDelay: `${index * 40}ms` }}
        >
          <span className="-ml-[1.35rem] flex h-6 w-16 items-center justify-center rounded-full border bg-card font-mono text-[10px] text-muted-foreground shadow-soft">
            {item.label ?? index + 1}
          </span>
          <div>
            <h4 className="text-sm font-semibold leading-5">{itemTitle(item, `Moment ${index + 1}`)}</h4>
            {primaryText(item) && <p className="mt-1 text-sm leading-6 text-muted-foreground">{primaryText(item)}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function VisualBody({ block }: { block: VisualBlock }) {
  if (block.type === "flow" || block.type === "flowchart" || block.type === "diagram") return <FlowBlock block={block} />;
  if (block.type === "comparison" || block.type === "table") return <ComparisonBlock block={block} />;
  if (block.type === "quiz") return <QuizBlock block={block} />;
  if (block.type === "callout") return <CalloutBlock block={block} />;
  if (block.type === "timeline") return <TimelineBlock block={block} />;
  return <CardsBlock block={block} />;
}

export function InlineVisualBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const block = React.useMemo(() => parseVisualBlock(source), [source]);

  if (!block) {
    return (
      <div className="my-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          {streaming ? <Wand2 className="h-4 w-4 animate-pulse text-primary" /> : <AlertCircle className="h-4 w-4 text-warning" />}
          <span>{streaming ? "Drawing inline visual..." : "This inline visual could not be rendered."}</span>
        </div>
      </div>
    );
  }

  if (block.type === "steps") {
    return (
      <StepLabBlock
        lab={stepLabFromLegacySteps({
          title: block.title,
          description: block.subtitle ?? block.body,
          label: "Step Lab",
          steps: itemsFor(block),
        })}
      />
    );
  }

  return (
    <section className="juno-visual my-4 overflow-hidden rounded-lg border bg-card text-foreground shadow-soft motion-safe:animate-rise-in">
      <Header block={block} />
      <VisualBody block={block} />
    </section>
  );
}
