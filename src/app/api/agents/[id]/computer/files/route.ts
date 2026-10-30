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
import { ComputerUploadError, uploadToComputerInbox } from "@/lib/computer/files";

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

/** Uploads per person and agent per hour (COMPUTERS_2026-10.md S5.2). */
const UPLOADS_PER_HOUR = 30;

/**
 * Adds one file to the computer's ~/work/inbox (S5.2): the raw bytes as the
 * body, the file's name percent-encoded in `X-File-Name` (a header a plain
 * form cannot send, so a cross-site page cannot post one). Gated like every
 * way into the computer; only an awake or resting computer, at most
 * AGENT_COMPUTER_UPLOAD_MAX_MB, 30 an hour; works while the person has
 * control. Answers `{ name, path, sizeBytes }`.
 */
export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  if (!computerProvider()) {
    const { status, body } = computerErrorBody(new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff));
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }

  const fileName = req.headers.get("x-file-name");
  if (fileName === null) {
    return NextResponse.json(
      { error: "bad_name", message: "Choose a file to add." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const limit = await rateLimit({
    key: `agents:computer-upload:${user.id}:${id}`,
    limit: UPLOADS_PER_HOUR,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: `You can add up to ${UPLOADS_PER_HOUR} files an hour. Try again later.` },
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

  const declared = req.headers.get("content-length");
  const contentLength = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
  try {
    const uploaded = await uploadToComputerInbox({
      userId: user.id,
      agentId: id,
      agentName: agent.name,
      fileName,
      contentLength,
      body: req.body,
    });
    return NextResponse.json(
      { name: uploaded.name, path: uploaded.path, sizeBytes: uploaded.sizeBytes },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    if (err instanceof ComputerUploadError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE_HEADERS });
    }
    if (err instanceof AsleepComputerError) {
      return NextResponse.json(
        { error: "asleep", message: "Wake the computer first to add a file." },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }
    // A sentence, never a raw error message.
    const { status, body } = computerErrorBody(err, { fallbackError: "upload_error", fallbackStatus: 400 });
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  }
}
