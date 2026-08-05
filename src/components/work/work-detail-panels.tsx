"use client";

import * as React from "react";
import type { Prisma } from "@prisma/client";
import { ExternalLink, FileText, Link2, ShieldCheck } from "lucide-react";
import {
  ARTIFACT_EXTENSION,
  WORK_ARTIFACT_KINDS,
  budgetExceeded,
  type WorkArtifactKind,
  type WorkCapability,
} from "@/lib/work/domain";
import type { ClientWorkEvent, ClientWorkHost, ClientWorkRun } from "@/lib/work/serializers";
import type { PerformedAction } from "@/components/work/work-timeline";
import {
  CapabilityChip,
  DegradationNotes,
  WorkTargetLabel,
  formatDuration,
  formatMicroUsd,
  workTimeAgo,
} from "@/components/work/work-vocabulary";
import { cn, formatBytes, formatTokens } from "@/lib/utils";

/*
 * The right-hand column's reference panels: what went in, what came out, what
 * the run was allowed to spend, and what it was actually able to do.
 *
 * Nothing in here shows a filesystem path, and the rule is enforced by omission
 * rather than by stripping: a `files_changed` entry is rendered only when the
 * executor gave it a display name of its own. An entry that arrives as a bare
 * string is counted but not printed, because a bare string in that field is
 * overwhelmingly a path, and a path in a screenshot is a path in a support
 * ticket. The count still tells the truth about how much changed.
 *
 * Everything here is derived from the event stream. There is no artifacts or
 * references endpoint to read instead, and there should not be one: the stream
 * is what the resume cursor replays, so a panel built from it can never disagree
 * with the timeline beside it about whether something happened.
 */

type Payload = Record<string, unknown>;

function payloadOf(value: Prisma.JsonValue): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function num(payload: Payload, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Files and sources
// ---------------------------------------------------------------------------

export interface WorkReference {
  id: string;
  direction: "read" | "written";
  label: string;
  /** Set for a cited page, so the row can be followed. Null for anything else. */
  url: string | null;
  detail: string | null;
  at: string;
}

/**
 * Everything the run read or wrote, as far as the stream reported it.
 *
 * Sources and file changes are folded into one list because that is the
 * question a user actually has — "what did it touch" — and splitting them into
 * two panels makes the answer something you have to assemble yourself.
 */
export function deriveReferences(events: readonly ClientWorkEvent[]): WorkReference[] {
  const references: WorkReference[] = [];

  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = payloadOf(event.payload);

    if (event.kind === "source_cited") {
      const url = str(payload, "url", "href");
      const label = str(payload, "title", "label") ?? url;
      if (label === null) continue;
      references.push({
        id: event.id,
        direction: "read",
        label,
        url,
        detail: str(payload, "snippet", "publisher", "site"),
        at: event.createdAt,
      });
      continue;
    }

    if (event.kind === "files_changed" || event.kind === "batch_applied") {
      const entries = Array.isArray(payload.files)
        ? payload.files
        : Array.isArray(payload.items)
          ? payload.items
          : [];
      const named = entries.flatMap((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const record = entry as Payload;
        const label = str(record, "label", "name", "displayName", "title");
        if (label === null) return [];
        const bytes = num(record, "bytes", "size");
        return [
          {
            id: `${event.id}-${index}`,
            direction: "written" as const,
            label,
            url: null,
            detail: bytes === null ? str(record, "change", "action") : formatBytes(bytes),
            at: event.createdAt,
          },
        ];
      });

      if (named.length > 0) {
        references.push(...named);
        continue;
      }

      // Nothing in the payload could be named without printing a path, so the
      // row states the size of the change instead of inventing a filename.
      const changed = num(payload, "count") ?? entries.length;
      if (changed <= 0) continue;
      references.push({
        id: event.id,
        direction: "written",
        label: `${changed} file${changed === 1 ? "" : "s"} changed`,
        url: null,
        detail: str(payload, "summary"),
        at: event.createdAt,
      });
    }
  }

  return references;
}

export function WorkReferences({ references }: { references: readonly WorkReference[] }) {
  const read = references.filter((reference) => reference.direction === "read");
  const written = references.filter((reference) => reference.direction === "written");

  if (references.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Nothing has been read or written yet. Every page Juno cites and every file it changes is
        listed here as it goes.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {read.length > 0 && <ReferenceGroup title="Read" references={read} />}
      {written.length > 0 && <ReferenceGroup title="Written" references={written} />}
    </div>
  );
}

function ReferenceGroup({
  title,
  references,
}: {
  title: string;
  references: readonly WorkReference[];
}) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">{title}</p>
      <ul className="space-y-1.5">
        {references.map((reference) => (
          <li key={reference.id} className="flex items-start gap-2">
            {reference.url !== null ? (
              <Link2 className="mt-[3px] h-3.5 w-3.5 shrink-0 text-source" aria-hidden="true" />
            ) : (
              <FileText
                className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1">
              {reference.url !== null ? (
                <a
                  href={reference.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-w-0 max-w-full items-center gap-1 text-[13px] leading-relaxed text-foreground underline-offset-2 hover:underline"
                >
                  <span className="min-w-0 truncate">{reference.label}</span>
                  <ExternalLink
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </a>
              ) : (
                <span className="block truncate text-[13px] leading-relaxed text-foreground">
                  {reference.label}
                </span>
              )}
              {reference.detail !== null && (
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {reference.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents produced
// ---------------------------------------------------------------------------

export interface WorkProducedArtifact {
  id: string;
  title: string;
  kind: WorkArtifactKind;
  version: number | null;
  updatedAt: string;
}

const ARTIFACT_KINDS = new Set<string>(WORK_ARTIFACT_KINDS);

/**
 * The documents this run has produced, newest state per artifact.
 *
 * An `artifact_updated` replaces the row rather than adding one: the panel
 * answers "what has Juno made", and five rows for five saves of the same
 * workbook answers a question nobody asked.
 */
export function deriveArtifacts(events: readonly ClientWorkEvent[]): WorkProducedArtifact[] {
  const artifacts = new Map<string, WorkProducedArtifact>();
  for (const event of events) {
    if (event.visibility !== "user") continue;
    if (event.kind !== "artifact_created" && event.kind !== "artifact_updated") continue;
    const payload = payloadOf(event.payload);
    const id = str(payload, "artifactId", "id", "identifier");
    if (id === null) continue;
    const kind = str(payload, "kind");
    artifacts.set(id, {
      id,
      title: str(payload, "title", "name") ?? "Untitled document",
      // `bundle` is the fallback because it is the kind that promises least
      // about what will open: labelling an unknown export "spreadsheet" invites
      // a click that ends in an error dialog.
      kind: kind !== null && ARTIFACT_KINDS.has(kind) ? (kind as WorkArtifactKind) : "bundle",
      version: num(payload, "version", "currentVersion"),
      updatedAt: event.createdAt,
    });
  }
  return [...artifacts.values()];
}

export function WorkArtifacts({ artifacts }: { artifacts: readonly WorkProducedArtifact[] }) {
  if (artifacts.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        No documents yet. Anything Juno produces — a workbook, a report, a deck — is listed here as
        it is written.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {artifacts.map((artifact) => (
          <li
            key={artifact.id}
            className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/50 px-3 py-2.5"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted font-mono text-[9px] text-muted-foreground">
              {ARTIFACT_EXTENSION[artifact.kind]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {artifact.title}
              </span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                {artifact.version === null ? "written" : `v${artifact.version}`} ·{" "}
                {workTimeAgo(artifact.updatedAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {/* There is no download route under /api/work yet. A button linking to one
          would 404 on click, which is a worse answer than this sentence: the
          document genuinely exists, and saying where it does not yet reach is
          the only honest thing this panel can offer. */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Downloading these from the web isn’t available yet. They are attached to the task and
        reachable from the Juno app.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run settings and budget
// ---------------------------------------------------------------------------

export function WorkRunSettings({
  run,
  host,
}: {
  run: ClientWorkRun | null;
  /** The Mac this run is bound to, when it is bound to one and the host list loaded. */
  host: ClientWorkHost | null;
}) {
  if (run === null) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        This task has not been started, so there is nothing to describe yet — no target, no model,
        no budget spent.
      </p>
    );
  }

  const available = new Set<WorkCapability>(run.availableCapabilities);

  return (
    <div className="space-y-3.5">
      <dl className="space-y-1.5">
        <SettingRow label="Runs on">
          <WorkTargetLabel
            target={run.effectiveTarget}
            hostName={host?.displayName}
            // A local run whose host row has not loaded still knows it is local.
            // Naming the machine is the part that has to wait for the fetch.
            hostUnknown={run.effectiveTarget === "local" && host === null}
          />
        </SettingRow>
        <SettingRow label="Model">
          <span className="font-mono text-[10px] text-muted-foreground">
            {/* The model that was asked for and the model that ran are two facts,
                and a substitution the user is not told about is a substitution
                they will discover in the output instead. */}
            {run.effectiveModel ?? run.requestedModel ?? "not chosen yet"}
            {run.effectiveModel !== null &&
              run.requestedModel !== null &&
              run.effectiveModel !== run.requestedModel &&
              ` (you asked for ${run.requestedModel})`}
          </span>
        </SettingRow>
        <SettingRow label="Attempt">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            #{run.attempt} · {run.origin}
          </span>
        </SettingRow>
        {run.startedAt !== null && (
          <SettingRow label="Started">
            <span className="font-mono text-[10px] text-muted-foreground">
              {workTimeAgo(run.startedAt)}
            </span>
          </SettingRow>
        )}
      </dl>

      {run.requiredCapabilities.length > 0 && (
        <div>
          <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Needs</p>
          <div className="flex flex-wrap gap-1.5">
            {run.requiredCapabilities.map((capability) => (
              <CapabilityChip
                key={capability}
                capability={capability}
                available={available.has(capability)}
              />
            ))}
          </div>
        </div>
      )}

      {run.degradation.length > 0 && (
        <div className="rounded-xl border border-warning/35 bg-warning/5 px-3 py-2.5">
          <DegradationNotes degradation={run.degradation} />
        </div>
      )}

      <WorkBudget run={run} />
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * Elapsed runtime, ticking only while the run is still going.
 *
 * `Date.now()` is read in an effect rather than during render, because a
 * duration computed on the server and again on the client is guaranteed to
 * differ and is exactly the hydration mismatch this codebase warns about. A
 * finished run needs no clock at all — both ends of its interval are recorded.
 */
function useElapsedMs(run: ClientWorkRun): number {
  const settled =
    run.startedAt === null
      ? 0
      : run.finishedAt === null
        ? null
        : Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  const [live, setLive] = React.useState(0);

  React.useEffect(() => {
    if (settled !== null || run.startedAt === null) return;
    const started = Date.parse(run.startedAt);
    const tick = () => setLive(Math.max(0, Date.now() - started));
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [settled, run.startedAt]);

  return settled ?? live;
}

function WorkBudget({ run }: { run: ClientWorkRun }) {
  const elapsedMs = useElapsedMs(run);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const ceiling = budgetExceeded(run.budget, {
    costMicroUsd: run.usage.costMicroUsd,
    tokens,
    runtimeMs: Math.max(elapsedMs, 0),
  });

  const unlimited =
    run.budget.maxCostMicroUsd === 0 && run.budget.maxTokens === 0 && run.budget.maxRuntimeMs === 0;

  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Budget</p>
      <div className="space-y-1.5">
        <BudgetBar
          label="Cost"
          used={formatMicroUsd(run.usage.costMicroUsd)}
          limit={run.budget.maxCostMicroUsd === 0 ? null : formatMicroUsd(run.budget.maxCostMicroUsd)}
          fraction={
            run.budget.maxCostMicroUsd === 0
              ? null
              : run.usage.costMicroUsd / run.budget.maxCostMicroUsd
          }
        />
        <BudgetBar
          label="Tokens"
          used={formatTokens(tokens)}
          limit={run.budget.maxTokens === 0 ? null : formatTokens(run.budget.maxTokens)}
          fraction={run.budget.maxTokens === 0 ? null : tokens / run.budget.maxTokens}
        />
        <BudgetBar
          label="Time"
          used={formatDuration(elapsedMs)}
          limit={run.budget.maxRuntimeMs === 0 ? null : formatDuration(run.budget.maxRuntimeMs)}
          fraction={run.budget.maxRuntimeMs === 0 ? null : elapsedMs / run.budget.maxRuntimeMs}
        />
      </div>
      {unlimited && (
        // Zero is "no explicit ceiling", not "zero allowed" — see NO_BUDGET in
        // domain.ts. Rendering it as a full bar would say the opposite.
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          No ceiling was set for this run, so the plan’s own default applies.
        </p>
      )}
      {ceiling.exceeded && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-warning-foreground">{ceiling.detail}</p>
      )}
    </div>
  );
}

function BudgetBar({
  label,
  used,
  limit,
  fraction,
}: {
  label: string;
  used: string;
  limit: string | null;
  /** Null when no ceiling was set, so the track renders empty rather than full. */
  fraction: number | null;
}) {
  const filled = fraction === null ? 0 : Math.max(0, Math.min(1, fraction));
  const near = fraction !== null && filled >= 0.8;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums">
        <span className="text-muted-foreground/70">{label}</span>
        <span className={cn(near ? "text-warning-foreground" : "text-muted-foreground")}>
          {used}
          {limit !== null && ` / ${limit}`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-slow ease-out-soft",
            near ? "bg-warning" : "bg-foreground/30"
          )}
          style={{ width: `${filled * 100}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What was actually done
// ---------------------------------------------------------------------------

export function WorkActionsPerformed({ actions }: { actions: readonly PerformedAction[] }) {
  if (actions.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Juno hasn’t changed anything yet. Every action that touches the world — a file written, a
        message sent, a batch applied — is listed here after it happens.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {actions.map((action) => (
        <li key={action.id} className="flex items-start gap-2 text-[13px] leading-relaxed">
          {action.approved ? (
            <ShieldCheck className="mt-[3px] h-3.5 w-3.5 shrink-0 text-success-ink" aria-hidden="true" />
          ) : (
            <span
              className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 flex-1 text-foreground">{action.summary}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {workTimeAgo(action.at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
