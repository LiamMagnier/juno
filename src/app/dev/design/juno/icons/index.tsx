"use client";

/**
 * Juno icon set (design round 3). Owned by the icon designer; the stub below
 * keeps the import stable for the foundations and crew work while the set is
 * drawn. `name` values not yet drawn render a neutral placeholder square.
 *
 * Motion contract: an icon animates when an ancestor carries the class
 * `jicon-trigger` and is hovered, focused-visible or pressed, or when the icon
 * itself receives `state="active"`. Styles live in ./icons.css.
 */
import type { SVGProps } from "react";

export type IconName = string;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: 16 | 20 | 24 | number;
  state?: "rest" | "active" | "disabled";
  title?: string;
}

export function Icon({ name, size = 20, state = "rest", title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      data-icon={name}
      data-state={state}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <rect x="5" y="5" width="14" height="14" rx="3" opacity="0.35" />
    </svg>
  );
}
