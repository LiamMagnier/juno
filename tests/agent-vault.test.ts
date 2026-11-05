/**
 * The agents' credential vault (docs/design/agents-v2/VAULT.md), end to end
 * without a database or a browser: the store over its in-memory table (and
 * the real `encryptSecretBound`), the fill over a stand-in page, and the
 * `computer_fill_login` tool from the built runtime (runner/agent-core
 * `dist/`) inside a real `WorkAgentSession` driven by the scripted model. No
 * AI model is called anywhere in this file.
 *
 * Properties, each with its own test:
 * - the values never appear in a tool result, the model's requests, an
 *   event, an approval, an audit row or a log line;
 * - a page on any other origin (subdomain, parent, lookalike, scheme, port)
 *   is refused, before anything is decrypted;
 * - the first fill of each login asks; a declined one types nothing;
 * - another person's, or another agent's, login cannot be listed, opened or filled;
 * - TOTP codes match the RFC 6238 vectors;
 * - the values are sealed at rest, bound to owner, agent, row and field;
 * - without AGENT_VAULT_ENABLED=1 (and a computer provider) it is all off.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "agent-vault-test-secret-at-least-32-bytes!!";

const req = createRequire(import.meta.url);
const policy = req("../src/lib/computer/vault-policy") as typeof import("@/lib/computer/vault-policy");
const store = req("../src/lib/computer/vault-store") as typeof import("@/lib/computer/vault-store");
const fillMod = req("../src/lib/computer/vault-fill") as typeof import("@/lib/computer/vault-fill");
const runMod = req("../src/lib/computer/vault-run") as typeof import("@/lib/computer/vault-run");
const pageMod = req("../src/lib/computer/vault-page") as typeof import("@/lib/computer/vault-page");
const audit = req("../src/lib/computer/audit") as typeof import("@/lib/computer/audit");
const envMod = req("../src/lib/env") as typeof import("@/lib/env");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const domain = req("../src/lib/work/domain") as typeof import("@/lib/work/domain");

type Runtime = typeof import("../runner/agent-core/src/work/index.js");
type WorkApprovalRequest = import("../runner/agent-core/src/work/types.js").WorkApprovalRequest;
type WorkEmittedEvent = import("../runner/agent-core/src/work/types.js").WorkEmittedEvent;
const loadRuntime = async (): Promise<Runtime> => (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

const ALICE = "user_alice";
const BOB = "user_bob";
const MIRA = "agent_mira";
const NOVA = "agent_nova";
const USERNAME = "alice.octocat@example.org";
const PASSWORD = "hunter2-Correct-Horse-9!";
const TOTP_KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** A login page in the agent's browser: records exactly what was typed where. */
function fakePage(initialUrl: string, fields: { username: boolean; password: boolean; otp: boolean } = { username: true, password: true, otp: false }) {
  let url = initialUrl;
  let focused: "username" | "password" | "otp" | null = null;
  const values: Record<string, string> = {};
  const typed: Array<{ field: string; text: string }> = [];
  let onInsert: (() => void) | null = null;
  const port: import("@/lib/computer/vault-fill").LoginPagePort = {
    url: async () => url,
    fields: async () => fields,
    focus: async (kind) => {
      if (!fields[kind]) return false;
      focused = kind;
      values[kind] = "";
      return true;
    },
    insertText: async (text) => {
      if (!focused) throw new Error("nothing focused");
      values[focused] = (values[focused] ?? "") + text;
      typed.push({ field: focused, text });
      onInsert?.();
    },
    focusedLength: async () => (focused ? (values[focused] ?? "").length : null),
  };
  return {
    port,
    typed,
    /** The browser's URL, synchronously, as the runner's classifier reads it. */
    current: () => url,
    navigate: (next: string) => (url = next),
    afterInsert: (fn: () => void) => (onInsert = fn),
  };
}

/** Everything written to the console while `run` runs. */
async function capturingConsole<T>(run: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((name) => console[name]);
  // console only: the test runner reports over this process's stdout.
  for (const name of methods) console[name] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  try {
    const value = await run();
    return { value, output: lines.join("\n") };
  } finally {
    methods.forEach((name, i) => (console[name] = saved[i]!));
  }
}

function assertNoSecret(haystack: string, where: string, extra: string[] = []) {
  for (const secret of [USERNAME, PASSWORD, TOTP_KEY, encodeURIComponent(USERNAME), ...extra]) {
    assert.equal(haystack.includes(secret), false, `${where} must not contain a saved value`);
  }
}

const ENV_KEYS = ["AGENT_VAULT_ENABLED", "AGENT_COMPUTER_PROVIDER", "COMPUTER_PROVIDER", "NODE_ENV"] as const;

describe("the agents' credential vault", () => {
  let db: ReturnType<typeof store.createInMemoryVaultPersistence>;
  let audits: import("@/lib/computer/audit").ComputerAuditRow[];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.COMPUTER_PROVIDER;
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_VAULT_ENABLED = "1";
    resetComputerProviderCache();
    db = store.createInMemoryVaultPersistence();
    store.setVaultPersistenceForTest(db);
    audits = [];
    audit.setComputerAuditSinkForTest(async (row) => void audits.push(row));
  });
  afterEach(() => {
    store.setVaultPersistenceForTest(null);
    audit.setComputerAuditSinkForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  const saveGithub = (userId = ALICE, agentId = MIRA, extra: { totpSecret?: string } = {}) =>
    store.createAgentCredential({ userId, agentId, label: "GitHub", origin: "github.com", username: USERNAME, password: PASSWORD, ...extra });

  /** The runner's port for one agent's run, over the store and a page. */
  const portFor = (userId: string, agentId: string, page: ReturnType<typeof fakePage>, fence: () => Promise<string | null> = async () => null) =>
    runMod.createVaultRunPort({
      userId,
      agentId,
      store: { entries: store.vaultEntriesFor, open: store.openAgentCredentialForFill, recordFill: store.recordAgentCredentialFill },
      page: () => page.port,
      currentUrl: page.current,
      fence,
      audit: (event) =>
        void audit.recordComputerAudit({ userId, agentId, kind: event.kind, actor: "runner", detail: { runId: "run_v", ...(event.reason ? { reason: event.reason } : {}) } }),
    });

  // ── Off ──────────────────────────────────────────────────────────────────

  it("is off without AGENT_VAULT_ENABLED=1, and off without a computer provider", () => {
    delete process.env.AGENT_VAULT_ENABLED;
    assert.equal(envMod.isAgentVaultConfigured(), false);
    assert.equal(store.isAgentVaultEnabled(), false);
    for (const value of ["0", "true", "yes", " 2 "]) {
      process.env.AGENT_VAULT_ENABLED = value;
      assert.equal(store.isAgentVaultEnabled(), false, `"${value}" is not the switch`);
    }
    process.env.AGENT_VAULT_ENABLED = "1";
    assert.equal(store.isAgentVaultEnabled(), true);
    delete process.env.AGENT_COMPUTER_PROVIDER;
    resetComputerProviderCache();
    assert.equal(envMod.isAgentVaultConfigured(), false, "no computers, no vault");
    assert.equal(store.isAgentVaultEnabled(), false);
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    (process.env as Record<string, string>).NODE_ENV = "production";
    assert.equal(envMod.isAgentVaultConfigured(), false, "the fake provider is never on in production");
  });

  it("off, the routes answer credentials: null and refuse writes, and the runner builds no tool", () => {
    const list = readFileSync("src/app/api/agents/[id]/credentials/route.ts", "utf8");
    assert.match(list, /if \(!isAgentVaultEnabled\(\)\) return NextResponse\.json\(\{ credentials: null \}/);
    assert.match(list, /if \(!isAgentVaultEnabled\(\)\) \{\s*return NextResponse\.json\(\{ error: "not_enabled"/);
    const one = readFileSync("src/app/api/agents/[id]/credentials/[credentialId]/route.ts", "utf8");
    assert.match(one, /if \(!agent \|\| !isAgentVaultEnabled\(\)\) return notFound\(\);/);
    const runner = readFileSync("scripts/work-runner.ts", "utf8");
    assert.match(runner, /async function prepareRunVault[\s\S]*?if \(!isAgentVaultEnabled\(\)\) return null;/);
    assert.match(runner, /const fillLoginTools =\s*lazyComputer && vault\s*\?/);
    // No env var is set in the default test run, so the vault is off there.
    assert.equal(readFileSync(".env.example", "utf8").includes('# AGENT_VAULT_ENABLED=""'), true);
  });

  it("the runner gives no tool to an agent with no saved logins", async () => {
    assert.equal(await portFor(ALICE, MIRA, fakePage("https://github.com/login")), null);
  });

  // ── Encryption at rest ───────────────────────────────────────────────────

  it("seals every value at rest, bound to its owner, agent, row and field", async () => {
    const created = await saveGithub(ALICE, MIRA, { totpSecret: TOTP_KEY });
    const row = db.rows.find((r) => r.id === created.id)!;
    for (const sealed of [row.usernameSealed, row.passwordSealed, row.totpSealed!]) {
      assert.match(sealed, /^v1b\./, "encryptSecretBound's format");
      assertNoSecret(sealed, "a sealed column");
    }
    assertNoSecret(JSON.stringify(db.rows), "the stored row");
    assertNoSecret(JSON.stringify(created), "the create response");
    assertNoSecret(JSON.stringify(await store.listAgentCredentials(ALICE, MIRA)), "the list response");
    assert.deepEqual(Object.keys(created).sort(), ["approved", "createdAt", "hasTotp", "id", "label", "lastUsedAt", "origin"]);

    const opened = await store.openAgentCredentialForFill(ALICE, MIRA, created.id);
    assert.equal(opened?.password, PASSWORD);
    assert.equal(opened?.username, USERNAME);
    assert.equal(opened?.totpSecret, TOTP_KEY);

    // A ciphertext moved to another field, or to another agent's row, does not open.
    const other = await saveGithub(ALICE, NOVA);
    const otherRow = db.rows.find((r) => r.id === other.id)!;
    otherRow.passwordSealed = row.passwordSealed;
    assert.equal(await store.openAgentCredentialForFill(ALICE, NOVA, other.id), null, "moved across agents");
    row.usernameSealed = row.passwordSealed;
    const { value, output } = await capturingConsole(() => store.openAgentCredentialForFill(ALICE, MIRA, created.id));
    assert.equal(value, null, "moved across fields");
    assertNoSecret(output, "the log of a failed open");
  });

  // ── Ownership ────────────────────────────────────────────────────────────

  it("another person's or another agent's login cannot be listed, opened, changed, removed or filled", async () => {
    const mine = await saveGithub(ALICE, MIRA);
    assert.deepEqual(await store.listAgentCredentials(BOB, MIRA), []);
    assert.deepEqual(await store.listAgentCredentials(ALICE, NOVA), []);
    assert.equal(await store.openAgentCredentialForFill(BOB, MIRA, mine.id), null);
    assert.equal(await store.openAgentCredentialForFill(ALICE, NOVA, mine.id), null);
    assert.equal(await store.updateAgentCredential({ userId: BOB, agentId: MIRA, id: mine.id, origin: "https://evil.example" }), null);
    assert.equal(await store.deleteAgentCredential({ userId: ALICE, agentId: NOVA, id: mine.id }), false);
    assert.equal(db.rows.length, 1);

    // Nova has a login of its own, so its run gets the tool, but never Mira's.
    await store.createAgentCredential({ userId: ALICE, agentId: NOVA, label: "Linear", origin: "https://linear.app", username: "nova", password: "nova-pass-123" });
    const page = fakePage("https://github.com/login");
    const nova = (await portFor(ALICE, NOVA, page))!;
    assert.equal(nova.description.includes("GitHub"), false, "Mira's login is not even named to Nova");
    for (const login of ["GitHub", "https://github.com", mine.id]) {
      const result = await nova.fill({ login, approvedNow: true });
      assert.equal(result.ok, false);
      assert.equal(result.output, policy.VAULT_RESULT_MESSAGE.unknown);
    }
    // Bob's run of an agent with Mira's id: nothing.
    const bob = await portFor(BOB, MIRA, page);
    assert.equal(bob, null);
    assert.deepEqual(page.typed, []);
  });

  // ── Origins ──────────────────────────────────────────────────────────────

  it("normalizes a saved site to https://host[:port] and refuses anything else", () => {
    assert.equal(policy.normalizeVaultOrigin("github.com"), "https://github.com");
    assert.equal(policy.normalizeVaultOrigin("https://GitHub.com/login?next=/"), "https://github.com");
    assert.equal(policy.normalizeVaultOrigin("https://github.com:443"), "https://github.com");
    assert.equal(policy.normalizeVaultOrigin("https://git.example.com:8443/x"), "https://git.example.com:8443");
    assert.equal(policy.normalizeVaultOrigin("https://bücher.example"), "https://xn--bcher-kva.example");
    for (const bad of ["http://github.com", "ftp://github.com", "https://user:pw@github.com", "localhost", "javascript:alert(1)", "", "https://"]) {
      assert.equal(policy.normalizeVaultOrigin(bad), null, bad);
    }
  });

  it("matches only exactly the saved origin: no subdomain, parent, lookalike, scheme or port", () => {
    const saved = "https://github.com";
    assert.equal(policy.originMatches("https://github.com/login", saved), true);
    assert.equal(policy.originMatches("https://GITHUB.com/session?x=1#y", saved), true);
    for (const url of [
      "https://login.github.com/",
      "https://www.github.com/login",
      "https://github.com.evil.example/login",
      "https://evil.example/github.com",
      "https://evil.example/?u=https://github.com",
      "https://github.com@evil.example/",
      "https://githuh.com/login",
      "https://gіthub.com/login", // Cyrillic і
      "https://github.co/login",
      "http://github.com/login",
      "https://github.com:8443/login",
      "about:blank",
      "data:text/html,https://github.com",
      "",
    ]) {
      assert.equal(policy.originMatches(url, saved), false, url);
    }
    const sub = "https://login.example.com";
    assert.equal(policy.originMatches("https://example.com/", sub), false, "the parent of a saved subdomain");
    assert.equal(policy.originMatches("https://a.login.example.com/", sub), false, "a subdomain of a saved subdomain");
  });

  it("an origin mismatch is refused before anything is decrypted or typed, and audited without a value", async () => {
    await saveGithub();
    for (const url of ["https://login.github.com/", "https://github.com.evil.example/login", "https://gіthub.com/login", "http://github.com/login"]) {
      const page = fakePage(url);
      let opened = 0;
      const filler = fillMod.createVaultFiller({
        entries: () => store.vaultEntriesFor(ALICE, MIRA),
        open: async (id) => (opened++, store.openAgentCredentialForFill(ALICE, MIRA, id)),
        recordFill: async () => {},
        page: () => page.port,
        fence: async () => null,
        audit: (event) => void audits.push({ userId: ALICE, agentId: MIRA, kind: event.kind, actor: "runner", detail: { reason: event.reason } }),
      });
      const result = await filler.fill({ ref: "GitHub", approvedNow: true });
      assert.deepEqual(result, { ok: false, output: policy.VAULT_RESULT_MESSAGE.originMismatch }, url);
      assert.equal(opened, 0, "nothing was decrypted");
      assert.deepEqual(page.typed, []);
    }
    assert.ok(audits.every((a) => a.kind === "login_refused" && a.detail.reason === "origin_mismatch"));
  });

  it("stops when the page leaves the site between two fields", async () => {
    await saveGithub();
    const port = (await portFor(ALICE, MIRA, fakePage("https://github.com/login")))!;
    const page = fakePage("https://github.com/login");
    page.afterInsert(() => page.navigate("https://github.com.evil.example/login"));
    const filler = fillMod.createVaultFiller({
      entries: () => store.vaultEntriesFor(ALICE, MIRA),
      open: (id) => store.openAgentCredentialForFill(ALICE, MIRA, id),
      recordFill: async () => {},
      page: () => page.port,
      fence: async () => null,
    });
    const result = await filler.fill({ ref: "GitHub", approvedNow: true });
    assert.deepEqual(result, { ok: false, output: policy.VAULT_RESULT_MESSAGE.changed });
    assert.deepEqual(page.typed.map((t) => t.field), ["username"], "the password was never typed");
    assert.ok(port);
  });

  it("a takeover between fields stops the fill with the fence's own sentence", async () => {
    await saveGithub();
    const page = fakePage("https://github.com/login");
    let calls = 0;
    const port = (await portFor(ALICE, MIRA, page, async () => (++calls > 1 ? "The person has control of this computer right now." : null)))!;
    const result = await port.fill({ login: "GitHub", approvedNow: true });
    assert.equal(result.ok, false);
    assert.equal(result.output, "The person has control of this computer right now.");
    assert.deepEqual(page.typed.map((t) => t.field), ["username"]);
  });

  // ── Approval, through the real runtime ───────────────────────────────────

  async function runSession(input: {
    runtime: Runtime;
    port: import("@/lib/computer/vault-run").VaultRunPort;
    mode: "conservative" | "balanced" | "permissive";
    answer: "allowed" | "denied";
    expect?: string;
  }) {
    const { runtime, port } = input;
    const tool = runtime.computerFillLoginTool({
      description: port.description,
      classify: port.classify,
      describe: port.describe,
      refresh: port.refresh,
      fill: port.fill,
    });
    const requests: string[] = [];
    const scripted = runtime.createScriptedWorkProvider({
      version: 1,
      vision: true,
      steps: [
        { call: { name: "computer_fill_login", input: { login: "GitHub" } } },
        { ...(input.expect ? { expect: input.expect } : {}), say: "Done.", end: true },
      ],
    });
    const provider = {
      ...scripted,
      stream(request: Parameters<typeof scripted.stream>[0]) {
        requests.push(JSON.stringify(request));
        return scripted.stream(request);
      },
    };
    const approvals: WorkApprovalRequest[] = [];
    const events: WorkEmittedEvent[] = [];
    const session = new runtime.WorkAgentSession({
      runId: "run_vault",
      goal: "Sign in to GitHub.",
      provider,
      model: "scripted-work-model",
      cwd: "/tmp",
      tools: [tool],
      plan: new runtime.WorkPlan([{ id: "step_1", title: "Sign in" }]),
      budget: runtime.NO_BUDGET,
      approvalMode: input.mode,
      callbacks: {
        onEvent: (event) => events.push(event),
        requestApproval: async (request) => {
          approvals.push(request);
          return input.answer;
        },
        askQuestion: async () => "ok",
      },
    });
    const { output } = await capturingConsole(() => session.run());
    return { approvals, events, requests, output };
  }

  it("the first fill asks at sensitive, even under Skip; the model is told only the one sentence; nothing secret leaks anywhere", async () => {
    const runtime = await loadRuntime();
    await saveGithub(ALICE, MIRA, { totpSecret: TOTP_KEY });
    const page = fakePage("https://github.com/login");
    const port = (await portFor(ALICE, MIRA, page))!;
    const run = await runSession({ runtime, port, mode: "permissive", answer: "allowed", expect: "^Filled the login for GitHub\\.$" });

    assert.equal(run.approvals.length, 1, "Skip still asks the first time");
    assert.equal(run.approvals[0]!.action, "work.computer.fill_login");
    assert.equal(run.approvals[0]!.risk, "sensitive");
    assert.equal(run.approvals[0]!.summary, "Sign in with your saved login “GitHub” on github.com");
    assert.deepEqual(page.typed, [
      { field: "username", text: USERNAME },
      { field: "password", text: PASSWORD },
    ]);
    // The scripted model's `expect` held: the result it saw was exactly the sentence.
    assert.ok(run.events.some((e) => e.kind === "assistant_message" && e.text === "Done."), "the expectation passed");

    const everything = [JSON.stringify(run.approvals), JSON.stringify(run.events), run.requests.join("\n"), run.output, JSON.stringify(audits)].join("\n");
    assertNoSecret(everything, "the approvals, events, model requests, logs and audit");
    assert.ok(run.requests.at(-1)!.includes("Filled the login for GitHub."));
    assert.ok(audits.some((a) => a.kind === "login_filled"));

    const [row] = await store.listAgentCredentials(ALICE, MIRA);
    assert.equal(row!.approved, true, "the approval is remembered for this login");
    assert.ok(row!.lastUsedAt);
  });

  it("a declined first fill types nothing and is not remembered as approved", async () => {
    const runtime = await loadRuntime();
    await saveGithub();
    const page = fakePage("https://github.com/login");
    const port = (await portFor(ALICE, MIRA, page))!;
    const run = await runSession({ runtime, port, mode: "permissive", answer: "denied" });
    assert.equal(run.approvals.length, 1);
    assert.deepEqual(page.typed, []);
    assert.equal((await store.listAgentCredentials(ALICE, MIRA))[0]!.approved, false);
  });

  it("once approved, the next run follows the approval mode, and a new site or username asks again", async () => {
    const runtime = await loadRuntime();
    const created = await saveGithub();
    await store.recordAgentCredentialFill({ userId: ALICE, agentId: MIRA, id: created.id, approvedNow: true });

    const page = fakePage("https://github.com/login");
    const port = (await portFor(ALICE, MIRA, page))!;
    const skip = await runSession({ runtime, port, mode: "permissive", answer: "denied" });
    assert.equal(skip.approvals.length, 0, "Skip does not ask again for an approved login");
    assert.equal(page.typed.length, 2);

    const manual = await runSession({ runtime, port: (await portFor(ALICE, MIRA, fakePage("https://github.com/login")))!, mode: "conservative", answer: "allowed" });
    assert.equal(manual.approvals[0]?.risk, "command", "Manual still asks, at the mode's level");

    await store.updateAgentCredential({ userId: ALICE, agentId: MIRA, id: created.id, username: "someone-else" });
    assert.equal((await store.listAgentCredentials(ALICE, MIRA))[0]!.approved, false, "a new username is a new login to approve");
    await store.recordAgentCredentialFill({ userId: ALICE, agentId: MIRA, id: created.id, approvedNow: true });
    await store.updateAgentCredential({ userId: ALICE, agentId: MIRA, id: created.id, origin: "https://gitlab.com" });
    assert.equal((await store.listAgentCredentials(ALICE, MIRA))[0]!.approved, false, "a new site is a new login to approve");
    await store.recordAgentCredentialFill({ userId: ALICE, agentId: MIRA, id: created.id, approvedNow: true });
    await store.updateAgentCredential({ userId: ALICE, agentId: MIRA, id: created.id, password: "a-new-password-123" });
    assert.equal((await store.listAgentCredentials(ALICE, MIRA))[0]!.approved, true, "a new password for the same account does not");
  });

  it("a stale snapshot can never skip the first card: an unapproved login is filled only by a call that was asked", async () => {
    await saveGithub();
    const page = fakePage("https://github.com/login");
    const port = (await portFor(ALICE, MIRA, page))!;
    const result = await port.fill({ login: "GitHub", approvedNow: false });
    assert.deepEqual(result, { ok: false, output: policy.VAULT_RESULT_MESSAGE.notApproved });
    assert.deepEqual(page.typed, []);
  });

  it("the approval rules: sensitive always asks and is never standing; the floor token keeps every level out of Always allow", () => {
    for (const mode of domain.WORK_PERMISSION_POLICIES) {
      assert.equal(domain.approvalRuling({ action: "work.computer.fill_login", risk: "sensitive", policy: mode }).ask, true, mode);
    }
    for (const risk of ["safe", "edit", "command", "sensitive"] as const) {
      assert.equal(domain.mayBeCoveredByStandingAllowance("work.computer.fill_login", risk), false, risk);
    }
    assert.match(domain.approvalRuling({ action: "work.computer.fill_login", risk: "sensitive", policy: "permissive" }).explanation, /never sees it/);
  });

  // ── Two-step codes ───────────────────────────────────────────────────────

  it("generates TOTP codes matching the RFC 6238 SHA-1 vectors", () => {
    // RFC 6238 Appendix B: the ASCII seed "12345678901234567890", 8 digits. A
    // six-digit code is the same truncation mod 10^6, so its last six digits.
    const seed = policy.normalizeTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      assert.equal(policy.vaultTotpCode(seed, seconds * 1000), code.slice(-6), `T=${seconds}`);
    }
  });

  it("reads a setup key or an otpauth link, and refuses codes it cannot generate, without quoting the input", () => {
    assert.equal(policy.normalizeTotpSecret("jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp"), TOTP_KEY);
    assert.equal(policy.normalizeTotpSecret(`otpauth://totp/GitHub:alice?secret=${TOTP_KEY}&issuer=GitHub`), TOTP_KEY);
    for (const bad of ["not base32!", "ABC", `otpauth://totp/x?secret=${TOTP_KEY}&digits=8`, `otpauth://hotp/x?secret=${TOTP_KEY}`]) {
      assert.throws(() => policy.normalizeTotpSecret(bad), (error: Error) => error instanceof policy.VaultInputError && !error.message.includes(TOTP_KEY));
    }
  });

  it("fills a two-step code page with the current code, generated on the server, and never the secret", async () => {
    await saveGithub(ALICE, MIRA, { totpSecret: TOTP_KEY });
    const created = (await store.listAgentCredentials(ALICE, MIRA))[0]!;
    await store.recordAgentCredentialFill({ userId: ALICE, agentId: MIRA, id: created.id, approvedNow: true });
    const page = fakePage("https://github.com/sessions/two-factor", { username: false, password: false, otp: true });
    const now = Date.UTC(2026, 9, 30, 12, 0, 0);
    const filler = fillMod.createVaultFiller({
      entries: () => store.vaultEntriesFor(ALICE, MIRA),
      open: (id) => store.openAgentCredentialForFill(ALICE, MIRA, id),
      recordFill: async () => {},
      page: () => page.port,
      fence: async () => null,
      now: () => now,
    });
    const result = await filler.fill({ ref: "GitHub", approvedNow: false });
    assert.deepEqual(result, { ok: true, output: "Filled the login for GitHub." });
    const code = policy.vaultTotpCode(TOTP_KEY, now);
    assert.deepEqual(page.typed, [{ field: "otp", text: code }]);
    assert.equal(filler.scrubText(`code ${code} sent`), "code [credential hidden] sent");

    // A login with no two-step secret says so, and types nothing.
    await store.createAgentCredential({ userId: ALICE, agentId: MIRA, label: "Plain", origin: "https://github.com", username: "u-plain", password: "p-plain-123" });
    const plainPage = fakePage("https://github.com/sessions/two-factor", { username: false, password: false, otp: true });
    const plain = await fillMod
      .createVaultFiller({
        entries: async () => (await store.vaultEntriesFor(ALICE, MIRA)).map((e) => ({ ...e, approved: true })),
        open: (id) => store.openAgentCredentialForFill(ALICE, MIRA, id),
        recordFill: async () => {},
        page: () => plainPage.port,
        fence: async () => null,
      })
      .fill({ ref: "Plain", approvedNow: true });
    assert.deepEqual(plain, { ok: false, output: policy.VAULT_RESULT_MESSAGE.noTotp });
    assert.deepEqual(plainPage.typed, []);
  });

  // ── Leaks through the page and errors ────────────────────────────────────

  it("scrubs what it typed from later page reads, and a browser error's own text never reaches the model", async () => {
    await saveGithub();
    const page = fakePage("https://github.com/login");
    const port = (await portFor(ALICE, MIRA, page))!;
    assert.equal((await port.fill({ login: "GitHub", approvedNow: true })).ok, true);
    const echoed = runMod.scrubBrowserOutcome(
      { ok: true as const, page: { url: "https://github.com/", title: `Hi ${USERNAME}`, html: `<input value="${PASSWORD}">`, elements: [{ label: USERNAME }] } },
      port.scrubText,
    );
    assertNoSecret(JSON.stringify(echoed), "a scrubbed page read");

    const throwing = fakePage("https://github.com/login");
    throwing.port.insertText = async (text) => {
      throw new Error(`Input.insertText failed for "${text}"`);
    };
    const filler = fillMod.createVaultFiller({
      entries: async () => (await store.vaultEntriesFor(ALICE, MIRA)).map((e) => ({ ...e, approved: true })),
      open: (id) => store.openAgentCredentialForFill(ALICE, MIRA, id),
      recordFill: async () => {},
      page: () => throwing.port,
      fence: async () => null,
    });
    const { value, output } = await capturingConsole(() => filler.fill({ ref: "GitHub", approvedNow: true }));
    assert.deepEqual(value, { ok: false, output: policy.VAULT_RESULT_MESSAGE.failed });
    assertNoSecret(output, "the log of a failed fill");
  });

  it("types over CDP Input.insertText, never through page script, and reads the URL from the browser", async () => {
    const evaluated: string[] = [];
    const sent: Array<{ method: string; text: string }> = [];
    const page = {
      url: () => "https://github.com/login",
      isClosed: () => false,
      evaluate: async (expression: string) => {
        evaluated.push(expression);
        assert.ok(expression.startsWith(pageMod.LOGIN_FIELDS_SCRIPT), "only the locator runs in the page");
        const arg = JSON.parse(expression.slice(pageMod.LOGIN_FIELDS_SCRIPT.length + 1, -1)) as { action: string };
        if (arg.action === "probe") return { username: true, password: true, otp: false };
        if (arg.action === "focus") return true;
        return 12;
      },
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: "Input.insertText", params: { text: string }) => void sent.push({ method, text: params.text }),
          detach: async () => {},
        }),
      }),
    };
    const port = pageMod.loginPagePortFor((fn) => fn(page as never));
    assert.equal(await port.url(), "https://github.com/login");
    assert.deepEqual(await port.fields(), { username: true, password: true, otp: false });
    assert.equal(await port.focus("password"), true);
    await port.insertText(PASSWORD);
    assert.deepEqual(sent, [{ method: "Input.insertText", text: PASSWORD }]);
    assertNoSecret(evaluated.join("\n"), "the page scripts");
    assert.equal(pageMod.loginPagePort({ open: () => null }), null, "a browser that cannot lend its page cannot fill");
    // The locator searches only the main document and types only into its focused input.
    assert.match(pageMod.LOGIN_FIELDS_SCRIPT, /return document\.activeElement === el;/);
    assert.doesNotMatch(pageMod.LOGIN_FIELDS_SCRIPT, /contentDocument|frames\[/);
  });

  it("the computer's Chromium keeps no passwords of its own", () => {
    const policies = JSON.parse(readFileSync("deploy/agent-computers/chrome-policies.json", "utf8")) as Record<string, unknown>;
    assert.equal(policies.PasswordManagerEnabled, false);
  });
});
