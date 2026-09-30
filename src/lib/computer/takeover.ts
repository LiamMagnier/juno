/**
 * Exclusive takeover of a crew member's computer (D-011, security audit C3).
 *
 * While the person has control, the agent does not: every computer tool
 * (screenshots included) and the browser tool on the same Chromium refuse, so
 * nothing the person types or sees reaches the model, and the agent's clicks
 * and keys cannot interleave with theirs. Hand back ends it and the agent
 * carries on.
 *
 * The lock is `AgentComputer.takeoverUntil`, a window rather than a flag:
 * taking control opens it, every control heartbeat (web viewer and the apps,
 * every 20 seconds) extends it, Hand back closes it, and a window nobody
 * extends lapses on its own. A closed tab or a crashed app therefore hands the
 * computer back after `TAKEOVER_WINDOW_MS` instead of stranding the task.
 *
 * The runner is another process and reads the row before every tool call
 * (`computerBlockedReason` in store.ts); this file is the pure part, tested in
 * `tests/agent-computer-takeover.test.ts`.
 */

/**
 * How long one heartbeat holds the takeover. Three heartbeats' worth, so a
 * slow network or a backgrounded tab for a few seconds does not hand the
 * computer back while the person is still typing.
 */
export const TAKEOVER_WINDOW_MS = 60_000;

/** What every refused tool call tells the model. */
export const TAKEOVER_REFUSAL =
  "The person has taken control of this computer. Nothing was done. Wait for them to hand it back, then carry on from where the screen is.";

export interface TakeoverState {
  takeoverUntil?: Date | null;
  takeoverStartedAt?: Date | null;
  takeoverBy?: string | null;
}

/** Whether the person holds the computer at `now`. */
export function takeoverActive(state: TakeoverState | null | undefined, now: Date): boolean {
  const until = state?.takeoverUntil;
  return until instanceof Date && until.getTime() > now.getTime();
}

/** The fields that open or extend a takeover. Extending keeps when it started and who holds it. */
export function takeoverOpened(input: {
  state: TakeoverState | null | undefined;
  by: string;
  now: Date;
}): Required<TakeoverState> {
  const continuing = takeoverActive(input.state, input.now);
  return {
    takeoverUntil: new Date(input.now.getTime() + TAKEOVER_WINDOW_MS),
    takeoverStartedAt: continuing && input.state?.takeoverStartedAt ? input.state.takeoverStartedAt : input.now,
    takeoverBy: continuing && input.state?.takeoverBy ? input.state.takeoverBy : input.by,
  };
}

/** The fields that end a takeover (Hand back). */
export function takeoverClosed(): Required<TakeoverState> {
  return { takeoverUntil: null, takeoverStartedAt: null, takeoverBy: null };
}

/**
 * Who a takeover is recorded against: the web, or one app install by its
 * device session. Never an email or a name: this lands in the agent's log.
 */
export function takeoverHolder(deviceSessionId: string | null | undefined): string {
  return deviceSessionId ? `native:${deviceSessionId}` : "web";
}

/** The subset of the Work browser a takeover has to stop (src/lib/work/browser.ts). */
interface GuardableBrowser {
  open(url: string): Promise<{ ok: boolean; message?: string }>;
  read(): Promise<{ ok: boolean; message?: string }>;
  click(target: { ref?: number; selector?: string }): Promise<{ ok: boolean; message?: string }>;
  typeText(target: { ref?: number; selector?: string }, text: string): Promise<{ ok: boolean; message?: string }>;
  submit(target: { ref?: number; selector?: string }): Promise<{ ok: boolean; message?: string }>;
}

/**
 * The `browser` tool drives the same Chromium the person is using during a
 * takeover, so it is stopped too: every call that reads the page or acts on it
 * answers with the takeover sentence instead, and a read that finished as a
 * takeover began is discarded. Everything else passes through unchanged.
 */
export function guardBrowserForTakeover<T extends GuardableBrowser>(
  browser: T,
  blockedReason: () => Promise<string | null>
): T {
  const refuse = (message: string) => ({ ok: false as const, message });
  const around =
    <A extends unknown[]>(call: (...args: A) => Promise<{ ok: boolean; message?: string }>) =>
    async (...args: A) => {
      const before = await blockedReason();
      if (before) return refuse(before);
      const result = await call(...args);
      const after = await blockedReason();
      return after ? refuse(after) : result;
    };
  // The browsers are object literals of closures (remote-browser.ts), so a
  // spread keeps every other method working as it was.
  return {
    ...browser,
    open: around((url: string) => browser.open(url)),
    read: around(() => browser.read()),
    click: around((target: { ref?: number; selector?: string }) => browser.click(target)),
    typeText: around((target: { ref?: number; selector?: string }, text: string) => browser.typeText(target, text)),
    submit: around((target: { ref?: number; selector?: string }) => browser.submit(target)),
  } as T;
}
