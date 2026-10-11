import { test } from "node:test";
import assert from "node:assert/strict";
import { removeOwnedCodeProject } from "../src/lib/code-project-removal";

test("another owner's project returns 404 without cancelling or deleting records", async () => {
  let touched = false;
  const result = await removeOwnedCodeProject("owner", { id: "foreign", cwd: "/project" }, {
    find: async (user) => { assert.equal(user, "owner"); return null; },
    activeTasks: async () => { touched = true; return []; }, cancel: async () => { touched = true; }, erase: async () => { touched = true; return []; },
  });
  assert.equal(result.status, 404); assert.equal(touched, false);
});
test("running tasks are cancelled before any project data can be erased", async () => {
  const calls: string[] = [];
  const result = await removeOwnedCodeProject("owner", { id: "project", cwd: "/stale" }, {
    find: async () => ({ id: "project", key: "stable", path: "/real" }),
    activeTasks: async (user, cwd, key) => { assert.deepEqual([user, cwd, key], ["owner", "/real", "stable"]); return ["run"]; },
    cancel: async (id) => { calls.push(id); }, erase: async () => { throw new Error("must not erase a running task"); },
  });
  assert.equal(result.status, 409); assert.deepEqual(calls, ["run"]);
});
test("settled removal uses the authoritative owned path and returns erased sessions", async () => {
  const result = await removeOwnedCodeProject("owner", { id: "project", cwd: "/stale" }, {
    find: async () => ({ id: "project", key: "stable", path: "/real" }), activeTasks: async () => [], cancel: async () => {},
    erase: async (...args) => { assert.deepEqual(args, ["owner", "/real", "stable", "project"]); return ["session"]; },
  });
  assert.deepEqual(result, { status: 200, sessionIds: ["session"] });
});
