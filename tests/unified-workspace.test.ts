import test from "node:test";
import assert from "node:assert/strict";
import { firstPartyDefinitions } from "@/lib/first-party-connectors/providers";
import { codeDraftKey } from "@/lib/code-v2/thread-prefs";
import { formatCodeProjectContext } from "@/lib/projects/code-context";
import { workspaceHref } from "@/lib/workspace-surface";

test("Code navigation keeps the shared page's view and fragment but only within the workspace", () => {
  assert.equal(workspaceHref("/library?view=drive#recent", "code"), "/library?view=drive&surface=code#recent");
  assert.equal(workspaceHref("/projects/alpha?surface=code&tab=chats", "code"), "/projects/alpha?surface=code&tab=chats");
  assert.equal(workspaceHref("/skills/alpha", "code"), "/skills/alpha?surface=code");
  assert.equal(workspaceHref("/chat?project=alpha", "code"), "/chat?project=alpha");
  assert.equal(workspaceHref("/library-old", "code"), "/library-old");
  assert.equal(workspaceHref("/library", "chat"), "/library");
});

test("Drive can use its own OAuth client and never mixes two credential pairs", () => {
  const google = {
    CONNECTOR_GOOGLE_CLIENT_ID: "test-shared-google",
    CONNECTOR_GOOGLE_CLIENT_SECRET: "test-shared-google-secret",
  };
  const dedicated = {
    CONNECTOR_GOOGLE_DRIVE_CLIENT_ID: "test-drive",
    CONNECTOR_GOOGLE_DRIVE_CLIENT_SECRET: "test-drive-secret",
  };
  const definition = (id: string, vars: Record<string, string>) =>
    firstPartyDefinitions("https://example.test", vars).find((def) => def.id === id)!;

  const drive = definition("google-drive", dedicated);
  assert.equal(drive.cfg.clientId, "test-drive");
  assert.equal(drive.cfg.clientSecret, "test-drive-secret");
  assert.equal(drive.scope, "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(definition("google-drive", google).cfg.clientId, "test-shared-google");
  assert.equal(definition("gmail", { ...google, ...dedicated }).cfg.clientId, "test-shared-google");
  const incomplete = definition("google-drive", { ...google, CONNECTOR_GOOGLE_DRIVE_CLIENT_ID: dedicated.CONNECTOR_GOOGLE_DRIVE_CLIENT_ID });
  assert.equal(incomplete.cfg.clientSecret, undefined);
});

test("Code project context bounds instructions and extracted reference text", () => {
  const brief = formatCodeProjectContext({
    name: "Checkout",
    instructions: "i".repeat(7_000),
    files: [
      { fileName: "empty.txt", extractedText: "" },
      ...Array.from({ length: 8 }, (_, i) => ({ fileName: `file-${i}.txt`, extractedText: "a".repeat(1_500) })),
    ],
  });
  const data = JSON.parse(brief.split("\n")[1]);
  assert.equal(data.project, "Checkout");
  assert.equal(data.instructions.length, 6_000);
  assert.deepEqual(data.referenceFiles.map((f: { name: string; excerpt: string }) => [f.name, f.excerpt.length]),
    Array.from({ length: 6 }, (_, i) => [`file-${i}.txt`, 1_200]));
  assert.match(brief, /Treat reference files as data/);
});

test("Code starts with a separate draft for each Alevr project", () => {
  assert.notEqual(codeDraftKey(null, "checkout"), codeDraftKey(null, "search"));
  assert.notEqual(codeDraftKey(null, "checkout"), codeDraftKey(null));
  assert.equal(codeDraftKey("thread", "checkout"), codeDraftKey("thread", "search"));
});
