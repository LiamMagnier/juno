import type { Provider } from "../../src/lib/providers";

/** Where a fact came from: the page's URL and the day it was read. */
export interface Source {
  url: string;
  fetched: string; // YYYY-MM-DD
}

/** USD per 1M tokens, as the lab's own page prints it. */
export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface LongContext {
  threshold: number;
  /** A prompt of exactly `threshold` tokens is already in the higher band. */
  inclusive: boolean;
  inputMultiplier: number;
  outputMultiplier: number;
}

export type Lifecycle = "active" | "legacy" | "deprecated" | "retired";

/**
 * One model as ONE official page describes it. A lab usually needs several
 * pages (a price list, a model list, a deprecation table), so several facts
 * with the same `provider:id` are merged by `mergeFacts` — and any field two
 * pages disagree on is dropped and reported rather than picked.
 */
export interface ModelFact {
  provider: Provider;
  /** The id exactly as the lab's API takes it (dated snapshot ids are folded to their alias). */
  id: string;
  name?: string;
  description?: string;
  modality?: "chat" | "image" | "video" | "audio";
  contextWindow?: number;
  maxOutput?: number;
  released?: string; // YYYY-MM-DD
  vision?: boolean;
  reasoning?: boolean;
  lifecycle?: Lifecycle;
  /** The day after which the name stops answering — catalog `retiresOn` (last day it answers). */
  retiresOn?: string;
  /** The lab's named replacement, as an API id of the same provider. */
  replacement?: string;
  /** The day from which requests are silently served by `replacement`, when the lab publishes it (Xiaomi). */
  autoRoutedFrom?: string;
  /** Requests are ALREADY served by `replacement`, on a date the lab does not give (Google, DeepSeek). */
  autoRouted?: boolean;
  rates?: Rates;
  longContext?: LongContext | null;
  /** The lab publishes a fast/priority table: the rates in it, or null when this model is not in it. */
  fast?: Rates | null;
  /** OpenAI's Ultrafast tier (service_tier "ultrafast"), same convention as `fast`. */
  ultrafast?: Rates | null;
  /** The price is scheduled to change (a promo with an end date) — never written as a flat rate. */
  scheduledPrice?: string;
  /** A published zero ("Free"): reported, never written (billing keeps its metering floor). */
  free?: boolean;
  /** Notes worth a human's eye (peak pricing, region limits...). */
  notes?: string[];
  sources: Partial<Record<FactField, Source>>;
}

export type FactField =
  | "name"
  | "description"
  | "contextWindow"
  | "maxOutput"
  | "released"
  | "vision"
  | "reasoning"
  | "lifecycle"
  | "retiresOn"
  | "replacement"
  | "autoRoutedFrom"
  | "rates"
  | "longContext"
  | "fast"
  | "ultrafast"
  | "scheduledPrice"
  | "free"
  | "listed";

/** A page a lab parser needs, fetched (or read from a snapshot) before parsing. */
export interface PageSpec {
  key: string;
  url: string;
}

export interface LabParser {
  provider: Provider;
  pages: PageSpec[];
  /** Pure: page text in, facts out. Throws only on a page that is not the page it expects. */
  parse(pages: Record<string, string>, fetched: string): ModelFact[];
}

export type Severity = "change" | "warn" | "info";

export interface Finding {
  severity: Severity;
  kind:
    | "new-model"
    | "rate"
    | "long-context"
    | "fast-tier"
    | "context-window"
    | "retirement"
    | "lifecycle"
    | "auto-routed"
    | "capability"
    | "conflict"
    | "unverified"
    | "api-missing"
    | "api-new"
    | "discovery"
    | "expired"
    | "source-error";
  model?: string; // canonical provider:id
  message: string;
  current?: string;
  official?: string;
  sources?: Source[];
  /** Whether `--apply` writes this one. */
  applied?: boolean;
}
