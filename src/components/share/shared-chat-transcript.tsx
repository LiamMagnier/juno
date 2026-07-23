import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon } from "lucide-react";
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
};

/** Inert stand-in for an artifact tag inside the transcript. */
function ArtifactChip({ title, type }: { title: string; type: ArtifactType }) {
  const Icon = TYPE_ICON[type] ?? FileCode2;
  return (
    <div className="my-3 flex items-center gap-3 rounded-[18px] border border-border/70 bg-card/80 px-4 py-3 shadow-soft">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="font-mono text-[10px] text-muted-foreground">
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
        <p className="mb-1.5 font-mono text-[10px] text-muted-foreground">{modelName}</p>
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
          <p className="pt-1 text-sm leading-6 text-muted-foreground">
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
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-border/50 bg-secondary px-4 py-2.5 text-body leading-relaxed [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-soft)]">
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
