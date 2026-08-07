import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * Juno's fontSize keys are words, not t-shirt sizes, so stock tailwind-merge has
 * no way to know `text-label` is a SIZE. It classifies it as a colour and drops
 * it whenever a real `text-*` colour follows: cn("text-label","text-muted-foreground")
 * emitted only the colour, discarding the size, its 1.4 leading and its tracking.
 *
 * Every type token passed through cn() next to a colour has therefore been dead
 * for the life of the codebase. Registering the keys in the font-size group is
 * what makes the type scale usable at all — see the hand-rolled workarounds this
 * replaces in card.tsx and label.tsx.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["hero", "display", "title", "heading", "body", "body-lg", "label", "caption"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}

/**
 * Per-item entrance delay for a staggered list, with a hard index cap.
 *
 * Nine different formulas had grown across twelve files, several of them capped
 * at 12 — a 480–660ms tail before the last item lands, which stops reading as
 * choreography and starts reading as slow loading. Capping the index at 5 holds
 * the whole stagger under ~200ms; 40ms is kept because it sits inside the
 * 40–60ms range Juno already used, so the felt rhythm is unchanged.
 *
 * Never stagger something the user is about to aim at — a model-picker row that
 * has not faded in yet is a row that cannot be clicked. The cap guarantees
 * everything past index 5 is live on the same frame.
 */
export const stagger = (i: number, step = 40) => ({ animationDelay: `${Math.min(i, 5) * step}ms` });

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function truncate(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Compact token count for UI: 940 · 1.2K · 34K · 1.20M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Money for tiny per-message costs: <$0.0001 · $0.0032 · $0.123 · $1.23. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
