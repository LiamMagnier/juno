"use client";

import * as React from "react";
import { toast } from "sonner";
import { RESEARCH_COPY, isResearchRefusal, phrase, researchRefusalLine } from "@/components/research/copy";
import { keepResearchingGoal } from "@/components/research/keep-researching.prompt";
import { announceResearchStarted } from "@/components/research/research-discovery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPhrase, Phrase, PhraseWithArgs, usePhrase } from "@/lib/i18n-phrase";
import type { PhraseLine } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * "Keep researching" (SPEC §9.7, DECISIONS R1): the only way to go further
 * once a run is over. There is no depth to turn up; the reader says what to
 * look into next and a new run starts from the old goal plus those words,
 * with the previous run's cited sources pinned. It goes through its own scope
 * card like any run, so nothing is spent until they press Start there.
 */

export interface KeepResearchingProps {
  /** The finished run's goal. */
  goal: string;
  conversationId: string | null;
  /** The finished run's cited URLs, pinned on the new run. */
  pinnedSources: readonly string[];
  /** The new run exists (its scope card is on its way). */
  onStarted?(runId: string): void;
  className?: string;
}

/** `startResearchSchema` takes at most 24 pinned sources. */
const MAX_PINNED = 24;

export function KeepResearching({ goal, conversationId, pinnedSources, onStarted, className }: KeepResearchingProps) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<PhraseLine | null>(null);
  const placeholder = usePhrase(RESEARCH_COPY.keep.placeholder);
  const inputId = React.useId();

  const submit = async () => {
    const next = text.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: keepResearchingGoal(goal, next),
          conversationId,
          pinnedSources: pinnedSources.slice(0, MAX_PINNED),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { run?: { id?: string }; reason?: unknown; params?: Record<string, string | number> };
      const runId = typeof data.run?.id === "string" ? data.run.id : null;
      if (!res.ok || !runId) {
        setError(
          isResearchRefusal(data.reason)
            ? researchRefusalLine(data.reason, data.params ?? {}, { heading: false })
            : [phrase(RESEARCH_COPY.scope.couldNotStart)],
        );
        return;
      }
      setText("");
      announceResearchStarted({ runId, conversationId });
      toast.success(formatPhrase(RESEARCH_COPY.keep.started));
      onStarted?.(runId);
    } catch {
      setError([phrase(RESEARCH_COPY.scope.couldNotStart)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={cn("space-y-1.5", className)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        <Phrase text={RESEARCH_COPY.keep.placeholder} />
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={text}
          disabled={busy}
          placeholder={placeholder}
          data-no-auto-translate
          onChange={(e) => setText(e.target.value)}
          className="h-9 flex-1"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!text.trim()} loading={busy}>
          <Phrase text={RESEARCH_COPY.keep.action} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-caption text-warning-foreground">
          <PhraseWithArgs spec={error} />
        </p>
      )}
    </form>
  );
}
