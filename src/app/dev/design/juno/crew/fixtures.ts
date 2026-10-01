/**
 * Realistic crew fixtures for the gallery and the screens: twelve members of
 * one account on a Tuesday afternoon, each a character its person has made
 * their own. Names, roles and "now" lines read the way a real team would.
 *
 * The twelve are Juno's own designs (D-032, D-033), the same looks as the
 * Blender roster (tools/crew/roster.json) and its Cycles portraits: no blue
 * cloud in a beret, no frog, no yellow triangle in round glasses and a bow
 * tie, no pink heart in sunglasses. `resemblesSomeoneElse` is false for every
 * one of them (the gallery checks).
 */
import { AVATAR_VERSION, avatarFromSeed, type AccessorySpec, type AvatarConfig } from "./avatar2";
import type { CrewMember, CrewState } from "./face";

export interface CrewFixture extends CrewMember {
  role: string;
  state: CrewState;
  /** One line: what the member is doing or waiting for. */
  now: string;
  /** When the state began, as the person would read it. */
  since: string;
  avatar: AvatarConfig;
}

type Look = Partial<Omit<AvatarConfig, "eyes" | "material">> & {
  eyes?: Partial<AvatarConfig["eyes"]>;
  material?: Partial<AvatarConfig["material"]>;
  wear?: (AccessorySpec | AccessorySpec["id"])[];
};

function look(seed: string, l: Look): AvatarConfig {
  const base = avatarFromSeed(seed);
  return {
    ...base,
    ...l,
    v: AVATAR_VERSION,
    seed,
    eyes: { ...base.eyes, ...l.eyes },
    material: { ...base.material, ...l.material },
    accessories: (l.wear ?? []).map((a) => (typeof a === "string" ? { id: a } : a)),
  };
}

export const CREW: CrewFixture[] = [
  {
    id: "mira",
    name: "Mira",
    role: "Accounts",
    seed: "mira-accounts",
    avatar: look("mira-accounts", {
      shape: "pebble",
      stretch: 0.05,
      color: "marigold",
      material: { kind: "plush", furLength: 0.45, furDensity: 0.85 },
      eyes: { style: "oval", size: 0.55, gap: 0.5, y: 0.35 },
      cheeks: true,
      wear: [{ id: "flower", color: "#e9566d" }],
    }),
    state: "waiting",
    now: "Needs your answer on the Halvorsen renewal",
    since: "4 min",
  },
  {
    id: "otto",
    name: "Otto",
    role: "Finance operations",
    seed: "otto-finops",
    avatar: look("otto-finops", {
      shape: "marshmallow",
      stretch: 0,
      color: "cocoa",
      material: { kind: "plush", furLength: 0.35, furDensity: 0.9 },
      eyes: { style: "button", size: 0.45, gap: 0.5, y: 0.35 },
      wear: [{ id: "round", color: "#c9a660" }],
    }),
    state: "working",
    now: "Reconciling September invoices, 206 of 214 matched",
    since: "38 min",
  },
  {
    id: "scout",
    name: "Scout",
    role: "Research",
    seed: "scout-research",
    avatar: look("scout-research", {
      shape: "bean",
      stretch: 0.1,
      color: "iris",
      material: { kind: "plush", furLength: 0.4, furDensity: 0.85 },
      eyes: { style: "oval", size: 0.6, gap: 0.5, y: 0.4 },
      wear: [{ id: "antenna", color: "#f4a07a" }],
    }),
    state: "thinking",
    now: "Comparing three vendors for the SOC 2 audit",
    since: "2 min",
  },
  {
    id: "rhea",
    name: "Rhea",
    role: "Support",
    seed: "rhea-support",
    avatar: look("rhea-support", {
      shape: "cub",
      stretch: 0,
      color: "mint",
      material: { kind: "plush", furLength: 0.5, furDensity: 0.85 },
      eyes: { style: "button", size: 0.5, gap: 0.5, y: 0.35 },
      cheeks: true,
      wear: [{ id: "headphones", color: "graphite" }],
    }),
    state: "available",
    now: "Cleared 14 escalations this morning",
    since: "1 h",
  },
  {
    id: "ines",
    name: "Ines",
    role: "Recruiting",
    seed: "ines-recruiting",
    avatar: look("ines-recruiting", {
      shape: "drop",
      stretch: 0,
      color: "lilac",
      material: { kind: "plush", furLength: 0.3, furDensity: 0.85 },
      eyes: { style: "sleepy", size: 0.55, gap: 0.5, y: 0.35 },
      cheeks: true,
      wear: [{ id: "headband", color: "#f0b545" }],
    }),
    state: "paused",
    now: "Paused until Monday at 9:00",
    since: "Fri",
  },
  {
    id: "tomas",
    name: "Tomas",
    role: "On-call engineering",
    seed: "tomas-oncall",
    avatar: look("tomas-oncall", {
      shape: "kit",
      stretch: 0,
      color: "sky",
      material: { kind: "plush", furLength: 0.45, furDensity: 0.85 },
      eyes: { style: "oval", size: 0.5, gap: 0.5, y: 0.35 },
      wear: [{ id: "cap", color: "graphite" }],
    }),
    state: "offline",
    now: "Offline since Sunday, the staging key expired",
    since: "2 d",
  },
  {
    id: "nadia",
    name: "Nadia",
    role: "Partnerships",
    seed: "nadia-partners",
    avatar: look("nadia-partners", {
      shape: "gumdrop",
      stretch: 0,
      color: "apricot",
      material: { kind: "plush", furLength: 0.45, furDensity: 0.85 },
      eyes: { style: "button", size: 0.5, gap: 0.5, y: 0.35 },
      wear: [{ id: "bucket", color: "#e8dcc6" }],
    }),
    state: "available",
    now: "Next: partner digest, Thursday at 8:30",
    since: "4 h",
  },
  {
    id: "bram",
    name: "Bram",
    role: "Release notes",
    seed: "bram-release",
    avatar: look("bram-release", {
      shape: "peanut",
      stretch: 0,
      color: "lagoon",
      material: { kind: "plush", furLength: 0.4, furDensity: 0.85 },
      eyes: { style: "bead", size: 0.6, gap: 0.5, y: 0.4 },
      wear: [{ id: "square", color: "#2c2d31" }],
    }),
    state: "working",
    now: "Drafting notes for Atlas 0.9",
    since: "6 min",
  },
  {
    id: "wren",
    name: "Wren",
    role: "Design review",
    seed: "wren-design",
    avatar: look("wren-design", {
      shape: "star",
      stretch: 0,
      color: "blossom",
      material: { kind: "plush", furLength: 0.4, furDensity: 0.85 },
      eyes: { style: "oval", size: 0.55, gap: 0.5, y: 0.4 },
      cheeks: true,
      wear: [{ id: "bow", color: "raspberry" }],
    }),
    state: "available",
    now: "Left 9 comments on the pricing page",
    since: "25 min",
  },
  {
    id: "kit",
    name: "Kit",
    role: "Data",
    seed: "kit-data",
    avatar: look("kit-data", {
      shape: "mochi",
      stretch: 0,
      color: "moss",
      material: { kind: "plush", furLength: 0.5, furDensity: 0.85 },
      eyes: { style: "button", size: 0.5, gap: 0.5, y: 0.35 },
      cheeks: true,
      wear: ["sprout"],
    }),
    state: "thinking",
    now: "Checking why weekly actives dipped on Sunday",
    since: "1 min",
  },
  {
    id: "pia",
    name: "Pia",
    role: "Travel",
    seed: "pia-travel",
    avatar: look("pia-travel", {
      shape: "orb",
      stretch: 0,
      color: "raspberry",
      material: { kind: "plush", furLength: 0.45, furDensity: 0.85 },
      eyes: { style: "oval", size: 0.5, gap: 0.5, y: 0.35 },
      wear: [{ id: "beanie", color: "#ece3d2" }],
    }),
    state: "working",
    now: "Holding two hotel options for the Lisbon offsite",
    since: "12 min",
  },
  {
    id: "sol",
    name: "Sol",
    role: "Legal",
    seed: "sol-legal",
    avatar: look("sol-legal", {
      shape: "lop",
      stretch: 0,
      color: "oat",
      material: { kind: "plush", furLength: 0.35, furDensity: 0.9 },
      eyes: { style: "stitched", size: 0.5, gap: 0.5, y: 0.35 },
      cheeks: true,
      wear: [{ id: "monocle", color: "#c9a660" }],
    }),
    state: "available",
    now: "Redlined the Halvorsen MSA, two open points",
    since: "3 h",
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
