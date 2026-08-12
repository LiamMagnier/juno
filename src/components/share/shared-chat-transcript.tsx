import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, PenTool } from "lucide-react";
import { Markdown } from "@/components/chat/markdown";
import { splitMessageContent, type ArtifactType } from "@/lib/message-content";
import { runtimeFor } from "@/lib/artifact-runtime";
import { resolveModel } from "@/lib/models";
import type { SharedArtifactRef, SharedChatMessage } from "@/lib/share";

/*
 * Read-only transcript for the public share page (server component; the
 * Markdown renderer is its client island). Mirrors the app's message voice:
 * user turns as subtly shaded bubbles, assistant turns flat and full-width
 * with a mono model eyebrow. Attachments, reasoning, and interactive blocks
 * are deliberately absent — a share shows the words, nothing else.
 */

const TYPE_ICON: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
  DESIGN: PenTool,
};

/** Inert stand-in for an artifact tag inside the transcript. */
function ArtifactChip({ title, type }: { title: string; type: ArtifactType }) {
  const Icon = TYPE_ICON[type] ?? FileCode2;
  return (
    // Opaque `bg-card` and a full-strength border: at /80 over the true-black
    // ground the chip composited to ~5.2%, below the card rung it is supposed to
    // sit ON, and its shadow-soft is black ink on black — so the one raised
    // object in a shared transcript read as a hairline rectangle. The dark
    // override is the lit INSET edge every raised surface on black uses.
    // Concentric radii: 14px shell, 12px of padding-to-icon, so the tile lands
    // on `rounded-field` (10px) rather than `rounded-lg`'s 16px — which was
    // ROUNDER than the container holding it.
    <div className="my-3 flex items-center gap-3 rounded-popover border border-border/70 bg-card px-4 py-3 shadow-soft dark:shadow-[inset_0_1px_0_hsl(var(--sheen)),0_1px_2px_hsl(0_0%_0%/0.4)]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="truncate text-body font-medium">{title}</p>
        <p className="font-mono text-caption text-muted-foreground">
          {runtimeFor(type).label} artifact
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({ message, artifactsByIdentifier }: { message: SharedChatMessage; artifactsByIdentifier: Map<string, SharedArtifactRef> }) {
  const modelName = message.model ? resolveModel(message.model)?.name ?? message.model : null;
  const parts = splitMessageContent(message.content);

  return (
    <div>
      {modelName && (
        <p className="mb-1.5 font-mono text-caption text-muted-foreground">{modelName}</p>
      )}
      <div className="space-y-1">
        {parts.map((part, i) => {
          if (part.type === "text") return <Markdown key={i} content={part.text} />;
          if (part.type === "artifact") {
            const ref = artifactsByIdentifier.get(part.identifier);
            return <ArtifactChip key={i} title={ref?.title ?? part.title ?? "Artifact"} type={ref?.type ?? part.artifactType ?? "CODE"} />;
          }
          // Interactive learning blocks are omitted from shared views.
          return null;
        })}
      </div>
    </div>
  );
}

export function SharedChatTranscript({ messages, artifacts }: { messages: SharedChatMessage[]; artifacts: SharedArtifactRef[] }) {
  const artifactsByIdentifier = new Map(artifacts.map((a) => [a.identifier, a]));

  if (messages.length === 0) {
    return (
      <div className="grid min-h-[40vh] place-items-center text-center">
        <div className="max-w-sm">
          <p className="font-serif text-heading">Nothing here yet</p>
          <p className="pt-1 text-body text-muted-foreground">
            This conversation had no messages when it was shared.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {messages.map((m) =>
        m.role === "USER" ? (
          <div key={m.id} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-md border border-border/50 bg-secondary px-4 py-2.5 text-body leading-relaxed [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-soft)]">
              {m.content}
            </div>
          </div>
        ) : (
          <AssistantMessage key={m.id} message={m} artifactsByIdentifier={artifactsByIdentifier} />
        )
      )}
    </div>
  );
}
