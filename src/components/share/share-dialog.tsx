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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  publicationSummary,
  publishTargetValue,
  versionChoices,
  type ClientPublicationView,
} from "@/lib/publication-view";

/*
 * Share dialog for chats and artifacts.
 *
 * OPENING IT CREATES NOTHING. It used to mint a public link the moment it
 * opened (audit §3.1), so looking at the dialog published the thing. Now it
 * reads what exists and creating is an explicit action:
 *
 *   - a CHAT gets a snapshot link: "Create link", then Copy and Revoke;
 *   - an ARTIFACT is PUBLISHED (src/lib/artifact-publication.ts): a stable URL
 *     serving the version the owner picks (or the latest), with Update, Roll
 *     back (pick an older version), Unpublish and Reset link.
 *
 * Minimal on purpose: the visual redesign of sharing and publishing comes with
 * the new design system. Everything here is existing components.
 */

export interface ShareInfo {
  id: string;
  url: string;
  snapshotAt: string;
  views: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A read-only link field with a Copy button that confirms itself. */
function LinkField({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={label}
        className="font-mono text-caption"
      />
      <Button size="sm" onClick={copy} className="shrink-0">
        <IconSwap
          curve="spring"
          swapped={copied}
          from={<ActionIcons.copy className="size-4" aria-hidden />}
          to={<StatusIcons.success className="size-4" aria-hidden />}
        />
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <div className="flex items-center gap-2" aria-hidden>
        <div className="skeleton h-9 flex-1 rounded-field coarse:h-11" />
        <div className="skeleton h-8 w-20 shrink-0 rounded-control coarse:h-10" />
      </div>
      <div className="skeleton h-3 w-48 rounded-micro" aria-hidden />
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="space-y-3 motion-safe:animate-fade-in" role="alert">
      <p className="flex items-start gap-2 text-body text-destructive">
        <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden />
        <span className="min-w-0">{message}</span>
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

type ChatStatus = "loading" | "none" | "creating" | "ready" | "revoked" | "error" | "blocked";

/** A chat's snapshot link: read on open, created only on "Create link". */
function ChatLinkPanel({ conversationId, open }: { conversationId: string; open: boolean }) {
  const [status, setStatus] = React.useState<ChatStatus>("loading");
  const [share, setShare] = React.useState<ShareInfo | null>(null);
  const [revoking, setRevoking] = React.useState(false);
  const [blockedReason, setBlockedReason] = React.useState("");

  const load = React.useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/share?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { shares: ShareInfo[] };
      const existing = data.shares[0] ?? null;
      setShare(existing);
      setStatus(existing ? "ready" : "none");
    } catch {
      setStatus("error");
    }
  }, [conversationId]);

  React.useEffect(() => {
    if (open) void load();
    else {
      setStatus("loading");
      setShare(null);
    }
  }, [open, load]);

  const create = async () => {
    setStatus("creating");
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "CHAT", conversationId }),
      });
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        if (body?.code === "share_taken_down") {
          setBlockedReason(body.error ?? "This can’t be shared.");
          setStatus("blocked");
          return;
        }
      }
      if (!res.ok) throw new Error("create failed");
      const data = (await res.json()) as { share: ShareInfo };
      setShare(data.share);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  const revoke = async () => {
    if (!share) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/share/${share.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("revoke failed");
      setShare(null);
      setStatus("revoked");
      toast.success("Link revoked. It no longer works.");
    } catch {
      toast.error("Couldn’t revoke the link.");
    } finally {
      setRevoking(false);
    }
  };

  if (status === "loading") return <Loading label="Checking for a link" />;
  if (status === "error") return <Failure message="Couldn’t reach the link. Please try again." onRetry={() => void load()} />;
  if (status === "blocked") return <Failure message={blockedReason} />;
  if (status === "none" || status === "creating" || status === "revoked") {
    return (
      <div className="space-y-3 motion-safe:animate-fade-in">
        {status === "revoked" && (
          <p className="flex items-start gap-2 text-body text-muted-foreground" role="status">
            <Link2Off className="mt-1 size-4 shrink-0" aria-hidden />
            <span className="min-w-0">The link was revoked. Anyone opening it now sees nothing.</span>
          </p>
        )}
        <Button size="sm" onClick={() => void create()} disabled={status === "creating"} aria-busy={status === "creating"}>
          <Link2 className="size-4" aria-hidden />{" "}
          {status === "creating" ? "Creating…" : status === "revoked" ? "Create a new link" : "Create link"}
        </Button>
      </div>
    );
  }
  if (!share) return null;
  return (
    <div className="space-y-3 motion-safe:animate-fade-in">
      <LinkField url={share.url} label="Share link" />
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-caption tabular-nums text-muted-foreground">
          Snapshot · {formatDate(share.snapshotAt)} · {share.views} {share.views === 1 ? "view" : "views"}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void revoke()}
          disabled={revoking}
          aria-busy={revoking}
          className="text-destructive danger-hover"
        >
          {revoking ? "Revoking…" : "Revoke link"}
        </Button>
      </div>
    </div>
  );
}

type PublishStatus = "loading" | "ready" | "error" | "blocked";
type PublishAction = "publish" | "unpublish" | "reset";

/** An artifact's publication: read on open; every change is a button press. */
function PublishPanel({ artifactId, open }: { artifactId: string; open: boolean }) {
  const [status, setStatus] = React.useState<PublishStatus>("loading");
  const [publication, setPublication] = React.useState<ClientPublicationView | null>(null);
  const [currentVersion, setCurrentVersion] = React.useState(1);
  const [target, setTarget] = React.useState("latest");
  const [busy, setBusy] = React.useState<PublishAction | null>(null);
  const [blockedReason, setBlockedReason] = React.useState("");

  const load = React.useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/publication`, { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { publication: ClientPublicationView | null; currentVersion: number };
      setPublication(data.publication);
      setCurrentVersion(data.currentVersion);
      setTarget(publishTargetValue(data.publication));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [artifactId]);

  React.useEffect(() => {
    if (open) void load();
    else {
      setStatus("loading");
      setPublication(null);
    }
  }, [open, load]);

  const act = async (action: PublishAction) => {
    setBusy(action);
    try {
      const base = `/api/artifacts/${encodeURIComponent(artifactId)}/publication`;
      const res =
        action === "publish"
          ? await fetch(base, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ version: target === "latest" ? "latest" : Number(target) }),
            })
          : action === "unpublish"
            ? await fetch(base, { method: "DELETE" })
            : await fetch(`${base}/reset`, { method: "POST" });
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        if (body?.code === "share_taken_down") {
          setBlockedReason(body.error ?? "This can’t be published.");
          setStatus("blocked");
          return;
        }
      }
      if (!res.ok) throw new Error(`${action} failed`);
      const data = (await res.json()) as { publication: ClientPublicationView };
      setPublication(data.publication);
      setCurrentVersion((v) => Math.max(v, data.publication.servedVersion));
      setTarget(publishTargetValue(data.publication));
      toast.success(
        action === "publish"
          ? "Published."
          : action === "unpublish"
            ? "Unpublished. The link stops working until you publish again."
            : "Link reset. The old link no longer works."
      );
    } catch {
      toast.error(
        action === "publish" ? "Couldn’t publish." : action === "unpublish" ? "Couldn’t unpublish." : "Couldn’t reset the link."
      );
    } finally {
      setBusy(null);
    }
  };

  if (status === "loading") return <Loading label="Checking whether this is published" />;
  if (status === "error") return <Failure message="Couldn’t reach the publishing settings. Please try again." onRetry={() => void load()} />;
  if (status === "blocked") return <Failure message={blockedReason} />;

  const live = publication?.state === "live";
  const choices = versionChoices(currentVersion);
  const unchanged = live && target === publishTargetValue(publication);

  return (
    <div className="space-y-3 motion-safe:animate-fade-in">
      {publication && live && <LinkField url={publication.url} label="Published link" />}
      <p className="text-caption text-muted-foreground" role="status">
        {publicationSummary(publication, currentVersion)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="h-8 w-44" aria-label="Version to publish">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => void act("publish")} disabled={busy !== null || unchanged} aria-busy={busy === "publish"}>
          {busy === "publish" ? "Publishing…" : live ? "Update" : "Publish"}
        </Button>
      </div>
      {publication && (
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => void act("reset")} disabled={busy !== null} aria-busy={busy === "reset"}>
            {busy === "reset" ? "Resetting…" : "Reset link"}
          </Button>
          {live && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void act("unpublish")}
              disabled={busy !== null}
              aria-busy={busy === "unpublish"}
              className="text-destructive danger-hover"
            >
              {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "CHAT" ? "Share this chat" : "Publish this artifact"}</DialogTitle>
          <DialogDescription>
            {kind === "CHAT"
              ? "A link shows the conversation up to the moment you create it. New messages stay private."
              : "Publishing puts the version you choose on a public page anyone with the link can open. Later edits stay private until you update it."}
          </DialogDescription>
        </DialogHeader>
        {kind === "CHAT" && conversationId ? (
          <ChatLinkPanel conversationId={conversationId} open={open} />
        ) : kind === "ARTIFACT" && artifactId ? (
          <PublishPanel artifactId={artifactId} open={open} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
