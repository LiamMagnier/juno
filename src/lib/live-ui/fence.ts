/**
 * The fence names that open a Live UI view. Its own module so the chat's
 * markdown renderer can recognise the fence without importing the parser,
 * which loads only with the view itself.
 */
export const LIVE_UI_FENCES = ["live-ui", "live", "juno-live"] as const;

export function isLiveUIFence(lang: string | null | undefined): boolean {
  return !!lang && (LIVE_UI_FENCES as readonly string[]).includes(lang.trim().toLowerCase());
}
