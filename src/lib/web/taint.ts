/**
 * Whether outside content actually reached the model this turn (SPEC §6.5).
 *
 * The static flag decides whether the untrusted-content rule is in the system
 * prompt; this is the dynamic half, marked by tool executors and provider
 * search as it happens. The memory gate reads it: a tainted turn writes no
 * memory (INV-34).
 *
 * WS0 lands the shell with its final signatures; WS2 implements it.
 */

export type TaintSource =
  | "web_fetch" | "web_search" | "provider_search" | "connector" | "read_document" | "search_chats";

export class TurnTaint {
  /** `staticContent`: outside content is already in the prompt (attachments, a research report…). */
  constructor(_opts: { staticContent: boolean }) {}

  /** Set by tool executors when outside content actually reached the model. */
  mark(_source: TaintSource, _severity?: "suspicious" | "hostile"): void {
    throw new Error("not implemented: WS2");
  }

  get observed(): boolean {
    throw new Error("not implemented: WS2");
  }

  get severity(): "none" | "suspicious" | "hostile" {
    throw new Error("not implemented: WS2");
  }
}
