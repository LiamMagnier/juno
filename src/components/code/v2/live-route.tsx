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
import type { ApprovalDecision, InteractionMode, ModelSelection, ProviderInstance, ProviderModel, RoleRouting, RuntimeMode, SkillActivation } from "@/lib/code-v2/contracts";
import { legacyToItems, type LegacySessionInput } from "@/lib/code-v2/legacy-adapter";
import { fallbackSetupCommand, managedSetup } from "@/lib/code-v2/providers-view";
import { queueReducer, type QueueRow } from "@/lib/code-v2/composer";
import { overlayQueue, promoteOutcomeMessage, queueErrorMessage, reconcileQueueOps, type QueueOp } from "@/lib/code-v2/queue-sync";
import { routingAvoidsAlevrBilling } from "@/lib/code-v2/role-routing";
import { sessionItems } from "@/lib/code-v2/session-store";
import type { ThreadSummary } from "@/lib/code-v2/thread-sections";
import { buildInstances, reconcileSelection } from "@/lib/code-v2/workspace-instances";
import { publishThreadState } from "@/lib/code-v2/shell-threads";
import { hunkPatch, type HunkDecision } from "@/lib/code-v2/diff";
import { managedCall, runtimeRequest, type ScheduledResume } from "@/lib/code-v2/runtime-lane";
import { useMacScreenshots } from "@/lib/code-v2/use-mac-screenshots";
import { toast } from "sonner";
import type { ClientMessage, ConversationHistory } from "@/types/chat";
import { useEnvLink } from "./use-env-link";
import { readRepoSkills, useCodeSkills } from "./use-code-skills";
import type { AgentControlRequestInput, WorkspaceModel } from "./types";
import { sendAgentControl } from "@/lib/code-v2/agent-control-client";
import { CodeWorkspace } from "./workspace";
import { cloudPermissionMode, composerModeOf, initialModePair, projectModeKey, threadPrefsKey, type ProjectModeDefault } from "@/lib/code-v2/composer-mode";
import { createFirstPromptHandoff, firstPromptNeedsSkills, type PendingFirstPrompt } from "@/lib/code-v2/first-prompt";
import { skillsStorageKey } from "@/lib/code-v2/skills";
import { clearPendingCodePrompt, peekPendingCodePrompt } from "@/lib/code-session-handoff";
import { compactMessage } from "@/lib/code-v2/composer";
import { MAC_ATTACHMENT_FAILED_MESSAGE, MAC_ATTACHMENT_MAX_BYTES, MacAttachmentError, previewAttachment, sendAttachmentsToMac } from "@/lib/code-v2/composer-attachments";
import { choicesFromSynced, codeDraftKey, syncedPrefsOf, webCodeThreadKey } from "@/lib/code-v2/thread-prefs";
import { writeComposerDraft } from "@/lib/chat/context-draft";
import { useThreadDraftSync } from "@/lib/sync/thread-draft-client";
import type { Attachment, TurnItem } from "@/lib/code-v2/contracts";
import type { ClientAttachment, ClientConversation } from "@/types/chat";
import type { DraftChannel } from "./types";
import { transcriptFromTurns } from "@/lib/share-transcript";
import { registerSessionTranscript, useCodeSessionActions } from "./session-actions";
import { useAnswerFeedback } from "./use-answer-feedback";
import { useCodePrefs } from "./use-code-prefs";

/** A thread with no skills chosen, as one stable value. */
const NO_SKILLS: SkillActivation[] = [];

let opCounter = 0;
const newOpId = () => `qop${Date.now().toString(36)}${(opCounter++).toString(36)}`;

export interface CodeV2RouteProps {
  conversation: {
    id: string;
    title: string;
    codeWorkspaceName?: string | null;
    codeWorkspacePath?: string | null;
    codeWorkspaceKey?: string | null;
  };
  initialMessages: ClientMessage[];
  /** The newest page of a longer session (lib/chat/history-page.ts). Absent: the whole session. */
  initialHistory?: ConversationHistory;
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

const SEND_FAILED_MESSAGE = "Couldn’t send that to your Mac. Your message is back in the composer.";
const CLEAR_FAILED_MESSAGE = "Couldn’t start a new session. Check your connection and try again.";
const ATTACHMENT_READ_FAILED_MESSAGE = "Couldn’t read an attached file to send it. Try attaching it again.";
/** A cloud run has no Mac to name while it starts. */
const CLOUD_STARTING_LABEL = "Starting in the cloud…";

/** What the composer gave a draft back with, when a send could not go. */
type DraftIo = { read(): { text: string; editing: boolean }; apply(text: string): void; restore?(text: string, attachments: ClientAttachment[]): void };

export function CodeV2Route({ conversation, initialMessages, initialHistory }: CodeV2RouteProps) {
  const router = useRouter();
  const { conversations, updateConversation, upsertConversation, features } = useApp();
  const meta = useCodeTaskMeta(conversation.id);
  const { presence } = useDevicePresence(conversation.codeWorkspaceKey ?? null, conversation.codeWorkspaceName?.trim() || null, !(meta.loaded && meta.isCloud));
  const session = useCodeSession({
    conversationId: conversation.id,
    initialMessages,
    initialHistory,
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
  // The project's last mode is the default for a thread that has not chosen one.
  const projectKey = projectModeKey(conversation.codeWorkspaceKey ?? conversation.codeWorkspacePath ?? null);
  const [projectMode] = React.useState<Partial<ProjectModeDefault> | null>(() => (projectKey && typeof window !== "undefined" ? readJson(projectKey) : null));
  // A subscription chosen on the landing waits for the Mac's provider list
  // instead of being swapped for the first ready instance (G02).
  const awaitingDevice = !meta.isCloud && !!device?.online && !env.probed;
  const selection = reconcileSelection(instances, prefs.selection, { awaitingDevice });
  const selectionListed = instances.some((i) => i.id === selection.instanceId && i.models?.some((m) => m.id === selection.model));
  const [routing, setRoutingState] = React.useState<RoleRouting>({ preset: "solo", orchestrator: selection });
  // A team set before the thread's own routing has been read (the team chip seeds a fresh-looking
  // thread from the project's last team or the account default the moment it mounts, and a Mac
  // thread looks fresh until its log arrives) waits here: a stored team wins, and nothing
  // overwrites it on the server.
  const routingLoaded = React.useRef(false);
  const earlyRouting = React.useRef<RoleRouting | null>(null);
  const latestPersistRouting = React.useRef<(r: RoleRouting) => void>(() => undefined);
  // This browser already ran this thread on a Mac: it only looked fresh while its log loaded,
  // and a Solo thread stays Solo (a default is for new sessions).
  const ranOnMacHere = React.useRef(!!storedSession);
  React.useEffect(() => {
    routingLoaded.current = false;
    earlyRouting.current = null;
    let live = true;
    fetch(`/api/code/routing/${conversation.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { routing?: RoleRouting | null } | null) => {
        if (!live) return;
        if (b?.routing) setRoutingState(b.routing);
        else if (earlyRouting.current && ranOnMacHere.current) setRoutingState((r) => ({ preset: "solo", orchestrator: r.orchestrator }));
        else if (earlyRouting.current) latestPersistRouting.current(earlyRouting.current);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!live) return;
        routingLoaded.current = true;
        earlyRouting.current = null;
      });
    return () => {
      live = false;
    };
  }, [conversation.id]);
  const effectiveRouting: RoleRouting = { ...routing, orchestrator: selection };

  // Client-side queue for the CodeTask path (the env server keeps its own).
  const [localQueue, setLocalQueue] = React.useState<QueueRow[]>([]);
  /** Files that ride with a locally queued row, by row id (the row itself stays text). */
  const queuedFiles = React.useRef(new Map<string, ClientAttachment[]>());
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
  // A Mac thread's queue is the env server's; Remove / Edit / reorder / Steer now are requests to it,
  // drawn optimistically until its queue shows them (lib/code-v2/queue-sync.ts).
  const viewQueue = useEnv && env.view ? env.view.queue : null;
  const serverQueue = React.useMemo<QueueRow[]>(() => (viewQueue ?? []).map((q) => ({ id: q.id, text: q.input.text })), [viewQueue]);
  const [queueOps, setQueueOps] = React.useState<QueueOp[]>([]);
  React.useEffect(() => setQueueOps((ops) => reconcileQueueOps(serverQueue, ops)), [serverQueue]);
  const queue: QueueRow[] = viewQueue ? overlayQueue(serverQueue, queueOps) : localQueue;

  // Drain the local queue when a CodeTask run settles.
  React.useEffect(() => {
    if (useEnv || session.isBusy || localQueue.length === 0) return;
    const [next, ...rest] = localQueue;
    setLocalQueue(rest);
    const files = queuedFiles.current.get(next.id) ?? [];
    queuedFiles.current.delete(next.id);
    void sendLegacy(next.text, files);
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
  // A thread that never chose a mode starts from its project's last, then the account's default.
  // The account's default reaches only a thread with nothing in it yet (a new session). A thread
  // that already ran without choosing a mode keeps what it ran with (its project's last, else
  // Accept edits): a default changed in Settings, or read on another browser where this thread
  // has no stored choice, never moves an existing session to a different access level.
  const { prefs: account } = useCodePrefs();
  const accountPair = account.runtimeMode && items.length === 0 ? { runtimeMode: account.runtimeMode, interactionMode: account.interactionMode } : null;
  const { runtimeMode, interactionMode } = initialModePair(prefs, projectMode, accountPair);
  /**
   * The modes a send reads. Set at once by a mode change, so `/plan fix the
   * build` sends under Plan in the same tick it switched (state lands a render later).
   */
  const modesRef = React.useRef({ runtimeMode, interactionMode });
  modesRef.current = { runtimeMode, interactionMode };
  /** This thread's mode was chosen (here, on the landing or on another device), not just defaulted. */
  const modeChosen = React.useRef(false);
  // The first send pins the pair it ran with, so the thread's mode is its own from then on.
  const pinModeOnSend = () => {
    const pair = modesRef.current;
    if (!prefs.runtimeMode) setPrefs((p) => (p.runtimeMode ? p : { ...p, ...pair }));
  };
  const rememberMode = (pair: ProjectModeDefault) => {
    modesRef.current = pair;
    modeChosen.current = true;
    if (projectKey) writeJson(projectKey, pair);
    // A Mac session takes a choice made here at once, as the Mac app and the
    // phone send it: the running turn, and the queue after it, so `/plan` sent
    // while a turn runs is queued under Plan. Another device's choice applied
    // here is not sent back (that device already did).
    if (useEnv && env.client && env.view) void env.client.request("session.setMode", { sessionId: env.view.id, ...pair }).catch(() => undefined);
  };

  async function sendLegacy(text: string, attachments: ClientAttachment[] = []) {
    const choice = { model: selection.instanceId === "alevr" ? selection.model : null, reasoningEffort: selection.effort ?? null };
    if (meta.isCloud && meta.repoOwner && meta.repoName) {
      // Skills lane: the thread's account skills and the repository's own, for the runner.
      const cloudSkills = skills.takeCloud();
      // The composer's mode, as far as a cloud sandbox enforces one, so `/plan
      // fix it` runs under Plan. A thread that never chose one keeps the
      // server's rule: the run inherits the last task's mode.
      const chosen = modeChosen.current || !!(prefs.runtimeMode || prefs.interactionMode);
      const permissionMode = chosen ? cloudPermissionMode(composerModeOf(modesRef.current.runtimeMode, modesRef.current.interactionMode)) : null;
      return session.send(text, { mode: "cloud", repo: { owner: meta.repoOwner, name: meta.repoName }, baseRef: meta.baseRef, workspaceName: conversation.codeWorkspaceName }, attachments, { ...choice, ...(cloudSkills ? { skills: cloudSkills } : {}), ...(permissionMode ? { permissionMode } : {}) });
    }
    if (!presence.device || !cwd) return { accepted: false };
    return session.send(text, { deviceId: presence.device.id, workspacePath: cwd, workspaceName: conversation.codeWorkspaceName, workspaceKey: conversation.codeWorkspaceKey }, attachments, choice);
  }

  /**
   * Hands the row's files to the Mac (`host.upload` over the device link) and
   * returns the turn's attachments. A failure gives the words and files back
   * to the composer and says why, instead of sending half a message.
   */
  async function filesForMac(attachments: readonly ClientAttachment[], text: string): Promise<Attachment[] | null> {
    if (!attachments.length) return [];
    const client = env.client;
    if (!client) return null;
    try {
      return await sendAttachmentsToMac(attachments, {
        read: async (a) => {
          const res = await fetch(a.url, { credentials: "same-origin" });
          if (!res.ok) throw new MacAttachmentError(ATTACHMENT_READ_FAILED_MESSAGE);
          return new Uint8Array(await res.arrayBuffer());
        },
        upload: (params) => client.request("host.upload", params),
      });
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : MAC_ATTACHMENT_FAILED_MESSAGE);
      draftIo.current?.restore?.(text, [...attachments]);
      return null;
    }
  }

  /** This tab is opening the thread's env session fresh (not re-attaching to one), until its choices are written. */
  const openingEnvSession = React.useRef(false);
  async function ensureEnvSession(): Promise<string> {
    if (!env.sessionId) openingEnvSession.current = true;
    try {
      const id = await env.open({ sessionId: env.sessionId ?? undefined, cwd, selection });
      writeJson(sessionKey, id);
      return id;
    } catch (error) {
      openingEnvSession.current = false;
      throw error;
    }
  }

  // Skills lane: the account's skills and, when this thread runs on a Mac,
  // the Mac's and the project's (skills.list over the device link).
  const envClient = useEnv ? env.client : null;
  // The Mac's screen-control frames (alevr-shot://…), fetched over the same link with computer.frame.
  const resolveScreenshot = useMacScreenshots(envClient);
  const envSessionId = env.view?.id ?? env.sessionId ?? null;
  // A cloud thread lists its repository's own skills (what the runner reads from its clone).
  const cloudRepo = meta.isCloud && meta.repoOwner && meta.repoName ? { owner: meta.repoOwner, name: meta.repoName } : null;
  const cloudRepoKey = cloudRepo ? `${cloudRepo.owner}/${cloudRepo.name}` : null;
  const cloudRef = meta.branch ?? meta.baseRef ?? null;
  const listLocal = React.useMemo(() => {
    if (envClient) return async () => (await envClient.request("skills.list", envSessionId ? { sessionId: envSessionId } : cwd ? { cwd } : {})).skills;
    if (cloudRepoKey) {
      const [owner, name] = cloudRepoKey.split("/") as [string, string];
      return () => readRepoSkills({ owner, name }, cloudRef);
    }
    return null;
  }, [envClient, envSessionId, cwd, cloudRepoKey, cloudRef]);
  // Live selection: the env server's record of this thread's skills, set from any device.
  const liveView = useEnv && env.client && env.view ? env.view : null;
  const remoteSkills = React.useMemo(() => {
    if (!liveView || !envClient) return null;
    const sessionId = liveView.id;
    return { skills: liveView.skills ?? NO_SKILLS, select: (next: SkillActivation[]) => envClient.request("skills.select", { sessionId, skills: next }) };
  }, [liveView, envClient]);
  const skills = useCodeSkills({ threadKey: conversation.id, snapshotSkills: env.view?.skills, listLocal, remote: remoteSkills, listRevision: env.skillsRevision, localKind: envClient ? "mac" : cloudRepoKey ? "repo" : undefined });

  // Session menu verbs, shared with the sidebar row's menu; its dialogs render below.
  const sessionActions = useCodeSessionActions();
  const pinned = conversations.find((c) => c.id === conversation.id)?.pinned ?? false;
  // A Mac thread's transcript is not on the server: a share link carries it (messages and answers only).
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const onMac = useEnv && !!env.view;
  React.useEffect(() => {
    if (!onMac) return;
    return registerSessionTranscript(conversation.id, () => transcriptFromTurns(itemsRef.current));
  }, [onMac, conversation.id]);
  const feedback = useAnswerFeedback({
    conversationId: conversation.id,
    onMac,
    items,
    legacyMessages: session.messages as unknown as { id: string; feedback?: "UP" | "DOWN" | null }[],
    setLegacyFeedback: session.setFeedback,
    model: selection.model,
  });

  /**
   * A queue change on a Mac thread: drawn at once, sent to the env server, and
   * taken back (with the reason) if the Mac refuses it. False off a Mac thread,
   * where the CodeTask path's client-side queue is the real one.
   */
  const onMacQueue = (op: QueueOp, run: (client: NonNullable<typeof env.client>, sessionId: string) => Promise<unknown>): boolean => {
    const client = env.client;
    const sessionId = env.view?.id;
    if (!useEnv || !client || !sessionId) return false;
    setQueueOps((ops) => [...ops, op]);
    run(client, sessionId).catch((e) => {
      setQueueOps((ops) => ops.filter((o) => o.opId !== op.opId));
      toast.error(queueErrorMessage(e));
    });
    return true;
  };

  const persistRouting = (r: RoleRouting) => {
    setRoutingState(r);
    void fetch(`/api/code/routing/${conversation.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ routing: r }) }).catch(() => undefined);
  };
  latestPersistRouting.current = persistRouting;
  /** The team chip's setter: drawn at once, but saved only once the thread's own routing is known. */
  const setRouting = (r: RoleRouting) => {
    if (routingLoaded.current) return persistRouting(r);
    earlyRouting.current = r;
    setRoutingState(r);
  };

  /*
   * The draft and the composer's choices beyond this browser (the critic's
   * missed defect: the web kept model and mode in one browser's localStorage
   * and never kept the draft at all). The draft is kept in this tab per
   * thread and synced through the thread-sync row, as Chat drafts are; the
   * model, effort and mode ride the same row in the Mac's spelling, so a
   * thread on a Mac shares both with the Mac app (code:<device>:<session>).
   */
  const syncKey = webCodeThreadKey({ conversationId: conversation.id, deviceId: device?.id, envSessionId: useEnv ? envSessionId : null });
  const draftIo = React.useRef<DraftIo | null>(null);
  const choicesRef = React.useRef({ selection, runtimeMode, interactionMode, routing: effectiveRouting });
  choicesRef.current = { selection, runtimeMode, interactionMode, routing: effectiveRouting };
  const threadSync = useThreadDraftSync(
    syncKey,
    () => draftIo.current?.read() ?? { text: "", editing: false },
    (text) => draftIo.current?.apply(text),
    {
      applyPrefs: (remote) => {
        const change = choicesFromSynced(remote, choicesRef.current);
        if (!change.selection && !change.runtimeMode && !change.interactionMode) return;
        setPrefs((p) => ({ ...p, ...change }));
      },
    },
  );
  const publishChoices = (next: { selection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }) =>
    threadSync.prefsChanged(syncedPrefsOf({ ...choicesRef.current, ...next }));
  const draftChannel = React.useMemo<DraftChannel>(
    () => ({
      key: codeDraftKey(conversation.id),
      attach: (io) => {
        draftIo.current = io;
        return () => {
          if (draftIo.current === io) draftIo.current = null;
        };
      },
      changed: threadSync.changed,
      cleared: threadSync.cleared,
    }),
    [conversation.id, threadSync.changed, threadSync.cleared],
  );
  /*
   * A Mac session this tab just opened takes the thread's choices with it (the
   * Mac app reads that key). Only one it opened: every reload re-attaches to
   * the thread's session and moves the key the same way once the link is up,
   * and writing then would stamp this browser's older choices over what the
   * Mac app set since. A re-attached session reads the row instead.
   */
  const firstSyncKey = React.useRef(syncKey);
  React.useEffect(() => {
    if (firstSyncKey.current === syncKey) return;
    firstSyncKey.current = syncKey;
    if (!openingEnvSession.current || !syncKey.startsWith("code:")) return;
    openingEnvSession.current = false;
    threadSync.prefsChanged(syncedPrefsOf(choicesRef.current));
  }, [syncKey, threadSync]);

  /** `/clear`: a fresh thread in the same project, its words (if any) waiting in the new composer. */
  async function clearThread(rest?: string) {
    const draft = rest?.trim() ?? "";
    if (meta.isCloud && meta.repoOwner && meta.repoName) {
      // A cloud thread starts on the landing, with this repository and branch already picked.
      if (draft) writeComposerDraft(codeDraftKey(null), { text: draft, tokens: [] });
      const q = new URLSearchParams({ repositories: `${meta.repoOwner}/${meta.repoName}` });
      if (meta.baseRef) q.set("branch", meta.baseRef);
      router.push(`/code?${q}`);
      return;
    }
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "code",
          codeWorkspaceName: conversation.codeWorkspaceName ?? undefined,
          codeWorkspacePath: conversation.codeWorkspacePath ?? undefined,
          codeWorkspaceKey: conversation.codeWorkspaceKey ?? undefined,
          ...(selection.instanceId === "alevr" ? { model: selection.model } : {}),
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation: fresh } = (await res.json()) as { conversation: ClientConversation };
      writeJson(threadPrefsKey(fresh.id), { selection, runtimeMode: modesRef.current.runtimeMode, interactionMode: modesRef.current.interactionMode });
      if (draft) writeComposerDraft(codeDraftKey(fresh.id), { text: draft, tokens: [] });
      upsertConversation(fresh);
      router.push(`/code/${fresh.id}`);
    } catch {
      toast.error(CLEAR_FAILED_MESSAGE);
      if (draft) draftIo.current?.apply(`/clear ${draft}`);
    }
  }

  const actions: WorkspaceModel["actions"] = {
    ...(useEnv && env.client && env.view && env.instances.some((i) => i.id === env.view!.selection.instanceId && (i.kind === "alevr" || i.kind === "byok")) ? (() => {
      // Agents tree (REA backlog 10): every press goes through the audited
      // agent-control route over the hosted link, or straight to the env
      // server in the Mac app's own web view, under one request key.
      const transport = { linkDeviceId: env.linkDeviceId, request: env.client!.request.bind(env.client!) };
      const sessionId = env.view!.id;
      const controlAgent = (input: AgentControlRequestInput) => sendAgentControl(transport, { ...input, sessionId });
      return {
        controlAgent,
        messageAgent: async (agentId: string, text: string) => {
          const result = await controlAgent({ agentId, action: "steer", text });
          if (!result.accepted) throw new Error(result.message ?? "This agent cannot receive a message right now.");
          return true;
        },
        stopAgent: (agentId: string) => { void controlAgent({ agentId, action: "stop" }).catch((e) => toast.error(e.message)); },
      };
    })() : {}),
    async send(text, attachments = []) {
      pinModeOnSend();
      if (useEnv && env.client) {
        const client = env.client;
        const files = await filesForMac(attachments, text);
        if (!files) return false;
        try {
          const sessionId = await ensureEnvSession();
          const active = await skills.take();
          return await client.request("turn.start", { sessionId, input: { text, ...(files.length ? { attachments: files } : {}), ...(active ? { skills: active } : {}) }, selection, routing: effectiveRouting.preset === "solo" ? undefined : effectiveRouting, ...modesRef.current });
        } catch (error) {
          // The words and files go back to the composer rather than vanishing with the error.
          toast.error(error instanceof Error && error.message ? error.message : SEND_FAILED_MESSAGE);
          draftIo.current?.restore?.(text, [...attachments]);
          return false;
        }
      }
      return sendLegacy(text, attachments);
    },
    queue(text, attachments = []) {
      if (useEnv && env.client && env.view) {
        const { client, view } = { client: env.client, view: env.view };
        void filesForMac(attachments, text).then(async (files) => {
          if (!files) return;
          const active = await skills.take();
          return client.request("turn.queue", { sessionId: view.id, input: { text, ...(files.length ? { attachments: files } : {}), ...(active ? { skills: active } : {}) } });
        });
      }
      else {
        const id = `q${Date.now()}`;
        if (attachments.length) queuedFiles.current.set(id, attachments);
        setLocalQueue((q) => queueReducer(q, { type: "add", row: { id, text } }));
      }
    },
    async steer(text, attachments = []) {
      if (useEnv && env.client && env.view?.activeTurnId) {
        const { client, view } = { client: env.client, view: env.view };
        const files = await filesForMac(attachments, text);
        if (!files) return false;
        return client.request("turn.steer", { sessionId: view.id, turnId: view.activeTurnId!, input: { text, ...(files.length ? { attachments: files } : {}) } });
      }
      if (session.canSteer) return session.steer(text, attachments);
      const id = `q${Date.now()}`;
      if (attachments.length) queuedFiles.current.set(id, attachments);
      setLocalQueue((q) => queueReducer(q, { type: "add", row: { id, text } }));
    },
    // Only Claude Code reads instructions after `/compact` (composer.ts compactMessage).
    compact: (instructions) => void actions.send(compactMessage(instructions?.trim() ?? "", instances.find((i) => i.id === selection.instanceId)?.kind === "claude-agent")),
    clearThread: (rest) => void clearThread(rest),
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
    setSelection: (sel) => {
      setPrefs((p) => ({ ...p, selection: sel }));
      publishChoices({ selection: sel });
    },
    setRouting,
    setRuntimeMode: (m) => {
      rememberMode({ runtimeMode: m, interactionMode });
      setPrefs((p) => ({ ...p, runtimeMode: m, interactionMode: p.interactionMode ?? interactionMode }));
      publishChoices({ runtimeMode: m });
    },
    setModes: (pair) => {
      rememberMode(pair);
      setPrefs((p) => ({ ...p, ...pair }));
      publishChoices(pair);
    },
    setInteractionMode: (m) => {
      rememberMode({ runtimeMode, interactionMode: m });
      setPrefs((p) => ({ ...p, interactionMode: m, runtimeMode: p.runtimeMode ?? runtimeMode }));
      publishChoices({ interactionMode: m });
    },
    editQueued(id, text) {
      if (onMacQueue({ opId: newOpId(), kind: "edit", id, text }, (client, sessionId) => client.request("queue.edit", { sessionId, queuedId: id, text }))) return;
      setLocalQueue((q) => queueReducer(q, { type: "edit", id, text }));
    },
    removeQueued(id) {
      const sent = onMacQueue({ opId: newOpId(), kind: "remove", id }, async (client, sessionId) => {
        const { removed } = await client.request("queue.remove", { sessionId, queuedId: id });
        if (!removed) toast.message("That message had already started, so it stays in the thread.");
      });
      if (!sent) setLocalQueue((q) => queueReducer(q, { type: "remove", id }));
    },
    moveQueued(id, to) {
      if (onMacQueue({ opId: newOpId(), kind: "move", id, to }, (client, sessionId) => client.request("queue.move", { sessionId, queuedId: id, to }))) return;
      setLocalQueue((q) => queueReducer(q, { type: "move", id, to }));
    },
    steerQueued(id) {
      const row = queue.find((q) => q.id === id);
      if (!row) return;
      // Steer now on a Mac thread is one step on the env server: never steered AND left queued.
      const op: QueueOp = { opId: newOpId(), kind: "remove", id };
      const sent = onMacQueue(op, async (client, sessionId) => {
        const { outcome } = await client.request("queue.promote", { sessionId, queuedId: id });
        const note = promoteOutcomeMessage(outcome);
        // "next": it stays queued, at the front. Stop hiding it.
        if (outcome === "next") setQueueOps((ops) => ops.filter((o) => o.opId !== op.opId));
        if (note) toast.message(note);
      });
      if (sent) return;
      setLocalQueue((q) => queueReducer(q, { type: "take", id }));
      const files = queuedFiles.current.get(id) ?? [];
      queuedFiles.current.delete(id);
      void actions.steer(row.text, files);
    },
    rollback: useEnv
      ? async (checkpointId) => {
          if (!env.client || !env.view) return false;
          try {
            await env.client.request("checkpoint.rollback", { sessionId: env.view.id, checkpointId });
            return true;
          } catch (e) {
            // Said, not swallowed: Edit and Retry stop here rather than send over the old files.
            toast.error(e instanceof Error && e.message ? e.message : "Could not restore that checkpoint on your Mac.");
            return false;
          }
        }
      : undefined,
    // Retry and the error row's Retry: the turn's own message again (with its attachments on a Mac thread).
    async resend(message) {
      if (useEnv && env.client) {
        const sessionId = await ensureEnvSession();
        return env.client.request("turn.start", {
          sessionId,
          input: { text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}) },
          selection,
          routing: effectiveRouting.preset === "solo" ? undefined : effectiveRouting,
          runtimeMode,
          interactionMode,
        });
      }
      return sendLegacy(message.text);
    },
    feedbackFor: (turnId) => feedback.get(turnId),
    setFeedback: (turnId, value) => feedback.set(turnId, value),
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
    // The session menu (session-actions.tsx): the same verbs as the sidebar row's menu.
    renameThread: (title) => sessionActions.rename(conversation.id, title),
    pinThread: (pinned) => sessionActions.setPinned(conversation.id, pinned),
    shareThread: () => sessionActions.requestShare(conversation.id),
    archiveThread: () => sessionActions.archive(conversation.id),
    deleteThread: () => sessionActions.requestDelete(conversation.id),
  };

  /*
   * The /code landing's first prompt. The landing leaves it in sessionStorage
   * (with its Skills choice as this thread's selection and an armed `/name` in
   * front of the text); only the legacy view used to read it, so a run on a
   * Mac opened here never sent its task. Sent once, when the thread knows where
   * it runs; cleared once accepted (lib/code-v2/first-prompt.ts).
   */
  const latest = React.useRef({ actions, skills, sendLegacy, publishChoices });
  latest.current = { actions, skills, sendLegacy, publishChoices };
  // Re-renders when the first prompt's send settles (the hand-off is not React state).
  const [, settled] = React.useReducer((n: number) => n + 1, 0);
  /** The first prompt once the run took it, until its own turn shows up in the transcript. */
  const [firstEcho, setFirstEcho] = React.useState<PendingFirstPrompt<ClientAttachment> | null>(null);
  const handoff = React.useMemo(
    () =>
      createFirstPromptHandoff<ClientAttachment>({
        // The landing's words AND its attachments: a prompt that is only files is a prompt (G02).
        peek: () => peekPendingCodePrompt(conversation.id),
        clear: () => clearPendingCodePrompt(conversation.id),
        arm: (skill) => latest.current.skills.arm(skill),
        async send(route, text, attachments) {
          const result = route === "env" ? await latest.current.actions.send(text, attachments) : (await latest.current.sendLegacy(text, attachments)).accepted;
          // `false` from the env path: a file could not reach the Mac, and the
          // composer now holds the words and files, so a reload must not send
          // them again. With no composer to hold them, the hand-off keeps them.
          if (route === "env" && result === false && draftIo.current?.restore) clearPendingCodePrompt(conversation.id);
          const accepted = !!result;
          if (accepted) {
            setFirstEcho({ text, attachments });
            // The landing's model and mode become this thread's on every device.
            latest.current.publishChoices({});
          }
          return accepted;
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Could not send your first message. It is kept for when you reload."),
      }),
    [conversation.id],
  );
  const [landingSkillIds] = React.useState<string[]>(() => (typeof window === "undefined" ? [] : (readJson<string[]>(skillsStorageKey(conversation.id)) ?? [])));
  const firstPromptGate = {
    metaLoaded: meta.loaded,
    isCloud: meta.isCloud,
    envReady: env.ready && !!env.client,
    envProbed: env.probed,
    legacyTarget: !!presence.device && presence.state === "online" && !!cwd,
    skillsLoaded: skills.choices !== null && !skills.loading,
    // The landing's model must be one this thread lists before its first turn goes.
    selectionReady: !awaitingDevice && selectionListed,
  };
  React.useEffect(() => {
    const pending = handoff.pending();
    if (!pending) return;
    // The `/name` and the account skills' instructions need the list.
    if (firstPromptGate.envReady && firstPromptNeedsSkills(pending.text, landingSkillIds)) latest.current.skills.load();
    const sending = handoff.tick(firstPromptGate, skills.choices ?? [], landingSkillIds);
    if (sending) void sending.then(settled, settled);
  });

  /*
   * The first prompt is on screen from the first paint: the task the reader
   * just wrote, as the thread's first turn, with "Starting on <Mac>" under it
   * while the Mac link connects. It used to be an empty state, as if the task
   * had been lost, until the run answered.
   */
  const [openedAt] = React.useState(() => new Date().toISOString());
  const firstShown = handoff.showing() ?? (items.length === 0 ? firstEcho : null);
  const firstItems: TurnItem[] | null =
    firstShown && items.length === 0
      ? [{ id: "first-prompt", turnId: "first-prompt", kind: "user_message", text: firstShown.text, attachments: firstShown.attachments.map(previewAttachment), createdAt: openedAt, delivery: "send" }]
      : null;
  const firstWaiting = !!firstItems && !(!meta.isCloud && presence.state === "offline");

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
      // The app's copy first: a rename (here or from the sidebar) shows at once.
      title: conversations.find((c) => c.id === conversation.id)?.title || conversation.title || "Code session",
      repo: meta.repoOwner && meta.repoName ? `${meta.repoOwner}/${meta.repoName}` : (conversation.codeWorkspaceName ?? "Code session"),
      branch: meta.branch ?? undefined,
      cwd,
      pinned,
    },
    items: firstItems ?? items,
    // Paging belongs to the CodeTask transcript; the env server's view arrives whole.
    history: useEnv && env.view ? undefined : { hasOlder: session.history.hasOlder, loading: session.loadingOlder, loadOlder: session.loadOlderMessages },
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
    starting: firstWaiting || (meta.loaded && session.status === "submitting") ? (meta.isCloud ? CLOUD_STARTING_LABEL : `Starting on ${presence.device?.name ?? "your Mac"}…`) : null,
    offline: !meta.isCloud && presence.state === "offline",
    pairingRequired: env.pairingRequired && device ? { deviceName: device.name } : null,
    // The account's skills work anywhere; a Mac adds its own.
    skills,
    draft: draftChannel,
    canAttach: features.storage,
    uploadConversationId: conversation.id,
    ...(useEnv ? { attachmentMaxBytes: MAC_ATTACHMENT_MAX_BYTES } : {}),
    selectionPending: awaitingDevice && !selectionListed,
    actions,
  };

  return (
    <>
      <CodeWorkspace
        model={model}
        sidebar={false}
        byok={byok}
        resolveScreenshot={resolveScreenshot}
        // Never over a task the landing just sent: the Connections sheet used to open as the first prompt went.
        firstRun={!instances.some((i) => i.kind !== "alevr" && (i.status === "ready" || i.status === "limited")) && !keys.length && items.length === 0 && !firstItems && !handoff.pending()}
        onProbe={env.ready ? env.probe : undefined}
        onRefreshSubscriptions={env.refreshSubscriptions}
        onManaged={
          env.ready && env.client
            ? (instanceId, op) => {
                if (!env.client) throw new Error("Your Mac is not connected.");
                return managedCall(env.client, instanceId, op);
              }
            : undefined
        }
        onSetup={async (instance, action) => {
          const managed = managedSetup(instance, action);
          if (managed && env.client) {
            if (managed.type === "provider.install") await env.client.request("provider.install", managed.params);
            else await env.client.request("provider.auth", managed.params);
            return;
          }
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
      {sessionActions.ui}
    </>
  );
}
