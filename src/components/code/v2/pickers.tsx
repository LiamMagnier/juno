"use client";

/**
 * The composer's pickers (TARGET §8): small menus, not forms.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (ModelPickerContent / ModelListRow / ModelPickerSidebar: a 44 px provider
 * rail, a search field and two-line rows of model and source).
 *
 * - The model picker (380 wide): the rail lists the AI labs (as the web chat
 *   catalogue does), a hairline, one Subscriptions tile, then "+". A lab lists
 *   its models under "Alevr" ("$5 / $25 · 1M") and "Your <Lab> key" ("Your
 *   key · 200K"); Subscriptions lists each connected plan ("Included in your
 *   plan · 1M"). Only models that write code are listed: image, video and
 *   music models are chosen in Settings (picker-catalogue.ts). In a team run, tabs
 *   along the top pick whose model you are choosing: Lead, Workers, Reviewer,
 *   Explorer. The chip opens on the effort panel first (the chat's EffortPanel:
 *   the rung, Flash, reset, the model under it), and the model's name there
 *   leads to the catalogue; ⇧⌘M opens the catalogue directly. In a team run the
 *   catalogue keeps an Effort row for the role being edited. A footer row holds
 *   Context with the plan usage.
 * - Context opens the tier list inside the same popover: one row per tier with
 *   its size, rates and the next turn's estimate.
 * - The team popover: four role rows, a worker stepper, the budget. Role
 *   explanations live in Settings, not here.
 */
import * as React from "react";
import type { EffortLevel, ModelSelection, ProviderInstance, RoleRouting, SessionUsage } from "@/lib/code-v2/contracts";
import {
  CANDIDATES_MAX,
  CANDIDATES_MIN,
  WORKERS_MAX,
  WORKERS_MIN,
  estimateRunUsd,
  formatBudget,
  parseBudget,
  withCount,
  withRoleModel,
  type RoleSlot,
} from "@/lib/code-v2/orchestrate";
import { displayName, type FeatureFlags } from "@/lib/code-v2/providers-view";
import {
  CONNECT_SUBSCRIPTION,
  SUBSCRIPTIONS_TITLE,
  cycleTab,
  defaultTab,
  labTiles,
  searchCatalogue,
  tabGroups,
  tabKey,
  type PickerGroup,
  type PickerTab,
} from "@/lib/code-v2/picker-catalogue";
import { formatRate, formatReset, formatTokens, formatUsd, gaugeView, tierRows, tightestWindow, type TierRow } from "@/lib/code-v2/tier-view";
import { EFFORT_LABELS, currentTier, defaultSelection, effectiveEffort, effortLevelsOf, findInstance, findModel, modelLabel, ratesFor, shortLabel, tiersOf } from "./model-info";
import { ComposerPopover, DrawCheck, Glyph, ModelMark, Segmented, useIsMac } from "./primitives";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { EffortPanelContext, ReasoningSlider } from "@/components/chat/reasoning-slider";
import type { ReasoningEffort } from "@/types/chat";

// ── Words ────────────────────────────────────────────────────────────────────

/** "Your Claude plan", "Alevr", "Your Anthropic key". */
export function sourceName(instance: ProviderInstance | undefined): string {
  if (!instance) return "";
  if (instance.kind === "alevr") return "Alevr";
  if (instance.kind === "byok") return `Your ${displayName(instance).replace(/ key$/i, "")} key`;
  const vendor = instance.kind === "claude-agent" ? "Claude" : instance.kind === "codex" ? "ChatGPT" : displayName(instance);
  return `Your ${vendor} plan`;
}

/** The picker row's second line: source, rates when metered, the largest window. */
export function modelSourceLine(instance: ProviderInstance, modelId: string): string {
  const m = instance.models?.find((x) => x.id === modelId);
  const tiers = [...(m?.contextTiers ?? [])].sort((a, b) => a.tokens - b.tokens);
  const max = tiers.length ? formatTokens(tiers[tiers.length - 1].tokens) : undefined;
  const metered = instance.kind === "alevr" || instance.kind === "byok";
  const rates = metered && tiers[0] ? `${formatRate(tiers[0].inputPerMTok)} / ${formatRate(tiers[0].outputPerMTok)}` : undefined;
  return [sourceName(instance), rates, max].filter(Boolean).join(" · ");
}

/** Plan usage for the footer: "38% of 5-hour window, resets 20:33" or "$12.40 of $40 this month". */
export function usageLine(instance: ProviderInstance | undefined): string | undefined {
  if (!instance) return undefined;
  if (instance.kind === "alevr") {
    const m = instance.statusMessage?.match(/\$[\d.]+ of \$[\d.]+[^.]*/);
    return m ? m[0].replace(/ used/, "") : undefined;
  }
  const w = tightestWindow(instance.limits);
  if (!w || w.usedPct === undefined) return undefined;
  const label = /hour/i.test(w.label) ? `${w.label} window` : /week/i.test(w.label) ? "weekly window" : w.label;
  return `${Math.round(w.usedPct)}% of ${label}${w.resetsAt ? `, resets ${formatReset(w.resetsAt)}` : ""}`;
}

/** The composer's model trigger words: "Opus 5.5" and "High". */
export function triggerWords(instances: readonly ProviderInstance[], sel: ModelSelection): { model: string; effort?: string } {
  const e = effectiveEffort(instances, sel);
  return { model: shortLabel(instances, sel), effort: e && e !== "none" ? EFFORT_LABELS[e] : undefined };
}

/** Kept for callers of the old traits control. */
export function traitsLabel(instances: readonly ProviderInstance[], sel: ModelSelection): { effort?: string; tier?: string; fast: boolean } {
  const e = effectiveEffort(instances, sel);
  const t = currentTier(instances, sel);
  return { effort: e && e !== "none" ? EFFORT_LABELS[e] : undefined, tier: t ? formatTokens(t.tokens) : undefined, fast: !!sel.fast };
}

/** "Claude, ChatGPT and DeepSeek Harness". */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// ── Roles ────────────────────────────────────────────────────────────────────

export type RoleTab = "lead" | "architect" | "workers" | "reviewer" | "explorer" | `candidate:${number}`;

function slotOf(tab: RoleTab): RoleSlot {
  if (tab === "lead") return "orchestrator";
  if (tab.startsWith("candidate:")) return { candidate: Number(tab.split(":")[1]) };
  return tab as RoleSlot;
}

export function roleTabs(routing?: RoleRouting): { id: RoleTab; label: string }[] {
  if (!routing || routing.preset === "solo") return [];
  if (routing.preset === "best-of-n") return (routing.workers ?? []).map((_, i) => ({ id: `candidate:${i}` as RoleTab, label: String.fromCharCode(65 + i) }));
  // Team lane: Plan → Build → Verify names its roles for what they do.
  if (routing.preset === "plan-build-verify") {
    return [
      { id: "architect", label: "Architect" },
      { id: "workers", label: "Builders" },
      { id: "reviewer", label: "Verifier" },
      { id: "explorer", label: "Explorer" },
    ];
  }
  return [
    { id: "lead", label: "Lead" },
    { id: "workers", label: "Workers" },
    { id: "reviewer", label: "Reviewer" },
    { id: "explorer", label: "Explorer" },
  ];
}

export function roleSelection(routing: RoleRouting, tab: RoleTab, lead: ModelSelection): ModelSelection {
  if (tab === "lead") return lead;
  if (tab.startsWith("candidate:")) return routing.workers?.[Number(tab.split(":")[1])] ?? lead;
  if (tab === "workers") return routing.workers?.[0] ?? lead;
  if (tab === "architect") return routing.architect ?? lead;
  return (tab === "reviewer" ? routing.reviewer : routing.explorer) ?? lead;
}

// ── Context tiers (inside the picker) ───────────────────────────────────────

function TierList({
  instances,
  selection,
  threadTokens,
  onSelect,
  onCompactAndSwitch,
  onDone,
}: {
  instances: readonly ProviderInstance[];
  selection: ModelSelection;
  threadTokens: number;
  onSelect: (sel: ModelSelection) => void;
  onCompactAndSwitch?: (sel: ModelSelection) => void;
  onDone: () => void;
}) {
  const instance = findInstance(instances, selection.instanceId);
  const subscription = !!instance && instance.kind !== "alevr" && instance.kind !== "byok";
  const tiers = tiersOf(instances, selection);
  const rows = React.useMemo(
    () => tierRows({ tiers, threadTokens, selectedTokens: selection.contextTokens, subscription, cacheHitRatio: 0.6 }),
    [tiers, threadTokens, selection.contextTokens, subscription],
  );
  const [hover, setHover] = React.useState<number | null>(null);
  const [confirm, setConfirm] = React.useState<TierRow | null>(null);
  const tier = currentTier(instances, selection);
  const vendor = instance?.kind === "claude-agent" ? "Claude" : instance?.kind === "codex" ? "ChatGPT" : instance ? displayName(instance) : "";
  const pick = (r: TierRow) => {
    const next = { ...selection, contextTokens: r.tokens };
    if (r.compactsNow && !confirm) return setConfirm(r);
    if (r.compactsNow) onCompactAndSwitch?.(next);
    else onSelect(next);
    onDone();
  };
  const rateLine = (r: TierRow) => {
    if (subscription) return `Included in your ${vendor} plan`;
    if (hover !== null && rows[hover] === r && r.compactsNow) return r.compactsNowLine;
    return r.priceLine?.replace(" per million tokens", "");
  };
  return (
    <>
      <div className="cv2-pop-body" role="listbox" aria-label="Context windows">
        {rows.map((r, i) => (
          <button
            key={r.tokens}
            type="button"
            role="option"
            aria-selected={r.selected}
            className="cv2-mi two"
            data-active={hover === i}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onClick={() => pick(r)}
          >
            <span className="cv2-grow">
              <span className="block">
                {r.name} <span className="cv2-mute cv2-tnum">{r.windowLabel}</span>
              </span>
              <span className="l2">{rateLine(r)}</span>
            </span>
            {r.estimateUsd !== null && <span className="trail">≈ {formatUsd(r.estimateUsd)} next turn</span>}
            <span className="ck">{r.selected ? <DrawCheck /> : null}</span>
          </button>
        ))}
        {rows.length === 0 && <div className="cv2-mute" style={{ padding: "6px 14px 10px" }}>This model has one context window.</div>}
      </div>
      <div className="cv2-pop-foot">
        {confirm ? (
          <>
            <span className="cv2-grow">This thread is larger than {confirm.windowLabel}. Alevr compacts it first.</span>
            <button type="button" className="cv2-btn ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className="cv2-btn ink" onClick={() => pick(confirm)}>
              Compact and switch
            </button>
          </>
        ) : (
          <span className="cv2-tnum">
            This thread uses {formatTokens(threadTokens)}.
            {tier?.cachedInputPerMTok && !subscription ? ` Cached input ${formatRate(tier.cachedInputPerMTok)} per million.` : ""}
          </span>
        )}
      </div>
    </>
  );
}

// ── Model picker ─────────────────────────────────────────────────────────────

export function ModelPicker({
  open,
  onClose,
  instances,
  selection,
  flags,
  onSelect,
  onConnect,
  anchorRef,
  routing,
  onRouting,
  initialTab = "lead",
  initialView = "models",
  threadTokens = 0,
  onCompactAndSwitch,
  title = "Choose model",
  align = "left",
  offset = 0,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  selection: ModelSelection;
  flags?: FeatureFlags;
  onSelect: (sel: ModelSelection) => void;
  onConnect?: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** A team run: tabs pick whose model this is. */
  routing?: RoleRouting;
  onRouting?: (r: RoleRouting) => void;
  initialTab?: RoleTab;
  /** `effort`: the slider-first stage, falling back to the catalogue where the
   *  model has no choice of effort or a team run is picking per role. */
  initialView?: "effort" | "models" | "context";
  threadTokens?: number;
  onCompactAndSwitch?: (sel: ModelSelection) => void;
  title?: string;
  align?: "left" | "right";
  offset?: number;
}) {
  const mac = useIsMac();
  const labs = React.useMemo(() => labTiles(instances), [instances]);
  const tabs = onRouting ? roleTabs(routing) : [];
  const [tab, setTab] = React.useState<RoleTab>(initialTab);
  const editing = routing && tabs.length ? roleSelection(routing, tab, selection) : selection;
  const levels = effortLevelsOf(instances, editing).filter((l): l is ReasoningEffort => l !== "none");
  const effortStage = !tabs.length && levels.length >= 2 && !!findModel(instances, editing);
  const firstView = initialView === "effort" && !effortStage ? "models" : initialView;
  const [view, setView] = React.useState<"effort" | "models" | "context">(firstView);
  const [rail, setRail] = React.useState<PickerTab>(() => defaultTab(instances, editing));
  const [query, setQuery] = React.useState("");
  const [hi, setHi] = React.useState(0);
  React.useEffect(() => {
    if (open) {
      setTab(initialTab);
      setView(firstView);
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, initialTab, initialView]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the selection (and the role tab), not every instances refresh
  React.useEffect(() => setRail(defaultTab(instances, editing)), [editing.instanceId, editing.model, tab, open]);

  const commit = (sel: ModelSelection) => {
    if (routing && onRouting && tabs.length && tab !== "lead") onRouting(withRoleModel(routing, slotOf(tab), sel));
    else onSelect(sel);
  };
  const searching = query.trim().length > 0;
  const groups: PickerGroup[] = React.useMemo(
    () => (searching ? searchCatalogue(instances, query, flags) : tabGroups(instances, rail, flags)),
    [searching, instances, query, flags, rail],
  );
  const rows = groups.flatMap((g) => g.rows).map((r) => ({ instance: r.instance, id: r.model.id, label: r.model.label, line: r.line }));
  const connectRow = !searching && rail.type === "subscriptions" && rows.length === 0;
  const pickRail = (t: PickerTab) => (setRail(t), setQuery(""), setHi(0));
  const selectedIndex = rows.findIndex((r) => r.instance.id === editing.instanceId && r.id === editing.model);
  // Opening on the selection's tab lights its row, so Enter keeps it and arrows start from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the tab or the open state changes
  React.useEffect(() => setHi(Math.max(0, selectedIndex)), [tabKey(rail), open]);
  const choose = (inst: ProviderInstance, modelId: string) => {
    const m = inst.models?.find((x) => x.id === modelId);
    const keepEffort = editing.effort && m?.effortLevels?.includes(editing.effort) ? editing.effort : m?.defaultEffort;
    commit({ instanceId: inst.id, model: modelId, ...(keepEffort ? { effort: keepEffort } : {}) });
    if (!tabs.length) onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const modKey = mac ? e.metaKey : e.ctrlKey;
    if (modKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      setRail(cycleTab(instances, rail, e.key === "ArrowDown" ? 1 : -1));
      setHi(0);
      return;
    }
    if (view !== "models") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && connectRow) {
      e.preventDefault();
      onConnect?.();
    } else if (e.key === "Enter" && rows[hi]) {
      e.preventDefault();
      choose(rows[hi].instance, rows[hi].id);
    }
  };

  const effort = effectiveEffort(instances, editing);
  const editingModel = findModel(instances, editing);
  const tier = currentTier(instances, editing);
  const selInstance = findInstance(instances, editing.instanceId);
  const usage = usageLine(selInstance);

  return (
    <ComposerPopover open={open} onClose={onClose} width={380} align={align} offset={offset} label={title} anchorRef={anchorRef}>
      <div className="cv2-pop-grab" aria-hidden />
      <div onKeyDown={onKey} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        {tabs.length > 0 && view === "models" && (
          <div className="cv2-roles" role="tablist" aria-label="Role">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {view === "effort" && editingModel ? (
          <div style={{ padding: "14px 14px 12px" }}>
            <EffortPanelContext.Provider value={{ modelName: modelLabel(instances, editing), onOpenModels: () => setView("models") }}>
              <ReasoningSlider
                variant="panel"
                options={levels.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))}
                value={(effort && effort !== "none" ? effort : levels[0]) as ReasoningEffort}
                defaultValue={editingModel.defaultEffort && editingModel.defaultEffort !== "none" ? editingModel.defaultEffort : undefined}
                onChange={(l) => l && commit({ ...editing, effort: l })}
                fastMode={!!editing.fast}
                onFastModeChange={editingModel.supportsFast ? (v) => commit({ ...editing, fast: v }) : undefined}
              />
            </EffortPanelContext.Provider>
          </div>
        ) : view === "context" ? (
          <>
            <div className="cv2-pop-head">
              <button type="button" className="cv2-iconbtn" aria-label="Back to models" onClick={() => setView("models")}>
                <Glyph name="chevron-left" />
              </button>
              <span className="cv2-m">Context window</span>
              <span className="cv2-mute cv2-trunc cv2-small" style={{ marginLeft: "auto" }}>
                {modelLabel(instances, editing)}
              </span>
            </div>
            <TierList
              instances={instances}
              selection={editing}
              threadTokens={threadTokens}
              onSelect={commit}
              onCompactAndSwitch={onCompactAndSwitch}
              onDone={() => (initialView === "context" ? onClose() : setView("models"))}
            />
          </>
        ) : (
          <>
            <div className="cv2-picker" style={{ maxHeight: 320 }}>
              <div className="cv2-rail cv2-rail-split" role="tablist" aria-label="AI labs and subscriptions" aria-orientation="vertical">
                <div className="cv2-rail-labs">
                {labs.map((l) => {
                  const t: PickerTab = { type: "lab", lab: l.lab };
                  return (
                    <button key={l.lab} type="button" role="tab" aria-selected={!searching && tabKey(rail) === tabKey(t)} className="cv2-ri" title={l.name} aria-label={l.name} onClick={() => pickRail(t)}>
                      {l.lab === "openrouter" ? <Glyph name="globe" /> : <ProviderLogo provider={l.lab} className="shrink-0" />}
                    </button>
                  );
                })}
                </div>
                <div className="cv2-rail-foot">
                {labs.length > 0 && <span className="cv2-rail-sep" aria-hidden />}
                <button type="button" role="tab" aria-selected={!searching && rail.type === "subscriptions"} className="cv2-ri" title={SUBSCRIPTIONS_TITLE} aria-label={SUBSCRIPTIONS_TITLE} onClick={() => pickRail({ type: "subscriptions" })}>
                  <Glyph name="card" />
                </button>
                <button type="button" className="cv2-ri" title="Connect a subscription or add a key" aria-label="Connect a subscription or add a key" onClick={onConnect}>
                  <Glyph name="plus" />
                </button>
                </div>
              </div>
              <div className="cv2-picker-main">
                <label className="cv2-pop-search">
                  <Glyph name="search" size={16} />
                  <input autoFocus placeholder="Search models" value={query} onChange={(e) => (setQuery(e.target.value), setHi(0))} aria-label="Search models" />
                </label>
                <div className="cv2-pop-body">
                  <div key={searching ? "q" : tabKey(rail)} className="cv2-picker-list" role="listbox" aria-label={searching ? "Models" : rail.type === "subscriptions" ? SUBSCRIPTIONS_TITLE : labs.find((l) => rail.type === "lab" && l.lab === rail.lab)?.name ?? "Models"}>
                    {connectRow ? (
                      <button type="button" role="option" aria-selected={false} className="cv2-mrow" data-active onClick={onConnect}>
                        <span className="cv2-mrow-mark" aria-hidden>
                          <Glyph name="plus" size={14} />
                        </span>
                        <span className="cv2-grow">
                          <span className="nm cv2-trunc">{CONNECT_SUBSCRIPTION.title}</span>
                          <span className="l2 cv2-trunc">{CONNECT_SUBSCRIPTION.sub}</span>
                        </span>
                      </button>
                    ) : rows.length === 0 ? (
                      <div className="cv2-mute" style={{ padding: "8px 14px" }}>No models match.</div>
                    ) : (
                      (() => {
                        let i = -1;
                        return groups.map((g) => (
                          <div key={g.id} role="group" aria-label={g.title}>
                            <div className="cv2-pgroup" aria-hidden>
                              <span className="t">{g.title}</span>
                              {g.subscription && usageLine(g.subscription) && <span className="u cv2-trunc">{usageLine(g.subscription)}</span>}
                            </div>
                            {g.rows.map((r) => {
                              i += 1;
                              const idx = i;
                              const sel = r.instance.id === editing.instanceId && r.model.id === editing.model;
                              return (
                                <button key={`${r.instance.id}:${r.model.id}`} type="button" role="option" aria-selected={sel} className="cv2-mrow" data-active={idx === hi} onMouseEnter={() => setHi(idx)} onClick={() => choose(r.instance, r.model.id)}>
                                  <ModelMark modelId={r.model.id} instance={r.instance} />
                                  <span className="cv2-grow">
                                    <span className="nm cv2-trunc">{r.model.label}</span>
                                    <span className="l2 cv2-trunc cv2-tnum">{r.line}</span>
                                  </span>
                                  <span className="ck">{sel ? <DrawCheck /> : null}</span>
                                </button>
                              );
                            })}
                          </div>
                        ));
                      })()
                    )}
                  </div>
                </div>
              </div>
            </div>
            {findModel(instances, editing) && (
              <>
                {tabs.length > 0 && (
                <div className="cv2-pop-foot">
                  <span>Effort</span>
                  <span className="cv2-grow" />
                  {levels.length > 0 ? (
                    <Segmented
                      id={`picker-effort-${tab}`}
                      label="Effort"
                      value={(effort ?? levels[0]) as EffortLevel}
                      options={levels.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))}
                      onChange={(l) => commit({ ...editing, effort: l })}
                    />
                  ) : (
                    <span>Fixed for this model</span>
                  )}
                </div>
                )}
                <div className="cv2-pop-foot">
                  <span>Context</span>
                  {tier ? (
                    <button type="button" className="cv2-ctl" style={{ height: 24, padding: "0 6px", marginLeft: -4 }} onClick={() => setView("context")} aria-haspopup="listbox">
                      <span className="v cv2-tnum">{formatTokens(tier.tokens)}</span>
                      <Glyph name="chevron-right" size={12} className="chev" />
                    </button>
                  ) : (
                    <span>Fixed</span>
                  )}
                  <span className="cv2-grow" />
                  {usage && <span className="cv2-trunc">{usage}</span>}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ComposerPopover>
  );
}

// ── Team (Lead + workers) and Best of N ─────────────────────────────────────

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="cv2-stepper" role="group" aria-label={label} onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Glyph name="minus" size={12} />
      </button>
      <span className="n" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Glyph name="plus" size={12} />
      </button>
    </span>
  );
}

function roleSource(instances: readonly ProviderInstance[], sel: ModelSelection): string {
  const inst = findInstance(instances, sel.instanceId);
  if (!inst) return "";
  if (inst.kind === "alevr" || inst.kind === "byok") {
    const t = currentTier(instances, sel);
    return t ? `${formatRate(t.inputPerMTok)} / ${formatRate(t.outputPerMTok)}` : inst.kind === "alevr" ? "Alevr" : "Your key";
  }
  return inst.kind === "claude-agent" ? "Your plan" : inst.kind === "codex" ? "ChatGPT" : displayName(inst);
}

function roleModel(instances: readonly ProviderInstance[], sel: ModelSelection): string {
  const e = effectiveEffort(instances, sel);
  return `${modelLabel(instances, sel)}${e && e !== "none" ? ` · ${EFFORT_LABELS[e]}` : ""}`;
}

export function TeamPopover({
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
  lead: ModelSelection;
  onChange: (r: RoleRouting) => void;
  /** "›" on a role: the model picker on that role's tab. */
  onPickRole: (tab: RoleTab) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const [budgetText, setBudgetText] = React.useState(formatBudget(routing.budget?.maxUsd));
  React.useEffect(() => setBudgetText(formatBudget(routing.budget?.maxUsd)), [routing.budget?.maxUsd]);
  const budget = parseBudget(budgetText);
  const est = estimateRunUsd(routing, ratesFor(instances));
  const count = routing.workers?.length ?? 0;
  const best = routing.preset === "best-of-n";
  const row = (id: RoleTab, name: string, sel: ModelSelection | undefined, extra?: React.ReactNode) => (
    <button key={id} type="button" className="cv2-role" onClick={() => onPickRole(id)}>
      <span className="rn">{name}</span>
      <span className="rm">
        {extra}
        {sel ? roleModel(instances, sel) : "None"}
      </span>
      <span className="rs">{sel ? roleSource(instances, sel) : ""}</span>
      <Glyph name="chevron-right" size={14} className="cv2-mute" />
    </button>
  );
  return (
    <ComposerPopover open={open} onClose={onClose} width={460} align="left" offset={0} label={best ? "Best of N" : "Team"} anchorRef={anchorRef}>
      <div className="cv2-pop-grab" aria-hidden />
      <div className="cv2-pop-body">
        {best ? (
          <>
            {(routing.workers ?? []).map((w, i) => row(`candidate:${i}`, `Candidate ${String.fromCharCode(65 + i)}`, w))}
            {count < CANDIDATES_MAX && (
              <button type="button" className="cv2-mi" onClick={() => onChange(withCount(routing, count + 1))}>
                <Glyph name="plus" size={16} />
                <span className="cv2-mute">Add candidate</span>
              </button>
            )}
            {count > CANDIDATES_MIN && (
              <button type="button" className="cv2-mi" onClick={() => onChange(withCount(routing, count - 1))}>
                <Glyph name="minus" size={16} />
                <span className="cv2-mute">Remove the last candidate</span>
              </button>
            )}
          </>
        ) : (
          <>
            {row("lead", "Lead", lead)}
            {row(
              "workers",
              "Workers",
              routing.workers?.[0],
              <span style={{ marginRight: 6 }}>
                <Stepper value={count} min={WORKERS_MIN} max={WORKERS_MAX} label="Workers" onChange={(n) => onChange(withCount(routing, n))} />
              </span>,
            )}
            {row("reviewer", "Reviewer", routing.reviewer)}
            {row("explorer", "Explorer", routing.explorer)}
          </>
        )}
      </div>
      <div className="cv2-pop-foot">
        <span>Stop at</span>
        <input
          className="cv2-budget"
          value={budgetText}
          inputMode="decimal"
          aria-label="Budget in dollars"
          aria-invalid={budget === null}
          placeholder="No limit"
          onChange={(e) => setBudgetText(e.target.value)}
          onBlur={() => {
            const b = parseBudget(budgetText);
            if (b === null) return;
            onChange({ ...routing, budget: { ...routing.budget, maxUsd: b } });
          }}
        />
        <span>of Alevr spend</span>
        <span className="cv2-grow" />
        <span className="cv2-tnum" title={est.subscriptionRoles ? "Roles on a subscription count against that plan, not this budget." : "Based on typical token use per role"}>
          ≈ {formatUsd(est.usd)} a run
        </span>
      </div>
    </ComposerPopover>
  );
}

// ── Context ring (only past 60% of the window) ──────────────────────────────

export function ContextRing({ usage, onOpen, expanded }: { usage?: SessionUsage; onOpen: () => void; expanded?: boolean }) {
  const view = gaugeView(usage);
  if (view.fraction <= 0.6) return null;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <button type="button" className="cv2-ring" aria-label={`Context: ${view.usedLabel}`} title={`Context ${view.usedLabel}. ${view.compactsLine ?? ""}`} aria-expanded={expanded} onClick={onOpen}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={`${c * view.fraction} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
      </svg>
      {/* The number makes the ring read as a gauge, never as a spinner. */}
      <span className="cv2-ring-n">{Math.round(view.fraction * 100)}%</span>
    </button>
  );
}

/** Instance lookups re-exported for the composer. */
export { defaultSelection };
