/**
 * The provider instances Alevr knows how to find, and the steps a user runs
 * in a terminal to install or sign in to each one (SPEC §2).
 *
 * Every vendor runtime here holds its own credentials. Alevr never implements
 * a vendor login, never reads or stores a vendor token and never proxies a
 * vendor's inference; it starts the vendor's own program on the user's
 * machine. See docs/code-v2/PROVIDERS-LEGAL.md for what must be re-verified
 * before public release.
 */
import type { ProviderInstance, ProviderSetupAction, ProviderSetupStep } from "../contracts/code-v2.js";
import { shellQuote } from "./detect.js";

export interface AcpPreset {
  /** Instance id suffix: "acp:<preset>". */
  preset: string;
  label: string;
  /** argv; argv[0] is resolved on PATH. */
  command: string[];
  /** Alternative argv tried by the probe when `command` fails to initialize (older/newer CLI flags). */
  fallbacks?: string[][];
  /** Environment variables of the user's own shell this agent may read (its own API keys). Everything else is scrubbed. */
  envPassthrough?: string[];
  /** Extra binary names to look for (Antigravity's runtime ships under more than one name). */
  binaryAliases?: string[];
  install?: Omit<ProviderSetupStep, "action">;
  login?: Omit<ProviderSetupStep, "action">;
  /**
   * Off until a person flips it: the vendor's terms for third-party clients
   * are unresolved (see PROVIDERS-LEGAL.md). Detection still runs so the UI
   * can say why it is off.
   */
  legalHold?: string;
}

export const ACP_PRESETS: readonly AcpPreset[] = [
  {
    preset: "gemini",
    label: "Gemini CLI",
    command: ["gemini", "--acp"],
    fallbacks: [["gemini", "--experimental-acp"]],
    envPassthrough: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"],
    install: { command: "npm install -g @google/gemini-cli", label: "Install Gemini CLI", url: "https://github.com/google-gemini/gemini-cli" },
    login: {
      command: "gemini",
      label: "Sign in to Gemini CLI",
      note: "Gemini CLI works with a Gemini API key, Vertex AI or a Gemini Code Assist Standard/Enterprise seat. Personal Google sign-in is no longer served for Gemini CLI.",
      url: "https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals",
    },
  },
  {
    preset: "grok",
    label: "Grok",
    command: ["grok", "agent", "stdio"],
    envPassthrough: ["XAI_API_KEY"],
    login: { command: "grok login", label: "Sign in to Grok" },
  },
  {
    preset: "dsh",
    label: "DeepSeek Harness",
    command: ["dsh", "--profile", "acp"],
    envPassthrough: ["DEEPSEEK_API_KEY"],
    install: { command: "npm install -g @deepseek-ai/dsh", label: "Install DeepSeek Harness", url: "https://github.com/deepseek-ai/deepseek-harness" },
  },
  {
    preset: "opencode",
    label: "OpenCode",
    command: ["opencode", "acp"],
    install: { command: "curl -fsSL https://opencode.ai/install | bash", label: "Install OpenCode", url: "https://opencode.ai" },
    login: { command: "opencode auth login", label: "Sign in to OpenCode" },
  },
  {
    // Google's official ACP runtime. Enabled by the owner on 2026-10-09 (PROVIDERS-LEGAL.md).
    // Alevr installs it (provider.install: Google's CDN, pinned size and SHA-256) and signs it in
    // with Google (provider.auth: the runtime's own 127.0.0.1 callback); see providers/antigravity/.
    preset: "antigravity",
    label: "Antigravity",
    command: ["antigravity-acp"],
    binaryAliases: ["agy_acp_server.par", "agy_acp_server", "agy-acp-server"],
    // No ambient Google credentials: the instance's own sign-in is the only one the runtime sees.
    envPassthrough: [],
  },
];

export function acpPreset(instance: Pick<ProviderInstance, "id">): AcpPreset | undefined {
  const name = instance.id.startsWith("acp:") ? instance.id.slice(4).split(":")[0] : undefined;
  return ACP_PRESETS.find((p) => p.preset === name);
}

/** Built-in instance seeds. Users add more (second accounts, custom ACP agents) in instances.json. */
export function defaultInstances(): ProviderInstance[] {
  return [
    { id: "alevr", kind: "alevr", label: "Alevr", status: "unknown" },
    { id: "claude-agent:default", kind: "claude-agent", label: "Claude (your subscription)", status: "unknown" },
    { id: "codex:default", kind: "codex", label: "Codex (your ChatGPT plan)", status: "unknown" },
    ...ACP_PRESETS.map(
      (p): ProviderInstance => ({ id: `acp:${p.preset}`, kind: "acp", label: p.label, acpCommand: [...p.command], status: "unknown" }),
    ),
  ];
}

/** Prefixes `VAR='value'` for a per-account config dir so the login lands in the right account. */
function withEnv(command: string, name: string, value: string | undefined): string {
  return value ? `${name}=${shellQuote(value)} ${command}` : command;
}

export function claudeSetup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep {
  if (action === "install") {
    return {
      action,
      command: "curl -fsSL https://claude.ai/install.sh | bash",
      label: "Install Claude",
      note: "Installs Anthropic's own claude CLI. Alevr runs it on this Mac with your subscription; Alevr never sees your Claude sign-in.",
      url: "https://docs.claude.com/en/docs/claude-code/setup",
    };
  }
  const bin = instance.binaryPath ? shellQuote(instance.binaryPath) : "claude";
  return {
    action,
    command: withEnv(`${bin} auth login`, "CLAUDE_CONFIG_DIR", instance.configDir),
    label: "Sign in to Claude",
    note: "Signs in your own claude CLI in this terminal. Alevr never sees the credential.",
  };
}

export function codexSetup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep {
  if (action === "install") {
    return {
      action,
      command: "npm install -g @openai/codex",
      label: "Install Codex",
      note: "Installs OpenAI's own codex CLI. Alevr talks to it through codex app-server on this Mac.",
      url: "https://developers.openai.com/codex/cli",
    };
  }
  const bin = instance.binaryPath ? shellQuote(instance.binaryPath) : "codex";
  return {
    action,
    command: withEnv(`${bin} login`, "CODEX_HOME", instance.configDir),
    label: "Sign in to Codex",
    note: "Signs in your own codex CLI with ChatGPT in this terminal. Alevr never sees the credential.",
  };
}

export function acpSetup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep | null {
  const preset = acpPreset(instance);
  const step = action === "install" ? preset?.install : preset?.login;
  if (!step) return null;
  return { action, ...step };
}
