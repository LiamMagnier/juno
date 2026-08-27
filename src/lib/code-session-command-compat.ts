const LEGACY_SESSION_COMMAND_KINDS: Readonly<Record<string, string>> = {
  message: "send_message",
  stop: "stop_agent",
  approval: "approval_decision",
  patch: "apply_patch",
  delete: "delete_change",
  git: "git_action",
};

/**
 * Normalize older mobile/Web command spellings into the vocabulary executed by
 * the current native Workbench host.
 *
 * Keep this module transport- and database-free: it is a compatibility contract
 * shared by both HTTP command entry points and can be unit-tested without
 * loading Next, Prisma, auth, or the native runtime.
 */
export function canonicalSessionCommand(
  kind: string,
  rawPayload: Record<string, unknown>,
): { kind: string; payload: Record<string, unknown> } {
  const canonicalKind = LEGACY_SESSION_COMMAND_KINDS[kind] ?? kind;
  const payload = { ...rawPayload };

  if (canonicalKind === "send_message") {
    if (typeof payload.text !== "string" && typeof payload.prompt === "string") {
      payload.text = payload.prompt;
    }
    delete payload.prompt;
  }

  if (canonicalKind === "approval_decision") {
    if (typeof payload.approvalId !== "string" && typeof payload.requestId === "string") {
      payload.approvalId = payload.requestId;
    }
    if (typeof payload.approved !== "boolean" && typeof payload.approve === "boolean") {
      payload.approved = payload.approve;
    }
    delete payload.requestId;
    delete payload.approve;
  }

  return { kind: canonicalKind, payload };
}