/**
 * The context-window selector's view model (DESIGN §5.10; INTERACTION I-16)
 * and the context gauge (§5.7). Reads the contract's `ContextTier[]` (built by
 * the models lane from pricing.ts) and the thread's size; never holds a rate.
 *
 * - Standard = the default (cheapest) tier; Long = any larger window, priced
 *   by the band the prompt falls in (a lab bills the band, not the window).
 * - Lean is offered for every model whose default window exceeds 200K: same
 *   rates, an earlier compaction, cheaper turns (`LEAN_TOKENS`).
 * - Subscription instances show plan language instead of dollars.
 */
import { estimateTierCostUsd, pickContextTier, type ContextTier, type SessionUsage, type UsageWindow } from "@/lib/code-v2/contracts";

export const LEAN_TOKENS = 128_000;
/** Expected output of a typical agent turn, for the "next turn" estimate. */
export const MEDIAN_TURN_OUTPUT = 2_000;
/** Reserve for the model's own output when no max is known. */
export const DEFAULT_MAX_OUTPUT = 16_000;

/** "272K", "1.05M", "128K". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(2))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(Math.round(tokens));
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatRate(perMTok: number): string {
  return perMTok >= 10 ? `$${perMTok.toFixed(2)}` : `$${perMTok.toFixed(2)}`;
}

/** SPEC §3.5: compact at floor(min(0.8·W, W − O − 65,536)), never below half the window. */
export function compactionThreshold(window: number, maxOutput = DEFAULT_MAX_OUTPUT): number {
  const t = Math.floor(Math.min(0.8 * window, window - maxOutput - 65_536));
  return Math.max(Math.floor(window / 2), t);
}

/** After compaction the engine keeps about the newest 16% of the window plus a summary (~5%). */
export function compactedSize(window: number): number {
  return Math.round(window * 0.21 / 1_000) * 1_000;
}

export type TierKind = "standard" | "long" | "lean";

export interface TierRow {
  tokens: number;
  kind: TierKind;
  name: string;
  windowLabel: string;
  selected: boolean;
  /** "$2.00 in · $10.00 out per million tokens" (absent on subscription). */
  priceLine?: string;
  /** "2× input and 1.5× output past 272K." · "Compacts at 217K." · "Same rates, compacts earlier." */
  deltaLine: string;
  /** "≈ $0.37" next turn, or null when the thread does not fit / subscription. */
  estimateUsd: number | null;
  /** The thread exceeds this window: selecting compacts first. */
  compactsNow: boolean;
  /** "Compacts now to about 100K" when compactsNow. */
  compactsNowLine?: string;
  unverified?: boolean;
}

export interface TierViewInput {
  tiers: readonly ContextTier[];
  /** Tokens in this thread's context now. */
  threadTokens: number;
  /** The chosen tier's tokens; absent = default. */
  selectedTokens?: number;
  /** Subscription: no dollars. */
  subscription?: boolean;
  maxOutput?: number;
  /** Fraction of the thread that is a cache hit next turn (0…1). */
  cacheHitRatio?: number;
}

function multiplier(a: number, b: number): string {
  const r = b > 0 ? a / b : 1;
  return `${Number(r.toFixed(2))}×`;
}

/** The selector's rows, smallest window first, with Lean added when it applies. */
export function tierRows(input: TierViewInput): TierRow[] {
  const sorted = [...input.tiers].sort((a, b) => a.tokens - b.tokens);
  if (sorted.length === 0) return [];
  const base = sorted[0];
  const all: { tier: ContextTier; kind: TierKind }[] = sorted.map((tier, i) => ({ tier, kind: i === 0 ? "standard" : "long" }));
  if (base.tokens > 200_000 && !sorted.some((t) => t.tokens <= LEAN_TOKENS)) {
    all.unshift({ tier: { ...base, tokens: LEAN_TOKENS, label: formatTokens(LEAN_TOKENS), note: undefined, unverified: undefined }, kind: "lean" });
  }
  const selectedTokens = input.selectedTokens ?? base.tokens;
  const cached = Math.round(input.threadTokens * (input.cacheHitRatio ?? 0));

  return all.map(({ tier, kind }) => {
    const threshold = compactionThreshold(tier.tokens, input.maxOutput);
    const compactsNow = input.threadTokens > threshold;
    // The band the prompt is billed at: the smallest real tier that fits it, capped at this tier.
    const promptTokens = compactsNow ? compactedSize(tier.tokens) : input.threadTokens;
    const band = kind === "lean" ? base : pickContextTier(sorted, promptTokens) ?? tier;
    const billed = band.tokens <= tier.tokens ? band : tier;
    const estimate = input.subscription
      ? null
      : estimateTierCostUsd(billed, { input: promptTokens, output: MEDIAN_TURN_OUTPUT, cachedInput: Math.min(cached, promptTokens) });

    let deltaLine: string;
    if (kind === "lean") deltaLine = `Same rates, compacts earlier, at ${formatTokens(threshold)}.`;
    else if (kind === "long") {
      const parts = [`${multiplier(tier.inputPerMTok, base.inputPerMTok)} input`];
      if (tier.outputPerMTok !== base.outputPerMTok) parts.push(`${multiplier(tier.outputPerMTok, base.outputPerMTok)} output`);
      deltaLine =
        tier.inputPerMTok === base.inputPerMTok && tier.outputPerMTok === base.outputPerMTok
          ? `Same rates. Compacts at ${formatTokens(threshold)}.`
          : `${parts.join(" and ")} past ${formatTokens(base.tokens)}.`;
    } else deltaLine = `Compacts at ${formatTokens(threshold)}.`;
    if (tier.unverified && tier.note) deltaLine = `${deltaLine} ${tier.note}.`;

    const priceLine = input.subscription
      ? undefined
      : kind === "long" && (tier.inputPerMTok !== base.inputPerMTok || tier.outputPerMTok !== base.outputPerMTok)
        ? `Same rates up to ${formatTokens(base.tokens)}, then ${formatRate(tier.inputPerMTok)} in · ${formatRate(tier.outputPerMTok)} out`
        : `${formatRate(tier.inputPerMTok)} in · ${formatRate(tier.outputPerMTok)} out per million tokens`;

    return {
      tokens: tier.tokens,
      kind,
      name: kind === "standard" ? "Standard" : kind === "lean" ? "Lean" : "Long",
      windowLabel: formatTokens(tier.tokens),
      selected: tier.tokens === selectedTokens,
      priceLine,
      deltaLine,
      estimateUsd: estimate === null ? null : Math.round(estimate * 100) / 100,
      compactsNow,
      compactsNowLine: compactsNow ? `Compacts now to about ${formatTokens(compactedSize(tier.tokens))}, then every ${formatTokens(Math.round((threshold - compactedSize(tier.tokens)) / 1000) * 1000)}.` : undefined,
      unverified: tier.unverified,
    };
  });
}

/** The muted delta the traits control previews while a row is hovered ("+$0.17", "−$0.05", "+$0.00"). */
export function estimateDelta(hovered: TierRow | undefined, current: TierRow | undefined): string | null {
  if (!hovered || !current || hovered.estimateUsd === null || current.estimateUsd === null) return null;
  const d = Math.round((hovered.estimateUsd - current.estimateUsd) * 100) / 100;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "+";
  return `${sign}$${Math.abs(d).toFixed(2)}`;
}

/** Ruler ticks: every tier boundary, as fractions of the largest window. */
export function rulerTicks(rows: readonly TierRow[]): { at: number; label: string }[] {
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return rows.map((r) => ({ at: r.tokens / max, label: r.windowLabel }));
}

export function cachedTurnLine(tier: ContextTier | undefined, threadTokens: number): string | null {
  if (!tier?.cachedInputPerMTok) return null;
  const cost = estimateTierCostUsd(tier, { input: threadTokens, cachedInput: threadTokens, output: MEDIAN_TURN_OUTPUT });
  return `Cached input is ${formatRate(tier.cachedInputPerMTok)} per million: a turn that hits the cache costs about ${formatUsd(cost)}. Estimates use this thread's size.`;
}

// ── Context gauge ───────────────────────────────────────────────────────────

export interface GaugeView {
  fraction: number;
  /** Past 80% of the auto-compact threshold: the wedge turns coral. */
  warn: boolean;
  usedLabel: string;
  headline: string;
  compactsLine?: string;
  costLine?: string;
}

export function gaugeView(usage: SessionUsage | undefined, planLabel?: string): GaugeView {
  const used = usage?.contextTokens ?? 0;
  const max = usage?.contextWindow ?? 0;
  if (!max) return { fraction: 0, warn: false, usedLabel: "0", headline: "Context", costLine: undefined };
  const fraction = Math.max(0, Math.min(1, used / max));
  const compactAt = usage?.autoCompactAt ?? compactionThreshold(max);
  const warn = used >= 0.8 * compactAt;
  const pct = Math.round(fraction * 100);
  const costLine =
    usage?.billing === "subscription"
      ? `Counts against your ${planLabel ?? "plan"}`
      : usage?.costUsd !== undefined
        ? `This thread so far: ${formatUsd(usage.costUsd)}`
        : undefined;
  return {
    fraction,
    warn,
    usedLabel: `${formatTokens(used)} of ${formatTokens(max)} (${pct}%)`,
    headline: "Context",
    compactsLine: `Compacts at ${formatTokens(compactAt)}`,
    costLine,
  };
}

/** SVG path of the filled wedge from 12 o'clock (16×16 box, r 5.5). Full circle is drawn by the caller. */
export function wedgePath(fraction: number, r = 5.5, c = 8): string {
  const f = Math.max(0, Math.min(0.999, fraction));
  if (f <= 0) return "";
  const a = f * 2 * Math.PI;
  const x = c + r * Math.sin(a);
  const y = c - r * Math.cos(a);
  return `M${c} ${c} L${c} ${c - r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
}

// ── Plan windows (subscriptions) ───────────────────────────────────────────

/** "5-hour 38% resets 16:40" — absolute times, short labels. */
export function windowLine(w: UsageWindow, now = new Date()): string {
  const parts = [w.label];
  if (w.usedPct !== undefined) parts.push(`${Math.round(w.usedPct)}%`);
  if (w.resetsAt) parts.push(`resets ${formatReset(w.resetsAt, now)}`);
  return parts.join(" ");
}

export function formatReset(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days >= 0 && days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The most constrained window (the one a Limited state names). */
export function tightestWindow(windows: readonly UsageWindow[] | undefined): UsageWindow | undefined {
  if (!windows?.length) return undefined;
  return [...windows].sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0];
}
