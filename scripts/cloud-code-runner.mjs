#!/usr/bin/env node
// @ts-check
/**
 * Cloud Juno Code — GitHub Actions runner driver (milestone CC2).
 *
 * Dispatched by the workflow in .github/workflows/code-runner.yml. Reads its
 * inputs from the environment, pulls the task's runner-context from Juno,
 * clones the target repo, drives the vendored agent core (runner/agent-core)
 * with the task prompt, streams progress back as task events, and opens a pull
 * request with whatever the agent changed.
 *
 * SECURITY — this process executes arbitrary agent-authored bash as the SAME OS
 * uid as this driver. It therefore NEVER receives .env, the database URL,
 * AUTH_SECRET, or any provider API key. The credential design keeps the runner
 * holding NOTHING the agent can weaponize during the agent phase:
 *
 *  - The only credential handed in via the (public) workflow input is a one-time
 *    `ccx_` EXCHANGE code. It is redeemed ONCE, at start, for a real `cct_` task
 *    token + a GitHub clone token (GET runner-context). runner-context single-
 *    uses it, so after that the exchange code — the only Juno secret left in this
 *    process's environment — is INERT: it can no longer fetch the clone token or
 *    anything else.
 *  - The live secrets (the `cct_` task token and the clone token) live ONLY in
 *    this driver's JS memory. They are NEVER written to process.env, a file, a
 *    command line, or .git/config. Git auth flows through a transient GIT_ASKPASS
 *    helper that exists ONLY during clone/push and is deleted before any agent
 *    bash runs.
 *  - Before the agent phase we hand the agent a HARD-SCRUBBED env (allowlist
 *    only) AND strip CI-runtime + secret-shaped vars from this driver's own
 *    process.env, so even reading the driver's /proc/environ yields no usable
 *    credential.
 *
 * The DRIVER (not the agent) streams events and proxies /api/agent using the
 * `cct_` token from memory — provider calls proxy through Juno's
 * /api/agent/<provider>, so no provider key ever touches this VM (see
 * runner/agent-core/src/providers/proxy.ts, the vendored `authorization` field).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentSession, createProxyProvider } from "../runner/agent-core/dist/index.js";

const execFileAsync = promisify(execFile);

// ─── Inputs ──────────────────────────────────────────────────────────────────

const TASK_ID = requireEnv("JUNO_TASK_ID");
const EXCHANGE_CODE = requireEnv("JUNO_EXCHANGE_CODE"); // one-time; redeemed at runner-context only
const CALLBACK_BASE = requireEnv("JUNO_CALLBACK_BASE").replace(/\/+$/, ""); // origin, no /api
const INPUT_REPO_OWNER = process.env.JUNO_REPO_OWNER ?? "";
const INPUT_REPO_NAME = process.env.JUNO_REPO_NAME ?? "";
const INPUT_BASE_REF = process.env.JUNO_BASE_REF ?? ""; // empty = repo default branch

const RUNNER_TEMP = process.env.RUNNER_TEMP || os.tmpdir();
/** Transient git askpass helper — written only around clone/push, deleted before
 *  any agent bash runs so no credential material sits on the shared FS. */
const ASKPASS_PATH = path.join(RUNNER_TEMP, "juno-askpass.sh");

/** Secrets to scrub from every log line + event payload. Filled as we learn them. */
const SECRETS = new Set([EXCHANGE_CODE]);

/** The fresh per-task `cct_` bearer (set once runner-context returns) — auth for
 *  every callback after the exchange, including the fatal-handler's failure post.
 *  Held ONLY here in memory, never in process.env or on disk. */
let FRESH_TOKEN = null;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

/** Replace every known secret with a fixed marker. Always run before logging. */
function redact(value) {
  let s = typeof value === "string" ? value : safeString(value);
  for (const secret of SECRETS) {
    if (secret && secret.length >= 6) s = s.split(secret).join("***");
  }
  return s;
}

function safeString(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

function log(...parts) {
  console.log("[cloud-code]", ...parts.map((p) => redact(p)));
}

// ─── Juno callback API (task-bearer authenticated) ───────────────────────────

function apiUrl(pathname) {
  return `${CALLBACK_BASE}${pathname}`;
}

async function junoFetch(pathname, token, init = {}) {
  const res = await fetch(apiUrl(pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function getRunnerContext() {
  const res = await junoFetch(`/api/code/tasks/${TASK_ID}/runner-context`, EXCHANGE_CODE, {
    method: "GET",
  });
  if (!res.ok) {
    throw new Error(`runner-context failed: HTTP ${res.status} ${redact(await res.text().catch(() => ""))}`);
  }
  return /** @type {any} */ (await res.json());
}

// ─── Event streaming (batched) ───────────────────────────────────────────────

const MAX_BODY_BYTES = 240 * 1024; // stay clear of the route's 256KB reject
const FLUSH_INTERVAL_MS = 750;
const FLUSH_AT_COUNT = 20;

/**
 * Buffers task events and flushes them to POST /events, chunking so no single
 * request exceeds the body cap. Also surfaces any control events (cancel) the
 * server returns so the runner can stop a cancelled task.
 */
class EventSink {
  constructor(token) {
    this.token = token;
    /** @type {{kind:string, payload:Record<string,unknown>}[]} */
    this.queue = [];
    this.afterControlSeq = 0;
    this.cancelled = false;
    this.flushing = Promise.resolve();
    this.timer = null;
    /** Rolling assistant-prose buffer; coalesced into one `text` event so a
     *  chatty turn's stream deltas don't become hundreds of tiny events. */
    this.textBuffer = "";
  }

  push(kind, payload) {
    // Any non-text event flushes buffered prose first to preserve ordering.
    if (kind !== "text") this.flushText();
    this.queue.push({ kind, payload: redactPayload(payload) });
    if (this.queue.length >= FLUSH_AT_COUNT) this.kick();
    else this.scheduleFlush();
  }

  appendText(delta) {
    this.textBuffer += delta;
    if (this.textBuffer.length >= 1024) this.flushText();
  }

  flushText() {
    if (!this.textBuffer) return;
    const text = this.textBuffer;
    this.textBuffer = "";
    this.push("text", { text });
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.kick(), FLUSH_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  kick() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = this.flushing.then(() => this.flush()).catch((err) => log("flush error:", err));
  }

  /** Drain the queue. `finalStatus` is only sent on the last, terminal flush. */
  async flush(finalStatus) {
    const batch = this.queue;
    this.queue = [];
    // Split into body-size-bounded chunks; attach status only to the last one.
    const chunks = chunkBySize(batch, MAX_BODY_BYTES);
    if (chunks.length === 0 && finalStatus) chunks.push([]);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.post(chunks[i], isLast ? finalStatus : undefined);
    }
  }

  async post(events, status) {
    const body = JSON.stringify({ events, afterControlSeq: this.afterControlSeq, ...(status ? { status } : {}) });
    let res;
    try {
      res = await junoFetch(`/api/code/tasks/${TASK_ID}/events`, this.token, { method: "POST", body });
    } catch (err) {
      log("events POST network error:", err);
      return;
    }
    if (!res.ok) {
      log(`events POST HTTP ${res.status}`, await res.text().catch(() => ""));
      return;
    }
    const data = /** @type {any} */ (await res.json().catch(() => ({})));
    for (const ctl of data?.control ?? []) {
      if (typeof ctl?.seq === "number") this.afterControlSeq = Math.max(this.afterControlSeq, ctl.seq);
      if (ctl?.kind === "cancel_request") this.cancelled = true;
    }
  }

  /** Final flush + terminal status in one drain. */
  async finalize(status) {
    this.flushText();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flushing.catch(() => {});
    await this.flush(status);
  }
}

/** Redact any string field of an event payload as defence-in-depth. */
function redactPayload(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = typeof v === "string" ? redact(v) : v;
  }
  return out;
}

function chunkBySize(events, maxBytes) {
  const chunks = [];
  let cur = [];
  let curBytes = 2; // "[]"
  for (const ev of events) {
    const size = Buffer.byteLength(JSON.stringify(ev)) + 1;
    if (cur.length > 0 && curBytes + size > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(ev);
    curBytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// ─── Git plumbing (token-safe via a TRANSIENT GIT_ASKPASS) ───────────────────

/**
 * Write a tiny askpass helper that echoes the token from an env var, so the
 * clone token never appears in argv, .git/config, or process listings. Written
 * only around clone/push and removed before the agent runs (see removeAskpass).
 */
function writeAskpass() {
  fs.writeFileSync(ASKPASS_PATH, '#!/bin/sh\nprintf "%s" "$JUNO_GIT_TOKEN"\n', { mode: 0o700 });
}

/** Delete the askpass helper so no git credential material is on the shared FS
 *  while untrusted agent bash is running. */
function removeAskpass() {
  try {
    fs.rmSync(ASKPASS_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * A git env carrying the clone token via GIT_ASKPASS. The token lives ONLY in
 * this returned object (passed to execFile), never in process.env — so it stays
 * out of the driver's /proc/environ. Requires writeAskpass() to have run.
 */
function gitEnvWith(cloneToken) {
  return {
    ...process.env,
    GIT_ASKPASS: ASKPASS_PATH,
    JUNO_GIT_TOKEN: cloneToken,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run git, capturing output; token stays in env, output is redacted by callers. */
async function git(args, { cwd, env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code, message: e.message };
  }
}

// ─── Mapping the agent's events onto the task event log ──────────────────────

function riskToTaskRisk(risk) {
  if (risk === "sensitive") return "destructive";
  if (risk === "command") return "outside";
  return "neutral";
}

/** Human one-liner for a tool call (matches docs/code-remote.md examples). */
function summarizeTool(name, input) {
  const p = input && typeof input === "object" ? /** @type {any} */ (input) : {};
  switch (name) {
    case "bash":
      return `$ ${String(p.command ?? "").slice(0, 200)}`;
    case "read_file":
      return `Read ${p.path ?? ""}`;
    case "write_file":
      return `Write ${p.path ?? ""}`;
    case "edit_file":
      return `Edit ${p.path ?? ""}`;
    case "glob":
      return `Glob ${p.pattern ?? ""}`;
    case "grep":
      return `Grep /${p.pattern ?? ""}/${p.glob ? ` in ${p.glob}` : ""}`;
    default:
      return name;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`starting task ${TASK_ID}`);

  // 1. THE EXCHANGE (once): redeem the one-time ccx_ code for a real cct_ task
  //    token + clone token. Both live ONLY in these JS variables from here on —
  //    never written to process.env, a file, or a command line. runner-context
  //    single-uses the exchange code, so the ccx_ still sitting in our env is now
  //    inert (it can't be replayed to fetch the clone token again).
  const ctx = await getRunnerContext();
  const freshToken = String(ctx.taskToken ?? "");
  const cloneToken = String(ctx.cloneToken ?? "");
  if (!freshToken) throw new Error("runner-context did not return a fresh taskToken");
  if (!cloneToken) throw new Error("runner-context did not return a cloneToken");
  FRESH_TOKEN = freshToken;
  SECRETS.add(freshToken);
  SECRETS.add(cloneToken);

  const prompt = String(ctx.prompt ?? "");
  const repoOwner = String(ctx.repoOwner || INPUT_REPO_OWNER);
  const repoName = String(ctx.repoName || INPUT_REPO_NAME);
  const baseRef = String(ctx.baseRef || INPUT_BASE_REF); // may be empty -> default branch
  const agentBaseUrl = String(ctx.agentBaseUrl || `${CALLBACK_BASE}/api/agent`);
  const models = Array.isArray(ctx.models) ? ctx.models : [];
  if (!repoOwner || !repoName) throw new Error("runner-context is missing repoOwner/repoName");

  const chosen = models.find((m) => m && m.available) ?? models[0];
  if (!chosen) throw new Error("runner-context returned no models to run");
  log(`repo ${repoOwner}/${repoName}, model ${chosen.provider}/${chosen.model}, baseRef "${baseRef || "(default)"}"`);

  const sink = new EventSink(freshToken);

  // 2. Claim -> running, then announce.
  const claimRes = await junoFetch(`/api/code/tasks/${TASK_ID}/claim`, freshToken, { method: "POST", body: "{}" });
  if (!claimRes.ok) {
    throw new Error(`claim failed: HTTP ${claimRes.status} ${redact(await claimRes.text().catch(() => ""))}`);
  }
  sink.push("user", { text: prompt });
  sink.push("text", { text: `Cloud Code run started on ${repoOwner}/${repoName} with ${chosen.label ?? chosen.model}.\n` });
  await sink.flush("running");

  // 3. Clone the repo into ./workdir using a TRANSIENT askpass (token never in
  //    argv or .git/config). We tear the askpass down immediately after, so no
  //    git credential material is on disk during the agent phase.
  writeAskpass();
  const cloneGitEnv = gitEnvWith(cloneToken);
  const workdir = path.join(RUNNER_TEMP, "workdir"); // outside the runner checkout
  fs.rmSync(workdir, { recursive: true, force: true });
  const cloneUrl = `https://x-access-token@github.com/${repoOwner}/${repoName}.git`;
  const cloneArgs = ["clone", "--depth", "50"];
  if (baseRef) cloneArgs.push("--branch", baseRef);
  cloneArgs.push(cloneUrl, workdir);
  const cloned = await git(cloneArgs, { env: cloneGitEnv });
  if (!cloned.ok) throw new Error(`git clone failed: ${redact(cloned.stderr || cloned.message)}`);

  await git(["config", "user.name", "Juno Code"], { cwd: workdir, env: cloneGitEnv });
  await git(["config", "user.email", "noreply@chat.liams.dev"], { cwd: workdir, env: cloneGitEnv });

  // Resolve the branch we based off (for the PR base when baseRef was empty).
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workdir, env: cloneGitEnv });
  const baseBranch = baseRef || (head.ok ? head.stdout.trim() : "main");

  // TEAR DOWN git credential material before running any agent bash: delete the
  // askpass helper and drop our reference to the clone-bearing env. From here
  // until the agent finishes, the clone token exists ONLY in the `cloneToken`
  // JS variable — nothing the agent's shell can read.
  removeAskpass();

  // 4. Build the agent session against the backend proxy (task-bearer auth). The
  //    provider adapter is driven by THIS process (the driver), which is trusted
  //    to hold the cct_ token; the agent's tool calls never see it.
  const junoHome = path.join(RUNNER_TEMP, "juno-home");
  fs.mkdirSync(junoHome, { recursive: true });
  process.env.JUNO_HOME = junoHome; // read by the driver's SessionStore (not a secret)

  const provider = createProxyProvider(
    { baseUrl: agentBaseUrl, cookie: "", authorization: `Bearer ${freshToken}`, models },
    `backend/${chosen.provider}`,
  );

  // Harden the DRIVER's own env (defence in depth for /proc/environ) and build a
  // minimal, secret-free env for agent-spawned shells. The agent needs zero Juno
  // secrets — it only runs build/test tools in the workdir.
  hardenDriverEnv();
  const agentEnv = buildAgentEnv();

  const session = AgentSession.create({
    provider,
    cwd: workdir,
    model: chosen.model,
    mode: "full", // headless: the engine still hard-gates "sensitive" -> requestApproval
    // The bash tool spawns children with THIS env, not process.env — so agent
    // shell receives none of {exchange code, task token, clone token, JUNO_*,
    // GIT_ASKPASS, ACTIONS_*}. See runner/agent-core/VENDORED.md (divergence #3).
    env: agentEnv,
    callbacks: {
      onEvent: (event) => onAgentEvent(sink, event),
      // No human is attached; auto-approve, but log an audit trail. The agent
      // holds no secrets and runs on a throwaway VM, so this is safe here.
      requestApproval: async (request) => {
        sink.push("approval_request", {
          requestId: request.callId,
          summary: request.summary,
          risk: riskToTaskRisk(request.risk),
        });
        sink.push("approval_response", { requestId: request.callId, approve: true });
        return "allow";
      },
    },
  });

  // 5. Drive the agent, watching for a cancel control event.
  let finalStopReason = "end_turn";
  const cancelWatch = setInterval(() => {
    if (sink.cancelled) session.abort();
  }, 1000);
  if (typeof cancelWatch.unref === "function") cancelWatch.unref();
  try {
    await session.prompt(prompt);
  } finally {
    clearInterval(cancelWatch);
  }
  finalStopReason = sink.cancelled ? "cancelled" : finalStopReason;
  sink.flushText();
  await sink.flush();

  if (sink.cancelled) {
    sink.push("error", { message: "Cancelled by user before completion." });
    await sink.finalize("cancelled");
    log("task cancelled");
    return;
  }

  // 6. The agent phase is over — re-establish git credentials from the in-memory
  //    clone token for commit/push, then stage changes; if none, finish cleanly.
  writeAskpass();
  const gitEnv = gitEnvWith(cloneToken);
  await git(["add", "-A"], { cwd: workdir, env: gitEnv });
  const status = await git(["status", "--porcelain"], { cwd: workdir, env: gitEnv });
  if (status.ok && status.stdout.trim() === "") {
    sink.push("text", { text: "The agent made no file changes, so there is nothing to open a PR for." });
    sink.push("done", { finishReason: "no_changes" });
    await sink.finalize("done");
    log("no changes; done");
    return;
  }

  // Emit per-file change events (accurate counts + capped unified diff).
  await emitFileChanges(sink, workdir, gitEnv);

  // 7. Branch, commit, push, open PR.
  const shortId = TASK_ID.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "task";
  const branch = `juno/cloud-${shortId}`;
  const title = firstLine(prompt) || `Juno Cloud Code task ${shortId}`;

  const checkout = await git(["checkout", "-b", branch], { cwd: workdir, env: gitEnv });
  if (!checkout.ok) throw new Error(`could not create branch: ${redact(checkout.stderr || checkout.message)}`);

  const commitMsg = `${title}\n\nGenerated by Juno Cloud Code (task ${TASK_ID}).`;
  const committed = await git(["commit", "-m", commitMsg], { cwd: workdir, env: gitEnv });
  if (!committed.ok) throw new Error(`git commit failed: ${redact(committed.stderr || committed.message)}`);

  const pushed = await git(["push", "-u", "origin", branch], { cwd: workdir, env: gitEnv });
  if (!pushed.ok) {
    throw new Error(`git push rejected: ${redact(pushed.stderr || pushed.message)}`);
  }

  const prUrl = await openPullRequest({ repoOwner, repoName, cloneToken, branch, baseBranch, title, prompt });

  sink.push("text", {
    text: prUrl
      ? `Opened pull request: ${prUrl}`
      : `Pushed branch ${branch}, but the pull request could not be created automatically.`,
  });
  sink.push("done", { finishReason: finalStopReason, ...(prUrl ? { prUrl } : {}) });
  await sink.finalize("done");
  log(prUrl ? `done, PR ${prUrl}` : `done, pushed ${branch} (no PR)`);
}

/** Translate one AgentEvent into task events. */
function onAgentEvent(sink, event) {
  switch (event.type) {
    case "assistant_delta":
      if (event.text) sink.appendText(event.text);
      break;
    case "tool_finished": {
      const summary = summarizeTool(event.name, event.input);
      const suffix = event.name === "bash" ? (event.isError ? " — failed" : " — ok") : "";
      sink.push("tool", {
        name: event.name,
        summary: `${summary}${suffix}`,
        ...(event.output ? { detail: String(event.output).slice(0, 2000) } : {}),
      });
      break;
    }
    case "tool_denied":
      sink.push("tool", { name: event.name, summary: `Denied ${event.name}: ${event.reason}` });
      break;
    case "error":
      sink.push("error", { message: event.message });
      break;
    default:
      // session_started / turn_started / assistant_message / tool_started /
      // approval_* / files_changed / mode_changed / turn_finished carry no
      // extra transcript value here (deltas + git diff cover the content).
      break;
  }
}

/** Emit file_change events from the staged diff (capped diff per docs). */
async function emitFileChanges(sink, workdir, gitEnv) {
  const DIFF_CAP = 40 * 1024;
  const numstat = await git(["diff", "--cached", "--numstat"], { cwd: workdir, env: gitEnv });
  const nameStatus = await git(["diff", "--cached", "--name-status"], { cwd: workdir, env: gitEnv });
  if (!numstat.ok) return;

  const statusByPath = new Map();
  for (const line of nameStatus.stdout.split("\n")) {
    const m = line.match(/^([ACDMRT])\S*\t(.+)$/);
    if (m) {
      const file = m[2].includes("\t") ? m[2].split("\t").pop() : m[2];
      statusByPath.set(file, m[1]);
    }
  }
  const changeKindOf = (code) => (code === "A" ? "create" : code === "D" ? "delete" : "edit");

  for (const line of numstat.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, remRaw, ...rest] = parts;
    const file = rest.join("\t");
    if (!file) continue;
    const added = addRaw === "-" ? 0 : Number(addRaw) || 0;
    const removed = remRaw === "-" ? 0 : Number(remRaw) || 0;
    const changeKind = changeKindOf(statusByPath.get(file));
    const diffRes = await git(["diff", "--cached", "--", file], { cwd: workdir, env: gitEnv });
    let diff = diffRes.ok ? diffRes.stdout : "";
    if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + "\n…[diff truncated]";
    sink.push("file_change", { path: file, changeKind, added, removed, ...(diff ? { diff } : {}) });
  }
}

async function openPullRequest({ repoOwner, repoName, cloneToken, branch, baseBranch, title, prompt }) {
  const body =
    `This pull request was generated by **Juno Cloud Code**.\n\n` +
    `**Task prompt**\n\n> ${firstLine(prompt).slice(0, 500)}\n\n` +
    `Branch \`${branch}\` targets \`${baseBranch}\`. Review before merging.`;
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cloneToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Juno-Cloud-Code",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title: title.slice(0, 200), head: branch, base: baseBranch, body }),
    });
  } catch (err) {
    log("PR creation network error:", err);
    return null;
  }
  if (res.ok) {
    const data = /** @type {any} */ (await res.json().catch(() => ({})));
    return typeof data.html_url === "string" ? data.html_url : null;
  }
  log(`PR creation HTTP ${res.status}`, await res.text().catch(() => ""));
  return null;
}

/** Env var names safe to expose to agent-spawned shells: enough for build/test
 *  tooling to work, nothing Juno- or CI-secret. */
const AGENT_ENV_ALLOW = [
  "PATH",
  "HOME",
  "JUNO_HOME", // agent-core session store dir (not a secret)
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
];

/**
 * Build the minimal, secret-free environment handed to agent-spawned shells via
 * AgentSession's `env` option. An allowlist (not a denylist) so a
 * newly-introduced secret-shaped var can never leak by omission: only the names
 * above are copied through; everything else — the spent exchange code, JUNO_*,
 * GIT_ASKPASS, ACTIONS_* — is simply absent.
 */
function buildAgentEnv() {
  const env = {};
  for (const name of AGENT_ENV_ALLOW) {
    if (process.env[name] != null) env[name] = process.env[name];
  }
  return env;
}

/**
 * Defence in depth for the driver's OWN /proc/environ: strip CI-runtime and
 * secret-shaped vars from process.env before the agent runs. The driver already
 * captured everything it needs into module consts (TASK_ID, CALLBACK_BASE, …)
 * and holds its live secrets (task token, clone token) only in JS memory, so
 * this never breaks the driver — it just ensures an agent that reads the
 * driver's environ finds no usable credential (the spent ccx_ is inert anyway).
 */
function hardenDriverEnv() {
  const keep = new Set(AGENT_ENV_ALLOW).add("RUNNER_TEMP");
  const denyRe = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|_KEY|PRIVATE|SESSION)/i;
  for (const name of Object.keys(process.env)) {
    if (keep.has(name)) continue;
    if (
      name === "JUNO_EXCHANGE_CODE" ||
      name.startsWith("JUNO_") ||
      name.startsWith("ACTIONS_") ||
      name.startsWith("GIT") ||
      name === "GITHUB_TOKEN" ||
      denyRe.test(name)
    ) {
      delete process.env[name];
    }
  }
}

function firstLine(text) {
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 120);
  }
  return "";
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main()
  .then(() => {
    removeAskpass();
    process.exit(0);
  })
  .catch(async (err) => {
    log("FATAL:", err);
    // The DRIVER posts its own terminal `failed` event here — it holds the cct_
    // token in memory, so no on-disk auth handoff is needed. This covers every
    // catchable error. For a HARD crash where this process dies before reaching
    // here (OOM/kill/timeout) we deliberately leave NO token on disk: the task
    // stays 'running' until the workflow's timeout-minutes reaps the job (a
    // server-side stuck-task sweep is a documented follow-up).
    try {
      if (FRESH_TOKEN) {
        await fetch(apiUrl(`/api/code/tasks/${TASK_ID}/events`), {
          method: "POST",
          headers: { Authorization: `Bearer ${FRESH_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            events: [{ kind: "error", payload: { message: redact(err?.message ?? String(err)) } }],
            status: "failed",
            afterControlSeq: 0,
          }),
        });
      }
    } catch (postErr) {
      log("could not post failure status:", postErr);
    }
    removeAskpass();
    process.exit(1);
  });
