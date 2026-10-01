"use client";

import * as React from "react";
import { ChevronRight, Clock } from "@/components/ui/icons";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { cn } from "@/lib/utils";
import type {
  ActionApprovalDecision,
  ActionReceiptStatus,
  ActionRiskClass,
  ClientActionApproval,
} from "@/lib/action-approval";

/*
 * The one card in the transcript that is not prose.
 *
 * Everything else here is Juno talking. This is Juno stopping, because a tool
 * call is about to leave the machine and the broker (src/lib/mcp.ts) is blocked
 * on an answer. So the card is built to be read rather than skimmed: heavier
 * frame, warning rule, the exact redacted arguments one disclosure away, and the
 * refusal given the same weight as the allow.
 *
 * Two rules drive most of the code below.
 *
 * First, the answer must carry `receiptDigest` back. The server recomputes the
 * digest over the action, the arguments and the policy that were in force when
 * the request was raised, and refuses any answer whose digest does not match.
 * That is the binding between what this card SHOWED and what the person
 * ANSWERED — which is why the detail block prints the arguments in full rather
 * than summarising them. A card that showed less than the digest covers would be
 * asking someone to sign for something they were not shown.
 *
 * Second, the store answers with a typed code for every refusal. Collapsing
 * those into "something went wrong" would be a lie in the one place in the
 * product where the user most needs the truth: "your permissions changed",
 * "this expired", and "this answer is for a different action" have three
 * different next steps, and only one of them is "try again".
 */

const RISK_COPY: Record<ActionRiskClass, { label: string; detail: string }> = {
  read_only: {
    label: "Reads only",
    detail: "This reads. Nothing outside Juno changes.",
  },
  reversible_write: {
    label: "Reversible change",
    detail: "This changes something that can be put back, like a label, a folder or a draft.",
  },
  external_write: {
    label: "Leaves Juno",
    detail: "This sends something to another service. Once it lands there, Juno cannot take it back.",
  },
  destructive_or_sensitive: {
    label: "Cannot be undone",
    detail: "This deletes, pays for, or touches something private. Nothing here can undo it afterwards.",
  },
  // Not a hedge, a verdict. `classifyExternalAction` returns unknown when a
  // connector's own claim and its tool name disagree, or when there is not
  // enough evidence either way — and the policy floor for it is an external
  // write. Saying "unknown" alone would read as harmless; it is the opposite.
  unknown: {
    label: "Unverified",
    detail:
      "Juno could not verify that this only reads, so it is treated as a change that leaves Juno. Read the arguments below before you answer.",
  },
};

/**
 * What the card says once nobody can answer it any more.
 *
 * The receipt outlives the question, so a card scrolled back to an hour later
 * has to say what became of it rather than showing two dead buttons.
 */
const STATUS_COPY: Record<ActionReceiptStatus, string> = {
  pending: "Waiting for your answer.",
  allowed: "Allowed. Juno is carrying this out.",
  denied: "Denied. Juno did not carry this out.",
  executing: "Juno is carrying this out now.",
  executed: "Juno carried this out.",
  failed: "Juno tried this and it failed.",
  expired: "This expired before it was answered. Nothing was sent.",
  superseded:
    "The arguments or your permissions changed after this was raised, so Juno cancelled it and will ask again.",
  blocked: "Your permissions blocked this, so Juno never sent it.",
};

const DECISION_COPY: Record<ActionApprovalDecision, string> = {
  allow_once: "Allowed once. Juno is carrying out the action now.",
  allow_scope: "Allowed. Juno will not ask again before this action on this connector.",
  deny: "Denied. Juno will not carry out the action.",
};

/*
 * The same card, when the question is whether to start a background task.
 *
 * The chat model's `start_task` (src/lib/chat/task-tool.ts) asks through the
 * ordinary broker when the estimate is high or the turn carries outside
 * content, and the connector copy above would misdescribe it: nothing "leaves
 * Juno", and "the arguments" are a brief. So a task gets its own words, its
 * title as the headline, the estimate, and the brief in prose rather than as a
 * key/value dump. What is bound and answered is unchanged: the same receipt,
 * the same digest, the same decision endpoint.
 *
 * Recognised by connector id and tool name together, the test
 * `isTaskApproval` makes. Repeated here rather than imported because
 * task-tool.ts reaches the server through dynamic imports that must stay out of
 * the client bundle; tests/chat-task-tool.test.ts pins the two literals.
 */
function isTaskHandoff(approval: Pick<ClientActionApproval, "connectorId" | "toolName">): boolean {
  return approval.connectorId === "juno_work" && approval.toolName === "start_task";
}

const TASK_CARD_COPY = {
  description:
    "Juno works on this on its own and reports back in this chat. It asks before risky steps, and you can stop it at any time.",
  untrusted:
    "This chat includes content Juno read from outside it, such as a web page, a file or a connected app. Check that the brief below is what you asked for before you start it.",
  footnote: "Unanswered, this expires and the task does not start.",
};

const TASK_STATUS_COPY: Record<ActionReceiptStatus, string> = {
  pending: "Waiting for your answer.",
  allowed: "Allowed. Starting the task.",
  denied: "Not started.",
  executing: "Starting the task.",
  executed: "Started. The task reports back in this chat.",
  failed: "The task could not be started.",
  expired: "This expired before it was answered, so the task did not start.",
  superseded: "This was cancelled before it was answered, so the task did not start.",
  blocked: "Your permissions blocked this, so the task did not start.",
};

const TASK_DECISION_COPY: Record<ActionApprovalDecision, string> = {
  allow_once: "Starting the task.",
  allow_scope: "Starting the task.",
  deny: "Not started.",
};

/*
 * The task card again, when one agent hands work to another
 * (src/lib/chat/handoff-tool.ts). The same layout, because what is being
 * approved is the same thing, a task with a title, an estimate and a brief. What
 * changes is whose task it is: it runs as the teammate named on the card, in
 * their thread, so the copy says so and says where the result will appear.
 * Recognised on the same two literals as a task, for the same reason, and
 * pinned by tests/chat-handoff-tool.test.ts.
 */
function isAgentHandoff(approval: Pick<ClientActionApproval, "connectorId" | "toolName">): boolean {
  return approval.connectorId === "juno_work" && approval.toolName === "hand_off_to_teammate";
}

function isAgentConfig(approval: Pick<ClientActionApproval, "connectorId">): boolean {
  return approval.connectorId === "juno_agents";
}

interface AgentConfigPreview {
  headline: string | null;
  changes: Array<{ label: string; from?: string; to: string }>;
}

function readAgentConfigPreview(detail: Record<string, unknown>): AgentConfigPreview {
  const raw = detail.preview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { headline: null, changes: [] };
  }
  const obj = raw as Record<string, unknown>;
  const headline = typeof obj.headline === "string" && obj.headline.trim() ? obj.headline.trim() : null;
  const rawChanges = Array.isArray(obj.changes) ? obj.changes : [];
  const changes = rawChanges.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || typeof item.to !== "string") return [];
    return [
      {
        label: item.label,
        ...(typeof item.from === "string" && item.from.trim() ? { from: item.from.trim() } : {}),
        to: item.to,
      },
    ];
  });
  return { headline, changes };
}

const AGENT_CONFIG_STATUS_COPY: Record<ActionReceiptStatus, string> = {
  pending: "Waiting for your answer.",
  allowed: "Allowed. Updating agent setup.",
  denied: "Denied. Nothing was changed.",
  executing: "Updating agent setup.",
  executed: "Updated.",
  failed: "Could not update the agent setup.",
  expired: "This expired before it was answered, so nothing was changed.",
  superseded: "This was cancelled before it was answered, so nothing was changed.",
  blocked: "Your permissions blocked this, so nothing was changed.",
};

const AGENT_CONFIG_DECISION_COPY: Record<ActionApprovalDecision, string> = {
  allow_once: "Updating agent setup.",
  allow_scope: "Updating agent setup.",
  deny: "Denied. Nothing was changed.",
};

const HANDOFF_CARD_COPY = {
  description:
    "It becomes their task, in their own thread, with their apps and autonomy. They report back there, not in this chat, and you can stop it at any time.",
  untrusted:
    "This chat includes content Juno read from outside it, such as a web page, a file or a connected app. Check that the brief below is what you asked for before you hand it off.",
  footnote: "Unanswered, this expires and nothing is handed off.",
};

const HANDOFF_STATUS_COPY: Record<ActionReceiptStatus, string> = {
  pending: "Waiting for your answer.",
  allowed: "Allowed. Handing it off.",
  denied: "Not handed off.",
  executing: "Handing it off.",
  executed: "Handed off. It reports back in their thread.",
  failed: "It could not be handed off.",
  expired: "This expired before it was answered, so nothing was handed off.",
  superseded: "This was cancelled before it was answered, so nothing was handed off.",
  blocked: "Your permissions blocked this, so nothing was handed off.",
};

const HANDOFF_DECISION_COPY: Record<ActionApprovalDecision, string> = {
  allow_once: "Handing it off.",
  allow_scope: "Handing it off.",
  deny: "Not handed off.",
};

/** A string field of the receipt's redacted detail, or null. */
function detailText(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/*
 * Sentences that get appended to another sentence.
 *
 * They are separate entries rather than interpolated into a template, because
 * the i18n extractor reads static literals and never a template with a
 * substitution in it — copy written inline in a `${}` string simply never
 * reaches the catalog and stays English forever.
 */
const REPLAY_COPY = { message: "It had already been answered this way." };
const UNRECOGNISED_REFUSAL_COPY = {
  message: "Juno could not record your answer, and the server did not say why. Nothing was sent.",
};

type RefusalCode =
  | "not_found"
  | "digest_mismatch"
  | "policy_changed"
  | "expired"
  | "already_decided"
  | "not_scope_allowable"
  | "blocked"
  | "unauthorized"
  | "unreachable";

/**
 * One sentence per refusal the decision endpoint can return, plus the two the
 * browser itself can produce.
 *
 * Written here rather than shown from the response body so the copy is static
 * text the i18n extractor can see. The server's own message is only used when it
 * reports a code this build does not know about, where a stale sentence of ours
 * would be worse than its.
 */
const REFUSAL_COPY: Record<RefusalCode, { message: string; terminal: boolean }> = {
  not_found: {
    message: "Juno can no longer find this request, so there is nothing left to answer. Nothing was sent.",
    terminal: true,
  },
  digest_mismatch: {
    message:
      "This answer does not match the action you were shown, so Juno refused it. Nothing was sent. If Juno still needs this, it will ask again with the real arguments.",
    terminal: true,
  },
  policy_changed: {
    message:
      "Your permissions changed after this request was raised, so your answer no longer applies to it. Nothing was sent, and Juno will ask again.",
    terminal: true,
  },
  expired: {
    message: "This request expired before it was answered. Nothing was sent.",
    terminal: true,
  },
  already_decided: {
    message: "This was already answered, possibly on another device. Nothing changed here.",
    terminal: true,
  },
  // The only refusal that leaves the question open: the standing permission was
  // refused, the action itself still needs an answer. Allow once and Deny stay
  // live, and the button that caused this disappears.
  not_scope_allowable: {
    message: "Juno only remembers approval for actions it can undo. Allow this once, or deny it.",
    terminal: false,
  },
  blocked: {
    message: "This connector is blocked by your current permissions, so Juno refused the action itself. Nothing was sent.",
    terminal: true,
  },
  unauthorized: {
    message: "You are signed out, so Juno could not record your answer. Sign in and answer again.",
    terminal: true,
  },
  unreachable: {
    message: "Juno could not reach the server to record your answer. The request is still waiting, so try again.",
    terminal: false,
  },
};

function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && value in REFUSAL_COPY;
}

interface DecisionResponseBody {
  ok?: boolean;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  replay?: unknown;
  approval?: unknown;
}

/** A serialized approval is recognised by the two fields the card cannot work without. */
function asApproval(value: unknown): ClientActionApproval | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ClientActionApproval>;
  return typeof candidate.id === "string" && typeof candidate.receiptDigest === "string"
    ? (value as ClientActionApproval)
    : null;
}

/**
 * The live countdown, and only while the request can still be answered.
 *
 * `null` until the first tick, which happens in an effect rather than in
 * `useState`: a clock read during render makes the server's HTML and the first
 * client render disagree, and this component is server-rendered inside the
 * transcript. Until that first tick the card never calls anything expired —
 * the safe direction, since the server re-checks expiry on every decision, so
 * the worst case is one honest refusal instead of an action taken on a stale
 * approval.
 */
function useCountdown(expiresAt: string, active: boolean): number | null {
  const [remaining, setRemaining] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!active) {
      setRemaining(null);
      return;
    }
    const target = Date.parse(expiresAt);
    // An unparseable deadline is not a deadline. Showing "NaN left" or, worse,
    // treating the request as already expired would take an answerable action
    // away from the user over a formatting bug.
    if (Number.isNaN(target)) return;

    const tick = () => setRemaining(Math.max(0, target - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, active]);

  return remaining;
}

function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Values are printed, never described. Strings go through as they are so
 * trailing spaces and full URLs stay visible; everything else is indented JSON,
 * because a nested object flattened to "[object Object]" is exactly the kind of
 * hiding this block exists to prevent.
 */
function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

type Outcome =
  | { kind: "idle" }
  | { kind: "sending"; decision: ActionApprovalDecision }
  | { kind: "done"; message: string }
  | { kind: "refused"; code: RefusalCode | null; message: string; terminal: boolean };

/** Named verbs come from the tool identifier, never its untrusted arguments. */
function approvalVerb(toolName: string): string {
  const words = toolName.split("__").at(-1)?.replace(/_/g, " ").trim() ?? "";
  const verbs = /(?:^|\s)(send|post|publish|delete|remove|create|update|change|add|move|archive|read|search|write|pay|transfer)\s+(.+)/i.exec(words);
  return verbs ? `${verbs[1][0].toUpperCase()}${verbs[1].slice(1)} ${verbs[2]}` : "Allow this action";
}

export function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: ClientActionApproval;
  onDecided?: (approval: ClientActionApproval) => void;
}) {
  const labelId = React.useId();
  const detailId = React.useId();
  const visibleAt = React.useRef(0);
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    visibleAt.current = Date.now(); setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [approval.id, approval.receiptDigest]);
  // Presentation only: whether the argument list is unfolded. It used to be a
  // native <details>, whose open state the browser kept and which gives no
  // height to animate, so the list cut in and out under its caret.
  //
  // Open from the start for a task raised by a turn that read outside content:
  // the warning asks the reader to check the brief, and the brief is the whole
  // of what they are approving, so it should not take a second press to see.
  const [detailOpen, setDetailOpen] = React.useState(
    () =>
      (isTaskHandoff(approval) || isAgentHandoff(approval)) &&
      approval.derivedFromUntrusted &&
      approval.status === "pending"
  );
  // The server's answer replaces the streamed one once there is one, so the
  // status line and the pills reflect the receipt rather than what the chunk
  // said several seconds ago.
  const [decided, setDecided] = React.useState<ClientActionApproval | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome>({ kind: "idle" });
  const current = decided ?? approval;

  const settled = outcome.kind === "done" || (outcome.kind === "refused" && outcome.terminal);
  const sending = outcome.kind === "sending";
  const remaining = useCountdown(current.expiresAt, current.status === "pending" && !settled);
  const expired = current.status === "expired" || remaining === 0;
  const answerable = current.status === "pending" && !expired && !settled;
  // A rejected standing permission must not leave a button on screen that will
  // be rejected again for the same reason.
  const canAllowScope =
    current.canAllowScope && !(outcome.kind === "refused" && outcome.code === "not_scope_allowable");

  const risk = RISK_COPY[current.riskClass] ?? RISK_COPY.unknown;
  const detailRows = Object.entries(current.detail);
  // A task handoff reads its headline, estimate and brief out of the same
  // redacted detail the connector variant lists, so both show what was bound.
  // A handoff to a teammate is a task too, with the teammate added.
  const handoff = isAgentHandoff(current);
  const task = handoff || isTaskHandoff(current);
  const agentConfig = isAgentConfig(current);
  const agentConfigPreview = agentConfig ? readAgentConfigPreview(current.detail) : null;
  const taskTitle = task ? detailText(current.detail, "title") : null;
  const taskEstimate = task ? detailText(current.detail, "estimate") : null;
  const taskBrief = task ? detailText(current.detail, "goal") : null;
  const teammate = handoff ? detailText(current.detail, "teammate") : null;
  const taskCopy = handoff ? HANDOFF_CARD_COPY : TASK_CARD_COPY;
  const statusCopy = handoff
    ? HANDOFF_STATUS_COPY
    : task
      ? TASK_STATUS_COPY
      : agentConfig
        ? AGENT_CONFIG_STATUS_COPY
        : STATUS_COPY;
  const decisionCopy = handoff
    ? HANDOFF_DECISION_COPY
    : task
      ? TASK_DECISION_COPY
      : agentConfig
        ? AGENT_CONFIG_DECISION_COPY
        : DECISION_COPY;

  const decide = React.useCallback(
    async (decision: ActionApprovalDecision) => {
      if (Date.now() - visibleAt.current < 500) return;
      setOutcome({ kind: "sending", decision });
      let response: Response;
      try {
        response = await fetch(`/api/approvals/${encodeURIComponent(current.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The digest is what binds this answer to the action that was
          // rendered above. Sending the decision without it is not a lighter
          // request, it is an unanswerable one.
          body: JSON.stringify({ decision, receiptDigest: current.receiptDigest }),
        });
      } catch {
        setOutcome({ kind: "refused", code: "unreachable", ...REFUSAL_COPY.unreachable });
        return;
      }

      const body = (await response.json().catch(() => null)) as DecisionResponseBody | null;

      if (response.ok && body?.ok !== false) {
        const updated = asApproval(body?.approval);
        if (updated) setDecided(updated);
        setOutcome({
          kind: "done",
          message:
            body?.replay === true
              ? `${decisionCopy[decision]} ${REPLAY_COPY.message}`
              : decisionCopy[decision],
        });
        if (updated) onDecided?.(updated);
        return;
      }

      // The store names its own refusals; the route may pass that name through
      // as `code` or as `error`, and 401 is the one refusal it never reaches the
      // store to produce.
      const named = body?.code ?? body?.error;
      const reported: RefusalCode | null = isRefusalCode(named)
        ? named
        : response.status === 401
          ? "unauthorized"
          : null;
      if (reported) {
        setOutcome({ kind: "refused", code: reported, ...REFUSAL_COPY[reported] });
        return;
      }

      // A refusal this build has no name for. The server's own sentence is
      // preferred over ours because it is the only party that knows what
      // happened; failing that, the HTTP status is carried through verbatim.
      // Either is more use than a shrug, and neither invents a cause.
      //
      // `error` is read FIRST because that is the field the route actually
      // sends (`{ error: result.message, code: result.code }`). Reading only
      // `message` meant this branch could never show the server's sentence and
      // always fell through to the bare status code — the one case where the
      // card has nothing else to say is exactly the case it was dropping.
      const serverSentence = [body?.error, body?.message].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      );
      setOutcome({
        kind: "refused",
        code: null,
        message: serverSentence ?? `${UNRECOGNISED_REFUSAL_COPY.message} (${response.status})`,
        terminal: false,
      });
    },
    [current.id, current.receiptDigest, decisionCopy, onDecided]
  );

  // Named `resultText`, not `resultMessage`: the i18n extractor treats any
  // variable ending in Message/Note/Label as a copy variable and harvests every
  // string literal inside it, which here would put the state-machine tags
  // ("done", "refused") into the translation catalog as if they were copy.
  const resultText =
    outcome.kind === "done" || outcome.kind === "refused"
      ? outcome.message
      : expired && current.status === "pending"
        ? statusCopy.expired
        : !answerable && current.status !== "pending"
          ? statusCopy[current.status]
          : "";
  // Hoisted for the same reason: an `outcome.kind === "idle"` guard written
  // inline as a JSX child is read by the extractor as UI text.
  const untouched = outcome.kind === "idle";

  return (
    <section
      // A group, not a landmark: a transcript can hold several of these, and one
      // named region per approval turns the landmark list into noise.
      role="group"
      aria-labelledby={labelId}
      aria-busy={sending || undefined}
      className={cn(
        // `@container`: the argument rows below lay out by the card's own width —
        // it sits in a transcript that can be 412px wide beside a canvas at any
        // window width, and `sm:` was asking the window.
        "@container my-5 w-full rounded-card border px-4 py-4",
        answerable
          ? // This is holding a generation open. It has to out-shout the prose
            // it sits between, or it gets scrolled past and the model just
            // appears to hang.
            // The dark tint is separate. 7% of --warning over a #000 ground is
            // ~4% lightness — BELOW --card — so on dark the card that has to
            // out-shout the prose was dimmer than an ordinary one. 7% is still
            // right over light paper. No shadow: it sits in the reading column,
            // where an edge is a hairline (FLAT_UI §2), and the warning rule and
            // ring already carry the weight a `shadow-pop` never added.
            "border-warning/60 bg-warning/[0.07] ring-1 ring-warning/20 dark:bg-warning/[0.14]"
          : // `bg-card`, not `bg-card/50`: half of a 6.5% fill over black is
            // ~3.3%, so a settled approval was a border around the page.
            "border-border/60 bg-card",
        "motion-safe:animate-rise-in motion-reduce:animate-fade-in [animation-fill-mode:backwards]"
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {handoff || agentConfig ? (
          <AppIcons.agents
            className={cn("size-4 shrink-0", answerable ? "text-warning" : "text-muted-foreground")}
            aria-hidden="true"
          />
        ) : task ? (
          <AppIcons.work
            className={cn("size-4 shrink-0", answerable ? "text-warning" : "text-muted-foreground")}
            aria-hidden="true"
          />
        ) : (
          <StatusIcons.security
            className={cn("size-4 shrink-0", answerable ? "text-warning" : "text-muted-foreground")}
            aria-hidden="true"
          />
        )}
        <p id={labelId} className={cn("text-caption font-semibold", answerable ? "text-warning-foreground" : "text-muted-foreground")}>
          {handoff
            ? answerable
              ? "Hand this to a teammate?"
              : "Handoff to a teammate"
            : task
              ? answerable
                ? "Start a background task?"
                : "Background task"
              : agentConfig
                ? answerable
                  ? "Allow this agent setup change?"
                  : "Agent setup change"
                : answerable
                  ? "Juno needs your approval"
                  : "Approval request"}
        </p>
        {!task && !agentConfig && <span className="text-caption text-muted-foreground">{risk.label}</span>}
        {answerable && remaining !== null && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-micro text-muted-foreground">
            <Clock className="size-3" aria-hidden="true" />
            <span aria-hidden="true">Expires in {formatCountdown(remaining)}</span>
            <span className="sr-only">
              Answer this request before {new Date(current.expiresAt).toLocaleTimeString()}
            </span>
          </span>
        )}
      </header>

      <p className={cn("mt-2 leading-relaxed text-foreground", answerable ? "text-body font-medium" : "text-ui")}>
        {task && taskTitle
          ? taskTitle
          : agentConfig && agentConfigPreview?.headline
            ? agentConfigPreview.headline
            : current.preview}
      </p>
      {task ? (
        <>
          {teammate && (
            <p className="mt-1 text-label text-muted-foreground">
              To <span className="text-foreground">{teammate}</span>
            </p>
          )}
          {taskEstimate && (
            <p className="mt-1 text-label tabular-nums text-muted-foreground">
              Estimated cost <span className="text-foreground">{taskEstimate}</span>
            </p>
          )}
        </>
      ) : agentConfig && agentConfigPreview && agentConfigPreview.changes.length > 0 ? (
        <dl className="mt-2.5 divide-y divide-border/50 rounded-field border border-border/50 bg-secondary px-3 py-2">
          {agentConfigPreview.changes.map((item, idx) => (
            <div key={`${item.label}-${idx}`} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-label">
              <dt className="font-medium text-muted-foreground">{item.label}</dt>
              <dd className="text-right text-foreground">
                {item.from ? (
                  <>
                    <span className="text-muted-foreground">{item.from}</span>
                    <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
                      →
                    </span>
                    <span className="font-medium text-foreground">{item.to}</span>
                  </>
                ) : (
                  <span className="font-medium text-foreground">{item.to}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 font-mono text-micro text-muted-foreground">
          {current.connectorLabel} · {current.toolName}
        </p>
      )}
      {(!task || answerable) && !agentConfig && (
        <p className="mt-2 text-ui leading-relaxed text-muted-foreground">
          {task ? taskCopy.description : risk.detail}
        </p>
      )}

      {current.derivedFromUntrusted && (
        <div className="mt-2.5 flex gap-2 rounded-field border border-warning/40 bg-warning/10 px-3 py-2.5">
          <StatusIcons.security className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          {task ? (
            <p className="text-label leading-relaxed text-warning-foreground">{taskCopy.untrusted}</p>
          ) : (
            <p className="text-label leading-relaxed text-warning-foreground">
              The model wrote these arguments from content it read: a web page, a file, or output from
              another connector. That content can contain text written to steer what gets sent. Check the
              values below are what you meant before you allow it.
            </p>
          )}
        </div>
      )}

      {!agentConfig && (
        <div className="mt-2.5 rounded-field border border-border/50 bg-secondary">
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            aria-expanded={detailOpen}
            aria-controls={detailOpen ? detailId : undefined}
            className={cn(
              "flex min-h-11 w-full items-center gap-1.5 rounded-field px-3 text-left text-label font-medium text-foreground",
              "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
            )}
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
                detailOpen && "rotate-90"
              )}
              aria-hidden="true"
            />
            {handoff ? "What they will be told" : task ? "What the task will be told" : "Exactly what will be sent"}
          </button>
          <Collapse open={detailOpen}>
            <div id={detailId} className="border-t border-border/50 px-3 py-2.5">
              {task && taskBrief ? (
                <p className="whitespace-pre-wrap break-words text-label leading-relaxed text-foreground">
                  {taskBrief}
                </p>
              ) : detailRows.length === 0 ? (
                <p className="text-label leading-relaxed text-muted-foreground">
                  This call sends no arguments.
                </p>
              ) : (
                <dl className="space-y-1.5">
                  {detailRows.map(([key, value]) => (
                    <div key={key} className="flex flex-col gap-0.5 @[24rem]:flex-row @[24rem]:gap-2">
                      <dt className="shrink-0 font-mono text-micro text-muted-foreground @[24rem]:w-28">{key}</dt>
                      <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-foreground">
                        {formatDetailValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </Collapse>
        </div>
      )}

      {answerable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button disabled={sending || !armed} onClick={() => decide("allow_once")} className="h-11 px-4">
            {handoff ? "Hand off" : task ? "Start task" : agentConfig ? "Apply setup change" : approvalVerb(current.toolName)}
          </Button>
          <Button variant="ghost" disabled={sending || !armed} onClick={() => decide("deny")} className="h-11 px-4">Deny</Button>
          {canAllowScope && !agentConfig && (
            <details className="relative">
              <summary className="flex h-11 cursor-pointer items-center rounded-control px-3 text-ui text-muted-foreground hover:bg-accent" aria-label="More approval choices">More choices</summary>
              <div className="surface-float absolute left-0 top-full z-popper mt-1 rounded-menu p-1">
                <Button variant="ghost" disabled={sending || !armed} onClick={() => decide("allow_scope")}>Always allow this action</Button>
              </div>
            </details>
          )}
          <Button variant="ghost" className="basis-full justify-start px-0 text-muted-foreground" onClick={() => {
            window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: "Instead of this action, " }));
            document.getElementById("juno-composer-textarea")?.focus();
          }}>Tell Juno what to do instead</Button>
        </div>
      )}

      {/* Always mounted: a region inserted at the same moment its text appears
          is frequently not announced at all. */}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-start gap-1.5 text-label leading-relaxed",
          resultText ? "mt-2.5" : "sr-only",
          outcome.kind === "refused" ? "text-warning-foreground" : "text-muted-foreground"
        )}
      >
        {resultText}
      </p>

      {answerable && !sending && untouched && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
          <Clock className="size-3" aria-hidden="true" />
          {task ? taskCopy.footnote : "Unanswered, this expires and Juno stops rather than acting on it."}
        </p>
      )}
    </section>
  );
}

export default ApprovalCard;
