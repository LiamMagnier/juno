import type { LlmEvent } from "@/types/llm";

/*
 * Turn pipeline — the model streams that are not a provider: the research
 * output contract, an application-authored notice, and the local-only smoke
 * provider. Moved verbatim out of src/app/api/chat/route.ts.
 */

/**
 * What a deep-research turn is asked to produce: a short answer, then a long
 * document.
 *
 * The previous contract said "do not write the report directly in the chat" and
 * nothing else, so the whole turn was one artifact card and the conversation
 * itself said nothing. That is the wrong shape for the medium twice over: a
 * reader who asked a question got no answer in the place they asked it, and the
 * one artifact had to carry both the summary and the depth, so it opened on
 * neither. Every product that does this well — ChatGPT with canvas, Gemini with
 * its report pane, Claude with artifacts — answers in the thread and puts the
 * document beside it.
 *
 * So the contract is now explicitly two-part, and the brief half is specified
 * tightly: models left to "summarise briefly" reliably produce a preamble about
 * what the report contains rather than the finding itself, which is the one
 * thing the reader wanted in the thread.
 */
export const RESEARCH_OUTPUT_CONTRACT = `# How to deliver this research

Produce TWO things, in this order, in a single reply.

## 1. The chat answer (before the artifact)
Answer the question directly, in 100–200 words of flowing prose.
- Lead with the finding itself — never with what the report contains. Do not write "This report examines…", "I researched…", or "Below you will find…".
- State the most important numbers, dates and names inline, with citations [n].
- If the evidence is genuinely contested or thin, say so in one clause rather than implying false confidence.
- No headings, no bullet lists, no title. Plain paragraphs only.
- This must stand on its own: a reader who never opens the report should still have a real answer.

## 2. The full report (the artifact)
Then output the complete, publication-grade report inside ONE artifact block:
<juno:artifact identifier="research-report" type="MARKDOWN" title="<a specific title naming the topic>" language="md">
…the entire report…
</juno:artifact>

The report is the long-form document described above: every section, every table, every citation. Do not abbreviate it because the chat answer already exists, and do not repeat the chat answer's wording as the report's opening — the report begins with its own title and executive summary.
Give the artifact a title naming the actual subject, not the words "Research Report".
Write nothing after the closing tag.`;

/** Application-authored status, persisted through the normal chat protocol. */
export async function* streamResearchNotice(text: string): AsyncGenerator<LlmEvent> {
  yield { type: "text", text };
  yield { type: "finish", reason: "stop" };
}

/**
 * A local-only provider for the authenticated browser gate.
 *
 * The browser suite must prove the real acceptance/persistence/SSE lifecycle
 * without making a release decision depend on a developer API key's quota or
 * billing state. This still runs through the normal chat route, database write,
 * durable receipt, and client stream; only the external model call is replaced.
 * The route enables it only in a non-production process when the test runner
 * opts in explicitly, so it cannot silently become a production fallback.
 */
export async function* streamDeterministicSmokeResponse(prompt: string): AsyncGenerator<LlmEvent> {
  const requestedToken = prompt.match(/\bJUNO_[A-Z0-9_]+\b/g)?.at(-1);
  const answer = requestedToken ?? "JUNO_E2E_SMOKE_OK";
  const midpoint = Math.max(1, Math.floor(answer.length / 2));
  yield { type: "text", text: answer.slice(0, midpoint) };
  await Promise.resolve();
  yield { type: "text", text: answer.slice(midpoint) };
  yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output: answer.length };
  yield { type: "finish", reason: "stop" };
}
