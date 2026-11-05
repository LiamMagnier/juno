/**
 * The web viewer ends its session when the server refuses a heartbeat for
 * access (403: the account lost its plan, the rollout, or the server's
 * computers), in the server's sentence, in watch and in control alike, and
 * then neither beats nor reconnects (docs/design/agents-v2/COMPUTERS_2026-10.md
 * §S1.3). The heartbeat lives inside the component's effects, so this reads
 * the source, as tests/agents-computer-handback.test.ts does for the viewer's
 * other rules; the server's half is in tests/computer-routes-gating.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/agents/computer-viewer.tsx", import.meta.url), "utf8");

function block(startMarker: string, length = 1600): string {
  const at = source.indexOf(startMarker);
  assert.notEqual(at, -1, `missing: ${startMarker}`);
  return source.slice(at, at + length);
}

test("a refused heartbeat ends the session in both modes, before the control-only handling", () => {
  const beat = block("const beat = async () => {");
  const refused = beat.indexOf("outcome.status === 403");
  const controlOnly = beat.indexOf('if (current !== "control") return;');
  assert.ok(refused !== -1, "403 is handled");
  assert.ok(controlOnly !== -1 && refused < controlOnly, "a watch beat's 403 is not ignored");
  assert.match(beat.slice(refused, refused + 120), /endSession\(outcome\.message\)/, "in the server's words");
  assert.match(beat, /if \(endedRef\.current\) return;/, "no beat after the session ended");
});

test("the reconnect's control check treats 403 as the end of the session", () => {
  const reconnect = block("scheduleReconnectRef.current = () => {", 2000);
  assert.match(reconnect, /if \(endedRef\.current\) return;/, "an ended session never reconnects");
  assert.match(reconnect, /beat\.status === 403\) \{\s*endSession\(beat\.message\);/);
});

test("an ended session reconnects only when opened afresh", () => {
  const connect = block("const connect = useCallback(", 700);
  assert.match(connect, /if \(endedRef\.current && reason !== "open"\) return;/);
  const end = block("const endSession = useCallback(", 1200);
  assert.match(end, /setStatus\("ended"\)/);
  assert.match(end, /setErrorMessage\(message\)/);
  assert.match(end, /onControlLost\?\.\(message\)/, "the overlay hears why control ended");
});
