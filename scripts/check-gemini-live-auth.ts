/**
 * Which way, if any, this Gemini key can open a Live API socket.
 *
 *   npm run gemini:live-auth
 *
 * Written because the question stopped being answerable from documentation.
 * Google is retiring the classic `AIza…` keys and AI Studio now issues `AQ.…`
 * ones, the two formats are not accepted by the same surfaces, and the reports
 * of which works where contradict each other. Meanwhile a Live socket answers
 * every credential problem with the same close 1008 and the same sentence
 * about an OAuth 2 access token — including the case where it never received a
 * credential at all.
 *
 * So stop reading and measure. Each probe below is one real request with the
 * real key, and the table says which doors open. That is the whole point: the
 * relay's auth path should be whichever of these works, established by trying
 * it rather than by inferring it from a key's prefix.
 *
 * It never prints the key — only its kind, the surface, and what came back.
 */

import { createRequire } from "node:module";

/**
 * `ws` is a dependency of the relay package, not of the app, so resolve it
 * from there the way scripts/verify-voice-relay.mjs does. Its types are not
 * installed here either, so declare the handful of members this uses rather
 * than pulling a devDependency in for one script.
 */
interface ProbeSocket {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close", cb: (code: number, reason: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}
type ProbeSocketCtor = new (url: string) => ProbeSocket;

const relayRequire = createRequire(new URL("../relay/package.json", import.meta.url));
const { WebSocket } = relayRequire("ws") as { WebSocket: ProbeSocketCtor };

const BASE = "https://generativelanguage.googleapis.com";
const LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/** Ephemeral tokens are accepted on the Constrained variant, not the plain one. */
const LIVE_CONSTRAINED_PATH = `${LIVE_PATH}Constrained`;
const MODEL = process.env.RELAY_GEMINI_MODEL || "gemini-3.8-live";
const TIMEOUT_MS = 20_000;

type Outcome = { probe: string; ok: boolean; detail: string };

function keyKind(key: string): string {
  if (key.startsWith("AQ.")) return 'new "AQ." auth key';
  if (key.startsWith("AIza")) return 'classic "AIza" AI Studio key';
  return "unrecognized format";
}

/** Strip anything that could carry the credential out of a printable string. */
function scrub(text: string, key: string): string {
  return text.split(key).join("***").replace(/([?&](key|access_token)=)[^&\s"']+/gi, "$1***");
}

async function json(url: string, init: RequestInit, key: string): Promise<Outcome["detail"]> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text().catch(() => "");
  return `${res.status} ${res.statusText}${body ? ` — ${scrub(body, key).replace(/\s+/g, " ").slice(0, 220)}` : ""}`;
}

/** Does the key work on the surface Gemini chat uses? */
async function probeOpenAiCompat(key: string): Promise<Outcome> {
  try {
    const detail = await json(
      `${BASE}/v1beta/openai/models`,
      { headers: { Authorization: `Bearer ${key}` } },
      key
    );
    return { probe: "REST · OpenAI-compat surface", ok: detail.startsWith("200"), detail };
  } catch (err) {
    return { probe: "REST · OpenAI-compat surface", ok: false, detail: describe(err, key) };
  }
}

/** Does the key work on the surface the Live API belongs to? */
async function probeNative(key: string): Promise<Outcome> {
  try {
    const detail = await json(`${BASE}/v1beta/models`, { headers: { "x-goog-api-key": key } }, key);
    return { probe: "REST · native surface", ok: detail.startsWith("200"), detail };
  } catch (err) {
    return { probe: "REST · native surface", ok: false, detail: describe(err, key) };
  }
}

/**
 * Mint a short-lived token. This is the path Google documents for Live now:
 * the backend swaps its key for a token and the socket carries the token.
 * Returns the token so the socket probe below can use it.
 */
async function probeEphemeralToken(key: string): Promise<{ outcome: Outcome; token: string | null }> {
  const probe = "REST · mint ephemeral token";
  const now = Date.now();
  try {
    const res = await fetch(`${BASE}/v1beta/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return {
        outcome: { probe, ok: false, detail: `${res.status} ${res.statusText} — ${scrub(text, key).replace(/\s+/g, " ").slice(0, 220)}` },
        token: null,
      };
    }
    const name = (JSON.parse(text) as { name?: string }).name ?? null;
    return {
      outcome: { probe, ok: !!name, detail: name ? "200 OK — token minted" : "200 OK but no token name in the response" },
      token: name,
    };
  } catch (err) {
    return { outcome: { probe, ok: false, detail: describe(err, key) }, token: null };
  }
}

/** Open the Live socket and send a real setup frame; report what closed it. */
function probeSocket(probe: string, url: string, key: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve({ probe, ok, detail: scrub(detail, key) });
    };
    const timer = setTimeout(() => done(false, "no reply within 20s"), TIMEOUT_MS);
    const ws = new WebSocket(url);

    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          setup: { model: `models/${MODEL}`, generationConfig: { responseModalities: ["AUDIO"] } },
        })
      )
    );
    ws.on("message", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("setupComplete")) done(true, `setupComplete — ${MODEL} accepted`);
      else done(false, `unexpected first frame: ${text.slice(0, 200)}`);
    });
    ws.on("close", (code: number, reason: Buffer) =>
      done(false, `closed ${code}${reason?.toString() ? `: ${reason.toString().slice(0, 200)}` : " (no close frame)"}`)
    );
    ws.on("error", (err: Error) => done(false, err.message));
  });
}

function describe(err: unknown, key: string): string {
  return scrub(err instanceof Error ? err.message : String(err), key);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main() {
  const explicit = process.env.GEMINI_LIVE_API_KEY;
  const key = explicit || process.env.GOOGLE_API_KEY;
  if (!key) {
    console.error("Set GEMINI_LIVE_API_KEY (or GOOGLE_API_KEY) and run again.");
    process.exit(1);
  }
  const source = explicit ? "GEMINI_LIVE_API_KEY" : "GOOGLE_API_KEY";
  console.log(`\n${source}: ${keyKind(key)} · asking for model "${MODEL}"\n`);

  const results: Outcome[] = [];
  results.push(await probeNative(key));
  results.push(await probeOpenAiCompat(key));

  const { outcome: mint, token } = await probeEphemeralToken(key);
  results.push(mint);

  results.push(
    await probeSocket("Live socket · ?key=", `${BASE}${LIVE_PATH}?key=${encodeURIComponent(key)}`, key)
  );
  if (token) {
    results.push(
      await probeSocket(
        "Live socket · ?access_token=",
        `${BASE}${LIVE_CONSTRAINED_PATH}?access_token=${encodeURIComponent(token)}`,
        key
      )
    );
  }

  console.log(pad("PROBE", 32) + pad("RESULT", 8) + "DETAIL");
  console.log("─".repeat(110));
  for (const r of results) console.log(pad(r.probe, 32) + pad(r.ok ? "OK" : "FAIL", 8) + r.detail);

  const socketWorks = results.filter((r) => r.probe.startsWith("Live socket") && r.ok);
  console.log(
    socketWorks.length
      ? `\nVoice can work: ${socketWorks.map((r) => r.probe).join(", ")}\n`
      : "\nNo Live socket path accepted this key. The REST rows above say whether the key is usable at all.\n"
  );
}

main().catch((err) => {
  console.error("gemini live auth check failed to run:", err);
  process.exit(1);
});
