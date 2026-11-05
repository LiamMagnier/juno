import { mock } from "node:test";
import { createInterface } from "node:readline";

/*
 * Process A of tests/chat-cross-process-stop.integration.test.ts: a second
 * backend process that runs real chat turns through POST /api/chat against
 * the same database as the test process (process B).
 *
 * What runs for real: the route, admission, the durable receipt, the message
 * and spend writes, the SSE sender, the stream log, the generation registry
 * and its signal pump (cancel rows and live leases in Postgres). Stand-ins,
 * as in chat-turn-pipeline.integration.test.ts: the signed-in session,
 * provider configuration, `after()` (captured and drained here) and THE MODEL,
 * which streams one word every STEP_MS until aborted and reports when its
 * AbortSignal fired.
 *
 * Protocol: one JSON command per stdin line, `{ id, userId, body }`; every
 * event goes to stdout as one line prefixed with MARKER so the app's own
 * console output cannot be mistaken for it. Started by the parent with
 * `node --import tsx --experimental-test-module-mocks --conditions=react-server`.
 */

const MARKER = "@@xproc ";
const STEP_MS = 100;
const WORDS = 300;

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);
}

let signedIn: { id: string; email: string; name: string } | null = null;
let currentId = "";
const afterQueue: Array<() => unknown> = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`unexpected network call to ${url}`);
  };
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });
  const server = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) },
  });
  const providers = await import("@/lib/providers");
  mock.module("@/lib/providers", {
    namedExports: {
      ...providers,
      isProviderConfigured: () => true,
      configuredProviders: () => [...providers.PROVIDER_LIST],
    },
  });
  const llm = await import("@/lib/llm");
  mock.module("@/lib/llm", {
    namedExports: {
      ...llm,
      streamChat: (opts: { signal?: AbortSignal; requestContext?: unknown; cacheKey?: string }) => {
        // The turn itself: a saved turn passes its request context, a private
        // turn its per-user cache key. Background work after the turn
        // (moderation, memory) gets an empty reply.
        const turnCall = !!opts.requestContext || opts.cacheKey?.startsWith("private-") === true;
        if (!turnCall) return (async function* () { yield { type: "finish", reason: "stop" }; })();
        const id = currentId;
        emit({ id, event: "provider-called", at: Date.now() });
        opts.signal?.addEventListener("abort", () => emit({ id, event: "provider-aborted", at: Date.now() }), { once: true });
        return (async function* () {
          for (let i = 0; i < WORDS; i += 1) {
            await sleep(STEP_MS);
            if (opts.signal?.aborted) throw new DOMException("Stopped by user", "AbortError");
            yield { type: "text", text: `word${i} ` };
          }
          yield { type: "usage", input: 40, output: WORDS };
          yield { type: "finish", reason: "stop" };
        })();
      },
    },
  });
}

async function runTurn(command: { id: string; userId: string; body: Record<string, unknown> }) {
  currentId = command.id;
  signedIn = { id: command.userId, email: `${command.userId}@example.invalid`, name: "Process A" };
  const route = await import("@/app/api/chat/route");
  const res = await route.POST(
    new Request("http://juno.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-juno-request-id": `req-${command.id}` },
      body: JSON.stringify(command.body),
    })
  );
  if (!res.headers.get("content-type")?.includes("event-stream") || !res.body) {
    emit({ id: command.id, event: "response", status: res.status, body: await res.text() });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let deltas = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line.startsWith("data: ")) continue;
      const frame = JSON.parse(line.slice("data: ".length)) as { type: string; [key: string]: unknown };
      if (frame.type === "meta") emit({ id: command.id, event: "meta", at: Date.now(), generationId: frame.generationId, conversationId: frame.conversationId });
      if (frame.type === "delta") {
        deltas += 1;
        emit({ id: command.id, event: "delta", at: Date.now(), deltas });
      }
      if (frame.type === "done" || frame.type === "error" || frame.type === "handoff") {
        emit({ id: command.id, event: "terminal", at: Date.now(), frame, deltas });
      }
    }
  }
  while (afterQueue.length) await afterQueue.shift()!();
  emit({ id: command.id, event: "settled", at: Date.now() });
}

async function main() {
  await setup();
  emit({ event: "ready", pid: process.pid });
  const lines = createInterface({ input: process.stdin });
  const running: Promise<void>[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as { id: string; userId: string; body: Record<string, unknown> };
    running.push(
      runTurn(command).catch((error: unknown) => {
        emit({ id: command.id, event: "crashed", message: error instanceof Error ? error.stack ?? error.message : String(error) });
      })
    );
  }
  await Promise.all(running);
  const { prismaUnguarded } = await import("@/lib/prisma");
  await prismaUnguarded.$disconnect();
  emit({ event: "exit" });
  process.exit(0);
}

void main().catch((error: unknown) => {
  emit({ event: "crashed", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
