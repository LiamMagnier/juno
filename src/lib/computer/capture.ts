import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";

/*
 * How an agent's computer is looked at: one capture, a settled capture, a key
 * sequence split for xdotool, and a zoomed crop of the last frame.
 *
 * Shared by the Docker and fake providers so the two cannot drift, and pure
 * apart from sharp, so tests drive the settle loop with a fake frame sequence
 * and a fake clock (tests/computer-provider-capture.test.ts).
 */

/** The desktop the agent drives, in its own pixels. */
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;

/** How long a settled capture waits for two matching frames, at most. */
export const SETTLE_TIMEOUT_MS = 500;
/** The pause between two settle captures. */
export const SETTLE_INTERVAL_MS = 60;

/**
 * A cheap fingerprint of a frame: 64x40 greyscale, luminance quantised to 32
 * levels, hashed. A blinking caret or a hover tint survives the quantising; a
 * page that is still loading, a dialog sliding in or a menu opening does not.
 * The same rule the Mac's `ScreenControlService.fingerprint` uses.
 */
export async function frameFingerprint(image: Buffer): Promise<string> {
  const raw = await sharp(image).resize(64, 40, { fit: "fill" }).greyscale().raw().toBuffer();
  const quantised = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) quantised[i] = raw[i] >> 3;
  return createHash("sha1").update(quantised).digest("hex");
}

export interface SettleOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettledFrame<T> {
  frame: T;
  /** How long the first capture took. */
  captureMs: number;
  /** How long it then took for the screen to stop changing (0 when it already had). */
  settleMs: number;
  /** How many captures were taken. */
  captures: number;
  /** False when the deadline passed with the screen still changing. */
  settled: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Captures until two consecutive frames match, for at most `timeoutMs` after
 * the first one. Returns the last frame either way: a page that never stops
 * animating still gets looked at, just without the wait being spent twice.
 */
export async function settleCapture<T>(
  capture: () => Promise<{ frame: T; fingerprint: string }>,
  options: SettleOptions = {}
): Promise<SettledFrame<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = Math.max(0, options.timeoutMs ?? SETTLE_TIMEOUT_MS);
  const intervalMs = Math.max(0, options.intervalMs ?? SETTLE_INTERVAL_MS);

  const started = now();
  let previous = await capture();
  const firstDone = now();
  const captureMs = firstDone - started;
  const deadline = firstDone + timeoutMs;
  let captures = 1;

  while (now() < deadline) {
    const wait = Math.min(intervalMs, Math.max(0, deadline - now()));
    if (wait > 0) await sleep(wait);
    if (now() >= deadline) break;
    const next = await capture();
    captures += 1;
    if (next.fingerprint === previous.fingerprint) {
      return { frame: next.frame, captureMs, settleMs: now() - firstDone, captures, settled: true };
    }
    previous = next;
  }
  return { frame: previous.frame, captureMs, settleMs: now() - firstDone, captures, settled: false };
}

/**
 * A `computer_key` string as xdotool argv: "ctrl+l Return" is two keys, and
 * passing it as one argument made xdotool look for a key named "ctrl+l Return".
 */
export function splitKeySequence(keys: string): string[] {
  return keys
    .split(/\s+/)
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, 32);
}

export interface ZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The region clamped inside the frame, at least 8 px each way. */
export function clampZoomRegion(region: ZoomRegion, frameWidth: number, frameHeight: number): ZoomRegion {
  const width = Math.max(8, Math.min(frameWidth, Math.round(Number.isFinite(region.width) ? region.width : frameWidth)));
  const height = Math.max(8, Math.min(frameHeight, Math.round(Number.isFinite(region.height) ? region.height : frameHeight)));
  const x = Math.max(0, Math.min(frameWidth - width, Math.round(Number.isFinite(region.x) ? region.x : 0)));
  const y = Math.max(0, Math.min(frameHeight - height, Math.round(Number.isFinite(region.y) ? region.y : 0)));
  return { x, y, width, height };
}

/**
 * Crops `region` out of a frame and scales it up so small text is legible:
 * the longer side becomes `maxSide` (1280 by default) without ever shrinking
 * the crop. Returns a JPEG with its size.
 */
export async function zoomFrame(
  image: Buffer,
  region: ZoomRegion,
  options: { maxSide?: number; frameWidth?: number; frameHeight?: number } = {}
): Promise<{ jpeg: Buffer; width: number; height: number; region: ZoomRegion }> {
  const meta = await sharp(image).metadata();
  const frameWidth = options.frameWidth ?? meta.width ?? DESKTOP_WIDTH;
  const frameHeight = options.frameHeight ?? meta.height ?? DESKTOP_HEIGHT;
  const clamped = clampZoomRegion(region, frameWidth, frameHeight);
  const maxSide = options.maxSide ?? DESKTOP_WIDTH;
  const scale = Math.max(1, Math.min(8, maxSide / Math.max(clamped.width, clamped.height)));
  const width = Math.round(clamped.width * scale);
  const height = Math.round(clamped.height * scale);
  const jpeg = await sharp(image)
    .extract({ left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height })
    .resize(width, height, { kernel: "lanczos3" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { jpeg, width, height, region: clamped };
}

/** A captured PNG as the JPEG the model and the step record receive. */
export async function encodeFrame(image: Buffer): Promise<{ jpeg: Buffer; sha256: string }> {
  const jpeg = await sharp(image).jpeg({ quality: 70 }).toBuffer();
  return { jpeg, sha256: createHash("sha256").update(jpeg).digest("hex") };
}
