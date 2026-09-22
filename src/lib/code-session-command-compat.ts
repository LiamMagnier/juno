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
/** Where a command names one change: the Mac's `changeId`, or the web's `path`. */
const CHANGE_FIELDS = ["changeId", "path"] as const;

export function canonicalSessionCommand(
  kind: string,
  rawPayload: Record<string, unknown>,
): { kind: string; payload: Record<string, unknown> } {
  let canonicalKind = LEGACY_SESSION_COMMAND_KINDS[kind] ?? kind;
  const payload = { ...rawPayload };

  // `patch` is two things. With a change named it keeps that change; without
  // one it is the phone's session menu (model, effort, mode, title, pin), which
  // used to reach the Mac as an `apply_patch` missing its `changeId` — so every
  // setting changed from the phone failed with an error about a field the phone
  // never meant to send.
  if (kind === "patch") {
    const namesChange = CHANGE_FIELDS.some((field) => typeof payload[field] === "string" && payload[field] !== "");
    canonicalKind = namesChange ? "apply_patch" : "update_session";
  }

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