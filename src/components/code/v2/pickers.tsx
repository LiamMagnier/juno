"use client";

/**
 * The composer's popovers (DESIGN §5.7–§5.11; INTERACTION I-3, I-4, I-5,
 * I-15, I-16): the model picker with its provider-instance rail, the traits
 * menu, the context-window selector with its ruler and live price delta, the
 * Orchestrate role picker with its budget, the permissions menu, and the
 * context gauge with its hover card.
 */
import * as React from "react";
import { useReducedMotion, useSpring } from "framer-motion";
import type { EffortLevel, ModelSelection, ProviderInstance, RoleRouting, RolePreset, RuntimeMode, SessionUsage } from "@/lib/code-v2/contracts";
import { ROLE_PRESET_VALUES } from "@/lib/code-v2/contracts";
import {
  CANDIDATES_MAX,
  CANDIDATES_MIN,
  PRESET_LABELS,
  PRESET_SENTENCES,
  ROLE_COPY,
  WORKERS_MAX,
  WORKERS_MIN,
  estimateRunUsd,
  formatBudget,
  isSubscription,
  parseBudget,
  withCount,
  withPreset,
  withRoleModel,
  type RoleSlot,
} from "@/lib/code-v2/orchestrate";
import {
  cycleInstance,
  displayName,
  isConnected,
  isSubscriptionKind,
  pickerModels,
  railEntries,
  searchAllModels,
  statusSentence,
  type FeatureFlags,
} from "@/lib/code-v2/providers-view";
import {
  cachedTurnLine,
  estimateDelta,
  formatRate,
  formatTokens,
  formatUsd,
  gaugeView,
  rulerTicks,
  tierRows,
  wedgePath,
  windowLine,
  type TierRow,
} from "@/lib/code-v2/tier-view";
import {
  EFFORT_LABELS,
  RUNTIME_MODES,
  currentTier,
  defaultSelection,
  effectiveEffort,
  effortLevelsOf,
  findInstance,
  findModel,
  modelDescription,
  modelLabel,
  ratesFor,
  tiersOf,
} from "./model-info";
import { ComposerPopover, DrawCheck, Glyph, InstanceMark, Kbd, ModelMark, Segmented, useIsMac } from "./primitives";
import { cn } from "@/lib/utils";

// ── Model picker (⌘⇧M) ─────────────────────────────────────────────────────

export function ModelPicker({
  open,
  onClose,
  instances,
  selection,
  flags,
  onSelect,
  onOpenTier,
  onConnect,
  anchorRef,
  title = "Choose model",
  footer = true,
  align = "right",
  offset = 50,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  selection: ModelSelection;
  flags?: FeatureFlags;
  onSelect: (sel: ModelSelection) => void;
  onOpenTier?: () => void;
  onConnect?: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  title?: string;
  footer?: boolean;
  align?: "left" | "right";
  offset?: number;
}) {
  const mac = useIsMac();
  const entries = React.useMemo(() => railEntries(instances, flags), [instances, flags]);
  const [active, setActive] = React.useState(selection.instanceId);
  const [query, setQuery] = React.useState("");
  const [direction, setDirection] = React.useState(1);
  const [hi, setHi] = React.useState(0);
  const railRef = React.useRef<HTMLDivElement>(null);
  const [barY, setBarY] = React.useState(0);
  React.useEffect(() => {
    if (open) {
      setActive(selection.instanceId);
      setQuery("");
    }
  }, [open, selection.instanceId]);
  const instance = findInstance(instances, active) ?? entries[0]?.instance;
  const switchTo = (id: string) => {
    const from = entries.findIndex((e) => e.instance.id === active);
    const to = entries.findIndex((e) => e.instance.id === id);
    setDirection(to >= from ? 1 : -1);
    setActive(id);
    setHi(0);
  };
  React.useLayoutEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-rail="${CSS.escape(active)}"]`);
    if (el) setBarY(el.offsetTop + 9);
  }, [active, open, entries.length]);

  const searching = query.trim().length > 0;
  const results = searching ? searchAllModels(entries.map((e) => e.instance), query) : [];
  const models = instance && !searching ? pickerModels(instance) : [];
  const usable = instance ? isConnected(instance) || instance.kind === "alevr" : false;
  const rows: { instance: ProviderInstance; id: string; label: string }[] = searching
    ? results.map((r) => ({ instance: r.instance, id: r.model.id, label: r.model.label }))
    : usable && instance
      ? models.map((m) => ({ instance, id: m.id, label: m.label }))
      : [];

  const choose = (inst: ProviderInstance, modelId: string) => {
    const m = inst.models?.find((x) => x.id === modelId);
    const keepEffort = selection.effort && m?.effortLevels?.includes(selection.effort) ? selection.effort : m?.defaultEffort;
    onSelect({ instanceId: inst.id, model: modelId, ...(keepEffort ? { effort: keepEffort } : {}) });
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const modKey = mac ? e.metaKey : e.ctrlKey;
    if (modKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      switchTo(cycleInstance(entries, active, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && rows[hi]) {
      e.preventDefault();
      choose(rows[hi].instance, rows[hi].id);
    }
  };

  const selModel = findModel(instances, selection);
  const levels = effortLevelsOf(instances, selection).filter((l) => l !== "none");
  const effort = effectiveEffort(instances, selection);
  const tier = currentTier(instances, selection);
  const subs = entries.filter((e) => e.group !== "byok");
  const keys = entries.filter((e) => e.group === "byok");

  return (
    <ComposerPopover open={open} onClose={onClose} width={620} align={align} offset={offset} label={title} anchorRef={anchorRef}>
      <div className="cv2-picker" onKeyDown={onKey}>
        <div className="cv2-rail" ref={railRef} role="tablist" aria-label="Providers" aria-orientation="vertical">
          {subs.map((e) => (
            <button
              key={e.instance.id}
              data-rail={e.instance.id}
              type="button"
              role="tab"
              aria-selected={e.instance.id === active}
              className={cn("cv2-ri", e.dim && "dim")}
              title={e.tooltip}
              aria-label={e.tooltip}
              onClick={() => switchTo(e.instance.id)}
            >
              <InstanceMark instance={e.instance} size={18} />
            </button>
          ))}
          {keys.length > 0 && <span className="cv2-rail-sep" aria-hidden />}
          {keys.map((e) => (
            <button
              key={e.instance.id}
              data-rail={e.instance.id}
              type="button"
              role="tab"
              aria-selected={e.instance.id === active}
              className={cn("cv2-ri", e.dim && "dim")}
              title={e.tooltip}
              aria-label={e.tooltip}
              onClick={() => switchTo(e.instance.id)}
            >
              <Glyph name="key" />
            </button>
          ))}
          <button type="button" className="cv2-ri" title="Connect a provider" aria-label="Connect a provider" onClick={onConnect}>
            <Glyph name="plus" />
          </button>
          <span className="cv2-rail-bar" style={{ transform: `translateY(${barY}px)` }} aria-hidden />
        </div>
        <div className="cv2-picker-main">
          <label className="cv2-pop-search">
            <Glyph name="search" />
            <input autoFocus placeholder="Search models" value={query} onChange={(e) => (setQuery(e.target.value), setHi(0))} aria-label="Search models" />
            <span className="cv2-wide cv2-row" style={{ gap: 4 }}>
              <Kbd k="mod+shift+arrowup" mac={mac} />
              <span className="cv2-mute" style={{ fontSize: 11 }}>
                provider
              </span>
            </span>
          </label>
          <div className="cv2-pop-body">
            {!searching && instance && (
              <div key={`h-${instance.id}`} className="cv2-picker-list" style={{ ["--cv2-list-shift" as string]: `${direction * 4}px`, padding: "12px 16px 4px" }}>
                <div className="cv2-m" style={{ fontSize: 13.5 }}>
                  {displayName(instance)}
                </div>
                <div className={cn("cv2-mute", instance.status === "signed-out" && instance.account && "cv2-sig")}>{statusSentence(instance)}</div>
              </div>
            )}
            {!searching && instance && !usable ? (
              <div className="cv2-picker-fix">
                <span>
                  {instance.status === "not-installed"
                    ? `${displayName(instance)} is not installed on your Mac.`
                    : instance.status === "signed-out"
                      ? `Sign in to ${displayName(instance)} on your Mac to use it here.`
                      : instance.kind === "byok"
                        ? "Add or re-test this key in Connections."
                        : "Alevr could not start it. Re-check it in Connections."}
                </span>
                <button type="button" className="cv2-btn" onClick={onConnect}>
                  Open Connections
                </button>
              </div>
            ) : (
              <div key={`l-${searching ? "q" : instance?.id}`} className="cv2-picker-list" style={{ ["--cv2-list-shift" as string]: `${direction * 4}px` }} role="listbox" aria-label="Models">
                <div className="cv2-pop-sect">{searching ? `${rows.length} ${rows.length === 1 ? "model" : "models"}` : "Best for coding"}</div>
                {rows.length === 0 && <div className="cv2-mute" style={{ padding: "6px 16px" }}>No coding models match.</div>}
                {rows.map((r, i) => {
                  const sel = r.instance.id === selection.instanceId && r.id === selection.model;
                  const pm = r.instance.models?.find((m) => m.id === r.id);
                  const t = pm?.contextTiers?.length ? [...pm.contextTiers].sort((a, b) => a.tokens - b.tokens)[0] : undefined;
                  const sub = searching ? displayName(r.instance) : modelDescription(r.id);
                  const priced = r.instance.kind === "alevr" || r.instance.kind === "byok";
                  return (
                    <button
                      key={`${r.instance.id}:${r.id}`}
                      type="button"
                      role="option"
                      aria-selected={sel}
                      className="cv2-opt"
                      data-active={i === hi}
                      onMouseEnter={() => setHi(i)}
                      onClick={() => choose(r.instance, r.id)}
                      style={{ minHeight: 52 }}
                    >
                      <span className="ck">{sel && <DrawCheck />}</span>
                      <ModelMark modelId={r.id} instance={r.instance} />
                      <span className="cv2-grow">
                        <span className={cn("block cv2-trunc", sel && "cv2-m")} style={{ display: "block" }}>
                          {r.label}
                        </span>
                        {sub && <span className="sub block cv2-trunc" style={{ display: "block" }}>{sub}</span>}
                      </span>
                      <span className="meta">
                        {t
                          ? priced
                            ? `${formatRate(t.inputPerMTok)} / ${formatRate(t.outputPerMTok)}`
                            : // A plan prices nothing per token: show the largest window it offers (the Context control's ceiling).
                              formatTokens(Math.max(...(pm?.contextTiers ?? [t]).map((x) => x.tokens)))
                          : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {footer && selModel && (
            <div className="cv2-pop-foot">
              <span>Effort</span>
              {levels.length > 0 ? (
                <Segmented
                  id="picker-effort"
                  label="Effort"
                  value={(effort ?? levels[0]) as EffortLevel}
                  options={levels.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))}
                  onChange={(l) => onSelect({ ...selection, effort: l })}
                />
              ) : (
                <span className="cv2-faint">Fixed for this model</span>
              )}
              <span className="cv2-grow" />
              {tier && (
                <span className="cv2-row" style={{ gap: 8 }}>
                  <span>Context</span>
                  <button type="button" className="cv2-btn" onClick={onOpenTier} aria-haspopup="dialog">
                    {formatTokens(tier.tokens)} <Glyph name="chevron-down" size={12} />
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </ComposerPopover>
  );
}

// ── Traits (effort · speed · context) ──────────────────────────────────────

export function traitsLabel(instances: readonly ProviderInstance[], sel: ModelSelection): { effort?: string; tier?: string; fast: boolean } {
  const e = effectiveEffort(instances, sel);
  const t = currentTier(instances, sel);
  return { effort: e && e !== "none" ? EFFORT_LABELS[e] : undefined, tier: t ? formatTokens(t.tokens) : undefined, fast: !!sel.fast };
}

export function TraitsMenu({
  open,
  onClose,
  instances,
  selection,
  onSelect,
  onOpenTier,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  selection: ModelSelection;
  onSelect: (sel: ModelSelection) => void;
  onOpenTier: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const levels = effortLevelsOf(instances, selection);
  const effort = effectiveEffort(instances, selection);
  const model = findModel(instances, selection);
  const tier = currentTier(instances, selection);
  return (
    <ComposerPopover open={open} onClose={onClose} width={280} offset={50} label="Effort and context" anchorRef={anchorRef}>
      <div className="cv2-pop-body" style={{ paddingTop: 6 }} role="menu">
        {levels.length > 0 && <div className="cv2-pop-sect">Effort</div>}
        {levels.map((l) => (
          <button key={l} type="button" role="menuitemradio" aria-checked={l === effort} className="cv2-opt" onClick={() => onSelect({ ...selection, effort: l })}>
            <span className="ck">{l === effort && <DrawCheck />}</span>
            <span className="cv2-grow">{EFFORT_LABELS[l]}</span>
          </button>
        ))}
        {model?.supportsFast && (
          <>
            <div className="cv2-pop-sect">Speed</div>
            {[false, true].map((fast) => (
              <button key={String(fast)} type="button" role="menuitemradio" aria-checked={!!selection.fast === fast} className="cv2-opt" onClick={() => onSelect({ ...selection, fast })}>
                <span className="ck">{!!selection.fast === fast && <DrawCheck />}</span>
                <span className="cv2-grow">{fast ? "Fast" : "Standard"}</span>
                <span className="meta">{fast ? "higher price" : ""}</span>
              </button>
            ))}
          </>
        )}
        {tier && (
          <>
            <div className="cv2-pop-sect" style={{ borderTop: "1px solid hsl(var(--border))", marginTop: 6 }} />
            <button type="button" role="menuitem" className="cv2-opt" onClick={onOpenTier}>
              <span className="ck" />
              <span className="cv2-grow">Context window…</span>
              <span className="meta">{formatTokens(tier.tokens)}</span>
            </button>
          </>
        )}
      </div>
    </ComposerPopover>
  );
}

// ── Context-window selector (⌘⇧W) ──────────────────────────────────────────

export function TierPopover({
  open,
  onClose,
  instances,
  selection,
  threadTokens,
  onSelect,
  onCompactAndSwitch,
  onHoverDelta,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  selection: ModelSelection;
  threadTokens: number;
  onSelect: (sel: ModelSelection) => void;
  onCompactAndSwitch?: (sel: ModelSelection) => void;
  /** The muted delta the traits control previews while a row is hovered (I-16). */
  onHoverDelta?: (delta: string | null) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const instance = findInstance(instances, selection.instanceId);
  const subscription = instance ? isSubscriptionKind(instance.kind) : false;
  const tiers = tiersOf(instances, selection);
  const rows = React.useMemo(
    () => tierRows({ tiers, threadTokens, selectedTokens: selection.contextTokens, subscription, cacheHitRatio: 0.6 }),
    [tiers, threadTokens, selection.contextTokens, subscription],
  );
  const [hover, setHover] = React.useState<number | null>(null);
  const [confirm, setConfirm] = React.useState<TierRow | null>(null);
  React.useEffect(() => {
    if (!open) {
      setConfirm(null);
      setHover(null);
      onHoverDelta?.(null);
    }
  }, [open, onHoverDelta]);
  const current = rows.find((r) => r.selected) ?? rows[0];
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  const ticks = rulerTicks(rows);
  const hovered = hover !== null ? rows[hover] : undefined;
  const tier = currentTier(instances, selection);
  const pick = (r: TierRow) => {
    const next = { ...selection, contextTokens: r.tokens };
    if (r.compactsNow && !confirm) {
      setConfirm(r);
      return;
    }
    if (r.compactsNow) onCompactAndSwitch?.(next);
    else onSelect(next);
    setTimeout(onClose, 120);
  };
  const plan = instance?.limits?.[0];
  return (
    <ComposerPopover open={open} onClose={onClose} width={440} offset={50} label="Context window" anchorRef={anchorRef}>
      <div className="cv2-pop-head">
        {instance && <ModelMark modelId={selection.model} instance={instance} />}
        <span className="cv2-m">Context window</span>
        <span className="cv2-mute cv2-trunc">
          {modelLabel(instances, selection)} on {instance ? displayName(instance) : "Alevr"}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="cv2-ruler" aria-hidden>
          <span className="now cv2-tnum">This thread · {formatTokens(threadTokens)}</span>
          <span className="track" />
          <span className="used" style={{ width: "100%", transform: `scaleX(${Math.min(1, threadTokens / max)})` }} />
          {hovered && <span className="ghost" style={{ width: `${(hovered.tokens / max) * 100}%` }} />}
          {ticks.map((t, i) => (
            <React.Fragment key={t.label + i}>
              <span className="tick" style={{ left: `calc(${t.at * 100}% - 1px)` }} />
              <span className={cn("tl", t.at > 0.95 && "end")} style={{ left: `${t.at * 100}%` }}>
                {t.label}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="cv2-pop-body" role="listbox" aria-label="Context windows">
        {rows.map((r, i) => (
          <button
            key={r.tokens}
            type="button"
            role="option"
            aria-selected={r.selected}
            className="cv2-opt"
            data-active={hover === i}
            style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}
            onMouseEnter={() => {
              setHover(i);
              onHoverDelta?.(estimateDelta(r, current));
            }}
            onFocus={() => {
              setHover(i);
              onHoverDelta?.(estimateDelta(r, current));
            }}
            onMouseLeave={() => {
              setHover(null);
              onHoverDelta?.(null);
            }}
            onClick={() => pick(r)}
          >
            <span className="ck" style={{ marginTop: 2 }}>
              {r.selected && <DrawCheck />}
            </span>
            <span className="cv2-grow">
              <span className="block">
                <span className={cn(r.selected && "cv2-m")}>{r.name}</span> <span className="cv2-mute cv2-tnum">{r.windowLabel}</span>
              </span>
              <span className="sub block">{subscription ? `Uses your plan${plan ? ` · ${windowLine(plan)}` : ""}` : r.priceLine}</span>
              <span className={cn("sub block", r.compactsNow && "cv2-sig")}>{r.compactsNow ? r.compactsNowLine : r.deltaLine}</span>
            </span>
            {r.estimateUsd !== null && <span className="meta">≈ {formatUsd(r.estimateUsd)} next turn</span>}
          </button>
        ))}
        {rows.length === 0 && <div className="cv2-mute" style={{ padding: "6px 16px 10px" }}>This runtime offers one context window.</div>}
      </div>
      <div className="cv2-pop-foot" style={{ fontSize: 12, lineHeight: "16px" }}>
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
          <span>{subscription ? "Counts against your plan, not Alevr spend." : (cachedTurnLine(tier, threadTokens) ?? "Estimates use this thread's size.")}</span>
        )}
      </div>
    </ComposerPopover>
  );
}

/** "Claude, ChatGPT and DeepSeek Harness". */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// ── Orchestrate (⌘⇧O) ──────────────────────────────────────────────────────

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="cv2-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Glyph name="minus" size={14} />
      </button>
      <span className="n" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Glyph name="plus" size={14} />
      </button>
    </span>
  );
}

function roleSub(instances: readonly ProviderInstance[], sel: ModelSelection): string {
  const inst = findInstance(instances, sel.instanceId);
  if (!inst) return sel.instanceId;
  if (inst.kind === "alevr" || inst.kind === "byok") {
    const t = currentTier(instances, sel);
    const who = inst.kind === "alevr" ? "Alevr" : displayName(inst);
    return t ? `${who} · ${formatRate(t.inputPerMTok)} / ${formatRate(t.outputPerMTok)}` : who;
  }
  return inst.kind === "claude-agent" ? "Your subscription" : displayName(inst);
}

function RoleModelButton({
  instances,
  sel,
  onPick,
}: {
  instances: readonly ProviderInstance[];
  sel: ModelSelection;
  onPick: (anchor: HTMLElement) => void;
}) {
  const inst = findInstance(instances, sel.instanceId);
  const e = effectiveEffort(instances, sel);
  return (
    <button type="button" className="cv2-modelbtn" onClick={(ev) => onPick(ev.currentTarget)} aria-haspopup="dialog">
      <ModelMark modelId={sel.model} instance={inst} />
      <span className="cv2-trunc">
        <span className="block cv2-trunc">
          {modelLabel(instances, sel)}
          {e && e !== "none" ? ` · ${EFFORT_LABELS[e]}` : ""}
        </span>
        <span className="l2 block cv2-trunc">{roleSub(instances, sel)}</span>
      </span>
      <Glyph name="chevron-down" size={12} className="cv2-mute" />
    </button>
  );
}

export function OrchestratePopover({
  open,
  onClose,
  instances,
  routing,
  flags,
  onChange,
  onConnect,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  instances: readonly ProviderInstance[];
  routing: RoleRouting;
  flags?: FeatureFlags;
  onChange: (r: RoleRouting) => void;
  onConnect?: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const [slot, setSlot] = React.useState<RoleSlot | null>(null);
  const [budgetText, setBudgetText] = React.useState(formatBudget(routing.budget?.maxUsd));
  const [explorer, setExplorer] = React.useState(!!routing.explorer);
  const [utilityOpen, setUtilityOpen] = React.useState(false);
  React.useEffect(() => setBudgetText(formatBudget(routing.budget?.maxUsd)), [routing.budget?.maxUsd]);
  const budget = parseBudget(budgetText);
  const est = estimateRunUsd(routing, ratesFor(instances));
  const preset = routing.preset;
  const count = routing.workers?.length ?? 0;
  const slotSel = (s: RoleSlot): ModelSelection =>
    typeof s === "object" ? (routing.workers?.[s.candidate] ?? routing.orchestrator) : s === "workers" ? (routing.workers?.[0] ?? routing.orchestrator) : (routing[s] ?? routing.orchestrator);
  const subNames = [
    ...new Set(
      [routing.orchestrator, ...(routing.workers ?? []), routing.reviewer, routing.explorer]
        .filter((s): s is ModelSelection => !!s && isSubscription(s))
        .map((s) => {
          const i = findInstance(instances, s.instanceId);
          return i?.kind === "claude-agent" ? "Claude" : i?.kind === "codex" ? "ChatGPT" : i ? displayName(i) : "vendor";
        }),
    ),
  ];
  const row = (name: string, duty: string, s: RoleSlot, extra?: React.ReactNode) => (
    <div className="cv2-role" key={typeof s === "object" ? `c${s.candidate}` : s}>
      <span>
        <span className="block cv2-m">{name}</span>
        {duty && <span className="block cv2-mute" style={{ fontSize: 12, lineHeight: "16px" }}>{duty}</span>}
      </span>
      <span>{extra}</span>
      <RoleModelButton instances={instances} sel={slotSel(s)} onPick={() => setSlot(s)} />
    </div>
  );
  if (open && slot !== null) {
    // One popover at a time: the role's model picker replaces Orchestrate and returns to it.
    return (
      <ModelPicker
        open
        onClose={() => setSlot(null)}
        instances={instances}
        flags={flags}
        selection={slotSel(slot)}
        onConnect={onConnect}
        footer={false}
        align="left"
        offset={0}
        anchorRef={anchorRef}
        title="Choose a model for this role"
        onSelect={(sel) => onChange(withRoleModel(routing, slot, sel))}
      />
    );
  }
  return (
    <ComposerPopover open={open} onClose={onClose} width={600} align="left" offset={0} label="Orchestrate" anchorRef={anchorRef}>
      <div className="cv2-pop-head" style={{ paddingBottom: 4 }}>
        <span className="cv2-m">Orchestrate</span>
        <span className="cv2-grow" />
        <Segmented<RolePreset>
          id="orch-preset"
          label="Preset"
          value={preset}
          options={ROLE_PRESET_VALUES.map((p) => ({ value: p, label: PRESET_LABELS[p] }))}
          onChange={(p) => onChange(withPreset(routing, p))}
        />
      </div>
      <div className="cv2-mute" style={{ padding: "0 16px 8px" }}>
        {PRESET_SENTENCES[preset]}
      </div>
      <div className="cv2-pop-body" key={preset} style={{ animation: "cv2-fade var(--dur-mid) var(--cv2-ease) both" }}>
        {row(ROLE_COPY.lead.name, ROLE_COPY.lead.duty, "orchestrator")}
        {preset === "lead-workers" && (
          <>
            {row(
              ROLE_COPY.workers.name,
              ROLE_COPY.workers.duty.replace("{n}", String(count)),
              "workers",
              <Stepper value={count} min={WORKERS_MIN} max={WORKERS_MAX} label="Workers" onChange={(n) => onChange(withCount(routing, n))} />,
            )}
            {row(ROLE_COPY.reviewer.name, ROLE_COPY.reviewer.duty, "reviewer")}
            {explorer || routing.explorer ? (
              row(ROLE_COPY.explorer.name, ROLE_COPY.explorer.duty, "explorer")
            ) : (
              <div className="cv2-role">
                <span>
                  <span className="block cv2-m">{ROLE_COPY.explorer.name}</span>
                  <span className="block cv2-mute" style={{ fontSize: 12, lineHeight: "16px" }}>
                    {ROLE_COPY.explorer.duty}
                  </span>
                </span>
                <span />
                <button
                  type="button"
                  className="cv2-btn"
                  onClick={() => {
                    setExplorer(true);
                    onChange({ ...routing, explorer: routing.orchestrator });
                  }}
                >
                  Add an explorer
                </button>
              </div>
            )}
          </>
        )}
        {preset === "best-of-n" && (
          <>
            <div className="cv2-role">
              <span>
                <span className="block cv2-m">{ROLE_COPY.candidates.name}</span>
                <span className="block cv2-mute" style={{ fontSize: 12, lineHeight: "16px" }}>
                  Each runs in its own worktree. You pick one; the others are deleted.
                </span>
              </span>
              <Stepper value={Math.max(CANDIDATES_MIN, count)} min={CANDIDATES_MIN} max={CANDIDATES_MAX} label="Candidates" onChange={(n) => onChange(withCount(routing, n))} />
              <span />
            </div>
            {(routing.workers ?? []).map((_, i) => row(`Candidate ${String.fromCharCode(65 + i)}`, "", { candidate: i }))}
          </>
        )}
        {preset !== "solo" && (
          <>
            <button type="button" className="cv2-role" style={{ width: "calc(100% - 12px)", textAlign: "left" }} aria-expanded={utilityOpen} onClick={() => setUtilityOpen((v) => !v)}>
              <span className="cv2-row" style={{ gap: 6 }}>
                <Glyph name="chevron-right" size={14} className="cv2-mute" />
                <span>{ROLE_COPY.utility.name}</span>
              </span>
              <span />
              <span className="cv2-mute cv2-trunc" style={{ maxWidth: 220 }}>
                {modelLabel(instances, routing.compaction ?? routing.orchestrator)}
              </span>
            </button>
            {utilityOpen && row("Titles and compaction", "Names threads and summarises old turns", "compaction")}
          </>
        )}
      </div>
      <div className="cv2-pop-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
        <div className="cv2-row" style={{ gap: 8 }}>
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
          <span>of Alevr spend per run</span>
          <span className="cv2-grow" />
          <span className="cv2-tnum" title="Based on typical token use per role">
            ≈ {formatUsd(est.usd)} a run <span className="cv2-faint">estimate</span>
          </span>
        </div>
        {(est.subscriptionRoles || est.byokRoles) && (
          <div style={{ fontSize: 12, lineHeight: "16px" }}>
            {est.subscriptionRoles && `Subscription roles count against your ${listWords(subNames)} ${subNames.length > 1 ? "plans" : "plan"}, not this budget. `}
            {est.byokRoles && "Roles on your own keys are billed by the lab."}
          </div>
        )}
      </div>
    </ComposerPopover>
  );
}

// ── Permissions (runtime mode, ⌘⇧A) ────────────────────────────────────────

export function ModeMenu({
  open,
  onClose,
  mode,
  allowed,
  planMode,
  canPlan,
  onMode,
  onPlan,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  mode: RuntimeMode;
  allowed?: readonly RuntimeMode[];
  planMode: boolean;
  canPlan: boolean;
  onMode: (m: RuntimeMode) => void;
  onPlan: (on: boolean) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <ComposerPopover open={open} onClose={onClose} width={340} align="left" offset={0} label="Permissions" anchorRef={anchorRef}>
      <div className="cv2-pop-body" style={{ paddingTop: 6 }} role="menu">
        <div className="cv2-pop-sect">Permissions</div>
        {RUNTIME_MODES.map((m) => {
          const disabled = !!allowed?.length && !allowed.includes(m.mode);
          return (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === mode}
              aria-disabled={disabled}
              disabled={disabled}
              className="cv2-opt"
              style={{ alignItems: "flex-start" }}
              onClick={() => (onMode(m.mode), onClose())}
            >
              <span className="ck" style={{ marginTop: 2 }}>
                {m.mode === mode && <DrawCheck />}
              </span>
              <Glyph name={m.glyph} className="cv2-mute" />
              <span className="cv2-grow">
                <span className="block">{m.label}</span>
                <span className="sub block">{disabled ? "This runtime cannot enforce it." : m.description}</span>
              </span>
            </button>
          );
        })}
        {canPlan && (
          <>
            <div className="cv2-pop-sect">Mode</div>
            <button type="button" role="menuitemcheckbox" aria-checked={planMode} className="cv2-opt" style={{ alignItems: "flex-start" }} onClick={() => onPlan(!planMode)}>
              <span className="ck" style={{ marginTop: 2 }}>
                {planMode && <DrawCheck />}
              </span>
              <Glyph name="plan" className="cv2-mute" />
              <span className="cv2-grow">
                <span className="block">Plan first</span>
                <span className="sub block">Nothing changes until you approve the plan.</span>
              </span>
            </button>
          </>
        )}
      </div>
    </ComposerPopover>
  );
}

// ── Context gauge ───────────────────────────────────────────────────────────

export function ContextGauge({ usage, planLabel, onCompact }: { usage?: SessionUsage; planLabel?: string; onCompact?: () => void }) {
  const view = gaugeView(usage, planLabel);
  const [hover, setHover] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduce = useReducedMotion();
  const spring = useSpring(view.fraction, { stiffness: 260, damping: 34 });
  const [f, setF] = React.useState(view.fraction);
  React.useEffect(() => {
    if (reduce) {
      setF(view.fraction);
      return;
    }
    spring.set(view.fraction);
    return spring.on("change", (v) => setF(v));
  }, [view.fraction, spring, reduce]);
  const ref = React.useRef<HTMLDivElement>(null);
  const open = hover || pinned;
  React.useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setPinned(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);
  return (
    <div
      ref={ref}
      style={{ position: "relative" }}
      onMouseEnter={() => (timer.current = setTimeout(() => setHover(true), 150))}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setHover(false);
      }}
    >
      <button type="button" className="cv2-gauge" aria-label={`Context: ${view.usedLabel}`} aria-expanded={open} onClick={() => setPinned((p) => !p)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="hsl(var(--muted-foreground) / 0.55)" strokeWidth="1" />
          <path d={wedgePath(f)} fill={view.warn ? "hsl(var(--signal))" : "hsl(var(--muted-foreground))"} />
        </svg>
      </button>
      {open && (
        <div className="cv2-pop" style={{ width: 280, right: -8, padding: "12px 14px", gap: 8, ["--cv2-origin" as string]: "bottom right" }} role="dialog" aria-label="Context">
          <div className="cv2-row" style={{ gap: 8 }}>
            <span className="cv2-m">Context</span>
            <span className="cv2-grow" />
            <span className="cv2-mute cv2-tnum">{view.usedLabel}</span>
          </div>
          <span style={{ display: "block", height: 3, borderRadius: 2, boxShadow: "inset 0 0 0 1px hsl(var(--border))", position: "relative", overflow: "hidden" }}>
            <span style={{ position: "absolute", inset: 0, background: "hsl(var(--foreground))", transformOrigin: "left", transform: `scaleX(${view.fraction})`, transition: "transform var(--dur-wide) var(--cv2-ease)" }} />
          </span>
          {view.compactsLine && <span className="cv2-mute">{view.compactsLine}</span>}
          {view.costLine && <span className="cv2-mute">{view.costLine}</span>}
          {onCompact && (
            <button type="button" className="cv2-btn" style={{ alignSelf: "flex-start" }} onClick={onCompact}>
              Compact now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Instance lookups re-exported for the composer. */
export { defaultSelection };
