/**
 * Which device-link hub the routes use (docs/code-v2/DEVICE-LINK.md).
 *
 * - `ALEVR_LINK_STORE=postgres`: the Postgres store (env-link-store-pg.ts), for
 *   a backend that runs more than one process. Needs the CodeLink* tables
 *   (migration 20261009120000_code_v2_link_hub).
 * - otherwise (the default, and what one pm2 fork process needs): the
 *   in-memory hub.
 *
 * The routes and the Mac's protocol are the same either way.
 */
import { prisma } from "@/lib/prisma";
import { envLinkHub, type LinkHub } from "./env-link-hub";
import { PgLinkHub, type LinkSql } from "./env-link-store-pg";

const KEY = Symbol.for("alevr.code-v2.link-hub.pg");

export function linkStoreKind(env: NodeJS.ProcessEnv = process.env): "postgres" | "memory" {
  return env.ALEVR_LINK_STORE === "postgres" ? "postgres" : "memory";
}

export function linkHub(env: NodeJS.ProcessEnv = process.env): LinkHub {
  if (linkStoreKind(env) === "memory") return envLinkHub();
  const g = globalThis as unknown as Record<symbol, LinkHub | undefined>;
  g[KEY] ??= new PgLinkHub(prisma as unknown as LinkSql);
  return g[KEY]!;
}
