/**
 * Inline icon set.
 *
 * The app has no icon dependency, and adding one for fifteen glyphs would put a
 * few hundred kilobytes in the renderer bundle for shapes that fit in this
 * file. Every icon is 16×16 on a 16-unit grid, 1.5 stroke, `currentColor`, and
 * `aria-hidden` — an icon is never the accessible name of a control, the
 * control's own `aria-label` is.
 */

import type { JSX, ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronRight = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

export const ChevronDown = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
);

export const FileIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z" />
    <path d="M9 1.5V5.5H13" />
  </Icon>
);

export const PencilIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M11.2 2.3a1.4 1.4 0 0 1 2 2L6 11.5l-2.7.8.8-2.7z" />
    <path d="M2.5 14.2h11" />
  </Icon>
);

export const SearchIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Icon>
);

export const TerminalIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="m3 4.5 3 3.5-3 3.5" />
    <path d="M8.5 11.5H13" />
  </Icon>
);

export const BeakerIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M6.5 1.8v4L3.2 12a1.4 1.4 0 0 0 1.2 2.1h7.2A1.4 1.4 0 0 0 12.8 12L9.5 5.8v-4" />
    <path d="M5.5 1.8h5" />
    <path d="M4.6 9.6h6.8" />
  </Icon>
);

export const BranchIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <circle cx="4.5" cy="3.5" r="1.8" />
    <circle cx="4.5" cy="12.5" r="1.8" />
    <circle cx="11.5" cy="6" r="1.8" />
    <path d="M4.5 5.3v5.4" />
    <path d="M11.5 7.8c0 2-1.6 2.9-3.5 3.2" />
  </Icon>
);

export const CheckIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="m3 8.3 3.2 3.2L13 4.7" />
  </Icon>
);

export const CloseIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const AlertIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M8 2.2 14.4 13H1.6z" />
    <path d="M8 6.4v3.1" />
    <path d="M8 11.4h.01" />
  </Icon>
);

export const ShieldIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M8 1.6 13.2 3.6v4c0 3.3-2.2 5.8-5.2 6.8-3-1-5.2-3.5-5.2-6.8v-4z" />
    <path d="M8 5.6v3" />
    <path d="M8 10.6h.01" />
  </Icon>
);

export const LockIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <rect x="3.2" y="7" width="9.6" height="7" rx="1.4" />
    <path d="M5.4 7V4.8a2.6 2.6 0 0 1 5.2 0V7" />
  </Icon>
);

export const StopIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </Icon>
);

export const SendIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M2.4 8h9.4" />
    <path d="M8.2 4.4 11.8 8l-3.6 3.6" />
  </Icon>
);

export const AgentsIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <circle cx="8" cy="3.6" r="1.9" />
    <circle cx="3.6" cy="12.2" r="1.9" />
    <circle cx="12.4" cy="12.2" r="1.9" />
    <path d="M8 5.5v2.2M6.6 8.4 4.6 10.6M9.4 8.4l2 2.2" />
  </Icon>
);

export const ColumnsIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <rect x="2" y="2.8" width="12" height="10.4" rx="1.3" />
    <path d="M8 2.8v10.4" />
  </Icon>
);

export const RowsIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <rect x="2" y="2.8" width="12" height="10.4" rx="1.3" />
    <path d="M2 8h12" />
  </Icon>
);

export const ArrowDownIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M8 3v9.2" />
    <path d="m4.4 8.8 3.6 3.6 3.6-3.6" />
  </Icon>
);

export const DotIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
  </Icon>
);

export const FolderIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <path d="M1.8 4.2A1.4 1.4 0 0 1 3.2 2.8h2.6l1.4 1.8h5.6a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z" />
  </Icon>
);

export const ClockIcon = (props: IconProps): JSX.Element => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.3 1.4" />
  </Icon>
);

/** Determinate-free activity indicator. Rotation only — no colour change. */
export const SpinnerIcon = (props: IconProps): JSX.Element => (
  <Icon {...props} className={`animate-spin ${props.className ?? ''}`}>
    <path d="M8 1.8a6.2 6.2 0 1 0 6.2 6.2" />
  </Icon>
);
