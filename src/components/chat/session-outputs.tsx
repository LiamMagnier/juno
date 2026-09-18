"use client";

import * as React from "react";
import { ArtifactPreview } from "@/components/artifacts/artifact-preview";
import { Pressable } from "@/components/ui/pressable";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppIcons, CodeIcons, ComposerIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";
import type { ClientArtifact, ClientMessage } from "@/types/chat";

/* ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CONVERSATION MADE, AND WHAT IT USED TO MAKE IT.
 *
 * A chat is a scroll, and a scroll is the worst possible index of itself. By
 * the time a session has produced three documents, read two memories and
 * searched the web, every one of those facts is somewhere above the fold,
 * interleaved with the prose that produced it — so "where is the spreadsheet
 * you wrote" and "did you actually look this up" are both answered by
 * scrolling and squinting. This panel answers them in one place, from the
 * transcript that is already in memory.
 *
 * TWO LISTS, AND THE SPLIT IS THE POINT. Outputs are things that OUTLIVE the
 * conversation: an artifact you will open again, an image you will download.
 * "Used in this session" is provenance — the uploads, the searches, the
 * remembered facts and the connectors that went INTO the answers, which you
 * care about while judging them and then never again. A single mixed list
 * would put a document you want to keep next to a memory read you wanted to
 * audit, and the reader would have to sort the two kinds apart by eye every
 * time they opened it.
 *
 * IT DERIVES, IT DOES NOT FETCH. Every row here is already on the client:
 * artifacts arrive with the conversation, attachments ride on their messages,
 * sources and the activity trail are part of each turn. A panel behind a
 * button that a person opens once per session must not cost a round trip —
 * and a fetch would additionally be able to disagree with the transcript
 * beside it, which is the one thing an index must never do.
 *
 * NOTHING HERE IS A CLAIM THE TRANSCRIPT CANNOT BACK. A "Web search" row
 * appears because a turn carried search activity or cited sources, not
 * because the model was ALLOWED to search; "Memory" counts the facts a turn
 * actually received, which is what `memoryReceipt` is. A provenance panel
 * that reports capability rather than use is worse than no panel, because it
 * reads as evidence.
 */

/** What a tile calls each artifact type, in the reader's words rather than the enum's. */
const TYPE_LABEL: Record<ArtifactType, string> = {
  MARKDOWN: "Doc",
  HTML: "Web page",
  REACT: "Component",
  CODE: "Code",
  SVG: "Image",
  MERMAID: "Diagram",
  DESIGN: "Design",
};

type OutputTile = {
  id: string;
  /** Present for artifacts; absent for generated media, which has no canvas to open. */
  identifier?: string;
  title: string;
  label: string;
  type: ArtifactType;
  preview: string | null;
  /** Generated media renders its own bytes rather than a source excerpt. */
  imageUrl?: string;
  sortKey: string;
};

type UsedRow = {
  id: string;
  Glyph: React.ComponentType<{ className?: string }>;
  label: string;
  /** The specific thing — a file name, a count, a memory's subject. Absent rows
   *  still render: "it happened" is the whole message for some of these. */
  detail?: string;
};

/**
 * The transcript, read as an index.
 *
 * One pass over the messages. Every branch is `!= null`-guarded on fields that
 * are optional in `ClientMessage` because they are genuinely absent on older
 * rows and on private turns, and an absent field is "unknown", never zero —
 * see the cache-token note in types/chat.ts for the same rule stated once.
 */
function readSession(artifacts: ClientArtifact[], messages: ClientMessage[]) {
  const outputs: OutputTile[] = artifacts.map((a) => ({
    id: a.id,
    identifier: a.identifier,
    title: a.title,
    label: a.type === "CODE" && a.language ? a.language : (TYPE_LABEL[a.type] ?? "File"),
    type: a.type,
    preview: a.content || null,
    sortKey: a.updatedAt,
  }));

  const uploads: string[] = [];
  let searchTurns = 0;
  const searchSources = new Set<string>();
  const memories = new Set<string>();
  let memorySubject: string | undefined;
  const connectors = new Set<string>();

  for (const m of messages) {
    for (const att of m.attachments) {
      if (m.role === "USER") {
        uploads.push(att.fileName);
        continue;
      }
      // An assistant attachment is generated media — the only output that is
      // bytes rather than source, so it shows itself rather than an excerpt.
      if (att.kind === "IMAGE") {
        outputs.push({
          id: att.id,
          title: att.fileName,
          label: "Image",
          type: "SVG",
          preview: null,
          imageUrl: att.url,
          sortKey: m.createdAt,
        });
      }
    }

    if (m.sources?.length) {
      searchTurns += 1;
      for (const s of m.sources) if (s.url) searchSources.add(s.url);
    }
    for (const ev of m.activity ?? []) {
      if (ev.kind === "search" && !m.sources?.length) searchTurns += 1;
      if (ev.kind === "visit" && ev.url) searchSources.add(ev.url);
      for (const receipt of ev.memoryReceipt ?? []) {
        memories.add(receipt.id);
        memorySubject ??= receipt.category ?? undefined;
      }
      if (ev.kind === "tool" && ev.tool?.server) connectors.add(ev.tool.server);
    }
  }

  outputs.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  const used: UsedRow[] = [];
  if (uploads.length > 0) {
    used.push({
      id: "uploads",
      Glyph: ComposerIcons.attach,
      label: "Uploads",
      // The name when there is one thing, the count when there are several:
      // "3 files" is what a person checking their own session wants, and a
      // list of three truncated names in a 120px column is what they get from
      // the alternative.
      detail: uploads.length === 1 ? uploads[0] : `${uploads.length} files`,
    });
  }
  if (searchTurns > 0 || searchSources.size > 0) {
    used.push({
      id: "search",
      Glyph: ComposerIcons.web,
      label: "Web search",
      detail: searchSources.size > 0 ? `${searchSources.size} ${searchSources.size === 1 ? "source" : "sources"}` : undefined,
    });
  }
  if (memories.size > 0) {
    used.push({
      id: "memory",
      Glyph: ComposerIcons.memory,
      label: "Memory",
      detail: memorySubject ? `Read · ${memorySubject}` : `Read · ${memories.size} ${memories.size === 1 ? "fact" : "facts"}`,
    });
  }
  if (connectors.size > 0) {
    const names = [...connectors];
    used.push({
      id: "connectors",
      Glyph: AppIcons.connections,
      label: names.length === 1 ? "Connector" : "Connectors",
      detail: names.length <= 2 ? names.join(" · ") : `${names.length} used`,
    });
  }

  return { outputs, used };
}

export function SessionOutputs({
  artifacts,
  messages,
  onOpenArtifact,
  className,
}: {
  artifacts: ClientArtifact[];
  messages: ClientMessage[];
  onOpenArtifact: (identifier: string) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { outputs, used } = React.useMemo(() => readSession(artifacts, messages), [artifacts, messages]);

  // NO TRIGGER FOR AN EMPTY SESSION. A button that opens onto "nothing yet" is
  // a promise the chat has not made; the first artifact or the first upload is
  // what makes this panel mean something, and it appears then.
  if (outputs.length === 0 && used.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Pressable
              kind="chip"
              size="lg"
              aria-label={outputs.length > 0 ? `Outputs — ${outputs.length} in this chat` : "What this chat used"}
              /* `h-9`, which is a chip's size `lg` (32) overridden to the
                 icon buttons' 36 beside it. A row of controls that do not
                 share a height reads as two rows that failed to line up, and
                 this is the only one of the three carrying a number — the
                 chip's border is what says so, and it should not also be
                 saying "shorter". */
              className={cn("h-9 gap-1.5 text-foreground/75 coarse:h-11", className)}
            >
              <CodeIcons.file className="size-4" />
              {outputs.length > 0 && <span className="tabular-nums">{outputs.length}</span>}
            </Pressable>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Outputs</TooltipContent>
      </Tooltip>

      {/* `w-[21rem]`, not the popover's default 18: two tiles and the gap
          between them are what set this width, and a one-column fallback would
          make three documents a scroll where the reference shows them at a
          glance. `p-0` moves the padding onto the sections so the scroller's
          edge is the card's, not an inset rectangle inside it. */}
      <PopoverContent align="end" sideOffset={8} className="w-[21rem] p-0">
        <div className="max-h-[min(30rem,70vh)] overflow-y-auto overscroll-contain p-4">
          {outputs.length > 0 && (
            <section aria-labelledby="session-outputs-heading">
              <h2 id="session-outputs-heading" className="text-body font-medium text-foreground">
                Outputs
              </h2>
              <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4">
                {outputs.map((o) => (
                  <li key={o.id} className="min-w-0">
                    <OutputCard
                      tile={o}
                      onOpen={
                        o.identifier
                          ? () => {
                              setOpen(false);
                              onOpenArtifact(o.identifier!);
                            }
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {used.length > 0 && (
            <section
              aria-labelledby="session-used-heading"
              /* The hairline only exists between two lists. With no outputs
                 this section is the card, and a rule above it would be a
                 divider with nothing on the other side. */
              className={cn(outputs.length > 0 && "mt-5 border-t border-border/60 pt-4")}
            >
              <h2 id="session-used-heading" className="text-body font-medium text-foreground">
                Used in this session
              </h2>
              <ul className="mt-2 space-y-0.5">
                {used.map((row) => (
                  <li key={row.id} className="flex h-8 items-center gap-2.5 text-ui">
                    <row.Glyph className="size-4 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-foreground">{row.label}</span>
                    {row.detail && (
                      <span className="ml-auto min-w-0 truncate text-right text-muted-foreground">{row.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One tile: a picture of the thing, its name, and what kind of thing it is.
 *
 * A `<button>` only when there is somewhere to go. An artifact opens its
 * canvas; a generated image has no second view, and a control that looks
 * pressable and does nothing is worse than a static card.
 */
function OutputCard({ tile, onOpen }: { tile: OutputTile; onOpen?: () => void }) {
  const body = (
    <>
      {tile.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the generated
        // asset's own URL at thumbnail size; next/image would re-fetch and
        // re-encode bytes the transcript has already loaded above.
        <img
          src={tile.imageUrl}
          alt=""
          className="surface-inset aspect-[4/3] w-full rounded-field object-cover"
          loading="lazy"
        />
      ) : (
        <ArtifactPreview type={tile.type} preview={tile.preview} title={tile.title} className="aspect-[4/3] w-full" />
      )}
      <p className="mt-2 truncate text-ui text-foreground">{tile.title}</p>
      <p className="truncate text-caption text-muted-foreground">{tile.label}</p>
    </>
  );

  if (!onOpen) return <div className="min-w-0">{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/tile block w-full min-w-0 rounded-field text-left transition-opacity duration-fast ease-out-soft hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      {body}
    </button>
  );
}
