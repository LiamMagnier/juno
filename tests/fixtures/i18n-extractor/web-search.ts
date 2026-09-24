// Fixture for tests/i18n-extractor-skip.test.ts: a tool spec. Its title,
// description and parameter docs are model-facing and must never reach the
// UI catalog.
declare function defineTool<T>(spec: T): T;

export const webSearchSpec = defineTool({
  id: "web_search",
  title: "Web search fixture title",
  description: "Search the web for fresh facts. Use it when the answer depends on recent events.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The query, in the user's language." },
    },
  },
});

export const nested = {
  spec: defineTool({ title: "Nested tool fixture title", description: "A nested model-facing description." }),
};
