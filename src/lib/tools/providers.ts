/**
 * The tool providers installed in this build (src/lib/tools/types.ts
 * `ToolProvider`).
 *
 * Empty until the lanes that own them land: the execution lane adds its `exec`
 * provider (`run_code`, `check_run`, against `juno-exec`), the skill lane its
 * `skills` provider (`use_skill`, `read_skill_file`). Each is one import and
 * one entry here. With none installed, no turn carries an execution tool and
 * every chat is told plainly that code cannot run (entitlements.ts).
 *
 * A function rather than the bare list so a route test can stand a fake
 * provider in with a module mock.
 */

import type { ToolProvider, ToolProviderAvailability, ToolSpec, ToolTurn } from "@/lib/tools/types";

const TOOL_PROVIDERS: readonly ToolProvider[] = Object.freeze([]);

export function toolProviders(): readonly ToolProvider[] {
  return TOOL_PROVIDERS;
}

/**
 * Every installed provider's answer for this turn. Never throws: a provider
 * whose check fails is unavailable, because a capability that cannot be
 * confirmed is not offered.
 */
export async function providerAvailability(
  providers: readonly ToolProvider[],
  turn: ToolTurn,
): Promise<Partial<Record<ToolProvider["id"], ToolProviderAvailability>>> {
  const entries = await Promise.all(
    providers.map(async (provider) => {
      try {
        return [provider.id, await provider.availability(turn)] as const;
      } catch {
        return [provider.id, { available: false, reason: "unhealthy" } as const] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Open the providers this turn was granted tools from, and keep only the
 * granted specs: a provider is never trusted to narrow itself. A provider that
 * fails to open contributes nothing and the turn goes on without it.
 */
export async function openGrantedProviders(
  providers: readonly ToolProvider[],
  turn: ToolTurn,
  granted: Partial<Record<ToolProvider["id"], readonly string[]>>,
): Promise<{ specs: ToolSpec[]; promptSections: string[]; close(): Promise<void> }> {
  const sessions = await Promise.all(
    providers.map(async (provider) => {
      const tools = (granted[provider.id] ?? []).filter((tool) => provider.tools.includes(tool));
      if (tools.length === 0) return null;
      try {
        const session = await provider.open(turn, tools);
        return { session, allowed: new Set(tools) };
      } catch (error) {
        console.error("[tools] a tool provider failed to open", {
          provider: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );
  const open = sessions.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return {
    specs: open.flatMap(({ session, allowed }) => session.specs.filter((spec) => allowed.has(spec.id))),
    promptSections: open.map(({ session }) => session.promptSection).filter((text): text is string => !!text?.trim()),
    async close() {
      await Promise.all(open.map(({ session }) => session.close?.().catch(() => undefined)));
    },
  };
}
