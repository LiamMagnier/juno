# Research workspace redesign

The `/research` workspace exposes the existing durable engine: brief → editable
plan → investigation → evidence review → cited report. `/research/[id]` is a
stable, authenticated reader. Sidebar history remains available after navigation
and reload. The in-chat research toggle is retained for compatibility; the
composer menu also links to the plan-first workspace.

## Product research

Reviewed official product and engineering documentation in September 2026:

- [ChatGPT Deep Research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt): editable plans, source choice, live progress and steering.
- [Claude's research architecture](https://www.anthropic.com/engineering/multi-agent-research-system): bounded independent investigations, iterative exploration, synthesis and citation checking.
- [Perplexity research](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work.html): iterative searches and a report-first result.

Juno preserves its provider-neutral, budget-checked engine rather than pretending
to embed these proprietary products. Research depth and preferred source URLs now
reach the planner, not just the subsequent fetch stages. Preferred URLs are not
an allowlist: the UI explicitly says public-web search can use other sources.
Private apps and connected files are not advertised as research sources.

## Design and behavior

Warm paper, serif questions and report headings, sentence-case UI, restrained
terracotta, flat source lists, quiet rules. The four-stage track reflects persisted
state, never a guessed percentage. Failed/cancelled runs do not get success ticks.
Details are divided into Overview, Sources, Activity and Evidence. Only short
arrival transitions animate; reduced-motion users receive no entrance animation.

The new brief offers Focused, Balanced and Thorough depth, constraints, and up to
24 preferred URLs. Shared request validation runs before submission. Expensive
investigation waits for plan confirmation. Pause/resume, cancellation and steering
use existing authenticated control endpoints. Linked conversations are checked
against the owner before a research run is created.

The report reader adds mobile contents navigation, scoped heading IDs, and
scrollspy relative to its actual scroll container. Copying a page link is labelled
as requiring sign-in; it is not public sharing. Source snapshots are labelled
"read sources", not a promise that an entire page was read or fact-verified.

Existing backend tests cover plan gating, modified queries, budgets, cancellation,
resumption, source gathering, citations and worker recovery. A new regression
test ensures effort, constraints and preferred URLs reach the planning function.
Live paid research requires configured provider/search credentials; mocked UI
checks must not be described as live inference validation.
