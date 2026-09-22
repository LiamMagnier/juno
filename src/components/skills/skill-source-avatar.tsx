"use client";

import * as React from "react";
import { GitHubMark } from "@/components/connections/connector-logos";
import { cn } from "@/lib/utils";
import { githubAvatarUrl } from "@/components/skills/skill-library-model";

const SIZE = {
  // Inline with caption text: the source chip, the import dialog's chips.
  xs: { box: "size-4 rounded-sm", mark: "size-2.5", px: 32 },
  // A menu or dialog row.
  sm: { box: "size-5 rounded-xs", mark: "size-3", px: 40 },
  // The group row on the list, where it stands in for the skill glyph column.
  md: { box: "size-7 rounded-md", mark: "size-4", px: 56 },
} as const;

/**
 * Who a source belongs to: the GitHub owner's avatar, or the GitHub mark.
 *
 * A plain `<img>` rather than `next/image`: the avatar is a 40px picture
 * GitHub already serves resized, the content security policy allows `https:`
 * images, and next/image would need a remote pattern for one host to do
 * nothing it improves. The mark is the fallback for an owner whose picture
 * does not load (offline, blocked, renamed), drawn on the same tile so a row
 * does not change shape when it falls back.
 *
 * Decorative: `alt=""`. The owner's name is always written beside it.
 */
export function SkillSourceAvatar({
  owner,
  size = "sm",
  className,
}: {
  owner: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const metrics = SIZE[size];
  // A different owner is a different picture; the failure belonged to the old one.
  React.useEffect(() => setFailed(false), [owner]);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden bg-secondary text-foreground",
        // The hairline sits OVER the picture, on a pseudo-element: an inset
        // ring on the tile itself paints under its content, so a white avatar
        // on the paper ground would have no edge at all.
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-inherit after:ring-1 after:ring-inset after:ring-foreground/10",
        metrics.box,
        className
      )}
    >
      {failed ? (
        <GitHubMark className={metrics.mark} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- see the note above
        <img
          src={githubAvatarUrl(owner, metrics.px)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
