/**
 * The Work service: one method per invoke channel, backed by the real backend.
 *
 * ## What this is talking to
 *
 * `/api/work/*` — twenty-six route files, of which this surface uses ten:
 * `sessions`, `sessions/[id]/events`, `sessions/[id]/context`,
 * `sessions/[id]/runs`, `sessions/[id]/answer`, `runs/[id]/control`,
 * `approvals/[id]/decision`, `hosts`, `skills` and
 * `artifacts/[id]/download` — plus `/api/connectors` and `/api/models` for the
 * composer. They authenticate with
 * `requireUser()`, which accepts the native bearer, so the same credential that
 * opens `/api/v1` opens these. Note they are NOT `/api/v1` routes: they do not
 * stamp `X-Juno-Contract-Version`, and the transport reads that absence as
 * `{status: 'absent'}`, which `isBlockingContractObservation` does not block. It
 * does log one warning per change in observation, so a session that alternates
 * between `/api/v1` and `/api/work` calls will see the observation flap. That is
 * a wart in a module this surface does not own; it is recorded here rather than
 * worked around, because working around it would mean a second transport.
 *
 * ## The three things the backend does not have
 *
 * Named here, at the top, rather than discovered by whoever debugs them:
 *
 *  1. **No audit-trail read route.** `recordWorkAudit` writes `WorkAudit` rows
 *     and nothing in `src/app/api/**` reads them back. `auditTrail` therefore
 *     throws a sentence saying so. It does not return `{entries: []}`: an empty
 *     security log is a claim that nothing was recorded, which is a different
 *     and much worse statement than "this app cannot read it".
 *  2. **No route accepts a local path as a grant.** `POST /api/work/sessions`
 *     takes `attachmentIds` — uploads — and a folder on a Mac is a `WorkFileGrant`
 *     written by the relay's `grant_folder` command, which only a *registered
 *     Work host* may send. This app is not one. So `createTask` refuses rather
 *     than creating a task silently missing the folder somebody picked.
 *  3. **No JSON events endpoint.** The event log is Server-Sent Events only. See
 *     `event-stream.ts` for what this does about it.
 *
 * ## Signed out
 *
 * Normal during development, and every method says the same thing: the token
 * source throws `NotSignedInError`, and `describeFailure` turns it into one
 * sentence with no status code in it.
 */

import { z } from 'zod';
import { createLogger } from '../logger.js';
import {
  ApiError,
  CancelledError,
  ContractMismatchError,
  MalformedResponseError,
  NetworkError,
  TimeoutError,
  UnauthorizedError,
  type AccessTokenSource,
  type JunoTransport,
  type RequestSpec,
} from '../auth/transport.js';
import type {
  WorkApproval,
  WorkCapabilitiesSnapshot,
  WorkEmittedEvent,
  WorkEventChannel,
  WorkEventPayload,
  WorkInvokeChannel,
  WorkInvokeRequest,
  WorkInvokeResponse,
  WorkPollState,
  WorkSessionSummary,
  WorkSnapshot,
} from '../../shared/contracts/work.js';
import { ArtifactDownloader } from './artifacts.js';
import { BearerFetcher } from './bearer.js';
import { GrantVault } from './grants.js';
import { WorkEventStream } from './event-stream.js';
import { createElectronNativePorts, type WorkNativePorts } from './native.js';
import {
  WorkPoller,
  activityForStatus,
  type PollResult,
  type PollTiming,
} from './poller.js';
import {
  AnswerResponseSchema,
  ApprovalDecisionResponseSchema,
  ConnectorListResponseSchema,
  HostListResponseSchema,
  ModelListResponseSchema,
  RunResponseSchema,
  SessionContextResponseSchema,
  SessionCreateResponseSchema,
  SessionListResponseSchema,
  SkillListResponseSchema,
  connectorIsOfferable,
  openQuestions,
  toWorkApproval,
  toWorkConnectorRef,
  toWorkEvent,
  toWorkGrants,
  toWorkHostRef,
  toWorkModelOption,
  toWorkRun,
  toWorkSession,
  toWorkSessionSummary,
  toWorkSkillRef,
  type WireSessionContext,
  type WireStreamFrame,
} from './wire.js';

const log = createLogger('sync');

/**
 * `DEFAULT_RUN_BUDGET` as the contract has it.
 *
 * GAP — no route publishes the account's budget. `NO_BUDGET` in
 * `src/lib/work/domain.ts` is all zeroes and zero means "no explicit ceiling",
 * which is exactly what a task created through this app gets: `createRun`
 * applies the plan's default server-side and the run reports the ceiling it was
 * actually given. Sending zeroes is therefore true rather than a placeholder —
 * the composer has no ceiling to show because none has been chosen yet.
 */
const NO_BUDGET = { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 } as const;

/** An error whose message is written for the person holding the app. */
export class WorkServiceError extends Error {
  override readonly name = 'WorkServiceError';
}

export type WorkEmit = <C extends WorkEventChannel>(
  channel: C,
  payload: WorkEventPayload<C>,
) => void;

export interface WorkServiceOptions {
  readonly transport: JunoTransport;
  readonly tokens: AccessTokenSource;
  readonly emit: WorkEmit;
  /* Everything below is optional and defaulted. `index.ts` wires the three
     above and nothing else. */
  readonly appVersion?: string;
  readonly native?: WorkNativePorts;
  /** Switch the Chat surface to a conversation. Absent until Chat wires one. */
  readonly openConversation?: (conversationId: string) => void | Promise<void>;
  readonly timing?: PollTiming;
  readonly now?: () => number;
  readonly jitter?: () => number;
  readonly fetchImpl?: typeof fetch;
}

export class WorkService {
  readonly #transport: JunoTransport;
  readonly #tokens: AccessTokenSource;
  readonly #emit: WorkEmit;
  readonly #native: WorkNativePorts;
  readonly #grants = new GrantVault();
  readonly #stream: WorkEventStream;
  readonly #artifacts: ArtifactDownloader;
  readonly #poller: WorkPoller;
  readonly #openConversation: ((conversationId: string) => void | Promise<void>) | undefined;
  readonly #now: () => number;

  /**
   * The run id the cursor belongs to. `seq` is unique per RUN, so a cursor
   * without one is a cursor that can be applied to the wrong transcript.
   */
  #cursorRunId: string | null = null;

  constructor(options: WorkServiceOptions) {
    this.#transport = options.transport;
    this.#tokens = options.tokens;
    this.#emit = options.emit;
    this.#native = options.native ?? createElectronNativePorts();
    this.#openConversation = options.openConversation;
    this.#now = options.now ?? Date.now;

    const http = new BearerFetcher({
      origin: options.transport.origin,
      tokens: options.tokens,
      appVersion: options.appVersion ?? '0.0.0',
      contractVersion: options.transport.contractVersion,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.#stream = new WorkEventStream({ http });
    this.#artifacts = new ArtifactDownloader({
      http,
      directory: () => this.#native.downloadsDirectory(),
    });

    this.#poller = new WorkPoller({
      fetchSnapshot: (sessionId, sinceSeq, signal) => this.#poll(sessionId, sinceSeq, signal),
      fetchTasks: async (signal) =>
        (await this.#listSessions({ archived: false, limit: 100 }, signal)).map(
          toWorkSessionSummary,
        ),
      emitPollState: (state) => this.#emit('work:poll-state', state),
      emitSnapshot: (snapshot) => this.#emit('work:snapshot', snapshot),
      emitTasks: (tasks, fetchedAt) => this.#emit('work:tasks', { tasks: [...tasks], fetchedAt }),
      describeFailure: (error) => describeFailure(error),
      now: this.#now,
      jitter: options.jitter ?? Math.random,
      ...(options.timing === undefined ? {} : { timing: options.timing }),
    });
  }

  /** Begin the task list's slow loop. Called once the account is signed in. */
  start(): void {
    this.#poller.resume();
  }

  /** Signed out, or shutting down. Stops every timer and forgets every grant. */
  stop(): void {
    this.#poller.suspend();
    this.#grants.clear();
    this.#cursorRunId = null;
  }

  dispose(): void {
    this.#poller.dispose();
    this.#grants.clear();
  }

  /* ====================================================================== */
  /* work:list-tasks                                                         */
  /* ====================================================================== */

  /**
   * `GET /api/work/sessions`.
   *
   * GAP — the route's `archived` filter is a strict boolean and there is no
   * "either": `parseSessionListQuery` reads an absent value as `false` because
   * "the archive is a place a user puts a session to stop seeing it". `all`
   * therefore costs two requests and merges them, rather than quietly meaning
   * "all the unarchived ones", which is what a single request would have given.
   */
  async listTasks(
    request: WorkInvokeRequest<'work:list-tasks'>,
  ): Promise<WorkInvokeResponse<'work:list-tasks'>> {
    const limit = request.limit ?? 100;
    const sessions =
      request.filter === 'all'
        ? [
            ...(await this.#listSessions({ archived: false, limit })),
            ...(await this.#listSessions({ archived: true, limit })),
          ]
        : await this.#listSessions({
            archived: request.filter === 'archived',
            limit,
            ...(request.filter === 'needs-attention' ? { needsAttention: true } : {}),
          });

    return {
      tasks: sessions.map(toWorkSessionSummary),
      fetchedAt: new Date(this.#now()).toISOString(),
    };
  }

  async #listSessions(
    query: { archived: boolean; limit: number; needsAttention?: boolean },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof SessionListResponseSchema>['sessions']> {
    const params = new URLSearchParams({
      archived: String(query.archived),
      limit: String(query.limit),
    });
    if (query.needsAttention === true) params.set('needsAttention', 'true');
    const { data } = await this.#request(
      {
        path: `/api/work/sessions?${params.toString()}`,
        method: 'GET',
        schema: SessionListResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      },
      'the task list',
    );
    return data.sessions;
  }

  /* ====================================================================== */
  /* work:task-snapshot                                                      */
  /* ====================================================================== */

  /**
   * One task's full state.
   *
   * Two requests, and both are needed. The event stream's first frame carries
   * the session, the run, the approvals and the events; `.../context` carries
   * the file grants, the connectors and the skill, which the session serializer
   * deliberately does not join.
   */
  async taskSnapshot(
    request: WorkInvokeRequest<'work:task-snapshot'>,
  ): Promise<WorkInvokeResponse<'work:task-snapshot'>> {
    const sinceSeq = request.sinceSeq ?? 0;
    const runId = sinceSeq > 0 ? this.#cursorRunId : null;
    const result = await this.#snapshotFor(request.sessionId, runId, sinceSeq);
    return result.snapshot;
  }

  async #poll(sessionId: string, sinceSeq: number, signal: AbortSignal): Promise<PollResult> {
    return this.#snapshotFor(sessionId, this.#cursorRunId, sinceSeq, signal);
  }

  async #snapshotFor(
    sessionId: string,
    sinceRunId: string | null,
    sinceSeq: number,
    signal?: AbortSignal,
  ): Promise<PollResult> {
    const { frame, replaced } = await this.#stream.readSessionFrame(
      sessionId,
      sinceRunId,
      sinceSeq,
      signal,
    );

    /* Best effort, and deliberately so: the context is three joins that decide
       what a task may *reach*, and a task's transcript should not go dark
       because the route that lists its attachments was slow. A failure means
       empty grant and connector lists, which understate rather than overstate
       what the task can do. */
    let context: WireSessionContext | null = null;
    try {
      const { data } = await this.#request(
        {
          path: `/api/work/sessions/${encodeURIComponent(sessionId)}/context`,
          method: 'GET',
          schema: SessionContextResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        },
        "the task's inputs",
      );
      context = data.context;
    } catch (error) {
      log.debug('work: session context unavailable', { reason: describeFailure(error).message });
    }

    const snapshot = this.#composeSnapshot(frame, replaced, context);
    this.#cursorRunId = frame.run?.id ?? null;
    return {
      snapshot,
      cursorSeq: frame.run?.lastSeq ?? highestSeq(snapshot.events, sinceSeq),
    };
  }

  #composeSnapshot(
    frame: WireStreamFrame,
    replaced: boolean,
    context: WireSessionContext | null,
  ): WorkSnapshot {
    const now = this.#now();

    const events: WorkEmittedEvent[] = [];
    const dropped: string[] = [];
    for (const wire of frame.events) {
      const mapped = toWorkEvent(wire);
      if (mapped === null) {
        if (wire.visibility === 'user') dropped.push(wire.kind);
        continue;
      }
      events.push(mapped);
    }
    if (dropped.length > 0) {
      /* Kinds and a count. Never a payload: an event body holds the goal, the
         model's prose and every tool result. */
      log.warn('work: dropped events this build cannot read', {
        count: dropped.length,
        kinds: [...new Set(dropped)],
      });
    }

    const approvals = frame.approvals.flatMap((wire): WorkApproval[] => {
      const mapped = toWorkApproval(wire);
      return mapped === null ? [] : [mapped];
    });

    const run = frame.run;
    return {
      session: toWorkSession(frame.session, {
        run,
        grants: context === null ? [] : toWorkGrants(context),
        connectors: [],
        skill: null,
        now,
      }),
      run: run === null ? null : toWorkRun(run, now),
      events,
      replaced,
      approvals,
      /* Folded out of the log rather than fetched: a question is a
         `question_asked` event and it closes when a `question_answered` names
         it. There is no other record of one. */
      questions: openQuestions(events),
      fetchedAt: new Date(now).toISOString(),
    };
  }

  /* ====================================================================== */
  /* work:watch-task / work:poll-now                                         */
  /* ====================================================================== */

  watchTask(request: WorkInvokeRequest<'work:watch-task'>): WorkPollState {
    if (request.sessionId === null) this.#cursorRunId = null;
    return this.#poller.watch(request.sessionId);
  }

  pollNow(request: WorkInvokeRequest<'work:poll-now'>): WorkPollState {
    return this.#poller.pollNow(request.sessionId);
  }

  /* ====================================================================== */
  /* work:create-task                                                        */
  /* ====================================================================== */

  /**
   * `POST /api/work/sessions`.
   *
   * Two mappings that are not obvious:
   *
   * **`skillSlug` becomes a prefix on the goal.** There is no skill column. The
   * runner resolves the skill from a leading `/slug` on `WorkSession.goal` —
   * `applySkill` in `scripts/work-runner.ts` — and the goal is stored verbatim
   * precisely so that every attempt is validated against the sentence the user
   * wrote. Sending the slug in a field the server does not read would produce a
   * task that ran without the skill and said it had one.
   *
   * **`grantTokens` is refused.** See the module header: no route accepts a
   * local path, and a task created without the folder somebody picked would
   * dispatch, run, and fail to find the files — with nothing anywhere saying the
   * grant was dropped.
   */
  async createTask(
    request: WorkInvokeRequest<'work:create-task'>,
  ): Promise<WorkInvokeResponse<'work:create-task'>> {
    if (request.grantTokens.length > 0) {
      const { unknown } = this.#grants.resolveAll(request.grantTokens);
      if (unknown.length > 0) {
        throw new WorkServiceError(
          'That folder selection has expired. Choose the folder again.',
        );
      }
      throw new WorkServiceError(
        'Juno cannot yet hand a task a folder from this Mac. A folder is granted through the ' +
          'Work host on your Mac, and this app is not registered as one — so the task would run ' +
          'without the files you picked. Create the task without them, or start it from the Juno ' +
          'app that is paired as a host.',
      );
    }

    const goal = applySkillSlug(request.goal, request.skillSlug);
    const { data } = await this.#request(
      {
        path: '/api/work/sessions',
        method: 'POST',
        schema: SessionCreateResponseSchema,
        body: {
          goal,
          ...(request.title === undefined ? {} : { title: request.title }),
          requestedTarget: request.target,
          permissionPolicy: request.permissionPolicy,
          ...(request.model === null ? {} : { model: request.model }),
          connectorIds: request.connectorIds,
          /* No local paths, so no attachments. `[]` rather than absent is the
             deliberate statement the route documents: a client that omits it is
             saying it has never heard of files, and this one has. */
          attachmentIds: [],
        },
      },
      'creating the task',
    );
    return { sessionId: data.session.id };
  }

  /* ====================================================================== */
  /* work:dispatch-run                                                       */
  /* ====================================================================== */

  /** `POST /api/work/sessions/[id]/runs`. The three overrides are attempt-scoped. */
  async dispatchRun(
    request: WorkInvokeRequest<'work:dispatch-run'>,
  ): Promise<WorkInvokeResponse<'work:dispatch-run'>> {
    const { data } = await this.#request(
      {
        path: `/api/work/sessions/${encodeURIComponent(request.sessionId)}/runs`,
        method: 'POST',
        schema: RunResponseSchema,
        body: {
          origin: 'manual',
          ...(request.target === undefined ? {} : { requestedTarget: request.target }),
          ...(request.permissionPolicy === undefined
            ? {}
            : { permissionPolicy: request.permissionPolicy }),
          ...(request.model === undefined ? {} : { model: request.model }),
        },
        /* Dispatch reaches for an executor and can wait on a relay. */
        timeoutMs: 30_000,
      },
      'starting the task',
    );
    this.#poller.setActivity(activityForStatus(data.run.status));
    return { runId: data.run.id, attempt: data.run.attempt };
  }

  /* ====================================================================== */
  /* work:control-run                                                        */
  /* ====================================================================== */

  /**
   * `POST /api/work/runs/[id]/control`.
   *
   * The route's three 409s — `run_not_live`, `run_not_pausable`, `run_not_paused`
   * — each carry a sentence written for the reader, and each is surfaced as
   * that sentence. The contract has no `ok: false` here, so they are thrown; a
   * `{ok: true}` for a pause that did not happen would be the exact lie the
   * conditional UPDATE on the server exists to prevent.
   */
  async controlRun(
    request: WorkInvokeRequest<'work:control-run'>,
  ): Promise<WorkInvokeResponse<'work:control-run'>> {
    const { data } = await this.#request(
      {
        path: `/api/work/runs/${encodeURIComponent(request.runId)}/control`,
        method: 'POST',
        schema: RunResponseSchema,
        body: { action: request.action },
      },
      request.action === 'cancel' ? 'stopping the task' : `${request.action}ing the task`,
    );
    const status = coerceStatus(data.run.status);
    this.#poller.setActivity(activityForStatus(status));
    return { ok: true, status };
  }

  /* ====================================================================== */
  /* work:answer                                                             */
  /* ====================================================================== */

  /**
   * `POST /api/work/sessions/[id]/answer`.
   *
   * One route, two requests, told apart by the presence of `questionId` — which
   * is exactly what the contract's one optional field expresses.
   *
   * The refusal mapping, from the route's own 409 codes:
   *
   *  · `answer_expected` → `waiting_input`. Steering sent to a run that is
   *    stopped on a question. The contract names this one explicitly: a
   *    `waiting_input` run refuses steering because it is stopped, and saying
   *    otherwise would lie.
   *  · `run_not_waiting_input`, `run_finished`, `run_not_started` → `not_live`.
   *    Three ways of being unable to take what was sent, all of them "this
   *    attempt is not in a state to hear you".
   *
   * GAP — `unknown_question` is unreachable. The route checks that the run is
   * `waiting_input` and then appends the answer keyed on whatever `questionId`
   * arrived; it never compares it against the question that was asked. So a
   * stale answer to a superseded question is accepted server-side, and this
   * client cannot report otherwise without inventing a verdict.
   */
  async answer(
    request: WorkInvokeRequest<'work:answer'>,
  ): Promise<WorkInvokeResponse<'work:answer'>> {
    try {
      await this.#request(
        {
          path: `/api/work/sessions/${encodeURIComponent(request.sessionId)}/answer`,
          method: 'POST',
          schema: AnswerResponseSchema,
          body:
            request.questionId === null
              ? { text: request.text }
              : { questionId: request.questionId, text: request.text },
        },
        request.questionId === null ? 'sending your instruction' : 'sending your answer',
      );
      return {
        ok: true,
        kind: request.questionId === null ? 'user_message' : 'question_answered',
      };
    } catch (error) {
      const refusal = answerRefusal(error);
      if (refusal !== null) return { ok: false, reason: refusal };
      throw error;
    }
  }

  /* ====================================================================== */
  /* work:resolve-approval                                                   */
  /* ====================================================================== */

  /**
   * `POST /api/work/approvals/[id]/decision`.
   *
   * The five refusals come back named, one for one, because the server already
   * names them: `APPROVAL_DECISION_REFUSALS` in `src/app/api/work/protocol.ts`
   * is the same closed set as `WORK_APPROVAL_REFUSALS` in the desktop
   * vocabulary, and each arrives as a 409 whose `error` is the reason.
   *
   * Nothing here re-derives a refusal. `not_standing_allowable` in particular is
   * the server's judgement about whether an action may ever be covered by a
   * standing allowance, and a client that decided for itself would be a second
   * copy of a security classifier.
   */
  async resolveApproval(
    request: WorkInvokeRequest<'work:resolve-approval'>,
  ): Promise<WorkInvokeResponse<'work:resolve-approval'>> {
    try {
      const { data } = await this.#request(
        {
          path: `/api/work/approvals/${encodeURIComponent(request.approvalId)}/decision`,
          method: 'POST',
          schema: ApprovalDecisionResponseSchema,
          body: {
            decision: request.decision,
            actionDigest: request.actionDigest,
          },
        },
        'recording your decision',
      );
      const decision = toWorkApproval(data.approval)?.decision ?? request.decision;
      return { ok: true, decision };
    } catch (error) {
      const refusal = approvalRefusal(error);
      if (refusal !== null) {
        return { ok: false, refusal: refusal.reason, detail: refusal.detail };
      }
      throw error;
    }
  }

  /* ====================================================================== */
  /* work:audit-trail                                                        */
  /* ====================================================================== */

  /**
   * There is no route. See the module header.
   *
   * `recordWorkAudit` writes twenty kinds of `WorkAudit` row — refused
   * approvals, blocked egress, detected injection, path escapes — and no handler
   * anywhere under `src/app/api/` reads one back. Throwing is the honest answer
   * and returning an empty list is not: this is a *security* log, and "nothing
   * here" is a statement somebody would act on.
   */
  auditTrail(_request: WorkInvokeRequest<'work:audit-trail'>): never {
    throw new WorkServiceError(
      'Juno records a security log for every task, and there is no way to read it back yet — ' +
        'the backend has no endpoint for it. Nothing is missing from the log; this window ' +
        'simply cannot show it.',
    );
  }

  /* ====================================================================== */
  /* work:capabilities                                                       */
  /* ====================================================================== */

  /**
   * What the composer may offer, from four routes.
   *
   * Each is allowed to fail on its own. A deployment with no Composio
   * credentials answers `/api/connectors` differently from one that has them,
   * and a composer that showed nothing because the *hosts* route was slow would
   * be refusing to let somebody write a cloud task for an unrelated reason.
   */
  async capabilities(): Promise<WorkCapabilitiesSnapshot> {
    const [hosts, skills, connectors, models] = await Promise.all([
      this.#optional(
        async () => {
          const { data } = await this.#request(
            { path: '/api/work/hosts', method: 'GET', schema: HostListResponseSchema },
            'your Macs',
          );
          return data.hosts.map(toWorkHostRef);
        },
        [],
        'hosts',
      ),
      this.#optional(
        async () => {
          const { data } = await this.#request(
            { path: '/api/work/skills?enabled=true', method: 'GET', schema: SkillListResponseSchema },
            'your skills',
          );
          return data.skills.map(toWorkSkillRef);
        },
        [],
        'skills',
      ),
      this.#optional(
        async () => {
          const { data } = await this.#request(
            { path: '/api/connectors', method: 'GET', schema: ConnectorListResponseSchema },
            'your connected apps',
          );
          return data.connectors.filter(connectorIsOfferable).map(toWorkConnectorRef);
        },
        [],
        'connectors',
      ),
      this.#optional(
        async () => {
          const { data } = await this.#request(
            { path: '/api/models', method: 'GET', schema: ModelListResponseSchema },
            'the model list',
          );
          return data.models.map(toWorkModelOption);
        },
        [],
        'models',
      ),
    ]);

    /* Cloud capabilities are not published by any route. What IS true of every
       account is the set that needs no Mac — `capabilityRequiresLocalHost` in
       the vocabulary is the transcription of that — so the cloud half is stated
       from the contract rather than guessed from a request. */
    return {
      connectors,
      skills,
      hosts,
      cloudCapabilities: [
        'web_research',
        'connectors',
        'cloud_files',
        'deliverables',
        'background_continuation',
      ],
      defaultBudget: NO_BUDGET,
      models,
      fetchedAt: new Date(this.#now()).toISOString(),
    };
  }

  /* ====================================================================== */
  /* work:choose-grant                                                       */
  /* ====================================================================== */

  /**
   * A native picker in main, answered with an opaque token.
   *
   * The token is 32 random bytes and stands for a path this process keeps. The
   * renderer never learns the path, so a compromised renderer cannot name one
   * and cannot read one back out of a token it was handed.
   */
  async chooseGrant(
    request: WorkInvokeRequest<'work:choose-grant'>,
  ): Promise<WorkInvokeResponse<'work:choose-grant'>> {
    const chosen = await this.#native.chooseGrantPath(request.kind, request.accessMode);
    if (chosen === null) return null;

    const record = this.#grants.mint({
      kind: request.kind,
      accessMode: request.accessMode,
      path: chosen.path,
      label: chosen.label,
    });
    /* The label, never the path. `redactString` would rewrite the home
       directory and leave the rest, and the rest is the private part. */
    log.info('work: granted a local path', { kind: record.kind, accessMode: record.accessMode });
    return {
      kind: record.kind,
      label: record.label,
      token: record.token,
      accessMode: record.accessMode,
    };
  }

  /* ====================================================================== */
  /* work:open-artifact                                                      */
  /* ====================================================================== */

  /** Download and reveal. Bytes never enter the renderer. */
  async openArtifact(
    request: WorkInvokeRequest<'work:open-artifact'>,
  ): Promise<WorkInvokeResponse<'work:open-artifact'>> {
    let result;
    try {
      result = await this.#artifacts.download(request.artifactId, request.version);
    } catch (error) {
      return { ok: false, reason: describeFailure(error).message };
    }
    if (!result.ok) return { ok: false, reason: result.reason };

    try {
      await this.#native.revealPath(result.absolutePath, request.reveal);
    } catch (error) {
      /* The file IS on disk and named, so this is not a failed download. The
         reader is told where it went rather than that nothing happened. */
      return {
        ok: false,
        reason: `Juno saved “${result.filename}” to your Downloads folder but could not open it: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
    return { ok: true, filename: result.filename };
  }

  /* ====================================================================== */
  /* work:open-conversation                                                  */
  /* ====================================================================== */

  /**
   * Hand a linked conversation to the Chat surface.
   *
   * The port is supplied by `index.ts`, because switching surfaces is the
   * window's business and not this service's. Absent, this throws rather than
   * answering `{ok: true}` — the contract has no failure variant here, and a
   * cheerful ok for a window that did not move is the worst of the options.
   */
  async openConversation(
    request: WorkInvokeRequest<'work:open-conversation'>,
  ): Promise<WorkInvokeResponse<'work:open-conversation'>> {
    if (this.#openConversation === undefined) {
      throw new WorkServiceError(
        'Juno cannot open the conversation this task came from: the Chat surface is not wired ' +
          'up in this build.',
      );
    }
    await this.#openConversation(request.conversationId);
    return { ok: true };
  }

  /* ====================================================================== */
  /* Plumbing                                                                */
  /* ====================================================================== */

  /**
   * One authenticated JSON request, validated, with a failure sentence.
   *
   * `what` is the phrase the message is built around — "the task list",
   * "starting the task" — so a network failure reads as something a person did
   * rather than as a stack frame.
   */
  async #request<T>(
    spec: RequestSpec<T>,
    what: string,
  ): Promise<{ data: T }> {
    try {
      const response = await this.#transport.requestAuthenticated(spec, this.#tokens);
      return { data: response.data };
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        /* Rethrown untouched: the callers that map refusals need the code, and
           the 4xx messages this backend writes are already addressed to the
           reader. */
        throw error;
      }
      const described = describeFailure(error);
      throw new WorkServiceError(`Juno had a problem with ${what}. ${described.message}`);
    }
  }

  /** A sub-request that is allowed to fail without failing the whole answer. */
  async #optional<T>(work: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      log.warn('work: a composer input could not be loaded', {
        input: label,
        reason: describeFailure(error).message,
      });
      return fallback;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One handler per Work invoke channel, exhaustively.
 *
 * The mapped type is the point: a channel with no entry, or an entry whose
 * return type is not the channel's response, is a compile error here rather
 * than a Zod failure in `registerInvokeHandlers` at runtime. `index.ts` spreads
 * the result into its handler table and adds nothing.
 */
export type WorkInvokeHandlers = {
  [C in WorkInvokeChannel]: (
    request: WorkInvokeRequest<C>,
  ) => Promise<WorkInvokeResponse<C>> | WorkInvokeResponse<C>;
};

export function createWorkInvokeHandlers(service: WorkService): WorkInvokeHandlers {
  return {
    'work:list-tasks': (request) => service.listTasks(request),
    'work:task-snapshot': (request) => service.taskSnapshot(request),
    'work:watch-task': (request) => service.watchTask(request),
    'work:poll-now': (request) => service.pollNow(request),
    'work:create-task': (request) => service.createTask(request),
    'work:dispatch-run': (request) => service.dispatchRun(request),
    'work:control-run': (request) => service.controlRun(request),
    'work:answer': (request) => service.answer(request),
    'work:resolve-approval': (request) => service.resolveApproval(request),
    'work:audit-trail': (request) => service.auditTrail(request),
    'work:capabilities': () => service.capabilities(),
    'work:choose-grant': (request) => service.chooseGrant(request),
    'work:open-artifact': (request) => service.openArtifact(request),
    'work:open-conversation': (request) => service.openConversation(request),
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — the parts the tests pin                                      */
/* -------------------------------------------------------------------------- */

/**
 * Put the skill's slash command back on the front of the goal.
 *
 * Idempotent: a goal the reader already typed `/research` into is left alone,
 * because the composer's picker and the typed command are the same choice
 * expressed twice and doubling it would change the sentence every attempt is
 * validated against.
 */
export function applySkillSlug(goal: string, skillSlug: string | null): string {
  if (skillSlug === null || skillSlug.length === 0) return goal;
  const trimmed = goal.trimStart();
  if (trimmed.toLowerCase().startsWith(`/${skillSlug.toLowerCase()}`)) return goal;
  return `/${skillSlug} ${goal}`;
}

/** The three the contract names. A refusal outside this set is not a refusal. */
export type AnswerRefusal = 'waiting_input' | 'not_live' | 'unknown_question';

/**
 * The route's 409 code → the contract's refusal. Null when it is not a refusal.
 *
 * Written as a total mapping over the four codes the route can produce rather
 * than as a `default`, so a new code added server-side falls through and is
 * reported as the error it is instead of being silently filed as `not_live`.
 */
export function answerRefusal(error: unknown): AnswerRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  switch (error.code) {
    case 'answer_expected':
      return 'waiting_input';
    case 'run_not_waiting_input':
    case 'run_finished':
    case 'run_not_started':
      return 'not_live';
    default:
      return null;
  }
}

const ApprovalRefusalSchema = z.enum([
  'digest_mismatch',
  'policy_changed',
  'expired',
  'already_decided',
  'not_standing_allowable',
]);

/**
 * The decision route's 409 → the contract's named refusal, plus the server's
 * own sentence.
 *
 * The sentence is the server's rather than one written here, because the two
 * surfaces would otherwise word the same refusal differently and a reader who
 * saw both would have to work out whether they were the same thing.
 */
export function approvalRefusal(
  error: unknown,
): { reason: z.infer<typeof ApprovalRefusalSchema>; detail: string } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = ApprovalRefusalSchema.safeParse(error.code);
  if (!parsed.success) return null;
  return { reason: parsed.data, detail: error.message };
}

/**
 * A thrown error, as one sentence a person can act on, plus a reachability
 * verdict for the freshness bar.
 *
 * Never carries a token, a body or a path. The transport's own errors are
 * already written this way; the job here is to make sure a signed-out state
 * reads as a signed-out state rather than as HTTP 401.
 */
export function describeFailure(error: unknown): { message: string; offline: boolean } {
  if (error instanceof WorkServiceError) return { message: error.message, offline: false };

  if (error instanceof NetworkError) {
    return {
      message: 'Juno could not be reached. Check your connection.',
      offline: true,
    };
  }
  if (error instanceof TimeoutError) {
    return { message: 'Juno did not answer in time.', offline: true };
  }
  if (error instanceof CancelledError) {
    return { message: 'That refresh was cancelled.', offline: false };
  }
  if (error instanceof ContractMismatchError) {
    return { message: error.message, offline: false };
  }
  if (error instanceof MalformedResponseError) {
    return {
      message: 'Juno sent something this version of the app could not read.',
      offline: false,
    };
  }
  if (error instanceof UnauthorizedError) {
    return {
      message: 'Juno signed this device out. Sign in again to see your tasks.',
      offline: false,
    };
  }
  if (error instanceof ApiError) {
    return {
      message: error.message,
      /* A 5xx is the deployment, not the user's network. The bar says "Juno is
         having a problem" rather than "you are offline", which is the
         difference between waiting and rebooting a router. */
      offline: false,
    };
  }
  /* `NotSignedInError` is the common one in development, and it arrives as a
     plain `AuthFlowError` from a module this file does not import a class from.
     Matched on the name so no import cycle is introduced for one instanceof. */
  if (error instanceof Error && error.name === 'NotSignedInError') {
    return {
      message: 'No Juno account is signed in on this Mac. Sign in to see your tasks.',
      offline: false,
    };
  }
  if (error instanceof Error) return { message: error.message, offline: false };
  return { message: 'Something went wrong.', offline: false };
}

function highestSeq(events: readonly WorkEmittedEvent[], fallback: number): number {
  return events.reduce((highest, event) => Math.max(highest, event.seq), fallback);
}

function coerceStatus(raw: string): WorkInvokeResponse<'work:control-run'>['status'] {
  const parsed = z
    .enum([
      'draft',
      'queued',
      'preparing',
      'running',
      'waiting_input',
      'waiting_approval',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'host_offline',
      'budget_exceeded',
      'timed_out',
    ])
    .safeParse(raw);
  return parsed.success ? parsed.data : 'interrupted';
}

export type { WorkSessionSummary, WorkSnapshot };
