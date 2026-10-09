#!/usr/bin/env node
// A stand-in for Google's antigravity-acp runtime in the env server's tests.
// It behaves like the real one where Alevr depends on it:
// - initialize identifies as antigravity-acp with oauth-personal and logout;
// - authenticate succeeds at once when $GEMINI_HOME/antigravity-acp/acp_token.json
//   exists; otherwise it listens on 127.0.0.1, asks $BROWSER to open Google's
//   page (or prints the stdout prompt with FAKE_AGY_PROMPT=stdout), and writes
//   the token file when the loopback receives this flow's state and a code;
// - session/new fails with -32000 while signed out;
// - logout deletes the token file.
// FAKE_AGY_LOG (a file) records every method; "env" in a prompt reports what
// credentials it can see.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";

const home = process.env.GEMINI_HOME ?? "";
const tokenFile = path.join(home, "antigravity-acp", "acp_token.json");
const log = (m) => process.env.FAKE_AGY_LOG && fs.appendFileSync(process.env.FAKE_AGY_LOG, `${m}\n`);
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const signedIn = () => fs.existsSync(tokenFile);

/** Python's shlex.split for the single-quoted BROWSER command Alevr sets. */
function shlex(text) {
  const out = [];
  let cur = "";
  let i = 0;
  let has = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      cur += text.slice(i + 1, end);
      i = end + 1;
      has = true;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      cur += text.slice(i + 1, end);
      i = end + 1;
      has = true;
    } else if (c === " ") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

function authenticate(id) {
  if (signedIn()) return send({ id, result: {} });
  const state = crypto.randomBytes(12).toString("hex");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("bad state");
      return;
    }
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/plain" }).end("You can close this tab.");
    server.close();
    if (error) return send({ id, error: { code: -32603, message: `access_denied: ${error}` } });
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ fake: true, code: url.searchParams.get("code") }), { mode: 0o600 });
    send({ id, result: {} });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const redirect = `http://127.0.0.1:${port}/`;
    const auth = `https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=openid&state=${state}`;
    if (process.env.FAKE_AGY_PROMPT === "stdout") {
      process.stdout.write(`Open the following link to authenticate the ACP server: ${auth}\n`);
      return;
    }
    const browser = process.env.BROWSER;
    if (!browser) {
      process.stdout.write(`Open the following link to authenticate the ACP server: ${auth}\n`);
      return;
    }
    const argv = shlex(browser).map((a) => (a === "%s" ? auth : a));
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", () => {});
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (method) log(method);
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            mcpCapabilities: { http: true },
            sessionCapabilities: { resume: {} },
            auth: { logout: {} },
          },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
          agentInfo: { name: process.env.FAKE_AGY_NAME ?? "antigravity-acp", title: "Google Antigravity", version: process.env.FAKE_AGY_VERSION ?? "1.3.0" },
        },
      });
    case "authenticate":
      return authenticate(id);
    case "logout":
      fs.rmSync(tokenFile, { force: true });
      return send({ id, result: {} });
    case "session/new":
      if (!signedIn()) return send({ id, error: { code: -32000, message: "Authentication required" } });
      return send({
        id,
        result: {
          sessionId: `agy_${crypto.randomBytes(4).toString("hex")}`,
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gemini-3-pro",
              options: [
                { value: "gemini-3-pro", name: "Gemini 3 Pro" },
                { value: "gemini-3-flash", name: "Gemini 3 Flash" },
              ],
            },
          ],
        },
      });
    case "session/load":
      return send({ id, result: {} });
    case "session/set_config_option":
    case "session/set_mode":
      return send({ id, result: {} });
    case "session/prompt": {
      const text = params.prompt.map((b) => b.text ?? "").join(" ");
      const reply = /env/.test(text)
        ? JSON.stringify({
            gemini: "GEMINI_API_KEY" in process.env,
            google: "GOOGLE_API_KEY" in process.env,
            gcp: "GOOGLE_CLOUD_PROJECT" in process.env,
            home: process.env.GEMINI_HOME,
            harness: process.env.ANTIGRAVITY_HARNESS_PATH,
            fileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE,
          })
        : `Antigravity says: ${text}`;
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "session/cancel":
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
