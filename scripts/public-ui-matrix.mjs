/**
 * Deterministic UI request profiles used by the public smoke harness.
 *
 * This is intentionally a small, test-owned matrix. It describes the three
 * target viewport classes and the four preference combinations that can be
 * expressed without a browser. It does not pretend that HTTP headers prove
 * layout or paint; the browser/visual layer remains a separate gate.
 */

export const UI_VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "phone", width: 390, height: 844 },
];

export const UI_PRESENTATIONS = [
  { id: "light", colorScheme: "light", reducedMotion: false },
  { id: "dark", colorScheme: "dark", reducedMotion: false },
  { id: "light-reduced-motion", colorScheme: "light", reducedMotion: true },
  { id: "dark-reduced-motion", colorScheme: "dark", reducedMotion: true },
];

export const UI_PROFILES = UI_VIEWPORTS.flatMap((viewport) =>
  UI_PRESENTATIONS.map((presentation) => ({
    id: `${viewport.id}-${presentation.id}`,
    ...viewport,
    ...presentation,
  })),
);

/**
 * Headers for the request-level portion of the matrix.
 *
 * `X-Juno-Test-Reduced-Motion` is deliberately namespaced: reduced motion has
 * no standardized request client hint, and this header must never be mistaken
 * for a server-side replacement for the browser's media query.
 */
export function headersForUiProfile(profile) {
  return {
    "Viewport-Width": String(profile.width),
    "Sec-CH-UA-Mobile": profile.id.startsWith("phone-") ? "?1" : "?0",
    "Sec-CH-Prefers-Color-Scheme": profile.colorScheme,
    "X-Juno-Test-Reduced-Motion": profile.reducedMotion ? "1" : "0",
  };
}
