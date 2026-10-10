/**
 * Projects the engine's AgentEvents onto the Code v2 seam's TurnItems (SPEC
 * §3.2) — the one normalized item schema every surface renders, whatever the
 * engine or provider. Stateful only to pair a streaming item with its deltas
 * and a tool call's start with its finish; feed it every event in order.
 */

import type { AgentEvent, SubagentSnapshot } from '../types.js';
import type {
  ApprovalDecision as ContractDecision,
  ComputerActionKind,
  ItemStatus,
  SubagentStatus as ContractSubagentStatus,
  TurnItem,
} from '../contracts/code-v2.js';
import { contractRoleOf } from './routing.js';

export type TurnItemOp =
  | { op: 'added'; item: TurnItem }
  | { op: 'updated'; item: TurnItem }
  | { op: 'delta'; itemId: string; field: 'text' | 'output'; append: string };

const COMPUTER_ACTIONS: Record<string, ComputerActionKind> = {
  computer_screenshot: 'screenshot',
  computer_click: 'click',
  computer_double_click: 'double_click',
  computer_right_click: 'right_click',
  computer_move: 'move',
  computer_drag: 'drag',
  computer_scroll: 'scroll',
  computer_type: 'type',
  computer_key: 'key',
  computer_wait: 'wait',
  computer_open_app: 'open_app',
  computer_zoom: 'zoom',
};

const ORCHESTRATION = new Set([
  'delegate_tasks',
  'await_subagents',
  'inspect_subagent',
  'cancel_subagent',
  'spawn_agent',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'workflow',
  'best_of_n',
]);

function subagentStatus(status: string): ContractSubagentStatus {
  switch (status) {
    case 'waiting_approval':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

function decisionOf(decision: 'allow' | 'allow_always' | 'deny'): ContractDecision {
  if (decision === 'allow') return 'accept';
  if (decision === 'allow_always') return 'acceptForSession';
  return 'decline';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class TurnItemProjector {
  private turnId: string | undefined;
  private assistant: { id: string; text: string } | null = null;
  private reasoning: { id: string; text: string } | null = null;
  private readonly tools = new Map<string, TurnItem>();
  private readonly approvals = new Map<string, TurnItem & { kind: 'approval_request' }>();
  private readonly subagents = new Map<string, TurnItem & { kind: 'subagent' }>();
  private counter = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private base(id: string) {
    return { id, ...(this.turnId ? { turnId: this.turnId } : {}), createdAt: this.now() };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.turnId ?? 't'}-${this.counter}`;
  }

  project(event: AgentEvent): TurnItemOp[] {
    switch (event.type) {
      case 'turn_started':
        this.turnId = `turn-${event.turnIndex}`;
        this.assistant = null;
        this.reasoning = null;
        return [];
      case 'user_input':
        return [{ op: 'added', item: { ...this.base(`user-${event.id}`), kind: 'user_message', text: event.text, delivery: event.delivery } }];
      case 'assistant_delta': {
        if (!this.assistant) {
          this.assistant = { id: this.nextId('assistant'), text: event.text };
          return [{ op: 'added', item: { ...this.base(this.assistant.id), kind: 'assistant_message', text: event.text, streaming: true } }];
        }
        this.assistant.text += event.text;
        return [{ op: 'delta', itemId: this.assistant.id, field: 'text', append: event.text }];
      }
      case 'assistant_message': {
        const id = this.assistant?.id ?? this.nextId('assistant');
        const op = this.assistant ? 'updated' : 'added';
        this.assistant = null;
        return [{ op, item: { ...this.base(id), kind: 'assistant_message', text: event.text, streaming: false } }];
      }
      case 'thinking_delta': {
        if (!this.reasoning) {
          this.reasoning = { id: this.nextId('reasoning'), text: event.text };
          return [{ op: 'added', item: { ...this.base(this.reasoning.id), kind: 'reasoning', text: event.text, streaming: true } }];
        }
        this.reasoning.text += event.text;
        return [{ op: 'delta', itemId: this.reasoning.id, field: 'text', append: event.text }];
      }
      case 'thinking_message': {
        const id = this.reasoning?.id ?? this.nextId('reasoning');
        const op = this.reasoning ? 'updated' : 'added';
        this.reasoning = null;
        return [{ op, item: { ...this.base(id), kind: 'reasoning', text: event.text, streaming: false } }];
      }
      case 'tool_started':
        return this.toolStarted(event.callId, event.name, event.input);
      case 'tool_finished': {
        const item = this.tools.get(event.callId);
        if (!item) return [];
        const status: ItemStatus = event.isError ? 'failed' : 'completed';
        let next: TurnItem;
        switch (item.kind) {
          case 'command_execution':
            next = {
              ...item,
              output: event.output,
              ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
              durationMs: event.durationMs,
              ...(event.backgroundJobId ? { background: true } : {}),
              status: event.backgroundJobId ? 'running' : status,
            };
            break;
          case 'file_change':
          case 'search':
          case 'web_search':
          case 'computer_action':
            next = { ...item, status } as TurnItem;
            break;
          default:
            next = item;
        }
        this.tools.set(event.callId, next);
        return [{ op: 'updated', item: next }];
      }
      case 'tool_denied': {
        const item = this.tools.get(event.callId);
        if (item && 'status' in item) {
          const next = { ...item, status: 'declined' } as TurnItem;
          this.tools.set(event.callId, next);
          return [{ op: 'updated', item: next }];
        }
        return [];
      }
      case 'approval_requested': {
        const request = event.request;
        const action =
          request.toolName === 'bash' ? 'command' : request.toolName.startsWith('computer_') ? 'computer' : request.risk === 'edit' ? 'file_change' : 'tool';
        const item: TurnItem & { kind: 'approval_request' } = {
          ...this.base(`approval-${request.callId}`),
          kind: 'approval_request',
          callId: request.callId,
          requestId: request.callId,
          action,
          summary: request.agentLabel ? `${request.agentLabel}: ${request.summary}` : request.summary,
          ...(request.justification ? { justification: request.justification } : {}),
          options: request.risk === 'sensitive' ? ['accept', 'decline', 'cancel'] : ['accept', 'acceptForSession', 'decline', 'cancel'],
          status: 'pending',
        };
        this.approvals.set(request.callId, item);
        return [{ op: 'added', item }];
      }
      case 'approval_resolved': {
        const item = this.approvals.get(event.callId);
        if (!item) return [];
        const next = { ...item, decision: decisionOf(event.decision), status: 'resolved' as const };
        this.approvals.set(event.callId, next);
        return [{ op: 'updated', item: next }];
      }
      case 'auto_review':
        return [
          {
            op: 'added',
            item: {
              ...this.base(`review-${event.callId}`),
              kind: 'approval_request',
              callId: event.callId,
              requestId: event.callId,
              action: event.toolName === 'bash' ? 'command' : 'tool',
              summary: `Reviewed automatically: ${event.toolName} — ${event.risk} risk, ${event.decision === 'allow' ? 'allowed' : 'denied'}`,
              ...(event.reason || event.failure ? { detail: event.failure ?? event.reason } : {}),
              decision: event.decision === 'allow' ? 'accept' : 'decline',
              status: 'resolved',
            },
          },
        ];
      case 'context_compacted':
        return [
          {
            op: 'added',
            item: {
              ...this.base(this.nextId('compaction')),
              kind: 'compaction',
              beforeTokens: event.tokensBefore,
              afterTokens: event.tokensAfter,
              strategy: event.strategy ?? 'summarize',
            },
          },
        ];
      case 'subagent_update':
        return [this.subagent(event.agent)];
      case 'workflow_update': {
        const progress = event.progress;
        if (progress?.type === 'phase') {
          return [{ op: 'added', item: { ...this.base(this.nextId('notice')), kind: 'system_notice', level: 'info', text: `${event.name} · ${progress.title}`, code: 'workflow_phase' } }];
        }
        if (event.status === 'budget') {
          return [
            {
              op: 'added',
              item: {
                ...this.base(this.nextId('interrupt')),
                kind: 'interrupt',
                reason: 'budget',
                message: event.budget?.reason ? `Workflow ${event.name} stopped: ${event.budget.reason}.` : `Workflow ${event.name} reached its budget.`,
              },
            },
          ];
        }
        return [];
      }
      case 'best_of_n': {
        const run = event.run;
        const recommended = run.review?.recommended;
        return [
          {
            op: 'added',
            item: {
              ...this.base(`bon-${run.id}-${run.status}`),
              kind: 'system_notice',
              level: 'info',
              code: 'best_of_n',
              text:
                run.status === 'awaiting_pick'
                  ? `${run.candidates.length} candidates ready to compare${recommended ? `; the reviewer recommends ${recommended}` : ''}.`
                  : run.status === 'applied'
                    ? `Applied candidate ${run.pickedAgentId}.`
                    : `Best-of-N ${run.status}.`,
            },
          },
        ];
      }
      case 'guard':
        return [{ op: 'added', item: { ...this.base(this.nextId('notice')), kind: 'system_notice', level: 'warning', text: event.message, code: `guard_${event.guard}` } }];
      case 'error':
        return [{ op: 'added', item: { ...this.base(this.nextId('error')), kind: 'error', message: event.message, ...(event.code ? { code: event.code } : {}) } }];
      case 'turn_finished': {
        const out: TurnItemOp[] = [];
        if (this.assistant) {
          out.push({ op: 'updated', item: { ...this.base(this.assistant.id), kind: 'assistant_message', text: this.assistant.text, streaming: false } });
          this.assistant = null;
        }
        if (event.stopReason === 'aborted') {
          out.push({ op: 'added', item: { ...this.base(this.nextId('interrupt')), kind: 'interrupt', reason: 'user' } });
        } else if (event.stopReason === 'budget') {
          out.push({ op: 'added', item: { ...this.base(this.nextId('interrupt')), kind: 'interrupt', reason: 'budget' } });
        } else if (event.stopReason === 'quota') {
          out.push({ op: 'added', item: { ...this.base(this.nextId('interrupt')), kind: 'interrupt', reason: 'limit' } });
        }
        return out;
      }
      default:
        return [];
    }
  }

  private toolStarted(callId: string, name: string, rawInput: unknown): TurnItemOp[] {
    if (ORCHESTRATION.has(name)) return [];
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
    const id = `tool-${callId}`;
    let item: TurnItem | null = null;
    if (name === 'bash') {
      item = { ...this.base(id), kind: 'command_execution', callId, command: str(input.command), status: 'running' };
    } else if (name === 'edit_file' || name === 'write_file') {
      item = {
        ...this.base(id),
        kind: 'file_change',
        callId,
        changes: [{ path: str(input.path), change: name === 'write_file' ? 'add' : 'modify' }],
        status: 'running',
      };
    } else if (name === 'grep' || name === 'glob' || name === 'read_file') {
      item = {
        ...this.base(id),
        kind: 'search',
        callId,
        query: str(input.pattern) || str(input.path),
        scope: name === 'grep' ? 'content' : 'files',
        status: 'running',
      };
    } else if (name === 'web_search') {
      item = { ...this.base(id), kind: 'web_search', callId, query: str(input.query), status: 'running' };
    } else if (name in COMPUTER_ACTIONS) {
      item = {
        ...this.base(id),
        kind: 'computer_action',
        callId,
        action: COMPUTER_ACTIONS[name]!,
        ...(str(input.text) || str(input.app) ? { target: str(input.text) || str(input.app) } : {}),
        status: 'running',
      };
    } else if (name === 'bash_output' || name === 'kill_job') {
      item = { ...this.base(id), kind: 'command_execution', callId, command: `${name} ${str(input.id)}`.trim(), background: true, status: 'running' };
    }
    if (!item) return [];
    this.tools.set(callId, item);
    return [{ op: 'added', item }];
  }

  private subagent(agent: SubagentSnapshot): TurnItemOp {
    const existing = this.subagents.get(agent.id);
    const terminal = agent.status === 'completed' || agent.status === 'failed' || agent.status === 'interrupted' || agent.status === 'cancelled';
    const item: TurnItem & { kind: 'subagent' } = {
      ...(existing ? { id: existing.id, createdAt: existing.createdAt, ...(existing.turnId ? { turnId: existing.turnId } : {}) } : this.base(`agent-${agent.id}`)),
      kind: 'subagent',
      agentId: agent.id,
      role: contractRoleOf(agent.contractRole ?? agent.role),
      model: agent.selection ?? { instanceId: 'alevr', model: agent.model },
      status: subagentStatus(agent.status),
      ...(agent.task ? { task: agent.task } : { task: agent.title }),
      ...(agent.phase ? { phase: agent.phase, title: agent.title } : {}),
      ...(agent.label ? { label: agent.label } : {}),
      ...(terminal && (agent.summary || agent.error) ? { closingText: agent.summary ?? agent.error } : {}),
      tokens: { input: agent.usage.inputTokens, output: agent.usage.outputTokens, ...(agent.usage.cacheReadTokens ? { cachedInput: agent.usage.cacheReadTokens } : {}) },
    };
    this.subagents.set(agent.id, item);
    return { op: existing ? 'updated' : 'added', item };
  }
}
