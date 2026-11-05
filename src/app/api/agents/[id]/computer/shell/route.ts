import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { rateLimit } from "@/lib/rate-limit";
import { computerProvider } from "@/lib/computer/provider";
import { COMPUTER_ACCESS_COPY } from "@/lib/computer/access-copy";
import { computerAccessError, computerAccessFor } from "@/lib/computer/access";
import { ComputerAccessError, computerErrorBody } from "@/lib/computer/errors";
import { readShellOutput } from "@/lib/computer/shell-output";
import { isTerminalStatus } from "@/lib/work/domain";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/** The pane polls once a second while a command runs: a few tabs' worth, never a loop. */
const READS_PER_MINUTE = 240;

/**
 * The agent's shell output for one of its runs, after a cursor
 * (COMPUTERS_2026-10.md S5.1): `?runId=<run>&after=<seq>`. Read-only: this
 * route only reads what the Work runner stored, and nothing here can reach
 * the computer. Owner-scoped (the run must be the person's and the agent's),
 * gated like the live view (server, rollout, plan), and never a raw error.
 * Refusals are not audited here: the pane polls, and the gates that let a
 * person in at all already audit their own refusals.
 */
export async function GET(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  if (!computerProvider()) {
    const { status, body } = computerErrorBody(new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff));
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }

  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const rawAfter = url.searchParams.get("after") ?? "0";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || !/^\d{1,9}$/.test(rawAfter)) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid terminal request." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const limit = await rateLimit({ key: `agents:computer-shell:${user.id}:${id}`, limit: READS_PER_MINUTE, windowSec: 60 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many terminal requests. Try again in a minute." },
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

  try {
    const access = await computerAccessFor(user.id);
    if (!access.ok) {
      const { status, body } = computerErrorBody(computerAccessError(access, agent.name));
      return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
    }
    const run = await prisma.workRun.findFirst({
      where: { id: runId, userId: user.id, session: { agentId: id } },
      select: { status: true },
    });
    if (!run) {
      return NextResponse.json(
        { error: "not_found", message: "That task no longer exists." },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    const page = await readShellOutput({ userId: user.id, agentId: id, runId, afterSeq: Number(rawAfter) });
    return NextResponse.json({ ...page, runLive: !isTerminalStatus(run.status) }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const { status, body } = computerErrorBody(err, { fallbackError: "terminal_error", fallbackStatus: 502 });
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }
}
