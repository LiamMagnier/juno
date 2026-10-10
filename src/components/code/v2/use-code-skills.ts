"use client";

/**
 * The composer's skills for one Code thread (skills lane): the account's
 * skills (the library Chat runs, read from `/api/skills` the way Chat reads
 * it), the Mac's and the project's (`skills.list` over the device link), the
 * thread's selection (kept per thread in this browser, seeded from the env
 * server's snapshot), and a `/name` armed for the next message.
 *
 * LAZY, like Chat's: nothing is fetched until the reader opens the Skills
 * chip or types `/`. A composer is on every Code thread and most never open it.
 */
import * as React from "react";
import type { LocalSkillSummary, SkillActivation } from "@/lib/code-v2/contracts";
import {
  buildActivations,
  choiceFromAccount,
  choiceFromLocal,
  idsFromSnapshot,
  orderSkills,
  placeholderChoice,
  skillsStorageKey,
  type CodeSkillChoice,
} from "@/lib/code-v2/skills";
import { chatSkillsFromLibrary } from "@/components/chat/use-chat-skills";
import type { SkillLibrary } from "@/lib/skills/library-contract";

export interface CodeSkillsState {
  /** Null until the first read lands. */
  choices: CodeSkillChoice[] | null;
  loading: boolean;
  failed: boolean;
  /** The thread's selection, in the order chosen. */
  selected: CodeSkillChoice[];
  /** A `/name` skill for the next message only. */
  once: CodeSkillChoice | null;
  /** True when the Mac's skills could not be read (offline, an older Mac). */
  macUnavailable: boolean;
  /** Starts the first read (the chip opened, `/` typed). */
  load(): void;
  reload(): void;
  toggle(choice: CodeSkillChoice): void;
  arm(choice: CodeSkillChoice | null): void;
  clear(): void;
  /** The activations for the message about to go; clears the armed one. */
  take(): Promise<SkillActivation[] | undefined>;
  manageHref: string;
}

function readIds(key: string): string[] | null {
  try {
    const v = localStorage.getItem(key);
    const parsed = v ? (JSON.parse(v) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function writeIds(key: string, ids: string[]) {
  try {
    // Kept even when empty: "cleared here" must not fall back to the env
    // server's record the way "never chosen here" does.
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* per-viewer convenience */
  }
}

async function readAccountSkills(): Promise<CodeSkillChoice[]> {
  const response = await fetch("/api/skills");
  if (!response.ok) throw new Error("skills");
  const library = (await response.json()) as Partial<SkillLibrary>;
  return chatSkillsFromLibrary({
    yours: Array.isArray(library.yours) ? library.yours : [],
    sources: Array.isArray(library.sources) ? library.sources : [],
    total: library.total ?? 0,
    truncated: library.truncated === true,
  }).map((s) => choiceFromAccount({ id: s.id, slug: s.slug, name: s.name, description: s.description, sourceLabel: s.sourceLabel }));
}

async function readAccountInstructions(id: string): Promise<string | null> {
  const response = await fetch(`/api/work/skills/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: { instructions?: string } | null };
  return body.version?.instructions?.trim() || null;
}

export function useCodeSkills({
  threadKey,
  snapshotSkills,
  listLocal,
}: {
  /** The thread the selection belongs to; null for a new thread (kept in memory until it has one). */
  threadKey: string | null;
  /** The env server's record of the thread's selection, for a browser that has none. */
  snapshotSkills?: SkillActivation[];
  /** The Mac's skills; null when this thread does not run on a Mac. */
  listLocal: (() => Promise<LocalSkillSummary[]>) | null;
}): CodeSkillsState {
  const [choices, setChoices] = React.useState<CodeSkillChoice[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [macUnavailable, setMacUnavailable] = React.useState(false);
  const [ids, setIds] = React.useState<string[]>(() => (threadKey && typeof window !== "undefined" ? (readIds(skillsStorageKey(threadKey)) ?? []) : []));
  const [once, setOnceState] = React.useState<CodeSkillChoice | null>(null);
  // Read by `take` in the same tick a typed `/name` arms it, before React re-renders.
  const onceRef = React.useRef<CodeSkillChoice | null>(null);
  const setOnce = React.useCallback((choice: CodeSkillChoice | null) => {
    onceRef.current = choice;
    setOnceState(choice);
  }, []);
  const asked = React.useRef(false);
  const listRef = React.useRef(listLocal);
  listRef.current = listLocal;

  // A thread switch restores that thread's selection; a browser with none
  // takes the env server's.
  const seeded = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!threadKey || seeded.current === threadKey) return;
    seeded.current = threadKey;
    const stored = readIds(skillsStorageKey(threadKey));
    if (stored) setIds(stored);
    else if (snapshotSkills?.length) setIds(idsFromSnapshot(snapshotSkills));
  }, [threadKey, snapshotSkills]);

  const persist = React.useCallback(
    (next: string[]) => {
      setIds(next);
      if (threadKey) writeIds(skillsStorageKey(threadKey), next);
    },
    [threadKey],
  );

  const read = React.useCallback(async () => {
    asked.current = true;
    setLoading(true);
    setFailed(false);
    const local = listRef.current;
    const [account, mac] = await Promise.allSettled([readAccountSkills(), local ? local() : Promise.resolve([] as LocalSkillSummary[])]);
    const next = [...(account.status === "fulfilled" ? account.value : []), ...(mac.status === "fulfilled" ? mac.value.map(choiceFromLocal) : [])];
    setMacUnavailable(!!local && mac.status === "rejected");
    setFailed(account.status === "rejected" && (mac.status === "rejected" || !local));
    setChoices(orderSkills(next));
    setLoading(false);
  }, []);

  const load = React.useCallback(() => {
    if (!asked.current) void read();
  }, [read]);

  // A Mac that comes online after the first read: read again for its skills.
  const hasLocal = !!listLocal;
  React.useEffect(() => {
    if (asked.current && hasLocal) void read();
  }, [hasLocal, read]);

  const selected = React.useMemo(
    () => ids.map((id) => choices?.find((c) => c.id === id) ?? placeholderChoice(id)).filter((c): c is CodeSkillChoice => c !== null),
    [ids, choices],
  );

  const toggle = React.useCallback(
    (choice: CodeSkillChoice) => persist(ids.includes(choice.id) ? ids.filter((i) => i !== choice.id) : [...ids, choice.id]),
    [ids, persist],
  );

  const clear = React.useCallback(() => {
    setOnce(null);
    persist([]);
  }, [persist, setOnce]);

  const take = React.useCallback(async () => {
    const armed = onceRef.current;
    setOnce(null);
    // Nothing chosen and nothing ever chosen: leave the field out, so the
    // env server's own record of the thread (another device's choice) holds.
    if (!armed && ids.length === 0 && (!threadKey || readIds(skillsStorageKey(threadKey)) === null)) return undefined;
    return buildActivations(selected, armed, readAccountInstructions);
  }, [ids, selected, threadKey, setOnce]);

  return {
    choices,
    loading,
    failed,
    selected,
    once,
    macUnavailable,
    load,
    reload: () => void read(),
    toggle,
    arm: setOnce,
    clear,
    take,
    manageHref: "/skills",
  };
}
