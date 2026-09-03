"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import {
  AicssCodeBlock,
  CitationFooter,
  FileDiff,
  ImageGenerationCanvas,
  ThinkingReasoning,
  ThinkingState,
  TodoList,
  WebSearchBlock,
  parseUnifiedDiff,
  type TodoItem,
  type WebSearchSite,
} from "@/components/aicss";
import { Button } from "@/components/ui/button";
import type { ClientSource } from "@/types/chat";

const REASONING_LINES = [
  "Reading the request and the current selection, then locating the jwt.verify call inside the auth middleware.",
  "The verify call sets no algorithms allowlist, so a token signed with 'none' or a weak cipher could be accepted.",
  "Tracing where the signing secret is loaded from and confirming it is never logged or sent back to the client.",
  "Planning to pin the algorithm to HS256 and to validate the issuer and audience claims on every incoming request.",
  "Scanning the existing tests around the middleware so the fix stays covered and nothing downstream regresses.",
  "Drafting the patch with a focused regression test that rejects tampered, expired, and unsigned tokens.",
];

const SITES: WebSearchSite[] = [
  { title: "JWT verification best practices", label: "auth0.com/blog/jwt-security-best-practices", url: "https://auth0.com/blog/jwt-security-best-practices", state: "done" },
  { title: "Node.js authentication security guide", label: "owasp.org/www-project-nodejs-goat", url: "https://owasp.org/www-project-nodejs-goat", state: "loading" },
  { title: "JWT attacks · Web Security Academy", label: "portswigger.net/web-security/jwt", url: "https://portswigger.net/web-security/jwt", state: "pending" },
];

const PATCH = `@@ -12,3 +12,5 @@
 export function getToken() {
-  return localStorage.token;
+  const t = cookies.get("session");
+  if (!t) throw new Error("no session");
+  return t;
 }`;

const CODE = `export const sum = (a: number, b: number) =>
  a + b;

export const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);`;

const SOURCES: ClientSource[] = [
  { title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", snippet: "" },
  { title: "Efficient Transformers: A Survey", url: "https://arxiv.org/abs/2009.06732", snippet: "" },
];

const TODO_LABELS = [
  "Scaffold the project structure",
  "Build the component registry",
  "Implement entitlement gating",
  "Wire up Stripe checkout",
  "Polish the landing page",
];

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-sans text-heading text-foreground">{title}</h2>
        {note && <p className="mt-0.5 max-w-2xl text-body text-muted-foreground">{note}</p>}
      </div>
      <div className="flex flex-col gap-5 rounded-card border border-border/55 bg-card/60 p-5">{children}</div>
    </section>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-micro uppercase tracking-wide text-muted-foreground/60">{children}</p>;
}

export function AicssGallery() {
  const { resolvedTheme, setTheme } = useTheme();

  // A revealed count, so the thinking viewport can be watched growing into its
  // cap and then scrolling — the state a static gallery otherwise cannot show.
  const [revealed, setRevealed] = React.useState(REASONING_LINES.length);
  const [streaming, setStreaming] = React.useState(true);

  // The to-do list walks itself, because the interesting part is the pie, the
  // rolling count and the label handing off between three states.
  const [current, setCurrent] = React.useState(2);
  const todos = React.useMemo<TodoItem[]>(
    () =>
      TODO_LABELS.map((label, i) => ({
        id: String(i),
        label,
        state: i < current ? "done" : i === current ? "active" : "pending",
      })),
    [current],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-sans text-display text-foreground">AIcss blocks</h1>
          <p className="mt-1 max-w-2xl text-body text-muted-foreground">
            Ported from aicss.dev onto Juno&apos;s tokens. Geometry and easing are theirs; every colour is a
            token and dark mode is <code className="font-mono text-caption">.dark</code>, not the OS preference.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? "Light" : "Dark"}
        </Button>
      </header>

      <Section title="Thinking State" note="The shimmer, live and settled. Same node, same box — it stops rather than changing colour.">
        <div className="flex flex-col gap-2">
          <ThinkingState />
          <ThinkingState>Thinking about your request · 4s</ThinkingState>
          <ThinkingState settled>Thought for 8.4s</ThinkingState>
          <ThinkingState tone="strong">Generating image</ThinkingState>
        </div>
      </Section>

      <Section
        title="Thinking + Reasoning"
        note="Fixed 40px slots, two lines each, capped at 180px and then masked. The reveal below is a control, not the component's behaviour — in the app the lines are whatever the provider has sent."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setRevealed((n) => Math.max(0, n - 1))}>
            −
          </Button>
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {revealed}/{REASONING_LINES.length}
          </span>
          <Button variant="outline" size="sm" onClick={() => setRevealed((n) => Math.min(REASONING_LINES.length, n + 1))}>
            +
          </Button>
          <Button variant="outline" size="sm" onClick={() => setStreaming((v) => !v)}>
            {streaming ? "Settle" : "Go live"}
          </Button>
        </div>
        <div>
          <Caption>With header — the panel&apos;s resting form</Caption>
          <ThinkingReasoning lines={REASONING_LINES.slice(0, revealed)} streaming={streaming} duration="5.0s" />
        </div>
        <div>
          <Caption>Headless — the transcript&apos;s live form, under the strip</Caption>
          <ThinkingReasoning lines={REASONING_LINES.slice(0, revealed)} streaming showHeader={false} />
        </div>
      </Section>

      <Section
        title="Image Generation"
        note="Two masked ellipses drifting a point lattice, then the label. No frame, no footer, no clock — see the note at the top of generation-placeholder.tsx for what each of those was getting wrong."
      >
        <div className="flex flex-wrap items-start gap-8">
          <div>
            <Caption>AIcss reference — 208px, 11px pitch</Caption>
            <div className="w-52">
              <ImageGenerationCanvas resolution="1024 × 1024" className="aspect-square w-full" />
              <div className="mt-2.5 flex flex-col gap-0.5">
                <ThinkingState tone="strong" className="text-[0.875rem]">
                  Generating image
                </ThinkingState>
                <span className="text-body text-muted-foreground">“a calm mountain lake at dawn”</span>
              </div>
            </div>
          </div>
          <div>
            <Caption>In chat — 288px, 14px pitch</Caption>
            <div className="w-[288px]">
              <ImageGenerationCanvas pitch={14} className="aspect-square w-full" />
              <div className="mt-2.5">
                <ThinkingState tone="strong" className="text-[0.875rem]">
                  Creating image
                </ThinkingState>
              </div>
            </div>
          </div>
          <div>
            <Caption>Video — 16:9</Caption>
            <div className="w-[288px]">
              <div className="relative aspect-video overflow-hidden rounded-field">
                <ImageGenerationCanvas className="absolute inset-0" pitch={14} />
                <div className="generation-media__play">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="generation-media__play-icon">
                    <path d="M9 7.5v9l7.5-4.5L9 7.5z" />
                  </svg>
                </div>
              </div>
              <div className="mt-2.5 flex flex-col gap-0.5">
                <ThinkingState tone="strong" className="text-[0.875rem]">
                  Creating video
                </ThinkingState>
                <span className="text-body text-muted-foreground">Longer clips can take a couple of minutes.</span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Web Search"
        note="All three row states. In chat every row is `done`, because a visit event only exists once a source has been read — pending and fetching are states this app cannot observe."
      >
        <WebSearchBlock query="JWT auth vulnerabilities and middleware security best practices" sites={SITES} />
        <div>
          <Caption>Settled</Caption>
          <WebSearchBlock query="JWT auth vulnerabilities" sites={SITES.map((s) => ({ ...s, state: "done" }))} settled />
        </div>
        <div>
          <Caption>No query — provider-tool search, rows only</Caption>
          <WebSearchBlock sites={SITES.map((s) => ({ ...s, state: "done" }))} settled />
        </div>
      </Section>

      <Section title="Code Block" note="One <code> per line for an un-selectable gutter. In chat, rehype-highlight's tokens are cut at the newlines rather than re-highlighted.">
        <AicssCodeBlock label="utils.ts" code={CODE} />
      </Section>

      <Section title="File Diff" note="Two number columns and a sign column. The accent bar carries the sign a second time — solid for an addition, hatched for a deletion.">
        <FileDiff file="src/auth.ts" rows={parseUnifiedDiff(PATCH)} />
      </Section>

      <Section title="To-do List" note="The header glyph is the status: list, then determinate pie, then filled check — and a chevron on hover, because folding is the only thing you can do with it.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCurrent((n) => Math.max(0, n - 1))}>
            −
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCurrent((n) => Math.min(TODO_LABELS.length, n + 1))}>
            +
          </Button>
        </div>
        <TodoList items={todos} />
      </Section>

      <Section title="Inline Citations" note="The footer only. The inline [n] stays Juno's SourceChip, which carries the source's own favicon — a logo identifies a site faster than an ordinal.">
        <div>
          <p className="text-body text-foreground">
            Transformers scale well with data and compute, though attention is quadratic in sequence length.
          </p>
          <CitationFooter sources={SOURCES} />
        </div>
      </Section>

      <Section
        title="Streaming Text"
        note="The caret only — Juno has real tokens, so AIcss's typewriter would replay something already on screen. It is a ::after on the last paragraph, not an element: a cursor has to sit in the text run or it drifts away from the last word on every rewrap."
      >
        <div className="prose-juno" data-streaming="true">
          <p>Generating your release notes</p>
        </div>
        <div>
          <Caption>Settled — no caret</Caption>
          <div className="prose-juno">
            <p>Generated your release notes.</p>
          </div>
        </div>
      </Section>
    </div>
  );
}
