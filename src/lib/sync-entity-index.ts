export const DEFAULT_ENTITY_INDEX_LIMIT = 200;
export const MAX_ENTITY_INDEX_LIMIT = 500;

export class EntityIndexInputError extends Error {
  constructor(public readonly field: "cursor" | "limit") {
    super(`invalid entity index ${field}`);
    this.name = "EntityIndexInputError";
  }
}

export type EntityIndexCursor = {
  type: string;
  id: string;
};

export function parseEntityIndexLimit(value: string | null): number {
  if (value == null) return DEFAULT_ENTITY_INDEX_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new EntityIndexInputError("limit");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_ENTITY_INDEX_LIMIT) {
    throw new EntityIndexInputError("limit");
  }
  return limit;
}

export function encodeEntityIndexCursor(cursor: EntityIndexCursor): string {
  return Buffer.from(JSON.stringify([cursor.type, cursor.id]), "utf8").toString("base64url");
}

export function parseEntityIndexCursor(value: string | null): EntityIndexCursor | null {
  if (value == null || value === "") return null;
  if (value.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EntityIndexInputError("cursor");
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== "string"
      || typeof decoded[1] !== "string"
      || decoded[0].length === 0
      || decoded[0].length > 100
      || decoded[1].length === 0
      || decoded[1].length > 200
    ) {
      throw new Error("invalid cursor payload");
    }
    return { type: decoded[0], id: decoded[1] };
  } catch {
    throw new EntityIndexInputError("cursor");
  }
}
