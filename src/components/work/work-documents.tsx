"use client";

import * as React from "react";
import { ChevronRight, Link2, Loader2 } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { ARTIFACT_EXTENSION, type WorkArtifactKind } from "@/lib/work/domain";
import type { ClientWorkArtifact } from "@/lib/work/serializers";
import type { WorkProducedArtifact } from "@/components/work/work-detail-panels";
import {
  fetchWorkArtifact,
  fetchWorkArtifacts,
  workArtifactDownloadUrl,
  type WorkArtifactDetail,
  type WorkArtifactVersion,
} from "@/components/work/work-transport";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { canPreviewArtifact, WorkDeliverablePreview } from "@/components/work/work-site-preview";
import { cn, formatBytes } from "@/lib/utils";

/*
 * The documents a task produced, and the bytes behind them.
 *
 * This panel used to be the one place on the page that told the user something
 * was impossible: it derived a list from `artifact_created` events and then said
 * downloading from the web "isn't available yet". The route it was apologising
 * for exists — GET /api/work/artifacts/[id]/download — and it does more than
 * hand over a file: it re-computes the SHA-256 of the stored object and refuses
 * with a 409 rather than serving bytes that are not the ones the run recorded.
 *
 * So the list is read rather than inferred, and it is read ONCE, by the page,
 * through `useWorkArtifactList`: the rail's Outputs section and the deliverable
 * stage in the main column both render from the same answer, which is what
 * stops the two disagreeing about which documents exist. The event stream is
 * still used for two things it is better at than a list endpoint: it is what
 * tells the page a new document exists (which is what triggers the refetch),
 * and it is what the panel falls back to when the list request fails — a row
 * derived from an event is a real document that really was written, and showing
 * it without a download beside it is a better answer than an empty panel.
 *
 * ── The card, per kind ───────────────────────────────────────────────────────
 *
 * A `site` and a `report` render inline in the main column (`WorkDeliverableStage`)
 * and keep a Preview here for the dialog. The four kinds people actually ask
 * for — .docx, .xlsx, .pptx, .pdf — have no previewer (`canPreviewArtifact`
 * states the case for each), and used to be a 58px row with a download glyph.
 * They are a real card now: the size, whether the validator could re-open the
 * file, what it objected to when it could not, what the file was made from,
 * and a Download that says the word. The card fetches its detail on mount for
 * those four rather than on open, because the size and the verdict ARE the
 * card; for the other kinds the history stays behind the row.
 */

/** The kinds whose card carries its detail up front. */
const OFFICE_KINDS = new Set<WorkArtifactKind>(["document", "spreadsheet", "presentation", "pdf"]);

export interface WorkArtifactList {
  /** Null until the first read lands; the last good answer after a failure. */
  artifacts: ClientWorkArtifact[] | null;
  failed: boolean;
  reload: () => void;
}

/**
 * The task's documents, read once and shared.
 *
 * `produced` is the event stream's count of artifacts, in the dependency list
 * on purpose: the run writing a new artifact is exactly the moment this list is
 * out of date, and the event that says so has already arrived on the stream the
 * page is reading. `enabled` is false for a draft, which has no run and cannot
 * have produced anything — one request saved per page load of a task that has
 * not started.
 */
export function useWorkArtifactList(
  sessionId: string,
  produced: number,
  enabled: boolean
): WorkArtifactList {
  const [artifacts, setArtifacts] = React.useState<ClientWorkArtifact[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await fetchWorkArtifacts(sessionId);
    if (result.kind === "ok") {
      setArtifacts(result.value);
      setFailed(false);
      return;
    }
    // What was last known is left standing rather than blanked. A dropped
    // request says nothing about which documents exist, and replacing a real
    // list with an empty one would state something the failure did not
    // establish.
    setFailed(true);
  }, [sessionId]);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
  }, [load, produced, enabled]);

  return React.useMemo(
    () => ({ artifacts, failed, reload: () => void load() }),
    [artifacts, failed, load]
  );
}

export function WorkDocuments({
  list,
  /**
   * What the event stream says was produced — the rows rendered if the list
   * request never lands.
   */
  fromEvents,
}: {
  list: WorkArtifactList;
  fromEvents: readonly WorkProducedArtifact[];
}) {
  const { artifacts, failed, reload } = list;

  if (artifacts === null && !failed) {
    // 58px, not the list rung: a document row is two lines and a badge, not the
    // three-line task row `WorkRowSkeletons` is sized for by default.
    return <WorkRowSkeletons count={2} height={58} className="space-y-2" />;
  }

  if (failed && artifacts === null) {
    return (
      <div className="space-y-2.5">
        <WorkLoadError onRetry={reload}>
          Couldn’t load this task’s documents, so nothing here can be downloaded yet. The files
          themselves are unaffected.
        </WorkLoadError>
        {/* The transcript still knows what was written, even when the list of it
            could not be read. Naming them without offering a download is the
            honest half of the answer rather than none of it. */}
        {fromEvents.length > 0 && (
          <ul className="space-y-2">
            {fromEvents.map((artifact) => (
              <li
                key={artifact.id}
                className="flex items-center gap-2.5 rounded-field border border-border/60 bg-card px-3 py-2.5"
              >
                <KindBadge extension={ARTIFACT_EXTENSION[artifact.kind]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-foreground">
                    {artifact.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-micro text-muted-foreground">
                    {artifact.version === null ? "written" : `v${artifact.version}`} ·{" "}
                    {workTimeAgo(artifact.updatedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // Nothing, on purpose. A section with nothing in it is a heading and nothing
  // else (work-rail.tsx, rule 2); the Outputs section prints the one sentence
  // a settled run is allowed — "it made nothing" — where it knows the phase.
  if ((artifacts ?? []).length === 0) return null;

  return (
    <div className="space-y-2">
      {failed && (
        <p className="text-caption leading-relaxed text-warning-foreground">
          This list could not be refreshed just now, so a document written in the last few seconds
          may be missing from it.
        </p>
      )}
      <ul className="space-y-2">
        {(artifacts ?? []).map((artifact) => (
          <DocumentCard key={artifact.id} artifact={artifact} />
        ))}
      </ul>
    </div>
  );
}

function KindBadge({ extension }: { extension: string }) {
  return (
    // Identical to `FileMark` in detail/work-outputs.tsx, which is the other
    // half of this pair: the two marks stack inside one rail section.
    <span className="flex size-8 shrink-0 items-center justify-center rounded-field border border-border/60 bg-secondary font-mono text-micro text-muted-foreground">
      {extension}
    </span>
  );
}

/**
 * The detail of one document, fetched once and kept.
 *
 * A version history is append-only, so re-reading it every time the row is
 * folded and unfolded would cost a request per click to learn the same thing.
 */
function useArtifactDetail(artifactId: string, wanted: boolean) {
  const [detail, setDetail] = React.useState<WorkArtifactDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const result = await fetchWorkArtifact(artifactId);
    setLoading(false);
    if (result.kind === "ok") {
      setDetail(result.value);
      return;
    }
    setFailed(true);
  }, [artifactId]);

  React.useEffect(() => {
    if (wanted && detail === null && !loading && !failed) void load();
    // `loading` and `failed` are read, not depended on: the effect asks once
    // per `wanted`, and a retry is the button below, not a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, detail, load]);

  return { detail, loading, failed, load };
}

/**
 * One document.
 *
 * The primary action is the download of the current version, which is what
 * somebody opening this panel wants; the older versions and what each was made
 * from are behind the row. For the four Office kinds the card leads with its
 * facts — see the header — and the download is a word, not a glyph.
 *
 * Preview sits before Download and is a WORD rather than a glyph. There is no
 * house mark for "look at this without keeping it" (app-icons.ts is explicit
 * that a concept the web draws with no icon stays absent rather than being given
 * one here), and inventing an eye for the one row that needs it would be drift.
 */
function DocumentCard({ artifact }: { artifact: ClientWorkArtifact }) {
  const rich = OFFICE_KINDS.has(artifact.kind);
  const [open, setOpen] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  // A rich card wants its detail on mount; every other card only once opened.
  const { detail, loading, failed, load } = useArtifactDetail(artifact.id, rich || open);
  const current = detail?.versions.find((version) => version.version === artifact.currentVersion) ?? null;

  return (
    <li className="rounded-field border border-border/60 bg-card">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <KindBadge extension={ARTIFACT_EXTENSION[artifact.kind]} />
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          // The row's disclosure had no focus ring at all, so a keyboard reader
          // tabbing down the document list had no idea which row they were on.
          className="group min-w-0 flex-1 rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-ui font-medium text-foreground">
              {artifact.title}
            </span>
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
          </span>
          <span className="mt-0.5 block font-mono text-micro text-muted-foreground">
            v{artifact.currentVersion} · {workTimeAgo(artifact.updatedAt)}
            {current !== null && ` · ${formatBytes(current.byteSize)}`}
            {/* The absence of a pass is stated, never the presence of a failure:
                a file written by a build whose verdict this one cannot read is
                "not confirmed", not "broken". The problems below say which. */}
            {artifact.validatedAt === null ? " · not confirmed to open" : " · opens"}
          </span>
        </button>
        {canPreviewArtifact(artifact.kind) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreviewing(true)}
            className="h-7 shrink-0"
          >
            Preview
          </Button>
        )}
        {rich ? (
          <Button variant="secondary" size="sm" asChild className="h-7 shrink-0 gap-1.5">
            <a
              href={workArtifactDownloadUrl(artifact.id)}
              // No `download` attribute: the route sets Content-Disposition
              // itself, and a filename asserted here would be this bundle's
              // guess rather than the one the file was written under.
              aria-label={`Download ${artifact.title}`}
            >
              <ActionIcons.download className="size-3.5" aria-hidden="true" /> Download
            </a>
          </Button>
        ) : (
          <Pressable kind="icon" size="md" asChild className="shrink-0">
            <a href={workArtifactDownloadUrl(artifact.id)} aria-label={`Download ${artifact.title}`}>
              <ActionIcons.download className="size-3.5" aria-hidden="true" />
            </a>
          </Pressable>
        )}
      </div>

      {/* The facts a rich card leads with: what the validator objected to, and
          what the file was made from. Up front rather than behind the chevron,
          because "does it open, and what is it based on" is the whole question
          a reader has about a .xlsx they cannot look at here. */}
      {rich && (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2.5">
          {loading && detail === null ? (
            <p className="flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Checking the file…
            </p>
          ) : failed && detail === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-caption leading-relaxed text-muted-foreground">
                Couldn’t read this document’s details. The download is unaffected.
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="h-7 gap-1.5">
                <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            <>
              <VerdictLine artifact={artifact} version={current} warning={detail?.warning ?? null} />
              {current !== null && current.provenance.length > 0 && (
                <Provenance version={current} />
              )}
            </>
          )}
        </div>
      )}

      {open && (
        <div className="border-t border-border/60 px-3 py-2.5 motion-safe:animate-fade-in-up">
          {loading ? (
            <p className="flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Reading its history…
            </p>
          ) : failed ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
                Couldn’t read this document’s history. The download above is unaffected.
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="h-7 gap-1.5">
                <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : detail === null ? null : (
            <div className="space-y-2.5">
              {!rich && detail.warning !== null && (
                <p className="flex items-start gap-1.5 text-caption leading-relaxed text-warning-foreground">
                  <StatusIcons.warning className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
                  {detail.warning}
                </p>
              )}
              <ul className="space-y-2">
                {detail.versions.map((version) => (
                  <li key={version.version}>
                    <div className="flex items-baseline gap-2">
                      <a
                        href={workArtifactDownloadUrl(artifact.id, version.version)}
                        className="shrink-0 font-mono text-micro text-foreground underline-offset-2 hover:underline"
                      >
                        v{version.version}
                      </a>
                      <span className="min-w-0 flex-1 truncate font-mono text-micro text-muted-foreground">
                        {formatBytes(version.byteSize)} · {version.origin}
                        {!version.validated && " · not confirmed to open"}
                      </span>
                      <span className="shrink-0 font-mono text-micro text-muted-foreground">
                        {workTimeAgo(version.createdAt)}
                      </span>
                    </div>
                    {version.problems.length > 0 && (
                      <ul className="mt-1 space-y-0.5 pl-6">
                        {version.problems.map((problem) => (
                          <li key={problem} className="text-caption leading-relaxed text-warning-foreground">
                            {problem}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* The rich card already shows the current version's
                        provenance above; older versions list theirs here. */}
                    {version.provenance.length > 0 && (!rich || version.version !== artifact.currentVersion) && (
                      <div className="mt-1 pl-6">
                        <Provenance version={version} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Mounted unconditionally, and cheap while shut: Radix renders no content
          for a closed dialog, and the previewer downloads nothing until `open`
          and frees the archive again the moment it closes. */}
      {canPreviewArtifact(artifact.kind) && (
        <WorkDeliverablePreview
          kind={artifact.kind}
          artifactId={artifact.id}
          version={artifact.currentVersion}
          title={artifact.title}
          open={previewing}
          onOpenChange={setPreviewing}
        />
      )}
    </li>
  );
}

/**
 * Whether the file opens, in a sentence — and, when it does not, why.
 *
 * `validation.problems` is the validator's own list and until now reached no
 * screen: a reader was told "not re-opened" and left to download the file to
 * find out that a sheet name was too long. The route's warning sentence is the
 * fallback for a version whose verdict recorded no problems.
 */
function VerdictLine({
  artifact,
  version,
  warning,
}: {
  artifact: ClientWorkArtifact;
  version: WorkArtifactVersion | null;
  warning: string | null;
}) {
  if (artifact.validatedAt !== null && (version === null || version.validated)) {
    return (
      <p className="flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground">
        <StatusIcons.success className="mt-0.5 size-3 shrink-0 text-success-ink" aria-hidden="true" />
        Re-opened by the validator after it was written, so it opens in the application it was made
        for.
      </p>
    );
  }
  const problems = version?.problems ?? [];
  return (
    <div className="space-y-1">
      <p className="flex items-start gap-1.5 text-caption leading-relaxed text-warning-foreground">
        <StatusIcons.warning className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
        {problems.length > 0
          ? "The validator could not confirm this file opens. It said:"
          : (warning ??
            "Nothing has confirmed this file opens. Check it before sending it to anyone.")}
      </p>
      {problems.length > 0 && (
        <ul className="space-y-0.5 pl-[18px]">
          {problems.map((problem) => (
            <li key={problem} className="text-caption leading-relaxed text-warning-foreground">
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a version was made from: the sources the run relied on for it. */
function Provenance({ version }: { version: WorkArtifactVersion }) {
  return (
    <ul className="space-y-0.5">
      {version.provenance.map((entry, index) => (
        <li
          key={`${entry.kind}-${index}`}
          className="flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground"
        >
          {entry.url === null ? (
            <span
              className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/70"
              aria-hidden="true"
            />
          ) : (
            <Link2 className="mt-[3px] size-3 shrink-0 text-source" aria-hidden="true" />
          )}
          {entry.url === null ? (
            <span className="min-w-0 truncate">{entry.label}</span>
          ) : (
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline"
            >
              {entry.label}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
