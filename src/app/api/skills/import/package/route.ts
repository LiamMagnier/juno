/**
 * Importing skills from a FILE: an uploaded SKILL.md or .zip / .skill
 * package, a pasted SKILL.md, or a link to either on any public host.
 *
 * The same two steps as the GitHub importer (whose header explains why): a
 * body with no `paths` is a PREVIEW, a body with `paths` IMPORTS those. There
 * is no server-side copy between them, so the client sends the same file (or
 * text, or link) with both; for a link the server fetches it again, which is
 * the GitHub route's "re-read the files" rule, and for an upload the bytes are
 * the reader's own file on their own disk.
 *
 * EVERY IMPORT LANDS UNTRUSTED (`origin: "imported"`, a constant), is scanned,
 * and keeps the files beside a SKILL.md as the skill's bundle (`bundle.ts`):
 * scanned with it, and an imported bundle with a script waits for consent
 * before anything in it can run, which is only ever inside the no-network
 * sandbox. Links go through the SSRF-safe fetcher: a skill URL is a stranger's
 * address fetched from Juno's network.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { recordWorkAudit } from "@/lib/work/audit";
import { fetchSafePublicUrl } from "@/lib/search/fetch-safe";
import { createSkillWithFirstVersion, takenSkillSlugs } from "@/lib/skills/store";
import { serializeLibrarySkill, suggestSkillSlug } from "@/lib/skills/sources";
import { scanSkillVersion } from "@/lib/work/skill-security";
import {
  MAX_PACKAGE_BYTES,
  PACKAGE_REFUSAL_MESSAGES,
  originLabel,
  packageSkillContract,
  readSkillMarkdown,
  readSkillPackage,
  type PackageCandidate,
  type PackageOrigin,
  type PackageReadResult,
} from "@/lib/skills/package";
import { SKILL_MD_REFUSAL_MESSAGES, titleFromSkillName, type SkillMdRefusal } from "@/lib/skills/skill-md";
import { bundleCounts, skillBundleRefusalMessage, skillBundleScanInput } from "@/lib/skills/bundle";
import type { LibrarySkill } from "@/lib/skills/library-contract";
import { MAX_SKILL_NAME_CHARS, normalizeSkillSlug } from "@/lib/work/skills";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const runtime = "nodejs";
export const maxDuration = 30;

const PREVIEW_LIMIT_PER_HOUR = 60;
const IMPORT_LIMIT_PER_HOUR = 20;

const pathSchema = z.string().trim().min(1).max(500);
const choiceSchema = z.object({
  paths: z.array(pathSchema).max(50).optional(),
  renames: z.record(pathSchema, z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS)).optional(),
  projectId: z.string().cuid().nullable().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const jsonSchema = choiceSchema.extend({
  markdown: z.string().max(400_000).optional(),
  url: z.string().trim().url().max(2_000).optional(),
});

type Choice = z.infer<typeof choiceSchema>;

function refuse(error: string, message: string, status = 400) {
  return NextResponse.json({ error, message }, { status });
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

async function readLink(raw: string): Promise<{ result: PackageReadResult; url: string; digest: string } | NextResponse> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_url", `That isn't a link ${PRODUCT_NAME} can open.`);
  }
  if (GITHUB_HOSTS.has(url.hostname)) {
    // A repository page is HTML; the GitHub importer walks it properly.
    return refuse("use_github", `That's a GitHub link. ${PRODUCT_NAME} imports it from the repository instead.`, 409);
  }
  const fetched = await fetchSafePublicUrl(url.href, {
    headers: { Accept: "text/markdown, text/plain, application/zip, application/octet-stream;q=0.9, */*;q=0.5" },
  }, AbortSignal.timeout(10_000)).catch(() => null);
  if (!fetched || fetched.kind !== "response") {
    return refuse(
      fetched?.kind === "blocked" ? "blocked" : "unreachable",
      fetched?.kind === "blocked"
        ? `That link points somewhere ${PRODUCT_NAME} can't reach.`
        : `${PRODUCT_NAME} couldn't download that link. Check it opens in a browser without signing in.`,
      502
    );
  }
  const response = fetched.response;
  if (!response.ok) {
    return refuse("unreachable", `That link answered ${response.status}. Check it opens without signing in.`, 502);
  }
  // Bound the download while it streams. Content-Length is optional and a
  // malicious host can lie about it; arrayBuffer() would allocate first.
  const reader = response.body?.getReader();
  if (!reader) return refuse("unreachable", "That link returned an empty file.", 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PACKAGE_BYTES) {
        await reader.cancel();
        return refuse("too_large", PACKAGE_REFUSAL_MESSAGES.too_large, 413);
      }
      chunks.push(value);
    }
  } catch { return refuse("unreachable", "That download stopped before the file arrived. Try again.", 502); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { result: await readSkillPackage(bytes), url: fetched.url, digest: createHash("sha256").update(bytes).digest("hex") };
}

function previewOf(candidate: PackageCandidate, origin: PackageOrigin, notes: { slugTaken: boolean; suggestedSlug: string | null }) {
  const { contract, requestedTools, droppedTools } = packageSkillContract(candidate, origin);
  return {
    path: candidate.path,
    directory: candidate.directory,
    slug: candidate.skill.name,
    name: titleFromSkillName(candidate.skill.name),
    description: candidate.skill.description,
    license: candidate.skill.license,
    compatibility: candidate.skill.compatibility,
    instructionChars: candidate.skill.instructions.length,
    requestedTools,
    droppedTools,
    hostKeys: candidate.skill.hostKeys,
    ignoredKeys: candidate.skill.ignoredKeys,
    companionFiles: candidate.companionFiles,
    /** What of the folder is kept, by kind, and what was left out. Null for instructions only. */
    bundle: candidate.bundle
      ? {
          ...bundleCounts(candidate.bundle.manifest),
          totalBytes: candidate.bundle.manifest.totalBytes,
          skippedFiles: candidate.bundle.manifest.skipped.map((entry) => entry.path),
        }
      : null,
    url: origin.kind === "url" ? origin.url : "",
    securityStatus: scanSkillVersion({
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
      instructions: candidate.skill.instructions,
      requestedTools,
      contract,
      bundle: candidate.bundle ? skillBundleScanInput(candidate.bundle) : null,
    }).status,
    installed: false,
    ...notes,
  };
}

/** Taken names, and a free one for each skill whose own is taken (in path order). */
function annotate(candidates: readonly PackageCandidate[], stem: string, taken: ReadonlySet<string>) {
  const claimed = new Set(taken);
  const notes = new Map<string, { slugTaken: boolean; suggestedSlug: string | null }>();
  for (const candidate of candidates) {
    const slug = normalizeSkillSlug(candidate.skill.name);
    if (slug && claimed.has(slug)) {
      const suggestedSlug = suggestSkillSlug(stem, slug, claimed);
      if (suggestedSlug) claimed.add(suggestedSlug);
      notes.set(candidate.path, { slugTaken: true, suggestedSlug });
    } else {
      if (slug) claimed.add(slug);
      notes.set(candidate.path, { slugTaken: false, suggestedSlug: null });
    }
  }
  return notes;
}

function stemOf(origin: PackageOrigin): string {
  if (origin.kind === "file") return origin.filename.replace(/\.(zip|skill|md|markdown)$/i, "") || "imported";
  if (origin.kind === "url") {
    try {
      return new URL(origin.url).hostname.split(".").slice(-2, -1)[0] ?? "imported";
    } catch {
      return "imported";
    }
  }
  return "imported";
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  // Bound the entire request before formData/json allocate an arbitrary body.
  const requestBudget = MAX_PACKAGE_BYTES + 64 * 1024;
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > requestBudget) return refuse("too_large", PACKAGE_REFUSAL_MESSAGES.too_large, 413);
  const bodyReader = req.body?.getReader();
  if (!bodyReader) return refuse("invalid_input", "Choose a file, a SKILL.md, or a link to import.");
  const bodyChunks: Uint8Array[] = [];
  let bodyLength = 0;
  try {
    for (;;) {
      const { done, value } = await bodyReader.read();
      if (done) break;
      bodyLength += value.byteLength;
      if (bodyLength > requestBudget) {
        await bodyReader.cancel();
        return refuse("too_large", PACKAGE_REFUSAL_MESSAGES.too_large, 413);
      }
      bodyChunks.push(value);
    }
  } catch { return refuse("invalid_input", "That upload stopped before it arrived. Try again."); }
  finally { bodyReader.releaseLock(); }
  const boundedBody = new Uint8Array(bodyLength);
  let bodyOffset = 0;
  for (const chunk of bodyChunks) { boundedBody.set(chunk, bodyOffset); bodyOffset += chunk.byteLength; }
  const boundedRequest = new Request(req.url, { method: "POST", headers: req.headers, body: boundedBody });

  // Two encodings, one meaning: multipart for an upload, JSON for a paste or a link.
  let choice: Choice;
  let origin: PackageOrigin;
  let read: PackageReadResult;
  let digest: string;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const form = await boundedRequest.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return refuse("invalid_input", "Choose a file to import.");
    if (file.size > MAX_PACKAGE_BYTES) return refuse("too_large", PACKAGE_REFUSAL_MESSAGES.too_large, 413);
    const jsonField = (name: string): unknown => {
      const value = form?.get(name);
      if (typeof value !== "string" || !value) return undefined;
      try {
        return JSON.parse(value);
      } catch {
        return null; // fails the schema below, as a 400 rather than a 500
      }
    };
    const parsedChoice = choiceSchema.safeParse({
      paths: jsonField("paths"),
      renames: jsonField("renames"),
      projectId: form?.get("projectId") ? String(form.get("projectId")) : undefined,
      digest: form?.get("digest") || undefined,
    });
    if (!parsedChoice.success) return refuse("invalid_input", "That request didn't make sense.");
    choice = parsedChoice.data;
    origin = { kind: "file", filename: file.name.slice(0, 200) || "SKILL.md" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    digest = createHash("sha256").update(bytes).digest("hex");
    read = await readSkillPackage(bytes);
  } else {
    const parsed = jsonSchema.safeParse(await boundedRequest.json().catch(() => null));
    if (!parsed.success || (!parsed.data.markdown && !parsed.data.url)) {
      return refuse("invalid_input", "Paste a SKILL.md, or a link to one.");
    }
    choice = parsed.data;
    if (parsed.data.markdown) {
      origin = { kind: "paste" };
      digest = createHash("sha256").update(parsed.data.markdown).digest("hex");
      read = readSkillMarkdown(parsed.data.markdown);
    } else {
      const limit = await rateLimit({ key: `skill-import-link:${user.id}`, limit: PREVIEW_LIMIT_PER_HOUR, windowSec: 3600 });
      if (!limit.success) return refuse("rate_limited", "That's a lot of links in an hour. Try again shortly.", 429);
      const linked = await readLink(parsed.data.url!);
      if (linked instanceof NextResponse) return linked;
      origin = { kind: "url", url: linked.url };
      read = linked.result;
      digest = linked.digest;
    }
  }

  const importing = choice.paths !== undefined && choice.paths.length > 0;
  const limit = await rateLimit({
    key: `skill-import:${user.id}`,
    limit: importing ? IMPORT_LIMIT_PER_HOUR : PREVIEW_LIMIT_PER_HOUR,
    windowSec: 3600,
  });
  if (!limit.success) {
    return refuse("rate_limited", "You have imported a lot of skills in the last hour. Try again shortly.", 429);
  }

  if (importing && choice.digest !== digest) return refuse("source_changed", "That skill package changed since you reviewed it. Preview it again before importing.", 409);

  if (!read.ok) {
    const message = read.path
      ? `${PACKAGE_REFUSAL_MESSAGES[read.reason]} (“${read.path.slice(0, 120)}”)`
      : PACKAGE_REFUSAL_MESSAGES[read.reason];
    return refuse(read.reason, message, 422);
  }
  const problems = read.problems.map((problem) => ({
    path: problem.path,
    // A refused folder reports the bundle's own reason (`symlink`, `unsafe_path`, …).
    reason: problem.reason === "bundle" && problem.bundle ? problem.bundle.reason : problem.reason,
    message:
      problem.reason === "unreadable"
        ? "This file couldn't be read out of the archive."
        : problem.reason === "bundle" && problem.bundle
          ? skillBundleRefusalMessage(problem.bundle)
          : SKILL_MD_REFUSAL_MESSAGES[problem.reason as SkillMdRefusal],
  }));
  // A lone SKILL.md that doesn't parse is the whole answer, not a footnote.
  if (read.candidates.length === 0 && problems.length === 1 && read.total === 1) {
    return refuse(problems[0].reason, problems[0].message, 422);
  }

  if (choice.projectId) {
    const project = await prisma.project.findFirst({ where: { id: choice.projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const taken = await takenSkillSlugs(user.id);
  const stem = stemOf(origin);
  const originView = {
    kind: origin.kind,
    label: originLabel(origin),
    ...(origin.kind === "url" ? { url: origin.url } : {}),
  };

  if (!importing) {
    const notes = annotate(read.candidates, stem, taken);
    return NextResponse.json({
      origin: originView,
      digest,
      skills: read.candidates.map((candidate) => previewOf(candidate, origin, notes.get(candidate.path)!)),
      problems,
      more: read.more,
      total: read.total,
    });
  }

  const wanted = new Set(choice.paths);
  const chosen = read.candidates.filter((candidate) => wanted.has(candidate.path));
  if (chosen.length === 0) {
    return refuse("nothing_to_import", "None of the chosen skills are in that file. Preview it again.", 409);
  }
  const renames = choice.renames ?? {};
  const imported: LibrarySkill[] = [];
  const skipped: { path: string; slug: string; reason: string; message: string }[] = [];
  let blocked = 0;
  for (const candidate of chosen) {
    const rename = renames[candidate.path];
    const slug = normalizeSkillSlug(rename ?? candidate.skill.name);
    if (!slug) {
      skipped.push({
        path: candidate.path,
        slug: rename ?? candidate.skill.name,
        reason: "invalid_slug",
        message: `${PRODUCT_NAME} could not turn that name into something you can type after a slash.`,
      });
      continue;
    }
    const { contract, requestedTools } = packageSkillContract(candidate, origin);
    const created = await createSkillWithFirstVersion({
      userId: user.id,
      slug,
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
      instructions: candidate.skill.instructions,
      projectId: choice.projectId ?? null,
      contract,
      requestedTools,
      // A constant. Never from the body.
      origin: "imported",
      autoSelect: false,
      bundle: candidate.bundle,
    });
    if (!created.ok) {
      skipped.push({
        path: candidate.path,
        slug,
        reason: "slug_taken",
        message: `You already have a skill called /${slug}. Import this one under another name. An import never overwrites a skill you already have.`,
      });
      continue;
    }
    if (created.blocked) blocked++;
    imported.push(serializeLibrarySkill({ ...created.skill, requiresConsent: created.version.requiresConsent }));
  }

  await recordWorkAudit({
    userId: user.id,
    kind: "skill_applied",
    actor: "web",
    severity: blocked > 0 ? "warning" : "info",
    detail: { action: `${origin.kind}_import`, count: imported.length },
  });

  return NextResponse.json({ imported, skipped, problems, blocked, origin: originView, source: null }, { status: 201 });
}
