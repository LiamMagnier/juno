import * as React from "react";
import { FileSpreadsheet, FileText, Folder, MessageSquare } from "@/components/ui/icons";
import { GitHubMark, LinearMark } from "@/components/connections/connector-logos";
import { cn } from "@/lib/utils";

/*
 * Porcelain's drawings: the orbit (Juno's mark and presence) and the marks
 * other things carry into a sentence (file types, apps). Interface glyphs come
 * from the product icon set; only these are drawn here.
 */

/* ------------------------------------------------------------------ */
/* The orbit: a hairline arc open at the upper right and one dot.      */
/* The dot is Juno. At rest it sits in the gap; thinking, it travels   */
/* the orbit; listening, it holds while the arc breathes with the      */
/* voice. The dot is the only celadon on most screens.                 */
/* ------------------------------------------------------------------ */

export type OrbitState = "rest" | "thinking" | "listening" | "speaking";

const R = 7.6;
const DOT = 3.1;
const C = 12;
const AT = -50; // the dot's home: upper right
// The dot interrupts the line: the arc stops short of it on both sides.
const HALF_GAP = (Math.asin((DOT + 1.35) / R) * 180) / Math.PI;
function polar(deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [Math.round((C + R * Math.cos(t)) * 1000) / 1000, Math.round((C + R * Math.sin(t)) * 1000) / 1000];
}
const [SX, SY] = polar(AT + HALF_GAP);
const [EX, EY] = polar(AT - HALF_GAP);
const [DX, DY] = polar(AT);
export const ORBIT_ARC = `M${SX} ${SY} A${R} ${R} 0 1 1 ${EX} ${EY}`;

export function Orbit({
  state = "rest",
  size = 16,
  className,
  label,
  still = false,
}: {
  state?: OrbitState;
  size?: number;
  className?: string;
  /** Accessible name; omit when the words beside it say the state. */
  label?: string;
  /** Draw the reduced-motion pose regardless of the system setting (for the system sheet). */
  still?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      data-force-reduced={still ? "" : undefined}
      className={cn("pc-orbit", className)}
    >
      <g className="pc-orbit__carrier">
        <path className="pc-orbit__arc" d={ORBIT_ARC} />
        <circle className="pc-orbit__dot" cx={DX} cy={DY} r={DOT} />
      </g>
    </svg>
  );
}

/** The wordmark: the orbit and "Juno" set in the display face. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("pc-wordmark", className)}>
      <Orbit size={20} />
      <span translate="no">Juno</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Tabular digits. Wix Madefor has no `tnum`, so digits that align in  */
/* a column are set in fixed cells (0.6em, centred). Separators and    */
/* currency keep their own widths.                                     */
/* ------------------------------------------------------------------ */
export function Num({ children }: { children: string }) {
  return (
    <span className="pc-num" aria-label={children}>
      {Array.from(children).map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="pc-num__d" aria-hidden>
            {ch}
          </span>
        ) : (
          <span key={i} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Marks things carry into a sentence.                                 */
/* ------------------------------------------------------------------ */

export type FileKind = "xlsx" | "md" | "csv" | "pdf";

export function FileMark({ kind, className }: { kind: FileKind; className?: string }) {
  if (kind === "xlsx" || kind === "csv") return <FileSpreadsheet className={cn("pc-mark pc-mark--sheet", className)} aria-hidden />;
  return <FileText className={cn("pc-mark pc-mark--doc", className)} aria-hidden />;
}

export function ProjectMark({ className }: { className?: string }) {
  return <Folder className={cn("pc-mark pc-mark--muted", className)} aria-hidden />;
}

export function ChatMark({ className }: { className?: string }) {
  return <MessageSquare className={cn("pc-mark pc-mark--muted", className)} aria-hidden />;
}

export type AppId = "stripe" | "slack" | "hubspot" | "linear" | "github" | "gmail" | "drive";

export const APP_NAME: Record<AppId, string> = {
  stripe: "Stripe",
  slack: "Slack",
  hubspot: "HubSpot",
  linear: "Linear",
  github: "GitHub",
  gmail: "Gmail",
  drive: "Google Drive",
};

/** Slack in its four brand colours (the mark's own drawing, split by colour). */
function SlackColour({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" />
      <path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" />
      <path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" />
      <path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

/** A clean monogram tile in the app's own colour, for marks we do not redraw. */
function Monogram({ letter, bg, className }: { letter: string; bg: string; className?: string }) {
  return (
    <span className={cn("pc-monogram", className)} style={{ background: bg }} aria-hidden>
      {letter}
    </span>
  );
}

export function AppMark({ app, className }: { app: AppId; className?: string }) {
  switch (app) {
    case "slack":
      return <SlackColour className={cn("pc-mark", className)} />;
    case "stripe":
      return <Monogram letter="S" bg="#635BFF" className={className} />;
    case "hubspot":
      return <Monogram letter="H" bg="#FF7A59" className={className} />;
    case "gmail":
      return <Monogram letter="M" bg="#EA4335" className={className} />;
    case "drive":
      return <Monogram letter="D" bg="#1FA463" className={className} />;
    case "linear":
      return <LinearMark className={cn("pc-mark pc-mark--ink", className)} />;
    case "github":
      return <GitHubMark className={cn("pc-mark pc-mark--ink", className)} />;
  }
}
