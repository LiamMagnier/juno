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

const rootEnv = loadEnv(path.join(__dirname, "..", ".env"));
const relayEnv = {};
for (const [key, value] of Object.entries(rootEnv)) {
  if (
    key === "AUTH_SECRET" ||
    key === "ALLOWED_ORIGINS" ||
    key.endsWith("_API_KEY") ||
    key.startsWith("RELAY_")
  ) {
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
      max_memory_restart: "800M", // Automatically restart if memory exceeds 800MB (safe for 1GB AMD or ARM VM shapes)
      env: {
        PORT: 3000,
        NODE_ENV: "production",
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
