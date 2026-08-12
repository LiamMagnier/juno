/**
 * The icon set, drawn rather than imported.
 *
 * There is no icon package in this workspace's dependencies, and adding one for
 * eighteen glyphs would be a megabyte of tree-shaking risk for shapes that fit
 * in a file. Every glyph here is on the 24-unit Lucide grid and carries
 * `className="lucide"`, which is what binds it to the optical-stroke ladder in
 * `styles/base.css` — a single `stroke-width` on a 24 viewBox scales *down* with
 * the box, so a size-3 icon would otherwise draw at 0.875px. The ladder is the
 * reason the class is not decorative.
 *
 * Icons are `aria-hidden` without exception. Every one of them sits beside text
 * or inside a control that carries its own `aria-label`; an icon that announced
 * itself would double every button.
 */

import type { ReactNode, SVGProps } from 'react';
import { cn } from '../lib/cn.js';

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'xmlns'> & {
  readonly children?: ReactNode;
};

function Glyph({ className, children, ...rest }: GlyphProps): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('lucide shrink-0', className)}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconRefresh(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
      <path d="M3 21v-5h5" />
    </Glyph>
  );
}

export function IconPause(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Glyph>
  );
}

export function IconPlay(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M6 4.5v15l13-7.5z" />
    </Glyph>
  );
}

export function IconStop(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </Glyph>
  );
}

export function IconRetry(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Glyph>
  );
}

export function IconMessage(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Glyph>
  );
}

export function IconShieldAlert(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 3 5 6v6c0 4.5 3 7.9 7 9 4-1.1 7-4.5 7-9V6z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </Glyph>
  );
}

export function IconShieldCheck(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 3 5 6v6c0 4.5 3 7.9 7 9 4-1.1 7-4.5 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </Glyph>
  );
}

export function IconCheck(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Glyph>
  );
}

export function IconClose(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </Glyph>
  );
}

export function IconAlert(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M10.3 3.9 1.8 18.1A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Glyph>
  );
}

export function IconDashedCircle(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props} strokeDasharray="3 3">
      <circle cx="12" cy="12" r="9" />
    </Glyph>
  );
}

export function IconChevron(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m9 6 6 6-6 6" />
    </Glyph>
  );
}

export function IconFile(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </Glyph>
  );
}

export function IconFolder(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Glyph>
  );
}

export function IconExternal(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </Glyph>
  );
}

export function IconTool(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M14.5 5.5a4 4 0 0 0 5 5L21 9v4a8 8 0 0 1-8 8H9a6 6 0 0 1-6-6V6a3 3 0 0 1 3-3h4z" />
    </Glyph>
  );
}

export function IconClock(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </Glyph>
  );
}

export function IconPlus(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Glyph>
  );
}

export function IconBan(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </Glyph>
  );
}

export function IconOffline(props: GlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M2 3 22 21" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 3.2-2.1" />
      <path d="M19 13a10 10 0 0 0-3.6-2.3" />
      <path d="M2 9a15 15 0 0 1 4-2.6" />
      <path d="M22 9a15 15 0 0 0-11.5-3.9" />
      <path d="M12 20h.01" />
    </Glyph>
  );
}
