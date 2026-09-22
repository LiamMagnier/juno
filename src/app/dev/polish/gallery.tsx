"use client";

import * as React from "react";

import NewChatLoading from "@/app/(app)/chat/loading";
import ConversationLoading from "@/app/(app)/chat/[id]/loading";
import AppGroupLoading from "@/app/(app)/loading";
import { AppPageHeaderSkeleton } from "@/components/app/app-page";
import { CHAT_COMPOSER_FIELD_ID } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { StarterChips } from "@/components/chat/starter-chips";
import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerFieldClass,
  composerIconButtonClass,
  composerChipClass,
  COMPOSER_REST_HEIGHT,
} from "@/components/ui/composer-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronDown, Plus } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientArtifact } from "@/types/chat";

/*
 * Fixture data. Plain objects in the shape `use-chat` hands the transcript,
 * so the real MessageItem renders them exactly as it renders a live thread.
 */
const AT = "2026-09-22T09:14:00.000Z";

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: AT, attachments: [], ...partial };
}

const QUESTION = message({
  id: "fixture-user-1",
  role: "USER",
  content: "Can you explain how prompt caching works, and when it actually saves money?",
});

const ANSWER = message({
  id: "fixture-assistant-1",
  role: "ASSISTANT",
  model: "claude-opus-4-1",
  content: [
    "Prompt caching stores the processed form of the beginning of a prompt, so the next request that starts the same way skips that work. You pay a little more to write the cache once, then much less each time it is read.",
    "",
    "It saves money when three things are true:",
    "",
    "- **The prefix is long.** A system prompt, a tool list or a document you ask several questions about.",
    "- **It repeats within the cache lifetime.** Usually five minutes, refreshed on every hit.",
    "- **Only the end changes.** Anything after the first changed token is processed in full.",
    "",
    "For a single one-off question it costs slightly more, so turn it on where the same context is reused, like a chat over one long PDF.",
  ].join("\n"),
});

const LONG_QUESTION = message({
  id: "fixture-user-2",
  role: "USER",
  content: Array.from({ length: 9 }, (_, i) =>
    [
      `Section ${i + 1}. The quarterly report covers revenue across the three regions, with the northern region up eleven percent on the same quarter last year.`,
      "Costs were flat apart from a one-off hosting migration, and headcount grew by four in support.",
    ].join(" "),
  ).join("\n\n"),
});

const EDITED = message({
  id: "fixture-user-3",
  role: "USER",
  content: "Rewrite the summary so it leads with the northern region and keeps it under 120 words.",
});

const THINKING = message({
  id: "fixture-assistant-thinking",
  role: "ASSISTANT",
  content: "",
  streaming: true,
});

const THINKING_WITH_TRACE = message({
  id: "fixture-assistant-trace",
  role: "ASSISTANT",
  content: "",
  streaming: true,
  reasoning:
    "The user wants the summary rewritten. Lead with the northern region, keep the eleven percent figure, and fold the cost note into one sentence so it fits the limit.",
});

const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const noop = () => {};

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-polish-section className="border-t border-border py-10">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-body text-muted-foreground">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-caption text-muted-foreground">{children}</p>;
}

/** A turn, drawn by the real MessageItem, in the transcript's own column. */
function Turn({ m, editOnRequest = false }: { m: ChatMessage; editOnRequest?: boolean }) {
  return (
    <MessageItem
      message={m}
      isLast={m.role === "ASSISTANT"}
      busy={false}
      status={m.streaming ? "thinking" : undefined}
      artifactsByIdentifier={NO_ARTIFACTS}
      onOpenArtifact={noop}
      onEdit={noop}
      editOnRequest={editOnRequest}
      onFeedback={noop}
      canFeedback={false}
    />
  );
}

/** The landing, as chat-view draws it: greeting, composer, chips. */
function Landing() {
  const chipsRef = React.useRef<HTMLDivElement>(null);
  const [draft, setDraft] = React.useState("");
  const [measured, setMeasured] = React.useState<number | null>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  // Open the "Code" chip once the row has been dealt in, so the examples are
  // on screen for a static capture.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const chips = chipsRef.current?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
      chips?.[2]?.click();
    }, 700);
    return () => window.clearTimeout(timer);
  }, []);

  React.useLayoutEffect(() => {
    if (shellRef.current) setMeasured(Math.round(shellRef.current.getBoundingClientRect().height));
  }, []);

  return (
    <div className="flex flex-col items-center pb-48">
      <p className="mb-6 self-start text-caption text-muted-foreground" data-rest-height={measured ?? undefined}>
        Measured composer: {measured ?? "…"}px. COMPOSER_REST_HEIGHT: {COMPOSER_REST_HEIGHT.pointer}px.
      </p>
      <h1 className="mb-6 text-balance text-center font-serif text-display font-normal sm:mb-8">
        How can I help, <span className="italic">Liam</span>?
      </h1>
      <div className="w-full max-w-3xl">
        <ComposerShell
          ref={shellRef}
          field={
            <textarea
              id={CHAT_COMPOSER_FIELD_ID}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              aria-label="Ask Juno"
              placeholder="Ask Juno"
              className={composerFieldClass}
            />
          }
          leading={
            <button type="button" aria-label="Add" className={cn("grid place-items-center", composerIconButtonClass)}>
              <Plus className="size-4" />
            </button>
          }
          trailing={
            <button type="button" className={composerChipClass}>
              <span className="truncate">Opus 4.1</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
          }
          action={<ComposerPrimaryAction face={draft.trim() ? "send" : "voice"} aria-label={draft.trim() ? "Send" : "Voice"} />}
        />
        <div ref={chipsRef}>
          <StarterChips />
        </div>
      </div>
    </div>
  );
}

export function PolishGallery() {
  const [filter, setFilter] = React.useState("all");

  // Open the third turn in its editor, the way ↑ in an empty composer does.
  React.useEffect(() => {
    const timer = window.setTimeout(() => window.dispatchEvent(new Event("juno:edit-last-user-message")), 300);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="page-gutter mx-auto max-w-3xl py-10">
        <h1 className="text-page-title">Thread and states</h1>
        <p className="mt-1.5 text-body text-muted-foreground">
          The conversation, its states and the primitives under them, rendered from the real components.
        </p>

        <Section
          title="Reading size"
          note="Both speakers on the 16px reading rung. The bubble and the reply are one size, and the reply keeps its 75ch measure."
        >
          <div className="space-y-6">
            <Turn m={QUESTION} />
            <Turn m={ANSWER} />
            <Turn m={LONG_QUESTION} />
          </div>
        </Section>

        <Section title="Thinking" note="The quiet line at the reply's own size, then the same line above a live reasoning trace.">
          <div className="space-y-6">
            <Turn m={THINKING} />
            <Turn m={THINKING_WITH_TRACE} />
          </div>
        </Section>

        <Section title="Editing a sent message" note="In the bubble, full column width. Enter sends, Shift+Enter adds a line, Esc puts it back.">
          <Turn m={EDITED} editOnRequest />
        </Section>

        <Section title="Starter chips" note="A chip opens three example prompts under the row. An example seeds the composer and never sends.">
          <Landing />
        </Section>

        <Section title="Empty and error states">
          <div className="grid gap-8">
            <div>
              <Label>Page, empty</Label>
              <EmptyState
                icon={AppIcons.projects}
                title="No projects yet"
                description="A project keeps chats, files and instructions together, so Juno starts every chat in it with the same context."
                action={
                  <Button size="sm" className="gap-1.5">
                    <Plus className="size-4" aria-hidden="true" /> New project
                  </Button>
                }
              />
            </div>
            <div>
              <Label>Page, error</Label>
              <EmptyState
                tone="error"
                icon={StatusIcons.error}
                title="This conversation couldn’t load"
                description="The thread didn’t load. Nothing in it was changed or deleted, and trying again usually brings it back."
                action={
                  <>
                    <Button size="sm" className="gap-1.5">
                      <ActionIcons.refresh className="size-4" aria-hidden="true" />
                      Try again
                    </Button>
                    <Button size="sm" variant="outline">
                      Back to chat
                    </Button>
                  </>
                }
              />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label>Panel, empty</Label>
                <EmptyState size="panel" icon={AppIcons.library} title="No files yet" description="Files you add to this project show up here." />
              </div>
              <div>
                <Label>Panel, error</Label>
                <EmptyState
                  size="panel"
                  tone="error"
                  icon={StatusIcons.error}
                  title="Couldn’t load your library"
                  description="The request didn’t go through. Nothing was lost, so try again."
                  action={
                    <Button variant="outline" size="sm">
                      Try again
                    </Button>
                  }
                />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Text field" note="Rest, hover one step toward ink, focus on the accent edge with a soft halo.">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label>Rest</Label>
              <Input placeholder="Search projects" data-demo="rest" />
            </div>
            <div>
              <Label>Hover</Label>
              <Input placeholder="Search projects" data-demo="hover" />
            </div>
            <div>
              <Label>Focus</Label>
              <Input placeholder="Search projects" defaultValue="Quarterly" data-demo="focus" />
            </div>
          </div>
          <div className="mt-6">
            <Label>Segmented control with counts</Label>
            <SegmentedControl
              ariaLabel="Filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: 24 },
                { value: "files", label: "Files", count: 17 },
                { value: "artifacts", label: "Artifacts", count: 7 },
              ]}
            />
          </div>
        </Section>

        <Section title="Loading" note="Each skeleton in the frame of the page it stands in for.">
          <div className="grid gap-6">
            <div>
              <Label>New chat</Label>
              <div className="h-[520px] overflow-hidden rounded-card border border-border">
                <NewChatLoading />
              </div>
            </div>
            <div>
              <Label>Conversation</Label>
              <div className="h-[560px] overflow-hidden rounded-card border border-border">
                <ConversationLoading />
              </div>
            </div>
            <div>
              <Label>App page</Label>
              <div className="h-[520px] overflow-hidden rounded-card border border-border">
                <AppGroupLoading />
              </div>
            </div>
            <div>
              <Label>Header with a back link and eyebrow</Label>
              <AppPageHeaderSkeleton nav headingWidth="w-64" />
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
