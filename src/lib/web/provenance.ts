/**
 * The provenance ledger: `web_fetch` opens a URL only if it appeared verbatim —
 * up to benign normalisation — in something the user typed in this
 * conversation or something the model was shown this turn (SPEC §6.2). URLs the
 * model wrote itself never count.
 *
 * WS0 lands the shell with its final signatures; WS2 implements it.
 */

import type { UrlLedgerKind, UrlLedgerMatch } from "@/lib/web/types";

export class UrlLedger {
  /** `cap`: untrusted entries kept (default 5,000); user-class entries are always kept. */
  constructor(_cap?: number) {}

  /** Adds every URL (and, for user text, every bare domain) found in `text`. */
  addText(_text: string, _kind: UrlLedgerKind, _ref?: string): void {
    throw new Error("not implemented: WS2");
  }

  add(_raw: string, _kind: UrlLedgerKind, _ref?: string, _opts?: { bareDomain: boolean }): void {
    throw new Error("not implemented: WS2");
  }

  /** The matching entry, if any; user class wins over untrusted. */
  match(_raw: string): UrlLedgerMatch | null {
    throw new Error("not implemented: WS2");
  }
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
}

export async function buildUrlLedger(_turn: LedgerTurnInput): Promise<UrlLedger> {
  throw new Error("not implemented: WS2");
}
