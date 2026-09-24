"use client";

import * as React from "react";
import { toast } from "sonner";
import type { RightPanelState } from "@/components/chat/panel/panel-state";
import { RightColumnShell } from "@/components/chat/panel/right-column-shell";
import { RunClock } from "@/components/chat/run/run-clock";
import { RESEARCH_COPY } from "@/components/research/copy";
import { useReportModel } from "@/components/research/report-document";
import { ReportView } from "@/components/research/report-view";
import { ResearchDetails } from "@/components/research/research-details";
import { ResearchPlan } from "@/components/research/research-plan";
import { ResearchProgress } from "@/components/research/research-progress";
import { ResearchSources } from "@/components/research/research-sources";
import {
  TAB_LABEL,
  coerceView,
  panelControls,
  panelTabs,
  researchClock,
  viewOnCompletion,
} from "@/components/research/research-view";
import { useResearchRun, type ResearchControl } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Pause, Play, X } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SplitPane } from "@/hooks/use-split-pane";
import { Phrase, PhraseWithArgs, formatPhrase, usePhrase } from "@/lib/i18n-phrase";
import { RESEARCH_PHASE_UI, isTerminalPhase } from "@/lib/research/phase";
import type { ResearchPhase } from "@/types/research";

/*
 * The Research panel inside the right-column shell (SPEC §9.11.4):
 * Progress · Sources · Plan while live, Report · Sources · Plan · Details when
 * done, with Pause/Resume, Finish now and Cancel in the header.
 *
 * - The header is the stable h2 "Research" (the shell's), then the static
 *   phase word and the clock. It never loops: the panel's loop owner is the
 *   question being searched (Progress).
 * - Finish now writes with what the run has. The engine acts at the next
 *   round boundary, which can be minutes away, so the button disables and the
 *   header says "Finishing with what it has" from the answer until writing
 *   starts. Cancel asks first. After a control resolves, focus goes to the
 *   panel heading (bug 12).
 * - In sheet mode (below the split) Pause and Finish now move into the
 *   overflow menu.
 * - When the run completes while the panel shows Progress it cross-fades to
 *   the Report, unless the reader picked a tab during the run.
 *
 * The chrome (label, header, actions, tabs) and the body come from one hook,
 * `useResearchPanel`, so the shell can be rendered by the panel (with
 * `shell`) or by chat-view around whichever panel is open (the Activity and
 * Research panels share one shell instance, §8.5).
 */

type ResearchView = Extract<RightPanelState, { kind: "research" }>["view"];

export interface ResearchPanelProps {
  runId: string;
  view: ResearchView;
  onViewChange(view: ResearchView): void;
  onClose(): void;
  coversChat(): boolean;
  /** EUR per USD for the spend in Details (the plan's currency). Absent: spend is left out. */
  eurPerUsd?: number;
  /** Render inside the right-column shell, with chat-view's pane and mode. */
  shell?: { open: boolean; pane: SplitPane; mode: "column" | "sheet"; onExited?(): void };
}

export interface ResearchPanelChrome {
  label: string;
  header: React.ReactNode;
  headerActions: React.ReactNode;
  tabs: Array<{ id: ResearchView; label: string }>;
  activeTab: ResearchView;
  onTabChange(id: string): void;
}

/** Focus the panel's heading (the shell's h2) once a control has resolved. */
function focusHeading(from: HTMLElement | null) {
  const root = from?.closest("aside, [data-research-panel]");
  const heading = root?.querySelector<HTMLElement>("h2");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus();
}

function PanelSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

function ControlsMenu({
  narrow,
  controls,
  busy,
  onControl,
  onCancel,
}: {
  narrow: boolean;
  controls: ReturnType<typeof panelControls>;
  busy: boolean;
  onControl(action: ResearchControl): void;
  onCancel(): void;
}) {
  const more = usePhrase(RESEARCH_COPY.controls.more);
  const inMenu = narrow && (controls.pause || controls.resume || controls.finish !== "hidden");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable kind="icon" size="md" aria-label={more}>
          <MoreHorizontal className="size-4" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {narrow && controls.pause && (
          <DropdownMenuItem disabled={busy} onSelect={() => onControl("pause")}>
            <Phrase text={RESEARCH_COPY.controls.pause} />
          </DropdownMenuItem>
        )}
        {narrow && controls.resume && (
          <DropdownMenuItem disabled={busy} onSelect={() => onControl("resume")}>
            <Phrase text={RESEARCH_COPY.controls.resume} />
          </DropdownMenuItem>
        )}
        {narrow && controls.finish !== "hidden" && (
          <DropdownMenuItem disabled={busy || controls.finish === "disabled"} onSelect={() => onControl("finish")}>
            <Phrase text={RESEARCH_COPY.controls.finishNow} />
          </DropdownMenuItem>
        )}
        {inMenu && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCancel} className="text-destructive">
          <Phrase text={RESEARCH_COPY.controls.cancel} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function useResearchPanel(props: ResearchPanelProps): { chrome: ResearchPanelChrome; body: React.ReactNode } {
  const { runId, view, onViewChange, coversChat, eurPerUsd } = props;
  const research = useResearchRun(runId);
  const { run, phase, events, busy, fetchedAt } = research;
  const model = useReportModel(run);
  const label = usePhrase(RESEARCH_COPY.panelTitle);
  const actionsRef = React.useRef<HTMLDivElement | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  const hasReport = !!run?.report;
  const tabs = phase ? panelTabs(phase, hasReport) : panelTabs("planning", false);
  const active = coerceView(view, tabs);
  const terminal = !!phase && isTerminalPhase(phase);

  // The completion cross-fade: only for a run this panel saw working.
  const userPicked = React.useRef(false);
  const previous = React.useRef<ResearchPhase | null>(null);
  React.useEffect(() => {
    userPicked.current = false;
    previous.current = null;
  }, [runId]);
  React.useEffect(() => {
    if (!phase) return;
    const wasTerminal = previous.current === null ? true : isTerminalPhase(previous.current);
    previous.current = phase;
    const next = viewOnCompletion({ view, userPicked: userPicked.current, wasTerminal, phase, hasReport });
    if (next !== view) onViewChange(next);
  }, [phase, hasReport, view, onViewChange]);

  const controls = panelControls(run, phase ?? "planning");
  const narrow = coversChat();

  const onControl = React.useCallback(
    async (action: ResearchControl) => {
      const result = await research.control(action);
      if (!result.ok) toast.error(result.notice ?? formatPhrase(RESEARCH_COPY.controls.failed));
      focusHeading(actionsRef.current);
    },
    [research],
  );

  const clock = researchClock(run, phase ?? "planning", fetchedAt);
  const header = phase ? (
    <span aria-hidden className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
      <PhraseWithArgs spec={controls.finishing ? [{ parts: [{ phrase: RESEARCH_COPY.controls.finishing }] }] : RESEARCH_PHASE_UI[phase].line({})} className="min-w-0 truncate" />
      <RunClock elapsedMs={clock.elapsedMs} since={clock.since} showAfterMs={0} className="run-clock font-mono" />
    </span>
  ) : null;

  const headerActions = run ? (
    <div ref={actionsRef} className="flex items-center gap-1">
      {!narrow && controls.pause && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onControl("pause")} className="gap-1.5 px-2.5">
          <Pause className="size-3.5" />
          <Phrase text={RESEARCH_COPY.controls.pause} />
        </Button>
      )}
      {!narrow && controls.resume && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onControl("resume")} className="gap-1.5 px-2.5">
          <Play className="size-3.5" />
          <Phrase text={RESEARCH_COPY.controls.resume} />
        </Button>
      )}
      {!narrow && controls.finish !== "hidden" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || controls.finish === "disabled"}
          onClick={() => void onControl("finish")}
          className="px-2.5"
        >
          <Phrase text={RESEARCH_COPY.controls.finishNow} />
        </Button>
      )}
      {controls.cancel && (
        <ControlsMenu
          narrow={narrow}
          controls={controls}
          busy={busy}
          onControl={(action) => void onControl(action)}
          onCancel={() => setConfirmCancel(true)}
        />
      )}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Phrase text={RESEARCH_COPY.controls.cancelTitle} />
            </DialogTitle>
            <DialogDescription>
              <Phrase text={RESEARCH_COPY.controls.cancelBody} />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">
                <Phrase text={RESEARCH_COPY.controls.keepGoing} />
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmCancel(false);
                void onControl("cancel");
              }}
            >
              <Phrase text={RESEARCH_COPY.controls.cancelConfirm} />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ) : null;

  const tabLabels = tabs.map((id) => ({ id, label: formatPhrase(TAB_LABEL[id]) }));

  const body = !run ? (
    <PanelSkeleton />
  ) : (
    // Keyed by the view: a tab switch (or the completion cross-fade) enters on
    // the short opacity arrival, never a travel.
    <div key={active} className="research-tab-body pt-0">
      {active === "progress" && <ResearchProgress run={run} events={events} />}
      {active === "sources" && <ResearchSources sections={model.sections} live={!terminal} />}
      {active === "plan" && <ResearchPlan run={run} />}
      {active === "report" && <ReportView run={run} events={events} model={model} />}
      {active === "details" && <ResearchDetails run={run} eurPerUsd={eurPerUsd} />}
    </div>
  );

  return {
    chrome: {
      label,
      header,
      headerActions,
      tabs: tabLabels,
      activeTab: active,
      onTabChange: (id: string) => {
        const next = coerceView(id as ResearchView, tabs);
        userPicked.current = true;
        onViewChange(next);
      },
    },
    body,
  };
}

/**
 * Without `shell`, the same chrome in a plain frame (galleries, a page of its
 * own): the h2, the header, the actions, the tabs and a close button.
 */
function PanelFrame({ chrome, body, onClose }: { chrome: ResearchPanelChrome; body: React.ReactNode; onClose(): void }) {
  const closeName = usePhrase(RESEARCH_COPY.closePanel);
  return (
    <section aria-label={chrome.label} data-research-panel="" className="flex h-full min-h-0 flex-col bg-background [--fav-ring:var(--card)]">
      <header className="flex min-h-14 items-center gap-2 border-b border-border/70 px-4">
        <h2 className="shrink-0 text-ui font-semibold text-foreground">{chrome.label}</h2>
        <div className="min-w-0 flex-1">{chrome.header}</div>
        {chrome.headerActions}
        <Pressable kind="icon" size="md" aria-label={closeName} onClick={onClose}>
          <X className="size-4" />
        </Pressable>
      </header>
      <Tabs value={chrome.activeTab} onValueChange={chrome.onTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pt-3">
          <TabsList>
            {chrome.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {chrome.tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]">
            {tab.id === chrome.activeTab ? body : null}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

export function ResearchPanel(props: ResearchPanelProps) {
  const { chrome, body } = useResearchPanel(props);
  if (!props.shell) return <PanelFrame chrome={chrome} body={body} onClose={props.onClose} />;
  return (
    <RightColumnShell
      open={props.shell.open}
      label={chrome.label}
      header={chrome.header}
      headerActions={chrome.headerActions}
      tabs={chrome.tabs}
      activeTab={chrome.activeTab}
      onTabChange={chrome.onTabChange}
      onClose={props.onClose}
      pane={props.shell.pane}
      mode={props.shell.mode}
      onExited={props.shell.onExited}
    >
      {body}
    </RightColumnShell>
  );
}
