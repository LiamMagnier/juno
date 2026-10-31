import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * A FILE DELETED FROM A PROJECT MUST STOP REACHING THE MODEL (PRJ-0).
 *
 * Deleting a project file tombstones the attachment (`deletedAt`, parser
 * state "deleted") and keeps its `projectId` and `extractedText`. The project
 * page filtered tombstones out, but the lineage that builds every project
 * turn did not, so the person saw the file gone while its full text was still
 * sent on each message, in the project and in every subfolder. These pin the
 * filter on each query that reads a project's files for a model or a count.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const LIVE_FILES = /files:\s*\{\s*(?:\/\/[^\n]*\n\s*)*where:\s*\{\s*deletedAt:\s*null,\s*fileName:\s*\{\s*not:\s*"__cover__"\s*\}\s*\}/;

test("project lineage reads only live, non-cover files", () => {
  assert.match(read("src/lib/projects/project-tree-server.ts"), LIVE_FILES);
});

test("a Work run in a project names only live files", () => {
  assert.match(read("scripts/work-runner.ts"), LIVE_FILES);
});

test("the project list counts only live files, as the project page does", () => {
  for (const path of ["src/app/api/projects/route.ts", "src/app/api/projects/[id]/route.ts"]) {
    assert.match(read(path), LIVE_FILES, path);
  }
});
