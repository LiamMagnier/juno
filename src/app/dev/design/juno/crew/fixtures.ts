/**
 * Realistic crew fixtures for the gallery. Names, roles and "now" lines read
 * the way a real account would on a Tuesday afternoon, so every frame is
 * judged with real content. Most members wear the look their seed gives them
 * (a ceramic pebble in their own colour and proportions); three have been
 * changed by their person, the way a real team would.
 */
import { avatarFromSeed, type AvatarConfig } from "./avatar";
import type { CrewMember, CrewState } from "./face";

export interface CrewFixture extends CrewMember {
  role: string;
  state: CrewState;
  /** One line: what the member is doing or waiting for. */
  now: string;
  /** When the state began, as the person would read it. */
  since: string;
}

const custom = (seed: string, patch: Partial<AvatarConfig>): AvatarConfig => ({ ...avatarFromSeed(seed), ...patch });

export const CREW: CrewFixture[] = [
  {
    id: "mira",
    name: "Mira",
    role: "Accounts",
    seed: "mira-7f3a",
    avatar: custom("mira-7f3a", { color: "sage" }),
    state: "waiting",
    now: "Needs your answer on the Halvorsen renewal",
    since: "12 min",
  },
  {
    id: "otto",
    name: "Otto",
    role: "Finance operations",
    seed: "otto-21c9",
    avatar: custom("otto-21c9", { color: "clay", material: "stone", texture: { kind: "procedural", id: "speckle", seed: 3 } }),
    state: "working",
    now: "Reconciling September invoices, 206 of 214 matched",
    since: "38 min",
  },
  {
    id: "scout",
    name: "Scout",
    role: "Research",
    seed: "scout-9be4",
    avatar: custom("scout-9be4", { color: "iris" }),
    state: "thinking",
    now: "Comparing three vendors for the SOC 2 audit",
    since: "2 min",
  },
  {
    id: "rhea",
    name: "Rhea",
    role: "Support",
    seed: "rhea-44d0",
    avatar: custom("rhea-44d0", { color: "rose", material: "felt" }),
    state: "available",
    now: "Cleared 14 escalations this morning",
    since: "1 h",
  },
  {
    id: "ines",
    name: "Ines",
    role: "Recruiting",
    seed: "ines-c512",
    avatar: custom("ines-c512", { color: "lagoon" }),
    state: "paused",
    now: "Paused until Monday at 9:00",
    since: "Fri",
  },
  {
    id: "tomas",
    name: "Tomas",
    role: "On-call engineering",
    seed: "tomas-0a7e",
    avatar: custom("tomas-0a7e", { color: "graphite", eyes: { ...avatarFromSeed("tomas-0a7e").eyes, style: "lit" } }),
    state: "offline",
    now: "Offline since Friday, the staging key expired",
    since: "3 d",
  },
  {
    id: "nadia",
    name: "Nadia",
    role: "Partnerships",
    seed: "nadia-e83b",
    avatar: custom("nadia-e83b", { color: "porcelain" }),
    state: "available",
    now: "Next: partner digest, Thursday at 8:30",
    since: "4 h",
  },
  {
    id: "bram",
    name: "Bram",
    role: "Release notes",
    seed: "bram-5f61",
    avatar: custom("bram-5f61", { color: "ochre" }),
    state: "working",
    now: "Drafting notes for Atlas 0.9",
    since: "6 min",
  },
];

export const CREW_BY_ID = Object.fromEntries(CREW.map((m) => [m.id, m])) as Record<string, CrewFixture>;

export const STATE_ORDER: CrewState[] = ["available", "thinking", "working", "waiting", "paused", "offline"];

/** What each state says beside a face, in the member's words. Never a dot or a pill. */
export function stateLine(m: Pick<CrewFixture, "name" | "state" | "now">): string {
  switch (m.state) {
    case "thinking":
      return `${m.name} is thinking`;
    case "offline":
      return "Offline";
    case "paused":
      return "Paused";
    default:
      return m.now;
  }
}
