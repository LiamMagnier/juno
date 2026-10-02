/**
 * The typed facts a turn starts with (SPEC §2.12), in order: model, effort,
 * context, connectors (with one `connector_unavailable` warning per failed
 * connector), tools, then the context notices. Each row also carries its
 * legacy `kind`/`title`/`detail` (INV-7).
 *
 * Pure, so "Connected tools ready lists only ready connectors" (RC-3) is
 * tested without the route. The rows come back without their stamps: the
 * route sends each through `TurnStream.emitActivity` (or `sendRunActivity`),
 * whose sender gives it its `id`, `createdAt` and `seq` and streams the
 * offered-tools fact only to a `timeline` client (SPEC §2.4).
 */

import type { ClientFeatureSet } from "@/lib/chat/client-features";
import { contextActivityDetail } from "@/lib/chat/context-assembly";
import { noticeActivity } from "@/lib/chat/run-record";
import type { ClientActivityEvent } from "@/types/chat";
import type { CanonicalToolId, ConnectorFailure, RunFact, RunNotice, RunNoticeCode } from "@/types/run";

export interface TurnStartFactsInput {
  features: ClientFeatureSet;
  model: Extract<RunFact, { key: "model" }>;
  effort: Extract<RunFact, { key: "effort" }> | null;
  context: Extract<RunFact, { key: "context" }>;
  /** Null when the turn asked for no connector. */
  connectors: Extract<RunFact, { key: "connectors" }> | null;
  tools: Extract<RunFact, { key: "tools" }>;
  /** `web_off_lockdown`, `private_tools_limited`, `tools_capped` when they apply. */
  notices: readonly RunNotice[];
  /**
   * The legacy lines the route wrote before the rework, when they say more
   * than the typed fact can: the routing note on the model row, the
   * regenerate wording and the memory/passages line on the context row. Each
   * falls back to a line built from the fact.
   */
  legacy?: {
    modelDetail?: string;
    contextTitle?: string;
    contextDetail?: string;
  };
  /** English titles of the offered tools, for the legacy detail of the tools row. Defaults to the ids. */
  toolTitles?: Partial<Record<CanonicalToolId, string>>;
}

// ── Legacy wire text (INV-7) ─────────────────────────────────────────────────
//
// English, read by shipped native builds; the typed UI reads `fact` and
// `notice` and never these (INV-28).

const LEGACY_MODEL_TITLE = "Selected model";
const LEGACY_CONTEXT_TITLE = "Reading the conversation context";
const LEGACY_CONNECTORS_TITLE = "Connected tools ready";
const LEGACY_NO_CONNECTORS_TITLE = "Connected tools unavailable";
const LEGACY_TOOLS_TITLE = "Tools ready";

/** The legacy line of each notice code: a short English sentence, and the detail when the code implies one. */
const LEGACY_NOTICE_TEXT: Readonly<Record<RunNoticeCode, { title: string; detail?: string }>> = {
  model_changed: { title: "Model changed" },
  skill_not_applied: { title: "Skill not applied" },
  connector_unavailable: { title: "Connector unavailable" },
  usage_limit: { title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." },
  stall: { title: "Model stopped responding" },
  finish_length: { title: "Response hit the token limit" },
  finish_sensitive: { title: "Response stopped by a safety filter" },
  tool_budget: { title: "Tool steps used up", detail: "The answer was written from what was found." },
  web_off_lockdown: { title: "Web access is off", detail: "Lockdown mode turns off reading the web." },
  provenance_refused: { title: "Link not opened" },
  hostile_content: { title: "A page tried to instruct the assistant", detail: "Its instructions were ignored." },
  search_degraded: { title: "Web search partly unavailable" },
  research_skipped: { title: "Research was skipped" },
  private_tools_limited: { title: "Some tools are off in private chats" },
  tools_capped: { title: "Some tools were not offered", detail: "A turn can carry at most 64 tools." },
};

/** Why a connector did not connect, as the legacy detail line says it. */
const LEGACY_CONNECTOR_FAILURE: Readonly<Record<ConnectorFailure, string>> = {
  auth_expired: "Its sign-in expired. Reconnect it in Settings.",
  unreachable: "Its server could not be reached.",
  misconfigured: "It is not set up correctly.",
  timeout: "It took too long to connect.",
  not_linked: "It is not linked to this account.",
};

type Row = Omit<ClientActivityEvent, "id" | "createdAt">;

/**
 * A row without its sender stamps. The empty `id` and `createdAt` are
 * overwritten by `sendActivity`, which stamps every row it records.
 */
function unstamped(row: Row): ClientActivityEvent {
  return { ...row, id: "", createdAt: "" };
}

/**
 * The legacy row of a notice (SPEC §2.4): `kind: "warning"` only for the
 * must-act codes, every other code on `kind: "context"`. A string `detail`
 * param, when the notice carries one, is the legacy detail.
 */
export function noticeRow(notice: RunNotice, legacy?: { title?: string; detail?: string }): ClientActivityEvent {
  const text = LEGACY_NOTICE_TEXT[notice.code];
  const paramDetail = typeof notice.params?.detail === "string" ? notice.params.detail : undefined;
  const detail = legacy?.detail ?? paramDetail ?? text.detail;
  return unstamped(noticeActivity(notice, { title: legacy?.title ?? text.title, ...(detail ? { detail } : {}) }));
}

function capitalise(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function effortRow(effort: Extract<RunFact, { key: "effort" }>): Row {
  // As the route wrote it: "Auto thinking" whenever Auto chose, and the one
  // Auto choice with no reasoning says so in its own words.
  const title = effort.auto ? "Auto thinking" : "Reasoning mode enabled";
  const detail =
    effort.auto && effort.effort === "instant"
      ? "Instant — no extra reasoning for this prompt"
      : `${capitalise(effort.effort)} effort`;
  return { kind: "reasoning", title, detail, fact: { ...effort } };
}

export function turnStartFacts(input: TurnStartFactsInput): ClientActivityEvent[] {
  const rows: ClientActivityEvent[] = [];

  rows.push(
    unstamped({
      kind: "model",
      title: LEGACY_MODEL_TITLE,
      detail: input.legacy?.modelDetail ?? input.model.label,
      fact: { ...input.model },
    })
  );

  if (input.effort) rows.push(unstamped(effortRow(input.effort)));

  rows.push(
    unstamped({
      kind: "context",
      title: input.legacy?.contextTitle ?? LEGACY_CONTEXT_TITLE,
      detail:
        input.legacy?.contextDetail ??
        contextActivityDetail({
          messages: input.context.historyMessages,
          attachments: input.context.attachments,
          memories: 0,
          hasProjectContext: input.context.projectFiles > 0,
        }),
      fact: { ...input.context },
    })
  );

  const connectors = input.connectors;
  if (connectors && (connectors.ready.length || connectors.failed.length)) {
    // RC-3: the row names only the connectors that really connected. A turn
    // where none did still gets the fact (the Details tab lists the failures),
    // under a title that does not claim anything is ready.
    const ready = connectors.ready.map((connector) => connector.label);
    rows.push(
      unstamped({
        kind: "tool",
        title: ready.length ? LEGACY_CONNECTORS_TITLE : LEGACY_NO_CONNECTORS_TITLE,
        detail: (ready.length ? ready : connectors.failed.map((connector) => connector.label)).join(" · "),
        fact: {
          key: "connectors",
          ready: connectors.ready.map((connector) => ({ ...connector })),
          failed: connectors.failed.map((connector) => ({ ...connector })),
        },
      })
    );
    for (const failed of connectors.failed) {
      rows.push(
        noticeRow(
          { code: "connector_unavailable", params: { connector: failed.label, reason: failed.reason } },
          { title: `${failed.label} unavailable`, detail: LEGACY_CONNECTOR_FAILURE[failed.reason] }
        )
      );
    }
  }

  // Recorded for every client; the sender streams it only to a `timeline` one (SPEC §2.4).
  const titles = input.tools.offered.map((id) => input.toolTitles?.[id] ?? id);
  rows.push(
    unstamped({
      kind: "context",
      title: LEGACY_TOOLS_TITLE,
      ...(titles.length ? { detail: titles.join(", ") } : {}),
      fact: {
        key: "tools",
        offered: [...input.tools.offered],
        nativeSearch: input.tools.nativeSearch,
        roundBudget: input.tools.roundBudget,
      },
    })
  );

  for (const notice of input.notices) rows.push(noticeRow(notice));
  return rows;
}
