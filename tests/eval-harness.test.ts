import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { EVAL_CATEGORIES, EVAL_SUITE, citationQuality } from "@/lib/eval/suite";
import { ROUTER_BENCHMARK_CLASSES, evaluateRouter, runEvalSuite, summarize } from "@/lib/eval/runner";

/*
 * The evaluation harness (BRIEF §53), honest by construction: every category
 * is present, every record says how it was produced, graders reject wrong
 * answers, and nothing that was not run counts as a pass.
 */

test("every §53 category has exactly one task", () => {
  assert.deepEqual(EVAL_SUITE.map((t) => t.category).sort(), [...EVAL_CATEGORIES].sort());
});

test("graders accept the authored responses and reject wrong ones", () => {
  const wrong: Record<string, string> = {
    "chat-names": "1. Ash\n2. Pebble",
    "reason-bat-ball": "Answer: $0.10",
    "code-palindrome": "```js\nfunction isPalindrome(s){ return s === [...s].reverse().join(''); }\n```",
    "tool-multiply": "7006652",
    "search-cited": "Node 24.",
    "long-needle": "I could not find it.",
    "artifact-counter": "```html\n<p>0</p>\n```",
    "doc-memo": "## Purpose\nx",
    "sheet-csv": "name,qty,price\nStapler,two,7.50",
    "slides-outline": "## Slide 1: Welcome",
    "multilingual-fr": "The capital of Australia is Canberra.",
    "instruct-three-words": "Vast, restless blue.",
  };
  for (const task of EVAL_SUITE.filter((t) => !t.notRunnable)) {
    assert.equal(task.grade(task.mock).success, true, `${task.id} rejects its own mock`);
    assert.ok(wrong[task.id] !== undefined, `${task.id} has a negative case`);
    assert.equal(task.grade({ text: wrong[task.id], toolCalls: 0 }).success, false, `${task.id} accepts a wrong answer`);
  }
});

test("code graders run the code in a sandbox with a timeout", () => {
  const spin = EVAL_SUITE.find((t) => t.id === "code-palindrome")!;
  const r = spin.grade({ text: "```js\nfunction isPalindrome(){ while(true){} }\n```" });
  assert.equal(r.success, false);
  const escape = spin.grade({ text: "```js\nfunction isPalindrome(){ return process.exit(1); }\n```" });
  assert.equal(escape.success, false, "a crash is a failure, not a pass");
  const marker = `/tmp/alevr-eval-escape-${process.pid}`;
  const write = spin.grade({
    text: `\`\`\`js\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "x");\nfunction isPalindrome(s){ const t=s.toLowerCase().replace(/[^a-z0-9]/g,""); return t===[...t].reverse().join(""); }\n\`\`\``,
  });
  assert.equal(write.success, false, "file-system access is denied by --permission");
  assert.equal(existsSync(marker), false);
});

test("citation quality", () => {
  assert.equal(citationQuality(undefined), 0);
  assert.equal(
    citationQuality([
      { title: "A", url: "https://a.example/x", snippet: "" },
      { title: "", url: "http://b.example", snippet: "" },
    ]),
    0.5
  );
});

test("mock mode: labelled records; infrastructure categories are not_run, never passes", async () => {
  const records = await runEvalSuite({ mode: "mock", routeContext: { isConfigured: () => true } });
  const s = summarize(records);
  assert.equal(s.total, EVAL_CATEGORIES.length);
  assert.equal(s.passed, s.ran);
  for (const r of records) {
    if (r.mode === "not_run") {
      assert.equal(r.success, null);
      assert.ok(r.notes.length > 10);
    } else {
      assert.equal(r.mode, "mock");
      assert.equal(r.latencySource, "router_estimate");
      assert.equal(r.costSource, "priced_mock_tokens");
      assert.ok(r.model && r.provider && r.taskClass);
    }
  }
  for (const c of ["deep_research", "memory", "agent_persistence", "browser_tasks", "computer_use"]) {
    assert.equal(records.find((r) => r.category === c)?.mode, "not_run", c);
  }
});

test("live mode: measured numbers from the injected call; a failing model fails; errors are recorded", async () => {
  let calls = 0;
  const records = await runEvalSuite({
    mode: "live",
    routeContext: { isConfigured: () => true },
    live: async ({ prompt }) => {
      calls += 1;
      if (prompt.includes("JavaScript")) throw new Error("provider 529");
      return { text: "nope", inputTokens: 100, outputTokens: 5, latencyMs: 321 };
    },
  });
  const ran = records.filter((r) => r.mode === "live");
  assert.equal(calls, ran.length);
  assert.ok(ran.every((r) => r.success === false));
  assert.ok(ran.filter((r) => r.latencyMs === 321).every((r) => r.latencySource === "measured"));
  assert.match(records.find((r) => r.category === "coding")!.errors[0], /529/);
  assert.equal(records.find((r) => r.category === "long_context")?.mode, "not_run", "expensive task opt-in");
});

test("no configured provider: tasks are not_run with the reason, not failures", async () => {
  const records = await runEvalSuite({ mode: "live", routeContext: { isConfigured: () => false }, live: async () => assert.fail() });
  assert.ok(records.every((r) => r.mode === "not_run"));
});

test("router evaluation covers benchmark-shaped classes and shows fallback", () => {
  const rows = evaluateRouter();
  for (const b of ROUTER_BENCHMARK_CLASSES) assert.ok(rows.some((r) => r.taskId === b.id), b.id);
  for (const row of rows) {
    const def = row.picks[0];
    const down = row.picks.find((p) => p.scenario.startsWith("fallback:"))!;
    assert.notEqual(down.provider, def.provider, `${row.taskId}: provider-down fallback stays on that provider`);
    assert.ok(row.picks.every((p) => p.tier >= 1 && p.tier <= 3));
  }
  const hard = rows.find((r) => r.taskId === "repo-bugfix")!;
  const easy = rows.find((r) => r.taskId === "small-talk")!;
  assert.ok(hard.picks[0].expectedTotalMicroUsd > easy.picks[0].expectedTotalMicroUsd);
  assert.notEqual(hard.picks[0].effort, "instant");
});
