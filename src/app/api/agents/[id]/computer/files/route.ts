import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
  AsleepComputerError,
  listOrDownloadComputerFiles,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request, { params }: Params) {
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

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path") ?? "/home/agent/work";
  const download = url.searchParams.get("download") === "1";

  try {
    const result = await listOrDownloadComputerFiles(user.id, id, pathParam, download);
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
    const message = err instanceof Error ? err.message : "Unable to read files.";
    return NextResponse.json(
      { error: "file_error", message },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
}
