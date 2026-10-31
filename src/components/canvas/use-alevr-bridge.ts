"use client";

import * as React from "react";
import { createAlevrBridgeHost, type ConsentAnswer } from "@/lib/artifact-ai/bridge-host";
import { runtimeTargetKey, type AlevrRuntimeTarget } from "@/lib/artifact-ai/protocol";

/**
 * Answers `window.alevr` calls from one sandbox frame (src/lib/artifact-ai/bridge-host.ts
 * holds the rules). Only messages whose `source` is this frame's own
 * `contentWindow` are handed on; the host then checks the channel and shape.
 *
 * A new host per document: when the preview is rebuilt (an edit, a re-run, a
 * version switch) the calls the old document left running are aborted, so a
 * page that was replaced stops spending.
 */
export function useAlevrBridge({
  frameRef,
  channel,
  target,
  documentHtml,
  runNonce,
  askConsent,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  channel: string;
  target: AlevrRuntimeTarget | null | undefined;
  /** The document the frame shows; a new one (or a re-run) is a new host. */
  documentHtml: string;
  runNonce: number;
  askConsent?: () => Promise<ConsentAnswer>;
}) {
  const consentRef = React.useRef(askConsent);
  React.useLayoutEffect(() => {
    consentRef.current = askConsent;
  });
  const hasConsentStep = !!askConsent;
  const targetKey = runtimeTargetKey(target);
  // The target as a value, re-derived from its key so the effect below depends
  // on what it names rather than on the caller's object identity.
  const stableTarget = React.useMemo<AlevrRuntimeTarget | null>(() => {
    if (targetKey.startsWith("a:")) return { artifactId: targetKey.slice(2) };
    if (targetKey.startsWith("s:")) return { shareToken: targetKey.slice(2) };
    return null;
  }, [targetKey]);

  React.useEffect(() => {
    const host = createAlevrBridgeHost({
      channel,
      target: stableTarget,
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, "*"),
      fetch: (input, init) => window.fetch(input, init),
      askConsent: hasConsentStep ? () => consentRef.current?.() ?? Promise.resolve<ConsentAnswer>("denied") : undefined,
    });
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only OUR frame's window; everything else on the page is ignored.
      if (!frame || event.source !== frame.contentWindow) return;
      host.handle(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      host.dispose();
    };
    // `documentHtml` and `runNonce` are not read inside: they are what makes the
    // previous document's calls end when the frame is given a new one.
  }, [channel, stableTarget, documentHtml, runNonce, hasConsentStep, frameRef]);
}
