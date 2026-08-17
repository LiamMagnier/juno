import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { key } = await params;
  const safePath = (key ?? []).join("/");
  if (!safePath || safePath.includes("..") || path.isAbsolute(safePath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const baseDir = path.join(os.tmpdir(), "juno-python-workspaces");
  const fullPath = path.join(baseDir, safePath);

  // Security check: ensure path stays within juno-python-workspaces
  const normalized = path.normalize(fullPath);
  if (!normalized.startsWith(baseDir)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const stats = await fs.stat(normalized);
    if (!stats.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }

    const data = await fs.readFile(normalized);
    const ext = path.extname(normalized).toLowerCase();
    
    let mimeType = "application/octet-stream";
    if (ext === ".csv") mimeType = "text/csv";
    else if (ext === ".json") mimeType = "application/json";
    else if (ext === ".xlsx") mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    else if (ext === ".png") mimeType = "image/png";
    else if (ext === ".svg") mimeType = "image/svg+xml";
    else if (ext === ".pdf") mimeType = "application/pdf";
    else if (ext === ".txt") mimeType = "text/plain";

    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(stats.size),
        "Content-Disposition": `attachment; filename="${path.basename(normalized)}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
