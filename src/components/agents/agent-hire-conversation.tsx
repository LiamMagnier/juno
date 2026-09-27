"use client";

/**
 * Hiring by conversation (docs/design/AGENTS.md §5.1, talk-first).
 *
 * The primary path is a hire talk: the person describes the teammate they
 * want, Juno drafts it as structured fields, and the face on the right is
 * already arriving as those fields settle. Muse's lesson is the other half of
 * the form's problem: a blank brief is the wrong first screen, and a wizard
 * hides the combination you are about to create. A conversation is both the
 * guidance and the view of the whole.
 *
 * Two paths, one draft:
 *
 *   - Talk. Free text (or a starting-point chip) becomes a draft update and
 *     one short reply. Proposal cards land in the transcript the way approval
 *     cards do: objects you can read and accept, not prose about settings.
 *   - Edit details. The existing four-question form (`AgentHire`), seeded from
 *     the living draft, for anyone who would rather fill fields. It hires the
 *     same way, and never throws away what the talk already settled.
 *
 * Motion stays on the house ladder: conversation rows `motion-safe:animate-rise-in`,
 * the face cross-fades its state on the fast rung, the Hire button presses with
 * `.pressable`. Hire lands in the agent's thread (Agents v2 §4.8.2): the
 * conversation is created with the agent, and `/agents/[id]` is that thread
 * with the side panel open.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import {
  ComposerShell,
  ComposerPrimaryAction,
  composerFieldClass,
} from "@/components/ui/composer-shell";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Check, Pencil, Sparkles } from "@/components/ui/icons";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { AgentFace } from "@/components/agents/agent-face";
import { AgentHire, type AgentHireValues } from "@/components/agents/agent-hire";
import {
  useLinkedConnectors,
  type ConnectorOption,
} from "@/components/agents/agent-profile-fields";
import {
  announceAgentsChanged,
  draftHireAgent,
  hireAgent,
  type HireDraftFields,
  type HireDraftTurn,
} from "@/components/agents/agents-transport";
import {
  AGENT_STYLES,
  AGENT_STYLE_LABEL,
  MAX_AGENT_NAME_CHARS,
  type AgentStyle,
} from "@/lib/agents/domain";
import {
  AGENT_EYES_LABEL,
  AGENT_MARK_LABEL,
  AGENT_SHAPE_LABEL,
  AGENT_TONE_LABEL,
  defaultAgentAvatar,
  type AgentAvatar,
} from "@/lib/agents/avatar";
import {
  EMPTY_HIRE_DRAFT,
  hireDraftFromTemplate,
  hireDraftReply,
  hireTemplateChips,
  parseHireDraft,
  type HireDraftResult,
} from "@/lib/agents/hire-draft";
import { AGENT_TEMPLATES, agentTemplate } from "@/lib/agents/templates";
import {
  WORK_APPROVAL_MODE_LABEL,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Row =
  | { id: string; kind: "juno"; text: string }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "thinking" }
  | { id: string; kind: "draft"; result: HireDraftResult; accepted: boolean };

let rowSeq = 0;
function rowId(prefix: string): string {
  rowSeq += 1;
  return `${prefix}-${rowSeq}`;
}

const OPENING =
  "What should this teammate take on? Describe the job in your own words, or pick a starting point below.";

function asStyle(value: string | null | undefined): AgentStyle | null {
  return value && (AGENT_STYLES as readonly string[]).includes(value) ? (value as AgentStyle) : null;
}

function asApproval(value: string | null | undefined): WorkPermissionPolicy | null {
  const list = ["conservative", "balanced", "permissive"] as const;
  return value && (list as readonly string[]).includes(value) ? (value as WorkPermissionPolicy) : null;
}

function draftToInitial(draft: HireDraftFields): AgentHireValues {
  return {
    templateId: draft.template,
    name: draft.name,
    role: draft.role,
    avatar: draft.avatar,
    style: asStyle(draft.style),
    instructions: draft.instructions,
    approvalMode: asApproval(draft.approvalMode),
    connectorIds: draft.connectorIds,
    firstGoal: draft.firstGoal,
  };
}

/** One line of the compact draft card in the rail and in the transcript. */
function DraftRow({
  label,
  value,
  missing,
  settle,
}: {
  label: string;
  value: string | null;
  missing?: string;
  settle?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 font-mono text-label text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-ui text-foreground",
          settle && "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
        )}
      >
        {value?.trim() || <span className="text-muted-foreground">{missing ?? "Not set"}</span>}
      </dd>
    </div>
  );
}

function DraftSummary({
  draft,
  connectors,
  className,
  settleKeys,
}: {
  draft: HireDraftFields;
  connectors: ConnectorOption[] | null;
  className?: string;
  settleKeys?: readonly string[];
}) {
  const style = asStyle(draft.style);
  const approval = asApproval(draft.approvalMode);
  const faces = draft.avatar;
  const connectorLabels = (draft.connectorIds ?? [])
    .map((id) => connectors?.find((option) => option.id === id)?.label ?? id)
    .join(", ");
  const settle = (key: string) => settleKeys?.includes(key) ?? false;
  return (
    <dl className={cn("divide-y divide-border/60", className)}>
      <DraftRow label="Name" value={draft.name} missing="Pick a name" settle={settle("name")} />
      <DraftRow label="Role" value={draft.role} missing="What it is for" settle={settle("role")} />
      <DraftRow
        label="Face"
        value={
          faces
            ? `${AGENT_SHAPE_LABEL[faces.shape]} · ${AGENT_TONE_LABEL[faces.tone]} · ${AGENT_EYES_LABEL[faces.eyes]}${
                faces.mark === "none" ? "" : ` · ${AGENT_MARK_LABEL[faces.mark]}`
              }`
            : null
        }
        missing="From the starting point"
        settle={settle("avatar")}
      />
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="shrink-0 font-mono text-label text-muted-foreground">Style</dt>
        <dd className="min-w-0 text-right">
          {style ? (
            <span
              className={cn(
                "inline-flex rounded-control border border-border bg-secondary px-2 py-0.5 text-ui text-foreground",
                settle("style") && "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              )}
            >
              {AGENT_STYLE_LABEL[style]}
            </span>
          ) : (
            <span className="text-ui text-muted-foreground">How it talks</span>
          )}
        </dd>
      </div>
      <DraftRow
        label="Autonomy"
        value={approval ? WORK_APPROVAL_MODE_LABEL[approval] : null}
        missing="How much it checks in"
        settle={settle("approvalMode")}
      />
      <DraftRow
        label="Connected apps"
        value={connectorLabels || (draft.connectorIds?.length === 0 ? "None" : null)}
        missing="None linked"
        settle={settle("connectorIds")}
      />
      <DraftRow label="First goal" value={draft.firstGoal} missing="Optional" settle={settle("firstGoal")} />
    </dl>
  );
}

/**
 * The proposal card in the transcript. The draft is already live in the rail;
 * this is the moment in the talk where Juno says "here is the combination" and
 * the person can take it or keep amending in words.
 */
function DraftProposalCard({
  result,
  accepted,
  connectors,
  onAccept,
}: {
  result: HireDraftResult;
  accepted: boolean;
  connectors: ConnectorOption[] | null;
  onAccept: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-card p-4",
        accepted && "border-foreground/25 bg-selected"
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
        <p className="text-ui font-medium text-foreground">
          {accepted ? "Draft accepted" : "Here is the draft"}
        </p>
      </div>
      <DraftSummary draft={result.draft} connectors={connectors} settleKeys={result.changed} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {accepted ? (
          <p className="text-ui text-muted-foreground">Say anything to change it, or press Hire.</p>
        ) : (
          <>
            <Button type="button" size="sm" onClick={onAccept}>
              <Check className="size-4" aria-hidden="true" />
              Keep this
            </Button>
            <p className="text-ui text-muted-foreground">Or say what to change.</p>
          </>
        )}
      </div>
    </div>
  );
}

export function AgentHireConversation({ initialTemplate }: { initialTemplate: string | null }) {
  const router = useRouter();
  const connectors = useLinkedConnectors();
  const [draft, setDraft] = React.useState<HireDraftFields>(() => {
    const template = agentTemplate(initialTemplate);
    if (!template) return { ...EMPTY_HIRE_DRAFT };
    return hireDraftFromTemplate(template).draft;
  });
  const [rows, setRows] = React.useState<Row[]>(() =>
    initialTemplate && agentTemplate(initialTemplate)
      ? [
          { id: rowId("juno"), kind: "juno", text: OPENING },
          {
            id: rowId("draft"),
            kind: "draft",
            accepted: false,
            result: {
              draft: hireDraftFromTemplate(agentTemplate(initialTemplate)!).draft,
              changed: ["name", "role", "style", "avatar", "instructions", "approvalMode", "firstGoal", "template"],
              reply: `Starting from ${agentTemplate(initialTemplate)!.label}. Tell me what to change, or press Hire.`,
            },
          },
        ]
      : [{ id: rowId("juno"), kind: "juno", text: OPENING }]
  );
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [hiring, setHiring] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [faceState, setFaceState] = React.useState<"idle" | "thinking" | "done">("idle");
  const [live, setLive] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const acceptedRef = React.useRef(false);

  const trimmed = input.trim();
  const canHire = Boolean(draft.name?.trim()) && !hiring && !busy;

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [rows.length, busy]);

  React.useEffect(() => {
    if (faceState !== "done") return;
    const timer = window.setTimeout(() => setFaceState("idle"), 1_200);
    return () => window.clearTimeout(timer);
  }, [faceState]);

  const applyResult = (result: HireDraftResult) => {
    setDraft(result.draft);
    setRows((prev) => [
      ...prev.filter((row) => row.kind !== "thinking"),
      { id: rowId("draft"), kind: "draft", result, accepted: false },
      { id: rowId("juno"), kind: "juno", text: result.reply },
    ]);
    acceptedRef.current = false;
    setLive(
      result.changed.length > 0
        ? `Draft updated: ${result.changed.join(", ")}.`
        : "Draft unchanged."
    );
    setFaceState("done");
  };

  const turn = async (
    message: string,
    patch?: HireDraftFields,
    reply?: string,
    changed?: (keyof HireDraftFields)[]
  ) => {
    if (!message.trim() || busy) return;
    setRows((prev) => [
      ...prev,
      { id: rowId("user"), kind: "user", text: message.trim() },
      { id: rowId("thinking"), kind: "thinking" },
    ]);
    setInput("");
    setBusy(true);
    setFaceState("thinking");
    setLive("Juno is drafting a teammate.");

    // A chip is a decision already made: apply the starting point locally and
    // still show a proposal card, so the transcript reads the same either way.
    if (patch && reply) {
      const result: HireDraftResult = {
        draft: patch,
        changed: changed ?? [],
        reply,
      };
      // Give the thinking row one frame so the talk has a beat.
      window.setTimeout(() => {
        setBusy(false);
        applyResult(result);
      }, 280);
      return;
    }

    const history: HireDraftTurn[] = [];
    for (const row of rows) {
      if (row.kind === "user") history.push({ role: "user", content: row.text });
      else if (row.kind === "juno") history.push({ role: "juno", content: row.text });
    }

    const outcome = await draftHireAgent({
      message: message.trim(),
      draft,
      turns: history.slice(-8),
    });
    setBusy(false);
    if (outcome.kind === "ok") {
      applyResult(outcome.value);
      return;
    }
    // The floor is always local parsing: a down model still hears "call her Quill".
    const local = parseHireDraft(message, draft);
    applyResult({
      draft: local.draft,
      changed: local.changed,
      reply: hireDraftReply(local.draft, local.changed),
    });
  };

  const pickTemplate = (id: string) => {
    const template = agentTemplate(id);
    if (!template) return;
    const applied = hireDraftFromTemplate(template, draft);
    void turn(
      template.label,
      applied.draft,
      `Starting from ${template.label}. Tell me what to change, or press Hire.`,
      applied.changed
    );
  };

  const hire = async () => {
    const name = draft.name?.trim();
    if (!name || hiring) return;
    setHiring(true);
    setFaceState("done");
    const avatar: AgentAvatar =
      draft.avatar ??
      agentTemplate(draft.template)?.avatar ??
      defaultAgentAvatar(name);
    const outcome = await hireAgent({
      name: name.slice(0, MAX_AGENT_NAME_CHARS),
      role: (draft.role ?? "").trim(),
      avatar,
      style: asStyle(draft.style) ?? "warm",
      instructions: (draft.instructions ?? "").trim(),
      approvalMode: asApproval(draft.approvalMode) ?? "balanced",
      connectorIds: draft.connectorIds ?? [],
      template: draft.template,
      ...(draft.firstGoal?.trim() ? { firstGoal: draft.firstGoal.trim() } : {}),
    });
    if (outcome.kind !== "ok") {
      setHiring(false);
      setFaceState("idle");
      toast.error(outcome.message);
      return;
    }
    announceAgentsChanged();
    router.push(
      outcome.value.conversationId
        ? `/chat/${encodeURIComponent(outcome.value.conversationId)}`
        : `/agents/${encodeURIComponent(outcome.value.id)}`
    );
  };

  const acceptLatest = () => {
    acceptedRef.current = true;
    setRows((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const row = next[i];
        if (row.kind === "draft") {
          next[i] = { ...row, accepted: true };
          break;
        }
      }
      return next;
    });
    setLive("Draft accepted. Ready to hire.");
  };

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="New agent"
        lede="Describe the teammate you want. Juno drafts the name, role, face and brief as you talk."
        backHref="/agents"
        backLabel="Agents"
      />

      <div className="@container">
        <div className="grid grid-cols-1 gap-8 @[52rem]:grid-cols-[minmax(0,1fr)_18rem]">
          {/* Conversation */}
          <div className="flex min-w-0 flex-col gap-4">
            <div
              ref={listRef}
              className="flex max-h-[min(28rem,60vh)] min-h-16 flex-col gap-4 overflow-y-auto rounded-card border border-border bg-card/40 p-4"
              aria-label="Hire conversation"
            >
              {rows.map((row, index) => {
                if (row.kind === "thinking") {
                  return (
                    <div
                      key={row.id}
                      className="flex items-center gap-2 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                      style={staggerDelay(index, "tight")}
                    >
                      <AgentFace avatar={draft.avatar ?? AGENT_TEMPLATES[0].avatar} size="sm" state="thinking" />
                      <ThinkingDots />
                      <span className="sr-only">Juno is drafting</span>
                    </div>
                  );
                }
                if (row.kind === "user") {
                  return (
                    <div
                      key={row.id}
                      className="flex justify-end motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                      style={staggerDelay(index, "tight")}
                    >
                      <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-md bg-secondary px-4 py-2.5 text-reading">
                        {row.text}
                      </p>
                    </div>
                  );
                }
                if (row.kind === "draft") {
                  return (
                    <div
                      key={row.id}
                      className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                      style={staggerDelay(index, "tight")}
                    >
                      <DraftProposalCard
                        result={row.result}
                        accepted={row.accepted}
                        connectors={connectors}
                        onAccept={acceptLatest}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={row.id}
                    className="flex items-start gap-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                    style={staggerDelay(index, "tight")}
                  >
                    <AgentFace
                      avatar={draft.avatar ?? AGENT_TEMPLATES[0].avatar}
                      size="sm"
                      state={faceState === "thinking" ? "thinking" : "idle"}
                    />
                    <p className="min-w-0 text-reading text-foreground">{row.text}</p>
                  </div>
                );
              })}
            </div>

            {/* Starting points, under the first question until the talk has moved. */}
            {rows.length <= 2 ? (
              <div className="flex flex-wrap gap-1.5">
                {hireTemplateChips().map((chip, index) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => pickTemplate(chip.id)}
                    style={staggerDelay(index, "tight")}
                    className={cn(
                      "rounded-control border border-border bg-card px-2.5 py-1.5 text-left text-ui text-foreground",
                      "transition-colors duration-fast ease-out-soft hover:bg-accent coarse:py-2.5",
                      "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                    )}
                  >
                    <span className="font-medium">{chip.label}</span>
                    <span className="mt-0.5 block text-ui text-muted-foreground">{chip.promise}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmed) void turn(trimmed);
              }}
            >
              <ComposerShell
                field={
                  <textarea
                    ref={fieldRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (trimmed) void turn(trimmed);
                      }
                    }}
                    rows={2}
                    maxLength={2_000}
                    disabled={busy}
                    placeholder="I need someone to… Call her Quill. Warm, and ask before anything risky."
                    className={composerFieldClass}
                    aria-label="Describe the teammate"
                  />
                }
                action={
                  <ComposerPrimaryAction
                    face={busy ? "busy" : "send"}
                    type="submit"
                    disabled={busy || !trimmed}
                    aria-label="Send"
                  />
                }
                dimmed={busy}
              />
            </form>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={hire} loading={hiring} disabled={!canHire}>
                Hire {draft.name?.trim() || "agent"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit details
              </Button>
            </div>

            <p aria-live="polite" className="sr-only">
              {live}
            </p>
          </div>

          {/* Live face and draft */}
          <aside className="order-first @[52rem]:order-none">
            <div className="flex flex-col gap-4 @[52rem]:sticky @[52rem]:top-6">
              <div className="flex flex-col items-center gap-3">
                <div className="grid size-40 place-items-center rounded-panel border border-border bg-card">
                  <AgentFace
                    avatar={draft.avatar ?? AGENT_TEMPLATES[0].avatar}
                    state={faceState}
                    size="lg"
                    name={draft.name?.trim() || "New agent"}
                  />
                </div>
                <div className="text-center">
                  <p className="text-body font-medium text-foreground">{draft.name?.trim() || "New agent"}</p>
                  {draft.role?.trim() ? (
                    <p className="text-ui text-muted-foreground">{draft.role.trim()}</p>
                  ) : (
                    <p className="text-ui text-muted-foreground">Not hired yet</p>
                  )}
                </div>
              </div>

              <div className="rounded-card border border-border bg-card p-3">
                <p className="mb-1 font-mono text-label text-muted-foreground">Draft teammate</p>
                <DraftSummary draft={draft} connectors={connectors} />
              </div>
            </div>
          </aside>
        </div>
      </div>

      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent
          side="right"
          scrim="always"
          title="Edit details"
          className="w-[min(40rem,92vw)] overflow-y-auto p-0"
        >
          <div className="border-b border-border px-6 py-4">
            <p className="text-heading">Edit details</p>
            <p className="mt-1 text-ui text-muted-foreground">
              Every field the talk set, editable. Hire from here when it looks right.
            </p>
          </div>
          <div className="px-6 py-6">
            <AgentHire
              initialTemplate={initialTemplate}
              initial={draftToInitial(draft)}
              embedded
              onHired={() => {
                setEditing(false);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </AppPage>
  );
}
