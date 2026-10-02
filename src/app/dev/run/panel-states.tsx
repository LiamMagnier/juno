"use client";

import * as React from "react";

/*
 * The Activity panel's states for the `/dev/run` gallery (SPEC §11.1): the
 * gallery's "panel open" toggle mounts the shell and the panel beside the
 * transcript from here, on the message the player is driving.
 *
 * WS0 STUB: final props, placeholder body. WS6 builds it; WS5's gallery
 * mounts it.
 */

export interface RunPanelStatesProps {
  open: boolean;
  /** The renderKey of the message the panel follows; null closes it. */
  renderKey: string | null;
  mode: "column" | "sheet";
  onClose(): void;
}

export function RunPanelStates({ open, renderKey }: RunPanelStatesProps) {
  return <div data-stub="run-panel-states" data-open={open ? "true" : undefined} data-render-key={renderKey ?? undefined} />;
}
