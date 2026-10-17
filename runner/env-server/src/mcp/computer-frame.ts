/**
 * `computer.frame` (SPEC §3.12): one stored frame of a session's screen-control
 * timeline, for the web's Screen pane and the thread's thumbnails.
 *
 * The Mac app writes each computer_action's screenshot to
 * `~/Library/Application Support/Alevr/computer-use/shots/<session>/<call>.jpg`
 * (`ComputerScreenshotStore.swift`) and records it on the item as
 * `alevr-shot://<session>/<call>.jpg`. This reads that file back and nothing
 * else:
 *
 * - the ref must have the store's exact shape (its `sanitize` rule: letters,
 *   digits, `-`, `_`, `.`, `:`, no leading or trailing dot, at most 120
 *   characters a part) and a `.jpg` or `.png` extension;
 * - the resolved path must stay inside the shots folder, also after symlinks
 *   in the folder's own parents are resolved;
 * - neither the shots folder, the session folder nor the file may be a
 *   symlink, and the file is opened with O_NOFOLLOW;
 * - it must be a regular file no larger than {@link MAX_FRAME_BYTES}, checked
 *   on the open descriptor, so it cannot be swapped between check and read.
 *
 * It is a stored file only: never a live capture of the screen.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ClientCommandResults } from "../contracts/code-v2.js";
import { WireError } from "../sessions/session-manager.js";
import { DEFAULT_COMPUTER_USE_DIR } from "./desktop-lock.js";

/** `ComputerScreenshotStore.defaultRoot`. */
export const DEFAULT_SHOTS_DIR = join(DEFAULT_COMPUTER_USE_DIR, "shots");

/**
 * A stored frame is a screen-sized JPEG of a few hundred KB; anything far
 * larger is not one. 4 MB is about 5.4 MB as base64, inside the relay's 8 MB
 * host push (`/api/code/v2/link/[deviceId]/host`) with room for the events
 * that travel beside it.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** One part of a ref, as `ComputerActionItems.sanitize` writes it. */
const PART = "[A-Za-z0-9_:-](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9_:-])?";

/** `alevr-shot://<session>/<call>.jpg` (or `.png`), and nothing else. */
export const FRAME_REF = new RegExp(`^alevr-shot://(${PART})/(${PART})\\.(jpg|png)$`);

export type ComputerFrame = ClientCommandResults["computer.frame"];

const NOT_A_REF = "That is not a screenshot reference.";
const NOT_PLAIN = "That screenshot is not a plain file in Alevr's screenshots folder, so it was not read.";

export interface ReadFrameOptions {
  /** The shots folder (default {@link DEFAULT_SHOTS_DIR}). */
  root?: string;
  maxBytes?: number;
}

/** The frame a ref names, or a WireError saying why not. */
export function readComputerFrame(ref: unknown, options: ReadFrameOptions = {}): ComputerFrame {
  const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
  if (typeof ref !== "string" || ref.length > 300) throw new WireError("bad_request", NOT_A_REF);
  const match = FRAME_REF.exec(ref);
  if (!match) throw new WireError("bad_request", NOT_A_REF);
  const [, session, call, ext] = match;

  const root = resolve(options.root ?? DEFAULT_SHOTS_DIR);
  const folder = join(root, session);
  const file = join(folder, `${call}.${ext}`);
  // Belt and braces: the pattern already rules out `/` and a leading dot.
  if (!file.startsWith(root + sep) || resolve(file) !== file) throw new WireError("bad_request", NOT_A_REF);

  // No symlink at the folder or the session level: the store makes both as plain 0700 folders.
  directory(root);
  directory(folder);
  // And after resolving whatever the folder's own parents link through, the file is still inside it.
  const realRoot = realpathSync(root);
  if (realpathSync(folder) !== join(realRoot, session)) throw new WireError("bad_request", NOT_PLAIN);

  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new WireError("not_found", "That screenshot is no longer on this Mac.");
    // ELOOP: the file is a symlink.
    throw new WireError("bad_request", NOT_PLAIN);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new WireError("bad_request", NOT_PLAIN);
    if (st.size > maxBytes) throw new WireError("bad_request", "That screenshot is too large to send.");
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { mime: ext === "png" ? "image/png" : "image/jpeg", data: buffer.subarray(0, read).toString("base64"), bytes: read };
  } finally {
    closeSync(fd);
  }
}

/** A real folder, not a symlink to one. */
function directory(path: string): void {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    throw new WireError("not_found", "That screenshot is no longer on this Mac.");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new WireError("bad_request", NOT_PLAIN);
}
