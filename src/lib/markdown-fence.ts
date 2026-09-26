/**
 * Pure helpers for the transcript's markdown: what a fence declares about
 * itself, and how a still-streaming block is held back until its syntax is
 * complete. Split from chat/markdown.tsx (a client module) so they can be
 * tested without a DOM.
 */

/**
 * The fence's declared filename, from its meta string.
 *
 * Three spellings in the wild: `ts title="src/auth.ts"` (MDX, Docusaurus),
 * `ts filename=src/auth.ts` (Nextra), and `ts:src/auth.ts` (GitHub-flavoured
 * habit, split into lang + meta by `remarkFenceFilename` in chat/markdown.tsx). A bare meta
 * that looks like a path (`ts src/auth.ts`) counts too; anything else in the
 * meta is ignored rather than guessed at.
 */
export function fenceFilename(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const named = /(?:^|\s)(?:title|filename|file|path)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta);
  if (named) return (named[1] ?? named[2] ?? named[3])?.trim() || undefined;
  const bare = meta.trim();
  return /^[\w@~.\/-]+\.[\w]+$|^[\w@~.-]*\/[\w@~.\/-]+$/.test(bare) ? bare : undefined;
}

/**
 * A link still being written shows as its words, not its syntax.
 *
 * `[the pricing` and `[the pricing notes](https://exa` are the two shapes a
 * link passes through mid-stream, and both used to print raw: a bracket, then
 * half a URL, for the half second before the closing paren landed and the
 * whole thing snapped into a link. The label is kept (it is prose the reader
 * is already reading) and the syntax is held back until it is complete.
 * Citation markers (`[3]`) close in the same token they open in, so they
 * never reach here; inline code is left alone.
 */
export function hideDanglingLink(block: string): string {
  const lastLine = block.slice(block.lastIndexOf("\n") + 1);
  // An odd count of backticks on the line means we are inside a code span.
  if ((lastLine.match(/(?<!\\)`/g) ?? []).length % 2 === 1) return block;
  const partialUrl = /!?\[([^\]\n]*)\]\([^)\s]*$/.exec(block);
  if (partialUrl) return block.slice(0, partialUrl.index) + partialUrl[1];
  const partialLabel = /!?\[([^\]\n]*)$/.exec(block);
  if (partialLabel) return block.slice(0, partialLabel.index) + partialLabel[1];
  return block;
}

/** The file a unified diff names, from its `+++ b/…` (or `--- a/…`) header. */
export function diffFilename(patch: string): string | undefined {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)?.[1];
  const minus = /^--- (?:a\/)?(.+)$/m.exec(patch)?.[1];
  const file = plus && plus !== "/dev/null" ? plus : minus && minus !== "/dev/null" ? minus : undefined;
  return file?.trim().replace(/\t.*$/, "") || undefined;
}

