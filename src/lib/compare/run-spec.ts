import { isAutoModelId } from "@/lib/auto-model";
import { clampReasoningEffort, reasoningCaps } from "@/lib/model-metrics";
import { effortLabel } from "@/lib/router/receipt";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";

/**
 * The controlled input of one side-by-side comparison.
 *
 * A comparison is only fair if every model gets the same request. The spec is
 * frozen when the person presses Send. Every pane, including one that joins
 * later, is retried, or has its model swapped, runs from this spec and not
 * from whatever the composer holds now. `buildCompareRequestBody` is the
 * only place the request is assembled, and it differs between panes only in
 * `model` and `generationId`. Each pane records a fingerprint of the shared
 * part of the body it ACTUALLY sent, so "identical input" is something the
 * page checks, not something it claims.
 */

export interface CompareSettings {
  /** Offer provider web search to every model (each model's own search tool). */
  webSearch: boolean;
  /** One effort for every model; null asks each model for its own default. */
  reasoningEffort: ReasoningEffort | null;
}

export const DEFAULT_COMPARE_SETTINGS: CompareSettings = { webSearch: false, reasoningEffort: null };

export interface CompareRunSpec {
  /** One id per Send. */
  id: string;
  prompt: string;
  webSearch: boolean;
  reasoningEffort: ReasoningEffort | null;
  /** The browser's IANA zone, sent to every pane alike (current-time answers). */
  timeZone: string | null;
  /** Wall-clock ISO time the comparison was started. */
  createdAt: string;
  /** Fingerprint of the shared request body (see `sharedInputFingerprint`). */
  fingerprint: string;
}

/** The effort options a comparison offers, shallowest first. */
export const COMPARE_EFFORT_OPTIONS: ReadonlyArray<{ value: ReasoningEffort | null; label: string }> = [
  { value: null, label: "Model default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export function compareEffortLabel(effort: ReasoningEffort | null): string {
  return effort === null ? "Model default" : effortLabel(effort);
}

/** The /api/chat body for one pane. Panes differ only in `model` and `generationId`. */
export function buildCompareRequestBody(
  spec: Pick<CompareRunSpec, "prompt" | "webSearch" | "reasoningEffort" | "timeZone">,
  modelId: string,
  generationId: string
): Record<string, unknown> {
  return {
    message: spec.prompt,
    model: modelId,
    // Private transport: nothing is stored, spend and quota still recorded.
    privateMode: true,
    // Private chats carry their full history; here it is just the prompt.
    privateHistory: [{ role: "USER", content: spec.prompt }],
    webSearch: spec.webSearch,
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    ...(spec.timeZone ? { timeZone: spec.timeZone } : {}),
    generationId,
  };
}

/** The keys that may differ between two panes' requests. */
const PER_PANE_KEYS = new Set(["model", "generationId"]);

/** JSON with object keys sorted at every depth, so equal values serialise equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** cyrb53: a fast 53-bit string hash. Not cryptographic; it labels inputs, it does not protect them. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A short, stable fingerprint of everything in a request body EXCEPT the
 * per-pane keys. Two panes with the same fingerprint sent the same prompt,
 * history, search flag, effort and time zone.
 */
export function sharedInputFingerprint(body: Record<string, unknown>): string {
  const shared = Object.fromEntries(Object.entries(body).filter(([key]) => !PER_PANE_KEYS.has(key)));
  return cyrb53(stableStringify(shared)).toString(16).padStart(14, "0").slice(0, 10);
}

export function createRunSpec(input: {
  prompt: string;
  settings: CompareSettings;
  timeZone?: string | null;
  id: string;
  now?: Date;
}): CompareRunSpec {
  const base = {
    prompt: input.prompt,
    webSearch: input.settings.webSearch,
    reasoningEffort: input.settings.reasoningEffort,
    timeZone: input.timeZone?.trim() || null,
  };
  return {
    id: input.id,
    ...base,
    createdAt: (input.now ?? new Date()).toISOString(),
    // The fingerprint of the body every pane will send, model aside.
    fingerprint: sharedInputFingerprint(buildCompareRequestBody(base, "", "")),
  };
}

/** The browser's zone, or null where Intl cannot say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// ── Effort, as each model will take it ──────────────────────────────────────

export interface PlannedEffort {
  /** What the model is expected to run at; null = no effort sent. */
  effort: ReasoningEffort | null;
  /** False when a specific effort was asked for and this model cannot take it. */
  honoured: boolean;
  /** The model has a thinking control at all. */
  reasoning: boolean;
  /** Auto chooses its own effort per prompt; nothing can be planned. */
  auto: boolean;
}

/**
 * The effort a model will run at for a requested one, by the same rule the
 * server applies (`effectiveReasoningEffort` → `clampReasoningEffort`). This
 * is the PLAN, shown before a run. After a run the pane shows what the server
 * reported instead (`ClientMessage.applied`).
 */
export function plannedEffort(model: ModelInfo | undefined, requested: ReasoningEffort | null): PlannedEffort | null {
  if (!model) return null;
  if (isAutoModelId(model.id)) return { effort: null, honoured: true, reasoning: true, auto: true };
  if (!model.reasoning) return { effort: null, honoured: requested === null, reasoning: false, auto: false };
  const effort = clampReasoningEffort(model, requested);
  return { effort, honoured: requested === null || effort === requested, reasoning: true, auto: false };
}

/**
 * How an effort reads for one model. Null means no effort parameter was sent,
 * which is Instant on a model that can turn thinking off, the provider's own
 * behaviour on one that cannot, and nothing at all on a model without thinking.
 */
export function effortDisplay(model: ModelInfo | undefined, effort: ReasoningEffort | null): string {
  if (effort) return effortLabel(effort);
  if (!model) return "Unknown";
  if (isAutoModelId(model.id)) return "Auto";
  if (!model.reasoning) return "No thinking";
  const caps = reasoningCaps(model);
  return caps.canDisable ? "Instant" : "Provider default";
}
