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
import { cloudSkillRefs, type CloudSkillRef } from "@/lib/code-v2/cloud-skills";
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
  /** True when the Mac's (or the repository's) skills could not be read (offline, an older Mac). */
  macUnavailable: boolean;
  /** Where the non-account skills come from: this Mac, a cloud run's repository, or nowhere. */
  localKind: "mac" | "repo" | null;
  /** Starts the first read (the chip opened, `/` typed). */
  load(): void;
  reload(): void;
  toggle(choice: CodeSkillChoice): void;
  arm(choice: CodeSkillChoice | null): void;
  clear(): void;
  /** The activations for the message about to go; clears the armed one. */
  take(): Promise<SkillActivation[] | undefined>;
  /**
   * A cloud run's skills for the message about to go (account ids and the
   * repository's names); clears the armed one. Undefined when this thread
   * never chose: the server keeps the conversation's last choice.
   */
  takeCloud(): CloudSkillRef[] | undefined;
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

/**
 * A cloud run's repository skills (`.alevr/skills`, `.juno/skills`,
 * `.claude/skills` on GitHub), what the runner will read from its clone.
 */
export async function readRepoSkills(repo: { owner: string; name: string }, ref?: string | null): Promise<LocalSkillSummary[]> {
  const q = new URLSearchParams({ repo: `${repo.owner}/${repo.name}`, ...(ref ? { ref } : {}) });
  const response = await fetch(`/api/code/github/skills?${q.toString()}`);
  if (!response.ok) throw new Error("repo skills");
  const body = (await response.json()) as { skills?: LocalSkillSummary[] };
  return Array.isArray(body.skills) ? body.skills : [];
}

async function readAccountInstructions(id: string): Promise<string | null> {
  const response = await fetch(`/api/work/skills/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: { instructions?: string } | null };
  return body.version?.instructions?.trim() || null;
}

/** The ids a selection names, as one comparable string. */
const idsKey = (skills: readonly SkillActivation[] | undefined) => JSON.stringify(idsFromSnapshot(skills));

export function useCodeSkills({
  threadKey,
  snapshotSkills,
  listLocal,
  remote,
  listRevision = 0,
  localKind,
}: {
  /** The thread the selection belongs to; null for a new thread (kept in memory until it has one). */
  threadKey: string | null;
  /** The env server's record of the thread's selection, for a browser that has none. */
  snapshotSkills?: SkillActivation[];
  /** The Mac's skills, or a cloud run's repository skills; null when there are none to list. */
  listLocal: (() => Promise<LocalSkillSummary[]>) | null;
  /**
   * LIVE SELECTION, for a thread on the env server: `skills` is the thread's
   * selection as the env server last reported it (its snapshot, then each
   * `session.skills`), and `select` sets it there (`skills.select`). A change
   * made on another device is applied here as it lands; one made here is
   * sent at once rather than with the next message. Null: no env session.
   */
  remote?: { skills: SkillActivation[]; select(skills: SkillActivation[]): Promise<unknown> } | null;
  /**
   * Bumped when the listed skills changed where they live (the env server's
   * `skills.updated`): an opened list is read again, so the picker is live.
   */
  listRevision?: number;
  /** What `listLocal` lists (default: this Mac when there is one). */
  localKind?: "mac" | "repo";
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

  // Skills installed, edited or removed on the Mac: re-read a list already shown.
  React.useEffect(() => {
    if (listRevision > 0 && asked.current) void read();
  }, [listRevision, read]);

  const selected = React.useMemo(
    () => ids.map((id) => choices?.find((c) => c.id === id) ?? placeholderChoice(id)).filter((c): c is CodeSkillChoice => c !== null),
    [ids, choices],
  );

  // ── Live selection (env server threads) ──────────────────────────────────
  const remoteRef = React.useRef(remote);
  remoteRef.current = remote;
  const remoteSkills = remote?.skills;
  const remoteKey = remote ? idsKey(remoteSkills) : null;
  // The env server's activations by id: an account skill another device chose
  // carries its instructions, so it is sent on even before the list loads.
  const remoteById = React.useMemo(() => new Map((remoteSkills ?? []).map((a) => [`${a.source}:${a.name}`, a])), [remoteSkills]);
  const remoteSeen = React.useRef<{ thread: string | null; key: string | null }>({ thread: null, key: null });
  React.useEffect(() => {
    if (remoteKey === null || !threadKey) return;
    const seen = remoteSeen.current;
    if (seen.thread === threadKey && seen.key === remoteKey) return;
    const first = seen.thread !== threadKey;
    remoteSeen.current = { thread: threadKey, key: remoteKey };
    const next = JSON.parse(remoteKey) as string[];
    const stored = readIds(skillsStorageKey(threadKey));
    // First sight of a thread whose env session knows no selection yet, while
    // this browser has one (chosen on the landing, or before the session
    // opened): this browser's choice is the thread's; tell the env server.
    if (first && next.length === 0 && stored?.length) {
      void pushRef.current?.(stored);
      return;
    }
    // Otherwise the env server's record is the thread's selection: another
    // device (or this one, echoed back) set it.
    setIds(next);
    writeIds(skillsStorageKey(threadKey), next);
  }, [remoteKey, threadKey]);

  const choicesRef = React.useRef(choices);
  choicesRef.current = choices;
  /** Sends a selection to the env server now (a no-op without a session). */
  const pushRef = React.useRef<((next: string[]) => Promise<void>) | null>(null);
  pushRef.current = async (next: string[]) => {
    const live = remoteRef.current;
    if (!live) return;
    let known = choicesRef.current ?? [];
    // An account skill needs its library row (for its text): read the list
    // when it has not been read yet, rather than drop the skill.
    if (next.some((id) => id.startsWith("account:") && !known.some((c) => c.id === id) && !remoteById.has(id))) {
      known = [...known, ...(await readAccountSkills().catch(() => [] as CodeSkillChoice[]))];
    }
    const picked = next
      .map((id) => known.find((c) => c.id === id) ?? placeholderChoice(id) ?? null)
      .filter((c): c is CodeSkillChoice => c !== null);
    const built = await buildActivations(picked, null, readAccountInstructions);
    // Keep what the env server already had for an id this browser cannot rebuild.
    const byId = new Map(built.map((a) => [`${a.source}:${a.name}`, a]));
    const activations = next.map((id) => byId.get(id) ?? remoteById.get(id)).filter((a): a is SkillActivation => !!a);
    await live.select(activations).catch(() => undefined);
  };

  const change = React.useCallback(
    (next: string[]) => {
      persist(next);
      void pushRef.current?.(next);
    },
    [persist],
  );

  const toggle = React.useCallback(
    (choice: CodeSkillChoice) => change(ids.includes(choice.id) ? ids.filter((i) => i !== choice.id) : [...ids, choice.id]),
    [ids, change],
  );

  const clear = React.useCallback(() => {
    setOnce(null);
    change([]);
  }, [change, setOnce]);

  const take = React.useCallback(async () => {
    const armed = onceRef.current;
    setOnce(null);
    // Nothing chosen and nothing ever chosen: leave the field out, so the
    // env server's own record of the thread (another device's choice) holds.
    if (!armed && ids.length === 0 && (!threadKey || readIds(skillsStorageKey(threadKey)) === null)) return undefined;
    const built = await buildActivations(selected, armed, readAccountInstructions);
    // An account skill chosen on another device whose row this browser has
    // not loaded: the env server's activation (with its text) stands in.
    for (const id of ids) {
      if (built.some((a) => `${a.source}:${a.name}` === id)) continue;
      const known = remoteById.get(id);
      if (known) built.push(known);
    }
    return built;
  }, [ids, selected, threadKey, setOnce, remoteById]);

  const takeCloud = React.useCallback(() => {
    const armed = onceRef.current;
    setOnce(null);
    if (!armed && ids.length === 0 && (!threadKey || readIds(skillsStorageKey(threadKey)) === null)) return undefined;
    return cloudSkillRefs(selected, armed);
  }, [ids, selected, threadKey, setOnce]);

  return {
    choices,
    loading,
    failed,
    selected,
    once,
    macUnavailable,
    localKind: listLocal ? (localKind ?? "mac") : null,
    load,
    reload: () => void read(),
    toggle,
    arm: setOnce,
    clear,
    take,
    takeCloud,
    manageHref: "/skills",
  };
}
