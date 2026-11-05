"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import type { CloudRepo } from "@/components/code/code-target-picker";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/*
 * PROJECT HOOKS, FOR CLOUD RUNS (`/code/customize`).
 *
 * A repository's `.alevr/hooks.json` runs commands around a run's tools. On a
 * Mac a person is asked the first time a version of the file appears. A cloud
 * run has nobody to ask, so it refuses any version its owner has not reviewed
 * here. Review reads the file from GitHub, shows each command, and approves
 * those exact bytes (their SHA-256): editing the file asks again.
 *
 * The file itself is edited in the repository, like any other file a run
 * reads; this page never writes to a repository.
 */

interface HookRow {
  event: "PreToolUse" | "PostToolUse" | "Stop";
  command: string;
  matcher: string[] | null;
  timeoutMs: number;
}

interface Approval {
  id: string;
  repo: string;
  hash: string;
  ref: string | null;
  createdAt: string;
  hooks: HookRow[];
}

type ReviewFile =
  | { present: false }
  | { present: true; hash: string | null; valid: boolean; message?: string; hooks: HookRow[]; approved: boolean };

type Review =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; repo: string; ref: string | null; file: ReviewFile }
  | { state: "error"; message: string };

const EVENT_LABEL: Record<HookRow["event"], string> = {
  PreToolUse: "Before a tool",
  PostToolUse: "After a tool",
  Stop: "When the run finishes",
};

const ERROR_SENTENCE: Record<string, string> = {
  invalid_repo: "Enter a repository as owner/name.",
  invalid_ref: "That branch name is not valid.",
  github_not_connected: "GitHub isn’t connected. Connect it in Connections to review a repository’s hooks.",
  github_unauthorized: "Your GitHub connection has expired. Reconnect it in Connections.",
  repo_not_found: "GitHub has no repository by that name that this account can read.",
  github_unreachable: "GitHub couldn’t be reached. Nothing was changed.",
  hooks_missing: "The repository no longer has .alevr/hooks.json.",
  hooks_invalid: "The file is not a valid hooks configuration.",
  hooks_changed: "The file changed on GitHub since you opened it. Review it again.",
};

const sentenceFor = (code: string | undefined) => ERROR_SENTENCE[code ?? ""] ?? "Something went wrong. Nothing was changed.";

function HookList({ hooks }: { hooks: HookRow[] }) {
  return (
    <ul className="space-y-2">
      {hooks.map((hook, i) => (
        <li key={`${hook.event}-${i}`} className="min-w-0">
          <p className="text-label text-muted-foreground">
            {EVENT_LABEL[hook.event]}
            {hook.matcher ? ` · ${hook.matcher.join(", ")}` : hook.event === "Stop" ? "" : " · every tool"}
            {` · up to ${Math.round(hook.timeoutMs / 1000)} s`}
          </p>
          <code className="mt-0.5 block overflow-x-auto whitespace-pre rounded-xs bg-muted px-2 py-1 font-mono text-caption text-foreground">
            {hook.command}
          </code>
        </li>
      ))}
    </ul>
  );
}

export function CodeProjectHooks({ repos }: { repos: CloudRepo[] }) {
  const [approvals, setApprovals] = React.useState<Approval[] | null>(null);
  const [listError, setListError] = React.useState(false);
  const [repo, setRepo] = React.useState("");
  const [ref, setRef] = React.useState("");
  const [review, setReview] = React.useState<Review>({ state: "idle" });
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const loadApprovals = React.useCallback(async () => {
    setListError(false);
    try {
      const res = await fetch("/api/code/hooks", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { approvals?: Approval[] };
      setApprovals(Array.isArray(data.approvals) ? data.approvals : []);
    } catch {
      setListError(true);
    }
  }, []);

  React.useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  const openReview = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setActionError(null);
    const target = repo.trim();
    if (!target) return;
    setReview({ state: "loading" });
    try {
      const params = new URLSearchParams({ repo: target, ...(ref.trim() ? { ref: ref.trim() } : {}) });
      const res = await fetch(`/api/code/hooks?${params}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; repo?: string; ref?: string | null; file?: ReviewFile };
      if (!res.ok || !data.file) {
        setReview({ state: "error", message: sentenceFor(data.error) });
        return;
      }
      setReview({ state: "ready", repo: data.repo ?? target, ref: data.ref ?? null, file: data.file });
    } catch {
      setReview({ state: "error", message: sentenceFor("github_unreachable") });
    }
  };

  const approve = async () => {
    if (review.state !== "ready" || !review.file.present || !review.file.hash) return;
    setBusy("approve");
    setActionError(null);
    try {
      const res = await fetch("/api/code/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: review.repo, ref: review.ref, hash: review.file.hash }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        setActionError(sentenceFor(code));
        return;
      }
      setReview({ ...review, file: { ...review.file, approved: true } });
      await loadApprovals();
    } catch {
      setActionError(sentenceFor("github_unreachable"));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const revoke = async (approval: Approval) => {
    setBusy(approval.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/code/hooks?id=${encodeURIComponent(approval.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error();
      setApprovals((list) => list?.filter((a) => a.id !== approval.id) ?? null);
      if (review.state === "ready" && review.file.present && review.file.hash === approval.hash) {
        setReview({ ...review, file: { ...review.file, approved: false } });
      }
    } catch {
      setActionError("The approval couldn’t be removed. It still applies.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsGroup
      title="Project hooks"
      description="Commands a repository’s .alevr/hooks.json runs before a tool, after it, or when a run finishes. Your Mac asks you the first time it sees a version of the file. A cloud run has nobody to ask, so it runs only a version you approved here. Editing the file asks again."
    >
      <form onSubmit={(e) => void openReview(e)} className="flex flex-wrap items-end gap-2 py-3.5">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span className="text-label text-muted-foreground">Repository</span>
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            list="code-hooks-repos"
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="code-hooks-repos">
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName} />
            ))}
          </datalist>
        </label>
        <label className="flex w-40 min-w-0 flex-col gap-1">
          <span className="text-label text-muted-foreground">Branch (optional)</span>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="default" autoComplete="off" spellCheck={false} />
        </label>
        <Button type="submit" variant="outline" disabled={!repo.trim() || review.state === "loading"} loading={review.state === "loading"}>
          Review hooks
        </Button>
      </form>

      {review.state === "error" && (
        <p role="alert" className="flex items-start gap-2 py-3.5 text-ui text-destructive">
          <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {review.message}
        </p>
      )}

      {review.state === "ready" && (
        <div className="space-y-3 py-3.5 motion-safe:animate-fade-in" aria-live="polite">
          {!review.file.present ? (
            <p className="text-ui text-muted-foreground">
              {review.repo} has no .alevr/hooks.json{review.ref ? ` on ${review.ref}` : ""}, so its runs have no hooks to approve.
            </p>
          ) : !review.file.valid ? (
            <p className="flex items-start gap-2 text-ui text-destructive">
              <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {review.file.message ?? "The file is not a valid hooks configuration."} Runs refuse it until it is fixed in the repository.
              </span>
            </p>
          ) : (
            <>
              <HookList hooks={review.file.hooks} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 text-caption text-muted-foreground">
                  SHA-256 <span className="break-all font-mono">{review.file.hash}</span>
                </p>
                {review.file.approved ? (
                  <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
                    <StatusIcons.success className="size-4" aria-hidden="true" /> Approved for cloud runs
                  </span>
                ) : (
                  <Button onClick={() => setConfirming(true)} disabled={review.file.hooks.length === 0}>
                    Approve for cloud runs
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {actionError && (
        <p role="alert" className="flex items-start gap-2 py-3.5 text-ui text-destructive">
          <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {listError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
          <p className="flex items-start gap-2 text-ui text-destructive">
            <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            The approved hooks couldn’t be loaded, so this list is empty rather than wrong.
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadApprovals()} className="gap-1.5">
            <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : approvals === null ? null : approvals.length === 0 ? (
        <p className="py-3.5 text-ui text-muted-foreground">No hooks are approved yet, so cloud runs refuse any project hooks they find.</p>
      ) : (
        approvals.map((approval) => (
          <SettingRow
            key={approval.id}
            label={<span className="truncate">{approval.repo}</span>}
            description={
              <span className={cn("flex flex-wrap gap-x-2 gap-y-0.5")}>
                <span>
                  {approval.hooks.length} {approval.hooks.length === 1 ? "command" : "commands"}
                </span>
                <span className="font-mono">{approval.hash.slice(0, 12)}</span>
                <span>approved {timeAgo(approval.createdAt)}</span>
              </span>
            }
            control={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void revoke(approval)}
                loading={busy === approval.id}
                disabled={busy !== null}
                aria-label={`Remove the approval for ${approval.repo} (${approval.hash.slice(0, 12)})`}
              >
                Remove
              </Button>
            }
          />
        ))
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        title="Approve these hooks for cloud runs?"
        description={
          review.state === "ready"
            ? `Cloud runs of ${review.repo} will run these commands without asking, inside the run’s sandbox and under its permission rules. Approval covers only this exact file; any edit asks again.`
            : undefined
        }
        confirmLabel="Approve"
        busy={busy === "approve"}
        onConfirm={() => void approve()}
      />
    </SettingsGroup>
  );
}
