"use client";

import type {
  ClientSkillSource,
  LibrarySkill,
  LibrarySource,
  SkillLibrary,
  SkillSourceChange,
  SkillSourcePatch,
  SkillSourceRemoval,
  SkillSourceUpdateCheck,
  SkillSourceUpdateRequest,
  SkillSourceUpdateResult,
} from "@/lib/skills/library-contract";
import type { ClientWorkSkill, ClientWorkSkillVersion, SkillResource } from "@/lib/work/skills";
import type {
  GithubSkillPreview,
  GithubSkillProblem,
  WorkBlocked,
  WorkResult,
  WorkSkillDetail,
  WorkTransportFailure,
} from "@/components/work/work-transport";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Everything the skills library asks the server for.
 *
 *   GET    /api/skills                         → SkillLibrary
 *   PATCH  /api/skills/sources/[id]            { enabled } → { source }
 *   DELETE /api/skills/sources/[id]            → { removed }
 *   POST   /api/skills/sources/[id]/check      → SkillSourceUpdateCheck
 *   POST   /api/skills/sources/[id]/update     { commit, update[], install[] } → SkillSourceUpdateResult
 *   POST   /api/skills/import/github           { source }                         → preview
 *                                              { source, commit, paths, renames } → 201 import
 *
 * The one-skill endpoints (`/api/work/skills/[id]`, its versions and consent)
 * keep their transport in work-transport.tsx and are re-exported below, so a
 * skills surface imports from one place.
 *
 * THE SAME RESULT SHAPE AS WORK. `WorkResult` already separates the two
 * answers a caller has to treat differently: a refusal the server explained
 * (409/429, `blocked`, with its sentence) and a failure the reader can only
 * retry (`failed`, with a cause). Reusing it means a page can hand either
 * straight to the same note components Work draws. Every reader here is
 * tolerant for the same reason Work's are: the library endpoints are new, a
 * deployment can be a step ahead of this bundle, and a field this build does
 * not recognise must not take the page down with it.
 */

async function body(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function list<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * A non-OK response as the typed refusal or failure behind it.
 *
 * The same mapping as Work's (see `refusal` in work-transport.tsx), restated
 * rather than imported because that one is private to its module: 409 and 429
 * carry a decision with the server's sentence attached, 401/403 are a
 * sign-in, 404 is a dead link (or an endpoint this deployment does not have
 * yet), 400 is this client's fault and not worth a retry, and anything else is
 * worth one.
 */
async function refusal(res: Response): Promise<WorkBlocked | WorkTransportFailure> {
  const data = await body(res);
  const message = text(data, "message");
  if (res.status === 409 || res.status === 429) {
    return {
      kind: "blocked",
      reason: text(data, "error") ?? "unavailable",
      explanation: message ?? `${PRODUCT_NAME} can’t do that right now. Try again in a moment.`,
      missing: [],
      degradation: [],
    };
  }
  if (res.status === 401 || res.status === 403) return { kind: "failed", cause: "unauthorized", message };
  if (res.status === 404) return { kind: "failed", cause: "not_found", message };
  return { kind: "failed", cause: res.status === 400 ? "rejected" : "server", message };
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // No body at all rather than a JSON `null` for GET and DELETE: the route
      // handlers read `null` as a parse failure.
      ...(payload === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
  } catch {
    return { kind: "failed", cause: "offline", message: null };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

/**
 * The sentence to put in front of a reader for a result that did not succeed.
 *
 * The server's own words when it wrote some; otherwise one sentence per cause,
 * with `fallback` for the plain server failure because only the caller knows
 * what did not happen.
 */
export function skillsFailureMessage(result: WorkBlocked | WorkTransportFailure, fallback: string): string {
  if (result.kind === "blocked") return result.explanation;
  if (result.message) return result.message;
  if (result.cause === "offline") return `Couldn’t reach ${PRODUCT_NAME}. Check your connection and try again.`;
  if (result.cause === "unauthorized") return "Your session has ended. Sign in again to continue.";
  return fallback;
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

function librarySkills(raw: unknown): LibrarySkill[] {
  return list<LibrarySkill>(raw).flatMap((skill) =>
    record(skill) === null || typeof skill.id !== "string" ? [] : [skill]
  ).map((skill) => ({
    ...skill,
    sourceId: typeof skill.sourceId === "string" ? skill.sourceId : null,
    sourcePath: typeof skill.sourcePath === "string" ? skill.sourcePath : null,
    requiresConsent: skill.requiresConsent === true,
  }));
}

function librarySources(raw: unknown): LibrarySource[] {
  return list<LibrarySource>(raw).flatMap((source) => {
    if (record(source) === null || typeof source.id !== "string") return [];
    return [
      {
        ...source,
        latestCommit: typeof source.latestCommit === "string" ? source.latestCommit : null,
        enabled: source.enabled !== false,
        path: typeof source.path === "string" ? source.path : "",
        skills: librarySkills(source.skills),
      },
    ];
  });
}

export function fetchSkillLibrary(): Promise<WorkResult<SkillLibrary>> {
  return request("GET", "/api/skills", undefined, (data) => {
    const yours = librarySkills(data.yours);
    const sources = librarySources(data.sources);
    const listed = yours.length + sources.reduce((sum, source) => sum + source.skills.length, 0);
    return {
      yours,
      sources,
      total: typeof data.total === "number" ? data.total : listed,
      truncated: data.truncated === true,
    };
  });
}

export function patchSkillSource(id: string, patch: SkillSourcePatch): Promise<WorkResult<ClientSkillSource>> {
  return request("PATCH", `/api/skills/sources/${id}`, patch, (data) => data.source as ClientSkillSource);
}

export function removeSkillSource(id: string): Promise<WorkResult<SkillSourceRemoval>> {
  return request("DELETE", `/api/skills/sources/${id}`, undefined, (data) => ({
    removed: typeof data.removed === "number" ? data.removed : 0,
  }));
}

function changes(raw: unknown): SkillSourceChange[] {
  return list<SkillSourceChange>(raw).filter((change) => typeof change?.path === "string");
}

export function checkSkillSource(id: string): Promise<WorkResult<SkillSourceUpdateCheck>> {
  return request("POST", `/api/skills/sources/${id}/check`, {}, (data) => ({
    source: data.source as ClientSkillSource,
    latestCommit: text(data, "latestCommit") ?? "",
    upToDate: data.upToDate === true,
    changed: changes(data.changed),
    added: changes(data.added),
    removed: changes(data.removed),
    more: data.more === true,
  }));
}

export function updateSkillSource(
  id: string,
  input: SkillSourceUpdateRequest
): Promise<WorkResult<SkillSourceUpdateResult>> {
  return request("POST", `/api/skills/sources/${id}/update`, input, (data) => ({
    source: data.source as ClientSkillSource,
    updated: librarySkills(data.updated),
    installed: librarySkills(data.installed),
    skipped: list<{ path: string; reason: string }>(data.skipped),
  }));
}

// ---------------------------------------------------------------------------
// Importing from GitHub
// ---------------------------------------------------------------------------

/**
 * A skill in a repository, as the importer previews it.
 *
 * The three library fields are what let the choose step say something useful
 * about a repository the reader has partly installed already: `installed`
 * rows are shown and not offered, and a `slugTaken` row is offered with its
 * `suggestedSlug` in an editable field instead of being skipped at the end.
 * `securityStatus` is read when the server sends it, so a blocked skill can
 * start unticked; without it every row starts ticked and the import reports
 * how many landed blocked.
 */
export interface SkillImportCandidate extends GithubSkillPreview {
  installed: boolean;
  slugTaken: boolean;
  suggestedSlug: string | null;
  securityStatus: string | null;
}

/**
 * Where a non-GitHub import came from, as the choose step names it: the file,
 * the link's host, or "Pasted SKILL.md".
 */
export interface SkillImportOrigin {
  kind: "file" | "url" | "paste";
  label: string;
  url?: string;
}

/**
 * What a file import sends, kept by the dialog between preview and import
 * because the server holds no copy in between (see the package route).
 */
export type SkillPackagePayload = { kind: "file"; file: File } | { kind: "url"; url: string } | { kind: "paste"; markdown: string };

export interface SkillImportPreview {
  /** A GitHub walk. Null for a file, a link or a paste, which carry `origin`. */
  repository: { owner: string; repo: string; ref: string; commit: string; url: string } | null;
  origin?: SkillImportOrigin;
  /** The exact package reviewed, checked again before installing. */
  digest?: string;
  skills: SkillImportCandidate[];
  problems: GithubSkillProblem[];
  /** The walk stopped before the end of the repository. */
  more: boolean;
  /**
   * Every `SKILL.md` in scope, read or not: what "the first 100 of N" says.
   * Null from a server that does not send it.
   */
  total: number | null;
  /** The read used the reader's own GitHub connection. */
  connected: boolean;
}

function candidates(raw: unknown): SkillImportCandidate[] {
  return list<Record<string, unknown>>(raw).flatMap((entry) => {
    if (record(entry) === null || typeof entry.path !== "string") return [];
    const strings = (key: string) => list<unknown>(entry[key]).filter((v): v is string => typeof v === "string");
    return [
      {
        path: entry.path,
        directory: typeof entry.directory === "string" ? entry.directory : "",
        slug: typeof entry.slug === "string" ? entry.slug : entry.path,
        name: typeof entry.name === "string" ? entry.name : String(entry.slug ?? entry.path),
        description: typeof entry.description === "string" ? entry.description : "",
        license: typeof entry.license === "string" ? entry.license : null,
        compatibility: typeof entry.compatibility === "string" ? entry.compatibility : null,
        instructionChars: typeof entry.instructionChars === "number" ? entry.instructionChars : 0,
        requestedTools: strings("requestedTools"),
        droppedTools: strings("droppedTools"),
        hostKeys: strings("hostKeys"),
        ignoredKeys: strings("ignoredKeys"),
        companionFiles: strings("companionFiles"),
        url: typeof entry.url === "string" ? entry.url : "",
        installed: entry.installed === true,
        slugTaken: entry.slugTaken === true,
        suggestedSlug: typeof entry.suggestedSlug === "string" ? entry.suggestedSlug : null,
        securityStatus: typeof entry.securityStatus === "string" ? entry.securityStatus : null,
      },
    ];
  });
}

/** Walks a repository and reports what is in it. Writes nothing. */
export function previewSkillImport(source: string): Promise<WorkResult<SkillImportPreview>> {
  return request("POST", "/api/skills/import/github", { source }, (data) => ({
    repository: data.repository as SkillImportPreview["repository"],
    skills: candidates(data.skills),
    problems: list<GithubSkillProblem>(data.problems),
    more: data.more === true,
    total: typeof data.total === "number" ? data.total : null,
    connected: data.connected === true,
  }));
}

export interface SkillImportRequest {
  source: string;
  /** The commit the preview read, so the import takes the bytes the reader was shown. */
  commit: string;
  paths: string[];
  /** A new slash name for a path whose own one is taken, keyed by `SKILL.md` path. */
  renames: Record<string, string>;
}

export interface SkillImportOutcome {
  imported: ClientWorkSkill[];
  skipped: { path: string; slug: string; reason: string; message: string }[];
  problems: GithubSkillProblem[];
  /** How many landed switched off because the scanner refused them. */
  blocked: number;
  /** The source the skills were installed into, when the server says. */
  source: ClientSkillSource | null;
  repository: { owner: string; repo: string } | null;
}

export function importSkills(input: SkillImportRequest): Promise<WorkResult<SkillImportOutcome>> {
  return request(
    "POST",
    "/api/skills/import/github",
    {
      source: input.source,
      commit: input.commit,
      paths: input.paths,
      // Omitted when empty, so a server from before renames existed reads the
      // body it always has.
      ...(Object.keys(input.renames).length > 0 ? { renames: input.renames } : {}),
    },
    (data) => {
      const repository = record(data.repository);
      return {
        imported: list<ClientWorkSkill>(data.imported),
        skipped: list<SkillImportOutcome["skipped"][number]>(data.skipped),
        problems: list<GithubSkillProblem>(data.problems),
        blocked: typeof data.blocked === "number" ? data.blocked : 0,
        source: record(data.source) ? (data.source as ClientSkillSource) : null,
        repository:
          repository && typeof repository.owner === "string" && typeof repository.repo === "string"
            ? { owner: repository.owner, repo: repository.repo }
            : null,
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Importing from a file, a link or a paste
// ---------------------------------------------------------------------------

async function packageRequest<T>(
  payload: SkillPackagePayload,
  choice: { paths?: string[]; renames?: Record<string, string>; digest?: string },
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  let init: RequestInit;
  if (payload.kind === "file") {
    const form = new FormData();
    form.set("file", payload.file);
    if (choice.digest) form.set("digest", choice.digest);
    if (choice.paths) form.set("paths", JSON.stringify(choice.paths));
    if (choice.renames && Object.keys(choice.renames).length > 0) form.set("renames", JSON.stringify(choice.renames));
    init = { method: "POST", body: form };
  } else {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(payload.kind === "url" ? { url: payload.url } : { markdown: payload.markdown }),
        ...(choice.paths ? { paths: choice.paths } : {}),
        ...(choice.digest ? { digest: choice.digest } : {}),
        ...(choice.renames && Object.keys(choice.renames).length > 0 ? { renames: choice.renames } : {}),
      }),
    };
  }
  let res: Response;
  try {
    res = await fetch("/api/skills/import/package", init);
  } catch {
    return { kind: "failed", cause: "offline", message: null };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

function originOf(raw: unknown): SkillImportOrigin | undefined {
  const origin = record(raw);
  if (!origin || typeof origin.label !== "string") return undefined;
  const kind = origin.kind === "file" || origin.kind === "url" || origin.kind === "paste" ? origin.kind : "file";
  return { kind, label: origin.label, ...(typeof origin.url === "string" ? { url: origin.url } : {}) };
}

/** Reads a SKILL.md, a .zip / .skill package, or a link to either. Writes nothing. */
export function previewSkillPackage(payload: SkillPackagePayload): Promise<WorkResult<SkillImportPreview>> {
  return packageRequest(payload, {}, (data) => ({
    repository: null,
    origin: originOf(data.origin),
    digest: typeof data.digest === "string" ? data.digest : undefined,
    skills: candidates(data.skills),
    problems: list<GithubSkillProblem>(data.problems),
    more: data.more === true,
    total: typeof data.total === "number" ? data.total : null,
    connected: false,
  }));
}

export function importSkillPackage(
  payload: SkillPackagePayload,
  input: { paths: string[]; renames: Record<string, string>; digest?: string }
): Promise<WorkResult<SkillImportOutcome>> {
  return packageRequest(payload, input, (data) => ({
    imported: list<ClientWorkSkill>(data.imported),
    skipped: list<SkillImportOutcome["skipped"][number]>(data.skipped),
    problems: list<GithubSkillProblem>(data.problems),
    blocked: typeof data.blocked === "number" ? data.blocked : 0,
    source: null,
    repository: null,
  }));
}

/** Where a skill downloads as a portable file. */
export function skillExportHref(id: string, format: "md" | "zip" = "md"): string {
  return `/api/work/skills/${encodeURIComponent(id)}/export${format === "zip" ? "?format=zip" : ""}`;
}

// ---------------------------------------------------------------------------
// One skill: unchanged endpoints, re-exported so a skills surface has one import
// ---------------------------------------------------------------------------

export {
  consentWorkSkillVersion as consentSkillVersion,
  createWorkSkill as createSkill,
  deleteWorkSkill as deleteSkill,
  fetchWorkSkillVersions as fetchSkillVersions,
  mintWorkSkillVersion as mintSkillVersion,
  patchWorkSkill as patchSkill,
  type PatchWorkSkillInput as PatchSkillInput,
} from "@/components/work/work-transport";

/**
 * One skill as its page reads it: Work's detail, plus the source it was
 * installed from.
 *
 * Read here rather than through Work's `fetchWorkSkill`, which predates
 * sources and drops the field: without it the page showed a skill as On while
 * its repository was switched off, so chat refused it and the composer did not
 * list it, and nothing on the page said why.
 */
export type SkillDetail = WorkSkillDetail & { source: ClientSkillSource | null };

export function fetchSkill(id: string): Promise<WorkResult<SkillDetail>> {
  return request("GET", `/api/work/skills/${id}`, undefined, (data) => ({
    skill: data.skill as ClientWorkSkill,
    version: (data.version as ClientWorkSkillVersion | null) ?? null,
    resources: list<SkillResource>(data.resources),
    projectName: typeof data.projectName === "string" ? data.projectName : null,
    source: record(data.source) ? (data.source as ClientSkillSource) : null,
  }));
}
