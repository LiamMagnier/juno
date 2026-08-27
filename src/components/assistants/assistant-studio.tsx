"use client";

import * as React from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { JunoAssistantConfig, CreateAssistantInput } from "@/lib/assistants";
import { MODEL_LIST } from "@/lib/models";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AssistantStudioProps {
  initialAssistant?: JunoAssistantConfig | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (assistant: JunoAssistantConfig) => void;
}

/**
 * The editor for a reusable Juno assistant.
 *
 * This used to be its own modal system: fixed black backdrop, raw neutral/coral
 * colours, private radii and a close button that had none of the focus/escape/
 * outside-click behaviour shared by the rest of Juno. It now uses the same
 * Dialog primitive as every production overlay, so motion, warm glass, focus
 * trapping, reduced motion and close semantics stay consistent automatically.
 *
 * The form is also reset whenever a different assistant is opened. The old
 * `useState(initialAssistant?.…)` only read props on the component's first
 * mount; editing assistant B after assistant A could therefore save A's text
 * into B unless the page itself happened to remount the studio.
 */
export function AssistantStudio({
  initialAssistant,
  isOpen,
  onClose,
  onSave,
}: AssistantStudioProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [starterPrompts, setStarterPrompts] = React.useState<string[]>([
    "How can you help me today?",
  ]);
  const [preferredModelId, setPreferredModelId] = React.useState("juno:auto");
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setName(initialAssistant?.name ?? "");
    setDescription(initialAssistant?.description ?? "");
    setSystemPrompt(initialAssistant?.systemPrompt ?? "");
    setStarterPrompts(
      initialAssistant?.starterPrompts?.length
        ? initialAssistant.starterPrompts
        : ["How can you help me today?"]
    );
    setPreferredModelId(initialAssistant?.preferredModelId ?? "juno:auto");
    setError(null);
  }, [isOpen, initialAssistant]);

  const handleAddStarter = () => setStarterPrompts((current) => [...current, ""]);

  const handleRemoveStarter = (index: number) => {
    setStarterPrompts((current) => current.filter((_, position) => position !== index));
  };

  const handleUpdateStarter = (index: number, value: string) => {
    setStarterPrompts((current) =>
      current.map((prompt, position) => (position === index ? value : prompt))
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !systemPrompt.trim()) {
      setError("Add a name and instructions before saving this assistant.");
      return;
    }

    setIsSaving(true);
    setError(null);

    const payload: CreateAssistantInput = {
      name: name.trim(),
      description: description.trim(),
      avatarIcon: initialAssistant?.avatarIcon || "bot",
      systemPrompt: systemPrompt.trim(),
      starterPrompts: starterPrompts.map((prompt) => prompt.trim()).filter(Boolean),
      preferredModelId:
        preferredModelId === "juno:auto" ? undefined : preferredModelId,
    };

    try {
      const url = initialAssistant
        ? `/api/assistants/${initialAssistant.id}`
        : "/api/assistants";
      const res = await fetch(url, {
        method: initialAssistant ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Juno could not save this assistant.");
      }

      const data = await res.json();
      onSave(data.assistant);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const AssistantIcon = AppIcons.assistants;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(88vh,760px)] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-5 pr-14">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent text-accent-foreground">
              <AssistantIcon className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DialogTitle>
                {initialAssistant ? "Edit assistant" : "Create assistant"}
              </DialogTitle>
              <DialogDescription className="mt-1">
                Give Juno a reusable role, operating instructions, starter prompts and a preferred model.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          id="assistant-studio-form"
          onSubmit={handleSubmit}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5"
        >
          {error && (
            <div
              role="alert"
              className="rounded-field border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="assistant-name">Name</Label>
              <Input
                id="assistant-name"
                required
                autoFocus
                placeholder="Python data analyst"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assistant-model">Preferred model</Label>
              <select
                id="assistant-model"
                value={preferredModelId}
                onChange={(event) => setPreferredModelId(event.target.value)}
                className="field-well h-10 w-full rounded-field border border-border/70 px-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
              >
                <option value="juno:auto">Auto · intelligent routing</option>
                {MODEL_LIST.filter(
                  (model) => model.modality === "chat" && !model.comingSoon
                ).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.provider}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assistant-description">Description</Label>
            <Input
              id="assistant-description"
              placeholder="What is this assistant for?"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Keep this short enough to scan in the assistant gallery.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assistant-instructions">Instructions</Label>
            <textarea
              id="assistant-instructions"
              required
              rows={7}
              placeholder="Define the role, how it should reason about the work, output conventions, boundaries, and what it should ask before doing."
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="field-well min-h-36 w-full resize-y rounded-field border border-border/70 px-3 py-2.5 font-mono text-sm leading-relaxed text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Conversation starters</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Optional prompts that make the assistant useful immediately.
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={handleAddStarter}>
                <Plus className="size-3.5" aria-hidden="true" />
                Add
              </Button>
            </div>

            <div className="space-y-2">
              {starterPrompts.map((prompt, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={`Starter prompt ${index + 1}`}
                    placeholder="Analyze this dataset and explain the important patterns."
                    value={prompt}
                    onChange={(event) => handleUpdateStarter(index, event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRemoveStarter(index)}
                    disabled={starterPrompts.length === 1}
                    aria-label={`Remove starter prompt ${index + 1}`}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </form>

        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" form="assistant-studio-form" disabled={isSaving}>
            <Save className="size-3.5" aria-hidden="true" />
            {isSaving ? "Saving…" : initialAssistant ? "Save changes" : "Create assistant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
