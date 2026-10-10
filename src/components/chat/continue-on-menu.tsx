"use client";

import * as React from "react";
import { toast } from "sonner";
import { CodeIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { continueOn, type HandoffTarget } from "@/lib/sync/handoff-client";

/**
 * "Continue on iPhone / Mac" for the open chat (docs/code-v2/REMOTE-CONTROL.md
 * §Hand-off): the other app gets a notification that opens this thread.
 * Apple Handoff covers the apps side by side; this reaches one in a pocket.
 */
export function ContinueOnMenu({ conversationId, title }: { conversationId: string; title?: string }) {
  const [busy, setBusy] = React.useState(false);
  const send = async (target: HandoffTarget) => {
    setBusy(true);
    const result = await continueOn(target, { kind: "chat", id: conversationId, title });
    setBusy(false);
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Pressable kind="icon" size="lg" aria-label="Continue on another device" disabled={busy} className="text-foreground/75">
              <CodeIcons.device className="size-5" />
            </Pressable>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Continue on another device</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void send("ios")}>Continue on iPhone</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void send("macos")}>Continue on Mac</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
