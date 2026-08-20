#!/usr/bin/env node

/**
 * Blocking voice relay health & WebSocket handshake verification script.
 * Used during deployment, CI, and production release smoke.
 */

import { createHmac } from "node:crypto";
import { WebSocket } from "ws";

const relayUrl = (process.env.VOICE_RELAY_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const authSecret = process.env.AUTH_SECRET || "";
const timeoutMs = Number(process.env.VOICE_RELAY_TIMEOUT_MS || 10000);

function mintTestToken(secret, userId = "smoke-verify-user") {
  const payload = JSON.stringify({
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + 120,
  });
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function verifyHttpHealth() {
  const healthUrl = `${relayUrl}/healthz`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`GET ${healthUrl} returned HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.ok !== true) {
      throw new Error(`GET ${healthUrl} returned invalid payload: ${JSON.stringify(data)}`);
    }
    console.log(`[voice-relay] HTTP /healthz ok — providers: ${Object.keys(data.providers || {}).join(", ")}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyWebSocketHandshake(secret) {
  const token = mintTestToken(secret);
  const wsUrl = relayUrl.replace(/^http/, "ws") + `/?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`WebSocket handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ping" }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") {
          clearTimeout(timeout);
          ws.close(1000, "verified");
          console.log("[voice-relay] WebSocket ping/pong handshake verified.");
          resolve(true);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection error: ${err.message}`));
    });

    ws.on("close", (code, reason) => {
      if (code !== 1000 && code !== 1005) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed unexpectedly with code ${code}: ${reason}`));
      }
    });
  });
}

async function main() {
  console.log(`[voice-relay] Verifying relay at ${relayUrl}...`);
  await verifyHttpHealth();

  if (authSecret) {
    console.log("[voice-relay] Verifying authenticated WebSocket handshake...");
    await verifyWebSocketHandshake(authSecret);
  } else {
    console.log("[voice-relay] AUTH_SECRET not set in environment; skipping WebSocket handshake (HTTP health passed).");
  }

  console.log("[voice-relay] All voice relay checks PASSED.");
}

main().catch((err) => {
  console.error(`[voice-relay] FAIL: ${err.message}`);
  process.exit(1);
});
