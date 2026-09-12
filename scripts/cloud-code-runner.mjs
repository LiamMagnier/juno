#!/usr/bin/env node
// @ts-check
/**
 * Cloud Juno Code — GitHub Actions runner driver (milestone CC2).
 *
 * Dispatched by the workflow in .github/workflows/code-runner.yml. Reads its
 * two inputs (task id, callback origin) from the environment — the repository
 * is deliberately NOT one of them — pulls the task's runner-context from Juno,
 * clones the target repo (or the branch a previous run of the same
 * conversation pushed), seeds the agent with the conversation so far, drives
 * the vendored agent core (runner/agent-core) with the task prompt — taking
 * mid-run instructions between steps — streams progress back as task events,
 * and opens a pull request with whatever the agent changed, or pushes to the
 * one the conversation already has.
 *
 * SECURITY — this process executes arbitrary agent-authored bash as the SAME OS
 * uid as this driver. It therefore NEVER receives .env, the database URL,
 * AUTH_SECRET, or any provider API key. The credential design keeps the runner
 * holding NOTHING the agent can weaponize during the agent phase:
 *
 *  - NO credential rides the (public) workflow inputs. The driver instead fetches
 *    a GitHub Actions OIDC JWT at runtime from the auto-provisioned token endpoint
 *    (ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience
 *    "juno-cloud-code") and presents it as `Authorization: Bearer <jwt>` on its
 *    ONE bootstrap call, GET runner-context. GitHub signs the JWT; Juno verifies
 *    the signature + repo + workflow claims and hands back a real `cct_` task token
 *    + a GitHub clone token. The JWT is short-lived and never logged; the request
 *    token GitHub auto-masks. No Juno secret ever appears in the public log.
 *  - The live secrets (the `cct_` task token and the clone token) live ONLY in
 *    this driver's JS memory. They are NEVER written to process.env, a file, a
 *    command line, or .git/config. Git auth flows through a transient GIT_ASKPASS
 *    helper that exists ONLY during clone/push and is deleted before any agent
 *    bash runs.
 *  - Before the agent phase we hand the agent a HARD-SCRUBBED env (allowlist
 *    only) AND strip CI-runtime + secret-shaped vars from this driver's own
 *    process.env (including ACTIONS_* and the OIDC request token), so even reading
 *    the driver's /proc/environ yields no usable credential.
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
import { containerSandboxFromEnv } from "../runner/agent-core/dist/tools/container-sandbox.js";
import {
  DurableOutbox,
  backoffDelayMs,
  isRetryableStatus,
  parseRetryAfter,
} from "./lib/runner-outbox.mjs";

const execFileAsync = promisify(execFile);

// ─── Inputs ──────────────────────────────────────────────────────────────────

const TASK_ID = requireEnv("JUNO_TASK_ID");
const CALLBACK_BASE = requireEnv("JUNO_CALLBACK_BASE").replace(/\/+$/, ""); // origin, no /api

/**
 * Identifies THIS attempt at the task, so event idempotency keys are unique
 * per run rather than per task.
 *
 * A retried workflow re-runs the same task id from sequence 1. Keying on the
 * task alone would make the second attempt's events collide with the first's
 * and be discarded as duplicates — the retry would appear to produce nothing.
 * GitHub's run id and attempt number identify the attempt exactly; the random
 * fallback covers a local invocation.
 */
const RUN_NONCE =
  process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : Math.random().toString(36).slice(2, 10);

/** Audience the runner requests in its OIDC token; the backend requires an exact
 *  match (see src/lib/github-oidc.ts). */
const OIDC_AUDIENCE = "juno-cloud-code";
/*
 * The repository is NOT an input. It used to arrive as JUNO_REPO_OWNER /
 * JUNO_REPO_NAME / JUNO_BASE_REF workflow inputs, which GitHub prints into
 * this run's public log — so every private repo a user pointed a cloud run at
 * was named in public. runner-context returns all three over the
 * authenticated handshake below, and it is the only source now.
 */

/** The six effort tiers agent-core accepts (providers/types.ts). Anything else
 *  from runner-context is dropped rather than sent to a provider that 400s. */
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * How long the runner may go without hearing about controls before it asks.
 *
 * Controls (cancel, steer) ride the response to an events POST, and the
 * runner posts when it has events — which during a long tool call is never.
 * When nothing has synced for this long the watcher reads the controls route
 * instead, so an instruction typed during a two-minute test run reaches the
 * agent at its next step rather than at the end of the suite.
 */
const CONTROL_SYNC_STALE_MS = 2_000;
const CONTROL_WATCH_MS = 1_000;

const RUNNER_TEMP = process.env.RUNNER_TEMP || os.tmpdir();
/** Transient git askpass helper — written only around clone/push, deleted before
 *  any agent bash runs so no credential material sits on the shared FS. */
const ASKPASS_PATH = path.join(RUNNER_TEMP, "juno-askpass.sh");

/** Secrets to scrub from every log line + event payload. Filled as we learn them
 *  (the OIDC JWT, then the task + clone tokens). */
const SECRETS = new Set();

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

/**
 * Fetch this job's GitHub Actions OIDC JWT. Available because the workflow grants
 * `id-token: write`, which provisions ACTIONS_ID_TOKEN_REQUEST_URL and
 * ACTIONS_ID_TOKEN_REQUEST_TOKEN. The request token is GitHub-issued + auto-masked;
 * we never log it, and the returned JWT is added to SECRETS by the caller. NO
 * credential rides the workflow inputs — this is the runner's sole authenticator.
 */
async function fetchOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new Error("OIDC token endpoint unavailable (workflow needs permissions: id-token: write)");
  }
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OIDC token request failed: HTTP ${res.status}`);
  }
  const data = /** @type {any} */ (await res.json().catch(() => ({})));
  const jwt = typeof data.value === "string" ? data.value : "";
  if (!jwt) throw new Error("OIDC token response missing value");
  return jwt;
}

async function getRunnerContext(oidcToken) {
  const res = await junoFetch(`/api/code/tasks/${TASK_ID}/runner-context`, oidcToken, {
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
    /**
     * Durable buffer. Events leave it only when the backend acknowledges them,
     * so a failed POST is retried instead of dropped — which is what the old
     * `this.queue = []`-before-post did on every network blip.
     */
    this.outbox = new DurableOutbox({ runId: `${TASK_ID}:${RUN_NONCE}` });
    this.afterControlSeq = 0;
    this.cancelled = false;
    /** Called with each `steer` control as it arrives; set once the session exists. */
    this.onSteer = null;
    /** Steers that arrived before the session existed (during the clone). */
    this.steerBacklog = [];
    /** When controls were last read, by a POST or a poll — see pollControls. */
    this.lastControlSyncAt = Date.now();
    this.polling = false;
    this.flushing = Promise.resolve();
    this.timer = null;
    /** Rolling assistant-prose buffer; coalesced into one `text` event so a
     *  chatty turn's stream deltas don't become hundreds of tiny events. */
    this.textBuffer = "";
  }

  push(kind, payload) {
    // Any non-text event flushes buffered prose first to preserve ordering.
    if (kind !== "text") this.flushText();
    this.outbox.add(kind, redactPayload(payload));
    if (this.outbox.size >= FLUSH_AT_COUNT) this.kick();
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

  /**
   * Drain the outbox. `finalStatus` is only sent on the last, terminal flush.
   *
   * Events are removed only once the backend has acknowledged them, so an
   * outage leaves them buffered for the next attempt instead of discarding
   * them. The terminal flush retries hardest: the status is the one fact that
   * decides whether the task shows as finished or as stuck forever.
   */
  async flush(finalStatus) {
    const notice = this.outbox.dropNotice();
    if (notice) {
      this.outbox.dropped = 0;
      this.outbox.add(notice.kind, notice.payload);
    }

    for (;;) {
      const batch = chunkBySize(this.outbox.peek(), MAX_BODY_BYTES)[0] ?? [];
      if (batch.length === 0 && !finalStatus) return;

      const isFinalChunk = finalStatus !== undefined && batch.length === this.outbox.size;
      const ok = await this.postWithRetry(batch, isFinalChunk ? finalStatus : undefined, {
        maxAttempts: finalStatus === undefined ? 3 : 8,
      });
      if (!ok) return; // Kept in the outbox; the next flush tries again.

      this.outbox.acknowledge(batch);
      if (this.outbox.size === 0) return;
    }
  }

  /**
   * One batch, retried with jittered exponential backoff.
   *
   * @returns {Promise<boolean>} whether the batch was acknowledged.
   */
  async postWithRetry(events, status, { maxAttempts = 3 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await this.post(events, status);
      if (outcome.ok) return true;
      if (!isRetryableStatus(outcome.status)) {
        // A malformed body, a revoked token or a deleted task will never
        // succeed. Retrying keeps a dead runner hammering the backend until
        // the job times out, so drop these and say so.
        log(`events POST permanently rejected (HTTP ${outcome.status}); dropping ${events.length} event(s)`);
        this.outbox.acknowledge(events);
        return true;
      }
      if (attempt === maxAttempts) {
        log(`events POST failed after ${attempt} attempt(s); ${this.outbox.size} event(s) still buffered`);
        return false;
      }
      const delay = backoffDelayMs(attempt, { retryAfterSeconds: outcome.retryAfterSeconds });
      log(`events POST retry ${attempt}/${maxAttempts} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  }

  /** @returns {Promise<{ok:boolean, status:number|null, retryAfterSeconds:number|null}>} */
  async post(events, status) {
    const body = JSON.stringify({
      events,
      afterControlSeq: this.afterControlSeq,
      ...(status ? { status } : {}),
    });
    let res;
    try {
      res = await junoFetch(`/api/code/tasks/${TASK_ID}/events`, this.token, { method: "POST", body });
    } catch (err) {
      log("events POST network error:", err);
      return { ok: false, status: null, retryAfterSeconds: null };
    }
    if (!res.ok) {
      log(`events POST HTTP ${res.status}`, await res.text().catch(() => ""));
      return {
        ok: false,
        status: res.status,
        retryAfterSeconds: parseRetryAfter(res.headers?.get?.("retry-after")),
      };
    }
    const data = /** @type {any} */ (await res.json().catch(() => ({})));
    this.handleControls(data?.control);
    return { ok: true, status: res.status, retryAfterSeconds: null };
  }

  /**
   * Read the controls the backend is holding for this task without posting.
   * Skipped while a read is in flight, and skipped when a POST synced them
   * moments ago — see CONTROL_SYNC_STALE_MS.
   */
  async pollControls() {
    if (this.polling || Date.now() - this.lastControlSyncAt < CONTROL_SYNC_STALE_MS) return;
    this.polling = true;
    try {
      const res = await junoFetch(
        `/api/code/tasks/${TASK_ID}/controls?afterSeq=${this.afterControlSeq}`,
        this.token,
        { method: "GET" },
      );
      if (!res.ok) return;
      const data = /** @type {any} */ (await res.json().catch(() => ({})));
      this.handleControls(data?.control);
    } catch {
      // Transient. The next tick, or the next events POST, reads them again.
    } finally {
      this.polling = false;
    }
  }

  /**
   * Act on controls, once each.
   *
   * A POST and a poll can return the same row — the cursor sent with one is
   * stale by the time the other answers — so a control is handled only when
   * its sequence number advances the cursor. Both paths land here, and the
   * function is synchronous, so the check cannot interleave with itself.
   */
  handleControls(list) {
    this.lastControlSyncAt = Date.now();
    for (const ctl of list ?? []) {
      if (typeof ctl?.seq !== "number" || ctl.seq <= this.afterControlSeq) continue;
      this.afterControlSeq = ctl.seq;
      if (ctl.kind === "cancel_request") this.cancelled = true;
      if (ctl.kind === "steer") {
        // A person's instruction for the running agent. Queued into the
        // session between steps (see the agent phase in main); the ack is
        // posted the moment the session takes it, never before.
        const requestId = typeof ctl.payload?.requestId === "string" ? ctl.payload.requestId : null;
        const text = typeof ctl.payload?.text === "string" ? ctl.payload.text.trim() : "";
        if (!requestId || !text) continue;
        const steer = { requestId, text };
        if (this.onSteer) this.onSteer(steer);
        else this.steerBacklog.push(steer);
      }
      /*
       * THE ROLLBACK VERBS (accept_change / reject_change / undo_change) ARE
       * DELIBERATELY NOT HANDLED HERE, AND THIS RUNNER MUST NOT ANNOUNCE
       * `rollback_ready`. The obvious implementation — announce after the first
       * file_change, then call session.revertFile / keepFile / undoLastTurn — was
       * tried against this file's actual control flow and produces a control that
       * lies. Three structural reasons, all checkable:
       *
       * 1. THERE IS NO MID-RUN WINDOW. `AgentSession.prompt()` is ONE turn (the
       *    whole tool loop runs inside `runAgentLoop`), this runner calls it
       *    exactly once, and agent-core emits `files_changed` only after that
       *    loop returns. So the earliest any file is visible is milliseconds
       *    before the agent phase ends — there is no point during the run at
       *    which a reader could intervene.
       * 2. THE COMMIT HAS ALREADY HAPPENED. `git add -A` runs before
       *    emitFileChanges, and commit/push/PR follow immediately. A revert
       *    landing in the seconds-long push window would change the working tree
       *    but NOT the staged content already captured — the PR would still
       *    contain the change while the UI said "Reverted". That is a false
       *    statement about the only artifact the reader actually gets.
       * 3. "UNDO LAST TURN" WOULD MEAN "UNDO THE WHOLE TASK". With a single
       *    turn, `undoLastTurn()` pops everything the run wrote, which is not
       *    what the button says and not what anyone pressing it expects.
       *
       * After `finalize` the task is terminal and the rollback route correctly
       * refuses with 409, so presses arriving later are already handled honestly.
       *
       * Making this real needs a review window that this runner does not have:
       * emit file changes and hold BEFORE `git add -A`, wait a bounded time for
       * control events, then stage whatever survived. That is a product decision
       * about delaying every cloud PR, not a wiring fix — so it is left undone
       * rather than faked. Until then no host announces, and the web renders no
       * rollback controls at all, which is the designed behaviour and not a gap.
       */
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

  // 1. THE HANDSHAKE (once): fetch a GitHub-signed OIDC JWT and present it to
  //    runner-context, which verifies it (signature + repo + workflow claims) and
  //    returns a real cct_ task token + clone token. NO credential rode the
  //    workflow inputs; the JWT is short-lived and never logged. The task + clone
  //    tokens live ONLY in these JS variables from here on — never written to
  //    process.env, a file, or a command line. runner-context is single-use
  //    server-side (runnerClaimedAt), so this handoff cannot be replayed.
  const oidcToken = await fetchOidcToken();
  SECRETS.add(oidcToken);
  const ctx = await getRunnerContext(oidcToken);
  const freshToken = String(ctx.taskToken ?? "");
  const cloneToken = String(ctx.cloneToken ?? "");
  if (!freshToken) throw new Error("runner-context did not return a fresh taskToken");
  if (!cloneToken) throw new Error("runner-context did not return a cloneToken");
  FRESH_TOKEN = freshToken;
  SECRETS.add(freshToken);
  SECRETS.add(cloneToken);

  const prompt = String(ctx.prompt ?? "");
  const repoOwner = String(ctx.repoOwner ?? "");
  const repoName = String(ctx.repoName ?? "");
  const baseRef = String(ctx.baseRef ?? ""); // may be empty -> default branch
  const agentBaseUrl = String(ctx.agentBaseUrl || `${CALLBACK_BASE}/api/agent`);
  const models = Array.isArray(ctx.models) ? ctx.models : [];
  // The submitter's thinking effort, finally read. runner-context has returned
  // it since the column existed; nothing here ever looked at it.
  const reasoningEffort = REASONING_EFFORTS.has(ctx.reasoningEffort) ? ctx.reasoningEffort : undefined;
  if (!repoOwner || !repoName) throw new Error("runner-context is missing repoOwner/repoName");
  // The conversation so far, and the branch this run continues (see main's
  // step 3/7). Both absent on a first run, which behaves as it always has.
  const history = readHistory(ctx.history);
  const continuation = readContinuation(ctx.continuation);
  // Which credential runner-context handed over, for the PR's authorship: an
  // app-authored pull request still has to name the person it is for.
  const credentialSource = ctx.cloneCredential === "github_app" ? "github_app" : "oauth";
  const githubLogin =
    typeof ctx.githubLogin === "string" && /^[A-Za-z0-9-]{1,39}$/.test(ctx.githubLogin) ? ctx.githubLogin : null;

  const chosen = models.find((m) => m && m.available) ?? models[0];
  if (!chosen) throw new Error("runner-context returned no models to run");
  // The model only. The repository name stays out of this public log for the
  // same reason it stays out of the workflow inputs — and so does the branch.
  log(
    `model ${chosen.provider}/${chosen.model}, effort ${reasoningEffort ?? "(default)"}, ` +
      `credential ${credentialSource}, ${history.length} earlier turn(s)` +
      (continuation ? ", continuing an existing branch" : ""),
  );

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
  const cloneAt = (ref) => {
    const args = ["clone", "--depth", "50"];
    if (ref) args.push("--branch", ref);
    args.push(cloneUrl, workdir);
    return git(args, { env: cloneGitEnv });
  };
  // A continuation clones the branch it continues (runner-context sets
  // baseRef to it); a first run clones the base.
  let cloned = await cloneAt(baseRef);
  /*
   * THE BRANCH IS GONE. The commonest way: the pull request was merged with
   * "delete branch". The record says to continue it, so it is recreated
   * under the same name from the base the first run targeted — the task's
   * `branch` stays true, and the pull request search below finds no open
   * one and opens a new PR for the new commits, which is the right outcome
   * for work that resumes after a merge.
   */
  let branchMissing = false;
  if (!cloned.ok && continuation) {
    log("the branch this run continues is not on origin; starting from the base instead");
    branchMissing = true;
    fs.rmSync(workdir, { recursive: true, force: true });
    cloned = await cloneAt(continuation.baseRef);
  }
  if (!cloned.ok) throw new Error(`git clone failed: ${redact(cloned.stderr || cloned.message)}`);

  await git(["config", "user.name", "Juno Code"], { cwd: workdir, env: cloneGitEnv });
  await git(["config", "user.email", "noreply@chat.liams.dev"], { cwd: workdir, env: cloneGitEnv });

  // Resolve the branch a NEW pull request would target. First run: what was
  // cloned (the base, or the default branch when none was named). A
  // continuation: the base the first run targeted, else origin's default —
  // never the branch itself, which is what was cloned.
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workdir, env: cloneGitEnv });
  const originHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: workdir, env: cloneGitEnv });
  const originDefault = originHead.ok ? originHead.stdout.trim().replace(/^origin\//, "") : "";
  const baseBranch = continuation
    ? continuation.baseRef || originDefault || "main"
    : baseRef || (head.ok ? head.stdout.trim() : originDefault || "main");

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

  // Read the container configuration BEFORE hardening, and hold it in a const.
  //
  // Order is load-bearing and was wrong. hardenDriverEnv() deletes every JUNO_*
  // key that is not in AGENT_ENV_ALLOW, and AGENT_ENV_ALLOW contains only
  // JUNO_HOME — so it deleted JUNO_RUNNER_SANDBOX_IMAGE, which the workflow
  // sets at code-runner.yml:119, eighteen lines before anything read it.
  // containerSandboxFromEnv then returned null, `?? undefined` dropped it, and
  // agent-authored bash ran directly on the runner VM through /bin/bash -c.
  // Every comment below describing the container boundary was accurate about
  // the intent and wrong about what was happening.
  //
  // Reading first rather than adding the names to the allowlist: the allowlist
  // governs what an agent shell can see, and the sandbox configuration has no
  // business being visible from inside the sandbox it describes.
  const containerSandbox = containerSandboxFromEnv(process.env, workdir);
  if (!containerSandbox) {
    // Cloud Code executes model-authored shell commands without a human in the
    // loop. A missing Docker image is therefore a security failure, not a
    // reason to fall back to the GitHub runner host. Local development still
    // omits the option deliberately; this driver is the production cloud path.
    throw new Error(
      "Cloud Code runner: no container sandbox configured; refusing to run agent-authored commands on the runner host",
    );
  }

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
    // When JUNO_RUNNER_SANDBOX_IMAGE is set, agent bash runs in a container
    // holding ONLY the worktree: no tokens, no host environment, no network.
    // The driver stays outside it and keeps doing the clone, commit, push and
    // PR with its scoped credentials — which is what stops "the agent can run
    // arbitrary bash" from meaning "the agent can push anywhere the runner
    // can". Unset (local runs) the commands execute here, as before.
    containerSandbox: containerSandbox ?? undefined,
    // How hard to think, as the composer asked. Absent means Instant.
    ...(reasoningEffort ? { reasoningEffort } : {}),
    callbacks: {
      onEvent: (event) => onAgentEvent(sink, event),
      /*
       * No human is attached; auto-approve, and SAY SO. The agent holds no
       * secrets and runs inside a container on a throwaway VM, so allowing is
       * safe here — but this used to emit an `approval_request` followed in
       * the same batch by an `approval_response approve:true`, and the
       * transcript then read "Approval requested … Approved" as if somebody
       * had been asked. Nobody was. One tool row that names what happened is
       * the honest record; the risk rides along so a reader can still see
       * which commands the engine would have stopped a Mac on.
       */
      requestApproval: async (request) => {
        sink.push("tool", {
          name: "approval",
          summary: `Auto-allowed in sandbox: ${request.summary}`,
          risk: riskToTaskRisk(request.risk),
          autoAllowed: true,
          ...(request.agentLabel ? { agentLabel: request.agentLabel } : {}),
        });
        return "allow";
      },
    },
  });

  // The conversation so far, so this turn is read as the next one of it
  // rather than the first of a new one. runner-context already trimmed it.
  if (history.length > 0) {
    session.seedHistory(history);
    log(`seeded ${history.length} earlier turn(s) from the conversation`);
  }

  // 5. Drive the agent, watching for cancel and steer controls.
  //
  // A steer is queued into the session and folded into its NEXT step (see
  // AgentSession.queueUserMessage); the `user` row and the `steer_ack` are
  // posted only when the session has actually taken it, which is the one
  // moment "the run has your instruction" is true.
  const takeSteer = (steer) => {
    void session.queueUserMessage(steer.text).then(() => {
      sink.push("user", { text: steer.text, requestId: steer.requestId, steer: true });
      sink.push("steer_ack", { requestId: steer.requestId });
    });
  };
  sink.onSteer = takeSteer;
  for (const steer of sink.steerBacklog.splice(0)) takeSteer(steer);

  let finalStopReason = "end_turn";
  const controlWatch = setInterval(() => {
    if (sink.cancelled) session.abort();
    else void sink.pollControls();
  }, CONTROL_WATCH_MS);
  if (typeof controlWatch.unref === "function") controlWatch.unref();
  try {
    await session.prompt(prompt);
    // An instruction that arrived after the turn's last step starts a turn of
    // its own, rather than being left queued for a session that has ended.
    while (!sink.cancelled && session.hasQueuedUserMessages) {
      const next = session.takeQueuedUserMessages();
      await session.prompt(next.join("\n\n"));
    }
  } finally {
    clearInterval(controlWatch);
    sink.onSteer = null;
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
    sink.push("text", {
      text: continuation
        ? "The agent made no further file changes; the pull request is as it was."
        : "The agent made no file changes, so there is nothing to open a PR for.",
    });
    // A continuation that changed nothing still points at the branch and pull
    // request it continued, so the task links to them like its predecessor.
    sink.push("done", {
      finishReason: "no_changes",
      ...(continuation
        ? {
            branch: continuation.branch,
            ...(continuation.prUrl ? { prUrl: continuation.prUrl } : {}),
            ...(continuation.prNumber ? { prNumber: continuation.prNumber } : {}),
          }
        : {}),
    });
    await sink.finalize("done");
    log("no changes; done");
    return;
  }

  // Emit per-file change events (accurate counts + capped unified diff).
  await emitFileChanges(sink, workdir, gitEnv);

  // 7. Branch, commit, push, then the pull request — reused when this run
  //    continues one, opened otherwise.
  const shortId = TASK_ID.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "task";
  const branch = continuation ? continuation.branch : `juno/cloud-${shortId}`;
  const title = firstLine(prompt) || `Juno Cloud Code task ${shortId}`;

  // Already on the branch when it was cloned; created here when it is new, or
  // when it had to be recreated from the base.
  const onBranch = !!continuation && !branchMissing;
  if (!onBranch) {
    const checkout = await git(["checkout", "-b", branch], { cwd: workdir, env: gitEnv });
    if (!checkout.ok) throw new Error(`could not create branch: ${redact(checkout.stderr || checkout.message)}`);
  }

  const commitMsg = `${title}\n\nGenerated by Juno Cloud Code (task ${TASK_ID}).`;
  const committed = await git(["commit", "-m", commitMsg], { cwd: workdir, env: gitEnv });
  if (!committed.ok) throw new Error(`git commit failed: ${redact(committed.stderr || committed.message)}`);

  const pushed = await git(onBranch ? ["push", "origin", branch] : ["push", "-u", "origin", branch], {
    cwd: workdir,
    env: gitEnv,
  });
  if (!pushed.ok) {
    throw new Error(`git push rejected: ${redact(pushed.stderr || pushed.message)}`);
  }

  /*
   * ONE PULL REQUEST PER BRANCH. A continuation looks for the open pull
   * request whose head is this branch and reuses it — the push above already
   * put the commits on it — rather than opening a second. Found by head via
   * the API, not by the recorded number: the record is a hint, GitHub is the
   * truth, and a PR closed since the last run is not one to push a note into.
   */
  const github = { repoOwner, repoName, cloneToken };
  let pr = continuation ? await findOpenPullRequest({ ...github, branch }) : null;
  let reused = !!pr;
  if (!pr) {
    pr = await openPullRequest({
      ...github,
      branch,
      baseBranch,
      title,
      prompt,
      // An app-authored pull request names the person it is for, so it
      // still turns up under `involves:@me` on their pull request list.
      mention: credentialSource === "github_app" ? githubLogin : null,
    });
    // `reused` when GitHub answered 422 "a pull request already exists" and
    // openPullRequest handed back the one it collided with — the lookup above
    // having been skipped (a first run whose branch survived a re-dispatch) or
    // having failed transiently.
    reused = !!pr?.reused;
  }
  if (pr && reused) {
    await notePullRequestFollowUp({ ...github, number: pr.number, prompt });
  }

  sink.push("text", {
    text: pr
      ? reused
        ? `Pushed to the open pull request: ${pr.url}`
        : `Opened pull request: ${pr.url}`
      : `Pushed branch ${branch}, but the pull request could not be created automatically.`,
  });
  sink.push("done", {
    finishReason: finalStopReason,
    branch,
    ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}),
  });
  await sink.finalize("done");
  log(pr ? `done, PR #${pr.number}` : `done, pushed the branch (no PR)`);
}

/** The conversation turns runner-context handed over, validated to the shape agent-core seeds. */
function readHistory(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ role: "user" | "assistant"; text: string }[]} */
  const turns = [];
  for (const entry of raw.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const role = entry.role === "user" || entry.role === "assistant" ? entry.role : null;
    const text = typeof entry.text === "string" ? entry.text : "";
    if (role && text.trim()) turns.push({ role, text });
  }
  return turns;
}

/** The branch this run continues, or null for a first run. Same name rules as the server's validator. */
function readContinuation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const branch = typeof raw.branch === "string" ? raw.branch : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(branch) || branch.includes("..")) return null;
  return {
    branch,
    prUrl: typeof raw.prUrl === "string" ? raw.prUrl : null,
    prNumber: typeof raw.prNumber === "number" && Number.isInteger(raw.prNumber) ? raw.prNumber : null,
    baseRef: typeof raw.baseRef === "string" && raw.baseRef ? raw.baseRef : null,
  };
}

function githubHeaders(cloneToken) {
  return {
    Authorization: `Bearer ${cloneToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "Juno-Cloud-Code",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** The open pull request whose head is `branch`, or null.
 *  @returns {Promise<{ url: string; number: number } | null>} */
async function findOpenPullRequest({ repoOwner, repoName, cloneToken, branch }) {
  const head = encodeURIComponent(`${repoOwner}:${branch}`);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls?head=${head}&state=open&per_page=1`, {
      headers: githubHeaders(cloneToken),
    });
  } catch (err) {
    log("PR lookup network error:", err);
    return null;
  }
  if (!res.ok) {
    log(`PR lookup HTTP ${res.status}`);
    return null;
  }
  const list = /** @type {any} */ (await res.json().catch(() => []));
  const found = Array.isArray(list) ? list[0] : null;
  return found && typeof found.html_url === "string" && typeof found.number === "number"
    ? { url: found.html_url, number: found.number }
    : null;
}

/** Append the follow-up's instruction to the pull request body. Best effort. */
async function notePullRequestFollowUp({ repoOwner, repoName, cloneToken, number, prompt }) {
  try {
    const current = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${number}`, {
      headers: githubHeaders(cloneToken),
    });
    if (!current.ok) return;
    const data = /** @type {any} */ (await current.json().catch(() => ({})));
    const body = typeof data.body === "string" ? data.body : "";
    const note = `\n\n**Follow-up** (task ${TASK_ID})\n\n> ${firstLine(prompt).slice(0, 500)}`;
    if (body.length + note.length > 60_000) return;
    await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${number}`, {
      method: "PATCH",
      headers: githubHeaders(cloneToken),
      body: JSON.stringify({ body: body + note }),
    });
  } catch (err) {
    log("PR note error:", err);
  }
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
        // The status as a number, beside the suffix that spells it. The web
        // receipt reads this to say whether a test command passed; the suffix
        // stays for hosts and transcripts that predate the field.
        ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
        ...(event.isError && typeof event.exitCode !== "number" ? { failed: true } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
      });
      break;
    }
    case "tool_denied":
      sink.push("tool", {
        name: event.name,
        summary: `Denied ${event.name}: ${event.reason}`,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      });
      break;
    case "subagent_update":
      // Child-agent lifecycle snapshot → the web UI's live agent cards.
      sink.push("agent", { agent: event.agent });
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

/** @returns {Promise<{ url: string; number: number; reused?: boolean } | null>} */
async function openPullRequest({ repoOwner, repoName, cloneToken, branch, baseBranch, title, prompt, mention }) {
  const body =
    `This pull request was generated by **Juno Cloud Code**${mention ? ` for @${mention}` : ""}.\n\n` +
    `**Task prompt**\n\n> ${firstLine(prompt).slice(0, 500)}\n\n` +
    `Branch \`${branch}\` targets \`${baseBranch}\`. Review before merging.`;
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls`, {
      method: "POST",
      headers: githubHeaders(cloneToken),
      body: JSON.stringify({ title: title.slice(0, 200), head: branch, base: baseBranch, body }),
    });
  } catch (err) {
    log("PR creation network error:", err);
    return null;
  }
  if (!res.ok) {
    log(`PR creation HTTP ${res.status}`, await res.text().catch(() => ""));
    /*
     * 422 is what GitHub answers when an open pull request already has this
     * head — the one case where "could not create" actually means "there is
     * already one". It happens when the lookup above could not run or failed
     * transiently (a rate limit, a blip), and reporting "no pull request" for
     * a branch that plainly has one loses the link for the rest of the
     * conversation. GitHub itself is what makes a second PR impossible here;
     * this is how the runner finds out which one it collided with.
     */
    if (res.status === 422) {
      const collided = await findOpenPullRequest({ repoOwner, repoName, cloneToken, branch });
      return collided ? { ...collided, reused: true } : null;
    }
    return null;
  }
  const data = /** @type {any} */ (await res.json().catch(() => ({})));
  if (typeof data.html_url !== "string" || typeof data.number !== "number") return null;
  // Best effort: a review request puts the app's pull request on the person's
  // own queue. 422 when they cannot review it (not a collaborator) is fine.
  if (mention) {
    await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${data.number}/requested_reviewers`, {
      method: "POST",
      headers: githubHeaders(cloneToken),
      body: JSON.stringify({ reviewers: [mention] }),
    }).catch(() => {});
  }
  return { url: data.html_url, number: data.number };
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
 * captured everything it needs into module consts (TASK_ID, CALLBACK_BASE, …),
 * has already fetched + used its OIDC token, and holds its live secrets (task
 * token, clone token) only in JS memory — so this never breaks the driver. It
 * just ensures an agent that reads the driver's environ finds no usable
 * credential (the ACTIONS_* OIDC request token is stripped here too).
 */
function hardenDriverEnv() {
  const keep = new Set(AGENT_ENV_ALLOW).add("RUNNER_TEMP");
  const denyRe = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|_KEY|PRIVATE|SESSION)/i;
  for (const name of Object.keys(process.env)) {
    if (keep.has(name)) continue;
    if (
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
