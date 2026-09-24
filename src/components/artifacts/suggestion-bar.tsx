"use client";

import * as React from "react";
import { GitCompare } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { SuggestionCompareDialog, useSuggestionActions } from "@/components/artifacts/suggestion-compare-dialog";
import { suggestionIsBehind } from "@/lib/artifact-card-state";
import type { ArtifactType } from "@/lib/message-content";
import { cn } from "@/lib/utils";
import type { ClientArtifact, ClientArtifactSuggestion } from "@/types/chat";

export { SuggestionCompareDialog } from "@/components/artifacts/suggestion-compare-dialog";

/**
 * "Juno’s suggestion is waiting · Compare · Apply · Dismiss" — the re-emit
 * guard's one piece of UI (04-MERGE-PLAN §2.7, R1 §3C).
 *
 * When Juno writes an artifact again after a person edited it, or in a way
 * that would drop structure a design had, the write is held as a suggestion
 * instead of becoming the current version. This bar is where the person
 * decides. It appears in three places, drawn two ways:
 *
 *   "card"  inside the chat card of the reply that made the suggestion, under
 *           the header, above the preview (which still shows the CURRENT
 *           version, because that is what is saved). First, because the
 *           reply's prose usually says "I've updated it" and the picture under
 *           it has not changed; the bar is what makes that honest.
 *   "bar"   a full-width strip at the top of the canvas and of `/a/{id}`, in
 *           the notice-strip register those surfaces already use (the stale
 *           save conflict), so it reads as chrome about the artifact rather
 *           than as part of it.
 *
 * APPLY SENDS THE VERSION ON SCREEN as the base, and the route refuses it if
 * the artifact moved. When the suggestion was written against an OLDER
 * version than the one on screen — the person saved after Juno's reply —
 * Apply opens Compare instead of applying blind: the suggestion knows nothing
 * of that save, and replacing it should be a decision made while looking at
 * both.
 *
 * Nothing here blocks a person's own save. A suggestion waits beside the
 * artifact; it never locks it.
 *
 * `onResolved` receives the server's copy, marked for `mergeArtifactUpdate`
 * (artifact-card-state.ts): `pendingSuggestion: null` once resolved, left
 * undefined on a stale answer so the surface keeps the bar against the new
 * version.
 */
export function SuggestionBar({
  artifactId,
  type,
  currentVersion,
  suggestion,
  variant,
  onResolved,
  className,
}: {
  artifactId: string;
  type: ArtifactType;
  /** The version the surface shows, which Apply names as its base. */
  currentVersion: number;
  suggestion: ClientArtifactSuggestion;
  variant: "card" | "bar";
  onResolved: (artifact: ClientArtifact) => void;
  className?: string;
}) {
  const [compareOpen, setCompareOpen] = React.useState(false);
  const { busy, apply, dismiss } = useSuggestionActions({ artifactId, suggestionId: suggestion.id, onResolved });
  const behind = suggestionIsBehind(suggestion, currentVersion);
  const card = variant === "card";

  const onApply = () => {
    if (behind) setCompareOpen(true);
    else void apply(currentVersion);
  };

  // The card's controls keep its header's compact 28px row; the bar's keep
  // the notice-strip size the canvas's conflict bar uses.
  const control = card ? "h-7 px-2.5 text-caption" : "h-6 px-2 text-caption";

  return (
    <div
      role="group"
      aria-label="Juno’s suggestion"
      className={cn(
        // One quiet accent wash: a waiting suggestion is STATE, which is what
        // the accent is spent on, and the tint is what separates the strip
        // from the preview under it without a second border.
        "flex border-border/60 bg-primary/5 motion-safe:animate-fade-in",
        card
          ? // The card is an `@container`: side by side once the card is
            // wide enough for the words and three buttons, stacked below it.
            "flex-col gap-2 border-b px-3.5 py-2.5 @[28rem]:flex-row @[28rem]:items-center"
          : "flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5",
        className
      )}
    >
      {/* The bar's words ask for 15rem before they shrink, so on a narrow
          canvas the buttons wrap under them instead of the sentence being
          truncated to "Juno’s suggestion is wait…". */}
      <div className={cn("flex min-w-0 flex-1 gap-2", card ? "items-start" : "basis-60 items-center")}>
        <GitCompare className={cn("size-4 shrink-0 text-primary", card && "mt-0.5")} aria-hidden />
        <p className={cn("min-w-0", card ? "text-ui" : "truncate text-caption")}>
          <span className="font-medium text-foreground">Juno’s suggestion is waiting</span>
          {suggestion.summary &&
            (card ? (
              <span className="block truncate pt-0.5 text-caption text-muted-foreground">{suggestion.summary}</span>
            ) : (
              <span className="text-muted-foreground"> · {suggestion.summary}</span>
            ))}
        </p>
      </div>
      <div className={cn("flex shrink-0 items-center gap-1", card ? "self-end @[28rem]:self-auto" : "ml-auto")}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCompareOpen(true)}
          disabled={busy !== null}
          aria-label="Compare Juno’s suggestion"
          className={control}
        >
          Compare
        </Button>
        <Button
          size="sm"
          onClick={onApply}
          loading={busy === "apply"}
          disabled={busy !== null}
          aria-label={behind ? "Apply Juno’s suggestion, which opens Compare first" : "Apply Juno’s suggestion"}
          className={control}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void dismiss()}
          loading={busy === "dismiss"}
          disabled={busy !== null}
          aria-label="Dismiss Juno’s suggestion"
          className={control}
        >
          Dismiss
        </Button>
      </div>
      <SuggestionCompareDialog
        artifactId={artifactId}
        type={type}
        suggestionId={suggestion.id}
        currentVersion={currentVersion}
        open={compareOpen}
        onOpenChange={setCompareOpen}
        onResolved={onResolved}
      />
    </div>
  );
}
