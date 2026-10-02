"use client";

import * as React from "react";
import { AppIcons } from "@/lib/app-icons";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { AgentFace } from "@/components/agents/agent-face";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { ContextTokenKind } from "@/lib/chat/context-tokens";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

/*
 * THE MARK A CONTEXT TOKEN IS DRAWN WITH: the thing's own face, logo or file
 * type (INTERACTION_SPEC S1, C8). These are entity marks, the one place colour
 * enters the composer: an app keeps its brand mark, a spreadsheet is green and
 * a PDF red, an agent shows its face. Everything that is a place rather than a
 * thing (a project, a chat, a skill) takes the interface set in the second ink.
 *
 * One component for the palette row, the token in the draft and the token's
 * popover, so the three can never disagree about what a thing looks like.
 * Drawn from `icon` (the mention search's key, also kept on the token's meta)
 * so a token restored without its palette row still has its right mark.
 */

export interface ContextMarkSource {
  kind: ContextTokenKind;
  id: string;
  /** The mention search's icon key: `file:sheet`, `app:github`, `artifact:html`. */
  icon?: string;
  /** Agents: their face. Without it (a token restored before its lookup lands) the Orbit glyph stands in. */
  avatar?: AgentAvatar;
  /** App: the connector id when it is not `id`. */
  connectorId?: string;
}

const PAGE = "M6.2 2.75h7.9l5.15 5.1V20a1.25 1.25 0 0 1-1.25 1.25H6.2A1.25 1.25 0 0 1 4.95 20V4A1.25 1.25 0 0 1 6.2 2.75Z";
const FOLD = "M14.1 2.75V7.85h5.15";

/** The coloured file pages, for the types people recognise by colour; null for the rest. */
function filePage(variant: string, size: number): React.ReactNode {
  const page = (fill: string, fold: string, detail: React.ReactNode) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path d={PAGE} fill={fill} />
      <path d={FOLD} fill={fold} />
      {detail}
    </svg>
  );
  switch (variant) {
    case "sheet":
      return page("#1F7A4D", "#7DBE9C", <path d="m8.9 11.4 5 6.2m0-6.2-5 6.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />);
    case "pdf":
      return page("#C8412F", "#E9A094", <path d="M8.6 16.6h6.6M8.6 13.3h6.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />);
    case "image":
      return page("#2F6FB5", "#9CC0E6", <path d="m7.6 17.4 3-3.6 2.2 2.4 1.4-1.5 2.2 2.7H7.6Z" fill="#fff" />);
    case "slides":
      return page("#C9631C", "#EDB384", <path d="M8.4 11.6h7.2v4.6H8.4z" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />);
    case "doc":
      return page("#2D5BBE", "#9DB3E6", <path d="M8.6 12.2h6.8M8.6 15h6.8M8.6 17.8h4.2" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />);
    default:
      return null;
  }
}

export function ContextTokenMark({ source, size = 16, className }: { source: ContextMarkSource; size?: 16 | 20 | 24; className?: string }) {
  const box = cn("inline-grid shrink-0 place-items-center", className);
  const style = { width: size, height: size };
  if (source.kind === "app") {
    return (
      <span className={box} style={style}>
        <ConnectorMark id={source.connectorId ?? source.id} className={size === 16 ? "size-4" : size === 20 ? "size-5" : "size-6"} />
      </span>
    );
  }
  if (source.kind === "crew") {
    return (
      <span className={box} style={style}>
        {source.avatar ? (
          <AgentFace avatar={source.avatar} size={size} state="idle" />
        ) : (
          <AppIcons.orbit aria-hidden="true" className="size-4 text-muted-foreground" motion="none" />
        )}
      </span>
    );
  }
  if (source.kind === "file") {
    const variant = source.icon?.startsWith("file:") ? source.icon.slice(5) : "generic";
    const page = filePage(variant, size);
    return (
      <span className={box} style={style}>
        {page ?? <AppIcons.library aria-hidden="true" className="size-4 text-muted-foreground" motion="none" />}
      </span>
    );
  }
  const Glyph =
    source.kind === "project"
      ? AppIcons.projects
      : source.kind === "skill"
        ? AppIcons.skills
        : source.kind === "chat"
          ? AppIcons.conversation
          : AppIcons.artifacts;
  return (
    <span className={box} style={style}>
      <Glyph aria-hidden="true" className="size-4 text-muted-foreground" motion="none" />
    </span>
  );
}

/** What Alevr made, by its real type (D-038), from the artifact's icon key. */
const MADE_TYPE: Record<string, string> = {
  html: "site",
  react: "app",
  code: "code",
  markdown: "document",
  svg: "image",
  mermaid: "diagram",
  design: "design",
};

/** The plain word for a kind, as it reads after a name: "Mira, agent"; "Q3 brief, document". */
export function contextKindWord(kind: ContextTokenKind, icon?: string): string {
  switch (kind) {
    case "crew":
      return "agent";
    case "app":
      return "app";
    case "file":
      return "file";
    case "project":
      return "project";
    case "skill":
      return "skill";
    case "chat":
      return "chat";
    case "artifact":
      return MADE_TYPE[icon?.startsWith("artifact:") ? icon.slice(9) : ""] ?? `made by ${PRODUCT_NAME}`;
  }
}
