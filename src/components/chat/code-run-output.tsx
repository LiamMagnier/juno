"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { RotateCcw, X } from "@/components/ui/icons";
import { SandboxFrame, type RunStatus } from "@/components/canvas/sandbox-frame";
import type { RunTarget } from "@/lib/exec/snippet-languages";
import { HR_SAMPLE_NOTE } from "@/lib/sandbox/hr-sample";
import { cn } from "@/lib/utils";

/**
 * A code block's output, drawn as the lower half of the block itself: the
 * same `--secondary` surface and 14px corners (the caller wraps both), a
 * hairline, a 36px header like the block's own (a name on the left, the state
 * in words and two square keys on the right), then the output in the block's
 * mono face and the app's theme. No status dot and no second black panel
 * (owner, 2026-10-09).
 */

const MIN_HEIGHT = 44;
const MAX_HEIGHT = 420;

function stateWord(status: RunStatus | "refused"): string {
  switch (status) {
    case "loading":
      return "Loading";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "refused":
      return "Not run";
    default:
      return "";
  }
}

export function CodeRunOutput({
  target,
  code,
  nonce,
  onClose,
  className,
}: {
  target: RunTarget;
  code: string;
  nonce: number;
  onClose: () => void;
  className?: string;
}) {
  const [again, setAgain] = React.useState(0);
  const [status, setStatus] = React.useState<RunStatus | "refused">("loading");
  const runKey = nonce * 1000 + again;

  return (
    <section aria-label={`${target.label} output`} className={cn("border-t border-border", className)}>
      <div className="flex min-h-9 items-center gap-2 py-1.5 pl-4 pr-3">
        <span className="aicss-cb-lang" title={target.language === "sql" ? HR_SAMPLE_NOTE : undefined}>
          {target.language === "sql" ? "Output · SQLite, HR sample" : target.where === "server" ? "Output · sandbox" : "Output"}
        </span>
        <span className="ml-auto text-caption text-muted-foreground" aria-live="polite">
          {stateWord(status)}
        </span>
        <span className="-mr-1.5 inline-flex items-center gap-0.5">
          <button type="button" onClick={() => setAgain((n) => n + 1)} aria-label="Run again" title="Run again" className="aicss-cb-icon">
            <RotateCcw className="size-3.5" aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Close the output" title="Close" className="aicss-cb-icon">
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      {target.where === "browser" ? (
        <BrowserRun target={target} code={code} runKey={runKey} onStatus={setStatus} />
      ) : (
        <ServerRun target={target} code={code} runKey={runKey} onStatus={setStatus} />
      )}
    </section>
  );
}

function BrowserRun({
  target,
  code,
  runKey,
  onStatus,
}: {
  target: RunTarget;
  code: string;
  runKey: number;
  onStatus: (status: RunStatus) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [height, setHeight] = React.useState(MIN_HEIGHT);
  const appearance = React.useMemo(() => ({ inline: true, theme: resolvedTheme === "dark" ? ("dark" as const) : ("light" as const) }), [resolvedTheme]);
  React.useEffect(() => {
    onStatus("loading");
    setHeight(MIN_HEIGHT);
  }, [runKey, onStatus]);
  // The frame grows with its output up to MAX_HEIGHT, then scrolls inside.
  return (
    <div style={{ height }} className="transition-[height] duration-base ease-out-soft motion-reduce:transition-none">
      <SandboxFrame
        type="CODE"
        content={code}
        language={target.language}
        runNonce={runKey}
        consoleAppearance={appearance}
        onConsoleSize={(h) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h)))}
        onStatus={(s) => onStatus(s)}
        className="block size-full border-0 bg-transparent"
      />
    </div>
  );
}

type ServerResult = { ok: boolean; output: string; durationMs: number | null } | { refused: string } | null;

function ServerRun({
  target,
  code,
  runKey,
  onStatus,
}: {
  target: RunTarget;
  code: string;
  runKey: number;
  onStatus: (status: RunStatus | "refused") => void;
}) {
  const [result, setResult] = React.useState<ServerResult>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    onStatus("running");
    const refuse = (message: string) => {
      setResult({ refused: message });
      onStatus("refused");
    };
    fetch("/api/code/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: target.language, code }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { status?: string; output?: string; durationMs?: number | null; message?: string };
        if (res.status === 402) return refuse(body.message ?? "Running code on the server is part of the paid plans.");
        if (res.status === 401) return refuse("Sign in to run code.");
        if (res.status === 429) return refuse("Too many runs in a minute. Try again shortly.");
        if (!res.ok) return refuse("This code couldn’t be run right now.");
        const ok = body.status === "succeeded";
        setResult({ ok, output: body.output ?? "", durationMs: body.durationMs ?? null });
        onStatus(ok ? "done" : "error");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        refuse(error instanceof Error ? error.message : "This code couldn’t be run right now.");
      });
    return () => controller.abort();
  }, [target.language, code, runKey, onStatus]);

  return (
    <div
      className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-4 pb-3.5 pt-3 font-mono text-ui leading-relaxed text-foreground"
      aria-live="polite"
    >
      {result === null ? (
        <span className="text-muted-foreground">Compiling and running in the sandbox…</span>
      ) : "refused" in result ? (
        <span className="text-muted-foreground">{result.refused}</span>
      ) : (
        <>
          <span className={result.ok ? undefined : "text-destructive-ink"}>{result.output || "(no output)"}</span>
          {result.durationMs ? <span className="mt-1 block text-muted-foreground">Ran in {(result.durationMs / 1000).toFixed(1)} s.</span> : null}
        </>
      )}
    </div>
  );
}
