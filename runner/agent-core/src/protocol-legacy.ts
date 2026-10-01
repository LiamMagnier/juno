/**
 * Protocol events, spoken in the legacy Code task vocabulary.
 *
 * Every Juno reader shipped before the canonical protocol — an iPhone, a Mac
 * that shows task transcripts, a web tab that has not reloaded — reads a Code
 * task as `CodeTaskEvent` kinds (`user`, `text`, `tool`, `file_change`, …).
 * A producer that speaks the protocol still has to be read by them, so it posts
 * these rows beside its protocol rows, derived from them here rather than built
 * a second time by hand. Each row is what the cloud runner wrote before the
 * protocol, so an old reader sees the run it always saw — minus the ` — ok` /
 * ` — failed` suffix, which it already reads from `exitCode`.
 *
 * With `markDerived`, every row names the protocol event it came from
 * (`protocolEventId`), which is how a protocol reader knows to skip it.
 */
import type { AgentEvent, AgentRisk } from './protocol.generated.js';

export interface LegacyTaskRow {
  kind: string;
  payload: Record<string, unknown>;
}

export interface LegacyTaskDowncastOptions {
  /**
   * Set when the host answers approvals by its permission mode, with nobody
   * asked (the cloud runner). A request is then never shown as pending: the
   * answer's row says what happened, which is the one honest row.
   */
  approvalsAnsweredByMode?: boolean;
  /** Name the protocol event each row came from, for protocol readers to skip. */
  markDerived?: boolean;
}

/** The payload key a derived row names its protocol event under. */
export const DERIVED_FROM_PROTOCOL_KEY = 'protocolEventId';

export class LegacyTaskDowncast {
  private readonly calls = new Map<string, { name: string; title: string }>();
  private readonly approvals = new Map<string, { summary: string; risk: AgentRisk; toolItemId?: string }>();
  /** Calls whose refusal the mode's answer row already reported. */
  private readonly answeredByMode = new Set<string>();
  /** Replies and thinking blocks that streamed, so their final text is not sent twice. */
  private readonly streamed = new Set<string>();
  private pullRequest: { branch: string; prUrl?: string; prNumber?: number } | undefined;

  constructor(private readonly options: LegacyTaskDowncastOptions = {}) {}

  rows(event: AgentEvent): LegacyTaskRow[] {
    const rows = this.project(event);
    if (!this.options.markDerived) return rows;
    return rows.map((row) => ({ kind: row.kind, payload: { ...row.payload, [DERIVED_FROM_PROTOCOL_KEY]: event.id } }));
  }

  private project(event: AgentEvent): LegacyTaskRow[] {
    const agent = event.agentId ? { agentId: event.agentId } : {};
    switch (event.type) {
      case 'item.user_message': {
        if (event.delivery === 'steer' && event.commandId) {
          // The echo and the acknowledgement, together: the host has the words.
          return [
            { kind: 'user', payload: { text: event.text, requestId: event.commandId, steer: true } },
            { kind: 'steer_ack', payload: { requestId: event.commandId } },
          ];
        }
        return [{ kind: 'user', payload: { text: event.text } }];
      }
      case 'item.assistant_text.delta':
        this.streamed.add(event.itemId);
        return [{ kind: 'text', payload: { text: event.text } }];
      case 'item.assistant_text':
        return this.streamed.has(event.itemId) ? [] : [{ kind: 'text', payload: { text: event.text } }];
      case 'item.thinking.delta':
        this.streamed.add(event.itemId);
        return [{ kind: 'reasoning_delta', payload: { text: event.text } }];
      case 'item.thinking':
        return this.streamed.has(event.itemId) ? [] : [{ kind: 'reasoning', payload: { text: event.summary } }];
      case 'item.tool_call':
        this.calls.set(event.itemId, { name: event.toolName, title: event.title });
        return [];
      case 'item.tool_result': {
        const call = this.calls.get(event.itemId) ?? { name: 'tool', title: 'tool' };
        if (event.status === 'denied') {
          if (this.answeredByMode.has(event.itemId)) return [];
          return [{ kind: 'tool', payload: { name: call.name, summary: `Denied ${call.name}: ${event.summary ?? ''}`.trim(), ...agent } }];
        }
        return [
          {
            kind: 'tool',
            payload: {
              name: call.name,
              summary: call.title,
              ...(event.output ? { detail: event.output } : {}),
              ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
              ...(event.status === 'error' && typeof event.exitCode !== 'number' ? { failed: true } : {}),
              ...agent,
            },
          },
        ];
      }
      case 'item.file_change':
        return [
          {
            kind: 'file_change',
            payload: {
              path: event.path,
              changeKind: event.change === 'created' ? 'create' : event.change === 'deleted' ? 'delete' : 'edit',
              added: event.linesAdded,
              removed: event.linesRemoved,
              ...(event.patch ? { diff: event.patch } : {}),
            },
          },
        ];
      case 'item.test_run':
        return [
          {
            kind: 'tool',
            payload: { name: 'Tests', summary: event.passed ? 'Tests passed' : 'Tests failed', detail: event.command },
          },
        ];
      case 'item.notice':
        // The host's own lines were always part of the reply's text; the
        // hooks' and the runtime's are quiet status lines.
        return event.source === 'host'
          ? [{ kind: 'text', payload: { text: `${event.text}\n` } }]
          : [{ kind: 'status', payload: { status: event.text, ...(event.detail ? { detail: event.detail } : {}) } }];
      case 'item.compaction':
        return [{ kind: 'status', payload: { status: 'Context compacted' } }];
      case 'approval.requested':
        this.approvals.set(event.approvalId, { summary: event.summary, risk: event.risk, toolItemId: event.itemId });
        if (this.options.approvalsAnsweredByMode) return [];
        return [
          {
            kind: 'approval_request',
            payload: { requestId: event.approvalId, summary: event.summary, risk: event.risk, detail: event.action },
          },
        ];
      case 'approval.resolved': {
        const allowed = event.decision === 'allow_once' || event.decision === 'allow_always';
        if (event.by === 'mode') {
          const request = this.approvals.get(event.approvalId);
          if (request?.toolItemId && !allowed) this.answeredByMode.add(request.toolItemId);
          const summary = request?.summary ?? '';
          return [
            {
              kind: 'tool',
              payload: {
                name: 'approval',
                summary: allowed
                  ? `Auto-allowed in sandbox: ${summary}`
                  : event.feedback
                    ? `Denied — ${event.feedback}: ${summary}`
                    : `Denied: ${summary}`,
                risk: legacyRisk(request?.risk),
                ...(allowed ? { autoAllowed: true } : {}),
                ...agent,
              },
            },
          ];
        }
        return [{ kind: 'approval_response', payload: { requestId: event.approvalId, approve: allowed } }];
      }
      case 'session.error':
        return [{ kind: 'error', payload: { message: event.error.message } }];
      case 'code.pull_request':
        this.pullRequest = {
          branch: event.branch,
          ...(event.prUrl ? { prUrl: event.prUrl } : {}),
          ...(event.prNumber !== undefined ? { prNumber: event.prNumber } : {}),
        };
        return [];
      case 'session.state':
        // The task's status rides the events POST itself; only the finish is a row.
        if (event.state !== 'completed') return [];
        return [{ kind: 'done', payload: { finishReason: event.reason ?? 'end_turn', ...(this.pullRequest ?? {}) } }];
      // No legacy reader has a word for these, and none needs one: a turn's
      // edges, usage, plans, questions and sub-agent snapshots (the host posts
      // the engine's full snapshot as an `agent` row itself).
      case 'session.created':
      case 'session.configured':
      case 'turn.started':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
      case 'transcript.restarted':
      case 'item.tool_output':
      case 'item.subagent':
      case 'question.asked':
      case 'question.answered':
      case 'plan.updated':
      case 'plan.proposed':
      case 'plan.resolved':
      case 'usage.updated':
        return [];
      // The autonomous loop (protocol v1.1): agent-core does not produce
      // these yet (Phase 11, D-014), and the legacy task wire has no word for
      // them; a reader that wants them reads the protocol rows.
      case 'run.continued':
      case 'run.outcome':
      case 'verify.result':
      case 'verify.ui':
      case 'review.findings':
      case 'goal.set':
      case 'goal.updated':
      case 'goal.verdict':
      case 'goal.status':
      case 'checkin.due':
      case 'ci.status':
      case 'budget.reached':
        return [];
    }
  }
}

/** The task wire's three risk words, as the cloud runner has always written them. */
function legacyRisk(risk: AgentRisk | undefined): string {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'execute' || risk === 'critical') return 'outside';
  return 'neutral';
}
