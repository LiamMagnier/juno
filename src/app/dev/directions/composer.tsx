"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { LinearMark, SlackMark } from "@/components/connections/connector-logos";
import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerChevronClass,
  composerChipClass,
  composerFieldClass,
  composerIconButtonClass,
} from "@/components/ui/composer-shell";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Folder,
  MessageSquare,
  Mic,
  Plus,
  ScrollText,
} from "@/components/ui/icons";
import { Kbd } from "@/components/ui/kbd";
import {
  menuGlyphInkClass,
  menuLabelClass,
  menuRowClass,
  menuSeparatorClass,
  menuShellClass,
} from "@/components/ui/menu-recipe";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { CREW, CURRENT_MODELS, FAVOURITE_MODELS, MIRA, type ModelRow } from "./fixtures";
import { SignatureGlyph } from "./glyphs";
import type { DirectionId } from "./tokens";

/* ————————————————————————————————————————————————————————————————————————
 * Context tokens (PRODUCT_REFOUNDATION §5): an atomic object in the
 * sentence, drawn with the thing's own mark. The composer today paints
 * connector mentions behind a textarea and has no token model, so the token
 * is drawn here; everything around it is the real composer shell.
 * ———————————————————————————————————————————————————————————————————— */

export type TokenKind = "file" | "app" | "crew" | "project" | "skill";
export type TokenState = "normal" | "selected" | "needs-connection";

function TokenMark({ kind, name }: { kind: TokenKind; name: string }) {
  const cls = "size-[1.05em] shrink-0";
  if (kind === "crew") {
    const member = CREW.find((m) => m.name === name) ?? MIRA;
    return <AgentFace avatar={member.avatar} state="idle" size={16} live={false} className="shrink-0" />;
  }
  if (kind === "file") return name.endsWith(".xlsx") ? <FileSpreadsheet className={cls} aria-hidden="true" /> : <FileText className={cls} aria-hidden="true" />;
  if (kind === "project") return <Folder className={cls} aria-hidden="true" />;
  if (kind === "skill") return <ScrollText className={cls} aria-hidden="true" />;
  if (name === "Slack") return <SlackMark className={cls} />;
  if (name === "Linear") return <LinearMark className={cls} />;
  // No Stripe mark in connector-logos.tsx yet: the icon set's card stands in.
  return <CreditCard className={cls} aria-hidden="true" />;
}

const KIND_NAME: Record<TokenKind, string> = { file: "File", app: "App", crew: "Crew member", project: "Project", skill: "Skill" };

export function ContextToken({
  kind,
  name,
  state = "normal",
}: {
  kind: TokenKind;
  name: string;
  state?: TokenState;
}) {
  return (
    <span
      contentEditable={false}
      data-kind={kind}
      data-state={state}
      role="img"
      aria-label={`${KIND_NAME[kind]}: ${name}${state === "needs-connection" ? ", not connected" : ""}`}
      className="dir-token"
    >
      <TokenMark kind={kind} name={name} />
      <span>{name}</span>
      {state === "needs-connection" && <span className="dir-token__hint">Connect</span>}
    </span>
  );
}

/** The sentence from the brief, with its three tokens. */
export function DraftSentence() {
  return (
    <>
      Compare <ContextToken kind="file" name="Q3 Forecast.xlsx" /> with <ContextToken kind="app" name="Stripe" /> and ask{" "}
      <ContextToken kind="crew" name="Mira" /> to flag renewal risk
    </>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * The composer: the real `ComposerShell`, its field metrics, its chip and
 * icon-button recipes and its primary action, around a draft that holds
 * tokens (a contentEditable standing in for the token model).
 * ———————————————————————————————————————————————————————————————————— */

export function DraftComposer({
  children,
  frame = "landing",
  above,
  popover,
  modelOpen = false,
  placeholder,
  className,
}: {
  children?: React.ReactNode;
  frame?: "landing" | "dock";
  /** A layer that floats above the field (the @ palette). */
  above?: React.ReactNode;
  /** A layer that floats above the controls row, on the composer's right edge (the model popover). */
  popover?: React.ReactNode;
  modelOpen?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const empty = !children;
  return (
    <div className={cn("relative isolate w-full", className)}>
      {above}
      {popover}
      <ComposerShell
        field={
          <div
            role="textbox"
            aria-multiline="true"
            aria-label="Message Juno"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            className={cn(
              composerFieldClass,
              "whitespace-pre-wrap break-words",
              frame === "landing" ? "min-h-20" : "",
              empty && "dir-field-empty",
            )}
          >
            {children}
          </div>
        }
        leading={
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Add files, photos and more" className={cn(composerIconButtonClass, "rounded-composer-control")}>
            <Plus className="size-4" />
          </Button>
        }
        trailing={
          <>
            <button
              type="button"
              className={cn(composerChipClass, "rounded-composer-control")}
              data-state={modelOpen ? "open" : "closed"}
              aria-haspopup="dialog"
              aria-expanded={modelOpen}
            >
              <span className="truncate">Auto</span>
              <ChevronDown className={composerChevronClass} aria-hidden="true" />
            </button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Dictate" className={cn(composerIconButtonClass, "rounded-composer-control")}>
              <Mic className="size-4" />
            </Button>
          </>
        }
        action={<ComposerPrimaryAction face={empty ? "voice" : "send"} aria-label={empty ? "Start voice conversation" : "Send message"} />}
      />
    </div>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * The @ palette: Crew, Files, Projects, Apps, Chats. Drawn open, in place,
 * with the menu recipe every floating list in the product is cut from.
 * ———————————————————————————————————————————————————————————————————— */

interface PaletteRow {
  id: string;
  kind: TokenKind | "chat";
  name: string;
  meta: string;
  needsConnection?: boolean;
}

const PALETTE: { heading: string; rows: PaletteRow[] }[] = [
  {
    heading: "Crew",
    rows: [
      { id: "mira", kind: "crew", name: "Mira", meta: "Accounts" },
      { id: "scout", kind: "crew", name: "Scout", meta: "Research" },
    ],
  },
  {
    heading: "Files",
    rows: [
      { id: "q3", kind: "file", name: "Q3 Forecast.xlsx", meta: "Edited today" },
      { id: "notes", kind: "file", name: "Renewal notes.md", meta: "Library" },
    ],
  },
  { heading: "Projects", rows: [{ id: "atlas", kind: "project", name: "Atlas launch", meta: "12 chats" }] },
  {
    heading: "Apps",
    rows: [
      { id: "stripe", kind: "app", name: "Stripe", meta: "Connected" },
      { id: "linear", kind: "app", name: "Linear", meta: "Connect", needsConnection: true },
    ],
  },
  { heading: "Chats", rows: [{ id: "pricing", kind: "chat", name: "Pricing page copy, second pass", meta: "Yesterday" }] },
];

export function MentionPalette({ highlighted = "mira" }: { highlighted?: string }) {
  const listId = React.useId();
  return (
    <div
      role="listbox"
      id={listId}
      aria-label="Mention"
      data-state="open"
      data-side="top"
      className={cn(menuShellClass, "absolute bottom-full left-0 mb-2 w-full max-w-sm overflow-hidden")}
    >
      <div className="max-h-[min(30rem,60dvh)] overflow-y-auto">
        {PALETTE.map((section, s) => (
          <div key={section.heading} role="group" aria-label={section.heading}>
            {s > 0 && <div className={menuSeparatorClass} />}
            <p className={menuLabelClass}>{section.heading}</p>
            {section.rows.map((row) => {
              const on = row.id === highlighted;
              return (
                <div
                  key={row.id}
                  role="option"
                  aria-selected={on}
                  data-highlighted={on ? "" : undefined}
                  className={cn(menuRowClass, menuGlyphInkClass, on ? "bg-accent text-accent-foreground" : "hover:bg-accent")}
                >
                  {row.kind === "chat" ? (
                    <MessageSquare className="size-4" aria-hidden="true" />
                  ) : (
                    <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-4">
                      <TokenMark kind={row.kind} name={row.name} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className={cn("shrink-0 text-caption", row.needsConnection ? "text-primary" : "text-muted-foreground")}>
                    {row.meta}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={menuSeparatorClass} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 pb-1.5 pt-1 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> to add
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>esc</Kbd> to close
        </span>
      </div>
    </div>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * The model popover (§6): Auto, favourites, four current models with one
 * line each, effort under the list, and All models one layer down. No bars.
 * ———————————————————————————————————————————————————————————————————— */

function Cost({ cost }: { cost: ModelRow["cost"] }) {
  if (cost < 3) return null;
  return (
    <span className="shrink-0 font-mono text-micro text-muted-foreground" title="Higher cost per message">
      <span aria-hidden="true">$$$</span>
      <span className="sr-only">Higher cost per message</span>
    </span>
  );
}

function ModelOption({ model }: { model: ModelRow }) {
  return (
    <div role="option" aria-selected={false} className={cn(menuRowClass, menuGlyphInkClass, "items-start hover:bg-accent")}>
      <ProviderLogo provider={model.provider} className="mt-0.5 size-4 text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-foreground">{model.name}</span>
        <span className="block truncate text-caption text-muted-foreground">{model.line}</span>
      </span>
      <Cost cost={model.cost} />
    </div>
  );
}

export function ModelPopover({ direction }: { direction: DirectionId }) {
  const [effort, setEffort] = React.useState<"light" | "standard" | "deep">("standard");
  return (
    <div
      role="dialog"
      aria-label="Model"
      data-state="open"
      data-side="top"
      className={cn(menuShellClass, "absolute bottom-full right-0 mb-2 w-full max-w-[20rem] sm:right-12")}
    >
      <div role="listbox" aria-label="Models">
        <div role="option" aria-selected className={cn(menuRowClass, "items-start bg-accent text-accent-foreground")}>
          <span className="mt-0.5 flex size-4 items-center justify-center">
            <SignatureGlyph direction={direction} size={16} className="dir-text-brand" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-foreground">Auto</span>
            <span className="block text-caption text-muted-foreground">Juno picks the model for each message</span>
          </span>
          <Check className="mt-0.5 size-4 text-primary" aria-hidden="true" />
        </div>
        <div className={menuSeparatorClass} />
        <p className={menuLabelClass}>Favourites</p>
        {FAVOURITE_MODELS.map((m) => (
          <ModelOption key={m.id} model={m} />
        ))}
        <p className={menuLabelClass}>Current</p>
        {CURRENT_MODELS.map((m) => (
          <ModelOption key={m.id} model={m} />
        ))}
      </div>
      <div className={menuSeparatorClass} />
      <div className="px-1.5 pb-1.5 pt-1">
        <p className="px-1 pb-1.5 text-caption font-medium text-muted-foreground" id="dir-effort-label">
          Effort
        </p>
        <SegmentedControl
          ariaLabel="Effort"
          value={effort}
          onChange={setEffort}
          options={[
            { value: "light", label: "Light" },
            { value: "standard", label: "Standard" },
            { value: "deep", label: "Deep" },
          ]}
        />
      </div>
      <div className={menuSeparatorClass} />
      <button type="button" className={cn(menuRowClass, menuGlyphInkClass, "w-full hover:bg-accent")}>
        <span className="flex-1 text-left">All models</span>
        <ArrowRight className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
