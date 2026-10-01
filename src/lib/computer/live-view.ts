import "server-only";
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { env } from "@/lib/env";
import { computerProvider } from "./provider";
import type { ComputerHandle, ComputerProvider, Endpoints } from "./types";

const VNC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateVncPassword(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += VNC_ALPHABET[randomInt(0, VNC_ALPHABET.length)];
  }
  return out;
}

/**
 * The relay's view token. `j` is a one-time id: the relay refuses a token it
 * has already seen (relay/src/computer-view.ts), so a token copied out of a
 * log or a URL cannot open a second connection in its 60 seconds.
 *
 * The app links (`/computer-view?c=`) are no longer signed tokens at all: they
 * are single-use codes stored server-side (src/lib/computer/handoff.ts).
 */
export interface ViewTokenPayload {
  v: 1;
  a: string;
  u: string;
  h: string;
  p: number;
  m: "watch" | "control";
  exp: number;
  j: string;
}

export function mintViewToken(opts: {
  agentId: string;
  userId: string;
  host: string;
  port: number;
  mode: "watch" | "control";
  ttlSeconds?: number;
  authSecret?: string;
}): { token: string; expiresAt: number } {
  const secret = opts.authSecret ?? env.authSecret;
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 60);
  const payload: ViewTokenPayload = {
    v: 1,
    a: opts.agentId,
    u: opts.userId,
    h: opts.host,
    p: opts.port,
    m: opts.mode,
    exp,
    j: randomBytes(12).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", secret).update("juno-computer-view-v1").digest();
  const sigB64 = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return {
    token: `${payloadB64}.${sigB64}`,
    expiresAt: exp * 1000,
  };
}

export function resolveComputerRelayUrl(fallbackOrigin?: string): string {
  const configured =
    process.env.NEXT_PUBLIC_VOICE_RELAY_URL ||
    process.env.VOICE_RELAY_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.AUTH_URL ||
    fallbackOrigin ||
    "http://localhost:3000";

  try {
    const url = new URL(configured.trim());
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    const cleanPath = url.pathname.replace(/\/+$/, "");
    if (cleanPath.endsWith("/computer")) {
      url.pathname = cleanPath;
    } else if (cleanPath.endsWith("/voice-relay")) {
      url.pathname = `${cleanPath}/computer`;
    } else {
      url.pathname = `${cleanPath}/voice-relay/computer`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "ws://localhost:8787/voice-relay/computer";
  }
}

export async function ensureStream(opts: {
  handle: ComputerHandle;
  provider?: ComputerProvider;
  existingPasswords?: {
    controlPassword?: string;
    viewPassword?: string;
  };
  rotatePasswords?: boolean;
  /** Start x11vnc. False reuses the running server and its passwords. */
  restart?: boolean;
}): Promise<{
  controlPassword: string;
  viewPassword: string;
  endpoints: Endpoints;
}> {
  const provider = opts.provider ?? computerProvider();
  if (!provider) {
    throw new Error("Agent computer provider is not configured.");
  }

  const controlPassword =
    !opts.rotatePasswords && opts.existingPasswords?.controlPassword
      ? opts.existingPasswords.controlPassword
      : generateVncPassword(8);
  const viewPassword =
    !opts.rotatePasswords && opts.existingPasswords?.viewPassword
      ? opts.existingPasswords.viewPassword
      : generateVncPassword(8);

  if (opts.restart !== false) {
    await provider.startVnc(opts.handle, {
      controlPassword,
      viewPassword,
    });
  }
  const endpoints = await provider.endpoints(opts.handle);
  return {
    controlPassword,
    viewPassword,
    endpoints,
  };
}

export async function stopStream(opts: {
  handle: ComputerHandle;
  provider?: ComputerProvider;
}): Promise<void> {
  const provider = opts.provider ?? computerProvider();
  if (!provider) return;
  await provider.stopVnc(opts.handle);
}
