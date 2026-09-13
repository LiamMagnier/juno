/**
 * The voice aura's state bus — one source of truth for what a CALL is doing.
 *
 * THE LIGHT BELONGS TO VOICE, AND ONLY TO VOICE. It used to be the app's
 * ambient state light: five sources could claim it (`voice`, `chat`,
 * `research`, `code`, `work`), and a reply streaming in a background surface
 * lit the frame around a sidebar somebody was reading. An ambient light that
 * is on for most of the product's waking life is wallpaper, and wallpaper that
 * moves is worse than none — so it is now on for exactly one thing, which is
 * the one thing in Juno with no other way to say it is live. Typing, thinking
 * and streaming all have a composer, a thought panel and a stream line saying
 * so in words.
 *
 * WHY A MODULE SINGLETON AND NOT A CONTEXT. The number this carries that
 * matters most — the microphone envelope — changes at frame rate. Pushing it
 * through React would re-render the tree sixty times a second to move a canvas
 * that is not in the tree at all. So the publisher writes here, the single rAF
 * in `<AmbientAura />` reads here, and React is only involved when the *state*
 * changes, which is a handful of times per call.
 *
 * WHY THE PUBLISHER IS A HOOK, NOT A VIEW. `use-realtime-voice` publishes; no
 * surface mounts anything. Every screen that can run a call gets the light by
 * construction, and there is exactly one derivation of "is Juno talking" — the
 * failure mode `voice-phase.ts:129-133` was written to prevent, where two
 * readings disagree and the light says one thing while the label says another.
 */

import type { VoicePhase } from "@/lib/voice-phase";

export type AuraState =
  /** No call. Absent — no paint, no rAF, no layer. */
  | "idle"
  /** A call is up, nobody is talking. */
  | "listening"
  /** The person is speaking. */
  | "user"
  /** A call is up and the microphone is closed. */
  | "muted"
  /** A call is being established. */
  | "connecting"
  /** The model is working and producing nothing yet. */
  | "thinking"
  /** A connector, search or fetch is in flight. */
  | "tool"
  /** Output is arriving — tokens, or the model's voice. */
  | "answering"
  /** The one-shot settle at the end of a turn. */
  | "done"
  /** The turn failed. */
  | "error";

/**
 * Who may claim the light. One member, deliberately.
 *
 * Kept as a union rather than dropped because every call site names it, and a
 * named source is what makes "the light is voice's" a fact the type system
 * states rather than a convention four call sites have to remember. Adding a
 * second member here is the change that has to be argued for, and the argument
 * has to beat the one in this module's header.
 */
export type AuraSource = "voice";

/**
 * Where the amplitude comes from for the winning state. `level` is the live
 * audio envelope; `floor` is the state's own resting swell (possibly
 * breathing).
 *
 * There used to be a third, `cadence` — how much text had arrived recently —
 * which existed only to give a streaming reply something to modulate. With the
 * light scoped to voice there is always a microphone or a speaker, so the
 * substitute for one is gone.
 */
export type AuraDrive = "level" | "floor";

export interface AuraResolved {
  state: AuraState;
  source: AuraSource | null;
  drive: AuraDrive;
}

const LEVEL_STATES: ReadonlySet<AuraState> = new Set<AuraState>(["listening", "user", "muted"]);

/** How long the closing swell runs before the light goes out. */
const DONE_MS = 1100;

/**
 * How long a failure holds the light. It expires on its own so a stale error —
 * a turn that failed while the user was in another tab — cannot pin the light
 * on for the rest of the session.
 */
const ERROR_MS = 4000;

const states = new Map<AuraSource, AuraState>();
const timers = new Map<AuraSource, ReturnType<typeof setTimeout>>();
const listeners = new Set<(r: AuraResolved) => void>();

let levelRef: { current: number } | null = null;

let resolved: AuraResolved = { state: "idle", source: null, drive: "floor" };

/**
 * What the light should show.
 *
 * There is no rank table and no tie-break order any more: with one source
 * there is nothing to arbitrate, and forty lines deciding which of five
 * claimants wins was forty lines describing a contest that can no longer
 * happen. A call is a mode the whole surface is in, which is exactly why it is
 * the only thing allowed to paint one.
 */
function resolve(): AuraResolved {
  const state = states.get("voice") ?? "idle";
  if (state === "idle") return { state, source: null, drive: "floor" };
  // `answering` is Juno's own voice coming out of the speaker, so it has a
  // real envelope like the microphone states do.
  const drive: AuraDrive = LEVEL_STATES.has(state) || state === "answering" ? "level" : "floor";
  return { state, source: "voice", drive };
}

function publish() {
  const next = resolve();
  if (next.state === resolved.state && next.source === resolved.source && next.drive === resolved.drive) {
    return;
  }
  resolved = next;
  for (const fn of listeners) fn(resolved);
}

function clearTimer(source: AuraSource) {
  const timer = timers.get(source);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(source);
  }
}

/**
 * Declare what the call is doing.
 *
 * `done` and `error` are self-expiring: they are moments, not modes, and a
 * publisher that forgets to clear them would otherwise leave the light on. Any
 * later call from the same source cancels the pending expiry.
 */
export function setAuraState(source: AuraSource, state: AuraState): void {
  clearTimer(source);
  states.set(source, state);

  if (state === "done" || state === "error") {
    const ms = state === "done" ? DONE_MS : ERROR_MS;
    if (typeof setTimeout === "function") {
      timers.set(
        source,
        setTimeout(() => {
          timers.delete(source);
          // Only if nothing has claimed this source since: the timer is cleared
          // on every set, so reaching here means the state is still ours.
          if (states.get(source) === state) {
            states.set(source, "idle");
            publish();
          }
        }, ms)
      );
    }
  }

  publish();
}

/**
 * Hand the aura a live 0..1 audio envelope, or `null` on teardown. One ref, two
 * consumers — the meter that owns it and the light — so they can never disagree
 * about how loud the room is.
 */
export function attachAuraLevel(ref: { current: number } | null): void {
  levelRef = ref;
}

/** The current audio envelope, 0..1, or 0 when nothing is attached. */
export function readAuraLevel(): number {
  const value = levelRef?.current ?? 0;
  return value > 1 ? 1 : value > 0 ? value : 0;
}

/** What the light should be showing right now. Read once per frame. */
export function readAura(): AuraResolved {
  return resolved;
}

/** Called when the resolved state changes — never for the level. */
export function subscribeAura(fn: (r: AuraResolved) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The one place a voice phase becomes an aura state.
 *
 * Derived from `voicePhaseOf`, never from the transport status: the transport
 * says whether a call exists, the phase says what is happening inside it, and
 * reading the light off the wrong one is how it ends up the wrong colour while
 * the bar says something else.
 */
export function auraStateForVoicePhase(phase: VoicePhase): AuraState {
  switch (phase) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "listening":
      return "listening";
    case "user-speaking":
      return "user";
    case "thinking":
      return "thinking";
    case "speaking":
      return "answering";
    case "muted":
      return "muted";
    case "error":
      return "error";
  }
}

