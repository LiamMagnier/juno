"use client";

import * as React from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  Terminal,
  XCircle,
} from "lucide-react";
import type { PythonExecutionResult } from "@/lib/sandbox/python";
import { DataTableBlock } from "@/components/chat/data-table-block";
import { DataChartBlock } from "@/components/chat/data-chart-block";
import { Button } from "@/components/ui/button";

interface PythonExecutionBlockProps {
  code: string;
  result?: PythonExecutionResult;
  status?: "running" | "completed" | "failed";
}

/**
 * Python execution evidence inside Chat.
 *
 * The execution is machine output, but the container is still Juno. The old
 * block switched into its own neutral/coral theme and used a clickable `div`
 * as the disclosure control. This version keeps the code/output monospaced
 * while using the shared semantic surfaces and a real button for keyboard and
 * assistive-technology behaviour.
 */
export function PythonExecutionBlock({
  code,
  result,
  status = "completed",
}: PythonExecutionBlockProps) {
  const [isCodeOpen, setIsCodeOpen] = React.useState(false);
  const isSuccess = result ? result.success : status === "completed";

  return (
    <section className="my-3 overflow-hidden rounded-card border border-border/60 bg-card text-xs shadow-soft">
      <button
        type="button"
        onClick={() => setIsCodeOpen((open) => !open)}
        className="flex min-h-11 w-full select-none items-center justify-between gap-3 bg-muted/30 px-3.5 py-2 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
        aria-expanded={isCodeOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FileCode2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-medium text-foreground">Python execution</span>
          {result && (
            <span className="shrink-0 font-mono text-micro text-muted-foreground">
              {result.durationMs} ms
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {status === "running" ? (
            <span className="font-medium text-primary" aria-live="polite">
              Running…
            </span>
          ) : isSuccess ? (
            <span className="flex items-center gap-1 font-medium text-foreground">
              <CheckCircle2 className="size-3.5" aria-hidden="true" /> Done
            </span>
          ) : (
            <span className="flex items-center gap-1 font-medium text-destructive">
              <XCircle className="size-3.5" aria-hidden="true" /> Failed
            </span>
          )}
          {isCodeOpen ? (
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      </button>

      {isCodeOpen && (
        <div className="overflow-x-auto border-t border-border/60 bg-muted/55 p-3 font-mono text-caption text-foreground">
          <pre className="whitespace-pre">{code}</pre>
        </div>
      )}

      {result && (result.stdout || result.stderr) && (
        <div className="space-y-1 overflow-x-auto border-t border-border/60 bg-muted/35 p-3 font-mono text-caption text-foreground">
          {result.stdout && (
            <div className="flex items-start gap-2">
              <Terminal
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <pre className="whitespace-pre-wrap break-words">{result.stdout}</pre>
            </div>
          )}
          {result.stderr && (
            <pre className="whitespace-pre-wrap break-words pl-5 text-destructive">
              {result.stderr}
            </pre>
          )}
        </div>
      )}

      {result?.tables && result.tables.length > 0 && (
        <div className="space-y-3 border-t border-border/45 p-3">
          {result.tables.map((table, index) => (
            <DataTableBlock key={index} table={table} title={`Data table ${index + 1}`} />
          ))}
        </div>
      )}

      {result?.charts && result.charts.length > 0 && (
        <div className="space-y-3 border-t border-border/45 p-3">
          {result.charts.map((chart, index) => (
            <DataChartBlock key={index} chart={chart} />
          ))}
        </div>
      )}

      {result?.generatedFiles && result.generatedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border/60 bg-muted/20 p-3">
          {result.generatedFiles.map((file, index) => (
            <Button key={index} variant="outline" size="sm" asChild className="gap-1.5">
              <a href={file.path} download={file.name}>
                <Download className="size-3.5 text-primary" aria-hidden="true" />
                <span className="max-w-52 truncate">{file.name}</span>
                <span className="font-mono text-micro text-muted-foreground">
                  {Math.round(file.sizeBytes / 1024)} KB
                </span>
              </a>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
