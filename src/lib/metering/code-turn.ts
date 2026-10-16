import { createHash } from "node:crypto";

/*
 * WHICH PROXIED CALL OPENS A CODE TURN.
 *
 * A web chat turn is admitted and counted once, when the person sends a
 * message (`consumeMessage`): the email check, the month's message counter,
 * then the budget and the windows. A Code turn has no such moment on the
 * server. Its engine — the Mac's Swift engine, the env-server, the cloud
 * runner — runs the agent loop itself and reaches the server only as a series
 * of provider calls through `/api/agent/[...path]`, each billed there from the
 * provider's own usage. The budget and the windows were already checked on
 * every one of those calls; what no call did was count the turn, so a person
 * who worked all month in Code showed as a person who sent nothing.
 *
 * The turn is still visible in the calls, though, and it does not need the
 * client's word for it. An agent loop's first call of a turn ends on what the
 * person (or the orchestrator, for a subagent) said; every call after it ends
 * on tool results the loop is answering. That is a property of the request
 * body the provider will read, so this module reads it from there, the same
 * body `inspectAgentRequest` already parses, and never from a header a client
 * could leave off.
 *
 * Side calls. An engine also asks the model things that are not turns: the
 * Mac's auto-reviewer before a risky step, the completion judge, a hook's
 * prompt, a summary for compaction, a title. Each of those ends on words the
 * engine wrote as a user message, so the closing message alone would count
 * every one as a turn, and an auto-reviewed turn with ten risky steps as
 * eleven. What tells them apart is also in the body: a turn of the agent loop
 * offers the model its tools, and every one of those side calls is sent with
 * none (`tools: []` in the Swift engine's requests, and agent-core's helpers
 * alike). So an opening must offer tools. The one side call that keeps them is
 * the Mac's cache-reading compaction, which resends the session's prefix
 * whole; it runs once per long session and is counted, which is the honest
 * cost of not trusting a header for this.
 *
 * Retries. An engine retries an opening call that failed or was cut short with
 * the same body, and a retried opening is not a second turn. `fingerprint`
 * names the opening by what it asks — the wire, the model, how long the
 * conversation is and the closing words — so the store can count it once
 * inside a short window (`countCodeTurn` in code-turn-store.ts).
 *
 * Pure and free of the database so the classifier is tested on its own.
 */

export type CodeTurnWire = "anthropic" | "openai-chat" | "openai-responses";

export type CodeTurnOpening =
  | { opens: true; fingerprint: string }
  | { opens: false };

const NOT_AN_OPENING: CodeTurnOpening = { opens: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Responses API items that hand a tool's result back to the model. A request
 * whose input ends on one is the loop continuing a turn, never a new one.
 */
const RESPONSES_TOOL_OUTPUTS = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "computer_call_output",
  "local_shell_call_output",
  "apply_patch_call_output",
  "mcp_approval_response",
  "tool_search_output",
]);

/** The closing user message of an Anthropic Messages body, if it is the person speaking. */
function anthropicOpening(body: Record<string, unknown>): unknown | null {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const last = messages?.at(-1);
  if (!isRecord(last) || last.role !== "user") return null;
  const content = last.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content) || content.length === 0) return null;
  // One tool result anywhere in the closing message makes it the loop's turn:
  // Anthropic puts tool results first and lets text follow them in the same
  // message ("here is the output, and also…"), which is still a continuation.
  if (content.some((block) => isRecord(block) && block.type === "tool_result")) return null;
  return content;
}

/** The closing message of a Chat Completions body, if it is the person speaking. */
function chatOpening(body: Record<string, unknown>): unknown | null {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const last = messages?.at(-1);
  if (!isRecord(last) || last.role !== "user") return null;
  const content = last.content;
  if (typeof content === "string") return content.trim() ? content : null;
  return Array.isArray(content) && content.length > 0 ? content : null;
}

/** The closing input item of a Responses body, if it is the person speaking. */
function responsesOpening(body: Record<string, unknown>): unknown | null {
  const input = body.input;
  if (typeof input === "string") return input.trim() ? input : null;
  if (!Array.isArray(input)) return null;
  const last = input.at(-1);
  if (!isRecord(last)) return null;
  if (typeof last.type === "string" && RESPONSES_TOOL_OUTPUTS.has(last.type)) return null;
  // A message item may omit `type` (the easy-input form) but always has a role.
  if (last.role !== "user") return null;
  if (last.type !== undefined && last.type !== "message") return null;
  return last.content ?? null;
}

/**
 * Feed a JSON value into the hash without recursion.
 *
 * Not `JSON.stringify`: a body is the client's, and a closing message nested
 * twenty thousand arrays deep is valid JSON that overflows the stack of any
 * recursive walk — which would turn a request the provider accepts into a 500
 * here. Iterative, with a node budget: past it the rest of the value is simply
 * not read, which keeps the fingerprint deterministic for one body (a retry
 * hashes to the same value) at a bounded cost.
 */
const MAX_HASHED_NODES = 20_000;

function hashValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length > 0 && nodes < MAX_HASHED_NODES) {
    const next = pending.pop();
    nodes += 1;
    if (typeof next === "string") hash.update(`s${next.length}:${next}`);
    else if (typeof next === "number" || typeof next === "boolean") hash.update(`p${String(next)};`);
    else if (next === null || next === undefined) hash.update("n;");
    else if (Array.isArray(next)) {
      hash.update(`a${next.length}[`);
      for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i]);
    } else if (isRecord(next)) {
      const keys = Object.keys(next).sort();
      hash.update(`o${keys.length}{`);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        pending.push(next[keys[i]]);
        pending.push(keys[i]);
      }
    }
  }
}

/**
 * Whether the call offers the model tools: what an agent loop's turn always
 * does and its side calls never do (see "Side calls" above). `functions` is
 * Chat Completions' older spelling of the same thing.
 */
function offersTools(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return Array.isArray(body.functions) && body.functions.length > 0;
}

function conversationLength(wire: CodeTurnWire, body: Record<string, unknown>): number {
  const list = wire === "openai-responses" ? body.input : body.messages;
  return Array.isArray(list) ? list.length : 1;
}

/**
 * Whether this provider call opens a turn, and the opening's fingerprint.
 *
 * Reads the body exactly as the provider will. Anything this cannot read as a
 * person's closing words is answered as a continuation, which is the cheap
 * direction to be wrong in: a missed opening leaves a turn uncounted, and the
 * call itself is still billed in full by the proxy whatever this says.
 */
export function codeTurnOpening(wire: CodeTurnWire, body: Record<string, unknown>): CodeTurnOpening {
  if (!offersTools(body)) return NOT_AN_OPENING;
  const closing =
    wire === "anthropic" ? anthropicOpening(body) : wire === "openai-chat" ? chatOpening(body) : responsesOpening(body);
  if (closing === null) return NOT_AN_OPENING;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const hash = createHash("sha256").update(`${wire}\u0000${model}\u0000${conversationLength(wire, body)}\u0000`);
  hashValue(hash, closing);
  return { opens: true, fingerprint: hash.digest("hex").slice(0, 40) };
}

/**
 * How long a repeated opening is read as a retry of the first rather than a
 * new turn. Long enough to cover an engine's whole retry budget after an
 * overloaded provider (the Swift engine's `ModelRetryPolicy.standard` waits at
 * most 90 seconds per step across its retries); short enough that a person who
 * really does send the same words to the same model at the same point of a
 * conversation later is counted again.
 */
export const CODE_TURN_RETRY_WINDOW_SEC = 10 * 60;

/** The key a counted opening holds for the retry window. Scoped to the account. */
export function codeTurnKey(userId: string, fingerprint: string): string {
  return `code-turn:${userId}:${fingerprint}`;
}
