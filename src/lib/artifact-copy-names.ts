/** What a Duplicate is called (src/lib/artifact-duplicate.ts). Pure. */

export const COPY_SUFFIX = " (copy)";

/** "Pricing page" → "Pricing page (copy)", within the 200-character title limit. */
export function copyTitle(title: string): string {
  const base = title.trim() || "Untitled";
  return `${base.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
}

/**
 * A fresh handle for the copy. It has no chat, so the identifier only needs to
 * read well; a retired handle's `~tail` is dropped.
 */
export function copyIdentifier(identifier: string, now: Date = new Date()): string {
  return `${identifier.replace(/~[^~]*$/, "").slice(0, 80)}-copy-${now.getTime().toString(36)}`;
}
