import type { ToolResultImage } from "@/lib/mcp";

/**
 * Handing a tool's pixels back to the model, across four different wire shapes.
 *
 * WHY IT IS NOT ONE LINE PER ADAPTER. Only one provider takes an image where
 * you would expect it. Anthropic lets a `tool_result` block carry image
 * content directly, so the picture is part of the result it belongs to. The
 * other three accept only a string as a function's output, and the documented
 * way to show the model an image afterwards is to follow the output with an
 * ordinary user turn that contains it. The three then disagree again about
 * what an image part is called (`input_image`, `image_url`, `inlineData`), so
 * what can actually be shared is the *decisions* — which images are sendable,
 * what to say when they are not, and how to introduce them — rather than the
 * emission.
 *
 * This module is those decisions.
 */

/** The four types every vision model in the catalogue accepts. */
const SENDABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * How many images one tool round may put in front of the model.
 *
 * A bound, not a policy: an image is by far the most expensive thing that can
 * be appended to a prompt, and a tool loop runs up to six rounds. Nothing in
 * the product returns more than one today.
 */
const MAX_IMAGES_PER_ROUND = 4;

/** The images that can actually be sent to this model, in order. */
export function sendableToolImages(
  images: readonly ToolResultImage[] | undefined,
  vision: boolean,
): ToolResultImage[] {
  if (!vision || !images?.length) return [];
  return images
    .filter((image) => SENDABLE.has(image.mimeType) && image.base64.length > 0)
    .slice(0, MAX_IMAGES_PER_ROUND);
}

/**
 * The line that introduces the pictures in the follow-up turn.
 *
 * It exists because that turn is, on the wire, indistinguishable from
 * something the PERSON said — and a model that reads an unannounced image as
 * a new upload will thank the user for sending it. Naming where it came from
 * is what keeps the turn honest.
 */
export function toolImageIntro(toolName: string, images: readonly ToolResultImage[]): string {
  const labels = images.map((image) => image.label).filter(Boolean);
  const named = labels.length ? ` (${[...new Set(labels)].join(", ")})` : "";
  return images.length === 1
    ? `[Output of the ${toolName} tool${named} — an image, not something the user just sent:]`
    : `[Output of the ${toolName} tool${named} — ${images.length} images, not something the user just sent:]`;
}

/**
 * What to append to the tool's TEXT when its pictures could not be sent.
 *
 * A model that asked to see something and silently received nothing will
 * answer from the copy it already had and sound just as sure. Saying the
 * picture was withheld is what turns that into a qualified answer.
 */
export function withheldImagesNote(
  text: string,
  images: readonly ToolResultImage[] | undefined,
  sent: number,
): string {
  const withheld = (images?.length ?? 0) - sent;
  if (withheld <= 0) return text;
  return `${text}\n\n[${withheld} image(s) from this tool could not be shown to you here. Do not describe detail you have not actually seen.]`;
}

/** `data:image/jpeg;base64,…`, which three of the four wire shapes want. */
export function toDataUrl(image: ToolResultImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}
