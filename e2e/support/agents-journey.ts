import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { ScriptedWorkScript } from "../../runner/agent-core/src/work/scripted-model";
import { AGENTS_JOURNEY_EMAIL, localDatabaseProblem } from "./agents-journey-account";

/*
 * What the agents journey (e2e/agents-journey.spec.ts) needs besides a
 * browser: its own account, a LOCAL cloud Work runner driven by the scripted
 * Work model, and a read of the rows the browser cannot see (how many times a
 * run was picked up, how many times it asked).
 *
 * The runner is scripts/work-runner.ts itself, started the way production
 * starts it (node + tsx, the react-server condition), with three differences
 * that make it a test runner and nothing else:
 *
 *   - NODE_ENV=development and the scripted Work model switched on for the
 *     journey's account only (src/lib/dev/scripted-work-model.ts refuses it in
 *     production whatever is set, and the run says in its own transcript that
 *     no model was called);
 *   - WORK_ATTENDED_WAIT_MS is a few seconds, so a question parks the run
 *     while the test watches rather than after the default minute;
 *   - no provider key, no computer provider and no connector: nothing it can
 *     reach costs anything or leaves this machine.
 *
 * Its sweeps are global (stalled leases, runs set aside for a restart), so it
 * refuses to start against a database where another account has cloud work
 * in flight: on a shared dev database it would otherwise claim or end runs
 * that are not the journey's.
 */

export const ROOT = path.resolve(__dirname, "../..");

/** The executor's heartbeat row (src/lib/work/executor-presence.ts). */
const HEARTBEAT_KEY = "work-executor:heartbeat";
/** Its TTL there; a row expiring later than now + this − 40 s was written in the last 40 s. */
const HEARTBEAT_TTL_MS = 2 * 60_000;

export type JourneyScript = ScriptedWorkScript;

/** Why the journey cannot run here, or null. It is opt-in: it starts a process and writes rows. */
export function agentsJourneySkipReason(env: Record<string, string | undefined> = process.env): string | null {
  if (env.AGENTS_JOURNEY !== "1") {
    return "Opt-in (AGENTS_JOURNEY=1): it seeds its own account and starts a local Work runner. See e2e/agents-journey.spec.ts.";
  }
  return localDatabaseProblem(env.DATABASE_URL);
}

/** Variables the runner shares with the web server, forwarded only when set. */
const SHARED_WITH_THE_SERVER = [
  "DATABASE_URL",
  "DIRECT_URL",
  "AUTH_SECRET",
  "AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "DATA_ENCRYPTION_KEY",
  "DATA_ENCRYPTION_KEYRING",
  "DATA_ENCRYPTION_ACTIVE_KEY_ID",
  "TOKEN_ENCRYPTION_KEYS",
  "TOKEN_ENCRYPTION_PRIMARY",
] as const;

function baseEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    NODE_OPTIONS: "--conditions=react-server",
  };
  for (const name of SHARED_WITH_THE_SERVER) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.DIRECT_URL ??= env.DATABASE_URL ?? "";
  return env as NodeJS.ProcessEnv;
}

/** Makes the journey's account again from nothing (scripts/seed-agents-journey.ts). */
export function seedAgentsJourneyAccount(): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-agents-journey.ts"], {
    cwd: ROOT,
    env: baseEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`Seeding ${AGENTS_JOURNEY_EMAIL} failed: ${(result.stderr || result.stdout || String(result.error)).trim()}`);
  }
}

export function writeJourneyScript(file: string, script: JourneyScript): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(script, null, 2)}\n`);
}

export interface LocalWorkRunner {
  readonly logFile: string;
  /** SIGTERM (the runner drains: in-flight runs are set aside), then SIGKILL after 30 s. */
  stop(): Promise<void>;
}

/** Cloud work in flight that is not the journey's: a runner started now would claim or sweep it. */
async function othersInFlight(db: PrismaClient, userId: string): Promise<number> {
  return db.workRun.count({
    where: {
      effectiveTarget: "cloud",
      userId: { not: userId },
      status: { in: ["queued", "preparing", "running", "waiting_input", "waiting_approval"] },
    },
  });
}

export async function startLocalWorkRunner(input: {
  db: PrismaClient;
  userId: string;
  scriptPath: string;
  logDir: string;
  attendedWaitMs: number;
}): Promise<LocalWorkRunner> {
  const others = await othersInFlight(input.db, input.userId);
  if (others > 0) {
    throw new Error(
      `${others} cloud run(s) of other accounts are in flight in this database; a local runner would claim or sweep them. ` +
        "Run the journey against a database with no other cloud work in flight."
    );
  }
  mkdirSync(input.logDir, { recursive: true });
  const logFile = path.join(input.logDir, `work-runner-${Date.now()}.log`);
  const out = openSync(logFile, "a");
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "scripts/work-runner.ts"], {
    cwd: ROOT,
    env: {
      ...baseEnv(),
      NODE_ENV: "development",
      HOSTNAME: "agents-journey",
      JUNO_ALLOW_SCRIPTED_WORK: "1",
      WORK_SCRIPTED_MODEL_FILE: input.scriptPath,
      WORK_SCRIPTED_MODEL_USERS: AGENTS_JOURNEY_EMAIL,
      WORK_ATTENDED_WAIT_MS: String(input.attendedWaitMs),
    },
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(timer);
  };

  // Ready once it has written its heartbeat, which is also what lets dispatch
  // accept a cloud task at all (src/lib/work/executor-heartbeat.ts).
  const until = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`The work runner exited (${child.exitCode}) before it reported in:\n${readFileSync(logFile, "utf8").slice(-2_000)}`);
    }
    const beat = await input.db.rateLimit.findUnique({ where: { key: HEARTBEAT_KEY }, select: { expiresAt: true } });
    const started = readFileSync(logFile, "utf8").includes("[work-runner] started");
    if (started && beat && beat.expiresAt.getTime() > Date.now() + HEARTBEAT_TTL_MS - 40_000) break;
    if (Date.now() > until) {
      await stop();
      throw new Error(`The work runner did not report in within two minutes:\n${readFileSync(logFile, "utf8").slice(-2_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { logFile, stop };
}

/** What the browser cannot see about a task's runs. */
export interface TaskFacts {
  status: string | null;
  terminalReason: string | null;
  terminalDetail: string | null;
  pauseReason: string | null;
  needsAttention: boolean;
  runs: number;
  /** How many times the cloud executor picked the run up (`run_started`, executor cloud). */
  cloudStarts: number;
  questionsAsked: number;
  questionsAnswered: number;
  errorRows: number;
  /** The scripted model's own disclosure (`degraded`, model_substituted). */
  scriptedDisclosures: number;
  artifacts: number;
}

export async function taskFacts(db: PrismaClient, userId: string, sessionId: string): Promise<TaskFacts> {
  const session = await db.workSession.findFirst({ where: { id: sessionId, userId }, select: { needsAttention: true } });
  const runs = await db.workRun.findMany({
    where: { sessionId, userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, terminalReason: true, terminalDetail: true, pauseReason: true },
  });
  const latest = runs[0] ?? null;
  const events = latest
    ? await db.workEvent.findMany({ where: { runId: latest.id, userId }, select: { kind: true, payload: true } })
    : [];
  const payload = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  return {
    status: latest?.status ?? null,
    terminalReason: latest?.terminalReason ?? null,
    terminalDetail: latest?.terminalDetail ?? null,
    pauseReason: latest?.pauseReason ?? null,
    needsAttention: session?.needsAttention ?? false,
    runs: runs.length,
    cloudStarts: events.filter((e) => e.kind === "run_started" && payload(e.payload).executor === "cloud").length,
    questionsAsked: events.filter((e) => e.kind === "question_asked").length,
    questionsAnswered: events.filter((e) => e.kind === "question_answered").length,
    errorRows: events.filter((e) => e.kind === "error").length,
    scriptedDisclosures: events.filter((e) => e.kind === "degraded" && payload(e.payload).subject === "scripted").length,
    artifacts: await db.workArtifact.count({ where: { sessionId, userId } }),
  };
}
