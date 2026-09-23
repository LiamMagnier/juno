"use client";

import * as React from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import { createSaveLedger } from "@/components/settings/save-ledger";
import type { ClientSettings } from "@/types/app";

type SettingsKey = keyof ClientSettings;

/*
 * Shared by every caller of the hook, on purpose: two sections (or a section
 * and the memory page) writing the same account must agree on what the server
 * last accepted and on the order their writes reach it.
 *
 *   queue    every PATCH waits for the one before it, so two quick toggles of
 *            the same array field reach the server in the order they were
 *            made. Without it, "Health on" then "Money on" could land as
 *            [health, money] followed by [health], and the server would keep
 *            the older list while the switches showed the newer one.
 *   ledger   which write owns each field and what the server last accepted
 *            for it, so only the newest write rolls a field back, and to the
 *            server's value rather than to an optimistic one (save-ledger.ts).
 */
let queue: Promise<unknown> = Promise.resolve();
const ledger = createSaveLedger<SettingsKey>();

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
      // A write that never answers must not hold every later one behind it.
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(20_000) : undefined,
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
        /**
         * Called with the restored values when this write's failure rolls
         * fields back, and only then: never for a failure a newer write has
         * overtaken. For state the settings object does not drive by itself
         * (next-themes' theme, the root's `data-accent`), which must follow
         * the same rule or it drifts from the settings it mirrors.
         */
        onRollback?: (restored: Partial<ClientSettings>) => void;
      }
    ) => {
      const keys = Object.keys(patch) as SettingsKey[];
      const previous = options?.previous;
      const ticket = ledger.begin(keys, (key) =>
        previous && key in previous ? previous[key] : settingsRef.current[key]
      );
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

      if (ok) {
        ledger.settle(ticket, keys, { ok: true, written: patch });
        return true;
      }

      const rollback = ledger.settle(ticket, keys, { ok: false }) as Partial<ClientSettings> | null;
      if (rollback) {
        setSettings(rollback);
        options?.onRollback?.(rollback);
      }
      toast.error("Couldn’t save settings.", reason ? { description: reason } : undefined);
      return false;
    },
    [setSettings]
  );
}
