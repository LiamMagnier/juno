import test from "node:test";
import assert from "node:assert/strict";
import { selectMemoriesForContext, inScope, type LifecycleEntry } from "../src/lib/memory-lifecycle.js";

test("shared project memory isolation: personal global memory is excluded when isolateProjectMemory is true", () => {
  const personalFact: LifecycleEntry = {
    id: "mem-personal",
    content: "User secret personal global belief",
    normalized: "belief global personal secret user",
    category: "personal",
    confidence: 1.0,
    source: "AUTO",
    createdAt: new Date(),
    projectId: null,
    kind: "FACT",
    status: "active",
    expiresAt: null,
    sourceRef: null,
    sourceMessageId: null,
  };

  const projectFact: LifecycleEntry = {
    id: "mem-project",
    content: "Team shared project architecture decision",
    normalized: "architecture decision project shared team",
    category: "work",
    confidence: 1.0,
    source: "AUTO",
    createdAt: new Date(),
    projectId: "project-abc",
    kind: "FACT",
    status: "active",
    expiresAt: null,
    sourceRef: null,
    sourceMessageId: null,
  };

  // In shared project context with isolateProjectMemory
  const result = selectMemoriesForContext([personalFact, projectFact], {
    projectId: "project-abc",
    isolateProjectMemory: true,
    now: new Date(),
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "mem-project");
  assert.equal(result.excluded.outOfScope, 1);
});

test("inScope helper respects isolateProjectMemory flag", () => {
  const globalEntry = { projectId: null };
  const projectEntry = { projectId: "proj-1" };
  const otherProjectEntry = { projectId: "proj-2" };

  // When isolateProjectMemory is false (legacy / personal workspace)
  assert.equal(inScope(globalEntry, "proj-1", false), true);
  assert.equal(inScope(projectEntry, "proj-1", false), true);
  assert.equal(inScope(otherProjectEntry, "proj-1", false), false);

  // When isolateProjectMemory is true (shared collaborative project)
  assert.equal(inScope(globalEntry, "proj-1", true), false); // PERSONAL EXCLUDED
  assert.equal(inScope(projectEntry, "proj-1", true), true); // MATCHED PROJECT INCLUDED
  assert.equal(inScope(otherProjectEntry, "proj-1", true), false); // OTHER PROJECT EXCLUDED
});
