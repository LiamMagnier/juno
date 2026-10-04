import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, FREE_DEFAULT_EFFORT, FREE_DEFAULT_MODEL, defaultModelFor, getModel } from "@/lib/models";
import { canUseModel } from "@/lib/plans";

test("Free starts on GPT-6 Luna at Low, a model Free can use", () => {
  assert.equal(FREE_DEFAULT_MODEL, "openai:gpt-6-luna");
  assert.equal(FREE_DEFAULT_EFFORT, "low");
  assert.ok(getModel(FREE_DEFAULT_MODEL));
  assert.ok(canUseModel("FREE", FREE_DEFAULT_MODEL));
});

test("a Free account still on the stored generic default gets Luna; a chosen model is kept", () => {
  assert.equal(defaultModelFor("FREE", DEFAULT_MODEL), FREE_DEFAULT_MODEL);
  assert.equal(defaultModelFor("FREE", null), FREE_DEFAULT_MODEL);
  assert.equal(defaultModelFor("FREE", "anthropic:claude-haiku-4-5"), "anthropic:claude-haiku-4-5");
  assert.equal(defaultModelFor("PRO", DEFAULT_MODEL), DEFAULT_MODEL);
  assert.equal(defaultModelFor("PRO", null), DEFAULT_MODEL);
});

test("the turn and the composer both start Free at Low", () => {
  const turn = readFileSync("src/lib/chat/turn/model.ts", "utf8");
  assert.match(turn, /plan === "FREE" && requestedId === FREE_DEFAULT_MODEL \? FREE_DEFAULT_EFFORT/);
  const provider = readFileSync("src/components/app/app-provider.tsx", "utf8");
  assert.match(provider, /bootstrap\.quota\.plan === "FREE" \? \{ \.\.\.DEFAULT_COMPOSER_PREFS, reasoningEffort: FREE_DEFAULT_EFFORT \}/);
});
