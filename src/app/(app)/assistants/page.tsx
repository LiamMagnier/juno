"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Edit3, Pin, Plus, Trash2 } from "lucide-react";
import type { JunoAssistantConfig } from "@/lib/assistants";
import { AssistantStudio } from "@/components/assistants/assistant-studio";
import { AppIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page-header";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

/**
 * Custom Juno assistants — the product's equivalent of reusable Gems / custom
 * assistants, presented in the same editorial shell as Projects, Work and Code.
 *
 * This page used to be a visual island built from `neutral-*`, `coral-*`, raw
 * inputs, private cards and browser `confirm()`. Moving it onto semantic tokens
 * is not a palette swap: it makes appearance/accent settings, focus states,
 * coarse-pointer targets, dark mode and future design-token changes propagate
 * here exactly as they do everywhere else.
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

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-6xl">
        <AppPageHeader
          eyebrow="Assistants"
          heading="Specialists you can reuse"
          icon={AssistantIcon}
          lede="Create focused Juno personalities with their own instructions, starter prompts and model preference, then start them from the same Chat surface as everything else."
          actions={
            <Button
              onClick={() => {
                setEditingAssistant(null);
                setStudioOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="size-4" aria-hidden="true" />
              New assistant
            </Button>
          }
        />

        <div className="mb-6 max-w-md">
          <div className="relative">
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
        </div>

        {failed ? (
          <EmptyState
            icon={AssistantIcon}
            title="Assistants are unavailable"
            description="Juno could not read your assistant library. Nothing was deleted; retry the request."
            action={<Button onClick={() => void fetchAssistants()}>Retry</Button>}
          />
        ) : loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-44 animate-pulse rounded-card border border-border/50 bg-muted/55 motion-reduce:animate-none"
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
              searchQuery ? undefined : (
                <Button
                  onClick={() => {
                    setEditingAssistant(null);
                    setStudioOpen(true);
                  }}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Create assistant
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredAssistants.map((assistant) => (
              <article
                key={assistant.id}
                className="group relative flex min-h-44 flex-col rounded-card border border-border/60 bg-card p-5 shadow-soft transition-[border-color,box-shadow,transform] duration-fast ease-out-soft hover:border-border hover:shadow-pop motion-reduce:transition-none"
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => startChat(assistant)}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Start a chat with ${assistant.name}`}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent text-accent-foreground">
                      <AssistantIcon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 pt-0.5">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        <span className="truncate">{assistant.name}</span>
                        {assistant.isPinned && (
                          <Pin className="size-3 fill-current text-primary" aria-label="Pinned" />
                        )}
                      </span>
                      <span className="mt-1 block line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                        {assistant.description || "Custom Juno assistant"}
                      </span>
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100">
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
                      onClick={() => {
                        setEditingAssistant(assistant);
                        setStudioOpen(true);
                      }}
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
                  className="mt-auto flex min-h-11 items-center justify-between gap-3 border-t border-border/50 pt-3 text-left text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>Start chat</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="font-mono text-micro">v{assistant.version}</span>
                    <ArrowRight className="size-3.5 transition-transform duration-fast group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                  </span>
                </button>
              </article>
            ))}
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
    </div>
  );
}
