"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { skillSlugFromName } from "@/lib/work/skills";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { createWorkSkill } from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";

/**
 * Writing a skill.
 *
 * `origin` is a real question rather than a hidden default, because it is what
 * decides the skill's starting trust and therefore whether the planner may ever
 * reach for it unprompted: something written here starts as yours, and something
 * pasted in from elsewhere starts untrusted until you have read it and said
 * otherwise. The server derives the trust from this and never takes it from the
 * body, so answering honestly is the only thing that has any effect.
 *
 * The slug is derived rather than asked for. It is what a user types after a
 * slash and what an older message in their history already says, so it is chosen
 * once — and `skillSlugFromName` is the same function the route uses, imported
 * so the preview under the name field cannot disagree with what gets stored.
 */
/**
 * The picker's value for "not filed in any project".
 *
 * A sentinel rather than an empty string, because an `<option value="">` reads
 * back as the falsy value for both "the account" and "nothing chosen" while
 * only one of those is something the reader can have meant here.
 */
const ACCOUNT_LEVEL = "__account__";

export default function NewSkillPage() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [origin, setOrigin] = React.useState<"authored" | "imported">("authored");
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  /**
   * Where the skill is filed, chosen here rather than only afterwards.
   *
   * `null` is the account level, and it is the default: a skill nobody has
   * placed belongs to the whole account, which is what filing it nowhere has
   * always meant. The alternative — defaulting to whichever project the reader
   * last looked at — would narrow the planner's offer without anybody saying
   * so, and the symptom is a skill that never gets picked.
   */
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[] | null>(null);

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

  const slug = skillSlugFromName(name);
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && slug !== null && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    const result = await createWorkSkill({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      origin,
      projectId,
    });
    setSaving(false);
    if (result.kind === "ok") {
      router.push(`/skills/${result.value.id}`);
      return;
    }
    if (result.kind === "blocked") {
      // The one refusal this form can produce on its own: `(userId, slug)` is
      // unique, and the slug came from the name, so a second "Tidy Downloads"
      // collides without the reader ever having typed a slug.
      setRefusal(
        result.reason === "slug_taken"
          ? `You already have a skill called /${slug ?? ""}. Give this one a different name.`
          : result.explanation
      );
      return;
    }
    setRefusal(
      result.message ??
        (result.cause === "offline"
          ? "Couldn’t reach Juno to save this. Nothing was created."
          : "Couldn’t save this skill. Nothing was created.")
    );
  };

  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Skills"
        heading="New skill"
        lede="Instructions Juno can be handed by name. What it asks for is a request, never a grant — it can only ever do what you have already allowed elsewhere."
        backHref="/skills"
        backLabel="Back to skills"
      />
      <div className="space-y-6">
        <div>
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="File the invoices"
            disabled={saving}
            className="mt-1"
          />
          <p className="mt-1 font-mono text-micro text-muted-foreground">
            {slug === null
              ? "Type a name with at least one letter or number in it."
              : `Typed as /${slug}`}
          </p>
        </div>

        <div>
          <Label htmlFor="skill-description">What it is for</Label>
          <Input
            id="skill-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Sorts incoming invoices into the right folder and renames them."
            disabled={saving}
            className="mt-1"
          />
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            One line. This is what Juno reads when deciding whether a skill fits the task in front
            of it.
          </p>
        </div>

        <div>
          <Label htmlFor="skill-instructions">Instructions</Label>
          <Textarea
            id="skill-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Write it the way you would for a person doing it for the first time: the steps, the edge cases, and what to do when something does not fit."
            rows={12}
            disabled={saving}
            className="mt-1 font-mono text-ui"
          />
        </div>

        <div>
          <Label htmlFor="skill-project">Filed in</Label>
          {/* The same `field-well` recipe the other Work selects carry. */}
          <select
            id="skill-project"
            value={projectId ?? ACCOUNT_LEVEL}
            disabled={saving || projects === null}
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
          <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
            {projectId === null
              ? "Juno may offer this for any task. File it in a project to keep it out of the way of work it has nothing to do with."
              : "Juno offers this only for tasks filed in that project. Typing its slash name still reaches it from anywhere."}
          </p>
        </div>

        <div>
          <Label>Where it came from</Label>
          <SegmentedControl
            value={origin}
            onChange={setOrigin}
            options={[
              { value: "authored", label: "I wrote it" },
              { value: "imported", label: "From somewhere else" },
            ]}
            ariaLabel="Where this skill came from"
            optionClassName="px-3 py-1 text-label"
            className="mt-1 max-w-sm"
          />
          <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
            {origin === "authored"
              ? "Starts as trusted, because you wrote it. Juno may reach for it on its own once you switch that on."
              : "Starts untrusted. Juno will not reach for it on its own until you have read it and said it is fine — which is the point of the distinction."}
          </p>
        </div>

        {refusal !== null && <WorkStateNote tone="error">{refusal}</WorkStateNote>}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={!canSave} className="gap-1.5">
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Create skill
          </Button>
          <Button variant="ghost" onClick={() => router.push("/skills")} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </AppPage>
  );
}
