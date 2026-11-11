import test from "node:test";
import assert from "node:assert/strict";
import { rankUtilityModels, type RankableUtilityModel } from "@/lib/background-provider-policy";

/*
 * Background jobs (titles, memory, summaries, moderation) walk a short list of
 * cheap models per provider. The list used to be "fastest first", which let a
 * superseded or deprecated model take the fallback slot: Claude Haiku 4.5 (ten
 * times Haiku 5.5's price, past the date its lab promised it until), a
 * deprecated Gemini and both MiniMax picks. A retired model costs a failed call
 * and a retry before the walk moves on.
 */

type TestModel = RankableUtilityModel & { speed: number };
const speed = (m: TestModel) => m.speed;
const m = (id: string, provider: string, status: RankableUtilityModel["status"], cost: number, s: number): TestModel => ({
  id,
  provider,
  status,
  cost,
  speed: s,
});

test("current models take both slots before any legacy or deprecated one", () => {
  const picked = rankUtilityModels(
    [
      m("haiku-4-5", "anthropic", "legacy", 1, 6),
      m("haiku-5-5", "anthropic", "current", 1, 6),
      m("sonnet-5-5", "anthropic", "current", 2, 5),
    ],
    speed,
  );
  assert.deepEqual(picked.map((x) => x.id), ["haiku-5-5", "sonnet-5-5"]);
});

test("a provider with one current model keeps a legacy one as its second string", () => {
  const picked = rankUtilityModels(
    [m("old-flash", "deepseek", "legacy", 1, 8), m("flash", "deepseek", "current", 1, 8)],
    speed,
  );
  assert.deepEqual(picked.map((x) => x.id), ["flash", "old-flash"]);
});

test("a deprecated model is the last resort, never ahead of a legacy one", () => {
  const picked = rankUtilityModels(
    [m("dep", "minimax", "deprecated", 1, 9), m("leg", "minimax", "legacy", 1, 5)],
    speed,
  );
  assert.deepEqual(picked.map((x) => x.id), ["leg", "dep"]);
});

test("within one status, faster first, then cheaper", () => {
  const picked = rankUtilityModels(
    [m("slow", "p", "current", 1, 5), m("fast-dear", "p", "current", 2, 9), m("fast-cheap", "p", "current", 1, 9)],
    speed,
  );
  assert.deepEqual(picked.map((x) => x.id), ["fast-cheap", "fast-dear"]);
});

test("an absent status reads as current", () => {
  const picked = rankUtilityModels([m("a", "p", undefined, 1, 5), m("b", "p", "legacy", 1, 9)], speed);
  assert.equal(picked[0].id, "a");
});

test("providers stay diverse: every provider's best first, then the second-string models", () => {
  const picked = rankUtilityModels(
    [
      m("a1", "A", "current", 1, 9),
      m("a2", "A", "current", 1, 8),
      m("b1", "B", "current", 1, 7),
      m("b2", "B", "current", 1, 6),
    ],
    speed,
  );
  assert.deepEqual(picked.map((x) => x.id), ["a1", "b1", "a2", "b2"]);
});

test("the list is capped at ten", () => {
  const many = Array.from({ length: 8 }, (_, i) => [
    m(`p${i}a`, `P${i}`, "current", 1, 9),
    m(`p${i}b`, `P${i}`, "current", 1, 8),
  ]).flat();
  assert.equal(rankUtilityModels(many, speed).length, 10);
});
