"use client";

import * as React from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import type { ClientSettings } from "@/types/app";

type SettingsKey = keyof ClientSettings;

/*
 * Shared by every caller of the hook, on purpose: two sections (or a section
 * and the memory page) writing the same account must agree on what the server
 * last accepted and on the order their writes reach it.
 *
 *   queue      every PATCH waits for the one before it, so two quick toggles
 *              of the same array field reach the server in the order they
 *              were made. Without it, "Health on" then "Money on" could land
 *              as [health, money] followed by [health], and the server would
 *              keep the older list while the switches showed the newer one.
 *   latest     the newest write per key. Only that write may roll the key
 *              back; a slow failure of an older write must not undo a newer
 *              change the server already has.
 *   confirmed  the value per key the server last accepted, which is what a
 *              rollback restores. It used to restore the value the calling
 *              component happened to render with, which for an array field
 *              toggled twice in a row was already stale.
 *   pending    writes in flight per key, so `confirmed` is only seeded from
 *              the rendered value while nothing is in flight for it.
 */
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
const latest = new Map<SettingsKey, number>();
const confirmed = new Map<SettingsKey, unknown>();
const pending = new Map<SettingsKey, number>();

/**
 * PATCH /api/settings behind every write already queued, for the fields that
 * are not part of `ClientSettings` (the connector policy) and keep their own
 * optimistic state. Same queue, so a policy change and a switch flipped just
 * before it reach the server in the order they were made.
 */
export function queueSettingsPatch(body: Record<string, unknown>): Promise<Response> {
  const request = queue.then(() =>
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  queue = request.catch(() => undefined);
  return request;
}

const UNREACHABLE_MESSAGE = "The server couldn’t be reached. Check your connection and try again.";

/** The route's own words for a refusal, when it sent any. */
async function refusalReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * The one way a settings section writes: optimistic, sequenced, and rolled
 * back when the server refuses. Every control in every section goes through
 * here, so a rejected write can never leave the UI claiming a value the
 * server never stored. A refusal is toasted with the server's reason when it
 * gave one.
 *
 * Resolves to whether the server accepted the write, so a caller can show
 * its own inline confirmation (see `useSaveStates`).
 */
export function useSettingsSave() {
  const { settings, setSettings } = useApp();
  // Read through a ref so the returned function is stable across renders
  // (callers put it in effect and callback dependencies).
  const settingsRef = React.useRef(settings);
  React.useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  return React.useCallback(
    async (
      patch: Partial<ClientSettings>,
      options?: {
        /**
         * What the server holds for these keys, when the caller has already
         * changed them locally for a live preview (the custom accent while its
         * picker is dragged). Without it the rollback would restore the
         * preview.
         */
        previous?: Partial<ClientSettings>;
      }
    ) => {
      const keys = Object.keys(patch) as SettingsKey[];
      const seq = ++sequence;
      for (const key of keys) {
        if (!pending.get(key)) {
          confirmed.set(key, options?.previous && key in options.previous ? options.previous[key] : settingsRef.current[key]);
        }
        pending.set(key, (pending.get(key) ?? 0) + 1);
        latest.set(key, seq);
      }
      setSettings(patch);

      const request = queueSettingsPatch(patch);

      let ok = false;
      let reason: string | null = null;
      try {
        const res = await request;
        ok = res.ok;
        if (!ok) reason = await refusalReason(res);
      } catch {
        reason = UNREACHABLE_MESSAGE;
      }

      for (const key of keys) pending.set(key, Math.max(0, (pending.get(key) ?? 1) - 1));
      if (ok) {
        for (const key of keys) confirmed.set(key, patch[key]);
        return true;
      }

      const rollback: Partial<Record<SettingsKey, unknown>> = {};
      for (const key of keys) {
        if (latest.get(key) === seq) rollback[key] = confirmed.get(key);
      }
      if (Object.keys(rollback).length > 0) setSettings(rollback as Partial<ClientSettings>);
      toast.error("Couldn’t save settings.", reason ? { description: reason } : undefined);
      return false;
    },
    [setSettings]
  );
}
