/**
 * Where an artifact preview runs, and what it is allowed to reach.
 *
 * ── WHY PREVIEWS ARE LOADED BY URL, NOT BY `srcdoc` ─────────────────────────
 *
 * A document an iframe gets from `srcdoc` — and equally one from `about:blank`,
 * `blob:` or `data:` — does not have a policy of its own. The HTML spec gives it
 * a clone of its creator's policy container, so it enforces the embedding page's
 * Content-Security-Policy on top of anything it declares itself. A meta policy
 * inside it can only tighten. Since fb3a42b5 the app sends an enforcing policy
 * with `'nonce-…' 'strict-dynamic'` (src/lib/csp.ts), and an artifact's inline
 * scripts carry no nonce: every React, scripted-HTML, Tailwind, Mermaid, console,
 * share and Work site preview rendered blank or static for a month (audit X-01).
 * Measured in Chrome: srcdoc and blob: blocked, data: refused by frame-src, a
 * document served over http with its own header ran.
 *
 * So the preview is a real response. The iframe loads a small, static SHELL from
 * `/sandbox/v1/<profile>` — on a separate origin when `NEXT_PUBLIC_SANDBOX_ORIGIN`
 * is set, on the app's own origin otherwise — and that response carries the
 * policy below instead of inheriting the app's. The parent then hands the shell
 * the preview document over postMessage and the shell writes it into itself
 * (src/lib/sandbox-shell.ts), so the document runs under the shell's policy.
 *
 * ── WHAT ISOLATES IT ────────────────────────────────────────────────────────
 *
 * Unchanged, and still the whole boundary: `sandbox` WITHOUT `allow-same-origin`,
 * so the preview has an opaque origin and cannot read the app's cookies,
 * storage, DOM or session whichever origin the shell came from. The shell's
 * response repeats that as a CSP `sandbox` directive, so even a top-level visit
 * to the shell URL gets an opaque origin. A separate origin adds that the shell
 * request itself carries none of the app's cookies (they are host-only).
 *
 * ── THE EGRESS POLICY ───────────────────────────────────────────────────────
 *
 * Once scripts run again, a preview is a program, and on a public share page it
 * is a stranger's program shown under Juno's name. What it may reach:
 *
 *   Code, styles and fonts: an allowlist of public CDNs (SANDBOX_CODE_ORIGINS),
 *   not `https:`. A preview can use any library published to npm, cdnjs or the
 *   font services; it cannot pull a script from a server someone runs to steer
 *   it.
 *
 *   Requests it can read or send a body with — fetch, XHR, WebSocket,
 *   EventSource, sendBeacon: the three package CDNs only (plus PyPI for the
 *   private Python console). No preview can call an arbitrary API, post what a
 *   visitor typed, or hold a live channel open to anyone.
 *
 *   Forms: `form-action 'none'`, so a form can be typed into and handled by its
 *   own script but cannot POST anywhere.
 *
 *   Images and media: the one place the two profiles differ. In your own
 *   previews (`private`) they may come from any https host, because a generated
 *   website with no photographs is not the website that was asked for. On a
 *   public share (`public`) they may come only from the CDNs and a few stock
 *   photo hosts, because an image URL is also a way to send a string out, and
 *   there the person typing is a visitor who did not write the page.
 *
 *   Nested frames: a few video and map embeds in private previews; none on a
 *   public share.
 *
 * What no page policy can close, said plainly: a preview can still navigate its
 * own frame, and WebRTC is outside CSP. The allowlists narrow the channels to
 * hosts nobody can read the logs of; they do not make a hostile page harmless,
 * which is why public shares also have takedown, ban propagation and a report
 * link (src/lib/share-moderation.ts).
 *
 * No Node-only imports: the middleware (Edge) and the client both load this.
 */

export type SandboxProfile = "private" | "public";

export const SANDBOX_PROFILES: readonly SandboxProfile[] = ["private", "public"];

export function isSandboxProfile(value: unknown): value is SandboxProfile {
  return value === "private" || value === "public";
}

/** Versioned so a shell change can never be served to a parent built for another. */
export const SANDBOX_SHELL_PATH = "/sandbox/v1";

/** Parent → shell: the document to render. */
export const SANDBOX_RENDER_MESSAGE = "juno:sandbox-render";
/** Shell → parent: loaded and listening; send the document. */
export const SANDBOX_READY_MESSAGE = "juno:sandbox-ready";
/** Shell → parent: the written document fired `load`. */
export const SANDBOX_LOADED_MESSAGE = "juno:sandbox-loaded";

/**
 * Where preview code, styles and fonts may come from.
 *
 * The first three are what this app's own runtimes load (sandbox-frame.tsx:
 * Tailwind Play, React/ReactDOM/Babel from unpkg, Mermaid and Pyodide from
 * jsDelivr). The rest are the library and font hosts generated pages actually
 * name. Anything published to npm is reachable through jsDelivr, unpkg and
 * esm.sh, and cdnjs covers the long tail, so an absent host costs a URL rewrite
 * rather than a library.
 */
export const SANDBOX_CODE_ORIGINS: readonly string[] = [
  "https://cdn.tailwindcss.com",
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.skypack.dev",
  "https://ga.jspm.io",
  "https://code.jquery.com",
  "https://ajax.googleapis.com",
  "https://d3js.org",
  "https://cdn.plot.ly",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://fonts.bunny.net",
  "https://rsms.me",
  "https://use.fontawesome.com",
];

/**
 * The only hosts a preview may send a request to (fetch, XHR, WebSocket,
 * EventSource, sendBeacon). Package CDNs: Pyodide fetches its wasm and wheels
 * from jsDelivr, and chart and map examples load their data files from the same
 * places. None of them lets the author read what was requested.
 */
export const SANDBOX_CONNECT_ORIGINS: readonly string[] = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
];

/** micropip resolves and downloads wheels here. Only the private console runs Python. */
const PYPI_ORIGINS: readonly string[] = ["https://pypi.org", "https://files.pythonhosted.org"];

/** Stock-photo hosts a public page may still show images from. */
export const SANDBOX_PUBLIC_IMAGE_ORIGINS: readonly string[] = [
  "https://images.unsplash.com",
  "https://plus.unsplash.com",
  "https://picsum.photos",
  "https://fastly.picsum.photos",
  "https://placehold.co",
  "https://i.pravatar.cc",
  "https://randomuser.me",
];

/** Video and map embeds a private preview may frame. */
const PRIVATE_FRAME_ORIGINS: readonly string[] = [
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.google.com",
];

/**
 * The iframe's capability list, per profile.
 *
 * `allow-same-origin` is absent from both and must stay absent: it is the whole
 * isolation. `allow-popups` is absent too — a popup inheriting an opaque origin
 * cannot render the site it was opened for, so outward links are handed to the
 * parent (`LINK_BRIDGE` in sandbox-frame.tsx), which opens a real tab.
 *
 * A public share additionally drops `allow-modals` (an `alert`/`prompt` asking
 * for a password, under Juno's header) and `allow-downloads` (a stranger's page
 * handing a visitor a file).
 */
export const SANDBOX_FLAGS: Readonly<Record<SandboxProfile, string>> = {
  private: "allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock",
  public: "allow-scripts allow-forms allow-pointer-lock",
};

/**
 * The `sandbox` directive on the shell's own response. A backstop for a
 * top-level visit, where no iframe attribute applies; inside a frame the
 * attribute and the directive both apply and the stricter wins. So this is the
 * UNION of what any caller's attribute may ask for — the Work site preview needs
 * the two popup flags for its external links (work-site-preview.tsx) — and never
 * `allow-same-origin` or `allow-top-navigation`.
 */
const SHELL_SANDBOX_DIRECTIVE: Readonly<Record<SandboxProfile, string>> = {
  private: `sandbox ${SANDBOX_FLAGS.private} allow-popups allow-popups-to-escape-sandbox`,
  public: `sandbox ${SANDBOX_FLAGS.public}`,
};

const join = (...sources: (string | readonly string[])[]) => sources.flat().join(" ");

/**
 * The resource and egress directives. Shared by the shell's header and the meta
 * policy each preview document carries, so the two cannot drift apart.
 */
export function sandboxDirectives(profile: SandboxProfile): string[] {
  const isPublic = profile === "public";
  return [
    "default-src 'none'",
    // 'unsafe-inline' is the point of an artifact; 'unsafe-eval' is not
    // optional either — the React runtime compiles JSX with Babel standalone
    // and evaluates the result.
    `script-src ${join("'unsafe-inline' 'unsafe-eval' blob:", SANDBOX_CODE_ORIGINS)}`,
    `style-src ${join("'unsafe-inline'", SANDBOX_CODE_ORIGINS)}`,
    `font-src ${join("data:", SANDBOX_CODE_ORIGINS)}`,
    isPublic
      ? `img-src ${join("data: blob:", SANDBOX_CODE_ORIGINS, SANDBOX_PUBLIC_IMAGE_ORIGINS)}`
      : "img-src data: blob: https:",
    isPublic ? "media-src data: blob:" : "media-src data: blob: https:",
    `connect-src ${join("data: blob:", SANDBOX_CONNECT_ORIGINS, isPublic ? [] : PYPI_ORIGINS)}`,
    isPublic ? "frame-src 'none'" : `frame-src ${join("blob: data:", PRIVATE_FRAME_ORIGINS)}`,
    "worker-src blob:",
    // The three a preview never needs and an attack always does.
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ];
}

/** The same policy as a `<meta>` tag, for the head of every preview document. */
export function sandboxPolicyMeta(profile: SandboxProfile): string {
  return `<meta http-equiv="Content-Security-Policy" content="${sandboxDirectives(profile).join("; ")}">`;
}

/**
 * The shell response's own policy header: the directives above, the sandbox
 * backstop, and who may frame it.
 *
 * `frameAncestors` is the app origin when the shell is served from a separate
 * origin, `'self'` when it shares the app's.
 */
export function buildSandboxCsp({
  profile,
  frameAncestors,
}: {
  profile: SandboxProfile;
  frameAncestors: readonly string[];
}): string {
  return [
    ...sandboxDirectives(profile),
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
    SHELL_SANDBOX_DIRECTIVE[profile],
  ].join("; ");
}

/**
 * The configured preview origin (`https://host[:port]`), or null to serve
 * previews from the app's own origin. Read from NEXT_PUBLIC_SANDBOX_ORIGIN so the
 * client bundle, the middleware and the route agree on it.
 */
export function sandboxOrigin(raw: string | undefined = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The shell URL a preview iframe loads for this profile. */
export function sandboxShellUrl(profile: SandboxProfile, origin: string | null = sandboxOrigin()): string {
  return `${origin ?? ""}${SANDBOX_SHELL_PATH}/${profile}`;
}

export function isSandboxPath(pathname: string): boolean {
  return pathname === "/sandbox" || pathname.startsWith("/sandbox/");
}

/**
 * Which policy a document request gets, decided in the middleware:
 *
 *   "app"       — the nonce policy from src/lib/csp.ts;
 *   "sandbox"   — none from the middleware; the shell route sets its own;
 *   "not-found" — a request on the wrong host.
 *
 * With a separate preview origin configured, that host serves the shell and
 * nothing else (a second copy of the app on it would be a sign-in page on a
 * domain users were never told about), and the app host stops serving the shell.
 */
export type DocumentPolicy = "app" | "sandbox" | "not-found";

export function documentPolicyFor({
  pathname,
  host,
  sandboxOrigin: configured,
}: {
  pathname: string;
  host: string | null;
  sandboxOrigin: string | null;
}): DocumentPolicy {
  const shellPath = isSandboxPath(pathname);
  if (!configured) return shellPath ? "sandbox" : "app";
  const onSandboxHost = !!host && host.toLowerCase() === new URL(configured).host.toLowerCase();
  if (onSandboxHost) return shellPath ? "sandbox" : "not-found";
  return shellPath ? "not-found" : "app";
}
