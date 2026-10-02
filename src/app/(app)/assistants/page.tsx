"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Pin, Plus } from "@/components/ui/icons";
import type { JunoAssistantConfig } from "@/lib/assistants";
import { AssistantStudio } from "@/components/assistants/assistant-studio";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
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
import { PRODUCT_NAME } from "@/lib/brand/names";
import { BRAND } from "@/lib/brand/names";

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
    } catch {
      // The throw used to land in a `finally` with no `catch`, and the call site
      // is `void deleteAssistant()`: a failed delete was an unhandled rejection,
      // so the dialog stayed open, the row stayed put and nothing was said. The
      // user pressed Delete again.
      toast.error("Couldn’t delete the assistant. Nothing was removed.");
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
    if (!response?.ok) {
      // Same silence as the delete above: the pin simply did not move.
      toast.error("Couldn’t update the pin.");
      return;
    }
    const data = await response.json();
    setAssistants((current) =>
      current.map((item) => (item.id === assistant.id ? data.assistant : item))
    );
  };

  // D-007: an assistant becomes a crew member with its prompt as the brief and
  // its starter prompts as ideas. It then leaves this list and opens as the
  // member's thread.
  const moveToCrew = async (assistant: JunoAssistantConfig) => {
    const response = await fetch(`/api/assistants/${assistant.id}/move-to-crew`, { method: "POST" }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as
      | { agent?: { name?: string; conversationId?: string | null }; message?: string }
      | null;
    if (!response?.ok || !data?.agent) {
      toast.error(data?.message ?? "Couldn’t move the assistant. Nothing changed.");
      return;
    }
    setAssistants((current) => current.filter((item) => item.id !== assistant.id));
    toast.success(`${data.agent.name ?? assistant.name} is an agent in ${BRAND.orbit.label} now.`);
    if (data.agent.conversationId) router.push(`/chat/${data.agent.conversationId}`);
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
      style={staggerDelay(filteredAssistants.length, "tight")}
      className="surface-inset flex min-h-40 items-center justify-center gap-2 rounded-card border-dashed border-border/80 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:border-foreground/30 hover:text-foreground motion-reduce:transition-none [animation-fill-mode:backwards] motion-safe:animate-rise-in"
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
        lede={`Focused ${PRODUCT_NAME} personalities with their own instructions, starter prompts and model preference.`}
        actions={
          <Button onClick={() => openStudio(null)}>
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
            icon={StatusIcons.error}
            title="Assistants are unavailable"
            description={`${PRODUCT_NAME} could not read your assistant library. Nothing was deleted; retry the request.`}
            action={
              <Button variant="outline" size="sm" onClick={() => void fetchAssistants()}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          // The tile's anatomy in placeholder form — icon well, name, two
          // lines of description, the footer rule — so nothing changes shape
          // when the gallery lands. It was three bare slabs.
          <div className="grid gap-4 @[40rem]/page:grid-cols-2 @5xl/page:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="surface-raised flex min-h-40 flex-col gap-3 rounded-card p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(index, "tight")}
              >
                <div className="flex items-start gap-3">
                  <Skeleton className="size-9 shrink-0 rounded-field" />
                  <div className="min-w-0 flex-1 space-y-2 pt-1">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="h-2.5 w-8" />
                </div>
              </div>
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
                <Button onClick={() => openStudio(null)}>
                  <Plus className="size-4" aria-hidden="true" />
                  Create assistant
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 @[40rem]/page:grid-cols-2 @5xl/page:grid-cols-3">
            {filteredAssistants.map((assistant, i) => (
              <Card
                key={assistant.id}
                variant="interactive"
                // Tonal hover, no lift: the interactive variant owns it (ICONS_AND_MOTION §2.2).
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
                    <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none">
                      <AssistantIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 pt-0.5">
                      <span className="flex items-center gap-1.5 text-ui font-medium text-foreground">
                        <span className="truncate">{assistant.name}</span>
                        {assistant.isPinned && (
                          <Pin weight="fill" motion="none" className="size-3 shrink-0 text-primary" aria-label="Pinned" />
                        )}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-caption leading-5 text-muted-foreground">
                        {assistant.description || `Custom ${PRODUCT_NAME} assistant`}
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
                      aria-pressed={!!assistant.isPinned}
                      title={assistant.isPinned ? "Unpin" : "Pin"}
                      className={cn(
                        "text-muted-foreground hover:text-foreground",
                        assistant.isPinned && "text-primary hover:text-primary"
                      )}
                    >
                      <IconSwap
                        swapped={!!assistant.isPinned}
                        from={<Pin className="size-3.5" />}
                        to={<Pin weight="fill" className="size-3.5" />}
                      />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openStudio(assistant)}
                      aria-label={`Edit ${assistant.name}`}
                      title="Edit"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ActionIcons.edit className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void moveToCrew(assistant)}
                      aria-label={`Move ${assistant.name} to ${BRAND.orbit.label}`}
                      title={`Move to ${BRAND.orbit.label}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <AppIcons.agents className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDeleteTarget(assistant)}
                      aria-label={`Delete ${assistant.name}`}
                      title="Delete"
                      className="danger-hover text-muted-foreground"
                    >
                      <ActionIcons.delete className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => startChat(assistant)}
                  className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-left font-mono text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
                >
                  {/* The arrow's nudge is its own articulation (icons.tsx),
                      played when this footer button is pointed at — not a
                      second translate keyed to the whole card's hover. */}
                  <span className="inline-flex items-center gap-1.5">
                    Start chat
                    <ArrowRight className="size-3" aria-hidden="true" />
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
