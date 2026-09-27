import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
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

const computerActionSchema = z.object({
  action: z.enum(["enable", "disable", "wake", "sleep", "reset"]),
});

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

  const computer = await loadAgentComputerStatusPayload(user.id, id);
  return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
}

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

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
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

  const { action } = parsed.data;

  try {
    switch (action) {
      case "enable": {
        await enableComputer(user.id, id);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_enabled",
          title: "Enabled computer",
        });
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
      }
      case "disable": {
        await disableComputer(user.id, id);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_disabled",
          title: "Turned off computer",
        });
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
      }
      case "wake": {
        await enableComputer(user.id, id);
        after(async () => {
          await ensureAwake(user.id, id, { autoEnable: true }).catch(() => {});
        });
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json(
          {
            computer: computer ? { ...computer, status: "starting" } : null,
          },
          { status: 202, headers: NO_STORE_HEADERS }
        );
      }
      case "sleep": {
        await sleepComputer(user.id, id);
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
      }
      case "reset": {
        await resetComputer(user.id, id);
        await recordAgentEvent({
          userId: user.id,
          agentId: id,
          kind: "computer_reset",
          title: "Reset computer",
        });
        const computer = await loadAgentComputerStatusPayload(user.id, id);
        return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Computer action failed.";
    return NextResponse.json(
      { error: "computer_error", message },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
}
