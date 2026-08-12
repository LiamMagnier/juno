/**
 * The provider catalogue.
 *
 * Two families live here, and the split is architectural rather than cosmetic:
 *
 *   - **Juno first-party** (`juno`) — the backend proxy in
 *     `runner/agent-core/src/providers/proxy.ts`. Model traffic goes through the
 *     Juno backend with server-side keys and the user's Juno session, so usage
 *     lands in the same account as the website. No local CLI, no local
 *     credentials, no child process, and no third-party terms to satisfy. This
 *     is the default and the only provider that works on a machine with nothing
 *     installed.
 *   - **ACP agents** — third-party CLIs the user already installed and already
 *     signed into, spawned as a child process and driven over ACP. Juno adds a
 *     UI; it does not add an account.
 *
 * The per-agent data below is transcribed from the official ACP registry
 * (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
 * registry version 1.0.0), which is the machine-readable source of truth for
 * each agent's ACP entrypoint. The `acpArgs` in particular are NOT guessed:
 * agents distributed as npm packages declare their ACP flag there (`--acp` for
 * Gemini and Copilot, nothing for the Claude and Codex wrappers, which are ACP
 * servers outright), and agents distributed as standalone binaries declare no
 * extra flags at all.
 *
 * Every descriptor carries a `legal` block. It is not decoration: `discovery.ts`
 * refuses to look for a provider whose terms forbid it, and the UI must render
 * `displayName` rather than assembling a vendor name of its own. See
 * docs/PROVIDERS.md for the reasoning and the citations behind each stance.
 */

import type { ProviderDescriptor, ProviderId } from './types.js';

/** Where the launch data came from. Re-check when bumping agent versions. */
export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export const ACP_REGISTRY_VERSION = '1.0.0';

/** Prefix for every ACP-backed provider id, mirroring `backend/` in agent-core. */
export const ACP_PROVIDER_PREFIX = 'acp/';

/** The first-party provider id. Also the default. */
export const JUNO_PROVIDER_ID = 'juno';

/* -------------------------------------------------------------------------- */
/* First-party                                                                 */
/* -------------------------------------------------------------------------- */

const JUNO_FIRST_PARTY: ProviderDescriptor = {
  id: JUNO_PROVIDER_ID,
  displayName: 'Juno',
  vendor: 'Juno',
  transport: 'juno-backend',
  authKind: 'juno-account',
  discovery: [{ kind: 'builtin' }],
  acpArgs: [],
  acpEnv: {},
  envPassthrough: [],
  homepage: 'https://chat.liams.dev',
  summary: "Juno's own agent, running on the Juno backend. Nothing to install.",
  legal: {
    hostedLogin: 'permitted',
    localCli: 'permitted',
    license: 'proprietary (first-party)',
    citations: [],
    note: 'First-party. Model access is proxied through the Juno backend with server-side keys; the user authenticates to Juno, not to a model vendor.',
  },
};

/* -------------------------------------------------------------------------- */
/* ACP agents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Shared posture for every third-party agent Juno drives.
 *
 * Juno never implements a vendor's login, never surfaces a vendor subscription
 * as a Juno feature, and never brokers a vendor credential. It spawns a binary
 * the user installed and signed into, on the user's own machine. That is the
 * distinction the vendors' terms turn on, so it is the distinction the code is
 * built around: `authKind: 'cli-managed'` and `envPassthrough: []` together mean
 * there is no code path by which a vendor credential reaches Juno.
 */
const CLI_MANAGED = {
  transport: 'acp-stdio',
  authKind: 'cli-managed',
  acpEnv: {},
  envPassthrough: [],
} as const;

const ACP_AGENTS: readonly ProviderDescriptor[] = [
  {
    ...CLI_MANAGED,
    id: 'acp/claude-agent',
    /**
     * "Claude Agent", not the product name of Anthropic's own CLI. This is the
     * name the official ACP registry publishes for this entry, and matching it
     * is also the trademark-safe choice for a third-party integration — see
     * docs/PROVIDERS.md.
     */
    displayName: 'Claude Agent',
    vendor: 'Anthropic',
    discovery: [
      { kind: 'npm-global', packageName: '@agentclientprotocol/claude-agent-acp' },
      { kind: 'path-binary', names: ['claude-agent-acp'] },
    ],
    acpArgs: [],
    homepage: 'https://github.com/agentclientprotocol/claude-agent-acp',
    summary: "Anthropic's Claude, driven through your own signed-in local install.",
    legal: {
      hostedLogin: 'prohibited',
      localCli: 'permitted',
      license: 'proprietary (Claude Code CLI); Apache-2.0 (claude-agent-acp wrapper)',
      citations: [
        'https://code.claude.com/docs/en/legal-and-compliance',
        'https://code.claude.com/docs/en/agent-sdk/overview',
        'https://support.claude.com/en/articles/15036540',
        'https://www.anthropic.com/legal/commercial-terms',
        'https://www.anthropic.com/legal/trademark-guidelines',
      ],
      note: 'Anthropic states plainly that it "does not permit third-party developers to offer Claude.ai login", and the Agent SDK adds "unless previously approved" for login or rate limits. Juno therefore never implements Claude auth. Driving the user\'s own signed-in install is separately documented by Anthropic as supported, and its help centre confirms third-party app usage draws on the user\'s own subscription. Naming is constrained too: "Claude Code" and "Claude Code Agent" are not permitted for third-party integrations; "Claude Agent" is.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    discovery: [
      { kind: 'npm-global', packageName: '@agentclientprotocol/codex-acp' },
      { kind: 'path-binary', names: ['codex-acp'] },
    ],
    acpArgs: [],
    homepage: 'https://github.com/agentclientprotocol/codex-acp',
    summary: "OpenAI's coding agent, via the Apache-2.0 ACP adapter.",
    legal: {
      hostedLogin: 'prohibited',
      localCli: 'permitted',
      license: 'Apache-2.0 (Codex CLI and codex-acp adapter)',
      citations: [
        'https://github.com/openai/codex',
        'https://github.com/agentclientprotocol/codex-acp',
        'https://openai.com/policies/business-terms/',
        'https://openai.com/brand/',
      ],
      note: 'OpenAI Business Terms §3 bar reselling account access and buying, selling or transferring API keys — that is scenario (a). Embedding is the documented use of the Codex app-server (JSON-RPC over stdio, "Embed Codex into your product"), so scenario (b) is squarely supported. Brand guidelines bar OpenAI product names in a product name; use them referentially only.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/gemini',
    displayName: 'Gemini CLI',
    vendor: 'Google',
    discovery: [
      { kind: 'path-binary', names: ['gemini'] },
      { kind: 'npm-global', packageName: '@google/gemini-cli', binName: 'gemini' },
    ],
    acpArgs: ['--acp'],
    homepage: 'https://github.com/google-gemini/gemini-cli',
    summary: 'Google\'s Gemini CLI in ACP mode.',
    legal: {
      hostedLogin: 'prohibited',
      localCli: 'permitted',
      license: 'Apache-2.0',
      citations: [
        'https://github.com/google-gemini/gemini-cli',
        'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals',
      ],
      note: 'Google bars "directly accessing the services powering Gemini CLI" with third-party tooling — token-lifting, not spawning Google\'s own binary, which ships first-party ACP for exactly this. IMPORTANT: consumer Google accounts stopped being served on 2026-06-18, so only API-key, Vertex and Standard/Enterprise users can actually run this. The repo README still advertises the dead free tier; the deprecation page is authoritative.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/kimi',
    displayName: 'Kimi CLI',
    vendor: 'Moonshot AI',
    discovery: [{ kind: 'path-binary', names: ['kimi'] }],
    acpArgs: [],
    homepage: 'https://github.com/MoonshotAI/kimi-cli',
    summary: "Moonshot AI's coding assistant. Open source, ACP out of the box.",
    legal: {
      hostedLogin: 'permitted',
      localCli: 'permitted',
      license: 'Apache-2.0 + NOTICE (kimi-cli); MIT (kimi-code successor)',
      citations: [
        'https://github.com/MoonshotAI/kimi-cli',
        'https://github.com/MoonshotAI/kimi-code',
        'https://platform.kimi.ai/docs/agreement/modeluse',
      ],
      note: 'Moonshot\'s model-use agreement affirmatively grants the right to "integrate the Services into your own applications", and the docs list custom ACP client development as a use case with an AUTH_REQUIRED flow that sends the user to run `kimi login` — Juno\'s exact model. kimi-cli is winding down in favour of MIT-licensed kimi-code; retarget when its ACP entrypoint stabilises. Note the ACP registry records this agent as MIT, which matches the successor rather than kimi-cli.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/opencode',
    displayName: 'OpenCode',
    vendor: 'Anomaly',
    discovery: [{ kind: 'path-binary', names: ['opencode'] }],
    acpArgs: [],
    homepage: 'https://opencode.ai',
    summary: 'The open-source coding agent. MIT-licensed, bring your own model.',
    legal: {
      hostedLogin: 'permitted',
      localCli: 'permitted',
      license: 'MIT',
      citations: [
        'https://github.com/anomalyco/opencode',
        'https://opencode.ai/legal/terms-of-service',
        'https://opencode.ai/docs/acp/',
      ],
      note: 'The cleanest of the third parties: the hosted ToS carves out non-hosted software as governed by the MIT licence, and `opencode acp` is a documented stdio JSON-RPC subprocess. WARNING: OpenCode\'s own provider docs say Anthropic "explicitly prohibits" routing Claude Pro/Max through it, and those plugins were unbundled in 1.3.0. Juno must never surface, bundle or suggest that path — it re-imports the Anthropic restriction through a side door.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/goose',
    displayName: 'goose',
    vendor: 'Block',
    discovery: [{ kind: 'path-binary', names: ['goose'] }],
    acpArgs: [],
    homepage: 'https://block.github.io/goose/',
    summary: 'Block\'s open-source, extensible local agent.',
    legal: {
      hostedLogin: 'permitted',
      localCli: 'permitted',
      license: 'Apache-2.0',
      citations: ['https://github.com/block/goose'],
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/qwen-code',
    displayName: 'Qwen Code',
    vendor: 'Alibaba',
    discovery: [
      { kind: 'path-binary', names: ['qwen'] },
      { kind: 'npm-global', packageName: '@qwen-code/qwen-code' },
    ],
    acpArgs: ['--acp', '--experimental-skills'],
    homepage: 'https://github.com/QwenLM/qwen-code',
    summary: 'Alibaba\'s Qwen coding assistant.',
    legal: {
      hostedLogin: 'unverified',
      localCli: 'permitted',
      license: 'Apache-2.0',
      citations: ['https://github.com/QwenLM/qwen-code'],
      note: 'Terms not verified as of 2026-08-12. Apache-2.0 covers the client; Alibaba\'s model terms were not reviewed.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/github-copilot',
    displayName: 'GitHub Copilot',
    vendor: 'GitHub',
    discovery: [
      { kind: 'path-binary', names: ['copilot'] },
      { kind: 'npm-global', packageName: '@github/copilot' },
    ],
    acpArgs: ['--acp'],
    homepage: 'https://github.com/features/copilot/cli/',
    summary: 'GitHub Copilot CLI in ACP mode. Uses your existing Copilot seat.',
    legal: {
      hostedLogin: 'unverified',
      localCli: 'permitted',
      license: 'proprietary',
      citations: ['https://github.com/github/copilot-cli'],
      note: 'GitHub\'s Copilot terms were not reviewed as of 2026-08-12. A Copilot seat is licensed to the user by GitHub; Juno neither provisions nor resells it.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/cursor',
    displayName: 'Cursor',
    vendor: 'Cursor',
    discovery: [{ kind: 'path-binary', names: ['cursor-agent'] }],
    acpArgs: [],
    homepage: 'https://cursor.com/docs/cli/acp',
    summary: "Cursor's coding agent, via its own CLI.",
    legal: {
      hostedLogin: 'unverified',
      localCli: 'permitted',
      license: 'proprietary',
      citations: ['https://cursor.com/docs/cli/acp'],
      note: 'Cursor\'s terms were not reviewed as of 2026-08-12.',
    },
  },
  {
    ...CLI_MANAGED,
    id: 'acp/amp',
    displayName: 'Amp',
    vendor: 'Sourcegraph (community ACP wrapper)',
    discovery: [{ kind: 'path-binary', names: ['amp-acp'] }],
    acpArgs: [],
    homepage: 'https://github.com/tao12345666333/amp-acp',
    summary: 'Amp through a community-maintained ACP wrapper.',
    legal: {
      hostedLogin: 'unverified',
      localCli: 'permitted',
      license: 'Apache-2.0 (wrapper)',
      citations: ['https://github.com/tao12345666333/amp-acp'],
      note: 'Sourcegraph\'s Amp terms were not reviewed as of 2026-08-12. This wrapper is third-party, not published by the agent vendor: pin the version and treat updates as untrusted input.',
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/** Every provider Juno knows about, first-party first. */
export const PROVIDERS: readonly ProviderDescriptor[] = [JUNO_FIRST_PARTY, ...ACP_AGENTS];

const BY_ID = new Map<ProviderId, ProviderDescriptor>(
  PROVIDERS.map((descriptor) => [descriptor.id, descriptor]),
);

export function getProvider(id: ProviderId): ProviderDescriptor | undefined {
  return BY_ID.get(id);
}

/**
 * Look up a provider, refusing ids that are not in the catalogue.
 *
 * The catalogue is an allowlist, and this is the function that makes it one:
 * a provider id arriving over IPC from the renderer is untrusted, and resolving
 * it to a `LaunchCommand` any other way would let a compromised renderer pick
 * the binary Juno spawns.
 */
export function requireProvider(id: ProviderId): ProviderDescriptor {
  const descriptor = BY_ID.get(id);
  if (!descriptor) throw new Error(`Unknown provider "${id}".`);
  return descriptor;
}

export function acpProviders(): readonly ProviderDescriptor[] {
  return ACP_AGENTS;
}

export function isAcpProvider(id: ProviderId): boolean {
  return id.startsWith(ACP_PROVIDER_PREFIX);
}

/**
 * Providers Juno is permitted to launch at all.
 *
 * Only `localCli` gates this. A `prohibited` or `approval-required` stance on
 * `hostedLogin` never removes a provider, because Juno does not offer a hosted
 * login for any vendor — that clause constrains a feature Juno declines to
 * build, not the feature it ships. If a future change adds a vendor login flow,
 * this is the function that must start consulting `hostedLogin`.
 */
export function launchableProviders(): readonly ProviderDescriptor[] {
  return PROVIDERS.filter((descriptor) => descriptor.legal.localCli !== 'prohibited');
}
