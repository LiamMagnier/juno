/**
 * A model of OpenAI's GPT-5.6+ prompt cache, as the prompt-caching guide
 * documents it (developers.openai.com/api/docs/guides/prompt-caching,
 * read 2026-10-14), for measuring Responses request bodies offline:
 *
 *  - entries are created ONLY at breakpoints: each explicit
 *    `prompt_cache_breakpoint`, plus (implicit mode) the end of the latest
 *    eligible message: a user message, the last tool output of a run, or
 *    the last item of the opening system/developer block;
 *  - a request reads at its lookup boundaries only: its explicit
 *    breakpoints, the implicit one, and (implicit mode) the ends of up to 20
 *    earlier eligible messages and of the opening block; longest match wins;
 *  - explicit mode with no breakpoint neither reads nor writes;
 *  - billing: read tokens at the cached rate, tokens from the read point to
 *    the furthest write at the write rate (1.25x), the rest at the input rate.
 *
 * Tokens are estimated as serialized characters / 4, markers stripped: the
 * numbers are fixture numbers, for comparing two layouts of the same
 * conversation, never a production figure.
 */

type Item = Record<string, unknown>;

const strip = (value: unknown) => JSON.stringify(value, (key, v) => (key === "prompt_cache_breakpoint" ? undefined : v));

function hasBreakpoint(item: Item): boolean {
  const content = item.content;
  return Array.isArray(content) && content.some((part) => !!(part as Item)?.prompt_cache_breakpoint);
}

function eligible(items: Item[], i: number): boolean {
  const item = items[i];
  if (item.role === "user") return true;
  if (item.type === "function_call_output") return items[i + 1]?.type !== "function_call_output";
  if ((item.role === "system" || item.role === "developer") && items.slice(0, i + 1).every((x) => x.role === "system" || x.role === "developer")) {
    return !(items[i + 1]?.role === "system" || items[i + 1]?.role === "developer");
  }
  return false;
}

export interface SimRequest {
  tokens: number;
  read: number;
  written: number;
  fresh: number;
}

export function createOpenAICacheSim() {
  const entries = new Set<string>();
  return {
    send(body: { input: Item[]; prompt_cache_options?: { mode?: string } }): SimRequest {
      const items = body.input;
      const implicit = body.prompt_cache_options?.mode !== "explicit";
      // Cumulative prefix keys and token counts at each item end.
      const keys: string[] = [];
      const ends: number[] = [];
      let acc = "";
      let tokens = 0;
      for (const item of items) {
        const s = strip(item);
        acc += s;
        tokens += Math.ceil(s.length / 4);
        keys.push(acc);
        ends.push(tokens);
      }
      const explicit = items.map((item, i) => (hasBreakpoint(item) ? i : -1)).filter((i) => i >= 0);
      const eligibleEnds = items.map((_, i) => (eligible(items, i) ? i : -1)).filter((i) => i >= 0);
      const latestEligible = eligibleEnds.length ? eligibleEnds[eligibleEnds.length - 1] : -1;
      const writes = implicit && latestEligible >= 0 ? [...explicit, latestEligible] : explicit;
      const lookups = implicit ? [...new Set([...explicit, ...eligibleEnds.slice(-21)])] : explicit;

      let readAt = -1;
      for (const i of lookups) if (entries.has(keys[i]) && i > readAt) readAt = i;
      const read = readAt >= 0 ? ends[readAt] : 0;
      const furthestWrite = writes.length ? Math.max(...writes) : -1;
      const written = furthestWrite > readAt ? ends[furthestWrite] - read : 0;
      for (const i of writes) entries.add(keys[i]);
      return { tokens, read, written, fresh: tokens - read - written };
    },
  };
}

/** USD at per-MTok rates: cached reads, 1.25x writes, the rest at input. */
export function simCostUsd(requests: SimRequest[], rates: { input: number; cacheRead: number; cacheWrite: number }): number {
  let usd = 0;
  for (const r of requests) usd += (r.fresh * rates.input + r.read * rates.cacheRead + r.written * rates.cacheWrite) / 1_000_000;
  return usd;
}
