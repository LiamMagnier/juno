/*
 * Model-facing text for the OpenAI-compatible loop. English, and in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29,
 * SPEC §10.5).
 */

/**
 * The instruction that goes with `response_format: { type: "json_object" }`
 * (SPEC §5.0 `responseSchema`). JSON mode only promises valid JSON, not the
 * shape, and several hosts refuse it unless the conversation says "JSON", so
 * the schema itself is stated.
 */
export function structuredOutputNote(name: string, schemaJson: string): string {
  return `Reply with one JSON object and nothing else: no prose and no code fence. The object is "${name}" and must match this JSON Schema:\n${schemaJson}`;
}
