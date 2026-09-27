import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  fenceMatchesWrittenFile,
  receiptCanRetry,
  receiptFailureReason,
  receiptIconKindForCall,
  receiptLabel,
  receiptLabelForCall,
  writtenPaths,
} from "../src/lib/chat/tool-receipt";
import { buildRun } from "../src/components/chat/thought-process-model";
import type { ClientActivityEvent } from "../src/types/chat";

const swift = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Every `case "a", "b": return single("Phrase")` (or `return "Phrase"`) in one Swift function body. */
function swiftTable(source: string, fn: string): Map<string, string> {
  const start = source.indexOf(fn);
  assert.notEqual(start, -1, `${fn} is gone`);
  const end = source.indexOf("\n    }\n", start);
  const body = source.slice(start, end);
  const table = new Map<string, string>();
  const re = /case ((?:"[a-z_]+"(?:, )?)+): return (?:single\()?"([^"]+)"/g;
  for (const match of body.matchAll(re)) {
    for (const name of match[1].match(/"([a-z_]+)"/g) ?? []) table.set(name.slice(1, -1), match[2]);
  }
  assert.ok(table.size > 10, `${fn} parsed too few cases`);
  return table;
}

test("the web receipt says every call the Mac and iPhone say, in the same words", () => {
  const chat = swift("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeRunPresentation.swift");
  const work = swift("native/Packages/JunoNativeKit/Sources/JunoWorkKit/JunoWorkVocabulary.swift");
  const tables: Array<[Map<string, string>, boolean]> = [
    [swiftTable(chat, "public static func runningLine"), true],
    [swiftTable(chat, "public static func doneLine"), false],
    [swiftTable(work, "public static func toolPresent"), true],
    [swiftTable(work, "public static func toolPast"), false],
  ];
  for (const [table, running] of tables) {
    for (const [tool, phrase] of table) {
      assert.equal(receiptLabel(tool, { running }), phrase, `${tool} (${running ? "running" : "done"})`);
    }
  }
});

test("a connector call wears its connector and a readable tool title", () => {
  assert.equal(receiptLabelForCall("Linear", "linear__create_issue"), "Linear · Create issue");
  assert.equal(receiptLabelForCall("Linear", "linear__create_issue", true), "Linear · Create issue");
  assert.equal(receiptLabelForCall("Web search", "web_search"), "Searched the web");
  assert.equal(receiptLabelForCall("Web search", "web_search", true), "Searching the web");
  assert.equal(receiptLabelForCall("Linear", undefined), "Linear");
  assert.equal(receiptLabelForCall(undefined, undefined), "Used a tool");
  assert.equal(receiptIconKindForCall("web_search"), "search");
  assert.equal(receiptIconKindForCall("linear__create_issue"), "connectors");
});

test("a write is never offered again; a read is", () => {
  assert.equal(receiptCanRetry("linear__create_issue"), false);
  assert.equal(receiptCanRetry("permanently_delete"), false);
  assert.equal(receiptCanRetry("write_file"), false);
  assert.equal(receiptCanRetry("web_fetch"), true);
});

test("a failure says why in one line", () => {
  assert.equal(receiptFailureReason({ server: "X", name: "y", status: "ok", result: "fine" }), null);
  assert.equal(
    receiptFailureReason({ server: "X", name: "y", status: "failed", result: "\n403 Forbidden\nmore" }),
    "403 Forbidden",
  );
  assert.equal(
    receiptFailureReason({ server: "X", name: "y", status: "failed", resultNote: "unfinished" }),
    "The run ended before this call returned.",
  );
});

test("a fence naming a file a write receipt carries is recognised by path or leaf", () => {
  const events = [
    { id: "1", kind: "write", title: "edit src/app/page.tsx", detail: "+3 −1" },
    { id: "2", kind: "tool", title: "$ npm test" },
  ] as ClientActivityEvent[];
  const written = writtenPaths(events);
  assert.deepEqual([...written], ["src/app/page.tsx"]);
  assert.equal(fenceMatchesWrittenFile("src/app/page.tsx", written), true);
  assert.equal(fenceMatchesWrittenFile("./page.tsx", written), true);
  assert.equal(fenceMatchesWrittenFile("layout.tsx", written), false);
  assert.equal(fenceMatchesWrittenFile(undefined, written), false);
});

test("the Thought process tool step speaks the receipt vocabulary", () => {
  const run = buildRun(
    [
      {
        id: "t",
        kind: "tool",
        title: "Using Linear",
        detail: "linear__create_issue",
        tool: { server: "Linear", name: "linear__create_issue", status: "failed", result: "Team not found" },
      } as ClientActivityEvent,
    ],
    null,
  );
  const step = run.steps.find((s) => s.kind === "tool");
  assert.equal(step?.label, "Linear · Create issue");
  assert.equal(step?.detail, "Team not found");
  assert.equal(step?.icon, "connectors");
  assert.equal(step?.failed, true);
});
