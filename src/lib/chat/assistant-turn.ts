/**
 * Stage: persistence — how an assistant turn is written.
 *
 * A normal turn appends a Message row. A regenerate PRESERVES the previous
 * answer instead of destroying it: the old row's content is snapshotted into an
 * immutable MessageVersion (ciphertext copied verbatim — the crypto is
 * row-independent), its artifacts are dropped, and the Message row is then
 * overwritten in place. The Message row is therefore always the CURRENT
 * version; MessageVersion rows are append-only history rendered by the client's
 * "‹ 2/3 ›" pager.
 *
 * The Prisma calls stay in the route — this is the part of the decision that
 * can be stated without a database, and it is the part that was getting quietly
 * broken.
 */

/**
 * What to do with the `reasoningParts` column.
 *
 * The three-way distinction is the whole point. Appending a row with no parts
 * omits the column; *overwriting* a row with no parts must actively clear it. A
 * regenerate can swap a part-emitting model for one that sends none, and
 * leaving the old array behind shows the PREVIOUS answer's steps above the new
 * answer's reasoning — a fabricated chain of thought, assembled by an ORM
 * default.
 */
export type ReasoningPartsColumn =
  | { action: "set"; values: string[] }
  | { action: "clear" }
  | { action: "omit" };

/**
 * Each part is encrypted individually, exactly like the flat `reasoning` text —
 * same key, same path. The array shape stays in plaintext because the count of
 * steps is not the secret; their contents are.
 */
export function reasoningPartsColumn(
  parts: readonly string[],
  encrypt: (value: string) => string,
  mode: AssistantWriteMode
): ReasoningPartsColumn {
  if (parts.length) return { action: "set", values: parts.map(encrypt) };
  return mode === "supersede" ? { action: "clear" } : { action: "omit" };
}

export type AssistantWriteMode = "append" | "supersede";

/**
 * Whether this turn replaces an answer or adds one.
 *
 * The stale row can vanish mid-generation — deleted from another tab, or with
 * the whole conversation — and when it does the turn appends rather than
 * failing. The user asked for an answer; losing the request because the thing
 * it was going to replace is gone helps nobody.
 */
export function assistantWriteMode(
  staleAssistantId: string | null,
  staleRowExists: boolean
): AssistantWriteMode {
  return staleAssistantId && staleRowExists ? "supersede" : "append";
}

export interface AssistantTurnFields {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * The prompt-cache split of `promptTokens`, as the provider reported it.
   *
   * EXPLICIT `null`, NEVER `undefined`, and that is the whole reason these are
   * normalised here rather than passed through. Prisma reads `undefined` as
   * "leave this column alone", which is harmless on the append path and wrong
   * on the supersede path: regenerating a cached turn with a provider that
   * reports no cache buckets would leave the PREVIOUS answer's cache numbers
   * sitting under the new answer. That is the same trap `reasoningPartsColumn`
   * exists to close, and it produces a number that looks measured and is not.
   *
   * `null` itself still means "unknown", never "zero" — no reader may coalesce.
   */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Exact generation cost (tokens + cache + tool fees), micro-USD. */
  costMicroUsd: number | null;
}

/** The columns common to both write modes, with the text already encrypted. */
export function assistantTurnFields(
  data: {
    content: string;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costMicroUsd?: number | null;
  },
  encrypt: (value: string) => string
): AssistantTurnFields {
  return {
    content: encrypt(data.content),
    model: data.model,
    promptTokens: data.promptTokens,
    completionTokens: data.completionTokens,
    cacheReadTokens: data.cacheReadTokens ?? null,
    cacheWriteTokens: data.cacheWriteTokens ?? null,
    costMicroUsd: data.costMicroUsd ?? null,
  };
}

export interface StaleAssistantRow<Sources = unknown> {
  id: string;
  /** Already ciphertext. */
  content: string;
  reasoning: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  sources: Sources | null;
}

/**
 * Generic in the sources column so this module stays free of Prisma while the
 * route still gets a value its ORM accepts.
 */
export interface MessageVersionSnapshot<Sources = unknown> {
  messageId: string;
  content: string;
  reasoning: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  sources?: Sources;
}

/**
 * The immutable snapshot of the answer being replaced.
 *
 * `content` and `reasoning` are copied verbatim — they are already ciphertext,
 * and decrypting to re-encrypt would put plaintext in memory for no reason and
 * couple the history rows to the current key. `sources` is included only when
 * the original had them, because writing an explicit null and writing nothing
 * are different states in the column and only one of them means "this answer
 * cited nothing".
 */
export function versionSnapshot<Sources>(
  stale: StaleAssistantRow<Sources>
): MessageVersionSnapshot<Sources> {
  return {
    messageId: stale.id,
    content: stale.content,
    reasoning: stale.reasoning,
    model: stale.model,
    promptTokens: stale.promptTokens,
    completionTokens: stale.completionTokens,
    ...(stale.sources !== null ? { sources: stale.sources } : {}),
  };
}
