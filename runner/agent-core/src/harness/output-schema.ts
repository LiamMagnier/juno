/**
 * Structured output for child agents: the JSON-Schema subset a child's final
 * answer is checked against (`spawn_agent` `output_schema`, workflow
 * `agent(prompt, {schema})`). Small on purpose — object/array/string/number/
 * integer/boolean/null, `properties`, `required`, `items`, `enum`,
 * `additionalProperties: false` — which is what models are asked to produce.
 */

export type JsonSchema = Record<string, unknown>;

/** Every violation, as "path: problem". Empty means valid. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, at = '$'): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const types = Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${at}: expected ${types.join(' or ')}, got ${describe(value)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${at}.${key}: is required`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) errors.push(...validateAgainstSchema(record[key], child, `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${at}.${key}: is not allowed`);
      }
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${at}[${index}]`)));
  }
  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The JSON value in a model's final message: the whole text, a fenced block,
 * or the outermost {...} / [...] span. Undefined when none parses.
 */
export function extractJson(text: string): unknown {
  const candidates: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (let match = fence.exec(text); match; match = fence.exec(text)) candidates.push(match[1]!.trim());
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // next candidate
    }
  }
  return undefined;
}

/** Whether `schema` is in the supported subset; the problem otherwise. */
export function schemaProblem(schema: unknown): string | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return 'the schema must be a JSON object';
  try {
    JSON.stringify(schema);
  } catch {
    return 'the schema must be plain JSON';
  }
  return null;
}
