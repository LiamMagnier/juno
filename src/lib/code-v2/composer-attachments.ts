/**
 * Attachments in the Code composer (landing and session alike).
 *
 * The composer uploads through Chat's pipeline (`/api/upload`, `useUploads`),
 * so a file attached to a Code turn is the same stored, sniffed, size-checked
 * object as one attached to a chat. What differs is where the turn runs:
 *
 * - The CodeTask path (cloud runs, and a Mac without the env server) claims
 *   the stored attachment ids itself (`attachmentIds` on create and steer).
 * - A Mac running the env server cannot read our storage, so the browser
 *   hands it the bytes: `host.upload` over the device link, which the Mac app
 *   keeps in its own folder and answers with the file's path. The turn then
 *   carries `{ name, mediaType, ref: path }` (contracts `Attachment`), the shape
 *   the phone already sends.
 *
 * The rules are pure so the tests read them; the hook in
 * components/code/v2/use-composer-attachments.ts wires them to the DOM.
 */
import type { ClientAttachment } from "@/types/chat";
import type { Attachment } from "./contracts";
import { isHeicUpload } from "@/lib/uploads";

/**
 * The largest file the web may hand a Mac. The device link takes a 6 MB body
 * (api/code/v2/link/[deviceId]) and base64 grows a file by a third, so 4 MB is
 * what fits with the envelope; the phone keeps the same limit.
 */
export const MAC_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

/** A paste longer than this lands on the row as a text file (Mod+Shift+V keeps it inline). */
export const LARGE_PASTE_BYTES = 32 * 1024;

export const MAC_ATTACHMENT_TOO_LARGE_MESSAGE = "Files sent to your Mac from the web can be up to 4 MB.";
export const MAC_ATTACHMENT_FAILED_MESSAGE = "Your Mac could not keep an attached file. Try again.";
export const ATTACHMENTS_UPLOADING_LABEL = "Waiting for attachments to finish uploading";

/** UTF-8 size of a string, without allocating the encoded bytes twice. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether a paste becomes a text file instead of text in the field. */
export function pasteBecomesFile(text: string, keepInline: boolean): boolean {
  if (keepInline) return false;
  // Cheap bound first: a UTF-8 character is at most 4 bytes.
  if (text.length * 4 <= LARGE_PASTE_BYTES) return false;
  return utf8Length(text) > LARGE_PASTE_BYTES;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Pasted text 2026-10-15 14-31-08.txt": dashes, because sanitizeFileName strips ":". */
export function pastedTextFileName(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `Pasted text ${date} ${time}.txt`;
}

/** What to do with a file the reader handed the composer. */
export function intakeKind(file: { name: string; type: string }): "upload" | "heic" {
  return isHeicUpload(file.name, file.type) ? "heic" : "upload";
}

/** "IMG_0042.HEIC" → "IMG_0042.jpg", for a photo the browser converted. */
export function jpegNameFor(name: string): string {
  const base = name.replace(/\.(heic|heif|hif)$/i, "");
  return `${base || "Photo"}.jpg`;
}

/** Whether a stored attachment is too large to hand a Mac over the link. */
export function tooLargeForMac(attachment: Pick<ClientAttachment, "size">): boolean {
  return attachment.size > MAC_ATTACHMENT_MAX_BYTES;
}

/** Base64 of bytes, in chunks so a 4 MB file does not overflow the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** What `host.upload` answers (contracts ClientCommandResult["host.upload"]). */
export interface MacKeptFile {
  ref: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface MacTransferDeps {
  /** The stored file's bytes (fetch of its URL). */
  read(attachment: ClientAttachment): Promise<Uint8Array>;
  /** `host.upload` over the device link. */
  upload(params: { name: string; mediaType: string; data: string }): Promise<MacKeptFile>;
}

export class MacAttachmentError extends Error {}

/**
 * Hands each stored attachment to the Mac, in order, and returns the turn's
 * attachments. Fails as a whole (the turn is not sent with half its files),
 * with a sentence the composer can show.
 */
export async function sendAttachmentsToMac(attachments: readonly ClientAttachment[], deps: MacTransferDeps): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const attachment of attachments) {
    if (tooLargeForMac(attachment)) throw new MacAttachmentError(MAC_ATTACHMENT_TOO_LARGE_MESSAGE);
    let kept: MacKeptFile;
    try {
      const bytes = await deps.read(attachment);
      if (bytes.length > MAC_ATTACHMENT_MAX_BYTES) throw new MacAttachmentError(MAC_ATTACHMENT_TOO_LARGE_MESSAGE);
      kept = await deps.upload({ name: attachment.fileName, mediaType: attachment.mimeType || "application/octet-stream", data: bytesToBase64(bytes) });
    } catch (error) {
      if (error instanceof MacAttachmentError) throw error;
      throw new MacAttachmentError(error instanceof Error && error.message ? error.message : MAC_ATTACHMENT_FAILED_MESSAGE);
    }
    out.push({ name: kept.name || attachment.fileName, mediaType: kept.mediaType || attachment.mimeType, ref: kept.ref });
  }
  return out;
}

/** A turn's attachment for the optimistic bubble and the transcript (names only). */
export function previewAttachment(attachment: Pick<ClientAttachment, "id" | "fileName" | "mimeType">): Attachment {
  return { name: attachment.fileName, mediaType: attachment.mimeType || "application/octet-stream", ref: attachment.id };
}

/** "1 attachment" / "3 attachments", for a turn that has files and no words. */
export function attachmentsOnlyTitle(count: number): string {
  return count === 1 ? "1 attachment" : `${count} attachments`;
}
