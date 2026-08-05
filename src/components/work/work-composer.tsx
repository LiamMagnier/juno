"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, Check, ChevronDown, Cloud, Laptop, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  WORK_CAPABILITIES,
  describeCapability,
  selectTarget,
  type HostCapabilityView,
  type WorkCapability,
  type WorkTarget,
} from "@/lib/work/domain";
import type { ClientWorkHost, ClientWorkSession } from "@/lib/work/serializers";
import {
  WORK_SYNC_EVENT,
  createWorkSession,
  hostCapabilities,
  hostIsReachable,
  hostUnavailableReason,
  startWorkRun,
  workIdempotencyKey,
  type WorkBlocked,
} from "@/components/work/work-transport";
import { DegradationNotes, WorkStateNote } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * "Give Juno a task" — the Work home composer.
 *
 * The interesting part is not the textarea, it is the two chips above it: where
 * this should run, and what it is allowed to need. Both feed `selectTarget`
 * from src/lib/work/domain.ts, which is the same function the server runs when
 * the task is dispatched. Running it here as well is what lets the button say
 * "this cannot run" BEFORE the task is created, rather than creating a task that
 * sits queued at an executor that does not exist.
 *
 * Starting is two requests, because the server splits them: POST /sessions
 * writes a draft that costs nothing and holds no executor, and POST
 * /sessions/[id]/runs is the only thing that dispatches and the only thing that
 * can refuse. Both are sent with idempotency keys held across retries, so
 * pressing the button again after a refusal reuses the draft instead of leaving
 * a trail of abandoned ones.
 */

/** Automatic, the cloud, or one particular Mac by id. */
type TargetChoice = { kind: "automatic" } | { kind: "cloud" } | { kind: "host"; hostId: string };

function sameChoice(a: TargetChoice, b: TargetChoice): boolean {
  return a.kind === b.kind && (a.kind !== "host" || b.kind !== "host" || a.hostId === b.hostId);
}

function requestedTargetFor(choice: TargetChoice): WorkTarget {
  return choice.kind === "cloud" ? "cloud" : choice.kind === "host" ? "local" : "automatic";
}

/**
 * One attempt at starting, carried across retries.
 *
 * The two keys are minted once per attempt rather than per press. A press that
 * created the draft and then failed to dispatch must, on the next press, land on
 * the same draft — `POST /sessions` replays an existing id for a repeated key —
 * or every refused start leaves another orphan in the user's task list.
 */
interface StartAttempt {
  goal: string;
  sessionKey: string;
  runKey: string;
  session: ClientWorkSession | null;
}

export function WorkComposer({
  hosts,
  hostsFailed,
  onRetryHosts,
}: {
  /** Null while the host list is still loading. */
  hosts: ClientWorkHost[] | null;
  hostsFailed: boolean;
  onRetryHosts: () => void;
}) {
  const router = useRouter();
  const [goal, setGoal] = React.useState("");
  const [choice, setChoice] = React.useState<TargetChoice>({ kind: "automatic" });
  const [needs, setNeeds] = React.useState<readonly WorkCapability[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [blocked, setBlocked] = React.useState<WorkBlocked | null>(null);
  const [draft, setDraft] = React.useState<ClientWorkSession | null>(null);
  const [dispatchFailed, setDispatchFailed] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const attemptRef = React.useRef<StartAttempt | null>(null);

  const autoresize = React.useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [goal, autoresize]);

  // A Mac that stops being reachable while the page is open must not stay
  // selected — the composer would keep offering to run there and the dispatch
  // would be refused. Falling back to Automatic keeps the preview truthful.
  React.useEffect(() => {
    if (choice.kind !== "host" || hosts === null) return;
    const host = hosts.find((candidate) => candidate.id === choice.hostId);
    if (!host || !hostIsReachable(host)) setChoice({ kind: "automatic" });
  }, [choice, hosts]);

  const reachableHosts = React.useMemo(() => (hosts ?? []).filter(hostIsReachable), [hosts]);

  /**
   * The hosts `selectTarget` is allowed to consider, in preference order.
   *
   * Choosing a named Mac passes that Mac alone. Passing the whole list with it
   * first would let the selector silently fall through to a different machine,
   * and "run this on the studio Mac" is a request, not a hint.
   */
  const candidateHosts: HostCapabilityView[] = React.useMemo(() => {
    const usable =
      choice.kind === "host"
        ? reachableHosts.filter((host) => host.id === choice.hostId)
        : reachableHosts;
    return usable.map((host) => ({
      hostId: host.id,
      displayName: host.displayName,
      state: host.state,
      enabled: host.enabled,
      revoked: host.revokedAt !== null,
      capabilities: hostCapabilities(host),
    }));
  }, [choice, reachableHosts]);

  const selection = React.useMemo(
    () =>
      selectTarget({
        requested: requestedTargetFor(choice),
        required: needs,
        hosts: candidateHosts,
        // The browser has no way to observe whether the cloud executor is
        // accepting work — `/api/work/hosts` describes Macs and nothing else —
        // so the preview assumes it is and lets the dispatch be the authority.
        // Assuming the other way would grey out the primary action on the basis
        // of a fact nobody established. When the cloud really is paused the
        // dispatch answers 409 with the server's own sentence, which is shown
        // below in place of this preview.
        cloudAvailable: true,
      }),
    [choice, needs, candidateHosts]
  );

  const loadingHosts = hosts === null && !hostsFailed;
  // A failed host load is not the same as "nothing is available": Juno simply
  // does not know. A local task previewed against an empty host list would be
  // refused here for a reason that is about this page's network, not about the
  // user's Macs.
  const executorsUnknown = hostsFailed && hosts === null;
  const canStart =
    goal.trim().length > 0 &&
    !submitting &&
    !loadingHosts &&
    !executorsUnknown &&
    selection.target !== null;

  const submit = React.useCallback(async () => {
    const text = goal.trim();
    if (!text || submitting || selection.target === null) return;

    // A new attempt only when the goal itself changed. Re-pressing after a
    // refusal keeps the keys, so the draft created by the first press is the one
    // dispatched by the second rather than a sibling of it.
    let attempt = attemptRef.current;
    if (attempt === null || attempt.goal !== text) {
      attempt = { goal: text, sessionKey: workIdempotencyKey(), runKey: workIdempotencyKey(), session: null };
      attemptRef.current = attempt;
    }

    setSubmitting(true);
    setBlocked(null);
    setDispatchFailed(false);

    let session = attempt.session;
    if (session === null) {
      const created = await createWorkSession({
        goal: text,
        requestedTarget: requestedTargetFor(choice),
        preferredHostId: choice.kind === "host" ? choice.hostId : null,
        idempotencyKey: attempt.sessionKey,
      });
      if (created.kind !== "ok") {
        setSubmitting(false);
        if (created.kind === "blocked") {
          setBlocked(created);
          return;
        }
        setDispatchFailed(true);
        toast.error(
          created.cause === "offline"
            ? "Couldn’t reach Juno to save the task. Check your connection."
            : "Couldn’t save the task. Nothing was started, so trying again is safe."
        );
        return;
      }
      session = created.value;
      attempt.session = session;
      setDraft(session);
      // The sidebar mounts once and polls on its own clock, so without this the
      // draft the user just created is missing from the list beside them.
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
    }

    const started = await startWorkRun(session.id, {
      origin: "manual",
      requiredCapabilities: needs,
      requestedTarget: requestedTargetFor(choice),
      idempotencyKey: attempt.runKey,
    });
    setSubmitting(false);

    if (started.kind === "ok") {
      setGoal("");
      setDraft(null);
      attemptRef.current = null;
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      router.push(`/work/${session.id}`);
      return;
    }
    if (started.kind === "blocked") {
      // The server re-ran the same selection against fresher facts and refused.
      // Its sentence replaces the preview rather than sitting beside it, and the
      // draft it refused to run is linked so the task is not simply lost.
      setBlocked(started);
      return;
    }
    setDispatchFailed(true);
    toast.error(
      started.cause === "offline"
        ? "Couldn’t reach Juno to start the task. It has been saved as a draft."
        : "Couldn’t start the task. It has been saved as a draft, so nothing is lost."
    );
  }, [goal, submitting, selection.target, choice, needs, router]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canStart) void submit();
    }
  };

  const draftLink =
    draft === null ? null : (
      <Link
        href={`/work/${draft.id}`}
        className="font-medium underline underline-offset-2 hover:text-foreground"
      >
        Open the draft
      </Link>
    );

  return (
    <div className="w-full">
      <div className="composer-surface relative flex w-full flex-col rounded-[22px] border border-border/65 bg-card/95 backdrop-blur transition-[border-color,box-shadow] duration-base ease-spring focus-within:border-foreground/15 sm:rounded-[24px]">
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-0 pt-3 sm:px-3.5 sm:pt-3.5">
          <TargetPicker
            hosts={hosts}
            hostsFailed={hostsFailed}
            onRetryHosts={onRetryHosts}
            choice={choice}
            onChoose={(next) => {
              setChoice(next);
              setBlocked(null);
            }}
            disabled={submitting}
          />
          <NeedsPicker
            needs={needs}
            onChange={(next) => {
              setNeeds(next);
              setBlocked(null);
            }}
            disabled={submitting}
          />
        </div>

        <textarea
          ref={textareaRef}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={submitting}
          placeholder="Describe the task — what you want done, and what “done” looks like"
          aria-label="Describe the task for Juno to carry out"
          className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]"
        />

        <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-2 pt-0.5 sm:px-2.5 sm:pb-2.5">
          <p
            className="min-w-0 flex-1 truncate pl-1.5 text-caption text-muted-foreground"
            title={selection.explanation}
          >
            {executorsUnknown
              ? "Juno couldn’t check where this can run."
              : loadingHosts
                ? "Checking where this can run…"
                : selection.explanation}
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <Button
                  type="button"
                  size="icon"
                  onClick={() => void submit()}
                  disabled={!canStart}
                  aria-label={selection.target === null ? selection.explanation : "Start this task"}
                  className="composer-primary-action h-9 w-9 rounded-[13px] coarse:h-11 coarse:w-11"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="composer-send-icon h-4 w-4" aria-hidden="true" />
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Start task</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Everything below the composer is the honest answer to "will this
          actually run", newest fact last: the local preview, then whatever the
          server said when it disagreed. */}
      {executorsUnknown && (
        <WorkStateNote
          tone="error"
          className="mt-2.5 motion-safe:animate-rise-in"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={onRetryHosts}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Juno couldn’t reach the list of executors, so it can’t tell you whether anything would
          pick this up. Starting is held back rather than queued into the dark.
        </WorkStateNote>
      )}
      {blocked === null && !executorsUnknown && selection.target === null && !loadingHosts && (
        <WorkStateNote tone="blocked" className="mt-2.5 motion-safe:animate-rise-in">
          {selection.explanation}
        </WorkStateNote>
      )}
      {blocked === null &&
        !executorsUnknown &&
        selection.target !== null &&
        selection.degradation.length > 0 && (
          <div className="mt-2.5 rounded-xl border border-warning/35 bg-warning/5 px-3.5 py-2.5 motion-safe:animate-rise-in">
            <DegradationNotes degradation={selection.degradation} />
          </div>
        )}
      {blocked !== null && (
        <WorkStateNote tone="blocked" className="mt-2.5 motion-safe:animate-rise-in">
          <p>{blocked.explanation}</p>
          <DegradationNotes degradation={blocked.degradation} className="mt-2" />
          {draftLink !== null && (
            <p className="mt-2 text-[12.5px]">
              Nothing was queued. The task is saved as a draft. {draftLink}
            </p>
          )}
        </WorkStateNote>
      )}
      {dispatchFailed && (
        <WorkStateNote
          tone="error"
          className="mt-2.5 motion-safe:animate-rise-in"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void submit()}
              disabled={!canStart}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          }
        >
          {draftLink === null ? (
            "Couldn’t save the task. Nothing was queued, so trying again is safe."
          ) : (
            <>Couldn’t start it. The task is saved as a draft. {draftLink}</>
          )}
        </WorkStateNote>
      )}
    </div>
  );
}

/* ─────────────────────────── where it should run ────────────────────────── */

function TargetPicker({
  hosts,
  hostsFailed,
  onRetryHosts,
  choice,
  onChoose,
  disabled,
}: {
  hosts: ClientWorkHost[] | null;
  hostsFailed: boolean;
  onRetryHosts: () => void;
  choice: TargetChoice;
  onChoose: (choice: TargetChoice) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const chosenHost =
    choice.kind === "host" ? hosts?.find((host) => host.id === choice.hostId) : undefined;
  const label =
    choice.kind === "automatic"
      ? "Automatic"
      : choice.kind === "cloud"
        ? "Cloud"
        : chosenHost?.displayName ?? "Your Mac";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Where this runs: ${label}. Change it`}
          className="group min-w-0 max-w-[16rem] gap-1.5 px-2.5 text-[13px] font-medium"
        >
          {choice.kind === "cloud" ? (
            <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : choice.kind === "host" ? (
            <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-[calc(100vw-2rem)] max-w-[92vw] overflow-hidden p-0 sm:w-[24rem]"
      >
        <div className="border-b border-border/60 px-3 py-2.5">
          <p className="font-mono text-[10px] text-muted-foreground">Where this runs</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
            Only your Mac can touch your files, apps and signed-in browser. Only the cloud keeps
            going once every device is offline.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Where this task runs"
          className="max-h-[min(22rem,54vh)] space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
        >
          <TargetOption
            icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
            title="Automatic"
            note="Juno picks the cloud unless the task needs something only your Mac has."
            selected={sameChoice(choice, { kind: "automatic" })}
            onSelect={() => {
              onChoose({ kind: "automatic" });
              setOpen(false);
            }}
          />
          <TargetOption
            icon={<Cloud className="h-4 w-4" aria-hidden="true" />}
            title="Cloud"
            // Deliberately not claimed as "available". Whether the cloud executor
            // is accepting work is checked when the task is started, and this
            // page has no way to observe it beforehand; promising availability
            // here and refusing a second later is worse than saying neither.
            note="Runs on Juno’s machines and carries on when your devices are asleep. Availability is confirmed when you start."
            selected={sameChoice(choice, { kind: "cloud" })}
            onSelect={() => {
              onChoose({ kind: "cloud" });
              setOpen(false);
            }}
          />

          <div className="px-2.5 pb-1 pt-3">
            <p className="font-mono text-[10px] text-muted-foreground">Your Macs</p>
          </div>

          {hostsFailed && hosts === null ? (
            <div className="space-y-2.5 px-3 py-5 text-center">
              <p className="text-sm text-muted-foreground">
                Couldn’t load your Macs, so Juno can’t say which of them could take this.
              </p>
              <Button variant="outline" size="sm" onClick={onRetryHosts} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : hosts === null ? (
            <div className="space-y-1.5 p-1">
              {[...Array(2)].map((_, index) => (
                <Skeleton
                  key={index}
                  className="h-[52px] w-full rounded-xl"
                  style={{ animationDelay: `${index * 70}ms` }}
                />
              ))}
            </div>
          ) : hosts.length === 0 ? (
            <p className="px-3 py-5 text-center text-[13px] leading-relaxed text-muted-foreground">
              No Mac has been switched on for Juno Work yet. Open Juno on a Mac and turn Work on
              there to run tasks that touch your own files.
            </p>
          ) : (
            hosts.map((host) => {
              const reason = hostUnavailableReason(host);
              return (
                <TargetOption
                  key={host.id}
                  icon={<Laptop className="h-4 w-4" aria-hidden="true" />}
                  title={host.displayName}
                  note={reason ?? describeHostOffer(host)}
                  selected={sameChoice(choice, { kind: "host", hostId: host.id })}
                  unavailable={reason !== null}
                  onSelect={() => {
                    onChoose({ kind: "host", hostId: host.id });
                    setOpen(false);
                  }}
                />
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What a reachable Mac is actually offering, in the domain's own words. */
function describeHostOffer(host: ClientWorkHost): string {
  const capabilities = hostCapabilities(host);
  if (capabilities.length === 0) {
    return "Reachable, but every capability is switched off in its Juno settings.";
  }
  return `Can do ${capabilities.map(describeCapability).join(", ")}.`;
}

function TargetOption({
  icon,
  title,
  note,
  selected,
  unavailable = false,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  selected: boolean;
  unavailable?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // Rendered and disabled rather than hidden: a Mac the user expects to see
      // must appear with the reason it cannot take this, or they go looking for
      // a machine the list has silently dropped.
      disabled={unavailable}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-[background-color,box-shadow] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]",
        unavailable
          ? "cursor-not-allowed opacity-60"
          : selected
            ? "bg-primary/10 ring-1 ring-inset ring-primary/30"
            : "hover:bg-accent/60"
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
          selected && !unavailable ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{note}</span>
      </span>
      {selected && !unavailable && (
        <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      )}
    </button>
  );
}

/* ──────────────────────────── what it may need ──────────────────────────── */

function NeedsPicker({
  needs,
  onChange,
  disabled,
}: {
  needs: readonly WorkCapability[];
  onChange: (needs: readonly WorkCapability[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const label =
    needs.length === 0
      ? "Anything it needs"
      : needs.length === 1
        ? describeCapability(needs[0])
        : `${needs.length} requirements`;

  const toggle = (capability: WorkCapability) => {
    onChange(
      needs.includes(capability)
        ? needs.filter((entry) => entry !== capability)
        : [...needs, capability]
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`What this task needs: ${label}. Change it`}
          className="group min-w-0 max-w-[16rem] gap-1.5 px-2.5 text-[13px] font-medium"
        >
          <span className={cn("truncate", needs.length === 0 && "text-muted-foreground")}>{label}</span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-[calc(100vw-2rem)] max-w-[92vw] overflow-hidden p-0 sm:w-[22rem]"
      >
        <div className="border-b border-border/60 px-3 py-2.5">
          <p className="font-mono text-[10px] text-muted-foreground">What this needs</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
            Naming a requirement is what lets Juno tell you, before it starts, that nothing can
            serve it. Leave this empty and Juno works it out from the task.
          </p>
        </div>
        <div className="max-h-[min(20rem,50vh)] space-y-0.5 overflow-y-auto overscroll-contain p-1.5">
          {WORK_CAPABILITIES.map((capability) => {
            const active = needs.includes(capability);
            return (
              <button
                key={capability}
                type="button"
                role="checkbox"
                aria-checked={active}
                disabled={disabled}
                onClick={() => toggle(capability)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-[background-color] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                  active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/60"
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  )}
                  aria-hidden="true"
                >
                  {active && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{describeCapability(capability)}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
