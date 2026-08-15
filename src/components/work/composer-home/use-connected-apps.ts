"use client";

import * as React from "react";
import type { ConnectorStatus } from "@/components/connections/types";

export interface ConnectedApps {
  /** Null until the first answer lands. */
  connectors: ConnectorStatus[] | null;
  failed: boolean;
  reload: () => void;
}

/**
 * The account's connected apps, loaded once for everything on the home composer
 * that needs them.
 *
 * Three things do — the Apps chip that switches them on, the pre-flight question
 * that offers to switch one on because the goal named it, and the disclosure
 * that lists what the run will reach — and each of them asking `/api/connectors`
 * for itself would be three answers to one question, arriving at three different
 * moments. Only connected apps are kept: everything on that surface is about
 * narrowing what one task may reach inside what the account already permits, and
 * an app nobody has linked is not a choice it can offer.
 *
 * A failed load is carried rather than swallowed, because "you have no connected
 * apps" and "Juno could not find out" are different sentences and only the
 * second one deserves a Retry.
 *
 * It lives beside `useWorkSkills`, which is the same shape for the same reason
 * on the same surface — one fetch, a null while it is out, a `failed` the chip
 * turns into a Retry. Keeping the two apart in two files was how the composer
 * ended up owning a data hook in the middle of its JSX.
 */
export function useConnectedApps(): ConnectedApps {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/connectors");
      if (!response.ok) throw new Error("connectors");
      const data = (await response.json()) as { connectors?: ConnectorStatus[] };
      setConnectors((data.connectors ?? []).filter((connector) => connector.connected));
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  return { connectors, failed, reload };
}
