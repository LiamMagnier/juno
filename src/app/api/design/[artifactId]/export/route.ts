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
import type { DesignDocument, DesignNode, NodeId, PageId } from "@/lib/design/types";

export const runtime = "nodejs";

const querySchema = z.object({
  format: z.enum(["svg", "png", "pdf", "html", "react", "swiftui", "json", "tokens", "handoff"]),
  /** Export one layer instead of the whole page. The three document formats —
   *  `json`, `tokens`, `handoff` — describe the document rather than draw it,
   *  and are unaffected by it. */
  nodeId: z.string().min(1).max(120).optional(),
  pageId: z.string().min(1).max(120).optional(),
});

/**
 * The document as it would be if `nodeId` were the only layer on the page.
 *
 * The PDF, HTML, React and SwiftUI exporters each walk a page: they take a page
 * id and emit its roots. They were handed a `nodeId` they had no parameter for,
 * so asking for one selected layer quietly produced the entire page — the one
 * failure mode this route is otherwise careful to avoid. Rather than give four
 * exporters a second traversal to keep in step with the first, the layer is
 * lifted into a one-root view of the same document: it keeps its subtree,
 * leaves its parent, and sits at the origin — exactly what `renderNodeSvg` does
 * for the SVG and PNG paths, so all six formats now crop the same way.
 *
 * The result is a valid document in its own right, and it is never written
 * back: exports read.
 */
function isolateLayer(doc: DesignDocument, pageId: PageId, nodeId: NodeId): DesignDocument {
  const node = doc.nodes[nodeId];
  const nodes: Record<NodeId, DesignNode> = { ...doc.nodes, [nodeId]: { ...node, parentId: null, x: 0, y: 0 } };
  const parent = node.parentId ? nodes[node.parentId] : undefined;
  if (parent && "children" in parent) {
    nodes[parent.id] = { ...parent, children: parent.children.filter((id) => id !== nodeId) };
  }
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      children: page.id === pageId ? [nodeId] : page.children.filter((id) => id !== nodeId),
    })),
    nodes,
  };
}

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

  // What the drawing formats render: the whole page, or the one layer asked for.
  const drawn = parsed.data.nodeId ? isolateLayer(document, pageId, parsed.data.nodeId) : document;

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
        const result = exportPdf(drawn, pageId);
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
        const result = exportHtmlPrototype(drawn, pageId);
        return download(result.content, result.fileName, result.mimeType);
      }
      case "react": {
        const result = exportReact(drawn, pageId);
        return NextResponse.json({ file: result.fileName, content: result.content, mappings: result.mappings, unsupported: result.unsupported });
      }
      case "swiftui": {
        const result = exportSwiftUI(drawn, pageId);
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
