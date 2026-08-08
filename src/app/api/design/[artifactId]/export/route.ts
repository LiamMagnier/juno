import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { headObject } from "@/lib/storage";
import { sniffImageMime } from "@/lib/uploads";
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

/** Export must not turn a missing Library asset into a blank, shareable design. */
async function validateDesignAssets(doc: DesignDocument, userId: string): Promise<string | null> {
  for (const asset of Object.values(doc.assets)) {
    if (asset.url.toLowerCase().startsWith("data:image/")) {
      const comma = asset.url.indexOf(",");
      if (comma < 0) return `Image asset ${asset.id} has an invalid data URL.`;
      const payload = asset.url.slice(comma + 1);
      if (asset.url.slice(0, comma).toLowerCase().endsWith(";base64")) {
        const bytes = Buffer.from(payload, "base64");
        if (bytes.length === 0 || !sniffImageMime(bytes)) return `Image asset ${asset.id} has invalid image bytes.`;
      } else {
        try {
          if (!/^\s*<svg[\s>]/i.test(decodeURIComponent(payload))) {
            return `Image asset ${asset.id} is not a decodable inline image.`;
          }
        } catch {
          return `Image asset ${asset.id} is not a decodable inline image.`;
        }
      }
      continue;
    }
    if (!asset.url.startsWith("/api/files/")) return `Image asset ${asset.id} is not an app-owned file.`;
    const key = asset.url.slice("/api/files/".length).split("?", 1)[0];
    if (!key || key.includes("..")) return `Image asset ${asset.id} has an unsafe file reference.`;
    const attachment = await prisma.attachment.findFirst({
      where: { userId, storageKey: key, kind: "IMAGE", deletedAt: null },
      select: { id: true },
    });
    if (!attachment) return `Image asset ${asset.id} points to a missing Library file.`;
    try {
      const head = await headObject(key, 32);
      if (!sniffImageMime(head.prefix)) return `Image asset ${asset.id} is not a readable image.`;
    } catch {
      return `Image asset ${asset.id} points to an unavailable Library file.`;
    }
  }
  return null;
}

/** A generated export must have the bytes and a minimally valid envelope before download. */
function designExportProblem(format: "svg" | "pdf" | "html", content: string): string | null {
  const trimmed = content.trim();
  if (format === "svg") {
    if (!/^<svg(?:\s|>)/i.test(trimmed) || !/<\/svg>\s*$/i.test(trimmed)) return "The SVG export did not contain a complete root element.";
    if (/<(?:iframe|object|embed)\b|\bon[a-z]+\s*=|javascript:|<(?:script)\b/i.test(trimmed)) return "The SVG export contained unsafe markup.";
    if (/(?:href|xlink:href|src)\s*=\s*["']\s*["']/i.test(trimmed)) return "The SVG export contained a missing asset reference.";
    if (/(?:href|xlink:href|src)\s*=\s*["'](?:https?:|javascript:)/i.test(trimmed)) return "The SVG export contained a remote asset reference.";
    return null;
  }
  if (format === "pdf") {
    if (!/^%PDF-\d\.\d/.test(content) || !/startxref[\s\S]*%%EOF\s*$/.test(content)) return "The PDF export did not contain a complete PDF envelope.";
    return null;
  }
  if (!/^<!doctype html>/i.test(trimmed) || !/<\/html>\s*$/i.test(trimmed)) return "The HTML export did not contain a complete document.";
  if (/<(?:img|audio|video|source)\b[^>]*(?:src|poster)\s*=\s*["']\s*["']/i.test(trimmed)) return "The HTML export contained a missing asset reference.";
  if (/<(?:img|audio|video|source)\b[^>]*(?:src|poster)\s*=\s*["'](?:https?:|javascript:)/i.test(trimmed)) return "The HTML export contained a remote asset reference.";
  if (/(?:fetch|XMLHttpRequest|WebSocket)\s*\(/i.test(trimmed)) return "The HTML export contained an unexpected network call.";
  return null;
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

  const assetProblem = await validateDesignAssets(document, user.id);
  if (assetProblem) return NextResponse.json({ error: assetProblem, code: "MISSING_ASSET" }, { status: 422 });

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
        const problem = designExportProblem("svg", result.content);
        if (problem) return NextResponse.json({ error: problem, code: "EXPORT_VERIFICATION_FAILED" }, { status: 500 });
        return download(result.content, result.fileName, result.mimeType);
      }
      case "png": {
        // Deliberately JSON: see the note above.
        const rasterize = pngRequest(document, pageId, parsed.data.nodeId);
        const problem = designExportProblem("svg", rasterize.svg);
        if (problem) return NextResponse.json({ error: problem, code: "EXPORT_VERIFICATION_FAILED" }, { status: 500 });
        return NextResponse.json({ rasterize });
      }
      case "pdf": {
        const result = exportPdf(drawn, pageId);
        const problem = designExportProblem("pdf", result.content);
        if (problem) return NextResponse.json({ error: problem, code: "EXPORT_VERIFICATION_FAILED" }, { status: 500 });
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
        const problem = designExportProblem("html", result.content);
        if (problem) return NextResponse.json({ error: problem, code: "EXPORT_VERIFICATION_FAILED" }, { status: 500 });
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
