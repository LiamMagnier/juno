import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/production-smoke.mjs", import.meta.url));

function runSmoke(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      JUNO_SMOKE_BASE_URL: "http://127.0.0.1:9",
      JUNO_SMOKE_REQUIRE_AUTH: "1",
      JUNO_SMOKE_TOKEN: "",
      JUNO_SMOKE_COOKIE: "",
      JUNO_SMOKE_RUN_CHAT: "",
      ...overrides,
    },
  });
}

test("authenticated smoke refuses to reach the network without a credential", () => {
  const result = runSmoke({ JUNO_SMOKE_RUN_CHAT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires JUNO_SMOKE_TOKEN or JUNO_SMOKE_COOKIE/);
  assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
});

test("authenticated smoke refuses to run without the provider-backed chat path", () => {
  const result = runSmoke({ JUNO_SMOKE_TOKEN: "test-token" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires JUNO_SMOKE_RUN_CHAT=1/);
  assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
});

test("smoke requires a base URL before any health request", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, JUNO_SMOKE_BASE_URL: "" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /JUNO_SMOKE_BASE_URL is required/);
});

test("the smoke skips a provider only for a dead key or exhausted credit, in provider-error's own words", async () => {
  // The fallback discriminator matches the copy of the error frame
  // (production-smoke.mjs, PROVIDER_ACCOUNT_FAILURE): hold it to the sentences
  // the app really sends.
  const { normalizeProviderError } = await import("../src/lib/provider-error");
  const literal = readFileSync(SCRIPT, "utf8").match(/const PROVIDER_ACCOUNT_FAILURE = \/(.+)\/i;/);
  assert.ok(literal, "the discriminator is a regex literal");
  const skip = new RegExp(literal[1], "i");
  const said = (err: unknown) => normalizeProviderError(err, { model: "Qwen3.8 Flash", provider: "Alibaba · Qwen" }).userMessage;
  assert.match(said({ status: 401, message: "Incorrect API key provided" }), skip, "a dead key is the account's");
  assert.match(said({ status: 402, message: "Payment required" }), skip, "exhausted credit is the account's");
  assert.match(said({ status: 400, message: "Your credit balance is too low" }), skip, "Anthropic's unfunded 400 is the account's");
  for (const status of [400, 429, 500, 503]) {
    assert.doesNotMatch(said({ status, message: "upstream error" }), skip, `${status} is the release's to answer for`);
  }
});

test("the smoke's machine-readable account faults are exactly the health policy's", async () => {
  const { isAccountFault } = await import("../src/lib/provider-health-policy");
  const literal = readFileSync(SCRIPT, "utf8").match(/const ACCOUNT_FAULT_CLASSES = new Set\((\[[^\]]*\])\);/);
  assert.ok(literal, "the class list is a literal");
  const listed = new Set(JSON.parse(literal[1]) as string[]);
  const classes = ["auth", "billing", "rate_limit", "context", "content_filter", "invalid_request", "capacity", "not_found", "network", "unknown"] as const;
  for (const klass of classes) {
    assert.equal(listed.has(klass), isAccountFault(klass), `${klass}: the smoke and provider health must agree`);
  }
});

test("the deploy smoke tries the real DEFAULT_MODEL first", async () => {
  const { DEFAULT_MODEL, getModel } = await import("../src/lib/models");
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const line = workflow.match(/^\s*SMOKE_MODEL="([^"]+)"\s*$/m);
  assert.ok(line, "deploy.yml sets SMOKE_MODEL");
  const candidates = line[1].split(",").map((entry) => entry.trim());
  assert.equal(candidates[0], DEFAULT_MODEL, "the first smoke candidate must be the account default");
  for (const id of candidates) {
    const model = getModel(id);
    assert.ok(model, `${id} is in the catalog`);
    assert.equal(model.minPlan, "FREE", `${id} must not depend on the smoke account's plan`);
  }
});

// ---------------------------------------------------------------------------
// The skip logic end to end, against a local stand-in for production.
// ---------------------------------------------------------------------------

interface FakeChatPlan {
  /** model id -> the error frame to answer with (absent: a completed answer). */
  errors: Record<string, Record<string, unknown>>;
}

async function withFakeProduction(plan: FakeChatPlan, run: (baseUrl: string) => Promise<void>) {
  const { createServer } = await import("node:http");
  const submitted = new Map<string, { conversationId: string; userMessageId: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/health") return send(200, { ok: true, version: "test" });
      if (url.pathname === "/api/v1/models") {
        return send(200, { models: [{ id: "a:one", modality: "chat", availability: "available" }] }, { "x-juno-contract-version": "1.3.0" });
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const parsed = JSON.parse(body) as { model: string; clientRequestId: string };
        if ((req.headers.accept ?? "").includes("application/json")) {
          return send(409, { code: "REQUEST_ALREADY_SUBMITTED", ...submitted.get(parsed.clientRequestId) });
        }
        const error = plan.errors[parsed.model];
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (error) {
          res.end(`data: ${JSON.stringify({ type: "error", finishReason: "error", ...error })}\n\n`);
          return;
        }
        submitted.set(parsed.clientRequestId, { conversationId: "c1", userMessageId: "u1" });
        res.end(`data: ${JSON.stringify({ type: "done", finishReason: "stop" })}\n\n`);
        return;
      }
      if (url.pathname === "/api/chat/receipt") {
        const ids = submitted.get(url.searchParams.get("clientRequestId") ?? "");
        return ids ? send(200, { receiptState: "completed", ...ids }) : send(404, {});
      }
      if (url.pathname === "/api/voice/relay-token") return send(403, { error: "Voice needs a paid plan." });
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runSmokeAsync(env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const SMOKE_ENV = { JUNO_SMOKE_REQUIRE_AUTH: "1", JUNO_SMOKE_TOKEN: "test-token", JUNO_SMOKE_RUN_CHAT: "1", JUNO_SMOKE_TIMEOUT_MS: "5000" };

test("an account fault named by errorClass is skipped with a warning, and the next candidate carries the release", async () => {
  await withFakeProduction(
    { errors: { "lab:default": { message: "Default is temporarily unavailable. Choose another model, or try again later.", errorClass: "billing" } } },
    async (baseUrl) => {
      const result = await runSmokeAsync({ ...SMOKE_ENV, JUNO_SMOKE_BASE_URL: baseUrl, JUNO_SMOKE_MODEL: "lab:default,lab:next" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /::warning::lab:default \(the account default\) is unusable in production \(billing\)/);
      assert.match(result.stdout, /PASS chat submission reached a terminal response on lab:next \(after 1 unusable provider\(s\)\)/);
    },
  );
});

test("a frame without errorClass is still recognised by its sentence", async () => {
  await withFakeProduction(
    { errors: { "lab:default": { message: "Default is temporarily unavailable. Choose another model, or try again later." } } },
    async (baseUrl) => {
      const result = await runSmokeAsync({ ...SMOKE_ENV, JUNO_SMOKE_BASE_URL: baseUrl, JUNO_SMOKE_MODEL: "lab:default,lab:next" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /SKIP lab:default \(provider account\)/);
    },
  );
});

test("a server error is the release's to answer for, whatever its sentence says", async () => {
  await withFakeProduction(
    {
      errors: {
        // A capacity frame whose copy happened to read like an account fault:
        // the class wins, and the deploy fails rather than skips.
        "lab:default": { message: "Default is temporarily unavailable. Choose another model, or try again later.", errorClass: "capacity" },
      },
    },
    async (baseUrl) => {
      const result = await runSmokeAsync({ ...SMOKE_ENV, JUNO_SMOKE_BASE_URL: baseUrl, JUNO_SMOKE_MODEL: "lab:default,lab:next" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /chat smoke returned an error event on lab:default/);
      assert.doesNotMatch(result.stdout, /SKIP lab:default/);
    },
  );
});
