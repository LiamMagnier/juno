/*
 * Model-facing text of the history notes (SPEC §4.9). English, and in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29, SPEC
 * §10.5). Every string here is part of the cached prompt prefix of every later
 * turn, so a change to one changes the bytes of every earlier tool-using row:
 * change them together, or not at all (INV-24).
 */

/** The envelope label: the note sits inside `wrapUntrusted` because its titles and URLs are outside content. */
export const HISTORY_NOTE_ENVELOPE = "tools used in this earlier turn";

const count = (n: number): string => n.toLocaleString("en-US");
const noun = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

/** The words of a note line. */
export const HISTORY_NOTE_TEXT = {
  ok: "ok",
  /** A call that did not succeed, with its error code or status. */
  failed: (code: string) => `failed (${code})`,
  /** The final URL of a fetch that was redirected. */
  finalUrl: (url: string) => `(final ${url})`,
  pages: (range: string) => `pages ${range}`,
  results: (n: number) => noun(n, "result", "results"),
  figure: {
    results: (n: number) => noun(n, "result", "results"),
    pages: (n: number) => noun(n, "page", "pages"),
    chars: (n: number) => noun(n, "char", "chars"),
    files: (n: number) => noun(n, "file", "files"),
    matches: (n: number) => noun(n, "match", "matches"),
    chats: (n: number) => noun(n, "chat", "chats"),
    items: (n: number) => noun(n, "item", "items"),
    exit: (value: string) => `exit ${value}`,
  },
  /** The provider's own web search, which the model called without a Juno tool. */
  providerSearch: "web search",
  providerXSearch: "x search",
  connector: "connector",
  /** Closes a note that ran out of room. */
  more: (n: number) => `- … ${noun(n, "more call", "more calls")}`,
} as const;
