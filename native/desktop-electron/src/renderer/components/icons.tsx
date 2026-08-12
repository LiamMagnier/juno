/**
 * The icon set.
 *
 * Hand-written SVG rather than an icon package: the shell needs about twenty
 * glyphs, and a dependency that ships two thousand is a dependency that ships
 * two thousand into an app whose CSP forbids fetching anything at runtime.
 *
 * Every icon here is decorative. `aria-hidden` is not optional and not a
 * per-call-site decision — an icon inside a labelled button is a duplicate
 * announcement, and an icon inside an *unlabelled* button is a bug that
 * `IconButton` prevents by requiring a label. `focusable="false"` is the old
 * IE/Edge tab-stop fix and costs nothing to keep.
 *
 * 1.5 stroke on a 16px grid, round caps, `currentColor` throughout, so an icon
 * inherits the exact text colour of the control it sits in and no icon ever
 * needs a colour class of its own.
 */

import type { ReactNode } from 'react';

interface IconProps {
  readonly className?: string | undefined;
}

function Svg({ className, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function ChatIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M13.5 8.2c0 2.4-2.4 4.3-5.5 4.3-.7 0-1.4-.1-2-.3L3 13.5l.9-2.3C3 10.4 2.5 9.4 2.5 8.2 2.5 5.9 5 4 8 4s5.5 1.9 5.5 4.2Z" />
    </Svg>
  );
}

export function WorkIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="2.5" y="4.5" width="11" height="8" rx="1.5" />
      <path d="M6 4.5v-.8c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v.8M2.5 8h11" />
    </Svg>
  );
}

export function CodeIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="m5.5 5.5-3 2.6 3 2.6M10.5 5.5l3 2.6-3 2.6M9.2 3.4 6.8 12.6" />
    </Svg>
  );
}

export function PanelLeftIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.2 3v10" />
    </Svg>
  );
}

export function PanelRightIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.8 3v10" />
    </Svg>
  );
}

export function SearchIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <circle cx="7.2" cy="7.2" r="3.9" />
      <path d="m10.2 10.2 3 3" />
    </Svg>
  );
}

export function PlusIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function FolderIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M2.5 12V4.5c0-.6.4-1 1-1h2.4c.3 0 .6.1.8.4l.8.9h4.9c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1Z" />
    </Svg>
  );
}

export function CheckIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="m3.5 8.4 3 3 6-6.8" />
    </Svg>
  );
}

export function CloseIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function AlertIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M8 2.8 14 12.5H2L8 2.8Z" />
      <path d="M8 6.6v2.6M8 11.1h.01" />
    </Svg>
  );
}

export function ChevronRightIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  );
}

export function SunIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </Svg>
  );
}

export function MoonIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6Z" />
    </Svg>
  );
}

export function SystemIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="2" y="3" width="12" height="8" rx="1.2" />
      <path d="M6 13.5h4" />
    </Svg>
  );
}

export function PlayIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M5.5 3.7 12 8l-6.5 4.3V3.7Z" />
    </Svg>
  );
}

export function StopIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" />
    </Svg>
  );
}

export function LockIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.3" />
      <path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7" />
    </Svg>
  );
}

export function ShieldIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M8 2.4 13 4v4c0 3-2.2 5-5 5.6C5.2 13 3 11 3 8V4l5-1.6Z" />
    </Svg>
  );
}

export function RefreshIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v2.6h-2.6" />
    </Svg>
  );
}

export function ArrowUpIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <path d="M8 12.8V3.6M4.2 7.4 8 3.6l3.8 3.8" />
    </Svg>
  );
}

export function BranchIcon({ className }: IconProps): ReactNode {
  return (
    <Svg className={className}>
      <circle cx="4.6" cy="4" r="1.6" />
      <circle cx="4.6" cy="12" r="1.6" />
      <circle cx="11.4" cy="6" r="1.6" />
      <path d="M4.6 5.6v4.8M11.4 7.6c0 1.8-1.4 2.6-3.4 2.9" />
    </Svg>
  );
}
