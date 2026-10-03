"use client";

import * as React from "react";
import { ChevronRight, Folder } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ProjectSheet } from "@/components/projects/project-folders";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

/** Soft UI only, never a rejection: past this the footer says the prompt is large. */
const SOFT_WARN = 50_000;

export interface InheritedInstructions {
  id: string;
  name: string;
  instructions: string;
  fileCount: number;
}

/**
 * The project's instructions, as a writing sheet.
 *
 * A panel (16) with a 6px frame; the page inside is the writing field itself
 * (10 = 16 - 6), so there is no box inside the box and no focus ring: the
 * page's hairline turns presence blue while it has the caret. The actions sit
 * on the frame below, 8px from the panel's corner, at the control radius (8).
 *
 * Above the field, when the project is a folder, what it already inherits:
 * each ancestor's instructions, read-only, in the order a chat receives them.
 *
 * Every dismissal (Escape, the X, the backdrop, Cancel) goes through
 * `onRequestClose`, which the page turns into a discard confirm while the
 * draft is unsaved: people paste long prompts here.
 */
export function ProjectInstructionsDialog({
  open,
  projectName,
  value,
  onChange,
  dirty,
  saving,
  inherited,
  onSave,
  onRequestClose,
  onOpen,
}: {
  open: boolean;
  projectName: string;
  value: string;
  onChange: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  inherited: InheritedInstructions[];
  onSave: () => void;
  onRequestClose: () => void;
  onOpen: () => void;
}) {
  const [showInherited, setShowInherited] = React.useState(false);
  const lines = value ? value.split("\n").length : 0;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const withText = inherited.filter((level) => level.instructions.trim());

  return (
    <ProjectSheet
      open={open}
      onOpenChange={(next) => (next ? onOpen() : onRequestClose())}
      className="h-[min(46rem,calc(100dvh-2rem))] max-w-3xl"
      annot={`Instructions · ${projectName}`}
      title={`How ${PRODUCT_NAME} works in this project`}
      description={`Read before every chat, task and code session here${withText.length ? ", after the folders above it" : ""}. Headings, lists and code fences keep their shape.`}
      contentProps={{
        // Backdrop clicks are ignored while dirty; Escape asks first.
        onInteractOutside: (event) => {
          if (dirty) event.preventDefault();
        },
        onEscapeKeyDown: (event) => {
          if (!dirty) return;
          event.preventDefault();
          onRequestClose();
        },
      }}
      footerStart={
        <span className="pj-annot flex flex-wrap items-center gap-x-3">
          <span className={cn(value.length > SOFT_WARN && "text-warning")}>{value.length.toLocaleString()} chars</span>
          <span>{`${words.toLocaleString()} ${words === 1 ? "word" : "words"}`}</span>
          <span className="hidden sm:inline">{`${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`}</span>
          {value.length > SOFT_WARN && <span className="text-warning">Large prompt</span>}
        </span>
      }
      footer={
        <>
          <kbd className="pj-annot mr-1 hidden rounded-xs border border-[var(--pj-hair)] px-1.5 py-0.5 sm:inline-block">⌘↵</kbd>
          <Button variant="ghost" onClick={onRequestClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!dirty} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      {withText.length > 0 && (
        <div className="shrink-0 border-y border-[var(--pj-hair)]">
          <button
            type="button"
            onClick={() => setShowInherited((v) => !v)}
            aria-expanded={showInherited}
            className="flex min-h-10 w-full items-center gap-2 px-5 text-left text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 transition-transform duration-base ease-out-expo motion-reduce:transition-none", showInherited && "rotate-90")}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {`Also follows ${withText.map((level) => level.name).join(", then ")}`}
            </span>
            <span className="pj-annot shrink-0">Inherited</span>
          </button>
          <Collapse open={showInherited}>
            <ol className="max-h-48 space-y-4 overflow-y-auto px-5 pb-4 pt-1">
              {withText.map((level) => (
                <li key={level.id}>
                  <p className="pj-annot mb-1 flex items-center gap-1.5">
                    <Folder className="size-3" aria-hidden="true" />
                    {level.name}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-muted-foreground">
                    {level.instructions.trim()}
                  </p>
                </li>
              ))}
            </ol>
          </Collapse>
        </div>
      )}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (dirty) onSave();
          }
        }}
        placeholder={`Who ${PRODUCT_NAME} is here, what it should know, and how it should answer.\n\nFor example: Answer as a staff engineer on the Atlas team. Prefer Postgres and TypeScript. Keep replies short unless asked.`}
        spellCheck={false}
        autoFocus
        aria-label="Project instructions"
        className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 py-4 text-body leading-[1.7] text-foreground"
      />
    </ProjectSheet>
  );
}
