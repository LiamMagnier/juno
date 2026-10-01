# Juno Refoundation — decision log

Each entry: the decision, why, what was rejected, and what it costs. Newest
decisions are appended; a reversed decision is marked, not deleted.

## Process

**D-001 · Work on a branch and a worktree, never on main.** Branch
`rework/refoundation` in `../juno-refoundation`. Other sessions release from
main; this work lands only when its gates are green and the owner agrees.

**D-002 · Pull security and privacy fixes forward (deviation from the phase
order).** Phase 0 found problems that are live in production: server-side
request forgery through user MCP servers (`src/lib/user-mcp.ts:46-57`), deleted
agent notes still fed to autonomous runs (`scripts/work-runner.ts:931-936`),
design edits leaking onto public links (`src/lib/design/store.ts:179-200`), and
an approval card promising "Juno will not ask again" when nothing honours the
grant. They are fixed first, on the refoundation branch and on a separate
`hotfix/*` branch cut from main so they can ship without the redesign.

**D-003 · Run Juno Code's runtime work (Phase 9) in parallel with the design
phases (deviation).** It shares no files with Phases 2–8 (Swift JunoCode
runtime, `runner/agent-core`, the new agent protocol), so ordering it after
the web redesign would only waste time. The Mac Code UX (Phase 10) still waits
for the design system.

**D-004 · Treat unmerged branches as material, not as merges.**
`connectors/custom-mcp` is not merged (it introduces a second custom-MCP model
that competes with main's `UserMcpServer`, which has production rows); its
`mcp-safe-fetch.ts`, OAuth flow and per-tool switches are taken.
`skills/import-anywhere` exists only as uncommitted changes in another
session's worktree; its diff is read and re-applied here without touching that
worktree. The chat-rework branches (`web/rework-ws*`) are read as specification
for the transcript, not merged. `artifacts/r1-lifecycle` contributes its
re-emit guard, trash/purge and tests, not its hidden anchor chat.

## Product

**D-005 · Seven nouns.** Chat, Code, Crew, Project, Library, Apps, Skills.
Artifacts and Design fold into Library; Assistants into Crew; Automations
become routines; Connections become Apps; Notifications leave the sidebar;
"Work" leaves the vocabulary. *Why:* every vendor that shipped more nouns in
2026 (OpenAI's Chat/Work/Codex modes, three agent products; Anthropic's two
"Projects", five parallel-agent mechanisms) produced confusion their own users
describe. *Rejected:* keeping Artifacts as its own destination (Claude's
choice) — a person looking for "the deck Juno made" and "the PDF I uploaded"
is looking in the same place.

**D-006 · "Crew", lowercase, members always named.** Research (naming-identity
report) checked collisions: CrewAI's core noun is "crew", AWS launched Kiro
Crew (a persistent-agent workspace) on 2026-08-04, crew.you sells "Crew — Your
Personal AI Agent", and "crew" is a crowded weak mark in US software classes.
"Team" collides with plan tiers, Microsoft Teams and Grok's Team Bots and is
needed later for human workspaces; "Deputies" means legislator in four target
languages; "Orbit" doesn't make sentences ("Orbit needs you"); "Staff" reads as
Juno's employees. Crew wins on clarity and verb-ability, so it is used as a
common noun, never as the sub-brand "Juno Crew" and never "crewmate". If
counsel objects, fall back to "Agents".

**D-007 · Assistants retire into Crew.** Assistants are `WorkSkill` rows of
kind `assistant` (a GPT equivalent: prompt, tools, model, starters). OpenAI
retired GPTs into plugins on 2026-09-11 for the same overlap. Existing
assistants remain readable through their API for native compatibility and get
"Move to crew"; the destination disappears.

**D-008 · The conversation keeps deciding.** No Chat/Work switch (OpenAI's
users call it "being transferred to another assistant"); Research becomes
`/research` plus model choice, not a `+` toggle.

**D-009 · Customize is the one home for extending Juno.** Apps, Skills,
Routines, Memory, Instructions. Matches where Anthropic (Customize) and OpenAI
(plugin directory) landed, and replaces seven scattered surfaces.

**D-010 · No crew rooms in this pass; build the prerequisites.** Grok's
groups are capped and its power users add structure on top; OpenAI launched
one dot per person. Juno's task model has no owning member, no parent link,
no claim or transfer, no per-member budget, and refuses a second live task per
conversation. Those come first, then rooms behind a flag. The `agents/features`
branch's routing, per-message turn cap and loop guard are the starting point
when rooms are built.

**D-011 · Crew computers stay gated until the five holes close.** Listed in
PRODUCT_REFOUNDATION §7 and the security audit. Keep per-member isolation
(safer than Grok's shared VM); add a person-level login broker later instead of
typing passwords into the agent's browser.

**D-012 · One approval ladder, named by experience.** Today there are five chat
policies, three Work policies, a per-agent approval mode and Code's four modes.
The person-facing ladder has three rungs; the always-confirm floor is below all
of them. Keep digest binding and expiry (stronger than every competitor); add
task-scoped grants and Codex's fourth answer ("Tell Juno what to do instead").
Rejected: Muse's "learns which decisions need your sign-off".

**D-013 · Artifacts get their own owner.** `userId`, `projectId`, `deletedAt`,
nullable conversation link — not `artifacts/r1-lifecycle`'s hidden anchor chat.
Publish is separate from Share and pins a version.

**D-014 · Juno Code converges the protocol, not the engine.** Swift stays the
local engine (mature, ~1,000 tests), agent-core stays the Linux engine; one
versioned event/command protocol generated into both, as Codex's app-server and
ACP do.

**D-015 · iPhone tab bar is Chat · Crew · Code.** The Work tab goes; tasks live
in chats. Search is the system search tab.

## Design round 1 rejected (2026-09-30)

**D-016 · Round 1 directions rejected.** The owner judged the first gallery
(ion / graphite / meridian, commit 9f52b73b) "horrible AI slop compared to the
actual website". Agreed diagnosis: token swaps of one layout rather than three
designs; the accent everywhere; heavy greeting in off-the-shelf faces; busy
sidebar and suggestion rows; cool grey plus saturated blue reads as a default
SaaS template. The owner's goal is "the best overall product in terms of UI / UX
and motion design", and the bar is *better than today's Juno at the same frame*,
not merely different. Round 2 gives each designer a genuinely different concept
(Porcelain: evolve today; Canvas: the reference images' principles; Instrument:
a dark-first pro tool), a craft brief (two weights, accent in at most two places
per screen, tokens drawn with the entity's own mark, one elevated object), a
motion brief with recorded clips, three self-critique passes against current
frames, a critic panel and a revision round.

**D-017 · Skill guidance that the owner's rules override.** swiftui-design-skill
recommends a serif display face and a warm accent, and stitch-design-taste
recommends perpetual micro-loops and staggered list mounts. Both are overruled:
the serif/warm pairing is exactly what reads as Claude, and the owner's motion
brief bans decorative loops and endless staggers.

## Juno Code agent (owner request 2026-09-30)

The owner asked for "a real agent that can autonomously loop … like Codex,
Claude Code and everyone", fixed computer use, preview, and every missing
feature. Spec: `CODE_AGENT_SPEC.md` (lanes A–F). Its §7 decisions, taken here:

**D-018 · Autonomy is on by default at the standard level**, with the §1.6
budgets. The runtime's stop check, not the model, decides whether a run is
finished; it never widens permissions.

**D-019 · Checks run without prompts only through exact rules** the reader
accepts once from the verify-recipe card ("Run these without asking in this
repository"). Auto-running any command in the sandbox waits until the sandbox
stops allowing global reads; the credential read deny-list (S3) is built in
lane B.

**D-020 · The goal judge is the cheapest capable model in the account's
catalogue**, billed like other Code usage and shown separately in `/cost`. The
judge can only answer continue / met / impossible.

**D-021 · Computer-use grants are per app and per session** (Claude Code's
model), no persistent "Always allow" in this pass.

**D-022 · Evidence:** Preview screenshots and check results are kept with the
session (local, deletable, not synced); computer-use screenshots stay
memory-only. Nothing is attached to a PR unless the reader asks.

**D-023 · Preview stays loopback-only.** External sites are out of scope for the
agent's browser in this pass.

**D-024 · Simulator input uses public tooling only:** `simctl` for install,
launch, screenshots and URLs; taps and typing through accessibility on
Simulator.app under a computer-use grant. No private SimulatorKit APIs.

**D-025 · Offscreen Preview host,** with a 1-pt near-transparent on-screen host
as the fallback if WebKit throttles offscreen pages. **Resume on launch** is off
by default with a setting. **Headless CLI** waits (P2); an App Intent ships
first.

## Design round 2 feedback (2026-09-30)

The owner saw early round-2 passes: "a bit better", then: dark mode looks
horrible; the shadow behind the composer looks bad; build our own icons that
follow the design system, with motion on hover, press and every state; the
agents' design is bad (rework shapes, motion, everything); bring back the serif
font; keep upgrading.

**D-026 · Converge on one system.** Canvas and Porcelain had converged anyway
(bright neutral ground, neutral tokens carrying each thing's mark, three small
suggestion chips, quiet sidebar). Instrument produced the dark screen the owner
called horrible and is dropped; its density ideas survive as a Code density
variant of the same system. Round 3 puts specialists on the one system
(foundations and screens; icons; crew identity) instead of three generalists.

**D-027 · The serif returns (reverses part of D-017).** Newsreader is the
display face for the greeting and display moments, as the owner asked. It is not
used for the Claude "How can I help, *Name*?" italic-name pattern, and a
Cyrillic-capable serif is added to the stack because Newsreader has no Cyrillic.

**D-028 · Juno draws its own icons.** One set on a 24px grid, drawn for 16 and
20px, with purposeful micro-motion on hover, press, active and state changes
(copy→check, send→stop, mic→waveform), CSS-only, with reduced-motion forms. It
replaces the mix of lucide, phosphor and the old glyphs, and projects to native
through the icon generator. This overrides design-taste-frontend's "never
hand-roll icons" rule, because the owner asked for it.

**D-029 · Crew identity is redesigned from the shape up.** The Grok-like
two-dot rounded square goes. New shape grammar, states and motion rig.

**D-030 · The composer has no drop shadow;** it is defined by surface and a
crisp hairline. **Dark mode is designed, not derived:** it gets the same
critique weight as light.

**D-031 · Crew members are three-dimensional and texturable (owner, 2026-10-01).**
"Make the crew shape 3D … with the ability to add texture … the best looking
agents." Rendered with three.js (already a dependency): sculpted minimal forms
in physically based materials (matte ceramic default; frosted glass, felt,
stone/terrazzo, metal, wood), studio lighting, procedural textures and an
uploaded image as a texture. One serialisable `AvatarConfig` drives web and
native (RealityKit meshes and PhysicallyBasedMaterial on Mac/iOS). Performance
is part of the design: one shared renderer, cached sprites at ≤ 28 px, on-demand
rendering for live faces, zero GPU work when idle. Motion stays event-driven
(INTERACTION_SPEC §2.9, amended P4).

**D-032 · Crew members are premium, cute 3D characters with deep customization
(owner, 2026-10-01; supersedes the "face is an instrument, never a character"
rule in PRODUCT_REFOUNDATION §7 and INTERACTION_SPEC §2.9, and refines D-031).**
The owner shared OpenAI's dots imagery (plush 3D characters with accessories,
expressive eyes, a colour per character that themes its thread, the character
peeking above the conversation with its name and "Thinking…") and asked for
"these kind of agents … more premium but cute … a lot of customization, motion
design and everything". Juno builds its own character system in that spirit:
own body shapes, materials (plush fur by shell texturing, velvet flock, knit,
felt, soft vinyl, ceramic), eyes, accessories, colours, and an editor with a
live 3D preview. Guardrails: never replicate dots' four characters or their
exact accessories/colour pairings; state is always also words (no pills or
dots); motion is mostly event-driven, with a subtle idle allowed only on the
large character in the member's own thread (stopped when hidden or under
Reduce Motion); performance rules from D-031 still apply (shared renderer,
sprites at small sizes, fur level-of-detail, zero GPU when idle).

**D-033 · Framed shell, restrained blur, centred composer; crew modeled in
Blender (owner, 2026-10-01).** The owner called the first character build
"weird … uncanny valley and not cute", asked for Blender, and for the chat:
background blur on components, a reworked sidebar (spacing and sizes), the home
composer centred in the screen, and the framed layout from a screenshot (the
sidebar on the window frame, the main area a rounded inset panel). Decisions:
the shell becomes a frame plus an inset main panel in both themes (full-bleed at
phone width); floating layers (menus, popovers, palettes, sheets, toasts, the
sticky header and the docked composer's backdrop) use a translucent blurred
material with a solid reduced-transparency fallback, never content surfaces;
characters follow explicit cuteness principles (large, low, wide-set eyes; one
soft mass; plush materials; no realistic irises) and are modeled in Blender
5.2 (installed with the owner's OK via Homebrew), exported as glb for the live
three.js renderer and USD for RealityKit, with Cycles hero renders. The owner
marked the first-pass icon set as good for now.

**D-034 · Crew characters are flocked designer toys, not furry creatures
(owner, 2026-10-01).** The owner judged the Blender plush characters "still
creepy compared to OpenAI versions". Agreed diagnosis: long shaggy fur reads
as a hairy creature; glossy beady eyes with catchlights read as an animal's;
dusty colours, amorphous blobs, small realistic accessories and blush all push
toward uncanny. Direction: short velvet flocking with a crisp silhouette,
graphic eyes only (matte ovals, white googly, closed arcs, opaque glasses),
clean saturated colours, bold iconic silhouettes of our own, bold matte
oversized accessories, no blush or mouth, high-key light. Same genre as dots,
never their characters. Each Blender pass is scored by independent critics for
appeal and creepiness against the dots key art in the same composition; the
loop stops only at appeal ≥ 8, not creepy, ownable ≥ 7, premium ≥ 8.
