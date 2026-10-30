import { expect, test, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AGENTS_JOURNEY_EMAIL, AGENTS_JOURNEY_PASSWORD } from "./support/agents-journey-account";
import {
  agentsJourneySkipReason,
  seedAgentsJourneyAccount,
  startLocalWorkRunner,
  taskFacts,
  writeJourneyScript,
  type LocalWorkRunner,
  type TaskFacts,
} from "./support/agents-journey";
import {
  ANSWER,
  ANSWERED_DELIVERABLE_TITLE,
  ASK_SCRIPT,
  DELIVERABLE_TITLE,
  DELIVER_SCRIPT,
  QUESTION,
} from "./support/agents-journey-scripts";

/*
 * The agents journey, end to end, on a real web server and a real cloud Work
 * runner (orbit discovery gap 3):
 *
 *   1. a person hires an agent through the form (/agents/new?form=1) and lands
 *      in its thread;
 *   2. a task started as that agent is picked up by the runner, works through
 *      its plan and ends `completed` with a deliverable, attached once;
 *   3. a second task asks the person a question, waits, and parks (the runner
 *      lets it go); the person answers later, in the thread's composer; the
 *      answer puts it back in the queue, it is picked up exactly once more,
 *      reads the answer as the question's result, and completes;
 *   4. "Needs you" is right at every step: empty before, empty while the
 *      first task works and after it ends, holding the question from the
 *      moment it is asked, still holding it after the park, and empty again
 *      once it is answered and after the task ends. Checked in the sidebar
 *      (its fold and its live region) and in GET /api/work/sessions/counts.
 *
 * No model is called. The runner is scripts/work-runner.ts with the scripted
 * Work model (src/lib/dev/scripted-work-model.ts: tests and local demos only,
 * refused in production, listed accounts only), so every "model" turn is a
 * fixed step (e2e/support/agents-journey-scripts.ts) and each run says so in
 * its own transcript.
 *
 * The task is started through POST /api/agents/{id}/tasks, the route the web
 * transport and every agent-side start (goals, ideas, hand-offs) go through.
 * No button starts an agent task without a model in between: in the product
 * the person asks in the thread and the chat model calls the task tool, which
 * a deterministic journey cannot do without a model.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *
 * Opt-in (AGENTS_JOURNEY=1), against a local server whose dispatch has the
 * scripted model switched on for the journey's own account, and the database
 * that server uses:
 *
 *   # the server (next dev) must see these three, e.g. in .env.development.local:
 *   JUNO_ALLOW_SCRIPTED_WORK=1
 *   WORK_SCRIPTED_MODEL_FILE=<any valid script; the runner reads its own>
 *   WORK_SCRIPTED_MODEL_USERS=agents-journey@juno.test
 *
 *   AGENTS_JOURNEY=1 DATABASE_URL=<the server's> AUTH_SECRET=<the server's> \
 *   ALEVR_QA_RUNNER=1 E2E_BASE_URL=http://localhost:3000 \
 *   npx playwright test e2e/agents-journey.spec.ts --project=chromium --no-deps
 *
 * It seeds agents-journey@juno.test from nothing (scripts/seed-agents-journey.ts),
 * signs in as it through the credential endpoint the sign-in form posts to,
 * and starts and stops its own runner. It refuses a database
 * that is not on this machine, and a database where another account has
 * cloud work in flight (the runner's sweeps are global).
 *
 * Not in CI (.github/workflows/e2e.yml): that lane serves a production build,
 * where dispatch refuses the scripted model by design, so the start would need
 * a different model path that has not been run anywhere yet.
 */

const skip = agentsJourneySkipReason();

/** A few seconds, so the park happens while the test watches rather than after the default minute. */
const ATTENDED_WAIT_MS = 4_000;
/**
 * Generous on purpose. On the shared dev server this was written against, a
 * cold route took 70-150 s to compile and the server restarted under memory
 * pressure every few minutes, so every wait here survives a restart: a page
 * that stops answering is reloaded, and a side effect is read back from the
 * database rather than from a response that may have been cut off.
 */
const SLOW = 6 * 60_000;
const TERMINAL = ["completed", "failed", "cancelled", "interrupted", "timed_out", "budget_exceeded"];

test.describe("Agents journey", () => {
  test.skip(skip !== null, skip ?? "");
  // Its own account and its own sign-in, never the shared E2E session.
  test.use({ storageState: { cookies: [], origins: [] } });

  let db: PrismaClient;
  let userId: string;

  test.beforeAll(async () => {
    seedAgentsJourneyAccount();
    db = new PrismaClient();
    userId = (await db.user.findUniqueOrThrow({ where: { email: AGENTS_JOURNEY_EMAIL }, select: { id: true } })).id;
  });

  test.afterAll(async () => {
    await db?.$disconnect();
  });

  test("hire, deliver, ask, park, answer later, resume once", async ({ page, baseURL }, testInfo) => {
    test.setTimeout(100 * 60_000);
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;
    let shot = 0;
    const snap = async (name: string) => {
      shot += 1;
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => undefined);
      await page.screenshot({ path: testInfo.outputPath(`${String(shot).padStart(2, "0")}-${name}.png`), timeout: 120_000 }).catch(() => undefined);
    };

    /** A cookie-authenticated call the way the web client makes it (same origin), retried through a server restart. */
    const api = async (method: "GET" | "POST", path: string, data?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const until = Date.now() + SLOW;
      for (;;) {
        try {
          const response = await page.request.fetch(`${origin}${path}`, {
            method,
            headers: { origin, "content-type": "application/json" },
            ...(data === undefined ? {} : { data }),
            timeout: 180_000,
          });
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          // A dev server that is restarting answers 5xx from its proxy, or nothing.
          if (response.status() < 500 || Date.now() > until) return { status: response.status(), body };
        } catch (error) {
          if (Date.now() > until) throw error;
        }
        await page.waitForTimeout(5_000);
      }
    };
    const needsYouCount = async () => {
      const { status, body } = await api("GET", "/api/work/sessions/counts");
      expect(status).toBe(200);
      return Number((body.counts as Record<string, unknown> | undefined)?.needs_you ?? NaN);
    };

    /** Opens a page and waits for `ready`, through cold compiles and restarts. */
    const open = async (path: string, ready: Locator) => {
      await expect(async () => {
        await page.goto(path, { waitUntil: "domcontentloaded", timeout: 240_000 });
        await expect(ready).toBeVisible({ timeout: 240_000 });
      }).toPass({ timeout: SLOW * 2, intervals: [5_000, 15_000, 30_000] });
    };
    /**
     * Waits for the page in front of the person to show `check` on its own
     * (live updates), and only reloads when it has not after a few minutes:
     * the page may have lost its server to a restart.
     */
    const onPage = async (check: () => Promise<void>) => {
      try {
        await check();
      } catch {
        await expect(async () => {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 240_000 });
          await check();
        }).toPass({ timeout: SLOW * 2, intervals: [5_000, 15_000, 30_000] });
      }
    };

    // The sidebar's Needs you: its fold (a header button and one row per ask)
    // and the live region that says what is waiting.
    const sidebar = page.locator("aside").first();
    const needsYouHeader = sidebar.getByRole("button", { name: /^Needs you/ });
    const sidebarSays = sidebar.getByRole("status").filter({ hasText: /waiting on you|waiting for you|needs your/i });
    const nothingWaiting = async () => {
      await expect(sidebarSays).toHaveText("Nothing is waiting on you.", { timeout: 180_000 });
      await expect(needsYouHeader).toHaveCount(0);
    };

    const factsOf = (sessionId: string): Promise<TaskFacts> => taskFacts(db, userId, sessionId);
    const untilFacts = async (sessionId: string, what: string, ok: (facts: TaskFacts) => boolean, timeout = SLOW) => {
      let last: TaskFacts | null = null;
      await expect
        .poll(async () => {
          last = await factsOf(sessionId);
          return ok(last);
        }, { message: `${what} (last seen: ${JSON.stringify(last)})`, timeout, intervals: [1_000, 2_000, 5_000] })
        .toBe(true);
      return last as unknown as TaskFacts;
    };

    const scriptPath = testInfo.outputPath("scripted-work-model.json");
    let runner: LocalWorkRunner | null = null;
    try {
      // ── Sign in as the journey's own account ────────────────────────────
      await test.step("sign in", async () => {
        // The credential POST the sign-in form makes (next-auth's signIn), sent
        // from this browser context so the session lands in its cookies. The
        // form itself is e2e/setup.ts's to prove; here it would only add a
        // cold page and its hydration to every attempt, each of which the
        // sign-in limiter counts.
        const signedIn = async () => (await page.context().cookies()).some((cookie) => /session-token/.test(cookie.name));
        await expect(async () => {
          if (await signedIn()) return;
          const csrf = await api("GET", "/api/auth/csrf");
          expect(csrf.status).toBe(200);
          const response = await page.request.post(`${origin}/api/auth/callback/credentials`, {
            headers: { origin, "x-auth-return-redirect": "1" },
            form: { email: AGENTS_JOURNEY_EMAIL, password: AGENTS_JOURNEY_PASSWORD, csrfToken: String(csrf.body.csrfToken ?? ""), callbackUrl: `${origin}/chat` },
            timeout: 240_000,
          });
          expect(response.status(), "POST /api/auth/callback/credentials").toBeLessThan(400);
          expect(await signedIn(), "a session cookie").toBe(true);
        }).toPass({ timeout: SLOW * 2, intervals: [10_000, 30_000] });
        const session = await api("GET", "/api/auth/session");
        expect((session.body.user as { email?: string } | undefined)?.email).toBe(AGENTS_JOURNEY_EMAIL);
        await page.addInitScript(() => localStorage.setItem("juno:onboarded:v1", "1"));
      });

      const formPath = "/agents/new?template=researcher&form=1";
      const formHeading = page.getByRole("heading", { name: "Create agent" });
      await test.step("Needs you is empty before anything starts", async () => {
        expect(await needsYouCount()).toBe(0);
        await open(formPath, formHeading);
        await onPage(nothingWaiting);
      });

      // ── Hire ────────────────────────────────────────────────────────────
      const hired = await test.step("hire an agent through the form", async () => {
        const ledger = () => db.agent.findMany({ where: { userId, name: "Ledger" }, select: { id: true, conversationId: true, approvalMode: true } });
        const hires: number[] = [];
        page.on("response", (response) => {
          if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agents") hires.push(response.status());
        });
        // Read back from the database rather than from the response, which a
        // restart can cut off after the agent was made: a retry never hires twice.
        await expect(async () => {
          if ((await ledger()).length > 0) return;
          if (!(await formHeading.isVisible().catch(() => false))) await open(formPath, formHeading);
          const name = page.getByLabel("Name", { exact: true });
          const create = page.getByRole("button", { name: "Create Ledger" });
          // The field takes typing before the page is interactive on a cold
          // server; the button's label is what shows React has the value.
          await expect(async () => {
            await name.fill("Ledger");
            await expect(create).toBeVisible({ timeout: 3_000 });
          }).toPass({ timeout: 240_000, intervals: [2_000] });
          // No first goal: a goal would start work of its own.
          await page.getByPlaceholder("Something it works towards over time").fill("");
          await expect(page.getByRole("radio", { name: /Ask before risky steps/ })).toHaveAttribute("aria-checked", "true");
          await snap("hire-form");
          await create.click();
          await expect.poll(async () => (await ledger()).length, { timeout: 240_000, intervals: [2_000, 5_000] }).toBe(1);
        }).toPass({ timeout: SLOW * 4, intervals: [5_000, 30_000] });

        const agents = await ledger();
        expect(agents, "hired once").toHaveLength(1);
        expect(hires.every((status) => status === 201), `POST /api/agents answered ${hires.join(", ")}`).toBe(true);
        const agent = agents[0]!;
        expect(agent.approvalMode, "Ask before risky steps").toBe("balanced");
        expect(agent.conversationId, "a hire makes the agent's thread").toBeTruthy();
        const thread = `/chat/${agent.conversationId}`;
        // The form lands in the new agent's thread; a restart can cut the
        // navigation short, and then the thread is opened directly.
        const hello = page.getByRole("heading", { name: "Hi, I’m Ledger." });
        const landed = await page.waitForURL(new RegExp(thread), { timeout: 240_000 }).then(() => true, () => false);
        if (landed) await onPage(() => expect(hello).toBeVisible({ timeout: 240_000 }));
        else await open(thread, hello);
        await snap("hired-thread");
        return { id: agent.id, thread };
      });

      runner = await test.step("start a local cloud runner with the scripted model", async () => {
        writeJourneyScript(scriptPath, DELIVER_SCRIPT);
        return startLocalWorkRunner({ db, userId, scriptPath, logDir: testInfo.outputPath("runner"), attendedWaitMs: ATTENDED_WAIT_MS });
      });

      const startTask = async (title: string, goal: string): Promise<string> => {
        const started = await api("POST", `/api/agents/${hired.id}/tasks`, { title, goal, idempotencyKey: randomUUID() });
        expect([200, 201], `POST /api/agents/{id}/tasks: ${JSON.stringify(started.body)}`).toContain(started.status);
        const sessionId = String(started.body.sessionId ?? "");
        expect(sessionId).not.toBe("");
        expect(started.body.conversationId, "the task runs in the agent's thread").toBe(hired.thread.split("/").pop());
        return sessionId;
      };

      // ── A task that delivers ────────────────────────────────────────────
      await test.step("a task runs to completion with a deliverable", async () => {
        const sessionId = await startTask("Write the launch brief", "Write a one-page launch brief for the agents release.");
        const facts = await untilFacts(sessionId, "the first task ends", (f) => f.status !== null && TERMINAL.includes(f.status));
        expect(facts.status, facts.terminalDetail ?? "").toBe("completed");
        expect(facts.runs).toBe(1);
        expect(facts.cloudStarts, "picked up once").toBe(1);
        expect(facts.questionsAsked).toBe(0);
        expect(facts.errorRows).toBe(0);
        expect(facts.artifacts, "one deliverable").toBe(1);
        expect(facts.scriptedDisclosures, "the run says no model was called").toBe(1);
        expect(facts.needsAttention).toBe(false);
        expect(await needsYouCount()).toBe(0);

        const session = await api("GET", `/api/work/sessions/${sessionId}`);
        expect(session.status).toBe(200);
        expect((session.body.session as { status?: string }).status).toBe("completed");

        // The thread the person is reading shows the deliverable, and nothing waits.
        await onPage(async () => {
          await expect(page.getByText(DELIVERABLE_TITLE).first()).toBeVisible({ timeout: 180_000 });
          await nothingWaiting();
        });
        await snap("delivered");
      });

      // ── A task that asks, parks, and is answered later ──────────────────
      const asking = await test.step("a second task asks a question and Needs you holds it", async () => {
        writeJourneyScript(scriptPath, ASK_SCRIPT);
        const sessionId = await startTask("Pay the October invoices", "Pay the October invoices from the right folder.");
        await untilFacts(sessionId, "the question is asked", (f) => f.questionsAsked === 1);
        await expect.poll(needsYouCount, { timeout: SLOW, intervals: [2_000, 5_000] }).toBe(1);
        return sessionId;
      });

      await test.step("it parks after the attended wait and stays in Needs you", async () => {
        const parked = await untilFacts(asking, "the run parks", (f) => f.status === "paused" && f.pauseReason === "waiting");
        expect(parked.needsAttention, "a parked question is still the person's to answer").toBe(true);
        expect(parked.errorRows, "an ordinary park writes no error row").toBe(0);
        expect(parked.cloudStarts).toBe(1);
        expect(await needsYouCount()).toBe(1);

        // The thread shows the question, and the sidebar says Ledger is the
        // one asking, about this task.
        await onPage(async () => {
          await expect(page.getByText(QUESTION).first()).toBeVisible({ timeout: 180_000 });
          await expect(needsYouHeader).toBeVisible({ timeout: 180_000 });
          await expect(sidebar.getByRole("link", { name: /^Ledger\. .*: Pay the October invoices$/ })).toBeVisible();
          await expect(sidebarSays).toHaveText(/^Ledger: /);
        });
        await snap("parked");
      });

      await test.step("the person answers later, in the thread, and Needs you clears", async () => {
        // "Later": the runner let the run go; nothing is holding it.
        const before = await factsOf(asking);
        expect(before.status).toBe("paused");
        const field = page.locator("#juno-composer-textarea");
        const send = page.getByRole("button", { name: "Answer the task’s question" });
        const answers: Array<{ status: number; body: unknown }> = [];
        page.on("response", (response) => {
          if (response.request().method() !== "POST" || new URL(response.url()).pathname !== `/api/work/sessions/${asking}/answer`) return;
          void response.json().then(
            (body: unknown) => answers.push({ status: response.status(), body }),
            () => answers.push({ status: response.status(), body: null })
          );
        });
        // Typed in the thread's own composer, which is answering the task's
        // question while it is open. Retried only while the answer has not
        // been recorded, so it is never sent twice.
        await expect(async () => {
          if ((await factsOf(asking)).questionsAnswered > 0) return;
          await onPage(() => expect(field).toBeVisible({ timeout: 180_000 }));
          await expect(async () => {
            await field.fill(ANSWER);
            await expect(send).toBeEnabled({ timeout: 3_000 });
          }).toPass({ timeout: 240_000, intervals: [2_000] });
          await send.click();
          await expect.poll(async () => (await factsOf(asking)).questionsAnswered, { timeout: 240_000, intervals: [2_000, 5_000] }).toBe(1);
        }).toPass({ timeout: SLOW * 3, intervals: [5_000, 30_000] });
        // The response, when a restart did not cut it off: give it a moment to land.
        await expect.poll(() => answers.length, { timeout: 120_000 }).toBeGreaterThan(0).catch(() => undefined);
        const recorded = answers.filter((answer) => answer.status === 200);
        expect(answers.every((answer) => answer.status === 200), `POST …/answer answered ${JSON.stringify(answers)}`).toBe(true);
        for (const answer of recorded) expect(answer.body, "the answer puts the run back in the queue").toMatchObject({ resumed: true });
        // Whatever the response said, the row is what moved: off `paused`.
        await untilFacts(asking, "the answer requeues the run", (f) => f.status !== "paused");
        await expect.poll(needsYouCount, { timeout: SLOW, intervals: [2_000, 5_000] }).toBe(0);
      });

      await test.step("the run resumes once, reads the answer, and completes", async () => {
        const done = await untilFacts(asking, "the answered run ends", (f) => f.status !== null && TERMINAL.includes(f.status));
        expect(done.status, done.terminalDetail ?? "").toBe("completed");
        expect(done.runs, "the same run, not a new attempt").toBe(1);
        expect(done.cloudStarts, "picked up exactly twice: once to ask, once after the answer").toBe(2);
        expect(done.questionsAsked, "asked once").toBe(1);
        expect(done.questionsAnswered, "answered once").toBe(1);
        expect(done.errorRows).toBe(0);
        expect(done.artifacts, "the payment note").toBe(1);
        expect(done.needsAttention).toBe(false);
        expect(await needsYouCount()).toBe(0);

        await onPage(async () => {
          await expect(page.getByText(ANSWERED_DELIVERABLE_TITLE).first()).toBeVisible({ timeout: 180_000 });
          // The question stays in the transcript as history; no card still asks it.
          await expect(page.getByText(/Waiting on you · asked/)).toHaveCount(0);
          await nothingWaiting();
        });
        await snap("answered-and-done");
        // And after a fresh load, from the server's own read.
        await open(hired.thread, page.getByText(ANSWERED_DELIVERABLE_TITLE).first());
        await onPage(nothingWaiting);
      });
    } finally {
      await runner?.stop();
    }
  });
});
