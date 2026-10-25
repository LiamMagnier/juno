/**
 * The Alevr live executor for workflows whose deliverable is a chat answer
 * (answer.md, optionally facts.json) and whose inputs are text. It sends the
 * fixed prompt, with the input files inlined, through an injected model call —
 * the script wires Alevr's own `streamChat` and Auto router — and records the
 * model, tokens and measured cost.
 *
 * Its scope is `model_via_router`, NOT `end_to_end`: it uses the bench's own
 * LIVE_SYSTEM_PROMPT instead of the product's, offers no tools (streamChat
 * tools are opt-in, so no calculator or code execution even where a workflow
 * permits them), and bypasses the chat route, attachments and persistence.
 * Its records are reported in their own column and never count toward P1-7
 * acceptance. The product end to end is run in the product and imported.
 *
 * Everything else (documents, connectors, agents, devices) needs the deployed
 * product: those workflows are `not_run` here with the exact reason, and are
 * run in the product and brought in with the import executor.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionContext, ExecutionPlan, ExecutionResult, Executor } from "../runner";
import type { ProductInfo, Requirement, WorkflowSpec } from "../types";

export interface LiveCallInput {
  system: string;
  prompt: string;
  webSearch: boolean;
  signal: AbortSignal;
}

export interface LiveCallOutput {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when the price is unknown; never a guessed zero. */
  costUsd: number | null;
  settings?: Record<string, unknown>;
}

export type LiveModelCall = (input: LiveCallInput) => Promise<LiveCallOutput>;

const TEXT_INPUT = /\.(md|txt|csv|html?|json)$/i;
const CHAT_ARTIFACTS = new Set(["answer.md", "facts.json"]);
/** Requirements the live chat harness itself satisfies (given a key / network). */
const HARNESS_COVERS: Requirement[] = ["provider_key", "human_reviewer", "network"];

export const LIVE_SYSTEM_PROMPT =
  "You are being evaluated on a fixed task. Follow the user's instructions and formatting exactly. " +
  "The user's files are inlined below their request. Write the content of answer.md as your reply. " +
  "If the task asks for facts.json, also include it as a fenced code block that starts with ```json facts.json.";

export function livePlan(workflow: WorkflowSpec, env: { providersConfigured: string[]; network: boolean; hasCall: boolean }): ExecutionPlan {
  // Every blocker is listed, not just the first, so the owner knows what a
  // real run of this workflow needs.
  const blockers: string[] = [];
  const beyond = workflow.requires.filter((r) => !HARNESS_COVERS.includes(r));
  if (beyond.length) blockers.push(`needs ${beyond.join(", ")} beyond a model call`);
  const nonChat = workflow.requiredArtifacts.filter((a) => !CHAT_ARTIFACTS.has(a.name));
  if (nonChat.length) blockers.push(`delivers ${nonChat.map((a) => a.name).join(", ")}, and the live harness captures chat answers only`);
  const binary = workflow.inputs.filter((i) => !TEXT_INPUT.test(i));
  if (binary.length) blockers.push(`needs file attachments (${binary.join(", ")})`);
  const productOnly = blockers.length > 0;
  if (workflow.requires.includes("network") && !env.network) blockers.push("needs network access (run with --network)");
  if (env.providersConfigured.length === 0) blockers.push("no model provider key is configured here (no *_API_KEY set)");
  else if (!env.hasCall) blockers.push("live mode not enabled (run with --live)");
  if (!blockers.length) return { runnable: true };
  return {
    runnable: false,
    state: "not_run",
    reason: `${blockers.join("; ")}${productOnly ? " — run it in the Alevr product and import the outputs" : ""}`,
  };
}

export function buildLivePrompt(workflow: WorkflowSpec, inputsDir: string): string {
  const files = workflow.inputs.map((input) => `File: ${input}\n\`\`\`\n${readFileSync(path.join(inputsDir, input), "utf8").trimEnd()}\n\`\`\``);
  return files.length ? `${workflow.prompt}\n\n${files.join("\n\n")}` : workflow.prompt;
}

/** Split a reply into answer.md and an optional facts.json block. */
export function splitReply(text: string): { answer: string; facts: string | null } {
  const fence = /```json\s+facts\.json\s*\n([\s\S]*?)```/i.exec(text) ?? /```json\s*\n([\s\S]*?)```/i.exec(text);
  if (!fence) return { answer: text.trim(), facts: null };
  return { answer: text.replace(fence[0], "").trim(), facts: fence[1].trim() };
}

export function liveExecutor(options: {
  product: ProductInfo;
  call: LiveModelCall | null;
  providersConfigured: string[];
  network: boolean;
}): Executor {
  return {
    id: "alevr-live-chat",
    identity: "workflow-bench/live-executor",
    kind: "automated",
    product: options.product,
    scope: "model_via_router",
    plan: (workflow) => livePlan(workflow, { providersConfigured: options.providersConfigured, network: options.network, hasCall: options.call !== null }),
    async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
      const started = new Date().toISOString();
      const out = await options.call!({
        system: LIVE_SYSTEM_PROMPT,
        prompt: buildLivePrompt(ctx.workflow, ctx.inputsDir),
        webSearch: ctx.workflow.permittedTools.includes("web_search"),
        signal: ctx.signal,
      });
      const { answer, facts } = splitReply(out.text);
      writeFileSync(path.join(ctx.outputsDir, "answer.md"), `${answer}\n`);
      if (facts !== null && ctx.workflow.requiredArtifacts.some((a) => a.name === "facts.json")) writeFileSync(path.join(ctx.outputsDir, "facts.json"), `${facts}\n`);
      return {
        outcome: { kind: "completed" },
        startedAt: started,
        model: out.model,
        settings: { system: "LIVE_SYSTEM_PROMPT", tools: "none (streamChat called directly, not the chat route)", webSearch: ctx.workflow.permittedTools.includes("web_search"), ...(out.settings ?? {}) },
        cost: { usd: out.costUsd, source: out.costUsd === null ? "unobserved" : "measured_usage", inputTokens: out.inputTokens, outputTokens: out.outputTokens },
      };
    },
  };
}
