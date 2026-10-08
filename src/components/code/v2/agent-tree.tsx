"use client";

/**
 * The fan-out tree in the thread (DESIGN §5.12; INTERACTION I-8) and the Best
 * of N compare columns (Dock › Agents). Running, failed and waiting children
 * are open; finished ones collapse to their title line after 2 s; order never
 * changes (settlement changes status, not position).
 */
import * as React from "react";
import type { ProviderInstance, SubagentItem } from "@/lib/code-v2/contracts";
import { budgetLine, budgetWarn } from "@/lib/code-v2/orchestrate";
import { formatDuration } from "@/lib/code-v2/turns";
import { displayName, shortModelLabel } from "@/lib/code-v2/providers-view";
import { Glyph, ModelMark, Spinner } from "./primitives";
import { cn } from "@/lib/utils";

export function modelLabelFor(modelId: string, instances: readonly ProviderInstance[], instanceId: string): string {
  const instance = instances.find((i) => i.id === instanceId);
  const m = instance?.models?.find((x) => x.id === modelId);
  return m?.label ?? shortModelLabel(modelId.split(":").pop() ?? modelId);
}

function kidGlyph(status: SubagentItem["status"]) {
  switch (status) {
    case "running":
      return <Spinner />;
    case "waiting":
      return <Glyph name="needs-you" />;
    case "failed":
      return <Glyph name="error-circle" />;
    case "interrupted":
      return <Glyph name="stop-circle" />;
    default:
      return <Glyph name="check" />;
  }
}

function useCollapsedAfter(item: SubagentItem): boolean {
  const settled = item.status === "completed";
  const [collapsed, setCollapsed] = React.useState(settled);
  React.useEffect(() => {
    if (!settled) {
      setCollapsed(false);
      return;
    }
    const t = setTimeout(() => setCollapsed(true), 2000);
    return () => clearTimeout(t);
  }, [settled]);
  return collapsed;
}

function Kid({ item, instances, selected, onSelect, delay }: { item: SubagentItem; instances: readonly ProviderInstance[]; selected: boolean; onSelect?: (id: string) => void; delay: number }) {
  const collapsed = useCollapsedAfter(item);
  const instance = instances.find((i) => i.id === item.model.instanceId);
  const label = item.label ?? (item.role === "explorer" ? "Explorer" : item.role === "reviewer" ? "Reviewer" : "Worker");
  const glyphClass = item.status === "completed" ? "done" : item.status === "waiting" ? "needs" : item.status === "failed" ? "failed" : "";
  const live = item.status === "running";
  let line: React.ReactNode = null;
  if (item.status === "waiting") {
    line = (
      <>
        <span className="cv2-sig">Waiting for you:</span> {item.liveLine ?? "needs an answer"}
      </>
    );
  } else if (live && item.liveLine) {
    line = <span className="cv2-shimmer">{item.liveLine}</span>;
  } else if (item.closingText) {
    line = item.closingText;
  } else if (item.status === "failed") {
    line = item.liveLine ?? "Failed.";
  }
  const adds = item.candidate?.additions;
  const dels = item.candidate?.deletions;
  return (
    <button
      type="button"
      className="cv2-kid"
      style={{ animationDelay: `${delay}ms` }}
      aria-pressed={selected}
      onClick={() => onSelect?.(item.agentId)}
    >
      <span className={cn("g", glyphClass)}>{kidGlyph(item.status)}</span>
      <span className="b">
        <span className="name block cv2-trunc" style={{ display: "inline" }}>{item.title ?? item.task ?? label}</span>
        <span className="cv2-row cv2-mute" style={{ gap: 6 }}>
          <span>{label}</span>
          <span aria-hidden>·</span>
          <ModelMark modelId={item.model.model} instance={instance} />
          <span className="cv2-trunc">
            {modelLabelFor(item.model.model, instances, item.model.instanceId)}
            {instance && instance.kind !== "alevr" ? ` · ${displayName(instance)}` : ""}
          </span>
        </span>
        {!collapsed && line && (
          <span className="line block">
            {line}
            {adds !== undefined && (
              <>
                {" "}
                <span className="cv2-add cv2-tnum">+{adds}</span> <span className="cv2-del cv2-tnum">−{dels ?? 0}</span>
              </>
            )}
          </span>
        )}
      </span>
      <span className="r">{item.elapsedMs !== undefined ? formatDuration(item.elapsedMs) : ""}</span>
    </button>
  );
}

export function AgentTree({
  items,
  instances,
  budgetUsd,
  selectedId,
  onSelect,
}: {
  items: SubagentItem[];
  instances: readonly ProviderInstance[];
  budgetUsd?: number;
  selectedId?: string | null;
  onSelect?: (agentId: string) => void;
}) {
  const workers = items.filter((i) => i.role === "worker").length;
  const others = items.filter((i) => i.role !== "worker");
  const head =
    workers > 0 ? `${workers} ${workers === 1 ? "worker" : "workers"}` : others.length === 1 ? (others[0].label ?? "1 agent") : `${items.length} agents`;
  const rest = workers > 0 && others.length ? `and ${others.length === 1 ? `an ${others[0].role}` : `${others.length} more`}` : "";
  const elapsed = Math.max(0, ...items.map((i) => i.elapsedMs ?? 0));
  const costs = items.map((i) => i.costUsd).filter((c): c is number => c !== undefined);
  const spent = costs.length ? costs.reduce((a, b) => a + b, 0) : undefined;
  const money = budgetLine(spent, budgetUsd);
  return (
    <div className="cv2-tree" role="group" aria-label={`${head} ${rest}`.trim()}>
      <div className="head">
        <Glyph name="agents" className="cv2-mute" />
        <span className="cv2-m">{head}</span>
        {rest && <span className="cv2-mute">{rest}</span>}
        <span className="meta cv2-mute cv2-tnum" style={{ marginLeft: "auto" }}>
          {elapsed > 0 ? formatDuration(elapsed) : ""}
          {money && (
            <>
              {" · "}
              <span className={budgetWarn(spent, budgetUsd) ? "cv2-sig" : undefined} style={{ transition: "color var(--dur-mid)" }}>
                {money}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="kids">
        {items.map((item, i) => (
          <Kid key={item.id} item={item} instances={instances} selected={selectedId === item.agentId} onSelect={onSelect} delay={Math.min(i, 5) * 50} />
        ))}
      </div>
    </div>
  );
}

/** Best of N compare (Dock › Agents when the preset is Best of N). */
export function BestOfN({
  items,
  instances,
  onKeep,
}: {
  items: SubagentItem[];
  instances: readonly ProviderInstance[];
  onKeep?: (agentId: string) => void;
}) {
  const kept = items.find((i) => i.candidate?.kept);
  return (
    <div className="cv2-compare" role="list" aria-label="Candidates">
      {items.map((item, i) => {
        const instance = instances.find((x) => x.id === item.model.instanceId);
        const c = item.candidate ?? {};
        return (
          <div key={item.id} role="listitem" className={cn("cv2-cand", c.kept && "kept")}>
            <div className="ch">
              <ModelMark modelId={item.model.model} instance={instance} />
              <span className="cv2-m cv2-trunc">{item.label ?? `Candidate ${String.fromCharCode(65 + i)}`}</span>
              <span className="cv2-mute cv2-trunc" style={{ marginLeft: "auto" }}>
                {modelLabelFor(item.model.model, instances, item.model.instanceId)}
              </span>
            </div>
            <div className="cb">
              <div className="cv2-row cv2-mute cv2-tnum" style={{ gap: 10 }}>
                {item.status === "running" ? <Spinner /> : item.status === "failed" ? <Glyph name="error-circle" className="cv2-del" /> : <Glyph name="check" className="cv2-add" />}
                <span>{item.elapsedMs !== undefined ? formatDuration(item.elapsedMs) : "…"}</span>
                {item.costUsd !== undefined && <span>${item.costUsd.toFixed(2)}</span>}
                {c.additions !== undefined && (
                  <span style={{ marginLeft: "auto" }}>
                    <span className="cv2-add">+{c.additions}</span> <span className="cv2-del">−{c.deletions ?? 0}</span>
                  </span>
                )}
              </div>
              {c.testsLine && <div className="cv2-mono cv2-mute cv2-trunc">{c.testsLine}</div>}
              <div style={{ color: "hsl(var(--foreground))" }}>{item.closingText ?? item.liveLine ?? "Working…"}</div>
              {item.worktreeBranch && <div className="cv2-mono cv2-mute cv2-trunc">{item.worktreeBranch}</div>}
            </div>
            <div className="cf">
              {c.kept ? (
                <span className="cv2-row" style={{ gap: 6 }}>
                  <Glyph name="check" /> Kept
                </span>
              ) : (
                <button type="button" className="cv2-btn" disabled={item.status === "running" || !!kept} onClick={() => onKeep?.(item.agentId)}>
                  Keep this one
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
