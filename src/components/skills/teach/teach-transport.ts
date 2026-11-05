"use client";

import type { WorkBlocked, WorkResult, WorkTransportFailure } from "@/components/work/work-transport";
import {
  readSkillDraft,
  type ClientSkillDraft,
  type ClientTaughtSkill,
  type TaughtApp,
  type TaughtSkillForEdit,
  type TaughtSkillSaved,
} from "@/lib/skills/teach";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Everything the Teach page and the chat's draft card ask the server for.
 *
 *   GET  /api/skills/teach/context      → { projects, apps }
 *   GET  /api/skills/teach?key=…        → { skill | null }
 *   GET  /api/skills/teach/[id]         → TaughtSkillForEdit
 *   POST /api/skills/teach              TaughtSkillSave → TaughtSkillSaved
 *   POST /api/skills/teach/[id]/revoke  → { skill }
 *
 * The same result shape as the skills library (`WorkResult`): a refusal the
 * server explained arrives as `blocked` with its sentence, a failure the
 * reader can only retry as `failed`.
 */

async function body(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function refusal(res: Response): Promise<WorkBlocked | WorkTransportFailure> {
  const data = await body(res);
  const message = typeof data.message === "string" && data.message ? data.message : null;
  if (res.status === 409 || res.status === 429 || (res.status === 400 && message)) {
    return {
      kind: "blocked",
      reason: typeof data.error === "string" ? data.error : "unavailable",
      explanation: message ?? `${PRODUCT_NAME} can’t do that right now. Try again in a moment.`,
      missing: [],
      degradation: [],
    };
  }
  if (res.status === 401 || res.status === 403) return { kind: "failed", cause: "unauthorized", message };
  if (res.status === 404) return { kind: "failed", cause: "not_found", message };
  return { kind: "failed", cause: res.status === 400 ? "rejected" : "server", message };
}

async function request<T>(
  method: "GET" | "POST",
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
  } catch {
    return { kind: "failed", cause: "offline", message: null };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

function taughtSkill(raw: unknown): ClientTaughtSkill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.slug !== "string") return null;
  return {
    id: r.id,
    slug: r.slug,
    name: typeof r.name === "string" ? r.name : r.slug,
    enabled: r.enabled === true,
    currentVersion: typeof r.currentVersion === "number" ? r.currentVersion : 1,
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    securityStatus: typeof r.securityStatus === "string" ? r.securityStatus : "pending",
  };
}

export interface TeachContext {
  projects: { id: string; name: string }[];
  apps: TaughtApp[];
}

export function fetchTeachContext(): Promise<WorkResult<TeachContext>> {
  return request("GET", "/api/skills/teach/context", undefined, (data) => ({
    projects: Array.isArray(data.projects)
      ? data.projects.flatMap((p) =>
          p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string"
            ? [{ id: (p as { id: string }).id, name: String((p as { name?: unknown }).name ?? "Untitled project") }]
            : []
        )
      : [],
    apps: Array.isArray(data.apps)
      ? data.apps.flatMap((a) =>
          a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string"
            ? [{ id: (a as { id: string }).id, label: String((a as { label?: unknown }).label ?? (a as { id: string }).id) }]
            : []
        )
      : [],
  }));
}

export function fetchTaughtSkillByKey(key: string): Promise<WorkResult<ClientTaughtSkill | null>> {
  return request("GET", `/api/skills/teach?key=${encodeURIComponent(key)}`, undefined, (data) => taughtSkill(data.skill));
}

export function fetchTaughtSkillForEdit(id: string): Promise<WorkResult<TaughtSkillForEdit>> {
  return request("GET", `/api/skills/teach/${encodeURIComponent(id)}`, undefined, (data) => data as unknown as TaughtSkillForEdit);
}

export function saveTaughtSkillRequest(payload: Record<string, unknown>): Promise<WorkResult<TaughtSkillSaved>> {
  return request("POST", "/api/skills/teach", payload, (data) => ({
    outcome: data.outcome === "replayed" || data.outcome === "versioned" ? data.outcome : "created",
    skill: taughtSkill(data.skill) ?? { id: "", slug: "", name: "", enabled: false, currentVersion: 1, projectId: null, securityStatus: "pending" },
    version: typeof data.version === "number" ? data.version : 1,
    reason: typeof data.reason === "string" ? (data.reason as TaughtSkillSaved["reason"]) : null,
    message: typeof data.message === "string" ? data.message : null,
    requiresConsent: data.requiresConsent === true,
  }));
}

export function revokeTaughtSkillRequest(id: string): Promise<WorkResult<ClientTaughtSkill | null>> {
  return request("POST", `/api/skills/teach/${encodeURIComponent(id)}/revoke`, {}, (data) => taughtSkill(data.skill));
}

/** The sentence for a result that did not succeed. */
export function teachFailureMessage(result: WorkBlocked | WorkTransportFailure, fallback: string): string {
  if (result.kind === "blocked") return result.explanation;
  if (result.message) return result.message;
  if (result.cause === "offline") return `Couldn’t reach ${PRODUCT_NAME}. Check your connection and try again.`;
  if (result.cause === "unauthorized") return "Your session has ended. Sign in again to continue.";
  return fallback;
}

// ---------------------------------------------------------------------------
// Handing a chat draft to the Teach page
// ---------------------------------------------------------------------------

/*
 * The draft goes from the card to /skills/teach?draft=<id> through this tab's
 * session storage, not the URL: the steps are the person's own words, and a
 * URL is shared, logged and kept in history. A tab that cannot store it opens
 * the page with the conversation link instead, which re-opens the card.
 */
const DRAFT_PREFIX = "alevr:skill-draft:";

export function stashSkillDraft(draft: ClientSkillDraft): string | null {
  try {
    const id = Math.random().toString(36).slice(2, 12);
    window.sessionStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(draft));
    return id;
  } catch {
    return null;
  }
}

export function readStashedSkillDraft(id: string | null): ClientSkillDraft | null {
  if (!id || !/^[a-z0-9]{1,16}$/.test(id)) return null;
  try {
    const raw = window.sessionStorage.getItem(DRAFT_PREFIX + id);
    return raw ? (readSkillDraft(JSON.parse(raw)) ?? null) : null;
  } catch {
    return null;
  }
}
