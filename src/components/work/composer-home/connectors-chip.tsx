"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Switch } from "@/components/ui/switch";
import type { ConnectorStatus } from "@/components/connections/types";
import { COMPOSER_CHIP_CLASS } from "@/components/work/composer-home/composer-chip";
import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * Which connected apps this task may reach.
 *
 * ── Why it left the [+] ────────────────────────────────────────────────────
 *
 * It was the third section of `ComposerAddMenu`, filed alongside the files and
 * the skill on the reasoning that all three are "what this task is handed". That
 * grouping was true and it was still the wrong tier. A file and a skill are
 * spent on the sentence you are writing; the apps a task may reach are the
 * standing scope of the run, in the same class as which project it is filed in
 * and where it executes — which is precisely what the composer's second tier is
 * for. Reaching an app also cost two gestures behind a menu that opens upward
 * over the field, for a decision the reader wants visible while they type.
 *
 * The [+]'s dot badge went with it, and had to. That dot existed for one reason,
 * written into `ComposerAddMenu`: an attachment already shows as a chip and a
 * named skill is visible in the goal, so a granted app was the only choice in
 * the menu with no other trace on the surface. It has one now — this chip, which
 * carries the count in the reader's line of sight. Leaving the dot would be the
 * same fact reported twice, in two places, one of which is a dot.
 *
 * ── Off by default, all of them ────────────────────────────────────────────
 *
 * A linked app is an account-wide fact — the mailbox stays connected whether or
 * not this errand needs it — and a task that inherited every one of them would
 * be handed a mailbox, a repository and a calendar to do something that needed
 * none of the three. Nothing here links, unlinks or re-authorises anything: it
 * narrows one task inside what the account already permits, which is why the
 * footer sends the reader to /connections rather than offering to connect an app
 * from a composer. `evaluateConnector` refuses everything left off with
 * `not_selected_for_task`.
 */
export function WorkConnectorsChip({
  connectors,
  failed,
  onRetry,
  selected,
  onToggle,
  disabled,
}: {
  /** Null while the list is in flight. */
  connectors: readonly ConnectorStatus[] | null;
  failed: boolean;
  onRetry: () => void;
  selected: readonly string[];
  onToggle: (connectorId: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const count = (connectors ?? []).filter((connector) => selected.includes(connector.id)).length;

  /*
   * Nothing at all for an account with no linked apps, and nothing while the
   * list is still in flight — the rule this chip inherits from the submenu it
   * replaced. A control that opens onto "you have none" offers a choice that
   * does not exist, and a chip that appeared a moment after the strip drew would
   * shift the two beside it out from under a pointer already heading for one.
   * A failed load is treated as full, because "Juno could not find out" is a
   * sentence somebody is owed and a Retry to act on.
   */
  if (!failed && (connectors === null || connectors.length === 0)) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            count > 0
              ? `Apps this task may reach: ${(connectors ?? [])
                  .filter((connector) => selected.includes(connector.id))
                  .map((connector) => connector.label)
                  .join(", ")}. Change them`
              : "Choose which connected apps this task may reach"
          }
          className={COMPOSER_CHIP_CLASS}
        >
          <AppIcons.connections
            className={cn("size-3.5 shrink-0", count > 0 ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="truncate">Apps</span>
          {count > 0 && <span className="shrink-0 tabular-nums text-primary">{count}</span>}
          <ChevronDown
            className="size-3 shrink-0 transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      {/* `side="top"`: the strip is the bottom edge of the composer, and a menu
          opening downward from it would leave the page under the reader's hand. */}
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex max-h-[min(22rem,60vh)] w-72 flex-col p-0"
      >
        <DropdownMenuLabel className="shrink-0 font-mono text-label">
          Apps this task may reach
        </DropdownMenuLabel>
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your connected apps. This task will reach none of them until it can.
              </p>
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (connectors ?? []).map((connector) => {
              const active = selected.includes(connector.id);
              return (
                <DropdownMenuItem
                  key={connector.id}
                  role="menuitemcheckbox"
                  aria-checked={active}
                  // Held open on select: turning two apps on is one decision, and
                  // a menu that closed after the first would make the reader
                  // reopen it to finish the sentence they were in the middle of.
                  onSelect={(event) => {
                    event.preventDefault();
                    onToggle(connector.id);
                  }}
                >
                  <AppIcons.connections
                    className={cn(active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex-1 truncate">{connector.label}</span>
                  <Switch checked={active} tabIndex={-1} aria-hidden className="pointer-events-none" />
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* The rule, said once, where the decision is made. Neither sentence is
            decoration: the first is why an app being linked is not enough on its
            own, and the second is what stops a reader reading this as a switch
            that disconnects things. */}
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <p className="text-caption leading-relaxed text-muted-foreground">
            Off means this task cannot reach it. Your connections are unchanged —{" "}
            <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
              manage them
            </Link>
            .
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
