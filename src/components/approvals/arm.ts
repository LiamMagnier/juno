/**
 * THE ARM (spec C16, D20): an approval's primary verb is disarmed for
 * `--hold-arm` (500ms) after each new request and after EVERY focus entry
 * into the approval, so a keystroke meant for something else (an Enter that
 * was sending a message, a ⌘↩ from a mod-enter sender) can never approve it.
 * While disarmed the verb is aria-disabled at 0.6 opacity, ignores Enter and
 * ⌘↩, and says "Available in a moment" to assistive tech; then it fades to 1
 * over 120.
 *
 * Clock-driven and DOM-free, so the timing is tested with an injected clock.
 */

import { TIMING } from "@/lib/interaction";

export const ARM_MS = TIMING.arm;

export interface ArmClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ArmClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ApprovalArm {
  /** A new request arrived, or focus entered the approval: disarm and start again. */
  restart(): void;
  armed(): boolean;
  dispose(): void;
}

export function createApprovalArm(onChange: (armed: boolean) => void, clock: ArmClock = realClock): ApprovalArm {
  let armed = false;
  let timer: unknown = null;
  const set = (next: boolean) => {
    if (next === armed) return;
    armed = next;
    onChange(next);
  };
  const restart = () => {
    if (timer !== null) clock.clearTimeout(timer);
    set(false);
    timer = clock.setTimeout(() => {
      timer = null;
      set(true);
    }, ARM_MS);
  };
  restart();
  return {
    restart,
    armed: () => armed,
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
