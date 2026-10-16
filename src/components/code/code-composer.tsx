"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import "@/components/code/v2/code-v2.css";
import {
  CodeEnvironmentChip,
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import { Composer, type ComposerHandle, type PopoverName } from "@/components/code/v2/composer";
import { rememberComposerOrigin } from "@/components/code/v2/composer-travel";
import type { DraftChannel, WorkspaceModel } from "@/components/code/v2/types";
import { useEnvLink } from "@/components/code/v2/use-env-link";
import { useDevicePresence } from "@/components/code/code-session-meta";
import { useApp } from "@/components/app/app-provider";
import { openSettings } from "@/components/settings/settings-sections";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import {
  CLOUD_RUNTIME_APPROVALS,
  applyComposerMode,
  cloudPermissionMode,
  composerModeInfo,
  composerModeOf,
  landingMode,
  projectModeKey,
  seededThreadPrefs,
  threadPrefsKey,
  type ComposerMode,
} from "@/lib/code-v2/composer-mode";
import { codeProviderModels } from "@/lib/code-v2/code-models";
import { createByokClient, type ByokKeyRecord } from "@/lib/code-v2/byok-client";
import { buildInstances, reconcileSelection } from "@/lib/code-v2/workspace-instances";
import { MAC_ATTACHMENT_MAX_BYTES, attachmentsOnlyTitle } from "@/lib/code-v2/composer-attachments";
import { codeDraftKey } from "@/lib/code-v2/thread-prefs";
import type { ModelSelection, ProviderInstance, ProviderModel, RoleRouting } from "@/lib/code-v2/contracts";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import type { CodePrefill, CodePrefillNote } from "@/lib/code-prefill";
import { cn } from "@/lib/utils";
import { CODE_COMPOSER_SEED_EVENT } from "@/components/code/code-seed";
import { seedThreadSkills, useLandingSkills } from "@/components/code/code-landing-skills";
import type { ClientAttachment, ClientConversation } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";
/** The landing's model choice, in the v2 shape (instance, model, effort, tier). */
const SELECTION_KEY = "alevr.code.landing.selection";
/** What the landing stored before it shared the session's composer: an Alevr model id and an effort. */
const LEGACY_MODEL_KEY = "juno:code:model";
const LEGACY_EFFORT_KEY = "juno:code:reasoning";

/**
 * What `GET /api/code/cloud-runner` says. `null` while unasked or in flight;
 * a not-ready answer carries the sentence the server wants shown.
 */
type CloudReadiness = { ready: true } | { ready: false; message: string } | null;

function readStoredJson<T = Record<string, unknown>>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeStoredJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a per-viewer convenience */
  }
}

/** The landing's stored selection, or the older Alevr model id and effort it replaced. */
function storedSelection(): ModelSelection | null {
  const stored = readStoredJson<ModelSelection>(SELECTION_KEY);
  if (stored?.instanceId && stored.model) return stored;
  try {
    const model = localStorage.getItem(LEGACY_MODEL_KEY);
    const effort = localStorage.getItem(LEGACY_EFFORT_KEY);
    if (model) return { instanceId: "alevr", model, ...(effort ? { effort: effort as ModelSelection["effort"] } : {}) };
  } catch {
    /* storage blocked: the default model */
  }
  return null;
}

/**
 * WHAT A LINK ASKED FOR AND THIS COMPOSER DID NOT DO.
 *
 * `src/lib/code-prefill.ts` decides; this writes the sentence, because the
 * sentences are user-facing copy and the parser is a pure module the tests
 * read. Every one of them says what happened AND what the composer is doing
 * instead, since the person reading arrived from somewhere else and did not
 * write the link: "it was ignored" tells them nothing they can act on.
 */
const PREFILL_NOTES: Record<CodePrefillNote, string> = {
  multiple_repositories:
    "That link named more than one repository, and a session runs in one — pick the one you meant.",
  invalid_repository: "That link’s repository wasn’t a readable owner/name, so none is picked.",
  invalid_branch:
    "That link’s branch wasn’t a usable git ref, so it was dropped — the run starts from the default branch of whichever repository is picked.",
  branch_without_repository: "That link named a branch but no repository, so pick the repository it belongs to.",
  prompt_truncated: "That link’s text was too long to carry whole — what fits is in the field.",
  environment_unsupported:
    "That link named an environment. Nothing here chooses one yet, so this run gets the default.",
};

const PICK_PROJECT_LABEL = "Pick a project to start";
const PICK_REPOSITORY_LABEL = "Pick a repository to start";
const STARTING_LABEL = "Starting…";
const START_FAILED_MESSAGE = "Couldn’t start the session. Check your connection and try again.";

/** What the composer hands its draft channel: how to read, replace and give back its words and files. */
type DraftIo = Parameters<DraftChannel["attach"]>[0];

const NOOP = () => undefined;

/*
 * THE CODE COMPOSER — the whole of what `/code` is, under the greeting.
 *
 * ONE COMPOSER FROM LANDING TO SESSION (G58). This used to be its own box
 * (the chat composer's shell and model menu) and the session drew another (the
 * v2 composer), so the composer changed shape after the first send, and your
 * Claude or ChatGPT subscription, your keys and Team only appeared once a
 * session existed. The landing now mounts the session's `Composer` in its
 * `landing` variant: the same field, `+` (files, photos, a screenshot, the
 * library), the same model picker with every provider (pickers.tsx), Team,
 * the mode, skills, dictation and voice. What only a landing has sits around
 * it: the tray above (where it runs, which project) and one line under.
 *
 * THE FIRST TURN HONOURS ALL OF IT (G02). The model (instance, model, effort,
 * context tier), the mode and the team are written as the new thread's
 * prefs, the attachments ride the hand-off with the words, and a prompt that
 * is only attachments is a prompt. A run on a Mac goes straight to
 * /code/{id} (it used to hop through /chat/{id}); a cloud run carries its
 * model, effort and mode on the task itself.
 *
 * ONE line survives under the box, and only when there is something true to
 * say: a cloud runner this server does not have, or a part of a link that did
 * not apply; otherwise the chosen mode, in one sentence.
 */
export function CodeComposer({
  className,
  prefill,
}: {
  className?: string;
  /**
   * What the query string asked for, parsed on the server (`/code` reads it;
   * src/lib/code-prefill.ts carries the rules). It fills this composer and
   * never submits it — see the landing's docblock for why a Code link may not
   * do what `/chat?q=` does.
   */
  prefill?: CodePrefill;
}) {
  const router = useRouter();
  const { upsertConversation, removeConversation, features } = useApp();
  const composer = React.useRef<ComposerHandle>(null);
  const stack = React.useRef<HTMLDivElement>(null);

  /*
   * The landing's draft is kept in this tab only (nothing to sync before a
   * thread exists). The composer clears it as the send leaves, so a start that
   * fails gives the words and files back through `restore` instead of losing them.
   */
  const draftIo = React.useRef<DraftIo | null>(null);
  const landingDraft = React.useMemo<DraftChannel>(
    () => ({
      key: codeDraftKey(null),
      attach: (io) => {
        draftIo.current = io;
        return () => {
          if (draftIo.current === io) draftIo.current = null;
        };
      },
      changed: NOOP,
      cleared: NOOP,
    }),
    [],
  );

  // —— Target (Device ⇄ Cloud) ——
  // A link naming a repository lands on Cloud whatever the saved preference is:
  // a GitHub repository is not something a Mac session can be pointed at, so
  // restoring "Device" here would leave the picked repository visible on a
  // machine that cannot run it.
  const [target, setTarget] = React.useState<Target>(prefill?.repo ? "cloud" : "device");
  const prefilledCloud = !!prefill?.repo;
  React.useEffect(() => {
    if (prefilledCloud) return;
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, [prefilledCloud]);

  const cloudConversationId = React.useRef<string | null>(null);

  const discardOrphanCloudSession = React.useCallback(() => {
    const id = cloudConversationId.current;
    if (!id) return;
    cloudConversationId.current = null;
    removeConversation(id);
    void fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  }, [removeConversation]);

  const switchTarget = React.useCallback(
    (next: Target) => {
      setTarget(next);
      if (next !== "cloud") discardOrphanCloudSession();
      try {
        localStorage.setItem(TARGET_KEY, next);
      } catch {}
    },
    [discardOrphanCloudSession],
  );

  /*
   * WHETHER A CLOUD RUN CAN START, asked once the Cloud target is chosen.
   *
   * The server probes for its runner workflow before it creates any task, and
   * a missing one used to surface only as a 503 on the submit. Asking here
   * puts the same sentence under the composer before the reader has written
   * anything — a quiet note, not a modal, because the Device target one chip
   * away still works.
   */
  const [cloudReadiness, setCloudReadiness] = React.useState<CloudReadiness>(null);
  React.useEffect(() => {
    if (target !== "cloud" || cloudReadiness) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/code/cloud-runner", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { ready?: boolean; message?: string };
        if (cancelled) return;
        setCloudReadiness(
          data.ready
            ? { ready: true }
            : { ready: false, message: data.message ?? "Cloud runs aren’t enabled on this server yet." },
        );
      } catch {
        // Unknown stays unknown; the submit path says what the server says.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, cloudReadiness]);
  const cloudBlocked = target === "cloud" && cloudReadiness?.ready === false ? cloudReadiness : null;

  // —— Workspace / Repository Selection ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");
  // Skills lane: the run starts under the skills chosen here: the account's,
  // and the Mac's and project's (a run on a Mac) or the repository's (a cloud run).
  const landingSkills = useLandingSkills(
    target === "device" ? selectedWorkspace : null,
    target === "cloud" && selectedRepo ? { owner: selectedRepo.owner, name: selectedRepo.name, ref: baseRef || null } : null,
  );

  /*
   * —— Turning `?repositories=owner/name` into a picked repository ——
   *
   * The chip needs a whole `CloudRepo` — the default branch above all, because
   * it is what the chip shows and what the run uses when no base is chosen —
   * and a link carries two path segments. So the composer asks the one route
   * that answers "tell me about this repository"
   * (`/api/code/github/branches`), which is the same probe the branch list
   * makes, rather than waiting for the hundred-repository list inside the
   * picker and hoping the named one is on it.
   *
   * A failure is a sentence, not a silence, and it runs once: the link is an
   * opening position, not a setting.
   */
  const [prefillProblem, setPrefillProblem] = React.useState<string | null>(null);
  const appliedPrefill = React.useRef(false);
  React.useEffect(() => {
    const wanted = prefill?.repo;
    if (!wanted || appliedPrefill.current) return;
    appliedPrefill.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/code/github/branches?repo=${encodeURIComponent(wanted.fullName)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
          setPrefillProblem(
            err === "github_not_connected" || err === "github_unauthorized"
              ? `Connect GitHub in Connections to open ${wanted.fullName}.`
              : err === "repo_not_found"
                ? `Your GitHub connection can’t see ${wanted.fullName}, so no repository is picked.`
                : `Couldn’t reach GitHub to open ${wanted.fullName}. Pick a repository to start.`,
          );
          return;
        }
        const data = (await res.json()) as { repo?: CloudRepo; branches?: string[] };
        if (cancelled || !data.repo) return;
        setSelectedRepo(data.repo);
        const ref = prefill?.baseRef;
        if (!ref || ref === data.repo.defaultBranch) return;
        // Applied either way — a base ref is legitimately a tag or a commit,
        // which no branch list contains — but a ref that is not a branch is
        // said out loud, because the alternative is a run that fails at `git
        // clone` for a typo nobody was shown.
        setBaseRef(ref);
        if (!data.branches?.includes(ref)) {
          setPrefillProblem(
            `${ref} isn’t a branch of ${data.repo.fullName}; the run starts from it as a tag or commit, and a pull request would target ${data.repo.defaultBranch}.`,
          );
        }
      } catch {
        if (!cancelled) setPrefillProblem(`Couldn’t reach GitHub to open ${wanted.fullName}.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefill]);

  // —— Providers: Alevr's coding models, your keys, and the Mac's subscriptions ——
  // The same rail the session offers (G58: Team, subscriptions and keys used to
  // appear only once a session existed). A Mac run asks the chosen project's
  // Mac for its runtimes; a cloud run offers Alevr's models, as its runner does.
  const { presence } = useDevicePresence(
    selectedWorkspace?.key ?? null,
    selectedWorkspace?.name ?? null,
    target === "device" && !!selectedWorkspace,
  );
  const mac = target === "device" && presence.device && presence.state === "online" ? { id: presence.device.id, online: true } : null;
  const env = useEnvLink(mac, null);
  const byok = React.useMemo(() => createByokClient(), []);
  const [keys, setKeys] = React.useState<ByokKeyRecord[]>([]);
  React.useEffect(() => {
    byok.list().then(setKeys).catch(() => undefined);
  }, [byok]);
  const hasOpenRouter = keys.some((k) => k.provider === "openrouter" && !k.invalid);
  const [openRouterModels, setOpenRouterModels] = React.useState<ProviderModel[]>([]);
  React.useEffect(() => {
    if (!hasOpenRouter) return;
    byok.models("openrouter").then(setOpenRouterModels).catch(() => undefined);
  }, [byok, hasOpenRouter]);
  const alevrModels = React.useMemo(() => codeProviderModels(), []);
  const instances = React.useMemo<ProviderInstance[]>(() => {
    if (target === "cloud") {
      // A cloud sandbox enforces Plan, Accept edits and Full access, and runs Alevr's models.
      return buildInstances({ alevrModels }).map((i) => ({ ...i, capabilities: i.capabilities ? { ...i.capabilities, approvals: [...CLOUD_RUNTIME_APPROVALS] } : i.capabilities }));
    }
    return buildInstances({ alevrModels, deviceInstances: env.instances, byokKeys: keys, openRouterModels });
  }, [target, alevrModels, env.instances, keys, openRouterModels]);

  // —— The model: instance, model, effort and context tier, one selection ——
  const [chosen, setChosen] = React.useState<ModelSelection | null>(null);
  React.useEffect(() => setChosen((c) => c ?? storedSelection()), []);
  const awaitingMac = !!mac && !env.probed;
  const selection = reconcileSelection(instances, chosen, { awaitingDevice: awaitingMac });
  const choose = React.useCallback((next: ModelSelection) => {
    setChosen(next);
    writeStoredJson(SELECTION_KEY, next);
  }, []);

  // —— Team (a Mac run; the session keeps it on the server) ——
  const [routing, setRouting] = React.useState<RoleRouting>(() => ({ preset: "solo", orchestrator: selection }));
  const effectiveRouting = React.useMemo<RoleRouting>(() => ({ ...routing, orchestrator: selection }), [routing, selection]);

  // —— Mode (per project, remembered) ——
  const modeProjectKey = projectModeKey(
    target === "device" ? (selectedWorkspace?.key ?? selectedWorkspace?.path ?? null) : (selectedRepo?.fullName ?? null),
  );
  const [mode, setMode] = React.useState<ComposerMode>(() => landingMode(target, null));
  /** What a send reads: set at once by `/plan`, a render before the state lands. */
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  React.useEffect(() => {
    setMode(landingMode(target, modeProjectKey ? readStoredJson(modeProjectKey) : null));
  }, [target, modeProjectKey]);
  const chooseMode = React.useCallback(
    (next: ComposerMode) => {
      modeRef.current = next;
      setMode(next);
      if (modeProjectKey) writeStoredJson(modeProjectKey, applyComposerMode(next, "auto-edit"));
    },
    [modeProjectKey],
  );
  const pair = applyComposerMode(mode, "auto-edit");

  /** A new thread starts on the landing's mode AND model (the v2 route reads these prefs). */
  const seedThreadMode = React.useCallback(
    (conversationId: string) => {
      const key = threadPrefsKey(conversationId);
      writeStoredJson(key, seededThreadPrefs(readStoredJson(key), modeRef.current, { selection }));
    },
    [selection],
  );

  // —— Submission ——
  const [submitting, setSubmitting] = React.useState(false);
  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;

  /** Leaves for the new session, after noting where the box stood (it travels to the dock). */
  const openSession = React.useCallback(
    (conversationId: string) => {
      rememberComposerOrigin(stack.current?.querySelector(".cv2-composer"));
      router.push(`/code/${conversationId}`);
    },
    [router],
  );

  const startDevice = React.useCallback(
    async (w: Workspace, text: string, attachments: ClientAttachment[]): Promise<boolean> => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "code",
          codeWorkspaceName: w.name,
          codeWorkspacePath: w.path,
          codeWorkspaceKey: w.key ?? undefined,
          ...(selection.instanceId === "alevr" ? { model: selection.model } : {}),
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      seedThreadMode(conversation.id);
      if (routing.preset !== "solo") {
        await fetch(`/api/code/routing/${conversation.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routing: effectiveRouting }),
        }).catch(() => undefined);
      }
      setPendingCodePrompt(conversation.id, seedThreadSkills(landingSkills, conversation.id, text), attachments);
      upsertConversation({ ...conversation, ...(selection.instanceId === "alevr" ? { model: selection.model } : {}) });
      openSession(conversation.id);
      return true;
    },
    [effectiveRouting, landingSkills, openSession, routing.preset, seedThreadMode, selection, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null, attachments: ClientAttachment[]): Promise<boolean> => {
      let conversation: ClientConversation | null = null;
      const model = selection.model;
      if (!cloudConversationId.current) {
        const cRes = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "code",
            codeWorkspaceName: repo.name,
            codeWorkspacePath: `${repo.owner}/${repo.name}`,
            model,
          }),
        });
        if (!cRes.ok) throw new Error("conversation");
        conversation = ((await cRes.json()) as { conversation: ClientConversation }).conversation;
        cloudConversationId.current = conversation.id;
      }
      const conversationId = cloudConversationId.current;
      const attachmentIds = attachments.map((a) => a.id);
      // The thread keeps the landing's selection (its composer shows it); a
      // `/name` armed here is this first run's only.
      seedThreadSkills(landingSkills, conversationId, text);
      seedThreadMode(conversationId);
      const cloudSkills = landingSkills.takeCloud();
      const titleFallback = text.slice(0, 60) || attachmentsOnlyTitle(attachments.length);
      const mode = modeRef.current;

      const tRes = await fetch("/api/code/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "cloud",
          repo: { owner: repo.owner, name: repo.name },
          baseRef: ref ?? undefined,
          prompt: text,
          title: titleFallback,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
          conversationId,
          // This composer's model and effort, reaching the run.
          model,
          reasoningEffort: selection.effort && selection.effort !== "none" ? selection.effort : undefined,
          // And its mode, as far as a cloud sandbox can enforce one.
          permissionMode: cloudPermissionMode(mode) ?? undefined,
          // And its skills: account ones by id, the repository's by name.
          skills: cloudSkills,
        }),
      });

      if (tRes.ok) {
        if (conversation) {
          upsertConversation({ ...conversation, title: titleFallback.slice(0, 48), titleSource: "manual", model });
        }
        openSession(conversationId);
        return true;
      }

      const payload = (await tRes.json().catch(() => ({}))) as { error?: string; message?: string };
      const err = payload.error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        // The server says why, in a sentence written to be shown. Nothing was
        // created server-side, so the conversation this composer made is an orphan.
        setCloudReadiness({ ready: false, message: payload.message ?? "Cloud runs aren’t enabled on this server yet." });
        discardOrphanCloudSession();
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        /*
         * The task and the user's turn exist and are marked failed, and the
         * conversation shows them. Take the reader there rather than keeping an
         * orphan here with a "Try again" that would stack a second failed task
         * into the same conversation.
         */
        toast.error(payload.message ?? "Couldn’t start the cloud run — this is usually temporary.");
        if (conversation) upsertConversation({ ...conversation, title: titleFallback.slice(0, 48), titleSource: "manual", model });
        cloudConversationId.current = null;
        openSession(conversationId);
        return true;
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
        discardOrphanCloudSession();
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
        discardOrphanCloudSession();
      } else {
        // Anything else: say what the SERVER said, when it said something.
        const sentence =
          payload.message?.trim() ||
          (err && /\s/.test(err) ? err : "") ||
          "Couldn’t start the cloud run. Check your connection and try again.";
        toast.error(sentence);
        discardOrphanCloudSession();
      }
      return false;
    },
    [discardOrphanCloudSession, landingSkills, openSession, seedThreadMode, selection, upsertConversation],
  );

  /** The composer's send: words, attachments or both start the session. */
  const submit = React.useCallback(
    async (rawText: string, attachments: ClientAttachment[] = []): Promise<boolean> => {
      const text = rawText.trim();
      if ((!text && attachments.length === 0) || submitting) return false;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return false;
      if (cloudBlocked) return false;
      setSubmitting(true);
      let started = false;
      try {
        if (target === "device" && selectedWorkspace) started = await startDevice(selectedWorkspace, text, attachments);
        else if (target === "cloud" && selectedRepo) started = await startCloud(selectedRepo, text, baseRef.trim() || null, attachments);
      } catch {
        toast.error(START_FAILED_MESSAGE);
      } finally {
        setSubmitting(false);
      }
      // Not started: the words and files go back where they were typed (the failure was already said).
      if (!started) draftIo.current?.restore?.(rawText, attachments);
      return started;
    },
    [submitting, target, selectedWorkspace, selectedRepo, cloudBlocked, baseRef, startDevice, startCloud],
  );

  // A starting point under the landing seeds the field (code-starting-points):
  // the text lands with the caret at its end, and nothing is sent.
  React.useEffect(() => {
    const onSeed = (event: Event) => {
      const text = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null;
      if (!text || submitting) return;
      composer.current?.setDraft(text);
    };
    window.addEventListener(CODE_COMPOSER_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CODE_COMPOSER_SEED_EVENT, onSeed);
  }, [submitting]);

  React.useEffect(() => {
    requestAnimationFrame(() => composer.current?.focus());
  }, []);

  const [popover, setPopover] = React.useState<PopoverName>(null);
  const gateHint = !hasTarget ? (target === "device" ? PICK_PROJECT_LABEL : PICK_REPOSITORY_LABEL) : null;

  /*
   * One line for everything the link asked for and did not get — the parser's
   * refusals first, then whatever GitHub said about the repository it named.
   */
  const prefillMessage = React.useMemo(() => {
    const parts = (prefill?.notes ?? []).map((note) => PREFILL_NOTES[note]);
    if (prefillProblem) parts.push(prefillProblem);
    return parts.join(" ") || null;
  }, [prefill, prefillProblem]);

  const landingModel: WorkspaceModel = {
    thread: {
      id: "new",
      title: "New session",
      repo: target === "device" ? (selectedWorkspace?.name ?? "") : (selectedRepo?.fullName ?? ""),
      branch: target === "cloud" && selectedRepo ? baseRef.trim() || selectedRepo.defaultBranch : undefined,
      cwd: target === "device" ? selectedWorkspace?.path : undefined,
    },
    items: [],
    state: "idle",
    queue: [],
    instances,
    selection,
    routing: effectiveRouting,
    runtimeMode: pair.runtimeMode,
    interactionMode: pair.interactionMode,
    // The voice briefing says where this runs.
    device: target === "device" ? { id: presence.device?.id ?? "", name: presence.device?.name ?? "your Mac", online: presence.state === "online" } : null,
    byokKeys: keys,
    skills: landingSkills,
    starting: submitting ? STARTING_LABEL : null,
    draft: landingDraft,
    canAttach: features.storage,
    uploadConversationId: null,
    // A Mac running the env server gets its files over the device link (4 MB each).
    ...(target === "device" && env.ready ? { attachmentMaxBytes: MAC_ATTACHMENT_MAX_BYTES } : {}),
    selectionPending: awaitingMac && !instances.some((i) => i.id === selection.instanceId),
    actions: {
      send: (text, attachments) => submit(text, attachments ?? []),
      queue: NOOP,
      steer: NOOP,
      stop: NOOP,
      respond: NOOP,
      setSelection: choose,
      setRouting,
      setRuntimeMode: (runtimeMode) => chooseMode(composerModeOf(runtimeMode, pair.interactionMode)),
      setInteractionMode: (interactionMode) => chooseMode(composerModeOf(pair.runtimeMode, interactionMode)),
      setModes: (next) => chooseMode(composerModeOf(next.runtimeMode, next.interactionMode)),
      editQueued: NOOP,
      removeQueued: NOOP,
      moveQueued: NOOP,
      steerQueued: NOOP,
      openConnections: () => openSettings("connections"),
    },
  };

  /*
   * NOTHING UNDER THE FIELD UNLESS IT IS TRUE AND NO CHIP SAYS IT: this server
   * has no cloud runner (said quietly, with the way to your Mac), or the link
   * that opened this composer asked for something that did not happen, or else
   * the chosen mode in one sentence. Never two at once.
   */
  const under = cloudBlocked ? (
    <p role="status" className="mt-2.5 flex items-start justify-center gap-1.5 px-1 text-caption text-muted-foreground motion-safe:animate-fade-in">
      <CodeIcons.cloud className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {cloudBlocked.message}{" "}
        <button
          type="button"
          onClick={() => switchTarget("device")}
          className="rounded-xs font-medium text-foreground underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-primary motion-reduce:transition-none"
        >
          Run on your Mac instead
        </button>
        .
      </span>
    </p>
  ) : prefillMessage ? (
    <p role="status" className="mt-2.5 flex items-start justify-center gap-1.5 px-1 text-caption text-muted-foreground motion-safe:animate-fade-in">
      <StatusIcons.info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{prefillMessage}</span>
    </p>
  ) : (
    <p aria-live="polite" className="mt-2.5 px-5 text-caption text-muted-foreground">
      <span className="font-medium text-foreground/80">{composerModeInfo(mode).label}</span> {composerModeInfo(mode).description}
    </p>
  );

  return (
    <div className={cn("relative isolate w-full", className)}>
      {/* The tray (owner, 2026-10-03): where this runs and which project, as
          chips on a shelf tucked under the composer's top edge. Everything
          else is on the composer's own row, exactly as in the session. */}
      <div className="composer-tray composer-tray--top">
        <div className="composer-tray__row">
          <CodeEnvironmentChip target={target} onTargetChange={switchTarget} disabled={submitting} />
          <CodeTargetPicker
            target={target}
            selectedWorkspace={selectedWorkspace}
            onSelectWorkspace={setSelectedWorkspace}
            selectedRepo={selectedRepo}
            onSelectRepo={(r) => {
              setSelectedRepo(r);
              setBaseRef("");
              if (r.fullName !== selectedRepo?.fullName) discardOrphanCloudSession();
            }}
            baseRef={baseRef}
            onBaseRefChange={setBaseRef}
            disabled={submitting}
          />
        </div>
      </div>
      <div className="cv2 cv2-landing">
        <Composer
          ref={composer}
          variant="landing"
          model={landingModel}
          popover={popover}
          setPopover={setPopover}
          approvalIndex={0}
          setApprovalIndex={NOOP}
          onOpenDock={NOOP}
          tall
          gate={cloudBlocked?.message ?? gateHint}
          team={target === "device"}
          initialDraft={prefill?.prompt ?? ""}
          under={under}
          stackRef={stack}
        />
      </div>
    </div>
  );
}
