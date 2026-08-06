/**
 * Entry point for the design editor bundle the Mac hosts.
 *
 * This mounts the **same** `DesignEditor` the website renders — same canvas,
 * same operation layer, same layout engine, same inspector, same undo stack.
 * The only difference is where a committed transaction goes: on the web it is
 * an authenticated POST, here it is a validated bridge message. That is the
 * whole reason the editor lives in one place instead of two.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { DesignEditor } from "@/components/design/design-editor";
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

  return (
    <>
      <DesignEditor
        artifactId={session.document.id}
        content={content}
        transport={transport}
        readOnly={readOnly}
        onSelectionChange={(revision, nodeIds) => reportSelection(session.nonce, revision, nodeIds)}
      />
      <Toaster position="bottom-center" richColors />
    </>
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

// A crash inside the editor must reach the native pane, not vanish into a web
// view nobody can open the console on.
window.addEventListener("error", (event) => reportFailure(null, event.message));
window.addEventListener("unhandledrejection", (event) => reportFailure(null, String(event.reason)));

const container = document.getElementById("root");
if (container) createRoot(container).render(<Boot />);
