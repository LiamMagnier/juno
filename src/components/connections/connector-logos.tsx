import { Plug } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Inline brand marks so the dashboard needs no network fetch and stays
 * theme-aware: GitHub inherits currentColor; Figma keeps its brand palette
 * (raw hex lives only in SVG fill attributes, never classNames).
 */

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
  // Theme-aware take on the Notion mark: a page outline in currentColor with a
  // filled "N", so it reads correctly on both light and dark tiles.
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.6 4.3 15.7 3.4c.5-.04.9.1 1.2.4l3 3c.2.2.3.5.3.8v11.2c0 .6-.4 1-1 1.1l-11.1.8c-.5.04-1-.15-1.3-.5l-2.4-3c-.2-.25-.3-.55-.3-.85V5.4c0-.6.4-1 1-1.1Z"
        className="stroke-current"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 8.4v7.2m0-7.2 5.4 7.2m0-7.2v7.2" className="stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Brand mark for a connector id; generic plug for unknown ids. */
export function ConnectorMark({ id, className }: { id: string; className?: string }) {
  if (id === "github") return <GitHubMark className={className} />;
  if (id === "figma") return <FigmaMark className={className} />;
  if (id === "notion") return <NotionMark className={className} />;
  return <Plug className={className} aria-hidden="true" />;
}

/** 44px brand tile used on server cards. */
export function ConnectorLogoTile({ id, className }: { id: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-background text-foreground",
        className
      )}
    >
      <ConnectorMark id={id} className="h-[22px] w-[22px]" />
    </span>
  );
}
