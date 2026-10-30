import { PRODUCT_NAME } from "@/lib/brand/names";

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
export const COMPUTER_UNREACHABLE = `${PRODUCT_NAME} could not reach the agent's computer right now.`;
export const COMPUTER_BROWSER_UNREACHABLE = `${PRODUCT_NAME} could not connect to the browser on the agent's computer.`;
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
 * Why an account, or this use of a computer, was refused
 * (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.3). The first five are the
 * account's access; the rest are limits and the agent's own policy.
 */
export type ComputerRefusalCode =
  | "server_off"
  | "rollout_off"
  | "not_in_rollout"
  | "plan"
  | "unavailable"
  | "enabled_cap"
  | "allowance_exhausted"
  | "policy_off";

/**
 * A refusal with its code. The message is a sentence for the person (or the
 * model, in a tool result); `upgradePlan` is set only for `plan`, and
 * `maxEnabled` / `weeklyMinutes` carry the numbers a route needs to say the
 * sentence again with the agent's name in it.
 */
export class ComputerAccessError extends ComputerError {
  readonly code: ComputerRefusalCode;
  readonly upgradePlan: string | null;
  readonly maxEnabled: number | null;

  constructor(
    code: ComputerRefusalCode,
    message: string,
    extra: { upgradePlan?: string | null; maxEnabled?: number | null } = {},
  ) {
    super(message);
    this.name = "ComputerAccessError";
    this.code = code;
    this.upgradePlan = extra.upgradePlan ?? null;
    this.maxEnabled = extra.maxEnabled ?? null;
  }
}

/** The HTTP status a refusal is answered with (§S1.3). */
export function computerRefusalStatus(code: ComputerRefusalCode): 403 | 409 | 503 {
  if (code === "unavailable") return 503;
  if (code === "enabled_cap" || code === "allowance_exhausted" || code === "policy_off") return 409;
  return 403;
}

/**
 * How a route answers any error from the computer layer: a refusal with its
 * code and status, the unreachable sentence as a 503, any other
 * `ComputerError` with its own sentence, and everything else with the fixed
 * fallback. Never a raw `err.message` (fact 6 in the plan): a non-computer
 * error can carry a daemon's words, a path or a database detail.
 *
 * `reword` lets the caller say a refusal again with the agent's name in it.
 */
export function computerErrorBody(
  err: unknown,
  opts: { fallbackError?: string; fallbackStatus?: number; reword?: (err: ComputerAccessError) => string | null } = {},
): { status: number; body: { error: string; message: string; upgradePlan?: string } } {
  if (err instanceof ComputerAccessError) {
    const message = opts.reword?.(err) ?? err.message;
    return {
      status: computerRefusalStatus(err.code),
      body: { error: err.code, message, ...(err.upgradePlan ? { upgradePlan: err.upgradePlan } : {}) },
    };
  }
  if (err instanceof ComputerError) {
    if (err.message === COMPUTER_UNREACHABLE) {
      return { status: 503, body: { error: "unreachable", message: err.message } };
    }
    return { status: opts.fallbackStatus ?? 409, body: { error: opts.fallbackError ?? "computer_error", message: err.message } };
  }
  return {
    status: opts.fallbackStatus ?? 409,
    body: { error: opts.fallbackError ?? "computer_error", message: COMPUTER_NOT_RESPONDING },
  };
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
