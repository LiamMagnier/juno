/**
 * Capability manifest.
 *
 * The point of this module is to stop Juno guessing. A capability matrix keyed
 * by vendor name goes stale the week after it is written: agents gain session
 * resume, drop a mode, add MCP transports, and a hardcoded table quietly starts
 * lying. ACP negotiates a real subset of this in `initialize`, so wherever the
 * protocol reports something, that report wins.
 *
 * The interesting part is the honesty of the *unreported* cases, which is why
 * every capability carries a `source` rather than being a bare boolean:
 *
 *   - `protocol`    — guaranteed by ACP v1 itself. `session/update` streaming
 *                     and `tool_call` updates are not optional features; an
 *                     agent that omits them is not speaking ACP.
 *   - `negotiated`  — read out of the `initialize` handshake. Authoritative.
 *   - `observed`    — ACP has the concept but does not advertise it, so it can
 *                     only be learned from live traffic. Starts false and is
 *                     upgraded when evidence arrives. A false `observed` means
 *                     "not seen yet", NOT "not supported" — the UI must not
 *                     render it as an absence.
 *   - `host`        — not a protocol concept at all; Juno provides it around
 *                     the agent. Worktrees are the clean example: ACP has no
 *                     notion of one, but `session/new` takes a `cwd`, so Juno
 *                     creates the worktree and hands over its path. The agent
 *                     never knows.
 *   - `unavailable` — neither expressible in ACP nor provided by Juno. Real
 *                     absence, safe to grey out.
 *
 * `observed` and `unavailable` both render as "off" today, and conflating them
 * is exactly how a UI ends up telling a user their agent cannot reason when it
 * simply has not thought out loud yet.
 */

import type { AgentCapabilities, InitializeResponse, SessionUpdate } from './acp/schema.js';

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

export type CapabilitySource = 'protocol' | 'negotiated' | 'observed' | 'host' | 'unavailable';

export interface Capability {
  readonly supported: boolean;
  readonly source: CapabilitySource;
  /** Why, in one line. Shown in the capability inspector; always safe to display. */
  readonly detail: string;
}

/**
 * The twelve capabilities Juno's UI gates on, plus the ACP-specific ones the
 * handshake actually reports. Splitting them keeps the product-level surface
 * stable while the protocol-level surface tracks the spec.
 */
export interface CapabilityManifest {
  /* Product-level — every provider answers these, whatever its transport. */
  readonly streaming: Capability;
  readonly reasoning: Capability;
  readonly tools: Capability;
  readonly subagents: Capability;
  readonly agentTeams: Capability;
  readonly worktrees: Capability;
  readonly computerUse: Capability;
  readonly backgroundExecution: Capability;
  readonly sessionResume: Capability;
  readonly skills: Capability;
  readonly mcp: Capability;
  readonly usage: Capability;

  /* Protocol-level — meaningful only for ACP providers, negotiated verbatim. */
  readonly acp: {
    readonly loadSession: Capability;
    readonly sessionList: Capability;
    readonly sessionFork: Capability;
    readonly sessionClose: Capability;
    readonly sessionDelete: Capability;
    readonly additionalDirectories: Capability;
    readonly promptImage: Capability;
    readonly promptAudio: Capability;
    readonly promptEmbeddedContext: Capability;
    readonly mcpHttp: Capability;
    readonly mcpSse: Capability;
    readonly modes: Capability;
    readonly plans: Capability;
    readonly logout: Capability;
  };

  /** Free-text agent identity from `initialize`, when the agent supplied one. */
  readonly agentInfo?: { readonly name: string; readonly version: string };
  /** Negotiated protocol version the agent answered with. */
  readonly protocolVersion?: number;
}

/* -------------------------------------------------------------------------- */
/* Constructors                                                                */
/* -------------------------------------------------------------------------- */

const cap = (supported: boolean, source: CapabilitySource, detail: string): Capability => ({
  supported,
  source,
  detail,
});

/** ACP marks optional features by presence of an object, not by `true`. */
const present = (value: unknown): boolean => value !== undefined && value !== null;

/* -------------------------------------------------------------------------- */
/* What Juno itself brings                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Host-side facilities. These are *Juno's* answer, not the agent's, and they
 * are the same for every ACP provider because they sit outside the protocol.
 */
export interface HostCapabilities {
  /** Juno creates a git worktree and passes its path as the session `cwd`. */
  readonly worktrees: boolean;
  /**
   * Juno advertises `clientCapabilities.terminal`, letting the agent start
   * long-running commands through `terminal/create` and poll them rather than
   * blocking a turn.
   */
  readonly terminal: boolean;
  /** Juno answers `fs/read_text_file` / `fs/write_text_file`. */
  readonly fs: boolean;
}

export const DEFAULT_HOST_CAPABILITIES: HostCapabilities = {
  worktrees: true,
  terminal: true,
  fs: true,
};

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the manifest from a real `initialize` response.
 *
 * Nothing here is keyed on the agent's name. Two agents that answer the
 * handshake identically get identical manifests, which is the whole point.
 */
export function deriveAcpCapabilities(
  response: InitializeResponse,
  host: HostCapabilities = DEFAULT_HOST_CAPABILITIES,
): CapabilityManifest {
  const agent: AgentCapabilities = response.agentCapabilities ?? {};
  const session = agent.sessionCapabilities ?? {};
  const prompt = agent.promptCapabilities ?? {};
  const mcp = agent.mcpCapabilities ?? {};

  const loadSession = agent.loadSession === true;
  const resume = present(session.resume);

  const manifest: CapabilityManifest = {
    streaming: cap(
      true,
      'protocol',
      'ACP delivers all assistant output as session/update notifications; streaming is the only mode.',
    ),
    reasoning: cap(
      false,
      'observed',
      'ACP carries reasoning as agent_thought_chunk but does not advertise it. Confirmed on first thought chunk.',
    ),
    tools: cap(
      true,
      'protocol',
      'tool_call and tool_call_update are unconditional parts of the session/update union.',
    ),
    subagents: cap(
      false,
      'unavailable',
      'ACP v1 has no subagent concept. Nested agents, if any, are invisible behind the agent process.',
    ),
    agentTeams: cap(
      false,
      'unavailable',
      'No protocol concept. Juno agent teams apply to the first-party provider only.',
    ),
    worktrees: cap(
      host.worktrees,
      'host',
      'Not an ACP concept. Juno creates the worktree and passes its path as the session/new cwd.',
    ),
    computerUse: cap(
      false,
      'unavailable',
      'No ACP concept, and Juno does not provide a screen/input channel to third-party agents.',
    ),
    backgroundExecution: cap(
      host.terminal,
      'host',
      host.terminal
        ? 'Juno advertises clientCapabilities.terminal, so the agent may run commands via terminal/create and poll them.'
        : 'Juno did not advertise terminal support, so the agent must run commands inside a turn.',
    ),
    sessionResume: cap(
      loadSession || resume,
      'negotiated',
      describeResume(loadSession, resume),
    ),
    skills: cap(
      false,
      'observed',
      'ACP reports slash commands via available_commands_update, only after a session exists.',
    ),
    mcp: cap(
      true,
      'protocol',
      `session/new always accepts stdio MCP servers${describeMcpTransports(mcp)}.`,
    ),
    usage: cap(
      false,
      'observed',
      'PromptResponse.usage is optional. Confirmed once an agent returns token counts.',
    ),

    acp: {
      loadSession: cap(loadSession, 'negotiated', 'agentCapabilities.loadSession'),
      sessionList: cap(present(session.list), 'negotiated', 'sessionCapabilities.list'),
      sessionFork: cap(present(session.fork), 'negotiated', 'sessionCapabilities.fork'),
      sessionClose: cap(present(session.close), 'negotiated', 'sessionCapabilities.close'),
      sessionDelete: cap(present(session.delete), 'negotiated', 'sessionCapabilities.delete'),
      additionalDirectories: cap(
        present(session.additionalDirectories),
        'negotiated',
        'sessionCapabilities.additionalDirectories',
      ),
      promptImage: cap(prompt.image === true, 'negotiated', 'promptCapabilities.image'),
      promptAudio: cap(prompt.audio === true, 'negotiated', 'promptCapabilities.audio'),
      promptEmbeddedContext: cap(
        prompt.embeddedContext === true,
        'negotiated',
        'promptCapabilities.embeddedContext',
      ),
      mcpHttp: cap(mcp.http === true, 'negotiated', 'mcpCapabilities.http'),
      mcpSse: cap(mcp.sse === true, 'negotiated', 'mcpCapabilities.sse'),
      modes: cap(
        false,
        'observed',
        'Modes are reported in the session/new response, not the handshake.',
      ),
      plans: cap(false, 'observed', 'Plans arrive as plan / plan_update session updates.'),
      logout: cap(present(agent.auth?.logout), 'negotiated', 'agentCapabilities.auth.logout'),
    },
  };

  const info = response.agentInfo;
  if (info) {
    return { ...manifest, agentInfo: { name: info.name, version: info.version }, protocolVersion: response.protocolVersion };
  }
  return { ...manifest, protocolVersion: response.protocolVersion };
}

function describeResume(loadSession: boolean, resume: boolean): string {
  if (loadSession && resume) return 'agentCapabilities.loadSession and sessionCapabilities.resume';
  if (loadSession) return 'agentCapabilities.loadSession (session/load replays the transcript)';
  if (resume) return 'sessionCapabilities.resume';
  return 'Agent advertised neither loadSession nor sessionCapabilities.resume; history is lost on exit.';
}

function describeMcpTransports(mcp: { http?: boolean | undefined; sse?: boolean | undefined }): string {
  const extra: string[] = [];
  if (mcp.http === true) extra.push('http');
  if (mcp.sse === true) extra.push('sse');
  return extra.length > 0 ? `, plus ${extra.join(' and ')}` : ' (stdio only)';
}

/* -------------------------------------------------------------------------- */
/* Post-handshake refinement                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fold what the session announced into the manifest.
 *
 * `session/new` is where modes and config options show up, so a capability
 * inspector built only from `initialize` would under-report every agent that
 * has modes. Called once per session creation.
 */
export function applySessionCapabilities(
  manifest: CapabilityManifest,
  info: { readonly hasModes: boolean; readonly hasConfigOptions: boolean },
): CapabilityManifest {
  if (!info.hasModes && !info.hasConfigOptions) return manifest;
  return {
    ...manifest,
    acp: {
      ...manifest.acp,
      modes: info.hasModes
        ? cap(true, 'negotiated', 'session/new returned a SessionModeState.')
        : manifest.acp.modes,
    },
  };
}

/**
 * Upgrade `observed` capabilities from live traffic. Monotonic — a capability
 * is never downgraded, because one quiet turn is not evidence of absence.
 *
 * Returns the same object when nothing changed, so callers can cheaply skip a
 * re-render on the overwhelmingly common case of an ordinary message chunk.
 */
export function applyObservedUpdate(
  manifest: CapabilityManifest,
  update: SessionUpdate,
): CapabilityManifest {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
      if (manifest.reasoning.supported) return manifest;
      return {
        ...manifest,
        reasoning: cap(true, 'observed', 'Agent emitted an agent_thought_chunk.'),
      };
    case 'available_commands_update': {
      const count = update.availableCommands.length;
      if (count === 0 || manifest.skills.supported) return manifest;
      return {
        ...manifest,
        skills: cap(true, 'observed', `Agent published ${count} slash command(s).`),
      };
    }
    case 'plan':
    case 'plan_update':
      if (manifest.acp.plans.supported) return manifest;
      return {
        ...manifest,
        acp: { ...manifest.acp, plans: cap(true, 'observed', 'Agent emitted a plan update.') },
      };
    default:
      return manifest;
  }
}

/** Called when a turn returns token counts, which is the only proof `usage` works. */
export function applyObservedUsage(manifest: CapabilityManifest): CapabilityManifest {
  if (manifest.usage.supported) return manifest;
  return {
    ...manifest,
    usage: cap(true, 'observed', 'Agent returned token counts on a PromptResponse.'),
  };
}

/* -------------------------------------------------------------------------- */
/* First-party                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Juno backend-proxy provider. Its capabilities are not negotiated because
 * there is no handshake — the agent loop is Juno's own (`runner/agent-core`),
 * so these are `host` facts rather than protocol ones. Stated explicitly here
 * so the two provider families produce the same manifest type and the UI never
 * needs a special case.
 */
export function junoFirstPartyCapabilities(): CapabilityManifest {
  const host = (supported: boolean, detail: string): Capability => cap(supported, 'host', detail);
  const none = (detail: string): Capability => cap(false, 'unavailable', detail);
  return {
    streaming: host(true, 'agent-core streams assistant deltas from the backend proxy.'),
    reasoning: host(true, 'Reasoning effort is a first-class provider option in agent-core.'),
    tools: host(true, "Juno's own tool loop."),
    subagents: host(true, 'agent-core spawns subagents and reports them as subagent_update events.'),
    agentTeams: host(true, 'Agent teams are a first-party feature.'),
    worktrees: host(true, 'Subagents can be isolated in git worktrees.'),
    computerUse: none('Not offered through the backend proxy.'),
    backgroundExecution: host(true, 'Background command execution is built into the tool loop.'),
    sessionResume: host(true, 'Sessions are persisted locally and resumable by id.'),
    skills: host(true, 'Skills and slash commands are loaded from the workspace.'),
    mcp: host(true, 'MCP servers are configured per workspace.'),
    usage: host(true, 'Token usage is reported per turn and attributed to the Juno account.'),
    acp: {
      loadSession: none('Not an ACP provider.'),
      sessionList: host(true, 'Sessions are listed from local storage.'),
      sessionFork: none('Not implemented.'),
      sessionClose: host(true, 'Sessions close with the app.'),
      sessionDelete: host(true, 'Sessions are deletable from local storage.'),
      additionalDirectories: host(true, 'Additional roots are part of the workspace config.'),
      promptImage: host(true, 'Vision input is supported where the model supports it.'),
      promptAudio: none('Not supported.'),
      promptEmbeddedContext: host(true, 'File context is embedded into prompts.'),
      mcpHttp: host(true, 'HTTP MCP servers are supported.'),
      mcpSse: host(true, 'SSE MCP servers are supported.'),
      modes: host(true, 'Permission modes: plan, ask, auto-edit, full.'),
      plans: host(true, 'Plan mode produces a structured plan.'),
      logout: host(true, 'Signing out of the Juno account ends backend access.'),
    },
  };
}
