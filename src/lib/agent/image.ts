import crypto from "node:crypto";
import type { ToolDefinition, ToolExecutionResult } from "@/lib/agent/types";
import { matchAttachment, nameList } from "@/lib/agent/attachment-match";
import type { ToolResultImage } from "@/lib/mcp";

/*
 * NO `server-only` AND NO STATIC STORAGE IMPORT — see the same note in
 * `document.ts`. The rasteriser, storage and Prisma are all reached through
 * `await import()` inside `execute`, so the agent registry stays constructible
 * wherever it is read.
 */

/**
 * Juno Image Inspector — looking closer at a picture already on the table.
 *
 * WHY A MODEL CANNOT JUST LOOK HARDER. Every vision model in the catalogue
 * resizes an image down before it reaches the transformer — around 1.15
 * megapixels for Claude, a tile grid for GPT, similar for Gemini. A 4000-pixel
 * screenshot arrives at roughly a quarter of its width, so six-point text in a
 * table, a serial number on a label, or the third tick on an axis is not
 * *faint* in the model's view: those pixels do not exist in it. Asking the
 * model to "look more carefully" asks it to recover information that was
 * thrown away before it ever saw the picture, and what comes back is a
 * plausible guess stated as an observation. That is the failure this tool
 * exists to stop.
 *
 * The fix is the same one a person uses: crop to the part that matters and
 * magnify it. A 6% crop of a 4000-pixel screenshot is 240 pixels wide, scaled
 * back up to fill the model's whole budget — so the same six-point text
 * arrives an order of magnitude larger than it did the first time.
 *
 * IT ANSWERS IN PIXELS, NOT PROSE. The crop goes back into the tool round as
 * an image (`ToolResultImage`), because a tool that returned a *description*
 * of the crop would be answering the question itself and handing the model its
 * conclusion to repeat.
 *
 * IT ALSO OPENS DOCUMENT PAGES. A page of a PDF is a picture too, and the
 * cases that send a model looking — a signature, a stamped date, a chart with
 * no data table behind it, a scanned form — are exactly the ones where the
 * text layer has nothing to say. `page` renders one and hands it over.
 *
 * READ-ONLY AND CONVERSATION-SCOPED, like `read_document`: it can only reach
 * what the person attached here.
 */

export interface InspectImageParams {
  /** File name or attachment id. Optional when one image is attached. */
  file?: string;
  /** For a PDF: which page to rasterise. Ignored for an image. */
  page?: number;
  /** Region to keep, in PERCENT of the source, x/y from the top-left. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  grayscale?: boolean;
  /** 1 leaves tone alone. ~1.5 rescues washed-out scans and screenshots. */
  contrast?: number;
  rotate?: 0 | 90 | 180 | 270;
  reason?: string;
}

/**
 * The longest edge handed back to the model.
 *
 * 1400 px is just above where the major providers stop downsampling, so a crop
 * arrives at full detail without paying for pixels that will be discarded on
 * the way in. Larger is not sharper — it is only more expensive.
 */
const OUTPUT_MAX_EDGE = 1_400;

/**
 * The shortest edge a crop is scaled UP to.
 *
 * Without this the tool is pointless for its main use: crop 4% of a screenshot
 * and you get a 160-pixel image, which the model receives at 160 pixels and
 * can read no better than it read the original. Upscaling does not invent
 * detail, but it does stop the provider's own resize from throwing away the
 * detail that is there.
 */
const OUTPUT_MIN_EDGE = 768;

function failure(message: string): ToolExecutionResult<never> {
  return { success: false, error: message, summary: message, stdout: message };
}

function describeRegion(params: InspectImageParams): string | null {
  if ([params.x, params.y, params.width, params.height].every((value) => value == null)) return null;
  const x = params.x ?? 0;
  const y = params.y ?? 0;
  const width = params.width ?? 100 - x;
  const height = params.height ?? 100 - y;
  return `${Math.round(width)}%×${Math.round(height)}% of the image, ${Math.round(x)}% from the left and ${Math.round(y)}% from the top`;
}

export const inspectImageTool: ToolDefinition<InspectImageParams, unknown> = {
  id: "inspect_image",
  name: "Inspect image",
  category: "computer",
  description:
    "Look closer at an attached image or a page of an attached PDF. Give a region in PERCENT of the image (x, y, width, height, with x/y measured from the top-left corner) and it is cropped and magnified, then shown back to you. Use it before reading out small text, numbers, labels, signatures or anything in a dense screenshot, chart or scan: the copy of the image you were first shown was downscaled, so fine detail in it is genuinely not legible and must not be guessed. You can call it several times to sweep across a picture, and combine it with grayscale or contrast for a faded scan.",
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Which attachment, by file name. Optional when only one image is attached.",
      },
      page: {
        type: "number",
        description: "For a PDF: which page to render as an image (1-based). Ignored for images.",
      },
      x: { type: "number", description: "Left edge of the region, 0-100, as a percentage of width." },
      y: { type: "number", description: "Top edge of the region, 0-100, as a percentage of height." },
      width: { type: "number", description: "Width of the region as a percentage, 0-100." },
      height: { type: "number", description: "Height of the region as a percentage, 0-100." },
      grayscale: { type: "boolean", description: "Drop colour — helps with faded or tinted scans." },
      contrast: {
        type: "number",
        description: "Contrast multiplier; 1 leaves it alone, 1.5 is a firm push for a pale scan.",
      },
      rotate: {
        type: "number",
        // Described rather than enumerated: ToolParameterSchema's `enum` is a
        // list of STRINGS, and pairing it with a number type produces a schema
        // that half the providers reject and the other half read as "send a
        // string". The four legal values are named in the sentence instead,
        // and `normalizeRotation` is what actually enforces them.
        description: "Rotate the crop clockwise: 0, 90, 180 or 270 degrees. For a sideways scan.",
      },
      reason: {
        type: "string",
        description: "What you are trying to read, in a few words.",
      },
    },
    required: [],
  },
  riskClass: "read_only",
  formatPreview: (params) => ({
    title: "Inspect image",
    detail: [params.file, describeRegion(params), params.reason].filter(Boolean).join(" — ") || "Attached image",
    sensitive: false,
  }),
  execute: async (params, context): Promise<ToolExecutionResult<unknown>> => {
    const { canRaster, canRenderDocumentPage, imageDimensions, renderDocumentPage, transformImage } =
      await import("@/lib/media/raster");
    if (!(await canRaster())) {
      return failure(
        "Image inspection is unavailable on this server, so the picture cannot be cropped. Describe only what is legible in the copy you were already shown, and say that fine detail could not be checked.",
      );
    }

    const { conversationAttachments } = await import("@/lib/agent/attachments");
    const attachments = await conversationAttachments({
      userId: context.userId,
      conversationId: context.conversationId,
      projectId: context.projectId,
    });
    const inspectable = attachments.filter(
      (attachment) => attachment.kind === "IMAGE" || canRenderDocumentPage(attachment.mimeType),
    );
    if (inspectable.length === 0) {
      return failure("No image or PDF is attached to this conversation, so there is nothing to inspect.");
    }

    const { match, ambiguous } = matchAttachment(inspectable, params.file);
    if (!match) {
      return failure(
        ambiguous.length > 1
          ? `"${params.file ?? ""}" matches more than one attachment (${nameList(ambiguous)}). Name it exactly.`
          : `No attachment matches "${params.file ?? ""}". Available: ${nameList(inspectable)}.`,
      );
    }

    const { getObjectBytes } = await import("@/lib/storage");
    let source: Uint8Array;
    try {
      source = (await getObjectBytes(match.storageKey)).bytes;
    } catch {
      return failure(`"${match.fileName}" could not be loaded from storage.`);
    }

    const isDocument = match.kind !== "IMAGE";
    if (isDocument) {
      // The page is rasterised at a width the crop can still be taken out of:
      // rendering at the output size first and cropping second would magnify
      // the renderer's own pixels rather than the page's detail.
      const page = Math.max(1, Math.floor(params.page ?? 1));
      const rendered = await renderDocumentPage({ bytes: source, page, targetWidth: 2_200 });
      if (!rendered) {
        return failure(
          `Page ${page} of "${match.fileName}" could not be rendered. It may be encrypted, damaged, or past the end of the document.`,
        );
      }
      source = rendered.bytes;
    }

    const before = await imageDimensions(source);
    const region = describeRegion(params);
    const output = await transformImage(source, {
      region: region
        ? {
            x: params.x ?? 0,
            y: params.y ?? 0,
            width: params.width ?? 100 - (params.x ?? 0),
            height: params.height ?? 100 - (params.y ?? 0),
          }
        : undefined,
      maxEdge: OUTPUT_MAX_EDGE,
      minEdge: OUTPUT_MIN_EDGE,
      grayscale: params.grayscale,
      contrast: params.contrast,
      rotate: normalizeRotation(params.rotate),
      format: "jpeg",
      // 88, not the 82 a thumbnail gets: this is being enlarged and read, and
      // JPEG ringing around small glyphs is exactly the artefact that turns an
      // 8 into a 3.
      quality: 88,
    });
    if (!output) {
      return failure(`"${match.fileName}" could not be decoded as an image.`);
    }

    const pageNote = isDocument ? ` page ${Math.max(1, Math.floor(params.page ?? 1))} of` : "";
    const sourceNote = before ? ` The full ${isDocument ? "page" : "image"} is ${before.width}×${before.height}.` : "";
    const scaleNote = region ? "" : " This is the whole image, not a crop — give a region to magnify part of it.";
    const body =
      `Showing${pageNote} "${match.fileName}"${region ? `, cropped to ${region}` : ""}, at ${output.width}×${output.height}.` +
      `${sourceNote}${scaleNote}` +
      ` Read only what is actually legible here; if it is still too small, call inspect_image again with a tighter region.`;

    const images: ToolResultImage[] = [
      { mimeType: output.mimeType, base64: Buffer.from(output.bytes).toString("base64"), label: match.fileName },
    ];

    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "computer_action",
        timestamp: Date.now(),
        title: "Inspected image",
        detail: `${match.fileName}${region ? ` — ${region}` : ""}`,
        status: "completed",
        source: "inspect_image",
      });
    }

    return {
      success: true,
      summary: `Cropped ${match.fileName} to ${output.width}×${output.height}.`,
      // NOT enveloped. The envelope marks text that a stranger may have
      // written and that must not be obeyed as instruction; this sentence is
      // Juno's own report of what it just rendered. The IMAGE is the untrusted
      // part, and an image cannot be wrapped in markers — the system prompt's
      // rule about not following instructions found inside attachments is what
      // governs it, exactly as it does for the original the user attached.
      stdout: body,
      images,
    };
  },
};

function normalizeRotation(value: unknown): 0 | 90 | 180 | 270 {
  // Models routinely send "90" rather than 90 for an enum of numbers, and a
  // string here would silently become "no rotation" — the sideways scan stays
  // sideways and nothing says why.
  const degrees = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return degrees === 90 || degrees === 180 || degrees === 270 ? degrees : 0;
}

/** Registry id, so the allowlist and the registration cannot drift apart. */
export const INSPECT_IMAGE_TOOL_ID = inspectImageTool.id;
