import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BACKGROUND_PROVIDER_MODE,
  isBackgroundProviderMode,
  normalizeBackgroundProviderPolicy,
  resolveBackgroundCandidates,
  type UtilityCandidate,
} from "@/lib/background-provider-policy";

/*
 * The risk these cover: `utilityModelCandidates()` returned every free chat
 * model across every configured provider, and the utility walk took whichever
 * answered first. Automatic memory extraction decrypts user messages, so a
 * conversation held with Anthropic could have its contents read by DeepSeek
 * because DeepSeek's free tier was quicker — and nothing said so anywhere.
 */

const anthropic: UtilityCandidate = { id: "claude-haiku", provider: "anthropic" };
const anthropicSlow: UtilityCandidate = { id: "claude-haiku-old", provider: "anthropic" };
const openai: UtilityCandidate = { id: "gpt-mini", provider: "openai" };
const deepseek: UtilityCandidate = { id: "deepseek-chat", provider: "deepseek" };
const local: UtilityCandidate = { id: "juno-local-small", provider: "juno", isLocal: true };

const ALL = [anthropic, anthropicSlow, openai, deepseek];

test("the default is the privacy-preserving mode", () => {
  assert.equal(DEFAULT_BACKGROUND_PROVIDER_MODE, "same_provider");
  assert.equal(normalizeBackgroundProviderPolicy(null).mode, "same_provider");
  assert.equal(normalizeBackgroundProviderPolicy({}).mode, "same_provider");
});

test("an unrecognised stored mode falls back to the safe one, not to the loose one", () => {
  // A value written by a future build, or corrupted, must not be read as
  // permission to cross providers.
  assert.equal(normalizeBackgroundProviderPolicy({ mode: "anything" as never }).mode, "same_provider");
  assert.equal(isBackgroundProviderMode("any_allowed_provider"), true);
  assert.equal(isBackgroundProviderMode("walk_everything"), false);
});

test("same_provider keeps background work with the conversation's provider", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates.map((c) => c.id), ["claude-haiku", "claude-haiku-old"]);
  // A second model from the same provider is still a real fallback — free-tier
  // quotas are usually per model, not per provider.
  assert.equal(decision.candidates.every((c) => c.provider === "anthropic"), true);
});

test("same_provider skips the job rather than crossing when the provider has no utility model", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: "xai",
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.deniedReason, "no_candidate_for_conversation_provider");
});

test("same_provider with no known conversation provider does not guess", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: null,
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.deniedReason, "no_candidate_for_conversation_provider");
});

test("selected_provider pins background work to the chosen provider", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "selected_provider", selectedProvider: "openai" },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates.map((c) => c.id), ["gpt-mini"]);
});

test("selected_provider denies when its provider is unavailable", () => {
  for (const selectedProvider of ["mistral", null]) {
    const decision = resolveBackgroundCandidates({
      policy: { mode: "selected_provider", selectedProvider },
      conversationProvider: "anthropic",
      candidates: ALL,
    });
    assert.deepEqual(decision.candidates, [], `${selectedProvider} should deny`);
    assert.equal(decision.deniedReason, "selected_provider_unavailable");
  }
});

test("any_allowed_provider is the only mode that may cross, and must be chosen by name", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "any_allowed_provider" },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.equal(decision.candidates.length, ALL.length);
});

test("local_only uses local models and denies when none exist", () => {
  const withLocal = resolveBackgroundCandidates({
    policy: { mode: "local_only" },
    conversationProvider: "anthropic",
    candidates: [...ALL, local],
  });
  assert.deepEqual(withLocal.candidates.map((c) => c.id), ["juno-local-small"]);

  const withoutLocal = resolveBackgroundCandidates({
    policy: { mode: "local_only" },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.deepEqual(withoutLocal.candidates, []);
  assert.equal(withoutLocal.deniedReason, "no_local_model");
});

test("an admin allowlist bounds every mode, including the permissive one", () => {
  const crossing = resolveBackgroundCandidates({
    policy: { mode: "any_allowed_provider", allowedProviders: ["anthropic"] },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.equal(crossing.candidates.every((c) => c.provider === "anthropic"), true);

  // And it can veto the user's own selection.
  const vetoed = resolveBackgroundCandidates({
    policy: {
      mode: "selected_provider",
      selectedProvider: "deepseek",
      allowedProviders: ["anthropic", "openai"],
    },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.deepEqual(vetoed.candidates, []);
  assert.equal(vetoed.deniedReason, "selected_provider_unavailable");
});

test("an allowlist that excludes everything denies rather than falling through", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "any_allowed_provider", allowedProviders: ["nobody"] },
    conversationProvider: "anthropic",
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.deniedReason, "excluded_by_allowlist");
});

test("no configured utility models is reported distinctly from a policy denial", () => {
  const decision = resolveBackgroundCandidates({
    policy: { mode: "any_allowed_provider" },
    conversationProvider: "anthropic",
    candidates: [],
  });
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.deniedReason, "no_candidates");
});

test("an account migrated from before the policy existed lands on same_provider", () => {
  // What the migration's column default produces for every existing row.
  const migrated = normalizeBackgroundProviderPolicy({
    mode: "same_provider",
    selectedProvider: null,
  });
  const decision = resolveBackgroundCandidates({
    policy: migrated,
    conversationProvider: "deepseek",
    candidates: ALL,
  });
  assert.deepEqual(decision.candidates.map((c) => c.id), ["deepseek-chat"]);
});

test("every mode is covered by a case in the resolver", () => {
  // A new mode added to the union without a branch here would fall through and
  // return undefined candidates, which reads as "allow nothing" only by luck.
  for (const mode of ["same_provider", "selected_provider", "any_allowed_provider", "local_only"] as const) {
    const decision = resolveBackgroundCandidates({
      policy: { mode, selectedProvider: "anthropic" },
      conversationProvider: "anthropic",
      candidates: [...ALL, local],
    });
    assert.ok(Array.isArray(decision.candidates), `${mode} returned no array`);
    assert.equal(decision.mode, mode);
  }
});
