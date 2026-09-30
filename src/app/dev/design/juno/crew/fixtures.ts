/**
 * Realistic crew fixtures for the gallery. Names, roles and "now" lines are
 * written as a real account would read on a Tuesday afternoon, so every
 * frame is judged with real content (premium-design-2026 §6.1, rule 11).
 */
import type { CrewFamily } from "./identity";
import type { CrewMember, CrewState } from "./face";

export interface CrewFixture extends CrewMember {
  family: CrewFamily;
  role: string;
  state: CrewState;
  /** One line: what the member is doing or waiting for. */
  now: string;
  /** When the state began, as the person would read it. */
  since: string;
}

export const CREW: CrewFixture[] = [
  {
    id: "mira",
    name: "Mira",
    role: "Accounts",
    seed: "mira-7f3a",
    family: "sage",
    state: "waiting",
    now: "Wants your answer on the Halvorsen renewal",
    since: "12 min",
  },
  {
    id: "otto",
    name: "Otto",
    role: "Finance operations",
    seed: "otto-21c9",
    family: "clay",
    state: "working",
    now: "Reconciling September invoices against Stripe",
    since: "38 min",
  },
  {
    id: "scout",
    name: "Scout",
    role: "Research",
    seed: "scout-9be4",
    family: "iris",
    state: "thinking",
    now: "Comparing three vendors for the SOC 2 audit",
    since: "2 min",
  },
  {
    id: "rhea",
    name: "Rhea",
    role: "Support",
    seed: "rhea-44d0",
    family: "rose",
    state: "available",
    now: "Cleared 14 escalations this morning",
    since: "1 h",
  },
  {
    id: "ines",
    name: "Ines",
    role: "Recruiting",
    seed: "ines-c512",
    family: "lagoon",
    state: "paused",
    now: "Paused until Monday at 9:00",
    since: "Fri",
  },
  {
    id: "tomas",
    name: "Tomas",
    role: "On-call engineering",
    seed: "tomas-0a7e",
    family: "slate",
    state: "offline",
    now: "Offline since Friday, the staging key expired",
    since: "3 d",
  },
  {
    id: "nadia",
    name: "Nadia",
    role: "Partnerships",
    seed: "nadia-e83b",
    family: "plum",
    state: "available",
    now: "Next: partner digest, Thursday at 8:30",
    since: "4 h",
  },
  {
    id: "bram",
    name: "Bram",
    role: "Release notes",
    seed: "bram-5f61",
    family: "olive",
    state: "working",
    now: "Drafting notes for Atlas 0.9",
    since: "6 min",
  },
];

export const CREW_BY_ID = Object.fromEntries(CREW.map((m) => [m.id, m])) as Record<string, CrewFixture>;

export const STATE_ORDER: CrewState[] = ["available", "thinking", "working", "waiting", "paused", "offline"];
