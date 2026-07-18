import * as React from "react";
import { cn } from "@/lib/utils";

export type SidebarMotionIconKind =
  | "new"
  | "home"
  | "code"
  | "library"
  | "artifacts"
  | "connections"
  | "projects"
  | "tasks"
  | "pulls"
  | "search"
  | "panel-open"
  | "panel-close"
  | "close"
  | "folder"
  | "conversation"
  | "more";

/**
 * Small, articulated icons for the app shell. Each icon moves according to the
 * object it represents (book pages open, plug halves connect, clock hands turn)
 * instead of applying the same scale/translate treatment to every glyph.
 *
 * The owning control only needs Tailwind's `group` class. Animation details live
 * in globals.css so the same choreography is shared by full rows and the rail.
 */
export function SidebarMotionIcon({
  kind,
  className,
}: {
  kind: SidebarMotionIconKind;
  className?: string;
}) {
  const common = {
    "aria-hidden": true,
    className: cn(
      "sidebar-motion-icon",
      `sidebar-motion-icon--${kind}`,
      className,
    ),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (kind) {
    case "new":
      return (
        <svg {...common}>
          <circle
            className="sidebar-icon__new-orbit"
            cx="12"
            cy="12"
            r="9"
            stroke="none"
            fill="currentColor"
            opacity=".1"
          />
          <path className="sidebar-icon__new-plus" d="M12 8v8M8 12h8" />
          <path
            className="sidebar-icon__new-sparks"
            d="M12 4v1M12 19v1M4 12h1M19 12h1"
            opacity="0"
          />
        </svg>
      );
    case "home":
      return (
        <svg {...common}>
          <path className="sidebar-icon__home-roof" d="m4 10 8-6 8 6" />
          <path d="M6.5 9v10h11V9" />
          <path className="sidebar-icon__home-door" d="M10 19v-5h4v5" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path className="sidebar-icon__code-left" d="m9 7-5 5 5 5" />
          <path className="sidebar-icon__code-slash" d="m15 5-6 14" />
          <path className="sidebar-icon__code-right" d="m15 7 5 5-5 5" />
        </svg>
      );
    case "library":
      return (
        <svg {...common}>
          <path
            className="sidebar-icon__book-left"
            d="M12 19.5c-1.8-1.5-4.1-2.1-7-1.8V5.5c2.9-.3 5.2.3 7 1.8z"
          />
          <path
            className="sidebar-icon__book-right"
            d="M12 19.5c1.8-1.5 4.1-2.1 7-1.8V5.5c-2.9-.3-5.2.3-7 1.8z"
          />
          <path
            className="sidebar-icon__book-page"
            d="M7.5 9.2c1.1 0 2 .2 2.8.6M16.5 9.2c-1.1 0-2 .2-2.8.6"
            opacity=".55"
          />
        </svg>
      );
    case "artifacts":
      return (
        <svg {...common}>
          <rect
            className="sidebar-icon__artifact-square"
            x="4"
            y="4.5"
            width="7"
            height="7"
            rx="1.3"
          />
          <circle
            className="sidebar-icon__artifact-circle"
            cx="16.5"
            cy="8"
            r="3.5"
          />
          <path
            className="sidebar-icon__artifact-triangle"
            d="m12 19 4-6 4 6z"
          />
          <circle
            className="sidebar-icon__artifact-dot"
            cx="7"
            cy="17"
            r="2"
            fill="currentColor"
            stroke="none"
            opacity=".35"
          />
        </svg>
      );
    case "connections":
      return (
        <svg {...common}>
          <path
            className="sidebar-icon__plug-top"
            d="M9 3v4M15 3v4M7 7h10v2a5 5 0 0 1-5 5 5 5 0 0 1-5-5z"
          />
          <path
            className="sidebar-icon__plug-cord"
            d="M12 14v3a3 3 0 0 0 3 3h2"
          />
          <path
            className="sidebar-icon__plug-spark"
            d="m19 9 1.5-1.5M19.5 12H22M18 6l.5-2"
            opacity="0"
          />
        </svg>
      );
    case "projects":
      return (
        <svg {...common}>
          <path className="sidebar-icon__box-lid" d="m4 8 8-4 8 4-8 4z" />
          <path
            className="sidebar-icon__box-body"
            d="M4 8v9l8 4 8-4V8M12 12v9"
          />
          <path className="sidebar-icon__box-card" d="M9 7.2h6" opacity="0" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...common}>
          <path d="M6 3v3M18 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1" />
          <circle cx="14.5" cy="14" r="3.5" />
          <path className="sidebar-icon__clock-hour" d="M14.5 14v-2" />
          <path className="sidebar-icon__clock-minute" d="M14.5 14h2" />
        </svg>
      );
    case "pulls":
      return (
        <svg {...common}>
          <circle className="sidebar-icon__pull-start" cx="6" cy="5" r="2" />
          <circle className="sidebar-icon__pull-end" cx="18" cy="18" r="2" />
          <path d="M6 7v12" />
          <path
            className="sidebar-icon__pull-route"
            d="M18 16v-4a4 4 0 0 0-4-4h-2M9 5l3 3-3 3"
          />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle
            className="sidebar-icon__search-lens"
            cx="10.5"
            cy="10.5"
            r="6.5"
          />
          <path
            className="sidebar-icon__search-handle"
            d="m15.5 15.5 4.5 4.5"
          />
          <path
            className="sidebar-icon__search-glint"
            d="M7.5 8c.7-1 1.7-1.5 3-1.5"
            opacity="0"
          />
        </svg>
      );
    case "panel-open":
    case "panel-close":
      return (
        <svg {...common}>
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <path className="sidebar-icon__panel-divider" d="M9 4v16" />
          <path
            className="sidebar-icon__panel-chevron"
            d={kind === "panel-open" ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"}
          />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path className="sidebar-icon__close-a" d="M6 6l12 12" />
          <path className="sidebar-icon__close-b" d="M18 6 6 18" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path
            className="sidebar-icon__folder-back"
            d="M3.5 7V5.5A1.5 1.5 0 0 1 5 4h5l2 2h7A1.5 1.5 0 0 1 20.5 7.5V18A2 2 0 0 1 18.5 20h-13a2 2 0 0 1-2-2z"
          />
          <path
            className="sidebar-icon__folder-front"
            d="M3.5 9h17l-2 9.5H5.5z"
          />
        </svg>
      );
    case "conversation":
      return (
        <svg {...common}>
          <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 9 9 0 0 1-3.4-.7L4 20l1.4-4A7.4 7.4 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5" />
          <circle
            className="sidebar-icon__chat-dot sidebar-icon__chat-dot--1"
            cx="9"
            cy="12"
            r=".85"
            fill="currentColor"
            stroke="none"
          />
          <circle
            className="sidebar-icon__chat-dot sidebar-icon__chat-dot--2"
            cx="12"
            cy="12"
            r=".85"
            fill="currentColor"
            stroke="none"
          />
          <circle
            className="sidebar-icon__chat-dot sidebar-icon__chat-dot--3"
            cx="15"
            cy="12"
            r=".85"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle
            className="sidebar-icon__more-dot sidebar-icon__more-dot--1"
            cx="12"
            cy="5.5"
            r="1.3"
            fill="currentColor"
            stroke="none"
          />
          <circle
            className="sidebar-icon__more-dot sidebar-icon__more-dot--2"
            cx="12"
            cy="12"
            r="1.3"
            fill="currentColor"
            stroke="none"
          />
          <circle
            className="sidebar-icon__more-dot sidebar-icon__more-dot--3"
            cx="12"
            cy="18.5"
            r="1.3"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
  }
}
