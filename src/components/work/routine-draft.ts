"use client";

import type { JsonObject } from "@/lib/work/schedule";

/**
 * A routine handed from a chat card to the routine editor ("More options").
 *
 * Kept in this tab's session storage under a random id and read back by
 * /automations/new?draft=<id>, rather than written into the URL: the
 * instructions can be long and are the person's own words, and a URL is
 * shared, logged and kept in history. A tab that cannot store it opens the
 * editor blank, which is the editor as it always was.
 */
export interface RoutineDraftHandoff {
  name: string;
  instructions: string;
  timezone: string;
  trigger: { kind: string; config: JsonObject };
  budgetMicroUsd: number;
  notifyPolicy: string;
  connectorIds: string[];
  proposalKey?: string;
}

const PREFIX = "alevr:routine-draft:";

export function stashRoutineDraft(draft: RoutineDraftHandoff): string | null {
  try {
    const id = Math.random().toString(36).slice(2, 12);
    window.sessionStorage.setItem(PREFIX + id, JSON.stringify(draft));
    return id;
  } catch {
    return null;
  }
}

export function readRoutineDraft(id: string | null): RoutineDraftHandoff | null {
  if (!id || !/^[a-z0-9]{1,16}$/.test(id)) return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RoutineDraftHandoff>;
    if (typeof parsed.name !== "string" || typeof parsed.instructions !== "string") return null;
    if (!parsed.trigger || typeof parsed.trigger.kind !== "string" || typeof parsed.trigger.config !== "object") return null;
    return {
      name: parsed.name,
      instructions: parsed.instructions,
      timezone: typeof parsed.timezone === "string" ? parsed.timezone : "",
      trigger: { kind: parsed.trigger.kind, config: (parsed.trigger.config ?? {}) as JsonObject },
      budgetMicroUsd: typeof parsed.budgetMicroUsd === "number" ? parsed.budgetMicroUsd : 0,
      notifyPolicy: typeof parsed.notifyPolicy === "string" ? parsed.notifyPolicy : "on_finish",
      connectorIds: Array.isArray(parsed.connectorIds) ? parsed.connectorIds.filter((v): v is string => typeof v === "string") : [],
      ...(typeof parsed.proposalKey === "string" ? { proposalKey: parsed.proposalKey } : {}),
    };
  } catch {
    return null;
  }
}
