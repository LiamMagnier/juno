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

module.exports = {
  apps: [
    {
      name: "juno-backend",
      script: "npm",
      args: "run start",
      watch: false,
      // Large pastes + encryption need headroom; 800M was OOM-killing mid-request
      // and leaving the browser on a blank page after Send.
      max_memory_restart: "1400M",
      env: {
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
      script: "npm",
      args: "run tasks:runner",
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/scheduler-err.log",
      out_file: "logs/scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      name: "juno-voice-relay",
      cwd: path.join(__dirname, "..", "relay"),
      script: "npm",
      args: "run start",
      watch: false,
      max_memory_restart: "300M",
      env: {
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
