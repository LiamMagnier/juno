import AppKit
import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// The Code column beside the Chat column, drawn offscreen at 2× in both
/// appearances: the review set for the Code sidebar's Chat-recipe pass.
///
/// Off by default: set `JUNO_SIDEBAR_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_SIDEBAR_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/mac-sidebar-<name>-<light|dark>.png`.
///
/// Sample data only: the Chat column runs on the harness's `.showcase` world
/// and the Code column on `CodeShowcase`'s sample storefront.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SIDEBAR_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SIDEBAR_SNAPSHOT_DIR to render the sidebars."
    ),
    .serialized
)
struct CodeSidebarSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SIDEBAR_SNAPSHOT_DIR"]!)
    }

    nonisolated static let names = ["chat", "code-empty", "code-sessions", "compare"]

    static let paneSize = CGSize(width: 260, height: 820)

    @Test(arguments: names)
    func drawsTheColumn(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.showcase()
        for isDark in [false, true] {
            let view: AnyView
            var size = Self.paneSize
            switch name {
            case "chat":
                view = AnyView(SidebarPane { PremiumShots.chatSidebar(world: world, selection: .conversation("conv-1")) })
            case "code-empty":
                view = AnyView(SidebarPane { Self.codeEmpty(world: world) })
            case "code-sessions":
                view = AnyView(SidebarPane { Self.codeSessions(world: world) })
            case "compare":
                size = CGSize(width: Self.paneSize.width * 3 + 48, height: Self.paneSize.height + 24)
                view = AnyView(
                    HStack(spacing: 12) {
                        SidebarPane { PremiumShots.chatSidebar(world: world, selection: .conversation("conv-1")) }
                        SidebarPane { Self.codeSessions(world: world) }
                        SidebarPane { Self.codeEmpty(world: world) }
                    }
                    .padding(12)
                    .background(Color.junoCanvas)
                )
            default:
                Issue.record("Unknown shot \(name)")
                return
            }
            let url = try await PremiumRenderer.render(
                view.environment(\.locale, Locale(identifier: "en_US")),
                size: size,
                framed: false,
                isDark: isDark,
                into: directory.appendingPathComponent("mac-sidebar-\(name)-\(isDark ? "dark" : "light").png")
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    static func codeSessions(world: SnapshotPreviewWorld) -> some View {
        codeSidebar(world: world, workbench: CodeShowcase.sidebarWorkbench(), selection: .session(CodeShowcase.sessionID), showsSettled: true)
    }

    static func codeEmpty(world: SnapshotPreviewWorld) -> some View {
        codeSidebar(world: world, workbench: CodeShowcase.emptyWorkbench(), selection: nil, showsSettled: false)
    }

    static func codeSidebar(
        world: SnapshotPreviewWorld,
        workbench: WorkbenchModel,
        selection: DesktopCodeSidebarItem?,
        showsSettled: Bool
    ) -> some View {
        let sender = world.world.chatTransport
        return DesktopCodeSidebar(
            workbench: workbench,
            code: NativeCodeModel(client: NativeCodeTaskClient(sender: sender, streamer: sender)),
            remote: CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: sender)),
            selection: .constant(selection),
            remoteDeviceID: .constant(""),
            product: .constant(.code),
            isBootstrapping: false,
            configuration: world.configuration,
            session: world.world.session,
            openRepository: {},
            newSession: { _ in },
            rename: { _ in },
            openSettings: {},
            now: CodeShowcase.now,
            startsShowingSettled: showsSettled
        )
    }
}

/// The floating sidebar pane as `PremiumWindow` composes it: the traffic
/// lights' band, then the column, on the recessed tone the glass reads as.
private struct SidebarPane<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach([Color(red: 1, green: 0.373, blue: 0.341), Color(red: 0.996, green: 0.737, blue: 0.180), Color(red: 0.157, green: 0.784, blue: 0.251)], id: \.self) { color in
                    Circle()
                        .fill(color)
                        .overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5))
                        .frame(width: 12, height: 12)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 14)
            .frame(height: PremiumFrame.toolbarHeight - PremiumFrame.paneInset)
            content()
                .scrollContentBackground(.hidden)
        }
        .frame(width: CodeSidebarSnapshotTests.paneSize.width, height: CodeSidebarSnapshotTests.paneSize.height)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.junoSidebar)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// The Code column's list of work: the order and the Settled rule (the web's
/// `workList`), and what the list says when it is empty.
@MainActor
@Suite
struct DesktopCodeWorkListTests {
    private static let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private static func run(_ id: String, _ status: CodeRunStatus, hoursAgo: Double) -> DesktopCodeRun {
        DesktopCodeRun(
            item: .task(id),
            title: id,
            workspace: "storefront",
            workspaceID: nil,
            branch: nil,
            environment: .local,
            status: status,
            updatedAt: now.addingTimeInterval(-hoursAgo * 3_600)
        )
    }

    @Test
    func needsYouThenWorkingThenRecencyAndOldFinishedWorkSettles() {
        let runs = [
            Self.run("done-recent", CodeRunStatus(SessionStatus.completed), hoursAgo: 1),
            Self.run("working", CodeRunStatus(SessionStatus.running), hoursAgo: 5),
            Self.run("needs-you", CodeRunStatus(SessionStatus.waitingForApproval), hoursAgo: 30),
            Self.run("done-old", CodeRunStatus(SessionStatus.completed), hoursAgo: 24 * 5),
            Self.run("working-old", CodeRunStatus(SessionStatus.running), hoursAgo: 24 * 9),
            Self.run("done-older", CodeRunStatus(SessionStatus.completed), hoursAgo: 24 * 12),
        ]
        let split = DesktopCodeWorkList.split(runs, now: Self.now)
        #expect(split.active.map(\.title) == ["needs-you", "working", "working-old", "done-recent"])
        #expect(split.settled.map(\.title) == ["done-old", "done-older"])
    }

    @Test
    func emptyLinesSayWhatIsMissingAndWhereToStart() {
        #expect(DesktopCodeWorkList.emptyLines(searching: false, project: nil, hasProjects: true) == JunoShellCodeSidebar.emptyLines)
        #expect(DesktopCodeWorkList.emptyLines(searching: false, project: nil, hasProjects: false).last == "Open a project to start one.")
        #expect(DesktopCodeWorkList.emptyLines(searching: false, project: "storefront", hasProjects: true).first == "No sessions in storefront yet.")
        #expect(DesktopCodeWorkList.emptyLines(searching: true, project: "storefront", hasProjects: true).first == "No matches.")
    }
}
