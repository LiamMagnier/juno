/**
 * Schema migrations for persisted design documents.
 *
 * A document is stored as the JSON body of an artifact version, so an old
 * document outlives the code that wrote it by exactly as long as the user keeps
 * the artifact. Migrations run on read, are ordered, and are recorded: after
 * `migrateDesignDocument` the document's `migratedFrom` lists every version it
 * has passed through, so a later reader can tell an original v3 document from
 * one that started life as a v1.
 *
 * Rules for adding one:
 *  - Never mutate the input. Return a new object.
 *  - Never drop a field a later version might still want; add, widen, default.
 *  - A migration must be total: it takes whatever the previous version allowed
 *    and produces something the *next* schema accepts, with no I/O and no
 *    randomness (documents migrate identically on the Mac and in the browser).
 */

import { DESIGN_SCHEMA_VERSION, type DesignDocument } from "@/lib/design/types";
import { DesignValidationError, parseDesignDocument } from "@/lib/design/schema";

type RawDocument = Record<string, unknown>;

/** One step: `from` → `from + 1`. */
interface Migration {
  from: number;
  describe: string;
  up: (doc: RawDocument) => RawDocument;
}

/**
 * The migration table.
 *
 * Empty at v1 by construction — v1 is the first shipped version, so nothing
 * predates it. The machinery exists now rather than later because a migration
 * added after documents are in the wild has no way to reach the ones already
 * written by a build that did not record `migratedFrom`.
 */
const MIGRATIONS: Migration[] = [];

export function latestSchemaVersion(): number {
  return DESIGN_SCHEMA_VERSION;
}

/** Version stamped on a raw document, or 0 when it is not a document at all. */
export function readSchemaVersion(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const version = (raw as RawDocument).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version > 0 ? version : 0;
}

/**
 * Migrate a raw document up to the current schema version and validate it.
 *
 * Throws `DesignValidationError` for a document that is not one, for a version
 * newer than this build understands (a Mac on an older release must say so
 * rather than silently discard the fields it cannot see), and for anything that
 * fails validation after migrating.
 */
export function migrateDesignDocument(raw: unknown): DesignDocument {
  const version = readSchemaVersion(raw);
  if (version === 0) {
    throw new DesignValidationError("Not a design document (no schemaVersion)");
  }
  if (version > DESIGN_SCHEMA_VERSION) {
    throw new DesignValidationError(
      `This document was written by a newer version of Juno (schema v${version}; this build understands v${DESIGN_SCHEMA_VERSION}).`
    );
  }

  let current = { ...(raw as RawDocument) };
  const passed: number[] = Array.isArray(current.migratedFrom)
    ? (current.migratedFrom as unknown[]).filter((v): v is number => typeof v === "number")
    : [];

  for (let v = version; v < DESIGN_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) {
      throw new DesignValidationError(`No migration from design schema v${v} to v${v + 1}`);
    }
    current = step.up(current);
    passed.push(v);
    current.schemaVersion = v + 1;
  }

  current.migratedFrom = passed;
  return parseDesignDocument(current);
}

/** Parse a stored artifact body (a JSON string) into a validated document. */
export function parseStoredDesignDocument(content: string): DesignDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new DesignValidationError("Design document is not valid JSON");
  }
  return migrateDesignDocument(raw);
}

/**
 * Serialize for storage with stable key order at every depth.
 *
 * Not `JSON.stringify(doc)`: object key order in JavaScript follows insertion,
 * so the same document reached by two different edit paths would serialize to
 * two different strings — and every one of those is a new artifact version and
 * a diff in the history panel that shows nothing changed. (A replacer *array*
 * cannot do this job either: it filters keys at every level, so it would delete
 * every nested field whose name is not a top-level one.)
 */
export function serializeDesignDocument(doc: DesignDocument): string {
  return JSON.stringify(stableize(doc));
}

function stableize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stableize(source[key]);
    return out;
  }
  return value;
}
