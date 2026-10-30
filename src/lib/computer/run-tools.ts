/**
 * The Work runner's side of an agent's computer (docs/design/agents-v2/COMPUTERS_2026-10.md
 * §S1.5): the holder that starts the computer on the first computer tool call,
 * the `browser` tool's switch between the temporary browser and the
 * computer's (D15), which computer tools a model is offered, and the shell
 * call that keeps `cwd` out of the command string.
 *
 * No `server-only` import and no runtime import of the agent-core package:
 * the runner builds the definitions, and this file is unit-tested on its own.
 */

import { BROWSER_NOW_COMPUTER_RESULT, START_DECLINED_RESULT } from "./access-copy";
import { recordComputerAudit } from "./audit";
import type { AttachedRunComputer, RunComputerPlan } from "./store";
import type { ComputerHandle, ComputerProvider, ExecOptions, ExecResult } from "./types";

/** Every computer tool the runtime builds (agent-core `REMOTE_TOOL_NAMES`). */
export const COMPUTER_TOOL_NAMES = [
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_drag",
  "computer_wait",
  "computer_zoom",
  "computer_shell",
  "computer_files",
] as const;

/** The two that need no eyes. */
const NON_VISUAL_TOOL_NAMES = ["computer_shell", "computer_files"] as const;

/**
 * Which computer tools a model is offered: all of them to a model that can
 * see a screenshot, and only the shell and the files to one that cannot
 * (a pixel tool answers with an image the model would never see).
 */
export function computerToolNamesFor(model: { vision: boolean }): readonly string[] {
  return model.vision ? COMPUTER_TOOL_NAMES : NON_VISUAL_TOOL_NAMES;
}

/**
 * `computer_shell`'s command, run in its working directory. The directory
 * goes to the provider, which validates it (realpath under /home/agent) and
 * passes it as `--workdir`; the command string is passed unchanged. It used to
 * be `cd "<cwd>" && (<command>)`, where `$(...)` in the directory ran.
 */
export function runComputerShell(
  provider: Pick<ComputerProvider, "exec">,
  handle: ComputerHandle,
  command: string,
  opts: { timeoutSeconds: number; cwd?: string; onOutput?: ExecOptions["onOutput"] },
): Promise<ExecResult> {
  return provider.exec(handle, command, {
    timeoutSeconds: opts.timeoutSeconds,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
  });
}

/**
 * `computer_shell` with its output streamed to the person's terminal pane
 * (S5.1): the command row before it runs, each piece as it arrives, the exit
 * row after. The log is only watched; the result is the provider's, exactly
 * as `runComputerShell` returns it, and a log that fails to write changes
 * nothing about the command.
 */
export async function runWatchedComputerShell(
  provider: Pick<ComputerProvider, "exec">,
  handle: ComputerHandle,
  command: string,
  opts: { timeoutSeconds: number; cwd?: string },
  log: { call(callId: string, command: string): { append(chunk: { stream: "stdout" | "stderr"; text: string }): void; end(result: { exitCode: number; timedOut: boolean }): Promise<void> } } | null,
  callId: string | undefined,
): Promise<ExecResult> {
  if (!log || !callId) return runComputerShell(provider, handle, command, opts);
  const call = log.call(callId, command);
  let result: ExecResult | null = null;
  try {
    result = await runComputerShell(provider, handle, command, { ...opts, onOutput: (chunk) => call.append(chunk) });
    return result;
  } finally {
    await call.end(result ? { exitCode: result.exitCode, timedOut: result.timedOut } : { exitCode: -1, timedOut: false });
  }
}

/** Mirrors agent-core's `StartState`. */
export type StartState = "ready" | "needs_start" | "needs_approval" | "start_pending" | "declined" | "refused";

/** The run's own `work.computer.start` approval, as its latest row says. */
export type StartApprovalState = "none" | "pending" | "approved" | "declined";

/** Reads the run's latest start approval (a read of the Work approval rows; nothing here writes one). */
export async function readRunStartApproval(userId: string, runId: string): Promise<StartApprovalState> {
  const { prisma } = await import("@/lib/db");
  const row = await prisma.workApproval.findFirst({
    where: { userId, runId, action: "work.computer.start" },
    orderBy: { createdAt: "desc" },
    select: { decision: true },
  });
  return startApprovalStateOf(row?.decision ?? null);
}

/** A stored decision as the start gate reads it. `superseded` (an ended execution's card) is no card at all. */
export function startApprovalStateOf(decision: string | null): StartApprovalState {
  switch (decision) {
    case "pending":
      return "pending";
    case "allowed":
    case "allowed_always":
      return "approved";
    case "denied":
    case "expired":
      return "declined";
    default:
      return "none";
  }
}

/** Mirrors agent-core's `ComputerStartGate`. */
export interface RunComputerStartGate {
  refresh(): Promise<void>;
  state(): StartState;
  agentName: string;
  start(how: { approvedStart: boolean }): Promise<string | null>;
  noteStartUnanswered(): void;
  onStartRequested(): void;
}

export interface LazyRunComputer<B> {
  readonly agentId: string;
  readonly agentName: string;
  /** The policy the run began with. */
  readonly policy: "ask" | "allowed";
  /** Re-reads the policy and the run's start approval. */
  refresh(): Promise<void>;
  /** null when started (or already on), else the sentence for the model. */
  ensureStarted(how: { approvedStart: boolean }): Promise<string | null>;
  attachment(): AttachedRunComputer | null;
  /** The computer's browser, once started. */
  browser(): B | null;
  started(): boolean;
  startState(): StartState;
  /** The refusal sentence while `startState()` is `refused`, else null. */
  refusal(): string | null;
  gate: RunComputerStartGate;
  /** Closes the computer's browser and releases the lease. */
  dispose(): Promise<void>;
}

/**
 * The holder a run keeps for its agent's computer. Nothing starts until a
 * computer tool asks (`ensureStarted`); the policy is re-read at every start
 * and every refresh, never trusted from the run's beginning.
 *
 * Refusals that hold for the run (access, the allowance, the computer cap)
 * stay; the policy's own refusal follows the policy (switched back on, the
 * next call can start it); a busy or unreachable computer is tried again on
 * the next call.
 */
export function createLazyRunComputer<B extends { close(): Promise<void> }>(input: {
  plan: Extract<RunComputerPlan, { kind: "lazy" }>;
  userId: string;
  runId: string;
  connectBrowser: (attachment: AttachedRunComputer) => B;
  readStartApproval: () => Promise<StartApprovalState>;
}): LazyRunComputer<B> {
  const { plan } = input;
  let policy: "off" | "ask" | "allowed" = plan.policy;
  let approval: StartApprovalState = "none";
  let declinedHere = false;
  let sticky: string | null = null;
  let attachment: AttachedRunComputer | null = null;
  let browser: B | null = null;

  const state = (): StartState => {
    if (policy === "off") return "refused";
    if (sticky) return "refused";
    if (attachment) return "ready";
    if (approval === "approved" || policy === "allowed") return "needs_start";
    if (approval === "pending") return "start_pending";
    if (approval === "declined" || declinedHere) return "declined";
    return "needs_approval";
  };

  const refresh = async () => {
    const [nextPolicy, nextApproval] = await Promise.all([
      plan.currentPolicy().catch(() => policy),
      input.readStartApproval().catch(() => approval),
    ]);
    policy = nextPolicy;
    approval = nextApproval;
  };

  const ensureStarted = async (how: { approvedStart: boolean }): Promise<string | null> => {
    if (sticky) return sticky;
    const result = await plan.start({ approvedStart: how.approvedStart || approval === "approved" });
    if (result.attached) {
      if (!attachment) {
        attachment = result;
        try {
          browser = input.connectBrowser(result);
        } catch {
          // The tools still work without the page tools; the browser stays temporary.
          browser = null;
        }
      }
      // The store read the policy as on to start it.
      if (policy === "off") policy = plan.policy;
      return null;
    }
    if (result.fallbackReason === "policy_off") policy = "off";
    else if (result.fallbackReason === "needs_approval") policy = "ask";
    else if (result.fallbackReason === "refused") sticky = result.note ?? START_DECLINED_RESULT;
    return result.note ?? START_DECLINED_RESULT;
  };

  /** The run's standing refusal (access, the allowance, the cap), while there is one. */
  const refusal = (): string | null => (state() === "refused" ? sticky : null);

  const gate: RunComputerStartGate = {
    agentName: plan.agentName,
    refresh,
    state,
    start: ensureStarted,
    noteStartUnanswered() {
      declinedHere = true;
    },
    onStartRequested() {
      void recordComputerAudit({
        userId: input.userId,
        agentId: plan.agentId,
        kind: "start_requested",
        actor: "runner",
        detail: { runId: input.runId },
      });
    },
  };

  return {
    agentId: plan.agentId,
    agentName: plan.agentName,
    policy: plan.policy,
    refresh,
    ensureStarted,
    attachment: () => attachment,
    browser: () => browser,
    started: () => attachment !== null,
    startState: state,
    refusal,
    gate,
    async dispose() {
      if (browser) await browser.close().catch(() => {});
      if (attachment) await attachment.release();
    },
  };
}

/** The part of the Work browser the switch forwards. Structural, so the runner's `WorkBrowser` fits. */
export interface SwitchableBrowser {
  available(): boolean;
  open(url: string): Promise<unknown>;
  read(): Promise<unknown>;
  click(target: { ref?: number; selector?: string }): Promise<unknown>;
  typeText(target: { ref?: number; selector?: string }, text: string): Promise<unknown>;
  submit(target: { ref?: number; selector?: string }): Promise<unknown>;
  currentUrl(): string;
  submitMethod(target: { ref?: number; selector?: string }): "get" | "post" | null;
  pageTakesPayment(): boolean;
  close(): Promise<void>;
  fieldKind?(target: { ref?: number; selector?: string }): Promise<unknown>;
  fillSecret?(target: { ref?: number; selector?: string }, value: string, opts: { requirePasswordField: boolean }): Promise<unknown>;
}

export interface RunBrowserSwitch<B extends SwitchableBrowser> {
  /** The browser the `browser` tool drives. */
  browser: B;
  /** A sentence the next `browser` result should lead with, once, or null. */
  takeNotice(): string | null;
  /** Closes the temporary browser, if one was opened. */
  close(): Promise<void>;
}

/**
 * The `browser` tool's browser when the agent has a computer (D15).
 *
 * - `allowed`: the computer's browser. Its first call starts the computer
 *   (never with a card); if that is refused, the rest of the run uses the
 *   temporary browser it would have had without a computer, and the first
 *   result says why.
 * - `ask`: the temporary browser until a computer tool started the computer in
 *   this run, then the computer's, and the first result there says so.
 * - Either way, a computer switched off for tasks mid-run is left: the rest of
 *   the run browses in the temporary browser.
 *
 * It never raises the start card: browsing under `ask` is exactly what it was
 * before computers existed.
 */
export function createRunBrowserSwitch<B extends SwitchableBrowser>(input: {
  lazy: LazyRunComputer<B>;
  temporary: () => B;
}): RunBrowserSwitch<B> {
  const { lazy } = input;
  let temp: B | null = null;
  let temporaryForGood = false;
  let announcedComputer = false;
  let notice: string | null = null;
  let lastUsed: B | null = null;

  const temporary = (): B => (temp ??= input.temporary());

  /** The browser for one call, starting the computer first under `allowed`. */
  const pick = async (): Promise<B> => {
    if (!temporaryForGood && lazy.policy === "allowed" && !lazy.started()) {
      const refusal = await lazy.ensureStarted({ approvedStart: false });
      if (refusal) {
        temporaryForGood = true;
        notice = refusal;
      }
    }
    if (!temporaryForGood && lazy.started()) {
      await lazy.refresh().catch(() => undefined);
      if (lazy.startState() === "refused") {
        temporaryForGood = true;
        notice = (await lazy.ensureStarted({ approvedStart: false })) ?? null;
      }
    }
    const computerBrowser = lazy.browser();
    if (!temporaryForGood && lazy.started() && computerBrowser) {
      if (lazy.policy === "ask" && !announcedComputer) {
        announcedComputer = true;
        notice = BROWSER_NOW_COMPUTER_RESULT;
      }
      return (lastUsed = computerBrowser);
    }
    return (lastUsed = temporary());
  };

  /** For the synchronous reads: the browser the last call used, else the temporary one. */
  const current = (): B => lastUsed ?? (lazy.started() && lazy.browser() && !temporaryForGood ? lazy.browser()! : temporary());

  const forward = {
    available: () => current().available(),
    open: async (url: string) => (await pick()).open(url),
    read: async () => (await pick()).read(),
    click: async (target: { ref?: number; selector?: string }) => (await pick()).click(target),
    typeText: async (target: { ref?: number; selector?: string }, text: string) => (await pick()).typeText(target, text),
    submit: async (target: { ref?: number; selector?: string }) => (await pick()).submit(target),
    currentUrl: () => current().currentUrl(),
    submitMethod: (target: { ref?: number; selector?: string }) => current().submitMethod(target),
    pageTakesPayment: () => current().pageTakesPayment(),
    async fieldKind(target: { ref?: number; selector?: string }) {
      const b = await pick();
      return b.fieldKind ? b.fieldKind(target) : null;
    },
    async fillSecret(target: { ref?: number; selector?: string }, value: string, opts: { requirePasswordField: boolean }) {
      const b = await pick();
      return b.fillSecret
        ? b.fillSecret(target, value, opts)
        : { ok: false, message: "This browser cannot fill saved credentials." };
    },
    // The computer's browser is closed with the computer (`LazyRunComputer.dispose`).
    close: async () => {
      if (temp) await temp.close().catch(() => {});
    },
  };

  return {
    browser: forward as unknown as B,
    takeNotice() {
      const next = notice;
      notice = null;
      return next;
    },
    close: forward.close,
  };
}

/**
 * Leads the `browser` tool's next result with the switch's notice, once.
 * Structural over the tool definition, so the runner wraps the runtime's own.
 */
export function withBrowserNotice<T extends { execute(input: Record<string, unknown>, ctx: never): Promise<{ output: string }> }>(
  definition: T,
  takeNotice: () => string | null,
): T {
  return {
    ...definition,
    async execute(input: Record<string, unknown>, ctx: never) {
      const result = await definition.execute(input, ctx);
      const notice = takeNotice();
      return notice ? { ...result, output: `${notice}\n\n${result.output}` } : result;
    },
  };
}
