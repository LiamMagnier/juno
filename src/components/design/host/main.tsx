/**
 * Entry point for the design editor bundle the native apps host.
 *
 * This mounts the **same** `DesignEditor` the website renders — same canvas,
 * same operation layer, same layout engine, same inspector, same undo stack.
 * The only difference is where a committed transaction goes: on the web it is
 * an authenticated POST, here it is a validated bridge message. That is the
 * whole reason the editor lives in one place instead of two.
 *
 * The Mac hosts it for editing and the phone read-only, but the mount is one
 * mount. Everything the editor needs from an application shell has to be
 * supplied here, because there is no shell — a lesson `TooltipProvider` below
 * cost both platforms their canvas to teach.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { DesignEditor } from "@/components/design/design-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { serializeDesignDocument } from "@/lib/design/migrations";
import {
  awaitHostSession,
  bridgeTransport,
  isHosted,
  onHostCommand,
  reportFailure,
  reportSelection,
  type HostCommand,
  type HostSession,
} from "@/components/design/host/bridge";

function HostedEditor({ session }: { session: HostSession }) {
  const [readOnly, setReadOnly] = React.useState(session.readOnly);
  // Keyed remounts are how a host-pushed document replaces the editor's own:
  // `useDesignDocument` re-parses whenever `initialContent` changes identity.
  const [content, setContent] = React.useState(() => serializeDesignDocument(session.document));
  const transport = React.useMemo(() => bridgeTransport(session), [session]);

  React.useEffect(() => {
    onHostCommand("adoptDocument", (command: HostCommand) => {
      if (command.type !== "adoptDocument") return;
      setContent(serializeDesignDocument(command.document));
    });
    onHostCommand("setReadOnly", (command: HostCommand) => {
      if (command.type === "setReadOnly") setReadOnly(command.readOnly);
    });
  }, []);

  // `TooltipProvider` is not decoration: every button in the editor's toolbar is
  // a Radix `Tooltip`, and a `Tooltip` with no provider above it *throws* on
  // mount rather than rendering without a hint. On the website the provider
  // comes from `providers.tsx`, which wraps the whole app — this bundle mounts
  // `DesignEditor` on its own, so it has to supply the same context or the
  // editor cannot mount at all.
  //
  // It never did, which is why the canvas was empty on both platforms: the
  // exception unmounted the tree and reached the host as "Script error." — see
  // the root callbacks at the bottom of this file for why that message carried
  // nothing. The 200ms delay is `providers.tsx`'s, so a tooltip in the pane
  // waits exactly as long as the same tooltip in the browser.
  return (
    <TooltipProvider delayDuration={200}>
      <DesignEditor
        artifactId={session.document.id}
        content={content}
        transport={transport}
        readOnly={readOnly}
        onSelectionChange={(revision, nodeIds) => reportSelection(session.nonce, revision, nodeIds)}
      />
      <Toaster position="bottom-center" richColors />
    </TooltipProvider>
  );
}

function Boot() {
  const [session, setSession] = React.useState<HostSession | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isHosted()) {
      // Loaded outside the Mac host — say so rather than sitting on a spinner
      // that will never resolve.
      setError("This editor runs inside the Juno app.");
      return;
    }
    awaitHostSession().then(setSession, (reason) => setError(String(reason)));
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{error}</div>
    );
  }
  if (!session) {
    return <div className="flex h-full items-center justify-center text-caption text-muted-foreground">Opening design…</div>;
  }
  return <HostedEditor session={session} />;
}

/** The message and the stack, because a message alone was not enough — see below. */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ? `${reason.message}\n${reason.stack}` : reason.message;
  return String(reason);
}

// A crash inside the editor must reach the native pane, not vanish into a web
// view nobody can open the console on.
//
// `window.onerror` alone cannot do that job. This bundle is a *subresource* of
// its own file:// document, and WebKit treats every file:// URL as its own
// opaque origin — so an exception thrown in editor.js reaches the document's
// error handler stripped to the literal string "Script error." with no file, no
// line and a null `error`. That is all either pane ever said about the missing
// `TooltipProvider` above — "Script error." — which is why a fault present since
// the bundle was written went undiagnosed on both platforms: there was nothing
// in the report to act on. React 19's root callbacks run *inside* this script
// and are handed the real `Error`, so they are the channel that carries a
// diagnosis out.
window.addEventListener("error", (event) => reportFailure(null, event.message));
window.addEventListener("unhandledrejection", (event) => reportFailure(null, describe(event.reason)));

const container = document.getElementById("root");
if (container) {
  createRoot(container, {
    onUncaughtError: (error) => reportFailure(null, describe(error)),
    onCaughtError: (error) => reportFailure(null, describe(error)),
  }).render(<Boot />);
}
