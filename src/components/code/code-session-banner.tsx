"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Loader2 } from "lucide-react";

import { AgentStatusBadge, type AgentRunStatus } from "@/components/ui/agent-status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { AppIcons, CodeIcons } from "@/lib/app-icons";
import { checksLabel, type ChecksReport } from "@/lib/code-checks";
import { transition, variants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { CodeSessionStatus } from "@/hooks/use-code-session";
import { PRESENCE_META, type Presence } from "@/components/code/code-session-meta";
import type { AutoFixHandle } from "@/components/code/use-code-auto-fix";

/*
 * THE SESSION HEADER — the one place that answers "what is this, and what is it
 * doing right now" without scrolling.
 *
 * The old header was a single wrapping flex row: identity, then a spacer, then
 * up to four chips of equal weight. Two problems it could not solve in that
 * shape. On a phone the chips wrapped under the name and the header grew to
 * three lines before a word of transcript was visible. And the run's actual
 * state — the only thing on the row that CHANGES — was a static pill saying
 * "Running", with the thing it was running on hidden inside a trace panel the
 * reader has to open.
 *
 * So the header is two tiers now, on the same argument ComposerShell makes:
 *
 *   identity row   what this session is (workspace or repo), where it runs, and
 *                  whether that place is reachable. All of it survives the run.
 *   activity row   what Juno Code is doing THIS SECOND. Present only while a run
 *                  is live, and it collapses to nothing the moment it settles,
 *                  so a resting session is a single quiet line.
 *
 * The chips shed their labels on a narrow row rather than wrapping: a coloured
 * dot with an accessible name is the same fact in a tenth of the width, and it
 * is the fact — not the sentence — that a reader is scanning for.
 *
 * Every width here is measured against `@container/split`, the mount the
 * session view declares and sizes its docked columns from. `sm:` and `md:`
 * measured the WINDOW, and this header never has the window: the shell's
 * sidebar takes a slice of it and the thought dock, the canvas and the review
 * dock each take another, so a 1000px browser can leave this row 420px wide
 * with its labels still at full length. Same numbers, right question.
 */

/*
 * The header's status chips, one recipe. Four of them can sit on that row at
 * once — the task chip, the resolving chip, the cloud/PR chip and the presence
 * chip — and they had drifted into two families and two sizes (a mono 10px task
 * chip beside three sans 12px siblings with the same pill, border and fill).
 *
 * `bg-card` at full alpha, not `bg-card/70`: 6.5% × 0.7 is ~4.5% lightness on
 * the black ground, which is below the hairline that rings it.
 */
const BANNER_CHIP =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2 py-1 text-caption text-muted-foreground @[40rem]/split:px-2.5";
/** The chip's leading dot, at the one size all four use. */
const BANNER_DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

const TASK_CHIP: Partial<Record<CodeSessionStatus, { label: string; dot: string }>> = {
  queued: { label: "Queued", dot: "bg-muted-foreground motion-safe:animate-pulse" },
  running: { label: "Running", dot: "bg-success motion-safe:animate-pulse" },
  awaiting_approval: { label: "Needs approval", dot: "bg-warning" },
  stopping: { label: "Stopping…", dot: "bg-muted-foreground" },
};

/**
 * A chip label that survives a phone by becoming its own accessible name.
 *
 * Measured against the SPLIT CONTAINER, not the window. `sm:` asked how wide
 * the browser was, and this header sits inside a shell whose sidebar, thought
 * dock and canvas each take a third of it — so on a 900px window with the
 * review dock open the labels stayed at full length in a row half that wide and
 * the chips wrapped. `@[40rem]/split:` is the same 640px asking the right
 * question, and it is the mount every other docked column on this surface is
 * sized from.
 */
function ChipLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="hidden min-w-0 truncate @[40rem]/split:inline">{children}</span>
      <span className="sr-only @[40rem]/split:hidden">{children}</span>
    </>
  );
}

/** The dot colour for a CI rollup, in the same three inks the rest of the product uses. */
const CHECKS_DOT: Record<ChecksReport["state"], string> = {
  failing: "bg-destructive",
  running: "bg-muted-foreground motion-safe:animate-pulse",
  passing: "bg-success",
  neutral: "bg-muted-foreground",
  none: "bg-muted-foreground",
};

/*
 * WHAT GITHUB SAYS ABOUT THE BRANCH, AND WHETHER JUNO ANSWERS IT.
 *
 * These two facts were one chip and half a control. The rollup was a `<span>`
 * whose only detail lived in a `title` attribute — invisible on a phone, which
 * is where a reader is most likely to be when CI mails them — and the product
 * had nothing at all to say about acting on a failure. Both belong to the same
 * question, "is this branch mergeable and who is working on that", so they get
 * one object: a chip that opens a panel with the checks by name and the per-pull-
 * request auto-fix switch under them.
 *
 * ONE OBJECT, NOT TWO. Five things already sit on the right of this row. The
 * auto-fix switch is the kind of control that would have been a sixth chip and
 * then a badge on it; putting it inside the panel the failure already opens
 * keeps the resting row exactly as long as it was.
 */
const PANEL_ROW = "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left";

/** The outcome ink for one check, matching the rollup's own vocabulary. */
const CHECK_INK: Record<string, string> = {
  failing: "bg-destructive",
  running: "bg-muted-foreground motion-safe:animate-pulse",
  passing: "bg-success",
  neutral: "bg-muted-foreground",
};

export interface CodeSessionBannerProps {
  /** True until the session's own kind (device or cloud) is known. */
  resolving: boolean;
  isCloud: boolean;
  /** The workspace name, or `owner/name` for a cloud session. */
  title: string;
  /** The local path, or `on <baseRef>`. Secondary; hidden on a narrow row. */
  subtitle: string | null;
  status: CodeSessionStatus;
  presence: Presence;
  prUrl: string | null;
  /**
   * The last thing the runner reported doing — a tool summary or a file write.
   * Null whenever nothing is live, which is what collapses the second tier.
   */
  activity: string | null;
  /**
   * How much this session has changed, summed over every file it has touched.
   * Null until something has been reported, which is what keeps a session that
   * has only talked from wearing "+0 −0".
   */
  churn: { added: number; removed: number } | null;
  /** Whether the review dock is the open column right now. */
  reviewOpen: boolean;
  /** Opens or closes the review dock. Null where there is no diff to open. */
  onToggleReview: (() => void) | null;
  /** What CI says about the branch, or null when we have not been told. */
  checks: ChecksReport | null;
  /**
   * The per-pull-request auto-fix switch, or null where the session has none.
   *
   * The handle's `state.available` is the server's answer to "can this
   * deployment actually do this for this session" — no webhook secret, a device
   * run, or no pull request each make it false, and the switch is not drawn for
   * any of them. A control that implied a behaviour the runtime does not have
   * would be the defect this row was built to remove.
   */
  autoFix: AutoFixHandle | null;
  /** Rename / Share / Archive / Delete, rendered by the view that owns the row. */
  menu?: React.ReactNode;
}

export function CodeSessionBanner({
  resolving,
  isCloud,
  title,
  subtitle,
  status,
  presence,
  prUrl,
  activity,
  churn,
  reviewOpen,
  onToggleReview,
  checks,
  autoFix,
  menu,
}: CodeSessionBannerProps) {
  const presenceMeta = PRESENCE_META[presence.state];
  const taskChip = TASK_CHIP[status];

  /*
   * `state: "none"` covers both "this repository has no checks" and "the checks
   * have not been created yet", and the two are indistinguishable over the API
   * — so neither is reported. A green tick for a branch nobody tested is the
   * one thing a CI indicator must never do, and that rule survives the chip
   * becoming a control.
   */
  const report = checks && checks.state !== "none" ? checks : null;
  const autoFixState = autoFix?.state?.available ? autoFix.state : null;

  /*
   * Hold the last activity line through the collapse.
   *
   * Rendering `{activity}` directly emptied the row on the same frame the
   * height started animating, so the sentence blinked out and then an empty
   * strip closed underneath it — the one transition on this surface that
   * animated nothing the eye was following.
   */
  const lastActivity = React.useRef<string | null>(null);
  if (activity) lastActivity.current = activity;
  const shownActivity = activity ?? lastActivity.current;

  return (
    // `reducedMotion="user"` rather than a `useReducedMotion()` at each site:
    // the framer motion in this header is a chip swap and a row entrance, and
    // both should degrade to the opacity-only Tier B that globals.css applies
    // to the CSS keyframes beside them.
    <MotionConfig reducedMotion="user">
      <header
        // `bg-background` flat: the translucency bought nothing — this row is
        // `shrink-0` in a flex column, so nothing scrolls beneath it, and on a
        // 0%-lightness ground a 5% bleed is unobservable. The bottom hairline is
        // `border-border` at full strength for the same reason; at /60 it was
        // 9.6% lightness, the faintest edge on the surface doing the most work.
        className="shrink-0 border-b border-border bg-background"
        aria-label={`Session: ${title}`}
      >
        <div className="flex items-center gap-2 px-3 py-2 @[48rem]/split:px-4">
          {/* `bg-primary/20 border-primary/45` — at /10 and /25 the fill was ~2%
              lightness and the border ~4%, so the badge vanished and only the
              12px glyph inside it survived. Same recipe as the PR chip below, so
              the banner's two coral elements are one object. */}
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/45 bg-primary/20">
            {resolving ? (
              <Loader2 className="size-3 animate-spin text-primary" aria-hidden="true" />
            ) : isCloud ? (
              <CodeIcons.cloud className="size-3 text-primary" aria-hidden="true" />
            ) : (
              <AppIcons.projects className="size-3 text-primary" aria-hidden="true" />
            )}
          </span>

          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            {/* NOT a heading element, deliberately. The transcript below owns
                the surface's only <h1> (MessageList's `conversationTitle`, this
                same string), and the empty state owns it when there is no
                transcript — so an <h2> here would put a level-2 heading ahead
                of the level-1 it duplicates, in a document where a
                heading-navigating reader would then hit the same name twice.
                The <header>'s own label is what names this region. */}
            <p className="min-w-0 truncate text-ui font-medium text-foreground">{title}</p>
            {/* The mono slot is a LOCAL PATH on the device side. A cloud
                session's codeWorkspacePath is "owner/name", so printing it
                before the kind is known dressed a repo up as a folder on your
                disk — which is why the caller passes null while resolving. */}
            {subtitle && (
              <span className="hidden min-w-0 truncate font-mono text-caption text-muted-foreground @[40rem]/split:inline">
                {subtitle}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/*
              +N −M, AND IT IS THE DOOR TO THE DIFF.
              This is the single most useful fact about a finished coding run
              and the banner carried none of it: the figures lived in a
              collapsed card above the composer and in a review pane that only
              the run list could open. As a control it answers "what did it do"
              and opens the thing that answers "and is it right" in one press —
              which is the whole arrangement this session view was missing.

              The numbers never shed their labels the way the chips beside them
              do: they ARE the label, they are four characters wide, and a
              phone that hid them would be hiding the row's only content.
            */}
            {churn && onToggleReview && (
              <button
                type="button"
                onClick={onToggleReview}
                aria-expanded={reviewOpen}
                aria-label={`${reviewOpen ? "Close" : "Open"} the changes: ${churn.added} added, ${churn.removed} removed`}
                className={cn(
                  "pressable inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2 py-1 font-mono text-caption tabular-nums hover:bg-accent @[40rem]/split:px-2.5",
                  reviewOpen && "border-border bg-secondary",
                )}
              >
                <span className="text-success">+{churn.added}</span>
                <span className="text-destructive">−{churn.removed}</span>
              </button>
            )}

            {/*
              CI AND AUTO-FIX, AND ONLY WHEN THERE IS SOMETHING TO SAY.
              Nothing is drawn when GitHub has reported no checks AND auto-fix
              is impossible here — a chip whose panel would be empty is chrome
              about an absence. What the chip SAYS is the CI rollup whenever
              there is one, because a failing check is the louder fact; the
              switch's own state is only the label when CI has said nothing.
            */}
            {(report || autoFixState) && (
              <Popover onOpenChange={(open) => open && autoFix?.refresh()}>
                {/*
                  The chip became a button when it became a door, and a button
                  is not a live region: a screen-reader user who was told "2
                  checks failing" the moment the branch went red would now only
                  find out by opening the panel. The sentence is announced from
                  a visually-hidden status beside the trigger, which is the one
                  arrangement that keeps both — the control is a control, and
                  the fact still arrives unprompted.
                */}
                <span role="status" className="sr-only">
                  {report ? checksLabel(report) : ""}
                </span>
                <PopoverTrigger
                  className={cn(BANNER_CHIP, "pressable hover:bg-accent data-[state=open]:bg-secondary")}
                  aria-label={
                    report
                      ? `${checksLabel(report)}. Open checks and auto-fix.`
                      : "Open checks and auto-fix."
                  }
                >
                  <span
                    className={cn(
                      BANNER_DOT,
                      report
                        ? CHECKS_DOT[report.state]
                        : autoFixState?.enabled
                          ? "bg-primary"
                          : "bg-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <ChipLabel>
                    {report ? checksLabel(report) : autoFixState?.enabled ? "Auto-fix on" : "Auto-fix off"}
                  </ChipLabel>
                </PopoverTrigger>
                {/* 16px shell − p-1.5 (6) = the 10px rung every row inside uses. */}
                <PopoverContent align="end" className="w-80 p-1.5">
                  <ChecksAndAutoFix report={report} autoFix={autoFix} />
                </PopoverContent>
              </Popover>
            )}

            {/*
              THE ONE THING ON THIS ROW THAT CHANGES, so it is the one thing
              given real motion. It is framer rather than a CSS keyframe
              because a run goes queued → running → awaiting_approval faster
              than one entrance finishes, and a keyframe restarted mid-flight
              re-derives its path from wherever it happens to be — the spring
              in `variants.pop` carries its velocity through instead.

              `mode="wait"` so the outgoing chip is gone before the next one
              lands: `sync` leaves two pills in the row for the length of an
              exit and the whole right cluster jumps sideways, and `popLayout`
              buys that overlap back only by absolutely positioning a chip
              whose width is its own label.
            */}
            <AnimatePresence initial={false} mode="wait">
              {(() => {
                let agentStatus: AgentRunStatus | null = null;
                if (status === "running") agentStatus = "running";
                else if (status === "awaiting_approval") agentStatus = "waiting_approval";
                else if (status === "queued") agentStatus = "running";
                else if (status === "stopping") agentStatus = "cancelled";

                if (!agentStatus) return null;

                return (
                  <motion.div
                    key={status}
                    variants={variants.pop}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <AgentStatusBadge
                      status={agentStatus}
                      label={taskChip?.label}
                      pulsing={status === "running" || status === "queued"}
                      size="sm"
                    />
                  </motion.div>
                );
              })()}
            </AnimatePresence>

            {resolving ? (
              <span role="status" className={BANNER_CHIP}>
                <span className={cn(BANNER_DOT, "bg-muted-foreground motion-safe:animate-pulse")} aria-hidden="true" />
                <ChipLabel>Getting this session ready…</ChipLabel>
              </span>
            ) : isCloud ? (
              prUrl ? (
                // The banner's only call to action, and at `bg-primary/10` its
                // fill composited to roughly 2% lightness on black — the chip
                // collapsed into bare coral text inside a faint outline. /20
                // makes it a chip again, and hover has to step UP from there.
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/45 bg-primary/20 px-2 py-1 text-caption font-medium text-primary hover:border-primary/60 hover:bg-primary/30 motion-safe:animate-fade-in @[40rem]/split:px-2.5"
                >
                  <AppIcons.pulls className="size-3.5" aria-hidden="true" />
                  <ChipLabel>View pull request</ChipLabel>
                  <CodeIcons.external className="hidden size-3 @[40rem]/split:block" aria-hidden="true" />
                </a>
              ) : (
                <span role="status" className={BANNER_CHIP}>
                  <CodeIcons.cloud className="size-3.5 shrink-0" aria-hidden="true" />
                  <ChipLabel>Runs in the cloud · pushes a branch</ChipLabel>
                </span>
              )
            ) : (
              <span role="status" title={presence.device?.name} className={BANNER_CHIP}>
                <span className={cn(BANNER_DOT, presenceMeta.dot)} aria-hidden="true" />
                <ChipLabel>{presenceMeta.label}</ChipLabel>
              </span>
            )}

            {menu}
          </div>
        </div>

        {/*
          WHAT IT IS DOING RIGHT NOW.

          The transcript's own thinking indicator says "Thinking" or "Writing";
          it does not say which file, and it scrolls away. This line is the
          runner's last reported step, pinned under the identity row for as long
          as something is live. Deliberately NOT a live region: a tool-heavy run
          emits several of these a second, and a screen reader reading each one
          out would make the surface unusable — the permanently-mounted status
          region above the composer carries the announcements that matter
          (queued, approval needed).
        */}
        <div
          className={cn(
            "grid px-3 transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none @[48rem]/split:px-4",
            activity ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <motion.p
              className="flex items-center gap-2 pb-2 text-caption text-muted-foreground"
              initial={false}
              animate={{ opacity: activity ? 1 : 0 }}
              transition={transition.fast}
            >
              <span
                className={cn(BANNER_DOT, "bg-primary motion-safe:animate-pulse")}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate font-mono">{shownActivity}</span>
            </motion.p>
          </div>
        </div>
      </header>
    </MotionConfig>
  );
}

/**
 * The panel behind the chip: what CI said, and whether Juno answers it.
 *
 * TWO SECTIONS, AND EITHER MAY BE ABSENT. The checks are listed by name with a
 * link each — the rollup sentence says how many failed, and this says which,
 * which is the question a reader actually has and the one the old `title`
 * tooltip could only answer with a mouse. The switch appears only when the
 * server has said auto-fix is possible for this session, so it is never a
 * control over a behaviour that is not there.
 *
 * The delivery notes under the switch are the reference's third outcome made
 * visible: a no-op is noted and skipped, and a note nobody can read is not a
 * note. They are Juno's own sentences about what it did — never
 * the comment's or the check's own words, which belong only inside the fenced
 * prompt the run is given (src/lib/code-autofix.ts).
 */
function ChecksAndAutoFix({
  report,
  autoFix,
}: {
  report: ChecksReport | null;
  autoFix: AutoFixHandle | null;
}) {
  const switchId = React.useId();
  const state = autoFix?.state?.available ? autoFix.state : null;
  /*
   * THE ONE REFUSAL WORTH A SENTENCE. Three of the four reasons the server can
   * give are facts the reader cannot act on from here — this run is on a Mac,
   * this deployment has no webhook secret, no pull request exists yet — and a
   * panel that explained them would be chrome about an absence. `app_not_
   * installed` is different: it is about THIS repository, the remedy is one
   * action, and without it the most likely reading of a missing switch is that
   * the feature is broken.
   */
  const notInstalled = autoFix?.state && !autoFix.state.available && autoFix.state.reason === "app_not_installed";
  /*
   * PLAN MODE MEANS ONE OF THE THREE PROMISED OUTCOMES CANNOT HAPPEN. The
   * answering run inherits its mode from the anchor task — correctly, a webhook
   * decides no permissions — and in Plan the runner denies every edit. So the
   * copy says what the run will do instead of promising a push it cannot make.
   */
  const planMode = state?.permissionMode === "plan";

  return (
    <div className="flex flex-col">
      {report && (
        <>
          <p className="px-2 py-1.5 text-caption text-muted-foreground">{checksLabel(report)}</p>
          {/* Capped and scrollable rather than truncated: a repository with
              thirty checks has thirty facts, and the triage order in
              `summariseChecks` already puts the failures at the top, so the
              first screenful is always the part that matters. */}
          <ul className="max-h-48 overflow-y-auto overscroll-contain">
            {report.checks.map((check) => {
              const body = (
                <>
                  <span
                    className={cn(BANNER_DOT, CHECK_INK[check.outcome] ?? "bg-muted-foreground")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui text-foreground">{check.name}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">{check.outcome}</span>
                </>
              );
              return (
                <li key={check.name}>
                  {check.url ? (
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        PANEL_ROW,
                        "pressable transition-colors duration-fast ease-out-soft hover:bg-accent",
                      )}
                    >
                      {body}
                    </a>
                  ) : (
                    <span className={PANEL_ROW}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {report && (state || notInstalled) && (
        <div role="separator" aria-hidden="true" className="my-1 h-px bg-border/70" />
      )}

      {/* Only ever seen beside a CI report, because that is the only time this
          panel opens without a switch in it — and a reader looking at a failing
          check is exactly the reader whose next question is why Juno is not
          offering to answer it. The remedy is named, because "unavailable" with
          no next step reads as broken. */}
      {notInstalled && (
        <p className="px-2 py-1.5 text-caption text-muted-foreground">
          Auto-fix needs the Juno GitHub App installed on this repository — GitHub sends a check
          result or a review only to the repositories the app is installed on. Install it there and
          the switch appears here.
        </p>
      )}

      {state && autoFix && (
        <div className="px-2 py-1.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={switchId} className="block text-ui font-medium text-foreground">
                Auto-fix
              </label>
              {/* What it will and will not do, in the order a reader worries
                  about them. The second sentence is the one that makes the
                  switch safe to press: the run stops and asks rather than
                  guessing, and it never leaves this branch. In Plan mode the
                  first sentence would be a promise the permission forbids, so
                  it is the sentence that changes — never the permission. */}
              <p className="mt-0.5 text-caption text-muted-foreground">
                {planMode
                  ? "Juno answers a failing check or a review comment here by investigating it and replying in this session. While this session is set to Plan, it will not push a fix to the branch."
                  : "Juno answers a failing check or a review comment here by pushing a fix to this branch. When the ask is unclear or would change the design, it stops and asks you instead."}
              </p>
            </div>
            <Switch
              id={switchId}
              checked={state.enabled}
              disabled={autoFix.pending}
              onCheckedChange={(next) => autoFix.setEnabled(next)}
            />
          </div>

          {state.recent.length > 0 && (
            <ul className="mt-2 space-y-1">
              {state.recent.map((entry) => (
                <li key={`${entry.at}-${entry.note}`} className="flex items-start gap-2">
                  <span
                    className={cn(
                      BANNER_DOT,
                      "mt-1.5",
                      // Coral for the two outcomes that put the event in front
                      // of a run — started one, or handed it to the one going.
                      entry.outcome === "skipped" ? "bg-muted-foreground" : "bg-primary",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 text-caption text-muted-foreground">{entry.note}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
