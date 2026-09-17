"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShareDialog } from "@/components/share/share-dialog";
import { useApp } from "@/components/app/app-provider";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import type { ClientConversation } from "@/types/chat";

/*
 * WHAT YOU CAN DO TO A CODE SESSION, FROM THE SESSION.
 *
 * The API for all four of these has been complete since chat shipped —
 * `PATCH /api/conversations/[id]` takes title, pinned and archived, `DELETE`
 * removes the row, and `ShareDialog kind="CHAT"` makes a read-only snapshot —
 * and a code session could reach none of it. The sidebar filtered code rows out
 * of the list that carries the kebab, so the only way to rename a session was
 * to let the first prompt name it, and the only way to be rid of one was to
 * leave it there.
 *
 * ── WHY IT IS A MENU IN THE BANNER RATHER THAN A ROW OF BUTTONS ────────────
 *
 * The banner's right cluster already carries the facts that CHANGE — what the
 * run is doing, what CI says, how much it has written. These four do not
 * change; they are things a person does once. A menu is the shape for that, and
 * it keeps the row's one-glance reading intact (docs/design/PREMIUM_AUDIT.md
 * §3: a surface answers one question, and this one answers "what is happening").
 *
 * ── SHARE SHOWS PROSE, NOT COMMANDS, AND THAT IS DELIBERATE ────────────────
 *
 * A shared snapshot drops `activity` (src/app/share/[token]/page.tsx), so a
 * shared code session is the conversation without the tool rows. That stays: a
 * run's activity log is every command it ran and every path it touched in a
 * private repository, and a link anyone can open is the last place that belongs.
 * The menu item says so — "(no run log)" — rather than letting a reader find
 * out from the page after they have sent the link.
 */
export function CodeSessionMenu({ conversation }: { conversation: ClientConversation }) {
  const router = useRouter();
  const { updateConversation, removeConversation } = useApp();
  const [renaming, setRenaming] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [title, setTitle] = React.useState(conversation.title);

  const patch = React.useCallback(
    async (body: Record<string, unknown>, failure: string) => {
      const res = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) toast.error(failure);
      return !!res?.ok;
    },
    [conversation.id],
  );

  const rename = async () => {
    const next = title.trim();
    setRenaming(false);
    if (!next || next === conversation.title) return;
    // Optimistic, with `titleSource` so the server's own first-prompt naming
    // never overwrites a name a person chose — the same pair the sidebar sends.
    updateConversation(conversation.id, { title: next, titleSource: "manual" });
    await patch({ title: next }, "Could not rename this session.");
  };

  const archive = async () => {
    removeConversation(conversation.id);
    const ok = await patch({ archived: true }, "Could not archive this session.");
    if (!ok) return;
    toast.success("Session archived.", {
      action: {
        label: "Undo",
        onClick: () => {
          void patch({ archived: false }, "Could not bring the session back.");
          // The row comes back from the server on the next sidebar load; the
          // sentence is what tells the reader the undo landed.
          router.refresh();
        },
      },
    });
    router.push("/code");
  };

  const destroy = async () => {
    setConfirmDelete(false);
    removeConversation(conversation.id);
    const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error("Could not delete this session.");
      return;
    }
    router.push("/code");
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" className="shrink-0" aria-label="Session options">
                <ActionIcons.more className="size-4" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Session options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(conversation.title);
              setRenaming(true);
            }}
          >
            <ActionIcons.edit className="size-4" aria-hidden="true" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              const pinned = !conversation.pinned;
              updateConversation(conversation.id, { pinned });
              void patch({ pinned }, "Could not change the pin.");
            }}
          >
            <CodeIcons.pin className="size-4" aria-hidden="true" />
            {conversation.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSharing(true)}>
            <ActionIcons.share className="size-4" aria-hidden="true" /> Share a read-only link (no run log)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archive()}>
            <Archive className="size-4" aria-hidden="true" /> Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setConfirmDelete(true)} variant="destructive">
            <ActionIcons.delete className="size-4" aria-hidden="true" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename this session</DialogTitle>
            <DialogDescription>
              The name in the sidebar and at the top of the transcript. It never changes the workspace or the
              repository this session runs against.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void rename();
              }
            }}
            maxLength={200}
            autoFocus
            aria-label="Session name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void rename()} disabled={!title.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            {/*
              The one sentence that has to be exactly true. Deleting the
              conversation removes the transcript; it does not touch a branch
              that was pushed, a pull request that was opened, or anything a run
              wrote on a Mac — none of which this product could take back.
            */}
            <DialogDescription>
              This permanently removes the transcript and everything in it. Any branch or pull request a run
              already pushed stays on GitHub, and anything it changed on your Mac stays there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void destroy()}>
              Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sharing && (
        <ShareDialog
          kind="CHAT"
          conversationId={conversation.id}
          open
          onOpenChange={(open) => !open && setSharing(false)}
        />
      )}
    </>
  );
}
