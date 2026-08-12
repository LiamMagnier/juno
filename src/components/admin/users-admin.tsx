"use client";

import * as React from "react";
import { toast } from "sonner";
import { Ban, ChevronLeft, ChevronRight, MoreHorizontal, RotateCcw, Search, Trash2, Users as UsersIcon } from "lucide-react";
import type { Plan, SubStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppPageHeader } from "@/components/app/app-page-header";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { PLANS } from "@/lib/plans";
import { staggerDelay } from "@/lib/motion";

const PLAN_OPTIONS: Plan[] = ["FREE", "PRO", "MAX", "MAX20", "OWNER"];
const STRIKE_LIMIT = 3;

type AdminUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: string;
  plan: Plan;
  subscriptionStatus: SubStatus | null;
  messagesThisMonth: number;
  monthSpendMicroUsd: number;
  monthSpendWebMicroUsd: number;
  monthSpendAppMicroUsd: number;
  bannedAt: string | null;
  banReason: string | null;
  strikes: number;
  flagCount: number;
};

type UsersResponse = {
  users: AdminUser[];
  page: number;
  pageSize: number;
  total: number;
  totals: { users: number; activeThisMonth: number; flaggedCount: number };
};

function formatSpend(microUsd: number): string {
  if (!microUsd) return "—";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// `text-caption` is exactly the 11px this used to spell out by hand, and it is
// the rung the rest of the product's mono metadata sits on — the arbitrary value
// meant admin was the only surface whose table headers could drift off the scale.
const TH_CLASS = "px-4 py-2.5 font-mono text-caption font-medium uppercase text-muted-foreground";

export function UsersAdmin({ selfId }: { selfId: string }) {
  const [query, setQuery] = React.useState("");
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<UsersResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  /*
   * A failed load was indistinguishable from an empty account list.
   *
   * The catch below toasted and set loading=false, leaving `data` null — so the
   * table fell through to "No users yet", which is a claim about the database
   * rather than about the request. A toast is gone in four seconds; the wrong
   * empty state stays on screen. `reloadKey` exists because the fetch is keyed
   * off [q, page] and neither changes when you press Try again.
   */
  const [failed, setFailed] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [banTarget, setBanTarget] = React.useState<AdminUser | null>(null);
  const [banReason, setBanReason] = React.useState("");
  const [banning, setBanning] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminUser | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => {
      setQ(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set("q", q);
    fetch(`/api/admin/users?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load users.");
        setData(body as UsersResponse);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        toast.error(err instanceof Error ? err.message : "Could not load users.");
        setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q, page, reloadKey]);

  const patchUser = (id: string, next: Partial<AdminUser>) => {
    setData((d) => d && { ...d, users: d.users.map((u) => (u.id === id ? { ...u, ...next } : u)) });
  };

  const planReqSeq = React.useRef(new Map<string, number>());

  const changePlan = (target: AdminUser, plan: Plan) => {
    if (plan === target.plan) return;
    const prev = target.plan;
    const token = (planReqSeq.current.get(target.id) ?? 0) + 1;
    planReqSeq.current.set(target.id, token);
    patchUser(target.id, { plan });
    fetch(`/api/admin/users/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not update plan.");
        if (planReqSeq.current.get(target.id) !== token) return;
        patchUser(target.id, { plan: body.user.plan, subscriptionStatus: body.user.subscriptionStatus });
        toast.success(`${target.email} is now on ${PLANS[body.user.plan as Plan].name}.`);
      })
      .catch((err) => {
        if (planReqSeq.current.get(target.id) !== token) return;
        patchUser(target.id, { plan: prev });
        toast.error(err instanceof Error ? err.message : "Could not update plan.");
      });
  };

  const modReqSeq = React.useRef(new Map<string, number>());

  const confirmBan = () => {
    if (!banTarget) return;
    const reason = banReason.trim();
    if (reason.length < 3) {
      toast.error("Give a reason of at least 3 characters.");
      return;
    }
    const target = banTarget;
    const token = (modReqSeq.current.get(target.id) ?? 0) + 1;
    modReqSeq.current.set(target.id, token);
    setBanning(true);
    const nowIso = new Date().toISOString();
    patchUser(target.id, { bannedAt: nowIso, banReason: reason });
    fetch(`/api/admin/users/${target.id}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not ban user.");
        toast.success(`${target.email} has been banned.`);
        setBanTarget(null);
        setBanReason("");
      })
      .catch((err) => {
        if (modReqSeq.current.get(target.id) === token) {
          patchUser(target.id, { bannedAt: null, banReason: null });
        }
        toast.error(err instanceof Error ? err.message : "Could not ban user.");
      })
      .finally(() => setBanning(false));
  };

  const unban = (target: AdminUser) => {
    const token = (modReqSeq.current.get(target.id) ?? 0) + 1;
    modReqSeq.current.set(target.id, token);
    const prev = { bannedAt: target.bannedAt, banReason: target.banReason, strikes: target.strikes };
    patchUser(target.id, { bannedAt: null, banReason: null, strikes: 0 });
    fetch(`/api/admin/users/${target.id}/unban`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not unban user.");
        toast.success(`${target.email} has been unbanned.`);
      })
      .catch((err) => {
        if (modReqSeq.current.get(target.id) === token) patchUser(target.id, prev);
        toast.error(err instanceof Error ? err.message : "Could not unban user.");
      });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    if (deleteConfirm.trim().toLowerCase() !== deleteTarget.email.toLowerCase()) {
      toast.error("The email you typed does not match.");
      return;
    }
    const target = deleteTarget;
    setDeleting(true);
    fetch(`/api/admin/users/${target.id}`, { method: "DELETE" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not delete user.");
        setData((d) =>
          d && { ...d, users: d.users.filter((u) => u.id !== target.id), total: Math.max(0, d.total - 1) }
        );
        toast.success(`${target.email} has been deleted.`);
        setDeleteTarget(null);
        setDeleteConfirm("");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not delete user.");
      })
      .finally(() => setDeleting(false));
  };

  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));

  return (
    <div className="app-page-scroll">
      <div className="app-page-content flex max-w-6xl flex-col gap-6">
        {/* The shared app header, not a fourth hand-built one. text-3xl (30px)
            was not a rung on the Juno scale, and the three admin pages were the
            only app pages with no back affordance at all. */}
        <AppPageHeader
          className="mb-0"
          eyebrow="Owner"
          heading="Users"
          icon={UsersIcon}
          lede={
            data
              ? `${data.totals.users} ${data.totals.users === 1 ? "account" : "accounts"} · ${data.totals.activeThisMonth} active this month`
              : "Accounts, plans, and monthly usage."
          }
          actions={<AdminNav current="users" reviewCount={data?.totals.flaggedCount ?? 0} />}
        />

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or email"
                aria-label="Search users"
                className="pl-9"
              />
            </div>
            {data && (
              <p className="font-mono text-caption tabular-nums text-muted-foreground">
                {total} {total === 1 ? "match" : "matches"}
              </p>
            )}
          </div>

          {loading ? (
            // aria-hidden + a staggered reveal: eight identical bars appearing at
            // once read as a rendering glitch rather than as loading.
            <div className="flex flex-col gap-2 p-4" aria-hidden>
              {[...Array(8)].map((_, i) => (
                <div key={i} className="skeleton h-12 rounded-field" style={staggerDelay(i)} />
              ))}
            </div>
          ) : failed ? (
            <EmptyState
              tone="error"
              size="panel"
              icon={UsersIcon}
              className="m-4"
              title="Couldn't load users"
              description="The request didn't come back. Nothing is shown rather than a guess at what's there."
              action={
                <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                  Try again
                </Button>
              }
            />
          ) : users.length === 0 ? (
            // The shared primitive, and a way out of a dead search. This was a
            // detached top rule floating inside a card that already draws a
            // border above it, with no icon and no action.
            <EmptyState
              tone="empty"
              size="panel"
              icon={UsersIcon}
              title={q ? "No matching users" : "No users yet"}
              description={
                q
                  ? `Nothing matches “${q}”. Try a different name or email.`
                  : "Accounts appear here as soon as someone signs up."
              }
              action={
                q ? (
                  <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left">
                    <th className={TH_CLASS}>User</th>
                    <th className={TH_CLASS}>Signed up</th>
                    <th className={TH_CLASS}>Plan</th>
                    <th className={`${TH_CLASS} text-right`}>Messages</th>
                    <th className={`${TH_CLASS} text-right`}>Spend (mo)</th>
                    <th className={`${TH_CLASS} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === selfId;
                    const isOwner = u.plan === "OWNER";
                    const locked = isSelf || isOwner;
                    return (
                      <tr
                        key={u.id}
                        // `hover:bg-accent` at full strength. At /40 the fill
                        // composited to ~9.1% over the 6.5% card — a 2.6-point
                        // step on a row you are pointing at across an 800px
                        // table, where the hover is the only thing tying a name
                        // on the left to the actions on the right.
                        className="border-b border-border/60 transition-colors duration-fast ease-out-soft last:border-b-0 hover:bg-accent"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            {/* Both branches wear `rounded-field`. The photo was
                                `rounded-lg` (16px on a 32px box) while the
                                identicon draws its own rx=6 on a 20 viewBox
                                (~9.6px), so one column rendered two different
                                silhouettes depending on whether a photo existed. */}
                            {u.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={u.image} alt="" className="h-8 w-8 shrink-0 rounded-field object-cover" />
                            ) : (
                              <DotIdenticon seed={u.id} className="h-8 w-8 shrink-0 overflow-hidden rounded-field" />
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate font-medium">{u.name || "—"}</p>
                                {u.bannedAt && (
                                  <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 font-mono text-caption font-semibold text-destructive">
                                    Banned
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                              {u.strikes > 0 && !u.bannedAt && (
                                <p className="mt-0.5 font-mono text-caption tabular-nums text-warning">
                                  {u.strikes}/{STRIKE_LIMIT} strikes
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          {formatDate(u.createdAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          <Select
                            value={u.plan}
                            onValueChange={(value) => changePlan(u, value as Plan)}
                            disabled={isSelf}
                          >
                            <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Plan for ${u.email}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PLAN_OPTIONS.map((p) => (
                                <SelectItem key={p} value={p}>
                                  {PLANS[p].name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {u.subscriptionStatus && u.subscriptionStatus !== "ACTIVE" && (
                            <p className="mt-1 font-mono text-caption text-muted-foreground">
                              {u.subscriptionStatus.toLowerCase().replace(/_/g, " ")}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{u.messagesThisMonth}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                          {formatSpend(u.monthSpendMicroUsd)}
                          {u.monthSpendAppMicroUsd > 0 && (
                            <p className="mt-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                              web {formatSpend(u.monthSpendWebMicroUsd)} · app {formatSpend(u.monthSpendAppMicroUsd)}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              {/* `size="icon-sm"`, not size="icon" cut down to
                                  h-8 w-8 by hand: the override beat the base
                                  size but not its `coarse:` pair, so the row's
                                  only action control was the one thing on the
                                  page that did not grow to a 40px target on a
                                  touch pointer. icon-sm IS 8/coarse-10. */}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={locked}
                                aria-label={`Actions for ${u.email}`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {u.bannedAt ? (
                                <DropdownMenuItem onSelect={() => unban(u)}>
                                  <RotateCcw className="h-4 w-4" />
                                  Unban
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                                  onSelect={() => {
                                    setBanReason("");
                                    setBanTarget(u);
                                  }}
                                >
                                  <Ban className="h-4 w-4" />
                                  Ban…
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                                onSelect={() => {
                                  setDeleteConfirm("");
                                  setDeleteTarget(u);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
            <DialogTitle>Ban {banTarget?.email}?</DialogTitle>
            <DialogDescription>
              This blocks sign-in and kills active sessions. The reason is recorded to the moderation log.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ban-reason">Reason</Label>
            <Textarea
              id="ban-reason"
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

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && !deleting && (setDeleteTarget(null), setDeleteConfirm(""))}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.email}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the account and all of its data. This cannot be undone. Type the user&rsquo;s
              email to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm">Confirm email</Label>
            <Input
              id="delete-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteTarget?.email}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => (setDeleteTarget(null), setDeleteConfirm(""))} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting || deleteConfirm.trim().toLowerCase() !== deleteTarget?.email.toLowerCase()}
              className="gap-1.5"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? "Deleting…" : "Delete user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
