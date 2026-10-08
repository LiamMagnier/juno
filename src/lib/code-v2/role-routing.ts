/**
 * Role routing validation (Alevr Code v2 SPEC §3.4, §4): the per-thread
 * choice of orchestrator, workers, reviewer, explorer and compaction model,
 * each a `ModelSelection` on a provider instance.
 *
 * What the server can check, it checks; what only the user's machine can
 * know, it leaves to the machine:
 *
 *  - `alevr` and `byok:<lab>` selections run on Alevr's engine, so the model
 *    must be in the catalogue, agentic, and (for BYOK) from that lab with a
 *    working key stored; the effort must be on the model's ladder, the context
 *    tier one it offers, and Fast only where the lab sells it. Aliases
 *    (`opus`, `sonnet`…) are resolved to canonical ids.
 *  - `claude-agent:*`, `codex:*` and `acp:*` selections run the vendor's own
 *    runtime on the user's Mac; their model lists live there (Codex
 *    `model/list`, the ACP agent's models). Only the shape is checked here,
 *    and a cloud run refuses them outright — a GitHub runner has no user CLI.
 *
 * The result is the normalized routing to persist, or every problem found.
 */
import {
  EFFORT_LEVEL_VALUES,
  ROLE_PRESET_VALUES,
  instanceKindOf,
  resolveModelAlias,
  type ByokProvider,
  type EffortLevel,
  type ModelSelection,
  type ProviderKind,
  type RoleRouting,
  type RolePreset,
} from "@/lib/code-v2/contracts";
import type { ModelInfo } from "@/lib/models";
import { supportsFastMode } from "@/lib/pricing";
import { codeEffortLevels, isCodeAgentModel } from "@/lib/code-v2/code-models";
import { validateContextTier } from "@/lib/code-v2/context-tiers";

export const MAX_WORKERS = 8;
export const BEST_OF_N_MIN = 2;
export const BEST_OF_N_MAX = 6;
export const MAX_BUDGET_TOKENS = 1_000_000_000;
export const MAX_BUDGET_USD = 10_000;

export interface RoutingContext {
  /** Curated catalogue lookup (`catalogModel`); must not fabricate unknown ids. */
  resolve: (id: string) => ModelInfo | null;
  /** Labs with a working stored key; null skips the presence check (tests, offline validation). */
  byokProviders: ReadonlySet<ByokProvider> | null;
  /** Where the run executes. Cloud runs cannot use local subscriptions. */
  target?: "device" | "cloud";
  at?: Date | number;
}

/**
 * `warnings` name what was normalized away rather than refused (today: Fast
 * asked of a model with no fast mode, which is dropped so the run is not
 * billed or described as something it cannot be).
 */
export type RoutingValidation = { ok: true; routing: RoleRouting; warnings: string[] } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function validateSelection(
  raw: unknown,
  where: string,
  ctx: RoutingContext,
  errors: string[],
  warnings: string[] = [],
): ModelSelection | null {
  if (!isObject(raw)) {
    errors.push(`${where}: expected a model selection.`);
    return null;
  }
  const { instanceId, model, effort, contextTokens, fast } = raw;
  if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 120) {
    errors.push(`${where}: instanceId is required.`);
    return null;
  }
  const kind: ProviderKind | null = instanceKindOf(instanceId);
  if (!kind) {
    errors.push(`${where}: "${instanceId}" is not a provider instance.`);
    return null;
  }
  if (typeof model !== "string" || model.trim().length === 0 || model.length > 200) {
    errors.push(`${where}: model is required.`);
    return null;
  }
  if (effort !== undefined && !(EFFORT_LEVEL_VALUES as readonly unknown[]).includes(effort)) {
    errors.push(`${where}: effort "${String(effort)}" is not an effort level.`);
    return null;
  }
  if (contextTokens !== undefined && (typeof contextTokens !== "number" || !Number.isInteger(contextTokens) || contextTokens <= 0)) {
    errors.push(`${where}: contextTokens must be a positive whole number.`);
    return null;
  }
  if (fast !== undefined && typeof fast !== "boolean") {
    errors.push(`${where}: fast must be true or false.`);
    return null;
  }

  const out: ModelSelection = { instanceId, model: model.trim() };
  if (effort !== undefined) out.effort = effort as EffortLevel;
  if (contextTokens !== undefined) out.contextTokens = contextTokens as number;
  if (fast !== undefined) out.fast = fast;

  if (kind === "claude-agent" || kind === "codex" || kind === "acp") {
    if (ctx.target === "cloud") {
      errors.push(`${where}: ${instanceId} runs on your Mac and can't be used in a cloud run.`);
      return null;
    }
    return out;
  }

  // alevr / byok: Alevr's engine, checked against the catalogue.
  const canonical = resolveModelAlias(out.model);
  const info = ctx.resolve(canonical);
  if (!info) {
    errors.push(`${where}: "${out.model}" is not in the catalogue.`);
    return null;
  }
  out.model = info.id;
  if (!isCodeAgentModel(info)) {
    errors.push(`${where}: ${info.name} can't drive a coding agent.`);
    return null;
  }
  if (kind === "byok") {
    const lab = instanceId.slice("byok:".length) as ByokProvider;
    if (info.provider !== lab) {
      errors.push(`${where}: ${info.name} isn't a ${lab} model, so your ${lab} key can't run it.`);
      return null;
    }
    if (ctx.byokProviders && !ctx.byokProviders.has(lab)) {
      errors.push(`${where}: no working ${lab} key is connected.`);
      return null;
    }
  }
  if (out.effort !== undefined) {
    const { levels } = codeEffortLevels(info);
    if (!levels.includes(out.effort)) {
      errors.push(
        levels.length
          ? `${where}: ${info.name} takes effort ${levels.join(", ")}, not ${out.effort}.`
          : `${where}: ${info.name} has no effort setting.`,
      );
      return null;
    }
  }
  if (out.contextTokens !== undefined) {
    const tier = validateContextTier(info, out.contextTokens, ctx.at);
    if (!tier.ok) {
      errors.push(`${where}: ${tier.error}`);
      return null;
    }
  }
  if (out.fast && !supportsFastMode(info)) {
    warnings.push(`${where}: ${info.name} has no fast mode; running it at standard speed.`);
    delete out.fast;
  }
  return out;
}

/** Validate and normalize a routing. Unknown fields are dropped. */
export function validateRoleRouting(raw: unknown, ctx: RoutingContext): RoutingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["Routing must be an object."] };
  const preset = raw.preset;
  if (!(ROLE_PRESET_VALUES as readonly unknown[]).includes(preset)) {
    return { ok: false, errors: [`preset must be one of ${ROLE_PRESET_VALUES.join(", ")}.`] };
  }
  const routing: RoleRouting = { preset: preset as RolePreset } as RoleRouting;

  const orchestrator = validateSelection(raw.orchestrator, "orchestrator", ctx, errors, warnings);
  if (orchestrator) routing.orchestrator = orchestrator;

  if (raw.workers !== undefined && preset !== "solo") {
    if (!Array.isArray(raw.workers)) {
      errors.push("workers must be a list.");
    } else if (raw.workers.length > MAX_WORKERS) {
      errors.push(`At most ${MAX_WORKERS} workers.`);
    } else {
      const workers = raw.workers.map((w, i) => validateSelection(w, `workers[${i}]`, ctx, errors, warnings));
      if (workers.every((w): w is ModelSelection => w !== null)) routing.workers = workers;
    }
  }
  const workerCount = Array.isArray(raw.workers) && preset !== "solo" ? raw.workers.length : 0;
  if (preset === "lead-workers" && workerCount < 1) errors.push("Lead + workers needs at least one worker.");
  if (preset === "best-of-n" && (workerCount < BEST_OF_N_MIN || workerCount > BEST_OF_N_MAX)) {
    errors.push(`Best-of-N compares ${BEST_OF_N_MIN} to ${BEST_OF_N_MAX} runs.`);
  }

  for (const role of ["reviewer", "explorer", "compaction"] as const) {
    if (raw[role] === undefined || raw[role] === null) continue;
    const sel = validateSelection(raw[role], role, ctx, errors, warnings);
    if (sel) routing[role] = sel;
  }

  if (raw.budget !== undefined && raw.budget !== null) {
    if (!isObject(raw.budget)) {
      errors.push("budget must be an object.");
    } else {
      const { maxTokens, maxUsd } = raw.budget;
      const budget: NonNullable<RoleRouting["budget"]> = {};
      if (maxTokens !== undefined) {
        if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_BUDGET_TOKENS) {
          errors.push(`budget.maxTokens must be a whole number from 1 to ${MAX_BUDGET_TOKENS.toLocaleString("en-US")}.`);
        } else budget.maxTokens = maxTokens;
      }
      if (maxUsd !== undefined) {
        if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > MAX_BUDGET_USD) {
          errors.push(`budget.maxUsd must be more than 0 and at most ${MAX_BUDGET_USD}.`);
        } else budget.maxUsd = maxUsd;
      }
      if (budget.maxTokens !== undefined || budget.maxUsd !== undefined) routing.budget = budget;
    }
  }

  if (errors.length > 0 || !routing.orchestrator) return { ok: false, errors: errors.length ? errors : ["orchestrator is required."] };
  return { ok: true, routing, warnings };
}

/** Every selection in a routing, orchestrator first. */
export function routingSelections(routing: RoleRouting): ModelSelection[] {
  return [
    routing.orchestrator,
    ...(routing.workers ?? []),
    ...[routing.reviewer, routing.explorer, routing.compaction].filter((s): s is ModelSelection => !!s),
  ];
}

/**
 * True when no selection runs on Alevr's keys: every role is the user's own
 * key or their own subscription, so Alevr's plan is not what pays for the run
 * and the Pro gate does not apply (budgets are still enforced per call by
 * /api/agent for anything that does reach Alevr's keys).
 */
export function routingAvoidsAlevrBilling(routing: RoleRouting | null | undefined): boolean {
  if (!routing) return false;
  return routingSelections(routing).every((s) => instanceKindOf(s.instanceId) !== "alevr");
}

/** The catalogue model id a pre-v2 single-model consumer should run, when the orchestrator is on Alevr's engine. */
export function legacyModelFor(routing: RoleRouting): string | null {
  const kind = instanceKindOf(routing.orchestrator.instanceId);
  return kind === "alevr" || kind === "byok" ? routing.orchestrator.model : null;
}
