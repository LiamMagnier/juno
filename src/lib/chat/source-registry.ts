/**
 * The turn's one list of sources.
 *
 * Tool-side numbering (a `web_search` result the model is told to cite as [3])
 * and the persisted `Message.sources` order have to be the same list, or a
 * citation resolves to the wrong page. This registry is that list: every
 * source that reaches the turn — Juno search, a fetched page, provider search,
 * a research corpus — is registered here in order, normalised once (INV-3) and
 * numbered once.
 *
 * WS0 lands the class shell with its final method signatures; WS4 fills it in
 * (SPEC §2.11).
 */

import type { ClientSource } from "@/types/chat";
import type { ChatSourceOrigin } from "@/types/run";

/**
 * INV-3: title non-empty, single line, ≤ 2,000 UTF-8 bytes, falling back to the
 * URL host; `url` absolute http(s) with a host (otherwise the source is
 * dropped: `null`); `snippet` a string ≤ 32 KiB.
 */
export function normalizeSource(_raw: Partial<ClientSource> & { url: string }): ClientSource | null {
  throw new Error("not implemented: WS4");
}

export interface RegisteredSource {
  /** 1-based position in the turn's list. */
  n: number;
  source: ClientSource;
}

export class SourceRegistry {
  /** Registers in order, de-duplicating by exact normalised URL. Returns 1-based numbers (existing
   *  numbers for duplicates). `cited` marks the source as numbered for the model; `origin` is
   *  stamped on each new source (the first origin wins for duplicates). */
  register(
    _list: readonly ClientSource[],
    _opts: { cited: boolean; origin?: ChatSourceOrigin },
  ): RegisteredSource[] {
    throw new Error("not implemented: WS4");
  }

  /** Every source so far, in registration order. ≤ 100 per frame is enforced when framing. */
  all(): readonly ClientSource[] {
    throw new Error("not implemented: WS4");
  }

  /** Sources added since the last call (for profile-1 visit rows). */
  drainAdded(): ClientSource[] {
    throw new Error("not implemented: WS4");
  }
}
