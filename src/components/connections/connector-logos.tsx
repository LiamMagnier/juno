import * as React from "react";
import { Database, Globe, Plug, Terminal } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/*
 * Inline brand marks so the dashboard needs no network fetch and stays
 * theme-aware: GitHub and Linear inherit currentColor; every other brand keeps
 * its own palette (raw hex lives only in SVG fill attributes, never
 * classNames).
 *
 * TWO KINDS OF MARK LIVE HERE. GitHub, Figma, Notion, Linear, Slack and the
 * three Apple apps are BRANDS: the shape and colour are the company's, so they
 * are drawn here in full colour, the way the reader sees them in their dock.
 * The Apple apps had been drawn as the icon set's calendar, envelope and notes,
 * which made the three apps a reader recognises at a glance the only rows on
 * the Apps page that had to be read rather than seen. They are the app icons
 * now: Mail's blue envelope, Calendar's white page with the red weekday, and
 * Music's red note.
 *
 * Postgres, the terminal and web search are interface CONCEPTS, not apps you
 * sign in to, so they still come from `@/components/ui/icons` — the same
 * drawing the rest of the product uses for the same idea.
 */

/** A gradient id that is valid inside `url(#…)` whatever `useId` returns. */
function useSvgId(prefix: string) {
  return `${prefix}-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function FigmaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 300" aria-hidden="true" className={className}>
      <path fill="#0ACF83" d="M50 300c27.6 0 50-22.4 50-50v-50H50c-27.6 0-50 22.4-50 50s22.4 50 50 50Z" />
      <path fill="#A259FF" d="M0 150c0-27.6 22.4-50 50-50h50v100H50c-27.6 0-50-22.4-50-50Z" />
      <path fill="#F24E1E" d="M0 50C0 22.4 22.4 0 50 0h50v100H50C22.4 100 0 77.6 0 50Z" />
      <path fill="#FF7262" d="M100 0h50c27.6 0 50 22.4 50 50s-22.4 50-50 50h-50V0Z" />
      <path fill="#1ABCFE" d="M200 150c0 27.6-22.4 50-50 50s-50-22.4-50-50 22.4-50 50-50 50 22.4 50 50Z" />
    </svg>
  );
}

export function NotionMark({ className }: { className?: string }) {
  // The official mark: a white page with a black outline and N. It carries
  // its own white fill, so it reads on a light or a dark tile alike.
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" className={className}>
      <path
        fill="#fff"
        d="M6.017 4.313l55.333 -4.087c6.797 -0.583 8.543 -0.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277 -1.553 6.807 -6.99 7.193L24.467 99.967c-4.08 0.193 -6.023 -0.39 -8.16 -3.113L3.3 79.94c-2.333 -3.113 -3.3 -5.443 -3.3 -8.167V11.113c0 -3.497 1.553 -6.413 6.017 -6.8z"
      />
      <path
        fill="#000"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M61.35 0.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.723 0.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257 -3.89c5.433 -0.387 6.99 -2.917 6.99 -7.193V20.64c0 -2.21 -0.873 -2.847 -3.443 -4.733L74.167 3.143c-4.273 -3.107 -6.02 -3.5 -12.817 -2.917zM25.92 19.523c-5.247 0.353 -6.437 0.433 -9.417 -1.99L8.927 11.507c-0.77 -0.78 -0.383 -1.753 1.557 -1.947l53.193 -3.887c4.467 -0.39 6.793 1.167 8.54 2.527l9.123 6.61c0.39 0.197 1.36 1.36 0.193 1.36l-54.933 3.307 -0.68 0.047zM19.803 88.3V30.367c0 -2.53 0.777 -3.697 3.103 -3.893L86 22.78c2.14 -0.193 3.107 1.167 3.107 3.693v57.547c0 2.53 -0.39 4.67 -3.883 4.863l-60.377 3.5c-3.493 0.193 -5.043 -0.97 -5.043 -4.083zm59.6 -54.827c0.387 1.75 0 3.5 -1.75 3.7l-2.91 0.577v42.773c-2.527 1.36 -4.853 2.137 -6.797 2.137 -3.107 0 -3.883 -0.973 -6.21 -3.887l-19.03 -29.94v28.967l6.02 1.363s0 3.5 -4.857 3.5l-13.39 0.777c-0.39 -0.78 0 -2.723 1.357 -3.11l3.497 -0.97v-38.3L30.48 40.667c-0.39 -1.75 0.58 -4.277 3.3 -4.473l14.367 -0.967 19.8 30.327v-26.83l-5.047 -0.58c-0.39 -2.143 1.163 -3.7 3.103 -3.89l13.4 -0.78z"
      />
    </svg>
  );
}

/*
 * The three Apple apps are drawn as their app icons — a 64-unit rounded
 * square — because the icon IS the brand mark for a first-party app.
 */
/** iOS's corner is ~22.5% of the side; a plain rx reads the same at 22px. */
const APPLE_ICON_RADIUS = 14.4;

export function AppleCalendarMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect x=".5" y=".5" width="63" height="63" rx={APPLE_ICON_RADIUS} fill="#fff" stroke="#000" strokeOpacity=".12" />
      <text
        x="32"
        y="20"
        textAnchor="middle"
        fill="#FF3B30"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"
        fontSize="11"
        fontWeight="600"
        letterSpacing=".4"
      >
        MON
      </text>
      <text
        x="32"
        y="49"
        textAnchor="middle"
        fill="#1C1C1E"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
        fontSize="31"
        fontWeight="300"
        letterSpacing="-1"
      >
        17
      </text>
    </svg>
  );
}

export function AppleMailMark({ className }: { className?: string }) {
  const id = useSvgId("apple-mail");
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1AD6FD" />
          <stop offset="1" stopColor="#1D62F0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx={APPLE_ICON_RADIUS} fill={`url(#${id})`} />
      <rect x="12" y="19" width="40" height="27" rx="3.5" fill="#fff" />
      <path d="M13.5 21 32 35.5 50.5 21" fill="none" stroke="#1D62F0" strokeOpacity=".28" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function AppleMusicMark({ className }: { className?: string }) {
  const id = useSvgId("apple-music");
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FA5A6E" />
          <stop offset="1" stopColor="#FA233B" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx={APPLE_ICON_RADIUS} fill={`url(#${id})`} />
      <g fill="#fff" transform="translate(3 2)">
        <path d="M24.5 22.2 43.5 17v22.5h-3V22.1l-13 3.5v18h-3z" />
        <ellipse cx="21" cy="43.6" rx="6.2" ry="4.7" transform="rotate(-20 21 43.6)" />
        <ellipse cx="37" cy="39.5" rx="6.2" ry="4.7" transform="rotate(-20 37 39.5)" />
      </g>
    </svg>
  );
}

export function LinearMark({ className }: { className?: string }) {
  // Linear's mark is monochrome by design, so it takes the row's ink.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

export function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" />
      <path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" />
      <path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" />
      <path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

export function PostgresMark({ className }: { className?: string }) {
  return <Database className={className} aria-hidden="true" />;
}

export function TerminalMark({ className }: { className?: string }) {
  return <Terminal className={className} aria-hidden="true" />;
}

/** The same globe the composer's web-search tool draws (`ComposerIcons.web`). */
export function WebSearchMark({ className }: { className?: string }) {
  return <Globe className={className} aria-hidden="true" />;
}

/** Brand mark for a connector id; generic plug for unknown ids. */
export function ConnectorMark({ id, className }: { id: string; className?: string }) {
  if (id === "github") return <GitHubMark className={className} />;
  if (id === "figma") return <FigmaMark className={className} />;
  if (id === "notion") return <NotionMark className={className} />;
  if (id === "linear") return <LinearMark className={className} />;
  if (id === "slack") return <SlackMark className={className} />;
  if (id === "postgres" || id === "postgresql" || id === "database" || id === "supabase") return <PostgresMark className={className} />;
  if (id === "terminal" || id === "shell" || id === "bash") return <TerminalMark className={className} />;
  if (id === "web" || id === "web-search" || id === "search" || id === "browser") return <WebSearchMark className={className} />;
  if (id === "apple-calendar") return <AppleCalendarMark className={className} />;
  if (id === "apple-mail") return <AppleMailMark className={className} />;
  if (id === "apple-music") return <AppleMusicMark className={className} />;
  return <Plug className={className} aria-hidden="true" />;
}

/** 44px brand tile used on server cards. */
export function ConnectorLogoTile({ id, className }: { id: string; className?: string }) {
  return (
    <span
      className={cn(
        // `bg-secondary` + a stated hairline, matching AppLogo in
        // connector-directory — the same well one size up. `bg-background` is
        // the PAGE token, so on the true-black theme this tile painted #000
        // inside whatever card held it and read as a hole rather than a well;
        // a bare `border` (full --border) then made the edge the loudest thing
        // in a row of quiet ones.
        "flex size-11 shrink-0 items-center justify-center rounded-field border border-border/60 bg-secondary text-foreground",
        className
      )}
    >
      <ConnectorMark id={id} className="size-5" />
    </span>
  );
}
