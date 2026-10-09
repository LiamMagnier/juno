"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { Play } from "@/components/ui/icons";
import { runTargetFor } from "@/lib/exec/snippet-languages";

/**
 * Run a code block where it stands (owner, 2026-10-09: "we should be able to
 * run it live and see what it does", "every language").
 *
 * JavaScript, TypeScript, Python and SQL run in the reader's browser, in the
 * same isolated frame the canvas uses (no server, no cost); SQL runs on SQLite
 * against a sample of Oracle's HR schema. Every other language the server knows
 * (C, C++, Java, Go, Rust, Ruby, PHP, Lua, Perl, Bash) goes to the hosted
 * sandbox through /api/code/run, the path the model's run_code takes.
 */

export { runTargetFor };

/**
 * Whether the server has the sandbox, asked once per page and shared. Until it
 * answers (or if it cannot), sandbox languages show no Run: a button that can
 * only fail is worse than none.
 */
let sandboxAnswer: Promise<boolean> | null = null;
function serverSandbox(): Promise<boolean> {
  sandboxAnswer ??= fetch("/api/code/run", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ sandbox?: boolean }>) : { sandbox: false }))
    .then((body) => body.sandbox === true)
    .catch(() => false);
  return sandboxAnswer;
}

export function useCodeRun(lang: string) {
  const candidate = React.useMemo(() => runTargetFor(lang), [lang]);
  const [sandbox, setSandbox] = React.useState(false);
  const needsServer = candidate?.where === "server";
  React.useEffect(() => {
    if (!needsServer) return;
    let live = true;
    void serverSandbox().then((ok) => {
      if (live) setSandbox(ok);
    });
    return () => {
      live = false;
    };
  }, [needsServer]);
  const target = candidate && (candidate.where === "browser" || sandbox) ? candidate : null;
  const [open, setOpen] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const run = React.useCallback(() => {
    setOpen(true);
    setNonce((n) => n + 1);
  }, []);
  return { target, open, nonce, run, close: () => setOpen(false) };
}

export function CodeRunButton({ label, onRun }: { label: string; onRun: () => void }) {
  return (
    <button
      type="button"
      onClick={onRun}
      aria-label={`Run ${label}`}
      title={`Run ${label}`}
      className="aicss-cb-copy pressable motion-reduce:active:scale-100"
    >
      <Play className="size-3.5" aria-hidden />
      <span className="max-sm:sr-only">Run</span>
    </button>
  );
}

/** Loaded on the first Run: the sandbox frame and its documents stay out of every reply's bundle. */
export const CodeRunOutput = nextDynamic(() => import("@/components/chat/code-run-output").then((m) => m.CodeRunOutput), {
  ssr: false,
  loading: () => <div className="h-28 rounded-card border border-border/60 bg-[#0b0b0e]" aria-hidden />,
});
