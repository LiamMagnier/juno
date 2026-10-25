"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Check, GraduationCap } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { QuietButton, VerbButton } from "@/components/chat/decision";
import { useReducedMotion } from "@/lib/motion-preference";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { teachableTool, type ClientSkillDraft, type ClientTaughtSkill } from "@/lib/skills/teach";
import { listPhrase } from "@/components/skills/teach/teach-model";
import { fetchTaughtSkillByKey, stashSkillDraft } from "@/components/skills/teach/teach-transport";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * A skill the person taught in this chat, drafted for them to review.
 *
 *   [🎓] Skill draft
 *        File the monthly invoices
 *        /file-the-monthly-invoices · 4 steps · uses Gmail and Search the web
 *        1  Open the Invoices label in Gmail.
 *        2  Download each PDF attached to an unread email.
 *        3  Rename it to client-month.pdf.
 *           and 1 more
 *        It will ask you: Which folder do invoices go in?
 *   ─────────────────────────────────────────────────────────────────
 *        [Review]  Not now
 *
 * NOTHING EXISTS UNTIL A SAVE ON THE TEACH PAGE. Review hands the draft over
 * (session storage, never the URL) and opens /skills/teach, where every step,
 * every permission and the scope can be changed before anything is saved, and
 * the skill switches on only with the person's confirmation. The draft key
 * makes a second save land on the first skill, and is how the card knows, on a
 * later visit, that it was saved.
 */

type Phase = "checking" | "open" | "saved" | "dismissed";

const DISMISS_PREFIX = "alevr:skill-draft:not-now:";

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string, dismissed: boolean): void {
  try {
    if (dismissed) window.localStorage.setItem(DISMISS_PREFIX + key, "1");
    else window.localStorage.removeItem(DISMISS_PREFIX + key);
  } catch {
    // Not remembering is fine: the card comes back on the next visit.
  }
}

const PREVIEW_STEPS = 3;

export function SkillDraftCard({ draft, className }: { draft: ClientSkillDraft; className?: string }) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const titleId = React.useId();
  const [phase, setPhase] = React.useState<Phase>("checking");
  const [saved, setSaved] = React.useState<ClientTaughtSkill | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetchTaughtSkillByKey(draft.key).then((result) => {
      if (cancelled) return;
      if (result.kind === "ok" && result.value) {
        setSaved(result.value);
        setPhase("saved");
        return;
      }
      setPhase(readDismissed(draft.key) ? "dismissed" : "open");
    });
    return () => {
      cancelled = true;
    };
  }, [draft.key]);

  const review = () => {
    writeDismissed(draft.key, false);
    const id = stashSkillDraft(draft);
    router.push(id ? `/skills/teach?draft=${encodeURIComponent(id)}` : "/skills/teach?mode=walk");
  };

  const uses = [...draft.tools.map((id) => teachableTool(id)?.label ?? id), ...draft.apps.map((app) => app.label)];
  const meta = [
    draft.slug ? `/${draft.slug}` : null,
    `${draft.steps.length} step${draft.steps.length === 1 ? "" : "s"}`,
    uses.length > 0 ? `uses ${listPhrase(uses)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (phase === "checking") {
    return <div aria-hidden="true" className={cn("h-[3.25rem] rounded-field bg-muted/60", className)} />;
  }

  if (phase === "dismissed") {
    return (
      <p className={cn("flex items-center gap-2 text-ui text-muted-foreground", className)}>
        <GraduationCap className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Skill not saved: <span className="text-muted-on-fill">{draft.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            writeDismissed(draft.key, false);
            setPhase("open");
          }}
          className="shrink-0 rounded-control px-1 text-muted-on-fill underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none coarse:min-h-11"
        >
          Show
        </button>
      </p>
    );
  }

  const isSaved = phase === "saved" && saved !== null;

  return (
    <motion.section
      aria-labelledby={titleId}
      data-skill-draft={draft.key}
      data-phase={phase}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.base}
      className={cn("@container rounded-field bg-muted contrast-more:border contrast-more:border-border", className)}
    >
      <header className="flex items-start gap-3 py-3 pl-4 pr-3">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {isSaved ? <Check className="size-4 text-foreground" aria-hidden="true" /> : <GraduationCap className="size-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-micro text-muted-foreground">{isSaved ? "Skill saved" : "Skill draft"}</p>
          <h3 id={titleId} className="mt-0.5 line-clamp-2 text-body font-medium text-foreground">
            {isSaved ? saved.name : draft.name}
          </h3>
          <p className="mt-px text-ui text-muted-on-fill" aria-live="polite">
            {isSaved ? (
              <>
                <span className="font-mono" translate="no">
                  /{saved.slug}
                </span>
                {saved.enabled ? " · On" : " · Off until you switch it on"}
              </>
            ) : (
              meta
            )}
          </p>
        </div>
      </header>

      {!isSaved ? (
        <div className="px-4 pb-1 @[30rem]:pl-12">
          <ol className="space-y-1">
            {draft.steps.slice(0, PREVIEW_STEPS).map((step, index) => (
              <li key={index} className="flex gap-2.5 text-ui leading-relaxed text-foreground">
                <span aria-hidden="true" className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="line-clamp-2 min-w-0">{step}</span>
              </li>
            ))}
          </ol>
          {draft.steps.length > PREVIEW_STEPS ? (
            <p className="mt-1 pl-[1.625rem] text-caption text-muted-foreground">
              and {draft.steps.length - PREVIEW_STEPS} more
            </p>
          ) : null}
          {draft.questions.length > 0 ? (
            <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
              Open question{draft.questions.length === 1 ? "" : "s"}: {draft.questions[0]}
              {draft.questions.length > 1 ? ` (+${draft.questions.length - 1})` : ""}
            </p>
          ) : null}
          {draft.missingApps.length > 0 ? (
            <p className="mt-2 text-caption text-warning-foreground">
              Not connected: {listPhrase(draft.missingApps)}.{" "}
              <Link href="/connections" className="underline underline-offset-2">
                Connect
              </Link>
            </p>
          ) : null}
          {draft.fromOutsideContent ? (
            <p className="mt-2 text-caption leading-relaxed text-warning-foreground">
              Drafted while reading outside content. Read every step before you switch it on.
            </p>
          ) : null}
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3 @[30rem]:pl-12">
        <AnimatePresence mode="popLayout" initial={false}>
          {isSaved ? (
            <motion.div
              key="saved"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex flex-wrap items-center gap-2"
            >
              <QuietButton asChild>
                <Link href={`/skills/${saved.id}`}>Open skill</Link>
              </QuietButton>
              <span className="text-caption text-muted-foreground">
                {saved.enabled ? "You can switch it off or change it there." : "Review it there to switch it on."}
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="decide"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex flex-wrap items-center gap-2"
            >
              <VerbButton label="Review" accessibleLabel={`Review the ${draft.name} skill`} armed onClick={review} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  writeDismissed(draft.key, true);
                  setPhase("dismissed");
                }}
                className="font-normal text-muted-foreground hover:text-foreground"
              >
                Not now
              </Button>
              <span className="text-caption text-muted-foreground">Nothing is saved until you review it.</span>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </motion.section>
  );
}

/** Every skill one reply drafted, in the order it drafted them. */
export function SkillDraftList({ activity }: { activity: readonly ClientActivityEvent[] | undefined }) {
  const drafts = (activity ?? []).flatMap((evt) => (evt.skillDraft ? [evt.skillDraft] : []));
  if (drafts.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {drafts.map((draft) => (
        <SkillDraftCard key={draft.key} draft={draft} />
      ))}
    </div>
  );
}
