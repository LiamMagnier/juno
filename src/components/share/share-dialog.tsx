"use client";

import * as React from "react";
import { toast } from "sonner";
import { Link2, Link2Off } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/*
 * Share dialog for chats and artifacts. Opening it creates the link (the API
 * reuses the newest active one for the target, so reopening never mints a new
 * URL), shows it in a read-only mono field with a Copy confirmation, and
 * offers Revoke. The snapshot line makes the privacy contract explicit.
 */

export interface ShareInfo {
  id: string;
  url: string;
  snapshotAt: string;
  views: number;
}

type ShareStatus = "idle" | "loading" | "ready" | "revoked" | "error" | "blocked";

function formatSnapshotDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ShareDialog({
  kind,
  conversationId,
  artifactId,
  open,
  onOpenChange,
}: {
  kind: "CHAT" | "ARTIFACT";
  conversationId?: string;
  artifactId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = React.useState<ShareStatus>("idle");
  const [share, setShare] = React.useState<ShareInfo | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  // Juno took a link to this down (src/lib/share.ts ShareTakenDownError); the
  // server's sentence says so, and retrying would not change it.
  const [blockedReason, setBlockedReason] = React.useState("");

  const targetId = kind === "CHAT" ? conversationId : artifactId;

  const createLink = React.useCallback(async () => {
    if (!targetId) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "CHAT" ? { kind, conversationId: targetId } : { kind, artifactId: targetId }
        ),
      });
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        if (body?.code === "share_taken_down") {
          setBlockedReason(body.error ?? "This can’t be shared.");
          setStatus("blocked");
          return;
        }
      }
      if (!res.ok) throw new Error("Create failed");
      const data = (await res.json()) as { share: ShareInfo };
      setShare(data.share);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [kind, targetId]);

  // Create (or fetch the existing link) as soon as the dialog opens.
  React.useEffect(() => {
    if (open) {
      setCopied(false);
      void createLink();
    } else {
      setStatus("idle");
      setShare(null);
    }
  }, [open, createLink]);

  const copy = async () => {
    if (!share) return;
    await navigator.clipboard.writeText(share.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const revoke = async () => {
    if (!share) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/share/${share.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Revoke failed");
      setShare(null);
      setStatus("revoked");
      toast.success("Link revoked. It no longer works.");
    } catch {
      toast.error("Couldn’t revoke the link.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {kind === "CHAT" ? "Share this chat" : "Share this artifact"}
          </DialogTitle>
          <DialogDescription>
            {kind === "CHAT"
              ? "People with the link see the conversation up to now. New messages stay private."
              : "People with the link see this artifact as it is now. Later edits stay private."}
          </DialogDescription>
        </DialogHeader>

        {status === "loading" || status === "idle" ? (
          // Two bars, not one: the ready state is a field row PLUS a metadata
          // row, so a single 36px placeholder meant the dialog grew ~28px the
          // moment the link arrived — a box that resizes under the cursor.
          <div className="space-y-3" role="status" aria-label="Creating the link">
            <div className="flex items-center gap-2" aria-hidden>
              <div className="skeleton h-9 flex-1 rounded-field coarse:h-11" />
              <div className="skeleton h-8 w-20 shrink-0 rounded-control coarse:h-10" />
            </div>
            <div className="skeleton h-3 w-48 rounded-micro" aria-hidden />
          </div>
        ) : status === "error" ? (
          // role="alert" and the destructive tint: this was a muted grey sentence,
          // i.e. a failure dressed as ordinary help text, in a dialog whose whole
          // job had just not happened.
          <div className="space-y-3 motion-safe:animate-fade-in" role="alert">
            <p className="flex items-start gap-2 text-body text-destructive">
              <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden />
              <span className="min-w-0">Couldn’t create the link. Please try again.</span>
            </p>
            <Button variant="outline" size="sm" onClick={createLink}>
              Try again
            </Button>
          </div>
        ) : status === "blocked" ? (
          <p className="flex items-start gap-2 text-body text-destructive motion-safe:animate-fade-in" role="alert">
            <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden />
            <span className="min-w-0">{blockedReason}</span>
          </p>
        ) : status === "revoked" ? (
          <div className="space-y-3 motion-safe:animate-fade-in" role="status">
            {/* The broken link, the set's own mark for exactly this state. */}
            <p className="flex items-start gap-2 text-body text-muted-foreground">
              <Link2Off className="mt-1 size-4 shrink-0" aria-hidden />
              <span className="min-w-0">The link was revoked. Anyone opening it now sees nothing.</span>
            </p>
            {/* size-4, not size-3.5. That is what Button gives an unsized icon
                (`.ui-button svg:not([class*="size-"])` in globals.css), it is
                what the same Copy/Check pair renders at in the shared-links card,
                and one feature was drawing one glyph at two sizes depending on
                which surface you reached it from. */}
            <Button size="sm" onClick={createLink}>
              <Link2 className="size-4" aria-hidden /> Create a new link
            </Button>
          </div>
        ) : share ? (
          // Fades in over the skeleton it replaces, which holds the same two rows.
          <div className="space-y-3 motion-safe:animate-fade-in">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={share.url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Share link"
                className="font-mono text-caption"
              />
              {/* aria-live on the label, not just a swapped glyph: the copy
                  confirmation was a purely visual state change, so a screen
                  reader got no acknowledgement that anything had happened. */}
              <Button size="sm" onClick={copy} className="shrink-0">
                {/* Copy ⇄ check in one box (IconSwap); the check keeps the
                    button's own ink, since it sits on the accent fill. */}
                <IconSwap
                  curve="spring"
                  swapped={copied}
                  from={<ActionIcons.copy className="size-4" aria-hidden />}
                  to={<StatusIcons.success className="size-4" aria-hidden />}
                />
                <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-caption tabular-nums text-muted-foreground">
                Snapshot · {formatSnapshotDate(share.snapshotAt)} · {share.views}{" "}
                {share.views === 1 ? "view" : "views"}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={revoke}
                disabled={revoking}
                aria-busy={revoking}
                className="text-destructive danger-hover"
              >
                {revoking ? "Revoking…" : "Revoke link"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
