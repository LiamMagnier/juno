/**
 * Provider layer — core vocabulary.
 *
 * Juno talks to coding agents through exactly two transports:
 *
 *   1. **`acp-stdio`** — a third-party agent CLI already installed on the
 *      user's Mac, spawned as a child process and driven over the Agent Client
 *      Protocol (JSON-RPC 2.0, newline-delimited, on stdin/stdout). One client
 *      implementation covers every ACP agent; providers differ only in how they
 *      are launched, what they call themselves, and what their vendor's terms
 *      permit.
 *   2. **`juno-backend`** — Juno's own first-party path. Model traffic is
 *      proxied through the Juno backend with server-side keys
 *      (`runner/agent-core/src/providers/proxy.ts`). No local CLI, no local
 *      credentials, no child process.
 *
 * The `legal` block on every descriptor is deliberately part of the *type*, not
 * a comment in a doc. Vendor terms distinguish sharply between Juno offering a
 * vendor login as a Juno feature and Juno driving the user's own already-signed-in
 * CLI on the user's own machine (see docs/PROVIDERS.md). That distinction has to
 * survive contact with the code, so it is encoded as data the UI can read and
 * refuse to violate, rather than prose a future contributor will skim past.
 */

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Stable Juno-side provider key. Never shown to users — `displayName` is. */
export type ProviderId = string;

export type ProviderTransport = 'acp-stdio' | 'juno-backend';

/** How the agent's credentials are obtained. */
export type ProviderAuthKind =
  /**
   * The CLI owns its own credentials, stored wherever the vendor put them
   * (`~/.claude`, `~/.codex`, the login keychain, …). Juno never reads, brokers,
   * proxies or even sees them; it spawns a process that is already signed in.
   * This is the only mode Juno ships for third-party vendor accounts.
   */
  | 'cli-managed'
  /**
   * The agent advertised `authMethods` in the `initialize` response and expects
   * the client to drive `authenticate`. Juno supports the `env_var` and
   * `terminal` method shapes; it never renders a vendor's own login form.
   */
  | 'acp-negotiated'
  /** First-party: the user's Juno account, via the backend proxy. */
  | 'juno-account';

/** Whether a thing is permitted, forbidden, gated, or simply not yet verified. */
export type LegalStance = 'permitted' | 'approval-required' | 'prohibited' | 'unverified';

/**
 * The licensing posture Juno must respect for a provider.
 *
 * `hostedLogin` and `localCli` are separate on purpose: for several vendors the
 * first is restricted and the second is not, and collapsing them into one flag
 * is how a product ends up shipping something it may not ship.
 */
export interface ProviderLegal {
  /**
   * May Juno present the vendor's login / subscription inside Juno — implement
   * the OAuth flow, surface the vendor's plan rate limits as a Juno feature,
   * or otherwise put the vendor's account system in Juno's product surface?
   */
  readonly hostedLogin: LegalStance;
  /**
   * May Juno spawn the user's own, already-authenticated CLI on the user's own
   * machine, where that CLI holds its own credentials?
   */
  readonly localCli: LegalStance;
  /** SPDX-ish license of the agent binary/wrapper Juno launches. */
  readonly license: string;
  /** URLs actually checked. Empty means nobody has verified this yet. */
  readonly citations: readonly string[];
  /** Anything a reviewer needs before flipping a stance. */
  readonly note?: string;
}

/* -------------------------------------------------------------------------- */
/* Discovery + launch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How to find the agent on this machine.
 *
 * `npm-global` exists because several first-party ACP wrappers are published
 * only as npm packages. Juno resolves them by *reading* well-known global
 * `node_modules` roots and the package's own `bin` map — it never shells out to
 * `npx`, which would fetch and execute an unpinned package from the network on
 * the user's behalf. If the package is not already installed, the provider is
 * reported unavailable and the UI offers an install instruction, not an
 * automatic download.
 */
export type DiscoveryStrategy =
  | {
      readonly kind: 'path-binary';
      /** Candidate executable names, in preference order. */
      readonly names: readonly string[];
    }
  | {
      readonly kind: 'npm-global';
      /** Package name without a version range, e.g. `@google/gemini-cli`. */
      readonly packageName: string;
      /** Which entry of the package's `bin` map to launch, when it has several. */
      readonly binName?: string;
    }
  | {
      /** First-party / in-process. Always available; nothing to look for. */
      readonly kind: 'builtin';
    };

/** A fully resolved, ready-to-spawn command. Never a shell string. */
export interface LaunchCommand {
  /** Absolute path to the executable. */
  readonly command: string;
  /** Argument vector. Passed to `spawn` as an array; `shell` is always false. */
  readonly args: readonly string[];
  /** Extra environment merged on top of the scrubbed base env. */
  readonly env: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/* Descriptor                                                                  */
/* -------------------------------------------------------------------------- */

export interface ProviderDescriptor {
  readonly id: ProviderId;
  /**
   * The name Juno is allowed to show. Trademark-constrained for some vendors —
   * notably Anthropic's ACP agent, which the official registry itself publishes
   * as "Claude Agent" rather than the product name of Anthropic's own CLI.
   * Render this string; never assemble a vendor name in the UI by hand.
   */
  readonly displayName: string;
  readonly vendor: string;
  readonly transport: ProviderTransport;
  readonly authKind: ProviderAuthKind;
  /**
   * Ways to find this agent, tried in order. Several agents ship both as a
   * standalone binary and as a global npm package, and which one a given user
   * has is not knowable in advance.
   */
  readonly discovery: readonly DiscoveryStrategy[];
  /**
   * Arguments appended after the resolved executable to put it in ACP mode.
   * Taken from the official ACP registry entry for the agent, not guessed.
   */
  readonly acpArgs: readonly string[];
  /** Environment the vendor's registry entry asks for (e.g. disabling autoupdate). */
  readonly acpEnv: Readonly<Record<string, string>>;
  /**
   * Environment variable names this provider is allowed to inherit from the
   * user's shell despite looking secret-ish. Empty for every provider Juno
   * ships: `cli-managed` agents read their own credential stores, so passing
   * API keys through would widen the blast radius for no benefit.
   */
  readonly envPassthrough: readonly string[];
  readonly homepage: string;
  readonly legal: ProviderLegal;
  /** One line for the provider picker. */
  readonly summary: string;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

export type UnavailableReason =
  | 'not-installed'
  | 'not-executable'
  | 'probe-failed'
  | 'probe-timeout'
  | 'legally-blocked'
  | 'unsupported-platform';

/**
 * The result of looking for one provider on this machine. The UI gates on this
 * so it never offers a provider that is not actually there — an agent picker
 * that lists nine agents and errors on eight of them is worse than one that
 * lists the one that works.
 */
export type ProviderAvailability =
  | {
      readonly id: ProviderId;
      readonly available: true;
      readonly launch: LaunchCommand;
      /** Trimmed, bounded output of the `--version` probe, when one ran. */
      readonly version?: string;
    }
  | {
      readonly id: ProviderId;
      readonly available: false;
      readonly reason: UnavailableReason;
      /** Human-readable, already safe to display. */
      readonly detail: string;
    };
