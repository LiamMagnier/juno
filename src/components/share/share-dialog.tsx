"use client";

import * as React from "react";
import { toast } from "sonner";
import { Link2, Link2Off, Users } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Failure, LinkField, Loading, formatShareDate as formatDate } from "@/components/share/share-dialog-parts";
import { SharePeoplePanel } from "@/components/share/share-people-panel";
import {
  publicationSummary,
  publishTargetValue,
  versionChoices,
  type ClientPublicationView,
} from "@/lib/publication-view";
import type { SharedTranscriptEntry } from "@/lib/share-transcript";

/*
 * Share dialog for chats and artifacts.
 *
 * OPENING IT CREATES NOTHING. It used to mint a public link the moment it
 * opened (audit §3.1), so looking at the dialog published the thing. Now it
 * reads what exists and creating is an explicit action.
 *
 * Who can open it is the first choice, "Specific people" or "Anyone with the
 * link", and Specific people is where it starts — the private choice first:
 *
 *   - SPECIFIC PEOPLE (share-people-panel.tsx, src/lib/share-people-core.ts):
 *     add addresses; each gets an email and can open it only signed in with
 *     that verified address. Remove a person, or Stop sharing for everyone;
 *   - ANYONE WITH THE LINK, for a CHAT: a snapshot link, "Create link", then
 *     Copy and Revoke;
 *   - ANYONE WITH THE LINK, for an ARTIFACT: it is PUBLISHED
 *     (src/lib/artifact-publication.ts): a stable URL serving the version the
 *     owner picks (or the latest), with Update, Roll back (pick an older
 *     version), Unpublish and Reset link.
 *
 * The two are independent: a target can have a people share and a public
 * link at once, and switching the choice only changes which one the dialog is
 * showing — it never turns one into the other. A conversation whose transcript
 * is not on the server (a Code session on a Mac) shares by link only.
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

type ChatStatus = "loading" | "none" | "creating" | "ready" | "revoked" | "error" | "blocked";

/** A chat's snapshot link: read on open, created only on "Create link". */
function ChatLinkPanel({ conversationId, open, transcript }: { conversationId: string; open: boolean; transcript?: () => SharedTranscriptEntry[] | null }) {
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

  // A conversation whose transcript is not on the server (a Code session on a Mac) sends it along.
  const post = () => {
    const entries = transcript?.() ?? null;
    return fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "CHAT", conversationId, ...(entries ? { transcript: entries } : {}) }),
    });
  };

  // A transcript link's snapshot is what the owner's app sent: sending again refreshes the same
  // link (the server keeps its token), so the people who have it see the session as it is now.
  const [refreshing, setRefreshing] = React.useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await post();
      const body = (await res.json().catch(() => null)) as { share?: ShareInfo; error?: string } | null;
      if (!res.ok || !body?.share) {
        toast.error(body?.error ?? "Couldn’t update the link.");
        return;
      }
      setShare(body.share);
      toast.success("Link updated. It shows the session as it is now.");
    } catch {
      toast.error("Couldn’t update the link.");
    } finally {
      setRefreshing(false);
    }
  };

  const create = async () => {
    setStatus("creating");
    try {
      const res = await post();
      if (res.status === 403 || res.status === 400) {
        const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        if (body?.code === "share_taken_down" || body?.code === "transcript_invalid") {
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-caption tabular-nums text-muted-foreground">
          Snapshot · {formatDate(share.snapshotAt)} · {share.views} {share.views === 1 ? "view" : "views"}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {transcript && (
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing || revoking} aria-busy={refreshing}>
              {refreshing ? "Updating…" : "Update to now"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void revoke()}
            disabled={revoking || refreshing}
            aria-busy={revoking}
            className="text-destructive danger-hover"
          >
            {revoking ? "Revoking…" : "Revoke link"}
          </Button>
        </div>
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
  const [target, setTarget] = React.useState(publishTargetValue(null));
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
              body: JSON.stringify({ version: target === "latest" || target === "current" ? target : Number(target) }),
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

export type ShareAudienceChoice = "people" | "link";

/** The two answers to "who can open it", in the order the switch shows them. */
export function shareAudienceOptions(): SegmentedOption<ShareAudienceChoice>[] {
  return [
    // Icons from sm up: on a phone the two labels need the whole width.
    { value: "people", label: "Specific people", icon: <Users className="size-4 max-sm:hidden" aria-hidden /> },
    { value: "link", label: "Anyone with the link", icon: <Link2 className="size-4 max-sm:hidden" aria-hidden /> },
  ];
}

/** What the dialog says under its title, for each target and choice. */
export function shareDialogDescription(kind: "CHAT" | "ARTIFACT", audience: ShareAudienceChoice): string {
  if (audience === "people") {
    return kind === "CHAT"
      ? "The people you add can read the conversation up to the moment you first share it, signed in with the address you invite. New messages stay private."
      : "The people you add can see it as it is when you first share it, signed in with the address you invite. Later edits stay private.";
  }
  return kind === "CHAT"
    ? "A link shows the conversation up to the moment you create it. New messages stay private."
    : "Publishing puts the version you choose on a public page anyone with the link can open. Later edits stay private until you update it, unless you choose to follow the latest version.";
}

export function ShareDialog({
  kind,
  conversationId,
  artifactId,
  open,
  onOpenChange,
  title,
  description,
  transcript,
  initialAudience,
}: {
  kind: "CHAT" | "ARTIFACT";
  conversationId?: string;
  artifactId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides for a chat-kind link that is not a chat (a Code session); `description` is the link's. */
  title?: string;
  description?: string;
  /** For a conversation whose transcript is not on the server: what the link should show. */
  transcript?: () => SharedTranscriptEntry[] | null;
  /**
   * Which choice the dialog opens on. Specific people unless the caller asked
   * for something public by name (an artifact's "Publish…").
   */
  initialAudience?: ShareAudienceChoice;
}) {
  // Only a conversation the server holds can be shared with people: its page is
  // built from the server's own messages.
  const peopleAllowed = !transcript;
  const start: ShareAudienceChoice = peopleAllowed ? (initialAudience ?? "people") : "link";
  const [audience, setAudience] = React.useState<ShareAudienceChoice>(start);
  // Each opening starts from its first choice again, not from where the last one was left.
  React.useEffect(() => {
    if (!open) setAudience(start);
  }, [open, start]);
  const target = kind === "CHAT" && conversationId ? { conversationId } : kind === "ARTIFACT" && artifactId ? { artifactId } : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? (kind === "CHAT" ? "Share this chat" : "Share this artifact")}</DialogTitle>
          {/* A caller's description is about its link (a Code session's), so it
              stands in for the link's sentence only. */}
          <DialogDescription>{(audience === "link" && description) || shareDialogDescription(kind, audience)}</DialogDescription>
        </DialogHeader>
        {peopleAllowed && target && (
          <SegmentedControl
            value={audience}
            onChange={setAudience}
            options={shareAudienceOptions()}
            ariaLabel="Who can open it"
            optionClassName="max-sm:px-2 max-sm:text-caption"
          />
        )}
        {/* Keyed by the choice, so each panel reads its own state on arrival
            and a half-typed address does not follow the reader across. */}
        {peopleAllowed && target && audience === "people" ? (
          <SharePeoplePanel key="people" target={target} open={open} />
        ) : kind === "CHAT" && conversationId ? (
          <ChatLinkPanel key="link" conversationId={conversationId} open={open} transcript={transcript} />
        ) : kind === "ARTIFACT" && artifactId ? (
          <PublishPanel key="link" artifactId={artifactId} open={open} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
