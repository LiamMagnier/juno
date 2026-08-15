"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Loader2 } from "lucide-react";

import { AppIcons, CodeIcons } from "@/lib/app-icons";
import { transition, variants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { CodeSessionStatus } from "@/hooks/use-code-session";
import { PRESENCE_META, type Presence } from "@/components/code/code-session-meta";

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
 * The chips shed their labels below `sm` rather than wrapping: a coloured dot
 * with an accessible name is the same fact in a tenth of the width, and it is
 * the fact — not the sentence — that a reader is scanning for.
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
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2 py-1 text-xs text-muted-foreground sm:px-2.5";
/** The chip's leading dot, at the one size all four use. */
const BANNER_DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

const TASK_CHIP: Partial<Record<CodeSessionStatus, { label: string; dot: string }>> = {
  queued: { label: "Queued", dot: "bg-muted-foreground motion-safe:animate-pulse" },
  running: { label: "Running", dot: "bg-success motion-safe:animate-pulse" },
  awaiting_approval: { label: "Needs approval", dot: "bg-warning" },
  stopping: { label: "Stopping…", dot: "bg-muted-foreground" },
};

/** A chip label that survives a phone by becoming its own accessible name. */
function ChipLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="hidden min-w-0 truncate sm:inline">{children}</span>
      <span className="sr-only sm:hidden">{children}</span>
    </>
  );
}

export interface CodeSessionBannerProps {
  /** True until the session's own kind (device or cloud) is known. */
  resolving: boolean;
  isCloud: boolean;
  /** The workspace name, or `owner/name` for a cloud session. */
  title: string;
  /** The local path, or `on <baseRef>`. Secondary; hidden below `sm`. */
  subtitle: string | null;
  status: CodeSessionStatus;
  presence: Presence;
  prUrl: string | null;
  /**
   * The last thing the runner reported doing — a tool summary or a file write.
   * Null whenever nothing is live, which is what collapses the second tier.
   */
  activity: string | null;
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
}: CodeSessionBannerProps) {
  const presenceMeta = PRESENCE_META[presence.state];
  const taskChip = TASK_CHIP[status];

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
        <div className="flex items-center gap-2 px-3 py-2 md:px-4">
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
            <p className="min-w-0 truncate text-sm font-medium text-foreground">{title}</p>
            {/* The mono slot is a LOCAL PATH on the device side. A cloud
                session's codeWorkspacePath is "owner/name", so printing it
                before the kind is known dressed a repo up as a folder on your
                disk — which is why the caller passes null while resolving. */}
            {subtitle && (
              <span className="hidden min-w-0 truncate font-mono text-caption text-muted-foreground sm:inline">
                {subtitle}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
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
              {taskChip && (
                <motion.span
                  key={status}
                  // `variants.pop` carries its own transitions — a spring in,
                  // the accelerate curve out — so no `transition` prop here: a
                  // component-level one would be shadowed by the variants and
                  // read as the source of a timing it does not set.
                  variants={variants.pop}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className={BANNER_CHIP}
                >
                  <span className={cn(BANNER_DOT, taskChip.dot)} aria-hidden="true" />
                  <ChipLabel>{taskChip.label}</ChipLabel>
                </motion.span>
              )}
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
                  className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/45 bg-primary/20 px-2 py-1 text-xs font-medium text-primary hover:border-primary/60 hover:bg-primary/30 motion-safe:animate-fade-in sm:px-2.5"
                >
                  <AppIcons.pulls className="size-3.5" aria-hidden="true" />
                  <ChipLabel>View pull request</ChipLabel>
                  <CodeIcons.external className="hidden size-3 sm:block" aria-hidden="true" />
                </a>
              ) : (
                <span role="status" className={BANNER_CHIP}>
                  <CodeIcons.cloud className="size-3.5 shrink-0" aria-hidden="true" />
                  <ChipLabel>Runs in the cloud · opens a pull request</ChipLabel>
                </span>
              )
            ) : (
              <span role="status" title={presence.device?.name} className={BANNER_CHIP}>
                <span className={cn(BANNER_DOT, presenceMeta.dot)} aria-hidden="true" />
                <ChipLabel>{presenceMeta.label}</ChipLabel>
              </span>
            )}
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
            "grid px-3 transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none md:px-4",
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
