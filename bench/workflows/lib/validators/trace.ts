/**
 * Trace checkers for the workflows whose outcome is a BEHAVIOUR rather than a
 * file: a tool that must not run, a stream that must resume without a
 * duplicate, a stall that must be reported. The trace they read is written by
 * harness-owned instrumentation — the fake MCP server's request log, the
 * bench's tools that record every execution, the raw SSE bytes each simulated
 * device received — not by the product describing itself. Where a field is the
 * product's own output (the text a client stitched together, a scan verdict)
 * the checker compares it to ground truth the harness holds.
 */

import type { CheckResult, TraceChecker, ValidatorSpec } from "../types";
import { fail, pass, readOutput } from "./util";

type TraceSpec = Extract<ValidatorSpec, { kind: "trace" }>;
type Json = Record<string, unknown>;

const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const asObject = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Parse raw SSE into frames: `id:` (optional) and the JSON of `data:`. */
export function parseSse(raw: string): Array<{ id: number | null; data: Json | null; rawData: string }> {
  const frames: Array<{ id: number | null; data: Json | null; rawData: string }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let id: number | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const rawData = data.join("\n");
    let parsed: Json | null = null;
    try {
      parsed = JSON.parse(rawData) as Json;
    } catch {
      parsed = null;
    }
    frames.push({ id: Number.isFinite(id) ? id : null, data: parsed, rawData });
  }
  return frames;
}

/** Text a client would show from frames applied once each, in seq order. */
export function textFromFrames(frames: Array<{ id: number | null; data: Json | null }>): { text: string; terminals: number; duplicatesSkipped: number } {
  const seen = new Set<number>();
  let text = "";
  let terminals = 0;
  let duplicatesSkipped = 0;
  for (const frame of frames) {
    if (frame.id !== null) {
      if (seen.has(frame.id)) {
        duplicatesSkipped += 1;
        continue;
      }
      seen.add(frame.id);
    }
    const type = frame.data?.type;
    if (type === "delta" && typeof frame.data?.text === "string") text += frame.data.text;
    if (type === "done" || type === "error" || type === "handoff") terminals += 1;
  }
  return { text, terminals, duplicatesSkipped };
}

type Checker = (trace: Json, params: Json, id: (what: string) => string) => CheckResult[];

const CHECKERS: Record<TraceChecker, Checker> = {
  "mcp-tool-call": (trace, params, id) => {
    const server = asObject(trace.server);
    const client = asObject(trace.client);
    const requests = asArray(server.requests);
    const calls = requests.filter((r) => r.method === "tools/call");
    const expectedTool = String(params.tool ?? "search_tickets");
    const forbiddenTool = String(params.forbiddenTool ?? "create_ticket");
    const tokenRequests = asArray(server.tokenRequests);
    const checks: CheckResult[] = [];
    checks.push(client.probeOk === true ? pass(id("probe"), "server probed as addable") : fail(id("probe"), `probe result: ${JSON.stringify(client.probe ?? null)}`));
    checks.push(server.registrations === 1 ? pass(id("registration"), "one dynamic client registration") : fail(id("registration"), `${String(server.registrations)} registrations`));
    checks.push(tokenRequests.length === 1 && tokenRequests[0].hasVerifier === true ? pass(id("pkce"), "one token exchange, with a PKCE verifier") : fail(id("pkce"), `token requests: ${JSON.stringify(tokenRequests)}`));
    checks.push(requests.some((r) => r.method === "tools/list" && r.auth === true) ? pass(id("list"), "tools/list with the bearer token") : fail(id("list"), "no authenticated tools/list reached the server"));
    const good = calls.filter((c) => c.tool === expectedTool && JSON.stringify(c.args) === JSON.stringify(params.args ?? { query: "login" }) && c.auth === true);
    checks.push(calls.length === 1 && good.length === 1 ? pass(id("one-call"), `exactly one authenticated ${expectedTool} call with the requested arguments`) : fail(id("one-call"), `server saw ${calls.length} tools/call: ${JSON.stringify(calls)}`));
    checks.push(calls.some((c) => c.tool === forbiddenTool) ? fail(id("no-write"), `${forbiddenTool} reached the server`) : pass(id("no-write"), `${forbiddenTool} never called`));
    checks.push(client.callResult === params.expectResult ? pass(id("result"), "the client received exactly what the server returned") : fail(id("result"), `client got ${JSON.stringify(client.callResult)}, server returned ${JSON.stringify(params.expectResult)}`));
    checks.push(server.unauthenticatedRejected === true ? pass(id("auth-required"), "an unauthenticated request was refused (401)") : fail(id("auth-required"), "no evidence the server refused an unauthenticated request"));
    return checks;
  },

  "ssrf-refusal": (trace, _params, id) => {
    const attempts = asArray(trace.attempts);
    const canary = asObject(trace.canary);
    const allowed = attempts.filter((a) => a.refused !== true);
    return [
      attempts.length > 0 ? pass(id("attempts"), `${attempts.length} hostile target(s) tried`) : fail(id("attempts"), "nothing was attempted"),
      allowed.length === 0 ? pass(id("refused"), "every private/loopback/metadata target refused") : fail(id("refused"), `allowed: ${allowed.map((a) => String(a.target)).join(", ")}`),
      canary.connections === 0 ? pass(id("canary"), "the loopback canary listener received no connection") : fail(id("canary"), `canary received ${String(canary.connections)} connection(s)`),
    ];
  },

  "tool-batch-authorization": (trace, params, id) => {
    const executions = asArray(trace.executions).map((e) => String(e.name));
    const results = asArray(trace.results);
    const callOrder = Array.isArray(trace.callOrder) ? (trace.callOrder as string[]) : [];
    const write = String(params.writeTool ?? "publish_note");
    const byCall = new Map(results.map((r) => [String(r.callId), r]));
    const status = (callId: string) => byCall.get(callId);
    const checks: CheckResult[] = [];
    checks.push(results.length === callOrder.length && callOrder.every((c) => byCall.has(c)) ? pass(id("all-answered"), `${results.length} calls, every one answered`) : fail(id("all-answered"), `${results.length} results for ${callOrder.length} calls`));
    checks.push(JSON.stringify(results.map((r) => String(r.callId))) === JSON.stringify(callOrder) ? pass(id("call-order"), "results come back in call order") : fail(id("call-order"), "results out of call order"));
    checks.push(!executions.includes(write) ? pass(id("denied-write-not-run"), `${write} never executed after the denial`) : fail(id("denied-write-not-run"), `${write} executed despite the denial`));
    const authRequests = asArray(trace.authorizationRequests).filter((a) => a.toolName === write).length;
    checks.push(authRequests === 1 ? pass(id("authorization-asked"), "authorization requested exactly once for the write") : fail(id("authorization-asked"), `${authRequests} authorization request(s) for the write`));
    const reads = Array.isArray(params.readTools) ? (params.readTools as string[]) : [];
    const missingReads = reads.filter((r) => !executions.includes(r));
    checks.push(missingReads.length === 0 ? pass(id("reads-ran"), "the permitted reads executed") : fail(id("reads-ran"), `reads not executed: ${missingReads.join(", ")}`));
    for (const [callId, code] of Object.entries(asObject(params.expectErrors))) {
      const r = status(callId);
      const got = r ? `${String(r.status)}/${String(asObject(r.error).code ?? "")}` : "missing";
      checks.push(r && asObject(r.error).code === code ? pass(id(`error:${callId}`), got) : fail(id(`error:${callId}`), `expected ${String(code)}, got ${got}`));
    }
    const brokerless = asObject(trace.brokerless);
    checks.push(
      brokerless.executed === false && brokerless.errorCode === "not_permitted"
        ? pass(id("fail-closed"), "with no authorization broker the write is refused, not run")
        : fail(id("fail-closed"), `brokerless outcome: ${JSON.stringify(brokerless)}`)
    );
    return checks;
  },

  "stop-mid-tool": (trace, _params, id) => {
    const stopAt = Number(trace.stopAt);
    const executions = asArray(trace.executions);
    const effects = asArray(trace.effects);
    const results = asArray(trace.results);
    const calls = Number(trace.calls);
    const late = executions.filter((e) => Number(e.startedAt) > stopAt);
    const lateEffects = effects.filter((e) => Number(e.at) >= stopAt);
    const notCancelled = results.filter((r) => r.wasRunningOrQueued === true && r.status !== "cancelled");
    return [
      results.length === calls ? pass(id("all-answered"), `${calls} calls, every one answered`) : fail(id("all-answered"), `${results.length} results for ${calls} calls`),
      notCancelled.length === 0 ? pass(id("cancelled"), "every unfinished call is answered cancelled") : fail(id("cancelled"), `not cancelled: ${JSON.stringify(notCancelled)}`),
      late.length === 0 ? pass(id("nothing-started-after-stop"), "no tool started after the stop") : fail(id("nothing-started-after-stop"), `started after stop: ${late.map((e) => String(e.name)).join(", ")}`),
      lateEffects.length === 0 ? pass(id("no-effect-after-stop"), "no side effect committed after the stop") : fail(id("no-effect-after-stop"), `effects after stop: ${JSON.stringify(lateEffects)}`),
      trace.threwAbort === true ? pass(id("turn-ended"), "the batch ended with the abort, after answering") : fail(id("turn-ended"), "the batch did not surface the abort"),
    ];
  },

  "stream-resume": (trace, _params, id) => streamChecks(trace, id, ["deviceA"]),
  "second-device": (trace, _params, id) => streamChecks(trace, id, ["deviceA", "deviceB"]),

  "stall-detect": (trace, params, id) => {
    const idleMs = Number(trace.idleMs);
    const slack = Number(params.slackMs ?? 400);
    const stalledAt = Number(trace.stalledAt);
    const lastEventAt = Number(trace.lastEventAt);
    const gap = stalledAt - lastEventAt;
    const message = String(trace.userMessage ?? "");
    const hold = asObject(trace.holdScenario);
    return [
      trace.stalled === true ? pass(id("detected"), "the silent provider was detected") : fail(id("detected"), "no stall was reported; the turn would hang"),
      gap >= idleMs - 5 && gap <= idleMs + slack ? pass(id("timely"), `reported ${gap}ms after the last event (window ${idleMs}ms)`) : fail(id("timely"), `reported ${gap}ms after the last event, expected ${idleMs}–${idleMs + slack}ms`),
      message && !/you stopped|stopped by you|cancelled by user/i.test(message) ? pass(id("honest-message"), `"${message.slice(0, 80)}"`) : fail(id("honest-message"), `message misattributes the stop or is empty: "${message}"`),
      typeof trace.partialText === "string" && trace.partialText === trace.truthPartial ? pass(id("partial-kept"), "the partial answer is kept") : fail(id("partial-kept"), "partial answer lost or altered"),
      hold.stalled === false && Number(hold.toolRunMs) > idleMs ? pass(id("no-false-stall"), `a ${String(hold.toolRunMs)}ms tool run under a hold did not trip the ${idleMs}ms watchdog`) : fail(id("no-false-stall"), `hold scenario: ${JSON.stringify(hold)}`),
    ];
  },

  "injection-envelope": (trace, params, id) => {
    const wrapped = String(trace.wrapped ?? "");
    const verdict = asObject(trace.verdict);
    const open = "<<<JUNO_UNTRUSTED_BEGIN>>>";
    const close = "<<<JUNO_UNTRUSTED_END>>>";
    const opens = wrapped.split(open).length - 1;
    const closes = wrapped.split(close).length - 1;
    const begin = wrapped.indexOf(open);
    const end = wrapped.lastIndexOf(close);
    const inside = begin >= 0 && end > begin ? wrapped.slice(begin + open.length, end) : "";
    const outside = begin >= 0 && end > begin ? wrapped.slice(0, begin) + wrapped.slice(end + close.length) : wrapped;
    const hostile = Array.isArray(params.hostileMarkers) ? (params.hostileMarkers as string[]) : [];
    const signals = Array.isArray(verdict.signals) ? (verdict.signals as string[]) : [];
    const expectSignals = Array.isArray(params.expectSignals) ? (params.expectSignals as string[]) : [];
    const legit = String(params.legitimateClaim ?? "");
    return [
      verdict.severity === params.expectSeverity ? pass(id("severity"), `scan verdict ${String(verdict.severity)}`) : fail(id("severity"), `scan verdict ${String(verdict.severity)}, expected ${String(params.expectSeverity)}`),
      expectSignals.every((s) => signals.includes(s)) ? pass(id("signals"), signals.join(", ")) : fail(id("signals"), `signals ${signals.join(", ") || "none"}, expected ${expectSignals.join(", ")}`),
      opens === 1 && closes === 1 && begin < end ? pass(id("one-envelope"), "exactly one envelope; the page's fake close marker was defanged") : fail(id("one-envelope"), `${opens} open / ${closes} close markers — the page could escape the envelope`),
      hostile.every((h) => !outside.includes(h)) ? pass(id("nothing-hostile-outside"), "no hostile text outside the envelope") : fail(id("nothing-hostile-outside"), "hostile text sits outside the untrusted envelope"),
      legit && inside.includes(legit) ? pass(id("legit-claim-kept"), `"${legit}" kept for the summary`) : fail(id("legit-claim-kept"), `legitimate claim "${legit}" missing from the envelope`),
    ];
  },

  "calc-exact": (trace, params, id) => {
    const steps = asArray(trace.steps);
    const expected = Array.isArray(params.steps) ? (params.steps as number[]) : [];
    const checks: CheckResult[] = [];
    expected.forEach((want, i) => {
      const got = steps[i]?.value;
      checks.push(got === want ? pass(id(`step-${i + 1}`), `${String(steps[i]?.expression)} = ${String(got)}`) : fail(id(`step-${i + 1}`), `got ${String(got)} from ${String(steps[i]?.expression)}, expected ${want}`));
    });
    checks.push(trace.answer === params.answer ? pass(id("answer"), `${String(trace.answer)}`) : fail(id("answer"), `answer ${String(trace.answer)}, expected ${String(params.answer)}`));
    return checks;
  },
};

function streamChecks(trace: Json, id: (what: string) => string, devices: string[]): CheckResult[] {
  const truth = String(trace.truthText ?? "");
  const checks: CheckResult[] = [];
  const connections = asArray(trace.connections);
  for (const device of devices) {
    const mine = connections.filter((c) => c.device === device);
    const frames = mine.flatMap((c) => parseSse(String(c.raw ?? "")));
    const independent = textFromFrames(frames);
    const clientText = asObject(trace.clientText)[device];
    checks.push(mine.length > 0 ? pass(id(`${device}:connections`), `${mine.length} connection(s)`) : fail(id(`${device}:connections`), "no connection recorded"));
    checks.push(independent.text === truth ? pass(id(`${device}:frames-complete`), `${frames.length} frames carry the full answer`) : fail(id(`${device}:frames-complete`), `frames carry ${independent.text.length}/${truth.length} chars`));
    checks.push(clientText === truth ? pass(id(`${device}:client-text`), "the client's stitched transcript equals the answer exactly") : fail(id(`${device}:client-text`), `client shows ${String(clientText ?? "").length}/${truth.length} chars${typeof clientText === "string" && clientText.length > truth.length ? " (duplicated text)" : ""}`));
    checks.push(independent.terminals === 1 ? pass(id(`${device}:one-terminal`), "exactly one terminal frame") : fail(id(`${device}:one-terminal`), `${independent.terminals} terminal frames`));
  }
  if (devices.length === 1) {
    const frames = connections.flatMap((c) => parseSse(String(c.raw ?? "")));
    const overlap = textFromFrames(frames).duplicatesSkipped;
    checks.push(overlap > 0 ? pass(id("overlap-exercised"), `${overlap} duplicate frame(s) arrived and were dropped`) : fail(id("overlap-exercised"), "the reconnect never overlapped the drop, so duplicate handling was not exercised"));
    checks.push(connections.length >= 2 ? pass(id("reconnected"), "the drop was followed by a resume") : fail(id("reconnected"), "no resume connection"));
  }
  return checks;
}

export function validateTrace(spec: TraceSpec, outputsDir: string): CheckResult[] {
  const id = (what: string) => `trace:${spec.checker}:${what}`;
  let trace: Json;
  try {
    trace = JSON.parse(readOutput(outputsDir, spec.file).toString("utf8")) as Json;
  } catch (error) {
    return [fail(id("trace"), `trace unreadable: ${(error as Error).message}`)];
  }
  const checker = CHECKERS[spec.checker];
  if (!checker) return [fail(id("checker"), `unknown checker ${spec.checker}`)];
  return checker(trace, spec.params ?? {}, id);
}
