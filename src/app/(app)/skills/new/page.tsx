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
import { MAX_SKILL_MD_CHARS, parseSkillMd, SKILL_MD_REFUSAL_MESSAGES, type ParsedSkillMd } from "@/lib/skills/skill-md";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
 */
export default function NewSkillPage() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [imported, setImported] = React.useState<ParsedSkillMd | null>(null);
  const [reading, setReading] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const loadFile = async (file: File) => {
    setReading(true);
    setRefusal(null);
    try {
      if (file.size > MAX_SKILL_MD_CHARS * 4) throw new Error("This SKILL.md is too large to import.");
      const result = parseSkillMd(await file.text());
      if (!result.ok) throw new Error(SKILL_MD_REFUSAL_MESSAGES[result.reason]);
      setImported(result.skill);
      setName(result.skill.name);
      setDescription(result.skill.description);
      setInstructions(result.skill.instructions);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : "Couldn’t read this file.");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    const result = parseSkillMd(text);
    if (!result.ok) return;
    event.preventDefault();
    // Pasted external instructions retain the same trust as a file import.
    setImported(result.skill);
    setName(result.skill.name);
    setDescription(result.skill.description);
    setInstructions(result.skill.instructions);
    setRefusal(null);
  };

  const slug = skillSlugFromName(name);
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && slug !== null && !saving && !reading;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    const result = await createSkill({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      origin: imported ? "imported" : "authored",
      requestedTools: imported?.allowedTools ?? [],
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
        lede={`Instructions ${PRODUCT_NAME} follows when you call it by name.`}
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
            {`Create with ${PRODUCT_NAME}`}
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
        <div className="border-b border-border pb-5">
          <input ref={fileInput} type="file" accept=".md,text/markdown,text/plain" className="hidden" aria-label="Import SKILL.md"
            disabled={saving || reading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file); }} />
          <Button type="button" variant="outline" size="sm" disabled={saving || reading} onClick={() => fileInput.current?.click()}>
            {reading ? "Reading…" : "Import SKILL.md"}
          </Button>
          <p className="mt-2 text-caption text-muted-foreground">
            {imported ? "File loaded. Review the instructions below before saving. Files referenced by the skill must be attached separately." : "Bring a skill from your computer, or write one below."}
          </p>
          {imported && [...imported.hostKeys, ...imported.ignoredKeys].length > 0 ? (
            <p className="mt-2 text-caption text-muted-foreground">{`Settings that don’t apply in ${PRODUCT_NAME}: `}{[...imported.hostKeys, ...imported.ignoredKeys].join(", ")}.</p>
          ) : null}
        </div>
        <div>
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            onPaste={onPaste}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="File the invoices"
            disabled={saving || reading}
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
            onPaste={onPaste}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Sorts incoming invoices into the right folder and renames them."
            disabled={saving || reading}
            className="mt-1.5"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">
            {`One line. ${PRODUCT_NAME} reads it to decide when the skill fits.`}
          </p>
        </div>

        <div>
          <Label htmlFor="skill-instructions">Instructions</Label>
          <Textarea
            id="skill-instructions"
            onPaste={onPaste}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Write it the way you would brief a person doing it for the first time: the steps, the edge cases, and what to do when something doesn’t fit."
            rows={14}
            disabled={saving || reading}
            className="mt-1.5 font-mono text-ui leading-relaxed"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">Markdown works.</p>
        </div>

        {refusal !== null ? (
          <WorkStateNote tone="error" className="motion-safe:animate-rise-in">
            {refusal}
          </WorkStateNote>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSave} loading={saving}>
            Create skill
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push("/skills")} disabled={saving || reading}>
            Cancel
          </Button>
        </div>
      </form>
    </AppPage>
  );
}
