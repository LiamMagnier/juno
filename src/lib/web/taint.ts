/**
 * Whether outside content actually reached the model this turn (SPEC §6.5).
 *
 * The static flag decides whether the untrusted-content rule is in the system
 * prompt; this is the dynamic half, marked by tool executors and provider
 * search as it happens. The memory gate reads it: a tainted turn writes no
 * memory (INV-34), and `start_task` reads it at call time, asking always once
 * the turn has seen hostile content.
 *
 * Why two halves. The old single flag was decided at turn start from what
 * COULD appear (web on, connectors attached), so a web-on turn where the model
 * never searched still lost its memory write, and a turn where a provider's
 * own search quietly ran was judged clean. `observed` is set only when
 * something outside actually arrived; `staticContent` covers what was already
 * in the prompt before the first token (attachments, project knowledge, a
 * research report, a history note that carries web titles or URLs).
 *
 * Pure and free of `server-only`: the dispatcher, the turn stream and the
 * tests all hold one.
 */

export type TaintSource =
  | "web_fetch" | "web_search" | "provider_search" | "connector" | "read_document" | "search_chats";

export type TaintSeverity = "none" | "suspicious" | "hostile";

const RANK: Readonly<Record<TaintSeverity, number>> = { none: 0, suspicious: 1, hostile: 2 };

export class TurnTaint {
  private isObserved: boolean;
  private level: TaintSeverity = "none";
  private readonly marked = new Set<TaintSource>();

  /** `staticContent`: outside content is already in the prompt (attachments, a research report…). */
  constructor(opts: { staticContent: boolean }) {
    this.isObserved = opts.staticContent;
  }

  /**
   * Set by tool executors when outside content actually reached the model.
   * Idempotent, and a severity only ever rises: a later clean result never
   * launders an earlier hostile one.
   */
  mark(source: TaintSource, severity?: "suspicious" | "hostile"): void {
    this.isObserved = true;
    this.marked.add(source);
    if (severity && RANK[severity] > RANK[this.level]) this.level = severity;
  }

  get observed(): boolean {
    return this.isObserved;
  }

  get severity(): TaintSeverity {
    return this.level;
  }

  /** What marked the turn, in first-mark order. For audit rows and tests; never content. */
  get sources(): readonly TaintSource[] {
    return [...this.marked];
  }
}
