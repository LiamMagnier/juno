"use client";

/**
 * Settings for Code (TARGET §11). Settings take the sidebar's place, with a
 * Back row, the panes in a quiet list, and the pane itself on the canvas
 * under a "Settings / Connections" breadcrumb.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (settings replacing the sidebar; grouped cards of two-line rows with the
 * control at the right).
 *
 * Explanations live here and only here: role duties, what each permission
 * does, what the work-log levels show. The composer's menus keep one line.
 */
import * as React from "react";
import type { ModelSelection, ProviderInstance, RoleRouting, RuntimeMode } from "@/lib/code-v2/contracts";
import { COMMAND_TITLES, DEFAULT_KEYBINDINGS } from "@/lib/code-v2/keymap";
import { ROLE_COPY, formatBudget, parseBudget } from "@/lib/code-v2/orchestrate";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, type DetailLevel } from "@/lib/code-v2/turns";
import { ConnectionsPanel, type ConnectionsProps } from "./connections";
import { EFFORT_LABELS, RUNTIME_MODES, effectiveEffort, modelLabel } from "./model-info";
import { DrawCheck, Glyph, Kbd, useIsMac } from "./primitives";

export type SettingsPane = "general" | "connections" | "orchestration" | "permissions" | "keyboard";

const PANES: { id: SettingsPane; label: string; glyph: string }[] = [
  { id: "general", label: "General", glyph: "settings" },
  { id: "connections", label: "Connections", glyph: "plug" },
  { id: "orchestration", label: "Orchestration", glyph: "agents" },
  { id: "permissions", label: "Permissions", glyph: "shield" },
  { id: "keyboard", label: "Keyboard", glyph: "keyboard" },
];

export function SettingsSidebar({ pane, onPane, onBack }: { pane: SettingsPane; onPane: (p: SettingsPane) => void; onBack: () => void }) {
  return (
    <nav className="cv2-side" aria-label="Settings">
      <div className="cv2-side-top">
        <span className="cv2-m">Settings</span>
      </div>
      <div className="cv2-side-scroll" style={{ paddingTop: 2 }}>
        {PANES.map((p) => (
          <button key={p.id} type="button" className="cv2-nav" aria-current={pane === p.id ? "page" : undefined} onClick={() => onPane(p.id)} style={pane === p.id ? { background: "hsl(var(--sidebar-selected))" } : undefined}>
            <Glyph name={p.glyph} />
            <span className="cv2-grow">{p.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="cv2-nav" onClick={onBack} style={{ flex: "none" }}>
        <Glyph name="arrow-left" />
        <span className="cv2-grow">Back</span>
      </button>
    </nav>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      {title && <h2 className="cv2-msect" style={{ padding: "0 2px 8px", height: "auto", margin: 0, fontWeight: 400 }}>{title}</h2>}
      <div className="cv2-set-card">{children}</div>
    </section>
  );
}

function Row({ title, sub, control, onClick, checked }: { title: React.ReactNode; sub?: React.ReactNode; control?: React.ReactNode; onClick?: () => void; checked?: boolean }) {
  const body = (
    <>
      <span className="cv2-grow" style={{ minWidth: 0 }}>
        <span className="block">{title}</span>
        {sub && <span className="block cv2-small cv2-mute" style={{ marginTop: 2 }}>{sub}</span>}
      </span>
      {control}
      {checked !== undefined && <span style={{ width: 16, flex: "none" }}>{checked ? <DrawCheck /> : null}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="cv2-set-row" role={checked !== undefined ? "radio" : undefined} aria-checked={checked} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="cv2-set-row">{body}</div>
  );
}

export function SettingsContent({
  pane,
  connections,
  instances,
  routing,
  lead,
  onRouting,
  runtimeMode,
  onRuntimeMode,
  detail,
  onDetail,
}: {
  pane: SettingsPane;
  connections: ConnectionsProps;
  instances: readonly ProviderInstance[];
  routing: RoleRouting;
  lead: ModelSelection;
  onRouting?: (r: RoleRouting) => void;
  runtimeMode: RuntimeMode;
  onRuntimeMode?: (m: RuntimeMode) => void;
  detail: DetailLevel;
  onDetail: (d: DetailLevel) => void;
}) {
  const mac = useIsMac();
  const [budget, setBudget] = React.useState(formatBudget(routing.budget?.maxUsd));
  const model = (sel?: ModelSelection) => {
    if (!sel) return "None";
    const e = effectiveEffort(instances, sel);
    return `${modelLabel(instances, sel)}${e && e !== "none" ? ` · ${EFFORT_LABELS[e]}` : ""}`;
  };
  const title = PANES.find((p) => p.id === pane)?.label;
  return (
    <div className="cv2-page">
      <div className="inner" style={{ maxWidth: pane === "connections" ? 880 : 680 }}>
        <h1 className="cv2-sr">{title}</h1>
        {pane === "connections" && <ConnectionsPanel {...connections} embedded />}
        {pane === "general" && (
          <Group title="Work log">
            {DETAIL_LEVELS.map((d) => (
              <Row key={d} title={DETAIL_LEVEL_LABELS[d].label} sub={DETAIL_LEVEL_LABELS[d].description} checked={d === detail} onClick={() => onDetail(d)} />
            ))}
          </Group>
        )}
        {pane === "orchestration" && (
          <>
            <p className="cv2-note">Defaults for every new team run. Change them for one run from the composer.</p>
            <Group title="Team">
              <Row title={ROLE_COPY.lead.name} sub={ROLE_COPY.lead.duty} control={<span className="cv2-mute">{model(lead)}</span>} />
              <Row title={ROLE_COPY.workers.name} sub={ROLE_COPY.workers.duty.replace("{n}", String(routing.workers?.length ?? 3))} control={<span className="cv2-mute">{model(routing.workers?.[0])}</span>} />
              <Row title={ROLE_COPY.reviewer.name} sub={ROLE_COPY.reviewer.duty} control={<span className="cv2-mute">{model(routing.reviewer)}</span>} />
              <Row title={ROLE_COPY.explorer.name} sub={ROLE_COPY.explorer.duty} control={<span className="cv2-mute">{model(routing.explorer)}</span>} />
              <Row title="Titles and compaction" sub="Names sessions and summarises old turns" control={<span className="cv2-mute">{model(routing.compaction ?? lead)}</span>} />
            </Group>
            <Group title="Budget">
              <Row
                title="Stop a run at"
                sub="Counts Alevr spend only. Roles on a subscription count against that plan; roles on your own keys are billed by the lab."
                control={
                  <input
                    className="cv2-budget"
                    style={{ height: 28, width: 84 }}
                    value={budget}
                    inputMode="decimal"
                    aria-label="Budget in dollars"
                    aria-invalid={parseBudget(budget) === null}
                    placeholder="No limit"
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={() => {
                      const b = parseBudget(budget);
                      if (b !== null) onRouting?.({ ...routing, budget: { ...routing.budget, maxUsd: b } });
                    }}
                  />
                }
              />
            </Group>
          </>
        )}
        {pane === "permissions" && (
          <Group title="New sessions start with">
            {RUNTIME_MODES.map((m) => (
              <Row key={m.mode} title={m.label} sub={m.description} checked={m.mode === runtimeMode} onClick={() => onRuntimeMode?.(m.mode)} />
            ))}
          </Group>
        )}
        {pane === "keyboard" && (
          <Group>
            {DEFAULT_KEYBINDINGS.filter((b) => !b.command.startsWith("hunk.accept")).map((b) => (
              <Row key={`${b.key}:${b.command}`} title={COMMAND_TITLES[b.command] ?? b.command} control={<Kbd k={b.key} mac={mac} />} />
            ))}
          </Group>
        )}
      </div>
    </div>
  );
}

