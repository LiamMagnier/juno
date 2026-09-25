"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { IconButton } from "@/components/ui/icon-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActionIcons } from "@/lib/app-icons";
import type { AgentAvatar } from "@/lib/agents/avatar";
import {
  MAX_AGENT_INSTRUCTIONS_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_NOTE_CHARS,
  MAX_AGENT_ROLE_CHARS,
  type AgentStyle,
} from "@/lib/agents/domain";
import type { ClientAgentDetail, ClientAgentNote } from "@/lib/agents/types";
import type { WorkPermissionPolicy } from "@/lib/work/domain";
import {
  AutonomyPicker,
  ConnectorPicker,
  FaceBuilder,
  FacePreview,
  ModelPicker,
  StylePicker,
  useLinkedConnectors,
} from "@/components/agents/agent-profile-fields";
import {
  announceAgentsChanged,
  createNote,
  deleteNote,
  retireAgent,
  updateAgent,
  updateNote,
  type AgentPatch,
} from "@/components/agents/agents-transport";
import { formatAgo } from "@/components/agents/agent-bits";
import { SectionTitle } from "@/components/agents/agent-now";

/**
 * Profile: who it is, what it may do, and what it knows.
 *
 * WHAT IT KNOWS is Muse's "Identity" section, and the one piece of this page a
 * person must be able to trust completely: every note the agent keeps is
 * listed, editable, deletable and downloadable, and a deleted note is gone from
 * every later turn (they are read with `deletedAt: null`). An edited note
 * becomes the person's words, whoever wrote it first.
 */
export function AgentProfile({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  return (
    <div className="space-y-10">
      <ProfileForm detail={detail} onChanged={onChanged} />
      <Notes detail={detail} onChanged={onChanged} />
      <Retire detail={detail} />
    </div>
  );
}

function ProfileForm({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  const { agent } = detail;
  const connectors = useLinkedConnectors();
  const [name, setName] = React.useState(agent.name);
  const [role, setRole] = React.useState(agent.role);
  const [avatar, setAvatar] = React.useState<AgentAvatar>(agent.avatar);
  const [style, setStyle] = React.useState<AgentStyle>(agent.style);
  const [instructions, setInstructions] = React.useState(agent.instructions);
  const [approvalMode, setApprovalMode] = React.useState<WorkPermissionPolicy>(agent.approvalMode);
  const [connectorIds, setConnectorIds] = React.useState<string[]>(agent.connectorIds);
  const [proactive, setProactive] = React.useState(agent.proactive);
  const [thinking, setThinking] = React.useState({ model: agent.model, reasoningEffort: agent.reasoningEffort });
  const [saving, setSaving] = React.useState(false);

  const modelChanged = thinking.model !== agent.model || thinking.reasoningEffort !== agent.reasoningEffort;
  const dirty =
    name !== agent.name ||
    role !== agent.role ||
    JSON.stringify(avatar) !== JSON.stringify(agent.avatar) ||
    style !== agent.style ||
    instructions !== agent.instructions ||
    approvalMode !== agent.approvalMode ||
    proactive !== agent.proactive ||
    modelChanged ||
    [...connectorIds].sort().join(",") !== [...agent.connectorIds].sort().join(",");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || !name.trim() || saving) return;
    setSaving(true);
    // The model travels only when it changed: the server checks it against the
    // plan, and a plan that has since changed must not stop a rename.
    // `AgentPatch` does not name the effort yet, so the patch widens it here.
    const patch: AgentPatch & { reasoningEffort?: string | null } = {
      name: name.trim(),
      role: role.trim(),
      avatar,
      style,
      instructions: instructions.trim(),
      approvalMode,
      connectorIds,
      proactive,
      ...(modelChanged ? thinking : {}),
    };
    const outcome = await updateAgent(agent.id, patch);
    setSaving(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That did not save.");
      return;
    }
    toast.success("Saved. Its next message and its next task use this.");
    announceAgentsChanged();
    onChanged();
  };

  return (
    <form onSubmit={save} className="@container">
      <div className="grid grid-cols-1 gap-8 @[48rem]:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0 space-y-6">
          <div className="grid grid-cols-1 gap-3 @[28rem]:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block font-mono text-label text-muted-foreground">Name</span>
              <Input value={name} maxLength={MAX_AGENT_NAME_CHARS} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="block">
              <span className="mb-1.5 block font-mono text-label text-muted-foreground">What it is for</span>
              <Input value={role} maxLength={MAX_AGENT_ROLE_CHARS} onChange={(event) => setRole(event.target.value)} />
            </label>
          </div>
          <FaceBuilder avatar={avatar} onChange={setAvatar} />
          <div className="@container">
            <p className="mb-2 font-mono text-label text-muted-foreground">How it talks</p>
            <StylePicker value={style} onChange={setStyle} />
          </div>
          <label className="block">
            <span className="mb-1.5 block font-mono text-label text-muted-foreground">Its brief</span>
            <Textarea
              value={instructions}
              rows={7}
              maxLength={MAX_AGENT_INSTRUCTIONS_CHARS}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <div>
            <p className="mb-2 font-mono text-label text-muted-foreground">Autonomy</p>
            <AutonomyPicker value={approvalMode} onChange={setApprovalMode} />
          </div>
          <div>
            <p className="mb-2 font-mono text-label text-muted-foreground">Connected apps it may use</p>
            <ConnectorPicker options={connectors} value={connectorIds} onChange={setConnectorIds} />
          </div>
          <div className="@container">
            <p className="mb-2 font-mono text-label text-muted-foreground">Model</p>
            <ModelPicker model={thinking.model} reasoningEffort={thinking.reasoningEffort} onChange={setThinking} />
            <p className="mt-2 text-ui text-muted-foreground">
              Its thread and its tasks use this. You can still pick another model for any one message.
            </p>
          </div>
          <label className="flex items-start justify-between gap-4 rounded-card border border-border p-3">
            <span>
              <span className="block text-ui font-medium text-foreground">Suggests ideas on its own</span>
              <span className="mt-0.5 block text-ui text-muted-foreground">
                At most every six hours it looks over its goals and recent work, checks in, and raises ideas for you
                to start. It never starts work by itself.
              </span>
            </span>
            <Switch checked={proactive} onCheckedChange={setProactive} aria-label="Suggests ideas on its own" />
          </label>
          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" loading={saving} disabled={!dirty || !name.trim()}>
              Save changes
            </Button>
          </div>
        </div>
        <aside className="order-first @[48rem]:order-none">
          <div className="@[48rem]:sticky @[48rem]:top-6">
            <FacePreview avatar={avatar} name={name} />
          </div>
        </aside>
      </div>
    </form>
  );
}

function downloadNotes(name: string, notes: readonly ClientAgentNote[]) {
  const text = [
    `# What ${name} knows`,
    "",
    ...notes.map((note) => `- ${note.content} (${note.source === "user" ? "you" : "learned"}, ${note.createdAt.slice(0, 10)})`),
    "",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^\w-]+/g, "-").toLowerCase() || "agent"}-memory.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function Notes({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  const { agent, notes } = detail;
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; content: string } | null>(null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    const outcome = await createNote(agent.id, draft.trim());
    setSaving(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That note did not save.");
      return;
    }
    setDraft("");
    onChanged();
  };

  const saveEdit = async () => {
    if (!editing || !editing.content.trim()) return;
    const outcome = await updateNote(agent.id, editing.id, editing.content.trim());
    if (outcome.kind !== "ok") toast.error(outcome.kind === "failed" ? outcome.message : "That did not save.");
    setEditing(null);
    onChanged();
  };

  const remove = async (note: ClientAgentNote) => {
    const outcome = await deleteNote(agent.id, note.id);
    if (outcome.kind !== "ok") toast.error(outcome.kind === "failed" ? outcome.message : "That did not delete.");
    onChanged();
  };

  return (
    <section aria-labelledby="agent-notes">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle id="agent-notes" hint={`${notes.length}`}>
          What it knows
        </SectionTitle>
        {notes.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => downloadNotes(agent.name, notes)}>
            Download
          </Button>
        ) : null}
      </div>
      <p className="mb-3 text-ui text-muted-foreground">
        Its own memory, beside your account’s. It reads these in every conversation and every task. Delete one and it
        is gone from the next message on.
      </p>
      <form onSubmit={add} className="mb-3 flex items-center gap-2">
        <Input
          value={draft}
          maxLength={MAX_AGENT_NOTE_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Tell ${agent.name} something to remember`}
          aria-label="New note"
        />
        <Button type="submit" size="sm" loading={saving} disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      {notes.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-ui text-muted-foreground">
          Nothing yet. It keeps notes as it works, and you can add your own.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {notes.map((note) => (
            <li key={note.id} className="flex items-start gap-3 px-4 py-3">
              {editing?.id === note.id ? (
                <div className="flex flex-1 items-center gap-2">
                  <Input
                    autoFocus
                    value={editing.content}
                    maxLength={MAX_AGENT_NOTE_CHARS}
                    onChange={(event) => setEditing({ id: note.id, content: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveEdit();
                      }
                      if (event.key === "Escape") setEditing(null);
                    }}
                    aria-label="Edit note"
                  />
                  <Button size="sm" onClick={() => void saveEdit()}>
                    Save
                  </Button>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="text-ui text-foreground">{note.content}</p>
                    <p className="mt-0.5 font-mono text-caption text-muted-foreground">
                      {note.source === "user" ? "You told it" : "It learned"} · {formatAgo(note.createdAt)}
                    </p>
                  </div>
                  <IconButton label="Edit note" size="sm" variant="ghost" onClick={() => setEditing({ id: note.id, content: note.content })}>
                    <ActionIcons.edit className="size-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton label="Delete note" size="sm" variant="ghost" onClick={() => void remove(note)}>
                    <ActionIcons.delete className="size-4" aria-hidden="true" />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Retire({ detail }: { detail: ClientAgentDetail }) {
  const { agent } = detail;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const confirm = async () => {
    setBusy(true);
    const outcome = await retireAgent(agent.id);
    setBusy(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That did not work.");
      return;
    }
    setOpen(false);
    announceAgentsChanged();
    toast.success(`${agent.name} was retired. Its thread and its tasks are kept.`);
    router.push("/agents");
  };

  return (
    <section aria-labelledby="agent-retire" className="border-t border-border pt-6">
      <SectionTitle id="agent-retire">Retire {agent.name}</SectionTitle>
      <p className="mb-3 text-ui text-muted-foreground">
        Its routines stop. Its thread and everything its tasks made stay, as an ordinary chat and ordinary tasks.
      </p>
      <Button variant="destructive-outline" size="sm" onClick={() => setOpen(true)}>
        Retire agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Retire {agent.name}?</DialogTitle>
            <DialogDescription>
              Its routines stop and it leaves the roster. Its thread and its tasks are kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" autoFocus onClick={() => setOpen(false)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="destructive" loading={busy} onClick={() => void confirm()}>
              Retire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
