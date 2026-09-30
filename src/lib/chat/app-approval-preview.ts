/**
 * "Posting to Slack will ask you first" — said before send, from the rule
 * that will actually apply.
 *
 * An app token (and an app row in the mention palette) carries this preview
 * so the composer can tell a person, before they send, which of the things
 * they are asking for will stop for an approval card. It is computed by
 * running the broker's own decision function (`decideActionPolicy`) over one
 * representative action of each risk class, with the account's policy,
 * Lockdown, block list and standing grants — the inputs `authorizeExternalAction`
 * reads at call time. There is no second table of rules to drift from the first.
 *
 * What it cannot know is which class a particular tool call lands in: that is
 * decided per call, from the tool's name and arguments, deny-first. So the
 * preview speaks in classes ("sending or posting", "changes you can undo"),
 * never in tools.
 *
 * THE FLOOR. Sending, posting, publishing, deleting, paying and changing
 * permissions or credentials ask under every policy short of a block
 * (src/lib/action-approval.ts, src/lib/work/domain.ts ALWAYS_CONFIRM_ACTIONS).
 * The preview's type has no "allow" for them, and `appApprovalPreview`
 * refuses to produce one: a policy change that ever made the broker allow a
 * send would fail here, loudly, rather than tell a person "this won't ask".
 *
 * Pure (no Prisma). Imports action-approval, which uses node:crypto, so it is
 * server-only in practice; the preview's shape lives in context-tokens.ts for
 * clients.
 */
import {
  ACTION_PERMISSION_POLICIES,
  DEFAULT_ACTION_PERMISSION_POLICY,
  decideActionPolicy,
  type ActionPermissionPolicy,
} from "@/lib/action-approval";
import type { AppApprovalPreview, ApprovalVerdict } from "@/lib/chat/context-tokens";

/** The stored setting as a policy, defaulting exactly as the broker does. */
export function actionPolicyFromSetting(value: string | null | undefined): ActionPermissionPolicy {
  return value && (ACTION_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as ActionPermissionPolicy)
    : DEFAULT_ACTION_PERMISSION_POLICY;
}

export interface AppApprovalPreviewInput {
  /** The app's name as the person knows it ("Slack"). */
  label: string;
  policy: ActionPermissionPolicy;
  lockdown: boolean;
  /** In Settings' block list. */
  blocked: boolean;
  /**
   * The person has told Juno not to ask again about at least one of this
   * app's actions (an unrevoked `ActionApprovalGrant`). The broker lets that
   * action through without a card under `allow_selected_low_risk`, so the
   * preview must not say every change will ask. Grants are per action and per
   * scope (the account, or one project); the preview is per app and does not
   * know the chat's project, so any grant counts — the error it can make is
   * "might not ask" about a change that will, never the reverse.
   */
  standingGrants?: boolean;
}

export class ApprovalFloorViolation extends Error {
  constructor(policy: ActionPermissionPolicy) {
    super(`The "${policy}" policy would allow a send or a delete without asking; the always-confirm floor forbids it.`);
    this.name = "ApprovalFloorViolation";
  }
}

function verdict(input: AppApprovalPreviewInput, riskClass: Parameters<typeof decideActionPolicy>[0]["riskClass"]): ApprovalVerdict {
  return decideActionPolicy({
    policy: input.policy,
    riskClass,
    lockdown: input.lockdown,
    connectorBlocked: input.blocked,
    // The broker asks the same question per call (findStandingGrant), and a
    // grant only ever covers a reversible change (mayCreateStandingApproval):
    // passing it for every class is what proves a grant cannot lift a send.
    hasStandingApproval: !!input.standingGrants,
  });
}

function floored(input: AppApprovalPreviewInput, value: ApprovalVerdict): "ask" | "block" {
  if (value === "allow") throw new ApprovalFloorViolation(input.policy);
  return value;
}

function oneLine(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 59).trimEnd()}…` : clean || "this app";
}

export function appApprovalPreview(input: AppApprovalPreviewInput): AppApprovalPreview {
  const reads = verdict(input, "read_only");
  const changes = verdict(input, "reversible_write");
  const sends = floored(input, verdict(input, "external_write"));
  const deletes = floored(input, verdict(input, "destructive_or_sensitive"));
  const unknown = floored(input, verdict(input, "unknown"));
  // An action Juno cannot classify is treated as a send. If that ever stopped
  // asking, the preview would be describing a different broker.
  if (unknown !== sends) throw new ApprovalFloorViolation(input.policy);

  const label = oneLine(input.label);
  let summary: string;
  if (input.lockdown) {
    summary = `Lockdown is on, so Juno won't use ${label}.`;
  } else if (input.blocked) {
    summary = `${label} is turned off in Settings, so Juno won't use it.`;
  } else if (reads === "block") {
    summary = `Your approval settings stop Juno acting in apps, so it won't use ${label}.`;
  } else if (reads === "ask") {
    summary = `Juno will ask you before anything it does in ${label}, even reading.`;
  } else if (changes === "ask") {
    summary = `Sending, posting or changing anything in ${label} will ask you first.`;
  } else if (verdict({ ...input, standingGrants: false }, "reversible_write") === "ask") {
    // Allowed only through a grant: the other changes still ask.
    summary = `Sending, posting or deleting in ${label} will ask you first, and so will changes, except the ones you've told Juno not to ask about again.`;
  } else {
    summary = `Sending, posting or deleting in ${label} will ask you first. Changes you can undo won't.`;
  }
  return { reads, changes, sends, deletes, summary };
}
