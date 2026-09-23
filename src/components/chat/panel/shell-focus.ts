import { DURATION } from "@/lib/design/tokens.generated";

/*
 * Where focus goes when the right-column shell opens and closes, and when its
 * exit has finished (SPEC §8.2).
 *
 * These are the decisions a DOM test would have to click through, and this
 * repo's tests have no DOM (§13 harness rule 4). So they live here as small
 * objects over the few things they touch — something focusable, something
 * that can say whether it contains the active element, a timer — and the
 * shell only wires them to real elements.
 *
 *   open   focus moves to the panel's heading (both modes, as the thought dock
 *          did), and whatever had focus is remembered as the way back
 *   close  focus returns to that opener, but only if it is still in the
 *          document and focus is still in the panel (or nowhere): a reader who
 *          closed it by clicking the composer keeps the composer
 *   exit   `onExited` fires once, on the shell's own opacity `transitionend`,
 *          or after `--dur-exit` + 50 ms when no transition runs (Safari before
 *          17.4 cannot transition `display`; reduced motion; a closed tab)
 */

/** Something focus can move to. `isConnected` is false once React has removed it. */
export interface FocusTarget {
  focus(options?: { preventScroll?: boolean }): void;
  readonly isConnected?: boolean;
}

/** The shell's root, asked only whether focus is inside it. */
export interface FocusScope {
  contains(node: unknown): boolean;
}

export interface ShellFocus {
  /** The shell opened. `active` is what had focus (the opener); focus moves to `target`. */
  open(active: FocusTarget | null, target: FocusTarget | null): void;
  /**
   * The shell closed. Returns focus to the opener when focus is inside `scope`
   * or on nothing (`active` is null or `body`), and returns what was focused,
   * or null when focus was left where the reader put it.
   */
  close(active: unknown, scope: FocusScope | null, body?: unknown): FocusTarget | null;
  /** The opener being remembered, for inspection. */
  readonly returnTo: FocusTarget | null;
}

export function createShellFocus(): ShellFocus {
  let returnTo: FocusTarget | null = null;
  return {
    open(active, target) {
      // A second open while already open (a new run, a tab switch) keeps the
      // first opener: that is still where the reader came from.
      if (!returnTo && active && active !== target) returnTo = active;
      // preventScroll: moving focus into a column must not scroll the chat.
      target?.focus({ preventScroll: true });
    },
    close(active, scope, body) {
      const opener = returnTo;
      returnTo = null;
      if (!opener || opener.isConnected === false) return null;
      const focusLeftThePanel = active != null && active !== body && !(scope?.contains(active) ?? false);
      if (focusLeftThePanel) return null;
      opener.focus({ preventScroll: true });
      return opener;
    },
    get returnTo() {
      return returnTo;
    },
  };
}

/** A CSS time ("160ms", "0.16s", " 160ms ") in milliseconds, or null when it is not one. */
export function parseCssDuration(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return match[2].toLowerCase() === "s" ? amount * 1000 : amount;
}

/** A frame and a little over, so the timer never beats a transition that is about to end. */
export const EXIT_FALLBACK_SLACK_MS = 50;

/** How long to wait for the exit before calling it finished: the element's `--dur-exit` + 50 ms. */
export function exitFallbackMs(cssDurExit: string | null | undefined): number {
  return (parseCssDuration(cssDurExit) ?? DURATION.exit) + EXIT_FALLBACK_SLACK_MS;
}

export interface TimerPorts {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: TimerPorts = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The fields of a `transitionend` event the watcher reads. */
export interface TransitionEndLike {
  propertyName: string;
  target: unknown;
  currentTarget: unknown;
}

export interface ExitWatcher {
  /** The shell started closing: arm the fallback timer. Restarting re-arms it. */
  start(fallbackMs: number): void;
  /** A `transitionend` reached the shell. Only its own opacity transition ends the exit. */
  transitionEnd(event: TransitionEndLike): void;
  /** The shell reopened (or unmounted) before the exit finished: nothing fires. */
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Fires `onExited` exactly once per `start`, on whichever comes first: the
 * shell's own `opacity` transition ending, or the fallback timer. A
 * `transitionend` that bubbled up from a row inside the panel, or that belongs
 * to `translate` or `display`, is ignored: `translate` ends later than
 * `opacity` on the enter curve, and a row's own fade says nothing about the
 * shell.
 */
export function createExitWatcher(onExited: () => void, timers: TimerPorts = browserTimers): ExitWatcher {
  let timer: unknown = null;
  let pending = false;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const finish = () => {
    if (!pending) return;
    pending = false;
    clear();
    onExited();
  };

  return {
    start(fallbackMs) {
      clear();
      pending = true;
      timer = timers.setTimeout(finish, Math.max(0, fallbackMs));
    },
    transitionEnd(event) {
      if (!pending || event.propertyName !== "opacity" || event.target !== event.currentTarget) return;
      finish();
    },
    cancel() {
      pending = false;
      clear();
    },
    get pending() {
      return pending;
    },
  };
}
