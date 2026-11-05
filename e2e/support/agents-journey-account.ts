/*
 * The agents journey's account and its one safety rule, shared by the spec
 * (e2e/agents-journey.spec.ts) and the seed (scripts/seed-agents-journey.ts).
 * No imports: the seed runs under tsx with the react-server condition and the
 * spec runs inside Playwright, and both must be able to load this.
 *
 * The password is a local test value, like e2e/helpers.ts's: the account only
 * ever exists in a database on this machine.
 */

export const AGENTS_JOURNEY_EMAIL = process.env.AGENTS_JOURNEY_EMAIL ?? "agents-journey@juno.test";
export const AGENTS_JOURNEY_PASSWORD = process.env.AGENTS_JOURNEY_PASSWORD ?? "Agents-Journey-Test-2026!";
/** The seed recognises the account it made by this name as well as its address. */
export const AGENTS_JOURNEY_NAME = "Agents Journey Test User";

/** Null for a Postgres database on this machine; otherwise why the journey refuses it. */
export function localDatabaseProblem(raw: string | undefined): string | null {
  if (!raw) return "DATABASE_URL is not set.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "DATABASE_URL is not a URL.";
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return "DATABASE_URL is not a Postgres URL.";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return `Refusing ${url.hostname}: the agents journey only uses a database on this machine.`;
  }
  return null;
}
