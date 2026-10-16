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
 * The hand-off carries the landing's attachments too, and a prompt that is
 * ONLY attachments is a prompt: it used to read `text` alone, so photos staged
 * on the landing were dropped and an attachment-only task was never sent.
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
  /**
   * The model the landing chose is one the thread can run now. False while a
   * Mac subscription the landing picked is not listed yet (the env server's
   * provider list is still arriving). Absent means ready.
   */
  selectionReady?: boolean;
}

/** Where the first prompt goes now, or why not yet. */
export function firstPromptRoute(gate: FirstPromptGate, needsSkills: boolean): FirstPromptRoute | "wait" | "drop" {
  if (!gate.metaLoaded) return "wait";
  // Cloud runs were dispatched on the landing itself.
  if (gate.isCloud) return "drop";
  if (gate.envReady) return (needsSkills && !gate.skillsLoaded) || gate.selectionReady === false ? "wait" : "env";
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

/** What the landing left: its words, its attachments, or both. */
export interface PendingFirstPrompt<A = unknown> {
  text: string;
  attachments: A[];
}

/** Something to send: words, or at least one attachment. */
export function hasFirstPrompt<A>(prompt: { text: string; attachments?: readonly A[] } | null | undefined): boolean {
  return !!prompt && (prompt.text.trim().length > 0 || (prompt.attachments?.length ?? 0) > 0);
}

export interface FirstPromptDeps<A = unknown> {
  /** The hand-off, or null. Read once. A bare string is the older text-only shape. */
  peek(): PendingFirstPrompt<A> | string | null;
  clear(): void;
  arm(skill: CodeSkillChoice): void;
  /** Resolves true when the run accepted the words. */
  send(route: FirstPromptRoute, text: string, attachments: A[]): Promise<boolean>;
  onError?(error: unknown): void;
}

export interface FirstPromptHandoff<A = unknown> {
  /** The prompt waiting to go, or null once sent, dropped or never there. */
  pending(): PendingFirstPrompt<A> | null;
  /**
   * The prompt to show as the thread's first bubble: waiting for the Mac, or
   * on its way. Null once the run has it (or refused it), so the transcript
   * takes over without a gap where the task vanished.
   */
  showing(): PendingFirstPrompt<A> | null;
  /**
   * Called on every render: sends when the gate opens, at most once. Returns
   * the send in flight (for tests), or null when nothing was started.
   */
  tick(gate: FirstPromptGate, choices: readonly CodeSkillChoice[], selectedIds: readonly string[]): Promise<boolean> | null;
}

export function createFirstPromptHandoff<A = unknown>(deps: FirstPromptDeps<A>): FirstPromptHandoff<A> {
  let prompt: PendingFirstPrompt<A> | null | undefined;
  let started = false;
  let inFlight = false;
  const read = () => {
    if (prompt === undefined) {
      const peeked = deps.peek();
      const shaped: PendingFirstPrompt<A> | null = typeof peeked === "string" ? { text: peeked, attachments: [] } : peeked ? { text: peeked.text ?? "", attachments: [...(peeked.attachments ?? [])] } : null;
      prompt = hasFirstPrompt(shaped) ? shaped : null;
    }
    return prompt;
  };
  return {
    pending: () => (started ? null : read()),
    showing: () => (!started || inFlight ? read() : null),
    tick(gate, choices, selectedIds) {
      const pending = read();
      if (started || !pending) return null;
      const route = firstPromptRoute(gate, firstPromptNeedsSkills(pending.text, selectedIds));
      if (route === "wait") return null;
      started = true;
      if (route === "drop") return null;
      // The CodeTask path reads a `/name` itself; the env server takes it as an activation.
      const message = route === "env" ? splitFirstPrompt(pending.text, choices) : { text: pending.text.trim(), once: null };
      if (message.once) deps.arm(message.once);
      inFlight = true;
      return deps.send(route, message.text, pending.attachments).then(
        (accepted) => {
          inFlight = false;
          if (accepted) deps.clear();
          return accepted;
        },
        (error: unknown) => {
          inFlight = false;
          deps.onError?.(error);
          return false;
        },
      );
    },
  };
}
