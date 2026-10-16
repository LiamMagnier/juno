import type { ClientActivityEvent, ClientMemoryReceipt, ClientMemoryWrite } from "@/types/chat";

/*
 * WHAT AN ANSWER HAD TO DO WITH MEMORY, read off its saved activity.
 *
 * Two rows carry it, both written by the chat turn and saved with the answer:
 * "Remembered about you" (`memoryReceipt`: the facts the turn was given) and
 * "Memory updated" / "Forgotten" (`memoryWrite`: what the turn saved or
 * forgot). The answer's memory receipt and the "Memory updated" notice read
 * them through this one function, so the two can never disagree about what a
 * turn used or changed.
 *
 * Pure and client-safe.
 */

export interface AnswerMemory {
  /** Facts the answer was given, in the order the turn listed them. */
  used: ClientMemoryReceipt[];
  /** Facts the turn saved, or believed again. */
  saved: ClientMemoryReceipt[];
  /** Statements the turn forgot because the person asked it to. */
  forgotten: string[];
}

const EMPTY: AnswerMemory = { used: [], saved: [], forgotten: [] };

export function answerMemory(activity: readonly ClientActivityEvent[] | null | undefined): AnswerMemory {
  if (!activity?.length) return EMPTY;
  const used = new Map<string, ClientMemoryReceipt>();
  const saved = new Map<string, ClientMemoryReceipt>();
  const forgotten: string[] = [];
  for (const event of activity) {
    for (const receipt of event.memoryReceipt ?? []) if (!used.has(receipt.id)) used.set(receipt.id, receipt);
    for (const receipt of event.memoryWrite?.saved ?? []) if (!saved.has(receipt.id)) saved.set(receipt.id, receipt);
    for (const statement of event.memoryWrite?.forgotten ?? []) if (!forgotten.includes(statement)) forgotten.push(statement);
  }
  if (used.size === 0 && saved.size === 0 && forgotten.length === 0) return EMPTY;
  return { used: [...used.values()], saved: [...saved.values()], forgotten };
}

/** The turn's write, for the "Memory updated" notice, or null when it wrote nothing it can name. */
export function memoryWriteOf(activity: readonly ClientActivityEvent[] | null | undefined): ClientMemoryWrite | null {
  const { saved, forgotten } = answerMemory(activity);
  if (saved.length === 0 && forgotten.length === 0) return null;
  return { saved, ...(forgotten.length ? { forgotten } : {}) };
}

/** Where one fact lives on the memory page; `edit` opens it for editing there. */
export function memoryEntryHref(id: string, opts: { edit?: boolean } = {}): string {
  return `/memory?entry=${encodeURIComponent(id)}${opts.edit ? "&edit=1" : ""}`;
}

/**
 * What the chip says, as a shape rather than a sentence: the words themselves
 * are written in answer-memory.tsx's JSX so the translation catalog sees each
 * one whole (a sentence assembled here would reach no reader but English).
 *
 *   used       "Memory 2", like "Sources 5" beside it, plus "· updated" when
 *              the turn also saved or forgot something;
 *   saved      "Memory updated" (the turn used nothing, but saved);
 *   forgotten  "Forgotten" (it only forgot, because it was asked to).
 */
export function answerMemoryLabel(memory: AnswerMemory): {
  kind: "used" | "saved" | "forgotten";
  /** How many memories the answer used; null when it used none. */
  count: number | null;
  /** The turn also wrote: drawn as "· updated" after the count. */
  updated: boolean;
} {
  const used = memory.used.length;
  const wrote = memory.saved.length + memory.forgotten.length > 0;
  if (used > 0) return { kind: "used", count: used, updated: wrote };
  return { kind: memory.saved.length > 0 ? "saved" : "forgotten", count: null, updated: false };
}

/**
 * Where a fact was learned, as a place the chat can link to.
 *
 * `sourceRef` holds the conversation a fact came from, or one of the words the
 * other ways in write instead ("manual", "edit", "forget", "import", "native":
 * the memory page names those in prose). A fact learned in the chat being read
 * is "this chat", with nothing to open; one learned in another chat opens that
 * chat at the message it came from, when the message is known.
 */
const NON_CHAT_SOURCES = new Set(["manual", "edit", "forget", "import", "native"]);
const CHAT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function memorySourceChat(
  fact: { sourceRef?: string | null; sourceMessageId?: string | null },
  currentChatId?: string | null,
): { kind: "this" } | { kind: "chat"; href: string } | null {
  const ref = fact.sourceRef?.trim();
  if (!ref || NON_CHAT_SOURCES.has(ref) || !CHAT_ID.test(ref)) return null;
  if (currentChatId && ref === currentChatId) return { kind: "this" };
  const message = fact.sourceMessageId && CHAT_ID.test(fact.sourceMessageId) ? fact.sourceMessageId : null;
  return { kind: "chat", href: `/chat/${encodeURIComponent(ref)}${message ? `?m=${encodeURIComponent(message)}` : ""}` };
}
