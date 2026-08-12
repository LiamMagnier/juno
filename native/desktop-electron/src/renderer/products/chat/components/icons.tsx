/**
 * The icon set, drawn inline.
 *
 * `lucide-react` is not a dependency of this package — the web app has it, the
 * desktop does not — so rather than add one for twenty glyphs, the twenty
 * glyphs are here. They are lucide geometry: 24-unit viewBox, `none` fill,
 * `currentColor` stroke, round caps and joins.
 *
 * Every icon carries `className="lucide"` before the caller's classes, which is
 * not decoration: `styles/base.css` hangs the optical stroke-width ladder off
 * `svg.lucide.size-4` and friends. Drop the class and a 12px icon draws at a
 * sub-pixel 0.875px stroke, which is the bug that ladder exists to prevent.
 *
 * All of them are `aria-hidden`. An icon is never the accessible name of
 * anything here — the button that contains it carries the label.
 */

import type { ReactNode, SVGProps } from 'react';
import { cn } from '../lib/cn.js';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'fill'>;

function Glyph({ className, children, ...rest }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      /* `lucide` first so a caller's `size-4` still lands on the same element
         and the ladder in base.css matches `svg.lucide.size-4`. */
      className={cn('lucide shrink-0', className)}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function CopyIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Glyph>
  );
}

export function CheckIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}

export function RetryIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Glyph>
  );
}

export function EditIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9Z" />
    </Glyph>
  );
}

export function ForkIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Glyph>
  );
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}

export function ChevronRightIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m9 18 6-6-6-6" />
    </Glyph>
  );
}

/** Filled, unlike the rest — a stop control reads as a solid block, not an outline. */
export function StopIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function SendIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Glyph>
  );
}

export function PaperclipIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Glyph>
  );
}

export function ImageIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </Glyph>
  );
}

export function FileIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Glyph>
  );
}

export function SearchIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Glyph>
  );
}

export function PinIcon({ filled = false, ...props }: IconProps & { filled?: boolean }): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 17v5" />
      <path
        d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"
        fill={filled ? 'currentColor' : 'none'}
        fillOpacity={filled ? 0.22 : undefined}
      />
    </Glyph>
  );
}

export function ArchiveIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Glyph>
  );
}

export function TrashIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Glyph>
  );
}

export function MoreIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </Glyph>
  );
}

export function PlusIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Glyph>
  );
}

/** Reasoning. A spark rather than a brain — the brain glyph reads as a mascot. */
export function ReasoningIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 3.5 13.6 8a3 3 0 0 0 1.9 1.9L20 11.5l-4.5 1.6A3 3 0 0 0 13.6 15L12 19.5 10.4 15a3 3 0 0 0-1.9-1.9L4 11.5l4.5-1.6A3 3 0 0 0 10.4 8Z" />
      <path d="M19 3v3" />
      <path d="M20.5 4.5h-3" />
    </Glyph>
  );
}

export function AlertIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Glyph>
  );
}

export function OfflineIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 20h.01" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 12.9a10 10 0 0 1 5.2-2.7" />
      <path d="M19 12.9a10 10 0 0 0-2-1.5" />
      <path d="M2 8.8a15 15 0 0 1 4.2-2.6" />
      <path d="M22 8.8a15 15 0 0 0-11.3-3.8" />
      <path d="m2 2 20 20" />
    </Glyph>
  );
}

export function ReconnectIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16" />
      <path d="M8 16H3v5" />
    </Glyph>
  );
}

export function ConversationIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Glyph>
  );
}

export function ExternalLinkIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Glyph>
  );
}

export function ModelIcon(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v2" />
      <path d="M15 2v2" />
      <path d="M9 20v2" />
      <path d="M15 20v2" />
      <path d="M20 9h2" />
      <path d="M20 15h2" />
      <path d="M2 9h2" />
      <path d="M2 15h2" />
    </Glyph>
  );
}
