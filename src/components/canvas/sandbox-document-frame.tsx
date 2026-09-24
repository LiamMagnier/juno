"use client";

import * as React from "react";
import {
  SANDBOX_FLAGS,
  SANDBOX_LOADED_MESSAGE,
  SANDBOX_READY_MESSAGE,
  SANDBOX_RENDER_MESSAGE,
  sandboxShellUrl,
  type SandboxProfile,
} from "@/lib/sandbox-policy";

/**
 * Which egress profile the previews under this point run with. Private (your
 * own artifacts) unless a surface says otherwise; the public share page wraps
 * everything it renders in `public`, so an inline Mermaid block in a shared
 * transcript gets the stranger's-page policy without having to be told.
 */
const SandboxProfileContext = React.createContext<SandboxProfile>("private");

export function SandboxProfileProvider({ profile, children }: { profile: SandboxProfile; children: React.ReactNode }) {
  return <SandboxProfileContext.Provider value={profile}>{children}</SandboxProfileContext.Provider>;
}

export function useSandboxProfile(): SandboxProfile {
  return React.useContext(SandboxProfileContext);
}

/**
 * An iframe that shows `html` on a preview origin with its own policy.
 *
 * Why not `srcDoc`: a srcdoc document inherits this page's Content-Security-
 * Policy, and the app's nonce policy blocks every inline script an artifact has
 * (audit X-01; src/lib/sandbox-policy.ts has the whole argument). So the frame
 * loads the static shell by URL and gives it the document over postMessage
 * (src/lib/sandbox-shell.ts has the other half of the exchange).
 *
 * The frame is remounted for every new document, so a revision never runs on
 * top of the previous one's timers and globals — the same clean slate a new
 * srcdoc gave. Callers that listen to the preview's own messages pass a ref and
 * compare `event.source` with its `contentWindow`, exactly as before.
 */
export const SandboxDocumentFrame = React.forwardRef<
  HTMLIFrameElement,
  {
    html: string;
    title: string;
    /** Defaults to the context's profile. */
    profile?: SandboxProfile;
    /** The iframe's capability list; defaults to the profile's (SANDBOX_FLAGS). */
    sandbox?: string;
    className?: string;
    /** The preview document itself finished loading (not just the shell). */
    onDocumentLoad?: () => void;
  }
>(function SandboxDocumentFrame({ html, title, profile, sandbox, className, onDocumentLoad }, forwardedRef) {
  const contextProfile = useSandboxProfile();
  const effectiveProfile = profile ?? contextProfile;
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLIFrameElement | null) => {
      frameRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef]
  );

  // One mount per document: a new key is a new frame, a new shell and a new JS
  // realm. (A caller that wants to re-run the SAME document keys this
  // component instead — SandboxFrame does, on its run nonce.)
  const [generation, setGeneration] = React.useState(0);
  const [renderedHtml, setRenderedHtml] = React.useState(html);
  if (renderedHtml !== html) {
    setRenderedHtml(html);
    setGeneration((g) => g + 1);
  }

  const htmlRef = React.useRef(html);
  const onLoadRef = React.useRef(onDocumentLoad);
  React.useLayoutEffect(() => {
    htmlRef.current = html;
    onLoadRef.current = onDocumentLoad;
  });

  // The frame gets its `src` only once the listener below exists. Rendered on
  // the server with a src, the browser would start loading the shell while the
  // HTML parses — and a warm (cached) shell says "ready" before React has
  // hydrated anyone to hear it, leaving a blank preview that never renders.
  const [armed, setArmed] = React.useState(false);

  React.useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only OUR frame. The document in it is artifact code, so everything it
      // says is treated as untrusted; these two messages only ask for what the
      // frame was going to be given anyway.
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === SANDBOX_READY_MESSAGE) {
        // Answered every time, not once: a `location.reload()` inside the
        // preview reloads the shell, which asks again. The target origin is
        // `*` because the frame's origin is opaque by design and has no name.
        frame.contentWindow?.postMessage({ type: SANDBOX_RENDER_MESSAGE, html: htmlRef.current }, "*");
      } else if (data.type === SANDBOX_LOADED_MESSAGE) {
        onLoadRef.current?.();
      }
    };
    window.addEventListener("message", onMessage);
    setArmed(true);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      key={generation}
      ref={setRef}
      title={title}
      src={armed ? sandboxShellUrl(effectiveProfile) : undefined}
      // Opaque origin (no allow-same-origin) so preview code cannot touch the
      // app, its cookies or its storage. See SANDBOX_FLAGS.
      sandbox={sandbox ?? SANDBOX_FLAGS[effectiveProfile]}
      // The preview's own requests must not name the conversation they came from.
      referrerPolicy="no-referrer"
      className={className}
    />
  );
});
