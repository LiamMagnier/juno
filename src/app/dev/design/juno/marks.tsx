import * as React from "react";
import { ProviderLogo } from "@/components/brand/provider-logo";
import type { Provider } from "@/lib/providers";
import { CrewFace } from "./crew/face";
import { crew, TOKENS, type TokenRef } from "./fixtures";
import { Icon } from "./icons";

/*
 * Entity marks: the only places colour enters the chrome. An app is drawn with
 * its real brand mark, a file with its type's glyph in the type's colour, a
 * crew member with their face. Interface glyphs (search, plus, send) are the
 * Juno icon set and never carry colour; these are not interface glyphs.
 *
 * Brand drawings: Slack, Stripe and Linear are the simple-icons paths (CC0)
 * in the brands' published colours; GitHub, Figma and Notion follow the app's
 * own drawings (connector-logos.tsx); Gmail and Drive are simplified to the
 * brands' published geometry at 24px.
 */

type MarkProps = { className?: string; size?: number };

const box = (size?: number): React.CSSProperties | undefined => (size ? { width: size, height: size } : undefined);

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

export function SlackMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
      {SLACK_PARTS.map((p) => (
        <path key={p.fill} fill={p.fill} d={p.d} />
      ))}
    </svg>
  );
}

const STRIPE_S =
  "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z";

export function StripeMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
      <rect width="24" height="24" rx="6" fill="#635BFF" />
      <g transform="translate(5.4 5.5) scale(0.54)">
        <path fill="#fff" d={STRIPE_S} />
      </g>
    </svg>
  );
}

const LINEAR =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

export function LinearMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
      <path fill="#5E6AD2" d={LINEAR} />
    </svg>
  );
}

export function GitHubMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className} style={box(size)}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function FigmaMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="-50 0 300 300" aria-hidden="true" className={className} style={box(size)}>
      <path fill="#0ACF83" d="M50 300c27.6 0 50-22.4 50-50v-50H50c-27.6 0-50 22.4-50 50s22.4 50 50 50Z" />
      <path fill="#A259FF" d="M0 150c0-27.6 22.4-50 50-50h50v100H50c-27.6 0-50-22.4-50-50Z" />
      <path fill="#F24E1E" d="M0 50C0 22.4 22.4 0 50 0h50v100H50C22.4 100 0 77.6 0 50Z" />
      <path fill="#FF7262" d="M100 0h50c27.6 0 50 22.4 50 50s-22.4 50-50 50h-50V0Z" />
      <path fill="#1ABCFE" d="M200 150c0 27.6-22.4 50-50 50s-50-22.4-50-50 22.4-50 50-50 50 22.4 50 50Z" />
    </svg>
  );
}

export function NotionMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} style={box(size)}>
      <path
        d="M4.6 4.3 15.7 3.4c.5-.04.9.1 1.2.4l3 3c.2.2.3.5.3.8v11.2c0 .6-.4 1-1 1.1l-11.1.8c-.5.04-1-.15-1.3-.5l-2.4-3c-.2-.25-.3-.55-.3-.85V5.4c0-.6.4-1 1-1.1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 8.4v7.2m0-7.2 5.4 7.2m0-7.2v7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GmailMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
      <path fill="#4285F4" d="M2 7.6v10c0 .8.6 1.4 1.4 1.4h3V10.9L2 7.6Z" />
      <path fill="#34A853" d="M17.6 10.9V19h3c.8 0 1.4-.6 1.4-1.4v-10l-4.4 3.3Z" />
      <path fill="#EA4335" d="m6.4 10.9 5.6 4.2 5.6-4.2V5.9L12 10.1 6.4 5.9v5Z" />
      <path fill="#FBBC04" d="M17.6 5.9v5l4.4-3.3v-.8c0-1.9-1.9-2.8-3.2-1.8l-1.2.9Z" />
      <path fill="#C5221F" d="M2 6.8v.8l4.4 3.3v-5L5.2 5C3.9 4 2 4.9 2 6.8Z" />
    </svg>
  );
}

export function DriveMark({ className, size }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
      <path fill="#0F9D58" d="M8.2 3.2 1.6 14.6l3.3 5.8 6.6-11.4-3.3-5.8Z" />
      <path fill="#FFBA00" d="M15.8 3.2H8.2l6.6 11.4h7.6L15.8 3.2Z" />
      <path fill="#4285F4" d="M22.4 14.6H9.2l-4.3 5.8h14.2l3.3-5.8Z" />
    </svg>
  );
}

export function AppMark({ id, className, size }: { id: string } & MarkProps) {
  switch (id) {
    case "stripe":
      return <StripeMark className={className} size={size} />;
    case "slack":
      return <SlackMark className={className} size={size} />;
    case "linear":
      return <LinearMark className={className} size={size} />;
    case "notion":
      return <NotionMark className={className} size={size} />;
    case "github":
      return <GitHubMark className={className} size={size} />;
    case "figma":
      return <FigmaMark className={className} size={size} />;
    case "gmail":
      return <GmailMark className={className} size={size} />;
    case "drive":
      return <DriveMark className={className} size={size} />;
    default:
      return <Icon name="app" size={size ?? 16} className={className} />;
  }
}

/* File types: the sheet is green, the PDF red; text and code take the ink. */
const PAGE = "M6.2 2.75h7.9l5.15 5.1V20a1.25 1.25 0 0 1-1.25 1.25H6.2A1.25 1.25 0 0 1 4.95 20V4A1.25 1.25 0 0 1 6.2 2.75Z";
const FOLD = "M14.1 2.75V7.85h5.15";

export function FileMark({ name, className, size }: { name: string } & MarkProps) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "csv") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
        <path d={PAGE} fill="#1F7A4D" />
        <path d={FOLD} fill="#7DBE9C" />
        <path d="m8.9 11.4 5 6.2m0-6.2-5 6.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (ext === "pdf") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
        <path d={PAGE} fill="#C8412F" />
        <path d={FOLD} fill="#E9A094" />
        <path d="M8.6 16.6h6.6M8.6 13.3h6.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (ext === "png" || ext === "jpg") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={box(size)}>
        <path d={PAGE} fill="#2F6FB5" />
        <path d={FOLD} fill="#9CC0E6" />
        <path d="m7.6 17.4 3-3.6 2.2 2.4 1.4-1.5 2.2 2.7H7.6Z" fill="#fff" />
      </svg>
    );
  }
  // Text and code: the page in the ink, so it reads as a neutral document.
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} style={box(size)}>
      <path d={PAGE} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={FOLD} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 12.6h7M8.5 15.8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ModelMark({ provider, className }: { provider: Provider; className?: string }) {
  return <ProviderLogo provider={provider} className={className} />;
}

/** The mark for any context token, by kind: the thing's own face, logo or file type. */
export function TokenMark({ token, size = 16 }: { token: TokenRef; size?: number }) {
  if (token.kind === "crew") {
    const m = crew(token.id);
    return <CrewFace member={{ id: m.id, name: m.name, role: m.role, seed: m.seed }} state="available" size={size} live={false} />;
  }
  if (token.kind === "file") return <FileMark name={token.label} size={size} className="jn-mark" />;
  if (token.kind === "app") return <AppMark id={token.id} size={size} className="jn-mark" />;
  if (token.kind === "project") return <Icon name="folder" size={size} className="jn-mark jn-mark--ink" />;
  return <Icon name="chat" size={size} className="jn-mark jn-mark--ink" />;
}

export const tokenById = (id: string): TokenRef => TOKENS[id];

/** A work-trace step's mark (M5): "file:Name.ext", "app:stripe" or "web". */
export function StepMark({ mark, size = 16 }: { mark: string; size?: number }) {
  if (mark.startsWith("file:")) return <FileMark name={mark.slice(5)} size={size} className="jn-mark" />;
  if (mark.startsWith("app:")) return <AppMark id={mark.slice(4)} size={size} className="jn-mark" />;
  return <Icon name="globe" size={size} className="jn-mark jn-mark--ink" />;
}
