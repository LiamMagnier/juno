/**
 * ALEVR DISPLAY NAMES: the one place the product and its features are named.
 *
 * Every user-facing name in the web app reads from here, so renaming the
 * product or a feature is one edit to a string below. The sidebar, page and
 * tab titles, metadata, the manifest, the shell contract, the assistant's own
 * self-name and every sentence that says "Alevr" follow it.
 *
 * The map is docs/rework/brand/NAMES_AND_ICONS.md (decisions D-035..D-037):
 *
 *   Alevr        the product. Alevr Chat, Alevr Orbit and Alevr Code explain
 *                its three parts; navigation says Chat, Orbit and Code.
 *   Orbit        where your persistent agents live. Its descriptor is
 *                "Your agents". One of them is an "agent" (or its own name),
 *                never "an Orbit" and never a crew member or teammate.
 *   Features     Projects, Library, Customize, Apps, Skills, Routines, Memory,
 *                Instructions, Research: plain capability names, not brands.
 *
 * Names still being chosen (an artifact's and memory's, see
 * docs/rework/brand/FEATURE_NAMES_PROPOSAL.md) sit here at their current
 * defaults, so the owner's choice lands as a one-line change.
 *
 * TRANSLATION. The interface is translated by matching rendered text against
 * the build-time catalog (scripts/generate-i18n-catalog.mjs). The generator
 * evaluates this module, adds its strings, and resolves `${PRODUCT_NAME}` and
 * `${BRAND.orbit.label}`-style references inside template literals anywhere in
 * src/, so a sentence built from these names is catalogued whole, exactly as
 * it renders. Two rules keep that working:
 *
 *   1. This module imports nothing. The generator evaluates it standalone.
 *   2. Interpolate a name into ONE template literal per sentence
 *      (`${PRODUCT_NAME} could not reach the server.`), not as a separate JSX
 *      child, which would split the sentence into fragments.
 *
 * WHAT THIS IS NOT. Display names only. Routes (/agents, /crew), ids, storage
 * keys (juno:*), cookies, API fields, env vars, package and bundle ids, file
 * names (crew/, juno-*), the User-Agent the server sends and third-party names
 * keep their stable spellings and must never be built from these strings.
 */

/** The product. Pronounced AL-ver. */
export const PRODUCT_NAME = "Alevr";

/** The product and its three parts: the explanatory title and the navigation label. */
export const BRAND = {
  product: { label: PRODUCT_NAME, pronunciation: "AL-ver" },
  chat: { label: "Chat", title: `${PRODUCT_NAME} Chat` },
  orbit: { label: "Orbit", title: `${PRODUCT_NAME} Orbit`, description: "Your agents" },
  code: { label: "Code", title: `${PRODUCT_NAME} Code` },
} as const;

/** One persistent agent, and several. Lower case: these sit inside sentences. */
export const AGENT_NOUN = {
  singular: "agent",
  plural: "agents",
} as const;

/**
 * Destinations and capabilities, by their navigation label. Sentence case, as
 * they appear in the sidebar, Customize, Settings and the + menu.
 */
export const FEATURE_NAMES = {
  newChat: { label: "New chat" },
  search: { label: "Search" },
  projects: { label: "Projects" },
  library: { label: "Library" },
  customize: { label: "Customize" },
  apps: { label: "Apps" },
  skills: { label: "Skills" },
  routines: { label: "Routines" },
  memory: { label: "Memory" },
  instructions: { label: "Instructions" },
  research: { label: "Research" },
  needsYou: { label: "Needs you" },
  createAgent: { label: "Create agent" },
  /** Pending the owner's naming choice; NAMES_AND_ICONS keeps "Artifacts" inside an item. */
  artifacts: { label: "Artifacts", singular: "Artifact" },
} as const;

/**
 * An agent's runtime state, in words. These are the truthful states from
 * ORBIT_SYSTEM.md; colour and pose never carry them alone.
 */
export const AGENT_STATE_NAMES = {
  ready: "Ready",
  thinking: "Thinking",
  working: "Working",
  needsAnswer: "Needs your answer",
  blocked: "Blocked",
  finished: "Finished",
} as const;
