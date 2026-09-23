"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { ImportHistoryRow } from "@/components/settings/import-history";
import { SharedLinksList } from "@/components/share/shared-links-card";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";

/** The three export formats, each with the one line that tells them apart. */
const EXPORT_FORMATS: { href: string; label: string; description: string }[] = [
  {
    href: "/api/account/export",
    label: "JSON",
    description: "Everything, in one readable file.",
  },
  {
    href: "/api/account/export?format=juno",
    label: "Juno package",
    description: "Everything, plus your Library files where they fit.",
  },
  {
    href: "/api/account/export?format=csv",
    label: "CSV",
    description: "Your conversations, for a spreadsheet.",
  },
];

export function DataPrivacySection() {
  const [deleteChatsOpen, setDeleteChatsOpen] = React.useState(false);
  const [deletingChats, setDeletingChats] = React.useState(false);

  const deleteAllChats = async () => {
    setDeletingChats(true);
    const res = await fetch("/api/conversations", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      toast.success("All conversations deleted.");
      window.location.href = "/chat";
    } else {
      setDeletingChats(false);
      toast.error("Couldn’t delete conversations.");
    }
  };

  return (
    <>
      <SettingsGroup>
        <SettingRow
          label="Export your data"
          description="Profile, settings, conversations, memories, projects and file details."
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="group">
                  Export
                  <ChevronDown
                    className="size-4 opacity-60 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_W_WIDE}>
                {EXPORT_FORMATS.map((format) => (
                  <DropdownMenuItem key={format.href} asChild className="items-start py-2">
                    <a href={format.href} download>
                      <ActionIcons.download className="mt-0.5 size-4" aria-hidden="true" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-ui font-medium text-foreground">{format.label}</span>
                        <span className="text-caption text-muted-foreground">{format.description}</span>
                      </span>
                    </a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <ImportHistoryRow />
      </SettingsGroup>

      <SettingsGroup title="Shared links" description="Anyone with one of these links can open what it shows.">
        <SharedLinksList />
      </SettingsGroup>

      <SettingsGroup tone="destructive">
        <SettingRow
          label="Delete all conversations"
          tone="destructive"
          description="Every chat and its messages, at once. Memories and projects stay."
          control={
            <Button variant="destructive-outline" size="sm" onClick={() => setDeleteChatsOpen(true)}>
              Delete all
            </Button>
          }
        />
      </SettingsGroup>

      <Dialog open={deleteChatsOpen} onOpenChange={(next) => (deletingChats ? undefined : setDeleteChatsOpen(next))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete all conversations?</DialogTitle>
            <DialogDescription>
              Every conversation and its messages are deleted for good. Memories and projects stay. This can’t be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteChatsOpen(false)} disabled={deletingChats}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void deleteAllChats()} loading={deletingChats}>
              Delete all conversations
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
