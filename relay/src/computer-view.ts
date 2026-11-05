import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isAllowedRelayOrigin } from "./origin.js";

/*
 * Two kinds of view token (src/lib/computer/live-view.ts mints both):
 *   v1, a single-box Docker install: the relay dials the computer's VNC port
 *       on the computers network itself (`h:p`, RELAY_COMPUTER_CIDR, 5900).
 *   v2, a separate computer host (COMPUTERS_2026-10.md S3.3, D5): the relay
 *       opens `<r>/v1/tunnel` on the host, with the single-use ticket the host
 *       minted for this computer's port 5900 in `X-Juno-Tunnel-Ticket` and no
 *       subprotocol. The ticket travels sealed in the token (`k`, AES-256-GCM,
 *       key from AUTH_SECRET, the token's other fields as additional data), so
 *       the browser holding the token cannot read it and a sealed ticket moved
 *       into another token does not open. `r` must be one of the exact origins
 *       in RELAY_COMPUTER_HOSTS: https (wss), or loopback http outside
 *       production. The relay never holds the host's bearer token; it trusts
 *       the host's certificate through NODE_EXTRA_CA_CERTS (D18).
 * Both keep the same single use, per-agent, idle and duration rules.
 */

export interface ComputerViewTokenPayload {
  v: 1;
  a: string;
  u: string;
  h: string;
  p: number;
  m: "watch" | "control";
  exp: number;
  /**
   * One-time id. The bridge refuses a token it has already accepted, so a
   * token copied out of a log, a URL or a screen share cannot open a second
   * connection in its 60 seconds (security audit C4/C7).
   */
  j: string;
}

/** A version 2 token as the relay holds it once verified: the host origin and the unsealed ticket. */
export interface ComputerViewTunnelGrant {
  v: 2;
  a: string;
  u: string;
  m: "watch" | "control";
  exp: number;
  j: string;
  /** The computer host's origin, one of RELAY_COMPUTER_HOSTS. */
  r: string;
  /** The host's single-use ticket for port 5900, unsealed. Never logged. */
  ticket: string;
}

export type ComputerViewGrant = ComputerViewTokenPayload | ComputerViewTunnelGrant;

/** The subprotocol a viewer offers its token in, so it never sits in a URL or an access log. */
export const VIEW_TOKEN_PROTOCOL_PREFIX = "juno-view.";

const SIGNING_LABEL = { 1: "juno-computer-view-v1", 2: "juno-computer-view-v2" } as const;
const TICKET_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A host origin the relay may open tunnels to: an exact origin, https, or
 * http to a loopback address outside production. Null otherwise.
 */
export function normalizeComputerHost(raw: string, nodeEnv: string = process.env.NODE_ENV ?? "development"): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && nodeEnv !== "production" && LOOPBACK_HOSTNAMES.has(url.hostname)) return url.origin;
  return null;
}

/** RELAY_COMPUTER_HOSTS: comma-separated exact origins; anything else is dropped. */
export function parseComputerHosts(raw: string | undefined, nodeEnv?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const origin = normalizeComputerHost(entry, nodeEnv);
      return origin ? [origin] : [];
    });
}

function viewTokenAad(payload: { a: string; u: string; m: string; exp: number; j: string; r: string }): Buffer {
  return Buffer.from([2, payload.a, payload.u, payload.m, payload.exp, payload.j, payload.r].join("|"), "utf8");
}

/** Opens a sealed ticket; null if it was not sealed for exactly these token fields, or is not for port 5900. */
export function unsealTunnelTicket(sealed: string, aad: Buffer, authSecret: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 12 + 16 + 2) return null;
    const key = Buffer.from(hkdfSync("sha256", authSecret, "juno-computer-view-v2", "tunnel-ticket", 32));
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as { t?: unknown; p?: unknown };
    if (parsed.p !== 5900 || typeof parsed.t !== "string" || !TICKET_FORMAT.test(parsed.t)) return null;
    return parsed.t;
  } catch {
    return null;
  }
}

/** The token a viewer presented: the `juno-view.<token>` subprotocol, else the legacy `?t=`. */
export function presentedViewToken(req: { url?: string; headers: IncomingMessage["headers"] }): string | null {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(VIEW_TOKEN_PROTOCOL_PREFIX));
  if (offered) return offered.slice(VIEW_TOKEN_PROTOCOL_PREFIX.length) || null;
  const url = new URL(req.url ?? "/", "http://relay");
  return url.searchParams.get("t") ?? url.searchParams.get("token");
}

/**
 * Remembers the one-time ids this process has accepted until their tokens
 * expire. In memory is enough: the relay is one process, and a restart loses
 * nothing a 60-second token could still use for long.
 */
export function createViewTokenLedger(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return {
    /** True the first time a token's id is presented, false every time after. */
    accept(grant: Pick<ComputerViewGrant, "j" | "exp">): boolean {
      const nowMs = now();
      for (const [id, expMs] of seen) if (expMs <= nowMs) seen.delete(id);
      if (seen.has(grant.j)) return false;
      seen.set(grant.j, grant.exp * 1000);
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}

export interface ComputerViewVerifyOptions {
  authSecret?: string;
  cidr?: string;
  nodeEnv?: string;
  nowMs?: number;
  /** Exact origins a version 2 token may tunnel to; default RELAY_COMPUTER_HOSTS. */
  computerHosts?: readonly string[];
}

const DEFAULT_COMPUTER_CIDR = "172.30.0.0/24";
const MAX_VIEWERS_PER_AGENT = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const TCP_HIGH_WATER_MARK = 256 * 1024;
const WS_HIGH_WATER_MARK = 512 * 1024;

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = ((value << 8) | num) >>> 0;
  }
  return value >>> 0;
}

export function isHostInCidr(host: string, cidr: string): boolean {
  const [subnetIp, prefixRaw] = cidr.trim().split("/");
  if (!subnetIp || !prefixRaw) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const hostInt = ipv4ToUint32(host);
  const subnetInt = ipv4ToUint32(subnetIp);
  if (hostInt === null || subnetInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (hostInt & mask) === (subnetInt & mask);
}

export function isAllowedComputerEndpoint(
  host: string,
  port: number,
  opts?: { cidr?: string; nodeEnv?: string }
): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const nodeEnv = opts?.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const cidr = opts?.cidr ?? process.env.RELAY_COMPUTER_CIDR ?? DEFAULT_COMPUTER_CIDR;

  if (nodeEnv !== "production" && host === "127.0.0.1") {
    return true;
  }

  if (port !== 5900) return false;
  return isHostInCidr(host, cidr);
}

export function mintComputerViewToken(
  payload: ComputerViewTokenPayload,
  authSecret = process.env.AUTH_SECRET ?? ""
): string {
  if (!authSecret) {
    throw new Error("AUTH_SECRET is not configured.");
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", authSecret).update("juno-computer-view-v1").digest();
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function signatureMatches(body: string, mac: string, secret: string, version: 1 | 2): boolean {
  const key = createHmac("sha256", secret).update(SIGNING_LABEL[version]).digest();
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const macBuf = Buffer.from(mac, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return macBuf.length === expectedBuf.length && timingSafeEqual(macBuf, expectedBuf);
}

export function verifyComputerViewToken(
  token: string | null | undefined,
  opts?: ComputerViewVerifyOptions
): ComputerViewGrant | null {
  if (!token || typeof token !== "string") return null;
  const secret = opts?.authSecret ?? process.env.AUTH_SECRET;
  if (!secret) return null;

  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dotIdx);
  const mac = token.slice(dotIdx + 1);
  if (!body || !mac) return null;

  // The signature decides the version: a body signed under v1's key is read
  // as v1 only, under v2's as v2 only.
  const version = signatureMatches(body, mac, secret, 1) ? 1 : signatureMatches(body, mac, secret, 2) ? 2 : null;
  if (version === null) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.v !== version ||
      typeof parsed.a !== "string" ||
      parsed.a.length === 0 ||
      typeof parsed.u !== "string" ||
      parsed.u.length === 0 ||
      (parsed.m !== "watch" && parsed.m !== "control") ||
      typeof parsed.exp !== "number" ||
      typeof parsed.j !== "string" ||
      parsed.j.length < 8 ||
      parsed.j.length > 64
    ) {
      return null;
    }

    const nowMs = opts?.nowMs ?? Date.now();
    if (parsed.exp * 1000 <= nowMs) {
      return null;
    }

    if (version === 2) {
      const nodeEnv = opts?.nodeEnv ?? process.env.NODE_ENV ?? "development";
      const hosts = opts?.computerHosts ?? parseComputerHosts(process.env.RELAY_COMPUTER_HOSTS, nodeEnv);
      if (typeof parsed.r !== "string" || typeof parsed.k !== "string") return null;
      const origin = normalizeComputerHost(parsed.r, nodeEnv);
      if (!origin || origin !== parsed.r || !hosts.includes(origin)) return null;
      const mode: "watch" | "control" = parsed.m;
      const fields = { a: parsed.a, u: parsed.u, m: mode, exp: parsed.exp, j: parsed.j, r: origin };
      const ticket = unsealTunnelTicket(parsed.k, viewTokenAad(fields), secret);
      if (!ticket) return null;
      return { v: 2, ...fields, ticket };
    }

    if (
      typeof parsed.h !== "string" ||
      parsed.h.length === 0 ||
      typeof parsed.p !== "number" ||
      !isAllowedComputerEndpoint(parsed.h, parsed.p, {
        cidr: opts?.cidr,
        nodeEnv: opts?.nodeEnv,
      })
    ) {
      return null;
    }

    return {
      v: 1,
      a: parsed.a,
      u: parsed.u,
      h: parsed.h,
      p: parsed.p,
      m: parsed.m,
      exp: parsed.exp,
      j: parsed.j,
    };
  } catch {
    return null;
  }
}

export function hashAgentIdForLog(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 12);
}

export function isComputerViewPath(pathname: string): boolean {
  return pathname === "/computer" || pathname.endsWith("/computer");
}

export interface ComputerViewBridgeOptions {
  allowedOrigins: readonly string[];
  authSecret?: string;
  cidr?: string;
  nodeEnv?: string;
  maxViewersPerAgent?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  /** Exact origins version 2 tokens may tunnel to; default RELAY_COMPUTER_HOSTS. */
  computerHosts?: readonly string[];
}

/** The largest frame either leg of a host tunnel accepts (the gate's own limit). */
const TUNNEL_MAX_PAYLOAD = 64 * 1024 * 1024;
/** Viewer bytes held while the host tunnel is still opening (an RFB client sends nothing before the banner). */
const TUNNEL_PENDING_LIMIT = 1024 * 1024;

/**
 * Where a viewer's bytes go: the computer's VNC port (v1) or a host tunnel
 * (v2). The bridge below drives either the same way, with the same
 * backpressure, idle, duration, per-agent and single-use rules.
 */
interface ViewUpstream {
  /** False when the upstream is backed up: the viewer is paused until `onDrain`. */
  write(chunk: Buffer): boolean;
  onData(listener: (chunk: Buffer) => void): void;
  onDrain(listener: () => void): void;
  onClose(listener: () => void): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  writable(): boolean;
  destroy(): void;
}

function tcpUpstream(host: string, port: number): ViewUpstream {
  const tcp = net.connect({ host, port, noDelay: true });
  return {
    write(chunk) {
      const ok = tcp.write(chunk);
      return ok && tcp.writableLength <= TCP_HIGH_WATER_MARK;
    },
    onData(listener) {
      tcp.on("data", listener);
    },
    onDrain(listener) {
      tcp.on("drain", listener);
    },
    onClose(listener) {
      tcp.on("error", listener);
      tcp.on("close", listener);
    },
    pause: () => tcp.pause(),
    resume: () => tcp.resume(),
    isPaused: () => tcp.isPaused(),
    writable: () => !tcp.destroyed && tcp.writable,
    destroy: () => tcp.destroy(),
  };
}

/**
 * A host's VNC tunnel: `<origin>/v1/tunnel`, the ticket in a header, no
 * subprotocol offered (ws 8 aborts a handshake whose server echoes none it
 * asked for, and the host selects none), certificate checked against the
 * trust store (NODE_EXTRA_CA_CERTS holds the host's name-constrained CA).
 */
function tunnelUpstream(origin: string, ticket: string): ViewUpstream {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/tunnel";
  const upstream = new WebSocket(url.toString(), {
    headers: { "X-Juno-Tunnel-Ticket": ticket },
    rejectUnauthorized: true,
    maxPayload: TUNNEL_MAX_PAYLOAD,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const drainListeners: Array<() => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  upstream.on("open", () => {
    for (const chunk of pending.splice(0)) upstream.send(chunk, { binary: true });
    pendingBytes = 0;
  });
  upstream.on("error", fireClose);
  upstream.on("close", fireClose);
  upstream.on("unexpected-response", (_req, res) => {
    res.resume();
    fireClose();
  });
  return {
    write(chunk) {
      if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes > TUNNEL_PENDING_LIMIT) upstream.terminate();
        return true;
      }
      upstream.send(chunk, { binary: true }, () => {
        if (upstream.bufferedAmount < TCP_HIGH_WATER_MARK / 2) for (const listener of drainListeners) listener();
      });
      return upstream.bufferedAmount <= TCP_HIGH_WATER_MARK;
    },
    onData(listener) {
      upstream.on("message", (data) => {
        listener(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
      });
    },
    onDrain(listener) {
      drainListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    pause: () => upstream.pause(),
    resume: () => upstream.resume(),
    isPaused: () => upstream.isPaused,
    writable: () => upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING,
    destroy: () => {
      try {
        upstream.terminate();
      } catch {
        // already closed
      }
    },
  };
}

export function createComputerViewUpgradeHandler(opts: ComputerViewBridgeOptions) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols(protocols) {
      if (protocols.has("binary")) return "binary";
      // Never echo the token back as the chosen protocol.
      for (const protocol of protocols) {
        if (!protocol.startsWith(VIEW_TOKEN_PROTOCOL_PREFIX)) return protocol;
      }
      return false;
    },
  });

  const viewersByAgent = new Map<string, number>();
  const ledger = createViewTokenLedger();
  const maxViewers = opts.maxViewersPerAgent ?? MAX_VIEWERS_PER_AGENT;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const computerHosts = opts.computerHosts ?? parseComputerHosts(process.env.RELAY_COMPUTER_HOSTS, nodeEnv);

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://relay");
    if (!isComputerViewPath(url.pathname)) {
      return false;
    }

    const origin = req.headers.origin;
    if (!isAllowedRelayOrigin(origin, opts.allowedOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return true;
    }

    const rawToken = presentedViewToken(req);
    const grant = verifyComputerViewToken(rawToken, {
      authSecret: opts.authSecret,
      cidr: opts.cidr,
      nodeEnv: opts.nodeEnv,
      computerHosts,
    });
    // Single use: a token already accepted once is refused, whoever presents it.
    if (!grant || !ledger.accept(grant)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }

    const currentViewers = viewersByAgent.get(grant.a) ?? 0;
    if (currentViewers >= maxViewers) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return true;
    }

    viewersByAgent.set(grant.a, currentViewers + 1);
    const agentHash = hashAgentIdForLog(grant.a);

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      console.info("computer view opened", { agent: agentHash, mode: grant.m, via: grant.v === 2 ? "host" : "direct" });
      let closed = false;

      const upstream = grant.v === 2 ? tunnelUpstream(grant.r, grant.ticket) : tcpUpstream(grant.h, grant.p);

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          closeBoth();
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };

      const maxTimer = setTimeout(() => {
        closeBoth();
      }, maxDurationMs);
      maxTimer.unref?.();

      function closeBoth() {
        if (closed) return;
        closed = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        clearTimeout(maxTimer);

        const nextCount = (viewersByAgent.get(grant!.a) ?? 1) - 1;
        if (nextCount <= 0) {
          viewersByAgent.delete(grant!.a);
        } else {
          viewersByAgent.set(grant!.a, nextCount);
        }

        try {
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
            ws.close();
          }
        } catch {
          // ignore
        }
        try {
          upstream.destroy();
        } catch {
          // ignore
        }
        console.info("computer view closed", { agent: agentHash });
      }

      resetIdleTimer();

      upstream.onData((chunk: Buffer) => {
        resetIdleTimer();
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
          upstream.pause();
        }
        ws.send(chunk, { binary: true }, (err) => {
          if (err) {
            closeBoth();
            return;
          }
          if (upstream.isPaused() && ws.bufferedAmount < WS_HIGH_WATER_MARK / 2) {
            upstream.resume();
          }
        });
      });

      ws.on("message", (data) => {
        resetIdleTimer();
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);

        if (!upstream.writable()) {
          closeBoth();
          return;
        }
        if (!upstream.write(buf)) {
          ws.pause();
        }
      });

      upstream.onDrain(() => {
        try {
          ws.resume();
        } catch {
          // ignore
        }
      });

      upstream.onClose(() => closeBoth());
      ws.on("error", () => closeBoth());
      ws.on("close", () => closeBoth());
    });

    return true;
  }

  return {
    handleUpgrade,
    getActiveViewerCount(agentId: string): number {
      return viewersByAgent.get(agentId) ?? 0;
    },
  };
}
