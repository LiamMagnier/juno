"use client";

import * as React from "react";
import { AlertTriangle, ChevronRight, Download, Link2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ARTIFACT_EXTENSION } from "@/lib/work/domain";
import type { ClientWorkArtifact } from "@/lib/work/serializers";
import type { WorkProducedArtifact } from "@/components/work/work-detail-panels";
import {
  fetchWorkArtifact,
  fetchWorkArtifacts,
  workArtifactDownloadUrl,
  type WorkArtifactDetail,
} from "@/components/work/work-transport";
import { WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
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
 * So the panel reads the artifact list rather than inferring it. The event
 * stream is still used, for two things it is better at than a list endpoint:
 * it is what tells this component that a new document exists (which is what
 * triggers the refetch below), and it is what the panel falls back to when the
 * list request fails — a row derived from an event is a real document that
 * really was written, and showing it without a download beside it is a better
 * answer than an empty panel.
 *
 * Version history is fetched per document and only when a reader opens one. A
 * task that regenerates a workbook on a daily schedule accumulates versions
 * indefinitely, and pulling every one of them for every document on first paint
 * would spend a second of somebody's time on rows nobody scrolls to.
 */

export function WorkDocuments({
  sessionId,
  /**
   * What the event stream says was produced.
   *
   * Two jobs: the count is the signal to re-read the list — a new
   * `artifact_created` is the only thing that changes it — and the rows
   * themselves are what gets rendered if the list request never lands.
   */
  fromEvents,
}: {
  sessionId: string;
  fromEvents: readonly WorkProducedArtifact[];
}) {
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

  const produced = fromEvents.length;
  React.useEffect(() => {
    void load();
    // `produced` is in the dependency list on purpose: the run writing a new
    // artifact is exactly the moment this list is out of date, and the event
    // that says so has already arrived on the stream this page is reading.
  }, [load, produced]);

  if (artifacts === null && !failed) {
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, index) => (
          <Skeleton
            key={index}
            className="h-[58px] w-full rounded-xl"
            style={{ animationDelay: `${index * 70}ms` }}
          />
        ))}
      </div>
    );
  }

  if (failed && artifacts === null) {
    return (
      <div className="space-y-2.5">
        <WorkStateNote
          tone="error"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Couldn’t load this task’s documents, so nothing here can be downloaded yet. The files
          themselves are unaffected.
        </WorkStateNote>
        {/* The transcript still knows what was written, even when the list of it
            could not be read. Naming them without offering a download is the
            honest half of the answer rather than none of it. */}
        {fromEvents.length > 0 && (
          <ul className="space-y-2">
            {fromEvents.map((artifact) => (
              <li
                key={artifact.id}
                className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/50 px-3 py-2.5"
              >
                <KindBadge extension={ARTIFACT_EXTENSION[artifact.kind]} />
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
        )}
      </div>
    );
  }

  if ((artifacts ?? []).length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        No documents yet. Anything Juno produces — a workbook, a report, a deck — is listed here as
        it is written, with the file itself behind it.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {failed && (
        <p className="text-[12px] leading-relaxed text-warning-foreground">
          This list could not be refreshed just now, so a document written in the last few seconds
          may be missing from it.
        </p>
      )}
      <ul className="space-y-2">
        {(artifacts ?? []).map((artifact) => (
          <DocumentRow key={artifact.id} artifact={artifact} />
        ))}
      </ul>
    </div>
  );
}

function KindBadge({ extension }: { extension: string }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted font-mono text-[9px] text-muted-foreground">
      {extension}
    </span>
  );
}

/**
 * One document, closed by default.
 *
 * The primary action is the download of the current version, which is what
 * somebody opening this panel wants; everything else — the older versions, what
 * each was made from, whether the validator could re-open it — is behind the
 * row rather than in front of it.
 */
function DocumentRow({ artifact }: { artifact: ClientWorkArtifact }) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<WorkArtifactDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const result = await fetchWorkArtifact(artifact.id);
    setLoading(false);
    if (result.kind === "ok") {
      setDetail(result.value);
      return;
    }
    setFailed(true);
  }, [artifact.id]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Fetched once and kept. A version history is append-only, so re-reading it
    // every time the row is folded and unfolded would cost a request per click
    // to learn the same thing.
    if (next && detail === null && !loading) void load();
  };

  return (
    <li className="rounded-xl border border-border/60 bg-card/50">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <KindBadge extension={ARTIFACT_EXTENSION[artifact.kind]} />
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="group min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {artifact.title}
            </span>
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-base ease-out-soft",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
            v{artifact.currentVersion} · {workTimeAgo(artifact.updatedAt)}
            {artifact.validatedAt === null && " · not re-opened"}
          </span>
        </button>
        <a
          href={workArtifactDownloadUrl(artifact.id)}
          // No `download` attribute: the route sets Content-Disposition itself,
          // and a filename asserted here would be this bundle's guess rather
          // than the one the file was written under.
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] text-muted-foreground transition-[background-color,color] duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Download ${artifact.title}`}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {open && (
        <div className="border-t border-border/60 px-3 py-2.5">
          {loading ? (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Reading its history…
            </p>
          ) : failed ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
                Couldn’t read this document’s history. The download above is unaffected.
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="h-7 gap-1.5">
                <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : detail === null ? null : (
            <div className="space-y-2.5">
              {detail.warning !== null && (
                <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-warning-foreground">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
                  {detail.warning}
                </p>
              )}
              <ul className="space-y-2">
                {detail.versions.map((version) => (
                  <li key={version.version}>
                    <div className="flex items-baseline gap-2">
                      <a
                        href={workArtifactDownloadUrl(artifact.id, version.version)}
                        className="shrink-0 font-mono text-[10px] text-foreground underline-offset-2 hover:underline"
                      >
                        v{version.version}
                      </a>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                        {formatBytes(version.byteSize)} · {version.origin}
                        {/* The absence of a pass is stated, never the presence
                            of a failure: a version written by a build whose
                            verdict this one cannot read is "not confirmed", not
                            "broken". */}
                        {!version.validated && " · not confirmed to open"}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {workTimeAgo(version.createdAt)}
                      </span>
                    </div>
                    {version.provenance.length > 0 && (
                      <ul className="mt-1 space-y-0.5 pl-6">
                        {version.provenance.map((entry, index) => (
                          <li
                            key={`${entry.kind}-${index}`}
                            className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground"
                          >
                            {entry.url === null ? (
                              <span
                                className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"
                                aria-hidden="true"
                              />
                            ) : (
                              <Link2 className="mt-[3px] h-3 w-3 shrink-0 text-source" aria-hidden="true" />
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
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
