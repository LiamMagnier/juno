"use client";

import * as React from "react";
import { Check, ChevronDown, Hand } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_PERMISSION_POLICIES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { COMPOSER_CHIP_CLASS } from "@/components/work/composer-home/composer-chip";
import { cn } from "@/lib/utils";

/**
 * How often this task stops to ask.
 *
 * This was a three-segment control below the composer, and the argument written
 * beside it there is the one this file has to keep honouring: these are the only
 * options here whose names are not self-explanatory. "Skip" alone reads as a
 * promise never to be interrupted, which is false in four cases and would
 * otherwise be discovered as a prompt somebody was told would not come.
 *
 * So the sentence travels with the control rather than being dropped when the
 * control shrank. Each row in the menu carries its own line from
 * `WORK_APPROVAL_MODE_SUMMARY`, which is where a reader deciding between the
 * three is actually looking; the composer keeps the chosen mode's line under
 * the surface for the reader who never opens the menu at all. Both read the
 * same record in `src/lib/work/domain.ts`, so there is one sentence per mode in
 * the product, not two that can drift.
 *
 * Only the mode is offered, never a per-action list. The four things that ask
 * under every mode are the floor — `ALWAYS_CONFIRM_ACTIONS` — and a control that
 * appeared to negotiate them would be promising something `approvalRuling`
 * refuses to deliver.
 *
 * A raised hand rather than a shield. Both shields in Juno's Work vocabulary are
 * spoken for by approvals themselves — `ShieldAlert` marks a run that has
 * stopped to ask and `ShieldCheck` one that was allowed — so a shield sitting
 * permanently in the composer would read as an approval already waiting, on a
 * task that has not started.
 */
export function WorkPermissionChip({
  value,
  onChange,
  disabled,
}: {
  value: WorkPermissionPolicy;
  onChange: (policy: WorkPermissionPolicy) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  // The default is not a decision, so it is not coloured like one. Coral here
  // marks a reader who moved off Auto — the case worth noticing on a strip
  // being skimmed — rather than every task ever composed.
  const chosen = value !== DEFAULT_WORK_PERMISSION_POLICY;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`How often this task asks before it acts: ${WORK_APPROVAL_MODE_LABEL[value]}. Change it`}
          className={COMPOSER_CHIP_CLASS}
        >
          <Hand
            className={cn("size-3.5 shrink-0", chosen ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="truncate">{WORK_APPROVAL_MODE_LABEL[value]}</span>
          <ChevronDown
            className="h-3 w-3 shrink-0 transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[19rem]">
        <DropdownMenuLabel className="font-mono text-label">
          How often this task asks
        </DropdownMenuLabel>
        {WORK_PERMISSION_POLICIES.map((policy) => {
          const active = policy === value;
          return (
            <DropdownMenuItem
              key={policy}
              // `items-start`, because the row is two lines and a centred check
              // beside a wrapped sentence floats away from the word it marks.
              className="items-start gap-2.5"
              onSelect={() => onChange(policy)}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cn("font-medium", active && "text-primary")}>
                    {WORK_APPROVAL_MODE_LABEL[policy]}
                  </span>
                  {policy === DEFAULT_WORK_PERMISSION_POLICY && (
                    <span className="font-mono text-micro text-muted-foreground">default</span>
                  )}
                </span>
                <span className="mt-0.5 block whitespace-normal text-caption leading-relaxed text-muted-foreground">
                  {WORK_APPROVAL_MODE_SUMMARY[policy]}
                </span>
              </span>
              {active && <Check className="mt-0.5 !size-3.5 shrink-0 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
