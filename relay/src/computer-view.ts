import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedRelayOrigin } from "./origin.js";

export interface ComputerViewTokenPayload {
  v: 1;
  a: string;
  u: string;
  h: string;
  p: number;
  m: "watch" | "control";
  exp: number;
}

export interface ComputerViewVerifyOptions {
  authSecret?: string;
  cidr?: string;
  nodeEnv?: string;
  nowMs?: number;
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

export function verifyComputerViewToken(
  token: string | null | undefined,
  opts?: ComputerViewVerifyOptions
): ComputerViewTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const secret = opts?.authSecret ?? process.env.AUTH_SECRET;
  if (!secret) return null;

  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dotIdx);
  const mac = token.slice(dotIdx + 1);
  if (!body || !mac) return null;

  const key = createHmac("sha256", secret).update("juno-computer-view-v1").digest();
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const macBuf = Buffer.from(mac, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ComputerViewTokenPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.a !== "string" ||
      parsed.a.length === 0 ||
      typeof parsed.u !== "string" ||
      parsed.u.length === 0 ||
      typeof parsed.h !== "string" ||
      parsed.h.length === 0 ||
      typeof parsed.p !== "number" ||
      (parsed.m !== "watch" && parsed.m !== "control") ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    const nowMs = opts?.nowMs ?? Date.now();
    if (parsed.exp * 1000 <= nowMs) {
      return null;
    }

    if (
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
}

export function createComputerViewUpgradeHandler(opts: ComputerViewBridgeOptions) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols(protocols) {
      if (protocols.has("binary")) return "binary";
      const first = protocols.values().next().value;
      return first ?? false;
    },
  });

  const viewersByAgent = new Map<string, number>();
  const maxViewers = opts.maxViewersPerAgent ?? MAX_VIEWERS_PER_AGENT;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

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

    const rawToken = url.searchParams.get("t") ?? url.searchParams.get("token");
    const grant = verifyComputerViewToken(rawToken, {
      authSecret: opts.authSecret,
      cidr: opts.cidr,
      nodeEnv: opts.nodeEnv,
    });
    if (!grant) {
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
      console.info("computer view opened", { agent: agentHash, mode: grant.m });
      let closed = false;

      const tcp = net.connect({ host: grant.h, port: grant.p, noDelay: true });

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
          tcp.destroy();
        } catch {
          // ignore
        }
        console.info("computer view closed", { agent: agentHash });
      }

      resetIdleTimer();

      tcp.on("data", (chunk: Buffer) => {
        resetIdleTimer();
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > WS_HIGH_WATER_MARK) {
          tcp.pause();
        }
        ws.send(chunk, { binary: true }, (err) => {
          if (err) {
            closeBoth();
            return;
          }
          if (tcp.isPaused() && ws.bufferedAmount < WS_HIGH_WATER_MARK / 2) {
            tcp.resume();
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

        if (tcp. destroyed || !tcp.writable) {
          closeBoth();
          return;
        }
        const ok = tcp.write(buf);
        if (!ok || tcp.writableLength > TCP_HIGH_WATER_MARK) {
          ws.pause();
        }
      });

      tcp.on("drain", () => {
        try {
          ws.resume();
        } catch {
          // ignore
        }
      });

      tcp.on("error", () => closeBoth());
      tcp.on("close", () => closeBoth());
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
