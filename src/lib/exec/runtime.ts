import "server-only";
/**
 * The hosted execution runtime: run_code, check_run and the lease sweep.
 *
 * A run exists only if a ToolRun row says so, and everything the model or the
 * person is told about it comes from that row and from the host's own report:
 *
 *   validate → claim the row (or find it) → upload inputs and skill bundles →
 *   start on the host with an Idempotency-Key → wait (long-poll, progress,
 *   lease renewal, Stop = cancel on the host) → capture files and logs →
 *   settle the row → meter → tell the model exactly what happened.
 *
 * A call that outlives its inline wait answers "still running" with a run id
 * and lets go of the row; check_run (or the scheduler's sweep, if the turn is
 * gone) picks it up. A row nobody can account for becomes `outcome_unknown`,
 * and nothing is ever re-run automatically. Design: TOOL_RUNTIME_DESIGN.md §6.
 */
import { conversationAttachments } from "@/lib/agent/attachments";
import { matchAttachment, nameList } from "@/lib/agent/attachment-match";
import { getObjectBytes } from "@/lib/storage";
import { recordSpend } from "@/lib/spend";
import { EXEC_LIMITS, execEndpoint, runCodeMicroUsdPerSecond, surfaceLimits } from "@/lib/exec/config";
import {
  ExecRefusedError,
  ExecUnavailableError,
  JunoExecClient,
  type HostManifest,
  type HostRunSnapshot,
} from "@/lib/exec/client";
import { captureOutputs, reloadImages, storeFullLogs } from "@/lib/exec/capture";
import { formatDuration, languageLabel, outcomeText, runSummary, type StreamSlice } from "@/lib/exec/format";
import { codeDigest, hostAccountId, hostIdempotencyKey, hostSessionId, runArgsDigest } from "@/lib/exec/ids";
import {
  claimMetering,
  claimToolRun,
  countSessionRuns,
  findAbandonedRuns,
  findOwnRun,
  getToolRun,
  isTerminal,
  lockdownEnabled,
  markStarted,
  readCode,
  readOutputs,
  readTail,
  recordInputs,
  releaseLease,
  renewLease,
  settleToolRun,
  storedTail,
  takeExpiredLease,
  type Lease,
  type ToolRunRow,
} from "@/lib/exec/store";
import {
  EXEC_LANGUAGES,
  type CheckRunArgs,
  type ExecCallContext,
  type ExecErrorCode,
  type ExecImage,
  type ExecInputFile,
  type ExecLanguage,
  type ExecRunFacts,
  type ExecSurface,
  type ExecToolOutcome,
  type SkillMount,
  type ToolRunStatus,
} from "@/lib/exec/types";

// ── small helpers ────────────────────────────────────────────────────────────

function refused(code: ExecErrorCode, message: string): ExecToolOutcome {
  const text = code === "invalid_arguments" ? `${message} Nothing was run.` : message;
  return { status: "failed", text, body: text, error: { code } };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

let manifestCache: { at: number; value: HostManifest | null } | null = null;

/** The host's runtimes and packages, cached for ten minutes per process. */
export async function execManifest(client?: JunoExecClient): Promise<HostManifest | null> {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60_000) return manifestCache.value;
  const endpoint = execEndpoint();
  if (!endpoint) return null;
  try {
    const value = await (client ?? new JunoExecClient(endpoint)).manifest();
    manifestCache = { at: Date.now(), value: value.error ? null : value };
  } catch {
    manifestCache = { at: Date.now() - 9 * 60_000, value: null };
  }
  return manifestCache.value;
}

/** One line for run_code's description: what the sandbox has (L1 puts it in the tool text). */
export async function runtimeManifestSummary(): Promise<string | null> {
  const manifest = await execManifest();
  if (!manifest?.runtimes) return null;
  const { python, javascript, bash } = manifest.runtimes;
  const packages = (manifest.pythonPackages ?? []).map((entry) => entry.name).filter((name) =>
    ["numpy", "pandas", "scipy", "matplotlib", "seaborn", "openpyxl", "xlsxwriter", "python-docx", "python-pptx", "pypdf", "pdfplumber", "pillow", "reportlab"].includes(name),
  );
  return `Python ${python ?? "3"} (${packages.join(", ")}), Node ${javascript ?? "22"}, bash ${(bash ?? "").split("(")[0] || "5"}.`;
}

let healthCache: { at: number; ok: boolean } | null = null;

/** Whether the configured host answers, cached for a minute (for capability notes). */
export async function execHealthy(): Promise<boolean> {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.ok;
  const endpoint = execEndpoint();
  if (!endpoint) return false;
  let ok = false;
  try {
    const health = await new JunoExecClient(endpoint).health();
    ok = health.ok === true && health.egress === "none";
  } catch {
    ok = false;
  }
  healthCache = { at: Date.now(), ok };
  return ok;
}

// ── argument validation ─────────────────────────────────────────────────────

interface ParsedRunCode {
  language: ExecLanguage;
  code: string;
  files: string[] | null;
  timeoutMs: number;
}

export function parseRunCodeArgs(raw: Record<string, unknown>, surface: ExecSurface): ParsedRunCode | { error: string } {
  const limits = surfaceLimits(surface);
  const allowed = new Set(["language", "code", "files", "timeout_seconds", "reason"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.` };
  const language = (raw.language ?? "python") as ExecLanguage;
  if (!EXEC_LANGUAGES.includes(language)) return { error: `language must be one of ${EXEC_LANGUAGES.join(", ")}.` };
  if (typeof raw.code !== "string" || !raw.code.trim()) return { error: "code is required and must be a non-empty string." };
  if (Buffer.byteLength(raw.code, "utf8") > EXEC_LIMITS.maxCodeBytes) return { error: "code is longer than 256 KB." };
  let files: string[] | null = null;
  if (raw.files !== undefined && raw.files !== null) {
    if (!Array.isArray(raw.files) || !raw.files.every((entry) => typeof entry === "string")) {
      return { error: "files must be an array of attachment names." };
    }
    files = raw.files as string[];
  }
  let timeoutMs = limits.defaultTimeoutMs;
  if (raw.timeout_seconds !== undefined && raw.timeout_seconds !== null) {
    const seconds = raw.timeout_seconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1) {
      return { error: "timeout_seconds must be a whole number of seconds, at least 1." };
    }
    timeoutMs = Math.min(seconds * 1000, limits.maxTimeoutMs);
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") return { error: "reason must be a string." };
  return { language, code: raw.code, files, timeoutMs };
}

// ── outcomes ────────────────────────────────────────────────────────────────

function factsFromRow(row: ToolRunRow): ExecRunFacts {
  const outputs = readOutputs(row);
  return {
    toolRunId: row.id,
    runId: row.remoteRunId,
    context: "hosted_sandbox",
    language: row.language as ExecLanguage,
    status: row.status as ToolRunStatus,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdoutBytes: row.stdoutBytes ?? 0,
    stderrBytes: row.stderrBytes ?? 0,
    files: outputs.files,
    skippedFiles: outputs.skipped,
    finishedLate: row.finishedLate,
    skillVersionId: row.skillVersionId,
    skillSlug: row.skillVersionId ? (/\/skills\/([a-z0-9][a-z0-9-]{0,63})/.exec(readCode(row))?.[1] ?? null) : null,
    skillBundleDigest: row.skillBundleDigest,
  };
}

function outcomeStatus(status: ToolRunStatus): ExecToolOutcome["status"] {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "outcome_unknown":
      return "outcome_unknown";
    case "queued":
    case "running":
      return "running";
    default:
      return "failed";
  }
}

function errorFor(status: ToolRunStatus): { code: ExecErrorCode } | undefined {
  switch (status) {
    case "failed":
      return { code: "program_failed" };
    case "timed_out":
      return { code: "timed_out" };
    case "cancelled":
      return { code: "cancelled" };
    case "outcome_unknown":
      return { code: "outcome_unknown" };
    case "refused":
      return { code: "sandbox_error" };
    default:
      return undefined;
  }
}

function feeFor(row: Pick<ToolRunRow, "durationMs" | "startedAt">): number {
  if (!row.startedAt) return 0;
  return Math.round(Math.max(1, (row.durationMs ?? 0) / 1000) * runCodeMicroUsdPerSecond());
}

/** The outcome of a settled (or still running) row, as the model reads it. */
export async function outcomeFromRow(
  row: ToolRunRow,
  options: { vision?: boolean; checkRunAvailable?: boolean; replayed?: boolean; images?: ExecImage[]; surface?: ExecSurface } = {},
): Promise<ExecToolOutcome> {
  const facts = factsFromRow(row);
  const outputs = readOutputs(row);
  const images = options.images ?? (options.vision && options.replayed ? await reloadImages(outputs.images, row.userId) : []);
  const stdoutParts = readTail(row.stdoutTail);
  const stderrParts = readTail(row.stderrTail);
  const slice = (parts: { head: string; tail: string }, bytes: number): StreamSlice => ({
    ...parts,
    bytes: Math.max(bytes, Buffer.byteLength(parts.head) + Buffer.byteLength(parts.tail)),
  });
  const manifest = row.status === "failed" ? await execManifest().catch(() => null) : null;
  const text = outcomeText({
    status: facts.status,
    language: facts.language,
    surface: (options.surface ?? row.surface) as ExecSurface,
    toolRunId: row.id,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdout: slice(stdoutParts, row.stdoutBytes ?? 0),
    stderr: slice(stderrParts, row.stderrBytes ?? 0),
    files: outputs.files,
    skippedFiles: outputs.skipped,
    imagesAttached: images.length,
    hostError: row.error,
    packages: manifest?.pythonPackages ?? null,
    finishedLate: row.finishedLate,
    checkRunAvailable: options.checkRunAvailable ?? true,
  });
  const prefixed = options.replayed ? `${text}\n\n(This is the recorded result of this exact call; it was not run again.)` : text;
  return {
    status: outcomeStatus(facts.status),
    text: prefixed,
    body: prefixed,
    ...(images.length ? { images } : {}),
    ...(errorFor(facts.status) ? { error: errorFor(facts.status) } : {}),
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    feeMicroUsd: feeFor(row),
    run: facts,
    ...(options.replayed ? { replayed: true } : {}),
  };
}

// ── inputs and skills ───────────────────────────────────────────────────────

/** Per process: which attachments a host session already holds, so a file goes up once. */
const uploaded = new Map<string, Set<string>>();

async function uploadInputs(
  client: JunoExecClient,
  remoteSession: string,
  inputs: readonly ExecInputFile[],
  signal?: AbortSignal,
): Promise<Array<{ attachmentId: string; name: string; bytes: number }>> {
  const seen = uploaded.get(remoteSession) ?? new Set<string>();
  uploaded.set(remoteSession, seen);
  if (uploaded.size > 500) uploaded.delete(uploaded.keys().next().value as string);
  const used = new Map<string, number>();
  const record: Array<{ attachmentId: string; name: string; bytes: number }> = [];
  for (const input of inputs.slice(0, EXEC_LIMITS.maxInputFiles)) {
    if (input.size > EXEC_LIMITS.maxInputBytes) continue;
    // Two attachments with one name: the later one gets " (2)" before its extension.
    const count = (used.get(input.fileName) ?? 0) + 1;
    used.set(input.fileName, count);
    const name = count === 1 ? input.fileName : input.fileName.replace(/(\.[^.]*)?$/, ` (${count})$1`);
    const key = `${input.id}:${name}`;
    if (!seen.has(key)) {
      const { bytes } = await getObjectBytes(input.storageKey);
      await client.putInput(remoteSession, name, bytes, signal);
      seen.add(key);
    }
    record.push({ attachmentId: input.id, name, bytes: input.size });
  }
  return record;
}

function skillUsed(code: string, skills: readonly SkillMount[] | undefined): SkillMount | null {
  if (!skills?.length) return null;
  return skills.find((skill) => code.includes(`/skills/${skill.slug}`)) ?? null;
}

// ── driving a run ───────────────────────────────────────────────────────────

interface DriveInput {
  client: JunoExecClient;
  row: ToolRunRow;
  lease: Lease;
  snapshot: HostRunSnapshot | null;
  surface: ExecSurface;
  vision: boolean;
  signal?: AbortSignal;
  deadline: number;
  checkRunAvailable: boolean;
  finishedLate: boolean;
  onProgress?: ExecCallContext["onProgress"];
}

/** Wait for the host run, then settle the row. Returns the outcome the model reads. */
async function drive(input: DriveInput): Promise<ExecToolOutcome> {
  const { client, row } = input;
  const remoteRunId = row.remoteRunId!;
  let lease: Lease | null = input.lease;
  let snapshot = input.snapshot;
  let failures = 0;
  let lastProgress = 0;
  const startedAt = row.startedAt?.getTime() ?? Date.now();

  while (!snapshot || !isHostTerminal(snapshot.status)) {
    if (input.signal?.aborted) return cancelAndSettle(input, lease);
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) break;
    const waitSeconds = Math.max(0, Math.min(input.onProgress ? 2 : 20, Math.floor(remaining / 1000)));
    try {
      snapshot = await client.getRun(remoteRunId, waitSeconds, input.signal);
      failures = 0;
    } catch (error) {
      if (input.signal?.aborted) return cancelAndSettle(input, lease);
      if (error instanceof ExecRefusedError && error.status === 404) {
        return settleUnknown(lease, row, "The sandbox no longer has this run, so its outcome is unknown.", input);
      }
      failures += 1;
      if (failures >= 3) break;
      await sleep(1000, input.signal);
    }
    lease = await renewLease(lease);
    if (!lease) return waitForOtherHolder(row.id, input);
    if (snapshot && input.onProgress && Date.now() - lastProgress >= 1000 && !isHostTerminal(snapshot.status)) {
      lastProgress = Date.now();
      input.onProgress({
        toolRunId: row.id,
        status: snapshot.status === "queued" ? "queued" : "running",
        stdoutTail: lastLines(snapshot.stdout),
        stderrTail: lastLines(snapshot.stderr),
        stdoutBytes: snapshot.stdoutBytes,
        stderrBytes: snapshot.stderrBytes,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: snapshot.timeoutMs,
      });
    }
  }

  if (!snapshot || !isHostTerminal(snapshot.status)) {
    // Still running (or the host stopped answering): let go, say so, and let
    // check_run or the sweep settle it. Never a success claim.
    await releaseLease(lease);
    const current = (await getToolRun(row.id)) ?? row;
    const elapsed = Date.now() - startedAt;
    const outcome = await outcomeFromRow({ ...current, status: "running", durationMs: elapsed }, {
      checkRunAvailable: input.checkRunAvailable,
    });
    if (failures >= 3) {
      const text = `${outcome.text}\n\nThe sandbox stopped answering while this ran (${formatDuration(elapsed)} in). Its outcome is not known yet.`;
      return { ...outcome, text, body: text };
    }
    return outcome;
  }
  return settleFromSnapshot(input, lease, snapshot);
}

function isHostTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "lost";
}

function lastLines(slice: HostRunSnapshot["stdout"]): string {
  const text = slice ? (slice.tail || slice.head) : "";
  return text.split("\n").slice(-20).join("\n").slice(-4000);
}

async function cancelAndSettle(input: DriveInput, lease: Lease): Promise<ExecToolOutcome> {
  const remoteRunId = input.row.remoteRunId!;
  let snapshot: HostRunSnapshot | null = null;
  try {
    snapshot = await input.client.cancel(remoteRunId);
    const deadline = Date.now() + 15_000;
    while (!isHostTerminal(snapshot.status) && Date.now() < deadline) {
      snapshot = await input.client.getRun(remoteRunId, 5);
    }
  } catch {
    snapshot = null;
  }
  if (!snapshot || !isHostTerminal(snapshot.status)) {
    // The host did not confirm. Recorded as unknown rather than as stopped.
    return settleUnknown(lease, input.row, "Stop was requested, but the sandbox did not confirm the run ended.", input);
  }
  return settleFromSnapshot({ ...input, signal: undefined }, lease, snapshot);
}

async function settleUnknown(lease: Lease, row: ToolRunRow, reason: string, input: Pick<DriveInput, "checkRunAvailable">): Promise<ExecToolOutcome> {
  await settleToolRun(lease, row.id, {
    status: "outcome_unknown",
    exitCode: null,
    durationMs: row.startedAt ? Date.now() - row.startedAt.getTime() : null,
    stdoutBytes: row.stdoutBytes ?? 0,
    stderrBytes: row.stderrBytes ?? 0,
    stdoutTail: row.stdoutTail,
    stderrTail: row.stderrTail,
    error: reason,
    logKey: row.logKey,
    outputs: readOutputs(row),
  });
  const settled = (await getToolRun(row.id)) ?? row;
  return outcomeFromRow(settled, { checkRunAvailable: input.checkRunAvailable });
}

async function waitForOtherHolder(id: string, input: Pick<DriveInput, "deadline" | "signal" | "checkRunAvailable" | "vision">): Promise<ExecToolOutcome> {
  let row = await getToolRun(id);
  while (row && !isTerminal(row.status) && Date.now() < input.deadline && !input.signal?.aborted) {
    await sleep(1000, input.signal);
    row = await getToolRun(id);
  }
  if (!row) return refused("not_found", "That run no longer exists.");
  if (!isTerminal(row.status)) {
    return outcomeFromRow({ ...row, status: "running" }, { checkRunAvailable: input.checkRunAvailable });
  }
  return outcomeFromRow(row, { checkRunAvailable: input.checkRunAvailable, vision: input.vision, replayed: true });
}

async function settleFromSnapshot(input: DriveInput, lease: Lease, snapshot: HostRunSnapshot): Promise<ExecToolOutcome> {
  const { client, row } = input;
  if (snapshot.status === "lost") {
    return settleUnknown(lease, row, "The sandbox restarted while this ran, so its outcome is unknown.", input);
  }
  // The full snapshot (with the stream slices) for a terminal run.
  if (!snapshot.stdout || !snapshot.stderr) snapshot = await client.getRun(snapshot.id, 0);
  const status = snapshot.status as ToolRunStatus;
  let files: ExecRunFacts["files"] = [];
  let skipped: ExecRunFacts["skippedFiles"] = [];
  let images: ExecImage[] = [];
  if (status === "cancelled") {
    skipped = (snapshot.files ?? []).map((file) => ({ name: file.path, bytes: file.bytes, reason: "discarded because the run was stopped" }));
  } else {
    const captured = await captureOutputs({
      client,
      run: snapshot,
      toolRunId: row.id,
      userId: row.userId,
      surface: input.surface,
      conversationId: row.conversationId,
      workRunId: row.workRunId,
      vision: input.vision,
    });
    files = captured.files;
    skipped = captured.skipped;
    images = captured.images;
  }
  const logKey = await storeFullLogs({ client, run: snapshot, userId: row.userId, toolRunId: row.id }).catch(() => null);
  const settledOk = await settleToolRun(lease, row.id, {
    status,
    exitCode: snapshot.exitCode,
    durationMs: snapshot.durationMs,
    stdoutBytes: snapshot.stdoutBytes,
    stderrBytes: snapshot.stderrBytes,
    stdoutTail: storedTail(snapshot.stdout),
    stderrTail: storedTail(snapshot.stderr),
    error: snapshot.error,
    logKey,
    outputs: { files, skipped, images: files.filter((file) => file.kind === "IMAGE").map((file) => file.attachmentId) },
    finishedLate: input.finishedLate,
  });
  const settled = (await getToolRun(row.id)) ?? row;
  if (!settledOk && !isTerminal(settled.status)) {
    return outcomeFromRow({ ...settled, status: "running" }, { checkRunAvailable: input.checkRunAvailable });
  }
  await meter(settled);
  return outcomeFromRow(settled, { checkRunAvailable: input.checkRunAvailable, images, surface: input.surface });
}

async function meter(row: ToolRunRow): Promise<void> {
  if (!row.startedAt || !(await claimMetering(row.id))) return;
  const microUsd = feeFor(row);
  await recordSpend({
    userId: row.userId,
    model: "juno-tool:run_code",
    kind: row.surface === "work" ? "work" : "chat",
    costUsd: microUsd / 1_000_000,
    idempotencyKey: `tool-run:${row.id}`,
  });
}

// ── run_code ────────────────────────────────────────────────────────────────

export interface RunCodeOptions {
  /** Whether check_run is attached on this surface (it says so in the text). */
  checkRunAvailable?: boolean;
}

export async function executeRunCode(
  raw: Record<string, unknown>,
  ctx: ExecCallContext,
  options: RunCodeOptions = {},
): Promise<ExecToolOutcome> {
  const checkRunAvailable = options.checkRunAvailable ?? true;
  const parsed = parseRunCodeArgs(raw, ctx.surface);
  if ("error" in parsed) return refused("invalid_arguments", parsed.error);
  if (ctx.private) {
    return refused("capability_unavailable", "Code does not run in private chats, because what it produces would have to be kept. Nothing was run.");
  }
  const endpoint = execEndpoint();
  if (!endpoint) {
    return refused("capability_unavailable", "The code sandbox is not available on this server, so nothing was run. Tell the user that code cannot be run right now.");
  }
  if (ctx.lockdown ?? (await lockdownEnabled(ctx.userId))) {
    return refused("capability_unavailable", "Code execution is off while lockdown mode is on. Nothing was run.");
  }
  const runBudget = ctx.surface === "work" ? 100 : EXEC_LIMITS.runsPerTurn;
  const client = new JunoExecClient(endpoint);
  const remoteSession = hostSessionId(ctx.surface, ctx.sessionId);
  const argsDigest = runArgsDigest(parsed);

  // Inputs: named files resolve against what this conversation (or run) may read.
  const available = ctx.inputs
    ? await ctx.inputs()
    : await conversationAttachments({ userId: ctx.userId, conversationId: ctx.conversationId, projectId: ctx.projectId });
  let inputs: ExecInputFile[] = available;
  if (parsed.files?.length) {
    inputs = [];
    for (const reference of parsed.files) {
      const { match, ambiguous } = matchAttachment(available, reference);
      if (!match) {
        return refused(
          "invalid_arguments",
          ambiguous.length > 1
            ? `"${reference}" matches more than one attached file (${nameList(ambiguous)}). Name it exactly.`
            : `No attached file matches "${reference}". ${available.length ? `Attached: ${nameList(available)}.` : "No files are attached."}`,
        );
      }
      inputs.push(match);
    }
  }

  const skill = skillUsed(parsed.code, ctx.skills);
  const claim = await claimToolRun({
    userId: ctx.userId,
    surface: ctx.surface,
    sessionId: ctx.sessionId,
    callId: ctx.callId,
    argsDigest,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    workRunId: ctx.workRunId ?? null,
    language: parsed.language,
    codeDigest: codeDigest(parsed.code),
    code: parsed.code,
    skillVersionId: skill?.skillVersionId ?? null,
    skillBundleDigest: skill?.bundleDigest ?? null,
    remoteSession,
  });
  const vision = !!ctx.vision;
  const deadline = Date.now() + surfaceLimits(ctx.surface).inlineWaitMs;
  if (!claim.created && isTerminal(claim.row.status)) {
    return outcomeFromRow(claim.row, { vision, checkRunAvailable, replayed: true });
  }
  if (!claim.lease) return waitForOtherHolder(claim.row.id, { deadline, signal: ctx.signal, checkRunAvailable, vision });
  let lease: Lease = claim.lease;
  let row = claim.row;

  if (claim.created && (await countSessionRuns(ctx.sessionId)) > runBudget) {
    await settleToolRun(lease, row.id, refusedSettlement(`More than ${runBudget} runs in one turn.`));
    return refused("capability_unavailable", `This turn has already run code ${runBudget} times, which is the limit. Nothing more was run; answer with what you have.`);
  }

  let snapshot: HostRunSnapshot | null = null;
  if (!row.remoteRunId) {
    try {
      const inputRecord = await uploadInputs(client, remoteSession, inputs, ctx.signal);
      await recordInputs(row.id, inputRecord);
      const skillSlugs: string[] = [];
      for (const mount of ctx.skills ?? []) {
        await client.putSkill(remoteSession, mount.slug, await mount.openBundle(), ctx.signal);
        skillSlugs.push(mount.slug);
      }
      snapshot = await client.startRun(
        {
          session: remoteSession,
          account: hostAccountId(ctx.userId),
          language: parsed.language,
          code: parsed.code,
          timeoutMs: parsed.timeoutMs,
          ...(skillSlugs.length ? { skills: skillSlugs } : {}),
        },
        hostIdempotencyKey(ctx.surface, ctx.sessionId, ctx.callId, argsDigest),
        ctx.signal,
      );
    } catch (error) {
      if (ctx.signal?.aborted) {
        // Stopped before the host confirmed a start. The same key is safe to
        // reuse, but nobody is waiting, so nothing is started on our behalf.
        await settleToolRun(lease, row.id, refusedSettlement("Stopped before the run started."));
        const text = "Stopped before the run started. Nothing was run.";
        return { status: "cancelled", text, body: text, error: { code: "cancelled" } };
      }
      if (error instanceof ExecUnavailableError && error.ambiguous) {
        // The request may have reached the host. Leave the row for the sweep
        // (or an identical retry, which the host's key turns into the same run).
        await releaseLease(lease);
        const text = "The sandbox did not confirm whether this run started, so its outcome is unknown. Do not say it ran; it will not be run again automatically.";
        return { status: "outcome_unknown", text, body: text, error: { code: "outcome_unknown" } };
      }
      const reason =
        error instanceof ExecRefusedError
          ? `The sandbox refused the run: ${error.message}`
          : error instanceof ExecUnavailableError
            ? "The code sandbox is not reachable right now, so nothing was run."
            : `The run could not be started: ${error instanceof Error ? error.message : String(error)}`;
      await settleToolRun(lease, row.id, refusedSettlement(reason));
      return refused(error instanceof ExecUnavailableError ? "capability_unavailable" : "sandbox_error", `${reason} Tell the user plainly; nothing was run.`);
    }
    if (!(await markStarted(lease, snapshot.id))) return waitForOtherHolder(row.id, { deadline, signal: ctx.signal, checkRunAvailable, vision });
    row = (await getToolRun(row.id)) ?? row;
    lease = (await renewLease(lease)) ?? lease;
  }

  return drive({
    client,
    row,
    lease,
    snapshot,
    surface: ctx.surface,
    vision,
    signal: ctx.signal,
    deadline,
    checkRunAvailable,
    finishedLate: false,
    onProgress: ctx.onProgress,
  });
}

function refusedSettlement(reason: string) {
  return {
    status: "refused" as const,
    exitCode: null,
    durationMs: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: null,
    stderrTail: null,
    error: reason,
    logKey: null,
    outputs: { files: [], skipped: [], images: [] },
  };
}

// ── check_run ───────────────────────────────────────────────────────────────

export function parseCheckRunArgs(raw: Record<string, unknown>): Required<Pick<CheckRunArgs, "run_id" | "wait_seconds">> & Pick<CheckRunArgs, "stream" | "offset"> | { error: string } {
  const allowed = new Set(["run_id", "wait_seconds", "stream", "offset"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.` };
  if (typeof raw.run_id !== "string" || !/^[a-z0-9]{10,40}$/.test(raw.run_id)) return { error: "run_id must be the run id run_code returned." };
  let wait = 30;
  if (raw.wait_seconds !== undefined) {
    if (typeof raw.wait_seconds !== "number" || !Number.isInteger(raw.wait_seconds) || raw.wait_seconds < 0) {
      return { error: "wait_seconds must be a whole number between 0 and 60." };
    }
    wait = Math.min(60, raw.wait_seconds);
  }
  if (raw.stream !== undefined && raw.stream !== "stdout" && raw.stream !== "stderr") return { error: 'stream must be "stdout" or "stderr".' };
  if (raw.offset !== undefined && (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    return { error: "offset must be a whole number of bytes, at least 0." };
  }
  return { run_id: raw.run_id, wait_seconds: wait, stream: raw.stream as CheckRunArgs["stream"], offset: raw.offset as number | undefined };
}

export async function executeCheckRun(raw: Record<string, unknown>, ctx: ExecCallContext): Promise<ExecToolOutcome> {
  const parsed = parseCheckRunArgs(raw);
  if ("error" in parsed) return refused("invalid_arguments", parsed.error);
  const row = await findOwnRun({
    userId: ctx.userId,
    toolRunId: parsed.run_id,
    conversationId: ctx.conversationId,
    workRunId: ctx.workRunId ?? null,
  });
  if (!row) return refused("not_found", `There is no run "${parsed.run_id}" in this conversation.`);
  const vision = !!ctx.vision;

  if (parsed.stream) return pageOutput(row, parsed.stream, parsed.offset ?? 0);

  if (isTerminal(row.status)) {
    const images = vision ? await reloadImages(readOutputs(row).images, row.userId) : [];
    return outcomeFromRow(row, { vision, checkRunAvailable: true, images });
  }

  const deadline = Date.now() + parsed.wait_seconds * 1000;
  const lease = await takeExpiredLease(row.id);
  const endpoint = execEndpoint();
  if (!lease || !endpoint || !row.remoteRunId) {
    return waitForOtherHolder(row.id, { deadline, signal: ctx.signal, checkRunAvailable: true, vision });
  }
  return drive({
    client: new JunoExecClient(endpoint),
    row: (await getToolRun(row.id)) ?? row,
    lease,
    snapshot: null,
    surface: row.surface as ExecSurface,
    vision,
    signal: ctx.signal,
    deadline,
    checkRunAvailable: true,
    finishedLate: false,
    onProgress: ctx.onProgress,
  });
}

/** One page of a stream: from the stored log, the host, or the row's own tails. */
async function pageOutput(row: ToolRunRow, stream: "stdout" | "stderr", offset: number): Promise<ExecToolOutcome> {
  const total = (stream === "stdout" ? row.stdoutBytes : row.stderrBytes) ?? 0;
  const pageBytes = EXEC_LIMITS.pageChars;
  let bytes: Uint8Array | null = null;
  if (row.logKey) {
    try {
      bytes = (await getObjectBytes(`${row.logKey}${stream}.log`)).bytes.subarray(offset, offset + pageBytes);
    } catch {
      bytes = null;
    }
  }
  if (!bytes && row.remoteRunId) {
    const endpoint = execEndpoint();
    if (endpoint) {
      try {
        bytes = (await new JunoExecClient(endpoint).output(row.remoteRunId, stream, offset, pageBytes)).bytes;
      } catch {
        bytes = null;
      }
    }
  }
  if (!bytes) {
    const parts = readTail(stream === "stdout" ? row.stdoutTail : row.stderrTail);
    bytes = Buffer.from(parts.tail ? `${parts.head}\n[…]\n${parts.tail}` : parts.head).subarray(offset, offset + pageBytes);
  }
  const text = Buffer.from(bytes).toString("utf8");
  const next = offset + bytes.byteLength;
  const more = next < total ? `\n\n[Bytes ${offset}–${next} of ${total}. Next page: check_run with run_id "${row.id}", stream "${stream}", offset ${next}.]` : `\n\n[Bytes ${offset}–${next} of ${total}; this is the end.]`;
  const body = `${stream} of ${languageLabel(row.language as ExecLanguage)} run ${row.id}:\n${text}${more}`;
  return { status: "succeeded", text: body, body, run: factsFromRow(row) };
}

// ── sweep (inside juno-work-scheduler; no new process) ──────────────────────

export interface SweepResult {
  examined: number;
  finishedLate: number;
  unknown: number;
  stillRunning: number;
}

/**
 * Settle rows whose lease lapsed: the turn that started them ended (Stop
 * aside), the process died, or the call answered "still running" and nobody
 * came back. A run the host finished is collected ("finished later") and its
 * files attached; a run the host does not have, or has as `lost`, becomes
 * `outcome_unknown`. Nothing is started, and nothing is re-run.
 */
export async function sweepToolRuns(options: { now?: Date; limit?: number } = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const result: SweepResult = { examined: 0, finishedLate: 0, unknown: 0, stillRunning: 0 };
  const rows = await findAbandonedRuns(now, options.limit ?? 20);
  const endpoint = execEndpoint();
  for (const candidate of rows) {
    const lease = await takeExpiredLease(candidate.id, now);
    if (!lease) continue;
    result.examined += 1;
    const row = (await getToolRun(candidate.id)) ?? candidate;
    if (!endpoint || !row.remoteRunId) {
      await settleUnknown(lease, row, row.remoteRunId
        ? "The code sandbox is no longer configured, so this run's outcome is unknown."
        : "The server stopped following this run before the sandbox confirmed it started, so its outcome is unknown.", { checkRunAvailable: false });
      result.unknown += 1;
      continue;
    }
    const client = new JunoExecClient(endpoint);
    let snapshot: HostRunSnapshot;
    try {
      snapshot = await client.getRun(row.remoteRunId, 0);
    } catch (error) {
      if (error instanceof ExecRefusedError && error.status === 404) {
        await settleUnknown(lease, row, "The sandbox no longer has this run, so its outcome is unknown.", { checkRunAvailable: false });
        result.unknown += 1;
      } else if (Date.now() - row.createdAt.getTime() > 2 * 60 * 60_000) {
        await settleUnknown(lease, row, "The sandbox could not be reached for two hours, so this run's outcome is unknown.", { checkRunAvailable: false });
        result.unknown += 1;
      } else {
        await releaseLease(lease);
        result.stillRunning += 1;
      }
      continue;
    }
    if (!isHostTerminal(snapshot.status)) {
      await releaseLease(lease);
      result.stillRunning += 1;
      continue;
    }
    const outcome = await settleFromSnapshot(
      {
        client,
        row,
        lease,
        snapshot,
        surface: row.surface as ExecSurface,
        vision: false,
        deadline: Date.now(),
        checkRunAvailable: false,
        finishedLate: true,
      },
      lease,
      snapshot,
    );
    if (outcome.status === "outcome_unknown") result.unknown += 1;
    else result.finishedLate += 1;
  }
  return result;
}

/** History note for later turns (SPEC §4.9): what earlier runs did. */
export function historyNote(facts: ExecRunFacts): string {
  return runSummary({ language: facts.language, status: facts.status, exitCode: facts.exitCode, files: facts.files });
}

