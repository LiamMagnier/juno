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
