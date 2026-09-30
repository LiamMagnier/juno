import * as React from "react";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { FigmaMark, GitHubMark, NotionMark } from "@/components/connections/connector-logos";
import { FileCode, FileText, Folder, MessageSquare } from "@/components/ui/icons";
import type { Provider } from "@/lib/providers";
import { CREW, TOKENS, type TokenRef } from "./fixtures";
import { Face } from "./face";

/*
 * Every entity is drawn with its OWN mark: an app with its real brand mark,
 * a file with its type's glyph in the type's colour, a crew member with the
 * face. These are the only places colour enters the chrome (besides send).
 *
 * Brand drawings: Slack and Stripe are the simple-icons paths (CC0) with the
 * brands' published colours; GitHub, Figma and Notion are the app's own
 * drawings (connector-logos.tsx); Linear is the simple-icons path.
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

export function SlackColor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      {SLACK_PARTS.map((p) => (
        <path key={p.fill} fill={p.fill} d={p.d} />
      ))}
    </svg>
  );
}

const STRIPE_S =
  "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z";

/** Stripe's app mark: the white S on its blurple tile. */
export function StripeTile({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect width="24" height="24" rx="6" fill="#635BFF" />
      <g transform="translate(5.4 5.5) scale(0.54)">
        <path fill="#fff" d={STRIPE_S} />
      </g>
    </svg>
  );
}

const LINEAR =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

export function LinearColor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#5E6AD2" d={LINEAR} />
    </svg>
  );
}

export type AppId = "stripe" | "slack" | "linear" | "notion" | "github" | "figma";

export function AppMark({ id, className }: { id: string; className?: string }) {
  const cls = className ?? "cv-mark";
  switch (id) {
    case "stripe":
      return <StripeTile className={cls} />;
    case "slack":
      return <SlackColor className={cls} />;
    case "linear":
      return <LinearColor className={cls} />;
    case "notion":
      return <NotionMark className={cls} />;
    case "github":
      return <GitHubMark className={cls} />;
    case "figma":
      return <FigmaMark className={cls} />;
    default:
      return <Folder className={cls} />;
  }
}

/** A file's type glyph, in the type's own colour (the only ink it carries). */
export function FileMark({ name, className }: { name: string; className?: string }) {
  const cls = className ?? "cv-mark";
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "csv") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={cls}>
        <path d="M6 2.75h8.2L19.25 7.8V20A1.25 1.25 0 0 1 18 21.25H6A1.25 1.25 0 0 1 4.75 20V4A1.25 1.25 0 0 1 6 2.75Z" fill="#1F7A4D" />
        <path d="M14.2 2.75V7.8h5.05" fill="#6FB592" />
        <path d="m8.6 11.2 5.2 6.6m0-6.6-5.2 6.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (ext === "pdf") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={cls}>
        <path d="M6 2.75h8.2L19.25 7.8V20A1.25 1.25 0 0 1 18 21.25H6A1.25 1.25 0 0 1 4.75 20V4A1.25 1.25 0 0 1 6 2.75Z" fill="#C8412F" />
        <path d="M14.2 2.75V7.8h5.05" fill="#E59A8F" />
        <path d="M8.5 16.5h7M8.5 13.2h7" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (ext === "ts" || ext === "tsx" || ext === "js") return <FileCode className={`${cls} cv-mark--ink`} />;
  return <FileText className={`${cls} cv-mark--ink`} />;
}

export function ModelMark({ provider, className }: { provider: Provider; className?: string }) {
  return <ProviderLogo provider={provider} className={className ?? "cv-mark cv-mark--ink"} />;
}

/** The mark for any context token, by kind. */
export function TokenMark({ token, size = 16 }: { token: TokenRef; size?: number }) {
  const style = { width: size, height: size } as React.CSSProperties;
  if (token.kind === "crew") {
    const member = CREW.find((m) => m.id === token.id) ?? CREW[0];
    return <Face member={member} presence="available" size={size} still />;
  }
  if (token.kind === "file") return <span className="cv-markbox" style={style}><FileMark name={token.label} className="cv-mark-fill" /></span>;
  if (token.kind === "app") return <span className="cv-markbox" style={style}><AppMark id={token.id} className="cv-mark-fill" /></span>;
  if (token.kind === "project") return <span className="cv-markbox" style={style}><Folder className="cv-mark-fill cv-mark--ink" /></span>;
  return <span className="cv-markbox" style={style}><MessageSquare className="cv-mark-fill cv-mark--ink" /></span>;
}

export function tokenById(id: string): TokenRef {
  return TOKENS[id];
}
