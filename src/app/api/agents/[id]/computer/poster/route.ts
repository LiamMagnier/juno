import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import { getPosterBytes } from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const POSTER_HEADERS = {
  "Cache-Control": "private, no-store",
} as const;

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: POSTER_HEADERS }
    );
  }

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
      { status: 404, headers: POSTER_HEADERS }
    );
  }

  const bytes = await getPosterBytes(user.id, id);
  if (!bytes || bytes.byteLength === 0) {
    return NextResponse.json(
      { error: "not_found", message: "No poster frame captured yet." },
      { status: 404, headers: POSTER_HEADERS }
    );
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
