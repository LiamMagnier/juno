# September 2026 model refresh

Verified against provider documentation on September 6, 2026. Exact provider IDs
are curated; predecessor IDs remain selectable as legacy entries.

| Model | Provider ID | Context | Input / output per million tokens |
| --- | --- | --- | --- |
| Claude Fable 5.1 | claude-fable-5-1 | 1,000,000 | $10 / $50 |
| Gemini 3.8 Flash | gemini-3.8-flash | 1,048,576 | $0.75 / $3.75 |
| Grok 4.6 | grok-4.6 | 500,000 | $2 / $6 |

Fable 5.1 uses adaptive reasoning, defaults to high, and supports low through max.
Its cache-read price is $0.25 per million tokens; older Fable cache pricing is
unchanged. Existing Anthropic transport already supplies adaptive thinking and
preserves thinking blocks during tool loops.

Gemini 3.8 uses low, medium, or high thinking, defaulting to medium. Gemini
3.6–3.8 Flash promotional pricing lasts through December 31, 2026; recheck rates
before January 1 ($1.50 / $7.50 announced). Cache reads are 10% of input pricing.
Grok 4.6 supports low, medium, high and xhigh, defaulting to high; 4.5 retains its
three-level ladder. GPT-6 Astra was already curated. Restricted Mythos access is
not advertised as general availability.

Sources:
- https://platform.claude.com/docs/en/models/fable-5-1/overview
- https://platform.claude.com/docs/en/models/fable-5-1/migration-guide
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- https://ai.google.dev/gemini-api/docs/pricing
- https://docs.x.ai/developers/models/grok-4.6
- https://docs.x.ai/developers/model-capabilities/text/reasoning

Live provider inference requires deployment credentials and was not exercised in
this change. Documentation verification does not imply every provider account
has access.
