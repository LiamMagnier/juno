/**
 * The tool round-trip probe (TOOL_RUNTIME_DESIGN §6.11): evidence, per model,
 * that tool calling works THROUGH ALEVR'S OWN ADAPTER — not a catalog flag.
 *
 * `agenticTools` on a catalog row is a guess (`guessAgenticTools`), and the
 * capability probe only ever sent "Reply with OK.", so until now nothing in
 * the product could say truthfully which models run tools. The execution and
 * skill tools are attached only for a model whose verdict here is `verified`;
 * every other model gets a plain-language note instead (see
 * `codeExecutionNote` in chat/prompt-sections.ts).
 *
 * The probe, run through the real adapter and the real dispatcher:
 *
 *   1. ROUND TRIP (decides the verdict). One function, `multiply(a, b)`. The
 *      model must call it with valid JSON arguments, receive the result and
 *      state it. Verified only if all three happen.
 *   2. PARALLEL (recorded, informative). Two independent calls in ONE response.
 *   3. TOOL IMAGE (recorded, vision models only). A tool returns a solid-colour
 *      PNG; the model must name the colour, which it can only know by seeing
 *      the pixels the adapter carried back.
 *
 * Stored under `ModelCapabilityProbe.evidence.tools` (the free-JSON column, so
 * no migration), version 2 of the tool evidence: version 1 was the catalog's
 * `catalogCapabilities.tools` guess that the transport probe copied — a
 * declaration, not evidence. A model with no current version-2 record is
 * `untested`, and an untested model is never treated as compatible.
 *
 * Pure apart from the injected stream: no credentials, no database. The
 * runner (`model-capability.ts`) supplies the adapter.
 */

import { deflateSync } from "node:zlib";
import { createToolLoop, type ToolLoop } from "@/lib/tools/loop";
import type { ChatToolset, ResolvedTool } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

export const TOOL_PROBE_VERSION = 2;
/** Tool behaviour moves slowly and each probe is billed: a verdict speaks for 30 days. */
export const TOOL_PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A probe the provider never answered is retried soon and decides nothing. */
export const TOOL_PROBE_TRANSPORT_TTL_MS = 60 * 60 * 1000;

export type ToolCheck = "passed" | "failed" | "skipped";
export type ToolCallingVerdict = "verified" | "failed" | "untested";

export interface ToolProbeEvidence {
  probeVersion: typeof TOOL_PROBE_VERSION;
  verdict: "verified" | "failed";
  checkedAt: string;
  expiresAt: string;
  adapter: string;
  checks: { roundTrip: ToolCheck; parallel: ToolCheck; toolImage: ToolCheck };
  /** One short line for an operator. Never a provider body, never a prompt. */
  detail?: string;
  /** `transport`: the provider never answered — not evidence about tool calling. */
  failureKind?: "transport" | "model";
}

/** What the probe needs from the runner: one streamed turn through the model's own adapter. */
export type ProbeStream = (input: {
  system: string;
  prompt: string;
  tools: ToolLoop;
  signal: AbortSignal;
}) => AsyncGenerator<LlmEvent>;

const MULTIPLY: ResolvedTool = {
  name: "multiply",
  origin: "alevr",
  title: "Multiply",
  risk: "read",
  parallelSafe: true,
  timeoutMs: 5_000,
  dedupe: false,
  input: {
    type: "object",
    properties: {
      a: { type: "number", description: "The first factor." },
      b: { type: "number", description: "The second factor." },
    },
    required: ["a", "b"],
  },
};

const SHOW_SWATCH: ResolvedTool = {
  name: "show_swatch",
  origin: "alevr",
  title: "Show swatch",
  risk: "read",
  parallelSafe: true,
  timeoutMs: 5_000,
  dedupe: false,
  input: { type: "object", properties: {} },
};

const PROBE_SYSTEM =
  "You are being tested on tool use. Use the tools you are given whenever the user asks you to, and answer briefly.";

/** The probe's own toolset: pure functions, nothing leaves the process. */
export function probeToolset(opts: { image?: boolean } = {}): ChatToolset & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const tools = opts.image ? [MULTIPLY, SHOW_SWATCH] : [MULTIPLY];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description:
          tool.name === "multiply"
            ? "Multiplies two numbers exactly and returns the product."
            : "Shows you a colour swatch as an image. Call it when asked about the swatch.",
        parameters: tool.input as unknown as Record<string, unknown>,
      },
    })),
    resolve: (name) => byName.get(name),
    labelFor: (name) => byName.get(name)?.title ?? name,
    accessFor: () => "read",
    async execute(name, args, _signal, _callId, execOpts) {
      execOpts?.onAuthorized?.();
      calls.push({ name, args });
      if (name === "multiply") {
        const product = Number(args.a) * Number(args.b);
        const text = `The product is ${product}.`;
        return { text, body: text, ok: true };
      }
      return {
        text: "Here is the swatch.",
        body: "Here is the swatch.",
        ok: true,
        images: [{ mimeType: "image/png", base64: solidPng(64, 64, [220, 20, 20]).toString("base64"), label: "swatch" }],
      };
    },
    close: async () => {},
  };
}

interface TurnRecord {
  text: string;
  calls: Array<{ name: string; round?: number; args?: string }>;
  results: Array<{ name: string; ok: boolean; status?: string }>;
}

async function runTurn(stream: ProbeStream, prompt: string, toolset: ChatToolset, timeoutMs: number): Promise<TurnRecord> {
  const record: TurnRecord = { text: "", calls: [], results: [] };
  const signal = AbortSignal.timeout(timeoutMs);
  for await (const event of stream({ system: PROBE_SYSTEM, prompt, tools: createToolLoop(toolset), signal })) {
    if (event.type === "text") record.text += event.text;
    else if (event.type === "tool" && event.phase === "call") record.calls.push({ name: event.name, round: event.round, args: event.args });
    else if (event.type === "tool" && event.phase === "result") record.results.push({ name: event.name, ok: event.ok, status: event.status });
  }
  return record;
}

/** Digits only, so "7,006,652" and "7 006 652" both read as the number. */
function mentionsNumber(text: string, value: number): boolean {
  return text.replace(/(?<=\d)[,.\s  '](?=\d{3}\b)/g, "").includes(String(value));
}

export function roundTripPassed(record: TurnRecord, a: number, b: number): { passed: boolean; detail?: string } {
  const called = record.calls.filter((call) => call.name === "multiply");
  if (called.length === 0) return { passed: false, detail: "The model did not call the tool." };
  const ran = record.results.some((result) => result.name === "multiply" && result.ok);
  if (!ran) return { passed: false, detail: "The model's call was not valid, so the tool did not run." };
  if (!mentionsNumber(record.text, a * b)) return { passed: false, detail: "The model did not state the tool's result." };
  return { passed: true };
}

export function parallelPassed(record: TurnRecord, products: number[]): boolean {
  const rounds = new Map<number, number>();
  for (const call of record.calls) {
    if (call.name !== "multiply") continue;
    rounds.set(call.round ?? 0, (rounds.get(call.round ?? 0) ?? 0) + 1);
  }
  const inOneResponse = [...rounds.values()].some((n) => n >= 2);
  return inOneResponse && products.every((value) => mentionsNumber(record.text, value));
}

/**
 * Run the probe. `answered` false means the provider never produced a single
 * event (a key, a network or a quota problem): the result is transport-class
 * and must not be stored as a verdict about tool calling.
 */
export async function runToolProbe(input: {
  stream: ProbeStream;
  adapter: string;
  vision: boolean;
  now?: Date;
  turnTimeoutMs?: number;
}): Promise<{ evidence: ToolProbeEvidence; answered: boolean }> {
  const now = input.now ?? new Date();
  const timeout = input.turnTimeoutMs ?? 60_000;
  const checks: ToolProbeEvidence["checks"] = { roundTrip: "failed", parallel: "skipped", toolImage: "skipped" };
  const evidence = (verdict: "verified" | "failed", extra: Partial<ToolProbeEvidence> = {}): ToolProbeEvidence => ({
    probeVersion: TOOL_PROBE_VERSION,
    verdict,
    checkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (extra.failureKind === "transport" ? TOOL_PROBE_TRANSPORT_TTL_MS : TOOL_PROBE_TTL_MS)).toISOString(),
    adapter: input.adapter,
    checks,
    ...extra,
  });

  let first: TurnRecord;
  try {
    first = await runTurn(input.stream, "Use the multiply tool to compute 1234 times 5678, then reply with only the result.", probeToolset(), timeout);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    return { evidence: evidence("failed", { detail, failureKind: "transport" }), answered: false };
  }
  const roundTrip = roundTripPassed(first, 1234, 5678);
  checks.roundTrip = roundTrip.passed ? "passed" : "failed";
  if (!roundTrip.passed) return { evidence: evidence("failed", { detail: roundTrip.detail, failureKind: "model" }), answered: true };

  try {
    const second = await runTurn(
      input.stream,
      "Call the multiply tool twice in the same response, in parallel: once for 12 times 13 and once for 21 times 22. Then reply with both results.",
      probeToolset(),
      timeout,
    );
    checks.parallel = parallelPassed(second, [156, 462]) ? "passed" : "failed";
  } catch {
    checks.parallel = "failed";
  }

  if (input.vision) {
    try {
      const third = await runTurn(
        input.stream,
        "Call the show_swatch tool, look at the image it returns, and reply with only the colour's name in one word.",
        probeToolset({ image: true }),
        timeout,
      );
      checks.toolImage = /\bred\b/i.test(third.text) ? "passed" : "failed";
    } catch {
      checks.toolImage = "failed";
    }
  }

  return { evidence: evidence("verified"), answered: true };
}

/**
 * The verdict a stored evidence object gives today. Missing, stale or
 * older-version evidence is untested.
 *
 * `adapter`, when given, is the adapter THIS turn will use: evidence gathered
 * through another one (an OpenAI model probed over chat completions, then run
 * in Pro mode over Responses) says nothing about this code path, so it is
 * untested here.
 */
export function toolCallingVerdict(evidence: unknown, now = new Date(), adapter?: string): ToolCallingVerdict {
  const tools = (evidence as { tools?: unknown } | null | undefined)?.tools as Partial<ToolProbeEvidence> | undefined;
  if (!tools || tools.probeVersion !== TOOL_PROBE_VERSION) return "untested";
  if (tools.failureKind === "transport") return "untested";
  if (adapter !== undefined && tools.adapter !== adapter) return "untested";
  const expires = typeof tools.expiresAt === "string" ? Date.parse(tools.expiresAt) : Number.NaN;
  if (!Number.isFinite(expires) || expires <= now.getTime()) return "untested";
  return tools.verdict === "verified" ? "verified" : tools.verdict === "failed" ? "failed" : "untested";
}

// ── A solid-colour PNG, for the tool-image check ─────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of one colour. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
