"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowLeft, Loader2, ShieldAlert } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { memoryCategoryLabel } from "@/lib/memory-categories";
import { MEMORY_IMPORT_PROMPT, type ImportCandidate } from "@/lib/memory-import";
import { sensitiveTopicLabel } from "@/lib/memory-sensitive";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * Import from another assistant, in three steps.
 *
 * COPY → PASTE → REVIEW, and each is its own screen rather than one long form,
 * because the middle step happens somewhere else: the user leaves for ChatGPT,
 * pastes the prompt, waits for an answer, and comes back. A single form would
 * greet them on return with the prompt they already used above the box they
 * need, and no sense of where they had got to. The step rail at the top is
 * that sense.
 *
 * THE REVIEW IS THE FEATURE. Nothing is written until the user has seen every
 * candidate and pressed Import, and what starts ticked is decided by rules
 * they can see (src/lib/memory-import.ts): new facts ticked, sensitive ones on
 * a topic they have not opted into unticked with their chip, already-known
 * ones unticked, forgotten ones not tickable at all.
 *
 * Motion: each step arrives with `stage-in` — the product's "next screen of a
 * staged flow" entrance — keyed on the step so it replays on Back as well as
 * Next; review rows deal in at the tight stagger. Both are CSS keyframes, so
 * they finish in a background tab and collapse to a fade under reduced motion
 * through the tiering globals.css already applies.
 */

type Step = "copy" | "paste" | "review";
const STEPS: { id: Step; label: string }[] = [
  { id: "copy", label: "Copy the prompt" },
  { id: "paste", label: "Paste the answer" },
  { id: "review", label: "Choose what to keep" },
];

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reload the page's rows once something was imported. */
  onImported: () => Promise<void>;
}

export function ImportDialog({ open, onOpenChange, onImported }: ImportDialogProps) {
  const [step, setStep] = React.useState<Step>("copy");
  const [text, setText] = React.useState("");
  const [candidates, setCandidates] = React.useState<ImportCandidate[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(() => new Set());
  const [working, setWorking] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // A closed dialog forgets its paste: the next import starts at step one, not
  // halfway through the last one with someone else's list in the box.
  React.useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      setStep("copy");
      setText("");
      setCandidates([]);
      setSelected(new Set());
      setCopied(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [open]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy. Select the prompt and copy it by hand.");
    }
  };

  const review = async () => {
    setWorking(true);
    try {
      const res = await fetch("/api/memory/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => ({}))) as { candidates?: ImportCandidate[]; error?: string };
      if (!res.ok || !data.candidates) throw new Error(data.error || "Couldn’t read that list.");
      setCandidates(data.candidates);
      setSelected(new Set(data.candidates.flatMap((candidate, i) => (candidate.selected ? [i] : []))));
      setStep("review");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t read that list.");
    } finally {
      setWorking(false);
    }
  };

  const commit = async () => {
    const facts = candidates.filter((_, i) => selected.has(i)).map((candidate) => candidate.content);
    if (facts.length === 0) return;
    setWorking(true);
    try {
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facts }),
      });
      const data = (await res.json().catch(() => ({}))) as { created?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn’t import those.");
      await onImported();
      const created = data.created ?? 0;
      toast.success(
        created > 0
          ? `Imported ${created} ${created === 1 ? "fact" : "facts"} into Juno’s memory.`
          : "Nothing new to import — Juno already knew all of that."
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t import those.");
    } finally {
      setWorking(false);
    }
  };

  const selectable = candidates.flatMap((candidate, i) =>
    candidate.status === "forgotten" || candidate.status === "secret" ? [] : [i]
  );
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i));
  const someSelected = selectable.some((i) => selected.has(i));
  const toggle = (index: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88dvh,46rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 p-6 pb-4">
          <DialogTitle>Import memory</DialogTitle>
          <DialogDescription>
            Bring what ChatGPT, Claude or Gemini knows about you. Nothing is saved until you choose.
          </DialogDescription>
          {/* The step rail. An ordered list, because the steps ARE an order,
              and aria-current is what tells a screen reader where it is. */}
          <ol className="flex items-center gap-2 pt-3" aria-label="Import steps">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                aria-current={s.id === step ? "step" : undefined}
                className="flex min-w-0 flex-1 flex-col gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1 rounded-full transition-colors duration-base ease-out-soft motion-reduce:transition-none",
                    i <= stepIndex ? "bg-primary" : "bg-muted"
                  )}
                />
                <span
                  className={cn(
                    "truncate text-caption transition-colors duration-base",
                    s.id === step ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        </DialogHeader>

        <div key={step} className="min-h-0 flex-1 overflow-y-auto p-6 motion-safe:animate-stage-in">
          {step === "copy" && (
            <div className="space-y-4">
              <p className="text-ui text-muted-foreground">
                Paste this into the assistant you’re coming from, in a new chat. It asks for everything it remembers,
                written one fact per line so Juno can read it back.
              </p>
              <pre className="surface-inset max-h-64 overflow-y-auto whitespace-pre-wrap rounded-field px-4 py-3 font-mono text-caption leading-relaxed text-foreground/90">
                {MEMORY_IMPORT_PROMPT}
              </pre>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copyPrompt()}>
                {copied ? (
                  <StatusIcons.success className="size-3.5" aria-hidden="true" />
                ) : (
                  <ActionIcons.copy className="size-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
            </div>
          )}

          {step === "paste" && (
            <div className="space-y-3">
              <label htmlFor="memory-import-text" className="text-ui text-muted-foreground">
                Paste the whole answer here — the list, and anything around it. Juno picks out the facts. A Juno memory
                export (.json) works too.
              </label>
              <Textarea
                id="memory-import-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={12}
                autoFocus
                placeholder={"- The user is a product designer in Lisbon.\n- The user prefers short answers with examples."}
                className="font-mono text-caption"
              />
            </div>
          )}

          {step === "review" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2.5 text-ui">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(on) =>
                      setSelected(on === true ? new Set(selectable) : new Set())
                    }
                    aria-label="Select every fact"
                  />
                  <span>
                    {selected.size} of {candidates.length} selected
                  </span>
                </label>
                <p className="text-caption text-muted-foreground">
                  Sensitive facts start unticked — tick them only if you want Juno to keep them.
                </p>
              </div>
              <ul className="divide-y divide-border/50 overflow-hidden rounded-card border border-border/60">
                {candidates.map((candidate, i) => (
                  <ReviewRow
                    key={`${i}-${candidate.content}`}
                    candidate={candidate}
                    index={i}
                    checked={selected.has(i)}
                    onCheckedChange={(on) => toggle(i, on)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/50 px-6 py-4">
          {step !== "copy" && (
            <Button
              variant="ghost"
              className="gap-1.5 sm:mr-auto"
              disabled={working}
              onClick={() => setStep(step === "review" ? "paste" : "copy")}
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Back
            </Button>
          )}
          {step === "copy" && <Button onClick={() => setStep("paste")}>I’ve got the answer</Button>}
          {step === "paste" && (
            <Button disabled={!text.trim() || working} onClick={() => void review()} className="gap-1.5">
              {working && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              {working ? "Reading…" : "Review"}
            </Button>
          )}
          {step === "review" && (
            <Button disabled={selected.size === 0 || working} onClick={() => void commit()} className="gap-1.5">
              {working && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              {working
                ? "Importing…"
                : `Import ${selected.size} ${selected.size === 1 ? "fact" : "facts"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({
  candidate,
  index,
  checked,
  onCheckedChange,
}: {
  candidate: ImportCandidate;
  index: number;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  // Neither can be ticked: the write door refuses a forgotten statement, and a
  // secret is never imported at all.
  const forgotten = candidate.status === "forgotten" || candidate.status === "secret";
  const id = `memory-import-row-${index}`;
  return (
    <li
      style={staggerDelay(index, "tight")}
      className={cn(
        "flex items-start gap-3 px-4 py-3 motion-safe:animate-fade-in-up [animation-fill-mode:backwards]",
        forgotten && "opacity-60"
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={forgotten}
        onCheckedChange={(on) => onCheckedChange(on === true)}
        className="mt-0.5"
      />
      <label htmlFor={id} className={cn("min-w-0 flex-1", !forgotten && "cursor-pointer")}>
        <span className={cn("block text-ui text-foreground/90", forgotten && "line-through")}>{candidate.content}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="soft">{memoryCategoryLabel(candidate.category)}</Badge>
          {candidate.sensitive && (
            <Badge variant="outline" className="gap-1 border-warning/40 bg-warning/10">
              <ShieldAlert className="size-3" aria-hidden="true" />
              {sensitiveTopicLabel(candidate.sensitive)}
            </Badge>
          )}
          {candidate.status === "known" && <Badge variant="muted">Already remembered</Badge>}
          {candidate.status === "forgotten" && <Badge variant="muted">You asked Juno to forget this</Badge>}
          {candidate.status === "secret" && (
            <Badge variant="outline" className="gap-1 border-destructive/40 bg-destructive/10">
              Looks like a password or key — never imported
            </Badge>
          )}
        </span>
      </label>
    </li>
  );
}
