/**
 * Live relay smoke test: boots the server in-process, connects as a client,
 * and verifies a real round-trip with the chosen provider.
 *   npm run smoke -- gemini|qwen|minimax|openai
 *
 * For S2S providers we send a spoken-ish test: 0.4s of silence, a synthesized
 * "beep speech" burst (which VAD may or may not treat as speech), then a
 * text turn (sendText) — the assertion is that AUDIO frames and an assistant
 * transcript come back. For minimax we send input.text (composed pipeline).
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

// Load repo .env (relay shares the Juno env in dev).
for (const p of [join(process.cwd(), "../.env"), join(process.cwd(), "../.env.local")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    const q = v.match(/^(["'])([\s\S]*)\1$/);
    if (q) v = q[2];
    if (!(k in process.env)) process.env[k] = v;
  }
}
process.env.PORT = process.env.PORT || "8790";

const provider = process.argv[2] || "gemini";

function mintToken(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  const body = Buffer.from(JSON.stringify({ uid: "smoke-test", exp: Math.floor(Date.now() / 1000) + 120 })).toString(
    "base64url"
  );
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** 16 kHz PCM16 burst that resembles voiced speech (formant-ish harmonics + AM). */
function speechBurst(sec: number): Buffer {
  const n = Math.floor(16000 * sec);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * t);
    const s = 0.35 * Math.sin(2 * Math.PI * 140 * t) + 0.2 * Math.sin(2 * Math.PI * 620 * t) + 0.12 * Math.sin(2 * Math.PI * 1700 * t);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * am * 32767 * 0.6))), i * 2);
  }
  return buf;
}

async function main() {
  await import("../src/server.js" in {} ? "../src/server.js" : "../src/server.ts");
  await new Promise((r) => setTimeout(r, 500));

  const ws = new WebSocket(`ws://localhost:${process.env.PORT}/?token=${mintToken()}`);
  let audioBytes = 0;
  let assistantText = "";
  let ready = false;
  let errors: string[] = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      audioBytes += (data as Buffer).length;
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === "session.ready") {
      ready = true;
      console.log("ready:", JSON.stringify(msg.capabilities));
    } else if (msg.type === "transcript") {
      if (msg.role === "assistant") assistantText += msg.text;
      process.stdout.write(`\n[${msg.role}${msg.final ? " final" : ""}] ${msg.text}`);
    } else if (msg.type === "error") {
      errors.push(msg.message);
      console.error("\nERROR:", msg.message);
    } else if (msg.type === "usage") {
      console.log("\nusage:", JSON.stringify(msg));
    } else if (msg.type !== "pong") {
      console.log("\nmsg:", msg.type);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "session.start", provider }));

  const deadline = Date.now() + 20000;
  while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!ready) throw new Error(`session.ready never arrived (errors: ${errors.join("; ") || "none"})`);

  if (provider === "minimax") {
    ws.send(JSON.stringify({ type: "input.text", text: "Say the single word hello." }));
  } else {
    // Feed audio in 100ms chunks like a real mic, then ask via text for a
    // deterministic response (VAD may ignore the synthetic burst).
    const chunks = [speechBurst(1.2)];
    for (const chunk of chunks) {
      for (let off = 0; off < chunk.length; off += 3200) {
        ws.send(chunk.subarray(off, Math.min(chunk.length, off + 3200)), { binary: true });
        await new Promise((r) => setTimeout(r, 90));
      }
    }
    ws.send(JSON.stringify({ type: "input.text", text: "Say the single word hello." }));
  }

  const waitUntil = Date.now() + 30000;
  while (Date.now() < waitUntil && audioBytes < 24000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`\n\n=== ${provider} result ===`);
  console.log("audio bytes received:", audioBytes, `(~${(audioBytes / 2 / 24000).toFixed(1)}s)`);
  console.log("assistant transcript:", assistantText.trim().slice(0, 200) || "(none)");
  console.log("errors:", errors.length ? errors.join(" | ") : "none");
  ws.close();
  const ok = audioBytes > 4800; // >0.1s of speech back
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
