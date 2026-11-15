/**
 * Which transcript row the thought dock belongs to.
 *
 * The dock is keyed on the row's RENDER key, not its message id. A streamed
 * answer starts under a temporary id and is swapped for the saved row when it
 * finishes (use-chat `done`), keeping its `renderKey`. Keyed on the id, a dock
 * opened while the answer streamed lost its row at that swap: the portal
 * unmounted and chat-view's reconciliation closed the dock the moment the
 * answer landed. The render key is also the transcript window's own key, so
 * the window can keep the docked row mounted by the same name.
 */
export interface DockRow {
  id: string;
  renderKey?: string;
}

export function dockKeyOf(row: DockRow): string {
  return row.renderKey ?? row.id;
}

/** Whether `key` still names a row in this transcript. */
export function dockNamesRow(rows: readonly DockRow[], key: string | null | undefined): boolean {
  if (!key) return false;
  return rows.some((row) => dockKeyOf(row) === key);
}
