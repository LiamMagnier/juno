import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bashTool, MINIMAL_ENV } from './tools/bash.js';
import type { ToolContext, ToolResult } from './tools/types.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from './types.js';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';
export interface ProjectHook { command: string; matcher?: string[]; timeoutMs?: number }
export interface ProjectHookConfig { version: 1; hooks: Partial<Record<HookEvent, ProjectHook[]>> }
export interface HookSnapshot { config: ProjectHookConfig; hash: string; file: string }
const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop'];

/** Strict config: misspelled events and malformed rules never silently run. */
export function parseProjectHooks(raw: string): ProjectHookConfig {
  const input = JSON.parse(raw);
  if (!input || input.version !== 1 || Object.keys(input).some((k) => k !== 'version' && k !== 'hooks') || !input.hooks || typeof input.hooks !== 'object' || Array.isArray(input.hooks)) throw new Error('Invalid hooks configuration');
  for (const [event, entries] of Object.entries(input.hooks)) {
    if (!EVENTS.includes(event as HookEvent) || !Array.isArray(entries) || entries.length > 12) throw new Error('Invalid hook event');
    for (const hook of entries) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook) || Object.keys(hook).some((k) => !['command', 'matcher', 'timeoutMs'].includes(k)) || typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > 4096) throw new Error('Invalid hook command');
      if (hook.matcher !== undefined && (!Array.isArray(hook.matcher) || hook.matcher.length > 32 || hook.matcher.some((s: unknown) => typeof s !== 'string' || !/^[a-zA-Z0-9_*:-]{1,128}$/.test(s)))) throw new Error('Invalid hook matcher');
      if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 100 || hook.timeoutMs > 60_000)) throw new Error('Invalid hook timeout');
    }
  }
  return input;
}

export function readProjectHooks(cwd: string): HookSnapshot | null {
  const root = fs.realpathSync(cwd);
  const dir = path.join(root, '.alevr');
  const file = path.join(dir, 'hooks.json');
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Hooks directory must stay inside the project');
    // Never create or truncate configuration. Nonblocking open also prevents
    // a repository-provided FIFO from hanging before descriptor validation.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    let raw: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 32_768) throw new Error('Hooks must be a regular file up to 32 KB');
      // Bound the read as well as stat: a concurrent append cannot grow it.
      raw = Buffer.alloc(32_769);
      raw = raw.subarray(0, fs.readSync(fd, raw, 0, raw.length, 0));
    } finally { fs.closeSync(fd); }
    if (raw.byteLength > 32_768 || !fs.realpathSync(file).startsWith(`${root}${path.sep}`)) throw new Error('Invalid hooks file');
    return { config: parseProjectHooks(raw.toString('utf8')), hash: createHash('sha256').update(raw).digest('hex'), file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Hooks must be a regular file up to 32 KB');
    throw err;
  }
}

export interface ProjectHookHost {
  emit(event: AgentEvent): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Apply the normal shell permission rules before trust can allow anything. */
  permission(command: string, ctx: ToolContext): 'allow' | 'ask' | 'deny';
  /** Host-supplied, account/repository-scoped hashes, never read from a clone. */
  trustedHashes?: readonly string[];
}

/** Trust only exact config bytes, held outside the repository. This is not a
 * shell permission grant. A deny/ask rule, Plan, and sensitive-action floor
 * still win over an already reviewed configuration. */
export class ProjectHooks {
  private readonly trusted: Set<string>;
  constructor(private readonly host: ProjectHookHost) { this.trusted = new Set(host.trustedHashes ?? []); }

  async run(event: HookEvent, ctx: ToolContext, context: { tool?: string; input?: Record<string, unknown>; result?: ToolResult } = {}): Promise<{ ok: boolean; reason?: string }> {
    if (ctx.signal?.aborted) return { ok: false, reason: 'Hook cancelled' };
    let snapshot: HookSnapshot | null;
    try { snapshot = readProjectHooks(ctx.cwd); }
    catch { return { ok: false, reason: 'The project hooks file is invalid. Fix .alevr/hooks.json before continuing.' }; }
    if (!snapshot) return { ok: true };
    const hooks = (snapshot.config.hooks[event] ?? []).filter((h) => !h.matcher?.length || h.matcher.some((m) => m === '*' || m === context.tool));
    for (const hook of hooks) {
      const permission = this.host.permission(hook.command, ctx);
      if (permission === 'deny') return { ok: false, reason: `${event} hook is blocked by the shell permission rules.` };
      const callId = `hook-${randomUUID()}`;
      const name = `hook:${event}`;
      const input = { command: hook.command, configHash: snapshot.hash, path: snapshot.file, event };
      if (!this.trusted.has(snapshot.hash) || permission === 'ask') {
        // Never send trust review through the model auto-reviewer. The host
        // must present the exact command/hash even in Full access.
        const request: ApprovalRequest = { callId, toolName: name, input, risk: 'sensitive', requiresHuman: true, summary: `Run ${event} hook: ${hook.command}\nConfig SHA-256: ${snapshot.hash}`, ...(ctx.agentId ? { agentId: ctx.agentId } : {}) };
        this.host.emit({ type: 'approval_requested', request });
        const decision = await this.host.requestApproval(request).catch((): ApprovalDecision => 'deny');
        this.host.emit({ type: 'approval_resolved', callId, decision, ...(ctx.agentId ? { agentId: ctx.agentId } : {}) });
        if (decision === 'deny') return { ok: false, reason: `${event} hook was not approved.` };
        if (decision === 'allow_always') this.trusted.add(snapshot.hash);
      }
      // A file changed while its review was open: no command from either
      // version runs under the other version's approval.
      try { if (readProjectHooks(ctx.cwd)?.hash !== snapshot.hash) return { ok: false, reason: 'Project hooks changed during review. Review them again.' }; }
      catch { return { ok: false, reason: 'Project hooks changed during review. Review them again.' }; }
      if (ctx.signal?.aborted) return { ok: false, reason: 'Hook cancelled' };
      this.host.emit({ type: 'tool_started', callId, name, input, risk: 'sensitive', ...(ctx.agentId ? { agentId: ctx.agentId } : {}) });
      const started = Date.now();
      const inputJson = JSON.stringify(context.input ?? {});
      const contextJson = JSON.stringify({ event, tool: context.tool, callId: ctx.callId, agentId: ctx.agentId, input: inputJson.length <= 16_000 ? context.input ?? {} : { truncated: true, preview: inputJson.slice(0, 16_000) }, result: context.result ? { isError: context.result.isError === true, exitCode: context.result.exitCode, output: context.result.output.slice(0, 8_000) } : undefined });
      const result = await bashTool.execute({ command: hook.command, timeout_ms: hook.timeoutMs ?? 10_000 }, {
        ...ctx,
        env: { ...(ctx.env ?? MINIMAL_ENV), ALEVR_HOOK_CONTEXT: contextJson },
        ...(ctx.containerSandbox ? { containerSandbox: { ...ctx.containerSandbox, forwardEnv: [...(ctx.containerSandbox.forwardEnv ?? []), 'ALEVR_HOOK_CONTEXT'] } } : {}),
      });
      this.host.emit({ type: 'tool_finished', callId, name, output: result.output.slice(0, 2_000), isError: result.isError === true, durationMs: Date.now() - started, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), ...(ctx.agentId ? { agentId: ctx.agentId } : {}) });
      if (result.isError) return { ok: false, reason: `${event} hook failed. See its command output.` };
    }
    return { ok: true };
  }

  /** The owning dispatcher executes the tool only after its permission gate.
   * Hooks decorate results, never add a second tool-execution chokepoint. */
  async finishTool(tool: string, input: Record<string, unknown>, result: ToolResult, ctx: ToolContext): Promise<ToolResult> {
    const after = await this.run('PostToolUse', ctx, { tool, input, result });
    return after.ok ? result : { ...result, isError: true, output: `${result.output}\n\n${after.reason}` };
  }
}
