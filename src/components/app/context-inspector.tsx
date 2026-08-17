"use client";

import React, { useState, useEffect } from "react";
import {
  SidebarClose,
  SidebarOpen,
  Sparkles,
  FileCode,
  Search,
  CheckCircle2,
  Table,
  Layers,
  Terminal,
  Activity,
  Download,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMode, AgentRuntimeEvent, AgentOutputArtifact } from "@/lib/agent/types";

interface ContextInspectorProps {
  mode?: AgentMode;
  events?: AgentRuntimeEvent[];
  artifacts?: AgentOutputArtifact[];
  activePlan?: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed" }>;
  subagents?: Array<{ id: string; name: string; role: string; status: string }>;
  workingCode?: { diff?: string; file?: string };
  className?: string;
}

const INSPECTOR_OPEN_KEY = "juno:inspector:open";

export function ContextInspector({
  mode = "chat",
  events = [],
  artifacts = [],
  activePlan = [],
  subagents: _subagents = [],
  workingCode: _workingCode,
  className,
}: ContextInspectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"activity" | "artifacts" | "plan" | "cockpit">("activity");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(INSPECTOR_OPEN_KEY);
      if (stored !== null) setIsOpen(stored === "1");
      else if (mode === "code" || mode === "work" || mode === "research") setIsOpen(true);
    } catch {
      // ignore
    }
  }, [mode]);

  const toggleOpen = () => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(INSPECTOR_OPEN_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className={cn("relative flex flex-col transition-all duration-200 shrink-0", isOpen ? "w-80 lg:w-96" : "w-10", className)}>
      {/* Toggle button */}
      <div className="absolute left-0 top-3 -translate-x-full z-20">
        <button
          onClick={toggleOpen}
          title={isOpen ? "Hide Inspector (Cmd+I)" : "Show Inspector (Cmd+I)"}
          className="flex h-8 w-8 items-center justify-center rounded-l-lg border border-r-0 border-neutral-200 bg-white/90 text-neutral-600 shadow-sm backdrop-blur hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-300 dark:hover:bg-neutral-800 transition"
        >
          {isOpen ? <SidebarClose className="h-4 w-4" /> : <SidebarOpen className="h-4 w-4" />}
        </button>
      </div>

      {/* Inspector Panel Body */}
      {isOpen ? (
        <aside className="flex flex-col h-full border-l border-neutral-200 bg-white/70 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-900/70 overflow-hidden text-xs">
          {/* Header & Tabs */}
          <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
            <div className="flex items-center gap-1.5 font-medium text-neutral-800 dark:text-neutral-200 capitalize">
              <Sparkles className="h-3.5 w-3.5 text-coral-500" />
              <span>{mode} Cockpit</span>
            </div>

            {/* Sub Tabs */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab("activity")}
                className={cn(
                  "px-2 py-1 rounded-sm text-caption font-medium transition",
                  activeTab === "activity"
                    ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                )}
              >
                Activity
              </button>
              <button
                onClick={() => setActiveTab("artifacts")}
                className={cn(
                  "px-2 py-1 rounded-sm text-caption font-medium transition",
                  activeTab === "artifacts"
                    ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                )}
              >
                Artifacts ({artifacts.length})
              </button>
              {(activePlan.length > 0 || mode === "work" || mode === "research") && (
                <button
                  onClick={() => setActiveTab("plan")}
                  className={cn(
                    "px-2 py-1 rounded-sm text-caption font-medium transition",
                    activeTab === "plan"
                      ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                      : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                  )}
                >
                  Plan
                </button>
              )}
            </div>
          </div>

          {/* Tab Contents */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Activity Stream */}
            {activeTab === "activity" && (
              <div className="space-y-2">
                {events.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-neutral-400">
                    <Activity className="h-6 w-6 mb-2 opacity-40" />
                    <p className="text-caption">No active background actions.</p>
                  </div>
                ) : (
                  events.map((ev) => (
                    <div
                      key={ev.id}
                      className="rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-800/50 shadow-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-neutral-800 dark:text-neutral-200 flex items-center gap-1.5">
                          {ev.type === "searching" && <Search className="h-3 w-3 text-sky-500" />}
                          {ev.type === "python_execution" && <Terminal className="h-3 w-3 text-emerald-500" />}
                          {ev.type === "browsing" && <Eye className="h-3 w-3 text-indigo-500" />}
                          {ev.title}
                        </span>
                        <span className="text-micro text-neutral-400">
                          {new Date(ev.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                      </div>
                      {ev.detail && <p className="text-caption text-neutral-600 dark:text-neutral-400">{ev.detail}</p>}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Artifacts List */}
            {activeTab === "artifacts" && (
              <div className="space-y-2">
                {artifacts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-neutral-400">
                    <Layers className="h-6 w-6 mb-2 opacity-40" />
                    <p className="text-caption">No generated artifacts in this session.</p>
                  </div>
                ) : (
                  artifacts.map((art) => (
                    <div
                      key={art.id}
                      className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-800/50 shadow-xs"
                    >
                      <div className="flex items-center gap-2">
                        {art.type === "table" && <Table className="h-4 w-4 text-emerald-500" />}
                        {art.type === "file" && <FileCode className="h-4 w-4 text-amber-500" />}
                        {art.type === "chart" && <Activity className="h-4 w-4 text-coral-500" />}
                        <div>
                          <p className="font-medium text-neutral-800 dark:text-neutral-200">{art.title}</p>
                          <p className="text-micro text-neutral-400 capitalize">{art.type}</p>
                        </div>
                      </div>
                      {art.downloadUrl && (
                        <a
                          href={art.downloadUrl}
                          download
                          className="p-1 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-500"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Plan List */}
            {activeTab === "plan" && (
              <div className="space-y-2">
                {activePlan.map((step, idx) => (
                  <div
                    key={step.id}
                    className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-800/50"
                  >
                    <span className="font-mono text-micro text-neutral-400 mt-0.5">{idx + 1}.</span>
                    <div className="flex-1">
                      <p className="font-medium text-neutral-800 dark:text-neutral-200">{step.title}</p>
                      <div className="flex items-center gap-1 mt-1">
                        {step.status === "completed" && (
                          <span className="flex items-center gap-1 text-micro text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" /> Done
                          </span>
                        )}
                        {step.status === "in_progress" && (
                          <span className="text-micro text-amber-500 font-medium animate-pulse">
                            In Progress
                          </span>
                        )}
                        {step.status === "pending" && (
                          <span className="text-micro text-neutral-400">Pending</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
