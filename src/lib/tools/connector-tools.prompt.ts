/*
 * What a connector result tells the model about its pictures (SPEC §3.4 item
 * 4). English, in a `*.prompt.ts` file so the i18n extractor never harvests it
 * (INV-29). The label is also what a model without vision reads in place of
 * the picture.
 */

export function connectorImageLabel(n: number): string {
  return `Image ${n} from the tool`;
}

export function connectorImagesDroppedText(max: number): string {
  return `[An image from the tool was not included: at most ${max} are shown.]`;
}

/**
 * The line the route adds to the turn's `dynamicContext` (never the cached
 * system prompt) for each requested connector that is unavailable this turn
 * (SPEC §3.4 item 1), so a connector flipping state never rewrites the cached
 * prefix.
 */
export function connectorUnavailableLine(label: string, reason: string): string {
  return `${label} is linked but unavailable this turn (${reason.replace(/_/g, " ")}). If the user asks for it, say so and suggest reconnecting it in Settings.`;
}
