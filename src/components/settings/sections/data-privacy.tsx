"use client";

import * as React from "react";
import { toast } from "sonner";
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
import { ImportHistoryCard } from "@/components/settings/import-history";
import { SharedLinksCard } from "@/components/share/shared-links-card";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";

export function DataPrivacySection() {
  const [deleteChatsOpen, setDeleteChatsOpen] = React.useState(false);
  const [deletingChats, setDeletingChats] = React.useState(false);

  const deleteAllChats = async () => {
    setDeletingChats(true);
    const res = await fetch("/api/conversations", { method: "DELETE" });
    if (res.ok) {
      toast.success("All conversations deleted.");
      window.location.href = "/chat";
    } else {
      setDeletingChats(false);
      toast.error("Could not delete conversations.");
    }
  };

  return (
    <>
      <SettingsGroup title="Your data" description="Everything Juno holds for you, in a format you can take elsewhere.">
        <SettingRow
          label="Export your data"
          description="Profile, settings, conversations, memories, projects and file metadata. The Juno package also carries Library bytes and revisions when they fit the archive cap."
          control={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href="/api/account/export" download>
                  <ActionIcons.download className="size-3.5" /> JSON
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href="/api/account/export?format=juno" download>
                  <ActionIcons.download className="size-3.5" /> Juno package
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href="/api/account/export?format=csv" download>
                  <ActionIcons.download className="size-3.5" /> CSV
                </a>
              </Button>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Import history" description="Bring conversations over from ChatGPT, Claude, Gemini or another Juno account.">
        <div className="py-3">
          <ImportHistoryCard />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Shared links" description="What you have made public, and how to take it back.">
        <div className="py-3">
          <SharedLinksCard />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Delete" description="Irreversible. This removes data permanently.">
        <SettingRow
          label="Delete all conversations"
          tone="destructive"
          description="Every chat and its messages, immediately. Memories and projects stay."
          control={
            <Button variant="destructive-outline" size="sm" onClick={() => setDeleteChatsOpen(true)} className="gap-2">
              <ActionIcons.delete className="size-4" /> Delete all chats
            </Button>
          }
        />
      </SettingsGroup>

      <Dialog open={deleteChatsOpen} onOpenChange={setDeleteChatsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all conversations?</DialogTitle>
            <DialogDescription>
              This permanently deletes all your conversations and message history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteChatsOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAllChats} disabled={deletingChats}>
              {deletingChats ? "Deleting…" : "Delete all chats"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
