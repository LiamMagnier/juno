"use client";
import * as React from "react";
import "@/components/code/v2/code-v2.css";
import { SettingsContent } from "@/components/code/v2/settings";
import { codeSettingsBridge, type CodeSettingsState } from "@/components/code/v2/settings-bridge";
import { useCodePrefs } from "@/components/code/v2/use-code-prefs";
import { RUNTIME_MODES } from "@/components/code/v2/model-info";
import { Input } from "@/components/ui/input";
import { ChoiceMenu } from "@/components/settings/choice-menu";
import { SettingRow, SettingRowSkeleton, SettingsGroup } from "@/components/settings/setting-row";
import { CodeConnectionsGroups } from "@/components/settings/sections/connections";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import type { RolePreset, RuntimeMode } from "@/lib/code-v2/contracts";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, type DetailLevel } from "@/lib/code-v2/turns";
import { PRESET_LABELS, PRESET_SENTENCES, formatBudget, parseBudget } from "@/lib/code-v2/orchestrate";
import { TEAM_PRESETS, TEAM_PRESET_COPY, type TeamPreset } from "@/lib/code-v2/team";
import {
  GENERATION_KINDS,
  GENERATION_KIND_LABELS,
  GENERATION_MODELS_COPY,
  generationModelOptions,
  generationOptionLabel,
  useGenerationModels,
} from "@/lib/code-v2/generation-models";
import { cn } from "@/lib/utils";

/*
 * CODE IN SETTINGS, WITH OR WITHOUT A SESSION OPEN.
 *
 * These sections used to read only `codeSettingsBridge`, which the open Code
 * workspace publishes and clears on unmount. Settings is its own route, so
 * from anywhere but an open session three of them were permanent dead ends
 * ("Open a Code session…"). Now each edits the ACCOUNT's defaults
 * (src/lib/code-v2/code-prefs.ts, /api/code/prefs), which every new session
 * starts from on every device, and, when a session is open behind the
 * settings sheet, adds a "This session (open now)" group for its own live
 * values. The bridge is kept only for those live overrides.
 *
 * THE SAME LANGUAGE AS EVERY OTHER SECTION. These four panes used to be drawn
 * with Code's own settings kit (caption-sized grey titles, edge-to-edge rules,
 * bare check-mark lists, a 28px budget box), so they read as a different
 * product inside the same window. They are SettingsGroups now: medium titles
 * over a note, inset hairlines, choices as radio rows on SettingRow's metrics,
 * the shared Input and the shared keycaps. Only the embedded live team view
 * (Code's own SettingsContent) keeps Code's kit, inside its `.cv2` scope.
 */

const DETAIL_KEY = "alevr.code.detailLevel";

const WORK_LOG_NOTE = "How much of each turn’s work the thread shows. A session’s own menu changes it on this device.";
const ACCESS_NOTE = "Where a new session’s access starts. A project remembers its own last choice, and that wins.";
const SESSION_ACCESS_NOTE = "The open session’s access, applied at once.";
const TEAM_NOTE = "Who works on a new session’s runs. A project remembers its last team, and that wins. Change it for one run from the composer.";
const BUDGET_NOTE = "Counts Alevr spend only. Roles on a subscription count against that plan; roles on your own keys are billed by the lab.";
const SESSION_TEAM_NOTE = "The team and budget of the session open behind settings, applied at once.";
const LIVE_TITLE = "This session (open now)";

function useLiveSession(): CodeSettingsState | null {
  return React.useSyncExternalStore(codeSettingsBridge.subscribe, codeSettingsBridge.get, () => null);
}

function readLocalDetail(): DetailLevel | null {
  try {
    const v = window.localStorage.getItem(DETAIL_KEY);
    return v && (DETAIL_LEVELS as readonly string[]).includes(v) ? (v as DetailLevel) : null;
  } catch {
    return null;
  }
}

/**
 * A group's choices while the account's defaults are still on their way:
 * placeholder rows on the rows' own metrics, as Subscriptions and API keys
 * draw theirs. The radios used to show the BUILT-IN defaults (Auto-edit,
 * Solo) and then flip to the saved ones, under a lone "Loading your Code
 * defaults…" line floating between two groups. The first group's
 * placeholder is the one status the section announces.
 */
function PendingRows({ count, announce = false }: { count: number; announce?: boolean }) {
  const rows = Array.from({ length: count }, (_, i) => <SettingRowSkeleton key={i} />);
  return announce ? (
    <div role="status" aria-label="Loading your Code defaults" className="divide-y divide-border/60">
      {rows}
    </div>
  ) : (
    <div className="divide-y divide-border/60">{rows}</div>
  );
}

/**
 * One choice from a short list whose options each need a sentence: the ARIA
 * radio pattern (one tab stop, arrows move and select) on SettingRow's own
 * metrics, with the radio mark Personalization's cards use at the right.
 *
 * The empty ring is drawn at foreground/50 (3.3:1 light, 4.5:1 dark): it is
 * the only mark that says "this is a choice", so it owes WCAG 1.4.11's 3:1.
 *
 * The keyboard ring is the row's own, not the global square outline: drawn
 * on an `::after` that reaches 8px into the card's padding on each side and
 * stops 4px short of the hairlines, on the house control radius. The row has
 * no inset of its own (its text sits on the card's edge, like SettingRow's),
 * so an outline on the button either ran into the hairlines and the card's
 * corners or, inset, onto the first letter and the radio mark.
 */
function RadioRows<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** The group's accessible name. */
  label: string;
  value: T;
  options: readonly { value: T; title: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const option = useRadioGroup(options, selectedIndex, (o) => onChange(o.value));
  return (
    <div role="radiogroup" aria-label={label} className="divide-y divide-border/60">
      {options.map((o, i) => {
        const checked = i === selectedIndex;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(o.value)}
            {...option(i)}
            className="group relative flex w-full items-center justify-between gap-x-8 py-4 text-left focus-visible:outline-none after:pointer-events-none after:absolute after:-inset-x-2 after:inset-y-1 after:rounded-control after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-foreground">{o.title}</span>
              {o.description && (
                <span className="mt-0.5 block max-w-[34rem] text-pretty text-ui text-muted-foreground">{o.description}</span>
              )}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-fast ease-out-soft",
                checked ? "border-foreground bg-foreground" : "border-foreground/50 group-hover:border-foreground/70"
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full bg-background transition-transform duration-base ease-out-soft",
                  checked ? "scale-100" : "scale-0"
                )}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

const RUNTIME_OPTIONS = RUNTIME_MODES.map((m) => ({ value: m.mode, title: m.label, description: m.description }));

/** The model Code uses when a run has to make an image, a video or music: one menu per kind. */
function GenerationModels() {
  const [chosen, setChosen] = useGenerationModels();
  const kinds = React.useMemo(
    () =>
      GENERATION_KINDS.map((kind) => ({
        kind,
        options: generationModelOptions(kind).map((m) => ({ value: m.id, label: generationOptionLabel(m) })),
      })).filter((k) => k.options.length > 0),
    []
  );
  return (
    <SettingsGroup title={GENERATION_MODELS_COPY.title} description={GENERATION_MODELS_COPY.description}>
      {kinds.map(({ kind, options }) => (
        <SettingRow
          key={kind}
          label={GENERATION_KIND_LABELS[kind]}
          wide
          control={
            <ChoiceMenu
              label={`${GENERATION_KIND_LABELS[kind]} model`}
              value={chosen[kind] ?? ""}
              options={options}
              onChange={(id) => setChosen(kind, id)}
              className="@[34rem]/pane:w-64"
            />
          }
        />
      ))}
    </SettingsGroup>
  );
}

function SessionDefaults() {
  const live = useLiveSession();
  const { prefs, loaded, update } = useCodePrefs();
  const [local, setLocal] = React.useState<DetailLevel | null>(null);
  React.useEffect(() => setLocal(readLocalDetail()), []);
  const shown: DetailLevel = live?.detail ?? local ?? prefs.detailLevel ?? "summary";
  // Known at once from the open session or this browser's own choice; else
  // it waits for the account's, rather than showing "summary" and flipping.
  const known = Boolean(live?.detail ?? local) || loaded;
  const choose = (d: DetailLevel) => {
    void update({ detailLevel: d });
    // This browser follows at once; the open session too.
    try {
      window.localStorage.setItem(DETAIL_KEY, d);
    } catch {
      /* per-browser convenience */
    }
    setLocal(d);
    live?.onDetail(d);
  };
  return (
    <>
      <SettingsGroup title="Work log" description={WORK_LOG_NOTE}>
        {known ? (
          <RadioRows
            label="Work log"
            value={shown}
            options={DETAIL_LEVELS.map((d) => ({ value: d, title: DETAIL_LEVEL_LABELS[d].label, description: DETAIL_LEVEL_LABELS[d].description }))}
            onChange={choose}
          />
        ) : (
          <PendingRows count={DETAIL_LEVELS.length} />
        )}
      </SettingsGroup>
      <GenerationModels />
    </>
  );
}

function PermissionDefaults() {
  const live = useLiveSession();
  const { prefs, loaded, update } = useCodePrefs();
  const chosen = prefs.runtimeMode ?? "auto-edit";
  return (
    <>
      <SettingsGroup title="Access" description={ACCESS_NOTE}>
        {loaded ? (
          <RadioRows<RuntimeMode>
            label="Access new sessions start with"
            value={chosen}
            options={RUNTIME_OPTIONS}
            onChange={(runtimeMode) => void update({ runtimeMode })}
          />
        ) : (
          <PendingRows count={RUNTIME_OPTIONS.length} announce />
        )}
      </SettingsGroup>
      {live?.onRuntimeMode && (
        <SettingsGroup title={LIVE_TITLE} description={SESSION_ACCESS_NOTE}>
          <RadioRows<RuntimeMode>
            label={LIVE_TITLE}
            value={live.runtimeMode}
            options={RUNTIME_OPTIONS}
            onChange={(mode) => live.onRuntimeMode?.(mode)}
          />
        </SettingsGroup>
      )}
    </>
  );
}

/**
 * The budget as typed: no "$", which the field's own prefix shows.
 *
 * In US dollars, said in the row's description and not converted to euros
 * like Plan & usage: a team budget is a Code setting, the composer's team
 * editor and the run that enforces it both count in dollars, and a figure
 * converted here would read differently from the same budget there.
 */
function budgetDraft(usd: number | undefined): string {
  return formatBudget(usd).replace(/^\$/, "");
}

function AgentDefaults() {
  const live = useLiveSession();
  const { prefs, loaded, update } = useCodePrefs();
  const preset: RolePreset = prefs.team?.preset ?? "solo";
  const [budget, setBudget] = React.useState(budgetDraft(prefs.team?.maxUsd));
  React.useEffect(() => setBudget(budgetDraft(prefs.team?.maxUsd)), [prefs.team?.maxUsd]);
  const choosePreset = (p: RolePreset) => {
    if (p === "solo" && prefs.team?.maxUsd === undefined) void update({ team: null });
    else void update({ team: { preset: p, ...(prefs.team?.maxUsd !== undefined ? { maxUsd: prefs.team.maxUsd } : {}) } });
  };
  const saveBudget = () => {
    const b = parseBudget(budget);
    if (b === null) return;
    if (b === prefs.team?.maxUsd) return;
    if (b === undefined) void update(preset === "solo" ? { team: null } : { team: { preset } });
    else void update({ team: { preset, maxUsd: b } });
  };
  const invalid = parseBudget(budget) === null;
  // The composer's team editor offers these three; a default set elsewhere (Lead + workers) still shows.
  const presets = (TEAM_PRESETS as readonly RolePreset[]).concat((TEAM_PRESETS as readonly RolePreset[]).includes(preset) ? [] : [preset]);
  return (
    <>
      <SettingsGroup title="Team" description={TEAM_NOTE}>
        {loaded ? (
          <RadioRows<RolePreset>
            label="Team new sessions start with"
            value={preset}
            options={presets.map((p) => ({
              value: p,
              title: p in TEAM_PRESET_COPY ? TEAM_PRESET_COPY[p as TeamPreset].label : PRESET_LABELS[p],
              description: p in TEAM_PRESET_COPY ? TEAM_PRESET_COPY[p as TeamPreset].line : PRESET_SENTENCES[p],
            }))}
            onChange={choosePreset}
          />
        ) : (
          <PendingRows count={TEAM_PRESETS.length} />
        )}
      </SettingsGroup>
      <SettingsGroup title="Budget" description={BUDGET_NOTE}>
        {/* The field waits too: typed into before the saved budget lands,
            it was overwritten by it. */}
        {!loaded ? (
          <PendingRows count={1} />
        ) : (
          <SettingRow
            label="Stop a team run at"
            htmlFor="code-team-budget"
            description={
              invalid ? (
                <span className="text-destructive-ink">Enter an amount in US dollars, or leave it empty for no limit.</span>
              ) : preset === "solo" ? (
                "In US dollars. Applies when a session runs as a team. Leave it empty for no limit."
              ) : (
                "In US dollars. Leave it empty for no limit."
              )
            }
            wide
            control={
              <div className="relative w-full @[34rem]/pane:w-32">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ui text-muted-foreground"
                >
                  $
                </span>
                <Input
                  id="code-team-budget"
                  value={budget}
                  inputMode="decimal"
                  aria-invalid={invalid}
                  aria-describedby="code-team-budget-unit"
                  placeholder="No limit"
                  onChange={(e) => setBudget(e.target.value)}
                  onBlur={saveBudget}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="pl-7 tabular-nums coarse:h-11"
                />
                <span id="code-team-budget-unit" className="sr-only">
                  In US dollars
                </span>
              </div>
            }
          />
        )}
      </SettingsGroup>
      {live && (
        // Code's own team view, in its own kit and scope: it is the live
        // session's, and it is drawn the same way inside the workspace.
        <section className="pt-10">
          <div className="pb-3">
            <h3 className="text-body font-medium text-foreground">{LIVE_TITLE}</h3>
            <p className="mt-1 max-w-[36rem] text-pretty text-ui text-muted-foreground">{SESSION_TEAM_NOTE}</p>
          </div>
          <div className="cv2">
            <SettingsContent {...live} pane="orchestration" embedded />
          </div>
        </section>
      )}
    </>
  );
}

/* Code's shortcuts are listed in Settings › General › Keyboard shortcuts,
   under its Code switch (settings/code-shortcuts.ts). "Code shortcuts" was a
   section of its own with a second "Everywhere" group that disagreed with
   Chat's. */

/**
 * Everything Code, in one section, as Claude's settings hold Claude Code:
 * what it runs on (the subscriptions your Mac signs in to, and your own API
 * keys), what a new session may do, who works on it and where a team run
 * stops, then how a session shows its work and the models it makes media
 * with.
 *
 * These were four rail rows (Connections, Session preferences, Agents,
 * Permissions), each one part of the same question. Their old ids open this
 * section (settings-sections.ts), which leads with what `connections` links
 * ("Use your own API key") come for.
 */
export function CodeSection() {
  return (
    <>
      <CodeConnectionsGroups />
      <PermissionDefaults />
      <AgentDefaults />
      <SessionDefaults />
    </>
  );
}
