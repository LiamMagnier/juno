"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentFace } from "@/components/agents/agent-face";
import { AgentPresence } from "@/components/agents/agent-presence";
import { announceAgentsChanged, updateAgent } from "@/components/agents/agents-transport";
import {
  AGENT_EYES,
  AGENT_EYES_LABEL,
  AGENT_MARKS,
  AGENT_MARK_LABEL,
  AGENT_SHAPES,
  AGENT_SHAPE_LABEL,
  AGENT_TONES,
  AGENT_TONE_LABEL,
  type AgentAvatar,
} from "@/lib/agents/avatar";
import { AGENT_STYLES, AGENT_STYLE_LABEL, type AgentState, type AgentStyle } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

const STYLE_COPY: Record<AgentStyle, string> = {
  warm: "Friendly and encouraging.",
  direct: "Short answers, no small talk.",
  playful: "Light, with a sense of humour.",
  formal: "Polished and precise.",
};

/** The states a person can try the face in, in the order they happen. */
const PREVIEW_STATES: ReadonlyArray<{ state: AgentState; label: string }> = [
  { state: "idle", label: "At rest" },
  { state: "thinking", label: "Thinking" },
  { state: "working", label: "Working" },
  { state: "waiting", label: "Needs you" },
  { state: "done", label: "Done" },
];

/**
 * The face studio: customise how an agent looks and speaks, with the face live
 * in front of you. The one place in Agents that is a direct editor, because a
 * look is easier to pick than to describe; everything else is set by talking.
 */
export function AgentFaceStudio({
  agent,
  open,
  onOpenChange,
  onSaved,
}: {
  agent: ClientAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (agent: ClientAgent) => void;
}) {
  const [avatar, setAvatar] = React.useState<AgentAvatar>(agent.avatar);
  const [name, setName] = React.useState(agent.name);
  const [style, setStyle] = React.useState<AgentStyle>(agent.style);
  const [preview, setPreview] = React.useState<AgentState>("idle");
  const [saving, setSaving] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setAvatar(agent.avatar);
    setName(agent.name);
    setStyle(agent.style);
    setPreview("idle");
  }, [open, agent.avatar, agent.name, agent.style]);

  const pick = <K extends keyof AgentAvatar>(key: K, value: AgentAvatar[K]) => {
    setAvatar((current) => ({ ...current, [key]: value }));
    // A change of look reads as a small greeting, then settles.
    setPreview("done");
    window.setTimeout(() => setPreview((s) => (s === "done" ? "idle" : s)), 700);
  };

  const dirty =
    name.trim() !== agent.name ||
    style !== agent.style ||
    avatar.shape !== agent.avatar.shape ||
    avatar.tone !== agent.avatar.tone ||
    avatar.eyes !== agent.avatar.eyes ||
    avatar.mark !== agent.avatar.mark;

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give it a name.");
      return;
    }
    setSaving(true);
    const res = await updateAgent(agent.id, { name: trimmed, avatar, style });
    setSaving(false);
    if (res.kind !== "ok") {
      toast.error(res.kind === "failed" ? res.message : "Couldn’t save. Try again.");
      return;
    }
    announceAgentsChanged();
    onSaved?.(res.value);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden p-0 sm:p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-[18rem_1fr]">
          <div
            className="relative flex flex-col items-center justify-center gap-6 px-6 py-10 md:py-12"
            style={{
              background: `radial-gradient(120% 90% at 50% 35%, hsl(var(--agent-${avatar.tone}) / 0.16), transparent 70%)`,
            }}
          >
            <div key={`${avatar.shape}-${avatar.tone}-${avatar.eyes}-${avatar.mark}`} className="motion-safe:animate-studio-swap">
              <AgentPresence avatar={avatar} state={preview} size={128} haloScale={2} gaze name={name || "Your agent"} />
            </div>
            <div className="text-center">
              <p className="font-serif text-title italic leading-tight text-foreground">{name.trim() || "Your agent"}</p>
              <p className="mt-1 text-ui text-muted-foreground">{STYLE_COPY[style]}</p>
            </div>
            <div className="flex max-w-[15rem] flex-wrap justify-center gap-x-2.5 gap-y-1" role="radiogroup" aria-label="Preview a state">
              {PREVIEW_STATES.map((item) => (
                <button
                  key={item.state}
                  type="button"
                  role="radio"
                  aria-checked={preview === item.state}
                  onClick={() => setPreview(item.state)}
                  className={cn(
                    "text-caption transition-colors duration-fast ease-out-soft",
                    preview === item.state ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[80dvh] space-y-7 overflow-y-auto border-t border-border/60 px-6 py-7 md:border-l md:border-t-0">
            <div>
              <DialogTitle className="text-heading">Make it yours</DialogTitle>
              <DialogDescription className="mt-1 text-ui text-muted-foreground">
                Its look and voice. What it does, you tell it in the chat.
              </DialogDescription>
            </div>

            <label className="block">
              <span className="mb-2 block text-ui font-medium text-muted-foreground">Name</span>
              <Input ref={nameRef} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-11 text-body" />
            </label>

            <Choice label="Colour">
              {AGENT_TONES.map((tone) => (
                <Swatch
                  key={tone}
                  selected={avatar.tone === tone}
                  label={AGENT_TONE_LABEL[tone]}
                  onClick={() => pick("tone", tone)}
                >
                  <span className="size-7 rounded-full" style={{ background: `hsl(var(--agent-${tone}))` }} />
                </Swatch>
              ))}
            </Choice>

            <Choice label="Shape">
              {AGENT_SHAPES.map((shape) => (
                <Swatch key={shape} selected={avatar.shape === shape} label={AGENT_SHAPE_LABEL[shape]} onClick={() => pick("shape", shape)}>
                  <AgentFace avatar={{ ...avatar, shape, mark: "none" }} size={30} live={false} />
                </Swatch>
              ))}
            </Choice>

            <Choice label="Eyes">
              {AGENT_EYES.map((eyes) => (
                <Swatch key={eyes} selected={avatar.eyes === eyes} label={AGENT_EYES_LABEL[eyes]} onClick={() => pick("eyes", eyes)}>
                  <AgentFace avatar={{ ...avatar, eyes, mark: "none" }} size={30} live={false} />
                </Swatch>
              ))}
            </Choice>

            <Choice label="Detail">
              {AGENT_MARKS.map((mark) => (
                <Swatch key={mark} selected={avatar.mark === mark} label={AGENT_MARK_LABEL[mark]} onClick={() => pick("mark", mark)}>
                  <AgentFace avatar={{ ...avatar, mark }} size={30} live={false} />
                </Swatch>
              ))}
            </Choice>

            <div>
              <span className="mb-2 block text-ui font-medium text-muted-foreground">Personality</span>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Personality">
                {AGENT_STYLES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={style === option}
                    onClick={() => setStyle(option)}
                    className={cn(
                      "rounded-field px-3.5 py-2.5 text-left ring-1 transition-[box-shadow,background-color] duration-fast ease-out-soft",
                      style === option ? "bg-selected ring-foreground/25" : "ring-border/70 hover:bg-accent"
                    )}
                  >
                    <span className="block text-ui font-medium text-foreground">{AGENT_STYLE_LABEL[option]}</span>
                    <span className="block text-caption text-muted-foreground">{STYLE_COPY[option]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" className="rounded-full px-6" disabled={!dirty} loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Choice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-2 block text-ui font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function Swatch({
  selected,
  label,
  onClick,
  children,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-11 place-items-center rounded-full transition-[box-shadow,transform] duration-fast ease-out-soft active:scale-95",
        selected ? "ring-2 ring-foreground/70 ring-offset-2 ring-offset-background" : "hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}
