"use client";

import { AppPage } from "@/components/app/app-page";
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, MessageSquare, Pin, SearchX } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { StatusBadge, CategoryChip, VoteButton, timeAgo } from "@/components/roadmap/roadmap-ui";
import {
  FEATURE_STATUSES,
  STATUS_META,
  type RoadmapComment,
  type RoadmapEvent,
  type RoadmapRequest,
  type FeatureStatus,
} from "@/lib/roadmap";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

type Detail = {
  request: RoadmapRequest;
  comments: RoadmapComment[];
  events: RoadmapEvent[];
  isOwner: boolean;
};

export default function RoadmapDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<"notfound" | "error" | null>(null);
  const [comment, setComment] = React.useState("");
  const [official, setOfficial] = React.useState(false);
  const [posting, setPosting] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/roadmap/${id}`);
      if (res.status === 404) return setError("notfound");
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("error");
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  const vote = async () => {
    if (!data) return;
    const r = data.request;
    setData({ ...data, request: { ...r, hasVoted: !r.hasVoted, voteCount: r.voteCount + (r.hasVoted ? -1 : 1) } });
    try {
      const res = await fetch(`/api/roadmap/${id}/vote`, { method: "POST" });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setData((cur) => (cur ? { ...cur, request: { ...cur.request, hasVoted: d.voted, voteCount: d.voteCount } } : cur));
    } catch {
      load();
      toast.error("Couldn’t register your vote.");
    }
  };

  const moderate = async (patch: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/roadmap/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      toast.success("Updated.");
      load();
    } catch {
      toast.error("Update failed.");
    }
  };

  const postComment = async () => {
    const body = comment.trim();
    if (!body) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/roadmap/${id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, official: official || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Could not comment.");
      setData((cur) => (cur ? { ...cur, comments: [...cur.comments, d.comment] } : cur));
      setComment("");
      setOfficial(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPosting(false);
    }
  };

  if (error === "notfound") {
    return (
      <CenteredMessage title="Request not found" body="It may have been removed or merged." onBack={() => router.push("/roadmap")} />
    );
  }
  if (error === "error") {
    return <CenteredMessage title="Couldn’t load this request" body="Something went wrong." retry={load} onBack={() => router.push("/roadmap")} />;
  }
  if (!data) {
    // The skeleton previews the shape that replaces it — vote rail beside a
    // title block, then the description — rather than two anonymous bars that
    // reflow the whole column the moment data lands.
    return (
      <AppPage measure="reading">
          <div className="skeleton mb-4 h-8 w-28 rounded-control" />
          <div className="flex gap-4">
            <div className="skeleton h-14 w-12 shrink-0 rounded-control" />
            <div className="min-w-0 flex-1 space-y-2">
              {/* The literal 60/120/…/360ms ladder written out by hand is exactly
                  STAGGER.loose, so this is the same rhythm said in the shared
                  vocabulary — and it now inherits the cap, which the hand-written
                  version could not. */}
              <div className="skeleton h-5 w-40 rounded-full" style={staggerDelay(1, "loose")} />
              <div className="skeleton h-7 w-3/4 rounded-control" style={staggerDelay(2, "loose")} />
              <div className="skeleton h-4 w-32 rounded-control" style={staggerDelay(3, "loose")} />
            </div>
          </div>
          <div className="mt-5 space-y-2">
            <div className="skeleton h-4 w-full rounded-control" style={staggerDelay(4, "loose")} />
            <div className="skeleton h-4 w-11/12 rounded-control" style={staggerDelay(5, "loose")} />
            <div className="skeleton h-4 w-2/3 rounded-control" style={staggerDelay(6, "loose")} />
          </div>
      </AppPage>
    );
  }

  const { request: r, comments, events, isOwner } = data;

  return (
    <AppPage measure="reading">
        <Button variant="ghost" size="sm" onClick={() => router.push("/roadmap")} className="mb-4 gap-1.5 text-muted-foreground">
          <ArrowLeft className="size-4" /> Roadmap
        </Button>

        {/* Header card */}
        <div className="flex gap-4">
          <VoteButton count={r.voteCount} voted={r.hasVoted} onToggle={vote} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={r.status} />
              <CategoryChip category={r.category} />
              {r.pinned && (
                <span className="inline-flex items-center gap-1 font-mono text-caption text-primary">
                  <Pin className="size-3 shrink-0 fill-primary text-primary" /> Pinned
                </span>
              )}
            </div>
            <h1 className="mt-2 font-sans text-title font-medium">{r.title}</h1>
            <p className="mt-1 flex items-center gap-2 text-caption text-muted-foreground">
              <DotIdenticon seed={r.author.id} className="size-4 shrink-0" />
              {r.author.name ?? "Someone"} · {timeAgo(r.createdAt)}
            </p>
          </div>
        </div>

        <p className="mt-5 whitespace-pre-wrap text-body leading-relaxed text-foreground/90">{r.description}</p>

        {r.status === "DECLINED" && r.declineReason && (
          <div className="mt-4 rounded-field border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <span className="font-medium">Declined:</span> {r.declineReason}
          </div>
        )}

        {/* Owner moderation */}
        {isOwner && (
          <Card variant="flat" className="mt-6 p-4">
            <p className="mb-3 font-mono text-label text-muted-foreground">Moderate</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={r.status} onValueChange={(v) => moderate({ status: v as FeatureStatus })}>
                <SelectTrigger className="h-8 w-[180px]" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEATURE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant={r.pinned ? "default" : "outline"} size="sm" onClick={() => moderate({ pinned: !r.pinned })} className="gap-1.5">
                <Pin className={cn("size-3.5 shrink-0", r.pinned && "fill-current")} /> {r.pinned ? "Unpin" : "Pin"}
              </Button>
              {r.status === "DECLINED" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const reason = window.prompt("Reason for declining (shown publicly):", r.declineReason ?? "");
                    if (reason !== null) moderate({ status: "DECLINED", declineReason: reason.trim() || null });
                  }}
                >
                  Edit reason
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Status timeline */}
        {events.length > 0 && (
          <div className="mt-8">
            <DottedDivider label="timeline" />
            <ol className="mt-4 space-y-3">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-3">
                  <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", STATUS_META[e.status].dot)} />
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{STATUS_META[e.status].label}</span>
                      {e.note ? <span className="text-muted-foreground"> — {e.note}</span> : null}
                    </p>
                    <p className="text-caption text-muted-foreground">{timeAgo(e.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Comments */}
        <div className="mt-8">
          <DottedDivider label={`${comments.length} ${comments.length === 1 ? "comment" : "comments"}`} />
          <ul className="mt-4 space-y-3">
            {comments.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "rounded-card border p-3.5 motion-safe:animate-rise-in",
                  // bg-primary/15, not /5: re-based against black, a 5% coral wash
                  // resolved to ~2.3% lightness — DARKER than the plain bg-card
                  // comment beside it, so the official reply was the one that sank.
                  // /15 lands level with --card and separates by hue instead.
                  c.official ? "border-primary/40 bg-primary/15" : "border-border bg-card"
                )}
              >
                <div className="mb-1.5 flex items-center gap-2 text-caption text-muted-foreground">
                  <DotIdenticon seed={c.author.id} className="size-4 shrink-0" />
                  <span className="font-medium text-foreground/90">{c.author.name ?? "Someone"}</span>
                  {c.official && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-caption text-primary">
                      <StatusIcons.verified className="size-3 shrink-0" /> Juno team
                    </span>
                  )}
                  <span>· {timeAgo(c.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-foreground/90">{c.body}</p>
              </li>
            ))}
            {comments.length === 0 && (
              <EmptyState size="panel" icon={MessageSquare} title="No comments yet" description="Start the conversation." />
            )}
          </ul>

          {/* Add comment */}
          <div className="mt-4 space-y-2">
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment…"
              className="min-h-[80px]"
              maxLength={2000}
            />
            <div className="flex items-center justify-between">
              {isOwner ? (
                // The Switch primitive, not a bare native checkbox: this was the only
                // `accent-[…]` in the area and the only control on the page rendering
                // with browser-default sizing, focus ring and hover.
                <label htmlFor="official-reply" className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
                  <Switch id="official-reply" checked={official} onCheckedChange={setOfficial} />
                  Post as official reply
                </label>
              ) : (
                <span />
              )}
              <Button onClick={postComment} disabled={posting || !comment.trim()} size="sm">
                {posting ? "Posting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>
    </AppPage>
  );
}

function CenteredMessage({
  title,
  body,
  onBack,
  retry,
}: {
  title: string;
  body: string;
  onBack: () => void;
  retry?: () => void;
}) {
  // Through EmptyState so a dead-end on this page is framed the same way as one
  // anywhere else. `retry` present means the fetch failed — that is the error
  // tone; a 404 is not a failure, it is a page that is genuinely not there.
  return (
    <div className="flex h-full items-center justify-center px-4">
      <EmptyState
        tone={retry ? "error" : "empty"}
        icon={retry ? StatusIcons.error : SearchX}
        title={title}
        description={body}
        action={
          <>
            {retry && (
              <Button variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            )}
            <Button size="sm" onClick={onBack}>
              Back to roadmap
            </Button>
          </>
        }
      />
    </div>
  );
}
