"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { JunoMark } from "@/components/brand/logo";
import {
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
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { cn } from "@/lib/utils";
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

function CodeGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];

  return (
    <div className="flex w-full flex-col items-center text-center">
      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border/80 bg-secondary/80 px-3 py-1 font-mono text-micro uppercase tracking-wider text-muted-foreground shadow-xs">
        <JunoMark className="size-3.5" />
        <span>Juno Code</span>
      </div>
      {/* `text-display`, the same rung the session view's own hero uses. The
          old `text-3xl sm:text-4xl` pair is not on the product type scale, and
          it put the two Code screens' headings at two different sizes one
          navigation apart — the token's clamp already does the responsive work
          the breakpoint was hand-rolling. */}
      <h1 className="text-center font-serif text-display font-normal tracking-tight text-foreground">
        What are we building today{firstName ? `, ${firstName}` : ""}?
      </h1>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground sm:text-base">
        Juno Code works in a synced project on your Mac, or on a fresh cloud machine that opens a
        pull request. Pick where it runs below, then say what to change.
      </p>
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
                  "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
                  dictating ? "min-h-[170px]" : "min-h-[68px]",
                )}
              >
                <div
                  className={cn(
                    "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
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
                    "transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
                    dictating
                      ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0"
                      : "translate-y-0 scale-100 opacity-100",
                  )}
                >
                  <ComposerShell
                    className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
                    utilityLabel="Where this session runs"
                    above={canAttach && <ComposerAttachmentTray uploads={uploads} onRemove={remove} />}
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
                        // The eased height is real layout movement — the
                        // composer and the greeting above it both shift — so it
                        // takes the reduced-motion escape the rest of this
                        // screen's transitions already carry.
                        //
                        // Placeholder at full --muted-foreground, matching the
                        // session composer: input.tsx, textarea.tsx and
                        // select.tsx each removed `/70` with a note recording it
                        // as a 2.91:1 failure against a token tuned to 5.3:1,
                        // and this is the only instruction on an otherwise empty
                        // screen.
                        className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 motion-reduce:transition-none sm:px-[18px] sm:pt-[17px]"
                      />
                    }
                    controls={
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-1">
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
                                className="composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[color,background-color,border-color,box-shadow,transform] duration-base ease-out-strong"
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
                              <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
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

                  {dragging && <ComposerDropOverlay />}

                  <ComposerFileInputs
                    imageInputRef={imageInputRef}
                    fileInputRef={fileInputRef}
                    onFiles={addFiles}
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
              // bg-warning/10, the alpha globals.css names as the product's
              // warning chip. At /5 the fill was ~1% lightness on the black
              // ground, so the border carried the banner alone.
              <p
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-warning-foreground motion-safe:animate-rise-in"
              >
                <StatusIcons.warning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  Cloud runs aren’t enabled on this server yet. Ask an admin to configure the cloud runner, or switch to{" "}
                  {/* rounded-xs so the global 2px focus outline traces a corner
                      rather than a bare rectangle through the sentence, and a
                      real colour transition — this is the banner's only way
                      out and it changed colour instantly on hover. */}
                  <button
                    type="button"
                    onClick={() => switchTarget("device")}
                    className="rounded-xs font-medium underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground"
                  >
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
                // `flex-wrap` + `gap-y-2`: at 320px the sentence and the retry
                // shared one nowrap row, so the button was squeezed to its
                // padding and the message truncated to nothing.
                className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-field border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive motion-safe:animate-rise-in"
              >
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Couldn’t start the cloud run — this is usually temporary.
                </span>
                {/* The button's border matches the banner's: at /30 against the
                    frame's /40 the retry read as a lighter-weight edge inside a
                    heavier one, which is a hierarchy the two do not have. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/20 hover:text-destructive coarse:h-11"
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CodeIcons.refresh className="size-3.5" aria-hidden="true" />
                  )}
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
