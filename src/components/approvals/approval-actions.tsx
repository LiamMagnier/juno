"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "@/components/ui/icons";
import { Kbd } from "@/components/ui/kbd";
import { isApplePlatform } from "@/components/ui/platform";
import { useShellString } from "@/components/ui/use-shell-string";
import { isModEnter } from "@/lib/composer-keys";
import { useUiLocale } from "@/lib/i18n-format";
import { cn } from "@/lib/utils";
import { useApprovalAnnouncer } from "./announcer";
import { createApprovalArm, type ArmClock } from "./arm";
import { resolveFocusPolicy, type ComposerState, type FocusPolicy } from "./focus-policy";
import { approvalVerbLabel, isIrreversibleVerb, type ApprovalVerb } from "./verbs";

/*
 * ONE APPROVAL, ONE LAYOUT (spec P2 (17), C16, D20, §10).
 *
 *   [Not now]  [Verb ▾]  ⌘↩  ……………………  [Amend]  [Tell Alevr instead]
 *
 * The verb is the filled ink button and says what will happen (verbs.ts); its
 * caret holds "Allow for this session" (not offered for irreversible verbs).
 * The heading is in the signal ink on an opaque card with a 2px signal
 * leading edge; a command shows in mono up to 8 lines, then "Show all". A
 * busy spinner appears only in the button that was pressed.
 *
 * KEYBOARD AND FOCUS.
 *   - The container is role=group, labelled by the heading and described by
 *     the summary — never alertdialog.
 *   - The arm: the verb is disarmed for 500ms after each request and every
 *     focus entry (arm.ts); Enter on it and ⌘↩ do nothing until it arms.
 *   - ⌘↩ (Ctrl+Enter on Windows and Linux) approves only while focus is
 *     inside the container and the arm has finished. Return on the container
 *     itself does nothing. Esc never denies.
 *   - focusPolicy take moves focus to the container; announce leaves focus
 *     where it is, asks the window's announcer to speak, and inserts a
 *     "Review approval" button right after the active input in tab order.
 *     `auto` (the default) decides with resolveFocusPolicy (D20).
 */

export interface ApprovalActionsProps {
  /** A stable id per request: a new id is a new request, which re-arms and re-applies the focus policy. */
  requestId: string;
  title: string;
  summary?: React.ReactNode;
  /** The exact command or arguments, shown in mono. */
  command?: string;
  verb: ApprovalVerb;
  onApprove: () => void;
  onAllowSession?: () => void;
  onNotNow: () => void;
  onTellInstead?: () => void;
  onAmend?: () => void;
  /** Which button is waiting on the server; its spinner shows and every button holds. */
  busy?: "approve" | "allowSession" | "notNow" | null;
  focusPolicy?: FocusPolicy | "auto";
  /** The composer's state when focus is inside it (for `auto`). */
  composerState?: () => ComposerState | null;
  className?: string;
  /** Tests: an injected clock for the arm. */
  armClock?: ArmClock;
}

/** Commands longer than this many lines fold behind "Show all". */
export const COMMAND_MAX_LINES = 8;

export interface ApprovalKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  /** The key went to something inside the approval container. */
  insideContainer: boolean;
  /** …to the container itself (it holds focus after `take`). */
  onContainer: boolean;
  /** …to the primary verb button. */
  onVerb: boolean;
  armed: boolean;
  busy: boolean;
}

/**
 * What a keydown does to an approval (spec §10), pure:
 *
 *   approve  ⌘↩ / Ctrl+Enter inside the container, after the arm, not busy
 *   block    swallow it: ⌘↩ or Enter/Space on the verb before the arm, or
 *            Return on the container itself
 *   ignore   everything else, Escape included (Esc never denies)
 */
export function approvalKeyAction(e: ApprovalKey, apple: boolean): "approve" | "block" | "ignore" {
  if (!e.insideContainer) return "ignore";
  if (isModEnter(e, apple)) return e.armed && !e.busy ? "approve" : "block";
  if (e.onVerb && !e.armed && (e.key === "Enter" || e.key === " ")) return "block";
  if (e.onContainer && e.key === "Enter") return "block";
  return "ignore";
}

export function ApprovalActions({
  requestId,
  title,
  summary,
  command,
  verb,
  onApprove,
  onAllowSession,
  onNotNow,
  onTellInstead,
  onAmend,
  busy = null,
  focusPolicy = "auto",
  composerState,
  className,
  armClock,
}: ApprovalActionsProps) {
  const t = useShellString();
  const locale = useUiLocale();
  const announcer = useApprovalAnnouncer();
  const container = React.useRef<HTMLDivElement>(null);
  const headingId = React.useId();
  const summaryId = React.useId();
  const [armed, setArmed] = React.useState(false);
  const [caretOpen, setCaretOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const arm = React.useMemo(() => createApprovalArm(setArmed, armClock), [armClock]);
  React.useEffect(() => () => arm.dispose(), [arm]);
  const armedRef = React.useRef(armed);
  armedRef.current = armed;

  const apple = React.useMemo(() => isApplePlatform(), []);
  const holding = busy !== null;
  const verbLabel = approvalVerbLabel(verb, locale);
  const canAllowSession = Boolean(onAllowSession) && !isIrreversibleVerb(verb);

  // Each new request: re-arm, then take focus or announce.
  React.useEffect(() => {
    arm.restart();
    const el = container.current;
    if (!el || typeof document === "undefined") return;
    const active = document.activeElement;
    const policy = focusPolicy === "auto" ? resolveFocusPolicy(active, composerState?.() ?? null) : focusPolicy;
    if (policy === "take") {
      el.focus({ preventScroll: true });
      return;
    }
    announcer.request(title);
    return insertReviewButton(active, t("approval.review"), () => el.focus());
    // Only a new request re-applies the policy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const approve = React.useCallback(() => {
    if (!armedRef.current || holding) return;
    onApprove();
  }, [holding, onApprove]);

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    // Focus ENTERING the container (not moving within it) re-arms.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    arm.restart();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const action = approvalKeyAction(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        insideContainer: event.currentTarget.contains(event.target as Node),
        onContainer: event.target === event.currentTarget,
        onVerb: event.target instanceof Element && event.target.closest(".ui-approval-verb") !== null,
        armed: armedRef.current,
        busy: holding,
      },
      apple,
    );
    if (action === "ignore") return;
    event.preventDefault();
    if (action === "approve") onApprove();
  };

  const lines = command ? command.split("\n") : [];
  const folded = lines.length > COMMAND_MAX_LINES && !showAll;

  return (
    <div
      ref={container}
      role="group"
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-describedby={summary ? summaryId : undefined}
      data-approval-container=""
      data-request-id={requestId}
      data-armed={armed ? "" : undefined}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className={cn("ui-approval relative rounded-card bg-card px-4 py-3 outline-none", className)}
      data-tone-step=""
    >
      <p id={headingId} className="text-ui font-medium text-[hsl(var(--status-needs-you-ink))]">
        {title}
      </p>
      {summary ? (
        <div id={summaryId} className="mt-1 text-body text-muted-foreground">
          {summary}
        </div>
      ) : null}
      {command ? (
        <div className="mt-2">
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-muted px-2.5 py-2 font-mono text-label text-foreground">
            {folded ? lines.slice(0, COMMAND_MAX_LINES).join("\n") : command}
          </pre>
          {lines.length > COMMAND_MAX_LINES ? (
            <button type="button" className="mt-1 text-ui text-muted-foreground underline-offset-2 hover:underline" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {t("approval.showAll")}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border px-3 text-ui text-foreground hover:bg-accent disabled:opacity-50"
          disabled={holding}
          onClick={onNotNow}
        >
          {busy === "notNow" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {t("approval.notNow")}
        </button>
        <span className="inline-flex items-stretch">
          <button
            type="button"
            className={cn(
              "ui-approval-verb inline-flex h-8 items-center gap-1.5 bg-foreground px-3 text-ui font-medium text-background transition-opacity duration-fast ease-out-soft",
              canAllowSession ? "rounded-s-control" : "rounded-control",
              !armed && "opacity-60"
            )}
            aria-disabled={!armed || holding || undefined}
            data-verb={verb.kind}
            onClick={approve}
          >
            {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {verbLabel}
            {!armed ? <span className="sr-only"> {t("approval.armed")}</span> : null}
          </button>
          {canAllowSession ? (
            <span className="relative">
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 items-center rounded-e-control border-s border-background/20 bg-foreground px-1.5 text-background transition-opacity duration-fast ease-out-soft",
                  !armed && "opacity-60"
                )}
                aria-label={t("approval.allowSession")}
                aria-haspopup="menu"
                aria-expanded={caretOpen}
                aria-disabled={!armed || holding || undefined}
                onClick={() => armedRef.current && !holding && setCaretOpen((v) => !v)}
              >
                {busy === "allowSession" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
              </button>
              {caretOpen ? (
                <span role="menu" className="ui-overlay-frequent surface-float absolute start-0 top-full z-popper mt-1 min-w-max rounded-menu p-1" data-state="open">
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full rounded-field px-2.5 py-1.5 text-start text-ui text-foreground hover:bg-accent"
                    onClick={() => {
                      setCaretOpen(false);
                      if (armedRef.current && !holding) onAllowSession?.();
                    }}
                  >
                    {t("approval.allowSession")}
                  </button>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <Kbd chord="⌘↩" aria-hidden="true" className="ui-approval-hint" />
        <span className="flex-1" />
        {onAmend ? (
          <button type="button" className="inline-flex h-8 items-center rounded-control px-3 text-ui text-foreground hover:bg-accent disabled:opacity-50" disabled={holding} onClick={onAmend}>
            Amend
          </button>
        ) : null}
        {onTellInstead ? (
          <button type="button" className="inline-flex h-8 items-center rounded-control px-3 text-ui text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" disabled={holding} onClick={onTellInstead}>
            {t("approval.tellInstead")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Inserts "Review approval" right after `active` in tab order (the announce
 * policy), as a skip link that shows when focused. Returns its removal. The
 * anchor is the focus host, not an internal node: after an xterm's container,
 * a contenteditable's root, or the field itself.
 */
export function insertReviewButton(active: Element | null, label: string, onActivate: () => void): (() => void) | undefined {
  if (!active || typeof document === "undefined" || active === document.body) return undefined;
  const anchor =
    active.closest(".xterm, [data-xterm]") ??
    (active instanceof HTMLElement && active.isContentEditable ? active.closest("[contenteditable='true'], [contenteditable='']") : null) ??
    active;
  if (!anchor.parentElement) return undefined;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("data-approval-review", "");
  button.className = "ui-approval-review";
  const activate = () => {
    onActivate();
    button.remove();
  };
  button.addEventListener("click", activate);
  anchor.insertAdjacentElement("afterend", button);
  return () => {
    button.removeEventListener("click", activate);
    button.remove();
  };
}
