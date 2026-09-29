"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronDown, Download, Plus, Trash2 } from "@/components/ui/icons";
import { AgentFace } from "@/components/agents/agent-face";
import {
  AutonomyPicker,
  ConnectorPicker,
  FaceBuilder,
  ModelPicker,
  StylePicker,
  useLinkedConnectors,
} from "@/components/agents/agent-profile-fields";
import {
  AGENT_NOTIFY_LEVELS,
  AGENT_STYLE_LABEL,
  type AgentNotifyLevel,
  type AgentStyle,
} from "@/lib/agents/domain";
import { WORK_APPROVAL_MODE_LABEL, type WorkPermissionPolicy } from "@/lib/work/domain";
import type { ClientAgentDetail } from "@/lib/agents/types";
import { cn } from "@/lib/utils";
import {
  announceAgentsChanged,
  computerAction,
  createNote,
  deleteNote,
  deleteRoutine,
  duplicateAgent,
  retireAgent,
  updateAgent,
  updateNote,
  updateRoutine,
  type AgentPatch,
} from "@/components/agents/agents-transport";

const NOTIFY_LABEL: Record<AgentNotifyLevel, string> = {
  needs_you: "Needs you only",
  results: "Results",
  all: "Everything",
};

const NOTIFY_SUMMARY: Record<AgentNotifyLevel, string> = {
  needs_you: "Only when it asks a question, needs approval, or a task fails.",
  results: "When tasks finish or when it needs you.",
  all: "Finished tasks, questions, and ideas from reflection.",
};

type DetailGroup = "identity" | "work" | "memory";
const DetailGroupContext = React.createContext<DetailGroup>("identity");
const ROW_GROUP: Record<string, DetailGroup> = {
  "Name and role": "identity", Face: "identity", "Style and brief": "identity",
  Autonomy: "work", "Connected apps": "work", Computer: "work", "Model and effort": "work",
  Notifications: "work", "What it knows": "memory", Routines: "memory",
};

function ExpandRow({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const group = React.useContext(DetailGroupContext);
  if (ROW_GROUP[label] !== group) return null;
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors duration-fast ease-out-soft hover:bg-accent/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-3.5 py-3.5">{children}</div>
      ) : null}
    </div>
  );
}

export function AgentPanelSetup({
  detail,
  onChanged,
  initialExpandedRow,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
  initialExpandedRow?: string;
}) {
  const router = useRouter();
  const { agent } = detail;
  const connectors = useLinkedConnectors();
  const [group, setGroup] = React.useState<DetailGroup>(initialExpandedRow === "memory" || initialExpandedRow === "routines" ? "memory" : initialExpandedRow && !["name", "face", "style"].includes(initialExpandedRow) ? "work" : "identity");
  const saving = React.useRef(false);
  const [expanded, setExpanded] = React.useState<string | null>(initialExpandedRow ?? null);
  const [savingRow, setSavingRow] = React.useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = React.useState(false);

  // Local draft states for each row
  const [name, setName] = React.useState(agent.name);
  const [role, setRole] = React.useState(agent.role);
  const [avatar, setAvatar] = React.useState(agent.avatar);
  const [style, setStyle] = React.useState<AgentStyle>(agent.style);
  const [instructions, setInstructions] = React.useState(agent.instructions);
  const [approvalMode, setApprovalMode] = React.useState<WorkPermissionPolicy>(agent.approvalMode);
  const [connectorIds, setConnectorIds] = React.useState<string[]>(agent.connectorIds);
  const [model, setModel] = React.useState<string | null>(agent.model);
  const [reasoningEffort, setReasoningEffort] = React.useState<string | null>(agent.reasoningEffort);
  const [notify, setNotify] = React.useState<AgentNotifyLevel>(agent.notify ?? "results");

  // Memory state
  const [newNoteContent, setNewNoteContent] = React.useState("");
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = React.useState("");

  React.useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setAvatar(agent.avatar);
    setStyle(agent.style);
    setInstructions(agent.instructions);
    setApprovalMode(agent.approvalMode);
    setConnectorIds(agent.connectorIds);
    setModel(agent.model);
    setReasoningEffort(agent.reasoningEffort);
    setNotify(agent.notify ?? "results");
  // A background refresh must not overwrite edits on the same agent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const toggle = (key: string) => setExpanded((prev) => (prev === key ? null : key));

  const savePatch = async (rowKey: string, patch: AgentPatch) => {
    if (saving.current) return;
    saving.current = true;
    setSavingRow(rowKey);
    const outcome = await updateAgent(agent.id, patch);
    setSavingRow(null);
    saving.current = false;
    if (outcome.kind !== "ok") {
      toast.error(outcome.message);
      return;
    }
    toast.success("Saved.");
    setExpanded(null);
    announceAgentsChanged();
    onChanged();
  };

  const handleDuplicate = async () => {
    setSavingRow("duplicate");
    const outcome = await duplicateAgent(agent.id);
    setSavingRow(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.message);
      return;
    }
    toast.success(`Duplicated as ${outcome.value.name}.`);
    announceAgentsChanged();
    const target = outcome.value.conversationId
      ? `/chat/${outcome.value.conversationId}`
      : `/agents/${outcome.value.id}`;
    router.push(target);
  };

  const handleRetire = async () => {
    setSavingRow("retire");
    const outcome = await retireAgent(agent.id);
    setSavingRow(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    toast.success(`Retired ${agent.name}.`);
    announceAgentsChanged();
    router.push("/agents");
  };

  const handleDownloadNotes = () => {
    const md = [
      `# ${agent.name} memory`,
      "",
      ...detail.notes.map((n) => `- ${n.content} _(${n.source})_`),
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-memory.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const compStatus = detail.computer?.status ?? "disabled";

  return (
    <div className="space-y-4">
      <div className="agent-detail-intro">
        <AgentFace avatar={agent.avatar} state={agent.state} size={64} />
        <h2>{agent.name}, in detail.</h2>
        <p>{agent.instructions || "Tell your agent the outcome you want. It saves its brief as you work together."}</p>
        <p>Change any of this by telling {agent.name} in the conversation, or make a specific adjustment here.</p>
      </div>
      <div className="agent-detail-groups" role="group" aria-label="Agent details">
        {(["identity", "work", "memory"] as const).map(value => <button type="button" key={value} aria-pressed={group === value}
          onClick={() => { setGroup(value); setExpanded(null); }}>{value === "identity" ? "Identity" : value === "work" ? "How it works" : "Memory & routines"}</button>)}
      </div>
      <DetailGroupContext.Provider value={group}>

      <div className="overflow-hidden rounded-card border border-border bg-card">
        {/* 1. Name and role */}
        <ExpandRow
          label="Name and role"
          summary={`${agent.name}${agent.role ? ` · ${agent.role}` : ""}`}
          open={expanded === "name"}
          onToggle={() => toggle("name")}
        >
          <div className="space-y-2.5">
            <div>
              <label htmlFor="setup-name" className="mb-1 block font-mono text-label text-muted-foreground">
                Name
              </label>
              <Input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-ui" />
            </div>
            <div>
              <label htmlFor="setup-role" className="mb-1 block font-mono text-label text-muted-foreground">
                Role
              </label>
              <Input id="setup-role" value={role} onChange={(e) => setRole(e.target.value)} className="h-8 text-ui" />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={savingRow === "name"}
                onClick={() => void savePatch("name", { name: name.trim(), role: role.trim() })}
              >
                Save
              </Button>
            </div>
          </div>
        </ExpandRow>

        {/* 2. Face */}
        <ExpandRow
          label="Face"
          summary={
            <span className="inline-flex items-center gap-2">
              <AgentFace avatar={agent.avatar} size="sm" />
              <span>
                {agent.avatar.shape} · {agent.avatar.tone}
              </span>
            </span>
          }
          open={expanded === "face"}
          onToggle={() => toggle("face")}
        >
          <FaceBuilder avatar={avatar} onChange={setAvatar} />
          <div className="flex justify-end">
            <Button size="sm" loading={savingRow === "face"} onClick={() => void savePatch("face", { avatar })}>
              Save
            </Button>
          </div>
        </ExpandRow>

        {/* 3. Style and brief */}
        <ExpandRow
          label="Style and brief"
          summary={`${AGENT_STYLE_LABEL[agent.style]}${
            agent.instructions ? ` · ${agent.instructions.slice(0, 48)}${agent.instructions.length > 48 ? "…" : ""}` : ""
          }`}
          open={expanded === "personality"}
          onToggle={() => toggle("personality")}
        >
          <div className="space-y-3">
            <StylePicker value={style} onChange={setStyle} />
            <div>
              <label htmlFor="setup-brief" className="mb-1 block font-mono text-label text-muted-foreground">
                Brief
              </label>
              <Textarea
                id="setup-brief"
                rows={4}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="text-ui"
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={savingRow === "personality"}
                onClick={() => void savePatch("personality", { style, instructions })}
              >
                Save
              </Button>
            </div>
          </div>
        </ExpandRow>

        {/* 4. Autonomy */}
        <ExpandRow
          label="Autonomy"
          summary={WORK_APPROVAL_MODE_LABEL[agent.approvalMode]}
          open={expanded === "autonomy"}
          onToggle={() => toggle("autonomy")}
        >
          <AutonomyPicker value={approvalMode} onChange={setApprovalMode} />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={savingRow === "autonomy"}
              onClick={() => void savePatch("autonomy", { approvalMode })}
            >
              Save
            </Button>
          </div>
        </ExpandRow>

        {/* 5. Connected apps */}
        <ExpandRow
          label="Connected apps"
          summary={agent.connectorIds.length > 0 ? agent.connectorIds.join(", ") : "None"}
          open={expanded === "apps"}
          onToggle={() => toggle("apps")}
        >
          <ConnectorPicker options={connectors} value={connectorIds} onChange={setConnectorIds} />
          <div className="flex justify-end">
            <Button size="sm" loading={savingRow === "apps"} onClick={() => void savePatch("apps", { connectorIds })}>
              Save
            </Button>
          </div>
        </ExpandRow>

        {/* 6. Computer */}
        {detail.computerConfigured ? (
          <ExpandRow
            label="Computer"
            summary={compStatus === "disabled" ? "Off" : compStatus}
            open={expanded === "computer"}
            onToggle={() => toggle("computer")}
          >
            <div className="space-y-2.5">
              <p className="text-caption text-muted-foreground">
                Asleep more than 30 days: its sign-ins and files are cleared.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {compStatus === "disabled" ? (
                  <Button
                    size="sm"
                    loading={savingRow === "computer"}
                    onClick={async () => {
                      setSavingRow("computer");
                      const res = await computerAction(agent.id, "enable");
                      setSavingRow(null);
                      if (res.kind === "failed") toast.error(res.message);
                      else {
                        toast.success("Computer enabled.");
                        announceAgentsChanged();
                        onChanged();
                      }
                    }}
                  >
                    Give it a computer
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={savingRow === "computer"}
                      onClick={async () => {
                        setSavingRow("computer");
                        const res = await computerAction(agent.id, "reset");
                        setSavingRow(null);
                        if (res.kind === "failed") toast.error(res.message);
                        else {
                          toast.success("Computer reset.");
                          announceAgentsChanged();
                          onChanged();
                        }
                      }}
                    >
                      Reset computer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={savingRow === "computer"}
                      onClick={async () => {
                        setSavingRow("computer");
                        const res = await computerAction(agent.id, "disable");
                        setSavingRow(null);
                        if (res.kind === "failed") toast.error(res.message);
                        else {
                          toast.success("Computer turned off.");
                          announceAgentsChanged();
                          onChanged();
                        }
                      }}
                    >
                      Turn off
                    </Button>
                  </>
                )}
              </div>
            </div>
          </ExpandRow>
        ) : null}

        {/* 7. Model and effort */}
        <ExpandRow
          label="Model and effort"
          summary={`${agent.model ?? "Your default"}${agent.reasoningEffort ? ` · ${agent.reasoningEffort}` : ""}`}
          open={expanded === "model"}
          onToggle={() => toggle("model")}
        >
          <ModelPicker
            model={model}
            reasoningEffort={reasoningEffort}
            onChange={(next) => {
              setModel(next.model);
              setReasoningEffort(next.reasoningEffort);
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={savingRow === "model"}
              onClick={() => void savePatch("model", { model, reasoningEffort })}
            >
              Save
            </Button>
          </div>
        </ExpandRow>

        {/* 8. Notifications */}
        <ExpandRow
          label="Notifications"
          summary={NOTIFY_LABEL[agent.notify ?? "results"]}
          open={expanded === "notify"}
          onToggle={() => toggle("notify")}
        >
          <div className="space-y-2">
            {AGENT_NOTIFY_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setNotify(level)}
                className={cn(
                  "block w-full rounded-control border p-2.5 text-left transition-colors",
                  notify === level
                    ? "border-foreground/40 bg-selected"
                    : "border-border bg-card hover:bg-accent"
                )}
              >
                <span className="block text-ui font-medium text-foreground">{NOTIFY_LABEL[level]}</span>
                <span className="mt-0.5 block text-caption text-muted-foreground">{NOTIFY_SUMMARY[level]}</span>
              </button>
            ))}
            <div className="flex justify-end">
              <Button size="sm" loading={savingRow === "notify"} onClick={() => void savePatch("notify", { notify })}>
                Save
              </Button>
            </div>
          </div>
        </ExpandRow>

        {/* 9. Suggests ideas */}
        <div className={cn("flex items-center justify-between gap-3 border-b border-border px-3.5 py-3", group !== "work" && "hidden")}>
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-foreground">Suggests ideas</span>
            <span className="mt-0.5 block text-caption text-muted-foreground">
              Raises bounded ideas during daily reflection.
            </span>
          </span>
          <Switch
            checked={agent.proactive}
            onCheckedChange={(checked) => void savePatch("proactive", { proactive: checked })}
            aria-label="Suggests ideas"
          />
        </div>

        {/* 10. What it knows */}
        <ExpandRow
          label="What it knows"
          summary={`${detail.notes.length} ${detail.notes.length === 1 ? "note" : "notes"}`}
          open={expanded === "memory"}
          onToggle={() => toggle("memory")}
        >
          <div className="space-y-3">
            {detail.notes.length > 0 ? (
              <ul className="divide-y divide-border">
                {detail.notes.map((note) => (
                  <li key={note.id} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                    {editingNoteId === note.id ? (
                      <div className="space-y-2">
                        <Textarea
                          rows={2}
                          value={editingNoteText}
                          onChange={(e) => setEditingNoteText(e.target.value)}
                          className="text-ui"
                        />
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => setEditingNoteId(null)}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={async () => {
                              const res = await updateNote(agent.id, note.id, editingNoteText.trim());
                              if (res.kind === "failed") toast.error(res.message);
                              else {
                                setEditingNoteId(null);
                                announceAgentsChanged();
                                onChanged();
                              }
                            }}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-ui text-foreground">{note.content}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNoteId(note.id);
                              setEditingNoteText(note.content);
                            }}
                            className="text-caption text-muted-foreground hover:text-foreground"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await deleteNote(agent.id, note.id);
                              if (res.kind === "failed") toast.error(res.message);
                              else {
                                announceAgentsChanged();
                                onChanged();
                              }
                            }}
                            aria-label="Delete note"
                            className="text-caption text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">Nothing saved yet.</p>
            )}

            <div className="flex items-center gap-2">
              <Input
                value={newNoteContent}
                onChange={(e) => setNewNoteContent(e.target.value)}
                placeholder="Add a note to remember…"
                className="h-8 text-ui"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!newNoteContent.trim()}
                onClick={async () => {
                  const res = await createNote(agent.id, newNoteContent.trim());
                  if (res.kind === "failed") toast.error(res.message);
                  else {
                    setNewNoteContent("");
                    announceAgentsChanged();
                    onChanged();
                  }
                }}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add
              </Button>
            </div>

            {detail.notes.length > 0 ? (
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={handleDownloadNotes} className="gap-1">
                  <Download className="size-3" aria-hidden="true" />
                  Download notes (.md)
                </Button>
              </div>
            ) : null}
          </div>
        </ExpandRow>

        {/* 11. Routines */}
        <ExpandRow
          label="Routines"
          summary={
            detail.routines.length > 0
              ? `${detail.routines.length} ${detail.routines.length === 1 ? "routine" : "routines"}`
              : "None"
          }
          open={expanded === "routines"}
          onToggle={() => toggle("routines")}
        >
          <div className="space-y-3">
            {detail.routines.length > 0 ? (
              <ul className="divide-y divide-border">
                {detail.routines.map((routine) => (
                  <li key={routine.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui font-medium text-foreground">{routine.name}</p>
                      <p className="truncate text-caption text-muted-foreground">{routine.schedule}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          const res = await updateRoutine(routine.id, !routine.enabled);
                          if (res.kind === "failed") toast.error(res.message);
                          else {
                            announceAgentsChanged();
                            onChanged();
                          }
                        }}
                      >
                        {routine.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${routine.name}`}
                        onClick={async () => {
                          const res = await deleteRoutine(routine.id);
                          if (res.kind === "failed") toast.error(res.message);
                          else {
                            announceAgentsChanged();
                            onChanged();
                          }
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">
                Ask {agent.name} in the chat to schedule a recurring routine.
              </p>
            )}
            <div className="flex justify-end">
              <Link href="/automations" className="text-caption text-foreground underline-offset-4 hover:underline">
                Edit in Automations
              </Link>
            </div>
          </div>
        </ExpandRow>
      </div>

      </DetailGroupContext.Provider>
      {/* Footer: Pause/Resume · Duplicate · Retire */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={savingRow === "status"}
            onClick={() =>
              void savePatch("status", { status: agent.status === "paused" ? "active" : "paused" })
            }
          >
            {agent.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="secondary" loading={savingRow === "duplicate"} onClick={() => void handleDuplicate()}>
            Duplicate
          </Button>
        </div>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmRetire(true)}>
          Retire
        </Button>
      </div>

      <Dialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire {agent.name}?</DialogTitle>
            <DialogDescription>
              Retiring {agent.name} stops all of its routines and tasks and removes it from your roster. Its past chat
              transcript stays in your conversations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmRetire(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmRetire(false);
                void handleRetire();
              }}
            >
              Retire {agent.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
