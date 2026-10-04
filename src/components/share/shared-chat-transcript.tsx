import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, Table2, Presentation } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { QuotedSelection } from "@/components/chat/quoted-selection";
import { parseQuotedMessage } from "@/lib/quote-context";
import { Markdown } from "@/components/chat/markdown";
import { splitMessageContent, type ArtifactType } from "@/lib/message-content";
import { runtimeFor } from "@/lib/artifact-runtime";
import { resolveModel } from "@/lib/models";
import { SharedTurnActions } from "@/components/share/shared-turn-actions";
import type { SharedArtifactRef, SharedChatMessage } from "@/lib/share";

/*
 * Read-only transcript for the public share page (server component; the
 * Markdown renderer is its client island). Mirrors the app's message voice:
 * user turns as subtly shaded bubbles, assistant turns flat and full-width
 * with Copy and the model name under each answer. Attachments, reasoning, and interactive blocks
 * are deliberately absent — a share shows the words, nothing else.
 */

const TYPE_ICON: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
  DESIGN: AppIcons.design,
  SPREADSHEET: Table2,
  DOCUMENT: FileText,
  PRESENTATION: Presentation,
};

/** Inert stand-in for an artifact tag inside the transcript. */
function ArtifactChip({ title, type }: { title: string; type: ArtifactType }) {
  const Icon = TYPE_ICON[type] ?? FileCode2;
  return (
    // The one raised object in a flat transcript: the artifact is a thing, not
    // prose, so it takes the tile recipe — `surface-raised` at rounded-card
    // with the app's inset icon tile inside (16 = 12 + 4, concentric). The
    // glyph is muted, as it is on the live artifact card: the accent marks
    // state, and a frozen share has none.
    <div className="surface-raised my-3 flex items-center gap-3 rounded-card px-4 py-3">
      <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
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
      {/* Below the answer, not above it: the model is a receipt for what was
          written, and a mono eyebrow over every reply read as a byline. */}
      <SharedTurnActions content={message.content} modelName={modelName} />
    </div>
  );
}

export function SharedChatTranscript({ messages, artifacts }: { messages: SharedChatMessage[]; artifacts: SharedArtifactRef[] }) {
  const artifactsByIdentifier = new Map(artifacts.map((a) => [a.identifier, a]));

  if (messages.length === 0) {
    return (
      <div className="py-16 text-center"><h2 className="font-serif text-title">Nothing here yet</h2><p className="mt-3 text-body text-muted-foreground">This conversation had no messages when it was shared.</p></div>
    );
  }

  return (
    <div className="space-y-6">
      {messages.map((m) =>
        m.role === "USER" ? (
          <SharedUserTurn key={m.id} content={m.content} />
        ) : (
          <AssistantMessage key={m.id} message={m} artifactsByIdentifier={artifactsByIdentifier} />
        )
      )}
    </div>
  );
}

/** A user turn, with a quoted selection drawn as the app draws it (message-item.tsx). */
function SharedUserTurn({ content }: { content: string }) {
  const quoted = parseQuotedMessage(content);
  const text = quoted ? quoted.request : content;
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end">
        {quoted && <QuotedSelection quote={quoted} standalone={!text} />}
        {text && <div className={USER_BUBBLE_CLASS}>{text}</div>}
      </div>
    </div>
  );
}
