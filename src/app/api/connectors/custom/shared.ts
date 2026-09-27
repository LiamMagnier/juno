import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { isCustomConnectorId } from "@/lib/custom-connectors";

export const urlBody = z.object({ url: z.string().trim().min(1).max(2_000) });

/** Probing reaches out to a stranger's server from ours: keep it bounded. */
export async function probeAllowed(userId: string): Promise<boolean> {
  const limit = await rateLimit({ key: `custom-mcp-probe:${userId}`, limit: 30, windowSec: 3_600 });
  return limit.success;
}

export function tooMany() {
  return NextResponse.json(
    { error: "rate_limited", message: "That's a lot of servers to check. Try again in a little while." },
    { status: 429 }
  );
}

/** The caller's own connector, or null. Unknown and foreign ids look the same. */
export async function ownedConnector(userId: string, rawId: string) {
  const id = decodeURIComponent(rawId);
  if (!isCustomConnectorId(id)) return null;
  return prisma.customConnector.findFirst({ where: { id, userId } });
}

export function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** What the callback needs to finish, kept server-side in an encrypted cookie. */
export interface CustomOAuthSession {
  connectorId: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
}

export const CUSTOM_NONCE_COOKIE = "oauth_nonce_custom_mcp";
export const CUSTOM_SESSION_COOKIE = "oauth_session_custom_mcp";
