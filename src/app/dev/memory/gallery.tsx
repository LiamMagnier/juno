"use client";

import * as React from "react";
import { MotionConfig } from "framer-motion";
import { toast } from "sonner";
import { CustomizeFrame } from "@/components/customize/customize-nav";
import { MemoryManagerView } from "@/components/memory/memory-manager";
import type { MemoryEditRecord, Memory, Operation, ProjectSummaryData, SummaryData } from "@/components/memory/memory-model";
import type { BackfillState } from "@/components/memory/use-backfill";
import type { MemoryState } from "@/components/memory/use-memory";
import type { RecapExtras } from "@/components/memory/recap-view";
import type { SkillCandidateTransport, SkillCandidateView } from "@/components/memory/skill-candidates";

/*
 * Fixture state for the memory page. Every action mutates local state the way
 * the server would answer, with a short delay, so the page's motion (Undo,
 * applying a proposal, adding a memory) can be checked by hand as well as in
 * a screenshot.
 */

const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000).toISOString();
const wait = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
function fact(
  content: string,
  category: string | null,
  days: number,
  extra: Partial<Memory> = {}
): Memory {
  seq += 1;
  return {
    id: `m${seq}`,
    content,
    source: "AUTO",
    kind: "FACT",
    sourceRef: `chat-${seq}`,
    createdAt: ago(days, seq % 7),
    category,
    projectId: null,
    projectName: null,
    sourceMessageId: null,
    confidence: 0.8,
    status: "active",
    reason: null,
    expiresAt: null,
    lastUsedAt: days < 20 ? ago(Math.max(0, days - 1)) : null,
    lastVerifiedAt: null,
    supersededById: null,
    sensitive: null,
    ...extra,
  };
}

const THESIS = { projectId: "p-thesis", projectName: "Thesis: urban heat islands" };
const LAUNCH = { projectId: "p-launch", projectName: "Juno launch" };

export function richMemories(): Memory[] {
  seq = 0;
  return [
    fact("Works as a product engineer at a small design-tools startup", "identity", 0, { sourceRef: "manual", source: "MANUAL" }),
    fact("Lives in Lisbon, in the Arroios neighbourhood", "identity", 3),
    fact("Speaks Portuguese and English, and is learning Japanese", "identity", 12),
    fact("Goes by Liam", "identity", 40, { sourceRef: "import", source: "MANUAL" }),
    fact("Was born in Dublin and moved to Portugal in 2019", "identity", 64),
    fact("Has a dog called Miso", "identity", 90),
    fact("Prefers short answers that lead with the recommendation", "preferences", 1, { sourceRef: "edit", source: "MANUAL" }),
    fact("Likes code examples in TypeScript rather than JavaScript", "preferences", 9, { lastVerifiedAt: ago(1), sourceMessageId: "msg-1" }),
    fact("Wants metric units and 24-hour times", "preferences", 6, { sourceRef: "manual", source: "MANUAL" }),
    fact("Dislikes bullet points for anything that reads better as prose", "preferences", 9),
    fact("Prefers British spelling", "preferences", 22),
    fact("Avoids caffeine after 2pm", "preferences", 30),
    fact("Likes a list of trade-offs before a recommendation on technical choices", "preferences", 45),
    fact("Has a mild peanut allergy", "preferences", 18, { sensitive: "health" }),
    fact("Wants to ship the Juno public beta before the end of October", "goals", 4),
    fact("Is training for the Lisbon half marathon in March", "goals", 15),
    fact("Wants to read twelve novels this year", "goals", 70),
    fact("Is studying for the JLPT N4 in December", "studies", 8),
    fact("Takes an evening course in urban climate at Nova", "studies", 35),
    fact("Works in Next.js, Prisma and Postgres day to day", "workflows", 1),
    fact("Reviews pull requests first thing in the morning", "workflows", 11),
    fact("Keeps notes in Obsidian with a daily note template", "workflows", 26, { confidence: 0.5 }),
    fact("Deploys with GitHub Actions to a single VPS", "workflows", 50),
    fact("The thesis compares surface temperatures across three Lisbon parishes", "projects", 5, THESIS),
    fact("Cites in APA 7th edition", "projects", 5, { ...THESIS, sourceRef: "manual", source: "MANUAL" }),
    fact("Supervisor is Prof. Marta Reis", "projects", 20, THESIS),
    fact("The launch checklist lives in Linear under the Beta project", "projects", 2, LAUNCH),
    fact("Partner is called Inês and works as an architect", "relationships", 14),
    fact("Collaborates with Sam on the design system", "relationships", 3),
    fact("Is in Tokyo until 2 October for a conference", "temporary", 1, { expiresAt: new Date(Date.now() + 9 * DAY).toISOString() }),
    // Retired
    fact("Lives in Porto", "identity", 120, { status: "superseded", reason: "You mentioned moving to Lisbon." }),
    fact("Prefers long, detailed answers", "preferences", 100, { status: "contradicted", reason: "You asked for short answers since." }),
    fact("Is preparing a talk for the September meetup", "temporary", 60, { status: "expired" }),
    fact("Is considering a job at a bank", "goals", 80, { status: "suppressed", reason: "You asked Juno to forget this." }),
    {
      ...fact("Is considering a job at a bank", "suppression", 10),
      kind: "SUPPRESSION",
      sourceRef: "forget",
    },
  ];
}

export const SUMMARY: SummaryData = {
  updatedAt: ago(0, 2),
  entryCount: 30,
  content: `Liam is a product engineer at a small design-tools startup, living in Lisbon with his partner Inês and their dog Miso. He moved from Dublin in 2019, speaks Portuguese and English, and is learning Japanese for the JLPT N4 in December.

## How he likes answers
Short, leading with the recommendation, with the trade-offs laid out before any technical choice. Code examples in **TypeScript**, British spelling, metric units and 24-hour times. Prose over bullet points unless the content is genuinely a list.

## Work
He works in Next.js, Prisma and Postgres, reviews pull requests first thing in the morning and keeps his notes in Obsidian. The current push is the Juno public beta, which he wants out before the end of October; the launch checklist lives in Linear.

## Studies and goals
Alongside work he takes an evening course in urban climate at Nova and is writing a thesis on urban heat islands. He is training for the Lisbon half marathon in March and wants to read twelve novels this year.

## Right now
He is in Tokyo for a conference until 2 October, so times and suggestions should account for Japan Standard Time for the next week or so.`,
};

export const PROJECT_SUMMARIES: ProjectSummaryData[] = [
  {
    projectId: "p-thesis",
    projectName: THESIS.projectName,
    updatedAt: ago(1),
    entryCount: 3,
    content: `## Purpose & context
A master's thesis comparing land surface temperatures across three Lisbon parishes, supervised by Prof. Marta Reis. Citations follow APA 7th edition.`,
  },
];

function richEdits(memories: Memory[]): MemoryEditRecord[] {
  const byContent = (text: string) => memories.find((m) => m.content.startsWith(text))!;
  const lives = byContent("Lives in Lisbon");
  const coffee = byContent("Avoids caffeine");
  return [
    {
      id: "e-pending",
      instruction: "I moved to Porto last week, and I stopped caring about caffeine",
      summary: "Update where you live and drop the caffeine rule.",
      operations: [
        { op: "update", id: lives.id, before: lives.content, content: "Lives in Porto, near Bolhão" },
        { op: "remove", id: coffee.id, before: coffee.content },
      ],
      status: "pending",
      createdAt: ago(0, 0),
    },
    {
      id: "e-applied",
      instruction: "Remember that I prefer short answers",
      summary: "Add a preference for short answers.",
      operations: [{ op: "add", content: "Prefers short answers that lead with the recommendation" }],
      inverse: [{ op: "remove", id: "m7", before: "Prefers short answers that lead with the recommendation" }],
      status: "applied",
      createdAt: ago(1, 3),
    },
    {
      id: "e-rejected",
      instruction: "Remember my card number",
      note: "Juno doesn’t keep payment details, passwords or ID numbers.",
      operations: [],
      status: "rejected",
      createdAt: ago(4),
    },
  ];
}

/** Apply operations the way /api/memory/edit/apply does, returning the inverse. */
function applyOps(memories: Memory[], operations: Operation[]): { memories: Memory[]; inverse: Operation[] } {
  let next = [...memories];
  const inverse: Operation[] = [];
  for (const op of operations) {
    if (op.op === "update") {
      const row = next.find((m) => m.id === op.id);
      if (!row) continue;
      inverse.push({ op: "update", id: op.id, before: op.content, content: row.content });
      next = next.map((m) => (m.id === op.id ? { ...m, content: op.content, sourceRef: "edit", source: "MANUAL" } : m));
    } else if (op.op === "remove") {
      const row = next.find((m) => m.id === op.id);
      if (!row) continue;
      inverse.push({ op: "add", content: row.content, projectId: row.projectId });
      next = next.filter((m) => m.id !== op.id);
    } else {
      const row = { ...fact(op.content, "preferences", 0), sourceRef: "edit", source: "MANUAL" as const };
      inverse.push({ op: "remove", id: row.id, before: row.content });
      next = [row, ...next];
    }
  }
  return { memories: next, inverse };
}

function useFixtureMemory(initial: {
  memories: Memory[] | null;
  summary: SummaryData | null;
  projectSummaries: ProjectSummaryData[];
  edits: MemoryEditRecord[];
  paused: boolean;
}): MemoryState {
  const [memories, setMemories] = React.useState(initial.memories);
  const [summary, setSummary] = React.useState(initial.summary);
  const [projectSummaries, setProjectSummaries] = React.useState(initial.projectSummaries);
  const [edits, setEdits] = React.useState(initial.edits);
  const [paused, setPausedState] = React.useState(initial.paused);
  const [busy, setBusy] = React.useState(false);
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(new Set());
  const [busyEditIds, setBusyEditIds] = React.useState<ReadonlySet<string>>(new Set());
  const [resetting, setResetting] = React.useState(false);
  const memoriesRef = React.useRef(memories);
  memoriesRef.current = memories;

  const mark = (setter: typeof setBusyIds, id: string, on: boolean) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return {
    memories,
    summary,
    projectSummaries,
    edits,
    loadError: false,
    busy,
    busyIds,
    busyEditIds,
    policyNotice: null,
    paused,
    resetting,
    reload: async () => {},
    setPaused: async (next) => {
      setPausedState(next);
      if (next) toast.success("Memory is off. Juno won’t use or save memories.");
      else toast.success("Memory is on. Juno will learn from your chats.");
    },
    regenerate: async () => {
      setBusy(true);
      await wait(1200);
      setSummary((prev) => (prev ? { ...prev, updatedAt: new Date().toISOString() } : SUMMARY));
      setBusy(false);
    },
    instruct: async (instruction) => {
      setBusy(true);
      await wait(1400);
      const target = (memoriesRef.current ?? []).find((m) => m.kind === "FACT" && m.status === "active");
      setEdits((prev) => [
        {
          id: `e-${Date.now()}`,
          instruction,
          summary: "Add what you asked Juno to remember.",
          operations: target
            ? [{ op: "add", content: instruction.replace(/^remember (that )?/i, "") }]
            : [{ op: "add", content: instruction }],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setBusy(false);
      return true;
    },
    acceptEdit: async (edit) => {
      mark(setBusyEditIds, edit.id, true);
      await wait(700);
      const { memories: next, inverse } = applyOps(memoriesRef.current ?? [], edit.operations);
      setMemories(next);
      await wait(120);
      setEdits((prev) => prev.map((e) => (e.id === edit.id ? { ...e, status: "applied", inverse } : e)));
      mark(setBusyEditIds, edit.id, false);
    },
    undoEdit: async (edit) => {
      mark(setBusyEditIds, edit.id, true);
      await wait(600);
      const { memories: next } = applyOps(memoriesRef.current ?? [], edit.inverse ?? []);
      setMemories(next);
      await wait(120);
      setEdits((prev) => prev.map((e) => (e.id === edit.id ? { ...e, status: "pending", inverse: undefined } : e)));
      mark(setBusyEditIds, edit.id, false);
      toast.success("Change undone.");
    },
    deleteEdit: async (id) => {
      setEdits((prev) => prev.filter((e) => e.id !== id));
    },
    addMemory: async (content, projectId) => {
      await wait(350);
      const row = {
        ...fact(content, "preferences", 0, projectId ? { projectId, projectName: THESIS.projectName } : {}),
        sourceRef: "manual",
        source: "MANUAL" as const,
      };
      setMemories((prev) => [row, ...(prev ?? [])]);
      toast.success("Added to memory.");
      return true;
    },
    editMemory: async (id, content) => {
      mark(setBusyIds, id, true);
      await wait(400);
      setMemories((prev) => (prev ?? []).map((m) => (m.id === id ? { ...m, content, sourceRef: "edit", source: "MANUAL" } : m)));
      mark(setBusyIds, id, false);
      return true;
    },
    forgetMemory: async (entry) => {
      await wait(300);
      setMemories((prev) =>
        (prev ?? []).map((m) => (m.id === entry.id ? { ...m, status: "suppressed", reason: "You asked Juno to forget this." } : m))
      );
      return true;
    },
    deleteMemory: async (entry) => {
      await wait(300);
      setMemories((prev) => (prev ?? []).filter((m) => m.id !== entry.id));
      return true;
    },
    moveMemory: async (entry, project) => {
      await wait(300);
      setMemories((prev) =>
        (prev ?? []).map((m) =>
          m.id === entry.id ? { ...m, projectId: project?.id ?? null, projectName: project?.name ?? null } : m
        )
      );
      toast.success(project ? "Moved. Only chats in that project will use it." : "Moved. Every chat can use it now.");
      return true;
    },
    resetMemory: async () => {
      setResetting(true);
      await wait(800);
      setMemories([]);
      setSummary(null);
      setProjectSummaries([]);
      setEdits([]);
      setResetting(false);
      return true;
    },
    exportMemory: () => toast.success("Memory exported."),
    clearProjectMemory: async (projectId: string) => {
      await wait();
      setMemories((current) => (current ?? []).filter((m) => m.projectId !== projectId));
      setProjectSummaries((current) => current.filter((s) => s.projectId !== projectId));
      toast.success("This project’s memory is cleared.");
      return true;
    },
  };
}

function useFixtureBackfill(remaining: number | null): BackfillState {
  const [left, setLeft] = React.useState(remaining);
  const [running, setRunning] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  return {
    remaining: left,
    running,
    total,
    dreaming: false,
    run: () => {
      if (running || !left) return;
      setRunning(true);
      setTotal(left);
      const tick = (n: number) => {
        if (n <= 0) {
          setRunning(false);
          setLeft(0);
          return;
        }
        setLeft(n);
        setTimeout(() => tick(n - 2), 500);
      };
      tick(left);
    },
  };
}

const PROJECTS = [
  { id: "p-thesis", name: THESIS.projectName },
  { id: "p-launch", name: LAUNCH.projectName },
  { id: "p-trip", name: "Japan trip" },
];

async function loadRecapExtras(): Promise<RecapExtras> {
  await wait(300);
  return {
    conversations: 18,
    themes: [
      "Planning the Juno public beta and its launch checklist",
      "Choosing a charting library for the thesis figures",
      "A week of meals that avoid peanuts",
      "Kanji practice routines for the JLPT N4",
    ],
  };
}

function Fixture({ state }: { state: string }) {
  const empty = state === "empty";
  const loading = state === "loading";
  const memory = useFixtureMemory(
    React.useMemo(() => {
      const memories = richMemories();
      return {
        memories: loading ? null : empty ? [] : memories,
        summary: empty || loading ? null : SUMMARY,
        projectSummaries: empty || loading ? [] : PROJECT_SUMMARIES,
        edits: empty || loading ? [] : richEdits(memories),
        paused: state === "paused",
      };
    }, [empty, loading, state])
  );
  const backfill = useFixtureBackfill(empty ? 38 : 6);

  // `project` narrows the page the way /memory?project=… does.
  React.useLayoutEffect(() => {
    const url = new URL(window.location.href);
    if (state === "project") url.searchParams.set("project", "p-thesis");
    else url.searchParams.delete("project");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, [state]);

  // `activity` opens the sheet once the page is up.
  React.useEffect(() => {
    if (state !== "activity") return;
    const timer = setTimeout(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Activity");
      button?.click();
    }, 400);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <MemoryManagerView
      memory={memory}
      backfill={backfill}
      projects={PROJECTS}
      onWantProjects={() => {}}
      onOpenSettings={() => toast.message("Settings would open here.")}
      loadRecapExtras={loadRecapExtras}
      skillCandidates={SKILL_CANDIDATES}
    />
  );
}

/** Two proposals, as the dreamer would leave them; deciding mutates locally. */
const SKILL_CANDIDATES: SkillCandidateTransport = (() => {
  let list: SkillCandidateView[] = [
    {
      id: "sc1",
      title: "Weekly investor update",
      examples: [
        "Draft this week's investor update from the metrics sheet and the changelog",
        "Write the Friday investor update with the new MRR numbers",
      ],
      tools: ["read_spreadsheet", "write_document"],
      runCount: 4,
      lastSeenAt: ago(2),
    },
    {
      id: "sc2",
      title: "Triage new GitHub issues",
      examples: ["Go through the new issues on juno-web and label them", "Label and prioritise this morning's issues"],
      tools: ["github_issues", "github_label"],
      runCount: 3,
      lastSeenAt: ago(5),
    },
  ];
  return {
    load: async () => list,
    decide: async (id, action) => {
      await wait();
      if (action === "dismiss") list = list.filter((c) => c.id !== id);
      return { ok: true, href: action === "accept" ? "/skills" : undefined };
    },
  };
})();

export function MemoryGallery({ state }: { state: string }) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="h-dvh bg-background text-foreground">
        {/* The real route's frame (customize tabs, the wide measure), so the
            gallery shows the page at the width it ships at. */}
        <CustomizeFrame current="memory">
          <Fixture key={state} state={state} />
        </CustomizeFrame>
      </div>
    </MotionConfig>
  );
}
