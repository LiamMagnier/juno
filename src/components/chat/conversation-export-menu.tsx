"use client";

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { Copy, Download, Printer } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MENU_W } from "@/components/ui/menu-recipe";
import { ActionIcons } from "@/lib/app-icons";
import { MEMORY_OFF_COPY } from "@/lib/chat/memory-off";

/*
 * Export, from the conversation's own menu (spec §6.15): Copy as Markdown,
 * Download Markdown, Print or save as PDF. The chat view does the work
 * (chat-view.tsx `exportChat`, with conversation-export.ts and
 * conversation-print.tsx); these are the two doors to it. The header's More
 * menu calls it directly. An answer's More menu, which is how a phone reaches
 * it (the header band is desktop only), asks for it with `requestChatExport`.
 */

export type ChatExportKind = "copy" | "download" | "print";

/** The window event an answer's menu raises; chat-view.tsx listens. */
export const CHAT_EXPORT_EVENT = "juno:export-chat";

export function requestChatExport(kind: ChatExportKind): void {
  window.dispatchEvent(new CustomEvent<ChatExportKind>(CHAT_EXPORT_EVENT, { detail: kind }));
}

export function isChatExportKind(value: unknown): value is ChatExportKind {
  return value === "copy" || value === "download" || value === "print";
}

/** The menu's words, named so the i18n catalog generator picks them up. */
export const CHAT_EXPORT_COPY = {
  menuLabel: "More options for this chat",
  more: "More",
  heading: "Export",
  chatHeading: "Export chat",
  copy: "Copy as Markdown",
  download: "Download Markdown",
  print: "Print or save as PDF",
} as const;

/** The three export rows, for whichever menu holds them. */
export function ChatExportItems({ onSelect }: { onSelect: (kind: ChatExportKind) => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onSelect("copy")}>
        <Copy aria-hidden="true" className="size-4" /> {CHAT_EXPORT_COPY.copy}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onSelect("download")}>
        <Download aria-hidden="true" className="size-4" /> {CHAT_EXPORT_COPY.download}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onSelect("print")}>
        <Printer aria-hidden="true" className="size-4" /> {CHAT_EXPORT_COPY.print}
      </DropdownMenuItem>
    </>
  );
}

/**
 * Export inside an answer's More menu. A submenu where there is room beside
 * the menu for it; on a phone the three rows sit in the menu itself under a
 * heading, because a submenu there opened off the edge of the screen (the
 * menu sits at the answer's left, and its submenu had nowhere to go).
 * Mounted only while the menu is open, so the width is read only then.
 */
export function ExportChatMenuSection() {
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone) {
    return (
      <>
        <DropdownMenuLabel>{CHAT_EXPORT_COPY.chatHeading}</DropdownMenuLabel>
        <ChatExportItems onSelect={requestChatExport} />
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Download aria-hidden="true" className="size-4" /> {CHAT_EXPORT_COPY.chatHeading}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={MENU_W}>
        <ChatExportItems onSelect={requestChatExport} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The header's More button (desktop): the conversation's own menu. Export,
 * and — given `memory` — the chat's "Memory off for this chat"
 * (src/lib/chat/memory-off.ts), the same switch as the composer's + Memory
 * row read the other way round: ticked here means kept out. A checkbox row
 * that keeps the menu open, so the tick visibly lands where it was pressed.
 */
export function ConversationMoreMenu({
  onExport,
  memory,
}: {
  onExport: (kind: ChatExportKind) => void;
  memory?: { off: boolean; onChange: (off: boolean) => void };
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Pressable
              kind="icon"
              size="lg"
              aria-label={CHAT_EXPORT_COPY.menuLabel}
              className="text-muted-foreground hover:text-foreground data-[state=open]:control-neu data-[state=open]:text-foreground"
            >
              <ActionIcons.more className="size-5" />
            </Pressable>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{CHAT_EXPORT_COPY.more}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className={MENU_W}>
        <DropdownMenuLabel>{CHAT_EXPORT_COPY.heading}</DropdownMenuLabel>
        <ChatExportItems onSelect={onExport} />
        {memory && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={memory.off}
              onCheckedChange={(checked) => memory.onChange(checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              {MEMORY_OFF_COPY.menuLabel}
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Saves text as a file through a temporary link; the link and its object URL go at once. */
export function downloadTextFile(fileName: string, text: string, type = "text/markdown;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has been handled: revoking in the same task can cancel
  // the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
