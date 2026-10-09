import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl

/// Every Code v2 surface on fixture data, by name — the Mac's equivalent of
/// the web's `/dev/code-v2` gallery. The package's snapshot tests and the
/// app's (which has the icon and provider-mark assets) both render from
/// here, so the two sets of pictures cannot drift.
@MainActor
public enum CodeV2Gallery {
    public enum Surface: String, CaseIterable, Sendable {
        case workspaceWorking = "workspace-working"
        case workspaceMultiAgent = "workspace-multi-agent"
        case workspaceComputerUse = "workspace-computer-use"
        case dockBestOfN = "dock-best-of-n"
        case sessionLimited = "session-limited"
        case modelPickerSubscription = "model-picker-subscription"
        case modelPickerAlevr = "model-picker-alevr"
        case contextTiersAlevr = "context-tiers-alevr"
        case contextTiersSubscription = "context-tiers-subscription"
        case orchestrateLeadWorkers = "orchestrate-lead-workers"
        case orchestrateBestOfN = "orchestrate-best-of-n"
        case contextCard = "context-card"
        case settingsConnections = "settings-connections"
        case dockTerminal = "dock-terminal"
        case computerOverlay = "computer-overlay"
        case connectedApproval = "connected-approval"

        public var size: CGSize {
            switch self {
            case .workspaceWorking, .workspaceMultiAgent: CGSize(width: 1280, height: 860)
            case .workspaceComputerUse: CGSize(width: 1280, height: 760)
            case .dockBestOfN: CGSize(width: 680, height: 420)
            case .sessionLimited: CGSize(width: 820, height: 560)
            case .modelPickerSubscription, .modelPickerAlevr: CGSize(width: 700, height: 600)
            case .contextTiersAlevr: CGSize(width: 520, height: 520)
            case .contextTiersSubscription: CGSize(width: 520, height: 360)
            case .orchestrateLeadWorkers: CGSize(width: 680, height: 620)
            case .orchestrateBestOfN: CGSize(width: 680, height: 560)
            case .contextCard: CGSize(width: 340, height: 220)
            case .settingsConnections: CGSize(width: 760, height: 1180)
            case .dockTerminal: CGSize(width: 520, height: 420)
            case .computerOverlay: CGSize(width: 960, height: 600)
            case .connectedApproval: CGSize(width: 820, height: 360)
            }
        }
    }

    public static func view(_ surface: Surface) -> AnyView {
        let directory = CodeV2Fixtures.directory
        func composer(_ selection: CodeV2.ModelSelection, roles: CodeV2RoleDraft? = nil) -> CodeV2ComposerModel {
            CodeV2ComposerModel(selection: selection, runtimeMode: .autoEdit, roles: roles)
        }
        switch surface {
        case .workspaceWorking:
            let session = CodeV2EnvSession(preview: CodeV2Fixtures.workingSnapshot)
            session.setPreviewDiff(thread: CodeV2Fixtures.diffFiles)
            let dock = CodeV2DockController()
            dock.show(.changes)
            if let hunk = CodeV2Fixtures.diffFiles.dropFirst().first?.hunks.first { dock.decisions.set(.accepted, for: hunk) }
            return window(
                CodeV2EnvSessionView(session: session, composer: composer(CodeV2Fixtures.claudeSelection, roles: CodeV2Fixtures.leadWorkers), directory: directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        case .workspaceMultiAgent:
            let session = CodeV2EnvSession(preview: CodeV2Fixtures.multiAgentSnapshot)
            let dock = CodeV2DockController()
            dock.selectAgent("w2")
            return window(
                CodeV2EnvSessionView(session: session, composer: composer(CodeV2Fixtures.claudeSelection, roles: CodeV2Fixtures.leadWorkers), directory: directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        case .workspaceComputerUse:
            let session = CodeV2EnvSession(preview: CodeV2Fixtures.computerSnapshot)
            let dock = CodeV2DockController()
            dock.show(.screen)
            return window(
                CodeV2EnvSessionView(session: session, composer: composer(CodeV2Fixtures.claudeSelection), directory: directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        case .dockBestOfN:
            var snapshot = CodeV2Fixtures.workingSnapshot
            var draft = CodeV2Fixtures.leadWorkers
            draft.preset = .bestOfN
            snapshot.routing = draft.routing
            let dock = CodeV2DockController()
            dock.show(.agents)
            return AnyView(CodeV2EnvDockView(session: CodeV2EnvSession(preview: snapshot), dock: dock, bestOfN: CodeV2Fixtures.bestOfNCandidates))
        case .sessionLimited:
            return AnyView(CodeV2EnvSessionView(
                session: CodeV2EnvSession(preview: CodeV2Fixtures.limitedSnapshot),
                composer: composer(CodeV2Fixtures.claudeSelection), directory: directory
            ))
        case .modelPickerSubscription, .modelPickerAlevr:
            let selection = surface == .modelPickerAlevr ? CodeV2Fixtures.alevrSelection : CodeV2Fixtures.claudeSelection
            return popover(CodeV2ModelPicker(directory: directory, selection: .constant(selection), threadTokens: 184_000, openConnections: {}))
        case .contextTiersAlevr:
            return popover(CodeV2TierSelector(
                instance: CodeV2Fixtures.alevr, model: CodeV2Fixtures.gpt,
                selection: .constant(CodeV2Fixtures.alevrSelection), lean: .constant(false), threadTokens: 184_000
            ))
        case .contextTiersSubscription:
            return popover(CodeV2TierSelector(
                instance: CodeV2Fixtures.claude, model: CodeV2Fixtures.claude.models![0],
                selection: .constant(CodeV2Fixtures.claudeSelection), lean: .constant(false), threadTokens: 184_000
            ))
        case .orchestrateLeadWorkers:
            return popover(CodeV2OrchestratePicker(directory: directory, draft: .constant(CodeV2Fixtures.leadWorkers)))
        case .orchestrateBestOfN:
            var best = CodeV2Fixtures.leadWorkers
            best.preset = .bestOfN
            best.candidates = [CodeV2Fixtures.claudeSelection, CodeV2Fixtures.codexSelection, CodeV2Fixtures.alevrSelection]
            return popover(CodeV2OrchestratePicker(directory: directory, draft: .constant(best)))
        case .contextCard:
            return popover(CodeV2ContextCard(reading: CodeV2ContextReading(usedTokens: 184_000, maxTokens: 272_000, costUsd: 1.84), compact: {}))
        case .settingsConnections:
            let hub = EnvServerHub(previewInstances: [
                CodeV2Fixtures.claude, CodeV2Fixtures.codex, CodeV2Fixtures.gemini,
                CodeV2Fixtures.grok, CodeV2Fixtures.deepseekHarness, CodeV2Fixtures.opencode,
                CodeV2Fixtures.antigravity,
            ])
            // Antigravity mid sign-in: the browser is open, the paste fallback below.
            hub.apply(EnvRuntimeSetup.Update(
                instanceId: CodeV2Fixtures.antigravity.id,
                auth: EnvRuntimeSetup.AuthState(
                    phase: .waiting, flowId: "flow-1",
                    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", method: "Google account"
                )
            ))
            let keys = CodeV2KeysModel(preview: [
                ByokKeyRecord(provider: .anthropic, hint: "sk-ant-…4f2a", addedAt: CodeV2Fixtures.origin.addingTimeInterval(-86_400 * 9),
                              lastUsedAt: nil, isValid: true, location: .account),
            ])
            return AnyView(CodeV2ConnectionsView(hub: hub, keys: keys, alevrPlanLine: "Plus plan. $12.40 of $40 used this month."))
        case .dockTerminal:
            let session = CodeV2EnvSession(preview: CodeV2Fixtures.workingSnapshot)
            let dock = CodeV2DockController()
            dock.show(.terminal)
            return AnyView(CodeV2EnvDockView(
                session: session, dock: dock,
                previewTerminal: CodeV2EnvTerminal(preview: session.cwd, output: terminalOutput)
            ))
        case .computerOverlay:
            return overlay(screen: surface.size)
        case .connectedApproval:
            let approvals = CodeV2ConnectedApprovals()
            let request = StudioComputerBridgeApprover.request(
                sessionID: "preview", summary: "Use apps on this Mac",
                justification: "For ‘Fix the flaky upload test’. Alevr shows every step on screen, asks before anything it can't undo, and Esc stops it.",
                options: [.acceptForSession, .decline]
            )
            approvals.preview(CodeV2ConnectedApprovals.Pending(id: UUID(), sessionID: nil, request: request, crop: nil))
            return AnyView(ZStack(alignment: .top) {
                Studio.Surface.canvas
                CodeV2ConnectedApprovalCard(approvals: approvals)
            })
        }
    }

    /// Dock › Terminal with a finished `npm test` run (colours stripped).
    static let terminalOutput = "\u{1B}[1m$ \u{1B}[0mnpm test\r\n\r\n> alevr@1.0.0 test\r\n> vitest run\r\n\r\n"
        + " \u{1B}[32m✓\u{1B}[39m tests/code-v2-env-link.test.ts \u{1B}[2m(24 tests)\u{1B}[22m 812ms\r\n"
        + " \u{1B}[32m✓\u{1B}[39m tests/code-v2-routing.test.ts \u{1B}[2m(18 tests)\u{1B}[22m 140ms\r\n\r\n"
        + " Test Files  \u{1B}[32m2 passed\u{1B}[39m (2)\r\n      Tests  \u{1B}[32m42 passed\u{1B}[39m (42)\r\n"
        + "Progress 10%\rProgress 100%\r\n$ "

    /// The computer-use overlay as its panel draws it over the screen.
    static func overlay(screen: CGSize) -> AnyView {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), linger: .seconds(3_600), mainDisplayHeight: { screen.height })
        model.apply(ComputerActionCue(
            sessionID: "preview", label: "Click the “Save” button in TextEdit",
            point: ScreenPoint(x: 540, y: 250), appName: "TextEdit", phase: .acting
        ))
        return AnyView(ZStack(alignment: .topLeading) {
            // A stand-in for whatever app is on screen under the panel.
            LinearGradient(colors: [Color(white: 0.93), Color(white: 0.86)], startPoint: .top, endPoint: .bottom)
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white)
                .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
                .frame(width: 520, height: 340)
                .offset(x: 220, y: 90)
            ComputerActionOverlayView(model: model, screenFrame: CGRect(origin: .zero, size: screen))
        })
    }

    private static func window<Center: View, Dock: View>(_ center: Center, dock: Dock) -> AnyView {
        AnyView(HStack(spacing: 0) {
            center
            Rectangle().fill(Studio.Surface.hairline).frame(width: 1)
            dock.frame(width: 460)
        }
        .background(Studio.Surface.canvas))
    }

    /// A popover's content as the system draws it: the popover ground, the
    /// menu radius, a hairline and the pop shadow, on the page.
    private static func popover<Content: View>(_ content: Content) -> AnyView {
        AnyView(ZStack {
            Studio.Surface.canvas
            content
                .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).strokeBorder(Studio.Surface.hairline))
                .shadow(color: .black.opacity(0.16), radius: 20, y: 10)
        })
    }
}
