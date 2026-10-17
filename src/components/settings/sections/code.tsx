"use client";
import * as React from "react";
import "@/components/code/v2/code-v2.css";
import { SettingsContent, GenerationModelsGroup, CodeKeyboardGroup, Group, Row, type SettingsPane } from "@/components/code/v2/settings";
import { codeSettingsBridge, type CodeSettingsState } from "@/components/code/v2/settings-bridge";
import { useCodePrefs } from "@/components/code/v2/use-code-prefs";
import { RUNTIME_MODES } from "@/components/code/v2/model-info";
import type { RolePreset } from "@/lib/code-v2/contracts";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, type DetailLevel } from "@/lib/code-v2/turns";
import { PRESET_LABELS, PRESET_SENTENCES, formatBudget, parseBudget } from "@/lib/code-v2/orchestrate";
import { TEAM_PRESETS, TEAM_PRESET_COPY, type TeamPreset } from "@/lib/code-v2/team";

/*
 * CODE IN SETTINGS, WITH OR WITHOUT A SESSION OPEN.
 *
 * These sections used to read only `codeSettingsBridge`, which the open Code
 * workspace publishes and clears on unmount. Settings is its own route, so
 * from anywhere but an open session three of them were permanent dead ends
 * ("Open a Code session…"). Now each edits the ACCOUNT's defaults
 * (src/lib/code-v2/code-prefs.ts, /api/code/prefs), which every new session
 * starts from on every device, and, when a session is open behind the
 * settings sheet, adds a "This session" group for its own live values. The
 * bridge is kept only for those live overrides.
 */

const DETAIL_KEY = "alevr.code.detailLevel";

const WORK_LOG_NOTE = "How much of each turn's work the thread shows. A session's own menu changes it on this device.";
const ACCESS_NOTE = "Where a new session's access starts. A project remembers its own last choice, and that wins.";
const SESSION_ACCESS_NOTE = "The open session's access, applied at once.";
const TEAM_NOTE = "Who works on a new session's runs. A project remembers its last team, and that wins. Change it for one run from the composer.";
const BUDGET_NOTE = "Counts Alevr spend only. Roles on a subscription count against that plan; roles on your own keys are billed by the lab.";

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

function Loading() {
  return (
    <p className="cv2-note" role="status" aria-busy="true" style={{ marginTop: 16 }}>
      Loading your Code defaults…
    </p>
  );
}

function SessionDefaults() {
  const live = useLiveSession();
  const { prefs, update } = useCodePrefs();
  const [local, setLocal] = React.useState<DetailLevel | null>(null);
  React.useEffect(() => setLocal(readLocalDetail()), []);
  const shown: DetailLevel = live?.detail ?? local ?? prefs.detailLevel ?? "summary";
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
      <Group title="Work log" note={WORK_LOG_NOTE}>
        {DETAIL_LEVELS.map((d) => (
          <Row key={d} title={DETAIL_LEVEL_LABELS[d].label} sub={DETAIL_LEVEL_LABELS[d].description} checked={d === shown} onClick={() => choose(d)} />
        ))}
      </Group>
      <GenerationModelsGroup />
    </>
  );
}

function PermissionDefaults() {
  const live = useLiveSession();
  const { prefs, loaded, update } = useCodePrefs();
  const chosen = prefs.runtimeMode ?? "auto-edit";
  return (
    <>
      <Group title="New sessions start with" note={ACCESS_NOTE}>
        {RUNTIME_MODES.map((m) => (
          <Row key={m.mode} title={m.label} sub={m.description} checked={m.mode === chosen} onClick={() => void update({ runtimeMode: m.mode })} />
        ))}
      </Group>
      {!loaded && <Loading />}
      {live?.onRuntimeMode && (
        <Group title="This session" note={SESSION_ACCESS_NOTE}>
          {RUNTIME_MODES.map((m) => (
            <Row key={m.mode} title={m.label} sub={m.description} checked={m.mode === live.runtimeMode} onClick={() => live.onRuntimeMode?.(m.mode)} />
          ))}
        </Group>
      )}
    </>
  );
}

function AgentDefaults() {
  const live = useLiveSession();
  const { prefs, loaded, update } = useCodePrefs();
  const preset: RolePreset = prefs.team?.preset ?? "solo";
  const [budget, setBudget] = React.useState(formatBudget(prefs.team?.maxUsd));
  React.useEffect(() => setBudget(formatBudget(prefs.team?.maxUsd)), [prefs.team?.maxUsd]);
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
  return (
    <>
      <Group title="New sessions start with" note={TEAM_NOTE}>
        {/* The composer's team editor offers these three; a default set elsewhere (Lead + workers) still shows. */}
        {(TEAM_PRESETS as readonly RolePreset[]).concat((TEAM_PRESETS as readonly RolePreset[]).includes(preset) ? [] : [preset]).map((p) => (
          <Row
            key={p}
            title={p in TEAM_PRESET_COPY ? TEAM_PRESET_COPY[p as TeamPreset].label : PRESET_LABELS[p]}
            sub={p in TEAM_PRESET_COPY ? TEAM_PRESET_COPY[p as TeamPreset].line : PRESET_SENTENCES[p]}
            checked={p === preset}
            onClick={() => choosePreset(p)}
          />
        ))}
      </Group>
      <Group title="Budget" note={BUDGET_NOTE}>
        <Row
          title="Stop a team run at"
          sub={preset === "solo" ? "Applies when a session runs as a team." : undefined}
          control={
            <input
              className="cv2-budget"
              style={{ height: 28, width: 84 }}
              value={budget}
              inputMode="decimal"
              aria-label="Default budget in dollars"
              aria-invalid={parseBudget(budget) === null}
              placeholder="No limit"
              onChange={(e) => setBudget(e.target.value)}
              onBlur={saveBudget}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
          }
        />
      </Group>
      {!loaded && <Loading />}
      {live && (
        <section style={{ marginTop: 32 }}>
          <h2 className="cv2-msect" style={{ padding: "0 2px 0", height: "auto", margin: 0, fontWeight: 500 }}>
            This session
          </h2>
          <SettingsContent {...live} pane="orchestration" embedded />
        </section>
      )}
    </>
  );
}

function CodeSection({ pane }: { pane: SettingsPane }) {
  return (
    <div className="cv2">
      {pane === "general" ? <SessionDefaults /> : pane === "permissions" ? <PermissionDefaults /> : pane === "orchestration" ? <AgentDefaults /> : null}
    </div>
  );
}

export function CodeSessionSection() { return <CodeSection pane="general" />; }
export function CodeAgentSection() { return <CodeSection pane="orchestration" />; }
export function CodePermissionsSection() { return <CodeSection pane="permissions" />; }
export function CodeKeyboardSection() { return <div className="cv2"><CodeKeyboardGroup /></div>; }
