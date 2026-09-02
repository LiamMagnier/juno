"use client";

import * as React from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import type { ClientSettings } from "@/types/app";

/**
 * The one way a settings section writes: optimistic, and rolled back when the
 * server refuses. Every control in every section — switches, selects, radio
 * tiles — goes through here, so a rejected write can never leave the UI
 * claiming a value the server never stored.
 */
export function useSettingsSave() {
  const { settings, setSettings } = useApp();
  return React.useCallback(
    async (patch: Partial<ClientSettings>) => {
      const previous = Object.fromEntries(
        (Object.keys(patch) as (keyof ClientSettings)[]).map((key) => [key, settings[key]])
      ) as Partial<ClientSettings>;
      setSettings(patch);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSettings(previous);
        toast.error("Could not save settings.");
      }
      return res.ok;
    },
    [setSettings, settings]
  );
}
