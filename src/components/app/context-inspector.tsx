"use client";

import * as React from "react";
import {
  Activity,
  CheckCircle2,
  Eye,
  FileCode,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Table,
  Terminal,
  type IconComponent,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionIcons } from "@/lib/app-icons";
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
        {/* A tooltip with the chord as a keycap, like every icon-only control
            in the shell, rather than a native `title`. The tab is flush with
            the rail's hairline, so it carries no shadow of its own: it is part
            of the edge, not a layer above it. The glyph is the right-hand
            panel mark — the sidebar's own drawing, mirrored — because this
            rail opens on the right. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setOpen(!isOpen)}
              aria-label={isOpen ? "Hide inspector" : "Show inspector"}
              aria-expanded={isOpen}
              className="rounded-r-none border-r-0 bg-background/90 backdrop-blur"
            >
              {isOpen ? (
                <PanelRightClose className="size-4" aria-hidden="true" />
              ) : (
                <PanelRightOpen className="size-4" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" className="flex items-center gap-1.5">
            {isOpen ? "Hide inspector" : "Show inspector"}
            <Kbd>⌘I</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      {isOpen && (
        // Fades in behind the width sweep instead of appearing at full ink
        // in the frame the rail starts to open.
        <aside
          className="flex h-full min-w-0 flex-col overflow-hidden border-l border-border/60 bg-background/80 text-caption backdrop-blur-md motion-safe:animate-fade-in"
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
                  // The global `:focus-visible` outline is the one focus mark;
                  // these tabs used to swap it for a ring of their own.
                  className={cn(
                    "shrink-0 rounded-control px-2.5 py-1.5 text-caption font-medium transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
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
                  // A live feed: each event rises in as it ARRIVES, which is
                  // the state it reports. No stagger — a delay on the newest
                  // row would make the rail lag the run it is describing.
                  events.map((event) => (
                    <div
                      key={event.id}
                      className="space-y-1 surface-raised rounded-control p-2.5 motion-safe:animate-rise-in"
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
                      className="flex items-center justify-between gap-3 surface-raised rounded-control p-2.5 motion-safe:animate-rise-in"
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
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon-sm" asChild>
                              <a
                                href={artifact.downloadUrl}
                                download
                                aria-label={`Download ${artifact.title}`}
                              >
                                <ActionIcons.download className="size-4" aria-hidden="true" />
                              </a>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Download</TooltipContent>
                        </Tooltip>
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
                      className="flex items-start gap-2 surface-raised rounded-control p-2.5 motion-safe:animate-rise-in"
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

/**
 * An empty tab: one muted glyph in a quiet tile and one sentence
 * (ICONS_AND_MOTION.md §3). It was a 24px mark at half opacity floating over a
 * caption, which read as a disabled control rather than as a tab with nothing
 * in it yet.
 */
function InspectorEmpty({
  icon: Icon,
  message,
}: {
  icon: IconComponent;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground motion-safe:animate-fade-in">
      <span className="flex size-10 items-center justify-center rounded-field bg-secondary">
        <Icon className="size-5" motion="none" aria-hidden={true} />
      </span>
      <p className="text-caption">{message}</p>
    </div>
  );
}

/*
 * Event and artifact kinds are drawn in MUTED ink. They were the accent, which
 * put five coral marks down a rail whose one accent job is the step that is in
 * progress (the plan tab's `text-primary`): a kind of thing is not a state.
 * `size-3.5` beside the caption rung, per the icon ladder.
 */
function EventIcon({ type }: { type: AgentRuntimeEvent["type"] }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground";
  if (type === "searching") {
    return <Search className={cls} aria-hidden="true" />;
  }
  if (type === "python_execution") {
    return <Terminal className={cls} aria-hidden="true" />;
  }
  if (type === "browsing") {
    return <Eye className={cls} aria-hidden="true" />;
  }
  return <Activity className={cls} aria-hidden="true" />;
}

function ArtifactIcon({ type }: { type: AgentOutputArtifact["type"] }) {
  const cls = "size-4 shrink-0 text-muted-foreground";
  if (type === "table") {
    return <Table className={cls} aria-hidden="true" />;
  }
  if (type === "file") {
    return <FileCode className={cls} aria-hidden="true" />;
  }
  return <Activity className={cls} aria-hidden="true" />;
}
