"use client";

/**
 * /code/[id]: the v2 workspace on real data. Two transports feed one
 * `WorkspaceModel`:
 *
 * - The env server on the user's Mac (direct socket in the Mac app, the device
 *   link relay on the web), when it answers `provider.list`: event-sourced
 *   session views, subscriptions as providers, terminals, checkpoints.
 * - Otherwise today's CodeTask path (useCodeSession), folded into the same
 *   turn items by the legacy adapter, so every existing session renders and
 *   runs with the same components.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-provider";
import { useCodeTaskMeta, useDevicePresence } from "@/components/code/code-session-meta";
import { useCodeSession } from "@/hooks/use-code-session";
import { codeProviderModels } from "@/lib/code-v2/code-models";
import { createByokClient, type ByokKeyRecord } from "@/lib/code-v2/byok-client";
import type { ApprovalDecision, InteractionMode, ModelSelection, ProviderInstance, ProviderModel, RoleRouting, RuntimeMode } from "@/lib/code-v2/contracts";
import { legacyToItems, type LegacySessionInput } from "@/lib/code-v2/legacy-adapter";
import { fallbackSetupCommand } from "@/lib/code-v2/providers-view";
import { queueReducer, type QueueRow } from "@/lib/code-v2/composer";
import { routingAvoidsAlevrBilling } from "@/lib/code-v2/role-routing";
import { sessionItems } from "@/lib/code-v2/session-store";
import type { ThreadSummary } from "@/lib/code-v2/thread-sections";
import { buildInstances, reconcileSelection } from "@/lib/code-v2/workspace-instances";
import { publishThreadState } from "@/lib/code-v2/shell-threads";
import { hunkPatch, type HunkDecision } from "@/lib/code-v2/diff";
import { managedCall, runtimeRequest, type ScheduledResume } from "@/lib/code-v2/runtime-lane";
import { toast } from "sonner";
import type { ClientMessage } from "@/types/chat";
import { useEnvLink } from "./use-env-link";
import type { WorkspaceModel } from "./types";
import { CodeWorkspace } from "./workspace";

export interface CodeV2RouteProps {
  conversation: {
    id: string;
    title: string;
    codeWorkspaceName?: string | null;
    codeWorkspacePath?: string | null;
    codeWorkspaceKey?: string | null;
  };
  initialMessages: ClientMessage[];
  userName?: string;
}

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-viewer convenience */
  }
}

export function CodeV2Route({ conversation, initialMessages, userName }: CodeV2RouteProps) {
  const router = useRouter();
  const { conversations, updateConversation } = useApp();
  const meta = useCodeTaskMeta(conversation.id);
  const { presence } = useDevicePresence(conversation.codeWorkspaceKey ?? null, conversation.codeWorkspaceName?.trim() || null, !(meta.loaded && meta.isCloud));
  const session = useCodeSession({
    conversationId: conversation.id,
    initialMessages,
    onActivity: () => updateConversation(conversation.id, { lastMessageAt: new Date().toISOString() }),
  });
  const device = presence.device ? { id: presence.device.id, name: presence.device.name, online: presence.state === "online" } : null;
  const sessionKey = `alevr.code.envSession.${conversation.id}`;
  const [storedSession] = React.useState(() => (typeof window === "undefined" ? null : readJson<string>(sessionKey)));
  const env = useEnvLink(device && !meta.isCloud ? device : null, storedSession);
  const useEnv = env.ready && (!!env.view || session.messages.length === 0);

  // Re-attach to a CodeTask run that was live when the page loaded.
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current || !meta.loaded) return;
    resumed.current = true;
    if (meta.activeTask) session.resume(meta.activeTask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.loaded]);

  // BYOK keys for the rail.
  const byok = React.useMemo(() => createByokClient(), []);
  const [keys, setKeys] = React.useState<ByokKeyRecord[]>([]);
  React.useEffect(() => {
    byok.list().then(setKeys).catch(() => undefined);
  }, [byok]);

  // OpenRouter's models, once a key for it is stored.
  const hasOpenRouter = keys.some((k) => k.provider === "openrouter" && !k.invalid);
  const [openRouterModels, setOpenRouterModels] = React.useState<ProviderModel[]>([]);
  React.useEffect(() => {
    if (!hasOpenRouter) return;
    byok.models("openrouter").then(setOpenRouterModels).catch(() => undefined);
  }, [byok, hasOpenRouter]);

  const alevrModels = React.useMemo(() => codeProviderModels(), []);
  const instances = React.useMemo<ProviderInstance[]>(
    () => buildInstances({ alevrModels, deviceInstances: env.instances, byokKeys: keys, openRouterModels }),
    [alevrModels, env.instances, keys, openRouterModels],
  );

  const prefKey = `alevr.code.prefs.${conversation.id}`;
  const [prefs, setPrefs] = React.useState<{ selection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }>(() =>
    typeof window === "undefined" ? {} : (readJson(prefKey) ?? {}),
  );
  React.useEffect(() => writeJson(prefKey, prefs), [prefKey, prefs]);
  const selection = reconcileSelection(instances, prefs.selection);
  const [routing, setRoutingState] = React.useState<RoleRouting>({ preset: "solo", orchestrator: selection });
  React.useEffect(() => {
    fetch(`/api/code/routing/${conversation.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { routing?: RoleRouting | null } | null) => b?.routing && setRoutingState(b.routing))
      .catch(() => undefined);
  }, [conversation.id]);
  const effectiveRouting: RoleRouting = { ...routing, orchestrator: selection };

  // Client-side queue for the CodeTask path (the env server keeps its own).
  const [localQueue, setLocalQueue] = React.useState<QueueRow[]>([]);
  const legacy = React.useMemo(
    () =>
      legacyToItems({
        messages: session.messages as unknown as LegacySessionInput["messages"],
        status: session.status,
        pendingApproval: session.pendingApproval,
        pendingQuestion: session.pendingQuestion as LegacySessionInput["pendingQuestion"],
        pendingPlan: session.pendingPlan as LegacySessionInput["pendingPlan"],
        agents: session.agents,
        fileChanges: session.fileChanges as unknown as LegacySessionInput["fileChanges"],
        instanceId: "alevr",
      }),
    [session.messages, session.status, session.pendingApproval, session.pendingQuestion, session.pendingPlan, session.agents, session.fileChanges],
  );

  const items = useEnv && env.view ? sessionItems(env.view) : legacy.items;
  const state = useEnv && env.view ? env.view.state : legacy.state;
  const queue: QueueRow[] = useEnv && env.view ? env.view.queue.map((q) => ({ id: q.id, text: q.input.text })) : localQueue;

  // Drain the local queue when a CodeTask run settles.
  React.useEffect(() => {
    if (useEnv || session.isBusy || localQueue.length === 0) return;
    const [next, ...rest] = localQueue;
    setLocalQueue(rest);
    void sendLegacy(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.isBusy, useEnv]);

  // Hunk decisions survive the dock remounting (and a reload): rejected hunks were reverted on the Mac.
  const hunkKey = `alevr.code.hunks.${conversation.id}`;
  const [hunkDecisions, setHunkDecisions] = React.useState<Record<string, HunkDecision>>(() =>
    typeof window === "undefined" ? {} : (readJson<Record<string, HunkDecision>>(hunkKey) ?? {}),
  );
  React.useEffect(() => writeJson(hunkKey, hunkDecisions), [hunkKey, hunkDecisions]);

  // Resume at reset: the env server's own schedule once the runtime lane's session view carries it,
  // else what this page scheduled. Only meaningful while the session is limited.
  const [localSchedule, setLocalSchedule] = React.useState<ScheduledResume | null>(null);
  const viewSchedule = useEnv && env.view ? (env.view as { scheduledResume?: ScheduledResume }).scheduledResume : undefined;
  const scheduled = state === "limited" ? (viewSchedule ?? localSchedule) : null;
  React.useEffect(() => {
    if (state !== "limited") setLocalSchedule(null);
  }, [state]);

  const cwd = conversation.codeWorkspacePath ?? "";
  const runtimeMode = prefs.runtimeMode ?? "auto-edit";
  const interactionMode = prefs.interactionMode ?? "default";

  async function sendLegacy(text: string) {
    const choice = { model: selection.instanceId === "alevr" ? selection.model : null, reasoningEffort: selection.effort ?? null };
    if (meta.isCloud && meta.repoOwner && meta.repoName) {
      return session.send(text, { mode: "cloud", repo: { owner: meta.repoOwner, name: meta.repoName }, baseRef: meta.baseRef, workspaceName: conversation.codeWorkspaceName }, [], choice);
    }
    if (!presence.device || !cwd) return { accepted: false };
    return session.send(text, { deviceId: presence.device.id, workspacePath: cwd, workspaceName: conversation.codeWorkspaceName, workspaceKey: conversation.codeWorkspaceKey }, [], choice);
  }

  async function ensureEnvSession(): Promise<string> {
    const id = await env.open({ sessionId: env.sessionId ?? undefined, cwd, selection });
    writeJson(sessionKey, id);
    return id;
  }

  const persistRouting = (r: RoleRouting) => {
    setRoutingState(r);
    void fetch(`/api/code/routing/${conversation.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ routing: r }) }).catch(() => undefined);
  };

  const actions: WorkspaceModel["actions"] = {
    async send(text) {
      if (useEnv && env.client) {
        const sessionId = await ensureEnvSession();
        return env.client.request("turn.start", { sessionId, input: { text }, selection, routing: effectiveRouting.preset === "solo" ? undefined : effectiveRouting, runtimeMode, interactionMode });
      }
      return sendLegacy(text);
    },
    queue(text) {
      if (useEnv && env.client && env.view) void env.client.request("turn.queue", { sessionId: env.view.id, input: { text } });
      else setLocalQueue((q) => queueReducer(q, { type: "add", row: { id: `q${Date.now()}`, text } }));
    },
    async steer(text) {
      if (useEnv && env.client && env.view?.activeTurnId) return env.client.request("turn.steer", { sessionId: env.view.id, turnId: env.view.activeTurnId, input: { text } });
      if (session.canSteer) return session.steer(text);
      setLocalQueue((q) => queueReducer(q, { type: "add", row: { id: `q${Date.now()}`, text } }));
    },
    stop() {
      if (useEnv && env.client && env.view) void env.client.request("turn.interrupt", { sessionId: env.view.id, turnId: env.view.activeTurnId });
      else void session.cancel();
    },
    async respond(requestId, decision: ApprovalDecision, answers) {
      if (useEnv && env.client && env.view) return env.client.request("approval.respond", { sessionId: env.view.id, requestId, decision, answers });
      if (session.pendingQuestion && session.pendingQuestion.questionId === requestId) {
        const answer = answers ? Object.values(answers).flat().join(", ") : "";
        return session.respondToInput({ type: "question.answer", requestId, answer });
      }
      return session.respond(requestId, decision === "accept" || decision === "acceptForSession");
    },
    setSelection: (sel) => setPrefs((p) => ({ ...p, selection: sel })),
    setRouting: persistRouting,
    setRuntimeMode: (m) => setPrefs((p) => ({ ...p, runtimeMode: m })),
    setInteractionMode: (m) => setPrefs((p) => ({ ...p, interactionMode: m })),
    editQueued: (id, text) => setLocalQueue((q) => queueReducer(q, { type: "edit", id, text })),
    removeQueued: (id) => setLocalQueue((q) => queueReducer(q, { type: "remove", id })),
    moveQueued: (id, to) => setLocalQueue((q) => queueReducer(q, { type: "move", id, to })),
    steerQueued(id) {
      const row = queue.find((q) => q.id === id);
      if (!row) return;
      setLocalQueue((q) => queueReducer(q, { type: "take", id }));
      void actions.steer(row.text);
    },
    rollback: useEnv
      ? (checkpointId) => {
          if (env.client && env.view) void env.client.request("checkpoint.rollback", { sessionId: env.view.id, checkpointId });
        }
      : undefined,
    approvePlan(itemId, approve) {
      const planId = itemId.replace(/^plan-/, "");
      if (useEnv && env.client && env.view) void env.client.request("approval.respond", { sessionId: env.view.id, requestId: planId, decision: approve ? "accept" : "decline" });
      else void session.respondToInput({ type: "plan.decide", requestId: planId, decision: approve ? "approve" : "reject" });
    },
    decideHunk:
      useEnv && env.client && env.view
        ? async (_path, hunkId, decision, file) => {
            const client = env.client;
            const sessionId = env.view?.id;
            const before = hunkDecisions[hunkId];
            const commit = () =>
              setHunkDecisions((d) => {
                const n = { ...d };
                if (decision) n[hunkId] = decision;
                else delete n[hunkId];
                return n;
              });
            // Accepting is the default state of a change the agent already wrote: nothing to apply.
            const revert = decision === "rejected" && before !== "rejected";
            const reapply = decision !== "rejected" && before === "rejected";
            if (!revert && !reapply) {
              commit();
              return true;
            }
            const patch = file ? hunkPatch(file, [hunkId]) : "";
            if (!client || !sessionId || !patch) return false;
            try {
              await runtimeRequest(client, "checkpoint.applyPatch", { sessionId, patch, reverse: revert });
              commit();
              return true;
            } catch (e) {
              toast.error(e instanceof Error ? e.message : revert ? "Could not undo that change on your Mac." : "Could not put that change back.");
              return false;
            }
          }
        : undefined,
    resumeAtReset:
      useEnv && env.client && env.view
        ? async (at) => {
            const client = env.client;
            const sessionId = env.view?.id;
            if (!client || !sessionId) return;
            try {
              const { schedule } = await runtimeRequest(client, "turn.schedule", { sessionId, ...(env.view?.resumeAt ? {} : at ? { at } : {}) });
              setLocalSchedule(schedule);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not schedule the next turn on your Mac.");
            }
          }
        : undefined,
    cancelResume:
      useEnv && env.client && env.view && scheduled
        ? () => {
            const client = env.client;
            const sessionId = env.view?.id;
            if (!client || !sessionId) return;
            const id = scheduled.id;
            setLocalSchedule(null);
            void runtimeRequest(client, "turn.unschedule", { sessionId, scheduleId: id }).catch((e) =>
              toast.error(e instanceof Error ? e.message : "Could not cancel. Alevr may still continue at the reset."),
            );
          }
        : undefined,
    openThread: (id) => router.push(`/code/${id}`),
    newThread: () => router.push("/code"),
    terminalInput: env.ready ? env.writeTerminal : undefined,
    terminalResize: env.ready ? env.resizeTerminal : undefined,
    closeTerminal: env.ready ? env.closeTerminal : undefined,
    openTerminal: env.ready ? (command) => void env.openTerminal(cwd, command) : undefined,
    renameThread: (title) => {
      updateConversation(conversation.id, { title });
      void fetch(`/api/conversations/${conversation.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }).catch(() => undefined);
    },
  };

  const threads: ThreadSummary[] = conversations
    .filter((c) => c.kind === "code")
    .map((c) => ({
      id: c.id,
      title: c.title,
      project: c.codeWorkspaceName ?? "Not in a project",
      state: c.id === conversation.id ? (state === "waiting" ? "waiting" : state === "running" ? "running" : state === "limited" ? "limited" : "idle") : "idle",
      updatedAt: (c as { lastMessageAt?: string }).lastMessageAt ?? new Date(0).toISOString(),
    }));

  // The shell's Code column shows this thread's live state (the env server has no CodeTask behind it).
  React.useEffect(() => {
    publishThreadState(conversation.id, { state });
  }, [conversation.id, state]);
  React.useEffect(() => () => publishThreadState(conversation.id, null), [conversation.id]);

  const usage = useEnv && env.view?.usage ? env.view.usage : undefined;
  const model: WorkspaceModel = {
    thread: {
      id: conversation.id,
      title: conversation.title || "Code session",
      repo: meta.repoOwner && meta.repoName ? `${meta.repoOwner}/${meta.repoName}` : (conversation.codeWorkspaceName ?? "Code session"),
      branch: meta.branch ?? undefined,
      cwd,
    },
    items,
    state,
    resumeAt: env.view?.resumeAt,
    scheduledResume: scheduled ? { id: scheduled.id, at: scheduled.at } : null,
    hunkDecisions,
    stateMessage: env.view?.stateMessage,
    usage: usage ?? (routingAvoidsAlevrBilling(effectiveRouting) ? { inputTokens: 0, outputTokens: 0, billing: "subscription" } : undefined),
    queue,
    instances,
    selection,
    routing: effectiveRouting,
    runtimeMode,
    interactionMode,
    terminals: env.terminals,
    device: device ? { id: device.id, name: device.name, online: device.online } : null,
    byokKeys: keys,
    threads,
    starting: !meta.loaded ? null : session.status === "submitting" ? `Starting on ${presence.device?.name ?? "your Mac"}…` : null,
    offline: !meta.isCloud && presence.state === "offline",
    actions,
  };

  return (
    <CodeWorkspace
      model={model}
      sidebar={false}
      userName={userName}
      byok={byok}
      firstRun={!instances.some((i) => i.kind !== "alevr" && (i.status === "ready" || i.status === "limited")) && !keys.length && session.messages.length === 0}
      onProbe={env.ready ? env.probe : undefined}
      onManaged={
        env.ready && env.client
          ? (instanceId, op) => {
              if (!env.client) throw new Error("Your Mac is not connected.");
              return managedCall(env.client, instanceId, op);
            }
          : undefined
      }
      onSetup={async (instance, action) => {
        let command: string | null = null;
        if (env.client) {
          try {
            const { step } = await env.client.request("provider.setup", { instanceId: instance.id, action });
            command = step?.command ?? null;
          } catch {
            command = null;
          }
        }
        command ??= fallbackSetupCommand(instance, action);
        if (!command) throw new Error("Alevr does not know this runtime's command yet. Run it yourself, then press Re-check.");
        await env.openTerminal(cwd || "~", command, action === "install" ? `Install ${instance.label}` : `Sign in to ${instance.label}`);
      }}
    />
  );
}
