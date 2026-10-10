import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The Team orchestrator's surfaces for offscreen snapshots (team lane): the
/// composer's chip at rest and with a team, the role editor open, and a
/// Plan → Build → Verify run in the thread with the agent tree.
public enum CodeV2TeamGallery {
    public enum Surface: String, CaseIterable, Sendable {
        case chipSolo = "team-chip-solo"
        case chipTeam = "team-chip-team"
        case editor = "team-editor"
        case editorBestOfN = "team-editor-best-of-n"
        case windowEditor = "team-window-editor"
        case windowRunning = "team-window-running"

        public var size: CGSize {
            switch self {
            case .chipSolo, .chipTeam: CGSize(width: 760, height: 150)
            case .editor: CGSize(width: 540, height: 400)
            case .editorBestOfN: CGSize(width: 540, height: 330)
            case .windowEditor, .windowRunning: CGSize(width: 1280, height: 800)
            }
        }
    }

    /// Opus plans (your Claude plan), two Sonnet builders, GPT verifies (Codex).
    public static var team: CodeV2RoleDraft {
        var draft = CodeV2RoleDraft(lead: CodeV2Fixtures.claudeSelection)
        draft.applyTeamPreset(.planBuildVerify)
        draft.setSelection(CodeV2Fixtures.claudeSelection, for: .architect)
        draft.setSelection(
            CodeV2.ModelSelection(instanceId: CodeV2Fixtures.claude.id, model: "claude-sonnet-5-5", effort: .medium),
            for: .builder
        )
        draft.setSelection(CodeV2Fixtures.codexSelection, for: .verifier)
        draft.budgetUsd = 4
        return draft
    }

    /// A Plan → Build → Verify run mid-build: the plan is in, one builder is
    /// done, the other is working, the verifier has not started.
    public static var runningSnapshot: CodeV2.SessionSnapshot {
        let at = CodeV2Fixtures.at
        let routing = team.routing
        let sonnet = routing.workers![0]
        return CodeV2.SessionSnapshot(
            id: "env-team", cwd: "/Users/maya/code/storefront", title: "Move checkout totals to the server",
            selection: CodeV2Fixtures.claudeSelection,
            routing: routing,
            runtimeMode: .autoEdit, state: .running, activeTurnId: "t1",
            items: [
                .userMessage(.init(id: "u1", turnId: "t1", createdAt: at(0), text: "Move checkout totals to the server and cover them with tests.")),
                .subagent(.init(id: "sa1", turnId: "t1", createdAt: at(2), agentId: "a1", role: .architect, model: routing.architect!, status: .completed,
                                task: "Plan", closingText: "Two parts: a server route for the total, then the client reads it. Tests with each.",
                                title: "Plan", label: "Architect", phase: .plan)),
                .assistantMessage(.init(id: "a1-done", turnId: "t1", createdAt: at(58), text: "Two parts: a server route for the total, then the client reads it.", agentId: "a1")),
                .subagent(.init(id: "sa2", turnId: "t1", createdAt: at(60), agentId: "b1", role: .worker, model: sonnet, status: .completed,
                                task: "Server route for the total", closingText: "Added /api/cart/total with tax before coupon. 9 tests pass.",
                                title: "Server route for the total", label: "Builder 1", phase: .build)),
                .assistantMessage(.init(id: "b1-done", turnId: "t1", createdAt: at(190), text: "Added /api/cart/total with tax before coupon. 9 tests pass.", agentId: "b1")),
                .subagent(.init(id: "sa3", turnId: "t1", createdAt: at(61), agentId: "b2", role: .worker, model: sonnet, status: .running,
                                task: "Client reads the server total", title: "Client reads the server total", label: "Builder 2", phase: .build)),
                .assistantMessage(.init(id: "b2-live", turnId: "t1", createdAt: at(380), text: "Editing src/cart/useCartTotal.ts", streaming: true, agentId: "b2")),
            ],
            usage: CodeV2.SessionUsage(inputTokens: 182_000, outputTokens: 21_000, contextTokens: 48_000, contextWindow: 1_000_000, costUsd: 0.41)
        )
    }

    @MainActor
    public static func view(_ surface: Surface) -> AnyView {
        let directory = CodeV2Fixtures.directory
        let place = CodeV2SessionPlace(project: "storefront", branch: "alevr/server-totals", machine: "This Mac",
                                       projectMenu: [("storefront", {})], branchMenu: [("main", {})], machineMenu: [("This Mac", {})])
        func composer(_ roles: CodeV2RoleDraft?) -> CodeV2ComposerModel {
            CodeV2ComposerModel(selection: CodeV2Fixtures.claudeSelection, runtimeMode: .autoEdit, roles: roles)
        }
        func footer(_ model: CodeV2ComposerModel) -> some View {
            HStack(spacing: JunoSpace.tight) {
                CodeV2ComposerLeading(model: model, directory: directory)
                Spacer(minLength: 0)
            }
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Studio.Surface.canvas)
        }
        switch surface {
        case .chipSolo:
            return AnyView(footer(composer(nil)))
        case .chipTeam:
            return AnyView(footer(composer(team)))
        case .editor:
            return popover(CodeV2TeamEditor(directory: directory, draft: .constant(team), lead: CodeV2Fixtures.claudeSelection))
        case .editorBestOfN:
            var best = team
            best.applyTeamPreset(.bestOfN)
            best.candidates = [CodeV2Fixtures.claudeSelection, CodeV2Fixtures.codexSelection, CodeV2Fixtures.alevrSelection]
            return popover(CodeV2TeamEditor(directory: directory, draft: .constant(best), lead: CodeV2Fixtures.claudeSelection))
        case .windowEditor:
            return AnyView(CodeV2WindowPreview(title: "Move checkout totals to the server", subtitle: "storefront", selected: "s1", inspectorOpen: false) {
                CodeV2EnvSessionView(session: CodeV2EnvSession(preview: CodeV2Fixtures.newSnapshot), composer: composer(team),
                                     directory: directory, openConnections: {}, place: place)
                    .overlay(alignment: .bottom) {
                        floating(CodeV2TeamEditor(directory: directory, draft: .constant(team), lead: CodeV2Fixtures.claudeSelection))
                            .offset(x: -40, y: -128)
                    }
            } inspector: { EmptyView() })
        case .windowRunning:
            let session = CodeV2EnvSession(preview: runningSnapshot)
            let dock = CodeV2DockController()
            dock.show(.agents)
            return AnyView(CodeV2WindowPreview(title: "Move checkout totals to the server", subtitle: "storefront", selected: "s1", inspectorOpen: true) {
                CodeV2EnvSessionView(session: session, composer: composer(team), directory: directory, dock: dock, place: place)
            } inspector: {
                CodeV2EnvDockView(session: session, dock: dock, close: {})
            })
        }
    }

    private static func floating<Content: View>(_ content: Content) -> some View {
        content
            .background(Studio.Surface.popover)
            .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
            .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
            .shadow(color: .black.opacity(0.18), radius: 28, y: 14)
    }

    private static func popover<Content: View>(_ content: Content) -> AnyView {
        AnyView(ZStack {
            Studio.Surface.canvas
            floating(content)
        })
    }
}
