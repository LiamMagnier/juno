"use client";

import * as React from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { JunoAssistantConfig, CreateAssistantInput } from "@/lib/assistants";
import { MODEL_LIST } from "@/lib/models";
import { AppIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface AssistantStudioProps {
  initialAssistant?: JunoAssistantConfig | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (assistant: JunoAssistantConfig) => void;
}

const AUTO_MODEL = "juno:auto";

/**
 * The editor for a reusable Juno assistant.
 *
 * A two-column studio on the shared Dialog: the form (inset fields) on the
 * left, and on the right a raised preview of the tile the gallery will show —
 * so the name, description and starters are written against the thing they
 * become rather than against a blank sheet.
 *
 * The form is reset whenever a different assistant is opened. The old
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
  const [preferredModelId, setPreferredModelId] = React.useState(AUTO_MODEL);
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
    setPreferredModelId(initialAssistant?.preferredModelId ?? AUTO_MODEL);
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
      preferredModelId: preferredModelId === AUTO_MODEL ? undefined : preferredModelId,
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
  const chatModels = MODEL_LIST.filter((model) => model.modality === "chat" && !model.comingSoon);
  const previewModel =
    preferredModelId === AUTO_MODEL ? "Auto" : chatModels.find((m) => m.id === preferredModelId)?.name ?? "Auto";
  const previewStarters = starterPrompts.map((p) => p.trim()).filter(Boolean);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(88vh,800px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[60rem] sm:p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-5 pr-14">
          <div className="flex items-start gap-3">
            <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
              <AssistantIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{initialAssistant ? "Edit assistant" : "Create assistant"}</DialogTitle>
              <DialogDescription className="mt-1">
                Give Juno a reusable role, operating instructions, starter prompts and a preferred model.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] md:overflow-hidden">
          <form
            id="assistant-studio-form"
            onSubmit={handleSubmit}
            className="min-h-0 space-y-5 px-6 py-5 md:overflow-y-auto"
          >
            {error && (
              <div
                role="alert"
                className="rounded-field border border-destructive/35 bg-destructive/10 px-3.5 py-3 text-sm text-destructive-ink"
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
                <Select value={preferredModelId} onValueChange={setPreferredModelId}>
                  <SelectTrigger id="assistant-model" aria-label="Preferred model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_MODEL}>Auto · intelligent routing</SelectItem>
                    {chatModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name} · {model.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <p className="text-xs text-muted-foreground">Keep this short enough to scan in the gallery.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assistant-instructions">Instructions</Label>
              <Textarea
                id="assistant-instructions"
                required
                rows={7}
                placeholder="Define the role, how it should reason about the work, output conventions, boundaries, and what it should ask before doing."
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="min-h-36 resize-y font-mono text-xs leading-relaxed"
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

          {/* The preview: the gallery tile this form produces, raised on an
              inset shelf so it reads as the object being made. */}
          <aside className="surface-inset flex min-h-0 flex-col gap-4 border-t border-border/60 px-6 py-5 md:overflow-y-auto md:border-l md:border-t-0">
            <CardEyebrow>Preview</CardEyebrow>
            <Card variant="elevated" className="flex flex-col gap-3 p-4">
              <div className="flex items-start gap-3">
                <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                  <AssistantIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{name.trim() || "Untitled assistant"}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {description.trim() || "A one-line description shows here."}
                  </p>
                </div>
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3 font-mono text-caption text-muted-foreground">
                <span>Start chat</span>
                <span className="truncate">{previewModel}</span>
              </div>
            </Card>

            <div>
              <CardEyebrow>Starters</CardEyebrow>
              {previewStarters.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">Add a starter to see it here.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {previewStarters.map((starter, i) => (
                    <Badge key={`${starter}-${i}`} variant="outline" className="max-w-full">
                      <span className="truncate">{starter}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <CardEyebrow>Instructions</CardEyebrow>
              <p className="mt-2 line-clamp-6 whitespace-pre-wrap font-mono text-caption leading-5 text-muted-foreground">
                {systemPrompt.trim() || "The system prompt appears here as you write it."}
              </p>
            </div>
          </aside>
        </div>

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
