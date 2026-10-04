import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync("next.config.mjs", "utf8");
const policy = /key: "Permissions-Policy",\s*value:\s*'([^']+)'/.exec(config)?.[1] ?? "";

test("payments are allowed for this origin and Stripe's checkout frames, and nowhere else", () => {
  const payment = /payment=\(([^)]*)\)/.exec(policy)?.[1] ?? "";
  assert.ok(payment.split(" ").includes("self"), "Apple Pay and Google Pay need the Payment Request API here");
  const origins = payment.split(" ").filter((o) => o !== "self").map((o) => o.replace(/"/g, ""));
  assert.ok(origins.length > 0 && origins.every((o) => /^https:\/\/[a-z.]*stripe\.com$/.test(o)), origins.join(" "));
});

test("camera and location stay off, and the microphone stays this origin's own", () => {
  assert.match(policy, /camera=\(\)/);
  assert.match(policy, /geolocation=\(\)/);
  assert.match(policy, /microphone=\(self\)/);
});
