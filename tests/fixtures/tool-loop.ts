/**
 * A fake turn toolset for the scripted-transport adapter tests: two tools the
 * dispatcher knows (`lookup`, a parallel-safe read with a strict schema, and
 * `slow_job`, a write that runs until it is stopped), and a record of every
 * call that actually reached an executor — "nothing ran" is checked on that
 * record, never inferred from the text the model was sent.
 */

import type { ToolExecution } from "@/lib/mcp";
import type { ChatToolset, ResolvedTool, ToolExecuteOptions } from "@/lib/tools/types";

export interface Dispatched {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

export interface FakeToolset extends ChatToolset {
  dispatched: Dispatched[];
}

const LOOKUP: ResolvedTool = {
  name: "lookup",
  origin: "alevr",
  title: "Lookup",
  risk: "read",
  parallelSafe: true,
  timeoutMs: 5_000,
  dedupe: false,
  input: { type: "object", properties: { q: { type: "string", description: "Query." } }, required: ["q"] },
};

const SLOW_JOB: ResolvedTool = {
  name: "slow_job",
  origin: "alevr",
  title: "Slow job",
  risk: "write",
  parallelSafe: false,
  timeoutMs: 5_000,
  dedupe: false,
  input: { type: "object", properties: { q: { type: "string", description: "Job." } } },
};

export function fakeTurnToolset(opts: { onRunning?: (callId: string) => void } = {}): FakeToolset {
  const resolved = new Map([LOOKUP, SLOW_JOB].map((tool) => [tool.name, tool]));
  const dispatched: Dispatched[] = [];
  return {
    dispatched,
    tools: [LOOKUP, SLOW_JOB].map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.title, parameters: tool.input as unknown as Record<string, unknown> },
    })),
    resolve: (name) => resolved.get(name),
    labelFor: (name) => resolved.get(name)?.title ?? name,
    accessFor: (name) => (name === "lookup" ? "read" : "write"),
    async execute(name, args, signal, callId, execOpts?: ToolExecuteOptions): Promise<ToolExecution> {
      dispatched.push({ name, args, callId });
      execOpts?.onAuthorized?.();
      if (name === "slow_job") {
        opts.onRunning?.(callId ?? "");
        await new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const text = `${name}:${String(args.q)}`;
      return { text, body: text, ok: true };
    },
    close: async () => {},
  };
}

/** A scripted stream of raw provider events, as an async iterable. */
export async function* scripted<T>(events: readonly T[], signal?: AbortSignal): AsyncGenerator<T> {
  for (const event of events) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    yield event;
  }
}

/** A Gemini streamGenerateContent response: one SSE `data:` line per chunk. */
export function sseResponse(chunks: readonly unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
