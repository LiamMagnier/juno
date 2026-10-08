#!/usr/bin/env node
/**
 * alevr-env — the Alevr Code local environment server.
 *
 *   alevr-env [--port N] [--data-dir DIR] [--allow-origin URL]… [--parent-pid PID] [--log debug|info|warn]
 *       Starts the server and prints ONE JSON line on stdout once it listens:
 *       {"alevrEnv":1,"port":…,"token":"…","pid":…,"protocol":{…}}
 *       The Mac app reads that line (sidecar handshake); everything else goes
 *       to stderr. The token may be fixed with ALEVR_ENV_TOKEN (dev only).
 *       With --parent-pid the server exits when that process dies.
 *
 *   alevr-env mcp-stdio --url URL
 *       Bridges an ACP agent that only speaks stdio MCP to the env server's
 *       HTTP MCP endpoint. The bearer comes from ALEVR_MCP_AUTHORIZATION.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CODE_V2_PROTOCOL } from "./contracts/code-v2.js";
import { defaultDataDir, startEnvServer } from "./server.js";
import { stderrLogger } from "./util.js";

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function args(name: string, argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

async function mcpStdio(argv: string[]): Promise<void> {
  const url = arg("--url", argv);
  const authorization = process.env.ALEVR_MCP_AUTHORIZATION;
  if (!url || !authorization) {
    process.stderr.write("mcp-stdio needs --url and ALEVR_MCP_AUTHORIZATION\n");
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
          body: line,
        });
        if (res.status === 202) return;
        const body = await res.text();
        if (body.trim()) process.stdout.write(`${body.replace(/\n/g, " ")}\n`);
      } catch (error) {
        let id: unknown = null;
        try {
          id = (JSON.parse(line) as { id?: unknown }).id ?? null;
        } catch {
          /* not JSON */
        }
        if (id !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error) } })}\n`);
      }
    });
  });
  rl.on("close", () => void chain.then(() => process.exit(0)));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp-stdio") return mcpStdio(argv.slice(1));
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("alevr-env [--port N] [--data-dir DIR] [--allow-origin URL] [--parent-pid PID] [--log LEVEL]\n");
    return;
  }
  const level = (arg("--log", argv) ?? process.env.ALEVR_ENV_LOG ?? "info") as "debug" | "info" | "warn" | "error";
  const logger = stderrLogger(level);
  const dataDir = arg("--data-dir", argv) ?? defaultDataDir();
  const self = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const server = await startEnvServer({
    dataDir,
    port: Number(arg("--port", argv) ?? process.env.ALEVR_ENV_PORT ?? 0),
    ...(process.env.ALEVR_ENV_TOKEN ? { token: process.env.ALEVR_ENV_TOKEN } : {}),
    logger,
    allowedOrigins: args("--allow-origin", argv),
    ...(self ? { mcpBridge: { command: process.execPath, args: [...process.execArgv, self, "mcp-stdio"] } } : {}),
  });
  const handshake = { alevrEnv: 1, port: server.port, token: server.token, pid: process.pid, protocol: CODE_V2_PROTOCOL, dataDir };
  // Local discovery for dev tools: owner-only file, removed on exit.
  const discovery = path.join(dataDir, "server.json");
  try {
    fs.writeFileSync(discovery, JSON.stringify(handshake), { mode: 0o600 });
  } catch {
    /* read-only data dir */
  }
  process.stdout.write(`${JSON.stringify(handshake)}\n`);

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      fs.rmSync(discovery, { force: true });
    } catch {
      /* gone */
    }
    await server.close().catch(() => undefined);
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  const parent = Number(arg("--parent-pid", argv));
  if (Number.isInteger(parent) && parent > 1) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void stop(0);
      }
    }, 2000).unref();
  }
  // The Mac app closing our stdin is the other "parent went away" signal.
  process.stdin.on("end", () => {
    if (!process.stdin.isTTY) void stop(0);
  });
  process.stdin.resume();
}

main().catch((error) => {
  process.stderr.write(`alevr-env: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
