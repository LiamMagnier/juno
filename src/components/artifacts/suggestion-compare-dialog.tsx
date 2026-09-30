"use client";

import * as React from "react";
import { toast } from "sonner";
import { GitCompare } from "@/components/ui/icons";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import {
  comparisonNotice,
  readSuggestionComparison,
  suggestionOutcome,
  suggestionToast,
  suggestionUrl,
  type SuggestionComparison,
  type SuggestionOutcome,
} from "@/lib/artifact-card-state";
import { diffLines } from "@/lib/line-diff";
import type { ArtifactType } from "@/lib/message-content";
import { cn } from "@/lib/utils";
import type { ClientArtifact } from "@/types/chat";

/**
 * Apply and Dismiss, shared by the bar and the dialog so both surfaces reach
 * the same routes, read the same answers and say the same words.
 *
 * `onResolved` gets the server's copy whenever an answer carries one — applied,
 * dismissed, already resolved, or stale. The copy is already marked for
 * `mergeArtifactUpdate`: a resolution sets `pendingSuggestion: null`, and a
 * stale answer leaves it undefined, because the suggestion is still waiting and
 * the surface should keep showing it against the artifact's new version.
 *
 * The in-flight guard is a ref as well as state: two presses inside one render
 * would otherwise both read `busy === null` and post twice.
 */
export function useSuggestionActions({
  artifactId,
  suggestionId,
  onResolved,
}: {
  artifactId: string;
  suggestionId: string;
  onResolved: (artifact: ClientArtifact) => void;
}) {
  const [busy, setBusy] = React.useState<"apply" | "dismiss" | null>(null);
  const inFlight = React.useRef(false);
  const onResolvedRef = React.useRef(onResolved);
  onResolvedRef.current = onResolved;

  const run = React.useCallback(
    async (action: "apply" | "dismiss", baseVersion?: number): Promise<SuggestionOutcome | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(action);
      let outcome: SuggestionOutcome;
      try {
        const res = await fetch(suggestionUrl(artifactId, suggestionId, action), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "apply" ? { baseVersion } : {}),
        });
        const body: unknown = await res.json().catch(() => null);
        outcome = suggestionOutcome(action, res.status, body, suggestionId);
      } catch {
        outcome = { kind: "error" };
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
      const words = suggestionToast(action, outcome);
      if (words) {
        if (words.tone === "success") toast.success(words.message);
        else toast.error(words.message);
      }
      // After the toast: resolving usually unmounts the surface that asked.
      if ("artifact" in outcome && outcome.artifact) onResolvedRef.current(outcome.artifact);
      return outcome;
    },
    [artifactId, suggestionId]
  );

  const apply = React.useCallback((baseVersion: number) => run("apply", baseVersion), [run]);
  const dismiss = React.useCallback(() => run("dismiss"), [run]);
  return { busy, apply, dismiss };
}

type Loaded =
  | { phase: "loading" }
  | { phase: "ready"; view: SuggestionComparison }
  | { phase: "gone" }
  | { phase: "error" };

/**
 * The suggestion's own picture: `…/proposals/{id}/poster`.
 *
 * `DesignPoster` draws a VERSION's poster by artifact id, and a suggestion is
 * not a version, so this is the same `<img>` contract — no script, contained,
 * faded in once decoded, the glyph when it will not draw — pointed at the
 * proposal route. The element's own state is read on mount for the same
 * reason DesignPoster does: a cached picture can settle before React listens.
 */
function SuggestedPoster({ src, alt }: { src: string; alt: string }) {
  const ref = React.useRef<HTMLImageElement>(null);
  const [state, setState] = React.useState<"loading" | "loaded" | "failed">("loading");

  React.useEffect(() => {
    setState("loading");
    const img = ref.current;
    if (!img || !img.complete) return;
    setState(img.naturalWidth > 0 ? "loaded" : "failed");
  }, [src]);

  if (state === "failed") {
    return (
      <span className="flex size-full items-center justify-center text-muted-foreground">
        <AppIcons.design className="size-7" motion="none" aria-hidden />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin SVG
    // drawn per proposal; image mode is the no-script sandbox it needs, and the
    // optimiser would only re-encode a vector as a bitmap.
    <img
      ref={ref}
      src={src}
      alt={alt}
      decoding="async"
      onLoad={() => setState("loaded")}
      onError={() => setState("failed")}
      className={cn(
        "size-full object-contain transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
        state === "loaded" ? "opacity-100" : "opacity-0"
      )}
    />
  );
}

/** One side of the design comparison: a captioned picture in the tile well. */
function PosterFigure({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="min-w-0">
      {/* The Artifacts tile's well: the neutral ground a poster is drawn on
          everywhere else, so the two pictures read as the same object twice. */}
      <div className="surface-inset aspect-[4/3] overflow-hidden rounded-field p-2">{children}</div>
      <figcaption className="pt-2 font-mono text-caption text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

/**
 * Line diff of the current version against the suggestion, drawn the way the
 * canvas's version history draws one, so a person who has read one has read
 * both: removed on the destructive tint, added on the success tint, both
 * gutters in full muted ink.
 */
function SourceDiff({ from, to, fromLabel }: { from: string; to: string; fromLabel: string }) {
  const diff = React.useMemo(() => diffLines(from, to), [from, to]);
  const added = diff.filter((l) => l.type === "added").length;
  const removed = diff.filter((l) => l.type === "removed").length;

  return (
    <div className="overflow-hidden rounded-field border border-border/60 bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <GitCompare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
          {fromLabel} → Juno’s suggestion
        </span>
        {(added > 0 || removed > 0) && (
          <>
            <span className="font-mono text-caption tabular-nums text-success">+{added}</span>
            <span className="font-mono text-caption tabular-nums text-destructive">−{removed}</span>
          </>
        )}
      </div>
      {added === 0 && removed === 0 ? (
        <p className="px-4 py-6 text-center text-body text-muted-foreground">
          The suggestion is the same as {fromLabel}.
        </p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={`Changes from ${fromLabel} to Juno’s suggestion`}
          className="max-h-[min(52dvh,28rem)] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="min-w-max py-2 font-mono text-caption leading-relaxed">
            {diff.map((line, idx) => (
              <div
                key={idx}
                className={cn(
                  "flex border-l-2",
                  line.type === "added"
                    ? "border-success bg-success/10"
                    : line.type === "removed"
                      ? "border-destructive/70 bg-destructive/10 opacity-80"
                      : "border-transparent"
                )}
              >
                <span className="w-9 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground">
                  {line.aLine ?? ""}
                </span>
                <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground">
                  {line.bLine ?? ""}
                </span>
                <span className="whitespace-pre pr-4">{line.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compare what is saved now with what Juno suggested, then Apply or Dismiss.
 *
 * WHAT IS COMPARED IS FETCHED WHEN IT OPENS, never carried in the chat
 * payload: a suggestion can be a whole design, and every chat load would pay
 * for it (serializers.ts, ARTIFACT_CLIENT_INCLUDE). The route answers with the
 * suggestion AND the current version together, so the two sides are one
 * moment's truth rather than a fresh suggestion against whatever version this
 * tab last heard of.
 *
 * APPLY SENDS THE VERSION ON SCREEN. The route's stale check compares it with
 * the artifact's current version, so what gets replaced is exactly what the
 * person just looked at. If it moved in the meantime, the answer is stale and
 * the comparison reloads in place — "compare again before applying" is one
 * look, not a trip back to the card.
 *
 * A DESIGN is two posters rather than a diff: its source is JSON, which never
 * appears by default (04-MERGE-PLAN §1.2), and the route sends no content for
 * it.
 */
export function SuggestionCompareDialog({
  artifactId,
  type,
  suggestionId,
  currentVersion,
  open,
  onOpenChange,
  onResolved,
}: {
  artifactId: string;
  type: ArtifactType;
  suggestionId: string;
  /** The version the opening surface shows; the label until the route answers. */
  currentVersion: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: (artifact: ClientArtifact) => void;
}) {
  const [loaded, setLoaded] = React.useState<Loaded>({ phase: "loading" });
  const [reload, setReload] = React.useState(0);
  const { busy, apply, dismiss } = useSuggestionActions({ artifactId, suggestionId, onResolved });
  const isDesign = type === "DESIGN";

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded({ phase: "loading" });
    (async () => {
      try {
        const res = await fetch(suggestionUrl(artifactId, suggestionId), { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) return setLoaded({ phase: "gone" });
        if (!res.ok) return setLoaded({ phase: "error" });
        const view = readSuggestionComparison(await res.json().catch(() => null));
        if (!cancelled) setLoaded(view ? { phase: "ready", view } : { phase: "error" });
      } catch {
        if (!cancelled) setLoaded({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, artifactId, suggestionId, reload]);

  const view = loaded.phase === "ready" ? loaded.view : null;
  const notice = view ? comparisonNotice(view) : null;
  const shownVersion = view?.current.version ?? currentVersion;
  const pending = view?.proposal.status === "PENDING";

  const settle = (outcome: SuggestionOutcome | null) => {
    if (!outcome) return;
    if (outcome.kind === "stale") setReload((n) => n + 1);
    else if (outcome.kind !== "error") onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88dvh,48rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 p-6 pb-4 pr-14">
          <DialogTitle>Juno’s suggestion</DialogTitle>
          <DialogDescription>
            {view?.proposal.summary ||
              (view?.proposal.title
                ? `A revision of “${view.proposal.title}” that has not been applied.`
                : "A revision Juno made that has not been applied.")}
          </DialogDescription>
        </DialogHeader>

        <div
          key={`${loaded.phase}-${reload}`}
          aria-busy={loaded.phase === "loading" || undefined}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 motion-safe:animate-fade-in"
        >
          {loaded.phase === "loading" ? (
            isDesign ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="aspect-[4/3] rounded-field" />
                <Skeleton className="aspect-[4/3] rounded-field" />
              </div>
            ) : (
              <Skeleton className="h-64 rounded-field" />
            )
          ) : loaded.phase === "gone" ? (
            <EmptyState
              size="panel"
              icon={StatusIcons.info}
              title="No longer available"
              description="Its artifact is in Recently deleted, or the reply that made it was removed."
            />
          ) : loaded.phase === "error" ? (
            <EmptyState
              tone="error"
              size="panel"
              icon={StatusIcons.error}
              title="Couldn’t load the comparison"
              description="Nothing was changed."
              action={
                <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                  Try again
                </Button>
              }
            />
          ) : view ? (
            <>
              {notice && (
                <div
                  role="status"
                  className={cn(
                    "flex items-start gap-2 rounded-field border px-3 py-2.5 text-ui",
                    notice.kind === "behind"
                      ? "border-warning/40 bg-warning/10 text-warning-foreground"
                      : "border-border/70 bg-muted text-muted-foreground"
                  )}
                >
                  {notice.kind === "behind" ? (
                    <StatusIcons.warning className="mt-0.5 size-4 shrink-0" aria-hidden />
                  ) : (
                    <StatusIcons.info className="mt-0.5 size-4 shrink-0" aria-hidden />
                  )}
                  <span>{notice.message}</span>
                </div>
              )}
              {isDesign ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <PosterFigure caption={`Now · v${view.current.version}`}>
                    <DesignPoster
                      artifactId={artifactId}
                      version={view.current.version}
                      alt={`v${view.current.version}, first page`}
                    />
                  </PosterFigure>
                  <PosterFigure caption="Juno’s suggestion">
                    <SuggestedPoster
                      src={suggestionUrl(artifactId, suggestionId, "poster")}
                      alt="Juno’s suggestion, first page"
                    />
                  </PosterFigure>
                </div>
              ) : (
                <SourceDiff
                  from={view.current.content ?? ""}
                  to={view.proposal.content ?? ""}
                  fromLabel={`v${view.current.version}`}
                />
              )}
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/50 px-6 py-4">
          {view && pending ? (
            <>
              <Button
                variant="ghost"
                onClick={async () => settle(await dismiss())}
                loading={busy === "dismiss"}
                disabled={busy !== null}
              >
                Dismiss
              </Button>
              <Button
                onClick={async () => settle(await apply(view.current.version))}
                loading={busy === "apply"}
                disabled={busy !== null}
              >
                Apply as v{shownVersion + 1}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
