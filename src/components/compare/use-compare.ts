"use client";

import * as React from "react";
import { CompareController } from "@/lib/compare/controller";
import type { CompareRunSpec } from "@/lib/compare/run-spec";
import type { ModelId } from "@/lib/models";
import type { ClientQuota } from "@/types/chat";

/**
 * The side-by-side comparison's React binding. Everything that matters (the
 * per-pane state machine, the parallel private /api/chat streams, server-first
 * stopping, late-frame protection) lives in `CompareController`
 * (src/lib/compare/controller.ts), where it is tested without a renderer.
 * This hook only subscribes to it and hands the commands through.
 */

export { IDLE_RUN, isPaneStreaming, type PaneRun, type PaneStatus } from "@/lib/compare/pane-run";

export function useCompare(opts: { onQuota?: (quota: ClientQuota) => void } = {}) {
  const [controller] = React.useState(() => new CompareController());
  const onQuotaRef = React.useRef(opts.onQuota);
  React.useEffect(() => {
    onQuotaRef.current = opts.onQuota;
  });
  React.useEffect(() => {
    controller.setOnQuota((quota) => onQuotaRef.current?.(quota));
  }, [controller]);

  const { runs, anyStreaming, stopping } = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  // Leaving the page mid-stream stops every generation server-side (an
  // abandoned private stream would otherwise run, and bill, to completion).
  React.useEffect(() => () => controller.dispose(), [controller]);

  const start = React.useCallback(
    (spec: CompareRunSpec, panes: { id: string; modelId: ModelId }[]) => void controller.start(spec, panes),
    [controller]
  );
  const runPane = React.useCallback(
    (paneId: string, modelId: ModelId, spec: CompareRunSpec) => controller.runPane(paneId, modelId, spec),
    [controller]
  );
  const stopAll = React.useCallback(() => controller.stopAll(), [controller]);
  const discardPane = React.useCallback((paneId: string) => controller.discardPane(paneId), [controller]);
  const resetPane = React.useCallback((paneId: string) => controller.resetPane(paneId), [controller]);

  return { runs, anyStreaming, stopping, start, runPane, stopAll, discardPane, resetPane };
}
