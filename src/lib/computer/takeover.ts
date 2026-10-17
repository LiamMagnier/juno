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

/**
 * How long one control heartbeat from a hidden tab or a backgrounded app holds
 * the takeover. Switching to a password manager, an authenticator or an email
 * for a 2FA code hides the viewer, and an iPhone app may not run again until
 * it is in front. Five minutes covers that round trip without leaving the
 * agent stopped for long behind a tab that was simply abandoned: the window is
 * bounded, every visible beat brings it back to `TAKEOVER_WINDOW_MS`, and an
 * ended beat (Hand back, or the page going away) still releases at once.
 */
export const TAKEOVER_HIDDEN_WINDOW_MS = 5 * 60_000;

/** The window one control heartbeat buys. */
export function takeoverWindowMs(hidden: boolean | null | undefined): number {
  return hidden ? TAKEOVER_HIDDEN_WINDOW_MS : TAKEOVER_WINDOW_MS;
}

/** What every refused tool call tells the model. */
export const TAKEOVER_REFUSAL =
  "The person has taken control of this computer. Nothing was done. Wait for them to hand it back, then carry on from where the screen is.";

export interface TakeoverState {
  takeoverUntil?: Date | null;
  takeoverStartedAt?: Date | null;
  takeoverBy?: string | null;
  takeoverEpoch?: number;
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
  /** A beat from a hidden tab or a backgrounded app: the longer, bounded window. */
  hidden?: boolean;
}): Required<TakeoverState> {
  const continuing = takeoverActive(input.state, input.now);
  const epoch = input.state?.takeoverEpoch ?? 0;
  return {
    takeoverUntil: new Date(input.now.getTime() + takeoverWindowMs(input.hidden)),
    takeoverStartedAt: continuing && input.state?.takeoverStartedAt ? input.state.takeoverStartedAt : input.now,
    takeoverBy: continuing && input.state?.takeoverBy ? input.state.takeoverBy : input.by,
    // A new takeover moves the fence; extending one does not.
    takeoverEpoch: continuing ? epoch : epoch + 1,
  };
}

/** The fields that end a takeover (Hand back). The epoch stays: it only ever grows. */
export function takeoverClosed(): Omit<Required<TakeoverState>, "takeoverEpoch"> {
  return { takeoverUntil: null, takeoverStartedAt: null, takeoverBy: null };
}

/**
 * Whether `holder` may hand the computer back: when nobody holds it, or when
 * `holder` is the client that took it. A row written before holders were
 * recorded (no `takeoverBy`) is releasable by anyone, as it was.
 */
export function takeoverReleasableBy(state: TakeoverState | null | undefined, holder: string, now: Date): boolean {
  if (!takeoverActive(state, now)) return true;
  return !state?.takeoverBy || state.takeoverBy === holder;
}

/**
 * Whether someone other than `holder` holds the computer right now. Asking for
 * control, extending it or handing it back is refused then: two clients in
 * control at once would type over each other, and a hand back from the wrong
 * one would let the agent resume while the holder is still typing.
 */
export function takeoverHeldByOther(state: TakeoverState | null | undefined, holder: string, now: Date): boolean {
  if (!takeoverActive(state, now)) return false;
  return Boolean(state?.takeoverBy) && state?.takeoverBy !== holder;
}

/**
 * A takeover window that was opened and then neither extended nor closed:
 * the holder went away (a closed tab, a crashed app, a lost network) and the
 * agent has the computer again. The sweep and the fence record it once
 * (`takeover_lapsed`) and clear it.
 */
export function takeoverLapsed(state: TakeoverState | null | undefined, now: Date): boolean {
  const until = state?.takeoverUntil;
  return until instanceof Date && until.getTime() <= now.getTime();
}

/** The holder kinds a client can name (src/lib/agents/computer-handback.ts). */
export type TakeoverHolderKindName = "web" | "iphone" | "ipad" | "mac" | "app";

/**
 * The kind of device a holder is, from its recorded holder and, for an app,
 * the platform its device session registered with ("iOS", "iPadOS", "macOS").
 */
export function takeoverHolderKind(
  holder: string | null | undefined,
  platform?: string | null,
): TakeoverHolderKindName | null {
  if (!holder) return null;
  if (holder === "web") return "web";
  switch ((platform ?? "").trim().toLowerCase()) {
    case "ios":
    case "iphoneos":
      return "iphone";
    case "ipados":
      return "ipad";
    case "macos":
    case "mac":
      return "mac";
    default:
      return "app";
  }
}

/** The takeover as a client sees it: whether it is on, whether it is this client's, and until when. */
export interface TakeoverView {
  active: boolean;
  /** True when the viewer asking is the holder. */
  mine: boolean;
  /** When the window lapses unless it is extended, as ISO; null when nobody holds it. */
  until: string | null;
  /** What kind of device holds it, never an id; null when nobody does. */
  holder: TakeoverHolderKindName | null;
}

export function takeoverView(
  state: TakeoverState | null | undefined,
  viewerHolder: string,
  now: Date,
  holderKind: TakeoverHolderKindName | null = null,
): TakeoverView {
  if (!takeoverActive(state, now)) return { active: false, mine: false, until: null, holder: null };
  const by = state?.takeoverBy ?? null;
  return {
    active: true,
    // A row written before holders were recorded is anybody's, as hand back treats it.
    mine: !by || by === viewerHolder,
    until: state?.takeoverUntil instanceof Date ? state.takeoverUntil.toISOString() : null,
    holder: holderKind ?? takeoverHolderKind(by),
  };
}

/** What a guard reads: the refusal and the takeover epoch, or just a refusal (older callers). */
export type TakeoverFence = string | null | { reason: string | null; epoch: number };

/** The sentence when a takeover overlapped a call that has already returned. */
export const TAKEOVER_OVERLAP_REFUSAL =
  "The person took control of this computer while that was running, so its result was discarded. Look at the screen again before carrying on.";

function fenceParts(fence: TakeoverFence): { reason: string | null; epoch: number | null } {
  if (fence === null || typeof fence === "string") return { reason: fence, epoch: null };
  return fence;
}

/**
 * The before/after rule every guarded computer or browser call follows:
 * refuse if blocked after, and refuse if the epoch moved (a takeover started
 * at any point during the call). Pure; tested directly.
 */
export function takeoverFenceVerdict(before: TakeoverFence, after: TakeoverFence): string | null {
  const a = fenceParts(before);
  const b = fenceParts(after);
  if (b.reason) return b.reason;
  if (a.epoch !== null && b.epoch !== null && a.epoch !== b.epoch) return TAKEOVER_OVERLAP_REFUSAL;
  return null;
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
  fillSecret?(
    target: { ref?: number; selector?: string },
    value: string,
    opts: { requirePasswordField: boolean },
  ): Promise<{ ok: boolean; message?: string }>;
  fieldKind?(target: { ref?: number; selector?: string }): Promise<unknown>;
}

/**
 * The `browser` tool drives the same Chromium the person is using during a
 * takeover, so it is stopped too: every call that reads the page or acts on it
 * answers with the takeover sentence instead, and a read that finished as a
 * takeover began is discarded. Everything else passes through unchanged.
 */
export function guardBrowserForTakeover<T extends GuardableBrowser>(
  browser: T,
  blockedReason: () => Promise<TakeoverFence>
): T {
  const refuse = (message: string) => ({ ok: false as const, message });
  const around =
    <A extends unknown[]>(call: (...args: A) => Promise<{ ok: boolean; message?: string }>) =>
    async (...args: A) => {
      const before = await blockedReason();
      const blocked = fenceParts(before).reason;
      if (blocked) return refuse(blocked);
      const result = await call(...args);
      const verdict = takeoverFenceVerdict(before, await blockedReason());
      return verdict ? refuse(verdict) : result;
    };
  const fillSecret = browser.fillSecret;
  const fieldKind = browser.fieldKind;
  // The browsers are object literals of closures (remote-browser.ts), so a
  // spread keeps every other method working as it was.
  return {
    ...browser,
    open: around((url: string) => browser.open(url)),
    read: around(() => browser.read()),
    click: around((target: { ref?: number; selector?: string }) => browser.click(target)),
    typeText: around((target: { ref?: number; selector?: string }, text: string) => browser.typeText(target, text)),
    submit: around((target: { ref?: number; selector?: string }) => browser.submit(target)),
    // A credential fill during a takeover would type into whatever the person
    // has focused; it is stopped like every other action.
    ...(fillSecret
      ? {
          fillSecret: around(
            (target: { ref?: number; selector?: string }, value: string, opts: { requirePasswordField: boolean }) =>
              fillSecret(target, value, opts),
          ),
        }
      : {}),
    ...(fieldKind
      ? {
          fieldKind: async (target: { ref?: number; selector?: string }) =>
            fenceParts(await blockedReason()).reason ? null : fieldKind(target),
        }
      : {}),
  } as T;
}

/** How much text one `xdotool type` call carries: about 0.8 s of typing. */
export const TYPE_CHUNK_CHARS = 64;

/**
 * Types long text in chunks, reading the fence before each one. A takeover
 * (or a lost lease) that begins mid-text stops the typing at the next chunk
 * instead of letting seconds of keystrokes land in whatever the person has
 * focused, a password field included. Chunks never split a character.
 * Returns the refusal that stopped it, or null when all of it was typed.
 */
export async function typeInChunks(
  text: string,
  sendChunk: (chunk: string) => Promise<void>,
  fence: () => Promise<TakeoverFence>,
  chunkChars = TYPE_CHUNK_CHARS,
): Promise<string | null> {
  const characters = Array.from(text);
  const start = await fence();
  for (let i = 0; i < characters.length; i += chunkChars) {
    if (i > 0) {
      const verdict = takeoverFenceVerdict(start, await fence());
      if (verdict) return verdict;
    }
    await sendChunk(characters.slice(i, i + chunkChars).join(""));
  }
  return null;
}
