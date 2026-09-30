"use client";

/**
 * Crew member identity (design round 3). Owned by the crew designer; this stub
 * keeps the import stable for the foundations work while the identity system
 * is designed.
 */
export type CrewState = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";

export interface CrewMember {
  id: string;
  name: string;
  role?: string;
  /** A seed the identity system derives shape and colour from. */
  seed: string;
}

export interface CrewFaceProps {
  member: CrewMember;
  state?: CrewState;
  size?: number;
  className?: string;
}

export function CrewFace({ member, size = 20, className }: CrewFaceProps) {
  return (
    <span
      className={className}
      aria-hidden
      data-crew-face={member.id}
      style={{ display: "inline-block", width: size, height: size, borderRadius: size / 2, background: "currentColor", opacity: 0.25 }}
    />
  );
}
