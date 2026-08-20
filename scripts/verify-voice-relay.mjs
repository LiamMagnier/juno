#!/usr/bin/env node

/**
 * Blocking voice-relay health and authenticated WebSocket verification.
 *
 * This script runs from the immutable Juno release root while the `ws` runtime
 * dependency intentionally belongs to the standalone `relay/` package. Resolve
 * it from that package rather than accidentally requiring a duplicate root
 * dependency. The release `.env` is also loaded here because deploy.sh invokes
 * this verifier as a child process; shell variables from the reviewed env file
 * are not automatically exported to it.
 */

import { createHmac } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relayRequire = createRequire(new URL("../relay/package.json", import.meta.url));
const { WebSocket } = relayRequire("ws");

function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[match[1]] = value;
    }
  } catch {
    // A CI/unit environment may intentionally have no release .env. Explicit
    // process variables and the local relay fallback below still work there.
  }
  return out;
}

const fileEnv = loadEnv(path.join(ROOT, ".env"));
const env = { ...fileEnv, ...process.env };
const configuredRelayUrl =
  env.VOICE_RELAY_VERIFY_URL ||
  env.VOICE_RELAY_URL ||
  env.NEXT_PUBLIC_VOICE_RELAY_URL ||
  "http://127.0.0.1:8787";
const authSecret = env.AUTH_SECRET || "";
const timeoutMs = Number(env.VOICE_RELAY_TIMEOUT_MS || 10_000);
const requireAuth = env.VOICE_RELAY_REQUIRE_AUTH === "1";
// A relay process with zero providers is alive but cannot provide Voice. Release
// verification therefore requires at least one real provider by default. Local
// diagnostic callers can explicitly opt out with VOICE_RELAY_REQUIRE_PROVIDER=0.
const requireProvider = env.VOICE_RELAY_REQUIRE_PROVIDER !== "0";

function normalizeHttpUrl(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(value)) value = value.replace(/^ws/i, "http");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

function normalizeWebSocketUrl(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) value = value.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
  return value;
}

const httpRelayUrl = normalizeHttpUrl(configuredRelayUrl);
const wsRelayUrl = normalizeWebSocketUrl(configuredRelayUrl);

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
  const healthUrl = `${httpRelayUrl}/healthz`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${healthUrl} returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.ok !== true) {
      throw new Error(`GET ${healthUrl} returned invalid payload: ${JSON.stringify(data)}`);
    }
    const providers = Object.entries(data.providers || {}).filter(([, available]) => available === true);
    if (requireProvider && providers.length === 0) {
      throw new Error("relay is healthy but no realtime voice provider is configured");
    }
    console.log(
      `[voice-relay] HTTP /healthz ok — providers: ${providers.map(([id]) => id).join(", ") || "none"}`,
    );
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyWebSocketHandshake(secret) {
  const token = mintTestToken(secret);
  const url = `${wsRelayUrl}/?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(true);
    };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      finish(new Error(`WebSocket handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") {
          console.log("[voice-relay] Authenticated WebSocket ping/pong verified.");
          finish();
          ws.close(1000, "verified");
        }
      } catch (error) {
        try { ws.close(); } catch {}
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on("error", (error) => finish(new Error(`WebSocket connection error: ${error.message}`)));
    ws.on("close", (code, reason) => {
      if (!settled && code !== 1000 && code !== 1005) {
        finish(new Error(`WebSocket closed unexpectedly with code ${code}: ${reason}`));
      }
    });
  });
}

async function main() {
  console.log(`[voice-relay] Verifying relay HTTP at ${httpRelayUrl}...`);
  await verifyHttpHealth();

  if (authSecret) {
    console.log(`[voice-relay] Verifying authenticated WebSocket at ${wsRelayUrl}...`);
    await verifyWebSocketHandshake(authSecret);
  } else if (requireAuth) {
    throw new Error("AUTH_SECRET is required for the blocking relay WebSocket verification");
  } else {
    console.log("[voice-relay] AUTH_SECRET unavailable; authenticated WebSocket check skipped.");
  }

  console.log("[voice-relay] All required voice-relay checks PASSED.");
}

main().catch((error) => {
  console.error(`[voice-relay] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
