"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, ListChecks, Lock, MessageSquare } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { openSkillDraftingChat } from "@/components/skills/add-skill-menu";
import { useReducedMotion } from "@/lib/motion-preference";
import { spring, staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { emptySkillContract } from "@/lib/work/skills";
import {
  emptyTaughtForm,
  taughtInputsFromContract,
  type ClientSkillDraft,
  type TaughtSkillForEdit,
  type TaughtSkillSaved,
} from "@/lib/skills/teach";
import { emptyTeachState, stateFromDraft, stateFromForm, type TeachEditorState } from "@/components/skills/teach/teach-model";
import { TeachEditor, type TeachEditorMode } from "@/components/skills/teach/teach-editor";
import {
  fetchTaughtSkillForEdit,
  fetchTeachContext,
  readStashedSkillDraft,
  teachFailureMessage,
  type TeachContext,
} from "@/components/skills/teach/teach-transport";

/*
 * /skills/teach — Teach Juno.
 *
 *   (nothing)        two ways in: walk through it here, or teach it in a chat
 *   ?mode=walk       the editor, empty, with the caret in the first step
 *   ?draft=<id>      a chat's draft, handed over from its card (session storage)
 *   ?skill=<id>      re-teach a skill you have: the next save is its next version
 *
 * No screen is recorded and nothing is read that the person did not type or do
 * in a conversation with Juno. A draft is only ever a draft: the editor's Save
 * is the one write, and it switches the skill on only with the confirmation
 * the server can check.
 */

type View =
  | { kind: "choose" }
  | { kind: "loading" }
  | { kind: "missing"; message: string }
  | { kind: "edit"; initial: TeachEditorState; mode: TeachEditorMode; draft?: ClientSkillDraft; freeform?: boolean; walk?: boolean }
  | { kind: "saved"; saved: TaughtSkillSaved; conversationId: string | null; revoked?: boolean };

/**
 * The page's apps, plus the ones a chat draft already matched: the draft knows
 * their labels before the account's list has loaded, so a row never flashes
 * an id where "Gmail" belongs.
 */
function withDraftApps(context: TeachContext | null, draft: ClientSkillDraft | undefined): TeachContext | null {
  if (!draft || draft.apps.length === 0) return context;
  const apps = [...(context?.apps ?? [])];
  for (const app of draft.apps) if (!apps.some((known) => known.id === app.id)) apps.push(app);
  return { projects: context?.projects ?? [], apps };
}

/** Free-form instructions as starting steps: one per line, list markers dropped. */
function stepsFromFreeform(instructions: string): string[] {
  return instructions
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|#+)\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

function reteachView(loaded: TaughtSkillForEdit): View {
  const freeform = loaded.form === null;
  const form = loaded.form ?? {
    ...emptyTaughtForm(),
    name: loaded.skill.name,
    whenToUse: loaded.skill.description,
    steps: stepsFromFreeform(loaded.version?.instructions ?? "").map((step) => step.slice(0, 600)),
    // What it asks for each time is shown and sent back, so a save never
    // drops it unseen; a typed input keeps its kind on the server.
    inputs: taughtInputsFromContract(loaded.version?.contract.inputs ?? []),
    tools: loaded.version?.requestedTools ?? [],
    connectors: loaded.version?.contract.requestedConnectors ?? [],
    domains: loaded.version?.contract.requestedDomains ?? [],
  };
  return {
    kind: "edit",
    freeform,
    initial: stateFromForm(form, loaded.skill.projectId),
    mode: {
      kind: "reteach",
      skillId: loaded.skill.id,
      slug: loaded.skill.slug,
      enabled: loaded.skill.enabled,
      currentVersion: loaded.skill.currentVersion,
      base: loaded.version?.contract ?? emptySkillContract(),
      source: { via: loaded.origin?.via ?? "walkthrough", conversationId: null },
    },
  };
}

export function TeachPage() {
  const router = useRouter();
  const params = useSearchParams();
  const reduce = useReducedMotion() ?? false;
  const draftId = params.get("draft");
  const skillId = params.get("skill");
  const walk = params.get("mode") === "walk";

  const [context, setContext] = React.useState<TeachContext | null>(null);
  const [view, setView] = React.useState<View>(() => (draftId || skillId ? { kind: "loading" } : walk ? { kind: "loading" } : { kind: "choose" }));

  React.useEffect(() => {
    let cancelled = false;
    void fetchTeachContext().then((result) => {
      if (!cancelled && result.kind === "ok") setContext(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (skillId) {
      setView({ kind: "loading" });
      void fetchTaughtSkillForEdit(skillId).then((result) => {
        if (cancelled) return;
        if (result.kind === "ok") setView(reteachView(result.value));
        else setView({ kind: "missing", message: teachFailureMessage(result, "That skill couldn’t be opened.") });
      });
    } else if (draftId) {
      const draft = readStashedSkillDraft(draftId);
      setView(
        draft
          ? {
              kind: "edit",
              draft,
              initial: stateFromDraft(draft),
              mode: { kind: "new", key: draft.key, source: draft.source },
            }
          : {
              kind: "missing",
              message: "This draft is no longer in this tab. Open the chat it came from and press Review on its card again.",
            }
      );
    } else if (walk) {
      setView({
        kind: "edit",
        walk: true,
        initial: emptyTeachState(),
        mode: { kind: "new", key: null, source: { via: "walkthrough", conversationId: null } },
      });
    } else {
      setView({ kind: "choose" });
    }
    return () => {
      cancelled = true;
    };
  }, [draftId, skillId, walk]);

  const heading =
    view.kind === "edit" && view.mode.kind === "reteach"
      ? "Teach it again"
      : view.kind === "saved"
        ? "Taught"
        : `Teach ${PRODUCT_NAME}`;
  const lede =
    view.kind === "edit" && view.mode.kind === "reteach"
      ? "Change the steps, what it may use or where it applies. Saving keeps the current version in its history."
      : view.kind === "edit" && view.draft
        ? `${PRODUCT_NAME} drafted this from your chat. Read it, change anything, then save.`
        : "Show it how you do something once. It becomes a skill you review, edit and switch on yourself.";

  return (
    <AppPage measure="reading">
      <AppPageHeader heading={heading} lede={lede} backHref="/skills" backLabel="Back to skills" />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view.kind === "edit" ? `edit:${view.mode.kind}` : view.kind}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0, transition: transition.base }}
          exit={{ opacity: 0, transition: transition.exit }}
        >
          {view.kind === "choose" ? (
            <TeachChooser
              onWalk={() => router.push("/skills/teach?mode=walk")}
              onChat={() => openSkillDraftingChat((href) => router.push(href))}
            />
          ) : view.kind === "loading" ? (
            <div role="status" aria-label="Loading" className="space-y-4">
              <Skeleton className="h-10 w-full rounded-field" />
              <Skeleton className="h-16 w-full rounded-field" />
              <Skeleton className="h-48 w-full rounded-field" />
            </div>
          ) : view.kind === "missing" ? (
            <WorkStateNote
              tone="warning"
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href="/skills/teach">Start over</Link>
                </Button>
              }
            >
              {view.message}
            </WorkStateNote>
          ) : view.kind === "edit" ? (
            <>
              {view.freeform ? (
                <WorkStateNote tone="info" className="mb-6">
                  This skill’s instructions weren’t written as steps, so each line became one. Check them, and “What it
                  asks you for each time”, before you save: the saved version replaces the text with these steps, and
                  what it asks for with that list.
                </WorkStateNote>
              ) : null}
              <TeachEditor
                initial={view.initial}
                mode={view.mode}
                context={withDraftApps(context, view.draft)}
                observed={view.draft?.observed}
                draftNotes={
                  view.draft
                    ? {
                        dropped: view.draft.dropped,
                        missingApps: view.draft.missingApps,
                        fromOutsideContent: view.draft.fromOutsideContent,
                      }
                    : undefined
                }
                autoFocusSteps={view.walk === true}
                onSaved={(saved) =>
                  setView({ kind: "saved", saved, conversationId: view.mode.source.conversationId ?? null })
                }
                onRevoked={() => router.push(`/skills/${view.mode.kind === "reteach" ? view.mode.skillId : ""}`)}
              />
            </>
          ) : (
            <TeachSaved saved={view.saved} conversationId={view.conversationId} reduce={reduce} />
          )}
        </motion.div>
      </AnimatePresence>
    </AppPage>
  );
}

function TeachChooser({ onWalk, onChat }: { onWalk: () => void; onChat: () => void }) {
  const steps = [
    { title: "Show", line: "Walk through the task once, in your own words." },
    { title: "Review", line: "Edit the steps, what it may use and where it applies." },
    { title: "Switch on", line: "Nothing runs until you do. Turn it off any time." },
  ];
  return (
    <div className="space-y-10">
      <div className="grid gap-3 sm:grid-cols-2">
        <Pressable
          kind="tile"
          onClick={onWalk}
          style={staggerDelay(0)}
          className="group gap-2 p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
        >
          <span className="flex size-9 items-center justify-center rounded-control bg-background text-foreground">
            <ListChecks className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="mt-1 text-body font-semibold text-foreground">Walk me through it</span>
          <span className="text-ui leading-relaxed text-muted-foreground">
            Type the steps yourself, one at a time. Enter takes you to the next.
          </span>
          <span className="mt-2 inline-flex items-center gap-1 text-ui font-medium text-foreground">
            Start
            <ArrowRight className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
          </span>
        </Pressable>
        <Pressable
          kind="tile"
          onClick={onChat}
          style={staggerDelay(1)}
          className="group gap-2 p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
        >
          <span className="flex size-9 items-center justify-center rounded-control bg-background text-foreground">
            <MessageSquare className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="mt-1 text-body font-semibold text-foreground">Teach it in a chat</span>
          <span className="text-ui leading-relaxed text-muted-foreground">
            Describe it to {PRODUCT_NAME}. It asks what it needs, then drafts the steps for you to review.
          </span>
          <span className="mt-2 inline-flex items-center gap-1 text-ui font-medium text-foreground">
            Open a chat
            <ArrowRight className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
          </span>
        </Pressable>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3" aria-label="How teaching works">
        {steps.map((step, index) => (
          <li
            key={step.title}
            style={staggerDelay(index + 2)}
            className="flex gap-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium tabular-nums text-muted-on-fill"
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">{step.title}</span>
              <span className="block text-caption leading-relaxed text-muted-foreground">{step.line}</span>
            </span>
          </li>
        ))}
      </ol>

      <p
        style={staggerDelay(5)}
        className="flex items-start gap-2 border-t border-border/70 pt-5 text-caption leading-relaxed text-muted-foreground motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      >
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        No screen recording. {PRODUCT_NAME} learns only from what you type here or do in a chat with it, and keeps
        nothing from a draft you don’t save.
      </p>
    </div>
  );
}

function TeachSaved({
  saved,
  conversationId,
  reduce,
}: {
  saved: TaughtSkillSaved;
  conversationId: string | null;
  reduce: boolean;
}) {
  const on = saved.skill.enabled;
  return (
    <div className="rounded-card bg-muted/70 p-6 contrast-more:border contrast-more:border-border sm:p-8">
      <motion.span
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduce ? transition.base : spring.emphasized}
        className={cn(
          "flex size-11 items-center justify-center rounded-full",
          on ? "bg-foreground text-background" : "bg-background text-foreground"
        )}
      >
        <Check className="size-5" aria-hidden="true" />
      </motion.span>
      <h2 className="mt-4 flex flex-wrap items-center gap-2 text-title font-semibold text-foreground">
        {saved.outcome === "replayed" ? "Already saved" : saved.outcome === "versioned" ? `Saved version ${saved.version}` : "Saved"}
        <span className="font-mono text-body font-normal text-muted-foreground" translate="no">
          /{saved.skill.slug}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-caption font-medium",
            on ? "bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success-ink))]" : "bg-background text-muted-foreground"
          )}
        >
          {on ? "On" : "Off"}
        </span>
      </h2>
      <p className="mt-2 max-w-prose text-body leading-relaxed text-foreground" aria-live="polite">
        {on
          ? `Type /${saved.skill.slug} in any chat to use it. You can switch it off or change it from its page.`
          : (saved.message ?? "It’s saved switched off. Switch it on from its page when you’re ready.")}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={`/skills/${saved.skill.id}`}>Open skill</Link>
        </Button>
        {conversationId ? (
          <Button asChild variant="outline">
            <Link href={`/chat/${conversationId}`}>Back to the chat</Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost" className="font-normal text-muted-foreground hover:text-foreground">
          <Link href="/skills/teach">Teach another</Link>
        </Button>
      </div>
    </div>
  );
}
