import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyRelayToken } from "./auth.js";
import { RelaySession } from "./session.js";
import { PROVIDERS } from "./providers/registry.js";

/**
 * Juno voice relay. Standalone service (NOT deployable on Vercel serverless —
 * it needs long-lived WebSockets). Env: PORT (default 8787), AUTH_SECRET
 * (shared with the Juno backend), provider keys (OPENAI_API_KEY,
 * GOOGLE_API_KEY, DASHSCOPE_API_KEY, MINIMAX_API_KEY), optional
 * RELAY_*_MODEL overrides, ALLOWED_ORIGINS (comma list; empty = allow all,
 * native apps send no Origin).
 */
const PORT = Number(process.env.PORT || 8787);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.AUTH_SECRET) {
  console.warn("[relay] AUTH_SECRET is not set — every client connection will be rejected with 401.");
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://relay").pathname;
  // Accept /healthz behind path-preserving proxies too (e.g. /voice-relay/healthz).
  if (pathname === "/healthz" || pathname.endsWith("/healthz")) {
    const providers = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.available()]));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const origin = req.headers.origin;
  if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  let auth: { userId: string } | null = null;
  try {
    auth = verifyRelayToken(url.searchParams.get("token"));
  } catch (err) {
    console.error("[relay] token verification failed", err instanceof Error ? err.message : err);
  }
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, auth.userId);
  });
});

wss.on("connection", (ws: WebSocket, userId: string) => {
  const session = new RelaySession(ws, userId);
  console.info("[relay] client connected", { userId });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.handleAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    } else {
      void session.handleText(data.toString()).catch((err) => {
        console.error("[relay] message error", err instanceof Error ? err.message : err);
      });
    }
  });
  ws.on("close", () => {
    console.info("[relay] client disconnected", { userId });
    void session.destroy();
  });
  ws.on("error", () => void session.destroy());
});

server.listen(PORT, () => {
  const configured = Object.values(PROVIDERS)
    .filter((p) => p.available())
    .map((p) => p.id);
  console.info(`[relay] listening on :${PORT} — providers: ${configured.join(", ") || "NONE CONFIGURED"}`);
});
