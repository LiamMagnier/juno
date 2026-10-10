"use client";

/**
 * The app shell's column on every Code route (/code, /code/[id], /code/pulls,
 * a Code session at /chat/[id]): the `ThreadSidebar` list of work (sessions
 * that need you, then working, then by recency, the rest settled), with FLIP. The
 * shell keeps its own frame around it (resize, rail, phone drawer), so the
 * workspace renders with `sidebar={false}` and nothing is drawn twice.
 */
import "./code-v2.css";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-provider";
import { useCodeRuns } from "@/components/code/use-code-runs";
import { RUN_STATE_META, isBlockedOnYou, runState } from "@/lib/code-runs";
import { newestPerConversation } from "@/lib/conversation-status";
import {
  shellThreads,
  subscribeThreadStates,
  threadStateFromRun,
  threadStatesSnapshot,
} from "@/lib/code-v2/shell-threads";
import type { ThreadState } from "@/lib/code-v2/thread-sections";
import { ThreadSidebar } from "./sidebar";

const EMPTY = new Map();

export function CodeShellSidebar({ onCollapse, onNavigate }: { onCollapse?: () => void; onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { conversations, user } = useApp();
  const { runs, reachableFor } = useCodeRuns({ enabled: true, perConversation: true });
  const live = React.useSyncExternalStore(subscribeThreadStates, threadStatesSnapshot, () => EMPTY);

  const runStates = React.useMemo(() => {
    const out = new Map<string, ThreadState>();
    const newest = newestPerConversation(
      runs,
      (run) => run.conversationId,
      (run) => run.createdAt,
    );
    for (const [conversationId, run] of newest) {
      const reachable = reachableFor(run);
      const state = runState(run, reachable);
      if (!(state in RUN_STATE_META)) continue;
      out.set(conversationId, threadStateFromRun(state, isBlockedOnYou(run, reachable)));
    }
    return out;
  }, [runs, reachableFor]);

  const threads = React.useMemo(() => shellThreads(conversations, runStates, live), [conversations, runStates, live]);
  const activeId = pathname?.match(/^\/(?:code|chat)\/([^/?#]+)/)?.[1];
  const go = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  return (
    <div className="cv2 cv2-shell-side">
      <ThreadSidebar
        threads={threads}
        activeId={activeId}
        userName={user?.name ?? undefined}
        onOpen={(id) => go(`/code/${id}`)}
        onNew={() => go("/code")}
        onSearch={() => window.dispatchEvent(new CustomEvent("juno:search"))}
        onSettings={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "connections" }))}
        onCollapse={onCollapse}
      />
    </div>
  );
}
