"use client";

import * as React from "react";
import { ChevronDown } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { CHAT_COMPOSER_FIELD_ID } from "@/components/chat/composer";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

/*
 * THE DECISION FAMILY (INTERACTION_SPEC T4-T6, critique 1).
 *
 * Every place in the transcript that stops for the person (a task's question,
 * a task's approval, the chat's own approval card) is drawn from these few
 * parts, so a reader learns one shape:
 *
 *   - `NeedsLead`: the only attention words, "Needs your answer:" or "Needs
 *     your approval:", followed by WHAT in plain ink. No pill, no dot, no
 *     tinted box: the words are the state.
 *   - One button family. The verb is the one filled button, in ink (never
 *     the brand blue, which means "acting now"; a destructive verb takes the
 *     danger fill). Every way out is the same quiet outline: "Not now",
 *     "Tell Alevr what to do instead". Nothing else competes.
 *   - A standing permission is never a peer of the verb: it lives behind the
 *     verb's own caret, as a second way to say yes that says what it covers.
 */

/** "Needs your answer:" / "Needs your approval:", in the attention ink. */
export function NeedsLead({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-[hsl(var(--attention))] dark:font-normal">{children}</span>;
}

/** The filled verb: ink on light, paper on dark. A destructive verb uses the danger fill. */
export const VERB_INK_CLASS =
  "border-foreground bg-foreground text-background hover:bg-foreground/90 hover:border-foreground/90 active:bg-foreground/80";
export const VERB_DANGER_CLASS =
  "border-destructive bg-destructive text-destructive-foreground hover:brightness-[1.06] active:brightness-[.94]";
/** The ways out: one quiet outline. */
export const QUIET_OUTLINE_CLASS = "font-normal";

export interface VerbAlternative {
  label: string;
  /** What this choice means next time, in one line. */
  line?: string;
  onSelect: () => void;
}

/**
 * The verb, with its standing-permission choices behind a caret when there
 * are any. While `armed` is false (the first `approvalArm` after the card
 * appears or its payload changes) both halves ignore activation and are drawn
 * at half ink; no countdown is shown.
 */
export function VerbButton({
  label,
  accessibleLabel,
  onClick,
  armed,
  busy,
  danger,
  alternatives,
  menuLabel,
}: {
  label: string;
  accessibleLabel?: string;
  onClick: () => void;
  armed: boolean;
  busy?: boolean;
  danger?: boolean;
  alternatives?: VerbAlternative[];
  menuLabel?: string;
}) {
  const fill = danger ? VERB_DANGER_CLASS : VERB_INK_CLASS;
  const inert = !armed || !!busy;
  const split = !!alternatives && alternatives.length > 0;
  return (
    <span className={cn("inline-flex items-stretch", !armed && "opacity-50", "transition-opacity duration-fast ease-out-soft")}>
      <Button
        type="button"
        aria-disabled={inert || undefined}
        aria-label={accessibleLabel}
        onClick={() => {
          if (!inert) onClick();
        }}
        className={cn("h-9 px-4 coarse:h-11", fill, split && "rounded-r-none")}
      >
        {label}
      </Button>
      {split && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={inert}>
            <Button
              type="button"
              aria-label={menuLabel ?? "More ways to approve"}
              className={cn("h-9 w-9 rounded-l-none border-l-background/25 px-0 coarse:h-11", fill)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_W_WIDE}>
            {alternatives.map((alt) => (
              <DropdownMenuItem key={alt.label} onSelect={alt.onSelect}>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{alt.label}</span>
                  {alt.line && <span className="text-caption leading-relaxed text-muted-foreground">{alt.line}</span>}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

/** A way out: the one quiet outline every decision shares. */
export function QuietButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button type="button" variant="outline" className={cn("h-9 px-3.5 coarse:h-11", QUIET_OUTLINE_CLASS, className)} {...props} />;
}

/**
 * "Tell Alevr what to do instead": puts the cursor in the chat composer with
 * the sentence started, so the redirect is typed where everything else is.
 */
export function tellInstead(seed = "Instead of this, ") {
  window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: seed }));
  document.getElementById(CHAT_COMPOSER_FIELD_ID)?.focus();
}

export const TELL_INSTEAD_LABEL = `Tell ${PRODUCT_NAME} what to do instead`;
