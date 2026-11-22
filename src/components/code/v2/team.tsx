"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ModelSelection, ProviderInstance, RoleRouting } from "@/lib/code-v2/contracts";
import type { FeatureFlags } from "@/lib/code-v2/providers-view";
import { estimateRunUsd, formatBudget, orchestrateLabel, parseBudget, CANDIDATES_MAX, CANDIDATES_MIN, withCount, withRoleModel, type RoleSlot } from "@/lib/code-v2/orchestrate";
import {
  BUILDERS_MAX,
  BUILDERS_MIN,
  TEAM_PRESETS,
  TEAM_PRESET_COPY,
  TEAM_ROLE_COPY,
  adoptTeam,
  loadTeam,
  saveTeam,
  teamPresetOf,
  teamSummary,
  withBudget,
  withTeamPreset,
  withTeamRole,
  type TeamScope,
  type TeamStorage,
} from "@/lib/code-v2/team";
import { teamFromDefault } from "@/lib/code-v2/code-prefs";
import { useCodePrefs } from "./use-code-prefs";
import { formatUsd } from "@/lib/code-v2/tier-view";
import { EFFORT_LABELS, effectiveEffort, findInstance, modelLabel, ratesFor, shortLabel } from "./model-info";
import { Glyph, ModelMark } from "./primitives";
import { ModelPicker } from "./pickers";

function storage(): TeamStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Keeps the project's default team: a new thread starts from the last team
 * set in the same project, else from the account's default team (Settings ›
 * Code, `code-prefs.ts`), and every change is remembered for the project's
 * next thread. The thread's own team is stored with the thread on the server.
 */
export function useTeamDefault(routing: RoleRouting, lead: ModelSelection, scope: TeamScope, fresh: boolean, setRouting: (r: RoleRouting) => void) {
  const seeded = React.useRef(false);
  const { prefs: account, loaded: accountLoaded } = useCodePrefs();
  React.useEffect(() => {
    if (seeded.current || !fresh || routing.preset !== "solo") return;
    const store = storage();
    const stored = store && scope.project ? adoptTeam(loadTeam(store, { project: scope.project }), lead) : null;
    if (stored) {
      seeded.current = true;
      if (stored.preset !== "solo") setRouting(stored);
      return;
    }
    const fromAccount = teamFromDefault(account.team, lead, withTeamPreset);
    if (fromAccount) {
      seeded.current = true;
      setRouting(fromAccount);
    } else if (accountLoaded) seeded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per thread, after the account's defaults arrive
  }, [scope.project, scope.session, accountLoaded, account.team?.preset, account.team?.maxUsd]);
  const save = React.useCallback(
    (next: RoleRouting) => {
      const store = storage();
      if (store) saveTeam(store, scope, next);
      setRouting(next);
    },
    [scope, setRouting],
  );
  return save;
}

export function TeamChip({ routing, open, onToggle, triggerRef }: {
  routing: RoleRouting;
  open: boolean;
  onToggle: () => void;
  triggerRef: React.Ref<HTMLButtonElement>;
}) {
  const swarm = routing.preset === "lead-workers";
  const workers = routing.workers ?? [];
  const workerModels = new Set(workers.map((selection) => selection.model));
  const summary = workerModels.size > 1 && (swarm || routing.preset === "plan-build-verify")
    ? `${workers.length} ${swarm ? "workers" : "builders"} with different models`
    : teamSummary(routing);
  return (
    <button
      ref={triggerRef}
      type="button"
      className="composer-tray__item cv2-team-chip"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={summary ? `Orchestrator: ${TEAM_PRESET_COPY[routing.preset].label}. ${summary}` : "Orchestrator"}
      title={summary ?? "Choose how agents work together"}
      data-team={summary ? "set" : "solo"}
      onClick={onToggle}
    >
      <Glyph name="agents" size={14} />
      <span className="v cv2-trunc">{swarm ? `Swarm · ${workers.length}` : summary ? orchestrateLabel(routing) : "Orchestrator"}</span>
      <Glyph name="chevron-down" size={12} className="chev" />
    </button>
  );
}

function RoleModel({ instances, selection }: { instances: readonly ProviderInstance[]; selection: ModelSelection }) {
  const instance = findInstance(instances, selection.instanceId);
  const effort = effectiveEffort(instances, selection);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      {instance && <ModelMark modelId={selection.model} instance={instance} />}
      <span className="cv2-trunc">{shortLabel(instances, selection)}</span>
      {effort && effort !== "none" && <span className="shrink-0">{EFFORT_LABELS[effort]}</span>}
    </span>
  );
}

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-control border border-border p-0.5" role="group" aria-label={label}>
      <Button type="button" variant="ghost" size="icon-sm" className="rounded-xs" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Glyph name="minus" size={12} />
      </Button>
      <span className="min-w-7 text-center text-caption tabular-nums" aria-live="polite">
        ×{value}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" className="rounded-xs" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Glyph name="plus" size={12} />
      </Button>
    </span>
  );
}

type AgentSlot = {
  id: string;
  label: string;
  icon: string;
  selection: ModelSelection;
  slot: RoleSlot;
};

function TeamEditor({
  open, onClose, instances, flags, routing, lead, onChange, onLeadChange, onConnect,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  flags?: FeatureFlags;
  routing: RoleRouting;
  lead: ModelSelection;
  onChange: (r: RoleRouting) => void;
  onLeadChange: (selection: ModelSelection) => void;
  onConnect?: () => void;
}) {
  const preset = teamPresetOf(routing);
  const [activeRole, setActiveRole] = React.useState<string | null>(null);
  const returnFocus = React.useRef<string | null>(null);
  const grid = React.useRef<HTMLUListElement>(null);
  const [budgetText, setBudgetText] = React.useState(formatBudget(routing.budget?.maxUsd));
  React.useEffect(() => setBudgetText(formatBudget(routing.budget?.maxUsd)), [routing.budget?.maxUsd]);
  React.useEffect(() => {
    if (!open) setActiveRole(null);
  }, [open]);
  React.useEffect(() => {
    if (open && !activeRole && returnFocus.current) {
      grid.current?.querySelector<HTMLButtonElement>(`[data-team-role="${returnFocus.current}"]`)?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [open, activeRole]);
  const budget = parseBudget(budgetText);
  const est = estimateRunUsd(routing, ratesFor(instances));
  const workers = routing.workers ?? [];
  const swarm = preset === "lead-workers";
  const phased = preset === "plan-build-verify";
  const compare = preset === "best-of-n";
  const supervised = swarm || phased;
  const workerLabel = compare ? "Candidates" : phased ? "Builders" : "Workers";
  const pickPreset = (next: RoleRouting["preset"]) => onChange(withTeamPreset({ ...routing, orchestrator: lead }, next));

  const roles: AgentSlot[] = [{ id: "lead", label: "Lead", icon: "agents", selection: lead, slot: "orchestrator" }];
  if (phased) {
    roles.push({ id: "architect", label: "Architect", icon: "layers", selection: routing.architect ?? lead, slot: "architect" });
  }
  if (preset !== "solo") {
    for (const [index, selection] of workers.entries()) {
      const label = compare ? `Candidate ${String.fromCharCode(65 + index)}` : `${phased ? "Builder" : "Worker"} ${index + 1}`;
      roles.push({ id: `worker-${index}`, label, icon: compare ? "git-branch" : "terminal", selection, slot: { candidate: index } });
    }
  }
  if (supervised) {
    roles.push({ id: "reviewer", label: phased ? "Verifier" : "Reviewer", icon: "check", selection: routing.reviewer ?? lead, slot: "reviewer" });
    if (routing.explorer) {
      roles.push({ id: "explorer", label: TEAM_ROLE_COPY.explorer.name, icon: "search", selection: routing.explorer, slot: "explorer" });
    }
  }
  const editing = roles.find((role) => role.id === activeRole);
  const updateModel = (selection: ModelSelection) => {
    if (!editing) return;
    if (editing.slot === "orchestrator") onLeadChange(selection);
    else onChange(withRoleModel({ ...routing, orchestrator: lead }, editing.slot, selection));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="cv2-team-dialog max-w-[42rem]">
        <DialogHeader>
          <DialogTitle>Orchestrator</DialogTitle>
          <DialogDescription>{editing ? `Choose a model for ${editing.label}.` : "Choose how Code runs this task."}</DialogDescription>
        </DialogHeader>
        {editing ? (
          <div className="min-w-0 space-y-3 pb-4" key={editing.id}>
            <Button autoFocus type="button" variant="ghost" className="-ms-2" onClick={() => setActiveRole(null)}>
              <Glyph name="arrow-left" size={16} /> Back to team
            </Button>
            <div className="overflow-hidden rounded-panel border border-border">
              <ModelPicker
                key={editing.id}
                inline
                open
                title={`Model for ${editing.label}`}
                onClose={() => setActiveRole(null)}
                instances={instances}
                flags={flags}
                selection={editing.selection}
                onSelect={updateModel}
                onConnect={onConnect ? () => { onClose(); onConnect(); } : undefined}
              />
            </div>
          </div>
        ) : (
          <>
            <div>
              <div role="group" aria-label="Run mode" className="grid grid-cols-2 gap-1 rounded-panel bg-muted p-1 sm:grid-cols-4">
                {TEAM_PRESETS.map((mode) => (
                  <button key={mode} type="button" aria-pressed={preset === mode} className={cn(
                    "min-h-11 rounded-card px-2 py-1.5 text-ui font-medium transition-colors duration-fast",
                    preset === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )} onClick={() => pickPreset(mode)}>
                    {mode === "lead-workers" ? "Swarm" : mode === "plan-build-verify" ? "Plan and verify" : mode === "best-of-n" ? "Compare" : "Solo"}
                  </button>
                ))}
              </div>
              <p className="mt-3 min-h-10 text-ui text-muted-foreground">{TEAM_PRESET_COPY[preset].line}</p>
              <div className="mt-2 flex min-h-11 flex-wrap items-center justify-between gap-2">
                <h3 className="text-ui font-semibold" id="code-team-models">{preset === "solo" ? "Model" : "Team models"}</h3>
                {preset !== "solo" && (
                  <Stepper value={workers.length} min={compare ? CANDIDATES_MIN : BUILDERS_MIN} max={compare ? CANDIDATES_MAX : BUILDERS_MAX} label={workerLabel} onChange={(n) => onChange(withCount(routing, n))} />
                )}
              </div>
              <ul ref={grid} className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-labelledby="code-team-models">
                {roles.map((role) => (
                  <li key={role.id} className={preset === "solo" ? "col-span-full" : "min-w-0"}>
                    <button type="button"
                      className="group flex min-h-[5.25rem] w-full flex-col justify-between gap-2 rounded-panel border border-border bg-muted/35 p-2.5 text-start transition-colors duration-fast hover:border-foreground/20 hover:bg-accent"
                      onClick={() => { returnFocus.current = role.id; setActiveRole(role.id); }}
                      data-team-role={role.id}
                      aria-label={`${role.label}: ${modelLabel(instances, role.selection)}. Change model`}
                    >
                      <span className="flex w-full items-center gap-2 text-ui font-medium">
                        <span className="grid size-7 shrink-0 place-items-center rounded-xs bg-background text-muted-foreground"><Glyph name={role.icon} size={15} /></span>
                        <span className="min-w-0 grow">{role.label}</span>
                        <Glyph name="chevron-right" size={13} className="shrink-0 text-muted-foreground" />
                      </span>
                      <RoleModel instances={instances} selection={role.selection} />
                    </button>
                  </li>
                ))}
              </ul>
              {preset !== "solo" && (
                <details className="group mt-3 border-t border-border">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-ui text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    Run limits{supervised ? " and explorer" : ""}
                    <Glyph name="chevron-down" size={16} className="transition-transform duration-fast group-open:rotate-180 motion-reduce:transition-none" />
                  </summary>
                  <div className="grid gap-2 pb-3">
                    <label className="flex flex-wrap items-center justify-between gap-2 text-ui">
                      <span>Alevr spend limit</span>
                      <input
                        className="h-9 w-24 rounded-control border border-border bg-background px-2.5"
                        value={budgetText}
                        inputMode="decimal"
                        aria-invalid={budget === null}
                        placeholder="No cap"
                        onChange={(event) => setBudgetText(event.target.value)}
                        onBlur={() => { if (budget !== null && budget !== routing.budget?.maxUsd) onChange(withBudget(routing, budget)); }}
                      />
                    </label>
                    {budget === null && <span role="status" className="text-caption text-destructive">Enter a dollar amount greater than zero.</span>}
                    {est.usd > 0 && <span className="text-caption text-muted-foreground">Estimated run cost: {formatUsd(est.usd)}</span>}
                    {supervised && (
                      <Button type="button" variant="ghost" className="justify-start" onClick={() => onChange(withTeamRole(routing, "explorer", routing.explorer ? undefined : lead))}>
                        <Glyph name={routing.explorer ? "minus" : "plus"} size={16} />
                        {routing.explorer ? "Remove explorer" : "Add a read-only explorer"}
                      </Button>
                    )}
                  </div>
                </details>
              )}
            </div>
            <DialogFooter className="!flex-row !justify-end">
              <DialogClose asChild><Button type="button" size="sm">Done</Button></DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ComposerTeam({
  routing, lead, instances, flags, scope, fresh, setRouting, popover, setPopover, onLeadChange, onConnect,
}: {
  routing: RoleRouting;
  lead: ModelSelection;
  instances: readonly ProviderInstance[];
  flags?: FeatureFlags;
  scope: TeamScope;
  fresh: boolean;
  setRouting: (r: RoleRouting) => void;
  popover: string | null;
  setPopover: (p: "team" | null) => void;
  onLeadChange: (selection: ModelSelection) => void;
  onConnect?: () => void;
}) {
  const save = useTeamDefault(routing, lead, scope, fresh, setRouting);
  const open = popover === "team";
  const trigger = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setPopover(open ? null : "team");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setPopover]);
  return (
    <>
      <TeamChip triggerRef={trigger} routing={routing} open={open} onToggle={() => setPopover(open ? null : "team")} />
      <TeamEditor open={open} onClose={() => setPopover(null)} instances={instances} flags={flags} routing={routing} lead={lead} onChange={save} onLeadChange={onLeadChange} onConnect={onConnect} />
    </>
  );
}
