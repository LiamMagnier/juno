/**
 * Teach by demonstration: what a request may do, and in what order
 * (docs/design/agents-v2/TEACH.md).
 *
 * Every operation is scoped by (userId, agentId) from the server's session,
 * never by anything the client or the model sends; a demonstration id names a
 * row only inside that scope. The real database, cipher, computer, recorder
 * and model are injected (src/lib/teach/server.ts wires them), so the rules
 * here run in tests without any of them (tests/teach-demonstration.test.ts):
 *
 *   - off unless the switch is on (`deps.enabled()`), whatever is asked;
 *   - recording starts only during a take over this very client holds, on an
 *     awake computer no task is using (a task holds the browser connection);
 *   - the trace and the screenshots are encrypted before they are stored, and
 *     what is stored is the redacted trace, never the raw observations;
 *   - a draft is built from the stored, redacted trace alone, and goes through
 *     the same gate a chat draft does. Nothing is saved as a skill here: the
 *     Teach page's Save is the write.
 */

import type { ClientSkillDraft } from "@/lib/skills/teach";
import {
  admitDemonstrationDraft,
  buildDemonstrationDraftPrompt,
  parseDemonstrationDraft,
  readDemonstrationTrace,
  type DemonstrationTrace,
} from "@/lib/teach/demonstration";
import type { DemonstrationCollector, DemonstrationEndReason } from "@/lib/teach/collector";

export type DemonstrationStatus = "recording" | "recorded" | "discarded";

export interface DemonstrationRow {
  id: string;
  userId: string;
  agentId: string;
  status: string;
  endReason: string | null;
  stepCount: number;
  trace: string | null;
  shots: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface DemonstrationPersistence {
  create(data: { userId: string; agentId: string; startedAt: Date }): Promise<DemonstrationRow>;
  find(userId: string, agentId: string, id: string): Promise<DemonstrationRow | null>;
  latest(userId: string, agentId: string): Promise<DemonstrationRow | null>;
  /** Writes only a row of (userId, agentId, id); false when there is none. */
  update(
    userId: string,
    agentId: string,
    id: string,
    data: Partial<Pick<DemonstrationRow, "status" | "endReason" | "stepCount" | "trace" | "shots" | "endedAt">>
  ): Promise<boolean>;
}

/** The take over as the recorder needs it, read server-side from (userId, agentId). */
export interface TeachComputerState {
  /** The account may use this computer now (src/lib/computer/access.ts). */
  allowed: boolean;
  awake: boolean;
  takeoverActive: boolean;
  /** Who holds it: "web" or "native:<device session>". */
  takeoverBy: string | null;
  takeoverEpoch: number;
  takeoverUntil: Date | null;
  /** A task holds the computer's lease (and so its browser connection). */
  leaseLive: boolean;
}

/** A running recording, as the recorder hands it back. */
export interface RecorderSession {
  /** Stops listening and disconnects from the browser. Idempotent. */
  close(): Promise<void>;
}

export interface StartRecorderInput {
  userId: string;
  agentId: string;
  collector: DemonstrationCollector;
  /** Read every couple of seconds; false ends the recording (take over gone or about to lapse). */
  stillHeld: () => Promise<boolean>;
  /** The recorder decided to stop (a cap, the take over ended, the browser went away). */
  onEnd: (reason: DemonstrationEndReason) => void;
  /** Called now and then so an interrupted recording keeps what it had. */
  onCheckpoint: () => void;
}

export interface TeachDeps {
  enabled(): boolean;
  now(): Date;
  persistence: DemonstrationPersistence;
  encrypt(plain: string): string;
  decrypt(stored: string): string | null;
  readComputer(userId: string, agentId: string): Promise<TeachComputerState | null>;
  startRecorder(input: StartRecorderInput): Promise<RecorderSession>;
  createCollector(startedAt: number): DemonstrationCollector;
  /** The drafting model call (the account's background provider, billed to it). */
  draftModel(input: { userId: string; agentId: string; system: string; userMsg: string }): Promise<string | null>;
}

/** What the client sees of a demonstration. Never the trace's typed values. */
export interface ClientDemonstration {
  id: string;
  status: DemonstrationStatus;
  steps: number;
  site: string | null;
  redactions: number;
  truncated: boolean;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ClientTeachState {
  enabled: boolean;
  recording: ClientDemonstration | null;
  latest: ClientDemonstration | null;
}

export const TEACH_COPY = {
  off: "Teaching by showing isn’t turned on for this server.",
  noAccess: "This account can’t use the agent’s computer right now.",
  notAwake: "Wake the computer first, then show it how.",
  notHeld: "Take control first. Recording only runs while you have control.",
  leased: "A task is using the computer. Show it how once the task is done.",
  already: "It’s already recording.",
  notFound: "That recording isn’t here any more.",
  notRecorded: "That recording has no steps to learn from.",
  noBrowser: "Couldn’t reach the browser on the computer to record. Try again in a moment.",
  noDraft: "Couldn’t draft a skill from that recording. Try again in a moment.",
} as const;

export type TeachRefusal = keyof typeof TEACH_COPY;

export class TeachError extends Error {
  constructor(
    readonly code: TeachRefusal,
    readonly status: 400 | 404 | 409 | 502
  ) {
    super(TEACH_COPY[code]);
    this.name = "TeachError";
  }
}

/** How long a recording row may say "recording" with no recorder behind it before it is settled. */
export const ORPHANED_RECORDING_MS = 30_000;
/** A take over closer than this to lapsing ends the recording first, so the agent never resumes under it. */
export const TAKEOVER_LAPSE_MARGIN_MS = 10_000;
/** How often a running recording is written down. */
export const CHECKPOINT_INTERVAL_MS = 20_000;

interface LiveRecording {
  demonstrationId: string;
  userId: string;
  agentId: string;
  collector: DemonstrationCollector;
  session: RecorderSession | null;
  ending: Promise<ClientDemonstration | null> | null;
  lastCheckpointAt: number;
}

/**
 * Whether a take over still belongs to the client recording it, with margin:
 * the same holder, the same epoch, and more than `TAKEOVER_LAPSE_MARGIN_MS`
 * left on the window. Pure.
 */
export function recordingStillHeld(
  state: TeachComputerState | null,
  started: { holder: string; epoch: number },
  now: Date
): boolean {
  if (!state || !state.allowed || !state.awake || !state.takeoverActive) return false;
  if (state.takeoverBy !== started.holder || state.takeoverEpoch !== started.epoch) return false;
  return !state.takeoverUntil || state.takeoverUntil.getTime() - now.getTime() > TAKEOVER_LAPSE_MARGIN_MS;
}

function readStatus(value: string): DemonstrationStatus {
  return value === "recording" || value === "discarded" ? value : "recorded";
}

export function createTeachService(deps: TeachDeps) {
  /** Live recordings in this process, by `${userId}:${agentId}`. */
  const live = new Map<string, LiveRecording>();
  const keyOf = (userId: string, agentId: string) => `${userId}:${agentId}`;

  function clientOf(row: DemonstrationRow, trace: DemonstrationTrace | null): ClientDemonstration {
    return {
      id: row.id,
      status: readStatus(row.status),
      steps: trace?.steps.length ?? row.stepCount,
      site: trace?.origin ? new URL(trace.origin).hostname : null,
      redactions: trace?.redactions ?? 0,
      truncated: trace?.truncated ?? false,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      endReason: row.endReason,
    };
  }

  function storedTrace(row: DemonstrationRow): DemonstrationTrace | null {
    if (!row.trace) return null;
    const plain = deps.decrypt(row.trace);
    if (!plain) return null;
    try {
      return readDemonstrationTrace(JSON.parse(plain));
    } catch {
      return null;
    }
  }

  /** Writes what a recording holds: the redacted trace and screenshots, encrypted. */
  async function persist(recording: LiveRecording, data: { status?: DemonstrationStatus; endReason?: DemonstrationEndReason; endedAt?: Date }) {
    const endedAt = (data.endedAt ?? deps.now()).getTime();
    const trace = recording.collector.trace(endedAt);
    const shots = recording.collector.shots();
    await deps.persistence.update(recording.userId, recording.agentId, recording.demonstrationId, {
      trace: deps.encrypt(JSON.stringify(trace)),
      shots: shots.length > 0 ? deps.encrypt(JSON.stringify(shots)) : null,
      stepCount: trace.steps.length,
      ...(data.status ? { status: data.status } : {}),
      ...(data.endReason ? { endReason: data.endReason } : {}),
      ...(data.endedAt ? { endedAt: data.endedAt } : {}),
    });
    return trace;
  }

  async function finish(recording: LiveRecording, reason: DemonstrationEndReason): Promise<ClientDemonstration | null> {
    if (recording.ending) return recording.ending;
    recording.ending = (async () => {
      // Disconnect from the browser first: the agent's own connection must be
      // free before Hand back lets it carry on.
      await recording.session?.close().catch(() => undefined);
      const endedAt = deps.now();
      const trace = await persist(recording, { status: "recorded", endReason: reason, endedAt });
      if (live.get(keyOf(recording.userId, recording.agentId)) === recording) live.delete(keyOf(recording.userId, recording.agentId));
      const row = await deps.persistence.find(recording.userId, recording.agentId, recording.demonstrationId);
      return row ? clientOf(row, trace) : null;
    })();
    return recording.ending;
  }

  /** A row that says "recording" with nothing recording it (a restart): settled with what it kept. */
  async function settleOrphan(row: DemonstrationRow): Promise<DemonstrationRow> {
    if (row.status !== "recording" || live.has(keyOf(row.userId, row.agentId))) return row;
    if (deps.now().getTime() - row.startedAt.getTime() < ORPHANED_RECORDING_MS) return row;
    const endedAt = deps.now();
    const status: DemonstrationStatus = row.stepCount > 0 ? "recorded" : "discarded";
    await deps.persistence.update(row.userId, row.agentId, row.id, {
      status,
      endReason: "interrupted",
      endedAt,
      ...(status === "discarded" ? { trace: null, shots: null } : {}),
    });
    return { ...row, status, endReason: "interrupted", endedAt, ...(status === "discarded" ? { trace: null, shots: null } : {}) };
  }

  return {
    /** The switch, the recording in progress (if any) and the latest recording. */
    async status(userId: string, agentId: string): Promise<ClientTeachState> {
      if (!deps.enabled()) return { enabled: false, recording: null, latest: null };
      const latestRow = await deps.persistence.latest(userId, agentId);
      if (!latestRow) return { enabled: true, recording: null, latest: null };
      const row = await settleOrphan(latestRow);
      const view = clientOf(row, storedTrace(row));
      const running = live.get(keyOf(userId, agentId));
      if (running && running.demonstrationId === row.id && row.status === "recording") {
        const trace = running.collector.trace(deps.now().getTime());
        return { enabled: true, recording: { ...view, steps: trace.steps.length, redactions: trace.redactions, site: trace.origin ? new URL(trace.origin).hostname : null }, latest: null };
      }
      return { enabled: true, recording: null, latest: view.status === "discarded" ? null : view };
    },

    /**
     * Starts recording the take over `holder` has open. `holder` is the
     * server's own reading of who is asking (takeoverHolder), never a value
     * from the request body.
     */
    async start(userId: string, agentId: string, holder: string): Promise<ClientDemonstration> {
      if (!deps.enabled()) throw new TeachError("off", 404);
      const key = keyOf(userId, agentId);
      if (live.has(key)) throw new TeachError("already", 409);
      const state = await deps.readComputer(userId, agentId);
      if (state && !state.allowed) throw new TeachError("noAccess", 409);
      if (!state || !state.awake) throw new TeachError("notAwake", 409);
      if (!state.takeoverActive || state.takeoverBy !== holder) throw new TeachError("notHeld", 409);
      if (state.leaseLive) throw new TeachError("leased", 409);
      const started = { holder, epoch: state.takeoverEpoch };

      const startedAt = deps.now();
      const row = await deps.persistence.create({ userId, agentId, startedAt });
      const recording: LiveRecording = {
        demonstrationId: row.id,
        userId,
        agentId,
        collector: deps.createCollector(startedAt.getTime()),
        session: null,
        ending: null,
        lastCheckpointAt: startedAt.getTime(),
      };
      live.set(key, recording);
      try {
        recording.session = await deps.startRecorder({
          userId,
          agentId,
          collector: recording.collector,
          stillHeld: async () => recordingStillHeld(await deps.readComputer(userId, agentId).catch(() => null), started, deps.now()),
          onEnd: (reason) => void finish(recording, reason).catch(() => undefined),
          onCheckpoint: () => {
            const now = deps.now().getTime();
            if (recording.ending || now - recording.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
            recording.lastCheckpointAt = now;
            void persist(recording, {}).catch(() => undefined);
          },
        });
      } catch {
        live.delete(key);
        await deps.persistence.update(userId, agentId, row.id, { status: "discarded", endReason: "error", endedAt: deps.now() });
        throw new TeachError("noBrowser", 502);
      }
      return clientOf(row, null);
    },

    /** Stops this agent's recording, if one runs. Returns what was recorded. */
    async stop(userId: string, agentId: string, reason: DemonstrationEndReason = "stopped"): Promise<ClientDemonstration | null> {
      const recording = live.get(keyOf(userId, agentId));
      if (!recording) return null;
      return finish(recording, reason);
    },

    /** Forgets a recording: its trace and screenshots are erased, not just hidden. */
    async discard(userId: string, agentId: string, id: string): Promise<boolean> {
      if (!deps.enabled()) throw new TeachError("off", 404);
      const running = live.get(keyOf(userId, agentId));
      if (running?.demonstrationId === id) await finish(running, "stopped");
      const row = await deps.persistence.find(userId, agentId, id);
      if (!row) throw new TeachError("notFound", 404);
      return deps.persistence.update(userId, agentId, id, { status: "discarded", trace: null, shots: null, endedAt: row.endedAt ?? deps.now() });
    },

    /**
     * Drafts a skill from a recorded demonstration. The model sees the
     * redacted trace's lines and nothing else; its answer goes through the
     * chat draft's gate. Returns the draft for the review card.
     */
    async draft(userId: string, agentId: string, id: string, agentName: string): Promise<ClientSkillDraft> {
      if (!deps.enabled()) throw new TeachError("off", 404);
      const row = await deps.persistence.find(userId, agentId, id);
      if (!row || row.status === "discarded") throw new TeachError("notFound", 404);
      if (row.status !== "recorded") throw new TeachError("notRecorded", 409);
      const trace = storedTrace(row);
      if (!trace || trace.steps.length === 0) throw new TeachError("notRecorded", 409);
      const prompt = buildDemonstrationDraftPrompt(trace, { agentName });
      const text = await deps.draftModel({ userId, agentId, system: prompt.system, userMsg: prompt.userMsg }).catch(() => null);
      const args = text ? parseDemonstrationDraft(text) : null;
      if (!args) throw new TeachError("noDraft", 502);
      const admission = admitDemonstrationDraft(args, { demonstrationId: id, trace, now: deps.now() });
      if (!admission.ok) throw Object.assign(new TeachError("noDraft", 502), { message: admission.message });
      return admission.draft;
    },

    /** For tests and the hand back hook: whether this agent has a recording running here. */
    isRecording(userId: string, agentId: string): boolean {
      return live.has(keyOf(userId, agentId));
    },
  };
}

export type TeachService = ReturnType<typeof createTeachService>;
