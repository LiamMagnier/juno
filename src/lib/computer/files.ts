/**
 * Files in and out of an agent's computer (docs/design/agents-v2/COMPUTERS_2026-10.md
 * S5.2, S5.3): the person adds a file to ~/work/inbox, and the agent hands one
 * back as a run deliverable.
 *
 * An upload goes through the same gate as every other way into the computer
 * (access first: rollout, plan, host), only to a computer that is awake or
 * resting (it is never woken from asleep for this), never past the size cap
 * or onto a computer over its disk quota, and is written as the agent's uid
 * through the launcher's `helper` mode (`writeFile(..., { by: "person" })`),
 * so it works while the person holds control. Its name is the file's own
 * (last path segment, checked); a name already taken gets " (2)", " (3)"…
 * Every upload is audited (`file_uploaded`, its size only).
 */

import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { computerAccessError, computerAccessFor } from "./access";
import { recordComputerAudit } from "./audit";
import { ComputerAccessError, ComputerError, isSafeAgentPath } from "./errors";
import {
  COMPUTER_INBOX_DIR,
  COMPUTER_PUBLISH_MAX_BYTES,
  computerFileType,
  formatFileSize,
  freeInboxName,
  inboxFileName,
  publishedIdentifier,
  publishedTitle,
  type ComputerFileType,
} from "./file-types";
import { AsleepComputerError, ensureAwake, getComputerStorePersistence } from "./store";
import type { ComputerHandle, ComputerProvider } from "./types";

/** A refusal of an upload the route answers with its own status. Its message is for people. */
export class ComputerUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: "bad_name" | "too_large" | "empty" | "disk_full",
    message: string
  ) {
    super(message);
    this.name = "ComputerUploadError";
  }
}

export function uploadTooLargeSentence(maxMb = env.agentComputer.uploadMaxMb): string {
  return `That file is larger than the ${maxMb} MB limit for adding files to the computer.`;
}

export const UPLOAD_DISK_FULL_SENTENCE =
  "The computer's storage is full, so nothing can be added. Delete some files from it first.";

/** Reads a request body up to `maxBytes`, refusing as soon as it is past it (a Content-Length can lie). */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** One upload at a time per computer in this process: the free-name check and the write go together. */
const uploadLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = uploadLocks.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(work);
  uploadLocks.set(key, next);
  void next.finally(() => {
    if (uploadLocks.get(key) === next) uploadLocks.delete(key);
  }).catch(() => undefined);
  return next;
}

export interface InboxUploadResult {
  name: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Puts one file into the computer's ~/work/inbox. Throws ComputerAccessError
 * (refused), AsleepComputerError (asleep: wake it first), ComputerUploadError
 * (name, size, disk) or ComputerError (the computer did not answer).
 */
export async function uploadToComputerInbox(input: {
  userId: string;
  agentId: string;
  agentName?: string | null;
  /** The X-File-Name header: the file's name, percent-encoded. */
  fileName: string | null;
  /** Content-Length, when the request sent one. */
  contentLength: number | null;
  body: ReadableStream<Uint8Array> | null;
  actor?: "web" | "app";
}): Promise<InboxUploadResult> {
  const maxBytes = env.agentComputer.uploadMaxMb * 1024 * 1024;
  const named = inboxFileName(input.fileName);
  if (!named.ok) throw new ComputerUploadError(400, "bad_name", named.message);
  if (input.contentLength !== null && input.contentLength > maxBytes) {
    throw new ComputerUploadError(413, "too_large", uploadTooLargeSentence());
  }

  // Access first, as every other way into the computer: an account that may
  // not use it is told so before a byte of the file is read.
  const access = await computerAccessFor(input.userId);
  if (!access.ok) {
    const refusal = computerAccessError(access, input.agentName);
    await recordComputerAudit({
      userId: input.userId,
      agentId: input.agentId,
      kind: "refused",
      actor: input.actor ?? "web",
      detail: { reason: refusal.code },
    });
    throw refusal;
  }
  const row = await getComputerStorePersistence().findByAgent(input.userId, input.agentId);
  if (!row || (row.status !== "awake" && row.status !== "resting")) throw new AsleepComputerError();
  const quotaMb = env.agentComputer.diskQuotaMb;
  if (typeof row.diskMb === "number" && row.diskMb >= quotaMb) {
    throw new ComputerUploadError(409, "disk_full", UPLOAD_DISK_FULL_SENTENCE);
  }

  const bytes = await readBodyCapped(input.body, maxBytes, () => new ComputerUploadError(413, "too_large", uploadTooLargeSentence()));
  if (bytes.byteLength === 0) throw new ComputerUploadError(400, "empty", "That file is empty, so there is nothing to add.");
  if (typeof row.diskMb === "number" && row.diskMb + bytes.byteLength / (1024 * 1024) > quotaMb) {
    throw new ComputerUploadError(409, "disk_full", UPLOAD_DISK_FULL_SENTENCE);
  }

  const awake = await ensureAwake(input.userId, input.agentId, {
    actor: input.actor ?? "web",
    agentName: input.agentName,
    by: "person",
  });
  return serialized(`${input.userId}:${input.agentId}`, async () => {
    const existing = await awake.provider.fileInfo(awake.handle, COMPUTER_INBOX_DIR).catch(() => null);
    const taken = new Set<string>();
    if (existing?.type === "dir") {
      for (const entry of await awake.provider.listFiles(awake.handle, COMPUTER_INBOX_DIR)) taken.add(entry.name);
    }
    const name = freeInboxName(named.name, taken);
    const target = `${COMPUTER_INBOX_DIR}/${name}`;
    // The person's write: the launcher's helper mode, so it works while they
    // hold control. The provider resolves the path again inside the computer
    // and refuses anything outside the work area (a symlinked inbox included).
    await awake.provider.writeFile(awake.handle, target, bytes, { by: "person" });
    await recordComputerAudit({
      userId: input.userId,
      agentId: input.agentId,
      kind: "file_uploaded",
      actor: input.actor ?? "web",
      detail: { bytes: bytes.byteLength },
    });
    return {
      name,
      path: target,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

// ---------------------------------------------------------------------------
// Publishing (the agent hands a file back)
// ---------------------------------------------------------------------------

export type PublishableComputerFile =
  | {
      ok: true;
      path: string;
      bytes: Buffer;
      sha256: string;
      title: string;
      identifier: string;
      type: ComputerFileType;
    }
  | { ok: false; message: string };

/**
 * A regular file on the computer, read whole, ready to store as a run
 * deliverable: at most 25 MB, typed by its extension (S5.3). The path is
 * resolved inside the computer and must stay under /home/agent.
 */
export async function readComputerFileForPublish(
  provider: Pick<ComputerProvider, "fileInfo" | "readFile">,
  handle: ComputerHandle,
  rawPath: string,
  title?: string | null
): Promise<PublishableComputerFile> {
  const info = await provider.fileInfo(handle, rawPath);
  if (!info) return { ok: false, message: `${rawPath} does not exist on the computer. Nothing was published.` };
  if (!isSafeAgentPath(info.path)) return { ok: false, message: "Only files under /home/agent can be published. Nothing was published." };
  if (info.type !== "file") return { ok: false, message: `${info.path} is not a regular file. Only files can be published.` };
  if (info.size > COMPUTER_PUBLISH_MAX_BYTES) {
    return {
      ok: false,
      message: `${info.path} is ${formatFileSize(info.size)}, over the ${formatFileSize(COMPUTER_PUBLISH_MAX_BYTES)} limit for publishing. Nothing was published.`,
    };
  }
  const bytes = await provider.readFile(handle, info.path, { maxBytes: COMPUTER_PUBLISH_MAX_BYTES + 1 });
  if (bytes.byteLength > COMPUTER_PUBLISH_MAX_BYTES) {
    return { ok: false, message: `${info.path} grew past the ${formatFileSize(COMPUTER_PUBLISH_MAX_BYTES)} limit while it was read. Nothing was published.` };
  }
  return {
    ok: true,
    path: info.path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    title: publishedTitle(info.path, title),
    identifier: publishedIdentifier(info.path),
    type: computerFileType(info.path),
  };
}

/** Re-exported for the route: a refusal it maps itself. */
export { AsleepComputerError, ComputerAccessError, ComputerError };
