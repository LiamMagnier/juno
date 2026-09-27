# Premium rework pass — October 2026

One pass across Connectors/MCP, Skills, Voice motion, Agents and Juno Code.
It does not replace `FLAT_UI.md`, `ICONS_AND_MOTION.md`, `PREMIUM_AUDIT.md` or
`AGENTS.md`. Those remain the material, motion, composition and agent laws.
This document is the product pass that sequences the work and states the
few new decisions.

## Design read

Reading this as: product UI rework for design-conscious power users of an AI
workspace, with a Linear/ChatGPT-chrome language (flat plane, hairlines, tonal
state, one accent), leaning toward Juno's existing Flat UI + Icons & Motion
system. Not a landing page. Not dashboards-for-their-own-sake.

**Dials** (from design-taste-frontend, applied to product chrome):
- `DESIGN_VARIANCE: 5` — offset, not chaotic. App shells need predictability.
- `MOTION_INTENSITY: 7` — voice, agents and status carry real motion; chrome stays quiet.
- `VISUAL_DENSITY: 5` — daily-app density; lists are rows, not cards.

**Skill precedence** (conflict rule):
1. `FLAT_UI` + `ICONS_AND_MOTION` + `PREMIUM_AUDIT` (repo laws) win on material, motion vocabulary, and composition.
2. `high-end-visual-design` informs micro-interaction quality and spring feel where it does not fight Flat UI (no double-bezel on in-flow cards; Flat UI forbids decorative depth).
3. `design-taste-frontend` pre-flight applies to any marketing/landing surface only.
4. `swiftui-design-skill` applies to `native/` work only (SF Symbols, 8pt grid, no Inter).

## Gaps found in the codebase

| Area | Gap | Evidence |
|---|---|---|
| Custom MCP | Users cannot add their own remote MCP server (URL + headers). Only native + Composio. | `src/lib/connectors.ts` closed `ConnectorId` union; `src/app/api/connectors/route.ts` lists only registry + Composio |
| Connectors UX | Directory is strong, but no "Add MCP" entry, no test-connection, no enable-per-chat with motion feedback | `connector-directory.tsx` |
| Skills UX | Library exists (`skills-library-page`, import, sources, editor). Needs: user-authored skill create, progressive-disclosure cost meter, install origin badge | `src/components/skills/*`, `docs/skills-audit.md` |
| Voice motion | `levelRef` + `VoiceBeam` already drive amplitude. Gap: AI speech has no source level (uses last mic), so Juno's talk is not voice-shaped; phase transitions need springier tone handoff | `use-realtime-voice.ts` L207–386, `voice-composer-glow.tsx` |
| Agents hire | Form wizard (4 steps). User wants Muse-style *talk to configure* | `agent-hire.tsx` |
| Juno Code thinking | Chat already collapses reasoning (`ActivityTimeline` + `ThoughtProcessPanel`). Gap: Code run cards can dump tool summaries as body prose; no Claude-style one-line "doing now" + collapsed thinking | `code-run-cards.tsx`, `activity-timeline.tsx` |
| Juno Code writes | `runner/agent-core` `writeFileTool` *does* write the workspace. Gap: prompt/UI still invites fenced code in chat instead of file writes; needs run prompt + UI that treats `file_change` as the product | `tools/fs.ts`, `code-run-cards.tsx` file_change |
| Product gaps | group agent rooms, teach-by-showing, secret card, payment cards, WhatsApp/iMessage | user brief + `AGENTS.md` §8 |

## Workstreams

### W1 — Custom MCP + connectors (T3)
- `UserMcpServer` model (or `Connection.kind = "user_mcp"`): URL, label, headers (encrypted), enabled.
- API: `GET/POST/DELETE /api/mcp/servers`, `POST /api/mcp/servers/[id]/test`.
- UI: "Add MCP server" in Connections — dialog with URL, name, optional bearer header; test → list tools; enable toggle with the same save-ledger motion as settings.
- Wire into `getActiveConnectors` so user MCP appears in connector pickers (chat, agents).
- Motion: dialog enter on drawer curve; test-connection uses live status orb, not a spinner.

### W2 — Skills (T4)
- "New skill" authoring from the library (name, description, body) matching agentskills.io frontmatter.
- Origin badge (personal / project / synced / marketplace) with the security rules from `docs/skills-audit.md` (synced skills cannot shell-substitute).
- Invocation strip: when a skill fires, one quiet row in the run ("Used skill: pdf-processing") so progressive disclosure is visible.

### W3 — Voice motion (T5)
- Drive the beam from **whoever is talking**: mic RMS while user-speaking; playback AnalyserNode while assistant-speaking (not a freeze of the last mic frame).
- Tone handoff: warm → thinking beam → cool on a single spring; muted holds still grey.
- Agent faces already listen (`listening` pupils scale with level) — keep that contract.

### W4 — Agents hire = conversation (T6)
- Replace the 4-step form as the *primary* path with a hire chat: say what you want, the model proposes name/face/role/brief/autonomy/connectors as structured cards you accept or amend in chat.
- Keep the form as "Edit details" behind a disclosure (power users).
- Face arrival on hire uses the `done` spring settle from `AGENTS.md` §4.2.

### W5 — Juno Code (T7)
- Transcript contract (Claude Code / Codex):
  1. Collapsed thinking (summary line only; full trace in ThoughtProcessPanel).
  2. Live activity = one line ("Editing `src/app/page.tsx`"), not a paragraph dump.
  3. File writes are `file_change` cards with diff; chat body never contains the full file as a fence when a write occurred.
- Run prompt: instruct the model to call `write_file`/`edit_file` for project work; fenced blocks only for short snippets that are not written.
- CLI/runner: keep workspace tools; surface "Wrote N files" as the run receipt.

### W6 — Product roadmap (T8)
Document only this pass (build later):
- Agent group rooms (claim model required — see AGENTS.md §8).
- Teach by showing (watch-me → skill draft) behind explicit consent.
- Secret card / password vault (Sentinel-style use-without-seeing).
- One-time payment cards.
- WhatsApp / iMessage bridges.

## Signature moments

1. **Voice beam is the speaker** — the composer edge *is* the waveform of whoever holds the floor.
2. **Agent face is the status bar** — hire arrives with a spring settle; waiting is the only state that loops for attention.
3. **Code run is a receipt** — one live line, then a collapsed "Thought process · 4s" strip and file diffs. The answer stays the hero.

## Pre-flight (product chrome subset)

- [ ] Flat UI: no in-flow shadows, tonal state, one accent
- [ ] Motion motivated (feedback / state / hierarchy only)
- [ ] Reduced motion honored everywhere intensity > 3
- [ ] Icons from `@/components/ui/icons` only
- [ ] Em-dash ban on any user-facing string
- [ ] Empty / loading / error states on every new surface
- [ ] Mobile collapse for every multi-column addition
