import assert from "node:assert/strict";
import test from "node:test";

import { createCredentialFill, type CredentialFillDeps } from "@/lib/secrets/browser-fill";
import type { SecretRedemptionRefusal } from "@/lib/secrets/policy";

/*
 * The trusted fill boundary (BRIEF §7): the model names a reference, trusted
 * code reads the real URL and field type, redeems, fills, and scrubs. Nothing
 * the model sees afterwards — the fill result, a later read of a page that
 * echoes the value, an error — carries the value.
 */

const PASSWORD = "correct horse battery staple";
const USERNAME = "liam@example.com";

function harness(over: Partial<CredentialFillDeps> & { url?: string; kind?: "password" | "text" | "other" | null } = {}) {
  const redeemed: Array<Record<string, unknown>> = [];
  const filled: Array<{ value: string; requirePasswordField: boolean }> = [];
  const deps: CredentialFillDeps = {
    currentUrl: () => over.url ?? "https://github.com/login",
    fieldKind: async () => (over.kind === undefined ? "password" : over.kind),
    fillSecret: async (_target, value, opts) => {
      filled.push({ value, requirePasswordField: opts.requirePasswordField });
      // A hostile page that echoes whatever was typed straight back.
      return {
        ok: true,
        page: {
          url: `https://github.com/login?echo=${encodeURIComponent(value)}`,
          title: `Welcome ${value}`,
          html: `<p>You typed ${value}</p><input type="text" value="${value}">`,
          elements: [{ ref: 1, role: "textbox", label: value }],
        },
      };
    },
    redeem: async (request) => {
      redeemed.push(request);
      if (request.scope === "fill:username") return { ok: true, value: USERNAME, label: "GitHub" };
      return { ok: true, value: PASSWORD, label: "GitHub" };
    },
    ...over,
  };
  return { fill: createCredentialFill(deps), redeemed, filled };
}

const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.includes(PASSWORD) || text.includes(encodeURIComponent(PASSWORD)) || text.includes(USERNAME);
};

test("a fill redeems for the page's real host and field type, and nothing it returns carries the value", async () => {
  const { fill, redeemed, filled } = harness();
  const outcome = await fill.fill({ ref: 1 }, { credential: "asec_g.m", field: "password" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(redeemed[0], {
    ref: "asec_g.m",
    targetUrl: "https://github.com/login",
    scope: "fill:secret",
    targetIsPasswordField: true,
  });
  assert.deepEqual(filled, [{ value: PASSWORD, requirePasswordField: true }]);
  assert.equal(leaks(outcome), false, "the page echoed the value; the model must not see it");
});

test("every later page read is scrubbed of what was filled", async () => {
  const { fill } = harness();
  await fill.fill({ ref: 1 }, { credential: "asec_g.m", field: "password" });
  await fill.fill({ ref: 2 }, { credential: "asec_g.m", field: "username" }).catch(() => undefined);
  const later = fill.scrub({
    ok: true,
    page: { url: "https://github.com/", title: "x", html: `<div>${PASSWORD}</div>`, elements: [] },
  });
  assert.equal(leaks(later), false);
  const error = fill.scrub({ ok: false, message: `Field rejected value ${PASSWORD}` });
  assert.equal(leaks(error), false);
});

test("the model's description of the field is not evidence: a text field gets no password", async () => {
  const { fill, redeemed } = harness({ kind: "text" });
  await fill.fill({ ref: 1 }, { credential: "asec_g.m", field: "password" });
  assert.equal(redeemed[0].targetIsPasswordField, false, "the broker is told the truth and refuses");
  const missing = harness({ kind: null });
  const outcome = await missing.fill.fill({ ref: 9 }, { credential: "asec_g.m", field: "password" });
  assert.equal(outcome.ok, false);
  assert.equal(missing.redeemed.length, 0, "nothing redeemed for a field that is not there");
  const wrongKind = harness({ kind: "password" });
  const userIntoPassword = await wrongKind.fill.fill({ ref: 1 }, { credential: "asec_g.m", field: "username" });
  assert.equal(userIntoPassword.ok, false, "a username is never typed into a password field");
});

test("a refusal is a fixed sentence: no value, no host list, nothing to probe with", async () => {
  for (const reason of ["host_not_allowed", "wrong_task", "grant_expired", "forged_reference"] as SecretRedemptionRefusal[]) {
    const { fill, filled } = harness({ redeem: async () => ({ ok: false, reason }) });
    const outcome = await fill.fill({ ref: 1 }, { credential: "asec_g.m", field: "password" });
    assert.equal(outcome.ok, false, reason);
    assert.equal(filled.length, 0, `${reason}: nothing filled`);
    assert.equal(leaks(outcome), false);
  }
});
