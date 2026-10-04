import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The chat turn's source, for structural tests.
 *
 * POST /api/chat was one 4,587-line file and many tests pinned invariants by
 * reading it (a guard sits around a call, a write is sealed, a tool rides one
 * gate). The route is now an orchestrator over src/lib/chat/turn/
 * (docs/rework/program/ORCHESTRATION.md), so those invariants are read from
 * the whole pipeline: the route followed by every stage module, in a stable
 * order. A test that needs one stage reads that module with `turnModule`.
 */

const ROOT = new URL("..", import.meta.url).pathname;
export const CHAT_ROUTE_PATH = "src/app/api/chat/route.ts";
export const CHAT_TURN_DIR = "src/lib/chat/turn";

/** The files the chat turn's code lives in: the route, then each stage module. */
export function chatTurnFiles(): string[] {
  const stages = readdirSync(join(ROOT, CHAT_TURN_DIR))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `${CHAT_TURN_DIR}/${name}`);
  return [CHAT_ROUTE_PATH, ...stages];
}

/** The route and every stage module, concatenated. */
export function chatTurnSource(): string {
  return chatTurnFiles()
    .map((path) => readFileSync(join(ROOT, path), "utf8"))
    .join("\n");
}

/** One stage module's source, e.g. `turnModule("private-turn")`. */
export function turnModule(name: string): string {
  return readFileSync(join(ROOT, CHAT_TURN_DIR, `${name}.ts`), "utf8");
}
