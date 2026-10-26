"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentPresence } from "@/components/agents/agent-presence";
import { FaceStatePicker, SwatchRow, lookSwatch } from "@/components/agents/agent-profile-fields";
import { announceAgentsChanged, updateAgent } from "@/components/agents/agents-transport";
import {
  AGENT_EYES,
  AGENT_EYES_LABEL,
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

/**
 * The face studio: customise how an agent looks and speaks, with the face live
 * in front of you. The one place in Agents that is a direct editor, because a
 * look is easier to pick than to describe; everything else is set by talking.
 * Its look pickers and state switcher are the hire flow's own
 * (agent-profile-fields.tsx), so the same choice never looks two ways.
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

  // Seeded when the dialog opens, never on the agent object's identity: the
  // profile re-reads the agent every 5 s, and a fresh object must not wipe an
  // edit in progress.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setAvatar(agent.avatar);
      setName(agent.name);
      setStyle(agent.style);
      setPreview("idle");
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A change of look, picked from rest, reads as a small greeting (done, then
  // ready again). From any other state the preview stays where the person put
  // it, so colours can be compared while it works or asks.
  const greeting = React.useRef(0);
  const endGreeting = () => {
    if (greeting.current) window.clearTimeout(greeting.current);
    greeting.current = 0;
  };
  React.useEffect(() => endGreeting, []);
  const pick = <K extends keyof AgentAvatar>(key: K, value: AgentAvatar[K]) => {
    setAvatar((current) => ({ ...current, [key]: value }));
    if (preview !== "idle" && !greeting.current) return;
    setPreview("done");
    endGreeting();
    greeting.current = window.setTimeout(() => {
      greeting.current = 0;
      setPreview((s) => (s === "done" ? "idle" : s));
    }, 700);
  };
  const choosePreview = (next: AgentState) => {
    // A state the person picks is theirs: no greeting ends it.
    endGreeting();
    setPreview(next);
  };

  // The swap is played on the element (never a remount), so the face carries
  // on under a new look as the hire preview does (face-rig.ts rebaseSegment).
  const swap = React.useRef<HTMLDivElement | null>(null);
  const look = `${avatar.shape}-${avatar.tone}-${avatar.eyes}`;
  const shownLook = React.useRef(look);
  React.useEffect(() => {
    if (shownLook.current === look) return;
    shownLook.current = look;
    const el = swap.current;
    if (!el) return;
    el.classList.remove("motion-safe:animate-studio-swap");
    void el.offsetWidth;
    el.classList.add("motion-safe:animate-studio-swap");
  }, [look]);

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
        className="max-w-[52rem] gap-0 overflow-hidden p-0 sm:p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-[21rem_1fr]">
          <div className="relative flex flex-col items-center justify-center gap-6 bg-foreground/[0.025] px-4 py-10 md:py-12">
            <div ref={swap} className="motion-safe:animate-studio-swap">
              {/* `direct`: a state picked here plays at once, never held like an agent loop's. */}
              <AgentPresence avatar={avatar} state={preview} size={128} gaze direct name={name || "Your agent"} />
            </div>
            <div className="text-center">
              {/* Set as on the agent's panel (upright serif); the line under it is
                  what the agent does, never the personality picked beside it. */}
              <p className="font-serif text-title font-normal leading-tight text-foreground">{name.trim() || "Your agent"}</p>
              {agent.role.trim() ? <p className="mt-1 text-ui text-muted-foreground">{agent.role}</p> : null}
            </div>
            <FaceStatePicker value={preview} onChange={choosePreview} />
          </div>

          <div className="@container/studio max-h-[80dvh] space-y-7 overflow-y-auto border-t border-border/60 px-6 py-7 md:border-l md:border-t-0">
            <div>
              <DialogTitle className="text-heading">Make it yours</DialogTitle>
              <DialogDescription className="mt-1 text-ui text-muted-foreground">
                Its look and voice. What it does, you tell it in the chat.
              </DialogDescription>
            </div>

            <label className="block">
              <span className="mb-1.5 block font-mono text-label text-muted-foreground">Name</span>
              <Input ref={nameRef} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-11 text-body" />
            </label>

            <SwatchRow label="Colour" values={AGENT_TONES} value={avatar.tone} onChange={(tone) => pick("tone", tone)} name={(tone) => AGENT_TONE_LABEL[tone]} render={lookSwatch.tone} />

            {/* Nine shapes in one row (5 + 4 when narrow), never 8 and an
                orphan. Nine distinct silhouettes at 30 px (tests/agents-face.test.ts
                checks no two swatches draw alike). Stills: a picture of a
                choice, so nothing here needs a clock. */}
            <SwatchRow
              label="Shape"
              values={AGENT_SHAPES}
              value={avatar.shape}
              onChange={(shape) => pick("shape", shape)}
              name={(shape) => AGENT_SHAPE_LABEL[shape]}
              render={(shape) => lookSwatch.shape(avatar, shape)}
              className="grid grid-cols-[repeat(5,2.75rem)] gap-1 @[27rem]/studio:grid-cols-[repeat(9,2.75rem)]"
            />

            <SwatchRow
              label="Eyes"
              values={AGENT_EYES}
              value={avatar.eyes}
              onChange={(eyes) => pick("eyes", eyes)}
              name={(eyes) => AGENT_EYES_LABEL[eyes]}
              render={(eyes) => lookSwatch.eyes(avatar, eyes)}
            />

            {/* No "Detail" row: the stored mark is no longer drawn (it only tunes
                how the face blinks and glances, agent-face.tsx), so six swatches
                would all look the same. The value is kept as it is. */}

            <div>
              <span className="mb-1.5 block font-mono text-label text-muted-foreground">Personality</span>
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
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" className="px-5" disabled={!dirty} loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
