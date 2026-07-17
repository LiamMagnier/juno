"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Cloud, Folder, Laptop, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CloudCodePanel, type CloudRepo, type CloudStartError } from "@/components/code/cloud-code-panel";
import { useApp } from "@/components/app/app-provider";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import type { ClientConversation } from "@/types/chat";

type Workspace = { id: string; name: string; path: string; key?: string | null; lastOpenedAt: string };

type Target = "device" | "cloud";
const TARGET_KEY = "juno:code:new:target";

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { upsertConversation } = useApp();

  const [target, setTarget] = React.useState<Target>("device");
  // Restore the last-used target after mount (SSR renders the "device" default).
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, []);
  const switchTarget = React.useCallback((next: Target) => {
    setTarget(next);
    try {
      localStorage.setItem(TARGET_KEY, next);
    } catch {}
  }, []);

  // ---- Device target (unchanged workspace picker) ----
  const [workspaces, setWorkspaces] = React.useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [creatingPath, setCreatingPath] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/code/workspaces");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
    } catch {
      setLoadError(true);
      setWorkspaces((cur) => cur ?? []);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const startDevice = async (w: Workspace) => {
    if (creatingPath) return;
    setCreatingPath(w.path);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "code",
          codeWorkspaceName: w.name,
          codeWorkspacePath: w.path,
          // Stable identity when the mirror has one — sessions then follow the
          // workspace even if the folder moves on disk.
          codeWorkspaceKey: w.key ?? undefined,
        }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { conversation: ClientConversation };
      upsertConversation(data.conversation);
      router.push(`/chat/${data.conversation.id}`);
    } catch {
      toast.error("Could not start the session. Check your connection and try again.");
      setCreatingPath(null);
    }
  };

  // ---- Cloud target (GitHub repo → dispatched runner) ----
  const [cloudSubmitting, setCloudSubmitting] = React.useState(false);
  const [cloudStartError, setCloudStartError] = React.useState<CloudStartError>(null);
  // Reuse one conversation across retries so a transient dispatch failure
  // doesn't leak an empty session on every attempt.
  const cloudConversationId = React.useRef<string | null>(null);

  const startCloud = async ({ repo, baseRef, prompt }: { repo: CloudRepo; baseRef: string | null; prompt: string }) => {
    if (cloudSubmitting) return;
    setCloudSubmitting(true);
    setCloudStartError(null);
    try {
      // 1) Ensure a kind:"code" session to stream the run into. The repo is the
      //    cloud "workspace": name for display, owner/name as the path, matching
      //    what the task row records so the sidebar groups it consistently.
      let conversation: ClientConversation | null = null;
      if (!cloudConversationId.current) {
        const cRes = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "code",
            codeWorkspaceName: repo.name,
            codeWorkspacePath: `${repo.owner}/${repo.name}`,
          }),
        });
        if (!cRes.ok) throw new Error("conversation");
        conversation = ((await cRes.json()) as { conversation: ClientConversation }).conversation;
        cloudConversationId.current = conversation.id;
      }
      const conversationId = cloudConversationId.current;

      // 2) Dispatch the cloud task against the selected repo.
      const tRes = await fetch("/api/code/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "cloud",
          repo: { owner: repo.owner, name: repo.name },
          baseRef: baseRef ?? undefined,
          prompt,
          title: prompt.slice(0, 60),
          conversationId,
        }),
      });

      if (tRes.ok) {
        // Route into the session; the code view fetches the task and streams it.
        if (conversation) {
          upsertConversation({ ...conversation, title: prompt.slice(0, 48), titleSource: "manual" });
        }
        router.push(`/chat/${conversationId}`);
        return;
      }

      const err = ((await tRes.json().catch(() => ({}))) as { error?: string }).error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        setCloudStartError("not_configured");
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        setCloudStartError("dispatch_failed");
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
      } else {
        toast.error("Could not start the cloud run. Check your connection and try again.");
      }
    } catch {
      toast.error("Could not start the cloud run. Check your connection and try again.");
    } finally {
      setCloudSubmitting(false);
    }
  };

  const loading = workspaces === null;
  const empty = !loading && !loadError && (workspaces?.length ?? 0) === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-1 flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
            <Link href="/chat">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Code</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">New session</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          {target === "cloud"
            ? "Pick a GitHub repository — the run happens in the cloud and opens a pull request."
            : "Pick a project to start a Juno Code session in. Projects sync here from the Juno app."}
        </p>

        {/* Where the session runs. Device = the Juno app on your Mac; Cloud = a
            fresh GitHub Actions machine that opens a pull request. */}
        <div className="mb-6 max-w-xs">
          <SegmentedControl
            value={target}
            onChange={switchTarget}
            ariaLabel="Where the session runs"
            optionClassName="gap-2 py-1.5 text-[13px]"
            options={[
              { value: "device", label: "Device", icon: <Laptop className="h-3.5 w-3.5" aria-hidden="true" /> },
              { value: "cloud", label: "Cloud", icon: <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> },
            ]}
          />
        </div>

        {target === "cloud" ? (
          <CloudCodePanel
            submitting={cloudSubmitting}
            startError={cloudStartError}
            onStart={startCloud}
            onClearStartError={() => setCloudStartError(null)}
          />
        ) : loadError ? (
          <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your projects. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[68px] w-full rounded-lg" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <Folder className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <div className="max-w-sm">
              <p className="font-serif text-heading">No projects synced yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Open a project folder in the Juno app and it appears here, ready for a new session.
              </p>
            </div>
          </div>
        ) : (
          // No list semantics: an explicit role REPLACES the implicit one, so
          // role="list"/"listitem" here stripped these of being buttons. A
          // stack of buttons needs no list wrapper to be understood.
          <div className="space-y-2">
            {(workspaces ?? []).map((w) => (
              <button
                key={w.key ?? w.path}
                type="button"
                onClick={() => startDevice(w)}
                disabled={creatingPath !== null}
                className="group flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-3 text-left shadow-soft transition-all duration-fast ease-out-soft hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995] disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-transform duration-fast group-hover:scale-105">
                  {creatingPath === w.path ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Folder className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{w.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{w.path}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {creatingPath === w.path ? "Starting…" : `Opened ${timeAgo(w.lastOpenedAt)}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
