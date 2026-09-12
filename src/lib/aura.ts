/**
 * The ambient aura's state bus — one source of truth for "what is Juno doing".
 *
 * WHY A MODULE SINGLETON AND NOT A CONTEXT. The two numbers this carries that
 * matter most — the microphone envelope and the token cadence — change at frame
 * rate. Pushing them through React would re-render the tree sixty times a
 * second to move a canvas that is not in the tree at all. So the publishers
 * write here, the single rAF in `<AmbientAura />` reads here, and React is only
 * involved when the *state* changes, which is a handful of times per turn.
 *
 * WHY THE PUBLISHERS ARE HOOKS, NOT VIEWS. `use-chat` and `use-realtime-voice`
 * publish; no surface mounts anything. Every screen that runs a chat or a call
 * gets the light by construction, and there is exactly one derivation of "is
 * Juno talking" — the failure mode `voice-phase.ts:129-133` was written to
 * prevent, where two readings disagree and the light says one thing while the
 * label says another.
 */

import type { VoicePhase } from "@/lib/voice-phase";

export type AuraState =
  /** Nothing is happening. Absent — no paint, no rAF, no layer. */
  | "idle"
  /** A call is up, nobody is talking. */
  | "listening"
  /** The person is speaking — microphone, call or dictation. */
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

/** Which part of the product is claiming the light. */
export type AuraSource = "voice" | "chat" | "research" | "code" | "work";

/**
 * Where the amplitude comes from for the winning state. `level` is a live audio
 * envelope, `cadence` is how much text arrived recently, `floor` is the state's
 * own resting swell (possibly breathing).
 */
export type AuraDrive = "level" | "cadence" | "floor";

export interface AuraResolved {
  state: AuraState;
  source: AuraSource | null;
  drive: AuraDrive;
}

/**
 * Which state wins when two sources disagree. Higher is louder: a failure
 * outranks a person speaking, which outranks anything the model is doing,
 * because the states nearer the top are the ones a person is waiting on an
 * answer about.
 */
const RANK: Record<AuraState, number> = {
  error: 100,
  user: 90,
  listening: 80,
  muted: 75,
  answering: 70,
  tool: 60,
  thinking: 50,
  connecting: 45,
  done: 20,
  idle: 0,
};

/** Tie-break order, and the order the override below reads. */
const SOURCES: readonly AuraSource[] = ["voice", "chat", "research", "code", "work"];

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
/**
 * The stream's own loudness: how much text arrived recently. A fast stream sits
 * high, a stalled one sinks to the floor within a second — which is the
 * difference between "writing" and "hung", and the one thing a fixed swell
 * cannot say.
 */
let drive = 0;

let resolved: AuraResolved = { state: "idle", source: null, drive: "floor" };

function resolve(): AuraResolved {
  // A live call is a mode the WHOLE SCREEN is in, so it wins outright rather
  // than on rank: a chat streaming in a background surface must never repaint
  // the caller's turn. Same argument as `voice-phase.ts` giving `muted` an
  // unconditional win inside a call.
  const voice = states.get("voice") ?? "idle";
  let source: AuraSource | null = null;
  let state: AuraState = "idle";

  if (voice !== "idle") {
    source = "voice";
    state = voice;
  } else {
    for (const candidate of SOURCES) {
      const value = states.get(candidate) ?? "idle";
      if (value === "idle") continue;
      if (source === null || RANK[value] > RANK[state]) {
        source = candidate;
        state = value;
      }
    }
  }

  const nextDrive: AuraDrive = LEVEL_STATES.has(state)
    ? "level"
    : state === "answering"
      ? source === "voice"
        ? "level"
        : "cadence"
      : "floor";

  return { state, source: state === "idle" ? null : source, drive: nextDrive };
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
 * Declare what one part of the product is doing. Sources are independent; the
 * light shows the winner (see `resolve`).
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

/**
 * A chunk of output arrived. This is the streaming reply's substitute for a
 * microphone: there is no audio level while tokens land, so the tokens ARE the
 * level. Never a random walk — a fake envelope makes a stalled stream and a
 * fast one look identical, which is the one thing this signal exists to
 * distinguish.
 */
export function pulseAura(chars: number): void {
  if (!(chars > 0)) return;
  drive = Math.min(1, drive + Math.min(1, chars / 28) * 0.3);
}

/**
 * Decay the cadence accumulator by `dt` seconds and return it. Called once per
 * frame from the aura's own rAF, so the decay is tied to real elapsed time and
 * not to how often chunks happen to arrive. τ = 280ms.
 */
export function decayAuraDrive(dt: number): number {
  if (dt > 0) drive *= Math.exp(-dt / 0.28);
  if (drive < 0.0005) drive = 0;
  return drive;
}

/** What the light should be showing right now. Read once per frame. */
export function readAura(): AuraResolved {
  return resolved;
}

/** Called when the resolved state changes — never for level or cadence. */
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

