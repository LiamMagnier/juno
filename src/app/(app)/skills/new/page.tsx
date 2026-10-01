"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { AppIcons } from "@/lib/app-icons";
import { skillSlugFromName } from "@/lib/work/skills";
import { openSkillDraftingChat } from "@/components/skills/add-skill-menu";
import { createSkill, skillsFailureMessage } from "@/components/skills/skills-transport";
import { looksLikeSkillMarkdown } from "@/components/skills/skill-library-model";
import { parseSkillMd, titleFromSkillName } from "@/lib/skills/skill-md";

/**
 * Writing a skill: a name, one line, and the instructions.
 *
 * A SKILL WRITTEN HERE IS YOURS. The page used to ask "where did it come
 * from", which set the starting trust, and it was the most confusing question
 * in the product: importing is a flow of its own now (and lands untrusted
 * there), so anything typed here is `authored`. Where it is filed and whether
 * Juno may pick it on its own are set on the skill's page afterwards, once it
 * exists and can be read back.
 *
 * The slash name is derived rather than asked for, by the same function the
 * route uses, so the preview under the name cannot disagree with what is saved.
 *
 * A whole SKILL.md pasted into any field is taken apart into the three
 * fields (name, description, instructions) by the importer's own parser,
 * instead of landing as YAML inside the instructions. A note says so, once.
 */
export default function NewSkillPage() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [filledFrom, setFilledFrom] = React.useState(false);

  const onPaste = (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!looksLikeSkillMarkdown(text)) return;
    const parsed = parseSkillMd(text);
    if (!parsed.ok) return; // not a skill after all: let it paste as text
    event.preventDefault();
    setName(titleFromSkillName(parsed.skill.name));
    setDescription(parsed.skill.description);
    setInstructions(parsed.skill.instructions);
    setFilledFrom(true);
  };

  const slug = skillSlugFromName(name);
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && slug !== null && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    const result = await createSkill({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      origin: "authored",
    });
    setSaving(false);
    if (result.kind === "ok") {
      router.push(`/skills/${result.value.id}`);
      return;
    }
    // The one refusal this form can cause on its own: slugs are unique per
    // account and this one came from the name.
    setRefusal(
      result.kind === "blocked" && result.reason === "slug_taken"
        ? `You already have a skill called /${slug ?? ""}. Give this one a different name.`
        : skillsFailureMessage(result, "Couldn’t save this skill. Nothing was created.")
    );
  };

  return (
    <AppPage measure="reading">
      <AppPageHeader
        heading="New skill"
        lede="Instructions Juno follows when you call it by name."
        backHref="/skills"
        backLabel="Back to skills"
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => openSkillDraftingChat((href) => router.push(href))}
          >
            <AppIcons.conversation className="size-4" aria-hidden="true" />
            Create with Juno
          </Button>
        }
      />
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onPaste={onPaste}
            placeholder="File the invoices"
            disabled={saving}
            autoFocus
            className="mt-1.5"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">
            {slug === null ? (
              "Use at least one letter or number."
            ) : (
              <>
                Type{" "}
                <span className="font-mono text-foreground" translate="no">
                  /{slug}
                </span>{" "}
                in chat to use it.
              </>
            )}
          </p>
        </div>

        <div>
          <Label htmlFor="skill-description">Description</Label>
          <Input
            id="skill-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onPaste={onPaste}
            placeholder="Sorts incoming invoices into the right folder and renames them."
            disabled={saving}
            className="mt-1.5"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">
            One line. Juno reads it to decide when the skill fits.
          </p>
        </div>

        <div>
          <Label htmlFor="skill-instructions">Instructions</Label>
          <Textarea
            id="skill-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onPaste={onPaste}
            placeholder="Write it the way you would brief a person doing it for the first time: the steps, the edge cases, and what to do when something doesn’t fit."
            rows={14}
            disabled={saving}
            className="mt-1.5 font-mono text-ui leading-relaxed"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">Markdown works. Paste a whole SKILL.md to fill every field.</p>
        </div>

        {filledFrom ? (
          <WorkStateNote tone="info" className="motion-safe:animate-rise-in">
            Filled in from the SKILL.md you pasted. Check the name and description, then create it.
          </WorkStateNote>
        ) : null}

        {refusal !== null ? (
          <WorkStateNote tone="error" className="motion-safe:animate-rise-in">
            {refusal}
          </WorkStateNote>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSave} loading={saving}>
            Create skill
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push("/skills")} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </AppPage>
  );
}
