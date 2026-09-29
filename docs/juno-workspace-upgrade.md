# Juno workspace refinement

September 29, 2026. This handoff covers the scoped Web and macOS changes to Agents, account connections, skill import, voice response, and Code execution. The confirmed direction is quiet and premium within Juno’s existing system. The existing harness was improved in place; no vendor harness was substituted.

## Implemented behavior

**Agents begin in chat.** The default new-agent route presents large starting-point rows. Selecting one creates a teammate and opens its persistent conversation, with a fallback to its agent page when no conversation ID is returned. Busy state prevents duplicate creation; failures remain visible. Starters supply identity and style, with empty instructions and no connected apps or example first goal. The onboarding prompt saves a clear brief and begins work; it asks only when missing information blocks useful work. Goals, routines, and app access follow the person’s actual intent. The legacy web form remains available through its explicit query option.

Maintainer entry points: `src/components/agents/agent-job-board.tsx`, `src/app/(app)/agents/new/page.tsx`, `src/lib/agents/starter.ts`, `src/lib/agents/prompt.ts`; native `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentsScreen.swift`, `NativeAgentModels.swift`, and `native/macOS/JunoDesktop/App/DesktopAgentRoutes.swift`.

**Connections manage account remote MCP servers.** Web and Mac provide name, public HTTPS URL, optional write-only authorization header, connection testing, and saved-server management. Tests use the current unsaved endpoint and credential without saving the draft definition. An omitted credential retains the stored secret; explicit `null` removes it. Editing the connection invalidates its previous probe result. Native custom servers use `/api/mcp/servers` routes for testing and mutations rather than the OAuth connector flow. Account remote MCP and Juno Code’s local project MCP settings remain separate scopes.

Entry points: `src/components/connections/add-mcp-server-dialog.tsx`, `src/lib/mcp-server-input.ts`, `src/app/api/mcp/servers/`, `src/app/api/connectors/route.ts`; `native/macOS/JunoDesktop/App/DesktopConnectionsScreen.swift` and `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeConnectorStore.swift`.

**SKILL.md imports are editable previews.** Local file import fills the existing name, description, and instructions fields for review before saving. Web uses the existing bounded parser; native previews through the authenticated file-import endpoint. Unsupported host settings are reported, requested tools remain requests, and imported origin remains untrusted. Saving uses the normal scanned and versioned skill path. References in SKILL.md do not import their files: attach those separately.

Entry points: `src/app/(app)/skills/new/page.tsx`, `src/app/api/skills/import/file/route.ts`, `src/lib/skills/skill-md.ts`; `native/macOS/JunoDesktop/App/DesktopSkillPage.swift` and `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Skills/NativeSkillsClient.swift`.

**Voice responds to audible samples.** Microphone and playback levels follow the actual audio graph, with fast attack and slower release so syllables register and pauses decay. Incoming network audio is not used as a substitute for audible playback. Shipping Chat retains the composer-edge glow: warm caller light, cool Juno light, a gathered beam while thinking, and restrained muted/paused states. Both glow implementations use a 0.06-second attack, 0.18-second release, and 0.06 idle level. Chat has no added call bar, meter, or visible status line; phase announcements remain accessible. Reduced Motion keeps the native light still while allowing level-driven brightness.

Web call controls use a restrained frosted backing following the requested blur/glass treatment: 12px backdrop blur, translucent card color, and a faint inset edge, with an opaque fallback. Foreground icons stay readable at maximum speech intensity; conservative contrast bounds are 9.83:1 in light appearance and 6.8:1 in dark. The muted state and coral End action keep their existing treatments. The development gallery uses the real composer; `?only=call&peak=1` holds speech intensity at its maximum for inspection.

Entry points: `src/hooks/use-realtime-voice.ts`, `src/components/voice/voice-composer-glow.tsx`, `src/components/voice/realtime-voice.tsx`; `native/Packages/JunoNativeKit/Sources/JunoVoiceKit/JunoRealtimeVoiceController.swift` and `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoVoiceGlow.swift`.

**Code separates thinking and executes real work.** Provider reasoning and leading `<think>`, `<thinking>`, or `<analysis>` envelopes stream through a separate collapsed thinking channel. Split tags are handled across stream boundaries; tags later in answers or code examples remain literal. Progress updates remain answer text. Valid tool calls execute even when a compatible provider labels completion as end-of-turn, subject to the existing permissions, approvals, checkpoints, and cancellation rules. Workspace instructions require real edits in the selected folder. CLI `exec`/`stop` aliases and permission options use the existing host protocol; invalid, duplicate, empty, or unknown arguments fail before submission.

Entry points: `runner/agent-core/src/loop.ts`, `runner/agent-core/src/providers/leading-thinking.ts`, `scripts/cloud-code-runner.mjs`, `src/hooks/use-code-session.ts`; `native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift`, `LeadingThinkingFilter.swift`, `native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkspaceContext.swift`, `Studio/StudioThreadView.swift`, and `native/Packages/JunoCode/Sources/JunoCodeCore/JunoCodeCommandLine.swift`.

## Incumbent design and motion

Continue to use the semantic warm-paper/warm-charcoal colors, typography, control shapes, and motion tokens in `src/app/globals.css` and `tailwind.config.ts`. The agent rows use the existing body/UI ladder, subtle dividers, hover tint, visible keyboard focus, and container-aware composition. Native additions use `JunoType`, `JunoSpace`, semantic inks, and existing page/sheet controls from `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoTypography.swift`, `JunoSurfaces.swift`, and `JunoDesignTokens.swift`. Voice tuning belongs to the existing glow and palette. This refinement introduces no new brand system or raster imagery; global design documentation and token sources were preserved.

## Verification and review

The initial scoped finish review disposition was **ship** for the reviewed Web/macOS changes. After the user identified the stale standalone Voice preview, a fresh Voice review found one Web control-visibility issue. The glass backing resolved that finding, verified in four desktop/narrow light/dark peak captures; the verdict disposition is **ship at that repair scope**. This is not an audit of every pre-existing product feature.

- TypeScript agent harness: 176 tests passed; additional final reasoning/agent regression selection: 11 passed. Scripted streams include an actual temporary-file write in the selected workspace, end-turn tool calls, reasoning separation, approvals, checkpoints, and rollback.
- Selected root tests: 103 passed, including starter and MCP input regressions.
- Native `AgentOrchestratorTests`: 27 passed; `JunoCodeCommandLineTests`: 8 passed. `NativeSkillsClientTests` passed. `NativeCustomMCPTests`: 2 passed, checking metadata and credential/mutation route semantics.
- macOS Xcode build and selected snapshot suites passed, including `StageBPageSnapshotTests` in both appearances. `PremiumVoiceSnapshotTests` passed eight composer fixtures and the phase contract; `JunoVoiceGlowResponseTests` passed two speech-response and Reduced Motion tests. Web desktop and narrow galleries render the real components; native images come from offscreen Xcode fixtures.
- Typecheck and lint passed. Code wiring checks passed. Native motion check reported zero violations and no newly introduced violations.

Local review images are under `.impeccable/review/`, intentionally ignored by Git. Session logs are under `/tmp/juno-upgrade-*.log`; they are local evidence, not durable repository artifacts. Regression sources include `tests/workspace-upgrade.test.ts`, `runner/agent-core/src/test/leading-thinking.test.ts`, native runtime/CLI tests, `NativeSkillsClientTests.swift`, and `NativeCustomMCPTests.swift`.

## Remaining evidence limits

The local database was offline, so authenticated production-route flows were not exercised end to end. No live paid provider, remote MCP server, or microphone-permission check was initiated. Scripted transport tests and fixture screenshots verify their bounded behaviors, not live provider, account, network, or microphone integration. A connected environment should exercise those paths before treating this handoff as live integration evidence.
