"use client";

/**
 * The /code landing's Skills chip (skills lane): the same selector a thread's
 * composer opens, for the run about to start on a Mac. The account's skills
 * always; the Mac's own once the chosen project's Mac answers `skills.list`
 * over the device link. What is chosen here becomes the new thread's
 * selection (`seedThreadSkills`); a `/name` armed here rides the first message.
 */
import * as React from "react";
import "@/components/code/v2/code-v2.css";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { composerChipClass } from "@/components/ui/composer-shell";
import { Icon } from "@/components/ui/juno-icons";
import { useDevicePresence } from "@/components/code/code-session-meta";
import { SkillsPanel } from "@/components/code/v2/skills";
import { useCodeSkills, type CodeSkillsState } from "@/components/code/v2/use-code-skills";
import type { LocalSkillSummary } from "@/lib/code-v2/contracts";
import { skillsChipLabel, skillsStorageKey } from "@/lib/code-v2/skills";
import { cn } from "@/lib/utils";

/** One `skills.list` over the device link, without opening a session. */
async function listMacSkills(deviceId: string, cwd: string | null): Promise<LocalSkillSummary[]> {
  const response = await fetch(`/api/code/v2/link/${encodeURIComponent(deviceId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "rpc", command: { id: `skills-${Date.now()}`, type: "skills.list", params: cwd ? { cwd } : {} } }),
  });
  if (!response.ok) throw new Error("link");
  const reply = (await response.json()) as { responses?: { ok: boolean; result?: { skills?: LocalSkillSummary[] } }[]; offline?: boolean };
  const first = reply.responses?.[0];
  if (reply.offline || !first?.ok) throw new Error("offline");
  return first.result?.skills ?? [];
}

/** The landing's skills, for the project chosen on the Mac. */
export function useLandingSkills(workspace: { key?: string | null; name: string; path: string } | null): CodeSkillsState {
  const { presence } = useDevicePresence(workspace?.key ?? null, workspace?.name ?? null, !!workspace);
  const deviceId = presence.state === "online" ? (presence.device?.id ?? null) : null;
  const path = workspace?.path ?? null;
  const listLocal = React.useMemo(() => (deviceId ? () => listMacSkills(deviceId, path) : null), [deviceId, path]);
  return useCodeSkills({ threadKey: null, listLocal });
}

/**
 * Hands the landing's choice to the thread it starts: its selection, kept as
 * the thread's own, and an armed `/name`, written ahead of the first message.
 */
export function seedThreadSkills(skills: CodeSkillsState, conversationId: string, text: string): string {
  try {
    if (skills.selected.length) localStorage.setItem(skillsStorageKey(conversationId), JSON.stringify(skills.selected.map((s) => s.id)));
  } catch {
    /* per-viewer convenience */
  }
  return skills.once ? `/${skills.once.name} ${text}` : text;
}

export function LandingSkillsChip({ skills, disabled }: { skills: CodeSkillsState; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const label = skillsChipLabel(skills.selected, skills.once);
  const active = skills.selected.length > 0 || !!skills.once;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) skills.load();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={active ? `Skills: ${label}` : "Skills"}
          onPointerEnter={skills.load}
          className={cn(composerChipClass, "max-w-full", active && "text-foreground")}
        >
          <Icon name="skills" size={14} />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} collisionPadding={12} className="w-[380px] overflow-hidden p-0">
        <div className="cv2 cv2-landing-skills">
          <SkillsPanel skills={skills} onClose={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
