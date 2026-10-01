# Alevr names and interface icons

Working design direction · 2026-10-01. This is the editorial replacement map for future implementation, not evidence that production strings changed.

## Product architecture

- **Alevr:** master product and application name.
- **Alevr Chat:** explanatory product label; navigation Chat.
- **Alevr Orbit:** persistent agent workspace; navigation Orbit with first-use descriptor Your agents.
- **Alevr Code:** professional coding workspace; navigation Code.
- An individual is an **agent**, addressed by its user-chosen name. The collective is **your agents**. Never an Orbit or an Alevr.
- Projects, Library and Customize are destinations inside the product. Apps, Skills, Routines, Memory and Instructions are clear capability names, not competing brands.

## Old-to-new editorial map

| Existing label / concept | Proposed label | Scope and rationale |
|---|---|---|
| Juno | Alevr | Owned product identity, window titles, onboarding, settings, help, notifications, web metadata and downloads |
| Juno Chat | Alevr Chat / Chat | Product explanation / navigation respectively |
| Juno Code | Alevr Code / Code | Product explanation / navigation respectively |
| Crew (workspace) | Alevr Orbit / Orbit | Agent product / sidebar and destination title respectively |
| Your crew | Your agents | Plain collective inside content |
| Crew member, teammate, crewmate | Agent, or its own name | Avoid employment implication and brand jargon |
| Add to crew / Hire agent | Create agent | Conversation-first setup |
| Assistants (persistent agent surface) | Agents, within Orbit | Preserve saved prompt/skill semantics where the old label means a different entity |
| Chat / New chat / Search | Unchanged | Clear everyday action names |
| Projects / Project | Unchanged | Context container |
| Library | Unchanged | Made things and uploaded files |
| Artifacts / Design (separate navigation) | Library | Keep artifact/design editor labels inside the relevant item |
| Artifacts (things Alevr makes) | Folio / Folios ("What Alevr made") | D-038: Library filter "Folios", "Open folio"; running copy names the real type (deck, document, site) |
| Research / Deep research | Deep Field ("Deep research") | D-038: always two words; quick lookups stay Search |
| Customize | Unchanged | One home for extensions and personalization |
| Connections / Integrations (service settings) | Apps | Retain Connection inside an app's connection details |
| Apps / Skills | Unchanged | Distinct services and reusable behavior |
| Automations (scheduled work destination) | Routines | Keep trigger/schedule terminology in detailed controls |
| Routines / Memory / Instructions | Unchanged | Predictable settings nouns (D-038: Memory stays Memory; Locus not adopted) |
| Work (separate conversational mode) | Work inside Chat or an agent thread | Do not require a mode switch to carry out work |
| Research | Unchanged | Capability and editable plan inside conversation |
| Voice / Dictation | Unchanged | Speaking with the assistant / entering text remain distinct |
| Computer / Preview / Activity | Unchanged | Operational views in the agent or coding context |
| Tasks / Runs / Receipts | Unchanged where exposed | Work item / execution / durable evidence are different concepts |
| Needs you | Unchanged | Sidebar attention section; agent events use Needs your answer |
| Free (agent idle state) | Ready | Avoid confusion with plan price |
| Thinking / Working / Blocked / Finished | Unchanged | Explicit truthful runtime states |
| Allowed / Ask first / Blocked | Unchanged | Permission decisions |
| Stop / Continue / Review / Retry / Approve | Unchanged | Consequential actions must stay explicit |
| Plan, account, billing, model, files and app provider names | Unchanged | Functional and third-party vocabulary |

No stable database keys, API fields, routes, bundle identifiers, signing/team identifiers, IPC channels, package names, migration names, import paths, local storage keys or service domains are renamed by this map. A visible Orbit destination may retain its existing agent/crew route. Any necessary migration needs a separately reviewed compatibility plan. Third-party Claude, ChatGPT, GitHub, Slack and other names/logos stay recognizable.

## Drawing grammar

Inherit the V3 family in src/components/ui/juno-icons/drawings.ts: 24-unit construction grid, live area 3–21, 1.5-unit key lattice, rounded caps and joins, continuous container corners, purposeful serif-like shoulders and 1.5-unit foreground interruption at overlaps. Stroke 1.25 px at 16 px, 1.5 px at 18 px and above. Use optical fitting per rendered size; do not scale every drawing blindly. Drop unnecessary detail below 18 px. The New motif is a small bottom-right plus.

The selected Continuum silhouette is Alevr’s master brand mark and thinking symbol, not the template for every action glyph. Read MOTION_AND_THINKING.md for the owner-requested thinking and feature-motion contract. Family coherence comes from weight, curvature, spacing and optical balance. Orbit's open ellipse is the distinctive workspace glyph. It is static except for directly meaningful user feedback and never doubles as a spinner.

## Semantic icon inventory

This map covers the identity's interface vocabulary. It specifies semantics for reuse; it does not certify that every call site has been audited or redrawn.

| Group | Labels / actions | Drawing direction |
|---|---|---|
| Primary destinations | Chat, Orbit, Code | Open conversation contour; open elliptical path; bracket pair with inset cursor |
| Context destinations | Projects, Library, Customize | Folded folder; aligned document spines; balanced adjustment sliders |
| Agent setup | Create agent, Profile, Appearance | Existing New convention; simple person outline; abstract shape swatch |
| Extensions | Apps, Skills, Routines | Connected framed tiles; folded reusable instruction sheet; clock with repeat path |
| Personal context | Memory, Instructions | Layered recall cards; ruled sheet with inset line |
| Discovery | Search, Filter, Sort | Magnifier; sparse sliders; direction with ordered lines |
| Conversation input | Add, Attach, Mention, Mic, Send, Stop | Plus; paperclip; at sign; microphone; up arrow; square |
| Voice | Voice, Mute, Volume, Dictation | Audio contour; crossed mic; speaker; mic plus insertion cursor |
| Output operations | Copy, Copied, Share, Download, Upload | Overlapping sheets; check; outward link; down tray; up tray |
| Editing | Edit, Rename, Duplicate, Delete, Restore | Pencil; text cursor; paired sheets; bin; returning arrow |
| Workspace operations | Open, Expand, Collapse, Sidebar, Close | Outward arrow; corner expansion; inset corners; split pane; cross |
| Navigation | Back, Forward, Previous, Next, More | Existing arrows/chevrons; stable ellipsis |
| Runtime | Play, Pause, Retry, Refresh, Cancel | Triangle; two strokes; return arrow; paired arcs; cross |
| Work evidence | Plan, Activity, Receipt, Versions | Ordered steps; aligned event lines; folded slip; layered history sheets |
| Approvals | Approve, Ask first, Blocked, Permission | Check; question in open contour; barred entry; lock |
| Research | Research, Sources, Citation, Link | Document plus magnifier; paired pages; quotation; chain |
| Code | Terminal, Branch, Commit, Diff, Review | Terminal prompt; fork; center node with line; plus/minus rows; inspected sheet |
| Agent tools | Computer, Preview, Browser, Files | Monitor; view frame; browser rectangle; folder/document |
| Documents and media | Document, Sheet, Deck, Image, Audio, Video | File outline with meaningful internal detail, simplified at 16 px |
| Organization | Pin, Unpin, Bookmark, Archive | Pin; pin with removal cut; bookmark; storage box |
| Account and settings | Account, Settings, Billing, Help, Sign out | Person; gear; card; question; outward doorway |
| System | Notifications, Language, Accessibility, Theme | Bell; globe; accessibility figure; half-tone circle |
| Truthful status | Success, Warning, Error, Loading | Check; triangle; error contour; real progress drawing only when appropriate |

Third-party icons use their own approved assets. File/application context tokens preserve actual recognizable marks. Do not paint all media and connector marks blue. Semantic drawings map to one shared registry; existing export names can stay stable.

## State and accessibility contract

Default: graphite; hover: tonal surface; press: immediate tonal feedback; selected: meaningful selected state plus readable label; disabled: actual disabled semantics with sufficient clarity. Active task presence is sparse ultramarine. Needs your answer uses attention text. Never invent a status dot, pill or colored avatar badge.

Each icon-only action has a localized accessible action name and visible tooltip where appropriate. Hover is optional, not the only way to discover capability. Focus remains stable and discernible. Reduce Motion and Reduce Transparency are tested independently. State transitions follow runtime events rather than animation completion.

Export future optical SVG masters at 16/20/24 px and native equivalents from the same reviewed geometry. A concept board's icon row illustrates the family, not a completed production glyph catalog.
