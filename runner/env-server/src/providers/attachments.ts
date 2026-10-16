/**
 * A turn's attachments, for the runtimes that do not take them natively.
 *
 * A file attached from the web or a phone reaches the Mac through
 * `host.upload`: the Mac app keeps it in its own folder and the turn carries
 * `{ name, mediaType, ref }` with `ref` the file's absolute path. Codex and ACP
 * agents already read those refs (localImage / mention / a path line). Claude
 * and Alevr's engine used to read `input.text` alone, so a pasted screenshot
 * sent to them arrived as nothing at all.
 *
 * - Claude takes pictures as image blocks (the Messages API's base64 source)
 *   and every other file as a path it can open with its own Read tool.
 * - Alevr's engine takes a prompt string, so both become path lines it reads
 *   with its file tools (which return images to the model).
 *
 * The recorded user message keeps the words as typed; only what the runtime
 * is handed carries the files.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Attachment, UserInput } from "../contracts/code-v2.js";

/** The image types the Messages API accepts as a base64 block. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Larger pictures go as a path: the API's per-image ceiling. */
const CLAUDE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The attachments that name a file on this Mac (an absolute path). */
export function localAttachments(input: Pick<UserInput, "attachments">): Attachment[] {
  return (input.attachments ?? []).filter((a) => typeof a.ref === "string" && path.isAbsolute(a.ref));
}

/** "Attached files:" and one line per file, or "" when there are none. */
export function attachmentNote(attachments: readonly Attachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map((a) => `- ${a.name} (${a.mediaType}): ${a.ref}`);
  return `Attached files (open them from these paths):\n${lines.join("\n")}`;
}

/** The prompt string for a runtime that takes text only: the words, then the files. */
export function textWithAttachments(input: Pick<UserInput, "text" | "attachments">): string {
  const note = attachmentNote(localAttachments(input));
  if (!note) return input.text;
  return input.text.trim() ? `${input.text}\n\n${note}` : note;
}

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface FileReader {
  size(file: string): number;
  read(file: string): Buffer;
}

const diskReader: FileReader = {
  size: (file) => statSync(file).size,
  read: (file) => readFileSync(file),
};

/**
 * A Claude user message's content: the words, each picture as an image block,
 * and every other file (or a picture that cannot be read or is too large) as a
 * path in a note after the words.
 */
export function claudeContent(input: Pick<UserInput, "text" | "attachments">, reader: FileReader = diskReader): ClaudeContentBlock[] {
  const images: ClaudeContentBlock[] = [];
  const asPaths: Attachment[] = [];
  for (const a of localAttachments(input)) {
    if (!CLAUDE_IMAGE_TYPES.has(a.mediaType)) {
      asPaths.push(a);
      continue;
    }
    try {
      if (reader.size(a.ref) > CLAUDE_IMAGE_MAX_BYTES) {
        asPaths.push(a);
        continue;
      }
      images.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: reader.read(a.ref).toString("base64") } });
    } catch {
      asPaths.push(a);
    }
  }
  const note = attachmentNote(asPaths);
  const text = note ? (input.text.trim() ? `${input.text}\n\n${note}` : note) : input.text;
  return [...(text.trim() || !images.length ? [{ type: "text" as const, text }] : []), ...images];
}
