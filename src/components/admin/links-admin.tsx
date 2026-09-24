"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Link2,
  Link2Off,
  Loader2,
  Search,
  type IconComponent,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import type { AdminShareReport, AdminShareRow } from "@/lib/share-moderation";
import { SHARE_REPORT_REASONS, type ShareStatus } from "@/lib/share-policy";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * /admin/links — public share links, and what visitors report about them.
 *
 * Two cards, because an admin arrives here with one of two things in hand:
 *
 *   - A link (or an account). Someone forwarded a URL, or a moderation flag
 *     names an account. "Look up a link" finds it by share URL or token, or
 *     lists everything an account has shared, and offers Take down / Restore.
 *   - Nothing yet. The report queue is what visitors sent from the Report link
 *     at the foot of every public page (src/components/share/report-share-dialog.tsx).
 *     Nothing there has been acted on — a report never removes a page by itself
 *     (src/lib/share-moderation.ts) — so each open one ends in a takedown or a
 *     dismissal, and both are made here.
 *
 * Every action refreshes both cards: a takedown resolves the link's open
 * reports and changes its row in the lookup, a ban changes every link the
 * owner has, and a dismissal changes a lookup row's report count. The server's
 * answer is patched in first so the row changes under the pointer, then both
 * lists reload quietly — the tables stay on screen while they do, and a
 * refresh that fails says so instead of keeping the stale rows.
 */

type ReportsResponse = {
  reports: AdminShareReport[];
  total: number;
  page: number;
  pageSize: number;
};

type ReportFilter = "open" | "all";

const REPORT_FILTERS: { id: ReportFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
];

// The bounds shareTakedownSchema enforces (src/lib/share-schemas.ts), so the
// button can say "not yet" before the server has to.
const TAKEDOWN_REASON_MIN = 3;
const TAKEDOWN_REASON_MAX = 500;

// A report whose detail runs past this folds to three lines behind Show more.
const LONG_DETAIL = 180;

const REASON_LABELS = new Map<string, string>(SHARE_REPORT_REASONS.map((r) => [r.id, r.label]));

/** The visitor-facing sentence for a stored reason id; an unknown id shows as itself. */
function reasonLabel(id: string): string {
  return REASON_LABELS.get(id) ?? id;
}

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
  return formatDate(iso);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function kindLabel(kind: AdminShareRow["kind"]): string {
  return kind === "CHAT" ? "Chat" : "Artifact";
}

const CHIP = "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-caption font-semibold";
const TH_CLASS = "px-4 py-2.5 font-mono text-caption font-medium text-muted-foreground";
const ROW_CLASS =
  "border-b border-border/60 align-top transition-colors duration-fast ease-out-soft last:border-b-0 hover:bg-accent motion-safe:animate-fade-in [animation-fill-mode:backwards]";

/*
 * One word per standing, each with its own mark so the four are not told apart
 * by colour alone (SC 1.4.1). The two dead links share the broken-link glyph
 * and differ in who pulled them: grey for the owner's own revoke, destructive
 * for Juno's takedown. A banned owner's link is on the warning ramp because it
 * is suspended, not gone — lifting the ban brings it back.
 */
const STATUS_CHIP: Record<ShareStatus, { label: string; tone: string; icon: IconComponent }> = {
  live: { label: "Live", tone: "bg-success/10 text-success", icon: Link2 },
  revoked: { label: "Revoked", tone: "bg-muted text-muted-foreground", icon: Link2Off },
  "taken-down": { label: "Taken down", tone: "bg-destructive/10 text-destructive", icon: Link2Off },
  "owner-banned": { label: "Owner banned", tone: "bg-warning/10 text-warning", icon: Ban },
};

function StatusChip({ status }: { status: ShareStatus }) {
  const { label, tone, icon: Icon } = STATUS_CHIP[status];
  return (
    <span className={cn(CHIP, tone)}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Opens the public page in a new tab. Only for a live link: every other
 * standing 404s there, which is the point of it, and a button that leads to a
 * 404 is a button that looks broken.
 */
function OpenLinkButton({ share }: { share: AdminShareRow }) {
  if (share.status !== "live") return null;
  const label = `Open “${share.title || "Untitled"}” in a new tab`;
  return (
    <Button asChild variant="ghost" size="icon-sm" aria-label={label} title="Open in a new tab">
      <a href={share.url} target="_blank" rel="noreferrer noopener">
        <ActionIcons.external className="size-4" />
      </a>
    </Button>
  );
}

export function LinksAdmin() {
  // ——— Look up a link ———
  // `query` is the field; `q` is what was last submitted. Lookups are exact
  // (a token, an email, an id), so they run on submit rather than per
  // keystroke — a half-typed email would only ever answer "no links".
  const [query, setQuery] = React.useState("");
  const [q, setQ] = React.useState("");
  const [lookup, setLookup] = React.useState<{ q: string; shares: AdminShareRow[] } | null>(null);
  // The query whose lookup failed, rather than a bare flag: a flag set by the
  // last search would still be true for the one render between submitting a
  // new query and its effect clearing it, and the error would flash.
  const [lookupFailedFor, setLookupFailedFor] = React.useState<string | null>(null);
  const [lookupReload, setLookupReload] = React.useState(0);

  React.useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    setLookupFailedFor(null);
    fetch(`/api/admin/shares?${new URLSearchParams({ q })}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn’t look that up.");
        setLookup({ q, shares: (body as { shares: AdminShareRow[] }).shares });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        toast.error(err instanceof Error ? err.message : "Couldn’t look that up.");
        setLookupFailedFor(q);
      });
    return () => controller.abort();
  }, [q, lookupReload]);

  // Results are keyed by the query that produced them, so a new search shows
  // the skeleton while a refresh of the same one keeps its rows on screen.
  const lookupCurrent = !!q && lookup?.q === q;
  const lookupFailed = !!q && lookupFailedFor === q;
  const lookupLoading = !!q && !lookupFailed && !lookupCurrent;
  const shares = lookupCurrent ? lookup.shares : [];

  const submitLookup = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setQ(query.trim());
    // The same query again is a refresh, not a no-op: the link may have
    // changed since it was last looked at.
    setLookupReload((k) => k + 1);
  };

  const clearLookup = () => {
    setQuery("");
    setQ("");
  };

  // ——— Reports ———
  const [filter, setFilter] = React.useState<ReportFilter>("open");
  const [page, setPage] = React.useState(1);
  const [reports, setReports] = React.useState<{ key: string; data: ReportsResponse } | null>(null);
  // A failed load must not fall through to "No open reports" — the most
  // reassuring sentence on the page, shown when the truth is that nobody knows.
  // Keyed like the data, so switching filter after a failure shows the
  // skeleton at once instead of a frame of the old error.
  const [reportsFailedFor, setReportsFailedFor] = React.useState<string | null>(null);
  const [reportsReload, setReportsReload] = React.useState(0);
  // For the nav badge. Known whenever the Open view has loaded; kept across a
  // switch to All, and stepped down locally as reports are resolved.
  const [openCount, setOpenCount] = React.useState(0);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const reportsKey = `${filter}:${page}`;

  React.useEffect(() => {
    const controller = new AbortController();
    const key = `${filter}:${page}`;
    setReportsFailedFor(null);
    const params = new URLSearchParams({ status: filter, page: String(page) });
    fetch(`/api/admin/shares/reports?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn’t load reports.");
        const data = body as ReportsResponse;
        setReports({ key, data });
        if (filter === "open") setOpenCount(data.total);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        toast.error(err instanceof Error ? err.message : "Couldn’t load reports.");
        setReportsFailedFor(key);
      });
    return () => controller.abort();
  }, [filter, page, reportsReload]);

  const reportsCurrent = reports?.key === reportsKey;
  const reportsFailed = reportsFailedFor === reportsKey;
  const reportsLoading = !reportsFailed && !reportsCurrent;
  const reportRows = reportsCurrent ? reports.data.reports : [];
  const total = reportsCurrent ? reports.data.total : 0;
  const pageCount = Math.max(1, Math.ceil(total / (reports?.data.pageSize ?? 25)));

  // Resolving the last open report on the last page leaves that page empty;
  // step back to the page that still has rows rather than showing "No open
  // reports" while earlier pages are full.
  React.useEffect(() => {
    if (reportsCurrent && page > pageCount) setPage(pageCount);
  }, [reportsCurrent, page, pageCount]);

  // ——— Actions ———
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const setBusyFor = (id: string, on: boolean) =>
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // Bumping both keys also aborts any load still in flight from before the
  // action, so a slow stale response cannot land on top of the patch below.
  const refreshAll = () => {
    setLookupReload((k) => k + 1);
    setReportsReload((k) => k + 1);
  };

  /** Puts the server's new row for a link everywhere it is shown. */
  const patchShare = (row: AdminShareRow, { resolveOpenReports = false } = {}) => {
    const now = new Date().toISOString();
    setLookup((l) => l && { ...l, shares: l.shares.map((s) => (s.id === row.id ? row : s)) });
    setReports(
      (r) =>
        r && {
          ...r,
          data: {
            ...r.data,
            reports: r.data.reports.map((rep) =>
              rep.share?.id !== row.id
                ? rep
                : {
                    ...rep,
                    share: row,
                    ...(resolveOpenReports && rep.status === "open" ? { status: "actioned", resolvedAt: now } : {}),
                  }
            ),
          },
        }
    );
  };

  const patchReport = (id: string, next: Partial<AdminShareReport>) => {
    setReports(
      (r) => r && { ...r, data: { ...r.data, reports: r.data.reports.map((rep) => (rep.id === id ? { ...rep, ...next } : rep)) } }
    );
  };

  // Open is its own flag so the target outlives the close: nulling the target
  // on close turned the title into “Untitled” and dropped the owner's email
  // for the length of the dialog's exit animation.
  const [takedownOpen, setTakedownOpen] = React.useState(false);
  const [takedownTarget, setTakedownTarget] = React.useState<AdminShareRow | null>(null);
  const [takedownReason, setTakedownReason] = React.useState("");
  const [banOwner, setBanOwner] = React.useState(false);
  const [takingDown, setTakingDown] = React.useState(false);

  // Opens empty every time — the reason is the admin's sentence to the owner,
  // not the visitor's report pasted forward.
  const openTakedown = (share: AdminShareRow) => {
    setTakedownReason("");
    setBanOwner(false);
    setTakedownTarget(share);
    setTakedownOpen(true);
  };

  const closeTakedown = () => setTakedownOpen(false);

  const confirmTakedown = () => {
    if (!takedownTarget) return;
    const reason = takedownReason.trim();
    if (reason.length < TAKEDOWN_REASON_MIN) {
      toast.error("Give a reason of at least 3 characters.");
      return;
    }
    const target = takedownTarget;
    const ban = banOwner && !target.owner.bannedAt;
    setTakingDown(true);
    fetch(`/api/admin/shares/${target.id}/takedown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, banOwner: ban }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn’t take the link down.");
        patchShare((body as { share: AdminShareRow }).share, { resolveOpenReports: true });
        setOpenCount((c) => Math.max(0, c - target.openReports));
        toast.success(
          ban ? `Link taken down and ${target.owner.email} banned.` : "Link taken down. The owner has been told why."
        );
        closeTakedown();
        refreshAll();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Couldn’t take the link down.");
      })
      .finally(() => setTakingDown(false));
  };

  const restore = (share: AdminShareRow) => {
    const key = `share:${share.id}`;
    setBusyFor(key, true);
    fetch(`/api/admin/shares/${share.id}/restore`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn’t restore the link.");
        const row = (body as { share: AdminShareRow }).share;
        patchShare(row);
        // Lifting a takedown does not always bring the page back, and the
        // toast says which case this was rather than promising a live link.
        toast.success(
          row.status === "live"
            ? "Link restored. It opens again."
            : row.status === "owner-banned"
              ? "Takedown lifted. The link stays offline while its owner is banned."
              : "Takedown lifted. The owner had revoked this link, so it stays offline."
        );
        refreshAll();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Couldn’t restore the link.");
      })
      .finally(() => setBusyFor(key, false));
  };

  const dismiss = (report: AdminShareReport) => {
    const key = `report:${report.id}`;
    setBusyFor(key, true);
    fetch(`/api/admin/shares/reports/${report.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn’t dismiss the report.");
        // No toast: the row answers for itself — it leaves the Open view, and
        // turns to "Dismissed" in All.
        patchReport(report.id, { status: "dismissed", resolvedAt: new Date().toISOString() });
        if (report.status === "open") setOpenCount((c) => Math.max(0, c - 1));
        refreshAll();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Couldn’t dismiss the report.");
      })
      .finally(() => setBusyFor(key, false));
  };

  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <AppPage measure="wide" contentClassName="flex flex-col gap-6">
      <AppPageHeader
        className="mb-0"
        eyebrow="Owner"
        heading="Links"
        lede="Public share links, and what visitors report about them."
        actions={<AdminNav current="links" reportCount={openCount} />}
      />

      {/* ——— Look up a link ——— */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h2 className="text-ui font-semibold">Look up a link</h2>
            <p className="text-caption text-muted-foreground">
              A share URL or token finds that link. An account’s email or id lists every link it has shared.
            </p>
          </div>
          <form
            role="search"
            aria-label="Look up links"
            onSubmit={submitLookup}
            className="flex w-full items-center gap-2 md:max-w-md"
          >
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Share URL, token, account email or id"
                aria-label="Share URL, token, account email or id"
                className="pl-9"
                // The route refuses anything longer.
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit" variant="outline" className="shrink-0">
              Look up
            </Button>
          </form>
        </div>

        {!q ? (
          <EmptyState
            tone="empty"
            size="panel"
            icon={Link2}
            className="m-4"
            title="Nothing looked up yet"
            description="Paste a link someone forwarded, or the email of an account a flag names."
          />
        ) : lookupLoading ? (
          <div className="flex flex-col gap-2 p-4" aria-hidden>
            {[...Array(3)].map((_, i) => (
              <div key={i} className="skeleton h-14 rounded-field" style={staggerDelay(i)} />
            ))}
          </div>
        ) : lookupFailed ? (
          <EmptyState
            tone="error"
            size="panel"
            icon={StatusIcons.error}
            className="m-4"
            title="Couldn’t look that up"
            description="The lookup didn’t come back, so nothing is shown — an empty table here would read as “no such link”."
            action={
              <Button variant="outline" size="sm" onClick={() => setLookupReload((k) => k + 1)}>
                Try again
              </Button>
            }
          />
        ) : shares.length === 0 ? (
          <EmptyState
            tone="empty"
            size="panel"
            icon={Link2Off}
            className="m-4"
            title="No links found"
            description={`Nothing matches “${q}”. Tokens, emails and account ids have to match exactly.`}
            action={
              <Button variant="outline" size="sm" onClick={clearLookup}>
                Clear
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-ui">
              <thead>
                <tr className="border-b border-border/70 text-left">
                  <th className={TH_CLASS}>Link</th>
                  <th className={TH_CLASS}>Owner</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={`${TH_CLASS} text-right`}>Views</th>
                  <th className={TH_CLASS}>Created</th>
                  <th className={`${TH_CLASS} text-right`}>Reports</th>
                  <th className={`${TH_CLASS} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shares.map((s, i) => {
                  const restoring = busy.has(`share:${s.id}`);
                  return (
                    // Dealt in on the tight rung, by opacity alone, as the
                    // users and moderation tables are.
                    <tr key={s.id} style={staggerDelay(i, "tight")} className={ROW_CLASS}>
                      <td className="px-4 py-3">
                        {/* A block with a max width, not a max-width cell: table
                            cells ignore max-width, so truncation needs a box. */}
                        {/* Kind rides under the title and the token is cut to a
                            recognisable prefix (the whole of it is the title
                            attribute): as their own columns, the two pushed
                            the Actions column out of the card at desktop width. */}
                        <div className="max-w-44">
                          <p className="line-clamp-2 break-words font-medium">{s.title || "Untitled"}</p>
                          <div className="mt-0.5 flex min-w-0 items-center gap-2">
                            <span className={cn(CHIP, "shrink-0 bg-muted text-muted-foreground")}>{kindLabel(s.kind)}</span>
                            <p className="truncate font-mono text-caption text-muted-foreground" title={s.token}>
                              {s.token}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-44">
                          <p className="truncate" title={s.owner.email}>
                            {s.owner.email}
                          </p>
                          <div className="flex items-center gap-2">
                            {s.owner.name && (
                              <p className="truncate text-caption text-muted-foreground">{s.owner.name}</p>
                            )}
                            {s.owner.bannedAt && (
                              <span className={cn(CHIP, "shrink-0 bg-destructive/10 text-destructive")}>
                                <Ban className="size-3" aria-hidden="true" />
                                Banned
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip status={s.status} />
                        {s.status === "taken-down" && (
                          // The statement of reasons the owner was sent, and who
                          // sent it — the thing to read before a Restore.
                          <div className="mt-1.5 max-w-72 text-caption text-muted-foreground">
                            {s.takedownReason && (
                              <p className="line-clamp-3 break-words text-foreground/85">{s.takedownReason}</p>
                            )}
                            <p className="mt-0.5 font-mono">
                              {s.takenDownBy ?? "Unknown"}
                              {s.takenDownAt && ` · ${formatDate(s.takenDownAt)}`}
                            </p>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-micro tabular-nums">{s.views}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-micro text-muted-foreground">
                        {formatDate(s.createdAt)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right font-mono text-micro tabular-nums",
                          s.openReports > 0 ? "text-warning" : "text-muted-foreground"
                        )}
                      >
                        {s.openReports}
                        <span className="sr-only"> open {s.openReports === 1 ? "report" : "reports"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <OpenLinkButton share={s} />
                          {s.status === "taken-down" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => restore(s)}
                              disabled={restoring}
                              aria-busy={restoring}
                            >
                              {restoring ? (
                                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                              ) : (
                                <ActionIcons.restore className="size-4" />
                              )}
                              Restore
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive danger-hover"
                              onClick={() => openTakedown(s)}
                            >
                              <Link2Off className="size-4" />
                              Take down
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ——— Reports ——— */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-ui font-semibold">Reports</h2>
            <SegmentedControl<ReportFilter>
              value={filter}
              onChange={(next) => {
                setFilter(next);
                setPage(1);
              }}
              ariaLabel="Filter reports"
              className="w-fit"
              options={REPORT_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            />
          </div>
          {reportsCurrent && (
            <p className="font-mono text-caption tabular-nums text-muted-foreground">
              {total} {total === 1 ? "report" : "reports"}
            </p>
          )}
        </div>

        {reportsLoading ? (
          <div className="flex flex-col gap-2 p-4" aria-hidden>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-field" style={staggerDelay(i)} />
            ))}
          </div>
        ) : reportsFailed ? (
          <EmptyState
            tone="error"
            size="panel"
            icon={StatusIcons.error}
            className="m-4"
            title="Couldn’t load the report queue"
            description="The request didn’t come back, so nothing is shown — an empty queue here would read as an all-clear."
            action={
              <Button variant="outline" size="sm" onClick={() => setReportsReload((k) => k + 1)}>
                Try again
              </Button>
            }
          />
        ) : reportRows.length === 0 ? (
          // The shield with a check, as on the moderation page: an empty queue
          // is the good news here.
          <EmptyState
            tone="empty"
            size="panel"
            icon={AppIcons.permissions}
            className="m-4"
            title={filter === "open" ? "No open reports" : "No reports yet"}
            description={
              filter === "open"
                ? "Reports sent from the Report link on public pages wait here until you act on them."
                : "Visitors can report a public page from the link at its foot. Their reports land here."
            }
            action={
              filter === "open" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilter("all");
                    setPage(1);
                  }}
                >
                  Show all reports
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-ui">
              <thead>
                <tr className="border-b border-border/70 text-left">
                  <th className={TH_CLASS}>Report</th>
                  <th className={TH_CLASS}>Detail</th>
                  <th className={TH_CLASS}>Link</th>
                  <th className={`${TH_CLASS} text-right`}>Action</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.map((r, i) => {
                  const isExpanded = expanded.has(r.id);
                  const long = r.detail.length > LONG_DETAIL;
                  const dismissing = busy.has(`report:${r.id}`);
                  const share = r.share;
                  return (
                    <tr key={r.id} style={staggerDelay(i, "tight")} className={ROW_CLASS}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{reasonLabel(r.reason)}</p>
                        <p
                          className="whitespace-nowrap font-mono text-micro text-muted-foreground"
                          title={new Date(r.createdAt).toLocaleString("en-US")}
                        >
                          {relativeTime(r.createdAt)}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-caption text-muted-foreground">
                        <div className="max-w-96">
                          {r.detail ? (
                            <p
                              className={cn(
                                "whitespace-pre-line break-words text-foreground/85",
                                !isExpanded && long && "line-clamp-3"
                              )}
                            >
                              {r.detail}
                            </p>
                          ) : (
                            <p>No details given.</p>
                          )}
                          {long && (
                            // The moderation table's disclosure: the caret
                            // turns with the state, in ink rather than accent.
                            <button
                              type="button"
                              onClick={() => toggleExpanded(r.id)}
                              aria-expanded={isExpanded}
                              className="mt-1 inline-flex items-center gap-1 rounded-sm text-caption font-medium text-foreground/80 underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
                            >
                              {isExpanded ? "Show less" : "Show more"}
                              <ChevronDown
                                className={cn(
                                  "size-3 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                                  isExpanded && "rotate-180"
                                )}
                                aria-hidden="true"
                              />
                            </button>
                          )}
                          <p className="mt-1.5">
                            {r.contact ? (
                              <>
                                Reply to{" "}
                                <a
                                  href={`mailto:${r.contact}`}
                                  className="rounded-xs break-all text-foreground/85 underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground"
                                >
                                  {r.contact}
                                </a>
                              </>
                            ) : (
                              "No reply address"
                            )}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-72">
                          {share ? (
                            <>
                              <p className="line-clamp-2 break-words font-medium">{share.title || "Untitled"}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <StatusChip status={share.status} />
                                <span className={cn(CHIP, "bg-muted text-muted-foreground")}>
                                  {kindLabel(share.kind)}
                                </span>
                              </div>
                              <p className="mt-1 truncate text-caption text-muted-foreground" title={share.owner.email}>
                                {share.owner.email}
                              </p>
                            </>
                          ) : (
                            // The title as it was when the report came in; the
                            // link itself went with its chat or its account.
                            <>
                              <p className="line-clamp-2 break-words text-muted-foreground">
                                {r.shareTitle || "Untitled"}
                              </p>
                              <p className="mt-1 text-caption text-muted-foreground">Link no longer exists</p>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "open" ? (
                          <div className="flex items-center justify-end gap-1.5">
                            {share && <OpenLinkButton share={share} />}
                            {share && share.status !== "taken-down" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive danger-hover"
                                onClick={() => openTakedown(share)}
                              >
                                <Link2Off className="size-4" />
                                Take down link
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => dismiss(r)}
                              disabled={dismissing}
                              aria-busy={dismissing}
                            >
                              {dismissing ? (
                                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                              ) : (
                                <ActionIcons.dismiss className="size-4" />
                              )}
                              Dismiss
                            </Button>
                          </div>
                        ) : (
                          // Resolved: what happened, and who did it. Grey
                          // either way — the decision is made.
                          <div className="flex flex-col items-end gap-1 text-right">
                            <div className="flex items-center gap-1.5">
                              {share && <OpenLinkButton share={share} />}
                              <span className={cn(CHIP, "bg-muted text-muted-foreground")}>
                                {r.status === "actioned" && <Link2Off className="size-3 shrink-0" aria-hidden="true" />}
                                {r.status === "actioned" ? "Link taken down" : r.status === "dismissed" ? "Dismissed" : r.status}
                              </span>
                            </div>
                            {(r.resolvedBy || r.resolvedAt) && (
                              <p className="font-mono text-micro text-muted-foreground">
                                {r.resolvedBy ?? "Unknown"}
                                {r.resolvedAt && ` · ${relativeTime(r.resolvedAt)}`}
                              </p>
                            )}
                          </div>
                        )}
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
              disabled={page <= 1 || reportsLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-4" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={page >= pageCount || reportsLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog open={takedownOpen} onOpenChange={(open) => !open && !takingDown && closeTakedown()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Take down <span className="break-words">“{takedownTarget?.title || "Untitled"}”</span>?
            </DialogTitle>
            <DialogDescription>
              The link stops opening at once, and this item can’t be shared again until you restore it.{" "}
              {takedownTarget?.owner.email} is sent a notification quoting your reason.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="takedown-reason">
              Reason
              {/* The asterisk is decoration for AT — the word is what gets announced. */}
              <span aria-hidden className="text-destructive">
                {" *"}
              </span>
              <span className="sr-only"> (required)</span>
            </Label>
            <Textarea
              id="takedown-reason"
              value={takedownReason}
              onChange={(e) => setTakedownReason(e.target.value)}
              placeholder="Why is this link coming down?"
              className="min-h-24"
              maxLength={TAKEDOWN_REASON_MAX}
              aria-required="true"
              aria-describedby="takedown-reason-hint"
              disabled={takingDown}
            />
            <p id="takedown-reason-hint" className="text-caption text-muted-foreground">
              The owner reads this, so write it for them. 3–500 characters.
            </p>
          </div>
          {takedownTarget && !takedownTarget.owner.bannedAt && (
            <div className="flex items-start gap-3">
              <Checkbox
                id="takedown-ban-owner"
                checked={banOwner}
                onCheckedChange={(on) => setBanOwner(on === true)}
                disabled={takingDown}
                className="mt-0.5"
              />
              <label htmlFor="takedown-ban-owner" className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-ui text-foreground">Also ban the owner</span>
                <span className="block text-caption text-muted-foreground">
                  Blocks sign-in, and every link they’ve shared stops opening until the ban is lifted.
                </span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeTakedown} disabled={takingDown}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmTakedown}
              disabled={takingDown || takedownReason.trim().length < TAKEDOWN_REASON_MIN}
              aria-busy={takingDown}
            >
              {takingDown ? (
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
              ) : banOwner ? (
                <Ban className="size-4" />
              ) : (
                <Link2Off className="size-4" />
              )}
              {takingDown ? "Taking down…" : banOwner ? "Take down and ban" : "Take down link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
