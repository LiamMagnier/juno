import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLIENT_FEATURES,
  MAX_CLIENT_FEATURES,
  parseClientFeatures,
  WEB_CLIENT_FEATURES,
} from "@/lib/chat/client-features";
import {
  chatBodySchema,
  lenientClientFeatures,
  lenientLocale,
  lenientTimeZone,
  noteIgnoredResearchEffort,
} from "@/lib/chat/request";

/*
 * THE REQUEST ADDITIONS ARE LENIENT (SPEC §2.1, INV-9).
 *
 * A native build in people's hands sends what it was built with, and an older
 * deploy may meet a newer client: an invalid value in one of the new fields
 * is dropped, never a 400. Profile negotiation is by `clientFeatures` only
 * (INV-26).
 */

const parse = (body: Record<string, unknown>) => chatBodySchema.safeParse({ message: "hi", ...body });

test("clientFeatures: known names kept, unknown dropped, duplicates collapsed", () => {
  assert.deepEqual(lenientClientFeatures(["timeline", "hologram", "timeline", 3, "resume"]), ["timeline", "resume"]);
  assert.equal(lenientClientFeatures("timeline"), undefined, "not an array → profile 1");
  assert.equal(lenientClientFeatures(undefined), undefined);
  assert.deepEqual(lenientClientFeatures([]), []);
});

test("clientFeatures: at most 16 are kept, however long the list", () => {
  const many = Array.from({ length: 5_000 }, (_, i) => (i % 2 ? CLIENT_FEATURES[i % CLIENT_FEATURES.length] : `future_${i}`));
  const kept = lenientClientFeatures(many)!;
  assert.ok(kept.length <= MAX_CLIENT_FEATURES);
  assert.deepEqual([...kept].sort(), [...CLIENT_FEATURES].sort());
  assert.ok(parseClientFeatures(Array.from({ length: 40 }, () => "timeline")).list.length <= MAX_CLIENT_FEATURES);
});

test("the schema accepts the new fields and never refuses a bad value", () => {
  const good = parse({ clientFeatures: [...WEB_CLIENT_FEATURES], timeZone: "Europe/Paris", locale: "pt-br" });
  assert.ok(good.success);
  assert.deepEqual(good.data.clientFeatures, [...WEB_CLIENT_FEATURES]);
  assert.equal(good.data.timeZone, "Europe/Paris");
  assert.equal(good.data.locale, "pt-BR", "canonical form");

  const bad = parse({ clientFeatures: { timeline: true }, timeZone: "Mars/Olympus_Mons", locale: "not a locale!!" });
  assert.ok(bad.success, "invalid values are dropped, not a 400");
  assert.equal(bad.data.clientFeatures, undefined);
  assert.equal(bad.data.timeZone, undefined);
  assert.equal(bad.data.locale, undefined);

  const absent = parse({});
  assert.ok(absent.success);
  assert.equal(parseClientFeatures(absent.data.clientFeatures).profile1, true, "absent → profile 1");
});

test("timeZone: a valid IANA zone of at most 64 characters", () => {
  assert.equal(lenientTimeZone(" America/New_York "), "America/New_York");
  assert.equal(lenientTimeZone("UTC"), "UTC");
  assert.equal(lenientTimeZone(`Europe/${"x".repeat(80)}`), undefined);
  assert.equal(lenientTimeZone(""), undefined);
  assert.equal(lenientTimeZone(42), undefined);
  assert.equal(lenientTimeZone("Not/AZone"), undefined);
});

test("locale: canonical BCP-47 of at most 35 characters", () => {
  assert.equal(lenientLocale("fr"), "fr");
  assert.equal(lenientLocale("EN-gb"), "en-GB");
  assert.equal(lenientLocale("x".repeat(40)), undefined);
  assert.equal(lenientLocale("en_US!"), undefined);
  assert.equal(lenientLocale(null), undefined);
  // Every value that survives can go straight to Intl.
  for (const value of ["de", "zh-Hant-TW", "sr-Latn"]) {
    const locale = lenientLocale(value)!;
    assert.doesNotThrow(() => new Intl.DateTimeFormat(locale));
  }
});

test("researchEffort is accepted and ignored, and its presence is logged once (SPEC §2.1)", () => {
  const known = parse({ researchEffort: "deep" });
  assert.ok(known.success);
  const unknown = parse({ researchEffort: "ludicrous" });
  assert.ok(unknown.success, "an unknown level is dropped, never a 400");
  assert.equal(unknown.data.researchEffort, undefined);

  const logged: Array<[string, unknown]> = [];
  const log = (message: string, detail: unknown) => void logged.push([message, detail]);
  assert.equal(noteIgnoredResearchEffort({ researchEffort: "deep", client: "app" }, log), true);
  assert.equal(noteIgnoredResearchEffort({ client: "web" }, log), false);
  assert.deepEqual(logged, [["[research] ignored researchEffort", { value: "deep", client: "app" }]]);
});

test("the schema stays non-strict: unknown keys are stripped, fields native sends still parse (INV-9)", () => {
  const result = parse({ someFutureKey: 1, canvasEnabled: false, webSearch: true, regenerateInstruction: "shorter", regenerate: true, conversationId: "ckabcdefghijklmnopqrstuvw" });
  assert.ok(result.success);
  assert.equal("someFutureKey" in result.data, false);
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/request.ts"), "utf8");
  assert.doesNotMatch(source, /this \.strict\(\) schema/, "the stale comment is corrected (SPEC §2.2)");
  assert.doesNotMatch(source, /\.strict\(\)/);
});

test("profile negotiation reads clientFeatures only (INV-26)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/client-features.ts"), "utf8");
  // The one input is the declared list: no client name, origin or app version.
  assert.match(source, /export function parseClientFeatures\(raw: readonly string\[\] \| undefined\): ClientFeatureSet/);
  const set = parseClientFeatures(["citations"]);
  assert.equal(set.profile1, false);
  assert.equal(set.has("timeline"), false, "a client may declare features without timeline and keep profile-1 shapes");
});
