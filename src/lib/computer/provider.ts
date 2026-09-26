import "server-only";
import { env } from "@/lib/env";
import { dockerComputerProvider } from "./docker";
import { fakeComputerProvider } from "./fake";
import type { ComputerProvider } from "./types";

let availabilityCache: {
  providerName: string;
  ok: boolean;
  expiresAt: number;
} | null = null;

export function resetComputerProviderCache(): void {
  availabilityCache = null;
}

export function computerProvider(): ComputerProvider | null {
  const mode = env.agentComputer.provider.toLowerCase();
  if (mode === "docker") {
    return dockerComputerProvider;
  }
  if (mode === "fake") {
    return fakeComputerProvider;
  }
  return null;
}

export async function isAgentComputerConfigured(): Promise<boolean> {
  const provider = computerProvider();
  if (!provider) {
    availabilityCache = null;
    return false;
  }

  const now = Date.now();
  if (
    availabilityCache &&
    availabilityCache.providerName === provider.name &&
    availabilityCache.expiresAt > now
  ) {
    return availabilityCache.ok;
  }

  try {
    const res = await provider.available();
    availabilityCache = {
      providerName: provider.name,
      ok: res.ok,
      expiresAt: now + 60_000,
    };
    return res.ok;
  } catch {
    availabilityCache = {
      providerName: provider.name,
      ok: false,
      expiresAt: now + 60_000,
    };
    return false;
  }
}
