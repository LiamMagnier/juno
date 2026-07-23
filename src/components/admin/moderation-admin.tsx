"use client";

import * as React from "react";
import { toast } from "sonner";
import { Ban, ChevronLeft, ChevronRight, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
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
      return "bg-amber-500/10 text-amber-600 dark:text-amber-500";
    default:
      return "bg-muted text-muted-foreground";
  }
}

const CHIP = "rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold";
const TH_CLASS = "px-4 py-2.5 font-mono text-[11px] font-medium text-muted-foreground";

export function ModerationAdmin() {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<ModerationResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const [banTarget, setBanTarget] = React.useState<ModerationFlag | null>(null);
  const [banReason, setBanReason] = React.useState("");
  const [banning, setBanning] = React.useState(false);

  const reqSeq = React.useRef(0);

  const load = React.useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-label text-muted-foreground">
              <ShieldAlert className="h-4 w-4" />
              Owner
            </div>
            <h1 className="font-serif text-display font-medium tracking-tight">Moderation</h1>
            <p className="mt-1 text-sm text-muted-foreground">Content flags, strikes, and bans across the platform.</p>
          </div>
          <AdminNav current="moderation" />
        </div>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="flex w-fit items-center gap-1 rounded-full border border-border/60 bg-secondary/50 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setFilter(f.id);
                    setPage(1);
                  }}
                  aria-pressed={filter === f.id}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 font-mono text-xs font-medium transition-colors duration-fast ease-out-soft",
                    filter === f.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {data && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {total} {total === 1 ? "flag" : "flags"}
              </p>
            )}
          </div>

          {loading ? (
            <div className="flex flex-col gap-2 p-4">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="skeleton h-14 rounded-lg" />
              ))}
            </div>
          ) : flags.length === 0 ? (
            <div className="m-4 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              {filter === "unreviewed"
                ? "Nothing needs review. Nice."
                : filter === "banned"
                  ? "No bans on record."
                  : "No moderation flags yet."}
            </div>
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
                      <tr key={f.id} className="border-b border-border/40 align-top last:border-b-0">
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
                            <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px] text-foreground/80">
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
                              className="mt-1 text-[11px] text-primary underline-offset-2 hover:underline"
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
                                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-500"
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
                                <RotateCcw className="h-3.5 w-3.5" />
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
                                <Ban className="h-3.5 w-3.5" />
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
            <p className="font-mono text-[11px] text-muted-foreground">
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
                <ChevronLeft className="h-4 w-4" />
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
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      </div>

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
              <Ban className="h-4 w-4" />
              {banning ? "Banning…" : "Ban user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
