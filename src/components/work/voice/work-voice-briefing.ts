/**
 * What the voice model is told about a Work task, and nothing more.
 *
 * ── Why this file is the whole feature ─────────────────────────────────────
 *
 * The realtime voice relay has no tools. `relay/src/providers/*` build their
 * provider session out of exactly two things — `seed.instructions` (a fixed
 * sentence about being Juno on a phone call) and `seed.transcript` — and the
 * relay itself holds no database handle: `RelaySession`'s constructor takes a
 * WebSocket and a `userId` and that is all it ever knows about the account. So
 * a voice session's entire knowledge of a Work task is the `history` array the
 * browser hands it at `session.start`. This module is that array.
 *
 * That also fixes the limit the UI has to state out loud: whatever is not
 * written here is not merely stale to the model, it is invisible. A voice
 * session cannot look anything up, cannot re-read the task, and cannot act on
 * it. `work-voice-button.tsx` says so on screen; this file is why.
 *
 * ── Order is load-bearing ──────────────────────────────────────────────────
 *
 * Both bounding passes — `boundVoiceHistory` in `use-realtime-voice.ts` and
 * `sanitizeHistory` in `relay/src/session.ts` — walk the array BACKWARDS from
 * the end and stop when the character budget runs out, so it is the EARLIEST
 * entries that get dropped and a mid-sentence `slice` that ends a kept one. A
 * briefing written front-to-back in importance order would lose the goal and
 * keep a list of file names.
 *
 * So sections are assembled most-important-first and then reversed, and the
 * budget here is deliberately below the wire limits (1,400 of 2,000 per turn;
 * 10,000 of 12,000 in total). Under those numbers neither pass ever has
 * anything to cut, which is the only way to be sure the model was told the
 * whole of what we think we told it.
 *
 * Everything is derived through the same functions the panels on screen use —
 * `derivePlan`, `deriveCurrentAction`, `deriveOpenQuestions`, `deriveApprovals`
 * — rather than by re-reading the event stream here. A second reader of those
 * payloads would eventually disagree with the first, and the disagreement would
 * surface as Juno describing a plan the page is not showing.
 */

import type { VoiceHistoryEntry } from "@/lib/voice-relay-protocol";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import { readEvent, str } from "@/components/work/work-payload";
import { deriveApprovals, deriveOpenQuestions } from "@/components/work/work-decisions";
import { deriveCurrentAction, derivePlan, type PlanStep } from "@/components/work/work-timeline";
import { statusSentence } from "@/components/work/work-vocabulary";

/** Per-turn ceiling. The wire allows 2,000; the gap is the safety margin. */
const MAX_ENTRY_CHARS = 1_400;
/** Whole-briefing ceiling. The wire allows 12,000. */
const MAX_TOTAL_CHARS = 10_000;
/** Longest a single quoted sentence from the task may run before it is cut. */
const MAX_QUOTE_CHARS = 400;

export interface WorkVoiceBriefingInput {
  session: ClientWorkSession;
  /** The newest attempt, or null when the task has never been dispatched. */
  run: ClientWorkRun | null;
  events: readonly ClientWorkEvent[];
}

export interface WorkVoiceBriefing {
  /** Handed to `useRealtimeVoice().start(provider, history)` verbatim. */
  entries: VoiceHistoryEntry[];
  /**
   * Changes exactly when something the briefing states changes.
   *
   * Compared as a plain string rather than hashed: it is a few kilobytes
   * compared once per stream frame, and a hash would only make a mismatch
   * impossible to explain when one shows up.
   */
  digest: string;
}

/** Cut at a word boundary, with an ellipsis, so nothing ends mid-syllable. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const boundary = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return `${(boundary > limit * 0.6 ? head.slice(0, boundary) : head).trimEnd()}…`;
}

/**
 * One line, for anything quoted inside a sentence.
 *
 * A user's goal can be several paragraphs, and dropping those line breaks
 * inside `The task, in my own words: "…"` is what keeps the quote a quote.
 */
function oneLine(value: string, limit: number): string {
  return cut(value.trim().replace(/\s+/g, " "), limit);
}

/**
 * A whole section, with its line breaks intact.
 *
 * Runs of spaces collapse but newlines survive: a plan is read aloud as a list
 * and a model handed it as one 900-character paragraph reads it as one.
 */
function block(value: string, limit: number): string {
  return cut(
    value
      .split("\n")
      .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
      .join("\n")
      .trim(),
    limit
  );
}

function planLine(step: PlanStep, index: number): string {
  const state =
    step.state === "done"
      ? "done"
      : step.state === "active"
        ? "in progress now"
        : step.state === "failed"
          ? "failed"
          : step.state === "skipped"
            ? "skipped"
            : step.state === "unreported"
              ? "never finished — the attempt stopped here"
              : "not started";
  return `${index + 1}. ${oneLine(step.title, 120)} — ${state}`;
}

/** Deliverables the run has named, newest last, deduplicated by title. */
function artifactTitles(events: readonly ClientWorkEvent[]): string[] {
  const titles: string[] = [];
  for (const event of events) {
    if (event.kind !== "artifact_created" && event.kind !== "artifact_updated") continue;
    const title = str(readEvent(event), "title", "name", "label", "path");
    if (title !== null && !titles.includes(title)) titles.push(oneLine(title, 90));
  }
  return titles;
}

/** The last few things Juno said in its own words, oldest first. */
function assistantSaid(events: readonly ClientWorkEvent[], take: number): string[] {
  const said: string[] = [];
  for (const event of events) {
    if (event.visibility !== "user" || event.kind !== "assistant_message") continue;
    const text = str(readEvent(event), "text", "message");
    if (text !== null) said.push(oneLine(text, MAX_QUOTE_CHARS));
  }
  return said.slice(-take);
}

/** One sentence about where the attempt ran, or null when it never did. */
function attemptLine(run: ClientWorkRun | null): string | null {
  if (run === null) return null;
  const where =
    run.effectiveTarget === "local"
      ? "on your Mac"
      : run.effectiveTarget === "cloud"
        ? "in the cloud"
        : "on an executor it has not picked yet";
  const model = run.effectiveModel ?? run.requestedModel;
  return `This is attempt ${run.attempt}, running ${where}${model ? ` on ${model}` : ""}.`;
}

/**
 * The sections, most important first.
 *
 * Each returns null when it has nothing to say. An empty heading followed by
 * nothing reads to a language model as an assertion that there is nothing,
 * which is a different claim from not having mentioned it.
 */
function sections(input: WorkVoiceBriefingInput): string[] {
  const { session, run, events } = input;
  const plan = derivePlan(events);
  const current = deriveCurrentAction(events);
  const questions = deriveOpenQuestions(events);
  const approvals = deriveApprovals(events).filter((card) => card.decision === "pending");
  const artifacts = artifactTitles(events);
  const said = assistantSaid(events, 3);

  const ordered: (string | null)[] = [
    // 1 — the task itself, and the rules of this conversation. Never dropped.
    [
      "I am looking at one of my Juno Work tasks and I want to talk it through out loud.",
      "",
      `The task, in my own words: "${oneLine(session.goal, MAX_QUOTE_CHARS)}"`,
      `Where it stands: ${statusSentence(session.status)}`,
      attemptLine(run),
      "",
      "Everything I tell you in this briefing is a snapshot of the task as it was when I " +
        "pressed the microphone. You cannot see anything else about it — not the files, not " +
        "the tools it used, not any change made after this — so if I ask about something " +
        "that is not here, say you cannot see it rather than guessing. You also cannot " +
        "change this task: you cannot start it, stop it, answer its questions or approve " +
        "anything. I do all of that myself in the app. Talk normally, keep it short, and use " +
        "my words for the work rather than Juno's.",
    ]
      .filter((line) => line !== null)
      .join("\n"),

    // 2 — what is stopping it, which is usually why somebody is talking to it.
    questions.length > 0 || approvals.length > 0
      ? [
          "What the task is waiting on:",
          ...questions.map(
            (question) =>
              `- It asked me: "${oneLine(question.question, 300)}"${question.why ? ` It says it needs this because ${oneLine(question.why, 200)}` : ""}`
          ),
          ...approvals.map(
            (approval) =>
              `- It wants my approval before it does this: ${oneLine(approval.summary, 240)} (risk: ${approval.risk})`
          ),
        ].join("\n")
      : null,

    // 3 — the plan, which is the thing the page is mostly showing.
    plan.length > 0
      ? [
          "The plan Juno wrote for it, in order:",
          ...plan.map(planLine),
          current ? `Right now it is: ${oneLine(current.title, 160)}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : current
        ? `Right now the task is: ${oneLine(current.title, 160)}`
        : null,

    // 4 — Juno's own recent words, so the voice can pick up the thread.
    said.length > 0 ? ["The last things Juno said on the task:", ...said.map((text) => `- ${text}`)].join("\n") : null,

    // 5 — what it has produced. Least important: I can see the list on screen.
    artifacts.length > 0
      ? ["What it has produced so far:", ...artifacts.slice(-8).map((title) => `- ${title}`)].join("\n")
      : null,
  ];

  return ordered.filter((section): section is string => section !== null).map((section) => block(section, MAX_ENTRY_CHARS));
}

/**
 * The whole briefing, as the history a voice session is started with.
 *
 * The closing assistant line is not decoration. Without it the seeded
 * conversation ends on a wall of text from the user, and every provider in the
 * relay treats a trailing user turn as something it still owes an answer to —
 * the session opens with the model reciting the briefing back. The line also
 * carries the limits in the model's own voice, which is where they stick.
 */
export function buildWorkVoiceBriefing(input: WorkVoiceBriefingInput): WorkVoiceBriefing {
  const kept: string[] = [];
  let remaining = MAX_TOTAL_CHARS;
  for (const section of sections(input)) {
    if (section.length > remaining) break;
    kept.push(section);
    remaining -= section.length;
  }

  const entries: VoiceHistoryEntry[] = kept
    // Reversed so the most important section is the LAST user turn: see the
    // note at the top of this file about which end the bounding passes eat.
    .reverse()
    .map((text) => ({ role: "user" as const, text }));

  entries.push({
    role: "assistant",
    text:
      "Got it. I have read where this task has got to, and I will stick to what you have told " +
      "me — happy to talk it through, but I cannot touch the task itself.",
  });

  return { entries, digest: kept.join("\n") };
}

/**
 * A mid-conversation update, sent as one ordinary user turn.
 *
 * There is no other way in. The relay seeds `history` exactly once — see the
 * `historySeeded` flag in `RelaySession.handleText` — so a live session cannot
 * be re-briefed; `input.text` is the only channel left, and it is delivered as
 * something the user said. That is why the button for it is explicit and
 * labelled, and why this string opens by naming itself: the model must not
 * attribute it to the person, and the panel filters it out of the visible
 * transcript by matching this exact text.
 */
export function workVoiceCatchUp(input: WorkVoiceBriefingInput): string {
  const { session, run, events } = input;
  const plan = derivePlan(events);
  const done = plan.filter((step) => step.state === "done").length;
  const current = deriveCurrentAction(events);
  const questions = deriveOpenQuestions(events);
  const approvals = deriveApprovals(events).filter((card) => card.decision === "pending");
  const said = assistantSaid(events, 1);

  return block(
    [
      "An update from the app, not from me — the task has moved on since you were briefed.",
      `Where it stands now: ${statusSentence(session.status)}`,
      plan.length > 0 ? `Plan: ${done} of ${plan.length} steps done.` : null,
      current ? `Right now it is: ${oneLine(current.title, 160)}` : null,
      questions.length > 0 ? `It is asking me: "${oneLine(questions[0].question, 240)}"` : null,
      approvals.length > 0 ? `It wants my approval for: ${oneLine(approvals[0].summary, 200)}` : null,
      said.length > 0 ? `The last thing it said: ${said[0]}` : null,
      run !== null && run.attempt > 1 ? `This is attempt ${run.attempt}.` : null,
      "Nothing else about the task has changed. Do not read this back to me; just take it into account.",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    MAX_ENTRY_CHARS
  );
}
