/**
 * The Alevr call id (chat-rework SPEC §4.3, RC-13).
 *
 * ONE id per call, used everywhere the call is named: the `tool` stream acts,
 * the activity row, the broker's idempotency key (with the generation id as the
 * session) and the execution lane's `ToolRun` key. It must therefore be
 *
 *   - STABLE: the same provider response, replayed (a reconnect, a resumed
 *     generation, the probe run twice), yields the same id. A random value per
 *     attempt — what three of the four adapters used to produce, or nothing at
 *     all — defeats replay protection rather than merely skipping it
 *     (`McpToolset.execute`'s contract in mcp.ts).
 *   - UNIQUE within a generation: provider ids are not. Kimi numbers its calls
 *     `functions.<name>:<idx>`, several compat hosts restart their numbering
 *     every response, and Gemini's id is optional. A repeat is suffixed with
 *     `#<round>.<index>`, which is itself a function of the stream, so it is as
 *     stable as the base.
 *
 * The PROVIDER id is a different thing and is never replaced: it is what goes
 * back on the wire (`tool_use_id`, `call_id`, `tool_call_id`,
 * `functionResponse.id`), because the provider pairs its own call with its own
 * id.
 */

/** The id a call is known by for the rest of the turn. */
export function stampCallId(
  providerCallId: string | undefined,
  round: number,
  index: number,
  taken: { has(id: string): boolean },
): string {
  const base = providerCallId && providerCallId.trim() ? providerCallId : `jc_${round}_${index}`;
  if (!taken.has(base)) return base;
  let id = `${base}#${round}.${index}`;
  for (let n = 2; taken.has(id); n += 1) id = `${base}#${round}.${index}.${n}`;
  return id;
}

/**
 * One generation's issuer. Issued ids are remembered at once, so two calls in
 * one response that carry the same provider id still come out distinct.
 */
export function createCallIdIssuer(seen: Set<string> = new Set()): (
  providerCallId: string | undefined,
  round: number,
  index: number,
) => string {
  return (providerCallId, round, index) => {
    const id = stampCallId(providerCallId, round, index, seen);
    seen.add(id);
    return id;
  };
}
