const fs = require("fs");
const path = require("path");

// The Next.js app loads the repo .env itself; the relay is plain Node and
// does not, so parse the .env here and hand the relay only the keys it needs.
function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    // No .env — the relay will boot with whatever the shell provides.
  }
  return out;
}

/*
 * Explicit allowlist, derived from `grep -o 'process\.env\.[A-Z_0-9]*' relay/src`.
 *
 * This used to pass anything matching `_API_KEY`, which handed the process that
 * terminates untrusted public WebSockets every provider key Juno holds —
 * ANTHROPIC_API_KEY, COMPOSIO_API_KEY, TAVILY_API_KEY, RESEND_API_KEY and the
 * rest — none of which the relay has any use for. The relay speaks to exactly
 * four realtime voice providers.
 *
 * Keep this in sync with what relay/src actually reads. Adding a key the relay
 * does not use costs nothing but blast radius; omitting one it does use breaks
 * that voice provider silently at runtime.
 */
const RELAY_ENV_ALLOWLIST = [
  "AUTH_SECRET",
  "ALLOWED_ORIGINS",
  // OpenAI realtime
  "OPENAI_API_KEY",
  // Gemini Live
  "GEMINI_LIVE_API_KEY",
  "GOOGLE_API_KEY",
  // MiniMax realtime
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  // Qwen (DashScope) realtime
  "DASHSCOPE_API_KEY",
];

const rootEnv = loadEnv(path.join(__dirname, "..", ".env"));
const relayEnv = {};
for (const [key, value] of Object.entries(rootEnv)) {
  // RELAY_* are the relay's own model/feature overrides.
  if (RELAY_ENV_ALLOWLIST.includes(key) || key.startsWith("RELAY_")) {
    relayEnv[key] = value;
  }
}

// PM2 keeps environment keys from the previous process when an ecosystem file
// does not declare them.  Declare the reviewed release SHA in the ecosystem so
// a reload cannot leave /api/health (or worker diagnostics) reporting the
// previous release after the current symlink has switched.
/**
 * Where the apps run from — and it is deliberately the `current` SYMLINK, not
 * the release directory this file happens to be sitting in.
 *
 * `deploy.sh` calls `pm2 startOrReload <release>/deploy/ecosystem.config.js
 * --cwd <release>`. `--cwd` applies only to an app PM2 is STARTING; for one
 * already online it reloads in place and keeps the cwd it first launched with —
 * the same way it keeps undeclared env keys, per the note above. Declaring
 * `cwd` in the config does NOT fix that: it is read when the app starts, and a
 * reload is not a start.
 *
 * The consequence was silent and total. The deploy uploads a release, flips the
 * symlink, reports success — and every process goes on serving the `.next` in
 * whatever directory it was launched from. This deployment served a build from
 * 2026-08-08 for three days while release after release landed beside it,
 * green and unread; pinning cwd to the release directory then merely moved the
 * staleness forward one deploy at a time.
 *
 * A symlink fixes it because the path never changes. Every app's cwd is the
 * literal string `<APP_HOME>/current` for the life of the deployment, so there
 * is no cwd change for a reload to ignore — and each reload spawns a process
 * that resolves that symlink afresh, landing in whichever release is current.
 *
 * Derived rather than passed in, so a caller cannot forget it: this file ships
 * at `<APP_HOME>/releases/<release>/deploy/`, so two levels up from the release
 * root is `<APP_HOME>`. Outside a `releases/` tree (a dev checkout, a manual
 * run) there is no symlink to point at and the release root is correct as-is.
 */
const releaseRoot = path.resolve(__dirname, "..");
const releasesParent = path.dirname(releaseRoot);
const runRoot =
  path.basename(releasesParent) === "releases"
    ? path.join(path.dirname(releasesParent), "current")
    : releaseRoot;

const releaseEnv = process.env.GIT_SHA ? { GIT_SHA: process.env.GIT_SHA } : {};

module.exports = {
  apps: [
    {
      name: "juno-backend",
      cwd: runRoot,
      script: "npm",
      args: "run start",
      watch: false,
      // Large pastes + encryption need headroom; 800M was OOM-killing mid-request
      // and leaving the browser on a blank page after Send.
      max_memory_restart: "1400M",
      env: {
        ...releaseEnv,
        PORT: 3000,
        NODE_ENV: "production",
        // Higher default HTTP header limit (16kb) and heap for big chat bodies.
        NODE_OPTIONS: "--max-http-header-size=131072 --max-old-space-size=1024",
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Scheduled-task worker: claims due ScheduledTasks every 60s and runs
      // them (scripts/scheduled-task-runner.ts). Loads the repo .env itself.
      name: "juno-scheduler",
      cwd: runRoot,
      script: "npm",
      args: "run tasks:runner",
      watch: false,
      max_memory_restart: "400M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
      },
      error_file: "logs/scheduler-err.log",
      out_file: "logs/scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Cloud Work executor: claims queued cloud runs every 5s and drives the
      // agent runtime (scripts/work-runner.ts). Loads the repo .env itself.
      //
      // Its own app rather than a second process of juno-scheduler, because a
      // Work run holds a model provider open for minutes at a time and a
      // scheduled task does not: sharing a process would mean one OOM restart
      // takes both down, and a Work run that is restarted mid-flight is a run
      // that has already moved files or sent a message.
      //
      // Headroom above the scheduler's 400M for the same reason: a run holds a
      // transcript, a plan, up to three connectors' MCP sessions and the bytes
      // of any deliverable it is packing, and MAX_CONCURRENT_RUNS is 3.
      name: "juno-work",
      cwd: runRoot,
      script: "npm",
      args: "run work:runner",
      watch: false,
      max_memory_restart: "900M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
      },
      error_file: "logs/work-err.log",
      out_file: "logs/work-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Work schedules and triggers: turns a due WorkSchedule into a queued
      // WorkRun, which juno-work then claims (scripts/work-scheduler.ts).
      //
      // Separate from juno-work deliberately. The executor is horizontally
      // scalable — leases mean several may run at once — while the thing that
      // decides a schedule is due must not be, or one cron expression fires
      // twice. Keeping them apart is what lets the executor be scaled without
      // anybody having to remember that.
      //
      name: "juno-work-scheduler",
      cwd: runRoot,
      script: "npm",
      args: "run work:scheduler",
      watch: false,
      max_memory_restart: "400M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
        NODE_OPTIONS: "--conditions=react-server",
      },
      error_file: "logs/work-scheduler-err.log",
      out_file: "logs/work-scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Restart-safe research executor: adopts accepted and working research
      // rows whose lease is absent or expired (scripts/research-worker.ts).
      // The API still nudges fresh runs for low latency; this process is the
      // durable backstop after deploys, crashes and machine restarts.
      name: "juno-research",
      cwd: runRoot,
      script: "npm",
      args: "run research:worker",
      watch: false,
      max_memory_restart: "600M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
        NODE_OPTIONS: "--conditions=react-server",
      },
      error_file: "logs/research-err.log",
      out_file: "logs/research-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Event triggers: polls the sources a WorkTrigger watches and turns a
      // match into a queued WorkRun (scripts/work-trigger-poller.ts).
      //
      // Its own app rather than a tick inside juno-work-scheduler, for the same
      // reason those two are separate. The scheduler's work is arithmetic on a
      // cron expression and finishes in milliseconds; this one makes network
      // calls to Gmail and CalDAV that can hang for as long as those services
      // let them. Sharing a process would mean one unresponsive mail server
      // stops every cron schedule in the deployment from firing.
      //
      // Single instance, and it must stay that way: the poller claims a trigger
      // with an optimistic lease, but the cursor that stops a restart re-firing
      // history is per-trigger, not per-process.
      //
      // NOTE: inert until the account has an event trigger. With none
      // configured the sweep finds nothing and costs one indexed query every
      // two minutes.
      name: "juno-work-triggers",
      cwd: runRoot,
      script: "npm",
      args: "run work:trigger-poller",
      watch: false,
      max_memory_restart: "400M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
        NODE_OPTIONS: "--conditions=react-server",
      },
      error_file: "logs/work-triggers-err.log",
      out_file: "logs/work-triggers-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Reclaims staged/imported objects after a request or VM dies before the
      // relational import transaction can mark them attached. The ledger keeps
      // this safe across restarts and multiple cleanup attempts.
      name: "juno-import-recovery",
      cwd: runRoot,
      script: "npm",
      args: "run import:recovery",
      watch: false,
      max_memory_restart: "300M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
      },
      error_file: "logs/import-recovery-err.log",
      out_file: "logs/import-recovery-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      // Reconciles Cloud Code tasks whose runner stopped reporting before it
      // could post a terminal event. This is intentionally a long-lived,
      // single-instance loop rather than a best-effort manual command: a task
      // that stays `running` forever is a broken product surface.
      name: "juno-code-sweeper",
      cwd: runRoot,
      script: "npm",
      args: "run tasks:sweep -- --daemon",
      watch: false,
      max_memory_restart: "400M",
      env: {
        ...releaseEnv,
        NODE_ENV: "production",
      },
      error_file: "logs/code-sweeper-err.log",
      out_file: "logs/code-sweeper-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      name: "juno-voice-relay",
      // The relay is its own package inside the release, so it is the one app
      // whose cwd is a subdirectory rather than the release root.
      cwd: path.join(runRoot, "relay"),
      script: "npm",
      args: "run start",
      watch: false,
      max_memory_restart: "300M",
      env: {
        ...releaseEnv,
        PORT: 8787,
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://chat.liams.dev,http://localhost:3000",
        ...relayEnv,
      },
      error_file: path.join(__dirname, "..", "logs", "relay-err.log"),
      out_file: path.join(__dirname, "..", "logs", "relay-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
