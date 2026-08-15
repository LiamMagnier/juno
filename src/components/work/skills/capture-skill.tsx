"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { skillSlugFromName } from "@/lib/work/skills";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { createWorkSkill } from "@/components/work/work-transport";
import type { PlanStep, PerformedActions } from "@/components/work/work-timeline";
import { WorkStateNote } from "@/components/work/work-vocabulary";

/*
 * Turning a task that worked into a skill you can run again.
 *
 * THE GAP THIS FILLS. Skills existed and could only be AUTHORED — a blank
 * textarea at /work/skills/new asking somebody to write, in advance and in the
 * abstract, instructions for a job they have not done yet. That is the hardest
 * possible moment to write them, and it is why skill libraries in every product
 * that only offers upfront authoring stay empty. The easy moment is straight
 * after a run that went well, when the steps are on the screen and the person
 * is thinking "I will want that again next month".
 *
 * IT IS A DRAFT, NOT AN AUTOMATION. Juno proposes; the reader edits and presses
 * a button. Nothing is created, enabled or made auto-selectable without an
 * explicit press, and the draft is shown in full and editable before that press
 * — which is the pattern this whole surface uses for anything consequential: say
 * what you understood, in the reader's words, and wait.
 *
 * THE DRAFT IS BUILT FROM THE PLAN, NOT THE TRANSCRIPT. A run's assistant
 * messages are prose written for one occasion — "I found 14 invoices in the
 * folder you mentioned" — and pasting them into a skill produces instructions
 * that describe last month rather than the job. The plan steps are already the
 * generalisable part: they are what the agent decided the SHAPE of the work was,
 * and they read as instructions with almost no editing. The performed actions
 * are appended as a note about what it needed access to, because that is the
 * fact that most often makes a re-run fail.
 *
 * ORIGIN IS `authored`, AND THAT IS CORRECT RATHER THAN CONVENIENT. The server
 * derives trust from origin: `authored` means user-authored and is trusted for
 * automatic selection, `imported` is untrusted. These instructions came out of
 * the user's own run on their own account and are being reviewed by them in this
 * dialog before they exist. That is exactly what `authored` describes. It would
 * be wrong for a skill pasted in from somewhere else, and this dialog cannot
 * produce one of those.
 */

/**
 * Whether this run is worth offering to capture.
 *
 * Completed only, and only with a plan. A failed run's steps are a record of
 * something that did not work, and turning that into a reusable skill is
 * teaching the mistake; a run with no plan has nothing to generalise from and
 * the draft would be one line repeating the goal. Two steps is the floor — a
 * one-step task is a sentence, and a sentence does not need a skill.
 */
export function canCaptureSkill(status: string, plan: readonly PlanStep[]): boolean {
  return status === "completed" && plan.filter((step) => step.state === "done").length >= 2;
}

/**
 * The instructions Juno proposes, from what the run actually did.
 *
 * Written in the second person and the imperative, because that is what a skill
 * is: instructions handed to Juno next time. The steps are numbered rather than
 * bulleted, since a plan's order is usually load-bearing, and the ones that were
 * skipped or never finished are dropped — a skill that tells Juno to do a step
 * the original run abandoned is a skill that fails the same way on purpose.
 */
export function draftInstructions(
  goal: string,
  plan: readonly PlanStep[],
  performed: PerformedActions
): string {
  const steps = plan.filter((step) => step.state === "done");
  const lines: string[] = [];
  lines.push(goal.trim());
  lines.push("");
  lines.push("Steps:");
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title}`);
  });
  if (performed.actions.length > 0) {
    lines.push("");
    lines.push("Last time this needed to:");
    // Capped, and capped low. This is a note about access, not a second
    // transcript — a skill carrying forty lines of "sent a message to X" is a
    // log somebody has to delete before the skill is usable.
    for (const action of performed.actions.slice(0, 6)) {
      lines.push(`- ${action.summary}`);
    }
  }
  return lines.join("\n");
}

/** A one-line description, which the router uses to decide when to reach for it. */
export function draftDescription(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, " ");
  // The routing description is what `scoreSkillsForGoal` matches a future goal
  // against, so it has to read like the job rather than like this instance of
  // it. Truncated at a sentence where there is one, because the second sentence
  // of a goal is almost always the particulars of the day it was written.
  const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] ?? trimmed;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}…` : firstSentence;
}

/** A short name, for the slug. Never the whole goal. */
function draftName(session: ClientWorkSession): string {
  const title = session.title.trim();
  if (title.length > 0 && title.toLowerCase() !== "untitled task") {
    return title.length > 60 ? title.slice(0, 60).trimEnd() : title;
  }
  const goal = session.goal.trim().replace(/\s+/g, " ");
  return goal.length > 60 ? `${goal.slice(0, 57).trimEnd()}…` : goal;
}

export function CaptureSkillButton({
  session,
  plan,
  performed,
}: {
  session: ClientWorkSession;
  plan: readonly PlanStep[];
  performed: PerformedActions;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-8 w-full gap-1.5"
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        Save this as a skill
      </Button>
      {/* Mounted only while open, so the draft is rebuilt from the run as it
          stands at the moment of the press rather than as it stood when the
          section first rendered. A run can finish a step between the two. */}
      {open && (
        <CaptureSkillDialog
          session={session}
          plan={plan}
          performed={performed}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function CaptureSkillDialog({
  session,
  plan,
  performed,
  onOpenChange,
}: {
  session: ClientWorkSession;
  plan: readonly PlanStep[];
  performed: PerformedActions;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(() => draftName(session));
  const [description, setDescription] = React.useState(() => draftDescription(session.goal));
  const [instructions, setInstructions] = React.useState(() =>
    draftInstructions(session.goal, plan, performed)
  );
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const slug = skillSlugFromName(name);
  const canSave =
    name.trim().length > 0 && instructions.trim().length > 0 && slug !== null && !saving;

  const save = async () => {
    setSaving(true);
    setRefusal(null);
    const result = await createWorkSkill({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      // See the note at the top of the file: these are the reader's own
      // instructions, from their own run, reviewed by them in this dialog.
      origin: "authored",
    });
    setSaving(false);
    if (result.kind === "ok") {
      toast.success(`Saved as /${result.value.slug}.`);
      onOpenChange(false);
      router.push(`/work/skills/${result.value.id}`);
      return;
    }
    setRefusal(
      result.kind === "blocked"
        ? result.explanation
        : result.kind === "failed" && result.cause === "rejected"
          ? "Juno wouldn’t accept that. Check the name and try again — nothing was created."
          : "Couldn’t reach Juno to save this. Nothing was created."
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Save this task as a skill</DialogTitle>
          {/*
            The confirmation-card sentence: what Juno understood, and what will
            happen when the button is pressed. Stated before the fields rather
            than after them, because it is the thing that decides whether the
            reader reads the fields at all.
          */}
          <DialogDescription>
            Juno has drafted this from the steps it actually took. Change anything you like — it is
            saved exactly as it reads here, and nothing runs until you ask for it by name.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="capture-name">Name</Label>
            <Input
              id="capture-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 font-mono text-micro text-muted-foreground">
              {slug === null
                ? "Give it a name with at least one letter or number in it."
                : `You will type /${slug} to use it.`}
            </p>
          </div>

          <div>
            <Label htmlFor="capture-description">What it is for</Label>
            <Input
              id="capture-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
              One line. This is what Juno reads when deciding whether a future task is this job, so
              describe the job rather than this particular run of it.
            </p>
          </div>

          <div>
            <Label htmlFor="capture-instructions">Instructions</Label>
            <Textarea
              id="capture-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={12}
              className="mt-1.5 font-mono text-ui"
            />
          </div>

          {refusal !== null && <WorkStateNote tone="error">{refusal}</WorkStateNote>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving…" : "Save the skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
