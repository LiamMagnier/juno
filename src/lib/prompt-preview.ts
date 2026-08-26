/**
 * Turn structured instructions into a compact human-facing preview without
 * changing the stored prompt. Section tags help the model, but they obscure the
 * prose that identifies a project when space is limited to two lines.
 */
export function promptPreview(
  input: string,
  fallback = "No instructions set.",
): string {
  const collapsed = input.split(/\s+/u).filter(Boolean).join(" ");
  if (!collapsed) return fallback;

  const unwrapped = collapsed
    .replace(/<\/?[A-Za-z][A-Za-z0-9_.:-]*(?:\s[^<>]*)?\/?>/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

  return unwrapped || collapsed;
}
