import { ALWAYS_CONFIRM_ACTIONS, type WorkRiskLevel } from "@/lib/work/domain";
import { str, type Payload } from "@/components/work/work-payload";

/*
 * What the approve button says, and what the card shows above it.
 *
 * THE BUTTON NEVER SAYS "APPROVE". A generic verb makes every gate look the
 * same, and the whole value of a gate is that the reader notices which one they
 * are answering. "Approve" on a draft email and "Approve" on a permanent delete
 * are the same three syllables and the same muscle memory, which is exactly how
 * somebody sends a message they meant to read first. The button says Send, or
 * Delete, or Post — the verb of the thing that is about to happen — so the
 * decision is legible from the control alone.
 *
 * TWO VOCABULARIES, NOT ONE. `work-vocabulary.tsx` already owns `actionLabel`,
 * which answers "what is this action called" for a log row — "Change files",
 * "Delete permanently". That is a NOUN PHRASE and it is right for a transcript.
 * A button needs an imperative, and an imperative derived by chopping a noun
 * phrase produces "Delete permanently" on a button, which reads as a setting.
 * So the verbs live here, keyed on the same identifiers, and the two files are
 * deliberately not merged: one is how Juno describes what happened, the other
 * is what the reader is being asked to authorise.
 *
 * The identifiers are the executor's own `WorkTool.name` and the
 * `work.<area>.<act>` action names in `ALWAYS_CONFIRM_ACTIONS`. Both spellings
 * appear on real approvals, so both are keyed.
 */

export interface ActionVerb {
  /** The imperative on the button. One or two words. Never "Approve". */
  verb: string;
  /**
   * Which field of the detail payload holds the thing a person would want to
   * READ before deciding — the message body, the file list, the command.
   *
   * Named rather than guessed, because guessing is how a card ends up showing a
   * request id as if it were the email. Null means this action has no body worth
   * previewing and the card shows its parameters instead.
   */
  bodyKeys: readonly string[] | null;
  /** The field naming who or what is on the receiving end, for the preview head. */
  targetKeys: readonly string[] | null;
  /** How the preview renders the body: as prose, as a path list, or as a command. */
  bodyAs: "prose" | "paths" | "command";
}

const FALLBACK: ActionVerb = {
  verb: "Go ahead",
  bodyKeys: null,
  targetKeys: null,
  bodyAs: "prose",
};

/**
 * The table. Every entry is a verb a person would use about their own work.
 *
 * Where an action has no natural imperative — a capability grant, a settings
 * change — the verb is the closest honest one rather than a coined phrase.
 * "Change the setting" is clumsier than "Apply" and is the right trade: the
 * reader is being asked about a security setting and clumsy is survivable,
 * ambiguous is not.
 */
const VERBS: Record<string, ActionVerb> = {
  // ---- The always-confirm floor. These ask under every mode. ----
  "work.connector.send_message": {
    verb: "Send",
    bodyKeys: ["body", "message", "text", "content"],
    targetKeys: ["to", "recipient", "recipients", "channel", "address"],
    bodyAs: "prose",
  },
  "work.connector.publish": {
    verb: "Post",
    bodyKeys: ["body", "message", "text", "content"],
    targetKeys: ["to", "channel", "destination", "board"],
    bodyAs: "prose",
  },
  "work.connector.delete": {
    verb: "Delete",
    bodyKeys: ["items", "records", "subject"],
    targetKeys: ["connector", "app", "collection"],
    bodyAs: "paths",
  },
  "work.connector.payment": {
    verb: "Pay",
    bodyKeys: ["description", "summary"],
    targetKeys: ["payee", "to", "recipient"],
    bodyAs: "prose",
  },
  "work.file.permanent_delete": {
    verb: "Delete for good",
    bodyKeys: ["paths", "files", "items"],
    targetKeys: null,
    bodyAs: "paths",
  },
  "work.file.empty_trash": {
    verb: "Empty the trash",
    bodyKeys: ["items", "paths"],
    targetKeys: null,
    bodyAs: "paths",
  },
  "work.app.purchase": {
    verb: "Buy",
    bodyKeys: ["description", "item", "summary"],
    targetKeys: ["vendor", "store", "app"],
    bodyAs: "prose",
  },
  "work.browser.purchase": {
    verb: "Buy",
    bodyKeys: ["description", "item", "summary"],
    targetKeys: ["site", "vendor", "url"],
    bodyAs: "prose",
  },
  "work.system.change_security_setting": {
    verb: "Change the setting",
    bodyKeys: ["setting", "description", "summary"],
    targetKeys: ["scope", "device"],
    bodyAs: "prose",
  },
  "work.system.change_account_setting": {
    verb: "Change the setting",
    bodyKeys: ["setting", "description", "summary"],
    targetKeys: ["account", "scope"],
    bodyAs: "prose",
  },

  // ---- The executor's own tool names, as they arrive on an approval. ----
  apply_changes: {
    verb: "Make the changes",
    bodyKeys: ["paths", "files", "changes"],
    targetKeys: null,
    bodyAs: "paths",
  },
  permanently_delete: {
    verb: "Delete for good",
    bodyKeys: ["paths", "files", "items"],
    targetKeys: null,
    bodyAs: "paths",
  },
  run_command: {
    verb: "Run it",
    bodyKeys: ["command", "script", "argv"],
    targetKeys: ["cwd", "directory", "host"],
    bodyAs: "command",
  },
  shell: {
    verb: "Run it",
    bodyKeys: ["command", "script", "argv"],
    targetKeys: ["cwd", "directory", "host"],
    bodyAs: "command",
  },
  browser_control: {
    verb: "Use the browser",
    bodyKeys: ["url", "description", "summary"],
    targetKeys: ["site", "url"],
    bodyAs: "prose",
  },
  app_control: {
    verb: "Use the app",
    bodyKeys: ["description", "summary"],
    targetKeys: ["app"],
    bodyAs: "prose",
  },
  screen_control: {
    verb: "Take the screen",
    bodyKeys: ["description", "summary"],
    targetKeys: ["app", "window"],
    bodyAs: "prose",
  },
  send_email: {
    verb: "Send",
    bodyKeys: ["body", "message", "text"],
    targetKeys: ["to", "recipient", "recipients"],
    bodyAs: "prose",
  },
  create_event: {
    verb: "Create the event",
    bodyKeys: ["description", "summary", "title"],
    targetKeys: ["calendar", "attendees"],
    bodyAs: "prose",
  },
};

export function actionVerb(action: string): ActionVerb {
  return VERBS[action] ?? FALLBACK;
}

/**
 * Whether "and stop asking" can be offered for this action at all.
 *
 * A mirror of the server's `mayBeCoveredByStandingAllowance`, and a mirror on
 * purpose rather than an import: that function is the executor's rule and this
 * is the client deciding whether to draw a control. Importing it would be
 * tidier and would also make a client build that drifted from the server look
 * correct right up to the 409. Both are checked; the server's answer wins, and
 * the card handles `not_standing_allowable` when it comes back.
 */
export function mayStopAsking(action: string, risk: WorkRiskLevel): boolean {
  if ((ALWAYS_CONFIRM_ACTIONS as readonly string[]).includes(action)) return false;
  return risk === "safe" || risk === "edit" || risk === "command";
}

/**
 * Whether this approval may ride a batch "Do all of them" press.
 *
 * The batch control exists because five file edits raised one at a time is a
 * surface that trains people to click without reading. It must never sweep up
 * the one card that was worth stopping for, so anything the floor catches —
 * sensitive, irreversible, or on the always-confirm list — is excluded and has
 * to be answered on its own. That is the same line `mayStopAsking` draws, and
 * for the same reason, but they are separate functions because they answer
 * different questions and a future risk level might move one and not the other.
 */
export function mayBatchApprove(action: string, risk: WorkRiskLevel): boolean {
  if ((ALWAYS_CONFIRM_ACTIONS as readonly string[]).includes(action)) return false;
  return risk === "safe" || risk === "edit";
}

/**
 * The thing the reader should read before deciding, pulled out of the detail
 * bag.
 *
 * Returns null rather than an empty string when there is nothing to show, so
 * the card can fall back to the parameter table instead of rendering an empty
 * quote block that looks like a message with no words in it.
 */
export function previewBody(detail: Payload, verb: ActionVerb): string | null {
  if (verb.bodyKeys === null) return null;
  const direct = str(detail, ...verb.bodyKeys);
  if (direct !== null) return direct;
  // A list of paths or items arrives as an array on the same keys. Joined with
  // newlines so the `paths` renderer can split it back out, rather than each
  // renderer re-reading the payload in its own way.
  for (const key of verb.bodyKeys) {
    const value = detail[key];
    if (Array.isArray(value)) {
      const lines = value.filter((entry): entry is string => typeof entry === "string");
      if (lines.length > 0) return lines.join("\n");
    }
  }
  return null;
}

/** Who or what is on the receiving end, for the line above the preview. */
export function previewTarget(detail: Payload, verb: ActionVerb): string | null {
  if (verb.targetKeys === null) return null;
  const direct = str(detail, ...verb.targetKeys);
  if (direct !== null) return direct;
  for (const key of verb.targetKeys) {
    const value = detail[key];
    if (Array.isArray(value)) {
      const names = value.filter((entry): entry is string => typeof entry === "string");
      if (names.length > 0) return names.join(", ");
    }
  }
  return null;
}
