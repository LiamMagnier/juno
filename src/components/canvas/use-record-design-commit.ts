"use client";

import * as React from "react";
import { recordCommittedDesign } from "@/lib/design/committed-envelope";
import type { DesignDocument } from "@/lib/design/types";
import type { ClientArtifact } from "@/types/chat";

/**
 * The embedded design editor's `onCommitted`, for a host that keeps the
 * artifact envelope: each acknowledged change is recorded, with the document
 * the store holds, on the newest envelope there is.
 *
 * Not on the `artifact` a callback closed over. The editor sends one request
 * at a time and reports each acknowledgement from the loop it started in, so
 * a run of them can land before the host renders again — and each has to
 * build on the one before, or the second would rebuild the version rail
 * without the first. The newest envelope is taken from props only when the
 * host hands over a different one, so a render of the panel alone (a tab
 * switch) cannot put it back to one it has since replaced.
 */
export function useRecordDesignCommit(
  artifact: ClientArtifact,
  onArtifactUpdated: (artifact: ClientArtifact) => void
): (version: number, document: DesignDocument) => void {
  const latestRef = React.useRef(artifact);
  const fromHostRef = React.useRef(artifact);
  if (fromHostRef.current !== artifact) {
    fromHostRef.current = artifact;
    latestRef.current = artifact;
  }

  return React.useCallback(
    (version: number, document: DesignDocument) => {
      const current = latestRef.current;
      const next = recordCommittedDesign(current, version, document);
      if (next === current) return;
      latestRef.current = next;
      onArtifactUpdated(next);
    },
    [onArtifactUpdated]
  );
}
