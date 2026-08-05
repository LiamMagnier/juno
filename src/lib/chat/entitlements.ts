/**
 * Stage: entitlements — the request-shaped refusals, as data.
 *
 * These are the checks that answer "this account may not do this, in this
 * mode", as opposed to admission (is the body well-formed and small enough)
 * and planning (which model can serve it). They were scattered through the
 * route as inline `return NextResponse.json(...)` statements, so the set of
 * things private mode refuses could only be discovered by reading 1,000 lines.
 *
 * Each returns the exact status and body the route returned before, or null.
 * The route still calls them at their original positions rather than as one
 * block: the private-mode canvas and regenerate refusals happen *after* model
 * resolution today, so a private regenerate sent to an account with no
 * configured provider answers 503 rather than 400. That ordering is observable,
 * so it is preserved — naming the rules is the change, not reordering them.
 */

export interface EntitlementRejection {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Uploads use the persistent account attachment store. Until an explicitly
 * ephemeral upload path exists, accepting them in private mode would make the
 * no-history promise misleading even though the chat branch ignores the IDs.
 */
export function privateAttachmentsRefusal(input: {
  privateMode?: boolean;
  attachmentIds?: readonly string[];
}): EntitlementRejection | null {
  if (!input.privateMode || (input.attachmentIds?.length ?? 0) === 0) return null;
  return {
    status: 400,
    body: {
      error: "private_attachments_unsupported",
      code: "PRIVATE_ATTACHMENTS_UNSUPPORTED",
      message: "Attachments are not available in private chat.",
    },
  };
}

/** A turn has to carry something: text, a clarification reply, or a file. */
export function emptySubmissionRefusal(input: {
  regenerate?: boolean;
  message?: string;
  clarification?: unknown;
  attachmentIds?: readonly string[];
}): EntitlementRejection | null {
  if (input.regenerate) return null;
  if (input.message?.trim()) return null;
  if (input.clarification) return null;
  if ((input.attachmentIds?.length ?? 0) > 0) return null;
  return { status: 400, body: { error: "Message cannot be empty." } };
}

/**
 * Private mode's two structural refusals.
 *
 * Both exist because the feature needs stored state that private mode does not
 * have: a canvas edit resolves an owned artifact row, and a regenerate replaces
 * a persisted assistant message.
 */
export function privateModeFeatureRefusal(input: {
  artifactEdit?: unknown;
  regenerate?: boolean;
}): EntitlementRejection | null {
  if (input.artifactEdit) {
    return { status: 400, body: { error: "Canvas edits are not available in private chat." } };
  }
  if (input.regenerate) {
    return { status: 400, body: { error: "Regenerate is not available in private chat." } };
  }
  return null;
}

/**
 * A Juno Code session that has somewhere to run never goes through the chat
 * pipeline: its prompts are tasks executed on the user's Mac or in the cloud.
 *
 * A code conversation with NO workspace is the exception, and this condition is
 * exactly its inverse. That is the "not in a project" conversation Juno Code
 * offers before you have opened anything: there is no runner that could execute
 * it, so the chat pipeline is not a shortcut around the task system — it is the
 * only thing that can answer at all. Both conditions read the same two columns,
 * so a session can never be answerable by both.
 */
export function codeSessionRefusal(
  conversation: { kind: string; codeWorkspacePath?: string | null; codeWorkspaceKey?: string | null } | null
): EntitlementRejection | null {
  if (!conversation || conversation.kind !== "code") return null;
  if (!conversation.codeWorkspacePath && !conversation.codeWorkspaceKey) return null;
  return {
    status: 409,
    body: {
      error: "This is a Juno Code session — prompts run on your Mac via /api/code/tasks, not /api/chat.",
    },
  };
}
