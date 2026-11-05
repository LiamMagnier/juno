import "server-only";
import { createCipheriv, createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
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
 * Version 1 (Docker, single box): the relay dials `h:p` on the computers
 * network itself. Version 2 (a separate computer host, COMPUTERS_2026-10.md
 * S3.3, D5): the relay opens `<r>/v1/tunnel` on the host with a single-use
 * ticket the host minted for this computer's port 5900. The ticket is sealed
 * in `k` (AES-256-GCM, key from AUTH_SECRET, the token's other fields as
 * additional data), so neither the browser nor a log can read it and it
 * cannot be lifted into another token. The relay never holds the host's
 * bearer token.
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

export interface ViewTokenPayloadV2 {
  v: 2;
  a: string;
  u: string;
  m: "watch" | "control";
  exp: number;
  j: string;
  /** The computer host's origin (https://…, or loopback http:// outside production). */
  r: string;
  /** The sealed `{t: <ticket>, p: 5900}`. */
  k: string;
}

const SIGNING_LABEL = { 1: "juno-computer-view-v1", 2: "juno-computer-view-v2" } as const;

/** The additional authenticated data of a sealed ticket: every other field of its token. */
export function viewTokenAad(payload: Omit<ViewTokenPayloadV2, "k">): Buffer {
  return Buffer.from([payload.v, payload.a, payload.u, payload.m, payload.exp, payload.j, payload.r].join("|"), "utf8");
}

function sealingKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "juno-computer-view-v2", "tunnel-ticket", 32));
}

/** AES-256-GCM over `{t, p}` with the token's other fields as AAD; base64url(iv | ciphertext | tag). */
export function sealTunnelTicket(ticket: string, aad: Buffer, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(authSecret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ t: ticket, p: 5900 }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

function signViewPayload(payload: ViewTokenPayload | ViewTokenPayloadV2, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", secret).update(SIGNING_LABEL[payload.v]).digest();
  const sigB64 = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sigB64}`;
}

export function mintViewToken(opts: {
  agentId: string;
  userId: string;
  host: string;
  port: number;
  mode: "watch" | "control";
  ttlSeconds?: number;
  authSecret?: string;
  /** A remote host's VNC tunnel (Endpoints.vncTunnel): mints a version 2 token. */
  tunnel?: { origin: string; ticket: string };
}): { token: string; expiresAt: number } {
  const secret = opts.authSecret ?? env.authSecret;
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 60);
  const j = randomBytes(12).toString("base64url");
  if (opts.tunnel) {
    const base = { v: 2 as const, a: opts.agentId, u: opts.userId, m: opts.mode, exp, j, r: opts.tunnel.origin };
    const payload: ViewTokenPayloadV2 = { ...base, k: sealTunnelTicket(opts.tunnel.ticket, viewTokenAad(base), secret) };
    return { token: signViewPayload(payload, secret), expiresAt: exp * 1000 };
  }
  const payload: ViewTokenPayload = {
    v: 1,
    a: opts.agentId,
    u: opts.userId,
    h: opts.host,
    p: opts.port,
    m: opts.mode,
    exp,
    j,
  };
  return {
    token: signViewPayload(payload, secret),
    expiresAt: exp * 1000,
  };
}

export function resolveComputerRelayUrl(fallbackOrigin?: string): string {
  // COMPUTER_VIEW_RELAY_URL first (server-only): a relay for the computer
  // view alone, which never moves voice.
  const configured =
    env.agentComputer.viewRelayUrl ||
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
  // A remote host mints one VNC tunnel ticket per call: one per view session.
  const endpoints = await provider.endpoints(opts.handle, { purpose: "vnc" });
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
