import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

/*
 * What `alertOperator` (src/lib/alerts.ts) says became of an alert's mail, and
 * the one caller-owned exception to its hourly dedupe. provider-health reads
 * the answer to keep a default lab's last mail true while the lab flaps
 * (provider-health-policy.ts, `outageMailDue` / `toldAfterMail`).
 *
 * No mail is sent: `@/lib/email` is a recorder and the log is a no-op.
 */

const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
const sent: Array<{ to: string; subject: string }> = [];
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/email") return { sendEmail: async (mail: { to: string; subject: string }) => void sent.push(mail) };
  if (request === "@/lib/logger") return { logAsync: () => undefined };
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const { alertOperator, resetAlertDedupeForTests } = req("../src/lib/alerts") as typeof import("@/lib/alerts");

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ["OWNER_EMAILS", "ALERT_MUTED_KINDS"]) savedEnv[name] = process.env[name];
  process.env.OWNER_EMAILS = "owner@example.invalid";
  delete process.env.ALERT_MUTED_KINDS;
  resetAlertDedupeForTests();
  sent.length = 0;
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAlertDedupeForTests();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("it says what became of the mail: queued, deduplicated, muted, or never wanted", async () => {
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "down" }), "queued");
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "down" }), "deduped", "one per kind:key per hour");
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "openai", title: "down" }), "queued", "another key is its own window");
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "down", mail: false }), "log_only");
  process.env.ALERT_MUTED_KINDS = "provider_recovered:qwen";
  assert.equal(alertOperator({ kind: "provider_recovered", key: "qwen", title: "up" }), "muted");
  await settle();
  assert.equal(sent.length, 2);
});

test("a caller that bounds its own mail can skip the dedupe, and still starts a window", async () => {
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "down" }), "queued");
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "down again", dedupe: false }), "queued");
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "and again" }), "deduped");
  // Muting still wins over a skipped dedupe.
  process.env.ALERT_MUTED_KINDS = "provider_unhealthy";
  assert.equal(alertOperator({ kind: "provider_unhealthy", key: "qwen", title: "muted", dedupe: false }), "muted");
  await settle();
  assert.equal(sent.length, 2);
});
