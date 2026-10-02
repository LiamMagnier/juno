/**
 * The run UI's shared client state (SPEC §7.9.1, §7.11, §7.12).
 *
 * Three small external stores, each a module-level map with a listener set
 * read through `useSyncExternalStore`:
 *
 *   - the one-loop arbiter: every loop-capable element claims the loop with a
 *     priority, and only the winner animates; everything else shows its
 *     phase's static signature ("one loop owner on screen", DECISIONS U2);
 *   - the paced phase and the live-answer state of each streaming message,
 *     keyed by its `renderKey`, so only the run line re-renders when the phase
 *     changes, and the Activity panel's header and the announcer read the same
 *     phase without a prop chain (U5);
 *   - the Research phases the announcer speaks, which the Research UI
 *     publishes here so the announcer never imports it.
 *
 * Client state only; nothing here is persisted.
 */

import * as React from "react";

import type { Announcement } from "@/lib/run/announcer";
import type { LiveAnswerState, LoopPriority, PacedPhase } from "@/lib/run/types";
import type { ResearchPhase } from "@/types/research";

export type { LoopPriority } from "@/lib/run/types";

type Listener = () => void;

function emitter() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

// ── The loop arbiter ─────────────────────────────────────────────────────────

interface Claim {
  priority: LoopPriority;
  /** Claim order: ties go to the most recent claim. */
  at: number;
  token: number;
}

const claims = new Map<string, Claim>();
const loopEvents = emitter();
let claimCounter = 0;
let owner: string | null = null;

function electOwner() {
  let best: [string, Claim] | null = null;
  for (const entry of claims) {
    const [, claim] = entry;
    if (!best || claim.priority < best[1].priority || (claim.priority === best[1].priority && claim.at > best[1].at)) best = entry;
  }
  const next = best ? best[0] : null;
  if (next !== owner) {
    owner = next;
    loopEvents.emit();
  }
}

/**
 * Claims the loop for `id` at `priority` (1 wins); returns the release.
 * Re-claiming an id updates its priority and makes it the most recent claim.
 * A release only drops the claim it made, so a stale cleanup cannot release
 * a newer claim under the same id.
 */
export function claimLoop(id: string, priority: LoopPriority): () => void {
  claimCounter += 1;
  const token = claimCounter;
  claims.set(id, { priority, at: claimCounter, token });
  electOwner();
  return () => {
    if (claims.get(id)?.token !== token) return;
    claims.delete(id);
    electOwner();
  };
}

/** The id that owns the loop now, or null. */
export function loopOwner(): string | null {
  return owner;
}

export function subscribeLoopOwner(listener: Listener): () => void {
  return loopEvents.subscribe(listener);
}

/** True while `id` owns the loop. "false" on the server: the static signature is the safe first frame. */
export function useLoopOwner(id: string): boolean {
  return React.useSyncExternalStore(
    loopEvents.subscribe,
    () => owner === id,
    () => false,
  );
}

/**
 * Holds a claim while `active`, at `priority`, and returns whether this id
 * owns the loop. The one way a component joins the arbiter.
 */
export function useLoopClaim(id: string, priority: LoopPriority, active: boolean): boolean {
  React.useEffect(() => {
    if (!active) return;
    return claimLoop(id, priority);
  }, [id, priority, active]);
  const owns = useLoopOwner(id);
  return active && owns;
}

// ── Per-message phase and live answer ────────────────────────────────────────

const phases = new Map<string, PacedPhase>();
const phaseEvents = emitter();
const answers = new Map<string, LiveAnswerState>();
const answerEvents = emitter();

/** Publishes a message's paced phase. The same object again is a no-op. */
export function setRunPhase(renderKey: string, phase: PacedPhase | null): void {
  if (phase === null) {
    if (!phases.delete(renderKey)) return;
  } else {
    if (phases.get(renderKey) === phase) return;
    phases.set(renderKey, phase);
  }
  phaseEvents.emit();
}

export function getRunPhase(renderKey: string): PacedPhase | null {
  return phases.get(renderKey) ?? null;
}

export function subscribeRunPhase(listener: Listener): () => void {
  return phaseEvents.subscribe(listener);
}

/**
 * A message's paced phase, or a selection of it. The selector keeps a
 * subscriber from re-rendering when a part it does not read changes: the
 * panel header reads only the phase word.
 */
export function useRunPhase<T = PacedPhase | null>(
  renderKey: string | null,
  select: (phase: PacedPhase | null) => T = (phase) => phase as T,
): T {
  const read = () => select(renderKey ? getRunPhase(renderKey) : null);
  return React.useSyncExternalStore(phaseEvents.subscribe, read, () => select(null));
}

export function setLiveAnswer(renderKey: string, state: LiveAnswerState | null): void {
  if (state === null) {
    if (!answers.delete(renderKey)) return;
  } else {
    const current = answers.get(renderKey);
    if (current && current.revealed === state.revealed && current.verdicts === state.verdicts) return;
    answers.set(renderKey, state);
  }
  answerEvents.emit();
}

export function getLiveAnswer(renderKey: string): LiveAnswerState | null {
  return answers.get(renderKey) ?? null;
}

/** The live-answer state the run block publishes for this message (verdicts, reveal). */
export function useLiveAnswerState(renderKey: string | null): LiveAnswerState | null {
  return React.useSyncExternalStore(
    answerEvents.subscribe,
    () => (renderKey ? answers.get(renderKey) ?? null : null),
    () => null,
  );
}

// ── What the chat runs announce ──────────────────────────────────────────────

type AnnouncementListener = (renderKey: string, announcement: Announcement) => void;
const announcementListeners = new Set<AnnouncementListener>();

/**
 * A run block says what its message's run just did (a phase boundary, the
 * summary at done). The one announcer subscribes and speaks it if the message
 * is the one streaming; the run block never owns a live region itself.
 */
export function announceRun(renderKey: string, announcement: Announcement): void {
  for (const listener of [...announcementListeners]) listener(renderKey, announcement);
}

export function subscribeRunAnnouncements(listener: AnnouncementListener): () => void {
  announcementListeners.add(listener);
  return () => {
    announcementListeners.delete(listener);
  };
}

// ── Research phases for the announcer ────────────────────────────────────────

export interface PublishedResearchPhase {
  runId: string;
  phase: ResearchPhase;
  /** Publication order, so the announcer can say the newest first. */
  at: number;
}

const research = new Map<string, PublishedResearchPhase>();
const researchEvents = emitter();
let researchCounter = 0;

/** Research rows publish their run's phase here; publishing the same phase again is a no-op. */
export function publishResearchPhase(runId: string, phase: ResearchPhase): void {
  if (research.get(runId)?.phase === phase) return;
  researchCounter += 1;
  research.set(runId, { runId, phase, at: researchCounter });
  researchEvents.emit();
}

/** A run left the conversation: forget it, so switching back does not re-announce it. */
export function clearResearchPhase(runId: string): void {
  if (research.delete(runId)) researchEvents.emit();
}

export function researchPhases(): readonly PublishedResearchPhase[] {
  return [...research.values()].sort((a, b) => a.at - b.at);
}

export function subscribeResearchPhases(listener: Listener): () => void {
  return researchEvents.subscribe(listener);
}

/** Test seam: forgets every claim, phase and publication. */
export function resetRunStoreForTests(): void {
  claims.clear();
  owner = null;
  phases.clear();
  answers.clear();
  research.clear();
  loopEvents.emit();
  phaseEvents.emit();
  answerEvents.emit();
  researchEvents.emit();
}
