/**
 * Alevr's capabilities, said to every runtime in its own tool names.
 *
 * Two layers:
 *  - `capabilityGuidance(kind)`: the standing rule, once per session (the
 *    Claude system prompt append, Codex developer instructions, the Alevr
 *    MCP server's instructions): use subagents, the Preview and computer use
 *    on your own when they help.
 *  - `withCapabilityHints(input, kind)`: when the person's message names one
 *    of them ("using subagents, computer use and show me a preview"), a short
 *    block ahead of the message says which tool does it, so a small model at
 *    low effort does not quietly do the work another way.
 */
import type { InteractionMode, ProviderKind, UserInput } from "../contracts/code-v2.js";

export type Capability = "subagents" | "computer" | "preview";

const PATTERNS: Record<Capability, RegExp> = {
  subagents: /\b(sub-?agents?|agent teams?|team of agents|(?:several|multiple|parallel|many) agents|in parallel with agents|delegate)\b/i,
  computer: /\b(computer[- ]use|use (?:the|my|your) (?:computer|mac|screen)|control (?:the|my) (?:computer|mac|screen)|screen ?shot|look at (?:the|my) screen)\b/i,
  preview: /\b(previews?|show me (?:it|the (?:site|page|app|result|portfolio|website))|open (?:it|the (?:site|page|app)) in the browser)\b/i,
};

/** The capabilities a message asks for by name. */
export function requestedCapabilities(text: string): Capability[] {
  return (Object.keys(PATTERNS) as Capability[]).filter((c) => PATTERNS[c].test(text));
}

const isEngine = (kind: ProviderKind | null) => kind === "alevr" || kind === "byok";

/** How a runtime calls each capability. */
function toolNames(kind: ProviderKind | null): Record<Capability, string> {
  if (kind === "claude-agent") {
    return {
      subagents: "your Agent tool (Task), or mcp__alevr__spawn_subagent for another model",
      computer: "mcp__alevr__computer_use",
      preview: "mcp__alevr__open_preview",
    };
  }
  if (isEngine(kind)) {
    return { subagents: "spawn_agent or delegate_tasks", computer: "computer_use", preview: "open_preview" };
  }
  return {
    subagents: "the alevr spawn_subagent tool (then wait_subagent)",
    computer: "the alevr computer_use tool",
    preview: "the alevr open_preview tool",
  };
}

const LINES: Record<Capability, (tool: string) => string> = {
  subagents: (t) => `Subagents: split the work into independent parts and run them with ${t}, in parallel where they do not depend on each other.`,
  computer: (t) => `Computer use: look at the running result with ${t} (a screenshot first) and check it visually.`,
  preview: (t) => `Preview: when there is a page to see, open it with ${t} so the Preview tab shows it.`,
};

/** The block ahead of a message that names capabilities, or undefined. */
export function capabilityHint(text: string, kind: ProviderKind | null): string | undefined {
  const asked = requestedCapabilities(text);
  if (!asked.length) return undefined;
  const tools = toolNames(kind);
  return [
    "<alevr_capabilities>",
    "The person asked for these by name. Use each one in this turn with the tool given; if one is unavailable, say so plainly instead of skipping it.",
    ...asked.map((c) => `- ${LINES[c](tools[c])}`),
    "</alevr_capabilities>",
  ].join("\n");
}

/**
 * The turn's input with the capability block ahead of it. Plan mode only
 * plans. `asked` is the person's own words (default: the input's text), so
 * skill bodies prepended to the input never count as asking.
 */
export function withCapabilityHints(input: UserInput, kind: ProviderKind | null, interactionMode: InteractionMode, asked = input.text): UserInput {
  if (interactionMode === "plan") return input;
  const hint = capabilityHint(asked, kind);
  return hint ? { ...input, text: `${hint}\n\n${input.text}` } : input;
}

/** The standing rule, in the runtime's own tool names. */
export function capabilityGuidance(kind: ProviderKind | null): string {
  const tools = toolNames(kind);
  return [
    "Alevr capabilities. Use them when the person names them, and on your own when they help:",
    `- Subagents (${tools.subagents}): for work that splits into independent parts (separate pages or sections, front end and back end, tests, a broad search, an independent review). Give each a complete, self-contained task. Alevr shows them in its Agents panel. Skip them for small or strictly sequential work.`,
    `- Preview (${tools.preview}): after you build or change anything with a web page, open it so the person sees it in the Preview tab. A static site needs no server; for a dev server, start it in the background first and pass its http://localhost address.`,
    `- Computer use (${tools.computer}): to look at the running page or app and check it visually, when that helps or the person asks. Release it when done.`,
  ].join("\n");
}
