"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, ArrowUp, ChevronDown, Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { JunoMark } from "@/components/brand/logo";
import {
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import { useApp } from "@/components/app/app-provider";
import { resolveModel, DEFAULT_MODEL, type ModelId } from "@/lib/models";
import { reasoningOptions, defaultReasoning } from "@/lib/model-metrics";
import { CODE_PENDING_PROMPT_PREFIX } from "@/lib/code-session-handoff";
import { cn } from "@/lib/utils";
import type { ClientConversation, ReasoningEffort } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";

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
    <div className="flex flex-col items-center text-center">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80 [animation-fill-mode:backwards] motion-safe:animate-fade-in">
        Juno Code
      </p>
      <h1
        className="flex flex-wrap items-center justify-center gap-x-[0.38em] gap-y-1 font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]"
        suppressHydrationWarning
      >
        <button
          type="button"
          aria-label="Juno"
          onClick={() => setPopping(true)}
          onAnimationEnd={() => setPopping(false)}
          className={cn(
            "shrink-0 outline-none [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in",
            popping && "juno-mark-popping",
          )}
        >
          <JunoMark
            className={cn(
              "h-[0.78em] w-[0.78em] translate-y-[0.02em]",
              "transition-transform duration-base ease-spring motion-reduce:transition-none",
              !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110",
            )}
          />
        </button>
        <span className="inline-block [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
          {phrase}
          {firstName ? "," : "?"}
        </span>
        {firstName ? (
          <span className="inline-block font-medium italic text-primary [animation-delay:180ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
            {firstName}?
          </span>
        ) : null}
      </h1>
    </div>
  );
}

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { settings, upsertConversation, composerPrefs, setComposerPrefs } = useApp();

  // —— Target (Device ⇄ Cloud), restored after mount (SSR renders "device") ——
  const [target, setTarget] = React.useState<Target>("device");
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, []);
  const switchTarget = React.useCallback((next: Target) => {
    setTarget(next);
    setCloudStartError(null);
    try {
      localStorage.setItem(TARGET_KEY, next);
    } catch {}
  }, []);

  // —— Selection state (kept per target so toggling never loses a pick) ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");

  // —— Prompt + model + thinking (visible BEFORE the first send) ——
  const [prompt, setPrompt] = React.useState("");
  const [model, setModel] = React.useState<ModelId>(
    () => resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL,
  );
  const reasoningEffort = composerPrefs.reasoningEffort;
  const setReasoningEffort = React.useCallback(
    (e: ReasoningEffort | null) => setComposerPrefs({ reasoningEffort: e }),
    [setComposerPrefs],
  );
  const resolved = resolveModel(model);
  const effortOptions = React.useMemo(() => (resolved ? reasoningOptions(resolved) : []), [resolved]);

  // Switching models drops a thinking tier the new model can't do — same guard
  // the chat composer uses, so we never show (or persist) an unsupported effort.
  const changeModel = React.useCallback(
    (m: ModelId) => {
      setModel(m);
      const next = resolveModel(m);
      if (next) {
        const opts = reasoningOptions(next);
        if (!opts.some((o) => o.value === reasoningEffort)) setReasoningEffort(defaultReasoning(next));
      }
    },
    [reasoningEffort, setReasoningEffort],
  );

  // —— Submission ——
  const [submitting, setSubmitting] = React.useState(false);
  const [cloudStartError, setCloudStartError] = React.useState<CloudStartError>(null);
  // Reuse one cloud conversation across retries so a transient dispatch failure
  // doesn't leak an empty session on every attempt.
  const cloudConversationId = React.useRef<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

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
  const hasPrompt = prompt.trim().length > 0;
  const canSubmit = hasTarget && hasPrompt && !submitting;

  const startDevice = React.useCallback(
    async (w: Workspace, text: string) => {
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
      // Hand the first prompt off to the session view, which dispatches it once
      // the Mac is reachable (create contract stays prompt-free for device).
      try {
        sessionStorage.setItem(`${CODE_PENDING_PROMPT_PREFIX}${conversation.id}`, text);
      } catch {}
      // Carry the chosen model into the client-side session record.
      upsertConversation({ ...conversation, model });
      router.push(`/chat/${conversation.id}`);
    },
    [model, router, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null) => {
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

      // 2) Dispatch the cloud task against the selected repo.
      const tRes = await fetch("/api/code/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "cloud",
          repo: { owner: repo.owner, name: repo.name },
          baseRef: ref ?? undefined,
          prompt: text,
          title: text.slice(0, 60),
          conversationId,
        }),
      });

      if (tRes.ok) {
        if (conversation) {
          upsertConversation({ ...conversation, title: text.slice(0, 48), titleSource: "manual", model });
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
    },
    [model, router, upsertConversation],
  );

  const submit = React.useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    if (target === "device" ? !selectedWorkspace : !selectedRepo) return;

    setSubmitting(true);
    setCloudStartError(null);
    try {
      if (target === "device" && selectedWorkspace) {
        await startDevice(selectedWorkspace, text);
      } else if (target === "cloud" && selectedRepo) {
        await startCloud(selectedRepo, text, baseRef.trim() || null);
      }
    } catch {
      toast.error("Could not start the session. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting, target, selectedWorkspace, selectedRepo, baseRef, startDevice, startCloud]);

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

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto">
      {/* Back-to-chat control floats over the surface instead of taking a row, so
          the greeting + composer center in the FULL viewport rather than in the
          space left below a top bar. */}
      <div className="absolute left-2 top-2 z-10 sm:left-3 sm:top-3">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
          <Link href="/chat">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </div>

      {/* Greeting + composer, centered as one calm group and free to scroll on
          short viewports. py accounts for the floating back button so a short
          viewport never tucks the greeting under it. */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-14 sm:px-6">
        <div className="flex w-full max-w-[44rem] flex-col items-center gap-7 sm:gap-9">
          <CodeGreeting />

          <div className="w-full">
            <div
              className={cn(
                "relative flex w-full flex-col rounded-panel border border-border/70 bg-card/90 shadow-float backdrop-blur",
                "transition-[border-color,box-shadow] duration-base ease-out-soft",
                "focus-within:border-primary/30 focus-within:shadow-glass",
              )}
            >
              {/* Chip row — where this session runs. */}
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-0 pt-2.5">
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
                  }}
                  baseRef={baseRef}
                  onBaseRefChange={setBaseRef}
                  disabled={submitting}
                />
              </div>

              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={submitting}
                placeholder="Describe a task or ask a question"
                aria-label="Describe the task for this Juno Code session"
                className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-3.5 py-3 text-body-lg leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 sm:px-4"
              />

              {/* Toolbar — model + thinking are visible up front (the whole point),
                  and wrap gracefully before they ever clip. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2.5 pb-2.5 pt-0.5">
                <div className="flex min-w-0 flex-1 basis-[11rem] flex-wrap items-center gap-1">
                  <div className={cn("min-w-0 shrink", submitting && "pointer-events-none opacity-60")}>
                    <ModelSelector
                      value={model}
                      onChange={changeModel}
                      reasoningEffort={reasoningEffort}
                      onReasoningChange={setReasoningEffort}
                    />
                  </div>

                  {effortOptions.length > 0 && (() => {
                    const currentEffort = effortOptions.find((e) => e.value === reasoningEffort) ?? effortOptions[0];
                    const atTopTier =
                      effortOptions.length > 1 && currentEffort.value === effortOptions[effortOptions.length - 1].value;
                    return (
                      <>
                        <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block" aria-hidden="true" />
                        <Tooltip>
                          <Popover>
                            <PopoverTrigger asChild>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={submitting}
                                  aria-label={`Thinking effort: ${currentEffort.label}`}
                                  className={cn(
                                    "group h-8 gap-1 rounded-[10px] px-2 font-mono text-[13px] tracking-tight hover:text-foreground focus-visible:bg-accent focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:bg-accent data-[state=open]:text-foreground",
                                    atTopTier ? "text-ultra" : "text-foreground/80",
                                  )}
                                >
                                  {currentEffort.label}
                                  <ChevronDown className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                                </Button>
                              </TooltipTrigger>
                            </PopoverTrigger>
                            <PopoverContent align="start" sideOffset={10} className="w-[264px] origin-popper p-3">
                              <ReasoningSlider options={effortOptions} value={reasoningEffort} onChange={setReasoningEffort} />
                            </PopoverContent>
                          </Popover>
                          <TooltipContent>Thinking effort</TooltipContent>
                        </Tooltip>
                      </>
                    );
                  })()}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        onClick={() => void submit()}
                        disabled={!canSubmit}
                        aria-label={
                          !hasTarget
                            ? gateHint ?? "Select where to run first"
                            : target === "cloud"
                              ? "Start a cloud run"
                              : "Start the session"
                        }
                        className="rounded-lg coarse:h-11 coarse:w-11"
                      >
                        {submitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{target === "cloud" ? "Start cloud run" : "Start session"}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Inline task-dispatch failures (cloud only). */}
            {cloudStartError === "not_configured" && (
              <p
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-sm text-warning-foreground motion-safe:animate-rise-in"
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
              <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive motion-safe:animate-rise-in">
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
