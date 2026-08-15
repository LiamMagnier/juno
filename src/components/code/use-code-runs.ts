"use client";

import * as React from "react";

import { CODE_SYNC_EVENT } from "@/hooks/use-code-session";
import type { CodeRun } from "@/lib/code-runs";
import { deviceOffersWorkspace, type DeviceRow } from "@/components/code/device-presence";

/*
 * THE DATA BEHIND THE RUN LIST, AND THE THREE REQUESTS IT IS ALLOWED TO MAKE.
 *
 * The list is a triage surface, so its whole value is that a glance is enough.
 * That puts a hard ceiling on what it may fetch: anything per-row is N requests
 * for a screen the reader is going to look at for four seconds. So the list
 * loads exactly three collections — the runs, the machines that could be
 * running them, and the open pull requests — and every per-run detail
 * (what it is doing right now, what it changed, what it is asking) is deferred
 * to the peek, which is one run at a time and only when asked for.
 *
 * That split is why the list can afford to poll and the detail can afford to
 * stream.
 */

/** How often the collections refresh while the tab is visible. */
const POLL_MS = 6_000;
/**
 * The page size asked of `/api/code/tasks`. Its own cap is 100.
 *
 * Deliberately the maximum: this list's entire job is "everything at once,
 * ordered by who is blocked", and a page boundary in the middle of that is a
 * run the reader is not told about. When a user genuinely outgrows 100 live
 * runs the answer is a server-side triage query, not a Load more button that
 * hides the blocked ones below the fold.
 */
const RUN_PAGE_SIZE = 100;

/**
 * GitHub's open-PR page size, mirrored from the route's own GraphQL query
 * (`first: 30` in src/app/api/code/github/pulls/route.ts).
 *
 * It is duplicated here rather than imported because it is not exported, and
 * because what this module needs is not the number — it is the ability to tell
 * a SHORT page from a FULL one. A full page means the list was truncated, and a
 * truncated list cannot be used to prove a pull request is closed. See
 * `prSettled` in lib/code-runs.ts for what that guard prevents.
 */
const GITHUB_PULL_PAGE_SIZE = 30;

type TasksPayload = { tasks: CodeRun[] };
type DevicesPayload = { devices: DeviceRow[] };
type PullsPayload = { created?: { url: string }[]; involved?: { url: string }[] };

export type RunsLoadState = "loading" | "ready" | "error";

export interface CodeRunsData {
  runs: CodeRun[];
  devices: DeviceRow[];
  state: RunsLoadState;
  /** Open pull request urls, or null when GitHub is unlinked / unreachable. */
  openPrUrls: Set<string> | null;
  /** True when GitHub returned a full page, so absence proves nothing. */
  openPageWasFull: boolean;
  /** Re-fetch everything now. Safe to call from a retry button. */
  refresh: () => void;
  /**
   * Whether the Mac that owns a device run is reachable right now — `null`
   * while the device list is still loading, which is NOT the same as "offline".
   * See the note on `runState`.
   */
  reachableFor: (run: CodeRun) => boolean | null;
}

export function useCodeRuns(): CodeRunsData {
  const [runs, setRuns] = React.useState<CodeRun[]>([]);
  const [devices, setDevices] = React.useState<DeviceRow[] | null>(null);
  const [openPrUrls, setOpenPrUrls] = React.useState<Set<string> | null>(null);
  const [openPageWasFull, setOpenPageWasFull] = React.useState(false);
  const [state, setState] = React.useState<RunsLoadState>("loading");
  const [nonce, setNonce] = React.useState(0);

  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const [tasksRes, devicesRes] = await Promise.all([
          fetch(`/api/code/tasks?limit=${RUN_PAGE_SIZE}`, {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch("/api/code/devices", { cache: "no-store", signal: controller.signal }),
        ]);
        if (cancelled) return;
        if (!tasksRes.ok) {
          // Only the run list is load-bearing. A device list that fails leaves
          // reachability unknown, which the tri-state already models.
          setState("error");
          return;
        }
        const tasks = ((await tasksRes.json()) as TasksPayload).tasks ?? [];
        if (cancelled) return;
        setRuns(tasks);
        setState("ready");
        if (devicesRes.ok) {
          setDevices(((await devicesRes.json()) as DevicesPayload).devices ?? []);
        }
      } catch {
        // An aborted fetch is a navigation, not a failure — and setting `error`
        // on unmount would flash the error plate on the way out of the page.
        if (!cancelled && !controller.signal.aborted) setState("error");
      }
    };

    /*
     * The pull-request list is fetched for ONE reason: so a run whose pull
     * request has merged or closed can drop out of the active view by itself.
     *
     * Every failure mode here is silent on purpose. GitHub being unlinked (404),
     * the token being stale (401) and GitHub being unreachable (502) all mean
     * the same thing to this list — "no evidence either way" — and none of them
     * is worth an error on a screen about runs. `openPrUrls` stays null and the
     * list simply does not decay, which is exactly what it did before this
     * existed.
     */
    const loadPulls = async () => {
      try {
        const res = await fetch("/api/code/github/pulls", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as PullsPayload;
        if (cancelled) return;
        const created = payload.created ?? [];
        const involved = payload.involved ?? [];
        setOpenPrUrls(new Set([...created, ...involved].map((p) => p.url)));
        // Either section hitting the page size means the answer was cut off.
        setOpenPageWasFull(
          created.length >= GITHUB_PULL_PAGE_SIZE || involved.length >= GITHUB_PULL_PAGE_SIZE,
        );
      } catch {
        /* see above — absence of evidence, never an error */
      }
    };

    void load();
    void loadPulls();

    /*
     * Visibility-gated polling, the same rule `useDevicePresence` keeps. A
     * background tab holding a six-second poll open is a request every six
     * seconds for a screen nobody is looking at, multiplied by every tab the
     * user left open — and the moment they come back, the `visibilitychange`
     * handler refreshes anyway, so the polls it skipped bought nothing.
     */
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load();
        void loadPulls();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CODE_SYNC_EVENT, load);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CODE_SYNC_EVENT, load);
    };
  }, [nonce]);

  const reachableFor = React.useCallback(
    (run: CodeRun): boolean | null => {
      if (run.target === "cloud") return true;
      if (devices === null) return null;
      /*
       * The device id is the strong answer and the workspace is the fallback,
       * in that order — a run records which machine it was sent to, but a task
       * created before the device was re-registered can carry an id no device
       * row still has. Falling through to "does any online machine offer this
       * workspace" is the same rule `ownerDevice` uses in the target picker, so
       * a project the reader can start work in never shows as unreachable in
       * the list of work already started in it.
       */
      const byId = run.deviceId ? devices.find((d) => d.id === run.deviceId) : null;
      if (byId) return byId.online === true;
      const owner = devices.find((d) => deviceOffersWorkspace(d, run.workspaceKey, run.workspaceName));
      return owner ? owner.online === true : false;
    },
    [devices],
  );

  return {
    runs,
    devices: devices ?? [],
    state,
    openPrUrls,
    openPageWasFull,
    refresh,
    reachableFor,
  };
}

/* ── One run, in detail ───────────────────────────────────────────────────── */

/** A file the run touched, with its unified diff when one was transported. */
export interface RunFile {
  path: string;
  changeKind: string;
  added: number;
  removed: number;
  /**
   * Null means NO PATCH ARRIVED, never "the change was empty". Every device
   * host in the field sends path/kind/counts and no hunks; only the cloud
   * runner sends diffs today. A reader that treats null as an empty diff draws
   * an empty pane over a change with plenty of content.
   */
  patch: string | null;
  /**
   * Whether this file was written during the LATEST turn of the conversation.
   *
   * This is the whole "Last turn" scope, and it is computed here because only
   * the event stream can answer it: the turn boundary is the sequence number of
   * the most recent `user` event, and everything after it is what the agent did
   * in response to the last thing it was told. Without it the reader opens a
   * review pane on run number four and cannot tell which of the eleven files
   * are from the instruction they just gave.
   */
  fromLastTurn: boolean;
}

export interface PendingApproval {
  requestId: string;
  summary: string;
  /** "neutral" | "destructive" | "outside" — the Mac host's own risk labels. */
  risk: string;
  detail: string | null;
}

export interface RunDetail {
  loading: boolean;
  /** The newest thing the runner said it was doing, for the peek's headline. */
  activity: string | null;
  files: RunFile[];
  pendingApproval: PendingApproval | null;
  /** The run's own error text, when it reported one. */
  error: string | null;
  /** True once a turn boundary was seen, so "Last turn" can be offered honestly. */
  hasTurnBoundary: boolean;
  /**
   * Commands the run itself reported that look like verification — tests, type
   * checks, linters, builds.
   *
   * THIS IS EVIDENCE, NOT A GUARANTEE, and the receipt that renders it has to
   * say so. All it proves is that a tool event went past with `npm test` in its
   * summary; the event log carries no exit code, so a suite that ran and failed
   * looks identical here to one that ran and passed. It earns its place anyway
   * because the alternative on offer is worse: with nothing at all, a reader
   * assumes either that everything was checked or that nothing was, and the
   * receipt's whole purpose is to stop them having to guess.
   */
  checks: string[];
}

const EMPTY_DETAIL: RunDetail = {
  loading: true,
  activity: null,
  files: [],
  pendingApproval: null,
  error: null,
  hasTurnBoundary: false,
  checks: [],
};

/**
 * What a verification step looks like in a tool summary.
 *
 * Word-boundary anchored on purpose. An unanchored /test/ matches `latest`,
 * `contest` and every path with `tests/` in it, which would have turned "read
 * src/tests/fixtures.ts" into a claim that the suite ran.
 */
const CHECK_PATTERN =
  /\b(npm|pnpm|yarn|bun)?\s*(test|jest|vitest|pytest|tsc|typecheck|type-check|lint|eslint|build|cargo\s+test|go\s+test|swift\s+test)\b/i;

type RemoteEvent = { seq: number; kind: string; payload: Record<string, unknown> | null };
type StreamFrame =
  | { type: "snapshot" | "events"; task: { status: string }; events: RemoteEvent[] }
  | { type: "done"; task: { status: string } };

const str = (payload: Record<string, unknown> | null, key: string): string | null => {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
};
const num = (payload: Record<string, unknown> | null, key: string): number | null => {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Minimal SSE frame reader — `data:` JSON frames only, `: ping` heartbeats
 * skipped. Deliberately a copy of the one in use-code-session.ts rather than an
 * import: that one is not exported, and the alternative to duplicating twenty
 * lines was exporting a private detail of the chat session hook so a list could
 * borrow it.
 */
async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: StreamFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith("data:")) continue;
      try {
        onFrame(JSON.parse(frame.slice(5).trim()) as StreamFrame);
      } catch {
        /* a half-written frame is dropped; the next one carries the state */
      }
    }
  }
}

/**
 * Follow ONE run's event log, for the peek and the review pane.
 *
 * Pass null to follow nothing — which is the common case, because at most one
 * run is ever open at a time. That is not a performance nicety: the stream
 * endpoint holds a database poll open for up to four minutes per connection, so
 * a version of this that attached to every visible row would put twenty of them
 * on one page.
 */
export function useRunDetail(taskId: string | null): RunDetail {
  const [detail, setDetail] = React.useState<RunDetail>(EMPTY_DETAIL);

  React.useEffect(() => {
    if (!taskId) {
      setDetail(EMPTY_DETAIL);
      return;
    }
    setDetail(EMPTY_DETAIL);

    const controller = new AbortController();
    /*
     * Accumulators live outside React state because a stream frame can carry
     * five hundred events, and folding those through five setState calls each
     * would re-render the pane once per event. State is written once per frame.
     *
     * Files are held WITH the sequence number they were last written at, which
     * is what makes the "Last turn" scope possible: a file belongs to the
     * latest turn when it was touched after the newest `user` event. The seq
     * cannot live on `RunFile` itself — that is the shape the pane renders, and
     * a transport cursor on it is a field every consumer has to ignore — so the
     * pair is carried here and split apart on the way into state.
     */
    let touched: { file: Omit<RunFile, "fromLastTurn">; seq: number }[] = [];
    let activity: string | null = null;
    let pending: PendingApproval | null = null;
    let error: string | null = null;
    let lastUserSeq = 0;
    let seenUser = false;
    let lastSeq = 0;
    const checks = new Set<string>();

    const apply = (events: RemoteEvent[]) => {
      for (const event of events) {
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        switch (event.kind) {
          case "user":
            // A new instruction opens a new turn. Nothing is re-flagged here:
            // the boundary is applied once, below, against the whole collection,
            // because a `user` event can arrive after files that precede it.
            lastUserSeq = event.seq;
            seenUser = true;
            break;
          case "tool": {
            const summary = str(event.payload, "summary") ?? str(event.payload, "name");
            if (summary) {
              activity = summary;
              // Deduplicated by the whole summary, so a suite run four times
              // during one session is one line on the receipt rather than four.
              if (CHECK_PATTERN.test(summary)) checks.add(summary.trim().slice(0, 120));
            }
            break;
          }
          case "text": {
            const text = str(event.payload, "text");
            if (text?.trim()) activity = text.trim().slice(0, 200);
            break;
          }
          case "file_change": {
            const path = str(event.payload, "path");
            if (!path) break;
            /*
             * TWO SPELLINGS FOR ONE FIELD, AND BOTH ARE LOAD-BEARING. `patch`
             * is the name the payload documents; `diff` is the key the deployed
             * cloud runner actually writes. Reading only `patch` ships a diff
             * viewer that never fires against the one producer in the tree that
             * sends hunks. (The same pair is read in use-code-session.ts.)
             */
            const patch = str(event.payload, "patch") ?? str(event.payload, "diff");
            const next = {
              path,
              changeKind: str(event.payload, "changeKind") ?? "edit",
              added: num(event.payload, "added") ?? 0,
              removed: num(event.payload, "removed") ?? 0,
              patch: patch || null,
            };
            const index = touched.findIndex((t) => t.file.path === path);
            if (index === -1) {
              touched = [...touched, { file: next, seq: event.seq }];
            } else {
              const merged = [...touched];
              // Last write per path wins on everything EXCEPT the patch, which
              // survives when the newer event has none: a file written twice
              // whose second event lost its hunks must not lose the diff the
              // reader was already shown.
              merged[index] = {
                file: { ...next, patch: next.patch ?? touched[index].file.patch },
                seq: event.seq,
              };
              touched = merged;
            }
            break;
          }
          case "approval_request": {
            const requestId = str(event.payload, "requestId");
            const summary = str(event.payload, "summary");
            if (requestId && summary) {
              pending = {
                requestId,
                summary,
                risk: str(event.payload, "risk") ?? "neutral",
                detail: str(event.payload, "detail"),
              };
            }
            break;
          }
          case "approval_response": {
            const requestId = str(event.payload, "requestId");
            if (pending && pending.requestId === requestId) pending = null;
            break;
          }
          case "error":
            error = str(event.payload, "message") ?? "The run reported an error.";
            break;
          default:
            break;
        }
      }
      setDetail({
        loading: false,
        activity,
        files: touched.map((t) => ({ ...t.file, fromLastTurn: t.seq > lastUserSeq })),
        pendingApproval: pending,
        error,
        hasTurnBoundary: seenUser,
        checks: [...checks],
      });
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`/api/code/tasks/${taskId}/events?afterSeq=${lastSeq}`, {
            signal: controller.signal,
            headers: { Accept: "text/event-stream" },
          });
          // 404 is a deleted task and 401 is a signed-out session; reconnecting
          // helps neither, and a spinner that never resolves is worse than an
          // empty pane.
          if (res.status === 404 || res.status === 401) {
            setDetail((d) => ({ ...d, loading: false }));
            return;
          }
          if (!res.ok || !res.body) throw new Error("stream unavailable");
          let finished = false;
          await readSseFrames(res.body, (frame) => {
            if (frame.type === "done") {
              finished = true;
              return;
            }
            apply(frame.events);
          });
          if (finished) return;
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        // The server closes its own window after four minutes; reconnect from
        // the cursor so a long-running run keeps streaming into an open pane.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    };
    void run();

    return () => controller.abort();
  }, [taskId]);

  return detail;
}
