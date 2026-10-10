/**
 * Role routing for child agents (SPEC §3.3–3.4, §4).
 *
 * A child no longer has to run on its parent's provider adapter. The session's
 * `RoleRouting` names a {provider instance, model, effort, context tier} per
 * role, and a model a subagent call names explicitly ("sonnet",
 * "openai:gpt-6", "inherit") resolves to a provider *and* a model. The host
 * supplies the one piece this package cannot know — how an instance id and a
 * model become a `ProviderAdapter` — through `ProviderResolver`.
 */

import type { ProviderAdapter, ReasoningEffort } from '../providers/types.js';
import { isReasoningEffort } from '../providers/types.js';
import {
  resolveModelAlias,
  type AgentRole,
  type ContextTier,
  type EffortLevel,
  type ModelSelection,
  type RoleRouting,
} from '../contracts/code-v2.js';

/** What a resolver hands back for one selection. */
export interface ResolvedProvider {
  adapter: ProviderAdapter;
  /** The model id exactly as `adapter.stream` expects it. */
  model: string;
  /** False when inference is not billed to Alevr (BYOK key, the user's own subscription). */
  billable?: boolean;
  /** The selected context tier's price, for the run budget. */
  tier?: ContextTier;
}

/**
 * Turns a selection into an adapter. Returns null when the instance is unknown
 * or not ready; the caller then falls back to the parent's adapter and says so.
 */
export type ProviderResolver = (selection: ModelSelection) => ResolvedProvider | null;

/** The parent's own provider, as a child that inherits sees it. */
export interface ParentRoute {
  adapter: ProviderAdapter;
  model: string;
  selection?: ModelSelection;
  effort?: ReasoningEffort;
  tier?: ContextTier;
}

/** One child's resolved route. */
export interface ChildRoute {
  adapter: ProviderAdapter;
  model: string;
  selection: ModelSelection;
  effort?: ReasoningEffort;
  tier?: ContextTier;
  billable: boolean;
  /** Plain-language note when the request could not be honoured as asked. */
  note?: string;
}

const INHERIT_WORDS = new Set(['inherit', 'same', 'default', 'auto', 'parent']);
const FAST_WORDS = new Set(['fast', 'flash', 'flash_lite', 'lite', 'mini', 'small', 'cheap']);

/** The engine's six effort tiers from the contract's seven (`none` = Instant). */
export function engineEffort(effort: EffortLevel | undefined): ReasoningEffort | undefined {
  if (!effort || effort === 'none') return undefined;
  return isReasoningEffort(effort) ? effort : undefined;
}

/** The contract role a legacy subagent role reports as. */
export function contractRoleOf(role: string): AgentRole {
  switch (role) {
    case 'explorer':
      return 'explorer';
    case 'architect':
      return 'architect';
    case 'reviewer':
      return 'reviewer';
    case 'orchestrator':
    case 'compaction':
    case 'worker':
      return role;
    default:
      return 'worker';
  }
}

/** `provider:model` → [provider, model]; a bare id has no provider. */
export function splitCanonical(model: string): { provider?: string; model: string } {
  const index = model.indexOf(':');
  if (index <= 0) return { model };
  return { provider: model.slice(0, index), model: model.slice(index + 1) };
}

/**
 * The legacy fast-model shorthands, kept per lab so "use a fast model" on a
 * parent with no routing still picks the same lab's small model.
 */
function fastModelFor(parentModel: string, parentProviderId: string): string | null {
  const lab = splitCanonical(parentModel).provider ?? parentProviderId.replace(/^backend\//, '');
  if (lab.startsWith('anthropic')) return 'anthropic:claude-haiku-4-5';
  if (lab.startsWith('google')) return 'google:gemini-3.8-flash';
  if (lab.startsWith('openai')) return 'openai:gpt-5.4-mini';
  return null;
}

/** The routing entry a role reads, round-robin over workers. */
export function routingSelectionFor(
  routing: RoleRouting | undefined,
  role: AgentRole,
  ordinal = 0,
): ModelSelection | undefined {
  if (!routing) return undefined;
  switch (role) {
    case 'explorer':
      return routing.explorer ?? routing.workers?.[ordinal % Math.max(1, routing.workers.length)];
    case 'reviewer':
      return routing.reviewer ?? routing.orchestrator;
    case 'compaction':
      return routing.compaction;
    case 'orchestrator':
      return routing.orchestrator;
    // team lane: the Architect plans on its own model, else the lead's.
    case 'architect':
      return routing.architect ?? routing.orchestrator;
    case 'worker': {
      const workers = routing.workers ?? [];
      return workers.length > 0 ? workers[ordinal % workers.length] : undefined;
    }
  }
}

function inherit(parent: ParentRoute, note?: string): ChildRoute {
  return {
    adapter: parent.adapter,
    model: parent.model,
    selection: parent.selection ?? { instanceId: 'alevr', model: parent.model },
    ...(parent.effort ? { effort: parent.effort } : {}),
    ...(parent.tier ? { tier: parent.tier } : {}),
    billable: true,
    ...(note ? { note } : {}),
  };
}

function fromSelection(
  selection: ModelSelection,
  resolver: ProviderResolver | undefined,
  parent: ParentRoute,
): ChildRoute | null {
  const effort = engineEffort(selection.effort) ?? parent.effort;
  if (resolver) {
    const resolved = resolver(selection);
    if (resolved) {
      return {
        adapter: resolved.adapter,
        model: resolved.model,
        selection,
        ...(effort ? { effort } : {}),
        ...(resolved.tier ? { tier: resolved.tier } : {}),
        billable: resolved.billable !== false,
      };
    }
    return null;
  }
  // No resolver: only the parent's adapter exists. It can run the selection
  // when it is the same lab (or the model is bare) — the adapter takes its
  // own ids, so the lab prefix is stripped when the parent's model has none.
  const wanted = splitCanonical(selection.model);
  const parentSplit = splitCanonical(parent.model);
  const parentLab = parentSplit.provider ?? parent.adapter.id.replace(/^backend\//, '');
  if (wanted.provider && wanted.provider !== parentLab) return null;
  const model = parentSplit.provider ? `${parentLab}:${wanted.model}` : wanted.model;
  return {
    adapter: parent.adapter,
    model,
    selection,
    ...(effort ? { effort } : {}),
    billable: true,
  };
}

/**
 * Where one child runs.
 *
 * Order: a fork always inherits (it replays the parent's prefix, which only
 * the parent's model can read from cache); an explicit model wins next; then
 * the routing entry for the child's role; then the parent.
 */
export function resolveChildRoute(input: {
  requested?: string;
  role: AgentRole;
  ordinal?: number;
  fork?: boolean;
  routing?: RoleRouting;
  resolver?: ProviderResolver;
  parent: ParentRoute;
}): ChildRoute {
  const { parent, resolver, routing } = input;
  if (input.fork) return inherit(parent);

  const requested = input.requested?.trim();
  if (requested) {
    const lowered = requested.toLowerCase();
    if (INHERIT_WORDS.has(lowered)) return inherit(parent);
    let canonical: string | null = resolveModelAlias(requested);
    if (FAST_WORDS.has(lowered)) {
      const explorer = routing?.explorer;
      if (explorer) {
        const route = fromSelection(explorer, resolver, parent);
        if (route) return route;
      }
      canonical = fastModelFor(parent.model, parent.adapter.id);
      if (canonical === null) return inherit(parent);
    }
    // A bare Claude id is Anthropic's.
    if (!canonical.includes(':') && canonical.toLowerCase().startsWith('claude')) canonical = `anthropic:${canonical}`;
    const instanceId = parent.selection?.instanceId ?? 'alevr';
    const route = fromSelection({ instanceId, model: canonical }, resolver, parent);
    if (route) return route;
    return inherit(parent, `"${requested}" is not available here, so this agent runs on ${parent.model}.`);
  }

  const routed = routingSelectionFor(routing, input.role, input.ordinal ?? 0);
  if (routed) {
    const route = fromSelection(routed, resolver, parent);
    if (route) return route;
    return inherit(parent, `${routed.model} (${routed.instanceId}) is not available, so this agent runs on ${parent.model}.`);
  }
  return inherit(parent);
}
