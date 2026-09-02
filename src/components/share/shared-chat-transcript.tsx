import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, PenTool } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
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
    // The one raised object in a flat transcript: the artifact is a thing, not
    // prose, so it takes the tile recipe — `surface-raised` at rounded-card
    // with the app's inset icon tile inside (16 = 12 + 4, concentric).
    <div className="surface-raised my-3 flex items-center gap-3 rounded-card px-4 py-3">
      <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-primary">
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
      <EmptyState
        size="page"
        title="Nothing here yet"
        description="This conversation had no messages when it was shared."
      />
    );
  }

  return (
    <div className="space-y-6">
      {messages.map((m) =>
        m.role === "USER" ? (
          <div key={m.id} className="flex justify-end">
            <div className={cn(USER_BUBBLE_CLASS, "max-w-[85%]")}>
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
