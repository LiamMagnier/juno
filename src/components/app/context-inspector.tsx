"use client";

import * as React from "react";
import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  FileCode,
  Layers,
  Search,
  SidebarClose,
  SidebarOpen,
  Table,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AgentMode,
  AgentOutputArtifact,
  AgentRuntimeEvent,
} from "@/lib/agent/types";

interface ContextInspectorProps {
  mode?: AgentMode;
  events?: AgentRuntimeEvent[];
  artifacts?: AgentOutputArtifact[];
  activePlan?: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed";
  }>;
  subagents?: Array<{ id: string; name: string; role: string; status: string }>;
  workingCode?: { diff?: string; file?: string };
  className?: string;
}

const INSPECTOR_OPEN_KEY = "juno:inspector:open";
type InspectorTab = "activity" | "artifacts" | "plan";

/**
 * The shared context rail for agentic Chat/Work/Research surfaces.
 *
 * It intentionally reads like the rest of Juno now: semantic canvas/surface
 * tokens, product radii and real buttons. The previous inspector carried a
 * second neutral/coral palette and raw tab/button styling, so opening it made an
 * otherwise polished conversation look like a developer overlay.
 */
export function ContextInspector({
  mode = "chat",
  events = [],
  artifacts = [],
  activePlan = [],
  subagents: _subagents = [],
  workingCode: _workingCode,
  className,
}: ContextInspectorProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<InspectorTab>("activity");

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(INSPECTOR_OPEN_KEY);
      if (stored !== null) setIsOpen(stored === "1");
      else if (mode === "code" || mode === "work" || mode === "research") {
        setIsOpen(true);
      }
    } catch {
      // Storage is a preference only; the inspector still works without it.
    }
  }, [mode]);

  const setOpen = React.useCallback((open: boolean) => {
    setIsOpen(open);
    try {
      localStorage.setItem(INSPECTOR_OPEN_KEY, open ? "1" : "0");
    } catch {
      // Ignore storage failures; never make a view toggle depend on persistence.
    }
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setOpen(!isOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setOpen]);

  const tabs: Array<{ id: InspectorTab; label: string; visible: boolean }> = [
    { id: "activity", label: "Activity", visible: true },
    { id: "artifacts", label: `Artifacts ${artifacts.length}`, visible: true },
    {
      id: "plan",
      label: "Plan",
      visible: activePlan.length > 0 || mode === "work" || mode === "research",
    },
  ];

  return (
    <div
      className={cn(
        "relative flex shrink-0 flex-col transition-[width] duration-base ease-out-soft motion-reduce:transition-none",
        isOpen ? "w-80 lg:w-96" : "w-0",
        className
      )}
    >
      <div className="absolute left-0 top-3 z-20 -translate-x-full">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => setOpen(!isOpen)}
          title={isOpen ? "Hide inspector (⌘I)" : "Show inspector (⌘I)"}
          aria-label={isOpen ? "Hide inspector" : "Show inspector"}
          aria-expanded={isOpen}
          className="rounded-r-none border-r-0 bg-background/90 shadow-soft backdrop-blur"
        >
          {isOpen ? (
            <SidebarClose className="size-4" aria-hidden="true" />
          ) : (
            <SidebarOpen className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      {isOpen && (
        <aside
          className="flex h-full min-w-0 flex-col overflow-hidden border-l border-border/60 bg-background/80 text-xs backdrop-blur-md"
          aria-label={`${mode} context inspector`}
        >
          <header className="border-b border-border/60 bg-muted/30 px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 font-medium capitalize text-foreground">
              <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span>{mode} context</span>
            </div>

            <div
              role="tablist"
              aria-label="Inspector sections"
              className="flex max-w-full items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {tabs.filter((tab) => tab.visible).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "shrink-0 rounded-control px-2.5 py-1.5 text-caption font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    activeTab === tab.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/55 hover:text-foreground"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {activeTab === "activity" && (
              <div className="space-y-2">
                {events.length === 0 ? (
                  <InspectorEmpty
                    icon={Activity}
                    message="No active background actions."
                  />
                ) : (
                  events.map((event) => (
                    <div
                      key={event.id}
                      className="space-y-1 surface-raised rounded-control p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                          <EventIcon type={event.type} />
                          <span className="min-w-0 break-words">{event.title}</span>
                        </span>
                        <time
                          className="shrink-0 font-mono text-micro text-muted-foreground"
                          dateTime={new Date(event.timestamp).toISOString()}
                        >
                          {new Date(event.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      {event.detail && (
                        <p className="text-caption leading-relaxed text-muted-foreground">
                          {event.detail}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "artifacts" && (
              <div className="space-y-2">
                {artifacts.length === 0 ? (
                  <InspectorEmpty
                    icon={Layers}
                    message="No generated artifacts in this session."
                  />
                ) : (
                  artifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      className="flex items-center justify-between gap-3 surface-raised rounded-control p-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <ArtifactIcon type={artifact.type} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">
                            {artifact.title}
                          </p>
                          <p className="font-mono text-micro capitalize text-muted-foreground">
                            {artifact.type}
                          </p>
                        </div>
                      </div>
                      {artifact.downloadUrl && (
                        <Button variant="ghost" size="icon-sm" asChild>
                          <a
                            href={artifact.downloadUrl}
                            download
                            aria-label={`Download ${artifact.title}`}
                          >
                            <Download className="size-3.5" aria-hidden="true" />
                          </a>
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "plan" && (
              <div className="space-y-2">
                {activePlan.length === 0 ? (
                  <InspectorEmpty icon={CheckCircle2} message="No plan steps yet." />
                ) : (
                  activePlan.map((step, index) => (
                    <div
                      key={step.id}
                      className="flex items-start gap-2 surface-raised rounded-control p-2.5"
                    >
                      <span className="mt-0.5 font-mono text-micro text-muted-foreground">
                        {index + 1}.
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground">{step.title}</p>
                        <p
                          className={cn(
                            "mt-1 flex items-center gap-1 font-mono text-micro",
                            step.status === "failed"
                              ? "text-destructive"
                              : step.status === "in_progress"
                                ? "text-primary"
                                : "text-muted-foreground"
                          )}
                        >
                          {step.status === "completed" && (
                            <CheckCircle2 className="size-3" aria-hidden="true" />
                          )}
                          {step.status === "completed"
                            ? "Done"
                            : step.status === "in_progress"
                              ? "In progress"
                              : step.status === "failed"
                                ? "Failed"
                                : "Pending"}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function InspectorEmpty({
  icon: Icon,
  message,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
      <Icon className="mb-2 size-6 opacity-50" aria-hidden={true} />
      <p className="text-caption">{message}</p>
    </div>
  );
}

function EventIcon({ type }: { type: AgentRuntimeEvent["type"] }) {
  if (type === "searching") {
    return <Search className="size-3 shrink-0 text-primary" aria-hidden="true" />;
  }
  if (type === "python_execution") {
    return <Terminal className="size-3 shrink-0 text-primary" aria-hidden="true" />;
  }
  if (type === "browsing") {
    return <Eye className="size-3 shrink-0 text-primary" aria-hidden="true" />;
  }
  return <Activity className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function ArtifactIcon({ type }: { type: AgentOutputArtifact["type"] }) {
  if (type === "table") {
    return <Table className="size-4 shrink-0 text-primary" aria-hidden="true" />;
  }
  if (type === "file") {
    return <FileCode className="size-4 shrink-0 text-primary" aria-hidden="true" />;
  }
  return <Activity className="size-4 shrink-0 text-primary" aria-hidden="true" />;
}
