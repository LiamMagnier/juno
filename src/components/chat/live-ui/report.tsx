"use client";

import * as React from "react";

/**
 * A view part's own state, told to the view as one plain line ("Quiz:
 * 4 of 5 right", "Servings: 8 people"), so the reader's next message can
 * carry it (src/lib/live-ui/view-state.ts). Inputs, checklists and picks live
 * in the view's shared state and are described by the view itself; this is
 * for parts that keep state of their own (a quiz, a deck, a recipe, a timer).
 *
 * `null` says "nothing worth telling": the part is as the author left it.
 */
type Report = (key: string, line: string | null) => void;

export const LiveReportContext = React.createContext<Report | null>(null);

export function useLiveReport(key: string, line: string | null): void {
  const report = React.useContext(LiveReportContext);
  React.useEffect(() => {
    report?.(key, line);
  }, [report, key, line]);
  React.useEffect(() => () => report?.(key, null), [report, key]);
}
