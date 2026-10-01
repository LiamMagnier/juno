/**
 * What a failure on an agent's computer may say, and to whom.
 *
 * `docker` answers a failed command with the daemon's own words, and those
 * words name the container ("container 3f9a… is paused, unpause the container
 * before exec"), the volume, sometimes a bridge address. Every one of those is
 * server-side state (docs/design/agents-v2/RULES.md §3.2): it must not reach a
 * tool result the model reads, an API response, `AgentComputer.lastError`, an
 * event, or a log line.
 *
 * So a failure is carried as a `ComputerError`, whose `message` is a sentence
 * written here for the person reading it, and whose `detail` is the scrubbed
 * daemon text kept for the one place allowed to see it: a local log line.
 *
 * Pure (no `server-only`) so a test can reach it.
 */

export const COMPUTER_NOT_RESPONDING = "The computer did not respond. Try again in a moment.";
export const COMPUTER_UNREACHABLE = "Juno could not reach the agent's computer right now.";
export const COMPUTER_BROWSER_UNREACHABLE = "Juno could not connect to the browser on the agent's computer.";
export const COMPUTER_PATH_REFUSED = "Paths must stay inside /home/agent.";

export class ComputerError extends Error {
  /** Scrubbed diagnostic text for a server log. Never shown to anyone. */
  readonly detail: string;

  constructor(publicMessage: string, detail = "") {
    super(publicMessage);
    this.name = "ComputerError";
    this.detail = scrubComputerText(detail);
  }
}

/**
 * Removes container ids, agent container and volume names, IPv4 addresses and
 * URLs from a piece of daemon or driver output.
 */
export function scrubComputerText(text: string): string {
  return String(text ?? "")
    .replace(/\b[0-9a-f]{64}\b/gi, "[container]")
    .replace(/\bjuno-agent-[A-Za-z0-9_-]+/g, "[computer]")
    .replace(/\b(?:ws|wss|http|https):\/\/[^\s"'`]+/gi, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[address]")
    .replace(/\b[0-9a-f]{12}\b/gi, "[id]")
    .slice(0, 500);
}

/** The sentence a caller may show for any error thrown by the computer layer. */
export function publicComputerMessage(err: unknown, fallback = COMPUTER_NOT_RESPONDING): string {
  if (err instanceof ComputerError) return err.message;
  return fallback;
}

/**
 * A daemon line that describes Docker itself failing rather than the command
 * the agent ran. `docker exec` writes these to the same stderr as the command,
 * so the shell tool strips them before the model reads the output.
 */
export function isDaemonErrorLine(line: string): boolean {
  return /^(Error response from daemon|Error: No such container|error during connect|Cannot connect to the Docker daemon)/i.test(
    line.trim()
  );
}

export function stripDaemonLines(stderr: string): { text: string; daemonFailed: boolean } {
  let daemonFailed = false;
  const kept = stderr.split("\n").filter((line) => {
    if (isDaemonErrorLine(line)) {
      daemonFailed = true;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), daemonFailed };
}

/**
 * A path the files API or the files tool may touch: absolute, normalized, under
 * /home/agent, and free of the characters that make one path print as two.
 */
export function isSafeAgentPath(resolved: string): boolean {
  if (!resolved || /[\0\r\n]/.test(resolved)) return false;
  if (!resolved.startsWith("/")) return false;
  const parts = resolved.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return false;
  if (resolved.includes("//")) return false;
  return resolved === "/home/agent" || resolved.startsWith("/home/agent/");
}
