import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

/*
 * provider-health.ts at run time: what a live fault does to the cache, which
 * probes it starts, and which alerts it raises. The rules themselves are pure
 * and live in provider-health-policy.test.ts; this suite holds the module that
 * applies them.
 *
 * Nothing leaves the process: `fetch` is stubbed (it records each probe and
 * answers as the case says), the keys are fakes set for this file only, and
 * `@/lib/alerts` is replaced by a recorder, so no mail is ever attempted.
 */

const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
interface RecordedAlert {
  kind: string;
  key?: string;
  mail?: boolean;
  dedupe?: boolean;
  severity?: string;
  title: string;
}
const alerts: RecordedAlert[] = [];
/** What the recorder says became of a mail; absent: nothing (read as queued). */
let mailOutcome: ((input: RecordedAlert) => string) | null = null;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/alerts") {
    return {
      alertOperator: (input: RecordedAlert) => {
        alerts.push(input);
        return mailOutcome?.(input);
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const health = req("../src/lib/provider-health") as typeof import("@/lib/provider-health");
const { UNHEALTHY_TTL_MS } = req("../src/lib/provider-health-policy") as typeof import("@/lib/provider-health-policy");
const { markModelCallError } = req("../src/lib/provider-error") as typeof import("@/lib/provider-error");

/** As `streamChat` marks what a model call throws: only those feed health. */
function fromModelCall<T>(err: T): T {
  markModelCallError(err);
  return err;
}
/** Who met the fault, on which model. */
const by = (requester = "user-1", modelId = "qwen:qwen3.8-flash") => ({ requester, modelId });

const KEYS = { DASHSCOPE_API_KEY: "test-qwen-key", DEEPSEEK_API_KEY: "test-deepseek-key" } as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let probes: string[] = [];
/** What the stubbed lab answers a probe with. */
let answer: { status: number; body: string } = { status: 200, body: "{}" };

beforeEach(() => {
  for (const [name, value] of Object.entries(KEYS)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  probes = [];
  alerts.length = 0;
  mailOutcome = null;
  answer = { status: 200, body: "{}" };
  globalThis.fetch = (async (input: string | URL | Request) => {
    probes.push(input instanceof Request ? input.url : String(input));
    return new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  health.__setProviderHealthForTests([]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of Object.keys(KEYS)) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  health.__setProviderHealthForTests([]);
});

/** Let a background probe finish: it resolves within a few ticks against the stub. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const snapshotOf = (provider: string) => health.providerHealthSnapshot().find((entry) => entry.provider === provider);
const unfunded = () => Object.assign(new Error("402 Insufficient Balance"), { status: 402, error: { message: "Insufficient Balance" } });

test("a live account fault marks the lab down at once and starts a probe; the probe's confirmation is the one alert, mailed for a default lab", async () => {
  // As the web process: src/lib/boot.ts makes it the one that mails.
  health.__setProviderHealthForTests([], { outageMailer: true });
  answer = { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  health.noteLiveProviderFault("qwen", fromModelCall(unfunded()), "chat", by());
  assert.equal(health.providerHealthy("qwen"), false, "the very next read sees it down, before any probe");
  assert.equal(alerts.length, 0, "one turn's error is not an alert");

  await settle();
  assert.equal(probes.length, 1, "exactly one confirming probe");
  const confirmed = snapshotOf("qwen");
  assert.equal(confirmed?.healthy, false);
  assert.equal(confirmed?.source, "probe");
  assert.equal(confirmed?.failure, "billing");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "provider_unhealthy");
  assert.equal(alerts[0].mail, true, "qwen serves DEFAULT_MODEL: mailed");
  assert.equal(alerts[0].severity, "critical");

  // More failed turns on a confirmed lab change nothing and probe nothing.
  health.noteLiveProviderFault("qwen", fromModelCall(unfunded()), "work", by("run-1"));
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(alerts.length, 1);
});

test("the Work runner and the sweepers log a default lab's outage without mailing it", async () => {
  // No mailer designation: the state every worker process is in.
  answer = { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  health.noteLiveProviderFault("qwen", fromModelCall(unfunded()), "work", by("run-1"));
  await settle();
  assert.equal(alerts.length, 1, "still recorded");
  assert.equal(alerts[0].kind, "provider_unhealthy");
  assert.equal(alerts[0].severity, "critical");
  assert.equal(alerts[0].mail, false, "only the web process mails");
});

test("a lab that serves no default model is logged, not mailed", async () => {
  health.__setProviderHealthForTests([], { outageMailer: true });
  answer = { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  health.noteLiveProviderFault("deepseek", fromModelCall(unfunded()), "background", by("user-1", "deepseek:deepseek-flash"));
  await settle();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].mail, false);
  assert.equal(alerts[0].severity, "warn");
});

test("a misattributed account fault is cleared by its probe within seconds, with no alert either way", async () => {
  answer = { status: 200, body: "{}" };
  health.noteLiveProviderFault("qwen", fromModelCall(Object.assign(new Error("401 Unauthorized"), { status: 401 })), "chat", by());
  assert.equal(health.providerHealthy("qwen"), false);
  await settle();
  assert.equal(health.providerHealthy("qwen"), true, "the lab answered its probe");
  assert.deepEqual(alerts, [], "never confirmed: no down mail and no recovered line");
});

test("a bare 403 on one model leaves the lab up and only asks the probe, at most once per recheck", async () => {
  answer = { status: 200, body: "{}" };
  const oneModel = () => ({ status: 403, error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } });
  health.noteLiveProviderFault("qwen", fromModelCall(oneModel()), "chat", by());
  assert.equal(health.providerHealthy("qwen"), true, "routing is unchanged on one turn's 403");
  assert.equal(health.providerAccountUsable("qwen"), true);
  await settle();
  assert.equal(probes.length, 1, "the probe asks the lab's cheapest model");
  assert.equal(health.providerHealthy("qwen"), true);
  health.noteLiveProviderFault("qwen", fromModelCall(oneModel()), "chat", by());
  health.noteLiveProviderFault("qwen", fromModelCall(oneModel()), "private_chat", by());
  await settle();
  assert.equal(probes.length, 1, "not again within the recheck period");
  assert.deepEqual(alerts, []);
});

test("a bare 403 the probe agrees with marks the lab down, as a probe verdict", async () => {
  health.__setProviderHealthForTests([], { outageMailer: true });
  answer = { status: 403, body: JSON.stringify({ error: { message: "Forbidden" } }) };
  health.noteLiveProviderFault("qwen", fromModelCall({ status: 403, error: { message: "Forbidden" } }), "chat", by());
  assert.equal(health.providerHealthy("qwen"), true, "nothing changes before the probe answers");
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(health.providerHealthy("qwen"), false);
  assert.equal(snapshotOf("qwen")?.source, "probe");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "provider_unhealthy");
});

test("repeated server errors hold a lab down without an immediate probe or an alert", async () => {
  const fiveHundred = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });
  const model = "deepseek:deepseek-flash";
  // One person's Try again, three times on one model: one source.
  for (let i = 0; i < 3; i += 1) health.noteLiveProviderFault("deepseek", fromModelCall(fiveHundred()), "chat", by("user-1", model));
  assert.equal(health.providerHealthy("deepseek"), true, "one source's repeats are weather");
  health.noteLiveProviderFault("deepseek", fromModelCall(fiveHundred()), "chat", by("user-2", model));
  assert.equal(health.providerHealthy("deepseek"), true, "two sources are weather");
  health.noteLiveProviderFault("deepseek", fromModelCall(fiveHundred()), "work", by("run-9", model));
  assert.equal(health.providerHealthy("deepseek"), false, "three sources in the window hold it down");
  await settle();
  assert.deepEqual(probes, [], "a lucky probe mid-overload must not clear the hold at once");
  assert.deepEqual(alerts, []);
  // Chat's server errors say nothing about the lab's account, so media
  // generation (a different endpoint) is not refused for them.
  assert.equal(health.providerAccountUsable("deepseek"), true, "a capacity hold does not block media");
});

test("only an account fault makes a lab's account unusable for media generation", async () => {
  answer = { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  health.noteLiveProviderFault("deepseek", fromModelCall(unfunded()), "chat", by("user-1", "deepseek:deepseek-flash"));
  assert.equal(health.providerAccountUsable("deepseek"), false, "a live account fault blocks it at once");
  await settle();
  assert.equal(health.providerAccountUsable("deepseek"), false, "and the confirmed one keeps it blocked");
  assert.equal(health.providerAccountUsable("anthropic"), true, "an unseen lab is usable");
  health.__setProviderHealthForTests([
    { provider: "qwen", healthy: false, checkedAt: null, failure: null, detail: "seeded", source: "seed", recheckAt: null },
  ]);
  assert.equal(health.providerAccountUsable("qwen"), true, "a boot seed is a suspicion about chat, not the account");
});

test("an error without an HTTP status, or from an unknown lab, changes nothing", async () => {
  health.noteLiveProviderFault("qwen", fromModelCall(new Error("internal: the database went away")), "chat", by());
  health.noteLiveProviderFault("not-a-lab", fromModelCall(unfunded()), "chat", by());
  await settle();
  assert.equal(health.providerHealthy("qwen"), true);
  assert.deepEqual(probes, []);
  assert.deepEqual(alerts, []);
});

test("a down verdict past its recheck is re-probed when read, so a process that never loads the catalog still recovers", async () => {
  // As the Work runner or a sweeper would hold it: confirmed down a while ago,
  // and nothing in that process ever calls ensureProviderHealthFresh().
  health.__setProviderHealthForTests([
    {
      provider: "qwen",
      healthy: false,
      checkedAt: Date.now() - UNHEALTHY_TTL_MS - 1_000,
      failure: "billing",
      detail: "402 Insufficient Balance",
      source: "probe",
      recheckAt: null,
    },
  ]);
  answer = { status: 200, body: "{}" };
  assert.equal(health.providerHealthy("qwen"), false, "the read answers from the cache");
  await settle();
  assert.equal(probes.length, 1, "and starts one probe");
  assert.equal(health.providerHealthy("qwen"), true, "the topped-up lab is back");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "provider_recovered");
  assert.equal(alerts[0].mail, false, "a worker logs the recovery");
});

test("the web process mails a default lab's recovery, so a mailed outage gets its all-clear", async () => {
  const downSince = Date.now() - UNHEALTHY_TTL_MS - 1_000;
  const confirmedDown = (provider: "qwen" | "deepseek") => ({
    provider,
    healthy: false,
    checkedAt: downSince,
    failure: "billing" as const,
    detail: "402 Insufficient Balance",
    source: "probe" as const,
    recheckAt: null,
  });
  // This process mailed qwen's outage when it was confirmed.
  health.__setProviderHealthForTests([confirmedDown("qwen"), confirmedDown("deepseek")], { outageMailer: true, told: { qwen: "down" } });
  answer = { status: 200, body: "{}" };
  health.providerHealthy("qwen");
  health.providerHealthy("deepseek");
  await settle();
  const recovered = alerts.filter((alert) => alert.kind === "provider_recovered");
  assert.equal(recovered.length, 2);
  assert.equal(recovered.find((alert) => alert.key === "qwen")?.mail, true, "qwen serves DEFAULT_MODEL: mailed");
  assert.equal(recovered.find((alert) => alert.key === "deepseek")?.mail, false, "any other lab: logged");
});

test("an error the model call did not throw changes nothing, however much it reads like the lab's account", async () => {
  // A search API's 401, or a sentence with "insufficient" in it, that reached
  // the turn's catch from somewhere other than the model call.
  for (let i = 0; i < 10; i += 1) {
    health.noteLiveProviderFault("openai", Object.assign(new Error("401 Unauthorized"), { status: 401 }), "chat", by("user-1", "openai:gpt-6-luna"));
    health.noteLiveProviderFault("openai", Object.assign(new Error("insufficient context for the research brief"), { status: 400 }), "chat", by());
    assert.equal(health.providerHealthy("openai"), true, `turn ${i + 1}: routing unchanged`);
  }
  await settle();
  assert.deepEqual(probes, [], "and no probe is spent on it");
  assert.deepEqual(alerts, []);
  // Work's own classified failures are the model call's by construction.
  health.noteLiveProviderFault("openai", { class: "auth", status: 401, raw: "auth" }, "work", by("run-1", "openai:gpt-6-luna"));
  assert.equal(health.providerHealthy("openai"), false);
});

test("a private chat's fault keeps its class and status, never the provider's text", async () => {
  answer = { status: 200, body: "{}" };
  health.noteLiveProviderFault(
    "qwen",
    fromModelCall(Object.assign(new Error("402 Insufficient Balance: request about my private matter"), { status: 402 })),
    "private_chat",
    by(),
  );
  const held = snapshotOf("qwen");
  assert.equal(held?.healthy, false);
  assert.equal(held?.failure, "billing");
  assert.equal(held?.detail, "402 billing from a private chat; the provider's text is not kept");
  await settle();
});

test("a probe that clears a live verdict laid over a mailed outage sends the all-clear", async () => {
  health.__setProviderHealthForTests([], { outageMailer: true });
  // Confirmed and mailed: a probe met the same 402.
  answer = { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  health.noteLiveProviderFault("qwen", fromModelCall(unfunded()), "chat", by());
  await settle();
  assert.deepEqual(alerts.map((alert) => [alert.kind, alert.mail]), [["provider_unhealthy", true]]);
  // A turn then meets a different account fault: a live verdict over the outage.
  answer = { status: 200, body: "{}" };
  health.noteLiveProviderFault("qwen", fromModelCall(Object.assign(new Error("401 Incorrect API key provided"), { status: 401 })), "chat", by());
  assert.equal(snapshotOf("qwen")?.source, "live");
  await settle();
  assert.equal(health.providerHealthy("qwen"), true, "its probe found the lab serving");
  assert.deepEqual(
    alerts.map((alert) => [alert.kind, alert.mail]),
    [
      ["provider_unhealthy", true],
      ["provider_recovered", true],
    ],
    "the operator who was told it was down is told it is back",
  );
});

test("a flapping default lab: the operator's last mail is always true, and mail stays bounded", async () => {
  // A recorder with alerts.ts's hourly dedupe per kind:key, and a fake clock.
  const lastMailed = new Map<string, number>();
  const mailbox: string[] = [];
  let clock = Date.now();
  const realNow = Date.now;
  Date.now = () => clock;
  mailOutcome = (input) => {
    if (!input.mail) return "log_only";
    const key = `${input.kind}:${input.key}`;
    const previous = lastMailed.get(key);
    if (input.dedupe !== false && previous !== undefined && clock - previous < 60 * 60_000) return "deduped";
    lastMailed.set(key, clock);
    mailbox.push(input.kind === "provider_unhealthy" ? "down" : "recovered");
    return "queued";
  };
  try {
    health.__setProviderHealthForTests([], { outageMailer: true });
    const e503 = () => fromModelCall(Object.assign(new Error("503 Service Unavailable"), { status: 503 }));
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // Three people meet server errors; the probe at the recheck meets one
      // too (confirmed); the next answers (cleared).
      for (const person of ["a", "b", "c"]) {
        health.noteLiveProviderFault("qwen", e503(), "chat", by(person));
        clock += 5_000;
      }
      clock += 121_000;
      answer = { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable" } }) };
      health.providerHealthy("qwen");
      await settle();
      clock += 121_000;
      answer = { status: 200, body: "{}" };
      health.providerHealthy("qwen");
      await settle();
    }
    // It ends down.
    for (const person of ["a", "b", "c"]) health.noteLiveProviderFault("qwen", e503(), "chat", by(person));
    clock += 121_000;
    answer = { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable" } }) };
    health.providerHealthy("qwen");
    await settle();
    assert.equal(health.providerHealthy("qwen"), false);
    assert.deepEqual(mailbox, ["down", "recovered", "down"], "down, up, and down again: no more within the hour");
    assert.equal(mailbox.at(-1), "down", "the last mail says what is true");
  } finally {
    Date.now = realNow;
  }
});

test("reads of a fresh down verdict, a healthy lab or an unseen lab start no probe", async () => {
  health.__setProviderHealthForTests([
    { provider: "qwen", healthy: false, checkedAt: Date.now(), failure: "billing", detail: null, source: "probe", recheckAt: null },
    { provider: "deepseek", healthy: true, checkedAt: Date.now() - UNHEALTHY_TTL_MS * 2, failure: null, detail: null },
  ]);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(health.providerHealthy("qwen"), false);
    assert.equal(health.providerHealthy("deepseek"), true);
    assert.equal(health.providerHealthy("anthropic"), true);
  }
  await settle();
  assert.deepEqual(probes, [], "healthy and unseen labs are the catalog probe's, as before");
});
