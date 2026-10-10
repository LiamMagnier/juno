/**
 * The /code landing's first prompt, on the v2 route.
 *
 * The landing creates a prompt-free device conversation and leaves the task in
 * sessionStorage (code-session-handoff.ts), with the landing's Skills choice
 * written as the thread's selection and an armed `/name` prefixed to the text.
 * Only the legacy session view used to read it, so a run on a Mac opened on
 * /code/[id] showed an empty thread and the task was never sent.
 *
 * This is the v2 route's reader: it waits until the thread knows where it runs
 * (the Mac's env server, or the CodeTask path when the env server does not
 * answer), waits for the skills list when the message needs it, sends ONCE,
 * and clears the hand-off only once the send was accepted (a reload while the
 * Mac is offline still finds it, the same promise the legacy view keeps).
 *
 * Pure: the route drives it, the tests drive it the same way.
 */
import { readCodeSkillInvocation, type CodeSkillChoice } from "./skills";

export type FirstPromptRoute = "env" | "legacy";

export interface FirstPromptGate {
  /** The thread's CodeTask meta has loaded (cloud or device is known). */
  metaLoaded: boolean;
  isCloud: boolean;
  /** The Mac's env server answered its probe. */
  envReady: boolean;
  /** The probe has settled, either way. */
  envProbed: boolean;
  /** The CodeTask path can send (a Mac and a project path). */
  legacyTarget: boolean;
  /** The skills list has been read (choices loaded, no read in flight). */
  skillsLoaded: boolean;
}

/** Where the first prompt goes now, or why not yet. */
export function firstPromptRoute(gate: FirstPromptGate, needsSkills: boolean): FirstPromptRoute | "wait" | "drop" {
  if (!gate.metaLoaded) return "wait";
  // Cloud runs were dispatched on the landing itself.
  if (gate.isCloud) return "drop";
  if (gate.envReady) return needsSkills && !gate.skillsLoaded ? "wait" : "env";
  if (gate.envProbed && gate.legacyTarget) return "legacy";
  return "wait";
}

/**
 * Whether the message needs the skills list before it can go: a `/name` to
 * resolve, or a selection whose account skills need their instructions.
 */
export function firstPromptNeedsSkills(text: string, selectedIds: readonly string[]): boolean {
  return /^\s*\/[a-z0-9]/.test(text) || selectedIds.length > 0;
}

/** A leading `/name` naming a real skill: that skill for this message, the rest as the message. */
export function splitFirstPrompt(text: string, choices: readonly CodeSkillChoice[]): { text: string; once: CodeSkillChoice | null } {
  const invoked = readCodeSkillInvocation(text, choices);
  if (!invoked || !invoked.remainder) return { text: text.trim(), once: null };
  return { text: invoked.remainder, once: invoked.skill };
}

export interface FirstPromptDeps {
  /** The hand-off's text, or null. Read once. */
  peek(): string | null;
  clear(): void;
  arm(skill: CodeSkillChoice): void;
  /** Resolves true when the run accepted the words. */
  send(route: FirstPromptRoute, text: string): Promise<boolean>;
  onError?(error: unknown): void;
}

export interface FirstPromptHandoff {
  /** The text waiting to go, or null once sent, dropped or never there. */
  pending(): string | null;
  /**
   * Called on every render: sends when the gate opens, at most once. Returns
   * the send in flight (for tests), or null when nothing was started.
   */
  tick(gate: FirstPromptGate, choices: readonly CodeSkillChoice[], selectedIds: readonly string[]): Promise<boolean> | null;
}

export function createFirstPromptHandoff(deps: FirstPromptDeps): FirstPromptHandoff {
  let text: string | null | undefined;
  let started = false;
  const read = () => {
    if (text === undefined) {
      const peeked = deps.peek();
      text = peeked && peeked.trim() ? peeked : null;
    }
    return text;
  };
  return {
    pending: () => (started ? null : read()),
    tick(gate, choices, selectedIds) {
      const pending = read();
      if (started || !pending) return null;
      const route = firstPromptRoute(gate, firstPromptNeedsSkills(pending, selectedIds));
      if (route === "wait") return null;
      started = true;
      if (route === "drop") return null;
      // The CodeTask path reads a `/name` itself; the env server takes it as an activation.
      const message = route === "env" ? splitFirstPrompt(pending, choices) : { text: pending.trim(), once: null };
      if (message.once) deps.arm(message.once);
      return deps.send(route, message.text).then(
        (accepted) => {
          if (accepted) deps.clear();
          return accepted;
        },
        (error: unknown) => {
          deps.onError?.(error);
          return false;
        },
      );
    },
  };
}
