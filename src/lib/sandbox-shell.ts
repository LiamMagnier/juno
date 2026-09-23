import {
  SANDBOX_LOADED_MESSAGE,
  SANDBOX_READY_MESSAGE,
  SANDBOX_RENDER_MESSAGE,
  buildSandboxCsp,
  type SandboxProfile,
} from "@/lib/sandbox-policy";

/**
 * The document served at /sandbox/v1/<profile>: an empty page whose only job is
 * to carry its own Content-Security-Policy (see src/lib/sandbox-policy.ts) and
 * to take the preview document from the page that framed it.
 *
 * The exchange:
 *
 *   1. The shell loads and posts `juno:sandbox-ready` to its parent.
 *   2. The parent answers with `{ type: "juno:sandbox-render", html }`.
 *   3. The shell checks that the message came from its parent window AND from
 *      an origin allowed to frame it, then `document.open()` / `write(html)` /
 *      `close()` — replacing itself with the preview. The response's policy
 *      stays: `document.open` keeps the document's policy container, which is
 *      the whole reason for loading a shell rather than writing a srcdoc.
 *   4. On the written document's `load`, it posts `juno:sandbox-loaded`.
 *
 * It holds no artifact content and reflects nothing from the request, so the
 * URL on its own is inert: visited directly it has no parent to hear from, and
 * framed by any other site it is refused by `frame-ancestors` before it runs.
 *
 * A reload from inside the preview (`location.reload()`) reloads the SHELL,
 * which says ready again; the parent answers again, so a "restart" button in a
 * generated game keeps working the way it did under srcdoc.
 */
export function buildSandboxShell({
  parentOrigins,
  acceptOwnOrigin,
}: {
  /** Exact origins allowed to hand this frame a document. */
  parentOrigins: readonly string[];
  /** Same-origin mode: the app and the shell share an origin, so accept it. */
  acceptOwnOrigin: boolean;
}): string {
  // `<` escaped so nothing in the list can end the script element.
  const parents = JSON.stringify(parentOrigins).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Preview</title></head><body><script>
(function () {
  var parents = ${parents};
  // location.origin is the URL's origin even though this document's own origin
  // is opaque, so it names the app in same-origin mode.
  if (${acceptOwnOrigin ? "true" : "false"}) parents.push(location.origin);
  if (window.parent === window) return;
  function onMessage(e) {
    if (e.source !== window.parent || parents.indexOf(e.origin) === -1) return;
    var d = e.data;
    if (!d || d.type !== ${JSON.stringify(SANDBOX_RENDER_MESSAGE)} || typeof d.html !== "string") return;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(d.html);
    document.close();
    window.addEventListener("load", function () {
      try { window.parent.postMessage({ type: ${JSON.stringify(SANDBOX_LOADED_MESSAGE)} }, "*"); } catch (err) {}
    });
  }
  window.addEventListener("message", onMessage);
  window.parent.postMessage({ type: ${JSON.stringify(SANDBOX_READY_MESSAGE)} }, "*");
})();
</${"script"}></body></html>`;
}

/**
 * The full response for one profile: the shell and the headers that make it a
 * preview origin rather than a page of the app.
 */
export function sandboxShellResponse({
  profile,
  appOrigin,
  separateOrigin,
}: {
  profile: SandboxProfile;
  /** The app's own origin (NEXT_PUBLIC_APP_URL). */
  appOrigin: string | null;
  /** True when this response is served from NEXT_PUBLIC_SANDBOX_ORIGIN. */
  separateOrigin: boolean;
}): Response {
  const parentOrigins = separateOrigin && appOrigin ? [appOrigin] : [];
  const html = buildSandboxShell({ parentOrigins, acceptOwnOrigin: !separateOrigin });
  const csp = buildSandboxCsp({
    profile,
    frameAncestors: separateOrigin ? parentOrigins : ["'self'"],
  });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      // The shell is the same bytes for every preview of a deployment; a
      // re-render remounts the frame, and this keeps that off the network.
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      // A preview's own requests must not tell a CDN which conversation it
      // was opened from.
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
