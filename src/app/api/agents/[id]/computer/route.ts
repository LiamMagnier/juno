import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { computerAccessFor, computerAccessError, publicComputerAccess } from "@/lib/computer/access";
import { computerProvider } from "@/lib/computer/provider";
import { COMPUTER_ACCESS_COPY } from "@/lib/computer/access-copy";
import { ComputerAccessError, computerErrorBody } from "@/lib/computer/errors";
import { raisesComputerPolicy, readComputerPolicy, setComputerPolicy } from "@/lib/computer/policy";
import {
  assertComputerMayWake,
  disableComputer,
  enableComputer,
  ensureAwake,
  loadAgentComputerStatusPayload,
  resetComputer,
  sleepComputer,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

const computerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["enable", "disable", "wake", "sleep", "reset"]) }),
  z.object({ action: z.literal("policy"), policy: z.enum(["off", "ask", "allowed"]) }),
]);

/**
 * GET: `{ computer, access, policy }`. `computer` keeps its shape and stays
 * null when the server has no computers, so the apps are unaffected; `access`
 * is the account's verdict in one line (docs/design/agents-v2/COMPUTERS_2026-10.md
 * §4.3); `policy` is this agent's off | ask | allowed.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  const [computer, access, policy] = await Promise.all([
    loadAgentComputerStatusPayload(user.id, id),
    computerAccessFor(user.id),
    readComputerPolicy(user.id, id),
  ]);
  return NextResponse.json({ computer, access: publicComputerAccess(access), policy }, { headers: NO_STORE_HEADERS });
}

/**
 * POST `{ action }`: enable (gives it a computer; its runs may use it, so the
 * policy becomes `allowed`), disable (deletes the computer, its files and
 * sign-ins; the policy becomes `off`), wake, sleep, reset, and
 * `{ action: "policy", policy }`. Enable, wake and reset are gated on access,
 * the plan's caps and the weekly allowance; sleep, disable and lowering the
 * policy never are, because they reduce use. Every failure answers with a
 * sentence (`computerErrorBody`), never a raw error message.
 */
export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({
    key: `agents:computer:${user.id}`,
    limit: 20,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many computer actions. Try again in a little while." },
      { status: 429, headers: NO_STORE_HEADERS }
    );
  }

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  const parsed = computerActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "That computer action could not be read." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const body = parsed.data;
  const actor = (await getCurrentDeviceSessionId().catch(() => null)) ? ("app" as const) : ("web" as const);
  const caller = { actor, agentName: agent.name };
  const answer = async (status = 200) =>
    NextResponse.json(
      {
        computer: await loadAgentComputerStatusPayload(user.id, id),
        policy: await readComputerPolicy(user.id, id),
      },
      { status, headers: NO_STORE_HEADERS }
    );

  try {
    // Nothing can be done with no computers on this server, gated or not.
    if (!computerProvider() && body.action !== "policy") {
      throw new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff);
    }
    switch (body.action) {
      case "enable": {
        await enableComputer(user.id, id, caller);
        // Today's meaning of "enable": the runs use it.
        await setComputerPolicy(user.id, id, "allowed", actor);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_enabled",
          title: "Enabled computer",
        });
        return answer();
      }
      case "disable": {
        await disableComputer(user.id, id, caller);
        await setComputerPolicy(user.id, id, "off", actor);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_disabled",
          title: "Deleted computer",
        });
        return answer();
      }
      case "wake": {
        await enableComputer(user.id, id, caller);
        // Refused now, in words, rather than "waking up" and nothing.
        await assertComputerMayWake(user.id, id, caller);
        after(async () => {
          await ensureAwake(user.id, id, { autoEnable: true, by: "person", ...caller }).catch(() => {});
        });
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json(
          {
            computer: computer ? { ...computer, status: "starting" } : null,
            policy: await readComputerPolicy(user.id, id),
          },
          { status: 202, headers: NO_STORE_HEADERS }
        );
      }
      case "sleep": {
        await sleepComputer(user.id, id, { reason: "person", actor });
        return answer();
      }
      case "reset": {
        await resetComputer(user.id, id, new Date(), caller);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_reset",
          title: "Reset computer",
        });
        return answer();
      }
      case "policy": {
        const current = await readComputerPolicy(user.id, id);
        // Lowering is never refused. Raising asks the account's access first:
        // a policy the account cannot use would read as a promise.
        if (raisesComputerPolicy(current, body.policy)) {
          const access = await computerAccessFor(user.id, { checkAvailable: false });
          if (!access.ok) throw computerAccessError(access, agent.name);
        }
        await setComputerPolicy(user.id, id, body.policy, actor);
        return answer();
      }
    }
  } catch (err) {
    const { status, body: refusal } = computerErrorBody(err);
    return NextResponse.json(refusal, { status, headers: NO_STORE_HEADERS });
  }
}
