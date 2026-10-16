/** Keep the resource filter when editing a stream; never mutate the saved draft. */
export function withConnectorEventStream(attributes: unknown, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    for (const [key, item] of Object.entries(attributes)) if (typeof item === "string") out[key] = item;
  }
  const stream = value.trim();
  if (stream) out.stream = stream;
  else delete out.stream;
  return out;
}
