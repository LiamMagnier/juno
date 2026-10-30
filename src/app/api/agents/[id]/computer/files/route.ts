import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { rateLimit } from "@/lib/rate-limit";
import { computerProvider } from "@/lib/computer/provider";
import { COMPUTER_ACCESS_COPY } from "@/lib/computer/access-copy";
import { ComputerAccessError, computerErrorBody } from "@/lib/computer/errors";
import {
  AsleepComputerError,
  listOrDownloadComputerFiles,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/** Folder listings and downloads per person and agent per minute: brisk browsing, never a loop. */
const FILE_REQUESTS_PER_MINUTE = 120;

export async function GET(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  // No computers on this server: answered here, before the store, so a
  // request writes nothing (the store audits the refusals it decides).
  if (!computerProvider()) {
    const { status, body } = computerErrorBody(new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff));
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }

  const limit = await rateLimit({
    key: `agents:computer-files:${user.id}:${id}`,
    limit: FILE_REQUESTS_PER_MINUTE,
    windowSec: 60,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many file requests. Try again in a minute." },
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

  // Access (rollout, plan, host) is checked by the store, first, and answered
  // below with its own status and sentence.
  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path") ?? "/home/agent/work";
  const download = url.searchParams.get("download") === "1";

  try {
    const result = await listOrDownloadComputerFiles(user.id, id, pathParam, download, { agentName: agent.name });
    if (result.kind === "file") {
      const safeName = result.name.replace(/["\\\r\n]/g, "_");
      return new NextResponse(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${safeName}"`,
          "Content-Length": String(result.sizeBytes),
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      {
        path: result.path,
        entries: result.entries,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    if (err instanceof AsleepComputerError) {
      return NextResponse.json(
        { error: "asleep", message: "Wake the computer first to browse its files." },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }
    // A sentence, never a raw error message: a non-computer error can carry a
    // path, a daemon's words or a database detail.
    const { status, body } = computerErrorBody(err, { fallbackError: "file_error", fallbackStatus: 400 });
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }
}
