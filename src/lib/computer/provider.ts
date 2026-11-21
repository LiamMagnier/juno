import "server-only";
import { env } from "@/lib/env";
import { dockerComputerProvider } from "./docker";
import { fakeComputerProvider } from "./fake";
import { remoteComputerProvider } from "./remote";
import type { ComputerProvider } from "./types";

let availabilityCache: {
  providerName: string;
  ok: boolean;
  expiresAt: number;
} | null = null;

let availabilityRequest: { provider: ComputerProvider; result: Promise<boolean> } | null = null;

export function resetComputerProviderCache(): void {
  availabilityCache = null;
  availabilityRequest = null;
}

export function computerProvider(): ComputerProvider | null {
  const mode = env.agentComputer.provider.toLowerCase();
  if (mode === "docker") {
    return dockerComputerProvider;
  }
  if (mode === "remote") {
    // A separate computer host (deploy/computer-host/). Null, logged once,
    // when its URL is not https (or loopback http outside production) or its
    // token is not in the generator's format.
    return remoteComputerProvider();
  }
  if (mode === "fake") {
    if (process.env.NODE_ENV === "production") {
      return null;
    }
    return fakeComputerProvider;
  }
  return null;
}

export async function isAgentComputerConfigured(): Promise<boolean> {
  const provider = computerProvider();
  if (!provider) {
    resetComputerProviderCache();
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

  if (availabilityRequest?.provider === provider) return availabilityRequest.result;

  const result = Promise.resolve().then(() => provider.available()).then(
    (response) => response.ok,
    () => false,
  ).then((ok) => {
    if (availabilityRequest?.result === result) {
      availabilityCache = { providerName: provider.name, ok, expiresAt: Date.now() + 60_000 };
      availabilityRequest = null;
    }
    return ok;
  });
  availabilityRequest = { provider, result };
  return result;
}
