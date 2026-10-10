import test from "node:test";
import assert from "node:assert/strict";
import { CLIENT_FEATURES, WEB_CLIENT_FEATURES, parseClientFeatures } from "@/lib/chat/client-features";
import { chatBodySchema } from "@/lib/chat/request";
import {
  LOCAL_FOLDER_TOOL_IDS,
  checkLocalFolderArgs,
  isLocalFolderToolId,
  lenientLocalFolder,
  localFolderPresent,
  localFolderPromptSection,
  localFolderToolsEnabled,
  localFolderToolsFor,
  type LocalFolderGate,
} from "@/lib/chat/local-folder";
import {
  LOCAL_TOOL_CANCELLED_OUTPUT,
  LOCAL_TOOL_TIMEOUT_OUTPUT,
  awaitLocalToolResult,
  deliverLocalToolResult,
  pendingLocalToolCalls,
} from "@/lib/chat/local-folder-bridge";
import { createLocalFolderTools } from "@/lib/chat/local-folder-tools";
import { resolvedNativeTool, withNativeChatTools } from "@/lib/tools/toolset";
import { executeToolBatch } from "@/lib/tools/dispatch";
import { UNTRUSTED_OPEN } from "@/lib/untrusted-content";
import type { StreamChunk } from "@/types/chat";
import { turnModule } from "./chat-turn-source";

/*
 * Work in a folder (src/lib/chat/local-folder.ts): the Mac picks a folder,
 * the chat model works in it, and every call runs on the Mac. The server's
 * half is the gate (only a Mac that says it runs them gets the tools), the
 * shape checks, and the round trip.
 */

const OPEN_GATE: LocalFolderGate = {
  clientDeclares: true,
  folder: { name: "Invoices", access: "read_write" },
  privateMode: false,
  voiceMode: false,
  lockdown: false,
  functionToolsReachModel: true,
  agenticTools: true,
  conversationKind: "chat",
  artifactEdit: false,
  researchActive: false,
  skillPermits: true,
};

test("the web never claims local_folder; the Mac may", () => {
  assert.ok(CLIENT_FEATURES.includes("local_folder"));
  assert.ok(!WEB_CLIENT_FEATURES.includes("local_folder"), "a browser has no folder to run the tools in");
  assert.ok(parseClientFeatures(["timeline", "local_folder"]).has("local_folder"));
});

test("the folder tools are offered only with the client feature AND a folder", () => {
  assert.equal(localFolderToolsEnabled(OPEN_GATE), true);
  assert.equal(localFolderToolsEnabled({ ...OPEN_GATE, clientDeclares: false }), false, "web and iOS: no tools");
  assert.equal(localFolderToolsEnabled({ ...OPEN_GATE, folder: undefined }), false, "no folder named: no tools");
  for (const off of [
    { privateMode: true },
    { voiceMode: true },
    { lockdown: true },
    { functionToolsReachModel: false },
    { agenticTools: false },
    { conversationKind: "code" },
    { artifactEdit: true },
    { researchActive: true },
  ] satisfies Partial<LocalFolderGate>[]) {
    assert.equal(localFolderToolsEnabled({ ...OPEN_GATE, ...off }), false, JSON.stringify(off));
  }
});

test("the route reads the feature from the request, never from the client's name", () => {
  const approvals = turnModule("approvals");
  assert.match(approvals, /clientDeclares: input\.clientFeatures\?\.includes\(LOCAL_FOLDER_FEATURE\)/);
  assert.match(approvals, /folder: input\.localFolder/);
  const tools = turnModule("tools");
  assert.match(tools, /const folderTools = localFolder\s*\?\s*createLocalFolderTools/);
});

test("localFolder on the request is lenient and never carries a path", () => {
  assert.deepEqual(lenientLocalFolder({ name: "Invoices", access: "read_write" }), { name: "Invoices", access: "read_write" });
  assert.deepEqual(lenientLocalFolder({ name: "/Users/liam/Documents/Invoices" }), { name: "Invoices", access: "read" });
  assert.deepEqual(lenientLocalFolder({ name: "Tax\u0000 2026", access: "admin" }), { name: "Tax 2026", access: "read" });
  assert.equal(lenientLocalFolder({ name: "" }), undefined);
  assert.equal(lenientLocalFolder("Invoices"), undefined);
  assert.equal(lenientLocalFolder(undefined), undefined);

  const parsed = chatBodySchema.safeParse({ message: "hi", localFolder: { name: "Invoices", access: "read_write" } });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.localFolder, { name: "Invoices", access: "read_write" });
  const bad = chatBodySchema.safeParse({ message: "hi", localFolder: 42 });
  assert.ok(bad.success, "a malformed folder is dropped, never a 400");
  assert.equal(bad.data.localFolder, undefined);
});

test("a read-only folder is offered only the looking tools and open", () => {
  assert.deepEqual(localFolderToolsFor("read"), ["folder_list_dir", "folder_read_file", "folder_search", "folder_open"]);
  assert.deepEqual(localFolderToolsFor("read_write"), [...LOCAL_FOLDER_TOOL_IDS]);
  assert.ok(isLocalFolderToolId("folder_delete"));
  assert.ok(!isLocalFolderToolId("delete"));
});

test("paths that spell their way out are refused before they reach the Mac", () => {
  for (const path of ["/etc/passwd", "~/Desktop", "../secrets", "a/../../b", "a\\b", ""]) {
    const check = checkLocalFolderArgs("folder_read_file", { path });
    assert.equal(check.ok, false, path);
  }
  assert.deepEqual(checkLocalFolderArgs("folder_read_file", { path: "notes/today.md", extra: "dropped" }), {
    ok: true,
    args: { path: "notes/today.md" },
  });
  assert.equal(checkLocalFolderArgs("folder_move", { from: "a.txt" }).ok, false, "to is required");
  assert.equal(checkLocalFolderArgs("folder_search", {}).ok, false, "a search needs a name or a text");
  const run = checkLocalFolderArgs("folder_run_command", { command: "ls", timeout_seconds: 9_999 });
  assert.ok(run.ok && run.args.timeout_seconds === 300, "the timeout is clamped");
});

test("rows show the action and the location, never a write's content", () => {
  assert.deepEqual(localFolderPresent("folder_write_file", { path: "out.md", content: "secret body" }), {
    action: "write",
    path: "out.md",
  });
  assert.deepEqual(localFolderPresent("folder_run_command", { command: "pandoc a.md -o a.docx" }), {
    action: "run",
    command: "pandoc a.md -o a.docx",
  });
  const resolved = resolvedNativeTool(createLocalFolderTools({
    folder: { name: "Invoices", access: "read_write" },
    userId: "u1",
    generationId: "generation-1",
    send: () => {},
  })[0]);
  assert.equal(resolved.canonical, "local_folder");
  assert.equal(resolved.dedupe, false, "reading a file again after an edit reads the new file");
  assert.ok(resolved.timeoutMs > 60_000, "the bound covers the approval card and a command");
});

test("the prompt names the folder and its access, never a path", () => {
  const section = localFolderPromptSection({ name: "Invoices", access: "read" });
  assert.match(section, /"Invoices" \(read only\)/);
  assert.doesNotMatch(section, /\/Users\//);
});

test("a call goes to the Mac as a local_tool frame and waits for its answer", async () => {
  const sent: StreamChunk[] = [];
  let authorized = 0;
  const tools = createLocalFolderTools({
    folder: { name: "Invoices", access: "read_write" },
    userId: "user-1",
    generationId: "generation-1",
    send: (chunk) => sent.push(chunk),
    newCallId: () => "lft_00000000-0000-0000-0000-000000000001",
  });
  const read = tools.find((tool) => tool.tool.function.name === "folder_read_file")!;
  const pending = read.execute({ path: "march.csv" }, undefined, { onAuthorized: () => authorized++ });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorized, 1, "running once sent, so the stall watchdog is held");
  assert.deepEqual(sent, [
    { type: "local_tool", call: { id: "lft_00000000-0000-0000-0000-000000000001", tool: "folder_read_file", args: { path: "march.csv" } } },
  ]);

  assert.equal(
    deliverLocalToolResult({ callId: "lft_00000000-0000-0000-0000-000000000001", userId: "someone-else", result: { outcome: "succeeded", output: "x" } }),
    "unknown",
    "another account cannot answer this call"
  );
  assert.equal(
    deliverLocalToolResult({
      callId: "lft_00000000-0000-0000-0000-000000000001",
      userId: "user-1",
      generationId: "generation-1",
      result: { outcome: "succeeded", output: "date,amount\n2026-03-01,12" },
    }),
    "accepted"
  );
  const result = await pending;
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith(UNTRUSTED_OPEN), "file text reaches the model inside the envelope");
  assert.equal(result.body, "date,amount\n2026-03-01,12");
  assert.equal(pendingLocalToolCalls(), 0);
  assert.equal(
    deliverLocalToolResult({ callId: "lft_00000000-0000-0000-0000-000000000001", userId: "user-1", result: { outcome: "succeeded", output: "again" } }),
    "unknown",
    "a call is answered once"
  );
});

test("a declined call reads as a denial; a bad call never leaves the server", async () => {
  const sent: StreamChunk[] = [];
  const [, , , , , , , remove] = createLocalFolderTools({
    folder: { name: "Invoices", access: "read_write" },
    userId: "user-1",
    generationId: "generation-1",
    send: (chunk) => sent.push(chunk),
    newCallId: () => "lft_00000000-0000-0000-0000-000000000002",
  });
  assert.equal(remove.tool.function.name, "folder_delete");
  const pending = remove.execute({ path: "old.pdf" });
  await new Promise((resolve) => setImmediate(resolve));
  deliverLocalToolResult({
    callId: "lft_00000000-0000-0000-0000-000000000002",
    userId: "user-1",
    result: { outcome: "denied", output: "The user chose Deny." },
  });
  const denied = await pending;
  assert.equal(denied.ok, false);
  assert.equal(denied.status, "denied");

  const refused = await remove.execute({ path: "../../etc" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "invalid_args");
  assert.equal(sent.length, 1, "the refused call sent no frame");
});

test("the wait always ends: timeout and Stop", async () => {
  const timedOut = await awaitLocalToolResult({ callId: "lft_t", userId: "u", generationId: "g-00000001", timeoutMs: 5 });
  assert.deepEqual(timedOut, { outcome: "failed", output: LOCAL_TOOL_TIMEOUT_OUTPUT });
  const controller = new AbortController();
  const waiting = awaitLocalToolResult({ callId: "lft_s", userId: "u", generationId: "g-00000001", timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await waiting, { outcome: "failed", output: LOCAL_TOOL_CANCELLED_OUTPUT });
  assert.equal(pendingLocalToolCalls(), 0);
});

test("the dispatcher's queued act names the action and the file, before the Mac answers", async () => {
  const tools = createLocalFolderTools({
    folder: { name: "Invoices", access: "read_write" },
    userId: "user-1",
    generationId: "generation-1",
    send: () => {},
    newCallId: () => "lft_00000000-0000-0000-0000-000000000003",
  });
  const toolset = withNativeChatTools(undefined, tools)!;
  const controller = new AbortController();
  const batch = executeToolBatch(
    [{ name: "folder_read_file", callId: "c1", round: 0, index: 0, argsText: JSON.stringify({ path: "2026/march.csv" }) }],
    controller.signal,
    { toolset }
  );
  const first = await batch.next();
  assert.deepEqual(first.value, {
    type: "tool",
    phase: "status",
    server: "Read a file",
    name: "folder_read_file",
    callId: "c1",
    status: "queued",
    present: { action: "read", path: "2026/march.csv" },
    argsText: "{\"path\":\"2026/march.csv\"}",
  });
  controller.abort();
  await batch.return([]);
});
