"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mic } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerChipClass,
  composerFieldClass,
  composerIconButtonClass,
  useComposerAutosize,
} from "@/components/ui/composer-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import {
  CodeEnvironmentChip,
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import {
  ComposerAddMenu,
  ComposerAttachmentTray,
  ComposerDropOverlay,
  ComposerFileInputs,
} from "@/components/code/code-composer-parts";
import { useCodeVoice, useCodeVoiceCall, type CodeVoiceSend } from "@/components/code/code-voice";
import { VoiceComposerGlow } from "@/components/voice/voice-composer-glow";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import {
  CLOUD_RUNTIME_APPROVALS,
  COMPOSER_MODES,
  applyComposerMode,
  availableComposerModes,
  cloudPermissionMode,
  composerModeInfo,
  landingMode,
  projectModeKey,
  seededThreadPrefs,
  threadPrefsKey,
  type ComposerMode,
} from "@/lib/code-v2/composer-mode";
import { Icon } from "@/components/ui/juno-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import { defaultReasoning, reasoningOptions, type ReasoningEffort } from "@/lib/model-metrics";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import type { CodePrefill, CodePrefillNote } from "@/lib/code-prefill";
import { cn } from "@/lib/utils";
import { CODE_COMPOSER_SEED_EVENT } from "@/components/code/code-seed";
import type { ClientAttachment, ClientConversation } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";

const TARGET_KEY = "juno:code:new:target";
const MODEL_KEY = "juno:code:model";
const EFFORT_KEY = "juno:code:reasoning";

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

/**
 * THE MODE: how much this run may do without asking, the same five rungs as
 * every Code composer (Ask, Accept edits, Auto, Plan, Full access), each with
 * its one line. A real choice on both targets: a cloud run carries it as
 * `CodeTask.permissionMode` (Plan, Accept edits, Full access, which is all its
 * sandbox can enforce), and a run on a Mac starts its thread on it (the v2
 * route's per-thread prefs). The project remembers the last one chosen.
 */
function ModeChip({
  target,
  mode,
  onChange,
  disabled,
}: {
  target: Target;
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const info = composerModeInfo(mode);
  const modes = target === "cloud" ? availableComposerModes(CLOUD_RUNTIME_APPROVALS, true) : COMPOSER_MODES;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Mode: ${info.label}. What this run may do without asking`}
          data-mode={mode}
          className={cn(composerChipClass, "max-w-full")}
        >
          <Icon name={info.glyph} size={14} />
          <span className="min-w-0 truncate">{info.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} collisionPadding={12} className="w-80 p-1.5">
        <div role="menu" aria-label="Mode">
          {modes.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === mode}
              onClick={() => {
                onChange(m.mode);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-xs px-2.5 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <Icon name={m.glyph} size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-foreground">{m.label}</span>
                <span className="block text-caption leading-snug text-muted-foreground">{m.description}</span>
              </span>
              <Icon name="check" size={14} className={cn("mt-1 shrink-0", m.mode === mode ? "opacity-100" : "opacity-0")} />
            </button>
          ))}
          {target === "cloud" && (
            <p className="px-2.5 pb-1.5 pt-1 text-caption text-muted-foreground">
              A cloud run works in a sandbox and opens a pull request, so it offers Plan, Accept edits and Full access.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
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

/*
 * THE CODE COMPOSER — the whole of what `/code` is, under the greeting.
 *
 * It used to be page-local JSX inside `/code/new`: the field, the target
 * picker, the model chip, the effort control and both submit paths written
 * straight into a route, so nothing else in the product could mount them. That
 * mattered the moment Code stopped having a list page to land on
 * (docs/design/TWO_PRODUCTS.md §3) — the landing needs this box, and a route
 * cannot be rendered inside another route.
 *
 * THE SHAPE, and where each part of it comes from:
 *
 *   above     the two facts a run needs before it can start — which machine,
 *             which checkout — as chips on their own row, plus the staged
 *             attachments under them
 *   field     "Describe a task or ask a question"
 *   leading   `+` · dictate · voice · the permission chip
 *   trailing  the model chip, with thinking effort inside its popover
 *   action    send ⇄ busy — the one circle, and the run's status while it
 *             starts
 *
 * Effort is inside the model popover rather than beside it because FLAT_UI.md
 * §4 says so and because every other composer in the product already puts it
 * there; a row that shows every option at once reads as a settings panel and
 * the field above it stops being the point.
 *
 * WHAT IS NOT HERE. The seed-prompt chips are gone with the list page that
 * offered them — on a composer pinned to the bottom of the column there is no
 * room under the field for a second set of things to press, and the greeting
 * above it is the invitation. The footer caption that spelled out where a run
 * happens is gone too: the chips say it, and the permission chip says what it
 * means. ONE line survives under the field, and only when there is something
 * true to say: a cloud runner this server does not have, or — since a link can
 * open this composer with the task already written — a part of that link that
 * did not apply. Never both at once, and never a third.
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
  const { settings, upsertConversation, removeConversation, features } = useApp();

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
   * A failure is a sentence, not a silence. The reader did not write this link:
   * if the repository cannot be opened they need to know that is why the chip
   * still says "Pick a repository", and each refusal below names the thing they
   * could do about it.
   *
   * It runs once. `appliedPrefill` is a ref rather than a dependency list
   * because re-running would overwrite a repository the reader has since
   * changed with the one the link named — the link is an opening position, not
   * a setting.
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
        // clone` for a typo nobody was shown. The list this is checked against
        // is every branch the repository has: it was three pages with a
        // `truncated` flag, and reading "isn’t a branch" about a branch that
        // sat past the three hundredth is the failure that flag described
        // rather than prevented.
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

  // —— Model ——
  const [model, setModel] = React.useState<string>(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY);
      if (saved) return saved;
    } catch {}
    return resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL;
  });

  const changeModel = React.useCallback((next: string) => {
    setModel(next);
    try {
      localStorage.setItem(MODEL_KEY, next);
    } catch {}
  }, []);

  const modelInfo = React.useMemo(() => resolveModel(model), [model]);

  // —— Thinking effort (inside the model chip) ——
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort>(() => {
    try {
      const saved = localStorage.getItem(EFFORT_KEY);
      if (saved) return saved as ReasoningEffort;
    } catch {}
    return modelInfo ? defaultReasoning(modelInfo) : null;
  });

  const changeReasoning = React.useCallback((next: ReasoningEffort) => {
    setReasoningEffort(next);
    try {
      if (next) localStorage.setItem(EFFORT_KEY, next);
      else localStorage.removeItem(EFFORT_KEY);
    } catch {}
  }, []);

  // —— Prompt & Uploads ——
  // Filled from the first render rather than in an effect, so a prefilled link
  // paints with its text in the field instead of painting empty and then
  // filling — and so the autosize below measures the real content once.
  const [prompt, setPrompt] = React.useState(prefill?.prompt ?? "");
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [dictating, setDictating] = React.useState(false);
  const canAttach = features.storage;

  const { supported: speechSupported } = useSpeechRecognition();
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(null);

  // —— Submission & Status ——
  const [submitting, setSubmitting] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  // The shared composer growth: one line at rest, eight before it scrolls.
  const autoresize = useComposerAutosize(textareaRef, prompt);

  React.useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  const hasPayload = prompt.trim().length > 0 || readyAttachments.length > 0;
  const canSubmit = hasTarget && hasPayload && !submitting && !isUploading && !cloudBlocked;

  const codeVoice = useCodeVoice({ disabled: submitting || dictating });

  // —— Mode (per project, remembered) ——
  const modeProjectKey = projectModeKey(
    target === "device" ? (selectedWorkspace?.key ?? selectedWorkspace?.path ?? null) : (selectedRepo?.fullName ?? null),
  );
  const [mode, setMode] = React.useState<ComposerMode>(() => landingMode(target, null));
  React.useEffect(() => {
    setMode(landingMode(target, modeProjectKey ? readStoredJson(modeProjectKey) : null));
  }, [target, modeProjectKey]);
  const chooseMode = React.useCallback(
    (next: ComposerMode) => {
      setMode(next);
      if (modeProjectKey) writeStoredJson(modeProjectKey, applyComposerMode(next, "auto-edit"));
    },
    [modeProjectKey],
  );
  /** A new thread starts on the landing's mode (the v2 route reads these prefs). */
  const seedThreadMode = React.useCallback(
    (conversationId: string) => {
      const key = threadPrefsKey(conversationId);
      writeStoredJson(key, seededThreadPrefs(readStoredJson(key), mode));
    },
    [mode],
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
          model,
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      seedThreadMode(conversation.id);
      setPendingCodePrompt(conversation.id, text, attachments);
      upsertConversation({ ...conversation, model });
      router.push(`/chat/${conversation.id}`);
      return true;
    },
    [model, router, seedThreadMode, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null, attachments: ClientAttachment[]): Promise<boolean> => {
      let conversation: ClientConversation | null = null;
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
      const titleFallback =
        text.slice(0, 60) ||
        (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);

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
          // This composer's model picker and thinking control, reaching the run.
          model,
          reasoningEffort: reasoningEffort ?? undefined,
          // And its mode, as far as a cloud sandbox can enforce one.
          permissionMode: cloudPermissionMode(mode) ?? undefined,
        }),
      });

      if (tRes.ok) {
        if (conversation) {
          upsertConversation({
            ...conversation,
            title: titleFallback.slice(0, 48),
            titleSource: "manual",
            model,
          });
        }
        clear();
        router.push(`/chat/${conversationId}`);
        return true;
      }

      const payload = (await tRes.json().catch(() => ({}))) as { error?: string; message?: string };
      const err = payload.error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        // The server says why, in a sentence written to be shown. Nothing was
        // created server-side, so the conversation this composer made is an
        // orphan.
        setCloudReadiness({
          ready: false,
          message: payload.message ?? "Cloud runs aren’t enabled on this server yet.",
        });
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
        clear();
        router.push(`/chat/${conversationId}`);
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
        discardOrphanCloudSession();
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
        discardOrphanCloudSession();
      } else {
        /*
         * Anything else: say what the SERVER said, when it said something.
         * The quota refusals arrive as prose in `error` — anything with a
         * space in it is a sentence meant to be read, not a code.
         */
        const sentence =
          payload.message?.trim() ||
          (err && /\s/.test(err) ? err : "") ||
          "Couldn’t start the cloud run. Check your connection and try again.";
        toast.error(sentence);
        discardOrphanCloudSession();
      }
      return false;
    },
    [clear, discardOrphanCloudSession, mode, model, reasoningEffort, router, upsertConversation],
  );

  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const text = (overrideText ?? prompt).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || submitting || isUploading) return false;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return false;
      if (cloudBlocked) return false;

      setSubmitting(true);
      try {
        if (target === "device" && selectedWorkspace) {
          return await startDevice(selectedWorkspace, text, attachments);
        }
        if (target === "cloud" && selectedRepo) {
          return await startCloud(selectedRepo, text, baseRef.trim() || null, attachments);
        }
        return false;
      } catch {
        toast.error("Couldn’t start the session. Check your connection and try again.");
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [
      prompt,
      readyAttachments,
      submitting,
      isUploading,
      target,
      selectedWorkspace,
      selectedRepo,
      cloudBlocked,
      baseRef,
      startDevice,
      startCloud,
    ],
  );

  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [prompt.trim(), transcript.trim()].filter(Boolean).join(" ");
      if (!sendNow) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      if (!merged && readyAttachments.length === 0) {
        setPrompt("");
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (!(target === "device" ? selectedWorkspace : selectedRepo) || cloudBlocked) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      void submit(merged);
    },
    [autoresize, cloudBlocked, prompt, readyAttachments.length, selectedRepo, selectedWorkspace, submit, target],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) void submit();
    }
  };

  const gateHint = !hasTarget
    ? target === "device"
      ? "Pick a project to start"
      : "Pick a repository to start"
    : null;

  /*
   * One line for everything the link asked for and did not get — the parser's
   * refusals first, then whatever GitHub said about the repository it named.
   * Joined into a single sentence stack rather than a list: two is already the
   * unusual case, and a bulleted apology under a composer would be the prose
   * that was taken out of this surface on purpose.
   */
  const prefillMessage = React.useMemo(() => {
    const parts = (prefill?.notes ?? []).map((note) => PREFILL_NOTES[note]);
    if (prefillProblem) parts.push(prefillProblem);
    return parts.join(" ") || null;
  }, [prefill, prefillProblem]);

  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "new",
      target,
      place: target === "device" ? (selectedWorkspace?.name ?? null) : (selectedRepo?.fullName ?? null),
      baseRef: target === "cloud" ? ((baseRef.trim() || selectedRepo?.defaultBranch) ?? null) : null,
      turns: [],
      blocked: cloudBlocked?.message ?? gateHint,
    }),
    [baseRef, cloudBlocked, gateHint, selectedRepo, selectedWorkspace, target],
  );

  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "start",
      blockedReason: cloudBlocked
        ? cloudBlocked.message
        : gateHint
          ? `${gateHint} — then these words can start it.`
          : null,
      sending: submitting,
      endsCall: true,
      onSend: (text: string) => submit([prompt.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [cloudBlocked, gateHint, prompt, submit, submitting],
  );

  /** The call, inside this composer as Chat draws its own; the first sentence starts the session. */
  const call = useCodeVoiceCall({ open: codeVoice.open, onClose: codeVoice.close, briefing: voiceBriefing, send: voiceSend });

  // A starting point under the landing seeds the field (code-starting-points):
  // the text lands with the caret at its end, and nothing is sent.
  React.useEffect(() => {
    const onSeed = (event: Event) => {
      const text = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null;
      if (!text || submitting) return;
      setPrompt(text);
      requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
    };
    window.addEventListener(CODE_COMPOSER_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CODE_COMPOSER_SEED_EVENT, onSeed);
  }, [submitting]);

  const effortOptions = React.useMemo(() => (modelInfo ? reasoningOptions(modelInfo) : []), [modelInfo]);
  const isAuto = isAutoModelId(model);
  // Effort lives inside the model chip's popover, as every composer mounts it.
  const thinkingControl =
    isAuto || !modelInfo || effortOptions.length < 2 ? null : (
      <ReasoningSlider
        options={effortOptions}
        value={reasoningEffort}
        onChange={changeReasoning}
        disabled={submitting}
      />
    );

  return (
    <div className={cn("relative isolate w-full", className)}>

      <DictationSwap active={dictating} onCancel={() => setDictating(false)} onClose={closeDictation}>
        <div
          onDragOver={(e) => {
            if (!canAttach || submitting || dictating) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (canAttach && !submitting && !dictating && e.dataTransfer.files.length) {
              addFiles(e.dataTransfer.files);
            }
          }}
          className="relative isolate w-full"
        >
          {/* The tray (owner, 2026-10-03): the chat home's shelf, turned to sit
              ON the composer rather than under it, holding where this runs, the
              project, and what it may do there. The field is shorter for it:
              the box holds only what is typed and the row that sends it. */}
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
              <span className="ml-auto flex min-w-0">
                <ModeChip target={target} mode={mode} onChange={chooseMode} disabled={submitting} />
              </span>
            </div>
          </div>
          <VoiceComposerGlow call={call}>
          <ComposerShell
            className={cn("max-h-[600px]", call && "voice-glow-host", dragging && "border-primary/55 ring-2 ring-primary/20")}
            dimmed={submitting}
            above={canAttach ? <ComposerAttachmentTray uploads={uploads} onRemove={remove} /> : undefined}
            field={
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={submitting}
                // The placeholder is the accessible name, as it is on the chat
                // composer. It used to carry `aria-label="Describe the task for
                // this Juno Code session"` as well, which won — leaving a field
                // whose visible words appeared nowhere in its accessible name,
                // i.e. the WCAG 2.5.3 label-in-name failure the base-branch
                // input in code-target-picker.tsx was already fixed for, and a
                // field no voice user could address by the words inside it.
                placeholder={call ? "Type while you talk\u2026" : "Describe a task or ask a question\u2026"}
                className={composerFieldClass}
              />
            }
            leading={
              <>
                {canAttach && (
                  <ComposerAddMenu
                    open={plusOpen}
                    onOpenChange={setPlusOpen}
                    disabled={submitting}
                    onPickPhotos={() => imageInputRef.current?.click()}
                    onPickFiles={() => fileInputRef.current?.click()}
                    onPickLibrary={() => setLibraryOpen(true)}
                  />
                )}

                {speechSupported && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDictating(true)}
                        disabled={submitting || dictating || codeVoice.open}
                        aria-label="Dictate"
                        aria-pressed={dictating}
                        className={composerIconButtonClass}
                      >
                        <Mic className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Dictate</TooltipContent>
                  </Tooltip>
                )}

                {call?.status}
              </>
            }
            trailing={
              call ? call.controls : <div className={cn("min-w-0", submitting && "pointer-events-none")}>
                <ModelSelector
                  value={model}
                  onChange={changeModel}
                  disabled={submitting}
                  thinking={thinkingControl}
                />
              </div>
            }
            action={
              call && !hasPayload ? call.end : !call && !hasPayload && !submitting && codeVoice.onOpenVoiceMode ? (
                // Nothing to send: the slot is voice, as on Chat's composer.
                <ComposerPrimaryAction face="voice" onClick={codeVoice.onOpenVoiceMode} aria-label={`Talk this through with ${PRODUCT_NAME}`} />
              ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ComposerPrimaryAction
                    face={submitting ? "busy" : "send"}
                    onClick={() => void submit()}
                    disabled={!canSubmit}
                    aria-label={
                      cloudBlocked
                        ? cloudBlocked.message
                        : !hasTarget
                          ? (gateHint ?? "Select where to run first")
                          : target === "cloud"
                            ? "Start a cloud run"
                            : "Start the session"
                    }
                  />
                </TooltipTrigger>
                <TooltipContent>{target === "cloud" ? "Start cloud run" : "Start session"}</TooltipContent>
              </Tooltip>
              )
            }
          />
          </VoiceComposerGlow>

          {dragging && <ComposerDropOverlay />}

          <ComposerFileInputs imageInputRef={imageInputRef} fileInputRef={fileInputRef} onFiles={addFiles} />
          {canAttach && (
            <LibraryPicker
              open={libraryOpen}
              onOpenChange={setLibraryOpen}
              onAttach={addAttachments}
              existingCount={uploads.length}
            />
          )}
        </div>
      </DictationSwap>

      {/*
        NOTHING UNDER THE FIELD UNLESS THE SERVER HAS NEWS.

        Three paragraphs used to live here: a permanent sentence naming where
        the run happens, a permanent one naming what it may do, and a gate hint
        reading "Pick a project to start". The first two are the chips above and
        the permission chip below. The third was the same words a third time —
        the repository chip's own empty label IS "Pick a project", in muted ink,
        directly above the field — and on a composer pinned to the bottom of the
        page it also made the box hop up twenty pixels the moment you picked
        one, which is a layout shift charged to the reader for reading a
        sentence they had already read.

        What is left is what no chip can say. One: this server has no cloud
        runner — said quietly, in muted ink, rather than as an alert, because
        the reader can still run on their Mac and the sentence names the way
        there. Two, below it: this composer was opened from a link and part of
        what the link asked for did not happen.
      */}
      {cloudBlocked && (
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
      )}
      {/*
        THE SECOND THING THAT CAN BE TRUE UNDER THE FIELD: this session was
        opened from a link and part of what the link asked for did not happen.
        Same quiet treatment as the note above — muted, centred, `role="status"`
        — because it is news about the state of the composer rather than an
        error in anything the reader did; `StatusIcons.info` rather than a
        warning triangle for the same reason.

        Only one of the two is ever drawn, and the cloud-runner note wins: a
        server that cannot run this at all is the bigger fact, and two stacked
        captions under a composer pinned to the bottom of the page is the prose
        stack that was deliberately taken out of this surface.
      */}
      {/* The mode, explained in one line: what this run may do without
          asking, as chosen on the tray's mode chip. Only when the server has
          no other news for this line. */}
      {!cloudBlocked && !prefillMessage && (
        <p aria-live="polite" className="mt-2.5 px-5 text-caption text-muted-foreground">
          <span className="font-medium text-foreground/80">{composerModeInfo(mode).label}</span> {composerModeInfo(mode).description}
        </p>
      )}
      {!cloudBlocked && prefillMessage && (
        <p role="status" className="mt-2.5 flex items-start justify-center gap-1.5 px-1 text-caption text-muted-foreground motion-safe:animate-fade-in">
          <StatusIcons.info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{prefillMessage}</span>
        </p>
      )}
    </div>
  );
}
