import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { isStorageConfigured } from "@/lib/env";
import { deleteObject, getObjectBytes, putObject } from "@/lib/storage";
import { workFramePath } from "@/lib/work/domain";

/*
 * Every step of a cloud computer run, kept.
 *
 * The model already sees a JPEG after each click, key and scroll; until now
 * nobody else ever did. Each step's frame is stored here under the run, and
 * `tool_finished` names it, so the run's owner can follow along live and
 * replay the steps afterwards (src/components/work/computer-steps.tsx), and an
 * approval can show the screen as it was before the action
 * (src/components/work/approvals/approval-frame.tsx).
 *
 *   computer-frames/{userId}/{runId}/{ref}.jpg
 *
 * `ref` is the tool call's id made safe for a key and a URL segment
 * (`computerFrameRef` in runner/agent-core/src/work/computer-tools.ts); a
 * pre-action frame for an approval adds `-pre`. Storage is `putObject`, so a
 * machine with no S3 bucket keeps frames under ./.uploads, which no route
 * other than the owner-only frames route serves (`/api/files` serves
 * `uploads/` keys only).
 *
 * The takeover fence is upstream of this module and is not repeated here: the
 * computer tools only ever hand a frame over after the fence has passed it, so
 * nothing captured while a person held control reaches storage.
 */

/** Frames kept per run. A long run keeps its first 300 steps. */
export const MAX_FRAMES_PER_RUN = 300;

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** A frame reference as events carry it and the route accepts it. */
export function isFrameRef(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value);
}

/** The frame reference for a tool call id, as the agent-core tools derive it. */
export function frameRefForCall(callId: string, suffix?: "pre"): string | null {
  const base = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  if (!/[A-Za-z0-9]/.test(base)) return null;
  return suffix ? `${base}-${suffix}` : base;
}

export function frameStorageKey(userId: string, runId: string, ref: string): string {
  if (!SEGMENT.test(userId) || !SEGMENT.test(runId) || !isFrameRef(ref)) {
    throw new Error("Invalid frame key");
  }
  return `computer-frames/${userId}/${runId}/${ref}.jpg`;
}

/** Where a client loads a frame: the owner-only route. */
export function framePath(runId: string, ref: string): string {
  return workFramePath(runId, ref);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** The three storage calls this module makes, injectable for tests. */
export interface FrameStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  /** Removes everything under a run's prefix, where the backend can list (local disk). */
  removeRun?(userId: string, runId: string): Promise<void>;
}

export const defaultFrameStorage: FrameStorage = {
  put: (key, body, contentType) => putObject(key, body, contentType),
  async get(key) {
    try {
      return (await getObjectBytes(key)).bytes;
    } catch {
      return null;
    }
  },
  remove: (key) => deleteObject(key),
  async removeRun(userId, runId) {
    // Only the local-disk fallback can be listed from here; on S3 the refs the
    // run's events name are what get deleted (`deleteRunFrames`).
    if (isStorageConfigured()) return;
    if (!SEGMENT.test(userId) || !SEGMENT.test(runId)) return;
    await fs.rm(path.join(process.cwd(), ".uploads", "computer-frames", userId, runId), {
      recursive: true,
      force: true,
    });
  },
};

export interface StoredRunFrame {
  ref: string;
  width: number;
  height: number;
  /** The owner-only route the frame is served from. */
  src: string;
}

export interface RunFrameRecorder {
  /** Keeps one frame, or returns null (bad ref, not a JPEG, or the run's cap reached). */
  store(ref: string, frame: { jpeg: Buffer; width: number; height: number }): Promise<StoredRunFrame | null>;
  /** How many distinct frames this run has kept. */
  readonly count: number;
}

/**
 * One run's frame keeper. The cap counts distinct refs, so writing the same
 * step twice (a retry) costs nothing; it is per process, which bounds a run
 * that is resumed elsewhere at one cap per executor.
 */
export function createRunFrameRecorder(opts: {
  userId: string;
  runId: string;
  max?: number;
  storage?: FrameStorage;
}): RunFrameRecorder {
  const storage = opts.storage ?? defaultFrameStorage;
  const max = Math.max(0, opts.max ?? MAX_FRAMES_PER_RUN);
  const kept = new Set<string>();
  return {
    get count() {
      return kept.size;
    },
    async store(ref, frame) {
      if (!isFrameRef(ref) || !isJpeg(frame.jpeg)) return null;
      const fresh = !kept.has(ref);
      if (fresh && kept.size >= max) return null;
      // Reserved before the write, so concurrent steps cannot overshoot the cap.
      if (fresh) kept.add(ref);
      try {
        await storage.put(frameStorageKey(opts.userId, opts.runId, ref), frame.jpeg, "image/jpeg");
      } catch {
        if (fresh) kept.delete(ref);
        return null;
      }
      return {
        ref,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        src: framePath(opts.runId, ref),
      };
    },
  };
}

/** A stored frame's bytes, or null when it is missing or not a JPEG. */
export async function readRunFrame(
  userId: string,
  runId: string,
  ref: string,
  storage: FrameStorage = defaultFrameStorage,
): Promise<Uint8Array | null> {
  if (!isFrameRef(ref) || !SEGMENT.test(userId) || !SEGMENT.test(runId)) return null;
  const bytes = await storage.get(frameStorageKey(userId, runId, ref));
  return bytes && isJpeg(bytes) ? bytes : null;
}

/** The facts `deleteRunFrames` needs from the run's events. */
export interface RunFrameEvent {
  kind: string;
  payload: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Every frame ref a run's events can name: the frame on each `tool_finished`,
 * the pre-action frame on each approval, and — for a frame whose event was
 * never written — the ref every computer call's id derives.
 */
export function frameRefsInEvents(events: readonly RunFrameEvent[]): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (event.kind === "tool_finished") {
      const ref = record(payload.frame)?.ref;
      if (isFrameRef(ref)) refs.add(ref);
    }
    if (event.kind === "approval_requested") {
      const ref = record(record(record(payload.request)?.detail)?.frame)?.ref;
      if (isFrameRef(ref)) refs.add(ref);
    }
    if (event.kind === "tool_started" && typeof payload.tool === "string" && payload.tool.startsWith("computer_")) {
      const callId = typeof payload.callId === "string" ? payload.callId : null;
      for (const suffix of [undefined, "pre"] as const) {
        const ref = callId ? frameRefForCall(callId, suffix) : null;
        if (ref) refs.add(ref);
      }
    }
  }
  return [...refs];
}

/**
 * Deletes a run's frames. Called from the run-deletion path (deleting a Work
 * session deletes its runs' frames). Best effort per frame: one that fails to
 * delete does not stop the rest, and the frames route already refuses every
 * frame of a deleted session, so a leftover is unreachable either way.
 *
 * `userId` is the owner: the storage prefix is per user, and the ownership
 * guard on the event query needs it.
 */
export async function deleteRunFrames(
  runId: string,
  userId: string,
  deps: {
    storage?: FrameStorage;
    events?: (runId: string, userId: string) => Promise<readonly RunFrameEvent[]>;
  } = {},
): Promise<number> {
  if (!SEGMENT.test(runId) || !SEGMENT.test(userId)) return 0;
  const storage = deps.storage ?? defaultFrameStorage;
  const events = await (deps.events ?? runFrameEvents)(runId, userId);
  let deleted = 0;
  for (const ref of frameRefsInEvents(events)) {
    try {
      await storage.remove(frameStorageKey(userId, runId, ref));
      deleted += 1;
    } catch {
      // Keep going: see above.
    }
  }
  await storage.removeRun?.(userId, runId).catch(() => {});
  return deleted;
}

async function runFrameEvents(runId: string, userId: string): Promise<readonly RunFrameEvent[]> {
  const { prisma } = await import("@/lib/prisma");
  return prisma.workEvent.findMany({
    where: { runId, userId, kind: { in: ["tool_started", "tool_finished", "approval_requested"] } },
    select: { kind: true, payload: true },
  });
}

/**
 * `computer_zoom`: a region of a frame, cropped and enlarged so small text
 * is legible to the model. Up to 4x, and never past the desktop's own size.
 */
export async function zoomFrame(
  jpeg: Buffer,
  region: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const left = Math.max(0, Math.min(frame.width - 1, Math.round(region.x)));
  const top = Math.max(0, Math.min(frame.height - 1, Math.round(region.y)));
  const width = Math.max(1, Math.min(frame.width - left, Math.round(region.width)));
  const height = Math.max(1, Math.min(frame.height - top, Math.round(region.height)));
  const scale = Math.max(1, Math.min(4, frame.width / width, frame.height / height));
  const outWidth = Math.round(width * scale);
  const outHeight = Math.round(height * scale);
  const out = await sharp(jpeg)
    .extract({ left, top, width, height })
    .resize({ width: outWidth, height: outHeight, kernel: "lanczos3" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { jpeg: out, width: outWidth, height: outHeight };
}
