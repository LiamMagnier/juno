"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectSheet } from "@/components/projects/project-folders";

/** The longest description the routes take (POST and PATCH /api/projects). */
export const PROJECT_DESCRIPTION_MAX = 2000;

/**
 * A project's name and what it is for: the one form for creating a project
 * and for editing its details later.
 *
 * Creating asks the two questions Claude's project form asks, in plain words,
 * and both are optional: an unnamed project is named from its first chat, as
 * it always was. The description is for people (it sits under the name on the
 * page and on the project's card); what the model should do lives in the
 * project's instructions, which the page offers next.
 */
export function ProjectDetailsDialog({
  open,
  onOpenChange,
  mode,
  initialName = "",
  initialDescription = "",
  busy = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialName?: string;
  initialDescription?: string;
  busy?: boolean;
  onSubmit: (details: { name: string; description: string }) => void;
}) {
  const [name, setName] = React.useState(initialName);
  const [description, setDescription] = React.useState(initialDescription);
  React.useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription);
  }, [open, initialName, initialDescription]);

  const create = mode === "create";
  const submit = () => {
    // Busy guards a second Enter while the first request (or the navigation
    // after it) is in flight, which used to make a second project.
    if (busy) return;
    if (!create && !name.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim() });
  };

  return (
    <ProjectSheet
      open={open}
      onOpenChange={onOpenChange}
      title={create ? "New project" : "Edit details"}
      description={create ? "A project keeps its chats, instructions and knowledge together. Every chat you start in it begins with them." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!create && !name.trim()}>
            {create ? "Create project" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div>
          <label htmlFor="pj-details-name" className="mb-2 block text-ui font-medium text-foreground">
            What are you working on?
          </label>
          <Input
            id="pj-details-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={create ? "Name your project" : "Project name"}
            autoFocus
            maxLength={120}
          />
        </div>
        <div>
          <label htmlFor="pj-details-description" className="mb-2 block text-ui font-medium text-foreground">
            What are you trying to achieve? <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="pj-details-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the project, its goals and what’s in it"
            maxLength={PROJECT_DESCRIPTION_MAX}
            className="min-h-24 text-ui"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {/* Enter in the name field submits through the form. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </ProjectSheet>
  );
}
