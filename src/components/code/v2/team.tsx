"use client";

/**
 * The Team orchestrator in the composer (team lane): an always-visible chip
 * that says who is on the team ("Opus plans · Sonnet ×2 builds · GPT
 * verifies", or just "Team" when Solo) and a role editor: the preset (Solo,
 * Plan → Build → Verify, Best of N), one row per role with its model and
 * effort (the row opens the model picker on that role's tab, where the
 * catalogue keeps an Effort row), the builders' count, an optional Explorer,
 * and the budget cap. Also reachable from the composer's options menu and
 * ⇧⌘O. The logic is src/lib/code-v2/team.ts; the Mac twin is
 * CodeV2TeamChip.swift / CodeV2TeamEditor.swift.
 */
import * as React from "react";
import type { ModelSelection, ProviderInstance, RoleRouting } from "@/lib/code-v2/contracts";
import { estimateRunUsd, formatBudget, parseBudget, CANDIDATES_MAX, CANDIDATES_MIN } from "@/lib/code-v2/orchestrate";
import {
  BUILDERS_MAX,
  BUILDERS_MIN,
  TEAM_PHASE_LABELS,
  TEAM_PRESETS,
  TEAM_PRESET_COPY,
  TEAM_ROLE_COPY,
  adoptTeam,
  loadTeam,
  saveTeam,
  teamPresetOf,
  teamRoleSelection,
  teamSummary,
  withBudget,
  withBuilderCount,
  withTeamPreset,
  withTeamRole,
  type TeamPreset,
  type TeamRole,
  type TeamScope,
  type TeamStorage,
} from "@/lib/code-v2/team";
import { withCount } from "@/lib/code-v2/orchestrate";
import { formatUsd } from "@/lib/code-v2/tier-view";
import { EFFORT_LABELS, effectiveEffort, findInstance, modelLabel, ratesFor, shortLabel } from "./model-info";
import { ComposerPopover, Glyph, ModelMark, Segmented } from "./primitives";
import type { RoleTab } from "./pickers";

const ROLE_TAB: Record<TeamRole, RoleTab> = { architect: "architect", builder: "workers", verifier: "reviewer", explorer: "explorer" };

function storage(): TeamStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Keeps the project's default team: a new thread starts from the last team
 * set in the same project, and every change is remembered for the next one.
 * The thread's own team is stored with the thread on the server.
 */
export function useTeamDefault(routing: RoleRouting, lead: ModelSelection, scope: TeamScope, fresh: boolean, setRouting: (r: RoleRouting) => void) {
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !fresh || routing.preset !== "solo" || !scope.project) return;
    seeded.current = true;
    const store = storage();
    const stored = store ? adoptTeam(loadTeam(store, { project: scope.project }), lead) : null;
    if (stored && stored.preset !== "solo") setRouting(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per thread
  }, [scope.project, scope.session]);
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

export function TeamChip({ routing, open, onToggle }: { routing: RoleRouting; open: boolean; onToggle: () => void }) {
  const summary = teamSummary(routing);
  return (
    <button
      type="button"
      className="cv2-ctl cv2-team-chip"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={summary ? `Team: ${summary}` : "Team"}
      title={summary ? `Team: ${summary} (⇧⌘O)` : "Choose who plans, builds and verifies (⇧⌘O)"}
      data-team={summary ? "set" : "solo"}
      onClick={onToggle}
    >
      <Glyph name="agents" size={14} />
      <span className="v cv2-trunc">{summary ?? "Team"}</span>
      <Glyph name="chevron-down" size={12} className="chev" />
    </button>
  );
}

function RoleModel({ instances, selection }: { instances: readonly ProviderInstance[]; selection: ModelSelection }) {
  const instance = findInstance(instances, selection.instanceId);
  const effort = effectiveEffort(instances, selection);
  return (
    <span className="cv2-team-model">
      {instance && <ModelMark modelId={selection.model} instance={instance} />}
      <span className="cv2-trunc">{shortLabel(instances, selection)}</span>
      {effort && effort !== "none" && <span className="eff">{EFFORT_LABELS[effort]}</span>}
    </span>
  );
}

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (n: number) => void }) {
  return (
    <span className="cv2-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Glyph name="minus" size={12} />
      </button>
      <span className="n" aria-live="polite">
        ×{value}
      </span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Glyph name="plus" size={12} />
      </button>
    </span>
  );
}

export function TeamEditor({
  open,
  onClose,
  instances,
  routing,
  lead,
  onChange,
  onPickRole,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  routing: RoleRouting;
  /** The composer's model: the lead, who runs the phases and writes the summary. */
  lead: ModelSelection;
  onChange: (r: RoleRouting) => void;
  /** A role's model: the model picker on that role's tab. */
  onPickRole: (tab: RoleTab) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const preset = teamPresetOf(routing);
  const [budgetText, setBudgetText] = React.useState(formatBudget(routing.budget?.maxUsd));
  React.useEffect(() => setBudgetText(formatBudget(routing.budget?.maxUsd)), [routing.budget?.maxUsd]);
  const budget = parseBudget(budgetText);
  const est = estimateRunUsd(routing, ratesFor(instances));
  const builders = routing.workers?.length ?? 0;

  const role = (r: TeamRole, extra?: React.ReactNode, remove?: () => void) => {
    const sel = teamRoleSelection(routing, r) ?? lead;
    const copy = TEAM_ROLE_COPY[r];
    const phase = r === "architect" ? "plan" : r === "builder" ? "build" : r === "verifier" ? "verify" : null;
    return (
      <div key={r} className="cv2-team-role" data-role={r}>
        <button type="button" className="cv2-team-role-main" onClick={() => onPickRole(ROLE_TAB[r])} aria-label={`${copy.name}: ${modelLabel(instances, sel)}. Change`}>
          <span className="who">
            <span className="n">
              {copy.name}
              {phase && <span className="ph">{TEAM_PHASE_LABELS[phase]}</span>}
            </span>
            <span className="d">{copy.duty}</span>
          </span>
          <RoleModel instances={instances} selection={sel} />
          <Glyph name="chevron-right" size={14} className="cv2-mute" />
        </button>
        {extra}
        {remove && (
          <button type="button" className="cv2-ctl icon" aria-label={`Remove the ${copy.name.toLowerCase()}`} onClick={remove}>
            <Glyph name="close" size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <ComposerPopover open={open} onClose={onClose} width={460} align="left" offset={0} label="Team" anchorRef={anchorRef} className="cv2-team-pop">
      <div className="cv2-team-head">
        <Segmented<TeamPreset>
          id="cv2-team-preset"
          label="Team preset"
          value={preset}
          options={TEAM_PRESETS.map((p) => ({ value: p, label: TEAM_PRESET_COPY[p].label }))}
          onChange={(p) => onChange(withTeamPreset({ ...routing, orchestrator: lead }, p))}
        />
        <p className="cv2-team-line">{TEAM_PRESET_COPY[preset].line}</p>
      </div>
      <div className="cv2-pop-body">
        {preset === "solo" && (
          <div className="cv2-team-role" data-role="lead">
            <button type="button" className="cv2-team-role-main" onClick={() => onPickRole("lead")}>
              <span className="who">
                <span className="n">Lead</span>
                <span className="d">Plans, builds and checks on the composer&apos;s model</span>
              </span>
              <RoleModel instances={instances} selection={lead} />
              <Glyph name="chevron-right" size={14} className="cv2-mute" />
            </button>
          </div>
        )}
        {preset === "plan-build-verify" && (
          <>
            {role("architect")}
            {role("builder", <Stepper value={builders} min={BUILDERS_MIN} max={BUILDERS_MAX} label="Builders" onChange={(n) => onChange(withBuilderCount(routing, n))} />)}
            {role("verifier")}
            {routing.explorer ? (
              role("explorer", undefined, () => onChange(withTeamRole(routing, "explorer", undefined)))
            ) : (
              <button type="button" className="cv2-mi cv2-team-add" onClick={() => onChange(withTeamRole(routing, "explorer", lead))}>
                <Glyph name="plus" size={16} />
                <span>Add an explorer</span>
                <span className="cv2-mute">maps the code first, read-only</span>
              </button>
            )}
          </>
        )}
        {preset === "best-of-n" && (
          <>
            {(routing.workers ?? []).map((w, i) => (
              <div key={i} className="cv2-team-role" data-role="candidate">
                <button type="button" className="cv2-team-role-main" onClick={() => onPickRole(`candidate:${i}`)}>
                  <span className="who">
                    <span className="n">Candidate {String.fromCharCode(65 + i)}</span>
                  </span>
                  <RoleModel instances={instances} selection={w} />
                  <Glyph name="chevron-right" size={14} className="cv2-mute" />
                </button>
              </div>
            ))}
            {builders < CANDIDATES_MAX && (
              <button type="button" className="cv2-mi cv2-team-add" onClick={() => onChange(withCount(routing, builders + 1))}>
                <Glyph name="plus" size={16} />
                <span>Add a candidate</span>
              </button>
            )}
            {builders > CANDIDATES_MIN && (
              <button type="button" className="cv2-mi cv2-team-add" onClick={() => onChange(withCount(routing, builders - 1))}>
                <Glyph name="minus" size={16} />
                <span className="cv2-mute">Remove the last candidate</span>
              </button>
            )}
          </>
        )}
      </div>
      {preset !== "solo" && (
        <div className="cv2-pop-foot">
          <span>Stop at</span>
          <input
            className="cv2-budget"
            value={budgetText}
            inputMode="decimal"
            aria-label="Budget cap in dollars"
            aria-invalid={budget === null}
            placeholder="No cap"
            onChange={(e) => setBudgetText(e.target.value)}
            onBlur={() => {
              const b = parseBudget(budgetText);
              if (b === null) return;
              onChange(withBudget(routing, b));
            }}
          />
          <span>of Alevr spend</span>
          <span className="cv2-grow" />
          <span className="cv2-tnum" title={est.subscriptionRoles ? "Roles on a subscription count against that plan, not this budget." : "Based on typical token use per role"}>
            {est.usd > 0 ? `≈ ${formatUsd(est.usd)} a run` : est.subscriptionRoles || est.byokRoles ? "Billed to your plans" : ""}
          </span>
        </div>
      )}
    </ComposerPopover>
  );
}

/**
 * The composer's single insertion point: the chip, its editor, the project
 * default and ⇧⌘O. `popover` / `setPopover` are the composer's own, so the
 * editor closes when another popover opens.
 */
export function ComposerTeam({
  routing,
  lead,
  instances,
  scope,
  fresh,
  setRouting,
  popover,
  setPopover,
  onPickRole,
  anchorRef,
}: {
  routing: RoleRouting;
  lead: ModelSelection;
  instances: readonly ProviderInstance[];
  scope: TeamScope;
  /** A thread with no messages yet starts from the project's last team. */
  fresh: boolean;
  setRouting: (r: RoleRouting) => void;
  popover: string | null;
  setPopover: (p: "team" | null) => void;
  onPickRole: (tab: RoleTab) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const save = useTeamDefault(routing, lead, scope, fresh, setRouting);
  const open = popover === "team";
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
      <TeamChip routing={routing} open={open} onToggle={() => setPopover(open ? null : "team")} />
      <TeamEditor open={open} onClose={() => setPopover(null)} instances={instances} routing={routing} lead={lead} onChange={save} onPickRole={onPickRole} anchorRef={anchorRef} />
    </>
  );
}
