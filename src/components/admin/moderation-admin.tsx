"use client";

import * as React from "react";
import { toast } from "sonner";
import { Ban, ChevronLeft, ChevronRight } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

type ModerationFlag = {
  id: string;
  userId: string;
  source: string;
  severity: string;
  category: string;
  detail: string;
  messagePreview: string | null;
  action: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  user: { name: string | null; email: string; bannedAt: string | null };
};

type ModerationResponse = {
  flags: ModerationFlag[];
  total: number;
  page: number;
  pageSize: number;
};

type Filter = "all" | "unreviewed" | "banned";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unreviewed", label: "Needs review" },
  { id: "banned", label: "Banned" },
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function severityClass(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "bg-destructive/10 text-destructive";
    case "medium":
      // The --warning ramp, not a raw Tailwind palette colour. `bg-amber-500/10
      // text-amber-600 dark:text-amber-500` bypassed the tokens that were tuned
      // per theme, so it could not follow the retheme; `textColor.warning`
      // already resolves to --warning-foreground, so one class covers both.
      return "bg-warning/10 text-warning";
    default:
      return "bg-muted text-muted-foreground";
  }
}

const CHIP = "rounded-full px-2 py-0.5 font-mono text-caption font-semibold";
const TH_CLASS = "px-4 py-2.5 font-mono text-caption font-medium text-muted-foreground";

export function ModerationAdmin() {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<ModerationResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  // A failed load used to fall through to "No moderation flags yet" — the most
  // reassuring sentence on the page, shown when the truth is that nobody knows.
  const [failed, setFailed] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const [banTarget, setBanTarget] = React.useState<ModerationFlag | null>(null);
  const [banReason, setBanReason] = React.useState("");
  const [banning, setBanning] = React.useState(false);

  const reqSeq = React.useRef(0);

  const load = React.useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setFailed(false);
      const params = new URLSearchParams({ page: String(page), filter });
      fetch(`/api/admin/moderation?${params}`, { signal })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "Could not load flags.");
          setData(body as ModerationResponse);
          setLoading(false);
        })
        .catch((err) => {
          if (signal?.aborted) return;
          toast.error(err instanceof Error ? err.message : "Could not load flags.");
          setFailed(true);
          setLoading(false);
        });
    },
    [page, filter]
  );

  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const patchFlag = (id: string, next: Partial<ModerationFlag>) => {
    setData((d) => d && { ...d, flags: d.flags.map((f) => (f.id === id ? { ...f, ...next } : f)) });
  };

  const patchUserBan = (userId: string, bannedAt: string | null) => {
    setData((d) => d && { ...d, flags: d.flags.map((f) => (f.userId === userId ? { ...f, user: { ...f.user, bannedAt } } : f)) });
  };

  const modReqSeq = React.useRef(new Map<string, number>());

  const toggleReviewed = (flag: ModerationFlag) => {
    const reviewed = !flag.reviewedAt;
    const token = (modReqSeq.current.get(flag.id) ?? 0) + 1;
    modReqSeq.current.set(flag.id, token);
    const prev = { reviewedAt: flag.reviewedAt, reviewedBy: flag.reviewedBy };
    patchFlag(flag.id, { reviewedAt: reviewed ? new Date().toISOString() : null });
    fetch(`/api/admin/moderation/${flag.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewed }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not update flag.");
        if (modReqSeq.current.get(flag.id) !== token) return;
        patchFlag(flag.id, { reviewedAt: body.reviewedAt, reviewedBy: body.reviewedBy });
      })
      .catch((err) => {
        if (modReqSeq.current.get(flag.id) === token) patchFlag(flag.id, prev);
        toast.error(err instanceof Error ? err.message : "Could not update flag.");
      });
  };

  const confirmBan = () => {
    if (!banTarget) return;
    const reason = banReason.trim();
    if (reason.length < 3) {
      toast.error("Give a reason of at least 3 characters.");
      return;
    }
    const target = banTarget;
    setBanning(true);
    fetch(`/api/admin/users/${target.userId}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not ban user.");
        patchUserBan(target.userId, new Date().toISOString());
        toast.success(`${target.user.email} has been banned.`);
        setBanTarget(null);
        setBanReason("");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not ban user.");
      })
      .finally(() => setBanning(false));
  };

  const unban = (flag: ModerationFlag) => {
    const token = (reqSeq.current += 1);
    patchUserBan(flag.userId, null);
    fetch(`/api/admin/users/${flag.userId}/unban`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not unban user.");
        toast.success(`${flag.user.email} has been unbanned.`);
      })
      .catch((err) => {
        if (reqSeq.current === token) patchUserBan(flag.userId, flag.user.bannedAt);
        toast.error(err instanceof Error ? err.message : "Could not unban user.");
      });
  };

  const flags = data?.flags ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));

  return (
    <AppPage measure="wide" contentClassName="flex flex-col gap-6">
        <AppPageHeader
          className="mb-0"
          eyebrow="Owner"
          heading="Moderation"
          icon={StatusIcons.security}
          lede="Content flags, strikes, and bans across the platform."
          actions={<AdminNav current="moderation" />}
        />

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            {/* The shared control, one import away, instead of a third local
                restatement of it — the inline copy repeated the inverted ladder
                (`bg-background` thumb on a `bg-secondary/50` track), so on OLED
                black the selected filter was the darkest thing in the control. */}
            <SegmentedControl<Filter>
              value={filter}
              onChange={(next) => {
                setFilter(next);
                setPage(1);
              }}
              ariaLabel="Filter flags"
              className="w-fit"
              options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            />
            {data && (
              <p className="font-mono text-caption tabular-nums text-muted-foreground">
                {total} {total === 1 ? "flag" : "flags"}
              </p>
            )}
          </div>

          {loading ? (
            <div className="flex flex-col gap-2 p-4" aria-hidden>
              {[...Array(8)].map((_, i) => (
                <div key={i} className="skeleton h-14 rounded-field" style={staggerDelay(i)} />
              ))}
            </div>
          ) : failed ? (
            <EmptyState
              tone="error"
              size="panel"
              icon={StatusIcons.security}
              className="m-4"
              title="Couldn't load the flag log"
              description="The request didn't come back, so nothing is shown — an empty table here would read as an all-clear."
              action={
                <Button variant="outline" size="sm" onClick={() => load()}>
                  Try again
                </Button>
              }
            />
          ) : flags.length === 0 ? (
            // The shared primitive. This was a detached top rule inside a card
            // that already draws a border above it, with no icon and no action.
            <EmptyState
              tone="empty"
              size="panel"
              icon={StatusIcons.security}
              title={
                filter === "unreviewed"
                  ? "Nothing needs review"
                  : filter === "banned"
                    ? "No bans on record"
                    : "No moderation flags yet"
              }
              description={
                filter === "all"
                  ? "Flags raised by the safety checks land here as they happen."
                  : "Nothing matches this filter right now."
              }
              action={
                filter === "all" ? undefined : (
                  <Button variant="outline" size="sm" onClick={() => { setFilter("all"); setPage(1); }}>
                    Show all flags
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left">
                    <th className={TH_CLASS}>User</th>
                    <th className={TH_CLASS}>Severity</th>
                    <th className={TH_CLASS}>Category</th>
                    <th className={TH_CLASS}>Detail</th>
                    <th className={TH_CLASS}>When</th>
                    <th className={TH_CLASS}>Action</th>
                    <th className={`${TH_CLASS} text-right`}>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => {
                    const isExpanded = expanded.has(f.id);
                    const long = f.detail.length > 90;
                    return (
                      <tr
                        key={f.id}
                        // Full `hover:bg-accent`, the same step the users table
                        // takes. /40 composited to ~9.1% over the 6.5% card —
                        // 2.6 points, which is not enough to follow a row across
                        // a seven-column table.
                        className="border-b border-border/60 align-top transition-colors duration-fast ease-out-soft last:border-b-0 hover:bg-accent"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium">{f.user.name || "—"}</p>
                            {f.user.bannedAt && (
                              <span className={cn(CHIP, "shrink-0 bg-destructive/10 text-destructive")}>Banned</span>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{f.user.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn(CHIP, severityClass(f.severity))}>{f.severity}</span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-mono text-xs">{f.category}</p>
                          <span className={cn(CHIP, "mt-1 inline-block bg-muted text-muted-foreground")}>{f.source}</span>
                        </td>
                        <td className="max-w-[22rem] px-4 py-3 text-xs text-muted-foreground">
                          <p className={cn(!isExpanded && long && "line-clamp-2")}>{f.detail}</p>
                          {f.messagePreview && isExpanded && (
                            // rounded-control + the opaque secondary rung: a
                            // `bg-muted/60` well composites to ~5.7% on pure
                            // black, which is under the card it sits in.
                            <p className="mt-1 rounded-control bg-secondary px-2 py-1 font-mono text-caption text-foreground/85 motion-safe:animate-fade-in">
                              {f.messagePreview}
                            </p>
                          )}
                          {(long || f.messagePreview) && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpanded((s) => {
                                  const next = new Set(s);
                                  if (next.has(f.id)) next.delete(f.id);
                                  else next.add(f.id);
                                  return next;
                                })
                              }
                              aria-expanded={isExpanded}
                              className="mt-1 rounded-sm text-caption font-medium text-primary underline-offset-2 transition-colors duration-fast ease-out-soft hover:underline"
                            >
                              {isExpanded ? "Show less" : "Show more"}
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                          {relativeTime(f.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              CHIP,
                              f.action === "banned"
                                ? "bg-destructive/10 text-destructive"
                                : f.action === "strike"
                                  ? // Same --warning ramp as severityClass above.
                                    "bg-warning/10 text-warning"
                                  : "bg-muted text-muted-foreground"
                            )}
                          >
                            {f.action}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            {f.user.bannedAt ? (
                              <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => unban(f)}>
                                <ActionIcons.restore className="size-3.5" />
                                Unban
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 text-destructive danger-hover"
                                onClick={() => {
                                  setBanReason(`${f.category}: ${f.detail}`.slice(0, 500));
                                  setBanTarget(f);
                                }}
                              >
                                <Ban className="size-3.5" />
                                Ban
                              </Button>
                            )}
                            <Button
                              variant={f.reviewedAt ? "ghost" : "outline"}
                              size="sm"
                              className="h-8"
                              onClick={() => toggleReviewed(f)}
                            >
                              {f.reviewedAt ? "Reopen" : "Mark reviewed"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border/70 px-4 py-3">
            <p className="font-mono text-caption tabular-nums text-muted-foreground">
              Page {page} of {pageCount}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="size-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={page >= pageCount || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </Card>

      <Dialog open={!!banTarget} onOpenChange={(open) => !open && !banning && (setBanTarget(null), setBanReason(""))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Ban {banTarget?.user.email}?</DialogTitle>
            <DialogDescription>
              This blocks sign-in and kills active sessions. The reason is recorded to the moderation log.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mod-ban-reason">Reason</Label>
            <Textarea
              id="mod-ban-reason"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="Why is this user being banned?"
              className="min-h-24"
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => (setBanTarget(null), setBanReason(""))} disabled={banning}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmBan} disabled={banning} className="gap-1.5">
              <Ban className="size-4" />
              {banning ? "Banning…" : "Ban user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
