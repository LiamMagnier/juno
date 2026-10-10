/**
 * What a chat client says it can render.
 *
 * Shipped native builds (1.6.0, build 87) throw on an SSE frame `type` they do
 * not know, and every one of them is still in people's hands. So the server
 * never guesses what a client understands — not from `client`, not from
 * `origin`, not from an app version (INV-26). A client that wants the reworked
 * stream says so, feature by feature, in `clientFeatures`; a request that says
 * nothing gets the frozen profile-1 grammar it has always had.
 *
 * Pure, and safe on both sides of the wire: the web client imports the list it
 * sends from here, and the route parses what arrived with the same list.
 */

export const CLIENT_FEATURES = [
  "timeline",            // renders typed run records; gets round/phase keys; no "\n\n" separator deltas
  "resume",              // may receive `resume` frames
  "research_background", // research runs on the background engine; gets the `handoff` frame (SPEC §9.6)
  "suggest_research",    // the suggest_research tool may be attached (SPEC §3.8.9)
  "citations",           // resolves [n] against message.sources[cited]; Juno search numbers results (SPEC §3.8.1)
  "live_ui",             // renders ```live-ui interactive views; the prompt may teach them (docs/design/LIVE_UI.md)
  "live_ui_exercise",    // renders the Live UI `exercise` card (answer box, hints, send); without it exercises are posed in prose
  "code_run",            // shows Run on chat code blocks (JS, TS, Python, SQL); the prompt may say so
  "local_folder",        // Mac only: runs the folder tools on a folder the person picked (src/lib/chat/local-folder.ts)
] as const;
export type ClientFeature = (typeof CLIENT_FEATURES)[number];

export interface ClientFeatureSet {
  has(feature: ClientFeature): boolean;
  /** True when no known feature was declared: the frozen profile-1 grammar applies. */
  readonly profile1: boolean;
  readonly list: readonly ClientFeature[];
}

/** The most a request may declare. Anything past it is dropped, never rejected. */
export const MAX_CLIENT_FEATURES = 16;

const KNOWN: ReadonlySet<string> = new Set(CLIENT_FEATURES);

function isClientFeature(value: unknown): value is ClientFeature {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * Unknown strings are ignored. `undefined` → profile 1. Pure; no I/O.
 *
 * Lenient by design (INV-9): a client that sends a feature this server has
 * never heard of — a newer build talking to an older deploy — gets everything
 * this server does know about instead of a 400. Duplicates collapse, and the
 * list stops at 16 entries however long the input is.
 */
export function parseClientFeatures(raw: readonly string[] | undefined): ClientFeatureSet {
  const list: ClientFeature[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (list.length >= MAX_CLIENT_FEATURES) break;
      if (isClientFeature(value) && !list.includes(value)) list.push(value);
    }
  }
  const declared: ReadonlySet<ClientFeature> = new Set(list);
  return {
    has: (feature) => declared.has(feature),
    profile1: list.length === 0,
    list,
  };
}

/**
 * Features only a native client can honour. A browser has no folder on the
 * person's disk to run a tool against, so the web never claims `local_folder`;
 * claiming it would offer the model tools whose calls nothing executes.
 */
export const NATIVE_ONLY_CLIENT_FEATURES: readonly ClientFeature[] = ["local_folder"];

/** What the web client sends on every /api/chat request. */
export const WEB_CLIENT_FEATURES: readonly ClientFeature[] = CLIENT_FEATURES.filter(
  (feature) => !NATIVE_ONLY_CLIENT_FEATURES.includes(feature)
);
