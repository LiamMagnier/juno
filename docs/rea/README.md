# REA: how ChatGPT, Codex, Claude and Claude Code work, and what Alevr builds next

Produced on 2026-10-17 with REA (`rea-agents@6.5.0`, https://github.com/morluto/rea) through static analysis of the apps installed on the owner's Mac:

| App | Version |
|---|---|
| ChatGPT | 26.1013.31256 (ships Codex CLI 0.163.0-alpha and `Codex Computer Use.app`) |
| Claude | 2.42304.0 |
| Claude Code | 2.1.299 |
| Codex CLI | 0.162.1 |

No app was launched or driven. No user data, keys or tokens were read, and no protection was bypassed. Nothing is copied from these apps: the designs are original Alevr work that uses the evidence only to understand mechanisms.

Each evidence file separates **observations** (with REA Evidence IDs or read-only file offsets) from **inferences** and **unknowns**.

| Area | Evidence | Alevr design and backlog |
|---|---|---|
| Computer use | [evidence/computer-use.md](evidence/computer-use.md) | [designs/computer-use.md](designs/computer-use.md) ("Baton") |
| Subagents and the coding harness | [evidence/subagents-and-harness.md](evidence/subagents-and-harness.md) | [designs/subagents-and-harness.md](designs/subagents-and-harness.md) |
| Reliability and native integration | [evidence/reliability-and-native.md](evidence/reliability-and-native.md) | [designs/reliability-and-native.md](designs/reliability-and-native.md) ("Tether") |
| Chat UX, design and motion | [evidence/chat-ux-design-motion.md](evidence/chat-ux-design-motion.md) | [designs/chat-ux-design-motion.md](designs/chat-ux-design-motion.md) |

## Who does what best (summary matrix)

| Capability | ChatGPT / Codex | Claude / Claude Code | Alevr today |
|---|---|---|---|
| Computer-use isolation | Separate signed agent app (`com.openai.sky.CUAService`) with its own permissions and updater | Rust helper that posts input to background windows (SkyLight), plus a phantom cursor | In-app floor; cross-process lock; consequential-action floor **enforced in code** (stronger than ChatGPT's prompt-only rules) |
| Screenshots | Accessibility index first, then pixels | `captureExcluding` an allowlist, so only granted apps are visible | Excludes refused apps only (**gap**) |
| Pre-input safety | Lock-screen guardian; stops on disallowed browser URLs | Refuses on Secure Input, typing, occlusion, sheets or lock | Secure fields and stale frames only (**gap**) |
| Emergency stop | Not established | Global Esc held only while a session controls the screen | Esc swallowed so pages can't see it, single-use view links, filmstrip (**ahead**) |
| Subagents | `spawn_agent` / `wait` / `close`, depth limit, Guardian approval reviewer | Background agents, worktree or remote isolation, observer agents, 33 hook events | One level deep, no per-child clock (**gap**) |
| Sandbox | Seatbelt / Landlock, network proxy | Seatbelt / bubblewrap with seccomp, domain allowlist | Docker only on Linux (**gap**) |
| Edits and rewind | `*** Begin Patch` apply-patch | Per-message file-history rewind | Two checkpoint stores, no atomic multi-file edit (**gap**) |
| Updates | Sparkle 2, EdDSA-signed feed per cohort | Squirrel with pulled-release handling, failed-apply counter, idle wait, window restore | Feed plus signature check; no apply ledger, rollback or signed manifest (**gap**) |
| Reconnect | Backoff 1 s to 20 s with jitter; network triggers | Backoff 1 s to 30 s; queue while offline; dedupe; wake on resume | Seq-numbered stream resume and idempotent sends (**ahead**); timer-only reconnect that gives up after 3 min (**gap**) |
| Quick Entry | Prewarmed window; modifier-only hotkeys | Double-tap Option; dictation chord; validated shortcuts | `NSEvent` global monitor: needs Accessibility and leaks ⌥Space (**bug**) |
| Streaming text | Word fade with a 24 ms stagger; follow state machine; reserved spacer | Remote UI (claude.ai); tokens only | Highlight fade without extra markup and truthful phase words (**ahead on web**); no pacing on Mac or iOS (**gap**) |
| Turn controls | Regenerate intents, "I prefer this version", "Answer now" | TurnStatus, queued strip (styles only) | Branching and pager; no queued strip, "Finish now" or pinned turn (**gap**) |

## Combined priority backlog (impact first, then effort)

Platforms: W = web, M = macOS, I = iOS, C = core runtime or cloud.

| # | Item | Area | Impact | Effort | Platforms |
|---|---|---|---|---|---|
| 1 | Quick Entry on `RegisterEventHotKey` (no Accessibility, consumes the key, rebindable, prewarmed) | Reliability | 5 | S | M |
| 2 | Granted-only computer-use frames, plus a "whole display" consent tick | Computer use | 5 | S | M |
| 3 | Lock policy: pause, push to the phone, keep the display awake, never auto-unlock | Computer use | 5 | S | M I |
| 4 | Preflight probes before each input (Secure Input, person typing, lock, occlusion, sheets) | Computer use | 5 | M | M |
| 5 | Hierarchical budget envelopes and a per-child wall clock for subagents | Subagents | 5 | M | C |
| 6 | Tether reconnect: jitter, network, foreground and wake triggers, park instead of giving up | Reliability | 5 | M | W M I |
| 7 | Unclean-exit sentinel, restore banner and safe mode | Reliability | 5 | M | M I |
| 8 | iOS Live Activity, actionable approval push and remote Stop for Code and computer runs | Subagents and computer use | 5 | M | I |
| 9 | Computer-use approval cards on iOS and web (Face ID for high risk) | Computer use | 5 | M | I W M |
| 10 | Web Agents tree with steer, pause, stop and top-up | Subagents | 5 | M | W |
| 11 | Reading-first follow: pin the new turn and let the answer grow into a reserved area (shared TS and Swift rules) | Chat UX | 5 | L | W M I |
| 12 | Finish the motion token pipeline and retire `--spring-pop` | Design | 4 | S | W M I |
| 13 | `edit_files` atomic multi-file patch tool | Harness | 4 | S | C |
| 14 | Updater apply ledger, pulled-release handling, offline skip | Reliability | 4 | S | M |
| 15 | Unattended-run rules (no takeover, deadlines, skip rather than approve) | Computer use | 4 | S | M C |
| 16 | TurnStatus as one persistent element, plus "Finish now" | Chat UX | 4 | M | W M I |
| 17 | Native stream pacer and ink-in fade | Chat UX | 4 | M | M I |
| 18 | Queued-message strip with steer | Chat UX | 4 | M | W M I |
| 19 | Accessibility actions (press, set value) as the main grounding rung | Computer use | 4 | M | M |
| 20 | Hooks in the TS engine with trust review and hash pin; MCP client per agent | Harness | 4 | M | C W |
| 21 | Durable send outbox ("Pending shelf") | Reliability | 4 | M | W M I |
| 22 | Signed Ed25519 update manifest; idle-aware install with restore | Reliability | 4 | M | M |
| 23 | Baton control-state contract and chip, plus the hand-back digest | Computer use | 4 | M | all |
| 24 | Brief context capsule (`inherit: "brief"`) | Subagents | 4 | M | C |
| 25 | Unified checkpoint timeline, per-agent rewind and a merge queue | Harness | 4 | L | C M W |
| 26 | Linux runner sandbox (bwrap with seccomp, then Landlock) and a network-approval proxy | Harness | 4 | L | C |
| 27 | Unified actionable notifications across devices | Reliability | 4 | M | I M W |
| 28 | Opt-in crash and hang diagnostics to Alevr's own endpoint | Reliability | 4 | M | all |
| 29 | Granted-only live view of the Mac on iOS and web | Computer use | 4 | L | I W M |
| 30 | Regenerate intents, "Keep this version", Quick Entry 2, shortcut editor, iOS "Ask Alevr" intent | Chat UX | 3 | M | all |

Each design note has the rest of its backlog (78 items in total) and the acceptance tests (58 in total).

**Suggested first build wave**, the small and high-impact items: 1, 2, 3, 12, 13, 14, 15. These are mostly macOS reliability and computer-use safety, plus the token pipeline and `edit_files`.

## Limits of this analysis

- **Partial coverage.** REA's semantic graph covered only part of each bundle because of result budgets. Many facts are literal strings and modules rather than traced call paths; the evidence files label these.
- **Claude's chat UI is remote.** It loads from claude.ai, so its streaming, branching and artifact behaviour still needs a web-bundle pass.
- **No competitor iOS binaries are on this Mac.** The iOS designs come from the Mac and web evidence plus Alevr's own spec.
- **Unknowns** are listed in each evidence file, for example Codex depth defaults, Claude Code nesting limits and ChatGPT checkpoints.
- **Naming overlap.** ChatGPT ships "orbit-character" assets, which overlaps with the name of Alevr's Orbit feature.
