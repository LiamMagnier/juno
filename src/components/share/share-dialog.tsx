"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Link2 } from "lucide-react";
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

type ShareStatus = "idle" | "loading" | "ready" | "revoked" | "error";

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
      toast.success("Link revoked — it no longer works.");
    } catch {
      toast.error("Could not revoke the link.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">
            {kind === "CHAT" ? "Share this chat" : "Share this artifact"}
          </DialogTitle>
          <DialogDescription>
            {kind === "CHAT"
              ? "People with the link see the conversation up to now — new messages stay private."
              : "People with the link see this artifact as it is now — later edits stay private."}
          </DialogDescription>
        </DialogHeader>

        {status === "loading" || status === "idle" ? (
          <div className="skeleton h-9 rounded-xl" aria-hidden />
        ) : status === "error" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Couldn’t create the link. Please try again.</p>
            <Button variant="outline" size="sm" onClick={createLink}>
              Try again
            </Button>
          </div>
        ) : status === "revoked" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The link was revoked — anyone opening it now sees nothing.
            </p>
            <Button size="sm" onClick={createLink}>
              <Link2 className="h-3.5 w-3.5" /> Create a new link
            </Button>
          </div>
        ) : share ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={share.url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Share link"
                className="font-mono text-xs"
              />
              <Button size="sm" onClick={copy} className="shrink-0">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] text-muted-foreground">
                Snapshot · {formatSnapshotDate(share.snapshotAt)} · {share.views}{" "}
                {share.views === 1 ? "view" : "views"}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={revoke}
                disabled={revoking}
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
