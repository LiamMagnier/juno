import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as domain from "@/lib/agents/domain";
import * as stateLabels from "@/lib/agents/state-labels";

/*
 * What the shared shell and a conversation download before anyone asks for
 * more (package C1, website discovery §6).
 *
 * The shell (sidebar, faces, the sentence beside a face) drew three words
 * from src/lib/agents/domain.ts, whose request schemas build zod objects at
 * the top level: so zod, and the model catalog behind it, rode into every
 * page. And every conversation imported realtime voice (the relay socket, the
 * microphone worklet, playback, the call bar), directly and through the Work
 * thread's voice panel, whether or not voice was ever opened.
 *
 * This walks the STATIC imports from the entry files, the way a bundler puts
 * modules into a page's first chunk: `import type` and type-only specifiers
 * are erased, and a dynamic `import()` is a chunk of its own, loaded later.
 * It is a graph check, not a size measurement: bundle sizes need a production
 * build, which these tests do not run.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(root, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => join(base, `index${ext}`))];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime import specifiers of one file: type-only imports and dynamic import() excluded. */
function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out: string[] = [];
  // The clause never runs into the next statement, so a `type` export above
  // an import cannot swallow it.
  const statement = /(?:^|[;\n])\s*(import|export)\s+((?:(?!\n\s*(?:import|export)\b)[^;])*?)\s*from\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(code))) {
    const clause = match[2].trim();
    if (/^type\b/.test(clause)) continue;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const outside = braces ? clause.replace(braces[0], "").replace(/,/g, "").trim() : clause;
    if (braces && !outside) {
      const names = braces[1].split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length && names.every((name) => /^type\s/.test(name))) continue;
    }
    out.push(match[3]);
  }
  const bare = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  while ((match = bare.exec(code))) out.push(match[1]);
  return out;
}

function staticGraph(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = entries.map((entry) => join(root, entry));
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue;
    for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
      const local = resolveLocal(spec, file);
      if (local) queue.push(local);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  return { files: new Set([...files].map((file) => relative(root, file))), packages };
}

test("the walker reads imports the way a bundler does", () => {
  assert.deepEqual(
    runtimeImports(
      [
        'import { z } from "zod";',
        'import type { A } from "./a";',
        'import { type B, type C } from "./b";',
        'import { type D, e } from "./d";',
        'export { f } from "./f";',
        'export type { G } from "./g";',
        'import "./side.css";',
        'const lazy = () => import("./lazy");',
        '// import { gone } from "./comment";',
      ].join("\n")
    ),
    ["zod", "./d", "./f", "./side.css"]
  );
});

test("zod and the agent request schemas stay out of the shared shell", () => {
  const shell = staticGraph(["src/components/app/app-shell.tsx", "src/components/app/app-provider.tsx"]);
  assert.ok(shell.files.has("src/components/app/app-sidebar.tsx"), "the walk reaches the sidebar");
  assert.ok(shell.files.has("src/lib/agents/state-labels.ts"), "the shell draws the state words from the zod-free module");
  assert.ok(!shell.packages.has("zod"), "zod is in the shell's static graph again");
  assert.ok(!shell.files.has("src/lib/agents/domain.ts"), "agents/domain.ts (zod schemas) is in the shell's static graph again");
});

test("state-labels imports nothing but the brand names, and domain re-exports the same values", () => {
  const source = readFileSync(join(root, "src/lib/agents/state-labels.ts"), "utf8");
  assert.deepEqual(runtimeImports(source), ["@/lib/brand/names"]);
  assert.equal(domain.AGENT_STATE_LABEL, stateLabels.AGENT_STATE_LABEL, "one map, re-exported");
  assert.equal(domain.AGENT_STATES, stateLabels.AGENT_STATES);
  assert.equal(domain.agentStateSentence, stateLabels.agentStateSentence);
  assert.equal(domain.formatAgentWhen, stateLabels.formatAgentWhen);
  for (const file of ["src/components/app/app-sidebar.tsx", "src/components/agents/agent-face.tsx", "src/components/agents/agent-bits.tsx"]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /from "@\/lib\/agents\/domain"/, `${file} imports the zod module`);
  }
});

test("a conversation does not load realtime voice until voice is opened", () => {
  const chat = staticGraph(["src/components/chat/chat-view.tsx"]);
  assert.ok(chat.files.has("src/components/chat/lazy-realtime-voice.tsx"));
  for (const heavy of [
    "src/hooks/use-realtime-voice.ts",
    "src/components/voice/realtime-voice.tsx",
    "src/components/chat/voice-engine.tsx",
    "src/components/work/voice/work-voice-panel.tsx",
    "src/components/work/work-conversation.tsx",
  ]) {
    assert.ok(!chat.files.has(heavy), `${heavy} is in a conversation's static graph`);
  }
  // It arrives with the engine, loaded on demand.
  assert.match(readFileSync(join(root, "src/components/chat/lazy-realtime-voice.tsx"), "utf8"), /import\("@\/components\/chat\/voice-engine"\)/);
  // The run panel reads the thread's turns from the React-free module.
  assert.match(readFileSync(join(root, "src/components/chat/work-run-panel.tsx"), "utf8"), /import \{ deriveTurns \} from "@\/components\/work\/work-turns";/);
});

test("the voice engine still wakes audio inside the click that opened it", () => {
  const view = readFileSync(join(root, "src/components/chat/chat-view.tsx"), "utf8");
  // Wake the shared AudioContext before waiting for the chunk (Safari).
  assert.match(view, /getAudioContext\(\);\s+setVoiceOpen\(true\);/);
  // A chunk that cannot load closes voice and says so.
  assert.match(view, /toast\.error\("Voice couldn’t load\. Check your connection and try again\."\)/);
  // Closed, or a new chat, while it loaded: nothing starts.
  assert.match(view, /if \(voiceSessionIdRef\.current !== sessionId \|\| !voiceOpenRef\.current\) return;/);
});
