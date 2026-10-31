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
 * The route enables it only when the test runner opts in explicitly, and in a
 * production process only under the QA runner against its disposable database
 * (smoke-provider-gate.ts), so it cannot silently become a production fallback.
 *
 * What it answers is chosen by directives in the prompt, so a journey spec can
 * drive each lifecycle through the real pipeline:
 *
 *   JUNO_E2E_SLOW_STREAM  streams SMOKE_SLOW_START, then a word every
 *                         SMOKE_SLOW_INTERVAL_MS for up to SMOKE_SLOW_TOTAL_MS,
 *                         then SMOKE_SLOW_END. It listens to `signal`, so Stop
 *                         (the cancel endpoint aborting the generation) ends it
 *                         mid-stream the way it ends a provider's: an
 *                         AbortError the turn records as user_stopped, with the
 *                         partial answer kept.
 *   JUNO_E2E_ARTIFACT     answers SMOKE_ARTIFACT_TOKEN and one closed markdown
 *                         artifact (SMOKE_ARTIFACT_TITLE, body
 *                         SMOKE_ARTIFACT_BODY), so the artifact parse, verify,
 *                         persist and canvas path runs for real.
 *   JUNO_E2E_SOURCES      answers SMOKE_SOURCES_TOKEN and reports SMOKE_SOURCES
 *                         as provider-search sources, so the stored sources
 *                         and the answer's Sources control render for real.
 *   otherwise             echoes the last JUNO_* token in the prompt (or
 *                         JUNO_E2E_SMOKE_OK) in two chunks — the long-standing
 *                         behaviour chat.spec.ts and regenerate.spec.ts rely on.
 */
export const SMOKE_SLOW_DIRECTIVE = "JUNO_E2E_SLOW_STREAM";
export const SMOKE_SLOW_START = "JUNO_E2E_STREAM_STARTED";
export const SMOKE_SLOW_END = "JUNO_E2E_STREAM_FINISHED";
export const SMOKE_SLOW_INTERVAL_MS = 150;
export const SMOKE_SLOW_TOTAL_MS = 45_000;
export const SMOKE_ARTIFACT_DIRECTIVE = "JUNO_E2E_ARTIFACT";
export const SMOKE_ARTIFACT_TOKEN = "JUNO_E2E_ARTIFACT_OK";
export const SMOKE_ARTIFACT_TITLE = "E2E smoke note";
export const SMOKE_ARTIFACT_BODY = "JUNO_E2E_ARTIFACT_BODY";
export const SMOKE_SOURCES_DIRECTIVE = "JUNO_E2E_SOURCES";
export const SMOKE_SOURCES_TOKEN = "JUNO_E2E_SOURCES_OK";
/** Two fixed, well-known pages; nothing fetches them. */
export const SMOKE_SOURCES: ReadonlyArray<{ title: string; url: string; snippet: string }> = [
  { title: "Example Domain", url: "https://example.com/", snippet: "This domain is for use in documentation examples." },
  { title: "IANA example domains", url: "https://www.iana.org/help/example-domains", snippet: "Reserved for use in documentation." },
];

function smokeAbortError(): Error {
  const error = new Error("The smoke stream was stopped (aborted).");
  error.name = "AbortError";
  return error;
}

/** Waits `ms`, or rejects with an AbortError as soon as `signal` aborts. */
function smokePause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(smokeAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(smokeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* streamDeterministicSmokeResponse(
  prompt: string,
  signal?: AbortSignal,
  timing: { intervalMs?: number; totalMs?: number } = {}
): AsyncGenerator<LlmEvent> {
  if (prompt.includes(SMOKE_SLOW_DIRECTIVE)) {
    const interval = timing.intervalMs ?? SMOKE_SLOW_INTERVAL_MS;
    const words = Math.max(1, Math.floor((timing.totalMs ?? SMOKE_SLOW_TOTAL_MS) / interval));
    let output = 0;
    const emit = (text: string): LlmEvent => {
      output += text.length;
      return { type: "text", text };
    };
    yield emit(`${SMOKE_SLOW_START} `);
    for (let i = 1; i <= words; i += 1) {
      await smokePause(interval, signal);
      yield emit(`word${i} `);
    }
    yield emit(SMOKE_SLOW_END);
    yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output };
    yield { type: "finish", reason: "stop" };
    return;
  }

  if (prompt.includes(SMOKE_ARTIFACT_DIRECTIVE)) {
    const answer =
      `Here is the note you asked for. ${SMOKE_ARTIFACT_TOKEN}\n\n` +
      `<juno:artifact identifier="e2e-smoke-note" type="markdown" title="${SMOKE_ARTIFACT_TITLE}">\n` +
      `# ${SMOKE_ARTIFACT_TITLE}\n\n${SMOKE_ARTIFACT_BODY}: written by the deterministic smoke provider.\n` +
      `</juno:artifact>`;
    const midpoint = Math.floor(answer.length / 2);
    yield { type: "text", text: answer.slice(0, midpoint) };
    await Promise.resolve();
    yield { type: "text", text: answer.slice(midpoint) };
    yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output: answer.length };
    yield { type: "finish", reason: "stop" };
    return;
  }

  if (prompt.includes(SMOKE_SOURCES_DIRECTIVE)) {
    const answer = `Two pages describe the reserved example domains. ${SMOKE_SOURCES_TOKEN}`;
    yield { type: "text", text: answer };
    yield { type: "sources", sources: SMOKE_SOURCES.map((source) => ({ ...source })), origin: "provider_search" };
    yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output: answer.length };
    yield { type: "finish", reason: "stop" };
    return;
  }

  const requestedToken = prompt.match(/\bJUNO_[A-Z0-9_]+\b/g)?.at(-1);
  const answer = requestedToken ?? "JUNO_E2E_SMOKE_OK";
  const midpoint = Math.max(1, Math.floor(answer.length / 2));
  yield { type: "text", text: answer.slice(0, midpoint) };
  await Promise.resolve();
  yield { type: "text", text: answer.slice(midpoint) };
  yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output: answer.length };
  yield { type: "finish", reason: "stop" };
}
