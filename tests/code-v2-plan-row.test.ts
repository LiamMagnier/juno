/**
 * The plan row above the Code composer (plan-row.ts / plan-row.tsx): the
 * newest lead todo list, shown while working or while steps are left.
 */
import "./support/ignore-css";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanRow } from "@/components/code/v2/plan-row";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { planRowModel } from "@/lib/code-v2/plan-row";

(globalThis as unknown as { React: typeof React }).React = React;

const list = (id: string, todos: { text: string; status: "pending" | "in_progress" | "completed" }[], agentId?: string): TurnItem => ({
  id,
  kind: "todo_list",
  createdAt: "2026-11-05T00:00:00.000Z",
  todos,
  ...(agentId ? { agentId } : {}),
});

test("the newest lead list wins; a child's list is ignored", () => {
  const items = [
    list("a", [{ text: "Old", status: "pending" }]),
    list("b", [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }, { text: "Test", status: "pending" }]),
    list("c", [{ text: "Child step", status: "pending" }], "agent-1"),
  ];
  const plan = planRowModel(items, "running");
  assert.ok(plan);
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 3);
  assert.equal(plan.current, "Fix");
  assert.equal(plan.finished, false);
});

test("no list, an empty list, or a finished plan on an idle session shows nothing", () => {
  assert.equal(planRowModel([], "running"), null);
  assert.equal(planRowModel([list("a", [])], "running"), null);
  const finished = [list("a", [{ text: "Fix", status: "completed" }])];
  assert.equal(planRowModel(finished, "idle"), null);
  assert.equal(planRowModel(finished, "running")?.finished, true);
  assert.equal(planRowModel([list("a", [{ text: "Fix", status: "pending" }])], "idle")?.current, "Fix", "steps left stay visible");
});

test("the row renders a labelled, collapsed disclosure", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlanRow, { items: [list("b", [{ text: "Read", status: "completed" }, { text: "Fix the bug", status: "in_progress" }])], state: "running" }),
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="1 of 2 steps done"/);
  assert.match(html, /Fix the bug/);
  assert.equal(renderToStaticMarkup(React.createElement(PlanRow, { items: [], state: "running" })), "");
});
