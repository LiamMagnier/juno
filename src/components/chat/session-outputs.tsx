"use client";

import * as React from "react";
import { ArtifactPreview } from "@/components/artifacts/artifact-preview";
import { Pressable } from "@/components/ui/pressable";
import { RollingNumber } from "@/components/ui/micro";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppIcons, CodeIcons, ComposerIcons } from "@/lib/app-icons";
import { SettingsIcons } from "@/lib/app-icons";
import { resolveModel } from "@/lib/models";
import { STAGGER, staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";
import { extensionOf } from "@/components/chat/file-preview";
import type { ClientArtifact, ClientAttachment, ClientMessage } from "@/types/chat";

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
  /** Generated media, which opens in the file viewer. */
  attachment?: ClientAttachment;
  sortKey: string;
};

type UsedRow = {
  id: string;
  Glyph: React.ComponentType<{ className?: string }>;
  label: string;
  /** The specific thing — a file name, a count, a memory's subject. Absent rows
   *  still render: "it happened" is the whole message for some of these. */
  detail?: string;
  /** The files behind an Uploads row, each of which opens in the viewer. */
  files?: ClientAttachment[];
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

  const uploads: ClientAttachment[] = [];
  /*
   * WHICH MODEL ACTUALLY ANSWERED, in order of first appearance.
   *
   * `Message.model` is the EFFECTIVE model — `modelId = modelInfo.id` in the
   * chat route, set after eligibility, provider health and any Auto
   * substitution have had their say — so this is the one place in the product
   * that reports what was really called rather than what was asked for. That
   * distinction is the whole reason the row exists: a person who picks a model
   * and gets billed for another has no way to notice from a picker that keeps
   * showing their choice, because the picker shows the CONVERSATION's sticky
   * selection and the turn is a different fact.
   */
  const models: string[] = [];
  let searchTurns = 0;
  const searchSources = new Set<string>();
  const memories = new Set<string>();
  let memorySubject: string | undefined;
  const connectors = new Set<string>();

  for (const m of messages) {
    for (const att of m.attachments) {
      if (m.role === "USER") {
        if (!uploads.some((u) => u.id === att.id)) uploads.push(att);
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
          attachment: att,
          sortKey: m.createdAt,
        });
      }
    }

    if (m.role === "ASSISTANT" && m.model && !models.includes(m.model)) models.push(m.model);

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
  if (models.length > 0) {
    const names = models.map((id) => resolveModel(id)?.name ?? id);
    used.push({
      id: "models",
      Glyph: SettingsIcons.models,
      // Plural when a conversation changed models mid-way, which is worth
      // noticing on its own: it means an answer above was not written by the
      // model the composer is showing you now.
      label: names.length === 1 ? "Model" : "Models",
      detail: names.length <= 2 ? names.join(" · ") : `${names[0]} +${names.length - 1}`,
    });
  }
  if (uploads.length > 0) {
    used.push({
      id: "uploads",
      Glyph: ComposerIcons.attach,
      label: "Uploads",
      // The name when there is one thing, the count when there are several:
      // "3 files" is what a person checking their own session wants, and a
      // list of three truncated names in a 120px column is what they get from
      // the alternative.
      detail: uploads.length === 1 ? uploads[0].fileName : `${uploads.length} files`,
      files: uploads,
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
  onOpenAttachment,
  className,
}: {
  artifacts: ClientArtifact[];
  messages: ClientMessage[];
  onOpenArtifact: (identifier: string) => void;
  /** Open an uploaded file in the side viewer; without it the row only counts. */
  onOpenAttachment?: (attachment: ClientAttachment) => void;
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
              {/* It rolls because it CHANGES WHILE YOU WATCH: an artifact
                  finishing mid-answer is the one moment this chip has to
                  announce itself, and a digit that cuts is indistinguishable
                  from a digit that was always there. */}
              {outputs.length > 0 && <RollingNumber value={outputs.length} />}
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
              {/* TWO COLUMNS ONLY WHEN THERE ARE TWO THINGS. A lone tile in a
                  two-column grid is a 150px card with 170px of nothing beside
                  it, which reads as a panel that failed to load the rest. One
                  output takes the full width and turns landscape to fill it;
                  the card is the same card either way. */}
              <ul className={cn("mt-3 grid gap-x-3 gap-y-4", outputs.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
                {/* Dealt in on the base rung as the popover lands, so the
                    tiles arrive as a set rather than as one repaint. */}
                {outputs.map((o, i) => (
                  <li
                    key={o.id}
                    className="min-w-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                    style={staggerDelay(i)}
                  >
                    <OutputCard
                      wide={outputs.length === 1}
                      tile={o}
                      onOpen={
                        o.identifier
                          ? () => {
                              setOpen(false);
                              onOpenArtifact(o.identifier!);
                            }
                          : o.attachment && onOpenAttachment
                            ? () => {
                                setOpen(false);
                                onOpenAttachment(o.attachment!);
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
                {used.map((row, i) => (
                  <li
                    key={row.id}
                    className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                    // After the tiles, on the tight rung: rows are lighter
                    // than cards and follow them rather than racing them.
                    style={staggerDelay(i, "tight", Math.min(outputs.length, 8) * STAGGER.base)}
                  >
                    <div className="flex h-8 items-center gap-2.5 text-ui">
                      <row.Glyph className="size-4 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 text-foreground">{row.label}</span>
                      {row.detail && (
                        <span className="ml-auto min-w-0 truncate text-right text-muted-foreground">{row.detail}</span>
                      )}
                    </div>
                    {/* Each upload, openable — the file you are judging an
                        answer against is one press from the answer. */}
                    {row.files && onOpenAttachment && (
                      <ul className="mb-1 ml-6 space-y-px">
                        {row.files.slice(0, 8).map((file) => (
                          <li key={file.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setOpen(false);
                                onOpenAttachment(file);
                              }}
                              className="pressable flex h-7 w-full min-w-0 items-center gap-2 rounded-control px-1.5 text-left text-caption text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-10"
                            >
                              <span className="grid h-4.5 min-w-8 shrink-0 place-items-center rounded-xs bg-secondary px-1 font-mono text-micro">
                                {extensionOf(file)}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                              <span className="shrink-0 font-mono text-micro opacity-70">Open</span>
                            </button>
                          </li>
                        ))}
                        {row.files.length > 8 && (
                          <li className="px-1.5 py-1 font-mono text-micro text-muted-foreground">+{row.files.length - 8} more in the chat</li>
                        )}
                      </ul>
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
function OutputCard({ tile, onOpen, wide }: { tile: OutputTile; onOpen?: () => void; wide?: boolean }) {
  // 4:3 in a column, 16:9 across the panel: a full-width tile at 4:3 is 216px
  // tall and turns a one-item list into a poster.
  const ratio = wide ? "aspect-[16/9]" : "aspect-[4/3]";
  const body = (
    <>
      {tile.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the generated
        // asset's own URL at thumbnail size; next/image would re-fetch and
        // re-encode bytes the transcript has already loaded above.
        <img
          src={tile.imageUrl}
          alt=""
          className={cn("surface-inset w-full rounded-field object-cover", ratio)}
          loading="lazy"
        />
      ) : (
        <ArtifactPreview type={tile.type} preview={tile.preview} title={tile.title} className={cn("w-full", ratio)} />
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
      // Focus is the global `:focus-visible` outline — the local ring that
      // replaced it drew a different focus from every other tile in the app.
      className="group/tile block w-full min-w-0 rounded-field text-left transition-opacity duration-fast ease-out-soft hover:opacity-80 motion-reduce:transition-none"
    >
      {body}
    </button>
  );
}
