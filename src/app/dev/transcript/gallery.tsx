"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { MessageItem } from "@/components/chat/message-item";
import { MessageList } from "@/components/chat/message-list";
import { SharedChatTranscript } from "@/components/share/shared-chat-transcript";
import { Button } from "@/components/ui/button";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ChatMessage } from "@/hooks/use-chat";
import type { AppBootstrap } from "@/types/app";
import type { ClientArtifact } from "@/types/chat";

/* Only what the rendered components read is filled in (see /dev/premium). */
const BOOTSTRAP = {
  user: { id: "dev", name: "Dev", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
    personality: "default",
    customInstructions: "",
    responseLanguage: "auto",
    uiLocale: "en",
    memoryEnabled: true,
    memorySensitiveTopics: [],
    memoryBackgroundLearning: false,
    backgroundProviderMode: "same_provider",
    voiceId: null,
    favoriteModels: [],
    emailBudgetAlerts: false,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: true,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic", "openai", "google"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

const AT = new Date(Date.now() - 60_000).toISOString();
const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: AT, attachments: [], conversationId: "dev-conversation", ...partial };
}

/* ---- Sample content ------------------------------------------------------ */

const PROSE = `The short version: **cache the prefix, not the question.** Prompt caching pays off when the same long context is sent many times, and it costs you when the prefix changes on every call.

### How the pricing works

A cache *write* is billed a little above the normal input rate; every later *read* of that prefix is billed at roughly a tenth. So the break-even is almost immediate:

1. The first call writes the prefix (about 1.25x input).
2. Each call after that reads it (about 0.1x input).
3. By the second hit you are already ahead.

| Scenario | Calls | Without cache | With cache | Saving |
| --- | ---: | ---: | ---: | ---: |
| Support bot, 40k-token handbook | 1,200 | $144.00 | $19.80 | 86% |
| Code review, 12k-token repo map | 90 | $3.24 | $0.61 | 81% |
| One-off question | 1 | $0.12 | $0.15 | -25% |

> A cache only helps a prefix that is byte-for-byte identical. Put the stable material (system prompt, documents, tool definitions) first and the part that changes last.

#### What to check

- The prefix is at least the model's minimum cacheable length.
- Nothing volatile (a timestamp, a request id) sits inside it.
  - Watch for dates in system prompts; they change at midnight.
- You mark the breakpoint after the last stable block.

- [x] Handbook moved above the user turn
- [ ] Timestamp moved out of the system prompt

The expected cost per call is $c = p \\cdot r + (1 - p) \\cdot w$, where $p$ is the hit rate. For the full derivation see [the pricing notes](https://example.com/pricing) or run \`npm run cost:report\`.

---

That is the whole trick. The rest is measuring your hit rate.`;

const CODE_ANSWER = `Here is a small helper that wraps the client and records hit rate per call.

\`\`\`ts title="src/lib/cache-meter.ts"
import { Anthropic } from "@anthropic-ai/sdk";

export interface CacheStats {
  reads: number;
  writes: number;
  /** Share of input tokens served from the cache, 0 to 1. */
  hitRate: number;
}

export async function meteredCall(client: Anthropic, prompt: string): Promise<CacheStats> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const reads = res.usage.cache_read_input_tokens ?? 0;
  const writes = res.usage.cache_creation_input_tokens ?? 0;
  const total = reads + writes + res.usage.input_tokens;
  return { reads, writes, hitRate: total ? reads / total : 0 };
}
\`\`\`

Run it against the handbook twice and compare:

\`\`\`bash
npx tsx scripts/meter.ts --file docs/handbook.md --runs 2
\`\`\`

The same thing in Python, if your worker is there:

\`\`\`py:worker/meter.py
def hit_rate(usage) -> float:
    reads = usage.cache_read_input_tokens or 0
    total = reads + (usage.cache_creation_input_tokens or 0) + usage.input_tokens
    return reads / total if total else 0.0  # a very long trailing comment that runs past the column so the block has to scroll or wrap to be read in full
\`\`\`

And the config it reads:

\`\`\`json
{ "model": "claude-sonnet-4-5", "cache": { "breakpoint": "after-tools", "ttl": "5m" } }
\`\`\``;

const LONG_LINES = Array.from({ length: 64 }, (_, i) =>
  i % 9 === 0
    ? `// ---- section ${i / 9 + 1} ----`
    : i % 9 === 1
      ? `export function step${i}(input: string): string {`
      : i % 9 === 7
        ? `}`
        : i % 9 === 8
          ? ``
          : `  const v${i} = input.slice(${i}, ${i + 8}).trim(); // line ${i + 1}`,
).join("\n");

const DIFF_ANSWER = `The fix is one guard and one moved line:

\`\`\`diff
diff --git a/src/lib/cache-meter.ts b/src/lib/cache-meter.ts
--- a/src/lib/cache-meter.ts
+++ b/src/lib/cache-meter.ts
@@ -14,7 +14,9 @@ export async function meteredCall(client: Anthropic, prompt: string) {
   const reads = res.usage.cache_read_input_tokens ?? 0;
   const writes = res.usage.cache_creation_input_tokens ?? 0;
-  const total = reads + writes + res.usage.input_tokens;
-  return { reads, writes, hitRate: reads / total };
+  const total = reads + writes + res.usage.input_tokens;
+  // A zero-token call (a cancelled request) would divide by zero.
+  if (total === 0) return { reads, writes, hitRate: 0 };
+  return { reads, writes, hitRate: reads / total };
 }
\`\`\`

And the full generated fixture, for reference:

\`\`\`ts title="tests/fixtures/steps.ts"
${LONG_LINES}
\`\`\``;

const REASONING =
  "The user wants to know when prompt caching is worth it. I should give the pricing shape first, then a worked table, then the gotchas: volatile prefixes and the minimum length.";

const CONVERSATION: ChatMessage[] = [
  msg({ id: "u1", role: "USER", content: "When is prompt caching actually worth it? We send a 40k-token handbook with every support question." }),
  msg({
    id: "a1",
    role: "ASSISTANT",
    content: PROSE,
    model: "claude-sonnet-4-5",
    reasoning: REASONING,
    promptTokens: 41_210,
    completionTokens: 612,
    costUsd: 0.0183,
    sources: [
      { title: "Prompt caching", url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching", snippet: "Cache the prefix." },
      { title: "Pricing", url: "https://www.anthropic.com/pricing", snippet: "Cache reads are billed at 10%." },
    ],
    activity: [
      { id: "e1", kind: "reasoning", title: "Thinking", createdAt: at(0) },
      { id: "e2", kind: "search", title: "Searching the web", detail: "prompt caching pricing", createdAt: at(1) },
      { id: "e3", kind: "visit", title: "Reading", url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching", createdAt: at(2) },
      { id: "e4", kind: "visit", title: "Reading", url: "https://www.anthropic.com/pricing", createdAt: at(3) },
      { id: "e5", kind: "write", title: "Writing", createdAt: at(6) },
      { id: "e6", kind: "done", title: "Done", createdAt: at(9) },
    ],
  }),
  msg({
    id: "u2",
    role: "USER",
    content: "Show me how to measure the hit rate in TypeScript.",
    versions: [{ id: "v1", createdAt: AT } as never],
  }),
  msg({
    id: "a2",
    role: "ASSISTANT",
    content: CODE_ANSWER,
    model: "gpt-5",
    promptTokens: 2_104,
    completionTokens: 488,
    costUsd: 0.0061,
    versions: [{ id: "v2", createdAt: AT } as never, { id: "v3", createdAt: AT } as never],
    activity: [
      { id: "t1", kind: "tool", title: "Using GitHub", detail: "search code", createdAt: at(0), tool: { server: "GitHub", name: "github__search_code", args: "{\"q\":\"cache_read_input_tokens\"}", result: "[]" } as never },
      { id: "t2", kind: "tool", title: "Using GitHub", detail: "get file", createdAt: at(2), tool: { server: "GitHub", name: "github__get_file", args: "{\"path\":\"src/lib/client.ts\"}", result: "export const client = …" } as never },
      { id: "t3", kind: "done", title: "Done", createdAt: at(4) },
    ],
  }),
  msg({ id: "u3", role: "USER", content: "There's a divide by zero when a request is cancelled. Fix it?" }),
  msg({
    id: "a3",
    role: "ASSISTANT",
    content: DIFF_ANSWER,
    model: "claude-sonnet-4-5",
    feedback: "UP",
    promptTokens: 3_902,
    completionTokens: 1_240,
    costUsd: 0.0304,
  }),
];

const STATES: Array<{ label: string; m: ChatMessage }> = [
  {
    label: "Failed before any text",
    m: msg({ id: "s1", role: "ASSISTANT", content: "", error: true, errorMessage: "The model provider is overloaded. Try again in a moment." }),
  },
  {
    label: "Stopped at the token limit (Continue)",
    m: msg({
      id: "s2",
      role: "ASSISTANT",
      content: "Here are the first three steps of the migration:\n\n1. Add the column as nullable.\n2. Backfill in batches of 10,000.\n3. Add the NOT NULL constraint once",
      model: "claude-sonnet-4-5",
      finishReason: "length",
    }),
  },
  {
    label: "Interrupted partial answer",
    m: msg({
      id: "s3",
      role: "ASSISTANT",
      content: "The cache key is built from the model, the system prompt and every block up to the breakpoint, so",
      error: true,
      errorMessage: "The connection dropped. The partial answer was kept.",
    }),
  },
  {
    label: "User turn that never sent",
    m: msg({ id: "s4", role: "USER", content: "Can you also check the retry budget?", unsent: true }),
  },
];

/* A reply to replay: prose, a list, a code block, a closing line. */
const STREAM_REPLY = `${PROSE.split("### How the pricing works")[0]}### Measuring it

Log three numbers per call and chart the ratio:

\`\`\`ts
const hitRate = usage.cache_read_input_tokens / (usage.input_tokens + usage.cache_read_input_tokens);
console.log({ hitRate });
\`\`\`

${PROSE.split("#### What to check")[1] ?? ""}`;

const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const NO_ARTIFACT_LIST: ClientArtifact[] = [];
const noop = () => {};

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-transcript-section={id} className="border-t border-border py-10">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-body text-muted-foreground">{note}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-caption text-muted-foreground">{children}</p>;
}

/** Local feedback / speaking state, so the actions answer a click. */
function useTurnState(initial: ChatMessage[]) {
  const [messages, setMessages] = React.useState(initial);
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);
  const onFeedback = React.useCallback((id: string, value: "UP" | "DOWN" | null) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback: value } : m)));
  }, []);
  const onSpeak = React.useCallback((id: string) => setSpeakingId((cur) => (cur === id ? null : id)), []);
  return { messages, setMessages, speakingId, onFeedback, onSpeak };
}

function StreamingDemo() {
  const { messages, setMessages, onFeedback } = useTurnState([
    msg({ id: "su1", role: "USER", content: "Explain prompt caching like I will implement it tomorrow." }),
  ]);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const play = () => {
    if (timer.current) window.clearInterval(timer.current);
    const id = `sa-${Date.now()}`;
    setBusy(true);
    setMessages((prev) => [prev[0], msg({ id, role: "ASSISTANT", content: "", streaming: true, model: "claude-sonnet-4-5" })]);
    let i = 0;
    const started = performance.now();
    timer.current = window.setInterval(() => {
      // Hold on the empty turn for a beat so the live row shows, then stream
      // in word-sized chunks at about the rate a fast model writes.
      if (performance.now() - started < 1400) return;
      i = Math.min(STREAM_REPLY.length, i + 6 + Math.floor(Math.random() * 10));
      const done = i >= STREAM_REPLY.length;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, content: STREAM_REPLY.slice(0, i), streaming: !done, promptTokens: done ? 1840 : null, completionTokens: done ? 702 : null, costUsd: done ? 0.0112 : null }
            : m,
        ),
      );
      if (done) {
        setBusy(false);
        if (timer.current) window.clearInterval(timer.current);
      }
    }, 40);
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Button size="sm" onClick={play} data-testid="stream-play">
          {busy ? "Restart" : "Play reply"}
        </Button>
        <p className="text-caption text-muted-foreground">Scroll up while it streams to detach the follow and see Jump to latest.</p>
      </div>
      <div className="relative flex h-[520px] flex-col overflow-hidden rounded-card border border-border">
        <MessageList
          messages={messages}
          busy={busy}
          status={busy ? "writing" : "idle"}
          artifacts={NO_ARTIFACT_LIST}
          onOpenArtifact={noop}
          onRegenerate={noop}
          onFeedback={onFeedback}
          onSpeak={noop}
          conversationTitle="Streaming demo"
        />
      </div>
    </div>
  );
}

export function TranscriptGallery({ only }: { only?: string }) {
  const convo = useTurnState(CONVERSATION);
  const show = (id: string) => !only || only === id;

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        <div className="page-gutter mx-auto w-full max-w-3xl py-12">
          <h1 className="font-serif text-page-title">Transcript</h1>
          <p className="mt-1 text-body text-muted-foreground">Message actions, code, diffs, tool rows, markdown and streaming on the real components.</p>

          {show("conversation") && (
            <Section id="conversation" title="Conversation" note="A settled thread. The newest answer keeps its actions; older turns show theirs on hover or focus.">
              <div role="log" aria-label="Conversation transcript" className="space-y-6">
                {convo.messages.map((m, i) => (
                  <div key={m.id} data-message-id={m.id}>
                    <MessageItem
                      message={m}
                      isLast={i === convo.messages.length - 1}
                      busy={false}
                      artifactsByIdentifier={NO_ARTIFACTS}
                      onOpenArtifact={noop}
                      onRegenerate={noop}
                      onEdit={noop}
                      onFeedback={convo.onFeedback}
                      onFork={noop}
                      onSpeak={convo.onSpeak}
                      speaking={convo.speakingId === m.id}
                      editOnRequest={m.id === "u3"}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {show("states") && (
            <Section id="states" title="States" note="Failure, a stop at the token limit, an interrupted answer, and a turn that never reached the server.">
              <div className="space-y-10">
                {STATES.map(({ label, m }) => (
                  <div key={m.id}>
                    <Label>{label}</Label>
                    <MessageItem
                      message={m}
                      isLast
                      busy={false}
                      artifactsByIdentifier={NO_ARTIFACTS}
                      onOpenArtifact={noop}
                      onRegenerate={noop}
                      onContinue={noop}
                      onResend={noop}
                      onFeedback={noop}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {show("streaming") && (
            <Section id="streaming" title="Streaming" note="The real MessageList: the live row, text arriving under the tail fade, the follow, and Jump to latest.">
              <StreamingDemo />
            </Section>
          )}

          {show("shared") && (
            <Section id="shared" title="Shared transcript" note="What /share/[token] renders for the same turns.">
              <SharedChatTranscript
                messages={CONVERSATION.slice(0, 4).map((m) => ({ id: m.id, role: m.role as "USER" | "ASSISTANT", content: m.content, model: m.model ?? null, createdAt: m.createdAt }))}
                artifacts={[]}
              />
            </Section>
          )}
        </div>
      </main>
    </AppProvider>
  );
}
