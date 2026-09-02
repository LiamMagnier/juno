"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Edit3, Pin, Plus, Trash2 } from "lucide-react";
import type { JunoAssistantConfig } from "@/lib/assistants";
import { AssistantStudio } from "@/components/assistants/assistant-studio";
import { AppIcons } from "@/lib/app-icons";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Custom Juno assistants — the product's equivalent of reusable Gems / custom
 * assistants, presented in the same page frame as Projects, Work and Code.
 *
 * The gallery is a grid of raised tiles with the house anatomy (icon well,
 * name, one-line description, metadata footer) and a dashed "New assistant"
 * tile at the end, so creating one reads as filling the next slot.
 */
export default function AssistantsPage() {
  const router = useRouter();
  const [assistants, setAssistants] = React.useState<JunoAssistantConfig[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [studioOpen, setStudioOpen] = React.useState(false);
  const [editingAssistant, setEditingAssistant] = React.useState<JunoAssistantConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<JunoAssistantConfig | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const fetchAssistants = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch("/api/assistants");
      if (!response.ok) throw new Error("assistants_unavailable");
      const data = await response.json();
      setAssistants(Array.isArray(data.assistants) ? data.assistants : []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchAssistants();
  }, [fetchAssistants]);

  const startChat = (assistant: JunoAssistantConfig) => {
    router.push(`/chat?assistantId=${assistant.id}`);
  };

  const openStudio = (assistant: JunoAssistantConfig | null) => {
    setEditingAssistant(assistant);
    setStudioOpen(true);
  };

  const deleteAssistant = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/assistants/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("delete_failed");
      setAssistants((current) => current.filter((assistant) => assistant.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const togglePin = async (assistant: JunoAssistantConfig) => {
    const response = await fetch(`/api/assistants/${assistant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: !assistant.isPinned }),
    }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json();
    setAssistants((current) =>
      current.map((item) => (item.id === assistant.id ? data.assistant : item))
    );
  };

  const filteredAssistants = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return assistants;
    return assistants.filter(
      (assistant) =>
        assistant.name.toLowerCase().includes(query) ||
        assistant.description.toLowerCase().includes(query)
    );
  }, [assistants, searchQuery]);

  const AssistantIcon = AppIcons.assistants;
  const SearchIcon = AppIcons.search;

  const newTile = (
    <button
      type="button"
      onClick={() => openStudio(null)}
      className="surface-inset flex min-h-40 items-center justify-center gap-2 rounded-card border-dashed border-border/80 text-sm text-muted-foreground transition-[color,border-color] duration-fast ease-out-soft hover:border-foreground/30 hover:text-foreground motion-reduce:transition-none"
    >
      <Plus className="size-4" aria-hidden="true" />
      New assistant
    </button>
  );

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Assistants"
        heading="Specialists you can reuse"
        icon={AssistantIcon}
        lede="Focused Juno personalities with their own instructions, starter prompts and model preference."
        actions={
          <Button onClick={() => openStudio(null)} className="gap-1.5">
            <Plus className="size-4" aria-hidden="true" />
            New assistant
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search assistants"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-9"
            aria-label="Search assistants"
          />
        </div>
        {!loading && !failed && (
          <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground">
            {filteredAssistants.length} {filteredAssistants.length === 1 ? "assistant" : "assistants"}
          </span>
        )}
      </div>

      <div className="mt-6">
        {failed ? (
          <EmptyState
            tone="error"
            icon={AssistantIcon}
            title="Assistants are unavailable"
            description="Juno could not read your assistant library. Nothing was deleted; retry the request."
            action={
              <Button variant="outline" size="sm" onClick={() => void fetchAssistants()}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <Skeleton
                key={index}
                className="min-h-40 rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(index, "tight")}
              />
            ))}
          </div>
        ) : filteredAssistants.length === 0 ? (
          <EmptyState
            icon={AssistantIcon}
            title={searchQuery ? "No matching assistants" : "No assistants yet"}
            description={
              searchQuery
                ? "Try a different name or description."
                : "Create a reusable specialist for a workflow, domain, class, project or writing style."
            }
            action={
              searchQuery ? (
                <Button variant="outline" size="sm" onClick={() => setSearchQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button onClick={() => openStudio(null)} className="gap-1.5">
                  <Plus className="size-4" aria-hidden="true" />
                  Create assistant
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredAssistants.map((assistant, i) => (
              <Card
                key={assistant.id}
                variant="interactive"
                className="group relative flex min-h-40 flex-col gap-3 p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "tight")}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => startChat(assistant)}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-control text-left"
                    aria-label={`Start a chat with ${assistant.name}`}
                  >
                    <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                      <AssistantIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 pt-0.5">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <span className="truncate">{assistant.name}</span>
                        {assistant.isPinned && (
                          <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="Pinned" />
                        )}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {assistant.description || "Custom Juno assistant"}
                      </span>
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void togglePin(assistant)}
                      aria-label={assistant.isPinned ? `Unpin ${assistant.name}` : `Pin ${assistant.name}`}
                    >
                      <Pin className={cn("size-3.5", assistant.isPinned && "fill-current")} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openStudio(assistant)}
                      aria-label={`Edit ${assistant.name}`}
                    >
                      <Edit3 className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDeleteTarget(assistant)}
                      aria-label={`Delete ${assistant.name}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => startChat(assistant)}
                  className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-left font-mono text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
                >
                  <span className="inline-flex items-center gap-1">
                    Start chat
                    <ArrowRight
                      className="size-3 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="tabular-nums">v{assistant.version}</span>
                </button>
              </Card>
            ))}
            {!searchQuery && newTile}
          </div>
        )}
      </div>

      <AssistantStudio
        isOpen={studioOpen}
        initialAssistant={editingAssistant}
        onClose={() => {
          setStudioOpen(false);
          setEditingAssistant(null);
        }}
        onSave={(saved) => {
          setAssistants((current) => {
            const exists = current.some((assistant) => assistant.id === saved.id);
            return exists
              ? current.map((assistant) => (assistant.id === saved.id ? saved : assistant))
              : [saved, ...current];
          });
        }}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete assistant?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${deleteTarget.name} will be removed from your assistant library. Existing chats are not deleted.`
                : "This assistant will be removed from your library."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void deleteAssistant()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete assistant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
