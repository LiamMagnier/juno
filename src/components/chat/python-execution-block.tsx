"use client";

import React, { useState } from "react";
import { Terminal, ChevronDown, ChevronRight, CheckCircle2, XCircle, FileCode2, Download } from "lucide-react";
import type { PythonExecutionResult } from "@/lib/sandbox/python";
import { DataTableBlock } from "@/components/chat/data-table-block";
import { DataChartBlock } from "@/components/chat/data-chart-block";

interface PythonExecutionBlockProps {
  code: string;
  result?: PythonExecutionResult;
  status?: "running" | "completed" | "failed";
}

export function PythonExecutionBlock({ code, result, status = "completed" }: PythonExecutionBlockProps) {
  const [isCodeOpen, setIsCodeOpen] = useState(false);
  const isSuccess = result ? result.success : status === "completed";

  return (
    <div className="my-3 rounded-xl border border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/60 overflow-hidden text-xs">
      {/* Header bar */}
      <div
        onClick={() => setIsCodeOpen(!isCodeOpen)}
        className="flex items-center justify-between px-3.5 py-2 cursor-pointer select-none hover:bg-neutral-100/60 dark:hover:bg-neutral-800/40 transition"
      >
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-medium text-neutral-800 dark:text-neutral-200">
            Python Execution
          </span>
          {result && (
            <span className="text-caption text-neutral-400 font-mono">
              ({result.durationMs}ms)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {status === "running" ? (
            <span className="flex items-center gap-1 text-caption text-amber-500 font-medium animate-pulse">
              Running...
            </span>
          ) : isSuccess ? (
            <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" /> Done
            </span>
          ) : (
            <span className="flex items-center gap-1 text-caption text-rose-500 font-medium">
              <XCircle className="h-3.5 w-3.5" /> Failed
            </span>
          )}
          {isCodeOpen ? <ChevronDown className="h-3.5 w-3.5 text-neutral-400" /> : <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />}
        </div>
      </div>

      {/* Expandable Code */}
      {isCodeOpen && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-900 text-neutral-100 p-3 font-mono text-caption overflow-x-auto">
          <pre>{code}</pre>
        </div>
      )}

      {/* Stdout / Stderr console output if present */}
      {result && (result.stdout || result.stderr) && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-950 text-neutral-300 p-3 font-mono text-caption overflow-x-auto space-y-1">
          {result.stdout && (
            <div className="flex items-start gap-2">
              <Terminal className="h-3.5 w-3.5 text-neutral-500 shrink-0 mt-0.5" />
              <pre className="whitespace-pre-wrap">{result.stdout}</pre>
            </div>
          )}
          {result.stderr && (
            <div className="text-rose-400 whitespace-pre-wrap pl-5">
              {result.stderr}
            </div>
          )}
        </div>
      )}

      {/* Rendered Tables */}
      {result?.tables && result.tables.length > 0 && (
        <div className="p-3 space-y-3">
          {result.tables.map((tbl, i) => (
            <DataTableBlock key={i} table={tbl} title={`Data Table ${i + 1}`} />
          ))}
        </div>
      )}

      {/* Rendered Charts */}
      {result?.charts && result.charts.length > 0 && (
        <div className="p-3 space-y-3">
          {result.charts.map((chart, i) => (
            <DataChartBlock key={i} chart={chart} />
          ))}
        </div>
      )}

      {/* Generated downloadable files */}
      {result?.generatedFiles && result.generatedFiles.length > 0 && (
        <div className="p-3 border-t border-neutral-200 dark:border-neutral-800 flex flex-wrap gap-2">
          {result.generatedFiles.map((file, i) => (
            <a
              key={i}
              href={file.path}
              download={file.name}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 transition shadow-sm"
            >
              <Download className="h-3.5 w-3.5 text-coral-500" />
              <span className="font-medium">{file.name}</span>
              <span className="text-micro text-neutral-400">({Math.round(file.sizeBytes / 1024)} KB)</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
