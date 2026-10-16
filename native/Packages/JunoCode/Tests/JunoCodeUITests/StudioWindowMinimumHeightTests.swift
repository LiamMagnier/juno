import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl
@testable import JunoCodeUI

/// The blank Code window of 1.11.0: a screen-control approval under the
/// composer ("Let Alevr use Safari (full control) for this session") reported
/// a minimum height of about 3,900 points when AppKit measured the window's
/// minimum size with a zero width, the split view grew to fit it, and the
/// sidebar and the thread were drawn centred far outside the window. Only the
/// toolbar stayed; switching to Chat and back re-mounted the view after the
/// card had been declined, which is why that seemed to fix it.
///
/// These host the real views in an offscreen window (never ordered front, no
/// screen access) and check the split view stays the window's height.
@MainActor
final class StudioWindowMinimumHeightTests: XCTestCase {
    private static let window = CGSize(width: 1_200, height: 800)

    // MARK: - The layout guard

    /// What the grant sheet's lines did: wrap a word per line and refuse to
    /// truncate, so a zero width asks for thousands of points.
    private struct Pathological: View {
        var body: some View {
            Text(String(repeating: "For this run only. Alevr never controls itself. ", count: 6))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    func testTheGuardBoundsAZeroWidthMeasurement() {
        let bare = NSHostingController(rootView: Pathological())
        let guarded = NSHostingController(rootView: Pathological().studioBoundedMinimumHeight())
        let zero = CGSize(width: 0, height: CGFloat.infinity)
        let bareHeight = bare.sizeThatFits(in: zero).height
        let guardedHeight = guarded.sizeThatFits(in: zero).height
        // The unguarded text is the bug: far taller than any window.
        XCTAssertGreaterThan(bareHeight, 2_000)
        XCTAssertLessThan(guardedHeight, 200)
    }

    func testTheGuardIsAPassThroughAtRealWidths() {
        let bare = NSHostingController(rootView: Pathological())
        let guarded = NSHostingController(rootView: Pathological().studioBoundedMinimumHeight())
        for width in [CGFloat(320), 480, 720] {
            let proposal = CGSize(width: width, height: .infinity)
            XCTAssertEqual(guarded.sizeThatFits(in: proposal), bare.sizeThatFits(in: proposal), "at \(width)")
        }
    }

    // MARK: - The Code window with each screen card pending

    func testTheWindowKeepsItsHeightWithAGrantCardPending() async throws {
        let proposal = GrantProposal(
            sessionID: "s",
            reason: "Open Safari to visit YouTube and play a video.",
            offers: [AppGrantPolicy.offer(request: "Safari", bundleID: "com.apple.Safari", displayName: "Safari", preferences: .default)]
        )
        try await assertWindowKeepsItsHeight(detail: .grants(proposal), toolName: ComputerUseToolName.apps, summary: proposal.summary)
    }

    func testTheWindowKeepsItsHeightWithAnActionCardPending() async throws {
        let prepared = PreparedScreenAction(
            sessionID: "s",
            action: ScreenAction(kind: .leftClick, coordinate: [400, 300]),
            target: ScreenTargetSummary(bundleID: "com.apple.mail", appName: "Mail", element: "“Send” button", role: "button", title: "Send"),
            point: ScreenPoint(x: 400, y: 300),
            framePoint: [400, 300],
            floor: .consequentialControl("send"),
            frameHash: "frame",
            summary: "Click the “Send” button in Mail",
            crop: nil,
            isInput: true
        )
        try await assertWindowKeepsItsHeight(detail: .action(prepared), toolName: ComputerUseToolName.computer, summary: prepared.summary)
    }

    func testTheWindowKeepsItsHeightWithATakeoverCardPending() async throws {
        try await assertWindowKeepsItsHeight(
            detail: .takeover(sessionID: "s", display: "Built-in Retina Display"),
            toolName: ComputerUseToolName.display,
            summary: "Let Alevr use the whole screen"
        )
    }

    /// The same window with nothing pending, so a failure above is the card's.
    func testTheWindowKeepsItsHeightWithNothingPending() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        let frame = try await splitViewFrame(controller: controller)
        XCTAssertEqual(frame.height, Self.window.height, accuracy: 1)
        XCTAssertEqual(frame.minY, 0, accuracy: 1)
    }

    /// A connected agent's thread (env server) with the missing-grant notice
    /// in its composer — the in-app message that opens System Settings must
    /// not itself blank the window — and then with a bridge approval.
    func testAnEnvThreadKeepsTheWindowHeightWithTheGrantNoticeAndAnApproval() async throws {
        let session = CodeV2EnvSession(preview: CodeV2Fixtures.settledSnapshot)
        let approvals = CodeV2ConnectedApprovals.shared
        approvals.showPermissionNotice(
            ComputerUsePermissionStatus(screenRecording: .denied, accessibility: .denied),
            sessionID: session.sessionId
        )
        defer { approvals.dismissPermissionNotice() }
        let root = { () -> AnyView in
            AnyView(CodeV2EnvSessionView(
                session: session,
                composer: CodeV2ComposerModel(selection: CodeV2Fixtures.claudeSelection),
                directory: CodeV2Fixtures.directory
            ))
        }
        var frame = try await splitViewFrame(detail: root())
        XCTAssertEqual(frame.height, Self.window.height, accuracy: 1, "the grant notice outgrew the window")
        XCTAssertEqual(frame.minY, 0, accuracy: 1)

        approvals.dismissPermissionNotice()
        let id = UUID()
        approvals.preview(CodeV2ConnectedApprovals.Pending(
            id: id, sessionID: session.sessionId,
            request: StudioComputerBridgeApprover.request(
                sessionID: session.sessionId, summary: "Let Alevr use Safari (full control) for this session",
                justification: "You can take it back at any time from Settings › Screen control."
            ),
            crop: nil
        ))
        defer { approvals.respond(id, .decline) }
        frame = try await splitViewFrame(detail: root())
        XCTAssertEqual(frame.height, Self.window.height, accuracy: 1, "the bridge approval outgrew the window")
        XCTAssertEqual(frame.minY, 0, accuracy: 1)
    }

    // MARK: - Helpers

    private func assertWindowKeepsItsHeight(
        detail: ScreenApprovalDetail, toolName: String, summary: String,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let approval = ApprovalRequest(
            sessionID: CodeSessionID(value: "window-height"),
            actionDigest: "digest-\(toolName)",
            toolName: toolName,
            summary: summary,
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            requestedAt: Date(),
            expiresAt: Date().addingTimeInterval(900)
        )
        var fixture = CodePreviewData.fixture(for: .transcript)
        fixture.pendingApprovals = [approval]
        let controller = SessionController(previewFixture: fixture)
        controller.screen.setPreviewApprovalDetail(detail, digest: approval.actionDigest)
        let frame = try await splitViewFrame(controller: controller)
        XCTAssertEqual(frame.height, Self.window.height, accuracy: 1, "the split view outgrew the window", file: file, line: line)
        XCTAssertEqual(frame.minY, 0, accuracy: 1, "the columns were drawn outside the window", file: file, line: line)
    }

    /// The Code window's shape: a sidebar, the session as the detail, the
    /// screen-control row over it. Returns the split view's frame in the
    /// hosting view once the approval card has loaded its detail.
    private func splitViewFrame(controller: SessionController) async throws -> CGRect {
        try await splitViewFrame(detail: AnyView(
            StudioSessionView(controller: controller, models: [], openReview: { _ in })
                .overlay(alignment: .top) { StudioScreenControlBanner(controller: controller) }
        ))
    }

    private func splitViewFrame(detail: AnyView) async throws -> CGRect {
        let root = NavigationSplitView {
            List { ForEach(0..<8) { Text("Session \($0)") } }
        } detail: {
            detail
        }
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: Self.window),
            styleMask: [.titled, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentView = hosting
        hosting.frame = CGRect(origin: .zero, size: Self.window)
        hosting.layoutSubtreeIfNeeded()
        // The card loads its detail in a task; give it a few turns.
        for _ in 0..<8 {
            try await Task.sleep(for: .milliseconds(60))
            hosting.layoutSubtreeIfNeeded()
        }
        let split = try XCTUnwrap(Self.firstSplitView(in: hosting), "no split view")
        let frame = split.convert(split.bounds, to: hosting)
        window.contentView = nil
        return frame
    }

    private static func firstSplitView(in view: NSView) -> NSSplitView? {
        if let split = view as? NSSplitView { return split }
        for child in view.subviews {
            if let split = firstSplitView(in: child) { return split }
        }
        return nil
    }
}
