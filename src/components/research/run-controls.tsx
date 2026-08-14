"use client";

import * as React from "react";
import { Pause, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { truncate } from "@/lib/utils";

/**
 * The two ways a person's hands reach into a run: the plan gate before any
 * money moves, and steering while it is moving. Shared by the chat panel and
 * the /research reader because both are fronts for the same POST routes, and
 * the gate especially must behave identically — it is the surface that decides
 * whether the expensive part starts at all.
 */

/**
 * The plan gate: nothing expensive has happened yet, and these are the
 * queries that will actually be issued. Editable, because the whole point
 * of stopping here is that the user can change them.
 */
export function PlanReview({
  queries,
  busy,
  onConfirm,
  onDiscard,
}: {
  queries: string[];
  busy: boolean;
  onConfirm: (queries: string[]) => void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = React.useState<string[] | null>(null);
  const current = draft ?? queries;

  return (
    <div className="rounded-field border border-border/50 bg-secondary p-3">
      <p className="text-xs font-medium text-foreground">
        Juno will search for these. Edit anything before it starts.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {current.map((query, i) => (
          <Input
            key={i}
            value={query}
            aria-label={`Search ${i + 1}`}
            onChange={(e) => {
              const next = [...current];
              next[i] = e.target.value;
              setDraft(next);
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || current.every((q) => !q.trim())}
          onClick={() => onConfirm(current.map((q) => q.trim()).filter(Boolean))}
        >
          Start researching
        </Button>
        <Button type="button" size="sm" variant="destructive-outline" disabled={busy} onClick={onDiscard}>
          Discard this run
        </Button>
      </div>
    </div>
  );
}

/**
 * Steering and the run controls. Rendered only while the run is live — there
 * is nothing to steer afterwards, and a disabled row of buttons is just noise.
 */
export function SteerControls({
  constraints,
  paused,
  busy,
  onSteer,
  onControl,
}: {
  constraints: string[];
  paused: boolean;
  busy: boolean;
  /** Resolves true when the server accepted the steer; the input clears only then. */
  onSteer: (body: { constraint: string } | { sourceUrl: string }) => Promise<boolean>;
  onControl: (action: "pause" | "resume" | "cancel") => void;
}) {
  const [steerText, setSteerText] = React.useState("");

  return (
    <div className="flex flex-col gap-2">
      {/* Named, not implied. The bare input used to be the only hint that a
          running investigation takes direction at all, and an unlabeled field
          under a progress bar reads as search, not steering. */}
      <p className="text-xs font-semibold text-foreground">Steer this run</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = steerText.trim();
          if (!value || busy) return;
          // A URL is a source to read; anything else is a constraint on the
          // whole report. Guessing here beats a mode switch the user has to
          // find before they can type.
          void onSteer(/^https?:\/\//i.test(value) ? { sourceUrl: value } : { constraint: value }).then(
            (accepted) => {
              if (accepted) setSteerText("");
            }
          );
        }}
      >
        <Input
          value={steerText}
          onChange={(e) => setSteerText(e.target.value)}
          placeholder="Add a constraint, or paste a source to include…"
          aria-label="Steer this research run"
          className="h-9 flex-1 text-xs"
        />
        <Button
          type="submit"
          size="icon"
          variant="outline"
          disabled={busy || !steerText.trim()}
          aria-label="Add direction to this run"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </form>
      {constraints.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {constraints.map((constraint) => (
            <li
              key={constraint}
              className="rounded-full border border-border/50 px-2 py-0.5 text-caption text-muted-foreground"
            >
              {truncate(constraint, 60)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onControl(paused ? "resume" : "pause")}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          disabled={busy}
          onClick={() => onControl("cancel")}
        >
          Stop research
        </Button>
      </div>
    </div>
  );
}
