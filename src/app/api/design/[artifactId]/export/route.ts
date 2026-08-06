import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { documentFromArtifact, loadOwnedDesignArtifact } from "@/lib/design/store";
import {
  buildHandoffBundle,
  exportHtmlPrototype,
  exportPdf,
  exportReact,
  exportSvg,
  exportSwiftUI,
  pngRequest,
} from "@/lib/design/export";
import { exportTokens } from "@/lib/design/variables";
import { serializeDesignDocument } from "@/lib/design/migrations";
import { DesignValidationError } from "@/lib/design/schema";

export const runtime = "nodejs";

const querySchema = z.object({
  format: z.enum(["svg", "png", "pdf", "html", "react", "swiftui", "json", "tokens", "handoff"]),
  /** Export one frame instead of the whole page. */
  nodeId: z.string().min(1).max(120).optional(),
  pageId: z.string().min(1).max(120).optional(),
});

/**
 * Export a design document.
 *
 * Everything is generated from the stored document through the shared renderer
 * and layout engine, so an export cannot disagree with what the editor drew.
 *
 * PNG is the one format this route does not return bytes for: rasterising needs
 * a renderer this process does not have, so it returns the SVG plus the target
 * dimensions and the client draws it. That is stated in the payload rather than
 * papered over with a worse server-side rasteriser.
 */
export async function GET(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { artifactId } = await params;
  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    format: url.searchParams.get("format") ?? undefined,
    nodeId: url.searchParams.get("nodeId") ?? undefined,
    pageId: url.searchParams.get("pageId") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid export request" }, { status: 400 });

  let document;
  try {
    document = documentFromArtifact(artifact);
  } catch (error) {
    if (error instanceof DesignValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 422 });
    }
    throw error;
  }

  const pageId = parsed.data.pageId ?? document.pages[0].id;
  if (!document.pages.some((page) => page.id === pageId)) {
    return NextResponse.json({ error: "No such page" }, { status: 404 });
  }
  if (parsed.data.nodeId && !document.nodes[parsed.data.nodeId]) {
    return NextResponse.json({ error: "No such layer" }, { status: 404 });
  }

  const download = (body: string, fileName: string, mimeType: string) =>
    new NextResponse(body, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        // An export is a snapshot of one revision; a cached copy would quietly
        // hand back an older document after the next edit.
        "Cache-Control": "no-store",
      },
    });

  try {
    switch (parsed.data.format) {
      case "svg": {
        const result = exportSvg(document, pageId, parsed.data.nodeId);
        return download(result.content, result.fileName, result.mimeType);
      }
      case "png": {
        // Deliberately JSON: see the note above.
        return NextResponse.json({ rasterize: pngRequest(document, pageId, parsed.data.nodeId) });
      }
      case "pdf": {
        const result = exportPdf(document, pageId);
        return new NextResponse(result.content, {
          headers: {
            "Content-Type": result.mimeType,
            "Content-Disposition": `attachment; filename="${result.fileName.replace(/"/g, "")}"`,
            "Cache-Control": "no-store",
            // What the PDF could not carry, so a caller can tell the user
            // instead of them finding out by looking.
            "X-Juno-Export-Notes": JSON.stringify(result.unsupported).slice(0, 2_000),
          },
        });
      }
      case "html": {
        const result = exportHtmlPrototype(document, pageId);
        return download(result.content, result.fileName, result.mimeType);
      }
      case "react": {
        const result = exportReact(document, pageId);
        return NextResponse.json({ file: result.fileName, content: result.content, mappings: result.mappings, unsupported: result.unsupported });
      }
      case "swiftui": {
        const result = exportSwiftUI(document, pageId);
        return NextResponse.json({ file: result.fileName, content: result.content, mappings: result.mappings, unsupported: result.unsupported });
      }
      case "tokens": {
        return NextResponse.json(exportTokens(document));
      }
      case "json": {
        return download(serializeDesignDocument(document), `${artifact.identifier}.juno.design.json`, "application/json");
      }
      case "handoff": {
        return NextResponse.json(buildHandoffBundle(document, pageId, new Date().toISOString()));
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 }
    );
  }
}
