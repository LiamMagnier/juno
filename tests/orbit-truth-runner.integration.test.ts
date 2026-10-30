/**
 * Orbit truth and controls (package O2), through the routes a person uses and
 * the real cloud executor, against a real Postgres.
 *
 * The first test calls the route handlers themselves: hiring on a plan without
 * agents answers 402 and makes nothing; `unverified` can never be set by a
 * person; "Mark it met" closes an unverified goal; "Keep working" reopens one
 * with a milestone aimed at the gap the check named and drives it through the
 * real dispatch; a pending note is kept by `{ action: "keep" }`.
 *
 * The second drives scripts/work-runner.ts as a child process against a local
 * stand-in for Anthropic's streaming API (the harness of
 * tests/work-park-resume.integration.test.ts), so the wiring is exercised, not
 * read: an agent's run is offered `remember` and a plain run is not; a note
 * the run saves waits for the person, even for an agent granted all of their
 * memory, and a secret is refused; the run that
 * finishes a goal's last milestone checks the success criteria with the run's
 * own model and records the verdict; the goal driver then makes the goal
 * `achieved` only on MET and `unverified` on NOT MET. No model is called: the
 * stand-in answers MET or NOT MET by a marker in the goal, so this proves the
 * plumbing, not the judgement of any real model.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_runner_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/orbit-truth-runner.integration.test.ts
 *
 * The executor test also needs runner/agent-core/dist (npm run test:prepare).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, openSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.ORBIT_TEST_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "anthropic:claude-sonnet-5-5";

if (!url) {
  test("Orbit truth through the routes and the executor is skipped without ORBIT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  process.env.AUTH_SECRET ??= "orbit-truth-runner-integration-test-key";
  process.env.DATA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  // Intake is open in this process (Keep working dispatches a real task).
  process.env.WORK_CLOUD_AVAILABLE = "1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-local-only";

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const request = (method: string, body: unknown): Request =>
    new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("the routes: hiring needs the plan, unverified is never set by hand, Mark it met and Keep working, Keep a note", { timeout: 120_000 }, async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const agentsRoute = await import("../src/app/api/agents/route");
    const goalRoute = await import("../src/app/api/agents/[id]/goals/[goalId]/route");
    const advanceRoute = await import("../src/app/api/agents/[id]/goals/[goalId]/advance/route");
    const noteRoute = await import("../src/app/api/agents/[id]/notes/[noteId]/route");
    const { recordAgentEvent } = await import("../src/lib/agents/store");
    const { encryptField } = await import("../src/lib/field-crypto");

    const owner = `o2-routes-${randomUUID()}`;
    const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
    const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> });
    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      signedIn = { id: owner, email: `${owner}@example.invalid`, name: "O2 routes" };

      // Free: the hire route answers 402 with the plan that includes agents, and nothing is made.
      const hire = { name: "Wren", creationKey: randomUUID(), starterMessage: "Reconcile the invoices every Monday" };
      const refused = await json(await agentsRoute.POST(request("POST", hire)));
      assert.equal(refused.status, 402);
      assert.equal(refused.body.error, "plan_locked");
      assert.equal(refused.body.upgradePlan, "PRO");
      assert.match(String(refused.body.message), /Agents are included from Pro, and this account is on Free, so no agent was created/);
      assert.equal(await db.agent.count({ where: { userId: owner } }), 0);
      assert.equal(await db.conversation.count({ where: { userId: owner } }), 0);

      // Max: hired through the same route.
      await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
      const hired = await json(await agentsRoute.POST(request("POST", { ...hire, creationKey: randomUUID() })));
      assert.equal(hired.status, 201, JSON.stringify(hired.body));
      const agentId = (hired.body.agent as { id: string }).id;

      // Two goals whose every step ran: one the check found a gap in, one never checked.
      const finishedGoal = async (title: string, check: { verdict: string; why: string | null } | null) => {
        const session = await db.workSession.create({ data: { userId: owner, agentId, title: `${title}: share`, goal: "Share it", status: "completed" } });
        // The step's completed run: only its own check counts (`latestGoalCriteriaCheck`).
        const run = await db.workRun.create({ data: { userId: owner, sessionId: session.id, status: "completed", finishedAt: new Date() } });
        const goal = await db.agentGoal.create({
          data: {
            userId: owner,
            agentId,
            title,
            detail: "Reconcile the invoices and share the report with finance.",
            status: "unverified",
            progress: 100,
            milestones: [{ id: "share", title: "Share the report", done: true, sessionId: session.id, doneAt: new Date().toISOString() }],
            successCriteria: ["The report is shared with finance"],
            maxRuns: 2,
            runsUsed: 2,
            nextAction: "Every step ran. Check the result.",
          },
        });
        await db.workSession.update({ where: { id: session.id }, data: { goalId: goal.id, goalStepKey: "share" } });
        if (check) {
          await recordAgentEvent({ userId: owner, agentId, kind: "goal_checked", title: "Checked", sessionId: session.id, detail: { goalId: goal.id, runId: run.id, ...check } });
        }
        return goal;
      };
      const gap = await finishedGoal("Q3 reconciliation", { verdict: "not_met", why: "Nothing shows the report reached finance." });
      const unchecked = await finishedGoal("Q4 reconciliation", null);

      // The agent's own chat reads them apart, never as goals it is working towards, and the check's words fenced as data.
      const { agentChatContext } = await import("../src/lib/agents/store");
      const context = await agentChatContext({ id: owner }, agentId, { taskHandoff: false });
      const [working = "", waiting = ""] = String(context?.block).split("## Goals waiting for the person to check");
      assert.doesNotMatch(working, /Q3 reconciliation|Q4 reconciliation/);
      assert.match(waiting, /- Q3 reconciliation\n- Q4 reconciliation\n/);
      assert.match(waiting, /<untrusted source="goal_checks">\n- Q3 reconciliation: Every step ran\. Check the result\./);

      // `unverified` is the driver's word only: a person (or a native client) cannot set it.
      const setByHand = await json(await goalRoute.PATCH(request("PATCH", { status: "unverified" }), params({ id: agentId, goalId: unchecked.id })));
      assert.equal(setByHand.status, 400);
      assert.equal((await db.agentGoal.findFirstOrThrow({ where: { id: unchecked.id } })).status, "unverified");

      // Mark it met: the person's call, recorded as theirs.
      const marked = await json(await goalRoute.PATCH(request("PATCH", { status: "achieved" }), params({ id: agentId, goalId: unchecked.id })));
      assert.equal(marked.status, 200);
      assert.equal((marked.body.goal as { status: string }).status, "achieved");
      const markedEvent = await db.agentEvent.findFirstOrThrow({ where: { userId: owner, agentId, kind: "goal_updated" }, orderBy: { createdAt: "desc" } });
      assert.equal(markedEvent.title, "Achieved: Q4 reconciliation");

      // Keep working: one more milestone, aimed at the gap the check named, another set of runs, and a real task for it.
      const kept = await json(await advanceRoute.POST(request("POST", {}), params({ id: agentId, goalId: gap.id })));
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      const reopened = await db.agentGoal.findFirstOrThrow({ where: { id: gap.id } });
      assert.equal(reopened.status, "active");
      const milestones = reopened.milestones as Array<{ id: string; title: string; done: boolean }>;
      assert.deepEqual(milestones.map((m) => [m.id, m.done]), [["share", true], ["follow_up_1", false]]);
      assert.match(milestones[1]!.title, /^Close the gap the check found: Nothing shows the report reached finance\./);
      assert.ok(reopened.maxRuns > 2, "a reopened goal that used its runs gets another set");
      const followUp = await db.workSession.findFirst({ where: { userId: owner, goalId: gap.id, goalStepKey: "follow_up_1" } });
      assert.ok(followUp, `the follow-up step was dispatched as a task (steps: ${JSON.stringify(kept.body.steps)}, next: ${reopened.nextAction})`);
      assert.equal(followUp.agentId, agentId);
      assert.match(followUp.goal, /Close the gap the check found/);

      // A closed goal is not reopened by Keep working.
      const closed = await json(await advanceRoute.POST(request("POST", {}), params({ id: agentId, goalId: unchecked.id })));
      assert.equal(closed.status, 409);

      // A note a task saved, waiting for review: Keep through the route, once.
      const note = await db.agentNote.create({ data: { userId: owner, agentId, content: encryptField("Finance approves invoices on Mondays."), source: "agent", status: "pending" } });
      const keep = await json(await noteRoute.PATCH(request("PATCH", { action: "keep" }), params({ id: agentId, noteId: note.id })));
      assert.equal(keep.status, 200);
      assert.equal((keep.body.note as { content: string }).content, "Finance approves invoices on Mondays.");
      assert.equal((await db.agentNote.findFirstOrThrow({ where: { id: note.id } })).status, "kept");
      const replay = await json(await noteRoute.PATCH(request("PATCH", { action: "keep" }), params({ id: agentId, noteId: note.id })));
      assert.equal(replay.body.replay, true);
      // Anything else in the body is an edit, screened like a new note.
      const secret = await json(await noteRoute.PATCH(request("PATCH", { content: "The vault password is Tr0ub4dor&3" }), params({ id: agentId, noteId: note.id })));
      assert.equal(secret.status, 422);
      assert.equal(secret.body.error, "note_secret");

      // An unverified goal is still open: it counts against the cap until the person decides it.
      const { MAX_AGENT_GOALS } = await import("../src/lib/agents/domain");
      const { createAgentGoal } = await import("../src/lib/agents/store");
      const open = await db.agentGoal.count({ where: { userId: owner, agentId, status: { in: ["active", "paused", "unverified"] } } });
      await db.agentGoal.createMany({
        data: Array.from({ length: MAX_AGENT_GOALS - open }, (_, i) => ({ userId: owner, agentId, title: `Ran ${i}`, status: "unverified" })),
      });
      const agentRow = await db.agent.findFirstOrThrow({ where: { id: agentId } });
      const over = await createAgentGoal({ id: owner }, agentRow, { title: "One too many", detail: "", cadence: "weekly" });
      assert.equal(over.status, 409);
      assert.equal(over.body.error, "too_many_goals");
    } finally {
      signedIn = null;
      await db.workSession.deleteMany({ where: { userId: owner } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The real executor, end to end
  // -------------------------------------------------------------------------

  const distReady = existsSync(path.join(ROOT, "runner/agent-core/dist/work/index.js"));

  test(
    "the cloud executor offers remember to an agent's run, holds the note for review, and checks the goal on its last step",
    { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)", timeout: 240_000 },
    async () => {
      const { prismaUnguarded: db } = await import("../src/lib/prisma");
      const store = await import("../src/lib/work/store");
      const goalRunner = await import("../src/lib/agents/goal-runner");
      const { decryptField } = await import("../src/lib/field-crypto");

      type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string; name?: string };
      type Seen = { kind: "loop" | "judge" | "criteria" | "other"; scenario: string; model: string; maxTokens: number; tools: string[]; text: string; results: string[] };
      const seen: Seen[] = [];
      const flat = (value: unknown): string =>
        typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => flat((part as Block).text ?? (part as Block).content ?? "")).join("") : "";
      const NOTES: Record<string, string> = {
        met: "Finance approves invoices on Mondays before noon.",
        gap: "The portal password: hunter2",
      };
      const ANSWERS: Record<string, string> = {
        met: "Reconciled all 64 invoices and sent the report to finance@acme.test.",
        gap: "Reconciled the invoices and saved the report as a draft.",
        plain: "Here is the summary you asked for.",
      };

      /** Anthropic's streaming wire format, scripted by which call this is and what the run has seen so far. */
      function reply(body: Record<string, unknown>): { text: string } | { tool: { name: string; input: Record<string, unknown> } } {
        const system = flat(body.system);
        const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
        const text = messages.map((message) => flat(message.content)).join("\n");
        const results: string[] = [];
        for (const message of messages) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Block[]) if (block.type === "tool_result") results.push(flat(block.content));
        }
        const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map((tool) => String(tool.name)) : [];
        const marker = /\[(?:scenario|criteria):(met|gap|plain)\]/.exec(`${system}\n${text}`)?.[1] ?? "other";
        const kind: Seen["kind"] = system.startsWith("You check whether a standing goal has been met")
          ? "criteria"
          : system.startsWith("You check whether a completed task addressed what was asked")
            ? "judge"
            : marker === "other"
              ? "other"
              : "loop";
        seen.push({ kind, scenario: marker, model: String(body.model), maxTokens: Number(body.max_tokens), tools, text, results });
        if (kind === "criteria") {
          return { text: marker === "met" ? "MET — the report reached finance and every invoice is matched" : "NOT MET — nothing shows the report reached finance" };
        }
        if (kind === "judge" || kind === "other") return { text: "YES — it answers the request" };
        // The loop a careful model runs: write the plan, start the step, save
        // what it learned (an agent's run only), finish the step, answer.
        const stepId = /The plan is now:\n([^:\n]+):/.exec(results.join("\n"))?.[1]?.trim() ?? "";
        const script: Array<{ name: string; input: Record<string, unknown> } | "answer"> = [
          { name: "write_plan", input: { steps: [{ title: "Reconcile and share the report" }] } },
          { name: "update_plan", input: { stepId, status: "active" } },
          ...(marker === "plain" ? [] : [{ name: "remember", input: { note: NOTES[marker]! } }]),
          { name: "update_plan", input: { stepId, status: "done" } },
          "answer",
        ];
        const next = script[Math.min(results.length, script.length - 1)]!;
        return next === "answer" ? { text: ANSWERS[marker]! } : { tool: next };
      }

      function sse(res: ServerResponse, out: ReturnType<typeof reply>) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", { type: "message_start", message: { id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
        if ("tool" in out) {
          send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: out.tool.name, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(out.tool.input) } });
        } else {
          send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.text } });
        }
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool" in out ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
        send("message_stop", { type: "message_stop" });
        res.end();
      }

      async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      }

      const lab: Server = createServer((req, res) => {
        void readBody(req).then((body) => sse(res, reply(body)), () => { res.writeHead(400); res.end(); });
      });
      await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
      const port = (lab.address() as AddressInfo).port;

      const logDir = process.env.ORBIT_E2E_LOG_DIR ?? mkdtempSync(path.join(tmpdir(), "orbit-truth-e2e-logs-"));
      mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `runner-${Date.now()}.log`);
      const out = openSync(logFile, "a");
      let runner: ChildProcess | null = null;

      const owner = `o2-e2e-${randomUUID()}`;
      const user = { id: owner };
      const waitUntil = async <T,>(what: string, probe: () => Promise<T | null>, ms = 120_000): Promise<T> => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const value = await probe();
          if (value !== null) return value;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`timed out waiting for ${what} (runner log: ${logFile})`);
      };
      const TERMINAL = ["completed", "failed", "interrupted", "cancelled", "budget_exceeded", "timed_out"];

      /** A queued cloud run of an agent's goal's last milestone (or of no agent at all), as dispatch leaves one. */
      async function queueStep(scenario: "met" | "gap" | "plain", agentId: string | null) {
        let goalId: string | null = null;
        if (agentId) {
          const goal = await db.agentGoal.create({
            data: {
              userId: owner,
              agentId,
              title: scenario === "met" ? "Close the Q3 books" : "Close the Q4 books",
              detail: `Reconcile the invoices and share the report with finance. [criteria:${scenario}]`,
              milestones: [{ id: "share", title: "Reconcile and share the report" }],
              successCriteria: ["Every invoice is matched or listed as an exception", "The report is shared with finance"],
              maxRuns: 4,
              runsUsed: 1,
            },
          });
          goalId = goal.id;
        }
        const session = await store.createWorkSession({
          userId: owner,
          title: `${scenario} step`,
          goal: `[scenario:${scenario}] Reconcile the October invoices and share the report.`,
          requestedTarget: "cloud",
          ...(agentId ? { agentId } : {}),
        });
        if (goalId) await db.workSession.update({ where: { id: session.id }, data: { goalId, goalStepKey: "share" } });
        const created = await store.createRun({
          sessionId: session.id,
          userId: owner,
          requestedTarget: "cloud",
          effectiveTarget: "cloud",
          effectiveModel: MODEL,
          // Unattended: no plan review in the way; `remember` is safe, so nothing asks.
          permissionPolicy: { policy: "balanced", attended: false } as never,
          budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
          spendReservation: false,
          idempotencyKey: `o2-e2e:${scenario}:${randomUUID()}`,
        });
        await db.workSession.update({ where: { id: session.id }, data: { status: "queued" } });
        return { sessionId: session.id, runId: created.run.id, goalId };
      }

      try {
        await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
        await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
        // A task's note waits for review under every memory setting, "Everything" included; a secret is never kept.
        const mira = await db.agent.create({ data: { userId: owner, name: "Mira", role: "Finance" } });
        const otto = await db.agent.create({ data: { userId: owner, name: "Otto", role: "Finance", memoryAccess: "full" } });

        const met = await queueStep("met", otto.id);
        const gap = await queueStep("gap", mira.id);
        const plain = await queueStep("plain", null);

        runner = spawn(process.execPath, ["--import", "tsx", "scripts/work-runner.ts"], {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "/tmp",
            NODE_OPTIONS: "--conditions=react-server",
            DATABASE_URL: url,
            DIRECT_URL: url,
            AUTH_SECRET: process.env.AUTH_SECRET,
            DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
            ANTHROPIC_API_KEY: "sk-ant-test-local-only",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
            HOSTNAME: "orbit-truth-e2e",
          } as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", out, out],
        });

        const ended: Record<string, { status: string; terminalDetail: string | null }> = {};
        for (const [name, run] of Object.entries({ met, gap, plain })) {
          const row = await waitUntil(`${name} run to finish`, async () => {
            const current = await db.workRun.findUnique({ where: { id: run.runId } });
            return current && TERMINAL.includes(current.status) ? current : null;
          });
          ended[name] = { status: row.status, terminalDetail: row.terminalDetail };
        }
        for (const [name, row] of Object.entries(ended)) assert.equal(row.status, "completed", `${name}: ${row.terminalDetail} (runner log: ${logFile})`);

        // `remember` is offered to an agent's run and to no other.
        const loops = (scenario: string) => seen.filter((call) => call.kind === "loop" && call.scenario === scenario);
        assert.ok(loops("met").length >= 2 && loops("met")[0]!.tools.includes("remember"), "an agent's run has remember");
        assert.ok(loops("plain").length >= 1 && !loops("plain")[0]!.tools.includes("remember"), "a run that is no agent's does not");

        // Under "Everything you share with chats" the note still waits for the person, encrypted, and the model is told so.
        const notes = await db.agentNote.findMany({ where: { userId: owner, agentId: otto.id } });
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.status, "pending");
        assert.equal(notes[0]!.source, "agent");
        assert.match(notes[0]!.content, /^enc:/);
        assert.equal(decryptField(notes[0]!.content), NOTES.met);
        assert.ok(loops("met").some((call) => call.results.some((result) => /Saved for the person to review/.test(result))), "the tool result says it waits");
        const learned = await db.agentEvent.findFirstOrThrow({ where: { userId: owner, agentId: otto.id, kind: "note_learned" } });
        assert.equal((learned.detail as { runId?: string }).runId, met.runId);
        assert.doesNotMatch(JSON.stringify(learned), /Mondays/, "the log says that it learned, never what");

        // A secret is refused, and nothing is stored.
        assert.equal(await db.agentNote.count({ where: { userId: owner, agentId: mira.id } }), 0);
        assert.ok(loops("gap").some((call) => call.results.some((result) => /never keep secrets/.test(result))), "the refusal reaches the model");

        // The last milestone's run checked the criteria, with the run's own model, over what it produced.
        const criteria = seen.filter((call) => call.kind === "criteria");
        assert.deepEqual(criteria.map((call) => call.scenario).sort(), ["gap", "met"], "one check per goal's last step, none for the plain run");
        for (const call of criteria) {
          assert.equal(call.model, "claude-sonnet-5-5", "the run's own model, never a substitute");
          assert.equal(call.maxTokens, 120, "the check's output bound (AGENT_GOAL_CHECK_MAX_TOKENS unset: the default)");
          assert.match(call.text, /The report is shared with finance/);
          assert.match(call.text, new RegExp(ANSWERS[call.scenario]!.slice(0, 30)));
        }
        const verdict = async (sessionId: string) =>
          (await db.agentEvent.findFirstOrThrow({ where: { userId: owner, kind: "goal_checked", sessionId } })).detail as { verdict: string; why: string | null; runId: string };
        const metCheck = await verdict(met.sessionId);
        assert.equal(metCheck.verdict, "met");
        assert.equal(metCheck.runId, met.runId);
        const gapCheck = await verdict(gap.sessionId);
        assert.equal(gapCheck.verdict, "not_met");
        assert.match(String(gapCheck.why), /nothing shows the report reached finance/);

        // The driver: met only on the recorded pass; the gap is unverified, said in words, and the person is told.
        const notified: Array<{ status: string; nextAction: string }> = [];
        const deps: import("../src/lib/agents/goal-runner").GoalRunnerDeps = {
          async startStep() {
            throw new Error("no step is left to start");
          },
          async retryStep() {
            return { ok: false, message: "not used here" };
          },
          async notifyOutcome(input) {
            notified.push({ status: input.status, nextAction: input.nextAction });
          },
        };
        const metDone = await goalRunner.advanceGoal({ user, goalId: met.goalId!, deps });
        assert.deepEqual(metDone.kind === "advanced" && metDone.steps, ["complete_step", "achieved"]);
        assert.equal((await db.agentGoal.findFirstOrThrow({ where: { id: met.goalId! } })).status, "achieved");
        await goalRunner.advanceGoal({ user, goalId: gap.goalId!, deps });
        const gapGoal = await db.agentGoal.findFirstOrThrow({ where: { id: gap.goalId! } });
        assert.equal(gapGoal.status, "unverified");
        assert.match(String(gapGoal.nextAction), /^Every step ran\. Check the result\. A check against its criteria found a gap: nothing shows/);
        assert.deepEqual(notified.map((n) => n.status), ["achieved", "unverified"]);
      } finally {
        runner?.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (runner && runner.exitCode === null) runner.kill("SIGKILL");
        await new Promise<void>((resolve) => lab.close(() => resolve()));
        await db.workSession.deleteMany({ where: { userId: owner } }).catch(() => undefined);
        await db.user.delete({ where: { id: owner } }).catch(() => undefined);
        rmSync(path.join(ROOT, ".uploads", "work", owner), { recursive: true, force: true });
        await db.$disconnect();
        console.log(`[orbit-truth-e2e] runner log: ${logFile}`);
      }
    }
  );
}
