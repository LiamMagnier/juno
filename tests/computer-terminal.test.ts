/**
 * The read-only terminal pane (docs/design/agents-v2/COMPUTERS_2026-10.md
 * S5.1): its pure helpers (ANSI stripping, grouping by call, follow-bottom,
 * when to poll) and the promise that matters most, that the pane has no input:
 * nothing a person types there can reach the computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComputerTerminal,
  TERMINAL_CAPPED_TEXT,
  TERMINAL_POLL_IDLE_MS,
  TERMINAL_POLL_RUNNING_MS,
  exitSentence,
  isScrolledToBottom,
  stripAnsi,
  terminalBlocks,
  terminalPollDelay,
  terminalRunning,
} from "@/components/agents/computer-terminal";
import type { ClientShellOutputRow } from "@/components/agents/agents-transport";

// tsx compiles the components' JSX with the classic runtime, which reads a global React.
(globalThis as { React?: typeof React }).React = React;

const row = (seq: number, callId: string, stream: ClientShellOutputRow["stream"], text: string): ClientShellOutputRow => ({
  seq,
  callId,
  stream,
  text,
  createdAt: "2026-10-30T10:00:00.000Z",
});

test("ANSI escapes and control characters are stripped; a carriage return keeps what was drawn last", () => {
  assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m done"), "ok done");
  assert.equal(stripAnsi("\u001b]0;title\u0007prompt"), "prompt", "OSC title");
  assert.equal(stripAnsi("\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\"), "link", "OSC 8 hyperlink");
  assert.equal(stripAnsi("a\u0000b\u0007c\u001b[2Kd"), "abcd");
  assert.equal(stripAnsi("tab\tkept\nnewline kept"), "tab\tkept\nnewline kept");
  assert.equal(stripAnsi("10%\r50%\r100%\ndone"), "100%\ndone", "a progress bar shows its last frame");
  assert.equal(stripAnsi("line\r\n"), "line\n", "CRLF reads as a newline");
});

test("rows group into one block per call, in write order, with the command, output and exit", () => {
  const blocks = terminalBlocks([
    row(5, "b", "command", "ls"),
    row(1, "a", "command", "python3 -c 'print(1)'"),
    row(2, "a", "stdout", "\u001b[33m1\u001b[0m"),
    row(3, "a", "stdout", "\n"),
    row(4, "a", "exit", JSON.stringify({ exitCode: 0, timedOut: false, capped: false })),
    row(6, "b", "stderr", "ls: cannot access\n"),
    row(7, "b", "stdout", `\n${TERMINAL_CAPPED_TEXT}\n`),
    row(8, "b", "exit", JSON.stringify({ exitCode: 2, timedOut: false, capped: true })),
  ]);
  assert.deepEqual(
    blocks.map((block) => block.callId),
    ["a", "b"]
  );
  assert.equal(blocks[0].command, "python3 -c 'print(1)'");
  assert.deepEqual(blocks[0].segments, [{ stream: "stdout", text: "1\n" }], "pieces of one stream joined, ANSI gone");
  assert.deepEqual(blocks[0].exit, { exitCode: 0, timedOut: false });
  assert.deepEqual(blocks[1].segments, [
    { stream: "stderr", text: "ls: cannot access\n" },
    { stream: "note", text: TERMINAL_CAPPED_TEXT },
  ]);
  assert.deepEqual(exitSentence(blocks[1].exit!), { text: "exit 2", failed: true });
  assert.deepEqual(exitSentence({ exitCode: 0, timedOut: false }), { text: "exit 0", failed: false });
  assert.equal(exitSentence({ exitCode: 124, timedOut: true }).failed, true);
});

test("a command is running until its exit row arrives; the pane polls fast only then, and stops when the task ends", () => {
  assert.equal(terminalRunning([]), false);
  assert.equal(terminalRunning([row(1, "a", "command", "sleep 5")]), true);
  assert.equal(terminalRunning([row(1, "a", "command", "x"), row(2, "a", "exit", "{}")]), false);
  assert.equal(terminalRunning([row(1, "a", "command", "x"), row(2, "a", "exit", "{}"), row(3, "b", "command", "y")]), true);
  assert.equal(terminalPollDelay({ running: true, runLive: true, more: false }), TERMINAL_POLL_RUNNING_MS);
  assert.equal(TERMINAL_POLL_RUNNING_MS, 1000, "a line a second shows within 2 s");
  assert.equal(terminalPollDelay({ running: false, runLive: true, more: false }), TERMINAL_POLL_IDLE_MS);
  assert.equal(terminalPollDelay({ running: false, runLive: false, more: false }), null, "the task ended: no more polling");
  assert.equal(terminalPollDelay({ running: true, runLive: false, more: true }), 0, "more waiting: read it now");
});

test("follow-bottom: the pane follows only while the person is at the bottom", () => {
  assert.equal(isScrolledToBottom({ scrollTop: 900, scrollHeight: 1200, clientHeight: 300 }), true);
  assert.equal(isScrolledToBottom({ scrollTop: 880, scrollHeight: 1200, clientHeight: 300 }), true, "within a few pixels");
  assert.equal(isScrolledToBottom({ scrollTop: 400, scrollHeight: 1200, clientHeight: 300 }), false, "scrolled up to read");
  assert.equal(isScrolledToBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 300 }), true, "nothing to scroll");
});

test("the pane has no input: no field, nothing editable, no key handler, a log that is not announced", () => {
  for (const runId of [null, "run_1"]) {
    const html = renderToStaticMarkup(React.createElement(ComputerTerminal, { agentId: "agent_1", agentName: "Mira", runId }));
    assert.equal(/<(input|textarea|select|button|form)\b/i.test(html), false, "no input element (and no button until there is output to jump to)");
    assert.equal(/contenteditable/i.test(html), false);
    assert.match(html, /role="log"/);
    assert.match(html, /aria-live="off"/);
    assert.match(html, /Read-only/);
  }
  const source = readFileSync("src/components/agents/computer-terminal.tsx", "utf8");
  for (const handler of ["onKeyDown", "onKeyUp", "onKeyPress", "onInput", "onBeforeInput", "onPaste", "onChange", "contentEditable", "<input", "<textarea", "addEventListener"]) {
    assert.equal(source.includes(handler), false, `no ${handler} in the pane`);
  }
  // Its only request is the read of stored output: nothing is ever sent to the computer.
  assert.equal(/fetch\(/.test(source), false);
  assert.match(source, /fetchShellOutput\(/);
  assert.equal(/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(source), false);
});

test("the empty and loading states say what will show, in the agent's name", () => {
  const none = renderToStaticMarkup(React.createElement(ComputerTerminal, { agentId: "agent_1", agentName: "Mira", runId: null }));
  assert.match(none, /Mira hasn’t run a command yet/);
  const loading = renderToStaticMarkup(React.createElement(ComputerTerminal, { agentId: "agent_1", agentName: "Mira", runId: "run_1" }));
  assert.match(loading, /Loading…/);
});
