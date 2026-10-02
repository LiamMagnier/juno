"use client";

import * as React from "react";

import { resolveModel } from "@/lib/models";
import { derivePhase } from "@/lib/run/phase";
import { presentTool } from "@/lib/run/presentation";
import { claimLoop, useLoopOwner } from "@/lib/run/store";
import { buildRunView } from "@/lib/run/timeline";
import type { PhaseInputs, RunPhase, RunView } from "@/lib/run/types";

import type { ModelCatalogEntry } from "./panel-model";
import type { PanelMessage } from "./use-panel-message";

/*
 * What the Activity panel takes from the rest of the run UI, in one place.
 *
 * The panel renders the run view the transcript builds (`buildRunView`), tool
 * rows through the presentation registry (`presentTool`), and joins the
 * one-loop arbiter (`claimLoop`, `useLoopOwner`) — all built by the run UI's
 * own workstream (SPEC §12.7). Reaching them through this context rather than
 * by direct call lets the `/dev/run` panel states and the tests render the
 * panel against hand-built views, and lets integration hand in the paced phase
 * store once it exists, without the panel changing.
 *
 * The defaults are the real modules. Nothing here is a second implementation.
 */

export interface PanelPorts {
  buildRunView(message: PanelMessage): RunView;
  presentTool: typeof presentTool;
  /** The run's phase for the header's static word; null when it is not working. */
  phaseOf(message: PanelMessage, view: RunView, now: number): RunPhase | null;
  claimLoop: typeof claimLoop;
  useLoopOwner: typeof useLoopOwner;
  /** The client model catalog: display name and context window. */
  modelInfo(modelId: string): ModelCatalogEntry | null;
  fetch: typeof fetch;
  now(): number;
}

/** The live inputs `derivePhase` reads, as far as a persisted-or-streaming message can tell them. */
export function phaseInputsOf(message: PanelMessage, view: RunView, now: number): PhaseInputs {
  return {
    streaming: message.streaming === true,
    error: message.error === true || message.finishReason === "error" || message.finishReason === "network_error",
    finishReason: message.finishReason ?? null,
    answerStarted: Boolean(message.content),
    lastEventAt: now,
    now,
    startedAt: view.timing.startedAt ?? now,
  };
}

export const DEFAULT_PANEL_PORTS: PanelPorts = {
  buildRunView: (message) => buildRunView(message),
  presentTool,
  phaseOf: (message, view, now) => derivePhase(view, phaseInputsOf(message, view, now)).phase,
  claimLoop,
  useLoopOwner,
  modelInfo: (modelId) => {
    const model = resolveModel(modelId);
    return model ? { name: model.name, contextWindow: model.contextWindow } : null;
  },
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
};

const PanelPortsContext = React.createContext<PanelPorts>(DEFAULT_PANEL_PORTS);

/** Overrides some ports for everything below; the rest stay the real modules. */
export function PanelPortsProvider({ ports, children }: { ports: Partial<PanelPorts>; children: React.ReactNode }) {
  const parent = React.useContext(PanelPortsContext);
  const value = React.useMemo(() => ({ ...parent, ...ports }), [parent, ports]);
  return <PanelPortsContext.Provider value={value}>{children}</PanelPortsContext.Provider>;
}

export function usePanelPorts(): PanelPorts {
  return React.useContext(PanelPortsContext);
}
