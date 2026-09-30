import * as React from "react";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { GitHubMark, LinearMark, NotionMark } from "@/components/connections/connector-logos";
import { FileSpreadsheet, FileText, Folder, MessageSquare, Sparkles } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { Entity, ModelRow } from "./fixtures";
import { CREW } from "./fixtures";
import { Face } from "./face";

/*
 * Every entity is drawn with its OWN mark: an app with its real brand drawing
 * in its real colours (Slack's four, Stripe's blurple tile), a file with its
 * type glyph, a crew member with their face. The mark is the only colour a
 * token carries; its words stay ink.
 *
 * Slack: the Simple Icons path (CC0 drawing of Slack's trademark), split into
 * its four pairs and filled with Slack's published colours. Stripe: the
 * Simple Icons "S" on Stripe's #635BFF tile. Both are used only to say which
 * app a token names.
 */

const SLACK_PARTS: { fill: string; d: string }[] = [
  {
    fill: "#E01E5A",
    d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
  },
  {
    fill: "#36C5F0",
    d: "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
  },
  {
    fill: "#2EB67D",
    d: "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
  },
  {
    fill: "#ECB22E",
    d: "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
];

export function SlackColor({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cn("shrink-0", className)}>
      {SLACK_PARTS.map((p) => (
        <path key={p.fill} d={p.d} fill={p.fill} />
      ))}
    </svg>
  );
}

const STRIPE_S =
  "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z";

export function StripeTile({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cn("shrink-0", className)}>
      <rect width={24} height={24} rx={6} fill="#635BFF" />
      <g transform="translate(6.2 5.6) scale(0.53)">
        <path d={STRIPE_S} fill="#FFFFFF" />
      </g>
    </svg>
  );
}

/** A file's type glyph; spreadsheets carry the spreadsheet green. */
export function FileGlyph({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  if (name.endsWith(".xlsx") || name.endsWith(".csv")) {
    return <FileSpreadsheet size={size} motion="none" className={cn("shrink-0 in-mark-sheet", className)} />;
  }
  return <FileText size={size} motion="none" className={cn("shrink-0 in-ink-2", className)} />;
}

export function AppMark({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  if (id === "slack") return <SlackColor size={size} className={className} />;
  if (id === "stripe") return <StripeTile size={size} className={className} />;
  const box = { width: size, height: size };
  if (id === "linear") return <span style={box} className={cn("inline-grid shrink-0 place-items-center in-ink", className)}><LinearMark className="size-full" /></span>;
  if (id === "notion") return <span style={box} className={cn("inline-grid shrink-0 place-items-center in-ink", className)}><NotionMark className="size-full" /></span>;
  if (id === "github") return <span style={box} className={cn("inline-grid shrink-0 place-items-center in-ink", className)}><GitHubMark className="size-[88%]" /></span>;
  return <Sparkles size={size} motion="none" className={cn("shrink-0 in-ink-2", className)} />;
}

/** The mark for any entity the @ palette offers, at one size. */
export function EntityMark({ entity, size = 16, className }: { entity: Entity; size?: number; className?: string }) {
  switch (entity.kind) {
    case "crew": {
      const member = CREW.find((m) => m.id === entity.id) ?? CREW[0];
      return <Face face={member.face} presence="available" size={size} live={false} className={className} />;
    }
    case "file":
      return <FileGlyph name={entity.name} size={size} className={className} />;
    case "project":
      return <Folder size={size} motion="none" className={cn("shrink-0 in-ink-2", className)} />;
    case "app":
      return <AppMark id={entity.id} size={size} className={className} />;
    case "chat":
      return <MessageSquare size={size} motion="none" className={cn("shrink-0 in-ink-2", className)} />;
  }
}

/** A model's lab mark in ink; Auto is drawn as the dial it is. */
export function ModelMark({ model, size = 16, className }: { model: ModelRow; size?: number; className?: string }) {
  if (model.provider === "auto") {
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className={cn("shrink-0", className)} fill="none">
        <circle cx={8} cy={8} r={6.25} stroke="currentColor" strokeWidth={1.1} />
        <path d="M8 8 L11 5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
        <circle cx={8} cy={8} r={1.2} fill="currentColor" />
      </svg>
    );
  }
  return <ProviderLogo provider={model.provider} className={cn("shrink-0", className)} />;
}

export function Initials({ text, size = 20 }: { text: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="in-initials inline-grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {text}
    </span>
  );
}

