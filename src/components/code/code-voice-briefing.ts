/**
 * What the voice model is told about a Juno Code session, and nothing more.
 *
 * ── Why this file exists at all ────────────────────────────────────────────
 *
 * The realtime relay has no tools and no database handle: a provider session is
 * built from a fixed "you are Juno on a phone call" instruction plus the
 * `history` array the browser hands to `useRealtimeVoice().start`. So a voice
 * session's entire knowledge of a code session is this module's output. Nothing
 * it is not told here is merely stale to the model — it is invisible.
 *
 * The Work equivalent (`work/voice/work-voice-briefing.ts`) is not importable
 * here: it takes a `ClientWorkSession` and reads a WorkEvent stream, neither of
 * which a code session has. What IS copied verbatim is the ordering rule, and
 * it is load-bearing rather than stylistic — both bounding passes
 * (`boundVoiceHistory` in `use-realtime-voice.ts`, `sanitizeHistory` in
 * `relay/src/session.ts`) walk the array BACKWARDS and stop when the character
 * budget runs out, so it is the EARLIEST entries that get dropped. Sections are
 * therefore assembled most-important-first and reversed at the end; a briefing
 * written front-to-back would lose "which repo, and what I want" and keep the
 * tail of a transcript.
 *
 * ── Why the two Code surfaces share one briefing ───────────────────────────
 *
 * /code/new and a live session are the same conversation at two moments: where
 * this runs, what I want done, and (once there is one) what happened. Two
 * builders would drift, and the drift would surface as Juno describing the
 * arrangement differently depending on which screen you called from.
 */

import type { VoiceHistoryEntry } from "@/lib/voice-relay-protocol";

/** Per-turn ceiling. The wire allows 2,000; the gap is the safety margin. */
const MAX_ENTRY_CHARS = 1_400;
/** Whole-briefing ceiling. The wire allows 12,000. */
const MAX_TOTAL_CHARS = 10_000;
/** How much of one transcript turn is quoted before it is cut. */
const MAX_TURN_CHARS = 420;
/** How many turns of the session's transcript are worth reading out. */
const MAX_TURNS = 8;

export interface CodeVoiceBriefingInput {
  /**
   * "new" — nothing exists yet and the call is about deciding what to ask for.
   * "session" — a session exists and the call is about what it has done.
   *
   * The distinction is not cosmetic: on /code/new the model must not talk as if
   * a run were under way, and in a session it must not offer to choose a repo.
   */
  stage: "new" | "session";
  /** Null while /code/new is still resolving which machine it will be. */
  target: "device" | "cloud" | null;
  /** Workspace name (device) or `owner/name` (cloud). Null when unpicked. */
  place: string | null;
  /** The branch a cloud run starts from, when one is known. */
  baseRef: string | null;
  /** The session transcript so far, oldest first. Empty on /code/new. */
  turns: readonly { role: "user" | "assistant"; text: string }[];
  /**
   * The app's own reason a run cannot be dispatched right now — the composer's
   * `sendBlockedReason`, in the composer's exact words. Handed over so the model
   * says the same thing the screen does rather than inventing a second story.
   */
  blocked: string | null;
}

/** Cut at a word boundary, with an ellipsis, so nothing ends mid-syllable. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const boundary = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return `${(boundary > limit * 0.6 ? head.slice(0, boundary) : head).trimEnd()}…`;
}

/** One line — for anything quoted inside a sentence. */
function oneLine(value: string, limit: number): string {
  return cut(value.trim().replace(/\s+/g, " "), limit);
}

/** A whole section, line breaks intact: a list read aloud has to stay a list. */
function block(value: string, limit: number): string {
  return cut(
    value
      .split("\n")
      .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
      .join("\n")
      .trim(),
    limit,
  );
}

/** Where the run happens, in one sentence, honest about what is still unpicked. */
function placeSentence(input: CodeVoiceBriefingInput): string {
  if (input.target === "cloud") {
    const where = input.place ? `the GitHub repository ${input.place}` : "a GitHub repository I have not picked yet";
    const branch = input.baseRef ? ` It starts from the ${input.baseRef} branch.` : "";
    return `It runs on a fresh cloud machine against ${where}, and opens a pull request when it is done.${branch}`;
  }
  if (input.target === "device") {
    const where = input.place ? `my project "${input.place}"` : "a project I have not picked yet";
    return `It runs with Juno Code on my own Mac, in ${where}.`;
  }
  return "I have not settled where it runs yet — it is either my own Mac or a fresh cloud machine.";
}

function sections(input: CodeVoiceBriefingInput): string[] {
  const recent = input.turns.filter((turn) => turn.text.trim()).slice(-MAX_TURNS);

  const ordered: (string | null)[] = [
    // 1 — the arrangement and the rules of this call. Never dropped.
    [
      input.stage === "new"
        ? "I am about to start a Juno Code session and I want to talk through what to ask it for."
        : "I am looking at one of my Juno Code sessions and I want to talk it through out loud.",
      "",
      placeSentence(input),
      input.blocked ? `The app is telling me: ${oneLine(input.blocked, 200)}` : null,
      "",
      "Everything in this briefing is a snapshot from the moment I pressed the microphone. " +
        "You cannot see the code, the files, the diff or anything that happens after this, so " +
        "if I ask about something that is not here, say you cannot see it rather than guessing. " +
        "You also cannot run anything: you cannot start the session, send it a prompt, stop a " +
        "run or approve anything — I do all of that myself in the app, and only the one line I " +
        "choose to send ever reaches it. Talk normally, keep it short, and help me get to a " +
        "clear instruction I could hand over.",
    ]
      .filter((line) => line !== null)
      .join("\n"),

    // 2 — what has actually happened, which is most of why anyone calls.
    recent.length > 0
      ? [
          "How the session has gone so far, oldest first:",
          ...recent.map(
            (turn) => `- ${turn.role === "user" ? "I asked" : "Juno Code replied"}: "${oneLine(turn.text, MAX_TURN_CHARS)}"`,
          ),
        ].join("\n")
      : null,
  ];

  return ordered.filter((section): section is string => section !== null).map((section) => block(section, MAX_ENTRY_CHARS));
}

export interface CodeVoiceBriefing {
  /** Handed to `useRealtimeVoice().start(provider, history)` verbatim. */
  entries: VoiceHistoryEntry[];
  /**
   * Changes exactly when something the briefing states changes. Compared as a
   * plain string rather than hashed: a mismatch has to stay explainable.
   */
  digest: string;
}

/**
 * The whole briefing, as the history a voice session is started with.
 *
 * The closing assistant line is not decoration. Without it the seeded
 * conversation ends on a wall of text from the user, and the relay's providers
 * treat a trailing user turn as something still owed an answer — the call opens
 * with the model reciting the briefing back at you.
 */
export function buildCodeVoiceBriefing(input: CodeVoiceBriefingInput): CodeVoiceBriefing {
  const kept: string[] = [];
  let remaining = MAX_TOTAL_CHARS;
  for (const section of sections(input)) {
    if (section.length > remaining) break;
    kept.push(section);
    remaining -= section.length;
  }

  const entries: VoiceHistoryEntry[] = kept
    // Reversed so the most important section is the LAST user turn — see the
    // note at the top about which end the bounding passes eat.
    .reverse()
    .map((text) => ({ role: "user" as const, text }));

  entries.push({
    role: "assistant",
    text:
      "Got it. I know where this runs and how far it has got, and I will stick to what you have " +
      "told me — happy to think it through with you, but I cannot touch the session itself.",
  });

  return { entries, digest: kept.join("\n") };
}

/**
 * A mid-call update, sent as one ordinary user turn.
 *
 * There is no other way in. The relay seeds `history` exactly once (the
 * `historySeeded` flag in `RelaySession.handleText`), so a live session can
 * never be re-briefed; `input.text` is the only channel left and it arrives at
 * the model as something the USER said. That is why the control for it is
 * explicit and labelled, why this string opens by naming itself, and why the
 * panel filters this exact text back out of the visible transcript.
 */
export function codeVoiceCatchUp(input: CodeVoiceBriefingInput): string {
  const last = input.turns.filter((turn) => turn.text.trim()).slice(-2);
  return block(
    [
      "An update from the app, not from me — things have moved on since you were briefed.",
      placeSentence(input),
      input.blocked ? `The app is telling me: ${oneLine(input.blocked, 200)}` : null,
      ...last.map(
        (turn) => `${turn.role === "user" ? "I asked" : "Juno Code replied"}: "${oneLine(turn.text, MAX_TURN_CHARS)}"`,
      ),
    ]
      .filter((line) => line !== null)
      .join("\n"),
    MAX_ENTRY_CHARS,
  );
}
