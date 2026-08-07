"use client";

import * as React from "react";
import { Coins, ExternalLink, FileText, Link2, ShieldCheck, Sigma, Timer } from "lucide-react";
import {
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_ARTIFACT_KINDS,
  budgetExceeded,
  type WorkArtifactKind,
  type WorkCapability,
} from "@/lib/work/domain";
import type {
  ClientWorkEvent,
  ClientWorkHost,
  ClientWorkRun,
  ClientWorkSession,
} from "@/lib/work/serializers";
import type { PerformedActions } from "@/components/work/work-timeline";
import { num, prose, readEvent, records, str } from "@/components/work/work-payload";
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
 * Everything here is derived from the event stream, and for the panels in this
 * file that is the only source there is: the stream is what the resume cursor
 * replays, so a panel built from it can never disagree with the feed beside it
 * about whether something happened. Payloads are read through work-payload.ts,
 * which reconciles the two executors' shapes — before it existed these panels
 * read the Mac's flat keys only, and a cloud run's sources and documents landed
 * one level down inside `citation` and `artifact` where nothing looked.
 *
 * The one exception is documents, and the exception is instructive. The stream
 * says a file was written; it does not hold the bytes, their size, their hash or
 * what they were made from, and there is a route that does. So `deriveArtifacts`
 * stays here — it is what tells the panel a new document exists — while the
 * panel itself lives in `work-documents.tsx` and reads /api/work/artifacts for
 * the facts only the store has.
 */

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
    const payload = readEvent(event);

    if (event.kind === "source_cited") {
      // `source` is the runtime's field and it is not always a URL — a citation
      // can name a connector record or a granted folder just as easily as a
      // page. Only something that parses as http(s) becomes a link; the rest is
      // printed as the name it is, because an anchor whose href is
      // `gmail:18f2c…` is a promise the browser cannot keep.
      const source = str(payload, "url", "href", "source");
      const url = source !== null && isWebUrl(source) ? source : null;
      const label = str(payload, "title", "label") ?? url ?? source;
      if (label === null) continue;
      references.push({
        id: event.id,
        direction: "read",
        label,
        url,
        // The quote is the passage actually relied on, which is the one thing
        // that makes a citation checkable rather than decorative.
        detail: prose(payload, "quote", "snippet", "publisher", "site") ?? (url === null ? null : source),
        at: event.createdAt,
      });
      continue;
    }

    if (event.kind === "files_changed" || event.kind === "batch_applied") {
      const entries = records(payload, "files", "items");
      const named = entries.flatMap((record, index) => {
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

/**
 * Whether a citation's source is something a browser can open.
 *
 * Parsed rather than pattern-matched, and restricted to http(s) by protocol
 * rather than by prefix, because `javascript:` and `data:` are exactly what an
 * untrusted page would like to see rendered as a link the user clicks.
 */
function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
    const payload = readEvent(event);
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

/*
 * The panel that renders these lives in `work-documents.tsx`.
 *
 * It reads `/api/work/artifacts` for the real rows and their download links,
 * and takes the list above as the signal that there is something new to read
 * and as the fallback when that request fails. The derivation stays here,
 * beside the other projections of the same stream.
 */

// ---------------------------------------------------------------------------
// Run settings and budget
// ---------------------------------------------------------------------------

export function WorkRunSettings({
  run,
  host,
}: {
  run: ClientWorkRun;
  /** The Mac this run is bound to, when it is bound to one and the host list loaded. */
  host: ClientWorkHost | null;
}) {
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
        {/* The mode this attempt enforced, which is not always the one the task
            asked for. Omitted rather than guessed when the run carries none —
            see `approvalMode` in serializers.ts — because a row reading "Manual"
            on a run that never enforced it is worse than no row. */}
        {run.approvalMode !== null && (
          <SettingRow label="Asks">
            <span className="font-mono text-[10px] text-muted-foreground">
              {WORK_APPROVAL_MODE_LABEL[run.approvalMode]}
            </span>
          </SettingRow>
        )}
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

      {/*
       * What "Asks: Manual" actually means for this run, in a sentence.
       *
       * The narrowed case is the reason this is here rather than left to the
       * three-letter label. A task composed as Skip that lands on a Mac pinned
       * to Manual runs Manual — the Mac is the machine with the files on it and
       * is entitled to a floor a phone cannot raise — and a reader who is shown
       * "Manual" with no explanation concludes the control they used did
       * nothing. Naming the machine is what turns an apparent bug back into the
       * rule it is.
       *
       * The unnarrowed case reuses `WORK_APPROVAL_MODE_SUMMARY`, which is the
       * same sentence the composer showed under the same choice. Two wordings
       * for one mode would have a reader wondering which one the run got.
       */}
      {run.approvalMode !== null && (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {run.approvalModeNarrowedByHost
            ? `${host?.displayName ?? "That Mac"} is set to ${WORK_APPROVAL_MODE_LABEL[run.approvalMode]}, and a task cannot ask less often than the Mac it runs on — so this attempt ran in ${WORK_APPROVAL_MODE_LABEL[run.approvalMode]} rather than the mode it was started with.`
            : WORK_APPROVAL_MODE_SUMMARY[run.approvalMode]}
        </p>
      )}

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

/**
 * What a draft *will* run as, before there is a run to describe.
 *
 * This replaces a sentence that said there was nothing to describe yet, which
 * was not true: a draft carries the target, the model and the approval mode
 * chosen in the composer, and those are exactly the three things somebody
 * checks before pressing Start. Saying "nothing to describe" and then starting
 * the task on settings the reader was never shown is how a person discovers
 * their choice of Mac was ignored by watching the cloud do the work.
 *
 * Every value here is a request rather than an outcome, and the wording keeps
 * that distinction rather than borrowing the run panel's. Automatic is not a
 * target and is not rendered as one — `selectTarget` decides at dispatch, and a
 * draft that claimed "Cloud" would be this panel guessing on its behalf.
 */
export function WorkPlannedSettings({
  session,
  hosts,
}: {
  session: ClientWorkSession;
  /** Null until the host list loads, which only affects whether a Mac is named. */
  hosts: readonly ClientWorkHost[] | null;
}) {
  const preferred =
    session.preferredHostId === null
      ? null
      : (hosts ?? []).find((host) => host.id === session.preferredHostId) ?? null;

  return (
    <div className="space-y-3.5">
      <dl className="space-y-1.5">
        <SettingRow label="Will run">
          {session.requestedTarget === "automatic" ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              wherever it fits
            </span>
          ) : (
            <WorkTargetLabel
              target={session.requestedTarget}
              hostName={preferred?.displayName}
              hostUnknown={session.requestedTarget === "local" && preferred === null}
            />
          )}
        </SettingRow>
        <SettingRow label="Model">
          <span className="font-mono text-[10px] text-muted-foreground">
            {/* A draft may carry the Auto sentinel, which is a promise to choose
                rather than a choice. Printing it verbatim is honest; resolving
                it here would be this bundle guessing at a decision the dispatch
                route makes with the account's plan in front of it. */}
            {session.requestedModel ?? "chosen when it starts"}
          </span>
        </SettingRow>
        <SettingRow label="Asks">
          <span className="font-mono text-[10px] text-muted-foreground">
            {WORK_APPROVAL_MODE_LABEL[session.permissionPolicy]}
          </span>
        </SettingRow>
      </dl>

      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        {WORK_APPROVAL_MODE_SUMMARY[session.permissionPolicy]}
      </p>

      {/* Said once, here, rather than as an empty state on every panel a draft
          has nothing to fill. */}
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Nothing has been spent and nothing has been touched. A Mac may ask more often than this —
        it cannot ask less.
      </p>
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

/**
 * Elapsed, cost and tokens, at the top of the page where they can be glanced at.
 *
 * The same three numbers as the budget bars below and read from the same run
 * row, deliberately: this is not a second source, it is the same one at a
 * different distance. The bars answer "how close is this to its ceiling" and
 * live at the bottom of the reference column; this answers "what is it costing
 * me right now" and has to be visible without scrolling, because that is the
 * question a person asks while a task is running rather than after.
 *
 * Ceilings are omitted here on purpose. Three numbers read at a glance; six with
 * slashes between them do not, and the pair that matters — the one approaching
 * its limit — is called out by the bars in warning colour anyway.
 */
export function WorkLiveMeter({ run }: { run: ClientWorkRun }) {
  const elapsedMs = useElapsedMs(run);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground">
      <Meter icon={Timer} label="Elapsed" value={formatDuration(elapsedMs)} />
      <Meter icon={Coins} label="Cost" value={formatMicroUsd(run.usage.costMicroUsd)} />
      <Meter icon={Sigma} label="Tokens" value={formatTokens(tokens)} />
    </dl>
  );
}

function Meter({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 text-muted-foreground/60" aria-hidden="true" />
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
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

export function WorkActionsPerformed({ performed }: { performed: PerformedActions }) {
  const { actions, unclassified } = performed;

  if (actions.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {unclassified === 0
          ? "Juno hasn’t changed anything yet. Every action that touches the world — a file written, a message sent, a batch applied — is listed here after it happens."
          : // Not "nothing was changed", which this panel is in no position to
            // claim: an executor that reports neither a risk level nor a
            // mutating flag leaves every one of its calls unclassified, and
            // answering the user's real question — what would I have to undo —
            // with a confident "nothing" on that evidence is the worst way to be
            // wrong here.
            `${unclassified} ${unclassified === 1 ? "action ran" : "actions ran"} without saying whether anything was changed. Read the activity below for what they were.`}
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
