"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUp,
  Cloud,
  FileText,
  FileUp,
  GitBranch,
  ImagePlus,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { JunoMark } from "@/components/brand/logo";
import {
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientAttachment, ClientConversation } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";

/*
 * The composer's separator, one string, used everywhere one is needed on this
 * screen. chat/composer.tsx:2205 records what the alternative shipped: two
 * heights (h-5/h-4) behind two breakpoints (min-[420px]/min-[380px]), so
 * between 380 and 420px two different separators were on screen at once. This
 * file carried the losing half of that pair until now.
 */
const COMPOSER_DIVIDER = "mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block";

/** Cloud task-dispatch failures surfaced inline under the composer (503/502). */
type CloudStartError = "not_configured" | "dispatch_failed" | null;

// Code-flavoured greetings — deterministic index during SSR (stable hydration),
// then a random pick once mounted so it varies per visit (same idiom as the chat
// EmptyGreeting).
const CODE_GREETINGS = [
  "What are we building",
  "What's the task",
  "What's next",
  "Where do we start",
  "What should Juno Code do",
  "Ready when you are",
];

function CodeGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => setIdx(Math.floor(Math.random() * CODE_GREETINGS.length)), []);
  const [popping, setPopping] = React.useState(false);
  const phrase = CODE_GREETINGS[idx];

  return (
    <div className="flex w-full flex-col items-center text-center">
      <p className="mb-3 font-mono text-[11px] text-muted-foreground/80 [animation-fill-mode:backwards] motion-safe:animate-fade-in">
        Juno Code
      </p>
      {/* 1fr | text | 1fr — text stays screen-centered; mark flanks left. */}
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center justify-end pr-[0.38em]">
          <button
            type="button"
            aria-label="Juno"
            onClick={() => setPopping(true)}
            onAnimationEnd={() => setPopping(false)}
            className={cn(
              // The glyph is 1.32rem (21px) — the weight the greeting wants,
              // and under the 24x24 WCAG 2.2 (2.5.8) target minimum. grid +
              // place-items grows the hit area around it without moving it,
              // exactly as the chat greeting's mark does. `outline-none` is
              // gone with it: it removed the global :focus-visible outline and
              // put nothing back, so this control had no keyboard focus at all.
              "grid size-6 shrink-0 place-items-center [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in sm:size-8",
              popping && "juno-mark-popping",
            )}
          >
            <JunoMark
              className={cn(
                "block h-[1.32rem] w-[1.32rem] sm:h-[1.83rem] sm:w-[1.83rem]",
                "transition-transform duration-base ease-spring motion-reduce:transition-none",
                !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110",
              )}
            />
          </button>
        </div>
        <h1
          className="text-center font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]"
          suppressHydrationWarning
        >
          <span className="inline-block [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
            {phrase}
            {firstName ? "," : "?"}
          </span>
          {firstName ? (
            <>
              {" "}
              <span className="inline-block font-medium italic text-primary [animation-delay:180ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
                {firstName}?
              </span>
            </>
          ) : null}
        </h1>
        <div aria-hidden="true" />
      </div>
    </div>
  );
}

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { settings, upsertConversation, removeConversation, features } = useApp();

  // —— Target (Device ⇄ Cloud), restored after mount (SSR renders "device") ——
  const [target, setTarget] = React.useState<Target>("device");
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, []);
  // Reuse one cloud conversation across retries so a transient dispatch failure
  // doesn't leak an empty session on every attempt.
  const cloudConversationId = React.useRef<string | null>(null);

  /*
   * Retries reused that conversation, and nothing ever cleaned it up — so a
   * failed cloud start still left exactly one empty untitled session in the
   * sidebar with no run behind it, and switching to Device or walking away
   * stranded it there for good.
   *
   * Called on every path that ends the retry: a non-retryable failure, leaving
   * Cloud, and picking a DIFFERENT repository — that last one is not tidiness.
   * The orphan carries the first repo's name and path, and `startCloud` only
   * creates a conversation when the ref is empty, so without this the retry
   * would stream a run against repo B into a session labelled repo A.
   */
  const discardOrphanCloudSession = React.useCallback(() => {
    const id = cloudConversationId.current;
    if (!id) return;
    cloudConversationId.current = null;
    removeConversation(id);
    // Fire-and-forget: the user is not waiting on this, and a failed delete
    // leaves exactly what failing to try would have.
    void fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  }, [removeConversation]);

  const switchTarget = React.useCallback(
    (next: Target) => {
      setTarget(next);
      setCloudStartError(null);
      if (next !== "cloud") discardOrphanCloudSession();
      try {
        localStorage.setItem(TARGET_KEY, next);
      } catch {}
    },
    [discardOrphanCloudSession],
  );

  // —— Selection state (kept per target so toggling never loses a pick) ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");

  // —— Prompt (the only thing this screen actually decides, besides target) ——
  const [prompt, setPrompt] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const [dictating, setDictating] = React.useState(false);
  /*
   * THE MODEL PICKER AND THE THINKING SLIDER ARE GONE, and this is what they
   * were: two controls that changed nothing about the run.
   *
   * POST /api/code/tasks carries no `model` and no `reasoningEffort` field, and
   * dispatchCloudRunner never reads one — the picked model was only ever
   * written onto the local conversation record (still is, below). The effort
   * control was worse than inert: it wrote through `setComposerPrefs`, which
   * persists to the shared `juno:composer-prefs` key, so dragging it here
   * silently and permanently changed the effort the CHAT composer would use
   * next, while doing nothing to the code task being started. The session
   * composer in code-session-view already ships without both, which is the
   * honest shape; these come back when the task API can carry them.
   *
   * The model still rides onto the conversation so the sidebar's record matches
   * the account default — a value, not a choice, so no control claims otherwise.
   */
  const model = React.useMemo(
    () => resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL,
    [settings.defaultModel],
  );
  const canAttach = features.storage;

  /*
   * Composer aura — the accent bloom behind an empty composer (globals.css
   * ".composer-aura"), which the empty chat has had and this screen has not.
   * They are the same screen: a greeting, a composer under it, and nothing else
   * yet. The bloom's stated job is that a brand-new session is the warmest
   * thing on the page, and a brand-new Code session is exactly that.
   *
   * It rides on the CSS defaults rather than on custom properties from here,
   * because the two properties it can take — `--aura-provider` (the lab colour
   * behind the picked model) and `--aura-think` (how hard it is set to think) —
   * are answers to questions this screen no longer asks. Both are registered
   * with real initial values (`hsl(var(--primary))` and 0.5), so the bloom is
   * the brand tint at mid effort: the light says "a new session", which is the
   * only thing left that is true here.
   *
   * The remaining two inputs need no wiring and are live for free: focus is
   * `:focus-within` on the `.composer-surface` class this composer already
   * carries, and reduced motion is handled inside the same CSS.
   */

  // Send swells the bloom once. Cleared on a timer rather than `animationend`:
  // under prefers-reduced-motion the keyframes are switched off, so that event
  // would never arrive and the class would stick for the rest of the visit.
  const [auraSending, setAuraSending] = React.useState(false);
  React.useEffect(() => {
    if (!auraSending) return;
    const t = window.setTimeout(() => setAuraSending(false), 1150);
    return () => window.clearTimeout(t);
  }, [auraSending]);
  const { supported: speechSupported } = useSpeechRecognition();
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(null);

  // —— Submission ——
  const [submitting, setSubmitting] = React.useState(false);
  const [cloudStartError, setCloudStartError] = React.useState<CloudStartError>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [prompt, autoresize]);
  React.useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const removeUpload = React.useCallback(
    (localId: string) => {
      setRemovingIds((prev) => [...prev, localId]);
      window.setTimeout(() => {
        remove(localId);
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
      }, 180);
    },
    [remove],
  );

  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  const hasPayload = prompt.trim().length > 0 || readyAttachments.length > 0;
  const canSubmit = hasTarget && hasPayload && !submitting && !isUploading;

  /*
   * Voice mode, which this screen has never had — only dictation, which is a
   * different thing (dictation types for you; voice is a conversation). Gated
   * in `useCodeVoice`: paid plan, a relay configured, not already live, and not
   * while this screen is mid-submit or mid-dictation, since both of those want
   * the same microphone.
   */
  const codeVoice = useCodeVoice({ disabled: submitting || dictating });

  // Every start path answers the same question — did the session actually
  // begin? — because the voice panel's hand-off has to know: a refusal leaves
  // the spoken line on screen to be sent again, and a success ends the call.
  const startDevice = React.useCallback(
    async (w: Workspace, text: string, attachments: ClientAttachment[]): Promise<boolean> => {
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
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      // Hand the first prompt (+ attachments) off to the session view, which
      // dispatches once the Mac is reachable (create contract stays prompt-free).
      setPendingCodePrompt(conversation.id, text, attachments);
      // Carry the chosen model into the client-side session record.
      upsertConversation({ ...conversation, model });
      router.push(`/chat/${conversation.id}`);
      return true;
    },
    [model, router, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null, attachments: ClientAttachment[]): Promise<boolean> => {
      // 1) Ensure a kind:"code" session to stream the run into. The repo is the
      //    cloud "workspace": name for display, owner/name as the path.
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
      const attachmentIds = attachments.map((a) => a.id);
      const titleFallback =
        text.slice(0, 60) ||
        (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);

      // 2) Dispatch the cloud task against the selected repo.
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

      const err = ((await tRes.json().catch(() => ({}))) as { error?: string }).error;
      // Only `dispatch_failed` is worth holding the session open for — its
      // banner is the one with a Try again. Every other failure here needs a
      // different server, a different connection or a different file, so the
      // empty session it would leave behind is pure litter.
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        setCloudStartError("not_configured");
        discardOrphanCloudSession();
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        setCloudStartError("dispatch_failed");
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
        discardOrphanCloudSession();
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
        discardOrphanCloudSession();
      } else {
        toast.error("Could not start the cloud run. Check your connection and try again.");
        discardOrphanCloudSession();
      }
      return false;
    },
    [clear, discardOrphanCloudSession, model, router, upsertConversation],
  );

  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const text = (overrideText ?? prompt).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || submitting || isUploading) return false;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return false;

      // Past every guard that can still refuse the turn, so the bloom only
      // swells for a session that is genuinely being started.
      setAuraSending(true);
      setSubmitting(true);
      setCloudStartError(null);
      try {
        if (target === "device" && selectedWorkspace) {
          return await startDevice(selectedWorkspace, text, attachments);
        }
        if (target === "cloud" && selectedRepo) {
          return await startCloud(selectedRepo, text, baseRef.trim() || null, attachments);
        }
        return false;
      } catch {
        toast.error("Could not start the session. Check your connection and try again.");
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
      // Gate the same way the send button does — if target is missing, park the
      // words in the field so the user can finish setup without losing them.
      if (!(target === "device" ? selectedWorkspace : selectedRepo)) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      void submit(merged);
    },
    [autoresize, prompt, readyAttachments.length, selectedRepo, selectedWorkspace, submit, target],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) void submit();
    }
  };

  const gateHint =
    !hasTarget
      ? target === "device"
        ? "Pick a project to start"
        : "Pick a repository to start"
      : null;

  /*
   * What the call is told. The relay has no tools and no database, so this is
   * the model's entire knowledge of the session about to be started — and on
   * this screen that is exactly the utility strip's contents, which is the
   * point: what persists across the send is what a conversation about the run
   * needs to know.
   *
   * The default branch stands in when no override is typed, because that is
   * what the run will actually use — `startCloud` sends `baseRef ?? undefined`
   * and the runner falls back to the repo's default.
   */
  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "new",
      target,
      place: target === "device" ? (selectedWorkspace?.name ?? null) : (selectedRepo?.fullName ?? null),
      baseRef: target === "cloud" ? (baseRef.trim() || selectedRepo?.defaultBranch) ?? null : null,
      turns: [],
      blocked: gateHint,
    }),
    [baseRef, gateHint, selectedRepo, selectedWorkspace, target],
  );

  /*
   * The one channel out of the call. `submit` already took an override, which
   * is the whole adapter — the spoken line goes through the identical start
   * path as a typed one, gates and all, so a call cannot start a session the
   * keyboard could not have.
   */
  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "start",
      // The screen's own gate sentence, verbatim. A second wording here would
      // read as a second rule.
      blockedReason: gateHint ? `${gateHint} — then these words can start it.` : null,
      sending: submitting,
      // Starting navigates to the new session, so the call cannot survive it.
      endsCall: true,
      // Merge, never replace — see the note on the session view's onSend. It
      // matters more here: this screen navigates to the new session on success,
      // so a typed draft dropped on a voice send is gone past recovery.
      onSend: (text: string) => submit([prompt.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [gateHint, prompt, submit, submitting],
  );

  // Nothing to send yet → the primary action is the way into a conversation
  // instead of a dead button. Keyed on the payload rather than on `canSubmit`:
  // with words typed and no project picked, `canSubmit` is false too, and
  // swapping Send for a phone call at that moment would hide the one control
  // whose disabled label says what is missing.
  const showVoiceButton = !submitting && !hasPayload && !!codeVoice.onOpenVoiceMode;

  return (
    // overflow-x-clip so the composer aura, which is deliberately wider than
    // the column it lights, can never put a horizontal scrollbar over dead
    // space. Vertical scrolling is untouched.
    <div className="relative flex h-full min-h-full w-full flex-col overflow-y-auto overflow-x-clip">
      {/* Greeting + composer, centered as one calm group and free to scroll on
          short viewports. py accounts for the floating back button so a short
          viewport never tucks the greeting under it. */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-14 sm:px-6">
        {/* `isolate` is the floor the aura is allowed to fall to. It paints on
            z-index -1 and the host below deliberately does NOT create a
            stacking context, so without a floor here the bloom would drop to
            whatever distant ancestor happens to establish one. Here it lands
            just above this column's background: under the greeting, under the
            composer, over nothing else. */}
        <div className="relative isolate flex w-full max-w-[44rem] flex-col items-center gap-7 sm:gap-9">
          <CodeGreeting />

          <div className="w-full">
            {/* The aura's host is its own element rather than the grid below,
                and that is not tidiness. `.composer-aura-host` carries a
                `transition` shorthand that eases the tint and the effort, and
                the grid carries a `transition-[min-height]` utility — Tailwind
                emits utilities after components at equal specificity, so
                hosting the aura there would replace that whole declaration and
                silently drop both easings, leaving a bloom that jumps colour
                instead of turning over. Deliberately no `isolate` here either:
                that belongs to the column above, so the light falls behind the
                greeting rather than being trapped in front of it.

                It wraps the composer and the voice call and nothing else, so
                the bloom centres on the capsule — the error banners and the
                footer line below are not part of what is being lit. */}
            <div className={cn("composer-aura-host relative w-full", auraSending && "is-sending")}>
              {/* One light at a time: the idle bloom steps aside while the
                  voice field is live, because two of them behind one composer
                  read as a mix rather than a colour. */}
              {!codeVoice.open && <div aria-hidden className="composer-aura" />}
              {/* A FRAGMENT, and a SIBLING of the composer. The voice field
                  paints at z-index -1, so anything that boxed it here would put
                  it behind that box instead of behind the composer — the same
                  arrangement chat-view.tsx keeps, for the same reason. */}
              {codeVoice.open && (
                <CodeVoicePanel briefing={voiceBriefing} send={voiceSend} onClose={codeVoice.close} />
              )}
              <div
                className={cn(
                  "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-spring motion-reduce:transition-none",
                  dictating ? "min-h-[170px]" : "min-h-[68px]",
                )}
              >
                <div
                  className={cn(
                    "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
                    dictating
                      ? "translate-y-0 scale-100 opacity-100"
                      : "pointer-events-none translate-y-1 scale-95 opacity-0",
                  )}
                >
                  {dictating && (
                    <ComposerDictation
                      onCancel={() => setDictating(false)}
                      onStop={(t) => closeDictation(t, false)}
                      onSend={(t) => closeDictation(t, true)}
                    />
                  )}
                </div>

                {/*
                  The dictation cross-fade and the drop target live on this
                  wrapper rather than on the shell itself.

                  <ComposerShell> already owns a
                  `transition-[border-color,box-shadow]`; putting a second
                  `transition-[opacity,transform,…]` on the same element is two
                  `transition-property` declarations at equal specificity, where
                  which one survives is decided by Tailwind's emit order rather
                  than by anything written here. Separating them also fixes the
                  drop overlay: `absolute inset-0` inside the shell can only
                  cover one slot, and the shell cannot clip (the drop state has
                  to reach the utility strip too), so the overlay is a sibling
                  that covers both tiers and traces the same corners.
                */}
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
                  className={cn(
                    "col-start-1 row-start-1 relative w-full origin-center",
                    "transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
                    dictating
                      ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0"
                      : "translate-y-0 scale-100 opacity-100",
                  )}
                >
                  <ComposerShell
                    className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
                    utilityLabel="Where this session runs"
                    above={
                      canAttach && (
                        <div
                          className={cn(
                            "grid transition-[grid-template-rows] duration-base ease-out-soft",
                            uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                          )}
                        >
                          <div className="min-h-0 overflow-hidden">
                            <div className="flex flex-wrap gap-2 px-3 pb-0 pt-3 sm:px-3.5">
                              {uploads.map((u) => (
                                <div
                                  key={u.localId}
                                  className={cn(
                                    "group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft",
                                    removingIds.includes(u.localId)
                                      ? "pointer-events-none motion-safe:animate-pop-out"
                                      : "motion-safe:animate-rise-in",
                                  )}
                                >
                                  {u.attachment?.kind === "IMAGE" ? (
                                    <Image
                                      src={u.attachment.url}
                                      unoptimized={requiresViewerCredentials(u.attachment.url)}
                                      alt={u.fileName}
                                      width={32}
                                      height={32}
                                      className="h-8 w-8 rounded-sm object-cover"
                                    />
                                  ) : (
                                    <FileText className="h-5 w-5 text-muted-foreground" />
                                  )}
                                  <div className="max-w-[140px]">
                                    <p className="truncate font-medium">{u.fileName}</p>
                                    <p className="text-muted-foreground">
                                      {u.status === "uploading"
                                        ? `${u.progress}%`
                                        : u.status === "error"
                                          ? "Failed"
                                          : formatBytes(u.size)}
                                    </p>
                                  </div>
                                  {u.status === "uploading" && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => removeUpload(u.localId)}
                                    className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                                    aria-label="Remove attachment"
                                  >
                                    <X className="h-3 w-3 coarse:h-4 coarse:w-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )
                    }
                    field={
                      <textarea
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={onKeyDown}
                        rows={1}
                        disabled={submitting}
                        placeholder="Describe a task or ask a question"
                        aria-label="Describe the task for this Juno Code session"
                        className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]"
                      />
                    }
                    controls={
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          {canAttach && (
                            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Add"
                                  disabled={submitting}
                                  className={cn(
                                    "composer-add-button group shrink-0 rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
                                    plusOpen && "bg-accent",
                                  )}
                                >
                                  <Plus
                                    aria-hidden="true"
                                    strokeWidth={1.75}
                                    className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                                  />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                                <DropdownMenuLabel className="font-mono text-label">Add</DropdownMenuLabel>
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <Paperclip className="text-muted-foreground" />
                                    <span className="flex-1">Attach</span>
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="w-52">
                                    <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}>
                                      <ImagePlus className="text-muted-foreground" />
                                      <span className="flex-1">Photos</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                                      <FileUp className="text-muted-foreground" />
                                      <span className="flex-1">Files</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                                      <Library className="text-muted-foreground" />
                                      <span className="flex-1">From your library</span>
                                    </DropdownMenuItem>
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>

                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          {speechSupported && (
                            <>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => setDictating(true)}
                                    // A live call already owns the microphone —
                                    // the same interlock the Work thread
                                    // composer keeps between these two.
                                    disabled={submitting || dictating || codeVoice.open}
                                    aria-label="Dictate"
                                    aria-pressed={dictating}
                                    className="composer-mic-button rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                                  >
                                    <Mic className="composer-mic-icon h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Dictate</TooltipContent>
                              </Tooltip>
                              <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                            </>
                          )}
                          {/* One button, three jobs: start the session, wait
                              for the one it started, or — with nothing written
                              — open a conversation about what to ask for. Chat
                              and the Work thread both morph this same control
                              rather than adding a fourth icon to the row. */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                onClick={
                                  showVoiceButton && codeVoice.onOpenVoiceMode
                                    ? codeVoice.onOpenVoiceMode
                                    : () => void submit()
                                }
                                disabled={showVoiceButton ? false : !canSubmit}
                                aria-label={
                                  showVoiceButton
                                    ? "Talk this through with Juno"
                                    : !hasTarget
                                      ? gateHint ?? "Select where to run first"
                                      : target === "cloud"
                                        ? "Start a cloud run"
                                        : "Start the session"
                                }
                                className="composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[color,background-color,border-color,box-shadow,transform] duration-base ease-spring"
                              >
                                {submitting ? (
                                  <Loader2 key="starting" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" aria-hidden="true" />
                                ) : showVoiceButton ? (
                                  <span key="voice" className="composer-voice-wave motion-safe:animate-fade-in" aria-hidden="true">
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                  </span>
                                ) : (
                                  <ArrowUp key="send" className="composer-send-icon h-4 w-4 motion-safe:animate-fade-in" aria-hidden="true" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {showVoiceButton
                                ? "Voice conversation"
                                : target === "cloud"
                                  ? "Start cloud run"
                                  : "Start session"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </>
                    }
                    /*
                      THE SECOND TIER. What used to be a chip row ABOVE the
                      field, which read as part of the message being composed
                      when it is the opposite of that: the machine, the checkout
                      and the branch are all still true after you press start,
                      and are still true of the session that follows. Under the
                      hairline they say so.
                    */
                    utility={
                      <>
                        <CodeTargetPicker
                          target={target}
                          onTargetChange={switchTarget}
                          selectedWorkspace={selectedWorkspace}
                          onSelectWorkspace={(w) => {
                            setSelectedWorkspace(w);
                            setCloudStartError(null);
                          }}
                          selectedRepo={selectedRepo}
                          onSelectRepo={(r) => {
                            setSelectedRepo(r);
                            setBaseRef("");
                            setCloudStartError(null);
                            // A held-over session from a failed start belongs to
                            // the repo it was named for, not this one.
                            if (r.fullName !== selectedRepo?.fullName) discardOrphanCloudSession();
                          }}
                          baseRef={baseRef}
                          onBaseRefChange={setBaseRef}
                          disabled={submitting}
                          className="h-7"
                        />
                        {/* The branch a cloud run starts from — read-only here,
                            edited in the picker's own popover where it belongs
                            (it only exists once a repo does). The repo default
                            stands in when nothing is typed because that is what
                            actually runs: `startCloud` sends `ref ?? undefined`
                            and the runner falls back to it. */}
                        {target === "cloud" && selectedRepo && (
                          <>
                            <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                            <span className="flex min-w-0 items-center gap-1 font-mono">
                              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                              <span className="sr-only">Base branch </span>
                              <span className="min-w-0 truncate">
                                {baseRef.trim() || selectedRepo.defaultBranch}
                              </span>
                            </span>
                          </>
                        )}
                      </>
                    }
                  />

                  {dragging && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-composer border-2 border-dashed border-primary/45 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in sm:rounded-lg">
                      <FileUp className="h-6 w-6 text-primary" />
                      <span className="font-mono text-label text-primary">Drop to attach</span>
                    </div>
                  )}

                  <input
                    ref={imageInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_ATTRIBUTE}
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  {canAttach && (
                    <LibraryPicker
                      open={libraryOpen}
                      onOpenChange={setLibraryOpen}
                      onAttach={addAttachments}
                      existingCount={uploads.length}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Inline task-dispatch failures (cloud only). */}
            {cloudStartError === "not_configured" && (
              <p
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-sm text-warning-foreground motion-safe:animate-rise-in"
              >
                <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  Cloud runs aren’t enabled on this server yet. Ask an admin to configure the cloud runner, or switch to{" "}
                  <button type="button" onClick={() => switchTarget("device")} className="font-medium underline underline-offset-2 hover:text-foreground">
                    Device
                  </button>{" "}
                  to run on your Mac.
                </span>
              </p>
            )}
            {cloudStartError === "dispatch_failed" && (
              // role="alert" for the same reason its sibling above has one:
              // both appear in this slot for the same gesture, and this is the
              // recoverable one carrying the retry — it was the silent one.
              <div
                role="alert"
                className="mt-2.5 flex items-center justify-between gap-3 rounded-field border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive motion-safe:animate-rise-in"
              >
                <span>Couldn’t start the cloud run — this is usually temporary.</span>
                <Button variant="outline" size="sm" onClick={() => void submit()} disabled={submitting} className="shrink-0 gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive">
                  Try again
                </Button>
              </div>
            )}

            {/* Quiet, honest footer — the gate hint (when send is blocked) then
                what happens on send, per target. Calm, never a nag. */}
            <p className="mt-3 text-center text-caption text-muted-foreground">
              {gateHint && !cloudStartError ? (
                <span className="text-foreground/70">{gateHint}. </span>
              ) : null}
              {target === "cloud"
                ? "Runs on a fresh cloud machine and opens a pull request to review."
                : "Runs with Juno Code on your Mac and streams the work here."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
