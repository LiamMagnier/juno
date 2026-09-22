"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ExternalLink, Loader2, Search } from "lucide-react";
import { GitHubMark } from "@/components/connections/connector-logos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import {
  importGithubSkills,
  previewGithubSkills,
  type GithubSkillDiscovery,
  type GithubSkillPreview,
} from "@/components/work/work-transport";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/**
 * Bringing skills in from a repository.
 *
 * TWO STEPS, AND THE FIRST ONE IS THE POINT. A repository is the unit of
 * distribution for skills in both ecosystems — Claude Code's
 * `/plugin marketplace add owner/repo` treats a repo as the marketplace, with
 * no publishing step in between — so the thing somebody pastes usually holds
 * twenty skills and they want three. A form that imported everything, or that
 * asked for one SKILL.md URL at a time, would be wrong in opposite directions.
 * So: look, then choose.
 *
 * WHAT THE PREVIEW HAS TO SAY, and why each line is here rather than tidied
 * away. A skill is the one thing in this product that is somebody else's
 * instructions running against the reader's own conversations, so the preview
 * states what Juno will and will not carry: the description the model would
 * match on, the tool declarations it can express, the ones it dropped because
 * they are argument patterns rather than names, the frontmatter written for
 * another host, and the files beside the SKILL.md that Juno lists and never
 * fetches. Anthropic's own guidance for third-party skills is "audit it
 * yourself"; this page is Juno doing the part of that it can do for you.
 *
 * EVERYTHING LANDS UNTRUSTED, and the page says so before the button rather
 * than after. Untrusted is not a warning badge — it is the state in which Juno
 * will not reach for the skill on its own. The reader can still type its name,
 * because they typed the name.
 */

/** The value the picker uses for "not filed in any project". */
const ACCOUNT_LEVEL = "__account__";

export default function ImportSkillsPage() {
  const router = useRouter();
  const [source, setSource] = React.useState("");
  const [looking, setLooking] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [discovery, setDiscovery] = React.useState<GithubSkillDiscovery | null>(null);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[] | null>(null);
  const [outcome, setOutcome] = React.useState<{
    imported: number;
    skipped: { slug: string; message: string }[];
    blocked: number;
  } | null>(null);

  React.useEffect(() => {
    let live = true;
    fetch("/api/projects")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { projects?: { id: string; name: string }[] } | null) => {
        if (live && data && Array.isArray(data.projects)) {
          setProjects(data.projects.map((project) => ({ id: project.id, name: project.name })));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const look = async () => {
    const trimmed = source.trim();
    if (!trimmed || looking) return;
    setLooking(true);
    setRefusal(null);
    setOutcome(null);
    setDiscovery(null);
    setChosen(new Set());
    const result = await previewGithubSkills(trimmed);
    setLooking(false);
    if (result.kind === "ok") {
      setDiscovery(result.value);
      // Nothing is pre-selected. Ticking every row for somebody turns a page
      // about choosing into a page about un-choosing, and the whole reason the
      // preview exists is that the reader should read before they keep.
      return;
    }
    setRefusal(
      result.kind === "blocked"
        ? result.explanation
        : (result.message ??
          (result.cause === "offline"
            ? "Couldn’t reach Juno to look at that repository."
            : "Couldn’t look at that repository."))
    );
  };

  const toggle = (path: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const keep = async () => {
    if (!discovery || chosen.size === 0 || importing) return;
    setImporting(true);
    setRefusal(null);
    const result = await importGithubSkills({
      source: source.trim(),
      commit: discovery.repository.commit,
      paths: [...chosen],
      projectId,
    });
    setImporting(false);
    if (result.kind === "ok") {
      // One imported skill goes straight to its page, because that is where the
      // reader's next question — "what does it actually say" — is answered.
      // Several stay here with a summary: routing to one of six would be a
      // choice nobody made.
      if (result.value.imported.length === 1 && result.value.skipped.length === 0) {
        router.push(`/skills/${result.value.imported[0].id}`);
        return;
      }
      setOutcome({
        imported: result.value.imported.length,
        skipped: result.value.skipped.map((entry) => ({ slug: entry.slug, message: entry.message })),
        blocked: result.value.blocked,
      });
      setChosen(new Set());
      return;
    }
    setRefusal(
      result.kind === "blocked"
        ? result.explanation
        : (result.message ?? "Couldn’t import those skills. Nothing was saved.")
    );
  };

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Skills"
        heading="Import from GitHub"
        lede="A skill is a folder with a SKILL.md in it — the format Claude and Codex both read. Paste a repository and Juno will show you what is in it before anything is saved."
        backHref="/skills"
        backLabel="Back to skills"
      />

      <div className="space-y-6">
        <div>
          <Label htmlFor="skill-source">Repository</Label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Input
              id="skill-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void look();
                }
              }}
              placeholder="anthropics/skills"
              disabled={looking || importing}
              className="max-w-md font-mono text-ui"
            />
            <Button onClick={() => void look()} disabled={!source.trim() || looking} className="gap-1.5">
              {looking ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="size-3.5" aria-hidden="true" />
              )}
              {looking ? "Looking…" : "Look inside"}
            </Button>
          </div>
          <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
            <code className="font-mono">owner/repo</code>, a link to a repository, or a link to a
            folder or a <code className="font-mono">SKILL.md</code> inside one — the URL from
            GitHub&apos;s own file browser works. Connect GitHub on{" "}
            <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
              Connections
            </Link>{" "}
            to reach your private repositories and to stop GitHub rate-limiting the read.
          </p>
        </div>

        {refusal !== null && <WorkStateNote tone="error">{refusal}</WorkStateNote>}

        {outcome !== null && (
          <WorkStateNote tone={outcome.skipped.length > 0 || outcome.blocked > 0 ? "warning" : "info"}>
            <span className="block">
              Imported {outcome.imported} skill{outcome.imported === 1 ? "" : "s"}.{" "}
              <Link href="/skills" className="underline underline-offset-2">
                See them
              </Link>
              .
            </span>
            {outcome.blocked > 0 && (
              <span className="mt-1 block">
                {outcome.blocked} of them came in switched off because Juno&apos;s scanner found
                something in the instructions. Open one to see what.
              </span>
            )}
            {outcome.skipped.map((entry) => (
              <span key={entry.slug} className="mt-1 block">
                <code className="font-mono">/{entry.slug}</code> — {entry.message}
              </span>
            ))}
          </WorkStateNote>
        )}

        {discovery !== null && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-ui text-muted-foreground">
                <span className="font-medium text-foreground">
                  {discovery.repository.owner}/{discovery.repository.repo}
                </span>{" "}
                at <code className="font-mono text-caption">{discovery.repository.ref}</code> —{" "}
                {discovery.skills.length} skill{discovery.skills.length === 1 ? "" : "s"}
                {discovery.more ? ", and more than Juno lists in one pass" : ""}.
              </p>
              {discovery.skills.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setChosen((current) =>
                      current.size === discovery.skills.length
                        ? new Set()
                        : new Set(discovery.skills.map((skill) => skill.path))
                    )
                  }
                  className="text-caption font-medium text-primary-ink underline-offset-2 hover:underline"
                >
                  {chosen.size === discovery.skills.length ? "Clear all" : "Choose all"}
                </button>
              )}
            </div>

            <div className="space-y-2">
              {discovery.skills.map((skill, index) => (
                <SkillPreviewRow
                  key={skill.path}
                  skill={skill}
                  index={index}
                  chosen={chosen.has(skill.path)}
                  onToggle={() => toggle(skill.path)}
                  disabled={importing}
                />
              ))}
            </div>

            {discovery.problems.length > 0 && (
              <WorkStateNote tone="warning">
                <span className="block">
                  {discovery.problems.length} file
                  {discovery.problems.length === 1 ? " was" : "s were"} named{" "}
                  <code className="font-mono">SKILL.md</code> and could not be read:
                </span>
                {discovery.problems.slice(0, 5).map((problem) => (
                  <span key={problem.path} className="mt-1 block">
                    <code className="font-mono text-caption">{problem.path}</code> — {problem.message}
                  </span>
                ))}
              </WorkStateNote>
            )}

            {discovery.skills.length > 0 && (
              <>
                <div>
                  <Label htmlFor="import-project">Filed in</Label>
                  <select
                    id="import-project"
                    value={projectId ?? ACCOUNT_LEVEL}
                    disabled={importing || projects === null}
                    onChange={(event) =>
                      setProjectId(event.target.value === ACCOUNT_LEVEL ? null : event.target.value)
                    }
                    className="field-well mt-1 h-9 w-full max-w-sm rounded-field border border-input px-3.5 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value={ACCOUNT_LEVEL}>Everything</option>
                    {(projects ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Stated before the button, not after it. What "untrusted"
                    means is the single most load-bearing fact on this page, and
                    it is a fact about what Juno will refuse to do on its own —
                    not a badge. */}
                <WorkStateNote tone="info">
                  Anything imported here starts <strong>untrusted</strong>. Juno will not reach for
                  it on its own, and its instructions reach the model inside the untrusted-content
                  markers — where they may shape how a task is done and nothing else. You can say
                  you trust it on its own page, once you have read it.
                </WorkStateNote>

                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => void keep()} disabled={chosen.size === 0 || importing} className="gap-1.5">
                    {importing && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                    {chosen.size === 0
                      ? "Choose a skill"
                      : `Import ${chosen.size} skill${chosen.size === 1 ? "" : "s"}`}
                  </Button>
                  <Button variant="ghost" onClick={() => router.push("/skills")} disabled={importing}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </AppPage>
  );
}

/**
 * One skill, as it is in the repository.
 *
 * The description is shown in full rather than truncated: it is the text the
 * model matches a request against, so it is the single most useful thing on the
 * row and the one a reader most needs to judge. Everything under it is what
 * Juno will not carry across, each stated as a fact rather than a warning —
 * a skill written for Claude Code is not a broken skill, it is a skill written
 * for a shell, and the reader is better served by knowing that than by a badge.
 */
function SkillPreviewRow({
  skill,
  index,
  chosen,
  onToggle,
  disabled,
}: {
  skill: GithubSkillPreview;
  index: number;
  chosen: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const notes: string[] = [];
  if (skill.droppedTools.length > 0) {
    notes.push(
      `${skill.droppedTools.length} tool declaration${skill.droppedTools.length === 1 ? "" : "s"} Juno can’t express (${skill.droppedTools.slice(0, 3).join(", ")})`
    );
  }
  if (skill.hostKeys.length > 0) {
    notes.push(`${skill.hostKeys.join(", ")} — written for another host, no effect here`);
  }
  if (skill.companionFiles.length > 0) {
    notes.push(
      `${skill.companionFiles.length} file${skill.companionFiles.length === 1 ? "" : "s"} beside it, which Juno lists and does not fetch`
    );
  }
  if (skill.ignoredKeys.length > 0) {
    notes.push(`unrecognised frontmatter: ${skill.ignoredKeys.join(", ")}`);
  }

  return (
    <div
      className={cn(
        "rounded-field border bg-card px-3.5 py-3 transition-[background-color,border-color] duration-base ease-out-soft motion-safe:animate-rise-in",
        chosen ? "border-primary/40 bg-secondary" : "border-border/60",
        "[animation-fill-mode:backwards]"
      )}
      style={staggerDelay(index, "tight")}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={chosen}
          onChange={onToggle}
          disabled={disabled}
          className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-body font-medium leading-snug text-foreground">
              {skill.name}
            </span>
            <span className="shrink-0 font-mono text-micro text-muted-foreground">/{skill.slug}</span>
            {skill.license && (
              <span className="shrink-0 font-mono text-micro text-muted-foreground">
                {skill.license}
              </span>
            )}
          </span>
          <span className="mt-1 block text-ui leading-relaxed text-muted-foreground">
            {skill.description}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-muted-foreground">
            <span>{skill.path}</span>
            <span>{skill.instructionChars.toLocaleString("en")} chars</span>
            {skill.requestedTools.length > 0 && (
              <span>asks for {skill.requestedTools.join(", ")}</span>
            )}
            <a
              href={skill.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
            >
              <GitHubMark className="size-3" />
              Read it
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </span>
          {notes.length > 0 && (
            <span className="mt-1.5 flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{notes.join(" · ")}</span>
            </span>
          )}
          {skill.compatibility && (
            <span className="mt-1 flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground">
              <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{skill.compatibility}</span>
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
