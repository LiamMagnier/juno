"use client";

/**
 * What you can do to a Code session, from the session and from its row in the
 * sidebar: rename, pin, share a read-only link, archive (with Undo) and delete
 * (after a confirm). One hook, so the header menu and the row menu cannot
 * drift apart the way the legacy banner menu (code-session-menu.tsx) and the
 * v2 workspace did, where v2 could only rename, through window.prompt.
 *
 * The API has been complete since chat shipped: `PATCH /api/conversations/[id]`
 * takes title, pinned and archived, `DELETE` removes the row. Every change is
 * optimistic and taken back, with a sentence, when the server refuses it.
 *
 * SHARING A MAC SESSION. A session that runs on the Mac keeps its transcript
 * in the env server's log there, not in Message rows, so a server-side
 * snapshot would publish an empty page. The open workspace registers a getter
 * for its transcript (`registerSessionTranscript`); the link then carries the
 * person's messages and the final answers only (src/lib/share-transcript.ts),
 * redacted on the server. A row whose session is not open shares what the
 * server has, and says nothing it cannot back up.
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShareDialog } from "@/components/share/share-dialog";
import type { SharedTranscriptEntry } from "@/lib/share-transcript";

type TranscriptGetter = () => SharedTranscriptEntry[] | null;
const transcripts = new Map<string, TranscriptGetter>();

/** The open workspace offers its transcript for a share link. Returns the unregister. */
export function registerSessionTranscript(conversationId: string, getter: TranscriptGetter): () => void {
  transcripts.set(conversationId, getter);
  return () => {
    if (transcripts.get(conversationId) === getter) transcripts.delete(conversationId);
  };
}

/** Test seam and the share dialog's source: the transcript an open session offered, if any. */
export function sessionTranscript(conversationId: string): TranscriptGetter | undefined {
  return transcripts.get(conversationId);
}

/**
 * A session's name, edited where it is shown (the workspace title, a sidebar
 * row): Enter or leaving the field saves, Esc puts the old name back. Replaces
 * the window.prompt the v2 header used.
 */
export function InlineTitleInput({
  initial,
  onCommit,
  onCancel,
  className,
  label = "Session name",
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
  label?: string;
}) {
  const [draft, setDraft] = React.useState(initial);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(draft);
  };
  return (
    <input
      className={className}
      value={draft}
      aria-label={label}
      placeholder="Session name"
      maxLength={200}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

export interface CodeSessionActions {
  rename(id: string, title: string): void;
  setPinned(id: string, pinned: boolean): void;
  archive(id: string): void;
  requestDelete(id: string): void;
  requestShare(id: string): void;
  /** The confirm and share dialogs; render once wherever the hook is used. */
  ui: React.ReactNode;
}

async function patchConversation(id: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  return !!res?.ok;
}

export function useCodeSessionActions(): CodeSessionActions {
  const router = useRouter();
  const pathname = usePathname();
  const { conversations, updateConversation, removeConversation, upsertConversation } = useApp();
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [shareId, setShareId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // Read at call time, so a handler made on an older render still finds the row.
  const latest = React.useRef(conversations);
  latest.current = conversations;
  const find = (id: string) => latest.current.find((c) => c.id === id);
  const isOpen = (id: string) => !!pathname && ["/code/", "/chat/"].some((p) => pathname === `${p}${id}` || pathname.startsWith(`${p}${id}/`));

  const rename = (id: string, title: string) => {
    const next = title.trim().slice(0, 200);
    const before = find(id);
    if (!next || !before || next === before.title) return;
    // titleSource "manual" so the server's first-prompt naming never overwrites a chosen name.
    updateConversation(id, { title: next, titleSource: "manual" });
    void patchConversation(id, { title: next }).then((ok) => {
      if (ok) return;
      updateConversation(id, { title: before.title, titleSource: before.titleSource });
      toast.error("Could not rename this session.");
    });
  };

  const setPinned = (id: string, pinned: boolean) => {
    updateConversation(id, { pinned });
    void patchConversation(id, { pinned }).then((ok) => {
      if (ok) return;
      updateConversation(id, { pinned: !pinned });
      toast.error("Could not change the pin.");
    });
  };

  const archive = (id: string) => {
    const row = find(id);
    if (!row) return;
    const wasOpen = isOpen(id);
    removeConversation(id);
    void patchConversation(id, { archived: true }).then((ok) => {
      if (!ok) {
        upsertConversation(row);
        toast.error("Could not archive this session.");
        return;
      }
      toast.success("Session archived.", {
        action: {
          label: "Undo",
          onClick: () => {
            void patchConversation(id, { archived: false }).then((back) => {
              if (back) upsertConversation({ ...row, archivedAt: null });
              else toast.error("Could not bring the session back.");
            });
          },
        },
      });
      if (wasOpen) router.push("/code");
    });
  };

  const destroy = async (id: string) => {
    const row = find(id);
    const wasOpen = isOpen(id);
    setDeleting(true);
    if (row) removeConversation(id);
    const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => null);
    setDeleting(false);
    setConfirmId(null);
    if (!res?.ok) {
      if (row) upsertConversation(row);
      toast.error("Could not delete this session.");
      return;
    }
    if (wasOpen) router.push("/code");
  };

  const confirming = confirmId ? find(confirmId) : undefined;
  const ui = (
    <>
      <Dialog open={confirmId !== null} onOpenChange={(open) => !open && !deleting && setConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            {/* The one sentence that has to be exactly true: the transcript goes;
                a pushed branch, an open pull request and anything a run changed
                on a Mac do not, and nothing here could take those back. */}
            <DialogDescription>
              {confirming?.title ? <span className="font-medium text-foreground">{confirming.title}</span> : null}
              {confirming?.title ? " " : null}
              This permanently removes the transcript. Any branch or pull request a run pushed stays on GitHub, and anything it changed on your Mac stays there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirmId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} aria-busy={deleting} onClick={() => confirmId && void destroy(confirmId)}>
              {deleting ? "Deleting…" : "Delete session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {shareId && (
        <ShareDialog
          kind="CHAT"
          conversationId={shareId}
          open
          onOpenChange={(open) => !open && setShareId(null)}
          title="Share this session"
          description="A read-only link shows your messages and the answers up to now. The work log, commands and files stay private, and anything that looks like a key is hidden."
          transcript={sessionTranscript(shareId)}
        />
      )}
    </>
  );

  return { rename, setPinned, archive, requestDelete: setConfirmId, requestShare: setShareId, ui };
}
